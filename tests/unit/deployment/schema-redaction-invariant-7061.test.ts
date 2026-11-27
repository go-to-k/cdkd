/**
 * go-to-k/cdkd#7061 slice (c): the type-agnostic redaction invariant,
 * generated from the CloudFormation registry schemas.
 *
 * The cases: every path of `tests/fixtures/cfn-registry-secret-paths.json`
 * (each type's `writeOnlyProperties` and every property NAMED as a secret,
 * refreshed weekly by `vp run gen:cfn-registry-secret-paths`), deduplicated
 * per type, and each seeded three ways, each a PROVENANCE the redaction reads:
 * a unique `secretsmanager` reference as the WHOLE value, one EMBEDDED in
 * surrounding text, and a `NoEcho` parameter (`{ Ref }`). The resolved pass
 * holds the plaintext. The names in the snapshot only SELECT the paths;
 * state redaction is driven by value and provenance. It sits at the path in `properties`, and
 * the provider's readback echoes it in `observedProperties`.
 *
 * Sampling rule: none. Every path is a case, so the run is bounded by the
 * snapshot, and the population is asserted between a floor and a cap
 * ({@link MIN_CASES}, {@link MAX_CASES}).
 *
 * Shapes: a top-level string, a nested object leaf, an array item (`*`), and a
 * create-only path (from `cfn-registry-create-only-paths.json`). Each shape has
 * a floor.
 *
 * For each case, through the writer choke point (`scrubResourceRecord`):
 * 1. no plaintext reaches the persisted record;
 * 2. an unchanged redeploy plans no change. The persisted `properties` equal
 *    what the diff side computes: the template's own spelling of a reference
 *    it keeps unresolved, or the mask a `NoEcho` parameter is redacted to.
 *
 * A case that may not hold is listed in {@link EXCEPTIONS} with its reason,
 * and an entry that no longer fails is itself a failure.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import {
  SECRET_MASK,
  recordMaskOnlyValue,
  recordResolvedPair,
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');
interface SecretPaths {
  writeOnly: string[][];
  secretNamed: string[][];
}
const SNAPSHOT = JSON.parse(readFileSync(join(FIXTURES, 'cfn-registry-secret-paths.json'), 'utf8')) as {
  types: Record<string, SecretPaths>;
};
const CREATE_ONLY = JSON.parse(readFileSync(join(FIXTURES, 'cfn-registry-create-only-paths.json'), 'utf8')) as {
  types: Record<string, string[][]>;
};

/** A literal floor and cap the generator does not read: a snapshot that lost its types, or grew past the runtime bound. */
const MIN_CASES = 1500;
const MAX_CASES = 6000;

type Shape = 'top-level' | 'nested' | 'array-item' | 'create-only';
interface Case {
  readonly type: string;
  readonly path: readonly string[];
  readonly kinds: readonly ('writeOnly' | 'secretNamed')[];
  readonly shapes: readonly Shape[];
}

function casesOf(): Case[] {
  const out: Case[] = [];
  for (const [type, paths] of Object.entries(SNAPSHOT.types).sort(([a], [b]) => a.localeCompare(b))) {
    const createOnly = new Set((CREATE_ONLY.types[type] ?? []).map((p) => p.join('/')));
    const byPath = new Map<string, Set<'writeOnly' | 'secretNamed'>>();
    for (const kind of ['writeOnly', 'secretNamed'] as const) {
      for (const path of paths[kind]) {
        const key = path.join('/');
        byPath.set(key, (byPath.get(key) ?? new Set()).add(kind));
      }
    }
    for (const [key, kinds] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
      const path = key.split('/');
      const shapes: Shape[] = [path.includes('*') ? 'array-item' : path.length === 1 ? 'top-level' : 'nested'];
      if (createOnly.has(key) || createOnly.has(path[0]!)) shapes.push('create-only');
      out.push({ type, path, kinds: [...kinds], shapes });
    }
  }
  return out;
}

/** `value` placed at `path` (`*` is the first item of a one-item list). */
function placed(path: readonly string[], value: unknown): Record<string, unknown> {
  const build = (i: number): unknown => {
    if (i === path.length) return value;
    return path[i] === '*' ? [build(i + 1)] : { [path[i]!]: build(i + 1) };
  };
  return build(0) as Record<string, unknown>;
}

