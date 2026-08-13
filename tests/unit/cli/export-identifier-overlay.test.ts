import { describe, it, expect, vi } from 'vite-plus/test';
import {
  applyImportOverlayForPhase2,
  buildImportPlan,
  filterTemplateForImport,
  groupBlockedReasons,
  hasCompositeIdSplitter,
  splitCompositePhysicalId,
} from '../../../src/cli/commands/export.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { StackState } from '../../../src/types/state.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * Issues [#1787](https://github.com/go-to-k/cdkd/issues/1787) and
 * [#1788](https://github.com/go-to-k/cdkd/issues/1788), both split out of
 * #1771 — the two halves of `cdkd export`'s resource-identifier handling that
 * #1771 deliberately did not touch:
 *
 * - #1788: `AWS::EC2::VPCCidrBlock` had a COMPOSITE `primaryIdentifier` and no
 *   `COMPOSITE_ID_SPLITTERS` entry, so its mere presence aborted the WHOLE
 *   command — and any CDK `Vpc` with `ipProtocol: IpProtocol.DUAL_STACK`
 *   declares one.
 * - #1787: `overlayResourceIdentifierOnProperties` only overwrote a
 *   `typeof === 'string'` value, so a field the template carried as an ARRAY
 *   survived into the phase-1 template and reached `CreateChangeSet`, where
 *   CFn answered with an opaque rejection.
 *
 * Every schema fact asserted below is the live `DescribeType` shape measured
 * in us-east-1 on 2026-08-13.
 */

const VPC_ID = 'vpc-0abc123def4567890';
const ASSOC_ID = 'vpc-cidr-assoc-0fedcba9876543210';

/** Run a template through BOTH overlay call sites and return the two results. */
function overlayBothPhases(
  template: Record<string, unknown>,
  entry: Parameters<typeof filterTemplateForImport>[1][number],
  logicalId: string
): { phase1: Record<string, unknown>; phase2: Record<string, unknown> } {
  const readProps = (t: Record<string, unknown>): Record<string, unknown> =>
    (
      (t['Resources'] as Record<string, Record<string, unknown>>)[logicalId] as Record<
        string,
        unknown
      >
    )['Properties'] as Record<string, unknown>;

  return {
    phase1: readProps(filterTemplateForImport(structuredClone(template), [entry])),
    phase2: readProps(applyImportOverlayForPhase2(structuredClone(template), [entry])),
  };
}

describe('AWS::EC2::VPCCidrBlock composite-id splitter (issue #1788)', () => {
  it('is registered, so its presence no longer aborts the whole export', () => {
    // The pre-fix failure: `resolveResourceIdentifier` threw
    // "resource type uses a composite primary identifier (2 fields: Id, VpcId);
    // add an entry to COMPOSITE_ID_SPLITTERS" for the WHOLE command.
    expect(hasCompositeIdSplitter('AWS::EC2::VPCCidrBlock')).toBe(true);
  });

  it('splits the Cloud-Control `<Id>|<VpcId>` physical id and narrows the overlay to VpcId', () => {
    expect(splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', `${ASSOC_ID}|${VPC_ID}`, {})).toEqual({
      // CFn requires the FULL primaryIdentifier in ResourcesToImport[].
      resourceIdentifier: { Id: ASSOC_ID, VpcId: VPC_ID },
      // ...but `Id` is `readOnlyProperties`, so writing it into Properties
      // would be rejected at changeset-create. Same narrowing as the
      // AWS::EC2::VPCGatewayAttachment / AWS::EC2::Route siblings.
      propertiesOverlay: { VpcId: VPC_ID },
    });
  });

  it('accepts the BARE association id, recovering VpcId from recorded properties', () => {
    // CloudFormation reports this type's PhysicalResourceId as the association
    // id ALONE, so a stack adopted via `cdkd import --migrate-from-cloudformation`
    // carries that shape in state. Same recovery as AWS::ApiGateway::Resource.
    expect(
      splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', ASSOC_ID, { VpcId: VPC_ID })
    ).toEqual({
      resourceIdentifier: { Id: ASSOC_ID, VpcId: VPC_ID },
      propertiesOverlay: { VpcId: VPC_ID },
    });
  });

  it('refuses a wrong-arity, blank or empty-part physical id rather than shipping a partial identifier', () => {
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', `${ASSOC_ID}|${VPC_ID}|extra`, {})
    ).toThrow(/expected a bare '<Id>' or '<Id>\|<VpcId>', got 3 parts/);
    expect(() => splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', `|${VPC_ID}`, {})).toThrow(
      /empty part/
    );
    expect(() => splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', `${ASSOC_ID}|`, {})).toThrow(
      /empty part/
    );
    // `.trim()`, not truthiness — the sibling EC2::Route / ApiGateway::Resource
    // guard. A blank segment would otherwise ship `Id: ' '`.
    expect(() => splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', '   ', {})).toThrow(
      /empty physical id/
    );
    expect(() => splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', `${ASSOC_ID}|   `, {})).toThrow(
      /empty part/
    );
  });

  it('shape-binds BOTH segments, so a reversed pair is refused locally instead of by CFn', () => {
    // The association id carries the distinct `vpc-cidr-assoc-` prefix while a
    // VPC id does not, so the two ARE discriminable — exactly as the
    // AWS::EC2::EIP splitter discriminates `eipalloc-`.
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', `${VPC_ID}|${ASSOC_ID}`, {})
    ).toThrow(/does not start with an association id/);

    // BOTH sides are checked: `assoc|assoc` satisfies a first-segment-only
    // guard and would then ship a VpcId naming nothing. A discriminator that
    // validates one side only is not a discriminator.
    expect(() =>
      splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', `${ASSOC_ID}|${ASSOC_ID}`, {})
    ).toThrow(/is not a VPC id/);
  });

  it('does NOT write the read-only Id into Properties at either overlay site', () => {
    const entry = {
      logicalId: 'Ipv6Cidr',
      resourceType: 'AWS::EC2::VPCCidrBlock',
      physicalId: `${ASSOC_ID}|${VPC_ID}`,
      ...splitCompositePhysicalId('AWS::EC2::VPCCidrBlock', `${ASSOC_ID}|${VPC_ID}`, {}),
    };
    const template = {
      Resources: {
        Ipv6Cidr: {
          Type: 'AWS::EC2::VPCCidrBlock',
          // The shape CDK synthesizes for a DUAL_STACK Vpc: a literal VpcId
          // (stale here, so the overlay's rewrite is observable) and no Id.
          Properties: { VpcId: 'vpc-stale', AmazonProvidedIpv6CidrBlock: true },
        },
      },
    };

    const { phase1, phase2 } = overlayBothPhases(template, entry, 'Ipv6Cidr');

    expect(phase1).toEqual({ VpcId: VPC_ID, AmazonProvidedIpv6CidrBlock: true });
    // `Id` is read-only; writing it is what CFn rejects at changeset-create.
    expect(phase1).not.toHaveProperty('Id');
    // Phase 1 and phase 2 must agree, or CFn sees a property change between
    // the IMPORT'd state and the UPDATE template and silently REPLACES.
    expect(phase2).toEqual(phase1);
  });
});

