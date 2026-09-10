/**
 * A `Ref` whose value is recovered from STATE must never serve the redaction
 * mask (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847), independent
 * review round).
 *
 * THE HOLE THIS CLOSES. `noteAttributeSecrecy`'s own contract is that "every
 * branch serving a value out of a PERSISTED `attributes` bag must call this",
 * and one branch did not: `Ref`. For a handful of types CloudFormation's `Ref`
 * is not the physical id but a value cdkd stores in `properties` / `attributes`
 * — `AWS::S3Tables::Table.TableName` (issue #974),
 * `AWS::Backup::BackupSelection.SelectionId` (issue #995),
 * `AWS::CodeCommit::Repository.RepositoryId` (issue #1045), the
 * `AWS::AppSync::*` child ARNs (issue #1681) — and
 * `refStateLookupFromResource` returned the first non-empty STRING it found.
 * `SECRET_MASK` is a non-empty string, so `{"Ref": "MyTable"}` resolved to
 * `'***'`, `resolveRef` returned it verbatim with no `carriesSecretMask` test
 * and no note, `redactedAttributeReads` stayed empty,
 * `DeployEngine.refuseRedactedAttributeReads` never fired, and a GREEN deploy
 * substituted the literal `***` into the consumer's property and sent it to
 * AWS — the issue #1498 / #1501 corrupted-write class.
 *
 * It became REACHABLE with this PR rather than being new: `CloudControlProvider.import`
 * now masks every model key it cannot certify is a `readOnlyProperties`
 * attribute, and `TableName` is WRITABLE, so it is masked even when
 * `cloudformation:DescribeType` IS granted. Without the grant the fail-closed
 * arm masks the whole model.
 *
 * WHAT EACH CASE MUST DISCRIMINATE. "The result is not `***`" is satisfied by a
 * lookup that never ran, so every masked case also pins the RECORDED READ, and
 * every recorded-read case is paired with an unmasked control proving the same
 * record resolves normally and records nothing. The chosen fixture value is an
 * ARN whose tail is a UUID — the real CC-routed shape — so "returned the
 * physical id" can never be confused with "returned the table name".
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  cfnRefValueFromPhysicalId,
  refStateLookupFromResource,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

const TABLE_TYPE = 'AWS::S3Tables::Table';
/**
 * A #614-routed Table's physical id: the BARE `TableARN`, pipe-free, ending in
 * a UUID rather than the table name. Its shape is what makes the fall-through
 * observable — no assertion below can mistake it for a recovered `TableName`.
 */
const TABLE_ARN =
  'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/6f1f5a90-2847-4b1a-9d6f-zz2847zz';
const TABLE_NAME = 'orders_zz2847';

function contextFor(
  record: Partial<ResourceState> & { resourceType?: string },
  redactedAttributeReads?: string[]
): ResolverContext {
  const resourceType = record.resourceType ?? TABLE_TYPE;
  const template: CloudFormationTemplate = {
    Resources: { T: { Type: resourceType, Properties: {} } },
  };
  return {
    template,
    resources: {
      T: {
        physicalId: record.physicalId ?? TABLE_ARN,
        resourceType,
        properties: record.properties ?? {},
        ...(record.attributes && { attributes: record.attributes }),
        dependencies: [],
      },
    },
    ...(redactedAttributeReads && { redactedAttributeReads }),
  };
}

describe('refStateLookupFromResource refuses to serve a masked Ref value (#2847)', () => {
  it('skips a masked leaf and reports the key, so the caller falls back instead of returning ***', () => {
    const reported: string[] = [];
    const lookup = refStateLookupFromResource(
      { properties: { TableName: SECRET_MASK } },
      (key) => reported.push(key)
    );

    expect(lookup(['TableName', 'Name'])).toBeUndefined();
    expect(reported).toEqual(['TableName']);
  });

  it('serves an ORDINARY value and reports nothing — the other direction', () => {
    // Without this, a lookup that had degraded to "always undefined" would pass
    // every masked case in this file.
    const reported: string[] = [];
    const lookup = refStateLookupFromResource(
      { properties: { TableName: TABLE_NAME } },
      (key) => reported.push(key)
    );

    expect(lookup(['TableName', 'Name'])).toBe(TABLE_NAME);
    expect(reported).toEqual([]);
  });

  it('falls through a masked properties leaf to a LIVE attributes leaf and reports nothing', () => {
    // The scan spans two bags. Reporting at the masked leaf rather than at the
    // empty RESULT would refuse a deploy that has the value it needs — and this
    // exact shape (a redacted `properties` beside a live `attributes`) is what
    // `cdkd import` writes.
    const reported: string[] = [];
    const lookup = refStateLookupFromResource(
      { properties: { TableName: SECRET_MASK }, attributes: { TableName: TABLE_NAME } },
      (key) => reported.push(key)
    );

    expect(lookup(['TableName', 'Name'])).toBe(TABLE_NAME);
    expect(reported).toEqual([]);
  });

  it('reports nothing for an ABSENT key, so the pre-existing graceful degradation is untouched', () => {
    // `AWS::CodeCommit::Repository` and friends document a fall-through to the
    // physical id for a record written before the attribute was stored. That
    // case must keep degrading silently; only a REDACTION refuses.
    const reported: string[] = [];
    const lookup = refStateLookupFromResource({ properties: {}, attributes: {} }, (key) =>
      reported.push(key)
    );

    expect(lookup(['RepositoryId'])).toBeUndefined();
    expect(reported).toEqual([]);
  });

  it('WITH NO CALLBACK, hands back the mask exactly as it did before #2847', () => {
    // THE OPT-IN, asserted at the seam. This case was INVERTED in round 3: it
    // used to require the skip here too, i.e. it pinned the unconditional
    // behaviour that three review rounds each found a fresh caller broken by.
    // A caller with nowhere to put a refusal is strictly better off with the
    // mask — `refuseMaskedReplayBaseline`, `cdkd export`'s blocker, drift and
    // the deploy refusal all recognise `'***'` and none of them recognises a
    // raw physical id. Nothing is lost by the inversion: the skip's own
    // behaviour is pinned by the case above, which passes a callback.
    const refValue = cfnRefValueFromPhysicalId(
      TABLE_TYPE,
      TABLE_ARN,
      refStateLookupFromResource({ properties: { TableName: SECRET_MASK } })
    );

    expect(refValue).toBe(SECRET_MASK);
    // ...and specifically NOT the fall-through, which is the value that
    // reaches AWS unrecognised.
    expect(refValue).not.toBe(TABLE_ARN);
  });
});

