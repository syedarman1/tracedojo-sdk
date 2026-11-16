// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
// Reset or print the booking app's state. STATE_DRIFT=1 makes reset non-deterministic.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.STATE_FILE;
if (process.argv[2] === 'reset')
  writeFileSync(
    file,
    JSON.stringify({
      bookings: [],
      otherCustomer: { id: 'customer_9', bookings: 2 },
      ...(process.env.STATE_DRIFT === '1' ? { seed: process.hrtime.bigint().toString() } : {}),
    }),
  );
else process.stdout.write(readFileSync(file, 'utf8'));
