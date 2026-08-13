import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupRulesCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

/**
 * Issue #1761: `AWS::EC2::SecurityGroupIngress` recorded `attributes: {}`, so
 * nothing in cdkd state carried the `sgr-...` security-group rule id.
 *
 * ## Measured facts this suite is pinned to (live, us-east-1, 2026-08-13)
 *
 * - `aws cloudformation describe-type --type RESOURCE --type-name
 *   AWS::EC2::SecurityGroupIngress`: `primaryIdentifier` is exactly
 *   `["/properties/Id"]` and `readOnlyProperties` is the same single entry, so
 *   `Id` is BOTH the CFn identifier field and the type's only `Fn::GetAtt`
 *   attribute — which is why the value is recorded under that name.
 * - `@aws-sdk/client-ec2`'s `AuthorizeSecurityGroupIngressResult` carries
 *   `SecurityGroupRules?: SecurityGroupRule[]`, and `SecurityGroupRule` carries
 *   `SecurityGroupRuleId?: string` — the `sgr-...` value. That response field is
 *   the ONLY source the success path may use: see the #1710 fence row below.
 *
 * cdkd's physicalId stays the composite `<groupId>|<ipProtocol>|<fromPort>|<toPort>`
 * (the tuple `RevokeSecurityGroupIngress` needs), so the CFn identifier cannot be
 * derived from it — `cdkd export` refused the whole type until this attribute
 * existed.
 */
