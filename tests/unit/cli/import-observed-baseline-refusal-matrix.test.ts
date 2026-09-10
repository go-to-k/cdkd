/**
 * The INPUT-SPACE fence for `cdkd import`'s observed-baseline refusal
 * (issue [#2828](https://github.com/go-to-k/cdkd/issues/2828)).
 *
 * WHY THIS EXISTS RATHER THAN A THIRD CASE. `resolveImportedProperties`'
 * refusal verdict is a CLASSIFIER: it decides, per resource, whether the
 * persisted `properties` can position the observed-capture redaction. Two
 * review rounds each found a new INPUT CLASS it got wrong — not a new place the
 * logic was wrong:
 *
 *  - round 1: the resolve THREW, leaving a raw `Fn::Join` OBJECT where the
 *    readback has a STRING;
 *  - round 2: the resolve SUCCEEDED and an `Fn::If` under a condition
 *    `cdkd import` cannot bind selected the branch AWS did not take, so the
 *    reference was gone with nothing thrown.
 *
 * Hand-picked cases cannot fence a classifier whose defects live in shapes
 * nobody wrote down, and a third hand-picked case would have been the third
 * round of the same. So this file enumerates SHAPES along the axes that have
 * produced defects, and asserts the SAFETY PROPERTY end to end rather than the
 * verdict alone.
 *
 * It does NOT enumerate "the input space", and an earlier revision of this
 * paragraph claimed it did. Round 4 falsified that by finding a whole AXIS the
 * table had no row for — a reference sourced from OUTSIDE the property bag (a
 * parameter `Default`, a `Mappings` entry) — which is now rows of its own. Say
 * which axes are covered, not that coverage is complete.
 *
 * THE INVARIANT, per row, and it is deliberately independent of HOW the
 * classifier decides: either the resource is REFUSED, or replaying exactly what
 * `captureObservedForImportedResources` does — `redactSecretsForState(readback,
 * EMPTY, properties, STATE_SOURCED_READBACK_RULES)` — produces a bag with no
 * plaintext in it. A shape nobody imagined therefore reds here even though no
 * one wrote its expected verdict down, which is the whole point.
 *
 * The per-row EXPECTED verdict is asserted too, and that pairing is load-bearing
 * in the other direction: the invariant alone is satisfied by refusing
 * everything, so without the expected column an over-refusal — which silently
 * costs every imported resource its drift baseline — would pass. Cap and floor.
 *
 * THE REAL RESOLVER, not a fake, for the reason
 * `import-resolver-error-masking.test.ts` gives at length: what is under test is
 * what the resolver DOES to these shapes, so a fake that produced the expected
 * shapes would be asserting the fixture.
 *
 * THE KNOWN-LEAKING SHAPES HAVE NO ROWS HERE, and that absence is recorded
 * rather than left to read as coverage. Issue
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852)'s shapes -- a reshaped
 * container, an identity key AWS normalised, a readback key the source lacks,
 * an unkeyed array anchors cannot corroborate -- all persist the plaintext
 * today, so a row for any of them would red the SAFETY invariant below.
 * #2852's fix made the position walk FAIL CLOSED at those shapes, but only for
 * a caller that declares its bag is a drift baseline
 * (`STATE_SOURCED_BASELINE_RULES`). THIS capture still passes
 * `STATE_SOURCED_READBACK_RULES`, one constant away, so the rows stay absent
 * and the residue is `src/cli/commands/import.ts`'s to close -- issue
 * [#2885](https://github.com/go-to-k/cdkd/issues/2885). That
 * issue carries the probe table measured against this module; this table
 * covers the shapes that hold plus the refusals. Same handling issue
 * [#2850](https://github.com/go-to-k/cdkd/issues/2850) already gets. When #2852
 * is fixed, those rows belong here and the probe table is what to move.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const SECRET_ID = 'cdkd-2828-matrix';
const PLAINTEXT = 'matrix-decrypted-value';
/**
 * A SECOND secret with a DIFFERENT value. Load-bearing for the two-reference
 * row: with both leaves holding the same plaintext, the derived-needle pass
 * learns `plaintext -> token` from the surviving leaf and rewrites the dropped
 * one for free, so that row's refusal was measurably UNEARNED — its own premise
 * assertion caught it. Distinct values are what make the dropped leaf actually
 * leak, which is the shape the row exists to describe.
 */
