// Secret-pattern rescan and string-length limit, in isolation (no database).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_SECRET_PATTERNS, sanitizeValue } from '../src/modules/intake/sanitize.js';
import { loadFixtureRun } from './helpers.js';

const options = { maxStringLength: 1024, extraPatterns: [] };

test('the conformance fixture is clean', () => {
  const { issues, report } = sanitizeValue(loadFixtureRun(), options);
  assert.deepEqual(issues, []);
  assert.ok(report.strings_checked > 40);
  assert.deepEqual(report.patterns.slice(0, 2), ['aws_access_key', 'bearer_token']);
});

test('each built-in pattern catches its example and reports the path only', () => {
  const samples: Array<[string, string]> = [
    ['aws_access_key', 'key=' + 'AKIA' + 'IOSFODNN7EXAMPLE'],
    ['bearer_token', 'header value Bearer ' + 'a'.repeat(32)],
    ['basic_auth_header', 'Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0NTY='],
    ['private_key_block', '-----BEGIN RSA ' + 'PRIVATE KEY-----'],
    ['url_with_credentials', 'postgres://alice:hunter2@db.internal:5432/app'],
    ['openai_style_key', 'sk-' + 'proj-' + 'A'.repeat(24)],
    ['github_token', 'ghp_' + 'a'.repeat(36)],
    ['github_fine_grained_token', 'github_pat_' + 'A'.repeat(30)],
    ['slack_token', 'xoxb-' + '1234567890-abcdef'],
    ['google_api_key', 'AIza' + 'A'.repeat(35)],
    ['jwt', 'eyJ' + 'a'.repeat(12) + '.' + 'eyJ' + 'b'.repeat(12) + '.' + 'c'.repeat(12)],
    ['stripe_key', 'sk_live_' + 'a'.repeat(24)],
    ['password_assignment', 'password=' + 'a'.repeat(12)],
  ];
  for (const [name, sample] of samples) {
    const pattern = BUILTIN_SECRET_PATTERNS.find((p) => p.name === name);
    assert.ok(pattern, name);
    assert.ok(pattern.regex.test(sample), `${name} should match its sample`);
    const { issues } = sanitizeValue({ context: [{ key: 'k', value: sample }] }, options);
    assert.deepEqual(issues, [{ path: '/context/0/value', rule: 'secret_pattern' }], name);
    assert.ok(!JSON.stringify(issues).includes(sample));
  }
});

test('object keys, nested arrays, and length are checked; pointer segments are escaped', () => {
  const value = {
    result: { 'a/b': { note: 'x'.repeat(1025) } },
    list: [['fine'], ['-----BEGIN EC ' + 'PRIVATE KEY-----']],
    ['ghp_' + 'b'.repeat(36)]: 1,
  };
  const { issues } = sanitizeValue(value, options);
  assert.deepEqual(issues, [
    { path: '/result/a~1b/note', rule: 'string_too_long' },
    { path: '/list/1/0', rule: 'secret_pattern' },
    { path: '/ghp_' + 'b'.repeat(36), rule: 'secret_pattern' },
  ]);
});

test('configured patterns extend the built-ins', () => {
  const { issues, report } = sanitizeValue(
    { context: [{ key: 'k', value: 'ACME-INTERNAL-7788' }] },
    { maxStringLength: 1024, extraPatterns: ['ACME-INTERNAL-\\d{4}'] },
  );
  assert.deepEqual(issues, [{ path: '/context/0/value', rule: 'secret_pattern' }]);
  assert.ok(report.patterns.includes('configured_1'));
});

test('ordinary values do not trip the rules', () => {
  const clean = {
    strings: [
      'stub-model',
      'inference-api/latency@1',
      'https://api.example.test/v1/chat/completions',
      'sha256:' + 'ab'.repeat(32),
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      'max_tokens: 64',
      'self-reported by the operator',
    ],
  };
  assert.deepEqual(sanitizeValue(clean, options).issues, []);
});
