import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  redactSecretsForState,
  scrubResourceRecord,
  clearRecordedSecretExpressions,
  recordSecretExpression,
  STATE_DERIVED_RULES,
  STATE_SOURCED_READBACK_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';
const PLAINTEXT = 'the-real-resolved-secret-value';
const PUBLIC_EXPR = '{{resolve:ssm:/app/public-host}}';
const PUBLIC_VALUE = 'public-host-value';

/** ECS-shaped: `ContainerDefinitions[].Environment[]`, keyed by `Name` twice. */
function taskDefinitionProperties(): Record<string, unknown> {
  return {
    Family: 'cdkd-array-secret',
    ContainerDefinitions: [
      {
        Name: 'app',
        Image: 'public.ecr.aws/docker/library/busybox:latest',
        Environment: [
          { Name: 'DB_PASSWORD', Value: EXPR },
          { Name: 'MODE', Value: 'production' },
        ],
      },
      {
        Name: 'sidecar',
        Image: 'public.ecr.aws/docker/library/busybox:latest',
        Environment: [{ Name: 'ROLE', Value: 'sidecar' }],
      },
    ],
  };
}

/**
 * What `DescribeTaskDefinition` echoes back: the RESOLVED value, and both list
 * levels in a different order from the template. The reorder is the whole
 * reason `descendArrays: false` exists on a readback bag, so the fixture has to
 * carry it or the case proves nothing.
 */
function taskDefinitionObserved(): Record<string, unknown> {
  return {
    Family: 'cdkd-array-secret',
    ContainerDefinitions: [
      {
        Name: 'sidecar',
        Image: 'public.ecr.aws/docker/library/busybox:latest',
        Environment: [{ Name: 'ROLE', Value: 'sidecar' }],
      },
      {
        Name: 'app',
        Image: 'public.ecr.aws/docker/library/busybox:latest',
        Environment: [
          { Name: 'MODE', Value: 'production' },
          { Name: 'DB_PASSWORD', Value: PLAINTEXT },
        ],
      },
    ],
  };
}

function envValue(bag: unknown, container: string, name: string): unknown {
  const defs = (bag as Record<string, unknown>)['ContainerDefinitions'] as Array<
    Record<string, unknown>
  >;
  const def = defs.find((d) => d['Name'] === container)!;
  const env = def['Environment'] as Array<Record<string, unknown>>;
  return env.find((e) => e['Name'] === name)?.['Value'];
}

/**
 * Issue #1915 — a secret nested in an ARRAY on the UNCHANGED-resource path.
 *
 * Both halves that would otherwise catch it are off there BY DESIGN: positional
 * array descent is unsound on an AWS readback (list order is not preserved),
 * and the value scan has no needles because the resource was never resolved
 * this deploy so its `perResourceSecrets` entry is empty (#1900). Keying the
 * descent on an element IDENTITY field restores POSITION without depending on
 * order, which answers the `descendArrays: false` rationale on its own terms.
 */
