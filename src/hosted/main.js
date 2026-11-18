#!/usr/bin/env node
/** `sf-host`: standalone entry of the hosted connector (same commands as `sf host`). */

import { runHostCli } from './cli.js';

try {
  await runHostCli(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`sf-host: Error: ${err.message}\n`);
  process.exit(1);
}
