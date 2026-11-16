// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Json } from '../schema.js';

export type Message = { [key: string]: Json };

/** A bidirectional JSON-RPC message pipe. */
export interface Channel {
  send(message: Message): void;
  close(): void;
  onMessage: (message: Message) => void;
  onClose: () => void;
}

const isMessage = (value: unknown): value is Message =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Newline-delimited JSON-RPC, as used by MCP stdio. */
export class LineChannel implements Channel {
  onMessage: (message: Message) => void = () => undefined;
  onClose: () => void = () => undefined;
  #buffer = '';
  #closed = false;
  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly dispose: () => void = () => undefined,
  ) {
    // Decode manually: upgraded HTTP sockets refuse setEncoding.
    const decoder = new StringDecoder('utf8');
    input.on('data', (chunk: Buffer | string) => {
      this.#buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (this.#buffer.length > 20_000_000) {
        this.close();
        return;
      }
      let index: number;
      while ((index = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // Non-protocol output; MCP stdio servers must not emit it.
        }
        for (const item of Array.isArray(parsed) ? parsed : [parsed])
          if (isMessage(item)) this.onMessage(item);
      }
    });
    const end = () => this.close();
    input.once('end', end);
    input.once('error', end);
    output.once('error', end);
  }
  send(message: Message) {
    if (this.#closed) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.output.end();
    } catch {
      // Already closed.
    }
    this.dispose();
    this.onClose();
  }
}

export function spawnStdio(
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stderr: 'inherit' | 'ignore' },
): { channel: LineChannel; child: ChildProcess } {
  const child = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', options.stderr],
  });
  const channel = new LineChannel(child.stdout!, child.stdin!, () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
  });
  child.once('error', () => channel.close());
  child.once('exit', () => channel.close());
  return { channel, child };
}

/** Parse a complete text/event-stream body into its data payloads. */
export function sseData(body: string): string[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n'),
    )
    .filter(Boolean);
}

/** A streamable-HTTP MCP client connection. Server-initiated requests need a GET stream and are not relayed. */
export class HttpChannel implements Channel {
  onMessage: (message: Message) => void = () => undefined;
  onClose: () => void = () => undefined;
  #session: string | undefined;
  #protocol: string | undefined;
  #closed = false;
  #controller = new AbortController();
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}
  #headers(): Record<string, string> {
    return {
      ...this.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.#session ? { 'mcp-session-id': this.#session } : {}),
      ...(this.#protocol ? { 'mcp-protocol-version': this.#protocol } : {}),
    };
  }
  send(message: Message) {
    if (this.#closed) return;
    void (async () => {
      try {
        const response = await fetch(this.url, {
          method: 'POST',
          headers: this.#headers(),
          body: JSON.stringify(message),
          signal: this.#controller.signal,
        });
        const session = response.headers.get('mcp-session-id');
        if (session) this.#session = session;
        const body = await response.text();
        if (response.status === 202 || !body.trim()) {
          if (!response.ok && message.id !== undefined) throw new Error();
          return;
        }
        const type = response.headers.get('content-type') ?? '';
        const payloads = type.includes('text/event-stream')
          ? sseData(body)
          : [body];
        let answered = false;
        for (const payload of payloads) {
          const parsed: unknown = JSON.parse(payload);
          for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
            if (!isMessage(item)) continue;
            if (item.id !== undefined && item.id === message.id) answered = true;
            const result = item.result;
            if (
              message.method === 'initialize' &&
              isMessage(result) &&
              typeof result.protocolVersion === 'string'
            )
              this.#protocol = result.protocolVersion;
            this.onMessage(item);
          }
        }
        if (!answered && message.id !== undefined && message.method)
          throw new Error();
      } catch {
        if (this.#closed || message.id === undefined || !message.method)
          return;
        this.onMessage({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'The upstream MCP request failed.' },
        });
      }
    })();
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    if (this.#session)
      void fetch(this.url, { method: 'DELETE', headers: this.#headers() }).catch(
        () => undefined,
      );
    this.onClose();
  }
}

export interface ToolOutcome {
  result?: Json;
  error?: Json;
}

/** An MCP tool call succeeded when it returned a result without isError. */
export function succeeded(outcome: ToolOutcome): boolean {
  return (
    outcome.result !== undefined &&
    !(isMessage(outcome.result) && outcome.result.isError === true)
  );
}

export function errorResult(code: string, message: string): ToolOutcome {
  return {
    result: {
      content: [{ type: 'text', text: `${code}: ${message}` }],
      isError: true,
    },
  };
}

/** Text content of a result, truncated to half: a response cut off in transit. */
export function malformedResult(original: ToolOutcome): ToolOutcome {
  const result = isMessage(original.result) ? original.result : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((item) =>
      isMessage(item) && typeof item.text === 'string' ? item.text : '',
    )
    .join('\n');
  const source =
    text.length >= 2
      ? text
      : JSON.stringify(result.structuredContent ?? result ?? null);
  return {
    result: {
      content: [
        { type: 'text', text: source.slice(0, Math.max(1, source.length >> 1)) },
      ],
    },
  };
}

export function injectedResult(replacement: Json): ToolOutcome {
  return {
    result: {
      content: [
        {
          type: 'text',
          text:
            typeof replacement === 'string'
              ? replacement
              : JSON.stringify(replacement),
        },
      ],
    },
  };
}

/** Report tool names follow the workflow name rule; other characters become "_". */
export function reportToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return /^[a-zA-Z0-9]/.test(cleaned) ? cleaned : `t${cleaned}`.slice(0, 100);
}
