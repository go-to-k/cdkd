import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupRulesCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.hoisted(() => vi.fn());
/** Commands sent through the single-send client (no SDK retries). */
const singleSent = vi.hoisted(() => [] as unknown[]);

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2SingleSend: {
      send: (command: unknown) => {
        singleSent.push(command);
        return mockSend(command);
      },
      config: { region: () => Promise.resolve('us-east-1') },
    },
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
import {
  isRefusedBeforeApplying,
  priorAttemptLookup,
  withPriorAttempts,
} from '../../../src/deployment/prior-attempt-scope.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { recordAfterRollbackUpdate } from '../../../src/deployment/rollback-executor/replay-retry.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#4355: `AuthorizeSecurityGroupIngress` answers
 * `InvalidPermission.Duplicate` both for a rule an interrupted run of THIS
 * stack left behind and for an identical rule another owner added. The create
 * used to adopt either, so `cdkd destroy` revoked the other owner's rule. It
 * now adopts only a rule this stack's rollback journal shows it attempted (or
 * a rollback replay's), and refuses anything else, naming the existing rule.
 */
describe('EC2Provider SecurityGroupIngress duplicate ownership (#4355)', () => {
  const TYPE = 'AWS::EC2::SecurityGroupIngress';
  const GROUP_ID = 'sg-0123456789abcdef0';
  const RULE_ID = 'sgr-0a1b2c3d4e5f60718';
  const PROPS = Object.freeze({
    GroupId: GROUP_ID,
    IpProtocol: 'tcp',
    FromPort: 5432,
    ToPort: 5432,
    CidrIp: '10.0.0.0/16',
  }) as Record<string, unknown>;

  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    singleSent.length = 0;
    childLogger.child.mockReturnValue(childLogger);
    provider = new EC2Provider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof AuthorizeSecurityGroupIngressCommand) {
        return Promise.reject(
          Object.assign(
            new Error(
              'the specified rule "peer: 10.0.0.0/16, TCP, from port: 5432, to port: 5432, ALLOW" already exists'
            ),
            { name: 'InvalidPermission.Duplicate' }
          )
        );
      }
      if (command instanceof DescribeSecurityGroupRulesCommand) {
        return Promise.resolve({
          SecurityGroupRules: [
            {
              SecurityGroupRuleId: RULE_ID,
              IsEgress: false,
              IpProtocol: 'tcp',
              FromPort: 5432,
              ToPort: 5432,
              CidrIpv4: '10.0.0.0/16',
            },
          ],
        });
      }
      return Promise.resolve({});
    });
  });

  const journaled = (bags: Array<Record<string, unknown>>, logicalId = 'Rule') => {
    const attempts = vi.fn(() => Promise.resolve(bags));
    return { ...priorAttemptLookup(logicalId, attempts), attempts };
  };

  const sent = () => mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);

  const awsError = (name: string, httpStatusCode: number, attempts = 1) =>
    Object.assign(new Error(`${name} from EC2`), {
      name,
      $metadata: { httpStatusCode, requestId: 'req-test', attempts },
    });

  describe('refuses a rule this stack has no record of', () => {
    it('with no evidence bound (a caller outside a deploy)', async () => {
      const error = await provider.create('Rule', TYPE, PROPS).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(`rule ${RULE_ID} already exists on security group ${GROUP_ID}`);
      expect(message).toContain("'cdkd destroy' would then revoke");
      expect(message).toContain(
        `aws ec2 revoke-security-group-ingress --group-id ${GROUP_ID} --security-group-rule-ids ${RULE_ID}`
      );
      expect(isMarkedNonRetryable(error)).toBe(true);
      // So the engine journals the failed op WITHOUT this bag, and the next
      // deploy does not read the refusal itself as this stack's prior attempt.
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(true);
      expect(message).not.toContain('This was an update');
    });

    it('when the journal holds no attempt for the logical id', async () => {
      const lookup = journaled([]);
      await expect(
        withPriorAttempts(lookup, () => provider.create('Rule', TYPE, PROPS))
      ).rejects.toThrow(/nothing in this stack's records shows cdkd created it/);
      expect(lookup.attempts).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['source', { CidrIp: '10.0.0.0/8' }],
      ['port', { FromPort: 5433, ToPort: 5433 }],
      ['protocol', { IpProtocol: 'udp' }],
      ['group', { GroupId: 'sg-0fffffffffffffff0' }],
      ['FromPort only', { FromPort: 5431 }],
      ['ToPort only', { ToPort: 5433 }],
      ['source family (IPv6 instead of IPv4)', { CidrIp: undefined, CidrIpv6: '2001:db8::/32' }],
      ['source family (prefix list instead of IPv4)', { CidrIp: undefined, SourcePrefixListId: 'pl-0123456789abcdef0' }],
      ['source family (security group instead of IPv4)', { CidrIp: undefined, SourceSecurityGroupId: 'sg-0aaaaaaaaaaaaaaa0' }],
    ])('when the journaled attempt was a rule with a different %s', async (_what, patch) => {
      await expect(
        withPriorAttempts(journaled([{ ...PROPS, ...patch }]), () =>
          provider.create('Rule', TYPE, PROPS)
        )
      ).rejects.toThrow(/already exists on security group/);
    });

    it.each([
      ['IPv6 range', { CidrIpv6: '2001:db8::/32' }, { CidrIpv6: '2001:db8:1::/48' }],
      ['prefix list', { SourcePrefixListId: 'pl-0aaaaaaaaaaaaaaa0' }, { SourcePrefixListId: 'pl-0bbbbbbbbbbbbbbb0' }],
      ['source group name', { SourceSecurityGroupName: 'alpha' }, { SourceSecurityGroupName: 'beta' }],
    ])('when the journaled attempt named a different %s of the same source family', async (_what, wanted, journaledSource) => {
      const base = { GroupId: GROUP_ID, IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432 };
      await expect(
        withPriorAttempts(journaled([{ ...base, ...journaledSource }]), () =>
          provider.create('Rule', TYPE, { ...base, ...wanted })
        )
      ).rejects.toThrow(/already exists on security group/);
    });

    it('when the evidence is bound for ANOTHER logical id', async () => {
      await expect(
        withPriorAttempts(journaled([{ ...PROPS }], 'OtherRule'), () =>
          provider.create('Rule', TYPE, PROPS)
        )
      ).rejects.toThrow(/already exists on security group/);
    });

    it('when the journal cannot be read — and says so', async () => {
      const lookup = priorAttemptLookup('Rule', () =>
        Promise.reject(new Error('AccessDenied: s3:GetObject'))
      );
      await expect(
        withPriorAttempts(lookup, () => provider.create('Rule', TYPE, PROPS))
      ).rejects.toThrow(/rollback journal could not be read: .*AccessDenied/);
    });

    it('withholds an AWS-authored journal read failure from the thrown message', async () => {
      // The message is persisted to the deployment events store; an S3
      // AccessDenied names the caller's role ARN and the bucket key.
      const arn = 'arn:aws:sts::123456789012:assumed-role/deployer/session';
      const lookup = priorAttemptLookup('Rule', () =>
          Promise.reject(
            Object.assign(new Error(`User: ${arn} is not authorized to perform: s3:GetObject`), {
              name: 'AccessDenied',
              $metadata: { httpStatusCode: 403, requestId: 'req-test' },
            })
          ),
      );

      const error = (await withPriorAttempts(lookup, () =>
        provider.create('Rule', TYPE, PROPS)
      ).catch((e: unknown) => e)) as Error;

      expect(error.message).toMatch(/rollback journal could not be read/);
      expect(error.message).not.toContain(arn);
    });

    it('without a revoke command when the existing rule id cannot be found', async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof AuthorizeSecurityGroupIngressCommand
          ? Promise.reject(new Error('the specified rule already exists'))
          : Promise.resolve({ SecurityGroupRules: [] })
      );

      const error = (await provider.create('Rule', TYPE, PROPS).catch((e: unknown) => e)) as Error;

      expect(error.message).toContain(`an identical rule already exists on security group ${GROUP_ID}`);
      expect(error.message).not.toContain('revoke-security-group-ingress');
    });

    it('on the UPDATE path names the recorded sgr- id of the revoked rule', async () => {
      const error = (await withPriorAttempts(journaled([]), () =>
        provider.update(
          'Rule',
          `${GROUP_ID}|tcp|5432|5432`,
          TYPE,
          PROPS,
          { ...PROPS, CidrIp: '172.16.0.0/12' },
          { recordedAttributes: { Id: 'sgr-0ccccccccccccccc0' } }
        )
      ).catch((e: unknown) => e)) as Error;

      expect(error.message).toContain('the previous rule (sgr-0ccccccccccccccc0) has already been revoked');
    });

    it('on the UPDATE path outside a deploy names no --revert-failed remedy (drift --revert)', async () => {
      const error = (await provider
        .update('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS, { ...PROPS, CidrIp: '172.16.0.0/12' })
        .catch((e: unknown) => e)) as Error;

      expect(error.message).toContain('has already been revoked');
      expect(error.message).not.toContain('--revert-failed');
    });

    it('on the UPDATE path, after the old rule was revoked', async () => {
      const error = await withPriorAttempts(journaled([]), () =>
        provider.update('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS, {
          ...PROPS,
          CidrIp: '172.16.0.0/12',
        })
      ).catch((e: unknown) => e);

      expect(sent()).toContain('RevokeSecurityGroupIngressCommand');
      expect((error as Error).message).toMatch(/already exists on security group/);
      expect((error as Error).message).toContain(
        `the previous rule (${GROUP_ID}|tcp|5432|5432) has already been revoked`
      );
      expect((error as Error).message).toContain("'cdkd rollback <stack> --revert-failed'");
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(true);
    });
  });

  describe('an SG-to-SG rule (the common CDK `connections.allowFrom` shape)', () => {
    const SG_PROPS = Object.freeze({
      GroupId: GROUP_ID,
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      SourceSecurityGroupId: 'sg-0aaaaaaaaaaaaaaa0',
    }) as Record<string, unknown>;

    it.each([
      ['source group', { SourceSecurityGroupId: 'sg-0bbbbbbbbbbbbbbb0' }],
      ['source group owner', { SourceSecurityGroupOwnerId: '210987654321' }],
      ['source group name', { SourceSecurityGroupId: undefined, SourceSecurityGroupName: 'other' }],
    ])('refuses when the journaled attempt named a different %s', async (_what, patch) => {
      await expect(
        withPriorAttempts(journaled([{ ...SG_PROPS, ...patch }]), () =>
          provider.create('Rule', TYPE, SG_PROPS)
        )
      ).rejects.toThrow(/already exists on security group/);
    });

    it('adopts when the journaled attempt named the same source group', async () => {
      const result = await withPriorAttempts(journaled([{ ...SG_PROPS }]), () =>
        provider.create('Rule', TYPE, SG_PROPS)
      );

      expect(result.physicalId).toBe(`${GROUP_ID}|tcp|5432|5432`);
    });
  });

  describe('adopts the rule this stack attempted before', () => {
    it('when the journal holds the same rule for the logical id', async () => {
      const result = await withPriorAttempts(journaled([{ ...PROPS }]), () =>
        provider.create('Rule', TYPE, PROPS)
      );

      expect(result.physicalId).toBe(`${GROUP_ID}|tcp|5432|5432`);
      expect(result.attributes).toEqual({ Id: RULE_ID });
    });

    it('when the matching bag is not the first the journal holds', async () => {
      const result = await withPriorAttempts(
        journaled([{ ...PROPS, CidrIp: '10.0.0.0/8' }, { ...PROPS, FromPort: 22, ToPort: 22 }, { ...PROPS }]),
        () => provider.create('Rule', TYPE, PROPS)
      );

      expect(result.attributes).toEqual({ Id: RULE_ID });
    });

    it('whatever description either side carries, and with the protocol spelled as its number', async () => {
      const result = await withPriorAttempts(
        journaled([{ ...PROPS, IpProtocol: '6', Description: 'old text' }]),
        () => provider.create('Rule', TYPE, { ...PROPS, Description: 'new text' })
      );

      expect(result.attributes).toEqual({ Id: RULE_ID });
    });

    it('on a rollback replay, which re-creates from a state record — logging the id at warn', async () => {
      const result = await provider.create('Rule', TYPE, PROPS, { replayingState: true });

      expect(result.attributes).toEqual({ Id: RULE_ID });
      expect(
        childLogger.warn.mock.calls.some((c) => String(c[0]).includes(`adopted the existing identical rule ${RULE_ID}`))
      ).toBe(true);
    });

    it('on the UPDATE path when the journal holds the new rule', async () => {
      const result = await withPriorAttempts(journaled([{ ...PROPS }]), () =>
        provider.update('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS, {
          ...PROPS,
          CidrIp: '172.16.0.0/12',
        })
      );

      expect(result.wasReplaced).toBe(true);
      expect(result.attributes).toEqual({ Id: RULE_ID });
    });

    it('re-authorizes on a replay whose two sides are equal (--revert-failed over a refused update)', async () => {
      // The refused update had already revoked the old rule and journaled no
      // attempted bag, so the revert passes the old rule on both sides. The
      // no-op short-circuit would report a restore that never happened.
      mockSend.mockImplementation((command: unknown) =>
        command instanceof AuthorizeSecurityGroupIngressCommand
          ? Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: RULE_ID }] })
          : Promise.reject(new Error('unexpected call'))
      );

      const result = await provider.update(
        'Rule',
        `${GROUP_ID}|tcp|5432|5432`,
        TYPE,
        PROPS,
        { ...PROPS },
        { replayingState: true }
      );

      expect(sent()).toEqual(['AuthorizeSecurityGroupIngressCommand']);
      expect(result.physicalId).toBe(`${GROUP_ID}|tcp|5432|5432`);
      // A re-created rule is a new rule: its attributes replace the record's.
      expect(result.wasReplaced).toBe(true);
      expect(result.attributes).toEqual({ Id: RULE_ID });
    });

    describe('a re-created rule whose Authorize response names no single id (#4484)', () => {
      const REVOKED_ID = 'sgr-0ffffffffffffffff';
      const RESTORED: ResourceState = {
        physicalId: `${GROUP_ID}|tcp|5432|5432`,
        resourceType: TYPE,
        properties: { ...PROPS },
        attributes: { Id: REVOKED_ID },
      };
      const replayWith = (authorized: unknown[], described: () => Promise<unknown>) => {
        mockSend.mockImplementation((command: unknown) => {
          if (command instanceof AuthorizeSecurityGroupIngressCommand) {
            return Promise.resolve({ SecurityGroupRules: authorized });
          }
          if (command instanceof DescribeSecurityGroupRulesCommand) return described();
          return Promise.reject(new Error('unexpected call'));
        });
        return provider.update(
          'Rule',
          `${GROUP_ID}|tcp|5432|5432`,
          TYPE,
          PROPS,
          { ...PROPS },
          { replayingState: true }
        );
      };
      const liveRule = (id: string) => ({
        SecurityGroupRuleId: id,
        IsEgress: false,
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        CidrIpv4: '10.0.0.0/16',
      });

      it.each([
        ['zero', []],
        [
          'two',
          [{ SecurityGroupRuleId: 'sgr-0000000000000000a' }, { SecurityGroupRuleId: 'sgr-0000000000000000b' }],
        ],
      ])('%s rules in the response: the new id is looked up by identity', async (_n, authorized) => {
        const result = await replayWith(authorized, () =>
          Promise.resolve({ SecurityGroupRules: [liveRule(RULE_ID)] })
        );

        expect(sent()).toEqual([
          'AuthorizeSecurityGroupIngressCommand',
          'DescribeSecurityGroupRulesCommand',
        ]);
        expect(result.wasReplaced).toBe(true);
        expect(recordAfterRollbackUpdate(RESTORED, result).attributes).toEqual({ Id: RULE_ID });
      });

      it.each([
        ['the lookup fails', () => Promise.reject(new Error('DescribeSecurityGroupRules throttled'))],
        [
          'two live rules match',
          () =>
            Promise.resolve({
              SecurityGroupRules: [liveRule(RULE_ID), liveRule('sgr-0000000000000000c')],
            }),
        ],
      ])('%s: the revoked id is dropped, not kept', async (_why, described) => {
        const result = await replayWith([], described);

        expect(result.wasReplaced).toBe(true);
        expect(result.attributes).toEqual({});
        const record = recordAfterRollbackUpdate(RESTORED, result);
        expect(record.attributes).toEqual({});
        expect(record.physicalId).toBe(RESTORED.physicalId);
      });

      it('an ADOPTED live rule whose id cannot be found keeps the recorded one (merged in place)', async () => {
        // The rule was never revoked, so the recorded id still names it.
        mockSend.mockImplementation((command: unknown) => {
          if (command instanceof AuthorizeSecurityGroupIngressCommand) {
            return Promise.reject(
              Object.assign(new Error('the specified rule already exists'), {
                name: 'InvalidPermission.Duplicate',
              })
            );
          }
          return Promise.reject(new Error('DescribeSecurityGroupRules throttled'));
        });

        const result = await provider.update(
          'Rule',
          `${GROUP_ID}|tcp|5432|5432`,
          TYPE,
          PROPS,
          { ...PROPS },
          { replayingState: true }
        );

        expect(result.wasReplaced).toBe(false);
        expect(recordAfterRollbackUpdate(RESTORED, result).attributes).toEqual({ Id: REVOKED_ID });
      });
    });

    it('adopts, never revokes, a LIVE rule on an equal-sides replay', async () => {
      // A failed update that never reached its revoke: the rule is intact, so
      // the Authorize answers Duplicate and the replay adopts it in place.
      const result = await provider.update(
        'Rule',
        `${GROUP_ID}|tcp|5432|5432`,
        TYPE,
        PROPS,
        { ...PROPS },
        { replayingState: true }
      );

      expect(sent()).not.toContain('RevokeSecurityGroupIngressCommand');
      expect(result.physicalId).toBe(`${GROUP_ID}|tcp|5432|5432`);
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({ Id: RULE_ID });
    });

    it('a definite 4xx on the equal-sides replay authorize is marked and nothing is revoked', async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof AuthorizeSecurityGroupIngressCommand
          ? Promise.reject(awsError('InvalidGroup.NotFound', 400))
          : Promise.reject(new Error('unexpected call'))
      );

      const error = await provider
        .update('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS, { ...PROPS }, { replayingState: true })
        .catch((e: unknown) => e);

      expect(sent()).toEqual(['AuthorizeSecurityGroupIngressCommand']);
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(true);
    });

    it('still short-circuits equal sides outside a replay (drift --revert)', async () => {
      const result = await provider.update('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS, {
        ...PROPS,
      });

      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('on a rollback replay of an UPDATE', async () => {
      const result = await provider.update(
        'Rule',
        `${GROUP_ID}|tcp|5432|5432`,
        TYPE,
        PROPS,
        { ...PROPS, CidrIp: '172.16.0.0/12' },
        { replayingState: true }
      );

      expect(result.attributes).toEqual({ Id: RULE_ID });
    });
  });

  it('refuses a retried create whose earlier attempt in this run ended ambiguously (a 5xx)', async () => {
    // The first Authorize may have landed, but nothing tells that rule from a
    // stranger's added meanwhile, and the maintainer's rule licenses only the
    // stack's journal or a replay (go-to-k/cdkd#4355).
    let authorizes = 0;
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof AuthorizeSecurityGroupIngressCommand && authorizes++ === 0) {
        return Promise.reject(
          Object.assign(new Error('InternalError from EC2'), {
            name: 'InternalError',
            $metadata: { httpStatusCode: 500, requestId: 'req-test' },
          })
        );
      }
      return base(command);
    });

    await expect(provider.create('Rule', TYPE, PROPS)).rejects.toThrow(/InternalError/);
    await expect(provider.create('Rule', TYPE, PROPS)).rejects.toThrow(
      /already exists on security group/
    );
  });

  describe('a write this dispatch may already have applied keeps its evidence', () => {
    const duplicateAfter = (first: Error, duplicateAttempts = 1) => {
      let authorizes = 0;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          authorizes += 1;
          if (authorizes === 1) return Promise.reject(first);
          return Promise.reject(
            Object.assign(new Error('the specified rule already exists'), {
              name: 'InvalidPermission.Duplicate',
              $metadata: { httpStatusCode: 400, requestId: 'req-test', attempts: duplicateAttempts },
            })
          );
        }
        if (command instanceof DescribeSecurityGroupRulesCommand) {
          return Promise.resolve({
            SecurityGroupRules: [
              { SecurityGroupRuleId: RULE_ID, IsEgress: false, IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, CidrIpv4: '10.0.0.0/16' },
            ],
          });
        }
        return Promise.resolve({});
      });
    };

    it('5xx then Duplicate: refuses this run, keeps the bag, and the next deploy adopts', async () => {
      duplicateAfter(awsError('InternalError', 500));
      const thisRun = journaled([]);

      // The engine's retry: two create() calls under ONE dispatch binding.
      const first = await withPriorAttempts(thisRun, () => provider.create('Rule', TYPE, PROPS)).catch(
        (e: unknown) => e
      );
      const second = (await withPriorAttempts(thisRun, () =>
        provider.create('Rule', TYPE, PROPS)
      ).catch((e: unknown) => e)) as Error;

      expect(isRefusedBeforeApplying(first, 'Rule')).toBe(false);
      expect(second.message).toMatch(/already exists on security group/);
      expect(second.message).toContain("the next 'cdkd deploy' adopts the rule");
      // Unmarked: the engine journals this failed op WITH its attempted bag.
      expect(isRefusedBeforeApplying(second, 'Rule')).toBe(false);

      // The next deploy reads that bag back from the journal.
      const result = await withPriorAttempts(journaled([{ ...PROPS }]), () =>
        provider.create('Rule', TYPE, PROPS)
      );
      expect(result.attributes).toEqual({ Id: RULE_ID });
    });

    // go-to-k/cdkd#4355's own scenario: the stranger's rule PRE-EXISTS. A
    // throttled send applied nothing, so the duplicate that follows it is the
    // stranger's rule and must refuse MARKED, or the next deploy adopts it.
    it('throttle then Duplicate within one dispatch refuses MARKED (the throttle applied nothing)', async () => {
      duplicateAfter(awsError('RequestLimitExceeded', 503), 2);
      const dispatch = journaled([]);

      const first = await withPriorAttempts(dispatch, () => provider.create('Rule', TYPE, PROPS)).catch(
        (e: unknown) => e
      );
      const second = (await withPriorAttempts(dispatch, () =>
        provider.create('Rule', TYPE, PROPS)
      ).catch((e: unknown) => e)) as Error;

      expect(isRefusedBeforeApplying(first, 'Rule')).toBe(true);
      expect(second.message).toMatch(/already exists on security group/);
      expect(second.message).not.toContain("the next 'cdkd deploy' adopts");
      expect(isRefusedBeforeApplying(second, 'Rule')).toBe(true);
    });

    it('every send throttled, then the engine retry meets Duplicate: refuses MARKED', async () => {
      let authorizes = 0;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          authorizes += 1;
          return Promise.reject(
            authorizes <= 3
              ? Object.assign(new Error('Request limit exceeded.'), {
                  name: 'Throttling',
                  $retryable: { throttling: true },
                  $metadata: { httpStatusCode: 400, requestId: 'req-test', attempts: 1 },
                })
              : Object.assign(new Error('the specified rule already exists'), {
                  name: 'InvalidPermission.Duplicate',
                  $metadata: { httpStatusCode: 400, requestId: 'req-test', attempts: 1 },
                })
          );
        }
        return Promise.resolve({ SecurityGroupRules: [] });
      });
      const dispatch = journaled([]);

      for (let i = 0; i < 3; i++) {
        await withPriorAttempts(dispatch, () => provider.create('Rule', TYPE, PROPS)).catch(() => undefined);
      }
      const error = await withPriorAttempts(dispatch, () => provider.create('Rule', TYPE, PROPS)).catch(
        (e: unknown) => e
      );

      expect((error as Error).message).toMatch(/already exists on security group/);
      expect(dispatch.possiblyLanded()).toBe(false);
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(true);
    });

    const socketError = (code: string) => Object.assign(new Error(`socket ${code}`), { code });
    const noSleep = () =>
      vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue();

    it('a request that never reached AWS (ENOTFOUND) is not evidence: the next deploy refuses', async () => {
      mockSend.mockImplementation(() => Promise.reject(socketError('ENOTFOUND')));
      const dispatch = journaled([]);

      const failed = await withPriorAttempts(dispatch, () => provider.create('Rule', TYPE, PROPS)).catch(
        (e: unknown) => e
      );

      // Marked: the failed op is journaled WITHOUT its bag, so the next
      // deploy has no evidence and refuses the stranger's rule.
      expect(isRefusedBeforeApplying(failed, 'Rule')).toBe(true);
      expect(dispatch.possiblyLanded()).toBe(false);
      mockSend.mockReset();
      mockSend.mockImplementation((command: unknown) =>
        command instanceof AuthorizeSecurityGroupIngressCommand
          ? Promise.reject(new Error('the specified rule already exists'))
          : Promise.resolve({ SecurityGroupRules: [] })
      );
      await expect(
        withPriorAttempts(journaled([]), () => provider.create('Rule', TYPE, PROPS))
      ).rejects.toThrow(/already exists on security group/);
    });

    it.each(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'])(
      'a never-connected %s is marked',
      async (code) => {
        mockSend.mockImplementation(() => Promise.reject(socketError(code)));
        const error = await provider.create('Rule', TYPE, PROPS).catch((e: unknown) => e);
        expect(isRefusedBeforeApplying(error, 'Rule')).toBe(true);
      }
    );

    it('missing credentials (CredentialsProviderError) are marked', async () => {
      mockSend.mockImplementation(() =>
        Promise.reject(Object.assign(new Error('Token is expired'), { name: 'CredentialsProviderError' }))
      );
      const error = await provider.create('Rule', TYPE, PROPS).catch((e: unknown) => e);
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(true);
    });

    it('ECONNRESET then success: re-sent by the provider, and the create succeeds', async () => {
      const sleep = noSleep();
      let authorizes = 0;
      mockSend.mockImplementation((command: unknown) =>
        command instanceof AuthorizeSecurityGroupIngressCommand && authorizes++ === 0
          ? Promise.reject(socketError('ECONNRESET'))
          : Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: RULE_ID }] })
      );

      const result = await provider.create('Rule', TYPE, PROPS);

      expect(authorizes).toBe(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(result.attributes).toEqual({ Id: RULE_ID });
    });

    it('ECONNRESET then Duplicate: refuses UNMARKED (the reset send may have made the rule)', async () => {
      noSleep();
      let authorizes = 0;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          return Promise.reject(
            authorizes++ === 0
              ? socketError('ECONNRESET')
              : Object.assign(new Error('the specified rule already exists'), {
                  name: 'InvalidPermission.Duplicate',
                  $metadata: { httpStatusCode: 400, requestId: 'req-test', attempts: 1 },
                })
          );
        }
        return Promise.resolve({ SecurityGroupRules: [] });
      });
      const dispatch = journaled([]);

      const error = (await withPriorAttempts(dispatch, () =>
        provider.create('Rule', TYPE, PROPS)
      ).catch((e: unknown) => e)) as Error;

      expect(error.message).toMatch(/already exists on security group/);
      expect(error.message).toContain("the next 'cdkd deploy' adopts the rule");
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(false);
      expect(dispatch.possiblyLanded()).toBe(true);
    });

    it.each([
      [
        'a Duplicate',
        Object.assign(new Error('the specified rule already exists'), {
          name: 'InvalidPermission.Duplicate',
          $metadata: { httpStatusCode: 400, requestId: 'req-test', attempts: 1 },
        }),
      ],
      ['a definite 4xx', awsError('InvalidGroup.NotFound', 400)],
    ])('with no dispatch bound, ECONNRESET then %s is still left UNMARKED (the per-call flag)', async (_what, then) => {
      noSleep();
      let authorizes = 0;
      mockSend.mockImplementation((command: unknown) =>
        command instanceof AuthorizeSecurityGroupIngressCommand
          ? Promise.reject(authorizes++ === 0 ? socketError('ECONNRESET') : then)
          : Promise.resolve({ SecurityGroupRules: [] })
      );

      const error = await provider.create('Rule', TYPE, PROPS).catch((e: unknown) => e);

      expect(authorizes).toBe(2);
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(false);
    });

    it('re-sends a socket error at most twice, then throws it unmarked', async () => {
      const sleep = noSleep();
      let authorizes = 0;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof AuthorizeSecurityGroupIngressCommand) authorizes += 1;
        return Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      });

      const error = await provider.create('Rule', TYPE, PROPS).catch((e: unknown) => e);

      expect(authorizes).toBe(3);
      expect(sleep.mock.calls).toEqual([[500], [1000]]);
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(false);
    });

    it.each([
      ['a never-connected ECONNREFUSED', () => socketError('ECONNREFUSED')],
      ['a definite 4xx', () => awsError('InvalidGroup.NotFound', 400)],
    ])('does not re-send %s', async (_what, failure) => {
      const sleep = noSleep();
      mockSend.mockImplementation(() => Promise.reject(failure()));

      await provider.create('Rule', TYPE, PROPS).catch(() => undefined);

      expect(sleep).not.toHaveBeenCalled();
      expect(mockSend.mock.calls.filter((c) => c[0] instanceof AuthorizeSecurityGroupIngressCommand)).toHaveLength(1);
    });

    // `@smithy/node-http-handler`'s connect timeout: nothing was written.
    const connectTimeout = () =>
      Object.assign(
        new Error(
          '@smithy/node-http-handler - the request socket did not establish a connection with the server within the configured timeout of 1000 ms.'
        ),
        { name: 'TimeoutError' }
      );

    it('a CONNECT timeout is re-sent but leaves no doubt: a following Duplicate refuses MARKED', async () => {
      const sleep = noSleep();
      let authorizes = 0;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          return Promise.reject(
            authorizes++ === 0
              ? connectTimeout()
              : Object.assign(new Error('the specified rule already exists'), {
                  name: 'InvalidPermission.Duplicate',
                  $metadata: { httpStatusCode: 400, requestId: 'req-test', attempts: 1 },
                })
          );
        }
        return Promise.resolve({ SecurityGroupRules: [] });
      });
      const dispatch = journaled([]);

      const error = await withPriorAttempts(dispatch, () => provider.create('Rule', TYPE, PROPS)).catch(
        (e: unknown) => e
      );

      expect(sleep).toHaveBeenCalledTimes(1);
      expect(dispatch.possiblyLanded()).toBe(false);
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(true);
    });

    it('a CONNECT timeout on every send is never-reached: marked', async () => {
      noSleep();
      mockSend.mockImplementation(() => Promise.reject(connectTimeout()));

      const error = await provider.create('Rule', TYPE, PROPS).catch((e: unknown) => e);

      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(true);
    });

    it('the per-call flag does not leak into the NEXT call on the same provider', async () => {
      noSleep();
      let authorizes = 0;
      mockSend.mockImplementation((command: unknown) => {
        if (!(command instanceof AuthorizeSecurityGroupIngressCommand)) {
          return Promise.resolve({ SecurityGroupRules: [] });
        }
        authorizes += 1;
        if (authorizes === 1) return Promise.reject(socketError('ECONNRESET'));
        if (authorizes === 2) return Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: RULE_ID }] });
        return Promise.reject(
          Object.assign(new Error('the specified rule already exists'), {
            name: 'InvalidPermission.Duplicate',
            $metadata: { httpStatusCode: 400, requestId: 'req-test', attempts: 1 },
          })
        );
      });

      await provider.create('Rule', TYPE, PROPS);
      const error = await provider.create('Other', TYPE, PROPS).catch((e: unknown) => e);

      expect((error as Error).message).toMatch(/already exists on security group/);
      expect(isRefusedBeforeApplying(error, 'Other')).toBe(true);
    });

    it('sends the Authorize through the single-send client, so each failure is one send', async () => {
      await provider.create('Rule', TYPE, PROPS).catch(() => undefined);

      expect(singleSent.some((c) => c instanceof AuthorizeSecurityGroupIngressCommand)).toBe(true);
      expect(singleSent.every((c) => c instanceof AuthorizeSecurityGroupIngressCommand)).toBe(true);
    });

    it('5xx then Duplicate on the UPDATE path: --revert-failed text says the existing rule is revoked first', async () => {
      let authorizes = 0;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          return Promise.reject(
            authorizes++ === 0
              ? awsError('InternalError', 500)
              : Object.assign(new Error('the specified rule already exists'), {
                  name: 'InvalidPermission.Duplicate',
                  $metadata: { httpStatusCode: 400, requestId: 'req-test', attempts: 1 },
                })
          );
        }
        return Promise.resolve({ SecurityGroupRules: [] });
      });
      const dispatch = journaled([]);
      const update = () =>
        provider.update('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS, { ...PROPS, CidrIp: '172.16.0.0/12' });

      await withPriorAttempts(dispatch, update).catch(() => undefined);
      const error = (await withPriorAttempts(dispatch, update).catch((e: unknown) => e)) as Error;

      expect(error.message).toContain('after first revoking the existing identical rule');
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(false);
    });

    it('a definite 4xx after an earlier ambiguous attempt in the same dispatch keeps the bag', async () => {
      let authorizes = 0;
      mockSend.mockImplementation((command: unknown) =>
        command instanceof AuthorizeSecurityGroupIngressCommand && authorizes++ === 0
          ? Promise.reject(awsError('InternalError', 503))
          : Promise.reject(awsError('InvalidGroup.NotFound', 400))
      );
      const dispatch = journaled([]);

      await withPriorAttempts(dispatch, () => provider.create('Rule', TYPE, PROPS)).catch(() => undefined);
      const error = await withPriorAttempts(dispatch, () => provider.create('Rule', TYPE, PROPS)).catch(
        (e: unknown) => e
      );

      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(false);
    });

    it.each([
      ['a throttle on one send (AWS did nothing)', Object.assign(new Error('Rate exceeded'), { name: 'RequestLimitExceeded', $metadata: { httpStatusCode: 503, attempts: 1 } }), true],
      ['a 4xx on one send', Object.assign(new Error('InvalidGroup.NotFound'), { name: 'InvalidGroup.NotFound', $metadata: { httpStatusCode: 400, attempts: 1 } }), true],
      ['a 503 the SDK flags as a throttle ($retryable.throttling), no throttle name', Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailableException', $retryable: { throttling: true }, $metadata: { httpStatusCode: 503, attempts: 1 } }), true],
      ['an error with no $metadata (unclassified)', new Error('socket hang up'), false],
      ['a bare 503 with no throttle name (a server error that may follow an applied write)', Object.assign(new Error('ServiceUnavailable'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503, attempts: 1 } }), false],
    ] as const)('%s: marked = %s', async (_what, failure, marked) => {
      mockSend.mockImplementation(() => Promise.reject(failure));

      const error = await provider.create('Rule', TYPE, PROPS).catch((e: unknown) => e);

      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(marked);
    });
  });

  it.each([
    ['a definite 4xx rejection — nothing was authorized', 'InvalidGroup.NotFound', 400, true],
    ['an ambiguous 5xx — the Authorize may have landed', 'InternalError', 500, false],
  ] as const)(
    'a failed Authorize after %s is journaled as evidence only when ambiguous',
    async (_what, name, httpStatusCode, notEvidence) => {
      mockSend.mockImplementation(() =>
        Promise.reject(
          Object.assign(new Error(`${name} from EC2`), {
            name,
            $metadata: { httpStatusCode, requestId: 'req-test' },
          })
        )
      );

      const error = await provider.create('Rule', TYPE, PROPS).catch((e: unknown) => e);

      expect((error as Error).message).toContain(name);
      // Marked = the engine journals the op WITHOUT its attempted bag, so a
      // rule someone adds by hand before the re-run is not adopted.
      expect(isRefusedBeforeApplying(error, 'Rule')).toBe(notEvidence);
    }
  );

  it('marks a definite 4xx on the UPDATE path re-create, so --revert-failed restores from state', async () => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof AuthorizeSecurityGroupIngressCommand
        ? Promise.reject(
            Object.assign(new Error('RulesPerSecurityGroupLimitExceeded from EC2'), {
              name: 'RulesPerSecurityGroupLimitExceeded',
              $metadata: { httpStatusCode: 400, requestId: 'req-test' },
            })
          )
        : Promise.resolve({})
    );

    const error = await provider
      .update('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS, { ...PROPS, CidrIp: '172.16.0.0/12' })
      .catch((e: unknown) => e);

    expect(sent()).toContain('RevokeSecurityGroupIngressCommand');
    expect(isRefusedBeforeApplying(error, 'Rule')).toBe(true);
  });

  describe('destroying an ADOPTED rule (live run of the integ arm)', () => {
    // The adopted rule is another owner's: it carries NO description, while
    // the stack's record carries the template's. AWS answers a revoke whose
    // permission names a description the rule lacks with
    // InvalidPermission.NotFound (non-default VPC), which the delete read as
    // "already gone" — the destroy reported success and the rule stayed.
    const adoptedRecord = { ...PROPS, Description: 'from the template' };
    const liveRuleRevoke = () =>
      mockSend.mockImplementation((command: unknown) => {
        if (!(command instanceof RevokeSecurityGroupIngressCommand)) return Promise.resolve({});
        const input = command.input;
        if (input.SecurityGroupRuleIds?.[0] === RULE_ID) return Promise.resolve({ Return: true });
        if (JSON.stringify(input).includes('Description')) {
          return Promise.reject(
            Object.assign(new Error('The specified rule does not exist in this security group.'), {
              name: 'InvalidPermission.NotFound',
            })
          );
        }
        return Promise.resolve({ Return: true });
      });

    it('revokes by the recorded sgr- id', async () => {
      liveRuleRevoke();

      await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, adoptedRecord, {
        recordedAttributes: { Id: RULE_ID },
      });

      const revokes = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c): c is RevokeSecurityGroupIngressCommand => c instanceof RevokeSecurityGroupIngressCommand);
      expect(revokes).toHaveLength(1);
      expect(revokes[0]!.input).toEqual({ GroupId: GROUP_ID, SecurityGroupRuleIds: [RULE_ID] });
      expect(childLogger.warn).not.toHaveBeenCalled();
    });

    it('without a recorded id, revokes by permission WITHOUT the description', async () => {
      liveRuleRevoke();

      await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, adoptedRecord);

      const revoke = mockSend.mock.calls.map((c) => c[0]).find((c) => c instanceof RevokeSecurityGroupIngressCommand) as
        | RevokeSecurityGroupIngressCommand
        | undefined;
      expect(JSON.stringify(revoke?.input)).not.toContain('Description');
      expect(childLogger.warn).not.toHaveBeenCalled();
    });

    it('a permission revoke that matched no rule is flagged at warn, not passed off as deleted', async () => {
      mockSend.mockImplementation(() =>
        Promise.resolve({ Return: true, UnknownIpPermissions: [{ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432 }] })
      );

      await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS);

      expect(childLogger.warn.mock.calls.some((c) => String(c[0]).includes('nothing was revoked'))).toBe(true);
    });

    it('the UPDATE path revokes the old rule by its recorded sgr- id too', async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof AuthorizeSecurityGroupIngressCommand
          ? Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-0ddddddddddddddd0' }] })
          : Promise.resolve({ Return: true })
      );

      await provider.update(
        'Rule',
        `${GROUP_ID}|tcp|5432|5432`,
        TYPE,
        { ...PROPS, Description: 'new text' },
        adoptedRecord,
        { recordedAttributes: { Id: RULE_ID } }
      );

      const revoke = mockSend.mock.calls.map((c) => c[0]).find((c) => c instanceof RevokeSecurityGroupIngressCommand) as
        | RevokeSecurityGroupIngressCommand
        | undefined;
      expect(revoke?.input).toEqual({ GroupId: GROUP_ID, SecurityGroupRuleIds: [RULE_ID] });
    });

    const revokesSent = () =>
      mockSend.mock.calls
        .map((c) => c[0])
        .filter((c): c is RevokeSecurityGroupIngressCommand => c instanceof RevokeSecurityGroupIngressCommand);
    const ruleIdNotFound = (id: string) =>
      Object.assign(new Error(`The security group rule ID '${id}' does not exist`), {
        name: 'InvalidSecurityGroupRuleId.NotFound',
      });

    // A stale recorded id: the record's rule is gone, so the delete looks at
    // the live rules. Only one matching BOTH the identity and the recorded
    // description is this stack's.
    const liveRule = (id: string, description?: string, cidr = '10.0.0.0/16') => ({
      SecurityGroupRuleId: id,
      IsEgress: false,
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      CidrIpv4: cidr,
      ...(description !== undefined && { Description: description }),
    });
    const staleIdWith = (live: unknown[], staleId = 'sgr-0eeeeeeeeeeeeeee0') =>
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof RevokeSecurityGroupIngressCommand) {
          return command.input.SecurityGroupRuleIds?.[0] === staleId
            ? Promise.reject(ruleIdNotFound(staleId))
            : Promise.resolve({ Return: true });
        }
        if (command instanceof DescribeSecurityGroupRulesCommand) {
          return Promise.resolve({ SecurityGroupRules: live });
        }
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          return Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: RULE_ID }] });
        }
        return Promise.resolve({});
      });
    const warned = (needle: string) =>
      childLogger.warn.mock.calls.some((c) => String(c[0]).includes(needle));

    it('a STALE id with this stack\'s live rule (same description) revokes that rule by ITS id', async () => {
      staleIdWith([liveRule('sgr-0fffffffffffffff0', 'from the template'), liveRule('sgr-01111111111111110', 'from the template', '10.9.0.0/16')]);

      await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, adoptedRecord, {
        recordedAttributes: { Id: 'sgr-0eeeeeeeeeeeeeee0' },
      });

      expect(revokesSent().map((c) => c.input)).toEqual([
        { GroupId: GROUP_ID, SecurityGroupRuleIds: ['sgr-0eeeeeeeeeeeeeee0'] },
        { GroupId: GROUP_ID, SecurityGroupRuleIds: ['sgr-0fffffffffffffff0'] },
      ]);
      expect(childLogger.warn).not.toHaveBeenCalled();
    });

    it.each([
      ['no description', undefined],
      ['a different description', 'someone else'],
    ])("a STALE id with a stranger's identical tuple carrying %s revokes NOTHING and warns", async (_what, description) => {
      staleIdWith([liveRule('sgr-02222222222222220', description)]);

      await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, adoptedRecord, {
        recordedAttributes: { Id: 'sgr-0eeeeeeeeeeeeeee0' },
      });

      expect(revokesSent()).toHaveLength(1);
      expect(revokesSent().some((c) => c.input.IpPermissions)).toBe(false);
      expect(warned('nothing was revoked')).toBe(true);
      expect(warned('--security-group-rule-ids sgr-02222222222222220')).toBe(true);
    });

    const skipped = { outcome: 'skipped', reason: expect.any(String) };

    it('two live rules matching identity AND description: revokes NOTHING, keeps the record (skip), names both', async () => {
      staleIdWith([liveRule('sgr-03333333333333330', 'from the template'), liveRule('sgr-04444444444444440', 'from the template')]);

      const result = await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, adoptedRecord, {
        recordedAttributes: { Id: 'sgr-0eeeeeeeeeeeeeee0' },
      });

      expect(result).toEqual(skipped);
      expect(revokesSent()).toHaveLength(1);
      expect(warned('2 live rules match its record')).toBe(true);
      expect(warned('sgr-03333333333333330')).toBe(true);
      expect(warned('sgr-04444444444444440')).toBe(true);
    });

    it('a STALE id and no live rule with its identity: gone — deleted, no warn', async () => {
      staleIdWith([liveRule('sgr-08888888888888880', 'from the template', '10.9.0.0/16')]);

      const result = await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS, {
        recordedAttributes: { Id: 'sgr-0eeeeeeeeeeeeeee0' },
      });

      expect(result).toBeUndefined();
      expect(revokesSent()).toHaveLength(1);
      expect(childLogger.warn).not.toHaveBeenCalled();
    });

    it.each([
      [
        'DescribeSecurityGroupRules throws (no permission)',
        () =>
          mockSend.mockImplementation((command: unknown) =>
            command instanceof RevokeSecurityGroupIngressCommand
              ? Promise.reject(ruleIdNotFound('sgr-0eeeeeeeeeeeeeee0'))
              : Promise.reject(Object.assign(new Error('not authorized'), { name: 'UnauthorizedOperation' }))
          ),
        adoptedRecord,
      ],
      [
        'the group never stops paginating',
        () =>
          mockSend.mockImplementation((command: unknown) =>
            command instanceof RevokeSecurityGroupIngressCommand
              ? Promise.reject(ruleIdNotFound('sgr-0eeeeeeeeeeeeeee0'))
              : Promise.resolve({ SecurityGroupRules: [], NextToken: 'more' })
          ),
        adoptedRecord,
      ],
      [
        'the recorded description is redacted and a same-identity rule exists',
        () => staleIdWith([liveRule('sgr-09999999999999990', 'anything')]),
        { ...PROPS, Description: '***' },
      ],
    ])('%s: keeps the record (skip), revokes nothing', async (_what, arrange, record) => {
      arrange();

      const result = await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, record, {
        recordedAttributes: { Id: 'sgr-0eeeeeeeeeeeeeee0' },
      });

      expect(result).toEqual(skipped);
      expect(revokesSent()).toHaveLength(1);
    });

    it('no recorded properties: keeps the record (skip)', async () => {
      staleIdWith([liveRule('sgr-09999999999999990', 'from the template')]);

      const result = await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, undefined, {
        recordedAttributes: { Id: 'sgr-0eeeeeeeeeeeeeee0' },
      });

      expect(result).toEqual(skipped);
    });

    it("on the UPDATE path a skip ABORTS before authorizing the new rule (the old one may be live)", async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof RevokeSecurityGroupIngressCommand
          ? Promise.reject(ruleIdNotFound('sgr-0eeeeeeeeeeeeeee0'))
          : command instanceof DescribeSecurityGroupRulesCommand
            ? Promise.reject(Object.assign(new Error('not authorized'), { name: 'UnauthorizedOperation' }))
            : Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: RULE_ID }] })
      );

      await expect(
        provider.update(
          'Rule',
          `${GROUP_ID}|tcp|5432|5432`,
          TYPE,
          { ...adoptedRecord, CidrIp: '172.16.0.0/12' },
          adoptedRecord,
          { recordedAttributes: { Id: 'sgr-0eeeeeeeeeeeeeee0' } }
        )
      ).rejects.toThrow(/NOT authorized/);
      expect(sent()).not.toContain('AuthorizeSecurityGroupIngressCommand');
    });

    it('absent description matches absent: a record with none revokes the live rule with none', async () => {
      staleIdWith([liveRule('sgr-05555555555555550')]);

      await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS, {
        recordedAttributes: { Id: 'sgr-0eeeeeeeeeeeeeee0' },
      });

      expect(revokesSent().map((c) => c.input.SecurityGroupRuleIds)).toEqual([
        ['sgr-0eeeeeeeeeeeeeee0'],
        ['sgr-05555555555555550'],
      ]);
    });

    it('an empty recorded description matches a live rule with none', async () => {
      staleIdWith([liveRule('sgr-07777777777777770')]);

      await provider.delete('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, { ...PROPS, Description: '' }, {
        recordedAttributes: { Id: 'sgr-0eeeeeeeeeeeeeee0' },
      });

      expect(revokesSent().map((c) => c.input.SecurityGroupRuleIds)).toEqual([
        ['sgr-0eeeeeeeeeeeeeee0'],
        ['sgr-07777777777777770'],
      ]);
    });

    it("--revert-failed (replay) with the OLD rule's id and the attempted bag B revokes B by its id, then re-authorizes", async () => {
      // The refused update revoked old rule A (sgr-A); the kept attempt names
      // B, this stack's own rule (it carries the template description).
      const bagB = { ...adoptedRecord, CidrIp: '172.16.0.0/12' };
      staleIdWith([liveRule('sgr-06666666666666660', 'from the template', '172.16.0.0/12')], 'sgr-0aaaaaaaaaaaaaaa0');

      await provider.update('Rule', `${GROUP_ID}|tcp|5432|5432`, TYPE, PROPS, bagB, {
        replayingState: true,
        recordedAttributes: { Id: 'sgr-0aaaaaaaaaaaaaaa0' },
      });

      expect(revokesSent().map((c) => c.input.SecurityGroupRuleIds)).toEqual([
        ['sgr-0aaaaaaaaaaaaaaa0'],
        ['sgr-06666666666666660'],
      ]);
      expect(sent()).toContain('AuthorizeSecurityGroupIngressCommand');
    });
  });

  it('reads no evidence and makes no extra call when the authorize succeeds', async () => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof AuthorizeSecurityGroupIngressCommand
        ? Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: RULE_ID }] })
        : Promise.reject(new Error('unexpected call'))
    );
    const lookup = journaled([]);

    const result = await withPriorAttempts(lookup, () => provider.create('Rule', TYPE, PROPS));

    expect(result.attributes).toEqual({ Id: RULE_ID });
    expect(lookup.attempts).not.toHaveBeenCalled();
    expect(sent()).toEqual(['AuthorizeSecurityGroupIngressCommand']);
  });
});
