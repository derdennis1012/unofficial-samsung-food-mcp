#!/usr/bin/env node
/** Standalone entry for the local HTTP API (`sf-api`); same flags as `sf serve`. */

import { runServe, parseFlags } from './serve.js';

const log = (msg) => process.stderr.write(`sf-api: ${msg}\n`);

try {
  await runServe(parseFlags(process.argv.slice(2)));
} catch (err) {
  log(`Error: ${err.message}`);
  process.exit(1);
}
