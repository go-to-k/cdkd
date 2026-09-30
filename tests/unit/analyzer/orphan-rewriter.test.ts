import { describe, it, expect, vi } from 'vite-plus/test';

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

import { rewriteResourceReferences } from '../../../src/analyzer/orphan-rewriter.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * Build a stub ProviderRegistry that resolves every resource type to a
 * provider whose `getAttribute` is the supplied function (or returns a
 * fixed value).
 */
function fakeRegistry(
  getAttribute?: ResourceProvider['getAttribute']
): ProviderRegistry {
  const provider: Partial<ResourceProvider> = {
    ...(getAttribute && { getAttribute }),
  };
  return {
    getProvider: vi.fn(() => provider as ResourceProvider),
    // #614: orphan-rewriter now routes via getProviderFor (sticky
    // provisionedBy from state). The test fixtures don't set
    // provisionedBy, so legacy SDK semantics apply.
    getProviderFor: vi.fn(() => ({ provider: provider as ResourceProvider, provisionedBy: 'sdk' })),
  } as unknown as ProviderRegistry;
}

function baseState(resources: StackState['resources'], outputs: Record<string, unknown> = {}): StackState {
  return {
    version: 2,
    stackName: 'TestStack',
    region: 'us-east-1',
    resources,
    outputs,
    lastModified: 0,
  };
}

