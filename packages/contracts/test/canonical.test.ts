// JCS vectors from RFC 8785 (§3.2.2, §3.2.3, Appendix B).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, digest } from '../src/canonical.js';

test('RFC 8785 §3.2.3 example: primitives and property sorting', () => {
  const input = JSON.parse(
    '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
      ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
      ' "literals": [null, true, false]}',
  ) as unknown;
  assert.equal(
    canonicalize(input),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
});

test('RFC 8785 §3.2.3 property names sort by UTF-16 code units', () => {
  const input = JSON.parse(
    '{"\\u20ac": "Euro Sign", "\\r": "Carriage Return",' +
      ' "\\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One",' +
      ' "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control",' +
      ' "\\u00f6": "Latin Small Letter O With Diaeresis"}',
  ) as unknown;
  const out = canonicalize(input);
  // Read the values back in serialized order (JSON.parse would move the
  // integer-like key "1" first, which is a JS object quirk, not JCS).
  const values = [...out.matchAll(/:"([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(values, [
    'Carriage Return',
    'One',
    'Control',
    'Latin Small Letter O With Diaeresis',
    'Euro Sign',
    'Emoji: Grinning Face',
    'Hebrew Letter Dalet With Dagesh',
  ]);
  assert.ok(out.startsWith('{"\\r":"Carriage Return","1":"One","":"Control"'));
});

test('RFC 8785 Appendix B number serialization samples', () => {
  const samples: Array<[string, string]> = [
    ['0', '0'],
    ['-0', '0'],
    ['5e-324', '5e-324'],
    ['-5e-324', '-5e-324'],
    ['1.7976931348623157e+308', '1.7976931348623157e+308'],
    ['9007199254740992', '9007199254740992'],
    ['-9007199254740992', '-9007199254740992'],
    ['295147905179352830000', '295147905179352830000'],
    ['9.999999999999997e+22', '9.999999999999997e+22'],
    ['1e+23', '1e+23'],
    ['1.0000000000000001e+23', '1.0000000000000001e+23'],
    ['999999999999999700000', '999999999999999700000'],
    ['999999999999999900000', '999999999999999900000'],
    ['1e+21', '1e+21'],
    ['9.999999999999997e-7', '9.999999999999997e-7'],
    ['0.000001', '0.000001'],
    ['333333333.3333332', '333333333.3333332'],
    ['333333333.33333325', '333333333.33333325'],
    ['333333333.3333333', '333333333.3333333'],
    ['333333333.3333334', '333333333.3333334'],
    ['333333333.33333343', '333333333.33333343'],
    ['-0.0000033333333333333333', '-0.0000033333333333333333'],
  ];
  for (const [text, expected] of samples) {
    assert.equal(canonicalize(JSON.parse(text)), expected, text);
  }
});

test('nested objects sort recursively while arrays keep order', () => {
  const input = { b: [{ z: 1, a: 2 }, 3, { y: { d: 1, c: 2 } }], a: 'x' };
  assert.equal(canonicalize(input), '{"a":"x","b":[{"a":2,"z":1},3,{"y":{"c":2,"d":1}}]}');
});

test('canonicalization is insensitive to key insertion order and whitespace', () => {
  const a = JSON.parse('{ "k": 1,   "j": [ 1, 2 ] }') as unknown;
  const b = JSON.parse('{"j":[1,2],"k":1}') as unknown;
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(digest(a), digest(b));
  assert.match(digest(a), /^sha256:[0-9a-f]{64}$/);
});

test('rejects values with no JSON form', () => {
  assert.throws(() => canonicalize(undefined), TypeError);
  assert.throws(() => canonicalize(() => 1), TypeError);
  assert.throws(() => canonicalize({ n: Number.NaN }), TypeError);
  assert.throws(() => canonicalize([Number.POSITIVE_INFINITY]), TypeError);
});
