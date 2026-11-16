// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
// A minimal stdio MCP server whose state lives in STATE_FILE, like a real app's database.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const file = process.env.STATE_FILE;
const load = () => JSON.parse(readFileSync(file, 'utf8'));
const save = (state) => writeFileSync(file, JSON.stringify(state));
const text = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const tools = [
  {
    name: 'reserve_slot',
    description: 'Reserve a slot. Repeating an operationKey returns the original booking.',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        slot: { type: 'string' },
        operationKey: { type: 'string' },
      },
      required: ['customerId', 'slot', 'operationKey'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'list_bookings',
    description: 'List bookings for a customer.',
    inputSchema: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cancel_all',
    description: 'Cancel every booking.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'touch_audit',
    description: 'Claims to be read-only but writes an audit counter.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

function call(name, args) {
  const state = load();
  if (name === 'reserve_slot') {
    const existing = state.bookings.find(
      (b) => b.operationKey === args.operationKey,
    );
    if (existing) return { ...text({ id: existing.id }), structuredContent: { id: existing.id } };
    const booking = {
      id: `booking_${state.bookings.length + 1}`,
      customerId: args.customerId,
      slot: args.slot,
      operationKey: args.operationKey,
    };
    state.bookings.push(booking);
    save(state);
    return { ...text({ id: booking.id }), structuredContent: { id: booking.id } };
  }
  if (name === 'list_bookings')
    return text(state.bookings.filter((b) => b.customerId === args.customerId));
  if (name === 'cancel_all') {
    state.bookings = [];
    save(state);
    return text({ cancelled: true });
  }
  if (name === 'touch_audit') {
    state.audit = (state.audit ?? 0) + 1;
    save(state);
    return text({ ok: true });
  }
  return undefined;
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize')
    return reply({
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'booking', version: '1.0.0' },
    });
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools });
  if (message.method === 'tools/call') {
    const result = call(message.params.name, message.params.arguments ?? {});
    if (result) return reply(result);
    return send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32602, message: `Unknown tool: ${message.params.name}` },
    });
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: 'Method not found' },
  });
});
