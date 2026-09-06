// The TypeScript digest implementation (src/digest.ts) and the dependency-free
// CommonJS mirror (scripts/pack-digest.js) must produce byte-identical output:
// the registry uses the former, packs and the runner use the latter, and a
// ProtocolVersion.harness_digest computed by one must verify with the other.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computePackDigests,
  fileDigest,
  listFiles,
  protocolDigest,
  staleFields,
  treeDigest,
} from '../src/digest.js';

interface ScriptApi {
  listFiles(dir: string): Array<[string, string]>;
  treeDigest(dir: string): string;
  fileDigest(file: string): string;
  protocolDigest(protocol: Record<string, unknown>): string;
  computePackDigests(packDir: string): {
    pack_id: string;
    pack_digest: string;
    harness_digest: string;
    protocols: Record<string, { expected: Record<string, unknown> }>;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const script = createRequire(import.meta.url)(
  join(repoRoot, 'scripts', 'pack-digest.js'),
) as ScriptApi;
const packDir = join(repoRoot, 'packs', 'inference-api');

test('tree digests agree with scripts/pack-digest.js on the committed pack', () => {
  assert.equal(treeDigest(packDir), script.treeDigest(packDir));
  assert.equal(treeDigest(join(packDir, 'harness')), script.treeDigest(join(packDir, 'harness')));
  assert.deepEqual(listFiles(packDir), script.listFiles(packDir));
  const protocol = join(packDir, 'protocols', 'latency', 'protocol.json');
  assert.equal(fileDigest(protocol), script.fileDigest(protocol));
});

test('computePackDigests agrees with the script and the committed protocol.json is current', () => {
  const ours = computePackDigests(packDir);
  const theirs = script.computePackDigests(packDir);
  assert.equal(ours.pack_id, theirs.pack_id);
  assert.equal(ours.pack_digest, theirs.pack_digest);
  assert.equal(ours.harness_digest, theirs.harness_digest);
  for (const [ref, entry] of Object.entries(ours.protocols)) {
    assert.deepEqual(entry.expected, theirs.protocols[ref]?.expected, ref);
    assert.deepEqual(staleFields(entry.current, entry.expected), [], `${ref} is stale`);
  }
});

test('tree digest encoding on a synthetic tree (nesting, unicode, node_modules skipped)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwik-digest-'));
  try {
    mkdirSync(join(dir, 'b', 'inner'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'alpha');
    writeFileSync(join(dir, 'B.txt'), 'beta');
    writeFileSync(join(dir, 'b', 'inner', 'z.json'), '{"k":1}');
    writeFileSync(join(dir, 'b', 'é.txt'), 'accent');
    writeFileSync(join(dir, 'node_modules', 'x', 'skip.js'), 'ignored');
    const files = listFiles(dir);
    assert.deepEqual(
      files.map(([rel]) => rel),
      ['B.txt', 'a.txt', 'b/inner/z.json', 'b/é.txt'],
    );
    assert.deepEqual(files, script.listFiles(dir));
    assert.equal(treeDigest(dir), script.treeDigest(dir));
    // Content-sensitive: change one byte, the digest changes.
    const before = treeDigest(dir);
    writeFileSync(join(dir, 'a.txt'), 'alphb');
    assert.notEqual(treeDigest(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protocol digest ignores its own member and agrees with the script', () => {
  const doc = { ref: 'x/y@1', protocol_digest: 'sha256:stale', b: [1, 2], a: { z: true } };
  const withoutMember = { ref: 'x/y@1', b: [1, 2], a: { z: true } };
  assert.equal(protocolDigest(doc), protocolDigest(withoutMember));
  assert.equal(protocolDigest(doc), script.protocolDigest(doc));
  assert.match(protocolDigest(doc), /^sha256:[0-9a-f]{64}$/);
});
