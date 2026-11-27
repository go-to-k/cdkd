/**
 * go-to-k/cdkd#7061 slice (c): the type-agnostic redaction invariant,
 * generated from the CloudFormation registry schemas.
 *
 * The cases: every path of `tests/fixtures/cfn-registry-secret-paths.json`
 * (each type's `writeOnlyProperties`, every property NAMED as a secret, and
 * every map value, go-to-k/cdkd#7151; refreshed weekly by
 * `vp run gen:cfn-registry-secret-paths`), deduplicated per type
 * (`schema-redaction-cases.ts`), and each seeded three ways, each a PROVENANCE the redaction reads:
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
 * Shapes: a top-level string, a nested object leaf, an array item (`*`), a map
 * value (`<key>`, the second entry of its map), and a create-only path (from `cfn-registry-create-only-paths.json`). Each shape has
 * a floor.
 *
 * For each case, through the writer choke point (`scrubResourceRecord`):
 * 1. no plaintext reaches the persisted record;
 * 2. an unchanged redeploy plans no change. The diff side's desired bag is
 *    the template's own spelling of a reference it keeps unresolved, or, for a
 *    `NoEcho` parameter, what the deploy diff's own `NoEcho` comparison
 *    (`noEchoComparisonForTemplate`) makes of both sides. It equals the
 *    persisted bag.
 *
 * Each case runs under both writer claims: none, and the same-generation
 * claim every deploy-written record states (`sameGenerationClaimsOf`). An array
 * item sits SECOND in its list, after a plain one. The plaintext is also echoed
 * as an attribute, and by the readback under a key the template lacks.
 *
 * NOT claimed here, and claimed by `schema-redaction-invariant-holes-7151.test.ts`
 * over the same population: the unchanged-resource arm with no template bag, a
 * `NoEcho` value embedded in text or under the needle floor, the whole persist
 * pipeline (`applyNoEchoPersist` after this choke point), the other writers'
 * call shapes, one plaintext at two paths, and a map KEY.
 * The `create-only` shape is a label: the redaction reads nothing create-only.
 *
 * The redaction reads values and provenance, never a property's name or path,
 * so today every case runs the same code path. The path dimension guards
 * against path-specific logic landing later.
 *
 * A case that may not hold is listed in {@link EXCEPTIONS} with its reason,
 * and an entry that no longer fails is itself a failure.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  recordMaskOnlyValue,
  recordResolvedPair,
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { noEchoComparisonForTemplate } from '../../../src/deployment/deploy-engine/noecho.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';
import { casesOf, placed, type Case, type Shape } from './schema-redaction-cases.js';

/** A literal floor and cap the generator does not read: a snapshot that lost its types, or grew past the runtime bound. */
const MIN_CASES = 2000;
const MAX_CASES = 6000;

/**
 * How the secret reaches the path: a dynamic reference as the whole value, one
 * embedded in text, or a `NoEcho` parameter (`{ Ref }`, persisted as the mask).
 */
type Form = 'whole' | 'embedded' | 'noecho';
const FORMS: readonly Form[] = ['whole', 'embedded', 'noecho'];
type Scrub = typeof scrubResourceRecord;
/** The writer's same-generation claim: none, or the one every deploy-written record states. */
type Claims = 'unclaimed' | 'same-generation';
const CLAIMS: readonly Claims[] = ['unclaimed', 'same-generation'];
function scrubbed(
  c: Case,
  index: number,
  form: Form,
  claims: Claims,
  scrub: Scrub = scrubResourceRecord
): { persisted: unknown; source: Record<string, unknown>; resolved: Record<string, unknown>; plaintext: string } {
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
  const record = {
    properties: placed(c.path, wrap(plaintext)),
    // A provider echoing the value as an attribute (`Fn::GetAtt`).
    attributes: { Echo: wrap(plaintext) },
    // The readback echoes it at the path, and under a key the template lacks.
    observedProperties: { ...placed(c.path, wrap(plaintext)), ReadbackOnly7061: wrap(plaintext) },
  };
  const resolved = placed(c.path, wrap(plaintext));
  const claim =
    claims === 'same-generation' ? ({ properties: 'same-generation', observed: 'same-generation' } as const) : {};
  return { persisted: scrub(record, secrets, source, undefined, claim), source, resolved, plaintext };
}

