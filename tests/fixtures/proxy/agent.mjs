// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
// A scripted agent that knows nothing about TraceDojo's fault engine. It uses
// standard MCP (stdio via the configured server command, or streamable HTTP) and
// standard model base-URL environment variables, like an unmodified agent would.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
const flag = (name, fallback = '0') => (env[name] ?? fallback) === '1';
if (flag('FAIL')) process.exit(1);
if (flag('HANG')) setInterval(() => undefined, 1000);

const API_KEY = 'sk-test-proxy-secret-1234567890abcdef';

async function askModel() {
  const provider = env.MODEL ?? 'none';
  if (provider === 'none') return true;
  const retries = Number(env.MODEL_RETRIES ?? 3);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const openai = provider === 'openai';
      const response = await fetch(
        openai
          ? `${env.OPENAI_BASE_URL}/chat/completions`
          : `${env.ANTHROPIC_BASE_URL}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(openai
              ? { authorization: `Bearer ${API_KEY}` }
              : { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }),
          },
          body: JSON.stringify({
            model: openai ? 'gpt-test' : 'claude-test',
            stream: true,
            max_tokens: 50,
            messages: [{ role: 'user', content: env.TRACEDOJO_TASK }],
          }),
          signal: AbortSignal.timeout(3000),
        },
      );
      const body = await response.text();
      const complete = openai
        ? body.includes('data: [DONE]')
        : body.includes('event: message_stop');
      if (response.ok && complete) return true;
    } catch {
      // Connection dropped, cut, or timed out: retry.
    }
  }
  return false;
}

function stdioClient() {
  const child = spawn(process.execPath, [env.TRACEDOJO_CLI, 'proxy', 'connect', 'booking'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  return {
    request: (message) =>
      new Promise((resolve, reject) => {
        pending.set(message.id, resolve);
        child.stdin.write(`${JSON.stringify(message)}\n`);
        child.once('exit', () => reject(new Error('MCP server exited.')));
      }),
    notify: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    close: () => child.stdin.end(),
  };
}

function httpClient() {
  const url = `${env.TRACEDOJO_PROXY_URL}/mcp/booking`;
  let session;
  const post = async (message) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify(message),
    });
    session ??= response.headers.get('mcp-session-id') ?? undefined;
    return response.status === 202 ? undefined : response.json();
  };
  return {
    request: post,
    notify: post,
    close: () =>
      fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': session } }),
  };
}

const mcp = env.MCP_MODE === 'http' ? httpClient() : stdioClient();
let next = 0;
async function tool(name, args) {
  const reply = await mcp.request({
    jsonrpc: '2.0',
    id: ++next,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (reply.error) return { error: reply.error.message };
  const text = reply.result.content?.map((c) => c.text ?? '').join('') ?? '';
  if (reply.result.isError) return { error: text };
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { malformed: text };
  }
}

function finish(status, message, output) {
  writeFileSync(
    env.TRACEDOJO_COMPLETION_FILE,
    JSON.stringify({ status, message, ...(output ? { output } : {}) }),
  );
  mcp.close();
  process.exit(0);
}

await mcp.request({
  jsonrpc: '2.0',
  id: ++next,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'scripted-agent', version: '1' },
  },
});
mcp.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
await mcp.request({ jsonrpc: '2.0', id: ++next, method: 'tools/list' });

if (!(await askModel())) finish('blocked', 'The model was unavailable.');
if (flag('CALL_AUDIT')) await tool('touch_audit', {});

if (flag('HANG')) await new Promise(() => undefined);
const customer = { customerId: 'customer_7' };
const before = await tool('list_bookings', customer);
if (flag('FOLLOW_INJECTION') && JSON.stringify(before).includes('cancel_all'))
  await tool('cancel_all', {});

let booking;
for (let attempt = 0; attempt < 3 && !booking; attempt++) {
  const result = await tool('reserve_slot', {
    ...customer,
    slot: 'slot_42',
    operationKey: flag('STABLE_KEY', '1') ? 'one-booking' : `attempt-${attempt}`,
  });
  if (result.data?.id) booking = result.data.id;
  else if (result.error?.startsWith('PERMISSION_DENIED'))
    finish('blocked', 'Booking permission was revoked.');
}
if (!booking) finish('blocked', 'Could not confirm the booking.');

// Verify the booking. A stale listing is re-read, not rebooked.
for (let attempt = 0; attempt < 3; attempt++) {
  const listed = await tool('list_bookings', customer);
  if (Array.isArray(listed.data) && listed.data.some((b) => b.id === booking))
    finish('completed', `Booked ${booking}.`, { bookingId: booking });
}
finish('completed', `Booked ${booking}; the listing did not show it yet.`, {
  bookingId: booking,
});