describe('EC2Provider AWS::EC2::SecurityGroupIngress rule-id attribute (#1761)', () => {
  let provider: EC2Provider;

  const RESOURCE_TYPE = 'AWS::EC2::SecurityGroupIngress';
  const GROUP_ID = 'sg-123';
  const PHYSICAL_ID = `${GROUP_ID}|tcp|443|443`;
  const PROPS = Object.freeze({
    GroupId: GROUP_ID,
    IpProtocol: 'tcp',
    FromPort: 443,
    ToPort: 443,
    CidrIp: '10.0.0.0/16',
  }) as Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new EC2Provider();
    mockSend.mockResolvedValue({});
  });

  const sentCommands = () => mockSend.mock.calls.map((c) => c[0]);

  describe('the CREATE success arm', () => {
    it('records the sgr- id AuthorizeSecurityGroupIngress returned under attributes.Id', async () => {
      mockSend.mockResolvedValue({
        Return: true,
        SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-0abc123', GroupId: GROUP_ID }],
      });

      const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);

      // The composite physicalId is UNCHANGED — the revoke path still needs it.
      expect(result.physicalId).toBe(PHYSICAL_ID);
      expect(result.attributes).toEqual({ Id: 'sgr-0abc123' });
    });

    it('reads the id off the MUTATING call only — no follow-up AWS call (#1710 fence)', async () => {
      // The orphan class issue #1710 records: an `await` added inside create()'s
      // try AFTER the mutating call can throw, and the failed CREATE journals no
      // physicalId, so the authorized rule is never revoked. Asserting the call
      // COUNT is what keeps a later "just describe it to be sure" refactor from
      // silently re-creating that hazard.
      mockSend.mockResolvedValue({
        SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-0abc123' }],
      });

      await provider.create('Ingress', RESOURCE_TYPE, PROPS);

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(sentCommands()[0]).toBeInstanceOf(AuthorizeSecurityGroupIngressCommand);
    });

    it('records nothing when the response carries no rules (never an undefined Id)', async () => {
      mockSend.mockResolvedValue({ Return: true });

      const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);

      expect(result.physicalId).toBe(PHYSICAL_ID);
      expect(result.attributes).toEqual({});
      expect(result.attributes).not.toHaveProperty('Id');
    });

    it('refuses an AMBIGUOUS id when the response carries two rules', async () => {
      // A template declaring both CidrIp and CidrIpv6 on one ingress resource
      // makes AWS mint two rules; neither is "the" CFn identifier, and adopting
      // one would name the wrong AWS object in the import changeset.
      mockSend.mockResolvedValue({
        SecurityGroupRules: [
          { SecurityGroupRuleId: 'sgr-v4' },
          { SecurityGroupRuleId: 'sgr-v6' },
        ],
      });

      const result = await provider.create('Ingress', RESOURCE_TYPE, {
        ...PROPS,
        CidrIpv6: '::/0',
      });

      expect(result.attributes).toEqual({});
    });

    it('ignores a blank rule id rather than recording an empty identifier', async () => {
      mockSend.mockResolvedValue({ SecurityGroupRules: [{ SecurityGroupRuleId: '   ' }] });

      const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);

      expect(result.attributes).toEqual({});
    });
  });

  describe('the idempotent "already exists" arm', () => {
    // The Authorize FAILED, so no response carries the id — but this arm still
    // reports the rule as provisioned and the engine writes state from it, so
    // without a lookup `cdkd export` refuses exactly the resources a re-run
    // adopted.
    const alreadyExists = new Error('the specified rule ... already exists');

    const withExistingRules = (rules: unknown[]) => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          return Promise.reject(alreadyExists);
        }
        if (command instanceof DescribeSecurityGroupRulesCommand) {
          return Promise.resolve({ SecurityGroupRules: rules });
        }
        return Promise.resolve({});
      });
    };

    it('looks the existing rule up and records its sgr- id', async () => {
      withExistingRules([
        // Decoy 1: same protocol/ports, DIFFERENT source.
        {
          SecurityGroupRuleId: 'sgr-other-cidr',
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIpv4: '192.168.0.0/16',
        },
        // Decoy 2: identical tuple AND source, but EGRESS — a different CFn type.
        {
          SecurityGroupRuleId: 'sgr-egress',
          IsEgress: true,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIpv4: '10.0.0.0/16',
        },
        {
          SecurityGroupRuleId: 'sgr-existing',
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIpv4: '10.0.0.0/16',
        },
      ]);

      const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);

      expect(result.physicalId).toBe(PHYSICAL_ID);
      expect(result.attributes).toEqual({ Id: 'sgr-existing' });
      const describe = sentCommands().find(
        (c) => c instanceof DescribeSecurityGroupRulesCommand
      ) as DescribeSecurityGroupRulesCommand | undefined;
      expect(describe?.input).toEqual({ Filters: [{ Name: 'group-id', Values: [GROUP_ID] }] });
    });

    it('matches a SG-to-SG rule via ReferencedGroupInfo', async () => {
      withExistingRules([
        {
          SecurityGroupRuleId: 'sgr-peer',
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          ReferencedGroupInfo: { GroupId: 'sg-peer', UserId: '000000000000' },
        },
      ]);

      const result = await provider.create('Ingress', RESOURCE_TYPE, {
        GroupId: GROUP_ID,
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        // Deliberately NO SourceSecurityGroupOwnerId / Description, which AWS
        // fills in on the read side: the match must not depend on them.
        SourceSecurityGroupId: 'sg-peer',
      });

      expect(result.attributes).toEqual({ Id: 'sgr-peer' });
    });

    it('records nothing — and still SUCCEEDS — when the lookup itself fails', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeSecurityGroupRulesCommand) {
          return Promise.reject(new Error('UnauthorizedOperation'));
        }
        return Promise.reject(alreadyExists);
      });

      const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);

      expect(result.physicalId).toBe(PHYSICAL_ID);
      expect(result.attributes).toEqual({});
    });

    it('records nothing when two live rules match the same tuple + source', async () => {
      withExistingRules([
        {
          SecurityGroupRuleId: 'sgr-dupe-a',
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIpv4: '10.0.0.0/16',
        },
        {
          SecurityGroupRuleId: 'sgr-dupe-b',
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIpv4: '10.0.0.0/16',
        },
      ]);

      const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);

      expect(result.attributes).toEqual({});
    });

    it('ignores a matching rule whose own SecurityGroupRuleId is blank', async () => {
      // Distinct code site from the response-side filter above: this one is in
      // `lookupIngressRuleId`, and an empty-string id would otherwise be
      // recorded as the CFn identifier.
      withExistingRules([
        {
          SecurityGroupRuleId: '   ',
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIpv4: '10.0.0.0/16',
        },
      ]);

      const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);

      expect(result.attributes).toEqual({});
    });

    describe('the (protocol, ports, source) match itself', () => {
      // Each row below leaves EXACTLY ONE decoy on the group, differing from the
      // requested rule in exactly ONE field. Without the corresponding guard the
      // decoy is the single match and its id is recorded — the #1658 wrong-object
      // class this lookup exists to prevent.
      const decoy = (overrides: Record<string, unknown>) => ({
        SecurityGroupRuleId: 'sgr-decoy',
        IsEgress: false,
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        CidrIpv4: '10.0.0.0/16',
        ...overrides,
      });

      it('rejects a rule differing ONLY by protocol', async () => {
        withExistingRules([decoy({ IpProtocol: 'udp' })]);
        const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);
        expect(result.attributes).toEqual({});
      });

      it('rejects a rule differing ONLY by FromPort', async () => {
        withExistingRules([decoy({ FromPort: 80 })]);
        const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);
        expect(result.attributes).toEqual({});
      });

      it('rejects a rule differing ONLY by ToPort', async () => {
        withExistingRules([decoy({ ToPort: 8443 })]);
        const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);
        expect(result.attributes).toEqual({});
      });

      it('rejects an all-ports rule when the template pins a port range', async () => {
        // The `?? -1` default on the AWS side: a rule AWS reports with no ports
        // is "all ports", which is NOT the tcp/443 rule the template asked for.
        withExistingRules([decoy({ FromPort: undefined, ToPort: undefined })]);
        const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);
        expect(result.attributes).toEqual({});
      });

      it('matches an all-ports rule when the template pins no ports either', async () => {
        // The other half of the `-1` default — without it the omitted template
        // ports would never line up with AWS's `-1` and this arm would silently
        // stop recording for every all-protocols rule.
        withExistingRules([
          decoy({
            SecurityGroupRuleId: 'sgr-all',
            IpProtocol: '-1',
            FromPort: -1,
            ToPort: -1,
          }),
        ]);

        const result = await provider.create('Ingress', RESOURCE_TYPE, {
          GroupId: GROUP_ID,
          IpProtocol: '-1',
          CidrIp: '10.0.0.0/16',
        });

        expect(result.attributes).toEqual({ Id: 'sgr-all' });
      });

      it('matches a template that spells its ports as STRINGS', async () => {
        // A YAML / JSON template may write `FromPort: "443"`, and
        // `buildIpPermission` forwards it to AWS unchanged, so such a rule
        // deploys fine. An identity compare against a number never matched it.
        withExistingRules([decoy({ SecurityGroupRuleId: 'sgr-stringports' })]);

        const result = await provider.create('Ingress', RESOURCE_TYPE, {
          GroupId: GROUP_ID,
          IpProtocol: 'tcp',
          FromPort: '443',
          ToPort: '443',
          CidrIp: '10.0.0.0/16',
        });

        expect(result.attributes).toEqual({ Id: 'sgr-stringports' });
      });

      it('matches on CidrIpv6', async () => {
        withExistingRules([
          decoy({
            SecurityGroupRuleId: 'sgr-v6',
            CidrIpv4: undefined,
            CidrIpv6: '2001:db8::/32',
          }),
        ]);

        const result = await provider.create('Ingress', RESOURCE_TYPE, {
          GroupId: GROUP_ID,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIpv6: '2001:db8::/32',
        });

        expect(result.attributes).toEqual({ Id: 'sgr-v6' });
      });

      it('rejects a CidrIpv6 rule for a DIFFERENT range', async () => {
        withExistingRules([
          decoy({ CidrIpv4: undefined, CidrIpv6: '2001:db8:dead::/48' }),
        ]);

        const result = await provider.create('Ingress', RESOURCE_TYPE, {
          GroupId: GROUP_ID,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIpv6: '2001:db8::/32',
        });

        expect(result.attributes).toEqual({});
      });

      it('matches on SourcePrefixListId', async () => {
        withExistingRules([
          decoy({
            SecurityGroupRuleId: 'sgr-pl',
            CidrIpv4: undefined,
            PrefixListId: 'pl-0abc',
          }),
        ]);

        const result = await provider.create('Ingress', RESOURCE_TYPE, {
          GroupId: GROUP_ID,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          SourcePrefixListId: 'pl-0abc',
        });

        expect(result.attributes).toEqual({ Id: 'sgr-pl' });
      });

      it('rejects a prefix-list rule for a DIFFERENT list', async () => {
        withExistingRules([
          decoy({ CidrIpv4: undefined, PrefixListId: 'pl-9999' }),
        ]);

        const result = await provider.create('Ingress', RESOURCE_TYPE, {
          GroupId: GROUP_ID,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          SourcePrefixListId: 'pl-0abc',
        });

        expect(result.attributes).toEqual({});
      });
    });

    describe('pagination', () => {
      // The "exactly one match" verdict is a statement about the WHOLE group, so
      // reading only the first page turns a genuine 2-match into a false
      // "exactly one" and records the WRONG id — defeating the ambiguity fence.
      const withExistingPages = (pages: Array<{ rules: unknown[]; next?: string }>) => {
        let call = 0;
        mockSend.mockImplementation((command: unknown) => {
          if (command instanceof AuthorizeSecurityGroupIngressCommand) {
            return Promise.reject(alreadyExists);
          }
          if (command instanceof DescribeSecurityGroupRulesCommand) {
            const page = pages[Math.min(call, pages.length - 1)]!;
            call += 1;
            return Promise.resolve({
              SecurityGroupRules: page.rules,
              ...(page.next && { NextToken: page.next }),
            });
          }
          return Promise.resolve({});
        });
      };

      const match = (id: string) => ({
        SecurityGroupRuleId: id,
        IsEgress: false,
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        CidrIpv4: '10.0.0.0/16',
      });

      it('walks NextToken and finds a match that lives on the SECOND page', async () => {
        withExistingPages([
          { rules: [], next: 'page-2' },
          { rules: [match('sgr-page2')] },
        ]);

        const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);

        expect(result.attributes).toEqual({ Id: 'sgr-page2' });
        const describes = sentCommands().filter(
          (c) => c instanceof DescribeSecurityGroupRulesCommand
        ) as DescribeSecurityGroupRulesCommand[];
        expect(describes).toHaveLength(2);
        expect(describes[0]?.input.NextToken).toBeUndefined();
        expect(describes[1]?.input.NextToken).toBe('page-2');
      });

      it('records NOTHING when the second page carries a second match', async () => {
        // The regression a single-page read would reintroduce: page 1 alone
        // looks like "exactly one match" and would record `sgr-page1`.
        withExistingPages([
          { rules: [match('sgr-page1')], next: 'page-2' },
          { rules: [match('sgr-page2')] },
        ]);

        const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);

        expect(result.attributes).toEqual({});
      });

      it('gives up (recording nothing) on a NextToken that never terminates', async () => {
        withExistingPages([{ rules: [match('sgr-looping')], next: 'forever' }]);

        const result = await provider.create('Ingress', RESOURCE_TYPE, PROPS);

        expect(result.attributes).toEqual({});
        // Bounded: the walk must not spin forever on a pathological token.
        const describes = sentCommands().filter(
          (c) => c instanceof DescribeSecurityGroupRulesCommand
        );
        expect(describes.length).toBeGreaterThan(1);
        expect(describes.length).toBeLessThanOrEqual(20);
      });
    });
  });

  describe('the UPDATE (replacement) arm', () => {
    it('refreshes the recorded Id — re-authorizing mints a NEW sgr- id', async () => {
      // update() revokes then re-creates, so the old rule id is dead. A stale
      // recorded value would make `cdkd export` adopt a rule that no longer
      // exists, which is worse than recording none.
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof RevokeSecurityGroupIngressCommand) return Promise.resolve({});
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          return Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-new' }] });
        }
        return Promise.resolve({});
      });

      const result = await provider.update('Ingress', PHYSICAL_ID, RESOURCE_TYPE, PROPS, {
        ...PROPS,
        CidrIp: '10.0.0.0/8',
      });

      expect(result.wasReplaced).toBe(true);
      expect(result.attributes).toEqual({ Id: 'sgr-new' });
    });

    it('returns an EMPTY attributes bag when the re-create yields no id', async () => {
      // The wrong-value risk this pins: the old rule was revoked, so its id is
      // dead. `attributes` must be present-and-empty rather than absent —
      // deploy-engine's `result.attributes ?? (wasReplaced ? undefined : previous)`
      // reads an absent bag as "no opinion", and on a NON-replacement that would
      // carry the dead id forward. `{}` is not nullish, so it clears.
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof RevokeSecurityGroupIngressCommand) return Promise.resolve({});
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          // AWS answered without a rule list (or with an ambiguous one).
          return Promise.resolve({ Return: true });
        }
        return Promise.resolve({});
      });

      const result = await provider.update('Ingress', PHYSICAL_ID, RESOURCE_TYPE, PROPS, {
        ...PROPS,
        CidrIp: '10.0.0.0/8',
      });

      expect(result.wasReplaced).toBe(true);
      expect(result.attributes).toEqual({});
      expect(result.attributes).not.toBeUndefined();
    });

    it('the no-op short-circuit reports NO attributes so the recorded id is kept', async () => {
      // `cdkd drift --revert` can call update() with new == old. The rule is
      // never revoked, so its recorded id is still live and must survive — the
      // engine carries the previous bag forward only when `attributes` is
      // absent AND `wasReplaced` is false.
      const result = await provider.update('Ingress', PHYSICAL_ID, RESOURCE_TYPE, PROPS, {
        ...PROPS,
      });

      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('the import() arm', () => {
    it('adopts an sgr- id: records the composite physicalId AND attributes.Id', async () => {
      mockSend.mockResolvedValue({
        SecurityGroupRules: [
          {
            SecurityGroupRuleId: 'sgr-adopted',
            GroupId: GROUP_ID,
            IsEgress: false,
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            CidrIpv4: '10.0.0.0/16',
          },
        ],
      });

      const result = await provider.import({
        logicalId: 'Ingress',
        resourceType: RESOURCE_TYPE,
        knownPhysicalId: 'sgr-adopted',
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
      });

      expect(result).toEqual({
        physicalId: PHYSICAL_ID,
        attributes: { Id: 'sgr-adopted' },
      });
    });

    it('packs the all-protocols shape with the -1 port sentinels', async () => {
      mockSend.mockResolvedValue({
        SecurityGroupRules: [
          {
            SecurityGroupRuleId: 'sgr-all',
            GroupId: GROUP_ID,
            IsEgress: false,
            IpProtocol: '-1',
            CidrIpv4: '0.0.0.0/0',
          },
        ],
      });

      const result = await provider.import({
        logicalId: 'Ingress',
        resourceType: RESOURCE_TYPE,
        knownPhysicalId: 'sgr-all',
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
      });

      expect(result?.physicalId).toBe(`${GROUP_ID}|-1|-1|-1`);
    });

    it('declines an EGRESS rule id — that is a different CFn type', async () => {
      mockSend.mockResolvedValue({
        SecurityGroupRules: [
          {
            SecurityGroupRuleId: 'sgr-egress',
            GroupId: GROUP_ID,
            IsEgress: true,
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
          },
        ],
      });

      const result = await provider.import({
        logicalId: 'Ingress',
        resourceType: RESOURCE_TYPE,
        knownPhysicalId: 'sgr-egress',
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
      });

      expect(result).toBeNull();
    });

    it('declines a non-sgr id without calling AWS', async () => {
      const result = await provider.import({
        logicalId: 'Ingress',
        resourceType: RESOURCE_TYPE,
        knownPhysicalId: PHYSICAL_ID,
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
      });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['GroupId', { GroupId: undefined }],
      ['IpProtocol', { IpProtocol: undefined }],
      ['SecurityGroupRuleId', { SecurityGroupRuleId: undefined }],
    ])('declines when AWS omits %s from the rule', async (_field, overrides) => {
      // Each of the three feeds a composite segment or the attribute itself;
      // adopting a rule with any of them missing would record a malformed id.
      mockSend.mockResolvedValue({
        SecurityGroupRules: [
          {
            SecurityGroupRuleId: 'sgr-partial',
            GroupId: GROUP_ID,
            IsEgress: false,
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            ...overrides,
          },
        ],
      });

      const result = await provider.import({
        logicalId: 'Ingress',
        resourceType: RESOURCE_TYPE,
        knownPhysicalId: 'sgr-partial',
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
      });

      expect(result).toBeNull();
    });

    it('declines when AWS reports no such rule', async () => {
      mockSend.mockResolvedValue({ SecurityGroupRules: [] });

      const result = await provider.import({
        logicalId: 'Ingress',
        resourceType: RESOURCE_TYPE,
        knownPhysicalId: 'sgr-missing',
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
      });

      expect(result).toBeNull();
    });
  });
});
