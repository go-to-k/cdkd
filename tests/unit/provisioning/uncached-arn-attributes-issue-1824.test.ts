import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #1824 — `AWS::RDS::DBSubnetGroup.DBSubnetGroupArn` and
 * `AWS::SSM::Parameter.Arn` were read-only ARN attributes AWS added to the CFn
 * schemas after the 2026-05-16 fixture capture, and neither provider recorded
 * them under their CFn name.
 *
 * WHY THIS TEST GOES THROUGH THE RESOLVER RATHER THAN ASSERTING THE ATTRIBUTE
 * MAP. The defect is not "the map lacks a key" in the abstract — it is that an
 * output / cross-resource `Fn::GetAtt` reads the CACHED
 * `resource.attributes[<CFnName>]` in
 * `IntrinsicFunctionResolver.constructAttribute`, which never calls a provider's
 * `getAttribute`, and for an `*Arn` name the resolver's shape guard HARD-FAILS
 * against a name-shaped physicalId instead of degrading. Both physicalIds here
 * ARE names (a subnet-group name, a parameter name), so an uncached ARN fails
 * the deploy. Wiring the provider's real create/update result into the resolver
 * is what pins the END-TO-END behavior a user sees.
 *
 * BINDING PROOF (how these were confirmed to fail WITHOUT the fix). With the
 * `DBSubnetGroupArn` / `Arn` spreads reverted in the two providers, each
 * `resolves` test below fails with the resolver's own guard message —
 * `Cannot resolve Fn::GetAtt [...] ... is not an ARN (arn:...)` — rather than
 * with an assertion diff, which is exactly the pre-fix deploy failure. The
 * `hard-fails when the ARN is NOT cached` cases in each block pin that guard
 * from the other side, so the suite cannot go vacuously green if the guard
 * itself is ever relaxed.
 */

// `mockStsSend` MUST be hoisted rather than created inside the `getAwsClients`
// factory: that factory returns a FRESH object per call, so a `vi.fn()` written
// inline would be a different instance on every `getAccountInfo` invocation and
// a per-test `mockRejectedValueOnce` would prime an instance nothing reads.
const { mockRdsSend, mockSsmSend, mockStsSend, ssmRegion } = vi.hoisted(() => ({
  mockRdsSend: vi.fn(),
  mockSsmSend: vi.fn(),
  mockStsSend: vi.fn(),
  // MUTABLE region box for the SSM client. The partition / region-canonicalization
  // cases need a NON-commercial and an UPPER-CASED region, and the provider
  // captures `config.region` in its constructor off the mocked `getAwsClients`,
  // so the value has to be swappable per test rather than baked into the factory.
  // A box (not a bare string) because `vi.hoisted`'s return is destructured once.
  ssmRegion: { value: 'us-east-1' },
}));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockRdsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSsmSend, config: { region: () => Promise.resolve(ssmRegion.value) } },
    // `getAccountInfo` resolves the account through STS; the SSM provider's
    // constructed ARN needs a NON-fabricated answer (a response carrying no
    // `Account` is flagged `fabricated` and the provider then refuses).
    sts: { send: mockStsSend },
    ec2: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * Build the resolver context a stack Output sees: the resource's real
 * physicalId plus the attribute map the provider just returned.
 */
const mkContext = (
  logicalId: string,
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown>
): ResolverContext => {
  const template: CloudFormationTemplate = {
    Resources: { [logicalId]: { Type: resourceType, Properties: {} } },
  };
  return {
    template,
    resources: {
      [logicalId]: { physicalId, resourceType, properties: {}, attributes, dependencies: [] },
    },
  };
};

