// SKILL.md lint: the file ships with the runner, is what `iwik mcp` hands
// clients as instructions, and carries the sections the agent-tools
// contract asks for, including "Never send".
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SKILL_PATH, skillText } from '../src/index.js';
import { repoRoot } from './helpers.js';

test('SKILL.md exists at the runner root, ships in the package, and is served as MCP instructions', () => {
  assert.equal(SKILL_PATH, join(repoRoot, 'packages', 'runner', 'SKILL.md'));
  assert.ok(existsSync(SKILL_PATH));
  const text = readFileSync(SKILL_PATH, 'utf8');
  assert.equal(skillText(), text);
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, 'packages', 'runner', 'package.json'), 'utf8'),
  ) as {
    files: string[];
  };
  assert.ok(pkg.files.includes('SKILL.md'));
  assert.ok(pkg.files.includes('schema'));
});

test('SKILL.md covers when to query, how to read an answer, when to propose a test, suppression, and never send', () => {
  const text = readFileSync(SKILL_PATH, 'utf8');
  for (const heading of [
    '## When to query',
    '## How to read a released answer',
    '## When to propose a test',
    '## How to explain a suppressed or insufficient answer',
    '## Never send',
  ]) {
    assert.ok(text.includes(heading), `missing section ${heading}`);
  }
  for (const term of [
    'applicability',
    'uncertainty',
    'freshness',
    'plan_test',
    'run_test',
    'iwik run --plan',
  ]) {
    assert.ok(text.includes(term), `missing ${term}`);
  }
  const neverSend = text.slice(text.indexOf('## Never send'));
  for (const term of [
    'Secrets',
    'API keys',
    'Hostnames',
    'IP addresses',
    'Prompts',
    'completions',
  ]) {
    assert.ok(neverSend.includes(term), `never-send section must name ${term}`);
  }
  assert.ok(/Local evidence only/.test(text));
  assert.ok(/insufficient_evidence/.test(text));
  assert.ok(/not_yet_available/.test(text));
});