describe('overlayResourceIdentifierOnProperties non-string literals (issue #1787)', () => {
  const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';

  /** The measured instance: `addPropertyOverride('Namespace', ['analytics'])`. */
  const namespaceEntry = {
    logicalId: 'Ns',
    resourceType: 'AWS::S3Tables::Namespace',
    physicalId: `${BUCKET_ARN}|analytics`,
    ...splitCompositePhysicalId('AWS::S3Tables::Namespace', `${BUCKET_ARN}|analytics`, {}),
  };

  const namespaceTemplate = (namespace: unknown): Record<string, unknown> => ({
    Resources: {
      Ns: { Type: 'AWS::S3Tables::Namespace', Properties: { Namespace: namespace } },
    },
  });

  it('rewrites a single-element string array to the scalar identifier', () => {
    // The exact shape the issue measured. Pre-fix this array survived into the
    // phase-1 template and CFn rejected the changeset opaquely.
    const { phase1, phase2 } = overlayBothPhases(
      namespaceTemplate(['analytics']),
      namespaceEntry,
      'Ns'
    );

    expect(phase1['Namespace']).toBe('analytics');
    expect(phase2['Namespace']).toBe('analytics');
    // Asserted against the ARRAY specifically, not merely "is a string": the
    // regression this fences re-admits the list, and `toBe` on the scalar
    // would also pass if the value were left as a one-element array under a
    // loose matcher.
    expect(Array.isArray(phase1['Namespace'])).toBe(false);
  });

  it('rewrites a multi-element array too — the identifier is the authority, not the template', () => {
    // The overlay value comes from the cdkd-recorded physicalId, so there is
    // nothing to reconcile against: whatever the template listed, the resource
    // IS `analytics`.
    const { phase1 } = overlayBothPhases(
      namespaceTemplate(['analytics', 'stale-sibling']),
      namespaceEntry,
      'Ns'
    );

    expect(phase1['Namespace']).toBe('analytics');
  });

  it('rewrites non-string scalars (a number / boolean the template mis-typed)', () => {
    const entry = {
      logicalId: 'Ns',
      resourceType: 'AWS::S3Tables::Namespace',
      physicalId: `${BUCKET_ARN}|123`,
      ...splitCompositePhysicalId('AWS::S3Tables::Namespace', `${BUCKET_ARN}|123`, {}),
    };
    // An unquoted YAML `Namespace: 123` parses to a NUMBER, which the pre-fix
    // `typeof === 'string'` rule also let through untouched.
    const { phase1 } = overlayBothPhases(namespaceTemplate(123), entry, 'Ns');

    expect(phase1['Namespace']).toBe('123');
  });

  it('still PRESERVES a top-level intrinsic — the #319 case must not regress', () => {
    // `{Ref: Parent}` resolves during changeset processing to exactly this
    // resource's ResourceIdentifier value, so clobbering it would only make
    // the post-export `cdk diff` dirty.
    const intrinsic = { Ref: 'ParentBucket' };
    const { phase1, phase2 } = overlayBothPhases(
      namespaceTemplate(intrinsic),
      namespaceEntry,
      'Ns'
    );

    expect(phase1['Namespace']).toEqual(intrinsic);
    expect(phase2['Namespace']).toEqual(intrinsic);
  });

  it('OVERWRITES an explicit null — it is present in the emitted template, not absent', () => {
    // `undefined` means the key is not there; `null` means it IS, and the
    // shallow Properties copy keeps it, so skipping would ship
    // `"Namespace": null` to CreateChangeSet — the same opaque-rejection class
    // as the array, through the same addPropertyOverride hatch.
    const { phase1 } = overlayBothPhases(namespaceTemplate(null), namespaceEntry, 'Ns');

    expect(phase1['Namespace']).toBe('analytics');
  });

  it('still leaves an ABSENT field absent', () => {
    const { phase1 } = overlayBothPhases(
      { Resources: { Ns: { Type: 'AWS::S3Tables::Namespace', Properties: {} } } },
      namespaceEntry,
      'Ns'
    );

    // An auto-generated name the user never declared: CFn accepts the IMPORT
    // on ResourceIdentifier alone.
    expect(phase1).not.toHaveProperty('Namespace');
  });

  it('REFUSES a list carrying an intrinsic, naming the resource, property and scalar', () => {
    // Neither available action is honest: preserving it reproduces the opaque
    // CFn rejection, and overwriting it would discard an intrinsic the user
    // wrote. So the command stops before submitting anything.
    expect(() =>
      filterTemplateForImport(namespaceTemplate([{ Ref: 'ParentBucket' }]), [namespaceEntry])
    ).toThrow(/Ns \(AWS::S3Tables::Namespace\).*'Namespace'.*will not rewrite it.*analytics/s);

    // The phase-2 site must refuse identically — a refusal on only one of the
    // two would let the same template through on the other path.
    expect(() =>
      applyImportOverlayForPhase2(namespaceTemplate([{ Ref: 'ParentBucket' }]), [namespaceEntry])
    ).toThrow(/will not rewrite it/);
  });

  it('REFUSES an empty list — and says WHY, without claiming a discarded intrinsic', () => {
    // The two refusal arms have different reasons and must not share one
    // sentence: an empty list carries no intrinsic to protect, so asserting
    // that rewriting "would discard the intrinsic it carries" would be false.
    expect(() => filterTemplateForImport(namespaceTemplate([]), [namespaceEntry])).toThrow(
      /'Namespace' is an empty list.*will not invent a scalar where the template declared no value/s
    );
    expect(() => filterTemplateForImport(namespaceTemplate([]), [namespaceEntry])).not.toThrow(
      /discard the intrinsic/
    );
  });

  it('REFUSES a nested list — and does NOT claim it carries an intrinsic', () => {
    // A nested list reaches the same `unrepresentable` arm as an
    // intrinsic-bearing one, but has no intrinsic to protect. An earlier
    // revision asserted the intrinsic reason for every shape, which sent the
    // user looking for something that is not there. Both call sites, since a
    // wording fix applied to only one would go unnoticed.
    for (const overlay of [filterTemplateForImport, applyImportOverlayForPhase2]) {
      expect(() => overlay(namespaceTemplate([['analytics']]), [namespaceEntry])).toThrow(
        /cannot represent as the scalar the schema declares/
      );
      expect(() => overlay(namespaceTemplate([['analytics']]), [namespaceEntry])).not.toThrow(
        /discard the intrinsic/
      );
    }
  });

  it('REFUSES a list holding null the same way — no intrinsic is claimed', () => {
    expect(() => filterTemplateForImport(namespaceTemplate([null]), [namespaceEntry])).toThrow(
      /cannot represent as the scalar the schema declares/
    );
    expect(() => filterTemplateForImport(namespaceTemplate([null]), [namespaceEntry])).not.toThrow(
      /discard the intrinsic/
    );
  });

  it('DOES claim a discarded intrinsic when the list actually carries one', () => {
    // The polarity control for the two tests above: without it, a message that
    // never mentions an intrinsic at all would satisfy both.
    expect(() =>
      filterTemplateForImport(namespaceTemplate([{ Ref: 'ParentBucket' }]), [namespaceEntry])
    ).toThrow(/discard the intrinsic it carries/);
  });
});

