import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupEgressCommand,
  DescribeSecurityGroupRulesCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2SingleSend: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const { childLogger } = vi.hoisted(() => ({
  childLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
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
import { withStackRecords, type StackRecordsView } from '../../../src/deployment/stack-records-scope.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#4492: two records of ONE stack can describe the same AWS
 * ingress rule — CDK cannot dedupe an Aurora proxy's `GetAtt Endpoint.Port`
 * rule against an explicit `Port.tcp(3306)` one — and AWS keeps one rule for
 * both. CloudFormation deploys such a template; cdkd refused the second
 * create since #4355. A rule another record of the stack holds is now shared:
 * the second create records it, and a delete leaves it while a record that
 * outlives the delete still holds it.
 */
describe('EC2Provider SecurityGroupIngress rule shared by two records of one stack (#4492)', () => {
  const TYPE = 'AWS::EC2::SecurityGroupIngress';
  const GROUP_ID = 'sg-0123456789abcdef0';
  const RULE_ID = 'sgr-0a1b2c3d4e5f60718';
  const PHYSICAL_ID = `${GROUP_ID}|tcp|3306|3306`;
  /** The proxy's rule: its port was `GetAtt Cluster.Endpoint.Port`. */
  const PROXY_RULE = Object.freeze({
    GroupId: GROUP_ID,
    IpProtocol: 'tcp',
    FromPort: 3306,
    ToPort: 3306,
    SourceSecurityGroupId: GROUP_ID,
    Description: 'from proxy:{IndirectPort}',
  }) as Record<string, unknown>;
  /** The explicit `addIngressRule(sg, Port.tcp(3306))`: same rule, another description. */
  const EXPLICIT_RULE = Object.freeze({
    ...PROXY_RULE,
    Description: 'Allow MySQL access from within security group',
  }) as Record<string, unknown>;

  const ingressRecord = (
    properties: Record<string, unknown>,
    attributes: Record<string, unknown> = { Id: RULE_ID }
  ): ResourceState =>
    ({
      physicalId: PHYSICAL_ID,
      resourceType: TYPE,
      properties,
      attributes,
      dependencies: [],
    }) as ResourceState;

  const view = (
    live: Record<string, ResourceState>,
    survivors: Record<string, ResourceState> = live
  ): StackRecordsView => ({
    live: () => Object.entries(live),
    survivors: () => Object.entries(survivors),
  });

  let provider: EC2Provider;

  const duplicate = () =>
    Promise.reject(
      Object.assign(
        new Error(
          `the specified rule "peer: ${GROUP_ID}, TCP, from port: 3306, to port: 3306, ALLOW" already exists`
        ),
        { name: 'InvalidPermission.Duplicate' }
      )
    );

  beforeEach(() => {
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new EC2Provider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof AuthorizeSecurityGroupIngressCommand) return duplicate();
      if (command instanceof DescribeSecurityGroupRulesCommand) {
        return Promise.resolve({
          SecurityGroupRules: [
            {
              SecurityGroupRuleId: RULE_ID,
              IsEgress: false,
              IpProtocol: 'tcp',
              FromPort: 3306,
              ToPort: 3306,
              ReferencedGroupInfo: { GroupId: GROUP_ID },
              Description: EXPLICIT_RULE['Description'],
            },
          ],
        });
      }
      return Promise.resolve({ Return: true });
    });
  });

  const revokes = () =>
    mockSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is RevokeSecurityGroupIngressCommand => c instanceof RevokeSecurityGroupIngressCommand);

  const infoLines = () => childLogger.info.mock.calls.map((c) => String(c[0]));

  describe('create: a duplicate another record of the stack holds is shared, not refused', () => {
    it('records the existing rule when a sibling SecurityGroupIngress record describes it', async () => {
      const result = await withStackRecords(view({ ExplicitRule: ingressRecord(EXPLICIT_RULE) }), () =>
        provider.create('ProxyRule', TYPE, PROXY_RULE)
      );

      expect(result).toEqual({ physicalId: PHYSICAL_ID, attributes: { Id: RULE_ID } });
      expect(infoLines().some((l) => l.includes('already held by ExplicitRule of this stack'))).toBe(true);
      expect(revokes()).toHaveLength(0);
    });

    it('records it when the sibling records no rule id', async () => {
      await expect(
        withStackRecords(view({ ExplicitRule: ingressRecord(EXPLICIT_RULE, {}) }), () =>
          provider.create('ProxyRule', TYPE, PROXY_RULE)
        )
      ).resolves.toMatchObject({ physicalId: PHYSICAL_ID });
    });

    it("matches a sibling recorded in another protocol and port spelling ('6', '3306')", async () => {
      const sibling = ingressRecord({ ...EXPLICIT_RULE, IpProtocol: '6', FromPort: '3306', ToPort: '3306' });

      await expect(
        withStackRecords(view({ ExplicitRule: sibling }), () => provider.create('ProxyRule', TYPE, PROXY_RULE))
      ).resolves.toMatchObject({ physicalId: PHYSICAL_ID });
    });

    it('records it when the group record of this stack declares the rule inline', async () => {
      const group: ResourceState = {
        physicalId: GROUP_ID,
        resourceType: 'AWS::EC2::SecurityGroup',
        properties: {
          GroupDescription: 'db',
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, SourceSecurityGroupId: GROUP_ID },
          ],
        },
        attributes: {},
        dependencies: [],
      } as ResourceState;

      await expect(
        withStackRecords(view({ DbGroup: group }), () => provider.create('ProxyRule', TYPE, PROXY_RULE))
      ).resolves.toMatchObject({ physicalId: PHYSICAL_ID });
      expect(infoLines().some((l) => l.includes('already held by DbGroup of this stack'))).toBe(true);
    });

    it('skips a holder recording a stale id and takes a later one recording the live id', async () => {
      await expect(
        withStackRecords(
          view({
            Stale: ingressRecord(EXPLICIT_RULE, { Id: 'sgr-0fffffffffffffff0' }),
            Current: ingressRecord(EXPLICIT_RULE),
          }),
          () => provider.create('ProxyRule', TYPE, PROXY_RULE)
        )
      ).resolves.toMatchObject({ physicalId: PHYSICAL_ID });
      expect(infoLines().some((l) => l.includes('already held by Current of this stack'))).toBe(true);
    });

    it('records it when neither the holder nor the lookup has a rule id', async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof AuthorizeSecurityGroupIngressCommand
          ? duplicate()
          : Promise.resolve({ SecurityGroupRules: [] })
      );

      await expect(
        withStackRecords(view({ ExplicitRule: ingressRecord(EXPLICIT_RULE, {}) }), () =>
          provider.create('ProxyRule', TYPE, PROXY_RULE)
        )
      ).resolves.toEqual({ physicalId: PHYSICAL_ID, attributes: {} });
    });

    describe('still refuses when no other record of the stack holds the live rule', () => {
      const refuses = async (records: Record<string, ResourceState> | undefined) => {
        const error = await withStackRecords(records && view(records), () =>
          provider.create('ProxyRule', TYPE, PROXY_RULE)
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(`rule ${RULE_ID} already exists on security group ${GROUP_ID}`);
        expect(isRefusedBeforeApplying(error, 'ProxyRule')).toBe(true);
      };

      it('no view bound (a caller outside a deploy)', () => refuses(undefined));

      it('a sibling recording a DIFFERENT rule id: the live rule is not the one this stack made', () =>
        refuses({ ExplicitRule: ingressRecord(EXPLICIT_RULE, { Id: 'sgr-0fffffffffffffff0' }) }));

      it.each([
        ['port', { FromPort: 3307, ToPort: 3307 }],
        ['protocol', { IpProtocol: 'udp' }],
        ['source', { SourceSecurityGroupId: 'sg-0aaaaaaaaaaaaaaa0' }],
        ['group', { GroupId: 'sg-0bbbbbbbbbbbbbbb0' }],
      ])('a sibling describing a rule with a different %s', (_what, patch) =>
        refuses({ ExplicitRule: ingressRecord({ ...EXPLICIT_RULE, ...patch }) })
      );

      it('a holder recording a rule id while the live rule id cannot be looked up', async () => {
        mockSend.mockImplementation((command: unknown) =>
          command instanceof AuthorizeSecurityGroupIngressCommand
            ? duplicate()
            : Promise.reject(Object.assign(new Error('not authorized'), { name: 'UnauthorizedOperation' }))
        );
        const error = await withStackRecords(view({ ExplicitRule: ingressRecord(EXPLICIT_RULE) }), () =>
          provider.create('ProxyRule', TYPE, PROXY_RULE)
        ).catch((e: unknown) => e);
        expect((error as Error).message).toMatch(/already exists on security group/);
      });

      it("the resource's OWN logical id", () => refuses({ ProxyRule: ingressRecord(EXPLICIT_RULE) }));

      it('a record of another type carrying the same properties', () =>
        refuses({ Other: { ...ingressRecord(EXPLICIT_RULE), resourceType: 'AWS::EC2::SecurityGroupEgress' } }));

      it("another group's record declaring the rule inline", () =>
        refuses({
          OtherGroup: {
            physicalId: 'sg-0ccccccccccccccc0',
            resourceType: 'AWS::EC2::SecurityGroup',
            properties: {
              SecurityGroupIngress: [
                { IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, SourceSecurityGroupId: GROUP_ID },
              ],
            },
            attributes: {},
            dependencies: [],
          } as ResourceState,
        }));

      it('a sibling whose ports are unreadable, against a desired rule whose ports are too', async () => {
        // Both identities would serialize a NaN port as `null` and compare
        // equal; an unreadable port pairs with nothing.
        const malformed = { ...PROXY_RULE, FromPort: 'x', ToPort: 'x' };
        const error = await withStackRecords(
          // `{}` attributes: no recorded id, so only the port guard can refuse.
          view({ ExplicitRule: ingressRecord({ ...EXPLICIT_RULE, FromPort: 'y', ToPort: 'y' }, {}) }),
          () => provider.create('ProxyRule', TYPE, malformed)
        ).catch((e: unknown) => e);
        expect((error as Error).message).toMatch(/already exists on security group/);
      });

      it('a holder only among the survivors: the create reads the LIVE records', async () => {
        // A view whose two halves disagree shows which one the create reads.
        const error = await withStackRecords(view({}, { ExplicitRule: ingressRecord(EXPLICIT_RULE) }), () =>
          provider.create('ProxyRule', TYPE, PROXY_RULE)
        ).catch((e: unknown) => e);
        expect((error as Error).message).toMatch(/already exists on security group/);
      });
    });
  });

  describe('create: a twin dispatched beside this one, still in flight, is waited for', () => {
    /** A view whose `live` bag the test fills when the in-flight twin settles. */
    const racing = (twinProps: Record<string, unknown> | undefined) => {
      const live: Record<string, ResourceState> = {};
      let settle!: (ok: boolean) => void;
      const settled = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const records: StackRecordsView = {
        live: () => Object.entries(live),
        survivors: () => Object.entries(live),
        inFlight: () => [
          { logicalId: 'ExplicitRule', resourceType: TYPE, properties: () => twinProps, settled },
        ],
        waiting: new Set<string>(),
      };
      return { live, settle, records };
    };

    /** Until the create is parked on its twin: proves the wait arm is what runs. */
    const parked = async (records: StackRecordsView): Promise<void> => {
      for (let i = 0; i < 100 && !records.waiting!.has('ProxyRule'); i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(records.waiting!.has('ProxyRule')).toBe(true);
    };

    it('adopts once the twin settles and its record holds the live rule', async () => {
      const { live, settle, records } = racing({ ...EXPLICIT_RULE });
      const creating = withStackRecords(records, () => provider.create('ProxyRule', TYPE, PROXY_RULE));
      await parked(records);
      live['ExplicitRule'] = ingressRecord(EXPLICIT_RULE);
      settle(true);

      await expect(creating).resolves.toEqual({ physicalId: PHYSICAL_ID, attributes: { Id: RULE_ID } });
      expect(infoLines().some((l) => l.includes('created in this deploy and is held by ExplicitRule of this stack'))).toBe(true);
    });

    it('refuses when the twin FAILS, even if a record of it is live', async () => {
      // A failed write can still leave a record (a partial create); its
      // failure, not the record, decides.
      const { live, settle, records } = racing({ ...EXPLICIT_RULE });
      const creating = withStackRecords(records, () => provider.create('ProxyRule', TYPE, PROXY_RULE));
      await parked(records);
      live['ExplicitRule'] = ingressRecord(EXPLICIT_RULE);
      settle(false);

      await expect(creating).rejects.toThrow(/already exists on security group/);
    });

    it('refuses when the settled twin records another rule id than the live one', async () => {
      const { live, settle, records } = racing({ ...EXPLICIT_RULE });
      const creating = withStackRecords(records, () => provider.create('ProxyRule', TYPE, PROXY_RULE));
      live['ExplicitRule'] = ingressRecord(EXPLICIT_RULE, { Id: 'sgr-0fffffffffffffff0' });
      settle(true);

      await expect(creating).rejects.toThrow(/already exists on security group/);
    });

    it('adopts a third record holding the live rule that settled while it waited, though the twin records a stale id', async () => {
      // Decided: after the wait, ANY live record holding the live rule is the
      // stack's evidence, exactly as on the first ask.
      const { live, settle, records } = racing({ ...EXPLICIT_RULE });
      const creating = withStackRecords(records, () => provider.create('ProxyRule', TYPE, PROXY_RULE));
      await parked(records);
      live['ExplicitRule'] = ingressRecord(EXPLICIT_RULE, { Id: 'sgr-0fffffffffffffff0' });
      live['ThirdRule'] = ingressRecord({ ...EXPLICIT_RULE, Description: 'third' });
      settle(true);

      await expect(creating).resolves.toMatchObject({ attributes: { Id: RULE_ID } });
      expect(infoLines().some((l) => l.includes('is held by ThirdRule of this stack'))).toBe(true);
    });

    it('does not wait on an in-flight SecurityGroupEgress with an identical bag', async () => {
      const records: StackRecordsView = {
        live: () => [],
        survivors: () => [],
        // Never settles: waiting on it would hang the test.
        inFlight: () => [
          {
            logicalId: 'Egress',
            resourceType: 'AWS::EC2::SecurityGroupEgress',
            properties: () => ({ ...EXPLICIT_RULE }),
            settled: new Promise<boolean>(() => undefined),
          },
        ],
        waiting: new Set<string>(),
      };

      await expect(
        withStackRecords(records, () => provider.create('ProxyRule', TYPE, PROXY_RULE))
      ).rejects.toThrow(/already exists on security group/);
    });

    it.each([
      ['a twin describing another rule', { ...EXPLICIT_RULE, FromPort: 3307, ToPort: 3307 }],
      ['a twin whose properties are not resolved yet', undefined],
    ])('does not wait on %s', async (_what, props) => {
      const { records } = racing(props);
      // The twin never settles: waiting on it would hang the test.
      await expect(
        withStackRecords(records, () => provider.create('ProxyRule', TYPE, PROXY_RULE))
      ).rejects.toThrow(/already exists on security group/);
    });

    it('two writes that both met a rule neither made do not wait on each other', async () => {
      // Each is the other's in-flight twin; the first to look waits, the
      // second sees it waiting and refuses, which settles the first.
      const waiting = new Set<string>();
      const live: Record<string, ResourceState> = {};
      const settles: Record<string, (ok: boolean) => void> = {};
      const entry = (logicalId: string, props: Record<string, unknown>) => ({
        logicalId,
        resourceType: TYPE,
        properties: () => props,
        settled: new Promise<boolean>((resolve) => {
          settles[logicalId] = resolve;
        }),
      });
      const entries = [entry('A', PROXY_RULE), entry('B', EXPLICIT_RULE)];
      const records: StackRecordsView = {
        live: () => Object.entries(live),
        survivors: () => Object.entries(live),
        inFlight: () => entries,
        waiting,
      };
      const run = (lid: string, props: Record<string, unknown>) =>
        withStackRecords(records, () => provider.create(lid, TYPE, props)).then(
          () => settles[lid]!(true),
          (e: unknown) => {
            settles[lid]!(false);
            throw e;
          }
        );

      const results = await Promise.allSettled([run('A', PROXY_RULE), run('B', EXPLICIT_RULE)]);

      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      expect(waiting.size).toBe(0);
    });
  });

  describe('delete: a rule a surviving record of the stack holds is left in place', () => {
    it('revokes nothing while a surviving sibling holds the rule', async () => {
      const result = await withStackRecords(view({ ExplicitRule: ingressRecord(EXPLICIT_RULE) }), () =>
        provider.delete('ProxyRule', PHYSICAL_ID, TYPE, PROXY_RULE, { recordedAttributes: { Id: RULE_ID } })
      );

      expect(result).toBeUndefined();
      expect(revokes()).toHaveLength(0);
      expect(infoLines().some((l) => l.includes('also held by ExplicitRule of this stack'))).toBe(true);
    });

    it("revokes nothing while the group's own record declares the rule inline", async () => {
      const group = {
        physicalId: GROUP_ID,
        resourceType: 'AWS::EC2::SecurityGroup',
        properties: {
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, SourceSecurityGroupId: GROUP_ID },
          ],
        },
        attributes: {},
        dependencies: [],
      } as ResourceState;

      await withStackRecords(view({ DbGroup: group }), () =>
        provider.delete('ProxyRule', PHYSICAL_ID, TYPE, PROXY_RULE, { recordedAttributes: { Id: RULE_ID } })
      );

      expect(revokes()).toHaveLength(0);
    });

    it('revokes when the holder is live but does NOT survive (a concurrent delete of the same operation)', async () => {
      await withStackRecords(view({ ExplicitRule: ingressRecord(EXPLICIT_RULE) }, {}), () =>
        provider.delete('ProxyRule', PHYSICAL_ID, TYPE, PROXY_RULE, { recordedAttributes: { Id: RULE_ID } })
      );

      expect(revokes().map((c) => c.input)).toEqual([{ GroupId: GROUP_ID, SecurityGroupRuleIds: [RULE_ID] }]);
    });

    it('revokes when the surviving records hold a different rule', async () => {
      await withStackRecords(view({ ExplicitRule: ingressRecord({ ...EXPLICIT_RULE, FromPort: 3307, ToPort: 3307 }) }), () =>
        provider.delete('ProxyRule', PHYSICAL_ID, TYPE, PROXY_RULE, { recordedAttributes: { Id: RULE_ID } })
      );

      expect(revokes()).toHaveLength(1);
    });

    it('revokes when the only matching record is its own', async () => {
      await withStackRecords(view({ ProxyRule: ingressRecord(PROXY_RULE) }), () =>
        provider.delete('ProxyRule', PHYSICAL_ID, TYPE, PROXY_RULE, { recordedAttributes: { Id: RULE_ID } })
      );

      expect(revokes()).toHaveLength(1);
    });

    it('revokes with no view bound', async () => {
      await provider.delete('ProxyRule', PHYSICAL_ID, TYPE, PROXY_RULE, { recordedAttributes: { Id: RULE_ID } });

      expect(revokes()).toHaveLength(1);
    });

    it('a redacted source never pairs: two masked records are skipped as redacted, not shared', async () => {
      // Both `***`: equal on paper, while the real ranges may differ. The
      // redacted-address skip keeps the record; sharing would drop it and
      // leave its live rule unrecorded.
      const masked = { ...PROXY_RULE, SourceSecurityGroupId: undefined, CidrIp: '***' };
      const result = await withStackRecords(view({ ExplicitRule: ingressRecord({ ...masked, Description: 'x' }) }), () =>
        provider.delete('ProxyRule', PHYSICAL_ID, TYPE, masked)
      );

      expect(result).toMatchObject({ outcome: 'skipped' });
      expect(infoLines().some((l) => l.includes('also held by'))).toBe(false);
    });

    it('a redacted holder does not hold a rule this record describes in full', async () => {
      await withStackRecords(
        view({ ExplicitRule: ingressRecord({ ...EXPLICIT_RULE, SourceSecurityGroupOwnerId: '***' }) }),
        () =>
          provider.delete('ProxyRule', PHYSICAL_ID, TYPE, PROXY_RULE, {
            recordedAttributes: { Id: RULE_ID },
          })
      );

      expect(infoLines().some((l) => l.includes('also held by'))).toBe(false);
      expect(revokes()).toHaveLength(1);
    });

    it('a redacted group never pairs either', async () => {
      await withStackRecords(view({ ExplicitRule: ingressRecord({ ...EXPLICIT_RULE, GroupId: '***' }) }), () =>
        provider.delete('ProxyRule', '***|tcp|3306|3306', TYPE, { ...PROXY_RULE, GroupId: '***' }, {
          recordedAttributes: { Id: RULE_ID },
        })
      );

      expect(infoLines().some((l) => l.includes('also held by'))).toBe(false);
    });

    it('a record with no properties cannot be matched, so the delete revokes as before', async () => {
      await withStackRecords(view({ ExplicitRule: ingressRecord(EXPLICIT_RULE) }), () =>
        provider.delete('ProxyRule', PHYSICAL_ID, TYPE, undefined, { recordedAttributes: { Id: RULE_ID } })
      );

      expect(revokes()).toHaveLength(1);
    });

    it('the last holder revokes, and a second revoke finding the rule gone is success', async () => {
      // Two deletes of one operation (a destroy): the first revokes; the
      // second finds the id gone and no live rule left, which is "deleted".
      let revoked = false;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof RevokeSecurityGroupIngressCommand) {
          if (revoked) {
            return Promise.reject(
              Object.assign(new Error('The specified rule does not exist in this security group.'), {
                name: 'InvalidPermission.NotFound',
              })
            );
          }
          revoked = true;
          return Promise.resolve({ Return: true });
        }
        if (command instanceof DescribeSecurityGroupRulesCommand) {
          return Promise.resolve({ SecurityGroupRules: [] });
        }
        return Promise.resolve({});
      });
      const none = view({ ExplicitRule: ingressRecord(EXPLICIT_RULE), ProxyRule: ingressRecord(PROXY_RULE) }, {});

      const first = await withStackRecords(none, () =>
        provider.delete('ExplicitRule', PHYSICAL_ID, TYPE, EXPLICIT_RULE, { recordedAttributes: { Id: RULE_ID } })
      );
      const second = await withStackRecords(none, () =>
        provider.delete('ProxyRule', PHYSICAL_ID, TYPE, PROXY_RULE, { recordedAttributes: { Id: RULE_ID } })
      );

      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(revokes()).toHaveLength(2);
      expect(childLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe("a group update dropping an inline rule a standalone record of the stack holds", () => {
    const INLINE = { IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, SourceSecurityGroupId: GROUP_ID };
    const update = () =>
      provider.update(
        'DbGroup',
        GROUP_ID,
        'AWS::EC2::SecurityGroup',
        { GroupDescription: 'db', SecurityGroupIngress: [] },
        { GroupDescription: 'db', SecurityGroupIngress: [INLINE] }
      );

    it('leaves the rule in place', async () => {
      await withStackRecords(view({ ProxyRule: ingressRecord(PROXY_RULE) }), update);

      expect(revokes()).toHaveLength(0);
      expect(infoLines().some((l) => l.includes('also held by ProxyRule of this stack'))).toBe(true);
    });

    it('revokes it when that record does not survive, or nothing holds it', async () => {
      await withStackRecords(view({ ProxyRule: ingressRecord(PROXY_RULE) }, {}), update);
      await update();

      expect(revokes()).toHaveLength(2);
    });
  });

  it('update: a description change of a shared rule leaves the rule and records it, revoking nothing', async () => {
    const result = await withStackRecords(view({ ExplicitRule: ingressRecord(EXPLICIT_RULE) }), () =>
      provider.update(
        'ProxyRule',
        PHYSICAL_ID,
        TYPE,
        { ...PROXY_RULE, Description: 'renamed' },
        PROXY_RULE,
        { recordedAttributes: { Id: RULE_ID } }
      )
    );

    expect(revokes()).toHaveLength(0);
    // Nothing re-authorized either: the shared rule is left exactly as it is.
    expect(mockSend.mock.calls.some((c) => c[0] instanceof AuthorizeSecurityGroupIngressCommand)).toBe(false);
    expect(result).toMatchObject({ physicalId: PHYSICAL_ID, attributes: { Id: RULE_ID } });
    expect(infoLines().some((l) => l.includes('the update left it in place'))).toBe(true);
  });

  it('update: a change of the rule itself is never kept for a holder of the OLD rule', async () => {
    // Every identity key is create-only, so only a caller without a diff
    // (drift --revert) reaches this; the early return must not swallow it.
    mockSend.mockImplementation((command: unknown) =>
      command instanceof AuthorizeSecurityGroupIngressCommand
        ? Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-0ddddddddddddddd0' }] })
        : Promise.resolve({ Return: true })
    );

    await withStackRecords(view({ ExplicitRule: ingressRecord(EXPLICIT_RULE) }), () =>
      provider.update('ProxyRule', PHYSICAL_ID, TYPE, { ...PROXY_RULE, FromPort: 3307, ToPort: 3307 }, PROXY_RULE, {
        recordedAttributes: { Id: RULE_ID },
      })
    );

    expect(mockSend.mock.calls.some((c) => c[0] instanceof AuthorizeSecurityGroupIngressCommand)).toBe(true);
  });

  it('update: a holder recording ANOTHER rule id is no holder, so the update revokes and re-authorizes', async () => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof AuthorizeSecurityGroupIngressCommand
        ? Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-0ddddddddddddddd0' }] })
        : Promise.resolve({ Return: true })
    );

    const result = await withStackRecords(
      view({ ExplicitRule: ingressRecord(EXPLICIT_RULE, { Id: 'sgr-0fffffffffffffff0' }) }),
      () =>
        provider.update('ProxyRule', PHYSICAL_ID, TYPE, { ...PROXY_RULE, Description: 'renamed' }, PROXY_RULE, {
          recordedAttributes: { Id: RULE_ID },
        })
    );

    expect(revokes().map((c) => c.input)).toEqual([{ GroupId: GROUP_ID, SecurityGroupRuleIds: [RULE_ID] }]);
    expect(result).toMatchObject({ attributes: { Id: 'sgr-0ddddddddddddddd0' } });
  });
});

