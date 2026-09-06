#!/usr/bin/env node
'use strict';
// Pack and harness digests (contracts/runner-pack.md; encoding in packs/README.md).
//
//   node scripts/pack-digest.js <pack-dir>            print digests as JSON
//   node scripts/pack-digest.js <pack-dir> --check    exit 1 if any protocol.json
//                                                     digest field is stale
//   node scripts/pack-digest.js <pack-dir> --write    rewrite protocol.json digest fields
//
// Node built-ins only, so it can run anywhere the runner runs.
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256Hex(data) {
  return nodeCrypto.createHash('sha256').update(data).digest('hex');
}

/** RFC 8785 canonical JSON (mirror of packages/contracts/src/canonical.ts). */
function canonicalize(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('value has no JSON representation');
  return serialize(JSON.parse(text));
}

function serialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(serialize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(value[k])).join(',') + '}';
}

/** Sorted (relative path, sha256) pairs for every regular file under `dir`. */
function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(dir, full).split(path.sep).join('/');
        out.push([rel, sha256Hex(fs.readFileSync(full))]);
      }
    }
  };
  walk(dir);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/** `sha256:<hex>` over the sorted `<path>\t<sha256>\n` lines. */
function treeDigest(dir) {
  const lines = listFiles(dir).map(([rel, hex]) => `${rel}\t${hex}\n`);
  return 'sha256:' + sha256Hex(lines.join(''));
}

function fileDigest(file) {
  return 'sha256:' + sha256Hex(fs.readFileSync(file));
}

/** Digest of a protocol.json document with its own `protocol_digest` removed. */
function protocolDigest(protocol) {
  const copy = { ...protocol };
  delete copy.protocol_digest;
  return 'sha256:' + sha256Hex(Buffer.from(canonicalize(copy), 'utf8'));
}

function computePackDigests(packDir) {
  const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
  const harnessDir = path.join(packDir, 'harness');
  const harnessDigest = treeDigest(harnessDir);
  const protocols = {};
  for (const entry of pack.protocols) {
    const name = entry.split('@')[0];
    const dir = path.join(packDir, 'protocols', name);
    const file = path.join(dir, 'protocol.json');
    const protocol = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expected = {
      ...protocol,
      harness_digest: harnessDigest,
      context_schema_digest: fileDigest(path.join(dir, 'context.schema.json')),
      result_schema_digest: fileDigest(path.join(dir, 'result.schema.json')),
      compatibility: {
        ...(protocol.compatibility || {}),
        harness_digests: [harnessDigest],
      },
    };
    expected.protocol_digest = protocolDigest(expected);
    protocols[entry] = { file, current: protocol, expected };
  }
  return {
    pack_id: pack.id,
    pack_digest: treeDigest(packDir),
    harness_digest: harnessDigest,
    protocols,
  };
}

function staleFields(current, expected) {
  const fields = [
    'protocol_digest',
    'harness_digest',
    'context_schema_digest',
    'result_schema_digest',
  ];
  const stale = fields.filter((f) => current[f] !== expected[f]);
  const currentCompat = (current.compatibility && current.compatibility.harness_digests) || [];
  if (JSON.stringify(currentCompat) !== JSON.stringify(expected.compatibility.harness_digests)) {
    stale.push('compatibility.harness_digests');
  }
  return stale;
}

function main(argv) {
  const packDir = argv[0];
  const mode = argv[1];
  if (!packDir) {
    process.stderr.write('usage: pack-digest.js <pack-dir> [--check|--write]\n');
    return 2;
  }
  const digests = computePackDigests(path.resolve(packDir));
  if (mode === '--check') {
    let stale = 0;
    for (const [ref, { file, current, expected }] of Object.entries(digests.protocols)) {
      const fields = staleFields(current, expected);
      if (fields.length > 0) {
        stale += 1;
        process.stderr.write(`${ref}: stale ${fields.join(', ')} in ${file}\n`);
      }
    }
    if (stale > 0) {
      process.stderr.write('run `node scripts/pack-digest.js <pack-dir> --write` and commit.\n');
      return 1;
    }
    process.stdout.write(`pack digests ok: ${digests.pack_id} ${digests.pack_digest}\n`);
    return 0;
  }
  if (mode === '--write') {
    for (const { file, expected } of Object.values(digests.protocols)) {
      fs.writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
    }
    process.stdout.write(`wrote digests for ${digests.pack_id}\n`);
    return 0;
  }
  const out = {
    pack_id: digests.pack_id,
    pack_digest: digests.pack_digest,
    harness_digest: digests.harness_digest,
    protocols: Object.fromEntries(
      Object.entries(digests.protocols).map(([ref, { expected }]) => [
        ref,
        {
          protocol_digest: expected.protocol_digest,
          context_schema_digest: expected.context_schema_digest,
          result_schema_digest: expected.result_schema_digest,
        },
      ]),
    ),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

module.exports = {
  canonicalize,
  listFiles,
  treeDigest,
  fileDigest,
  protocolDigest,
  computePackDigests,
  staleFields,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
