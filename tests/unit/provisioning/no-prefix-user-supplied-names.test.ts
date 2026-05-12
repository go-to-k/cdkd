/**
 * Per-provider verification of the `--no-prefix-user-supplied-names`
 * opt-in flag (issue #296 / `feat/no-prefix-user-supplied-names`).
 *
 * Scope: the **Pattern B** providers whose pre-PR code path runs
 * user-declared physical names through `generateResourceName`, which
 * prepended the stack name (`MyStack-my-role` instead of `my-role`):
 *
 *   - `AWS::IAM::Role`
 *   - `AWS::IAM::User`
 *   - `AWS::IAM::Group`
 *   - `AWS::IAM::InstanceProfile`
 *   - `AWS::ElasticLoadBalancingV2::LoadBalancer`
 *   - `AWS::ElasticLoadBalancingV2::TargetGroup`
 *
 * For each provider we assert:
 *  - Under `withSkipPrefix(true)` AND a user-supplied name, the
 *    SDK Create command receives the **unprefixed** user name.
 *  - Under `withSkipPrefix(false)` (the pre-PR default) AND a
 *    user-supplied name, the SDK Create command receives the
 *    **prefixed** name (preserves backward compatibility).
 *  - When the user did NOT supply a physical name (logical-id
 *    fallback), the prefix is applied regardless of the flag —
 *    auto-generated names need the prefix for cross-stack uniqueness.
 *
 * Pattern A providers (Lambda, S3, SNS, SQS, DynamoDB, etc.) are
 * intentionally NOT covered here: they already short-circuit user-
 * supplied names OUT of `generateResourceName` entirely, so the
 * prefix has never been applied to those types. The flag is a no-op
 * for them by construction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CreateRoleCommand,
  CreateUserCommand,
  CreateGroupCommand,
  CreateInstanceProfileCommand,
  UpdateRoleCommand,
} from '@aws-sdk/client-iam';
import {
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

const iamSend = vi.fn();
const elbv2Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: iamSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// ELBv2Provider constructs its own `ElasticLoadBalancingV2Client` rather
// than going through `getAwsClients()`; mock the SDK module directly so
// every `new ElasticLoadBalancingV2Client(...)` inside the provider hits
// our spy. Pattern lifted from `tests/unit/provisioning/elbv2-provider-roundtrip.test.ts`.
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-elastic-load-balancing-v2')
  >('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: elbv2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import {
  withStackName,
  withSkipPrefix,
} from '../../../src/provisioning/resource-name.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';

const ASSUME_ROLE = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
};

describe('--no-prefix-user-supplied-names per-provider verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('IAMRoleProvider.create', () => {
    const provider = new IAMRoleProvider();

    function mockHappyPath(): void {
      // CreateRole returns the role; ListRolePolicies + ListAttachedRolePolicies
      // return empty so the create path doesn't fan out to inline / managed
      // policy attachment.
      iamSend.mockResolvedValueOnce({
        Role: { Arn: 'arn:aws:iam::123:role/x', RoleId: 'AIDAEXAMPLE' },
      });
    }

    it('with withSkipPrefix(true) + user-supplied RoleName → unprefixed CreateRole', async () => {
      mockHappyPath();
      await withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          provider.create('CRRole', 'AWS::IAM::Role', {
            RoleName: 'my-role',
            AssumeRolePolicyDocument: ASSUME_ROLE,
          })
        )
      );
      const create = iamSend.mock.calls.find((c) => c[0] instanceof CreateRoleCommand);
      expect(create).toBeDefined();
      expect((create![0] as CreateRoleCommand).input.RoleName).toBe('my-role');
    });

    it('without withSkipPrefix + user-supplied RoleName → prefixed CreateRole (pre-PR default)', async () => {
      mockHappyPath();
      await withStackName('MyStack', () =>
        provider.create('CRRole', 'AWS::IAM::Role', {
          RoleName: 'my-role',
          AssumeRolePolicyDocument: ASSUME_ROLE,
        })
      );
      const create = iamSend.mock.calls.find((c) => c[0] instanceof CreateRoleCommand);
      expect((create![0] as CreateRoleCommand).input.RoleName).toBe('MyStack-my-role');
    });

    it('with withSkipPrefix(true) but no user-supplied RoleName → still prefixed (logical-id fallback)', async () => {
      mockHappyPath();
      await withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          provider.create('CRRole', 'AWS::IAM::Role', {
            AssumeRolePolicyDocument: ASSUME_ROLE,
          })
        )
      );
      const create = iamSend.mock.calls.find((c) => c[0] instanceof CreateRoleCommand);
      expect((create![0] as CreateRoleCommand).input.RoleName).toBe('MyStack-CRRole');
    });
  });

  describe('IAMRoleProvider.update', () => {
    // Update path also runs `generateResourceNameWithFallback` to compute
    // newRoleName and compare against the state-recorded physicalId.
    // Mismatches trigger REPLACEMENT (create new + delete old). The skip-
    // prefix flag affects which name shape `update()` computes, so these
    // tests guard against (a) regressions where a no-op deploy under the
    // same flag value as the original deploy unexpectedly triggers
    // replacement, and (b) the documented mid-flight flag-flip caveat
    // where toggling the flag against an existing stack DOES trigger
    // replacement (this is intended behavior, not a bug — but it should
    // be asserted so a future refactor doesn't silently break it).
    const provider = new IAMRoleProvider();

    it('no-op under withSkipPrefix(true) when physicalId already matches the un-prefixed name', async () => {
      // The "user re-deploys with the flag still on" scenario.
      // physicalId = 'my-role' (from a prior flag-on deploy).
      // New computed name with flag still on = 'my-role'.
      // → no replacement, in-place UpdateRoleCommand fires.
      iamSend.mockResolvedValue({}); // UpdateRoleCommand + sibling no-op responses
      await withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          provider.update(
            'CRRole',
            'my-role',
            'AWS::IAM::Role',
            { RoleName: 'my-role', AssumeRolePolicyDocument: ASSUME_ROLE },
            { RoleName: 'my-role', AssumeRolePolicyDocument: ASSUME_ROLE }
          )
        )
      );
      const update = iamSend.mock.calls.find((c) => c[0] instanceof UpdateRoleCommand);
      expect(update).toBeDefined();
      expect((update![0] as UpdateRoleCommand).input.RoleName).toBe('my-role');
      // No CreateRoleCommand (replacement would issue one).
      const create = iamSend.mock.calls.find((c) => c[0] instanceof CreateRoleCommand);
      expect(create).toBeUndefined();
    });

    it('no-op without withSkipPrefix when physicalId already matches the prefixed name', async () => {
      // The pre-PR pre-existing "user re-deploys without the flag" scenario.
      // physicalId = 'MyStack-my-role' (from a prior flag-off deploy).
      // New computed name with flag still off = 'MyStack-my-role'.
      // → no replacement.
      iamSend.mockResolvedValue({});
      await withStackName('MyStack', () =>
        provider.update(
          'CRRole',
          'MyStack-my-role',
          'AWS::IAM::Role',
          { RoleName: 'my-role', AssumeRolePolicyDocument: ASSUME_ROLE },
          { RoleName: 'my-role', AssumeRolePolicyDocument: ASSUME_ROLE }
        )
      );
      const update = iamSend.mock.calls.find((c) => c[0] instanceof UpdateRoleCommand);
      expect(update).toBeDefined();
      expect((update![0] as UpdateRoleCommand).input.RoleName).toBe('MyStack-my-role');
      const create = iamSend.mock.calls.find((c) => c[0] instanceof CreateRoleCommand);
      expect(create).toBeUndefined();
    });

    it('triggers REPLACEMENT when the flag is flipped on against a previously prefixed deployment (documented caveat)', async () => {
      // The "user toggles the flag mid-flight" scenario.
      // physicalId = 'MyStack-my-role' (state from prior flag-off deploy).
      // New computed name under flag-on = 'my-role'.
      // → replacement fires: create('my-role') then delete('MyStack-my-role').
      //
      // This is the documented caveat in README / docs/cli-reference.md
      // ("Mid-flight reversibility"). Asserting it here guards a future
      // refactor from silently breaking the caveat — e.g. by short-
      // circuiting the comparison when only the prefix differs.
      iamSend.mockResolvedValue({
        Role: { Arn: 'arn:aws:iam::123:role/new', RoleId: 'AIDANEW' },
      });
      const result = await withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          provider.update(
            'CRRole',
            'MyStack-my-role',
            'AWS::IAM::Role',
            { RoleName: 'my-role', AssumeRolePolicyDocument: ASSUME_ROLE },
            { RoleName: 'my-role', AssumeRolePolicyDocument: ASSUME_ROLE }
          )
        )
      );
      expect(result.wasReplaced).toBe(true);
      const create = iamSend.mock.calls.find((c) => c[0] instanceof CreateRoleCommand);
      expect(create).toBeDefined();
      expect((create![0] as CreateRoleCommand).input.RoleName).toBe('my-role');
    });
  });

  describe('IAMUserGroupProvider (user)', () => {
    const provider = new IAMUserGroupProvider();

    it('with withSkipPrefix(true) + user-supplied UserName → unprefixed CreateUser', async () => {
      iamSend.mockResolvedValueOnce({ User: { Arn: 'arn:aws:iam::123:user/x', UserId: 'AIDA' } });
      await withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          provider.create('CRUser', 'AWS::IAM::User', { UserName: 'my-user' })
        )
      );
      const create = iamSend.mock.calls.find((c) => c[0] instanceof CreateUserCommand);
      expect((create![0] as CreateUserCommand).input.UserName).toBe('my-user');
    });

    it('without withSkipPrefix + user-supplied UserName → prefixed CreateUser', async () => {
      iamSend.mockResolvedValueOnce({ User: { Arn: 'arn:aws:iam::123:user/x', UserId: 'AIDA' } });
      await withStackName('MyStack', () =>
        provider.create('CRUser', 'AWS::IAM::User', { UserName: 'my-user' })
      );
      const create = iamSend.mock.calls.find((c) => c[0] instanceof CreateUserCommand);
      expect((create![0] as CreateUserCommand).input.UserName).toBe('MyStack-my-user');
    });
  });

  describe('IAMUserGroupProvider (group)', () => {
    const provider = new IAMUserGroupProvider();

    it('with withSkipPrefix(true) + user-supplied GroupName → unprefixed CreateGroup', async () => {
      iamSend.mockResolvedValueOnce({ Group: { Arn: 'arn:aws:iam::123:group/x' } });
      await withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          provider.create('CRGroup', 'AWS::IAM::Group', { GroupName: 'my-group' })
        )
      );
      const create = iamSend.mock.calls.find((c) => c[0] instanceof CreateGroupCommand);
      expect((create![0] as CreateGroupCommand).input.GroupName).toBe('my-group');
    });

    it('without withSkipPrefix + user-supplied GroupName → prefixed CreateGroup', async () => {
      iamSend.mockResolvedValueOnce({ Group: { Arn: 'arn:aws:iam::123:group/x' } });
      await withStackName('MyStack', () =>
        provider.create('CRGroup', 'AWS::IAM::Group', { GroupName: 'my-group' })
      );
      const create = iamSend.mock.calls.find((c) => c[0] instanceof CreateGroupCommand);
      expect((create![0] as CreateGroupCommand).input.GroupName).toBe('MyStack-my-group');
    });
  });

  describe('IAMInstanceProfileProvider', () => {
    const provider = new IAMInstanceProfileProvider();

    it('with withSkipPrefix(true) + user-supplied InstanceProfileName → unprefixed CreateInstanceProfile', async () => {
      iamSend.mockResolvedValueOnce({
        InstanceProfile: { Arn: 'arn:aws:iam::123:instance-profile/x' },
      });
      await withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          provider.create('CRIP', 'AWS::IAM::InstanceProfile', {
            InstanceProfileName: 'my-ip',
            Roles: [],
          })
        )
      );
      const create = iamSend.mock.calls.find(
        (c) => c[0] instanceof CreateInstanceProfileCommand
      );
      expect((create![0] as CreateInstanceProfileCommand).input.InstanceProfileName).toBe('my-ip');
    });

    it('without withSkipPrefix + user-supplied InstanceProfileName → prefixed', async () => {
      iamSend.mockResolvedValueOnce({
        InstanceProfile: { Arn: 'arn:aws:iam::123:instance-profile/x' },
      });
      await withStackName('MyStack', () =>
        provider.create('CRIP', 'AWS::IAM::InstanceProfile', {
          InstanceProfileName: 'my-ip',
          Roles: [],
        })
      );
      const create = iamSend.mock.calls.find(
        (c) => c[0] instanceof CreateInstanceProfileCommand
      );
      expect((create![0] as CreateInstanceProfileCommand).input.InstanceProfileName).toBe(
        'MyStack-my-ip'
      );
    });
  });

  describe('ELBv2Provider (LoadBalancer)', () => {
    const provider = new ELBv2Provider();

    function mockLBHappyPath(): void {
      elbv2Send.mockResolvedValueOnce({
        LoadBalancers: [
          {
            LoadBalancerArn:
              'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/x/abc123',
            DNSName: 'x.elb.amazonaws.com',
            CanonicalHostedZoneId: 'Z123',
            LoadBalancerName: 'lb',
          },
        ],
      });
    }

    it('with withSkipPrefix(true) + user-supplied LB Name → unprefixed CreateLoadBalancer', async () => {
      mockLBHappyPath();
      await withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          provider.create('CRLB', 'AWS::ElasticLoadBalancingV2::LoadBalancer', {
            Name: 'my-lb',
            Subnets: ['subnet-aaa', 'subnet-bbb'],
            Scheme: 'internet-facing',
            Type: 'application',
          })
        )
      );
      const create = elbv2Send.mock.calls.find((c) => c[0] instanceof CreateLoadBalancerCommand);
      expect((create![0] as CreateLoadBalancerCommand).input.Name).toBe('my-lb');
    });

    it('without withSkipPrefix + user-supplied LB Name → prefixed', async () => {
      mockLBHappyPath();
      await withStackName('MyStack', () =>
        provider.create('CRLB', 'AWS::ElasticLoadBalancingV2::LoadBalancer', {
          Name: 'my-lb',
          Subnets: ['subnet-aaa', 'subnet-bbb'],
          Scheme: 'internet-facing',
          Type: 'application',
        })
      );
      const create = elbv2Send.mock.calls.find((c) => c[0] instanceof CreateLoadBalancerCommand);
      expect((create![0] as CreateLoadBalancerCommand).input.Name).toBe('MyStack-my-lb');
    });
  });

  describe('ELBv2Provider (TargetGroup)', () => {
    const provider = new ELBv2Provider();

    function mockTGHappyPath(): void {
      elbv2Send.mockResolvedValueOnce({
        TargetGroups: [
          {
            TargetGroupArn:
              'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/x/abc123',
            TargetGroupName: 'tg',
          },
        ],
      });
    }

    it('with withSkipPrefix(true) + user-supplied TG Name → unprefixed CreateTargetGroup', async () => {
      mockTGHappyPath();
      await withStackName('MyStack', () =>
        withSkipPrefix(true, () =>
          provider.create('CRTG', 'AWS::ElasticLoadBalancingV2::TargetGroup', {
            Name: 'my-tg',
            Protocol: 'HTTP',
            Port: 80,
            VpcId: 'vpc-aaa',
            TargetType: 'ip',
          })
        )
      );
      const create = elbv2Send.mock.calls.find((c) => c[0] instanceof CreateTargetGroupCommand);
      expect((create![0] as CreateTargetGroupCommand).input.Name).toBe('my-tg');
    });

    it('without withSkipPrefix + user-supplied TG Name → prefixed', async () => {
      mockTGHappyPath();
      await withStackName('MyStack', () =>
        provider.create('CRTG', 'AWS::ElasticLoadBalancingV2::TargetGroup', {
          Name: 'my-tg',
          Protocol: 'HTTP',
          Port: 80,
          VpcId: 'vpc-aaa',
          TargetType: 'ip',
        })
      );
      const create = elbv2Send.mock.calls.find((c) => c[0] instanceof CreateTargetGroupCommand);
      expect((create![0] as CreateTargetGroupCommand).input.Name).toBe('MyStack-my-tg');
    });
  });
});