describe('the refusal is a PLANNING verdict, not a preprocessing throw (issue #1787)', () => {
  const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';

  const cfnClient = {
    async send(cmd: { input?: { TypeName?: string } }) {
      if (cmd.input?.TypeName !== 'AWS::S3Tables::Namespace') {
        throw new Error(`DescribeType stub: no schema for ${cmd.input?.TypeName}`);
      }
      return {
        Schema: JSON.stringify({
          primaryIdentifier: ['/properties/TableBucketARN', '/properties/Namespace'],
          handlers: { create: {}, read: {}, delete: {}, list: {} },
        }),
        ProvisioningType: 'IMMUTABLE',
      };
    },
  } as unknown as AwsClients['cloudFormation'];

  const state = (): StackState => ({
    version: 8,
    stackName: 'MyStack',
    region: 'us-east-1',
    resources: {
      Ns: {
        physicalId: `${BUCKET_ARN}|analytics`,
        resourceType: 'AWS::S3Tables::Namespace',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  });

  const templateWith = (namespace: unknown): Record<string, unknown> => ({
    Resources: {
      Ns: { Type: 'AWS::S3Tables::Namespace', Properties: { Namespace: namespace } },
    },
  });

  it('BLOCKS the resource in buildImportPlan instead of throwing at overlay time', async () => {
    // THE point of the relocation. `overlayResourceIdentifierOnProperties` is
    // reached from three places, and two are past the point of no return:
    // `--dry-run` returns BEFORE any overlay call, so a dry run would report a
    // clean plan for a template the real run aborts on; and the nested-stack
    // path overlays INSIDE the per-stack IMPORT loop, where a throw on stack N
    // leaves stacks 1..N-1 already migrated. Reporting through `blocked` puts
    // the verdict before the lock, before dry-run's return, and before any AWS
    // write.
    const plan = await buildImportPlan(
      state(),
      templateWith([{ Ref: 'ParentBucket' }]),
      cfnClient,
      'MyStack'
    );

    expect(plan.phase1Imports).toHaveLength(0);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.logicalId).toBe('Ns');
    expect(plan.blocked[0]!.reason).toMatch(/'Namespace'.*will not rewrite it.*analytics/s);
  });

  it('does NOT block a template the overlay can legitimately rewrite', async () => {
    // Non-vacuity: the assertion above would also hold if the pre-flight
    // blocked every S3Tables namespace outright.
    const plan = await buildImportPlan(state(), templateWith(['analytics']), cfnClient, 'MyStack');

    expect(plan.blocked).toHaveLength(0);
    expect(plan.phase1Imports).toHaveLength(1);
  });
});

describe('groupBlockedReasons (issue #1787 reporting)', () => {
  // The pre-flight pushes one entry per offending FIELD, while the message
  // above the bullets counts distinct RESOURCES. Without folding, a two-field
  // overlay printed "1 resource(s)" over two bullets.
  const entry = (logicalId: string, reason: string) => ({
    logicalId,
    resourceType: 'AWS::S3Tables::Namespace',
    reason,
  });

  it('renders one bullet per resource and folds its several reasons under it', () => {
    const lines = groupBlockedReasons([
      entry('Ns', "the identifier property 'Namespace' is an empty list"),
      entry('Ns', "the identifier property 'TableBucketARN' is an empty list"),
      entry('Other', 'some other reason'),
    ]);

    // One bullet per RESOURCE — this is the number the caller's
    // `new Set(...).size` count reports, so they must agree.
    expect(lines).toHaveLength(2);
    expect(new Set(['Ns', 'Other']).size).toBe(lines.length);

    // Every reason survives the fold; none is dropped in favour of the first.
    expect(lines[0]).toContain('Namespace');
    expect(lines[0]).toContain('TableBucketARN');
    expect(lines[1]).toContain('some other reason');
  });

  it('keeps the single-reason shape on one line (no gratuitous nesting)', () => {
    const lines = groupBlockedReasons([entry('Ns', 'only reason')]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('  - Ns (AWS::S3Tables::Namespace): only reason');
    expect(lines[0]).not.toContain('\n');
  });

  it('preserves first-seen resource order', () => {
    const lines = groupBlockedReasons([entry('B', 'r1'), entry('A', 'r2'), entry('B', 'r3')]);

    expect(lines[0]).toContain('B (');
    expect(lines[1]).toContain('A (');
  });
});

describe('the LIST -> scalar rewrite warns once per export (issue #1787)', () => {
  const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
  const namespaceEntry = {
    logicalId: 'Ns',
    resourceType: 'AWS::S3Tables::Namespace',
    physicalId: `${BUCKET_ARN}|analytics`,
    ...splitCompositePhysicalId('AWS::S3Tables::Namespace', `${BUCKET_ARN}|analytics`, {}),
  };
  const templateWithArray = (): Record<string, unknown> => ({
    Resources: {
      Ns: { Type: 'AWS::S3Tables::Namespace', Properties: { Namespace: ['analytics'] } },
    },
  });

  it('is emitted by the phase-1 pass and suppressed on the repeat passes', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      // Phase 1 owns the message.
      filterTemplateForImport(templateWithArray(), [namespaceEntry]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/rewriting the identifier property 'Namespace'/);

      // The phase-2 overlay re-runs over the SAME entries; announcing every
      // rewrite a second time is noise, not information.
      applyImportOverlayForPhase2(templateWithArray(), [namespaceEntry]);
      expect(warn).toHaveBeenCalledTimes(1);

      // The nested path builds a phase-1 template twice (1A then 1B); the
      // second is passed `warnOnRewrite: false` for the same reason.
      filterTemplateForImport(templateWithArray(), [namespaceEntry], false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