describe('rewriteResourceReferences', () => {
  it('DROPS the skipped-outputs record it was handed (issue #2740)', async () => {
    // This rewrite substitutes FETCHED values into `properties`, `attributes`
    // and `outputs`, and a substitution alone can repair an Output — an
    // attribute holding an intrinsic that made an enclosing `Fn::Select` fail
    // becomes the fetched value. The output's own digest does not move and no
    // template resource changes, so the diff's change map has nothing to
    // un-bind on; carried, the record would preview that key as absent while
    // the next deploy publishes it. `cdkd import`, `drift --accept` and
    // `rollback` drop it for the same reason.
    const state = baseState({
      Bucket: { physicalId: 'b-phys', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o-phys',
        resourceType: 'AWS::S3::Bucket',
        properties: { BucketName: { Ref: 'Bucket' } },
      },
    });
    state.skippedOutputs = { Broken: 'digest-recorded-by-the-last-deploy' };

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    // The rewrite itself still happened — this is a targeted drop, not a
    // rebuild — so the substituted property is the control.
    expect(result.state.resources['Other']?.properties).toEqual({ BucketName: 'b-phys' });
    expect('skippedOutputs' in result.state).toBe(false);
  });

  it('rewrites a {Ref: orphan} into the orphan physicalId', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b-phys', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o-phys',
        resourceType: 'AWS::S3::Bucket',
        properties: { BucketName: { Ref: 'Bucket' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Bucket']).toBeUndefined();
    expect(result.state.resources['Other']?.properties).toEqual({ BucketName: 'b-phys' });
    expect(result.rewrites).toHaveLength(1);
    expect(result.rewrites[0]).toMatchObject({
      logicalId: 'Other',
      kind: 'ref',
      orphanLogicalId: 'Bucket',
      after: 'b-phys',
    });
  });

  // The `{Ref: orphan}` substitution must use CFn `Ref` semantics, not the raw
  // physical id — shared with the deploy-time resolver via
  // cfnRefValueFromPhysicalId. Two exception families:
  //  - ARN-stored SDK ids (AWS::Events::Rule): Ref is the rule NAME.
  //  - Compound CC ids (Cognito `<userPoolId>|<clientId>`): Ref is the
  //    after-pipe segment.
  it.each([
    [
      'AWS::Events::Rule',
      'arn:aws:events:us-east-1:123456789012:rule/my-rule',
      'my-rule',
    ],
    [
      'AWS::Cognito::UserPoolClient',
      'us-east-1_t1TBpabHO|9fut2hkhdues45051mvms2os5',
      '9fut2hkhdues45051mvms2os5',
    ],
    // Reversed-order compound (issue #963): Ref is the BEFORE-first-pipe
    // segment for ApiGateway::Deployment (`<deploymentId>|<restApiId>`).
    ['AWS::ApiGateway::Deployment', 'd5b52m|jkmnpf9ay0', 'd5b52m'],
  ])(
    'rewrites a {Ref: orphan} of %s into the CFn Ref value, not the raw physical id',
    async (resourceType, physicalId, expected) => {
      const state = baseState({
        Target: { physicalId, resourceType, properties: {} },
        Other: {
          physicalId: 'o-phys',
          resourceType: 'AWS::S3::Bucket',
          properties: { SomeRef: { Ref: 'Target' } },
        },
      });

      const result = await rewriteResourceReferences(state, ['Target'], fakeRegistry());

      expect(result.unresolvable).toEqual([]);
      expect(result.state.resources['Other']?.properties).toEqual({ SomeRef: expected });
    }
  );

  // Issue #974: a CC-routed AWS::S3Tables::Table stores the bare TableARN
  // (pipe-free, ends in a UUID) as its physical id, so `{Ref: table}` must be
  // rewritten to the stored TableName property — the same state-lookup seam the
  // deploy-time resolver uses — not the raw ARN.
  it('rewrites a {Ref: orphan} of a CC-routed S3Tables::Table into the TableName property', async () => {
    const state = baseState({
      Target: {
        physicalId: 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-tb/table/1234abcd-56ef',
        resourceType: 'AWS::S3Tables::Table',
        properties: { TableName: 'events' },
      },
      Other: {
        physicalId: 'o-phys',
        resourceType: 'AWS::S3::Bucket',
        properties: { SomeRef: { Ref: 'Target' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Target'], fakeRegistry());

    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Other']?.properties).toEqual({ SomeRef: 'events' });
  });

  it('rewrites array-form Fn::GetAtt via live provider call', async () => {
    const getAttribute = vi.fn(async (_p: string, _t: string, attr: string) =>
      attr === 'Arn' ? 'arn:aws:s3:::b-phys' : undefined
    );
    const state = baseState({
      Bucket: { physicalId: 'b-phys', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o-phys',
        resourceType: 'AWS::Lambda::Function',
        properties: { Env: { Bucket: { 'Fn::GetAtt': ['Bucket', 'Arn'] } } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(getAttribute));

    // The orphan's LOGICAL id is threaded as the fourth argument, for a
    // provider's `ProvisioningError` logical-id slot (go-to-k/cdkd#4222).
    expect(getAttribute).toHaveBeenCalledWith('b-phys', 'AWS::S3::Bucket', 'Arn', 'Bucket');
    expect(result.state.resources['Other']?.properties).toEqual({
      Env: { Bucket: 'arn:aws:s3:::b-phys' },
    });
    expect(result.unresolvable).toEqual([]);
  });

  it('rewrites string-form Fn::GetAtt ("Logical.Attr")', async () => {
    const getAttribute = vi.fn(async () => 'arn:aws:iam::role/r');
    const state = baseState({
      Role: { physicalId: 'r', resourceType: 'AWS::IAM::Role', properties: {} },
      User: {
        physicalId: 'u',
        resourceType: 'AWS::IAM::User',
        properties: { ManagedPolicyArns: [{ 'Fn::GetAtt': 'Role.Arn' }] },
      },
    });

    const result = await rewriteResourceReferences(state, ['Role'], fakeRegistry(getAttribute));

    expect(result.state.resources['User']?.properties).toEqual({
      ManagedPolicyArns: ['arn:aws:iam::role/r'],
    });
  });

  it('substitutes ${O} and ${O.attr} placeholders inside Fn::Sub, preserving unrelated placeholders', async () => {
    const getAttribute = vi.fn(async (_p, _t, attr: string) =>
      attr === 'Arn' ? 'arn:aws:s3:::b-phys' : undefined
    );
    const state = baseState({
      Bucket: { physicalId: 'b-phys', resourceType: 'AWS::S3::Bucket', properties: {} },
      Fn: {
        physicalId: 'f',
        resourceType: 'AWS::Lambda::Function',
        properties: {
          Env: {
            'Fn::Sub': 'arn=${Bucket.Arn};name=${Bucket};region=${AWS::Region};other=${Other}',
          },
        },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(getAttribute));

    const env = (result.state.resources['Fn']?.properties as { Env: unknown })['Env'];
    // Has a non-orphan placeholder (${AWS::Region}, ${Other}) so wrapper preserved.
    expect(env).toEqual({
      'Fn::Sub': 'arn=arn:aws:s3:::b-phys;name=b-phys;region=${AWS::Region};other=${Other}',
    });
  });

  it('drops dependency-array entries that match an orphan', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Fn: {
        physicalId: 'f',
        resourceType: 'AWS::Lambda::Function',
        properties: {},
        dependencies: ['Bucket', 'OtherDep'],
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    expect(result.state.resources['Fn']?.dependencies).toEqual(['OtherDep']);
    expect(result.rewrites.find((r) => r.kind === 'dependency')).toMatchObject({
      logicalId: 'Fn',
      path: 'dependencies',
      before: 'Bucket',
      after: null,
    });
  });

  it('handles multi-orphan circular references in one pass (resolves against pre-orphan snapshot)', async () => {
    // Orphan A references orphan B's attribute, AND vice versa.
    const getAttribute = vi.fn(async (_p, _t, attr: string) => `attr=${attr}`);
    const state = baseState({
      A: {
        physicalId: 'a',
        resourceType: 'AWS::S3::Bucket',
        properties: { Friend: { 'Fn::GetAtt': ['B', 'Arn'] } },
      },
      B: {
        physicalId: 'b',
        resourceType: 'AWS::S3::Bucket',
        properties: { Friend: { 'Fn::GetAtt': ['A', 'Arn'] } },
      },
      Bystander: {
        physicalId: 'c',
        resourceType: 'AWS::S3::Bucket',
        properties: { A: { Ref: 'A' }, B: { Ref: 'B' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['A', 'B'], fakeRegistry(getAttribute));

    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Bystander']?.properties).toEqual({ A: 'a', B: 'b' });
    expect(result.state.resources['A']).toBeUndefined();
    expect(result.state.resources['B']).toBeUndefined();
  });

  it('reports an unresolvable reference when the provider has no getAttribute', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(undefined));

    expect(result.unresolvable).toHaveLength(1);
    expect(result.unresolvable[0]).toMatchObject({
      logicalId: 'Other',
      orphanLogicalId: 'Bucket',
      attribute: 'Arn',
    });
    // Original intrinsic preserved.
    expect(result.state.resources['Other']?.properties).toEqual({
      Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
    });
  });

  it('reports unresolvable on provider error too (not just missing impl)', async () => {
    const getAttribute = vi.fn(async () => {
      throw new Error('AWS API failure');
    });
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(getAttribute));

    expect(result.unresolvable).toHaveLength(1);
    expect(result.unresolvable[0]?.reason).toMatch(/AWS API failure/);
  });

  it('--force falls back to state.attributes cache when live fetch fails', async () => {
    // A VPC's `Ipv6CidrBlocks` is the ordinary recorded value the
    // recorded-first read (go-to-k/cdkd#4186) declines, so the live read runs
    // and fails, and only `--force` reaches the cache.
    const getAttribute = vi.fn(async () => {
      throw new Error('throttled');
    });
    const state = baseState({
      Vpc: {
        physicalId: 'vpc-1',
        resourceType: 'AWS::EC2::VPC',
        properties: {},
        attributes: { Ipv6CidrBlocks: ['2600:1f18::/56'] },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] } },
      },
    });

    const plain = await rewriteResourceReferences(state, ['Vpc'], fakeRegistry(getAttribute));
    expect(plain.unresolvable.map((u) => u.reason)).toEqual(['throttled']);

    const result = await rewriteResourceReferences(
      state,
      ['Vpc'],
      fakeRegistry(getAttribute),
      { force: true }
    );

    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Other']?.properties).toEqual({ Value: ['2600:1f18::/56'] });
  });

  it("--force does NOT substitute a legacy '' security-group VpcId after a failed live read (#3097)", async () => {
    // A pre-#3097 record for a group declared without `VpcId` holds `''`,
    // which passes a bare `=== undefined` test; spliced into the referring
    // resource it would become its VpcId. The fallback reads it through the
    // resolver's `isImpossibleEmptyStoredAttribute`, so the reference stays
    // unresolvable instead.
    const getAttribute = vi.fn(async () => {
      throw new Error('throttled');
    });
    const state = baseState({
      Sg: {
        physicalId: 'sg-0123456789abcdef0',
        resourceType: 'AWS::EC2::SecurityGroup',
        properties: {},
        attributes: { GroupId: 'sg-0123456789abcdef0', VpcId: '' },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { 'Fn::GetAtt': ['Sg', 'VpcId'] } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Sg'], fakeRegistry(getAttribute), {
      force: true,
    });

    expect(result.unresolvable.map((u) => u.reason).join(' ')).toContain(
      "state.attributes cache also has no value for 'VpcId'"
    );
    expect(result.state.resources['Other']?.properties).toEqual({
      Value: { 'Fn::GetAtt': ['Sg', 'VpcId'] },
    });
    // The control: the same record's `GroupId` is a real value and IS substituted.
    const control = baseState({
      Sg: {
        physicalId: 'sg-0123456789abcdef0',
        resourceType: 'AWS::EC2::SecurityGroup',
        properties: {},
        attributes: { GroupId: 'sg-0123456789abcdef0', VpcId: '' },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { 'Fn::GetAtt': ['Sg', 'GroupId'] } },
      },
    });
    const controlResult = await rewriteResourceReferences(
      control,
      ['Sg'],
      fakeRegistry(getAttribute),
      { force: true }
    );
    expect(controlResult.unresolvable).toEqual([]);
    expect(controlResult.state.resources['Other']?.properties).toEqual({
      Value: 'sg-0123456789abcdef0',
    });
  });

  it('--force WARNS when the cached attribute is an unresolved dynamic reference (#2055)', async () => {
    // The SECOND reader of `state.attributes`. Since issue #2055 a nested
    // stack's `Outputs.<Key>` attribute legitimately holds its unresolved
    // `{{resolve:...}}` expression — the resolver re-resolves it at the READ
    // site, where a resolver context exists. This path has none, so it can only
    // splice the token verbatim into the referring resource's state; `--force`
    // is an explicit "use the cached value" escape hatch so it does not refuse,
    // but it must SAY what it wrote.
    const TOKEN = '{{resolve:secretsmanager:prod/db/cred:SecretString:password::}}';
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    const getAttribute = vi.fn(async () => {
      throw new Error('throttled');
    });
    const state = baseState({
      Child: {
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes: { 'Outputs.DbPassword': TOKEN },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { 'Fn::GetAtt': ['Child', 'Outputs.DbPassword'] } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Child'], fakeRegistry(getAttribute), {
      force: true,
    });

    // Behaviour is unchanged: the token IS spliced.
    expect(result.state.resources['Other']?.properties).toEqual({ Value: TOKEN });
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).toContain('UNRESOLVED');
    expect(warned).toContain('Outputs.DbPassword');
  });

  it('--force WARNS when the cached attribute is the REDACTION MASK (#2847)', async () => {
    // THE SECOND UNRESOLVABLE CLASS at this seam, and not the same as the one
    // above: a `{{resolve:...}}` token still NAMES the value, while
    // `SECRET_MASK` is all cdkd kept of it. Pre-existing for a `NoEcho` custom
    // resource, but issue #2847 WIDENED the population — `CloudControlProvider`
    // implements no `getAttribute` at all, so every CC-routed orphan lands in
    // this fallback, and `import` now masks every model key it cannot certify
    // as a read-only attribute.
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    // No `getAttribute` on the provider — the real CC shape, and the reason
    // this fallback is now the DEFAULT path for such a resource rather than an
    // error arm.
    const state = baseState({
      Chan: {
        physicalId: 'chan-1',
        resourceType: 'AWS::Pinpoint::APNSChannel',
        properties: {},
        attributes: { PrivateKey: SECRET_MASK },
        provisionedBy: 'cc-api',
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { 'Fn::GetAtt': ['Chan', 'PrivateKey'] } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Chan'], fakeRegistry(), {
      force: true,
    });

    // Behaviour is deliberately unchanged — `--force` means "use the cached
    // value" — so the POSITIVE is the warning, not a refusal.
    expect(result.state.resources['Other']?.properties).toEqual({ Value: SECRET_MASK });
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).toContain('REDACTION MASK');
    expect(warned).toContain('PrivateKey');
    // It must say what happens NEXT — and say it TRUTHFULLY. An earlier
    // revision promised "a later 'cdkd deploy' will REFUSE that resource",
    // which review measured false: `refuseRedactedAttributeReads` reads the
    // DESIRED-side resolution bag, while this splice lands in the CURRENT
    // (persisted) properties, which no deploy-path guard tests. These pin the
    // readers that really do recognise it.
    expect(warned).toContain('spurious change');
    expect(warned).toContain('cdkd rollback');
    expect(warned).toContain('cdkd export');
    // ...and pin the retracted claim as retracted, so restoring it reds.
    //
    // THE PROPOSITION, NOT THE TYPOGRAPHY. This asserted `not.toContain('REFUSE')`
    // and review measured that green against the IDENTICAL false claim in
    // sentence case (`…a later 'cdkd deploy' will refuse that resource…`). A
    // pin that a re-word defeats fences the shouting, not the statement.
    expect(warned).not.toMatch(/deploy'? will refuse/i);
    expect(warned).not.toMatch(/deploy will refuse/i);
  });

  it('REFUSES a {Ref: orphan} whose recovery key is the redaction mask, without --force', async () => {
    // The `Ref` path is NOT `--force`-gated and never was, so before this arm
    // it silently spliced whatever `cfnRefValueFromPhysicalId` returned. Once
    // the lookup learned to refuse a mask (issue #2847) that became the raw
    // physical id — an `AWS::S3Tables::Table` ARN ending in a UUID, not the
    // table name CFn's `Ref` returns — which, unlike the `'***'` it replaced,
    // NO later cdkd command recognises. So the refusal is the point: a
    // guarded sentinel must not be traded for an unguarded wrong value.
    const TABLE_ARN =
      'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/6f1f5a90-2847-4b1a-9d6f-aaaa';
    const state = baseState({
      Tbl: {
        physicalId: TABLE_ARN,
        resourceType: 'AWS::S3Tables::Table',
        properties: {},
        attributes: { TableName: SECRET_MASK },
        provisionedBy: 'cc-api',
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { Ref: 'Tbl' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Tbl'], fakeRegistry());

    // The intrinsic is LEFT IN PLACE — neither the mask nor the ARN is spliced.
    expect(result.state.resources['Other']?.properties).toEqual({ Value: { Ref: 'Tbl' } });
    expect(JSON.stringify(result.state.resources['Other'])).not.toContain(TABLE_ARN);
    // And the site is reported, which is what makes the command abort.
    expect(result.unresolvable).toHaveLength(1);
    expect(result.unresolvable[0]?.orphanLogicalId).toBe('Tbl');
    expect(result.unresolvable[0]?.attribute).toBe('Ref');
    expect(result.unresolvable[0]?.reason).toContain('TableName');
  });

  // Issue #1672 / #3892: for an id with more than one `|` the Glue `Ref` anchors
  // on the recorded DatabaseName. A masked anchor is the same refusal as any
  // masked recovery key; an ordinary two-segment id never reads state and
  // rewrites normally.
  it.each([
    ['refuses a masked DatabaseName anchor on a `|`-bearing id', 'mydb|a|b', 1],
    ['rewrites a two-segment Glue id without reading the masked anchor', 'mydb|orders', 0],
  ])('%s', async (_n, physicalId, unresolvable) => {
    const state = baseState({
      Tbl: {
        physicalId,
        resourceType: 'AWS::Glue::Table',
        properties: { DatabaseName: SECRET_MASK },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { Ref: 'Tbl' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Tbl'], fakeRegistry());

    expect(result.unresolvable).toHaveLength(unresolvable);
    if (unresolvable === 1) {
      expect(result.unresolvable[0]?.reason).toContain('DatabaseName');
      expect(result.state.resources['Other']?.properties).toEqual({ Value: { Ref: 'Tbl' } });
    } else {
      expect(result.state.resources['Other']?.properties).toEqual({ Value: 'orders' });
    }
  });

  it('--force substitutes the MASK, never the physical id, so downstream readers still catch it', async () => {
    // THE ROUND-2 SECURITY FINDING. `--force`'s contract is "use a
    // possibly-wrong value rather than stranding me", so the escape hatch
    // still produces a value — but WHICH value decides whether the damage
    // stays inside cdkd. The physical id here is a UUID-tailed `TableARN`
    // where the table NAME belongs; `refuseMaskedReplayBaseline`, `cdkd
    // export`'s blocker, drift and the deploy refusal all pass it, so every
    // later deploy would ship it to AWS. `SECRET_MASK` is the value those
    // four DO recognise, which is what `cacheFallback` — this arm's stated
    // mirror — already substitutes.
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    const TABLE_ARN =
      'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/6f1f5a90-2847-4b1a-9d6f-bbbb';
    const state = baseState({
      Tbl: {
        physicalId: TABLE_ARN,
        resourceType: 'AWS::S3Tables::Table',
        properties: {},
        attributes: { TableName: SECRET_MASK },
        provisionedBy: 'cc-api',
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { Ref: 'Tbl' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Tbl'], fakeRegistry(), {
      force: true,
    });

    // POSITIVE: the escape hatch completed and the reference WAS rewritten.
    expect(result.state.resources['Other']?.properties).toEqual({ Value: SECRET_MASK });
    expect(result.unresolvable).toHaveLength(0);
    // NEGATIVE, and the one the finding turns on: the physical id must not
    // appear anywhere in the rewritten record.
    expect(JSON.stringify(result.state.resources['Other'])).not.toContain(TABLE_ARN);
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).toContain('TableName');
    expect(warned).toContain('rather than the physical id');
    // The same truthfulness rule as the cacheFallback arm: no promise that a
    // deploy will refuse — it reads the DESIRED side, and this lands in the
    // persisted CURRENT one.
    expect(warned).not.toMatch(/deploy'? will refuse/i);
  });

  it('--force warns ONCE per masked orphan however many references it has', async () => {
    // `cacheFallback` memoizes through `this.cache`; the `Ref` arm has no
    // cacheable value, so without its own set N references print N identical
    // warnings over one orphan.
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    const state = baseState({
      Tbl: {
        physicalId: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/eeee',
        resourceType: 'AWS::S3Tables::Table',
        properties: {},
        attributes: { TableName: SECRET_MASK },
      },
      A: {
        physicalId: 'a',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { Ref: 'Tbl' } },
      },
      B: {
        physicalId: 'b',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { Ref: 'Tbl' }, Other: { 'Fn::Sub': 'x-${Tbl}' } },
      },
    });

    await rewriteResourceReferences(state, ['Tbl'], fakeRegistry(), { force: true });

    const maskWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((m) => m.includes('rather than the physical id'));
    expect(maskWarnings).toHaveLength(1);
  });

  it('warns once PER ORPHAN, not once per run', async () => {
    // THE KEY, not just the count. With one masked orphan in the fixture,
    // "one warning per run" and "one per orphan" are indistinguishable — so
    // keying the set on a constant stayed green while a SECOND masked
    // orphan's warning vanished, which is the diagnosis the user needs most.
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    const state = baseState({
      TblA: {
        physicalId: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/aaaa1',
        resourceType: 'AWS::S3Tables::Table',
        properties: {},
        attributes: { TableName: SECRET_MASK },
      },
      TblB: {
        physicalId: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/bbbb2',
        resourceType: 'AWS::S3Tables::Table',
        properties: {},
        attributes: { TableName: SECRET_MASK },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { A: { Ref: 'TblA' }, B: { Ref: 'TblB' } },
      },
    });

    await rewriteResourceReferences(state, ['TblA', 'TblB'], fakeRegistry(), { force: true });

    const maskWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((m) => m.includes('rather than the physical id'));
    expect(maskWarnings).toHaveLength(2);
    // ...and each NAMES its own orphan. Without the id the two lines render
    // byte-identically (same key, same type), so a reader could not tell which
    // record to repair — and a count alone would not notice a set keyed on the
    // RESOURCE TYPE either.
    expect(maskWarnings.some((m) => m.includes("'TblA'"))).toBe(true);
    expect(maskWarnings.some((m) => m.includes("'TblB'"))).toBe(true);
  });

  it('does NOT refuse an ordinary Ref recovery key (scope control)', async () => {
    // The other direction: a refusal that fires on every `Ref` would pass the
    // two cases above while breaking `cdkd orphan` for everyone.
    const state = baseState({
      Tbl: {
        physicalId: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/cccc',
        resourceType: 'AWS::S3Tables::Table',
        properties: { TableName: 'orders_2847' },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { Ref: 'Tbl' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Tbl'], fakeRegistry());

    expect(result.state.resources['Other']?.properties).toEqual({ Value: 'orders_2847' });
    expect(result.unresolvable).toHaveLength(0);
  });

  it('REFUSES an Fn::Sub ${orphan} whose recovery key is the mask, preserving the placeholder', async () => {
    // The SECOND `ref()` call site. A fix landing on one and not the other is
    // this repo's named sibling-site failure, so it gets its own row.
    const state = baseState({
      Tbl: {
        physicalId: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/dddd',
        resourceType: 'AWS::S3Tables::Table',
        properties: {},
        attributes: { TableName: SECRET_MASK },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { 'Fn::Sub': 'table-${Tbl}-suffix' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Tbl'], fakeRegistry());

    expect(result.state.resources['Other']?.properties).toEqual({
      Value: { 'Fn::Sub': 'table-${Tbl}-suffix' },
    });
    expect(result.unresolvable).toHaveLength(1);
    expect(result.unresolvable[0]?.attribute).toBe('Ref');
  });

  // An ORDINARY recorded value is served before any live read since
  // go-to-k/cdkd#4186, so it reaches the `--force` fallback only through an arm
  // the recorded-first read declines by type: a VPC's `Ipv6CidrBlocks`, which
  // the resolver never serves stored either.
  function vpcIpv6State(): StackState {
    return baseState({
      Vpc: {
        physicalId: 'vpc-1',
        resourceType: 'AWS::EC2::VPC',
        properties: {},
        attributes: { Ipv6CidrBlocks: ['2600:1f18::/56'] },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] } },
      },
    });
  }

  it('--force does NOT emit the MASK warning for an ordinary cached value (scope control)', async () => {
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    const state = vpcIpv6State();

    const result = await rewriteResourceReferences(state, ['Vpc'], fakeRegistry(), {
      force: true,
    });
    expect(result.state.resources['Other']?.properties).toEqual({ Value: ['2600:1f18::/56'] });

    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).toContain('falling back to cached value');
    expect(warned).not.toContain('REDACTION MASK');
  });

  it('--force does NOT emit that warning for an ordinary cached value (scope control)', async () => {
    // The discriminator: a fix that warned on every cache fallback would make
    // the assertion above pass while telling the user nothing specific.
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();
    const getAttribute = vi.fn(async () => {
      throw new Error('throttled');
    });
    const state = vpcIpv6State();

    await rewriteResourceReferences(state, ['Vpc'], fakeRegistry(getAttribute), { force: true });

    expect(getAttribute).toHaveBeenCalledTimes(1);
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    // The ordinary "falling back to cached value" warn still fires...
    expect(warned).toContain('falling back to cached value');
    // ...but not the dynamic-reference one.
    expect(warned).not.toContain('UNRESOLVED');
  });

  it('--force leaves the original intrinsic when both live and cache fail', async () => {
    const getAttribute = vi.fn(async () => {
      throw new Error('throttled');
    });
    const state = baseState({
      Bucket: {
        physicalId: 'b',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
    });

    const result = await rewriteResourceReferences(
      state,
      ['Bucket'],
      fakeRegistry(getAttribute),
      { force: true }
    );

    expect(result.unresolvable).toHaveLength(1);
    // Original intrinsic preserved verbatim.
    expect(result.state.resources['Other']?.properties).toEqual({
      Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
    });
  });

  it('memoizes provider.getAttribute calls per (orphan, attr)', async () => {
    const getAttribute = vi.fn(async () => 'arn:aws:s3:::b');
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      A: {
        physicalId: 'a',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
      B: {
        physicalId: 'b2',
        resourceType: 'AWS::Lambda::Function',
        properties: { Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
      },
    });

    await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(getAttribute));

    expect(getAttribute).toHaveBeenCalledTimes(1);
  });

  it('does NOT touch references to non-orphan resources', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      KeepThisRef: { physicalId: 'k', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::S3::Bucket',
        properties: {
          Drop: { Ref: 'Bucket' },
          Keep: { Ref: 'KeepThisRef' },
        },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    expect(result.state.resources['Other']?.properties).toEqual({
      Drop: 'b',
      Keep: { Ref: 'KeepThisRef' },
    });
  });

  it('rewrites references in outputs', async () => {
    const getAttribute = vi.fn(async () => 'arn');
    const state = baseState(
      {
        Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      },
      { BucketArn: { 'Fn::GetAtt': ['Bucket', 'Arn'] }, BucketName: { Ref: 'Bucket' } }
    );

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry(getAttribute));

    expect(result.state.outputs).toEqual({ BucketArn: 'arn', BucketName: 'b' });
  });

  it('preserves original input (does not mutate)', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::S3::Bucket',
        properties: { Name: { Ref: 'Bucket' } },
      },
    });
    const beforeJson = JSON.stringify(state);

    await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    expect(JSON.stringify(state)).toBe(beforeJson);
  });

  it('throws when an orphan logicalId does not exist in state', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
    });

    await expect(
      rewriteResourceReferences(state, ['DoesNotExist'], fakeRegistry())
    ).rejects.toThrow(/orphan 'DoesNotExist' not found/);
  });

  it('Fn::Sub collapses to a plain string when no placeholders remain', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::S3::Bucket',
        properties: { Url: { 'Fn::Sub': 'http://${Bucket}/path' } },
      },
    });

    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());

    expect(result.state.resources['Other']?.properties).toEqual({ Url: 'http://b/path' });
  });
});

/**
 * An ORPHANED record the rewrite cannot read (go-to-k/cdkd#3350). `cdkd orphan`
 * may drop such a record — its survivor-scoped refusals subtract the orphan
 * set precisely so this stays a way out — but it must not RESOLVE through one.
 */
describe('an orphaned record that is not a readable resource record', () => {
  function sibling(): StackState['resources'][string] {
    return {
      physicalId: 's',
      resourceType: 'AWS::Lambda::Function',
      properties: {
        Name: { Ref: 'Bucket' },
        Arn: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
        Url: { 'Fn::Sub': 'x-${Bucket}' },
      },
    };
  }

  // Measured before the guard: a string or number record made `{Ref}` resolve
  // to `undefined` (dropped from the saved JSON) and the `Fn::Sub` to the
  // literal `x-undefined`; the typeless object resolved `{Ref}` to its bare
  // `physicalId` with no type to route the CFn `Ref` value by.
  for (const [label, record] of [
    ['a string', 'abcdef'],
    ['a number', 5],
    ['null', null],
    ['an object with no resource type', { physicalId: 'x', properties: {} }],
    // Typed but with no usable physical id (review of go-to-k/cdkd#3568): the
    // entry predicate passes these, and `Ref` resolved to `undefined` /
    // `x-undefined` exactly as for a string record.
    ['a typed record with no physical id', { resourceType: 'AWS::S3::Bucket', properties: {} }],
    ['a typed record with a number physical id', { resourceType: 'AWS::S3::Bucket', physicalId: 5 }],
    ['a typed record with an empty physical id', { resourceType: 'AWS::S3::Bucket', physicalId: '' }],
    ['an S3Tables table with no physical id', { resourceType: 'AWS::S3Tables::Table', properties: {} }],
  ] as const) {
    for (const force of [false, true]) {
      it(`leaves every reference to ${label} in place${force ? ' under --force' : ''}`, async () => {
        const getAttribute = vi.fn(async () => 'live-arn');
        const state = baseState({
          Bucket: record as unknown as StackState['resources'][string],
          Other: sibling(),
        });
        const result = await rewriteResourceReferences(
          state,
          ['Bucket'],
          fakeRegistry(getAttribute),
          { force }
        );
        expect(result.state.resources['Other']?.properties).toEqual(sibling().properties);
        expect(result.rewrites).toEqual([]);
        // One site per intrinsic, each naming why — so a plain run aborts
        // listing them and `--force` says what it left.
        expect(result.unresolvable.map((u) => u.path).sort()).toEqual([
          'properties.Arn',
          'properties.Name',
          'properties.Url',
        ]);
        for (const u of result.unresolvable) {
          expect(u.reason).toContain('not a readable resource record');
        }
        // No live read was attempted through a record with no usable identity.
        expect(getAttribute).not.toHaveBeenCalled();
        expect(result.state.resources['Bucket']).toBeUndefined();
      });
    }
  }

  it('drops a NULL orphaned record nothing references, instead of an internal error', async () => {
    // The falsy presence test threw `orphan 'Bucket' not found` for an entry
    // that IS in the map, closing the per-resource way out of it.
    const state = baseState({
      Bucket: null as unknown as StackState['resources'][string],
      Other: { physicalId: 'o', resourceType: 'AWS::S3::Bucket', properties: {} },
    });
    const result = await rewriteResourceReferences(state, ['Bucket'], fakeRegistry());
    expect(Object.keys(result.state.resources)).toEqual(['Other']);
    expect(result.unresolvable).toEqual([]);
  });

  it('CONTROL: a readable orphaned record still resolves all three shapes', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: sibling(),
    });
    const result = await rewriteResourceReferences(
      state,
      ['Bucket'],
      fakeRegistry(vi.fn(async () => 'live-arn'))
    );
    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Other']?.properties).toEqual({
      Name: 'b',
      Arn: 'live-arn',
      Url: 'x-b',
    });
  });
});

/**
 * `--force`'s cache fallback over an orphan whose `attributes` map cannot be
 * read (go-to-k/cdkd#3345). The attribute NAME comes from the surviving
 * record's `Fn::GetAtt`, so indexing a list or a string answered for keys the
 * cache never held and spliced the answer into the sibling's saved properties.
 */
describe('--force over an unreadable state.attributes cache', () => {
  for (const [label, attributes] of [
    ['a list', ['v']],
    ['a string', 'abcdef'],
    ['null', null],
    ['a number', 5],
  ] as const) {
    it(`does not index ${label}, and leaves the intrinsic in place`, async () => {
      const getAttribute = vi.fn(async () => {
        throw new Error('live fetch failed');
      });
      const state = baseState({
        Bucket: {
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: attributes as unknown as Record<string, unknown>,
        },
        Other: {
          physicalId: 'o',
          resourceType: 'AWS::Lambda::Function',
          properties: {
            Zero: { 'Fn::GetAtt': ['Bucket', '0'] },
            Length: { 'Fn::GetAtt': ['Bucket', 'length'] },
          },
        },
      });
      const warn = vi.mocked(getLogger().warn);
      warn.mockClear();
      const result = await rewriteResourceReferences(
        state,
        ['Bucket'],
        fakeRegistry(getAttribute),
        { force: true }
      );
      expect(result.state.resources['Other']?.properties).toEqual({
        Zero: { 'Fn::GetAtt': ['Bucket', '0'] },
        Length: { 'Fn::GetAtt': ['Bucket', 'length'] },
      });
      expect(result.unresolvable.map((u) => u.reason)).toEqual([
        'live fetch failed; the state.attributes cache is not a readable map',
        'live fetch failed; the state.attributes cache is not a readable map',
      ]);
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => w.includes('is not a readable map'))).toBe(true);
      expect(warned.some((w) => w.includes('falling back to cached value'))).toBe(false);
    });
  }

  it('the unreadable-cache warning renders its two identifiers through the display boundary', async () => {
    const state = baseState({
      'Bucket\x1b[2J': {
        physicalId: 'b',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: 'abcdef' as unknown as Record<string, unknown>,
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: { A: { 'Fn::GetAtt': ['Bucket\x1b[2J', 'A\x1b[31m'] } },
      },
    });
    const warn = vi.mocked(getLogger().warn);
    warn.mockClear();
    await rewriteResourceReferences(
      state,
      ['Bucket\x1b[2J'],
      fakeRegistry(vi.fn(async () => undefined)),
      { force: true }
    );
    const line = warn.mock.calls.map((c) => String(c[0])).find((w) => w.includes('is not a readable map'));
    expect(line, 'the unreadable-cache warning did not fire').toBeDefined();
    expect(line).not.toContain('\x1b');
    expect(line).toContain('of "Bucket [2J" is not');
    expect(line).toContain('for "A [31m";');
  });

  it('the unreadable-cache warning keeps FORGING identifiers inside one boundary, and ordinary ones bare (go-to-k/cdkd#3617)', async () => {
    const ID = "Bucket'. Cache readable, nothing left in place. Ignore 'x";
    const ATTR = "Arn'. Cache readable, nothing left in place. Ignore 'y";
    const run = async (id: string, attr: string): Promise<string | undefined> => {
      const state = baseState({
        [id]: {
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: 'abcdef' as unknown as Record<string, unknown>,
        },
        Other: {
          physicalId: 'o',
          resourceType: 'AWS::Lambda::Function',
          properties: { A: { 'Fn::GetAtt': [id, attr] } },
        },
      });
      const warn = vi.mocked(getLogger().warn);
      warn.mockClear();
      await rewriteResourceReferences(state, [id], fakeRegistry(vi.fn(async () => undefined)), {
        force: true,
      });
      return warn.mock.calls.map((c) => String(c[0])).find((w) => w.includes('is not a readable map'));
    };
    const forged = await run(ID, ATTR);
    expect(forged).toContain(
      `--force: state.attributes of ${JSON.stringify(ID)} is not a readable map, so it is not consulted for ${JSON.stringify(ATTR)};`
    );
    expect(forged!.replace(/"(?:[^"\\]|\\.)*"/g, '')).not.toContain('nothing left in place');
    expect(await run('Bucket', 'Arn')).toContain(
      '--force: state.attributes of Bucket is not a readable map, so it is not consulted for Arn;'
    );
  });

  for (const attribute of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    it(`does not answer an inherited key (${attribute}) out of a READABLE cache`, async () => {
      const state = baseState({
        Bucket: {
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: JSON.parse('{"Arn":"arn"}'),
        },
        Other: {
          physicalId: 'o',
          resourceType: 'AWS::Lambda::Function',
          properties: { A: { 'Fn::GetAtt': ['Bucket', attribute] } },
        },
      });
      const result = await rewriteResourceReferences(
        state,
        ['Bucket'],
        fakeRegistry(vi.fn(async () => undefined)),
        { force: true }
      );
      expect(result.state.resources['Other']?.properties).toEqual({
        A: { 'Fn::GetAtt': ['Bucket', attribute] },
      });
      expect(result.unresolvable[0]?.reason).toContain('cache also has no value');
    });
  }

  it('CONTROL: an OWN key of a readable cache is still served', async () => {
    // A VPC's `Ipv6CidrBlocks` is declined by the recorded-first read
    // (go-to-k/cdkd#4186), so this reaches the fallback's own-key read.
    const getAttribute = vi.fn(async () => undefined);
    const state = baseState({
      Vpc: {
        physicalId: 'vpc-1',
        resourceType: 'AWS::EC2::VPC',
        properties: {},
        attributes: { Ipv6CidrBlocks: ['2600:1f18::/56'] },
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: { A: { 'Fn::GetAtt': ['Vpc', 'Ipv6CidrBlocks'] } },
      },
    });
    const result = await rewriteResourceReferences(state, ['Vpc'], fakeRegistry(getAttribute), {
      force: true,
    });
    expect(getAttribute).toHaveBeenCalledTimes(1);
    expect(result.state.resources['Other']?.properties).toEqual({ A: ['2600:1f18::/56'] });
  });

  it('CONTROL: an absent cache still reads as holding nothing, with its own warning', async () => {
    const state = baseState({
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: { Zero: { 'Fn::GetAtt': ['Bucket', '0'] } },
      },
    });
    const result = await rewriteResourceReferences(
      state,
      ['Bucket'],
      fakeRegistry(vi.fn(async () => undefined)),
      { force: true }
    );
    expect(result.unresolvable[0]?.reason).toContain('cache also has no value');
  });
});

/**
 * RECORDED OVER A LIVE ANSWER (go-to-k/cdkd#4186). The live read is addressed
 * by the recorded NAME, so after the resource was deleted out of band and
 * another one took the name it answers for the NEWCOMER. Once it answers, the
 * recorded value replaces that answer wherever the resolver would serve it; a
 * live read that fails or answers nothing keeps its pre-#4186 outcome.
 */
describe('a recorded attribute replaces a live answer (#4186)', () => {
  const FOREIGN = 'arn:aws:kms:us-east-1:123456789012:key/foreign-key';
  const RECORDED = 'arn:aws:kms:us-east-1:123456789012:key/recorded-key';

  function repoState(
    attributes: Record<string, unknown> | undefined,
    attribute = 'KmsKeyId',
    resourceType = 'AWS::CodeCommit::Repository'
  ): StackState {
    return baseState({
      Repo: {
        physicalId: 'my-repo',
        resourceType,
        properties: {},
        ...(attributes !== undefined && { attributes }),
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::Lambda::Function',
        properties: {
          Array: { 'Fn::GetAtt': ['Repo', attribute] },
          String: { 'Fn::GetAtt': `Repo.${attribute}` },
          Sub: { 'Fn::Sub': `k=\${Repo.${attribute}}` },
        },
      },
    });
  }

  it('takes the recorded value over a DIFFERENT live one, in all three shapes', async () => {
    const getAttribute = vi.fn(async () => FOREIGN);
    const result = await rewriteResourceReferences(
      repoState({ KmsKeyId: RECORDED }),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Other']?.properties).toEqual({
      Array: RECORDED,
      String: RECORDED,
      Sub: `k=${RECORDED}`,
    });
    expect(getAttribute).toHaveBeenCalledTimes(1);
    expect(result.rewrites.filter((r) => r.kind === 'getAtt').map((r) => r.after)).toEqual([
      RECORDED,
      RECORDED,
    ]);
  });

  it('CONTROL: an attribute the record lacks is still read live', async () => {
    const getAttribute = vi.fn(async () => FOREIGN);
    const result = await rewriteResourceReferences(
      repoState({ Arn: 'arn:aws:codecommit:us-east-1:123456789012:my-repo' }),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect(result.state.resources['Other']?.properties).toEqual({
      Array: FOREIGN,
      String: FOREIGN,
      Sub: `k=${FOREIGN}`,
    });
    // Memoized: one live read serves all three sites.
    expect(getAttribute).toHaveBeenCalledTimes(1);
    expect(getAttribute).toHaveBeenCalledWith(
      'my-repo',
      'AWS::CodeCommit::Repository',
      'KmsKeyId',
      'Repo'
    );
  });

  it('CONTROL: a record with no attributes map is still read live', async () => {
    const getAttribute = vi.fn(async () => FOREIGN);
    const result = await rewriteResourceReferences(
      repoState(undefined),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(FOREIGN);
  });

  it('takes a recorded null as the resolver does, over a live value', async () => {
    const getAttribute = vi.fn(async () => FOREIGN);
    const result = await rewriteResourceReferences(
      repoState({ KmsKeyId: null }),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBeNull();
    expect(getAttribute).toHaveBeenCalledTimes(1);
  });

  for (const [label, masked] of [
    ['the mask itself', SECRET_MASK],
    ['a list holding the mask', ['a', SECRET_MASK]],
    ['an object holding the mask', { Inner: SECRET_MASK }],
  ] as const) {
    it(`never writes ${label} into a sibling on the default path; reads live instead`, async () => {
      const getAttribute = vi.fn(async () => 'live-value');
      const result = await rewriteResourceReferences(
        repoState({ KmsKeyId: masked }),
        ['Repo'],
        fakeRegistry(getAttribute)
      );
      expect(result.state.resources['Other']?.properties).toEqual({
        Array: 'live-value',
        String: 'live-value',
        Sub: 'k=live-value',
      });
      expect(JSON.stringify(result.state)).not.toContain(SECRET_MASK);
    });
  }

  it('a masked recorded value with a FAILED live read stays unresolvable without --force', async () => {
    const getAttribute = vi.fn(async () => {
      throw new Error('RepositoryDoesNotExistException');
    });
    const state = repoState({ KmsKeyId: SECRET_MASK });
    const result = await rewriteResourceReferences(state, ['Repo'], fakeRegistry(getAttribute));
    expect(result.state.resources['Other']?.properties).toEqual(
      state.resources['Other']?.properties
    );
    expect(result.unresolvable).toHaveLength(3);
    expect(JSON.stringify(result.state.resources['Other'])).not.toContain(SECRET_MASK);
  });

  it('reads live past a recorded {{resolve:...}} reference (issue #2055)', async () => {
    const TOKEN = '{{resolve:secretsmanager:prod/db:SecretString:password::}}';
    const getAttribute = vi.fn(async () => 'live-value');
    const result = await rewriteResourceReferences(
      repoState({ 'Outputs.Pw': TOKEN }, 'Outputs.Pw', 'AWS::CloudFormation::Stack'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(
      'live-value'
    );
    expect(JSON.stringify(result.state)).not.toContain('{{resolve:');
  });

  it('reads live past a pre-#1681 placeholder ARN, and serves a real recorded ARN', async () => {
    const PLACEHOLDER = 'arn:aws:appsync:*:*:apis/abc/apikeys/k';
    const REAL = 'arn:aws:appsync:us-east-1:123456789012:apis/abc/apikeys/k';
    const getAttribute = vi.fn(async () => REAL);
    const stale = await rewriteResourceReferences(
      repoState({ Arn: PLACEHOLDER }, 'Arn', 'AWS::AppSync::ApiKey'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((stale.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(REAL);
    expect(getAttribute).toHaveBeenCalledTimes(1);

    getAttribute.mockClear();
    const recorded = 'arn:aws:appsync:us-east-1:123456789012:apis/abc/apikeys/recorded';
    const fresh = await rewriteResourceReferences(
      repoState({ Arn: recorded }, 'Arn', 'AWS::AppSync::ApiKey'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((fresh.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(recorded);
    expect(getAttribute).toHaveBeenCalledTimes(1);
  });

  it("reads live past a legacy '' security-group VpcId (#3097)", async () => {
    const getAttribute = vi.fn(async () => 'vpc-live');
    const result = await rewriteResourceReferences(
      repoState({ VpcId: '' }, 'VpcId', 'AWS::EC2::SecurityGroup'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(
      'vpc-live'
    );
  });

  it("reads a VPC's Ipv6CidrBlocks live even when recorded, as the resolver does", async () => {
    const getAttribute = vi.fn(async () => ['2600:1f18::/56']);
    const result = await rewriteResourceReferences(
      repoState({ Ipv6CidrBlocks: [] }, 'Ipv6CidrBlocks', 'AWS::EC2::VPC'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toEqual([
      '2600:1f18::/56',
    ]);
  });

  it('splits a legacy comma-joined Route 53 NameServers string into the list', async () => {
    const getAttribute = vi.fn(async () => ['ns-foreign']);
    const result = await rewriteResourceReferences(
      repoState({ NameServers: 'ns-1,ns-2' }, 'NameServers', 'AWS::Route53::HostedZone'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toEqual([
      'ns-1',
      'ns-2',
    ]);
    expect(getAttribute).toHaveBeenCalled();
  });

  it('serves a dotted attribute from a flat key, then from a nested object (issue #381)', async () => {
    const getAttribute = vi.fn(async () => 'live-port');
    const flat = await rewriteResourceReferences(
      repoState({ 'Endpoint.Port': '5432', Endpoint: { Port: '3306' } }, 'Endpoint.Port', 'AWS::RDS::DBCluster'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((flat.state.resources['Other']?.properties as { Array: unknown }).Array).toBe('5432');
    const nested = await rewriteResourceReferences(
      repoState({ Endpoint: { Port: '3306' } }, 'Endpoint.Port', 'AWS::RDS::DBCluster'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((nested.state.resources['Other']?.properties as { Array: unknown }).Array).toBe('3306');
    expect(getAttribute).toHaveBeenCalled();
  });

  it('does not walk an INHERITED key of a nested attribute object', async () => {
    const getAttribute = vi.fn(async () => 'live-value');
    const result = await rewriteResourceReferences(
      repoState({ Endpoint: { Port: '3306' } }, 'Endpoint.constructor', 'AWS::RDS::DBCluster'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(
      'live-value'
    );
    expect(getAttribute).toHaveBeenCalledTimes(1);
  });

  it('does not serve a masked leaf through the nested walk', async () => {
    const getAttribute = vi.fn(async () => 'live-value');
    const result = await rewriteResourceReferences(
      repoState({ Endpoint: { Password: SECRET_MASK } }, 'Endpoint.Password', 'AWS::RDS::DBCluster'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(
      'live-value'
    );
  });

  // GATED ON A LIVE ANSWER (security review of go-to-k/cdkd#4189): a record
  // whose provider cannot answer keeps its pre-#4186 outcome, so the recorded
  // read never prints what the live-read-only path could not.
  it('does NOT serve a recorded value where the provider has no getAttribute or none routes', async () => {
    const noGetAttribute = await rewriteResourceReferences(
      repoState({ KmsKeyId: RECORDED }),
      ['Repo'],
      fakeRegistry()
    );
    expect(noGetAttribute.unresolvable).toHaveLength(3);
    expect(JSON.stringify(noGetAttribute.rewrites)).not.toContain(RECORDED);
    const throwing = {
      getProviderFor: vi.fn(() => {
        throw new Error('no provider');
      }),
    } as unknown as ProviderRegistry;
    const noProvider = await rewriteResourceReferences(
      repoState({ KmsKeyId: RECORDED }),
      ['Repo'],
      throwing
    );
    expect(noProvider.unresolvable).toHaveLength(3);
    expect(JSON.stringify(noProvider.rewrites)).not.toContain(RECORDED);
  });

  it('does not serve a Cloud-Control-routed record, whose attributes are the whole model', async () => {
    // `CloudControlProvider` implements no `getAttribute`, and its record can
    // hold a credential no name rule sees (`TokenValue`).
    const state = baseState({
      Tok: {
        physicalId: 'tok-1',
        resourceType: 'AWS::EC2::IpamExternalResourceVerificationToken',
        properties: {},
        attributes: { TokenValue: 'plaintext-token-value' },
        provisionedBy: 'cc-api',
      },
      Other: {
        physicalId: 'o',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { 'Fn::GetAtt': ['Tok', 'TokenValue'] } },
      },
    });
    const result = await rewriteResourceReferences(state, ['Tok'], fakeRegistry());
    expect(JSON.stringify(result.rewrites)).not.toContain('plaintext-token-value');
    expect(JSON.stringify(result.state.resources['Other'])).not.toContain('plaintext-token-value');
    expect(result.unresolvable).toHaveLength(1);
  });

  it('does not serve a recorded value when the live read THROWS, and leaves the intrinsic', async () => {
    const state = repoState({ KmsKeyId: RECORDED });
    const result = await rewriteResourceReferences(
      state,
      ['Repo'],
      fakeRegistry(
        vi.fn(async () => {
          throw new Error('AccessDenied');
        })
      )
    );
    expect(result.unresolvable).toHaveLength(3);
    expect(JSON.stringify(result.rewrites)).not.toContain(RECORDED);
    expect(result.state.resources['Other']?.properties).toEqual(state.resources['Other']?.properties);
  });

  it('does not serve a recorded value when the live read answers undefined (a plain out-of-band delete)', async () => {
    const result = await rewriteResourceReferences(
      repoState({ KmsKeyId: RECORDED }),
      ['Repo'],
      fakeRegistry(vi.fn(async () => undefined))
    );
    expect(result.unresolvable).toHaveLength(3);
    expect(JSON.stringify(result.rewrites)).not.toContain(RECORDED);
  });

  it("serves an empty legacy NameServers string as [], the resolver's shape", async () => {
    const result = await rewriteResourceReferences(
      repoState({ NameServers: '' }, 'NameServers', 'AWS::Route53::HostedZone'),
      ['Repo'],
      fakeRegistry(vi.fn(async () => ['ns-foreign']))
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toEqual([]);
  });

  it('reads live when a nested walk meets a null, instead of throwing', async () => {
    const getAttribute = vi.fn(async () => 'live-port');
    const result = await rewriteResourceReferences(
      repoState({ Endpoint: null }, 'Endpoint.Port', 'AWS::RDS::DBCluster'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(
      'live-port'
    );
  });

  // A recorded value that may be a SECRET PLAINTEXT is never substituted on
  // the default path: the audit table prints every substituted value.
  it('does not serve a credential-named attribute (IAM AccessKey SecretAccessKey)', async () => {
    const SECRET = 'PLAINTEXT-SECRET-ACCESS-KEY';
    // A provider that DID answer (the real one refuses): the name rule alone
    // must withhold the record, and the live answer decides as before #4186.
    const getAttribute = vi.fn(async () => 'live-answer');
    const result = await rewriteResourceReferences(
      repoState({ SecretAccessKey: SECRET }, 'SecretAccessKey', 'AWS::IAM::AccessKey'),
      ['Repo'],
      fakeRegistry(getAttribute)
    );
    expect(JSON.stringify(result.rewrites)).not.toContain(SECRET);
    expect(JSON.stringify(result.state.resources['Other'])).not.toContain(SECRET);
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(
      'live-answer'
    );
  });

  it('CONTROL: a credential-looking name ending in an identifier suffix IS served', async () => {
    const ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:s-AbCdEf';
    const result = await rewriteResourceReferences(
      repoState({ 'MasterUserSecret.SecretArn': ARN }, 'MasterUserSecret.SecretArn', 'AWS::RDS::DBInstance'),
      ['Repo'],
      fakeRegistry(vi.fn(async () => 'live'))
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(ARN);
  });

  for (const type of ['AWS::CloudFormation::CustomResource', 'Custom::Thing']) {
    it(`does not serve a recorded custom-resource value (${type})`, async () => {
      const PLAIN = 'legacy-noecho-plaintext';
      // A provider that DID answer: the type rule alone must withhold it.
      const result = await rewriteResourceReferences(
        repoState({ Token: PLAIN }, 'Token', type),
        ['Repo'],
        fakeRegistry(vi.fn(async () => 'live-answer'))
      );
      expect(JSON.stringify(result.rewrites)).not.toContain(PLAIN);
      expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(
        'live-answer'
      );
    });
  }

  it("does not serve an AppSync API key's ApiKey, the x-api-key value itself", async () => {
    const KEY = 'da2-plaintextapikeyvalue123';
    // A provider that DID answer: the table alone must withhold the record.
    const result = await rewriteResourceReferences(
      repoState({ ApiKey: KEY, Arn: 'arn:aws:appsync:us-east-1:1:apis/a/apikey/k' }, 'ApiKey', 'AWS::AppSync::ApiKey'),
      ['Repo'],
      fakeRegistry(vi.fn(async () => 'live-answer'))
    );
    expect(JSON.stringify(result.rewrites)).not.toContain(KEY);
    expect(JSON.stringify(result.state.resources['Other'])).not.toContain(KEY);
    // CONTROL: with a live answer, the same record's Arn is served. (The
    // real AppSync provider answers nothing, so this isolates the table.)
    const arn = await rewriteResourceReferences(
      repoState({ ApiKey: KEY, Arn: 'arn:aws:appsync:us-east-1:1:apis/a/apikey/k' }, 'Arn', 'AWS::AppSync::ApiKey'),
      ['Repo'],
      fakeRegistry(vi.fn(async () => 'live-arn'))
    );
    expect((arn.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(
      'arn:aws:appsync:us-east-1:1:apis/a/apikey/k'
    );
  });

  for (const [label, value] of [
    ['a top-level Password leaf', { Host: 'h', Password: 'pw-plaintext-1' }],
    ['a nested credential leaf', { Conn: [{ Credentials: 'pw-plaintext-1' }] }],
  ] as const) {
    it(`does not serve an innocently named object holding ${label}; reads live instead`, async () => {
      const getAttribute = vi.fn(async () => 'live-value');
      const result = await rewriteResourceReferences(
        repoState({ Endpoint: value }, 'Endpoint', 'AWS::RDS::DBCluster'),
        ['Repo'],
        fakeRegistry(getAttribute)
      );
      expect(JSON.stringify(result.rewrites)).not.toContain('pw-plaintext-1');
      expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(
        'live-value'
      );
    });
  }

  it('CONTROL: an object whose keys are identifiers only is served whole', async () => {
    const value = { Address: 'db.example', Port: '5432', SecretArn: 'arn:s' };
    const result = await rewriteResourceReferences(
      repoState({ Endpoint: value }, 'Endpoint', 'AWS::RDS::DBCluster'),
      ['Repo'],
      fakeRegistry(vi.fn(async () => 'live-value'))
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toEqual(value);
  });

  it('does not answer an INHERITED flat key from the record, even when the live read answers', async () => {
    const result = await rewriteResourceReferences(
      repoState(JSON.parse('{"Arn":"arn"}'), 'constructor'),
      ['Repo'],
      fakeRegistry(vi.fn(async () => 'live-value'))
    );
    expect((result.state.resources['Other']?.properties as { Array: unknown }).Array).toBe(
      'live-value'
    );
  });
});
