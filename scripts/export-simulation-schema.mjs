// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

// Writes packages/sdk/simulations/simulation.schema.json from the zod schema.
// Run `npm run build` first. With --check, fails if the file is out of date.
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { simulationSchema } from '../packages/sdk/dist/simulation-schema.js';

const target = new URL(
  '../packages/sdk/simulations/simulation.schema.json',
  import.meta.url,
);
const schema = {
  ...z.toJSONSchema(simulationSchema, { target: 'draft-2020-12' }),
  title: 'TraceDojo simulation (simulation/1)',
  description:
    'Shape of a simulation spec. Cross-references (tools, errors, collections, operators, scenarios) are checked by parseSimulation in @tracedojo/sdk/simulations, not by this schema.',
};
const text = JSON.stringify(schema, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== text) {
    console.error(
      'simulation.schema.json is out of date. Run: npm run build && node scripts/export-simulation-schema.mjs',
    );
    process.exit(1);
  }
} else {
  await writeFile(target, text);
  console.log(`Wrote ${target.pathname}`);
}
