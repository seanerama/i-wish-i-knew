// Emit the frozen JSON Schema artifacts (ADR-0005).
//
//   tsx bin/build.ts          write contracts/schema/v1/<Entity>.schema.json
//                             and contracts/schema/v1/tools/<tool>.<side>.schema.json
//   tsx bin/build.ts --check  rebuild into a temp dir and diff against the
//                             committed files; exit 1 on any drift
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaDocument, toolSchemaDocument, toolSchemaFile } from '../src/schema.js';
import type { ToolSide } from '../src/schema.js';
import { entityNames } from '../src/v1/index.js';
import { toolNames } from '../src/v1/tools/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const committedDir = resolve(here, '..', '..', '..', 'contracts', 'schema', 'v1');
const TOOLS_DIR = 'tools';
const SIDES: ToolSide[] = ['input', 'output'];

function renderJson(document: Record<string, unknown>): string {
  return JSON.stringify(document, null, 2) + '\n';
}

/** Every artifact as `relative path -> content`, so build and check share one list. */
function artifacts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const entity of entityNames) {
    out.set(`${entity}.schema.json`, renderJson(schemaDocument(entity)));
  }
  for (const tool of toolNames) {
    for (const side of SIDES) {
      out.set(
        join(TOOLS_DIR, toolSchemaFile(tool, side)),
        renderJson(toolSchemaDocument(tool, side)),
      );
    }
  }
  return out;
}

function build(outDir: string): number {
  const files = artifacts();
  mkdirSync(join(outDir, TOOLS_DIR), { recursive: true });
  for (const [rel, content] of files) writeFileSync(join(outDir, rel), content, 'utf8');
  return files.size;
}

function listSchemaFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.schema.json'));
  } catch {
    names = [];
  }
  let toolNamesOnDisk: string[];
  try {
    toolNamesOnDisk = readdirSync(join(dir, TOOLS_DIR))
      .filter((f) => f.endsWith('.schema.json'))
      .map((f) => join(TOOLS_DIR, f));
  } catch {
    toolNamesOnDisk = [];
  }
  return [...names, ...toolNamesOnDisk];
}

function check(): number {
  const tmp = mkdtempSync(join(tmpdir(), 'iwik-contracts-'));
  try {
    build(tmp);
    const expected = new Set(listSchemaFiles(tmp));
    const committed = new Set(listSchemaFiles(committedDir));
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
  const count = build(committedDir);
  console.log(`wrote ${count} schema file(s) to ${committedDir}`);
} else {
  console.error(`usage: build.ts [--check]`);
  process.exitCode = 2;
}