describe('EC2Provider SecurityGroupIngress: the delete and group-update holder edges (#4492)', () => {
  const TYPE = 'AWS::EC2::SecurityGroupIngress';
  const GROUP_ID = 'sg-0123456789abcdef0';
  const RULE_ID = 'sgr-0a1b2c3d4e5f60718';
  const PHYSICAL_ID = `${GROUP_ID}|tcp|3306|3306`;
  const RULE = { GroupId: GROUP_ID, IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, SourceSecurityGroupId: GROUP_ID };
  const rec = (attributes: Record<string, unknown>, properties: Record<string, unknown> = RULE): ResourceState =>
    ({ physicalId: PHYSICAL_ID, resourceType: TYPE, properties, attributes, dependencies: [] }) as ResourceState;
  const group = (inline: unknown[]): ResourceState =>
    ({
      physicalId: GROUP_ID,
      resourceType: 'AWS::EC2::SecurityGroup',
      properties: { SecurityGroupIngress: inline },
      attributes: {},
      dependencies: [],
    }) as ResourceState;
  const view = (records: Record<string, ResourceState>): StackRecordsView => ({
    live: () => Object.entries(records),
    survivors: () => Object.entries(records),
  });
  let provider: EC2Provider;
  const revokes = () =>
    mockSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is RevokeSecurityGroupIngressCommand => c instanceof RevokeSecurityGroupIngressCommand);

  beforeEach(() => {
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new EC2Provider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof AuthorizeSecurityGroupIngressCommand) {
        return Promise.reject(Object.assign(new Error('the specified rule already exists'), { name: 'InvalidPermission.Duplicate' }));
      }
      if (command instanceof DescribeSecurityGroupRulesCommand) {
        return Promise.resolve({
          SecurityGroupRules: [
            { SecurityGroupRuleId: RULE_ID, IsEgress: false, IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, ReferencedGroupInfo: { GroupId: GROUP_ID } },
          ],
        });
      }
      return Promise.resolve({ Return: true });
    });
  });

  const del = (records: Record<string, ResourceState>, ownId?: string) =>
    withStackRecords(view(records), () =>
      provider.delete('Self', PHYSICAL_ID, TYPE, RULE, ownId === undefined ? undefined : { recordedAttributes: { Id: ownId } })
    );

  it.each([
    ['both record the same id', RULE_ID, { Id: RULE_ID }, 0],
    ['the holder records none', RULE_ID, {}, 0],
    ['this record has none', undefined, { Id: RULE_ID }, 0],
    ['the holder records ANOTHER id: no holder, so the rule is revoked', RULE_ID, { Id: 'sgr-0fffffffffffffff0' }, 1],
    ["the holder's id is not sgr- shaped (a mask), so it is not compared", RULE_ID, { Id: '***' }, 0],
  ])('delete: %s', async (_what, ownId, holderAttributes, expected) => {
    await del({ Twin: rec(holderAttributes) }, ownId);

    expect(revokes()).toHaveLength(expected);
  });

  it("delete: the group's inline rule must BE the rule — a different port or source holds nothing", async () => {
    await del({ DbGroup: group([{ ...RULE, GroupId: undefined, FromPort: 3307, ToPort: 3307 }]) }, RULE_ID);
    await del({ DbGroup: group([{ ...RULE, GroupId: undefined, SourceSecurityGroupId: 'sg-0aaaaaaaaaaaaaaa0' }]) }, RULE_ID);

    expect(revokes()).toHaveLength(2);
  });

  it("create: the group's differing inline rule holds nothing, so the duplicate is refused", async () => {
    const error = await withStackRecords(
      view({ DbGroup: group([{ ...RULE, GroupId: undefined, FromPort: 3307, ToPort: 3307 }]) }),
      () => provider.create('Self', TYPE, RULE)
    ).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(/already exists on security group/);
  });

  it('group update: an EGRESS rule dropped beside a matching standalone ingress record is still revoked', async () => {
    // Same protocol, ports and CidrIp: by identity alone the ingress record
    // would "hold" it. The egress diff passes the group's logical id too, so
    // only the direction guard keeps the revoke.
    const egress = { IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, CidrIp: '10.0.0.0/8' };
    const ingress = { GroupId: GROUP_ID, IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, CidrIp: '10.0.0.0/8' };
    await withStackRecords(view({ Twin: rec({ Id: RULE_ID }, ingress) }), () =>
      provider.update(
        'DbGroup',
        GROUP_ID,
        'AWS::EC2::SecurityGroup',
        { SecurityGroupEgress: [] },
        { SecurityGroupEgress: [egress] }
      )
    );

    expect(mockSend.mock.calls.some((c) => c[0] instanceof RevokeSecurityGroupEgressCommand)).toBe(true);
  });

  it("delete: a stale recorded id never revokes the live rule a surviving twin records", async () => {
    // Self records the stale sgr-1; the twin records the live sgr-2, with the
    // same identity, and so is no holder under the own-id check. The revoke by
    // sgr-1 finds nothing; the fallback finds sgr-2 under self's description,
    // which is the twin's rule, so it is left.
    const LIVE = 'sgr-0bbbbbbbbbbbbbbb0';
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof RevokeSecurityGroupIngressCommand) {
        return Promise.reject(
          Object.assign(new Error('The specified rule does not exist in this security group.'), {
            name: 'InvalidPermission.NotFound',
          })
        );
      }
      if (command instanceof DescribeSecurityGroupRulesCommand) {
        return Promise.resolve({
          SecurityGroupRules: [
            {
              SecurityGroupRuleId: LIVE,
              IsEgress: false,
              IpProtocol: 'tcp',
              FromPort: 3306,
              ToPort: 3306,
              ReferencedGroupInfo: { GroupId: GROUP_ID },
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    const result = await withStackRecords(view({ Twin: rec({ Id: LIVE }) }), () =>
      provider.delete('Self', PHYSICAL_ID, TYPE, RULE, { recordedAttributes: { Id: RULE_ID } })
    );

    expect(result).toBeUndefined();
    expect(revokes().map((c) => c.input.SecurityGroupRuleIds)).toEqual([[RULE_ID]]);
  });

  it('delete: a twin recording the live id that is live but NOT a survivor (deleted in the same operation) keeps nothing', async () => {
    const LIVE = 'sgr-0bbbbbbbbbbbbbbb0';
    let call = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof RevokeSecurityGroupIngressCommand) {
        return call++ === 0
          ? Promise.reject(Object.assign(new Error('does not exist'), { name: 'InvalidPermission.NotFound' }))
          : Promise.resolve({ Return: true });
      }
      if (command instanceof DescribeSecurityGroupRulesCommand) {
        return Promise.resolve({
          SecurityGroupRules: [
            { SecurityGroupRuleId: LIVE, IsEgress: false, IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, ReferencedGroupInfo: { GroupId: GROUP_ID } },
          ],
        });
      }
      return Promise.resolve({});
    });
    const twin = { Twin: rec({ Id: LIVE }) };
    const leaving: StackRecordsView = { live: () => Object.entries(twin), survivors: () => [] };

    await withStackRecords(leaving, () =>
      provider.delete('Self', PHYSICAL_ID, TYPE, RULE, { recordedAttributes: { Id: RULE_ID } })
    );

    expect(revokes().map((c) => c.input.SecurityGroupRuleIds)).toEqual([[RULE_ID], [LIVE]]);
  });

  it('delete: with no surviving record of the live id, the stale-id fallback still revokes it', async () => {
    const LIVE = 'sgr-0bbbbbbbbbbbbbbb0';
    let call = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof RevokeSecurityGroupIngressCommand) {
        return call++ === 0
          ? Promise.reject(Object.assign(new Error('does not exist'), { name: 'InvalidPermission.NotFound' }))
          : Promise.resolve({ Return: true });
      }
      if (command instanceof DescribeSecurityGroupRulesCommand) {
        return Promise.resolve({
          SecurityGroupRules: [
            { SecurityGroupRuleId: LIVE, IsEgress: false, IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, ReferencedGroupInfo: { GroupId: GROUP_ID } },
          ],
        });
      }
      return Promise.resolve({});
    });

    await withStackRecords(view({ Other: rec({ Id: 'sgr-0ccccccccccccccc0' }, { ...RULE, FromPort: 22, ToPort: 22 }) }), () =>
      provider.delete('Self', PHYSICAL_ID, TYPE, RULE, { recordedAttributes: { Id: RULE_ID } })
    );

    expect(revokes().map((c) => c.input.SecurityGroupRuleIds)).toEqual([[RULE_ID], [LIVE]]);
  });

  it('update: an identity change whose OLD rule a surviving twin holds revokes nothing and never claims it did', async () => {
    const error = await withStackRecords(view({ Twin: rec({ Id: RULE_ID }) }), () =>
      provider.update('Self', PHYSICAL_ID, TYPE, { ...RULE, FromPort: 3307, ToPort: 3307 }, RULE, {
        recordedAttributes: { Id: RULE_ID },
      })
    ).catch((e: unknown) => e);

    expect(revokes()).toHaveLength(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/already exists on security group/);
    expect((error as Error).message).not.toContain('already been revoked');
  });

  it('group update: of two dropped inline rules only the held one stays; the other is revoked', async () => {
    const held = { IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, SourceSecurityGroupId: GROUP_ID };
    const free = { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '10.0.0.0/8' };
    await withStackRecords(view({ Twin: rec({ Id: RULE_ID }) }), () =>
      provider.update('DbGroup', GROUP_ID, 'AWS::EC2::SecurityGroup', { SecurityGroupIngress: [] }, {
        SecurityGroupIngress: [held, free],
      })
    );

    const revoked = revokes().map((c) => JSON.stringify(c.input));
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toContain('10.0.0.0/8');
  });
});
