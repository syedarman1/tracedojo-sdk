// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

export function minimalSpec(): any {
  return {
    schemaVersion: 'simulation/1',
    id: 'notes',
    title: 'Notes service',
    api: { name: 'Notes API', version: '1', docs: 'https://example.com/docs' },
    epoch: 1700000000,
    collections: {
      notes: { unique: [['title']], conflict: 'duplicate' },
    },
    state: { notes: [], other: { id: 'keep' } },
    errors: {
      invalid: {
        code: 'invalid_request',
        message: 'Invalid {{field}}.',
        status: 400,
        retryable: false,
        verified: true,
      },
      duplicate: {
        code: 'duplicate',
        message: 'Title {{args.title}} exists.',
        status: 409,
        retryable: false,
        verified: true,
      },
      missing: {
        code: 'not_found',
        message: 'No note {{args.id}}.',
        status: 404,
        retryable: false,
        verified: true,
      },
    },
    tools: {
      create_note: {
        kind: 'write',
        description: 'POST /notes',
        input: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1 },
            key: { type: 'string', minLength: 1 },
          },
          required: ['title'],
          additionalProperties: false,
        },
        invalid: 'invalid',
        idempotency: { arg: 'key', conflict: 'duplicate' },
        steps: [
          {
            insert: 'notes',
            value: {
              id: { $concat: ['note_', { $seq: 'note' }] },
              title: { $: 'args.title' },
            },
            as: 'note',
          },
          { return: { $: 'note' } },
        ],
      },
      get_note: {
        kind: 'read',
        description: 'GET /notes/:id',
        input: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        invalid: 'invalid',
        steps: [
          {
            find: 'notes',
            where: { $eq: [{ $: 'item.id' }, { $: 'args.id' }] },
            as: 'note',
            missing: 'missing',
          },
          { return: { $: 'note' } },
        ],
      },
    },
    workflow: {
      schemaVersion: 'workflow/1',
      id: 'notes',
      title: 'Create one note',
      task: 'Create a note titled Hello.',
      checks: [
        {
          id: 'one',
          label: 'One note',
          type: 'count',
          path: '/notes',
          expected: 1,
        },
        {
          id: 'done',
          label: 'Reports completion',
          type: 'equals',
          source: 'completion',
          path: '/status',
          expected: 'completed',
        },
      ],
      scenarios: [
        {
          id: 'lost-confirmation',
          title: 'Lost confirmation',
          fault: { type: 'timeout_after', tool: 'create_note' },
        },
      ],
    },
    agent: {
      bug: 'A new key per attempt creates a second note.',
      bugScenario: 'lost-confirmation',
      fixed: {
        steps: [
          {
            call: 'create_note',
            args: { title: 'Hello', key: 'k1' },
            attempts: 3,
            save: 'note',
          },
        ],
        output: '{{saved.note}}',
        message: 'Created.',
      },
      broken: {
        steps: [
          {
            call: 'create_note',
            args: { title: 'Hello', key: 'k{{attempt}}' },
            attempts: 3,
            save: 'note',
          },
        ],
        output: '{{saved.note}}',
        message: 'Created.',
      },
    },
  };
}
