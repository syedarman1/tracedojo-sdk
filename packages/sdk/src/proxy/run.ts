// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  boundedJson,
  commitShaSchema,
  completionSchema,
  stableJson,
  unreachedFault,
  workflowBatchSchema,
  type Json,
  type State,
  type WorkflowBatch,
  type WorkflowCompletion,
  type WorkflowReport,
} from '../schema.js';
import {
  expandRecord,
  parseProxyConfig,
  type ProxyConfig,
} from './config.js';
import {
  HttpChannel,
  LineChannel,
  reportToolName,
  spawnStdio,
  type Channel,
  type Message,
  type ToolOutcome,
} from './mcp.js';
import { defaultOrigins, handleModelRequest, type Provider } from './model.js';
import { ProxyTrial, Stop, type Issue } from './trial.js';

export { parseProxyConfig, proxyConfigSchema } from './config.js';
export type { ProxyConfig } from './config.js';

export const DEFAULT_PROXY_PORT = 7357;

export interface ProxyRunOptions {
  /** Relative commands and working directories resolve against this directory. */
  configDir: string;
  trials?: number;
  commitSha?: string;
  signal?: AbortSignal;
  /** 0 picks a free port. Defaults to the config port, then 7357. */
  port?: number;
  /** Where agent and MCP server stderr goes. Default: inherit. */
  output?: 'inherit' | 'ignore';
  onListening?: (port: number) => void;
}

