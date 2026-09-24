// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { z } from 'zod';
import { parseWorkflowReports } from './reports.js';

export async function uploadWorkflowReports(
  input: unknown,
  options: { url: string; project: string; token: string },
  send: typeof fetch = fetch,
) {
  const origin = new URL(options.url);
  if (
    !z.uuid().safeParse(options.project).success ||
    !/^td_upload_[a-f0-9]{64}$/.test(options.token)
  )
    throw new Error('Supply a valid project ID and TRACEDOJO_UPLOAD_TOKEN.');
  if (
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      )) ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      'Use an HTTPS origin, or HTTP on localhost for development.',
    );
  const reports = parseWorkflowReports(input);
  const endpoint = new URL(`/api/projects/${options.project}/runs`, origin);
  for (let start = 0; start < reports.length; start += 21) {
    const chunk = reports.slice(start, start + 21);
    const body = JSON.stringify({
      schemaVersion: 'workflow-upload/1',
      reports: chunk,
    });
    if (Buffer.byteLength(body) > 5_000_000)
      throw new Error(
        'This upload exceeds 5 MB. Upload smaller report groups.',
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await send(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.token}`,
          },
          body,
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        if (attempt < 2) continue;
        throw new Error(
          'Upload could not connect. The local report is preserved; retry safely.',
        );
      }
      if ([408, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      if (response.status !== 201)
        throw new Error(
          `Upload rejected (HTTP ${response.status}). Check your project, token, or quota. The local report is preserved; retry safely.`,
        );
      const receipt = z
        .object({
          inserted: z.number().int().nonnegative(),
          duplicates: z.number().int().nonnegative(),
          runIds: z.array(z.string()),
        })
        .safeParse(await response.json().catch(() => null));
      if (
        !receipt.success ||
        receipt.data.inserted + receipt.data.duplicates !== chunk.length ||
        receipt.data.runIds.length !== chunk.length ||
        receipt.data.runIds.some((id, i) => id !== chunk[i]!.id)
      )
        throw new Error(
          'Unexpected upload receipt. The local report is preserved; retry safely.',
        );
      break;
    }
  }
  return {
    count: reports.length,
    url: new URL(`/projects/${options.project}/workflows`, origin).href,
  };
}