/**
 * Cases allowed to break the invariant, keyed `<type> <path> <form> <claims>`, with why.
 * Empty: every generated case holds.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {};

/**
 * The diff side's two bags for the case's key, as an unchanged redeploy
 * computes them. A reference is kept as written (`skipDynamicReferences`), so
 * the desired side is the template's spelling. A `NoEcho` parameter is
 * compared through the deploy diff's own `NoEcho` comparison
 * (`noEchoComparisonForTemplate`).
 */
function diffSides(
  c: Case,
  form: Form,
  source: Record<string, unknown>,
  resolved: Record<string, unknown>,
  current: Record<string, unknown>,
  plaintext: string
): { desired: unknown; current: unknown } {
  if (form !== 'noecho') return { desired: source, current };
  const template = {
    Parameters: { SecretParam: { Type: 'String', NoEcho: true } },
    Resources: { R: { Type: c.type, Properties: source } },
  } as unknown as CloudFormationTemplate;
  const compare = noEchoComparisonForTemplate(template, undefined, { SecretParam: plaintext }, {});
  const sides = compare?.({ logicalId: 'R', resourceType: c.type, templateProperties: source, desired: resolved, current });
  return sides ?? { desired: resolved, current };
}

/** Every case breaking the invariant under `scrub`, and the exceptions that held. */
function invariantFailures(cases: readonly Case[], scrub: Scrub = scrubResourceRecord): { failures: string[]; excepted: Set<string> } {
  const failures: string[] = [];
  const excepted = new Set<string>();
  cases.forEach((c, index) => {
    for (const form of FORMS) for (const claims of CLAIMS) {
      const key = `${c.type} ${c.path.join('/')} ${form} ${claims}`;
      const { persisted, source, resolved, plaintext } = scrubbed(c, index, form, claims, scrub);
      const record = persisted as { properties: Record<string, unknown> };
      const problems: string[] = [];
      if (JSON.stringify(persisted).includes(plaintext)) problems.push('plaintext persisted');
      const sides = diffSides(c, form, source, resolved, record.properties, plaintext);
      if (JSON.stringify(sides.desired) !== JSON.stringify(sides.current)) problems.push('an unchanged redeploy plans a change');
      if (problems.length === 0) continue;
      if (Object.hasOwn(EXCEPTIONS, key)) excepted.add(key);
      else failures.push(`${key}: ${problems.join(', ')}`);
    }
  });
  return { failures, excepted };
}

describe('schema redaction invariant (go-to-k/cdkd#7061 slice (c))', { timeout: CONTENDED_CASE_TIMEOUT_MS }, () => {
  const cases = casesOf();

  it('the population is between its floor and cap, with every shape and kind represented', () => {
    expect(cases.length).toBeGreaterThanOrEqual(MIN_CASES);
    expect(cases.length).toBeLessThanOrEqual(MAX_CASES);
    const count = (shape: Shape): number => cases.filter((c) => c.shapes.includes(shape)).length;
    expect(count('top-level')).toBeGreaterThanOrEqual(500);
    expect(count('nested')).toBeGreaterThanOrEqual(100);
    expect(count('array-item')).toBeGreaterThanOrEqual(50);
    expect(count('map-value')).toBeGreaterThanOrEqual(400);
    expect(count('create-only')).toBeGreaterThanOrEqual(50);
    expect(cases.filter((c) => c.kinds.includes('writeOnly')).length).toBeGreaterThanOrEqual(1000);
    expect(cases.filter((c) => c.kinds.includes('secretNamed')).length).toBeGreaterThanOrEqual(500);
    expect(cases.filter((c) => c.kinds.includes('mapValue')).length).toBeGreaterThanOrEqual(400);
  });

  it('every write-only and secret-named path is redacted on persist and plans no change on an unchanged redeploy', () => {
    const { failures, excepted } = invariantFailures(cases);
    expect(failures).toEqual([]);
    // An exception that no longer fails is stale.
    expect(Object.keys(EXCEPTIONS).filter((k) => !excepted.has(k))).toEqual([]);
  });

  it('probe: a writer that persists the record as handed fails the invariant on every case and form', () => {
    const passThrough = ((record: unknown) => record) as Scrub;
    const sample = cases.slice(0, 20);
    const { failures } = invariantFailures(sample, passThrough);
    expect(failures).toHaveLength(sample.length * FORMS.length * CLAIMS.length);
    for (const f of failures) expect(f).toMatch(/plaintext persisted/);
  });
});
