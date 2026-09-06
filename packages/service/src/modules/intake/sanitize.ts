// Intake rescan (ADR-0002 control 3): every string anywhere in a submitted
// Run is checked against secret patterns and a length limit. A hit rejects
// the whole submission with `{ path, rule }` only; the value is never
// surfaced, logged, or stored.
import type { ErrorDetail } from '../../errors.js';

export interface SecretPattern {
  name: string;
  regex: RegExp;
}

export const BUILTIN_SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'aws_access_key',
    regex: /(?:^|[^A-Z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}(?![A-Z0-9])/,
  },
  { name: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: 'basic_auth_header', regex: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/ },
  { name: 'private_key_block', regex: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/ },
  { name: 'url_with_credentials', regex: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  { name: 'openai_style_key', regex: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'github_token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/ },
  { name: 'github_fine_grained_token', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { name: 'slack_token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'stripe_key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  {
    name: 'password_assignment',
    regex: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*\S{6,}/i,
  },
];

export interface SanitizeOptions {
  maxStringLength: number;
  extraPatterns: readonly string[];
}

export interface SanitizationReport {
  strings_checked: number;
  max_string_length: number;
  rules: string[];
  patterns: string[];
}

export interface SanitizeResult {
  issues: ErrorDetail[];
  report: SanitizationReport;
}

export function compilePatterns(extra: readonly string[]): SecretPattern[] {
  return [
    ...BUILTIN_SECRET_PATTERNS,
    ...extra.map((source, i) => ({ name: `configured_${i + 1}`, regex: new RegExp(source) })),
  ];
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Walk any JSON value and report every string that trips a rule. */
export function sanitizeValue(value: unknown, options: SanitizeOptions): SanitizeResult {
  const patterns = compilePatterns(options.extraPatterns);
  const issues: ErrorDetail[] = [];
  let checked = 0;

  const check = (text: string, path: string): void => {
    checked += 1;
    if (text.length > options.maxStringLength) {
      issues.push({ path, rule: 'string_too_long' });
    }
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) {
        issues.push({ path, rule: 'secret_pattern' });
        break;
      }
    }
  };

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      check(node, path);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}/${i}`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        const childPath = `${path}/${escapePointer(key)}`;
        // Object keys are strings too (free-form `result` and `filters` maps).
        check(key, childPath);
        walk(item, childPath);
      }
    }
  };

  walk(value, '');
  return {
    issues,
    report: {
      strings_checked: checked,
      max_string_length: options.maxStringLength,
      rules: ['secret_pattern', 'string_too_long'],
      patterns: patterns.map((p) => p.name),
    },
  };
}