describe('resolveRef records a redacted read instead of shipping the mask (#2847)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver('us-east-1');
    resetAccountInfoCache();
  });

  it('resolves a masked S3Tables TableName to something other than the mask, and NOTES the read', async () => {
    const redactedAttributeReads: string[] = [];
    const context = contextFor({ properties: { TableName: SECRET_MASK } }, redactedAttributeReads);

    const value = await resolver.resolve({ Ref: 'T' }, context);

    // NEGATIVE: the literal mask must not be the value a provider would send.
    expect(value).not.toBe(SECRET_MASK);
    // POSITIVE: and the read is recorded, which is what makes
    // `DeployEngine.refuseRedactedAttributeReads` fail the resource rather than
    // let the (wrong-but-not-secret) ARN ship. Without this the negative above
    // would be satisfied by a plain silent fall-through.
    expect(redactedAttributeReads).toEqual(['Ref T (state key TableName)']);
  });

  it('records the read ONCE however many times the same Ref is resolved', async () => {
    const redactedAttributeReads: string[] = [];
    const context = contextFor({ properties: { TableName: SECRET_MASK } }, redactedAttributeReads);

    await resolver.resolve({ Ref: 'T' }, context);
    await resolver.resolve({ Ref: 'T' }, context);

    expect(redactedAttributeReads).toEqual(['Ref T (state key TableName)']);
  });

  it('resolves an ORDINARY TableName normally and records nothing', async () => {
    const redactedAttributeReads: string[] = [];
    const context = contextFor({ properties: { TableName: TABLE_NAME } }, redactedAttributeReads);

    const value = await resolver.resolve({ Ref: 'T' }, context);

    expect(value).toBe(TABLE_NAME);
    expect(redactedAttributeReads).toEqual([]);
  });

  it.each([
    ['AWS::Backup::BackupSelection', 'SelectionId', 'sel-2847_plan-2847'],
    ['AWS::CodeCommit::Repository', 'RepositoryId', 'repo-name-2847'],
    ['AWS::AppSync::DataSource', 'DataSourceArn', 'abcd1234|ds2847'],
  ])(
    'covers the %s recovery branch too — one masked key, one recorded read',
    async (resourceType, key, physicalId) => {
      // The recovery branches are SIBLING SITES of one root cause: each reads
      // the same two bags through the same seam. Fixing the lookup covers all
      // of them, and this row is what proves the fix is not S3Tables-shaped.
      const redactedAttributeReads: string[] = [];
      const context = contextFor(
        { resourceType, physicalId, attributes: { [key]: SECRET_MASK } },
        redactedAttributeReads
      );

      const value = await resolver.resolve({ Ref: 'T' }, context);

      expect(value).not.toBe(SECRET_MASK);
      expect(redactedAttributeReads).toEqual([`Ref T (state key ${key})`]);
    }
  );

  it('serves the MASK when the context declares no redactedAttributeReads bag', async () => {
    // The resolver-level half of the opt-in, and INVERTED in round 3 for the
    // same reason as the seam case above. `cdkd diff`, `cdkd scrub` and
    // `cdkd import` build contexts with no bag; `resolveRefValue` therefore
    // passes NO callback and the resolution is byte-for-byte pre-#2847.
    //
    // `cdkd import` is why this matters rather than being a tidy symmetry: its
    // result is PERSISTED into `resource.properties`, and while the skip fired
    // here it persisted the raw physical id — which `cdkd export` writes into
    // the imported template and `cdkd drift --revert` sends to AWS.
    const context = contextFor({ properties: { TableName: SECRET_MASK } });

    // Pinned to the VALUE, not to a bare negative: `undefined` would satisfy
    // `not.toBe(TABLE_ARN)` while saying nothing about what is served.
    await expect(resolver.resolve({ Ref: 'T' }, context)).resolves.toBe(SECRET_MASK);
  });

  it('reports the FIRST masked key when several of a type\'s alias keys are masked', async () => {
    // `AWS::S3Tables::Table` is the only type with an alias list
    // (`['TableName', 'Name']`), so it is the only place `maskedKey ??= key`
    // is observable. Without this row, changing `??=` to a plain `=` — report
    // the LAST masked key rather than the first — stays green across every
    // other case in this file.
    const redactedAttributeReads: string[] = [];
    const context = contextFor(
      { properties: { TableName: SECRET_MASK, Name: SECRET_MASK } },
      redactedAttributeReads
    );

    await resolver.resolve({ Ref: 'T' }, context);

    expect(redactedAttributeReads).toEqual(['Ref T (state key TableName)']);
  });
});
