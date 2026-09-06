// Emit the frozen JSON Schema artifacts (ADR-0005).
//
//   tsx bin/build.ts          write contracts/schema/v1/<Entity>.schema.json
//   tsx bin/build.ts --check  rebuild into a temp dir and diff against the
//                             committed files; exit 1 on any drift
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaDocument } from '../src/schema.js';
import { entityNames } from '../src/v1/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const committedDir = resolve(here, '..', '..', '..', 'contracts', 'schema', 'v1');

function render(entity: string): string {
  return JSON.stringify(schemaDocument(entity as (typeof entityNames)[number]), null, 2) + '\n';
}

function fileName(entity: string): string {
  return `${entity}.schema.json`;
}

function build(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const entity of entityNames) {
    writeFileSync(join(outDir, fileName(entity)), render(entity), 'utf8');
  }
}

function check(): number {
  const tmp = mkdtempSync(join(tmpdir(), 'iwik-contracts-'));
  try {
    build(tmp);
    const expected = new Set(readdirSync(tmp));
    let committed: Set<string>;
    try {
      committed = new Set(readdirSync(committedDir).filter((f) => f.endsWith('.schema.json')));
    } catch {
      committed = new Set();
    }
    const drift: string[] = [];
    for (const name of expected) {
      if (!committed.has(name)) {
        drift.push(`missing: ${name}`);
        continue;
      }
      const a = readFileSync(join(tmp, name), 'utf8');
      const b = readFileSync(join(committedDir, name), 'utf8');
      if (a !== b) drift.push(`changed: ${name}`);
    }
    for (const name of committed) {
      if (!expected.has(name)) drift.push(`stale: ${name}`);
    }
    if (drift.length > 0) {
      console.error('contracts:check FAILED — committed schema artifacts drift from source:');
      for (const line of drift) console.error('  ' + line);
      console.error('run `npm run contracts:build` and commit the result.');
      return 1;
    }
    console.log(`contracts:check ok — ${expected.size} schema file(s) match ${committedDir}`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === '--check') {
  process.exitCode = check();
} else if (mode === undefined) {
  build(committedDir);
  console.log(`wrote ${entityNames.length} schema file(s) to ${committedDir}`);
} else {
  console.error(`usage: build.ts [--check]`);
  process.exitCode = 2;
}
