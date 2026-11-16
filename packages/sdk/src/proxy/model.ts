// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isModelFault, type Json } from '../schema.js';
import { Stop, type ProxyTrial } from './trial.js';

export type Provider = 'openai' | 'anthropic';
export const defaultOrigins: Record<Provider, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
};

const hopHeaders = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'accept-encoding',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'origin',
  'referer',
]);

function errorBody(provider: Provider, status: number): string {
  const rate = status === 429;
  if (provider === 'anthropic')
    return JSON.stringify({
      type: 'error',
      error: {
        type: rate
          ? 'rate_limit_error'
          : status === 529
            ? 'overloaded_error'
            : 'api_error',
        message: rate
          ? 'Number of requests has exceeded your rate limit.'
          : status === 529
            ? 'Overloaded'
            : 'Internal server error',
      },
    });
  return JSON.stringify({
    error: {
      message: rate
        ? 'Rate limit reached for requests. Please try again later.'
        : 'The server had an error while processing your request.',
      type: rate ? 'requests' : 'server_error',
      param: null,
      code: rate ? 'rate_limit_exceeded' : null,
    },
  });
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 50_000_000) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Forward one model API request, injecting the trial's model fault when selected.
 * Evidence is a summary only: provider, method, path, model, stream, status.
 * Headers, keys, prompts and completions are never recorded.
 */
export async function handleModelRequest(
  trial: ProxyTrial,
  provider: Provider,
  origin: string,
  upstreamPath: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const controller = new AbortController();
  const closed = () => controller.abort();
  response.once('close', closed);
  const signal = AbortSignal.any([controller.signal, trial.closedSignal]);
  const summary: { [key: string]: Json } = {
    provider,
    method: request.method ?? 'GET',
    path: upstreamPath.split('?')[0]!.slice(0, 500),
  };
  const callId = `model_${trial.modelCalls + 1}`;
  const record = (status: number | 'dropped') => {
    if (trial.closed) return;
    summary.status = status;
    try {
      trial.emit({
        kind: 'model',
        visibility: 'evaluator',
        callId,
        detail: `${summary.method} ${summary.path} -> ${status}`,
        payload: summary,
      });
    } catch {
      // The trial already stopped on its evidence limit.
    }
  };
  try {
    trial.guard();
    if (++trial.modelCalls > trial.options.config.limits.maxModelCalls)
      throw trial.fail(new Stop('call_limit'));
    const body = await readBody(request);
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const { model, stream } = parsed as Record<string, unknown>;
        if (typeof model === 'string') summary.model = model.slice(0, 200);
        if (typeof stream === 'boolean') summary.stream = stream;
      }
    } catch {
      // Not JSON; forward unchanged.
    }
    const fault = trial.fault;
    const modelFault = isModelFault(fault) ? fault : undefined;
    const target = trial.selects(!!modelFault && request.method === 'POST');
    if (target && modelFault) summary.fault = modelFault.type;
    if (
      target &&
      modelFault &&
      (modelFault.type === 'rate_limited' || modelFault.type === 'server_error')
    ) {
      const status =
        modelFault.type === 'rate_limited' ? 429 : (modelFault.status ?? 503);
      trial.inject({ callId });
      response.writeHead(status, {
        'content-type': 'application/json',
        ...(status === 429 ? { 'retry-after': '1' } : {}),
      });
      response.end(errorBody(provider, status));
      record(status);
      return;
    }
    if (target && modelFault?.type === 'model_timeout') {
      trial.inject({ callId });
      record('dropped');
      await wait(modelFault.delayMs ?? 10000, signal);
      response.destroy();
      return;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers))
      if (!hopHeaders.has(key) && value !== undefined)
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
    headers['accept-encoding'] = 'identity';
    const upstream = await fetch(origin.replace(/\/+$/, '') + upstreamPath, {
      method: request.method ?? 'GET',
      headers,
      ...(body.length && request.method !== 'GET' && request.method !== 'HEAD'
        ? { body: new Uint8Array(body) }
        : {}),
      signal,
    });
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!hopHeaders.has(key) && key !== 'content-encoding')
        responseHeaders[key] = value;
    });
    response.writeHead(upstream.status, responseHeaders);
    const reader = upstream.body?.getReader();
    const cutting =
      target &&
      (modelFault?.type === 'stream_cut' || modelFault?.type === 'stream_stall')
        ? modelFault
        : undefined;
    if (!reader) {
      response.end();
      record(upstream.status);
      return;
    }
    if (!cutting) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(value);
      }
      response.end();
      record(upstream.status);
      return;
    }
    // Split the stream into server-sent events and withhold everything after
    // `afterChunks`. A non-streaming body counts as one chunk and is cut in half.
    const streaming = (upstream.headers.get('content-type') ?? '').includes(
      'text/event-stream',
    );
    const limit = cutting.afterChunks ?? 1;
    const decoder = new TextDecoder();
    let buffer = '';
    let sent = 0;
    let withheld = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      if (streaming) {
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, match.index + match[0].length);
          buffer = buffer.slice(match.index + match[0].length);
          if (sent < limit) {
            response.write(event);
            sent++;
          } else {
            withheld = true;
            break;
          }
        }
      } else if (done && buffer.length > 1) {
        response.write(buffer.slice(0, buffer.length >> 1));
        withheld = true;
      }
      if (withheld || done) break;
    }
    if (!withheld) {
      if (buffer) response.write(buffer);
      response.end();
      record(upstream.status);
      return;
    }
    void reader.cancel().catch(() => undefined);
    trial.inject({ callId }, { forwardedChunks: streaming ? sent : 0 });
    record(upstream.status);
    if (cutting.type === 'stream_stall')
      await wait(cutting.delayMs ?? 10000, signal);
    response.destroy();
  } catch {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(errorBody(provider, 502));
    } else response.destroy();
    record('dropped');
  } finally {
    response.removeListener('close', closed);
  }
}
