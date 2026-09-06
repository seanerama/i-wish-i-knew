// Conformance suite: every *.valid.json passes; every other fixture fails
// with at least the expected { path, rule } issues (contracts/fixtures/v1).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/validate.js';
import type { EntityName } from '../src/v1/index.js';
import { entityNames } from '../src/v1/index.js';

interface FixtureEntry {
  file: string;
  entity: EntityName;
  valid: boolean;
  expect?: Array<{ path: string; rule: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '..', '..', '..', 'contracts', 'fixtures', 'v1');
const index = JSON.parse(readFileSync(join(fixtureDir, 'index.json'), 'utf8')) as {
  fixtures: FixtureEntry[];
};

function load(file: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'));
}

test('every fixture file is listed in index.json and vice versa', () => {
  const onDisk = readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort();
  const listed = index.fixtures.map((f) => f.file).sort();
  assert.deepEqual(onDisk, listed);
  for (const entry of index.fixtures) {
    assert.ok(entityNames.includes(entry.entity), `${entry.file}: unknown entity ${entry.entity}`);
    assert.equal(entry.file.endsWith('.valid.json'), entry.valid, `${entry.file}: name/valid flag`);
  }
});

for (const entry of index.fixtures) {
  if (entry.valid) {
    test(`${entry.file} validates as ${entry.entity}`, () => {
      const result = validate(entry.entity, load(entry.file));
      assert.deepEqual(result, { ok: true, errors: [] });
    });
  } else {
    test(`${entry.file} fails as ${entry.entity} with the expected issues`, () => {
      const result = validate(entry.entity, load(entry.file));
      assert.equal(result.ok, false);
      assert.ok(
        entry.expect !== undefined && entry.expect.length > 0,
        'invalid fixture needs expect',
      );
      for (const expected of entry.expect) {
        const found = result.errors.some(
          (e) => e.path === expected.path && e.rule === expected.rule,
        );
        assert.ok(
          found,
          `expected ${JSON.stringify(expected)} in ${JSON.stringify(result.errors)}`,
        );
      }
    });
  }
}

test('validation errors never echo submitted values', () => {
  const marker = 'sk-live-THIS-VALUE-MUST-NOT-APPEAR-9f8e7d6c';
  const run = load('run.valid.json') as Record<string, unknown>;
  const result = validate('Run', { ...run, run_id: marker, smuggled: marker });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2);
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('every entity schema compiles and rejects a non-object', () => {
  for (const entity of entityNames) {
    const result = validate(entity, 'not-an-object');
    assert.equal(result.ok, false, entity);
    assert.ok(
      result.errors.some((e) => e.rule === 'type'),
      entity,
    );
  }
});