describe('secret-redaction - keyed array descent (issue #1915)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('redacts an array-nested secret on the unchanged path with an EMPTY secrets map', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: taskDefinitionProperties(),
        observedProperties: taskDefinitionObserved(),
      },
      // UNCHANGED resource: never resolved this deploy, so no needles exist.
      new Map()
    );

    expect(envValue(scrubbed.observedProperties, 'app', 'DB_PASSWORD')).toBe(EXPR);
    expect(JSON.stringify(scrubbed)).not.toContain(PLAINTEXT);
    // Non-secret siblings are untouched, at both list levels.
    expect(envValue(scrubbed.observedProperties, 'app', 'MODE')).toBe('production');
    expect(envValue(scrubbed.observedProperties, 'sidecar', 'ROLE')).toBe('sidecar');
  });

  it('keys on `Key` as well, for the Tags[] shape', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: {
          Tags: [
            { Key: 'owner', Value: 'platform' },
            { Key: 'db-password', Value: EXPR },
          ],
        },
        observedProperties: {
          Tags: [
            { Key: 'db-password', Value: PLAINTEXT },
            { Key: 'owner', Value: 'platform' },
          ],
        },
      },
      new Map()
    );

    const tags = (scrubbed.observedProperties!['Tags'] as Array<Record<string, unknown>>).find(
      (t) => t['Key'] === 'db-password'
    )!;
    expect(tags['Value']).toBe(EXPR);
    expect(JSON.stringify(scrubbed)).not.toContain(PLAINTEXT);
  });

  // The fence that keeps the relaxation from becoming blind positional descent
  // in disguise. A plain-string array carries no identity field, so no pairing
  // is possible — and the required outcome is that NOTHING is written, not that
  // something plausible is guessed. Writing EXPR onto element 1 here would be
  // the exact failure `descendArrays: false` was protecting against.
  it('refuses to pair a keyless array rather than mis-assigning by position', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: { Command: [EXPR, 'serve'] },
        observedProperties: { Command: ['serve', PLAINTEXT] },
      },
      new Map()
    );

    expect(scrubbed.observedProperties!['Command']).toEqual(['serve', PLAINTEXT]);
  });

  // Uniqueness is what makes a pairing impossible to get wrong, so a repeated
  // identity value must refuse the whole array rather than pair on first match.
  //
  // The source's LAST duplicate is the one carrying the expression, and both
  // bag elements would meet it if the index were built without the uniqueness
  // check — so dropping that check writes EXPR onto BOTH leaves, including the
  // one that holds ordinary config. A fixture whose duplicates carry the same
  // values would pass either way and pin nothing.
  it('refuses to pair when the identity value repeats within an array', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: {
          Environment: [
            { Name: 'DUP', Value: 'plain' },
            { Name: 'DUP', Value: EXPR },
          ],
        },
        observedProperties: {
          Environment: [
            { Name: 'DUP', Value: PLAINTEXT },
            { Name: 'DUP', Value: 'plain' },
          ],
        },
      },
      new Map()
    );

    expect(scrubbed.observedProperties!['Environment']).toEqual([
      { Name: 'DUP', Value: PLAINTEXT },
      { Name: 'DUP', Value: 'plain' },
    ]);
  });

  // An element the source does not have is not guessed at either.
  // An element the source does not carry is not guessed at. Two things make
  // this discriminating rather than merely true:
  //
  //  - The secrets map is EMPTY, so the value scan cannot stand in for the
  //    keyed pairing. With a populated map both mechanisms produce the same
  //    answer and the case passes with the entire keyed arm dead — which is
  //    what an earlier version of it did.
  //  - The unpaired element's value is an unrelated LITERAL, so a fabricated
  //    pairing is visible: it would take the source's expression, and the
  //    assertion names that specific wrong answer rather than only the right
  //    one.
  it('leaves an unpaired element alone rather than fabricating a partner', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: { Environment: [{ Name: 'KNOWN', Value: EXPR }] },
        observedProperties: {
          Environment: [
            { Name: 'KNOWN', Value: PLAINTEXT },
            { Name: 'ADDED_OUT_OF_BAND', Value: 'an-unrelated-literal' },
          ],
        },
      },
      new Map(),
      // TEMPLATE source, so the walk takes the non-trusting rules too.
      { Environment: [{ Name: 'KNOWN', Value: EXPR }] }
    );

    const env = scrubbed.observedProperties!['Environment'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(EXPR);
    expect(env[1]!['Value']).toBe('an-unrelated-literal');
    expect(env[1]!['Value']).not.toBe(EXPR);
  });

  // #1901 fence for the new descent: a TEMPLATE source carries PUBLIC ssm
  // expressions, and keying must not smuggle one into state — a public
  // parameter stored as its expression is a perpetual UPDATE.
  it('does NOT persist a public ssm expression reached through a keyed pairing', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: { Environment: [{ Name: 'HOST', Value: PUBLIC_VALUE }] },
        observedProperties: { Environment: [{ Name: 'HOST', Value: PUBLIC_VALUE }] },
      },
      new Map([[PLAINTEXT, EXPR]]),
      { Environment: [{ Name: 'HOST', Value: PUBLIC_EXPR }] }
    );

    const env = scrubbed.observedProperties!['Environment'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(PUBLIC_VALUE);
  });

  // MULTI-KEY fallback. The duplicate-`Name` case above cannot see this: its
  // elements have no `Key` at all, so "refused the array" and "tried `Key` and
  // found nothing" produce the same output. Here `Name` is degenerate (repeated
  // on both sides) while `Key` is a clean identity, so the two answers diverge:
  // refusing the array leaves the plaintext, trying the next key redacts it.
  it('falls through to the next identity key when the first one is degenerate', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: {
          Entries: [
            { Name: 'same', Key: 'public', Value: 'plain' },
            { Name: 'same', Key: 'secret', Value: EXPR },
          ],
        },
        observedProperties: {
          Entries: [
            { Name: 'same', Key: 'secret', Value: PLAINTEXT },
            { Name: 'same', Key: 'public', Value: 'plain' },
          ],
        },
      },
      new Map()
    );

    const entries = scrubbed.observedProperties!['Entries'] as Array<Record<string, unknown>>;
    expect(entries.find((e) => e['Key'] === 'secret')!['Value']).toBe(EXPR);
    expect(JSON.stringify(scrubbed)).not.toContain(PLAINTEXT);
  });

  // The EMPTY identity string is refused, for the reason the value scan refuses
  // an empty needle: it is not a distinguishing value, so pairing on it is
  // pairing on nothing.
  //
  // SINGLE-element arrays on purpose. A two-element fixture cannot isolate this
  // rule — two elements both carrying `Name: ''` already fail the UNIQUENESS
  // check, so the array is refused either way and dropping the empty-string
  // guard changes no output. With one element per side, uniqueness holds
  // trivially and only the empty-string rule stands between two UNRELATED
  // entries and a pairing that would copy a secret reference onto a literal.
  it('refuses an EMPTY identity value rather than pairing on it', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: { Entries: [{ Name: '', Value: EXPR }] },
        observedProperties: { Entries: [{ Name: '', Value: 'an-unrelated-literal' }] },
      },
      new Map()
    );

    // The literal must survive. Pairing these would rewrite it to EXPR — a
    // property silently replaced by a secret reference it has nothing to do
    // with, which on the next deploy is applied to AWS.
    expect(scrubbed.observedProperties!['Entries']).toEqual([
      { Name: '', Value: 'an-unrelated-literal' },
    ]);
  });

  // Degenerate identity SHAPES, all of which must refuse rather than pair. Each
  // row is a different way `item[key]` fails to be a usable identity.
  //
  // The identity value is the SAME on both sides on purpose. An earlier draft
  // used different ones (`1` against `2`), which meant no pairing was possible
  // whatever the type check did — so dropping `typeof id !== 'string'` changed
  // no output and the row fenced nothing. With equal ids, only the type check
  // stands between these two elements and a pairing that copies the source's
  // secret reference onto an unrelated literal.
  it.each([
    ['a non-string identity', 1],
    ['a null identity', null],
    ['a boolean identity', true],
  ])('refuses %s rather than pairing on it', (_label, id) => {
    const scrubbed = scrubResourceRecord(
      {
        properties: { Entries: [{ Name: id, Value: EXPR }] },
        observedProperties: { Entries: [{ Name: id, Value: 'an-unrelated-literal' }] },
      },
      new Map()
    );
    expect(scrubbed.observedProperties!['Entries']).toEqual([
      { Name: id, Value: 'an-unrelated-literal' },
    ]);
  });

  // A MISSING identity field on one side only. The two elements are otherwise
  // the SAME element, so the missing field is the only thing that can refuse
  // the pairing — with a differing identity instead, no pairing would have been
  // possible anyway and the case would fence nothing.
  it('refuses when only one side carries the identity field', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: { Entries: [{ Name: 'db', Value: EXPR }] },
        observedProperties: { Entries: [{ Value: 'an-unrelated-literal' }] },
      },
      new Map()
    );
    expect(scrubbed.observedProperties!['Entries']).toEqual([
      { Value: 'an-unrelated-literal' },
    ]);
  });

  // SOURCE-side uniqueness, which nothing else here reaches: the duplicate case
  // above has duplicates on BOTH sides, so the BAG arm refuses first and
  // dropping `isUniquelyKeyedBy(source, key)` changes no output. With a unique
  // bag and a duplicated SOURCE, only the source-side check stands between the
  // bag element and the LAST duplicate — the collapse the whole uniqueness rule
  // exists to forbid, and the one that silently picks a sibling's expression.
  it('refuses when the SOURCE side has duplicate identities', () => {
    const OTHER_EXPR = '{{resolve:secretsmanager:app/other:SecretString:password}}';
    const scrubbed = scrubResourceRecord(
      {
        properties: {
          Entries: [
            { Name: 'db', Value: EXPR },
            { Name: 'db', Value: OTHER_EXPR },
          ],
        },
        observedProperties: { Entries: [{ Name: 'db', Value: PLAINTEXT }] },
      },
      new Map()
    );
    // Unredacted is the CORRECT answer here: the source cannot say which of its
    // two `db` entries this is, and guessing the last one is the defect.
    expect(scrubbed.observedProperties!['Entries']).toEqual([{ Name: 'db', Value: PLAINTEXT }]);
  });

  // The flip side of running keyed BEFORE positional: two well-keyed lists can
  // still be keyed on DISJOINT identities (a provider normalising `Name` in its
  // `effectiveProperties`). Nothing pairs, and taking the keyed result anyway
  // would pre-empt an exact positional descent — collapsing a colliding pair
  // onto whichever expression the value map kept.
  it('falls back to positional when a keyed pairing matches NOTHING', () => {
    const EXPR_A = '{{resolve:secretsmanager:app/a:SecretString:pw}}';
    const EXPR_B = '{{resolve:secretsmanager:app/b:SecretString:pw}}';
    const SHARED = 'one-value-two-references';
    // Collapsed by construction: the map is keyed by the resolved plaintext.
    const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);

    const persisted = redactSecretsForState(
      {
        Env: [
          { Name: 'normalised-a', Value: SHARED },
          { Name: 'normalised-b', Value: SHARED },
        ],
      },
      secrets,
      {
        Env: [
          { Name: 'A', Value: EXPR_A },
          { Name: 'B', Value: EXPR_B },
        ],
      },
      STATE_DERIVED_RULES
    );

    const env = (persisted as Record<string, unknown>)['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(EXPR_A);
    expect(env[1]!['Value']).toBe(EXPR_B);
  });

  // An INHERITED identity field is not an identity. This is the only shape that
  // makes the `Object.hasOwn` guard observable — a missing key and an inherited
  // one both read as `undefined` without it, so the case above cannot tell them
  // apart. State that came from `JSON.parse` never carries a prototype, so this
  // is about the two walks in this module AGREEING: the object walk already
  // uses `Object.hasOwn`, and a pairing rule that quietly accepted the
  // prototype chain would diverge from it the moment a caller hands in a
  // constructed bag.
  it('refuses an identity field inherited from the prototype chain', () => {
    const inherited = Object.assign(Object.create({ Name: 'db' }) as object, {
      Value: 'an-unrelated-literal',
    });
    const scrubbed = scrubResourceRecord(
      {
        properties: { Entries: [{ Name: 'db', Value: EXPR }] },
        observedProperties: { Entries: [inherited] },
      },
      new Map()
    );
    const entries = scrubbed.observedProperties!['Entries'] as Array<Record<string, unknown>>;
    expect(entries[0]!['Value']).toBe('an-unrelated-literal');
  });

  // A SOURCE longer than the bag: the extra source elements simply have no
  // partner and contribute nothing. The point is that they do not shift the
  // pairing of the ones that DO match.
  it('pairs correctly when the source array is longer than the bag', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: {
          Entries: [
            { Name: 'gone', Value: EXPR },
            { Name: 'db', Value: EXPR },
          ],
        },
        observedProperties: { Entries: [{ Name: 'db', Value: PLAINTEXT }] },
      },
      new Map()
    );
    expect(scrubbed.observedProperties!['Entries']).toEqual([{ Name: 'db', Value: EXPR }]);
  });

  // The `bag.length === source.length` conjunct of `positionalIsExact`, ALONE.
  //
  // The case above reads like it covers this and does not: its one pairing sits
  // at source index 1 while the bag element sits at 0, so `orderPreserved` is
  // already false and the length conjunct is never consulted. Deleting the
  // conjunct left that test — and the whole suite — green.
  //
  // Here the pairing IS at its own index, so `descendArrays` and
  // `orderPreserved` both hold and the differing lengths are the only thing
  // left standing between the unpaired element and a fabricated partner.
  // Without the conjunct, `x` is handed `source[0]` — an element it has no
  // relationship to — and takes its expression, on the replay path that pushes
  // to AWS.
  it('does NOT position an unpaired element when only the LENGTHS differ', () => {
    const EXPR_A = '{{resolve:secretsmanager:app/a:SecretString:pw}}';
    const EXPR_B = '{{resolve:secretsmanager:app/b:SecretString:pw}}';
    const EXPR_C = '{{resolve:secretsmanager:app/c:SecretString:pw}}';
    const PLAIN_B = 'resolved-value-of-b';

    const persisted = redactSecretsForState(
      {
        Env: [
          { Name: 'x', Value: 'an-unrelated-literal' },
          { Name: 'b', Value: PLAIN_B },
        ],
      },
      new Map([[PLAIN_B, EXPR_B]]),
      {
        Env: [
          { Name: 'a', Value: EXPR_A },
          { Name: 'b', Value: EXPR_B },
          { Name: 'c', Value: EXPR_C },
        ],
      },
      STATE_DERIVED_RULES
    );

    const env = (persisted as Record<string, unknown>)['Env'] as Array<Record<string, unknown>>;
    // `b` pairs by identity at its own index, which is what makes
    // `orderPreserved` true and isolates the conjunct.
    expect(env[1]!['Value']).toBe(EXPR_B);
    // `x` has no partner and the lengths differ, so it must keep its own value.
    // Without the conjunct it becomes EXPR_A.
    expect(env[0]!['Value']).toBe('an-unrelated-literal');
    expect(env[0]!['Value']).not.toBe(EXPR_A);
  });

  // BOUND, not a fix (documented on `identityKeyFor`): when the identity field
  // ITSELF holds the secret, the two sides are KNOWN to differ, so no pairing is
  // possible and the element's other leaves are not reached either. Pinned so
  // the REFUSAL is the pinned behavior — the failure mode must stay "the leaf
  // keeps its plaintext", never "the leaf is paired with a guess".
  it('refuses to pair when the IDENTITY FIELD itself holds the secret', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: { Entries: [{ Name: EXPR, Value: 'plain' }] },
        observedProperties: { Entries: [{ Name: PLAINTEXT, Value: 'plain' }] },
      },
      new Map()
    );
    // Unredacted — the documented residual. What must NOT happen is EXPR
    // appearing on this element from a fabricated pairing.
    expect(scrubbed.observedProperties!['Entries']).toEqual([
      { Name: PLAINTEXT, Value: 'plain' },
    ]);
  });

  // BOUND, not a fix (documented on `identityKeyFor`): an array of ARRAYS has no
  // identity field on its OUTER elements, and descending it positionally would
  // reintroduce the order assumption the keyed pass exists to avoid.
  it('does not reach a secret nested in an array of ARRAYS', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: { Matrix: [[{ Name: 'db', Value: EXPR }]] },
        observedProperties: { Matrix: [[{ Name: 'db', Value: PLAINTEXT }]] },
      },
      new Map()
    );
    expect(scrubbed.observedProperties!['Matrix']).toEqual([[{ Name: 'db', Value: PLAINTEXT }]]);
  });

  // ORDERING: keyed descent must run BEFORE positional, not merely where
  // positional is refused. This array satisfies BOTH — equal lengths under a
  // `descendArrays: true` caller AND a clean `Name` identity — so it is the
  // only shape where the order of the two branches is observable. The provider
  // returned its `effectiveProperties` list in the other order, which
  // `descendArrays` assumes never happens and cannot enforce; keying is right
  // regardless, indexing puts each leaf on its SIBLING's expression.
  it('prefers keyed over positional when an equal-length list is REORDERED', () => {
    const EXPR_A = '{{resolve:secretsmanager:app/a:SecretString:pw}}';
    const EXPR_B = '{{resolve:secretsmanager:app/b:SecretString:pw}}';
    const PLAIN_A = 'resolved-value-of-a';
    const PLAIN_B = 'resolved-value-of-b';
    const secrets: RecordedSecretValues = new Map([
      [PLAIN_A, EXPR_A],
      [PLAIN_B, EXPR_B],
    ]);

    const persisted = redactSecretsForState(
      {
        Env: [
          { Name: 'B', Value: PLAIN_B },
          { Name: 'A', Value: PLAIN_A },
        ],
      },
      secrets,
      {
        Env: [
          { Name: 'A', Value: EXPR_A },
          { Name: 'B', Value: EXPR_B },
        ],
      },
      STATE_DERIVED_RULES
    );

    const env = (persisted as Record<string, unknown>)['Env'] as Array<Record<string, unknown>>;
    // Indexing would give B the value of EXPR_A here — nothing leaks either way,
    // which is exactly why only an expression-level assertion catches it.
    expect(env[0]!['Value']).toBe(EXPR_B);
    expect(env[1]!['Value']).toBe(EXPR_A);
  });

  // The other half of "keyed before positional": keying must never PRE-EMPT a
  // positional descent that would have been exact. With one element renamed,
  // keying pairs the survivor and the renamed one has no partner — and dropping
  // it to the value scan hands it a COLLIDING SIBLING's expression, which the
  // replay then applies to AWS (the #1910 class). Positional is exact here
  // (`descendArrays`, equal lengths, and every pairing at its own index), so the
  // unpaired element takes its positional partner instead.
  it('gives an unpaired element its POSITIONAL partner when positional would be exact', () => {
    const EXPR_A = '{{resolve:secretsmanager:app/a:SecretString:pw}}';
    const EXPR_B = '{{resolve:secretsmanager:app/b:SecretString:pw}}';
    const SHARED = 'one-value-two-references';
    // Collapsed by construction — the map is keyed by the resolved plaintext,
    // so the value scan can only ever answer EXPR_B for both leaves.
    const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);

    const persisted = redactSecretsForState(
      {
        Env: [
          { Name: 'RENAMED', Value: SHARED },
          { Name: 'B', Value: SHARED },
        ],
      },
      secrets,
      {
        Env: [
          { Name: 'A', Value: EXPR_A },
          { Name: 'B', Value: EXPR_B },
        ],
      },
      STATE_DERIVED_RULES
    );

    const env = (persisted as Record<string, unknown>)['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(EXPR_A);
    expect(env[1]!['Value']).toBe(EXPR_B);
  });

  // ...and the fence that keeps that from becoming blind positional descent: if
  // the pairings that DID happen are out of order, the order assumption behind
  // positional descent is demonstrably false HERE, so an unpaired element must
  // NOT be handed `source[i]`. It falls to the value scan instead.
  it('does NOT position an unpaired element when the pairings are out of order', () => {
    const EXPR_A = '{{resolve:secretsmanager:app/a:SecretString:pw}}';
    const EXPR_B = '{{resolve:secretsmanager:app/b:SecretString:pw}}';

    const persisted = redactSecretsForState(
      {
        Env: [
          { Name: 'B', Value: 'resolved-b' },
          { Name: 'RENAMED', Value: 'resolved-a' },
        ],
      },
      new Map([
        ['resolved-a', EXPR_A],
        ['resolved-b', EXPR_B],
      ]),
      {
        Env: [
          { Name: 'A', Value: EXPR_A },
          { Name: 'B', Value: EXPR_B },
        ],
      },
      STATE_DERIVED_RULES
    );

    const env = (persisted as Record<string, unknown>)['Env'] as Array<Record<string, unknown>>;
    // B paired by key, so it is exact. The renamed one took the value scan —
    // which is right here BECAUSE the map is not collapsed; had it been, the
    // honest answer is still "do not guess from a demonstrably wrong order".
    expect(env[0]!['Value']).toBe(EXPR_B);
    expect(env[1]!['Value']).toBe(EXPR_A);
  });

  // The #1900 half of the same bar, restated as its own case so a future edit
  // that "tidies" the gate to `paired === bag.length` fails here rather than in
  // review: with an EMPTY secrets map the value scan has no needles, so
  // demanding that every element pair would un-redact the one that did.
  it('still redacts the paired element when another has no partner and the map is empty', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: { Env: [{ Name: 'db', Value: EXPR }] },
        observedProperties: {
          Env: [
            { Name: 'db', Value: PLAINTEXT },
            { Name: 'ADDED_BY_AWS', Value: 'a-default' },
          ],
        },
      },
      new Map()
    );

    const env = scrubbed.observedProperties!['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(EXPR);
    expect(env[1]!['Value']).toBe('a-default');
  });

  // The trust flag has to survive the ARRAY boundary. Nothing else carries it
  // across one: every other keyed case uses a `secretsmanager` expression, which
  // `isKnownSecretExpression` accepts by SPELLING, so it would pass with the
  // recursion silently dropping `trustAnyExpression`. An UNRECORDED ssm
  // reference is the discriminator — only the blanket trust can persist it.
  it('carries trustAnyExpression through a keyed array element', () => {
    const unrecordedSsm = '{{resolve:ssm:/legacy/db/password}}';
    const scrubbed = scrubResourceRecord(
      {
        properties: { Env: [{ Name: 'db', Value: unrecordedSsm }] },
        observedProperties: { Env: [{ Name: 'db', Value: PLAINTEXT }] },
      },
      new Map()
    );

    const env = scrubbed.observedProperties!['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(unrecordedSsm);
  });

  // Pins the identity-key LIST. Its doc says widening "has to be justified per
  // shape", which is unenforced unless something fails when the list grows.
  // `Value` is the tempting wrong addition — it is a field name that looks like
  // an identity and is exactly where secrets live, so admitting it would pair
  // elements BY THEIR SECRET and copy a reference onto an unrelated element.
  it('does not key on a field outside ARRAY_IDENTITY_KEYS', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: { Entries: [{ Value: 'shared-id', Data: EXPR }] },
        observedProperties: { Entries: [{ Value: 'shared-id', Data: 'an-unrelated-literal' }] },
      },
      new Map()
    );

    expect(scrubbed.observedProperties!['Entries']).toEqual([
      { Value: 'shared-id', Data: 'an-unrelated-literal' },
    ]);
  });

  // The INTERSECTION of this PR's two issues, which only the integ covered: a
  // secret whose resolved plaintext is itself a `{{resolve:...}}` string
  // (#1917), nested two arrays deep and reachable only by keyed descent
  // (#1915), on the unchanged path where the secrets map is empty.
  it('redacts a TOKEN-SHAPED plaintext nested inside a keyed array', () => {
    const TOKEN_SHAPED = '{{resolve:secretsmanager:decoy/other:SecretString:key}}';
    const scrubbed = scrubResourceRecord(
      {
        properties: {
          Containers: [{ Name: 'app', Env: [{ Name: 'DB_PASSWORD', Value: EXPR }] }],
        },
        observedProperties: {
          Containers: [{ Name: 'app', Env: [{ Name: 'DB_PASSWORD', Value: TOKEN_SHAPED }] }],
        },
      },
      new Map()
    );

    const containers = scrubbed.observedProperties!['Containers'] as Array<Record<string, unknown>>;
    const env = containers[0]!['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(EXPR);
    expect(JSON.stringify(scrubbed)).not.toContain('decoy/other');
  });

  // INVARIANT 1 of the positional fallback: no two bag elements may share a
  // source partner. The paired element claims `source[0]`; the unpaired one
  // must take `source[1]`, its own index, NOT the element already claimed.
  //
  // The unpaired element's plaintext is deliberately absent from the map, so
  // only positioning can supply an expression for it — if the fallback handed
  // it `source[0]` instead, it would carry `a`'s expression and the two leaves
  // would both name the same secret.
  it('never gives two elements the same source partner', () => {
    const EXPR_A = '{{resolve:secretsmanager:app/a:SecretString:pw}}';
    const EXPR_Y = '{{resolve:secretsmanager:app/y:SecretString:pw}}';
    const PLAIN_A = 'resolved-value-of-a';

    const persisted = redactSecretsForState(
      {
        Env: [
          { Name: 'a', Value: PLAIN_A },
          { Name: 'x', Value: 'unresolvable-here' },
        ],
      },
      new Map([[PLAIN_A, EXPR_A]]),
      {
        Env: [
          { Name: 'a', Value: EXPR_A },
          { Name: 'y', Value: EXPR_Y },
        ],
      },
      STATE_DERIVED_RULES
    );

    const env = (persisted as Record<string, unknown>)['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(EXPR_A);
    expect(env[1]!['Value']).toBe(EXPR_Y);
    // The failure this exists for: both leaves naming the same secret.
    expect(env[1]!['Value']).not.toBe(env[0]!['Value']);
  });

  // INVARIANT 2: with ZERO pairings the fallback must still reach positional,
  // which is what makes the removed `paired > 0` gate unreachable rather than
  // merely unused. `orderPreserved` is vacuously true when nothing pairs, so
  // `positionalIsExact` reduces to the positional arm's own condition.
  //
  // Distinct from the disjoint-identity case elsewhere in this file: there the
  // expressions differ so a value scan would give a visibly wrong answer; here
  // the map is EMPTY, so a value scan gives NO answer and only positional can
  // redact either leaf.
  it('still reaches positional descent when NOTHING pairs and the map is empty', () => {
    const EXPR_A = '{{resolve:secretsmanager:app/a:SecretString:pw}}';
    const EXPR_B = '{{resolve:secretsmanager:app/b:SecretString:pw}}';

    const persisted = redactSecretsForState(
      {
        Env: [
          { Name: 'renamed-a', Value: 'resolved-a' },
          { Name: 'renamed-b', Value: 'resolved-b' },
        ],
      },
      new Map(),
      {
        Env: [
          { Name: 'a', Value: EXPR_A },
          { Name: 'b', Value: EXPR_B },
        ],
      },
      STATE_DERIVED_RULES
    );

    const env = (persisted as Record<string, unknown>)['Env'] as Array<Record<string, unknown>>;
    expect(env[0]!['Value']).toBe(EXPR_A);
    expect(env[1]!['Value']).toBe(EXPR_B);
  });

  // The keyed arm is also the new answer for a `descendArrays: true` caller
  // whose array LENGTH diverged — the rollback replay shape. Positional descent
  // is still refused there (a producer that drops an element must not be walked
  // by index), but equality-based pairing cannot mis-align.
  it('pairs by key when a descendArrays caller sees a length change', () => {
    const secrets: RecordedSecretValues = new Map([[PLAINTEXT, EXPR]]);

    const persisted = redactSecretsForState(
      {
        Environment: [
          { Name: 'EXTRA', Value: 'added-by-the-provider' },
          { Name: 'DB_PASSWORD', Value: PLAINTEXT },
        ],
      },
      secrets,
      { Environment: [{ Name: 'DB_PASSWORD', Value: EXPR }] },
      STATE_DERIVED_RULES
    );

    const env = (persisted as Record<string, unknown>)['Environment'] as Array<
      Record<string, unknown>
    >;
    expect(env[0]!['Value']).toBe('added-by-the-provider');
    expect(env[1]!['Value']).toBe(EXPR);
  });
});