const SECRET_ID_2 = 'cdkd-2828-matrix-two';
const PLAINTEXT_2 = 'matrix-second-decrypted-value';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: {
      input?: { SecretId?: string };
      constructor: { name: string };
    }): Promise<unknown> {
      if (command.input?.SecretId === SECRET_ID_2) {
        return { SecretString: JSON.stringify({ pw: PLAINTEXT_2 }) };
      }
      if (command.input?.SecretId !== SECRET_ID) {
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }
      return { SecretString: JSON.stringify({ pw: PLAINTEXT }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

const { resolveImportedProperties, captureObservedForImportedResources } = await import(
  '../../../src/cli/commands/import.js'
);
const { redactSecretsForState, STATE_SOURCED_BASELINE_RULES, SECRET_MASK } = await import(
  '../../../src/deployment/secret-redaction.js'
);
const { getLogger } = await import('../../../src/utils/logger.js');

const TOKEN = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pw::}}`;
const TOKEN_2 = `{{resolve:secretsmanager:${SECRET_ID_2}:SecretString:pw::}}`;
/** A token whose secret does NOT exist, so resolving it throws. */
const MISSING_TOKEN = '{{resolve:secretsmanager:cdkd-2828-absent:SecretString:pw::}}';

interface Row {
  readonly name: string;
  /** Template `Properties` for the single resource under test. */
  readonly properties: Record<string, unknown>;
  /** What AWS reports back for it — the DECRYPTED value, at the same path. */
  readonly readback: Record<string, unknown>;
  /** Whether the classifier must REFUSE to capture a baseline for it. */
  readonly refused: boolean;
  /** Why, in one line — this column is the reason the table reads as a spec. */
  readonly why: string;
  readonly template?: Partial<CloudFormationTemplate>;
  /**
   * The exact bag the capture must persist for a NON-refused row. `not.toContain`
   * alone is satisfied by a redactor that returns `{}`, and three shapes exist
   * ONLY in this table, so the safety claim for them rested on an assertion that
   * cannot tell a correct redaction from an empty one.
   */
  readonly expected?: Record<string, unknown>;
  /**
   * A refusal that is DELIBERATELY conservative: the row would not have leaked,
   * and is refused anyway because the predicate is coarse. Exempt from the
   * premise loop, and counted separately so the over-refusals stay visible and
   * bounded rather than hiding among the earned ones.
   */
  readonly overRefusal?: boolean;
  /**
   * The plaintext this row is about, when it is not the default one. A row
   * carrying two different secrets has to name the one whose disclosure it
   * describes, or the assertions test the wrong value and pass.
   */
  readonly needle?: string;
}

const ROWS: readonly Row[] = [
  {
    name: 'whole-token leaf, resolves',
    properties: { Detail: { pw: TOKEN } },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: TOKEN } },
    refused: false,
    why: 'the persisted bag holds the token as a string leaf — the walk substitutes it',
  },
  {
    name: 'MIXED leaf embedding the token, resolves',
    properties: { Detail: { url: `postgres://u:${TOKEN}@h/db` } },
    readback: { Detail: { url: `postgres://u:${PLAINTEXT}@h/db` } },
    expected: { Detail: { url: `postgres://u:${TOKEN}@h/db` } },
    refused: false,
    why: "the mixed-leaf refusal inside redactSecretsForState covers it",
  },
  {
    name: 'Fn::Join-assembled token, resolves',
    properties: {
      Detail: {
        pw: {
          'Fn::Join': ['', [`{{resolve:secretsmanager:${SECRET_ID}`, ':SecretString:pw::}}']],
        },
      },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: TOKEN } },
    refused: false,
    why: 'the resolve collapses the join to one string leaf carrying the token',
  },
  {
    name: 'no dynamic reference at all, resolves',
    properties: { Detail: { name: 'plain-literal' } },
    readback: { Detail: { name: 'plain-literal', AwsOnly: 'added' } },
    expected: { Detail: { name: 'plain-literal', AwsOnly: 'added' } },
    refused: false,
    why: 'nothing to disclose — refusing would cost a baseline for no gain',
  },
  {
    name: 'Fn::Join-assembled token, resolve THROWS',
    properties: {
      Detail: {
        pw: { 'Fn::Join': ['', ['{{resolve:secretsmanager:', { Ref: 'NoSuchResource' }, '}}']] },
      },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why: 'raw OBJECT leaf vs STRING readback — the walk cannot pair them (round 1)',
  },
  {
    name: 'whole-token STRING leaf, resolve THROWS on a SIBLING property',
    properties: { Detail: { pw: TOKEN }, Other: { Ref: 'NoSuchResource' } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    overRefusal: true,
    why:
      'the walk COULD pair this one, but the throw-arm test is coarse on purpose ' +
      '— see the three rows below for what precision here cost',
  },
  {
    name: 'complete token wrapped in a single-element Fn::Join, resolve THROWS',
    properties: {
      Detail: { pw: { 'Fn::Join': ['', [TOKEN]] } },
      Other: { Ref: 'NoSuchResource' },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'THE REGRESSION ROW. A precise throw-arm test counted this token as complete ' +
      'on both sides and admitted it; the walk sees an OBJECT where the readback ' +
      'has a STRING and returns the plaintext untouched',
  },
  {
    name: 'complete token wrapped in Fn::Sub, resolve THROWS',
    properties: {
      Detail: { pw: { 'Fn::Sub': TOKEN } },
      Other: { Ref: 'NoSuchResource' },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why: 'second spelling of the row above — the wrapper is what matters, not Fn::Join',
  },
  {
    name: 'complete token wrapped in Fn::If, resolve THROWS',
    properties: {
      Detail: { pw: { 'Fn::If': ['IsProd', TOKEN, 'other'] } },
      Other: { Ref: 'NoSuchResource' },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why: 'third spelling — an unresolved Fn::If is an object leaf like any other',
    template: {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'no dynamic reference, resolve THROWS',
    properties: { Detail: { name: 'plain-literal' }, Other: { Ref: 'NoSuchResource' } },
    readback: { Detail: { name: 'plain-literal' } },
    refused: true,
    overRefusal: true,
    why:
      'nothing to disclose, refused anyway — the price of refusing on the THROW ' +
      'itself rather than on any predicate over a bag the resolver could not finish',
  },
  {
    name: 'Fn::If under a DOWNGRADED condition, secret in the UNTAKEN branch',
    properties: { Detail: { 'Fn::If': ['IsProd', { pw: TOKEN }, { pw: 'dev-placeholder' }] } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why: 'resolves cleanly to the false branch, so the marker is LOST (round 2)',
    template: {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'Fn::If under a DOWNGRADED condition, secret in the TAKEN branch',
    properties: { Detail: { 'Fn::If': ['IsProd', { pw: 'prod-placeholder' }, { pw: TOKEN }] } },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: TOKEN } },
    refused: false,
    why: 'the selected branch keeps the marker — the mirror of the row above',
    template: {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'TWO references to DIFFERENT secrets, one resolved and one dropped by a downgraded Fn::If',
    properties: {
      Detail: { kept: TOKEN, dropped: { 'Fn::If': ['IsProd', TOKEN_2, 'dev-placeholder'] } },
    },
    readback: { Detail: { kept: PLAINTEXT, dropped: PLAINTEXT_2 } },
    refused: true,
    needle: PLAINTEXT_2,
    why:
      'a surviving sibling reference must not vouch for the dropped one — and ' +
      'the secrets differ, so the derived-needle pass cannot rescue it either',
    template: {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'reference from a PARAMETER DEFAULT, resolve THROWS on a sibling',
    properties: { Detail: { pw: { Ref: 'SecretRef' } }, Other: { Ref: 'NoSuchResource' } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'ROUND-4 CLASS. The reference is sourced OUTSIDE the property bag, so an ' +
      'opener count over the raw bag reads ZERO — a predicate gated on that ' +
      'count admitted this and leaked',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'reference from a MAPPINGS entry, resolve THROWS on a sibling',
    properties: {
      Detail: { pw: { 'Fn::FindInMap': ['M', 's', 'pw'] } },
      Other: { Ref: 'NoSuchResource' },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why: 'second source outside the bag — same zero opener count, same leak',
    template: { Mappings: { M: { s: { pw: TOKEN } } } },
  },
  {
    name: 'reference from a PARAMETER DEFAULT that RESOLVES cleanly',
    properties: { Detail: { pw: { Ref: 'SecretRef' } } },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: TOKEN } },
    refused: false,
    why:
      'the NEGATIVE control for the two rows above: with no throw AND no ' +
      'condition dropping it, the resolve puts the token into the persisted ' +
      'bag and the walk positions on it. It does NOT establish that the ' +
      'outside-the-bag class is throw-arm-only — an earlier revision of this ' +
      'line claimed that and a reviewer refuted it: drop the same reference ' +
      'with a downgraded Fn::If and BOTH counts read zero. That shape is issue ' +
      '2850 and has no row here, because the SAFETY invariant would red on it',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'token inside a KEYED array element, readback REORDERED',
    properties: { Detail: { Items: [{ Name: 'a', Value: TOKEN }, { Name: 'b', Value: 'plain' }] } },
    readback: { Detail: { Items: [{ Name: 'b', Value: 'plain' }, { Name: 'a', Value: PLAINTEXT }] } },
    expected: { Detail: { Items: [{ Name: 'b', Value: 'plain' }, { Name: 'a', Value: TOKEN }] } },
    refused: false,
    why: 'identity-keyed descent pairs by Name, so a reorder is still substituted',
  },
  {
    name: 'token inside an UNKEYED array, readback same length',
    properties: { Detail: { Items: [TOKEN, 'plain'] } },
    readback: { Detail: { Items: [PLAINTEXT, 'plain'] } },
    expected: { Detail: { Items: [TOKEN, 'plain'] } },
    refused: false,
    why: 'the corroborated positional walk pairs index-for-index',
  },
  {
    name: 'token whose SECRET does not exist, so the lookup throws',
    properties: { Detail: { pw: MISSING_TOKEN } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    overRefusal: true,
    why: 'a throw carrying any opener refuses, whether or not this one could have paired',
  },
];

function stateFor(row: Row): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'matrix-stack',
    region: 'us-east-1',
    resources: {
      Res: {
        physicalId: 'res-phys',
        resourceType: 'AWS::SQS::Queue',
        properties: structuredClone(row.properties),
      },
    },
    outputs: {},
    lastModified: 0,
  } satisfies StackState;
}

function templateFor(row: Row): CloudFormationTemplate {
  return {
    ...row.template,
    Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: {} } },
  } as CloudFormationTemplate;
}

async function classify(row: Row): Promise<{ refused: boolean; persisted: Record<string, unknown> }> {
  const state = stateFor(row);
  // `stateBackend` is only consulted for a cross-stack read, and no row holds
  // one — the same cast, for the same reason, as the sibling masking suite.
  const refusedIds = await resolveImportedProperties(
    state,
    templateFor(row),
    'us-east-1',
    undefined as never,
    getLogger()
  );
  return { refused: refusedIds.has('Res'), persisted: state.resources['Res']!.properties };
}

/**
 * Drives the REAL `captureObservedForImportedResources` rather than replaying
 * its `redactSecretsForState` call by hand: a hand-rolled replay keeps this
 * fence green when production's arguments change, which is the one regression
 * an input-space matrix must not miss.
 *
 * The provider double takes the FIVE arguments production passes
 * (`physicalId`, `logicalId`, `resourceType`, `properties`, `context`) and
 * records them, so the call shape is pinned too.
 */
async function captureVia(
  row: Row,
  persisted: Record<string, unknown>,
  refusedIds: ReadonlySet<string>
): Promise<{ observed: unknown; seen: readonly unknown[] }> {
  const seen: unknown[] = [];
  const state = stateFor(row);
  state.resources['Res']!.properties = persisted;
  const provider = {
    readCurrentState: async (
      physicalId: string,
      logicalId: string,
      resourceType: string,
      properties: Record<string, unknown>,
      context?: unknown
    ) => {
      seen.push({ physicalId, logicalId, resourceType, properties, context });
      return structuredClone(row.readback);
    },
  };
  const registry = {
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
  } as unknown as Parameters<typeof captureObservedForImportedResources>[1];
  await captureObservedForImportedResources(state, registry, getLogger(), refusedIds);
  return { observed: state.resources['Res']!.observedProperties, seen };
}

describe('cdkd import: which resources may take an observedProperties baseline (issue #2828)', () => {
  it('the table covers every enumerated shape, and both verdicts occur in it', () => {
    // A floor on the POOL, written as literals from this file rather than
    // derived from the array: a table that quietly lost its refusing rows would
    // otherwise satisfy every assertion below by having nothing to check.
    expect(ROWS).toHaveLength(19);
    expect(ROWS.filter((r) => r.refused)).toHaveLength(11);
    expect(ROWS.filter((r) => !r.refused)).toHaveLength(8);
    // The deliberate over-refusals, counted so they cannot grow unnoticed: each
    // costs a real resource its drift baseline.
    expect(ROWS.filter((r) => r.overRefusal)).toHaveLength(3);
    expect(
      ROWS.filter((r) => r.overRefusal && !r.refused),
      'an over-refusal that is not a refusal is a contradiction'
    ).toHaveLength(0);
    expect(new Set(ROWS.map((r) => r.name)).size, 'row names are unique').toBe(ROWS.length);
  });

  for (const row of ROWS) {
    it(`SAFE: ${row.name}`, async () => {
      const { refused, persisted } = await classify(row);

      // THE INVARIANT. Independent of how the verdict was reached, so a shape
      // nobody enumerated still has to satisfy it.
      if (!refused) {
        const { observed: redacted, seen } = await captureVia(row, persisted, new Set());
        expect(seen, `${row.name}: the provider was not consulted`).toHaveLength(1);
        expect(
          (seen[0] as { physicalId: string; resourceType: string }).physicalId,
          `${row.name}: production must pass the recorded physicalId`
        ).toBe('res-phys');
        expect((seen[0] as { resourceType: string }).resourceType).toBe('AWS::SQS::Queue');
        expect(
          JSON.stringify(redacted),
          `${row.name}: captured a baseline that still holds the plaintext (${row.why})`
        ).not.toContain(row.needle ?? PLAINTEXT);
        // CONTENT, not just absence: `not.toContain` alone is satisfied by a
        // redactor that returns `{}`, and several shapes exist only here.
        expect(
          row.expected,
          `${row.name}: a non-refused row must declare its expected bag. ` +
            '`not.toContain` alone is satisfied by a redactor returning `{}`, so a ' +
            'row without `expected` silently degrades to an absence check.'
        ).toBeDefined();
        expect(redacted, `${row.name}: wrong bag persisted`).toEqual(row.expected);
      }

      // THE EXPECTED VERDICT. Paired with the invariant so that refusing
      // everything — which satisfies the invariant perfectly — cannot pass.
      expect(refused, `${row.name}: ${row.why}`).toBe(row.refused);
    });
  }

  it('RESIDUE (issue #2885): the capture still leaks at an uncertifiable position', async () => {
    // The absence recorded in this file's header, stated as a RUNNING
    // assertion instead of prose. Issue #2852 made the position walk fail
    // CLOSED, but only for a caller that declares its bag is a drift baseline
    // (`STATE_SOURCED_BASELINE_RULES`); this capture still passes
    // `STATE_SOURCED_READBACK_RULES`, one constant away.
    //
    // Asserted in BOTH directions on purpose. The first half is the residue —
    // the plaintext survives today, so a row for this shape in the table above
    // would red its SAFETY invariant. The second half is the fix waiting: the
    // same input under the baseline constant already masks, so #2885 is a
    // constant swap and this case goes RED the moment it lands, which is what
    // makes it a test rather than a comment.
    //
    // THE FIRST HALF GOES THROUGH `captureVia`, i.e. through the real
    // `captureObservedForImportedResources`, and that is the whole point of the
    // case. An earlier revision called `redactSecretsForState` with
    // `STATE_SOURCED_READBACK_RULES` spelled HERE — which pins this file's own
    // argument, not production's: swapping the constant at the call site
    // (`src/cli/commands/import.ts`, the one edit #2885 asks for) left this case
    // GREEN, measured, so its failure message could never fire for the reason it
    // names. The second half stays a direct call because it describes an
    // argument production does not pass YET.
    const properties = { Detail: { pw: TOKEN } };
    const readback = { Detail: [PLAINTEXT] };
    const row: Row = {
      name: 'RESIDUE #2885: readback container where the source spells a record',
      properties,
      readback,
      refused: false,
      why: 'the shape #2852 closed for a baseline caller, still open for this one',
    };

    const { refused, persisted } = await classify(row);
    expect(refused, 'the residue is only reachable on a row the classifier ADMITS').toBe(false);
    const { observed: leaks } = await captureVia(row, persisted, new Set());
    expect(
      JSON.stringify(leaks),
      'issue #2885 has landed — move this shape into ROWS and delete this case'
    ).toContain(PLAINTEXT);

    const closed = redactSecretsForState(
      readback,
      new Map<string, string>(),
      properties,
      STATE_SOURCED_BASELINE_RULES
    );
    expect(JSON.stringify(closed)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(closed)).toContain(SECRET_MASK);
  });

  it('the premise holds: every refused row would REALLY have leaked', async () => {
    // Without this the refusing half of the table is unfalsifiable — a row
    // could be refused for a shape that was never dangerous, and the fence
    // would read as protective while protecting nothing. So replay the capture
    // for each refused row ANYWAY and require the plaintext to survive: that is
    // what the refusal is buying, measured rather than assumed.
    let proven = 0;
    for (const row of ROWS.filter((r) => r.refused && !r.overRefusal)) {
      const { persisted } = await classify(row);
      const { observed: redacted } = await captureVia(row, persisted, new Set());
      expect(
        JSON.stringify(redacted),
        `${row.name}: refused, but capturing would NOT have leaked — the refusal is unearned`
      ).toContain(row.needle ?? PLAINTEXT);
      proven++;
    }
    expect(proven, 'the loop ran over every EARNED refusal').toBe(8);
  });
});