describe('issue #1824 — uncached ARN attributes resolve through Fn::GetAtt', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    // Drain any `*Once` queue so a primer can never leak into a later test.
    mockRdsSend.mockReset();
    mockSsmSend.mockReset();
    mockStsSend.mockReset();
    // Re-seed the default (non-fabricated) STS answer after the reset; the
    // fabricated-account test overrides it with a rejection of its own.
    mockStsSend.mockResolvedValue({
      Account: '111122223333',
      Arn: 'arn:aws:iam::111122223333:user/test',
    });
    resetAccountInfoCache();
    // Back to the commercial default; the partition / case cases below opt out.
    ssmRegion.value = 'us-east-1';
    resolver = new IntrinsicFunctionResolver();
  });

  describe('AWS::RDS::DBSubnetGroup.DBSubnetGroupArn', () => {
    const TYPE = 'AWS::RDS::DBSubnetGroup';
    const ARN = 'arn:aws:rds:us-east-1:111122223333:subgrp:my-subnet-group';

    it('create records the ARN read off the CreateDBSubnetGroup response', async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBSubnetGroup: { DBSubnetGroupName: 'my-subnet-group', DBSubnetGroupArn: ARN },
      });

      const result = await new RDSProvider().create('SubnetGroup', TYPE, {
        DBSubnetGroupName: 'my-subnet-group',
        DBSubnetGroupDescription: 'test',
        SubnetIds: ['subnet-aaa', 'subnet-bbb'],
      });

      expect(result.attributes).toEqual({
        DBSubnetGroupName: 'my-subnet-group',
        DBSubnetGroupArn: ARN,
      });
      // No extra AWS call: the ARN comes from the create response itself.
      expect(mockRdsSend).toHaveBeenCalledTimes(1);
    });

    it('resolves Fn::GetAtt DBSubnetGroupArn after create, without reaching the shape guard', async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBSubnetGroup: { DBSubnetGroupName: 'my-subnet-group', DBSubnetGroupArn: ARN },
      });
      const result = await new RDSProvider().create('SubnetGroup', TYPE, {
        DBSubnetGroupName: 'my-subnet-group',
        SubnetIds: ['subnet-aaa', 'subnet-bbb'],
      });

      const context = mkContext('SubnetGroup', TYPE, result.physicalId, result.attributes ?? {});
      await expect(
        resolver.resolve({ 'Fn::GetAtt': ['SubnetGroup', 'DBSubnetGroupArn'] }, context)
      ).resolves.toBe(ARN);
    });

    it('update re-reports the ARN, so its attributes do not WIPE the create-time value', async () => {
      // ModifyDBSubnetGroup, then the DescribeDBSubnetGroups the tag diff needs.
      mockRdsSend.mockResolvedValueOnce({});
      mockRdsSend.mockResolvedValueOnce({
        DBSubnetGroups: [{ DBSubnetGroupName: 'my-subnet-group', DBSubnetGroupArn: ARN }],
      });

      const result = await new RDSProvider().update(
        'SubnetGroup',
        'my-subnet-group',
        TYPE,
        { DBSubnetGroupDescription: 'updated', SubnetIds: ['subnet-aaa', 'subnet-bbb'] },
        { DBSubnetGroupDescription: 'test', SubnetIds: ['subnet-aaa', 'subnet-bbb'] }
      );

      expect(result.attributes).toEqual({
        DBSubnetGroupName: 'my-subnet-group',
        DBSubnetGroupArn: ARN,
      });

      const context = mkContext('SubnetGroup', TYPE, result.physicalId, result.attributes ?? {});
      await expect(
        resolver.resolve({ 'Fn::GetAtt': ['SubnetGroup', 'DBSubnetGroupArn'] }, context)
      ).resolves.toBe(ARN);
    });

    it('hard-fails when the ARN is NOT cached (the pre-fix behavior this closes)', async () => {
      const context = mkContext('SubnetGroup', TYPE, 'my-subnet-group', {
        DBSubnetGroupName: 'my-subnet-group',
      });
      await expect(
        resolver.resolve({ 'Fn::GetAtt': ['SubnetGroup', 'DBSubnetGroupArn'] }, context)
      ).rejects.toThrow(/is not an ARN \(arn:\.\.\.\)/);
    });

    it('omits the key rather than writing undefined when AWS reports no ARN', async () => {
      mockRdsSend.mockResolvedValueOnce({});
      const result = await new RDSProvider().create('SubnetGroup', TYPE, {
        DBSubnetGroupName: 'my-subnet-group',
        SubnetIds: ['subnet-aaa', 'subnet-bbb'],
      });
      expect(result.attributes).toEqual({ DBSubnetGroupName: 'my-subnet-group' });
      expect(Object.keys(result.attributes ?? {})).not.toContain('DBSubnetGroupArn');
    });

    // The "omit the key, never write `undefined`" arm was covered for CREATE
    // only, and a probe showed why that is not enough: making the write
    // UNCONDITIONAL at the update site (`rds-provider.ts`'s
    // `DBSubnetGroupArn: arn`) left every test in this file passing. The two
    // shapes below are the two ways `DescribeDBSubnetGroups` can fail to report
    // an ARN, and each asserts the REGRESSION shape (a present key holding
    // `undefined`) rather than only the value.
    it('update omits the key when DescribeDBSubnetGroups reports no ARN', async () => {
      mockRdsSend.mockResolvedValueOnce({}); // ModifyDBSubnetGroup
      mockRdsSend.mockResolvedValueOnce({
        DBSubnetGroups: [{ DBSubnetGroupName: 'my-subnet-group' }], // no DBSubnetGroupArn
      });

      const result = await new RDSProvider().update(
        'SubnetGroup',
        'my-subnet-group',
        TYPE,
        { DBSubnetGroupDescription: 'updated', SubnetIds: ['subnet-aaa', 'subnet-bbb'] },
        { DBSubnetGroupDescription: 'test', SubnetIds: ['subnet-aaa', 'subnet-bbb'] }
      );

      expect(result.attributes).toEqual({ DBSubnetGroupName: 'my-subnet-group' });
      // A present-but-`undefined` key survives `structuredClone` into the state
      // record, so every `Object.keys` consumer would see a key carrying nothing.
      expect(Object.keys(result.attributes ?? {})).not.toContain('DBSubnetGroupArn');
    });

    it('update omits the key when DescribeDBSubnetGroups returns an EMPTY group list', async () => {
      mockRdsSend.mockResolvedValueOnce({}); // ModifyDBSubnetGroup
      mockRdsSend.mockResolvedValueOnce({ DBSubnetGroups: [] });

      const result = await new RDSProvider().update(
        'SubnetGroup',
        'my-subnet-group',
        TYPE,
        { DBSubnetGroupDescription: 'updated', SubnetIds: ['subnet-aaa', 'subnet-bbb'] },
        { DBSubnetGroupDescription: 'test', SubnetIds: ['subnet-aaa', 'subnet-bbb'] }
      );

      expect(result.attributes).toEqual({ DBSubnetGroupName: 'my-subnet-group' });
      expect(Object.keys(result.attributes ?? {})).not.toContain('DBSubnetGroupArn');
    });

    it('import omits the key when the verification Describe reports no ARN', async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBSubnetGroups: [{ DBSubnetGroupName: 'adopted-group' }], // no DBSubnetGroupArn
      });

      const result = await new RDSProvider().import({
        logicalId: 'SubnetGroup',
        resourceType: TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { DBSubnetGroupName: 'adopted-group' },
      });

      // The resource IS adopted — a missing ATTRIBUTE must never turn the import
      // into a not-found (`null`), which would leave the resource unmanaged.
      expect(result).toEqual({ physicalId: 'adopted-group', attributes: {} });
      expect(Object.keys(result?.attributes ?? {})).not.toContain('DBSubnetGroupArn');
    });

    it('records the ARN on the import path, read off the verification Describe', async () => {
      // Same reasoning as the SSM import case: the state record an import writes
      // is what a later Fn::GetAtt reads, and the existence check already
      // reports the ARN, so no construction and no extra call are needed.
      mockRdsSend.mockResolvedValueOnce({
        DBSubnetGroups: [{ DBSubnetGroupName: 'adopted-group', DBSubnetGroupArn: ARN }],
      });

      const result = await new RDSProvider().import({
        logicalId: 'SubnetGroup',
        resourceType: TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { DBSubnetGroupName: 'adopted-group' },
      });

      expect(result).toEqual({ physicalId: 'adopted-group', attributes: { DBSubnetGroupArn: ARN } });
      expect(mockRdsSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('AWS::SSM::Parameter.Arn', () => {
    const TYPE = 'AWS::SSM::Parameter';
    const ARN = 'arn:aws:ssm:us-east-1:111122223333:parameter/foo/bar';

    it('create records a constructed ARN (PutParameter reports none)', async () => {
      mockSsmSend.mockResolvedValueOnce({ Version: 1, Tier: 'Standard' }); // PutParameter

      const result = await new SSMParameterProvider().create('MyParam', TYPE, {
        Name: '/foo/bar',
        Type: 'String',
        Value: 'baz',
      });

      expect(result.attributes).toEqual({ Type: 'String', Value: 'baz', Arn: ARN });
      // The ARN costs NO extra SSM call — that is the whole reason it is
      // constructed rather than read back via GetParameter.
      expect(mockSsmSend).toHaveBeenCalledTimes(1);
    });

    it('resolves Fn::GetAtt Arn after create, without reaching the shape guard', async () => {
      mockSsmSend.mockResolvedValueOnce({ Version: 1 });
      const result = await new SSMParameterProvider().create('MyParam', TYPE, {
        Name: '/foo/bar',
        Type: 'String',
        Value: 'baz',
      });

      const context = mkContext('MyParam', TYPE, result.physicalId, result.attributes ?? {});
      await expect(
        resolver.resolve({ 'Fn::GetAtt': ['MyParam', 'Arn'] }, context)
      ).resolves.toBe(ARN);
    });

    it('update re-reports the ARN, so its attributes do not WIPE the create-time value', async () => {
      mockSsmSend.mockResolvedValueOnce({ Version: 2 }); // PutParameter (Overwrite)

      const result = await new SSMParameterProvider().update(
        'MyParam',
        '/foo/bar',
        TYPE,
        { Name: '/foo/bar', Type: 'String', Value: 'new' },
        { Name: '/foo/bar', Type: 'String', Value: 'baz' }
      );

      expect(result.attributes).toEqual({ Type: 'String', Value: 'new', Arn: ARN });

      const context = mkContext('MyParam', TYPE, result.physicalId, result.attributes ?? {});
      await expect(
        resolver.resolve({ 'Fn::GetAtt': ['MyParam', 'Arn'] }, context)
      ).resolves.toBe(ARN);
    });

    it('hard-fails when the ARN is NOT cached (the pre-fix behavior this closes)', async () => {
      const context = mkContext('MyParam', TYPE, '/foo/bar', {
        Type: 'String',
        Value: 'baz',
      });
      await expect(
        resolver.resolve({ 'Fn::GetAtt': ['MyParam', 'Arn'] }, context)
      ).rejects.toThrow(/is not an ARN \(arn:\.\.\.\)/);
    });

    it('folds a hierarchical leading slash into the ARN separator', async () => {
      mockSsmSend.mockResolvedValueOnce({});
      const result = await new SSMParameterProvider().create('MyParam', TYPE, {
        Name: '/deep/nested/param',
        Type: 'String',
        Value: 'v',
      });
      // NOT `...:parameter//deep/nested/param` — `/` IS the separator.
      expect(result.attributes?.['Arn']).toBe(
        'arn:aws:ssm:us-east-1:111122223333:parameter/deep/nested/param'
      );
    });

    it('appends a FLAT name (legal in SSM) with no leading slash to fold', async () => {
      mockSsmSend.mockResolvedValueOnce({});
      const result = await new SSMParameterProvider().create('MyParam', TYPE, {
        Name: 'flatname',
        Type: 'String',
        Value: 'v',
      });
      expect(result.attributes?.['Arn']).toBe(
        'arn:aws:ssm:us-east-1:111122223333:parameter/flatname'
      );
    });

    it('records the ARN on the import path, read off the verification GetParameter', async () => {
      // The import path needs no construction: the existence check ALREADY
      // reports the authoritative ARN, so prefer the value AWS holds.
      const awsArn = 'arn:aws:ssm:us-east-1:111122223333:parameter/adopted';
      mockSsmSend.mockResolvedValueOnce({ Parameter: { Name: '/adopted', ARN: awsArn } });

      const result = await new SSMParameterProvider().import({
        logicalId: 'MyParam',
        resourceType: TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { Name: '/adopted' },
      });

      expect(result).toEqual({ physicalId: '/adopted', attributes: { Arn: awsArn } });
      expect(mockSsmSend).toHaveBeenCalledTimes(1);
    });

    it('import omits the key when GetParameter reports no ARN', async () => {
      // Same "omit, never write `undefined`" arm as the RDS import case; probed
      // to matter, since making the write unconditional here left every other
      // test in this file passing.
      mockSsmSend.mockResolvedValueOnce({ Parameter: { Name: '/adopted' } }); // no ARN

      const result = await new SSMParameterProvider().import({
        logicalId: 'MyParam',
        resourceType: TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { Name: '/adopted' },
      });

      expect(result).toEqual({ physicalId: '/adopted', attributes: {} });
      expect(Object.keys(result?.attributes ?? {})).not.toContain('Arn');
    });

    // WHY THIS BLOCK REPLACED A `records an ARN-shaped physicalId VERBATIM`
    // CASE (issue #1824 review round 3). That case primed `PutParameter` to
    // ACCEPT an ARN as its `Name` in order to reach a guard inside the ARN
    // builder — a wire shape AWS rejects outright
    // (`PutParameterRequest.Name`: "You can't enter the Amazon Resource Name
    // (ARN) for a parameter, only the parameter name itself"), so the test
    // endorsed an impossible world and the guard it pinned was reachable only
    // from a mock: `update()` sends `PutParameter({Name: physicalId})` BEFORE it
    // builds the ARN, and `create()` likewise. The guard is deleted and the
    // defect is fixed where the bad value ENTERS — `import()` refuses it — so no
    // test in this file primes an SSM mock to accept an ARN as `Name`.
    describe('import REFUSES a physical id SSM cannot write', () => {
      const ARN_ID = 'arn:aws:ssm:us-east-1:111122223333:parameter/adopted';

      /** `--resource <id>` when `override` is set, else a template `Name`. */
      const importWith = (override: string | undefined, templateName?: string) =>
        new SSMParameterProvider().import({
          logicalId: 'MyParam',
          resourceType: TYPE,
          stackName: 'MyStack',
          region: 'us-east-1',
          properties: templateName !== undefined ? { Name: templateName } : {},
          ...(override !== undefined && { knownPhysicalId: override }),
        });

      /** The refusal's message, so both polarities can be asserted on one run. */
      const refusalMessage = async (
        override: string | undefined,
        templateName?: string
      ): Promise<string> => {
        try {
          await importWith(override, templateName);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        throw new Error('import() did not refuse the unwritable physical id');
      };

      it('refuses an ARN from --resource, naming the remedy and the reason', async () => {
        const msg = await refusalMessage(ARN_ID);
        expect(msg).toContain('Cannot adopt SSM parameter MyParam from an ARN');
        // The ACTIONABLE half, not merely the diagnosis: the flag form to re-run
        // with, and the command that prints the name to pass.
        expect(msg).toContain('--resource MyParam=<parameterName>');
        expect(msg).toContain(
          `aws ssm get-parameter --name '${ARN_ID}' --query Parameter.Name --output text`
        );
        // ...plus the recorded reason no normalization was attempted, which is
        // the whole basis of the refuse-over-derive decision.
        expect(msg).toContain('hierarchical name "/foo"');
        // Nothing was verified against a value cdkd would not record: the refusal
        // precedes `GetParameter`, so it spends no round trip (and cannot succeed
        // against a SHARED parameter, which has no name form at all).
        expect(mockSsmSend).not.toHaveBeenCalled();
        expect(mockStsSend).not.toHaveBeenCalled();
      });

      it('refuses an ARN that arrived through the TEMPLATE Name, with the template-side remedy', async () => {
        // `resolveExplicitPhysicalId` reads `Properties.Name` when no
        // `--resource` override is passed, so the SAME bad id has a second entry
        // route and a DIFFERENT fix. Both polarities: the template remedy is
        // present AND the flag form — which the user never used — is absent.
        const msg = await refusalMessage(undefined, ARN_ID);
        expect(msg).toContain('set Properties.Name to the parameter NAME rather than an ARN');
        expect(msg).not.toContain('--resource MyParam=');
        expect(mockSsmSend).not.toHaveBeenCalled();
      });

      it('refuses a version / label SELECTOR, the other shape GetParameter accepts and writes reject', async () => {
        // `GetParameterRequest.Name` documents `name:version` / `name:label`, and
        // a parameter NAME may contain only `a-zA-Z0-9_.-` plus `/` — so a
        // selector verifies fine and then breaks every later write, exactly like
        // an ARN. One predicate (a colon) covers both shapes.
        const msg = await refusalMessage('/adopted:2');
        expect(msg).toContain("from a version / label selector ('/adopted:2')");
        // The ARN-specific why-not-derived note must NOT appear here: there is no
        // ARN to derive a name from, and saying so would misdescribe the refusal.
        expect(msg).not.toContain('hierarchical name "/foo"');
        expect(mockSsmSend).not.toHaveBeenCalled();
      });

      it('lets an ordinary NAME through untouched — both a hierarchical and a flat one', async () => {
        // The polarity that keeps the guard from being a blanket refusal. A `:`
        // cannot occur in a writable name, so no legitimate id is affected.
        const liveArn = 'arn:aws:ssm:us-east-1:111122223333:parameter/x';
        for (const name of ['/adopted/deep', 'flatname']) {
          mockSsmSend.mockReset();
          mockSsmSend.mockResolvedValueOnce({ Parameter: { Name: name, ARN: liveArn } });
          await expect(importWith(name)).resolves.toEqual({
            physicalId: name,
            attributes: { Arn: liveArn },
          });
        }
      });
    });
  });

  describe('the constructed ARN derives its partition and canonicalizes its region', () => {
    const TYPE = 'AWS::SSM::Parameter';

    /** Create one parameter under `region` and return the recorded `Arn`. */
    const arnForRegion = async (region: string): Promise<unknown> => {
      ssmRegion.value = region;
      resetAccountInfoCache();
      mockSsmSend.mockResolvedValueOnce({}); // PutParameter
      const result = await new SSMParameterProvider().create('MyParam', TYPE, {
        Name: '/foo/bar',
        Type: 'String',
        Value: 'baz',
      });
      return result.attributes?.['Arn'];
    };

    // WHY EACH NON-COMMERCIAL CASE IS PAIRED WITH A COMMERCIAL ONE (the #1745 /
    // #1794 / #1815 convention). A test that only ever runs in `us-east-1`
    // cannot tell a DERIVED partition from a hardcoded `arn:aws:` — probed:
    // replacing the derivation with a literal `'aws'` left all 15 pre-existing
    // cases in this file green, because every one of them used `us-east-1`. The
    // commercial counter-case is what stops the inverse mistake, a "fix" that
    // hardcodes some non-commercial partition instead.
    it('derives aws-cn for a cn- region, with the commercial counter-case', async () => {
      expect(await arnForRegion('cn-north-1')).toBe(
        'arn:aws-cn:ssm:cn-north-1:111122223333:parameter/foo/bar'
      );
      expect(await arnForRegion('us-east-1')).toBe(
        'arn:aws:ssm:us-east-1:111122223333:parameter/foo/bar'
      );
    });

    it('derives aws-us-gov for a us-gov- region, with the commercial counter-case', async () => {
      expect(await arnForRegion('us-gov-west-1')).toBe(
        'arn:aws-us-gov:ssm:us-gov-west-1:111122223333:parameter/foo/bar'
      );
      expect(await arnForRegion('us-east-1')).toBe(
        'arn:aws:ssm:us-east-1:111122223333:parameter/foo/bar'
      );
    });

    // Region CASE (the #1795 / #1814 class). `cdkd deploy --region US-EAST-1` is
    // REACHABLE — DNS is case-insensitive, so the deploy SUCCEEDS — and the ARN
    // recorded from a verbatim region matches no IAM policy and no SDK call,
    // persisted into state.json where it outlives the deploy.
    it('folds an upper-cased region to a BYTE-IDENTICAL ARN', async () => {
      const upper = await arnForRegion('US-EAST-1');
      const canonical = await arnForRegion('us-east-1');
      // Both polarities: the canonical spelling is unchanged...
      expect(canonical).toBe('arn:aws:ssm:us-east-1:111122223333:parameter/foo/bar');
      // ...and the upper-cased one is byte-identical to it, NOT
      // `arn:aws:ssm:US-EAST-1:...` (the shape the regression emits).
      expect(upper).toBe(canonical);
      expect(upper).not.toBe('arn:aws:ssm:US-EAST-1:111122223333:parameter/foo/bar');
    });

    it('folds case AND derives the partition together for an upper-cased cn- region', async () => {
      // `derivePartitionAndUrlSuffix` canonicalizes internally, so the PARTITION
      // was already right here before the fix while the region segment was not —
      // which is exactly why the two halves need one case asserting them jointly.
      expect(await arnForRegion('CN-NORTH-1')).toBe(
        'arn:aws-cn:ssm:cn-north-1:111122223333:parameter/foo/bar'
      );
    });
  });

  describe('the constructed ARN honors the guards the repo already has', () => {
    const TYPE = 'AWS::SSM::Parameter';

    it('REFUSES to record an ARN built from a fabricated account (issues #1730 / #1746)', async () => {
      // `getAccountInfo` catches its own STS failure and answers the hardcoded
      // placeholder `123456789012`, flagged `fabricated`. That value carries no
      // wildcard, so `isPlaceholderArn` cannot catch it downstream — the ARN
      // must therefore NOT be recorded at all. Degrading to an absent attribute
      // restores the loud shape-guard failure, never a silently wrong value.
      mockStsSend.mockReset();
      mockStsSend.mockRejectedValue(new Error('STS unreachable'));

      mockSsmSend.mockResolvedValueOnce({});
      const result = await new SSMParameterProvider().create('MyParam', TYPE, {
        Name: '/foo/bar',
        Type: 'String',
        Value: 'baz',
      });

      expect(result.attributes).toEqual({ Type: 'String', Value: 'baz' });
      expect(Object.keys(result.attributes ?? {})).not.toContain('Arn');

      // ...and the resulting Fn::GetAtt fails LOUDLY rather than shipping a
      // fabricated ARN to the consumer.
      const context = mkContext('MyParam', TYPE, result.physicalId, result.attributes ?? {});
      await expect(
        resolver.resolve({ 'Fn::GetAtt': ['MyParam', 'Arn'] }, context)
      ).rejects.toThrow(/is not an ARN \(arn:\.\.\.\)/);
    });

    it('never lets an ARN-build failure fail the CREATE (the parameter is already committed)', async () => {
      // `create` builds the ARN AFTER `PutParameter` has committed, and after the
      // inner cleanup block that would otherwise delete the parameter. A throw
      // here would therefore surface as a failed create over a missing ATTRIBUTE
      // and leave an orphan that makes the next deploy hit
      // `ParameterAlreadyExists` (the issue #376 class). Simulate the one thing
      // `getAccountInfo` does NOT catch: a rejecting region resolver.
      const boom = vi.fn().mockRejectedValue(new Error('region resolver exploded'));

      mockSsmSend.mockResolvedValueOnce({}); // PutParameter
      const provider = new SSMParameterProvider();
      // Re-point the region resolver on the instance the provider captured. This
      // is the ONLY load-bearing re-point: the mocked `getAwsClients` returns a
      // FRESH object literal per call, so mutating the result of a separate
      // `getAwsClients()` here would be a throwaway the provider never reads.
      (provider as unknown as { ssmClient: { config: { region: unknown } } }).ssmClient.config.region =
        boom;

      const result = await provider.create('MyParam', TYPE, {
        Name: '/foo/bar',
        Type: 'String',
        Value: 'baz',
      });

      // The create SUCCEEDS, just without the attribute, and nothing was deleted.
      expect(result.physicalId).toBe('/foo/bar');
      expect(result.attributes).toEqual({ Type: 'String', Value: 'baz' });
      const commands = mockSsmSend.mock.calls.map((c) => c[0].constructor.name);
      expect(commands).toEqual(['PutParameterCommand']);
      expect(commands).not.toContain('DeleteParameterCommand');
    });

    it('DEGRADES an update by dropping Arn while KEEPING the freshly-sent Type / Value', async () => {
      // The deliberate half of the trade-off `buildParameterArn`'s note records.
      // An update result's `attributes` REPLACE the state record's
      // (`deploy-engine.ts`: `result.attributes ?? (wasReplaced ? undefined :
      // currentResource.attributes)`), so a degraded update has exactly two
      // options and BOTH cost something:
      //
      //   - return the PARTIAL map (chosen): `Arn` is dropped, the resolver's
      //     `*Arn` shape guard fails LOUDLY, and the next real UPDATE re-records
      //     it;
      //   - return NO attributes: the engine's `??` carries the PREVIOUS map
      //     forward and `Arn` survives — but so does the SUPERSEDED `Value`,
      //     so `Fn::GetAtt [Param, Value]` silently answers 'baz' after an
      //     update that sent 'new'.
      //
      // This pins the chosen behavior from both directions, so a later "keep the
      // ARN by returning nothing" change cannot land silently.
      mockStsSend.mockReset();
      mockStsSend.mockRejectedValue(new Error('STS unreachable'));

      mockSsmSend.mockResolvedValueOnce({ Version: 3 }); // PutParameter (Overwrite)
      const result = await new SSMParameterProvider().update(
        'MyParam',
        '/foo/bar',
        TYPE,
        { Name: '/foo/bar', Type: 'String', Value: 'new' },
        { Name: '/foo/bar', Type: 'String', Value: 'baz' }
      );

      // `attributes` is RETURNED, not omitted — this is the assertion that
      // distinguishes the two options, and it is the shape the REJECTED option
      // would break.
      expect(result.attributes).toBeDefined();
      expect(result.attributes).toEqual({ Type: 'String', Value: 'new' });
      expect(Object.keys(result.attributes ?? {})).not.toContain('Arn');
      // The value THIS update sent, never the superseded one the carry-forward
      // option would leave behind.
      expect(result.attributes?.['Value']).not.toBe('baz');

      // ...and the degradation is LOUD at the consumer rather than silent.
      const context = mkContext('MyParam', TYPE, result.physicalId, result.attributes ?? {});
      await expect(
        resolver.resolve({ 'Fn::GetAtt': ['MyParam', 'Arn'] }, context)
      ).rejects.toThrow(/is not an ARN \(arn:\.\.\.\)/);
    });
  });
});