/**
 * The readback REFUSAL added for issue #1926, and the two guards its review
 * measured into it. Lives beside the #1915 fences on purpose: those fences are
 * what rejected the first attempt at this pass, and both sets constrain the
 * same walk from opposite directions — #1915 says do not GUESS a position,
 * #1926 says do not PERSIST a plaintext, and the only way to satisfy both is to
 * substitute exactly where the source can account for the leaf.
 */
describe('secret-redaction - readback refusal (issue #1926)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  const PUBLIC_SSM = '{{resolve:ssm:/app/public-host}}';
  const SECURE_SSM = '{{resolve:ssm:/app/secure-token}}';

  const refuse = (bag: unknown, source: unknown): unknown =>
    redactSecretsForState(bag, new Map<string, string>(), source, STATE_SOURCED_READBACK_RULES);

  it('substitutes a MIXED leaf the whole-token arm cannot reach', () => {
    // The dominant CDK shape: an `Fn::Join` around a secret renders a leaf that
    // CONTAINS the reference instead of BEING it, so `redactByPath`'s
    // whole-token test never fires and — with an empty map — the value scan has
    // no needle either.
    const out = refuse(
      { Url: `postgres://u:${PLAINTEXT}@host` },
      { Url: `postgres://u:${EXPR}@host` }
    );
    expect((out as Record<string, unknown>)['Url']).toBe(`postgres://u:${EXPR}@host`);
  });

  it('does NOT write a scalar over a CONTAINER the readback reported', () => {
    // The type guard. Without it a reference-shaped SOURCE returned its string
    // whatever the bag was, so `{Foo: {a: 1}}` became `{Foo: '{{resolve:...}}'}`
    // — fabricating a baseline AWS never reported, which `--revert` then writes
    // back. Reachable when a provider structures a leaf the template spells as
    // a reference.
    expect(refuse({ Foo: { a: 1, b: 'plain' } }, { Foo: EXPR })).toEqual({
      Foo: { a: 1, b: 'plain' },
    });
    expect(refuse({ Foo: [1, 2] }, { Foo: EXPR })).toEqual({ Foo: [1, 2] });
    expect(refuse({ Foo: 42 }, { Foo: EXPR })).toEqual({ Foo: 42 });
  });

  it('EMPTY MAP: a mixed `{{resolve:ssm:` leaf is REFUSED, not read as public', () => {
    // The regression the `secrets-dynamic-ref` integ caught and every unit
    // assertion missed, which is why this test exists at all.
    //
    // `isRecordedSecretExpression` only ever says "yes" about a token some pass
    // RESOLVED. `cdkd state refresh-observed` resolves nothing — its empty map
    // is issue #1926's own design decision — so reading absence as "public"
    // made EVERY ssm mixed leaf look public and persisted the DECRYPTED
    // SecureString. The shape below is the fixture's `DB_URL` verbatim.
    //
    // Fail closed here is also the SAME premise the whole-token arm acts on: a
    // public `String` parameter is stored RESOLVED (issue #1901), so a token
    // that survives in a persisted state bag is a SecureString by construction.
    const token = '{{resolve:ssm:cdkd-test-dynref-secure-123456789012}}';
    const expr = `postgres://app-svc:${token}@db.us-east-1.internal:5432/app`;
    const plain = 'postgres://app-svc:the-decrypted-value@db.us-east-1.internal:5432/app';

    const out = redactSecretsForState(
      { Url: plain },
      new Map<string, string>(),
      { Url: expr },
      STATE_SOURCED_READBACK_RULES
    ) as Record<string, unknown>;

    expect(out['Url']).toBe(expr);
    expect(JSON.stringify(out)).not.toContain('the-decrypted-value');
  });

  it('EMPTY MAP: the same leaf through scrubResourceRecord, as the commands reach it', () => {
    // The call the CLI actually makes (`cdkd state refresh-observed`, and the
    // deploy persist choke point for an UNCHANGED resource). Pinned separately
    // from the direct call above because the rules are DERIVED here rather than
    // passed, and it is that derivation the integ exercised.
    const token = '{{resolve:ssm:/app/secure-token}}';
    const expr = `postgres://u:${token}@host`;

    const scrubbed = scrubResourceRecord(
      {
        properties: { Env: { Url: expr } },
        observedProperties: { Env: { Url: 'postgres://u:decrypted-secret@host' } },
      },
      new Map<string, string>()
    );

    expect(scrubbed.observedProperties!['Env']).toEqual({ Url: expr });
    expect(JSON.stringify(scrubbed)).not.toContain('decrypted-secret');
  });

  it('POPULATED MAP: a PUBLIC ssm reference stays RESOLVED inside a mixed leaf (issue #1901)', () => {
    // The other side of the split. With a map, some pass DID resolve this bag,
    // so absence from the verdict store is real evidence the parameter is
    // public — a `String` parameter is legitimately stored RESOLVED, and
    // substituting the expression over it is phantom drift on ordinary config.
    //
    // The map is deliberately non-empty and deliberately about a DIFFERENT
    // secret: it is the presence of a resolution pass that licenses the
    // inference, not anything about this leaf.
    const out = redactSecretsForState(
      { Url: 'pre-public-host-post' },
      new Map<string, string>([['unrelated-secret', EXPR]]),
      { Url: `pre-${PUBLIC_SSM}-post` },
      STATE_SOURCED_READBACK_RULES
    ) as Record<string, unknown>;
    expect(out['Url']).toBe('pre-public-host-post');
  });

  it('still refuses a mixed leaf whose ssm reference was RECORDED as secret', () => {
    // The other polarity of the same rule: a `SecureString` is spelled exactly
    // like the public one, so the verdict comes from what the resolver
    // recorded. Losing this arm turns the #1901 fix into a blanket exemption.
    recordSecretExpression(SECURE_SSM);
    const out = redactSecretsForState(
      { Url: 'pre-decrypted-post' },
      new Map<string, string>([['unrelated-secret', EXPR]]),
      { Url: `pre-${SECURE_SSM}-post` },
      STATE_SOURCED_READBACK_RULES
    ) as Record<string, unknown>;
    expect(out['Url']).toBe(`pre-${SECURE_SSM}-post`);
  });

  it('refuses a mixed `ssm-secure:` leaf, which the public test must not catch', () => {
    // `{{resolve:ssm-secure:` does not start with `{{resolve:ssm:` — the next
    // character is `-`. Pinned because a prefix test written one character
    // looser would silently exempt every ssm-secure reference.
    const secure = '{{resolve:ssm-secure:/app/token}}';
    expect(refuse({ Url: 'pre-x-post' }, { Url: `pre-${secure}-post` })).toEqual({
      Url: `pre-${secure}-post`,
    });
  });

  it('applies on the DEPLOY path: scrubResourceRecord with an empty map and no template bag', () => {
    // The coupling issue #1926 was hoisted for, and the reason it is a UNIT
    // test: `DeployEngine.redactStateForPersist` calls exactly this for an
    // UNCHANGED resource — no secrets (never resolved this deploy) and no
    // template bag — so the observed walk derives
    // `STATE_SOURCED_READBACK_RULES` and inherits the refusal with no
    // deploy-engine change. Flipping that derivation drops the default-deploy
    // redaction, and without this test only the real-AWS integ would notice.
    const scrubbed = scrubResourceRecord(
      {
        properties: { Env: { Url: `postgres://u:${EXPR}@host` } },
        observedProperties: { Env: { Url: `postgres://u:${PLAINTEXT}@host` } },
      },
      new Map<string, string>()
    );

    expect(scrubbed.observedProperties!['Env']).toEqual({ Url: `postgres://u:${EXPR}@host` });
    expect(JSON.stringify(scrubbed)).not.toContain(PLAINTEXT);
  });

  it('RESIDUAL (issue #2012): an observed KEY the source does not carry keeps its plaintext', () => {
    // Row 4 of the module's per-shape table, pinned like rows 1-3 are. There is
    // no source leaf to position against and no needle to match, so the value
    // is persisted as-is. It is NOT closed by refusing every unpaired key: an
    // extra key is the NORM in an AWS readback (`FunctionName`, `MemorySize`,
    // `LastModified`), so refusing them would empty the drift baseline of every
    // secret-bearing resource.
    //
    // A residual we chose to ship is pinned as deliberately as one we fixed —
    // a future fix has to flip this assertion on purpose.
    const out = redactSecretsForState(
      { Password: PLAINTEXT, MasterPassword: PLAINTEXT },
      new Map<string, string>(),
      { Password: EXPR },
      STATE_SOURCED_READBACK_RULES
    ) as Record<string, unknown>;

    expect(out['Password']).toBe(EXPR);
    expect(out['MasterPassword']).toBe(PLAINTEXT);
  });

  it('keeps an own `__proto__` key as DATA in the VALUE-SCAN walk too', () => {
    // The third accumulator. Its two siblings (the path walk and the refusal
    // walk) are fenced; this one — reached with NO source, so the value scan
    // rather than the path pass — was not, and `out[k] = ...` on a normal
    // object would drop the key onto the prototype instead of into the bag.
    const secrets = new Map<string, string>([[PLAINTEXT, EXPR]]);
    const out = redactSecretsForState(
      JSON.parse(`{"Pw":"${PLAINTEXT}","__proto__":{"polluted":true}}`) as Record<string, unknown>,
      secrets
    );

    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect((out as Record<string, unknown>)['Pw']).toBe(EXPR);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('does NOT apply to `cdkd scrub`s CROSS-GENERATION observed walk', () => {
    // The gate's third conjunct, from the other side. Scrub has already
    // repositioned `properties` onto TODAY's template, so its source is a
    // different generation and substituting from it would rewrite a baseline
    // onto a reference the stack may never have deployed (issue #1917).
    const out = redactSecretsForState(
      { Url: `postgres://u:${PLAINTEXT}@host` },
      new Map<string, string>(),
      { Url: `postgres://u:${EXPR}@host` },
      STATE_SOURCED_CROSS_GENERATION_RULES
    );
    expect((out as Record<string, unknown>)['Url']).toBe(`postgres://u:${PLAINTEXT}@host`);
  });
});