const isMessage = (value: unknown): value is Message =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** One agent connection to one upstream MCP server. */
class McpSession {
  #pending = new Map<
    string,
    { resolve: (outcome: ToolOutcome) => void; reject: () => void }
  >();
  #lists = new Set<string>();
  #next = 0;
  #prefix = `tracedojo-${randomUUID()}-`;
  constructor(
    private readonly trial: ProxyTrial,
    private readonly upstream: Channel,
    private readonly toAgent: (message: Message) => void,
  ) {
    upstream.onMessage = (message) => this.#fromUpstream(message);
    upstream.onClose = () => {
      for (const { reject } of this.#pending.values()) reject();
      this.#pending.clear();
    };
  }
  fromAgent(message: Message) {
    if (
      message.method === 'tools/call' &&
      message.id !== undefined &&
      isMessage(message.params)
    ) {
      const params = message.params;
      const id = message.id;
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isMessage(params.arguments) ? params.arguments : {};
      this.trial
        .callTool(reportToolName(name), args, (forwarded) =>
          this.#forward({ ...params, arguments: forwarded }),
        )
        .then(
          (outcome) => this.toAgent({ jsonrpc: '2.0', id, ...outcome }),
          () =>
            this.toAgent({
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: 'The test run stopped this call.' },
            }),
        );
      return;
    }
    if (message.method === 'tools/list' && message.id !== undefined)
      this.#lists.add(JSON.stringify(message.id));
    this.upstream.send(message);
  }
  #forward(params: Message): Promise<ToolOutcome> {
    const id = `${this.#prefix}${++this.#next}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(JSON.stringify(id), {
        resolve,
        reject: () => reject(new Error('The upstream MCP server closed.')),
      });
      this.upstream.send({ jsonrpc: '2.0', id, method: 'tools/call', params });
    });
  }
  #fromUpstream(message: Message) {
    if (message.id !== undefined && message.method === undefined) {
      const key = JSON.stringify(message.id);
      const pending = this.#pending.get(key);
      if (pending) {
        this.#pending.delete(key);
        pending.resolve(
          message.error !== undefined
            ? { error: message.error }
            : { result: message.result ?? null },
        );
        return;
      }
      if (this.#lists.delete(key) && isMessage(message.result)) {
        const tools = message.result.tools;
        if (Array.isArray(tools))
          for (const tool of tools)
            if (
              isMessage(tool) &&
              typeof tool.name === 'string' &&
              isMessage(tool.annotations) &&
              typeof tool.annotations.readOnlyHint === 'boolean'
            )
              this.trial.observeKind(
                reportToolName(tool.name),
                tool.annotations.readOnlyHint,
              );
      }
    }
    this.toAgent(message);
  }
  close() {
    this.upstream.close();
  }
}

function runCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((done, fail) =>
    execFile(
      command[0]!,
      command.slice(1),
      { cwd, env, timeout: 60000, maxBuffer: 2_000_000 },
      (error, stdout) =>
        error
          ? fail(new Error(`State command failed: ${command[0]}`))
          : done(stdout),
    ),
  );
}

async function readBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return (lines.filter(Boolean).at(-1) ?? '').slice(0, 2000);
}

function killGroup(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // Already gone.
      }
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 2000).unref();
}

interface ActiveTrial {
  trial: ProxyTrial;
  sessions: Set<{ close(): void }>;
  http: Map<string, { session: McpSession; waiters: Map<string, (m: Message) => void> }>;
}

/**
 * Run an unmodified agent process against real MCP servers and model APIs
 * through a local fault-injecting proxy. Produces a normal workflow batch:
 * a no-fault control first, then each scenario, with the same stop rules.
 */
export async function runProxy(
  input: unknown,
  options: ProxyRunOptions,
): Promise<WorkflowBatch> {
  const config = parseProxyConfig(input);
  const trials = z
    .number()
    .int()
    .min(1)
    .max(20)
    .parse(options.trials ?? 1);
  const commitSha =
    options.commitSha === undefined
      ? undefined
      : commitShaSchema.parse(options.commitSha);
  const base = resolve(options.configDir);
  const output = options.output ?? 'inherit';
  const at = (dir?: string) => resolve(base, dir ?? '.');
  // Expand ${VAR} references up front so a missing secret fails before any run.
  const agentEnv = expandRecord(config.agent.env);
  const stateEnv = { ...process.env, ...expandRecord(config.state.env) };
  const servers = Object.fromEntries(
    Object.entries(config.servers).map(([name, spec]) => [
      name,
      'command' in spec
        ? { ...spec, env: expandRecord(spec.env) }
        : { ...spec, headers: expandRecord(spec.headers) },
    ]),
  );
  const probe = async (): Promise<State> => {
    const parsed: unknown = JSON.parse(
      await runCommand(config.state.probe, at(config.state.cwd), stateEnv),
    );
    if (!isMessage(parsed))
      throw new Error('The state probe must print one JSON object.');
    boundedJson(parsed, 100000);
    return parsed;
  };
  const reset = async () => {
    if (config.state.reset)
      await runCommand(config.state.reset, at(config.state.cwd), stateEnv);
  };

  let active: ActiveTrial | undefined;
  let port = options.port ?? config.port ?? DEFAULT_PROXY_PORT;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  // Refuse requests that a web page could forge through DNS rebinding.
  const allowed = (request: IncomingMessage) => {
    const origin = request.headers.origin;
    return (
      hosts().has(request.headers.host ?? '') &&
      (!origin || [...hosts()].some((host) => origin === `http://${host}`))
    );
  };
  const openSession = (
    server: string,
    current: ActiveTrial,
    toAgent: (message: Message) => void,
  ) => {
    const spec = servers[server]!;
    const upstream: Channel =
      'command' in spec
        ? spawnStdio(spec.command, {
            cwd: at(spec.cwd),
            env: { ...process.env, ...spec.env },
            stderr: output,
          }).channel
        : new HttpChannel(spec.url, spec.headers);
    const session = new McpSession(current.trial, upstream, toAgent);
    current.sessions.add(session);
    return session;
  };
  const json = (response: ServerResponse, status: number, body: Json) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const handleMcp = async (
    server: string,
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    const current = active;
    if (!current)
      return json(response, 503, { error: 'No TraceDojo trial is running.' });
    const sessionId = request.headers['mcp-session-id'];
    if (request.method === 'DELETE') {
      const entry =
        typeof sessionId === 'string' ? current.http.get(sessionId) : undefined;
      entry?.session.close();
      if (typeof sessionId === 'string') current.http.delete(sessionId);
      response.writeHead(entry ? 200 : 404).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST, DELETE' }).end();
      return;
    }
    const parsed: unknown = JSON.parse(await readBody(request, 20_000_000));
    const messages = (Array.isArray(parsed) ? parsed : [parsed]).filter(isMessage);
    let id = typeof sessionId === 'string' ? sessionId : undefined;
    let entry = id ? current.http.get(id) : undefined;
    if (!entry) {
      if (id || !messages.some((m) => m.method === 'initialize'))
        return json(response, id ? 404 : 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Unknown or missing MCP session.' },
        });
      id = randomUUID();
      const waiters = new Map<string, (m: Message) => void>();
      const session = openSession(server, current, (message) => {
        if (message.id === undefined || message.method !== undefined) return;
        const key = JSON.stringify(message.id);
        const waiter = waiters.get(key);
        waiters.delete(key);
        waiter?.(message);
      });
      entry = { session, waiters };
      current.http.set(id, entry);
    }
    const requests = messages.filter(
      (m) => m.method !== undefined && m.id !== undefined,
    );
    const answers = requests.map(
      (m) =>
        new Promise<Message>((done) =>
          entry.waiters.set(JSON.stringify(m.id), done),
        ),
    );
    for (const message of messages) entry.session.fromAgent(message);
    if (!requests.length) {
      response.writeHead(202, { 'mcp-session-id': id }).end();
      return;
    }
    const closed = new Promise<undefined>((done) => {
      if (current.trial.closedSignal.aborted) done(undefined);
      current.trial.closedSignal.addEventListener('abort', () => done(undefined), {
        once: true,
      });
    });
    const results = await Promise.race([Promise.all(answers), closed]);
    if (!results)
      return json(response, 503, { error: 'The TraceDojo trial ended.' });
    response.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': id,
    });
    response.end(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (!allowed(request)) return json(response, 403, { error: 'Forbidden.' });
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const model = /^\/(openai|anthropic)(\/.*)$/.exec(url.pathname);
        if (model) {
          const provider = model[1] as Provider;
          if (!active)
            return json(response, 503, { error: 'No TraceDojo trial is running.' });
          return await handleModelRequest(
            active.trial,
            provider,
            config.model?.[provider] ?? defaultOrigins[provider],
            `${model[2]}${url.search}`,
            request,
            response,
          );
        }
        const mcp = /^\/mcp\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})$/.exec(url.pathname);
        if (mcp && Object.hasOwn(servers, mcp[1]!))
          return await handleMcp(mcp[1]!, request, response);
        json(response, 404, { error: 'Not found.' });
      } catch {
        if (!response.headersSent) json(response, 400, { error: 'Bad request.' });
        else response.destroy();
      }
    })();
  });
  // The stdio shim (`tracedojo proxy connect <server>`) upgrades to a raw line pipe.
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = /^\/connect\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})$/.exec(
      request.url ?? '',
    );
    const current = active;
    if (
      !allowed(request) ||
      !match ||
      !Object.hasOwn(servers, match[1]!) ||
      !current ||
      request.headers.upgrade !== 'tracedojo-mcp'
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tracedojo-mcp\r\n\r\n',
      );
      if (head.length) socket.unshift(head);
      const channel = new LineChannel(socket, socket, () => socket.destroy());
      const session = openSession(match[1]!, current, (message) =>
        channel.send(message),
      );
      channel.onMessage = (message) => session.fromAgent(message);
      channel.onClose = () => session.close();
      current.sessions.add(channel);
    } catch {
      socket.destroy();
    }
  });
  await new Promise<void>((done, fail) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      fail(
        new Error(
          error.code === 'EADDRINUSE'
            ? `Port ${port} is in use. Choose another with --port.`
            : 'Could not start the proxy listener.',
        ),
      ),
    );
    server.listen(port, '127.0.0.1', () => done());
  });
  const address = server.address();
  if (address && typeof address === 'object') port = address.port;
  options.onListening?.(port);
  const url = `http://127.0.0.1:${port}`;

  const execution = {
    id: randomUUID(),
    trialsPerScenario: trials,
    scenarioIds: config.scenarios.map((scenario) => scenario.id),
    ...(commitSha ? { commitSha } : {}),
  };
  let fingerprint = '';
  let controlState: State | undefined;

  const runTrial = async (
    scenario: ProxyConfig['scenarios'][number] | {
      id: 'baseline';
      title: string;
      fault: { type: 'none' };
    },
  ): Promise<WorkflowReport | 'state_mismatch'> => {
    await reset();
    const initialState = await probe();
    if (!controlState) {
      controlState = initialState;
      fingerprint = createHash('sha256')
        .update(
          stableJson({
            schemaVersion: config.schemaVersion,
            id: config.id,
            title: config.title,
            task: config.task,
            initialState,
            tools: config.tools ?? {},
            checks: config.checks,
            scenarios: config.scenarios,
            limits: config.limits,
          }),
        )
        .digest('hex');
    } else if (stableJson(initialState) !== stableJson(controlState))
      return 'state_mismatch';
    let child: ChildProcess | undefined;
    const trial = new ProxyTrial({
      config,
      scenario,
      initialState,
      probe,
      onFatal: () => {
        if (child) killGroup(child);
      },
    });
    const current: ActiveTrial = { trial, sessions: new Set(), http: new Map() };
    active = current;
    const scratch = await mkdtemp(join(tmpdir(), 'tracedojo-proxy-'));
    const completionFile = join(scratch, 'completion.json');
    let stdout = '';
    let exitCode: number | null = null;
    let issue: Issue | undefined;
    let completion: WorkflowCompletion | undefined;
    const cancel = () => trial.fail(new Stop('cancelled'));
    options.signal?.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(
      () => trial.fail(new Stop('timed_out')),
      config.limits.timeoutMs,
    );
    let exited: Promise<void> = Promise.resolve();
    try {
      if (options.signal?.aborted) throw trial.fail(new Stop('cancelled'));
      exited = new Promise<void>((done) => {
        child = spawn(config.agent.command[0]!, config.agent.command.slice(1), {
          cwd: at(config.agent.cwd),
          env: {
            ...process.env,
            ...agentEnv,
            TRACEDOJO_TASK: config.task,
            TRACEDOJO_PROXY_URL: url,
            TRACEDOJO_PROXY_PORT: String(port),
            TRACEDOJO_COMPLETION_FILE: completionFile,
            OPENAI_BASE_URL: `${url}/openai/v1`,
            ANTHROPIC_BASE_URL: `${url}/anthropic`,
          },
          detached: true,
          stdio: ['ignore', 'pipe', output === 'inherit' ? 'inherit' : 'ignore'],
        });
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (chunk: string) => {
          stdout = (stdout + chunk).slice(-8000);
        });
        child.once('error', () => {
          exitCode = -1;
          done();
        });
        child.once('exit', (code) => {
          exitCode = code ?? -1;
          done();
        });
      });
      await exited;
      if (!trial.fatal && trial.pending > 0)
        trial.fail(new Stop('unawaited_calls'));
      // Let in-flight writes finish before reading the final state.
      await Promise.race([
        trial.drain(),
        new Promise((done) => setTimeout(done, 5000).unref()),
      ]);
    } catch {
      // The fatal reason is already recorded.
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', cancel);
      if (child) {
        killGroup(child);
        // Wait for the process group to go, so no agent outlives its trial.
        await Promise.race([
          exited,
          new Promise((done) => setTimeout(done, 3000).unref()),
        ]);
      }
      for (const session of current.sessions) session.close();
      active = undefined;
    }
    try {
      await trial.sync();
    } catch {
      // A failed final probe is recorded as the trial's fatal issue.
    }
    if (!trial.fatal) {
      let file: string | undefined;
      try {
        if ((await stat(completionFile)).size > 64000) throw new Error();
        file = await readFile(completionFile, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          issue = 'agent_error';
      }
      if (file !== undefined) {
        try {
          const parsed: unknown = JSON.parse(file);
          boundedJson(parsed, 16000);
          completion = completionSchema.parse(parsed);
        } catch {
          issue = 'agent_error';
        }
      } else if (!issue) {
        if (exitCode === 0)
          completion = {
            status: 'completed',
            message: lastLine(stdout) || 'The agent exited successfully.',
          };
        else issue = 'agent_error';
      }
    }
    await rm(scratch, { recursive: true, force: true });
    return trial.finish({ fingerprint, execution }, { completion, issue });
  };

  try {
    const baseline = await runTrial({
      id: 'baseline',
      title: 'No-fault control',
      fault: { type: 'none' },
    });
    if (baseline === 'state_mismatch') throw new Error('Unreachable.');
    const batch: WorkflowBatch = {
      schemaVersion: 'workflow-batch/1',
      baseline,
      runs: [],
      planned: config.scenarios.length * trials,
    };
    if (baseline.status !== 'passed')
      batch.skippedReason =
        'The no-fault control did not pass. Fault trials were skipped.';
    else
      outer: for (const scenario of config.scenarios)
        for (let i = 0; i < trials; i++) {
          if (options.signal?.aborted) {
            batch.skippedReason = 'Remaining trials were cancelled.';
            break outer;
          }
          let report: WorkflowReport | 'state_mismatch';
          try {
            report = await runTrial(scenario);
          } catch {
            batch.skippedReason =
              'The state reset or probe failed. Completed evidence was preserved.';
            break outer;
          }
          if (report === 'state_mismatch') {
            batch.skippedReason =
              "The state reset did not restore the control's starting state. Remaining trials were skipped.";
            break outer;
          }
          batch.runs.push(report);
          // A fault the agent never reached says nothing about the next scenario,
          // so keep testing. Only an interrupted trial stops the batch.
          if (
            ['inconclusive', 'cancelled', 'timed_out'].includes(report.status) &&
            !unreachedFault(report)
          ) {
            batch.skippedReason =
              'Stopped after an interrupted or inconclusive trial. Completed evidence was preserved.';
            break outer;
          }
        }
    return workflowBatchSchema.parse(batch);
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  }
}

/** Pipe this process's stdio to a running proxy: use it as the MCP server command. */
export function connectStdio(server: string, port: number): Promise<number> {
  return new Promise((done) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: `/connect/${encodeURIComponent(server)}`,
      headers: { connection: 'Upgrade', upgrade: 'tracedojo-mcp' },
    });
    request.on('upgrade', (_response, socket, head) => {
      if (head.length) process.stdout.write(head);
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
      process.stdin.once('end', () => socket.end());
      socket.once('close', () => done(0));
      socket.once('error', () => done(1));
    });
    request.on('response', (response) => {
      response.resume();
      process.stderr.write(
        `The TraceDojo proxy refused server "${server}" (HTTP ${response.statusCode}). Is a trial running?\n`,
      );
      done(1);
    });
    request.on('error', () => {
      process.stderr.write(
        `No TraceDojo proxy is listening on 127.0.0.1:${port}. Start one with tracedojo proxy.\n`,
      );
      done(1);
    });
    request.end();
  });
}