/**
 * How the secret reaches the path: a dynamic reference as the whole value, one
 * embedded in text, or a `NoEcho` parameter (`{ Ref }`, persisted as the mask).
 */
type Form = 'whole' | 'embedded' | 'noecho';
const FORMS: readonly Form[] = ['whole', 'embedded', 'noecho'];
function scrubbed(
  c: Case,
  index: number,
  form: Form
): { persisted: unknown; source: Record<string, unknown>; expected: Record<string, unknown>; plaintext: string } {
  const plaintext = `inv7061-pl4intext-${index}-${form}`;
  const expression = `{{resolve:secretsmanager:inv7061/${index}:SecretString:${form}::}}`;
  const wrap = (v: string): string => (form === 'embedded' ? `pre-${v}-post` : v);
  const secrets: RecordedSecretValues = new Map();
  if (form === 'noecho') {
    recordMaskOnlyValue(secrets, plaintext);
  } else {
    secrets.set(plaintext, expression);
    recordResolvedPair(secrets, expression, plaintext);
  }
  const source = placed(c.path, form === 'noecho' ? { Ref: 'SecretParam' } : wrap(expression));
  // What the diff side computes for the key: the reference kept as written, or
  // the mask a `NoEcho` parameter is redacted to.
  const expected = form === 'noecho' ? placed(c.path, SECRET_MASK) : source;
  const record = {
    properties: placed(c.path, wrap(plaintext)),
    attributes: {},
    observedProperties: placed(c.path, wrap(plaintext)),
  };
  return { persisted: scrubResourceRecord(record, secrets, source), source, expected, plaintext };
}

/**
 * Cases allowed to break the invariant, keyed `<type> <path> <form>`, with why.
 * Empty: every generated case holds.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {};

describe('schema redaction invariant (go-to-k/cdkd#7061 slice (c))', { timeout: CONTENDED_CASE_TIMEOUT_MS }, () => {
  const cases = casesOf();

  it('the population is between its floor and cap, with every shape and kind represented', () => {
    expect(cases.length).toBeGreaterThanOrEqual(MIN_CASES);
    expect(cases.length).toBeLessThanOrEqual(MAX_CASES);
    const count = (shape: Shape): number => cases.filter((c) => c.shapes.includes(shape)).length;
    expect(count('top-level')).toBeGreaterThanOrEqual(500);
    expect(count('nested')).toBeGreaterThanOrEqual(100);
    expect(count('array-item')).toBeGreaterThanOrEqual(50);
    expect(count('create-only')).toBeGreaterThanOrEqual(50);
    expect(cases.filter((c) => c.kinds.includes('writeOnly')).length).toBeGreaterThanOrEqual(1000);
    expect(cases.filter((c) => c.kinds.includes('secretNamed')).length).toBeGreaterThanOrEqual(500);
  });

  it('every write-only and secret-named path is redacted on persist and plans no change on an unchanged redeploy', () => {
    const failures: string[] = [];
    const excepted = new Set<string>();
    cases.forEach((c, index) => {
      for (const form of FORMS) {
        const key = `${c.type} ${c.path.join('/')} ${form}`;
        const { persisted, expected, plaintext } = scrubbed(c, index, form);
        const record = persisted as { properties: unknown; observedProperties?: unknown };
        const problems: string[] = [];
        if (JSON.stringify(persisted).includes(plaintext)) problems.push('plaintext persisted');
        if (JSON.stringify(record.properties) !== JSON.stringify(expected)) problems.push('properties differ from what the diff side computes');
        if (problems.length === 0) continue;
        if (Object.hasOwn(EXCEPTIONS, key)) excepted.add(key);
        else failures.push(`${key}: ${problems.join(', ')}`);
      }
    });
    expect(failures).toEqual([]);
    // An exception that no longer fails is stale.
    expect(Object.keys(EXCEPTIONS).filter((k) => !excepted.has(k))).toEqual([]);
  });

  it('probe: a persist that kept the plaintext fails the invariant', () => {
    const c = cases[0]!;
    const { expected, plaintext } = scrubbed(c, 0, 'whole');
    const leaked = { properties: placed(c.path, plaintext) };
    expect(JSON.stringify(leaked).includes(plaintext)).toBe(true);
    expect(JSON.stringify(leaked.properties)).not.toBe(JSON.stringify(expected));
  });
});
