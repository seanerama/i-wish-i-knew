#!/usr/bin/env node
'use strict';
// `iwik` entrypoint: the CLI itself is ESM under dist/ (built by `npm run build`).
import('../dist/cli.js').catch((err) => {
  process.stderr.write('iwik: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
