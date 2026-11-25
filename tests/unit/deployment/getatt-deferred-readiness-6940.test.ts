import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { StaleAttributeHealOutcome } from '../../../src/deployment/stale-attribute-heal.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const mocks = vi.hoisted(() => ({ ec2Send: vi.fn(), stsSend: vi.fn() }));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: mocks.stsSend }, ec2: { send: mocks.ec2Send } }),
}));

/**
 * go-to-k/cdkd#6940 part 1: under `--no-wait`, a `Fn::GetAtt` of a value a
 * skipped-wait resource reports only once ready waits for that readiness and
 * reads the record again, instead of refusing at once.
 */

type Deferred = NonNullable<ResolverContext['deferredReadiness']>;

function contextFor(
  type: string,
  physicalId: string,
  attributes: Record<string, unknown>,
  deferred: Deferred | undefined,
  healer?: ResolverContext['attributeHealer']
): ResolverContext {
  return {
    template: { Resources: { X: { Type: type, Properties: {} } } },
    resources: {
      X: { physicalId, resourceType: type, properties: {}, attributes, dependencies: [] },
    },
    attributeHealer: healer ?? vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'not-attempted' })),
    ...(deferred && { deferredReadiness: deferred }),
  };
}

const resolveGetAtt = (context: ResolverContext, attribute: string): Promise<unknown> =>
  new IntrinsicFunctionResolver('us-east-1').resolve({ 'Fn::GetAtt': ['X', attribute] }, context);

describe('Fn::GetAtt waits for a deferred readiness (#6940)', () => {
  beforeEach(() => {
    resetAccountInfoCache();
    mocks.stsSend.mockResolvedValue({ Account: '123456789012' });
  });

  it('an RDS endpoint the --no-wait record lacks: waits, re-reads, serves', async () => {
    const order: string[] = [];
    const deferred: Deferred = {
      awaitReady: vi.fn((logicalId: string) => {
        order.push(`ready:${logicalId}`);
        return Promise.resolve();
      }),
      readAfterReady: vi.fn(async (): Promise<StaleAttributeHealOutcome> => {
        order.push('read');
        return {
          kind: 'read',
          attributes: { 'Endpoint.Address': 'mydb.x.us-east-1.rds.amazonaws.com' },
        };
      }),
    };
    const healer = vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'not-attempted' }));
    const value = await resolveGetAtt(
      contextFor('AWS::RDS::DBInstance', 'mydb', {}, deferred, healer),
      'Endpoint.Address'
    );
    expect(value).toBe('mydb.x.us-east-1.rds.amazonaws.com');
    expect(order).toStrictEqual(['ready:X', 'read']);
    // The #1852 heal (baseline records only) is not asked.
    expect(healer).not.toHaveBeenCalled();
  });

  it('an ElastiCache endpoint (a heal-first arm) waits the same way', async () => {
    const deferred: Deferred = {
      awaitReady: vi.fn(() => Promise.resolve()),
      readAfterReady: vi.fn(
        async (): Promise<StaleAttributeHealOutcome> => ({
          kind: 'read',
          attributes: { 'RedisEndpoint.Address': 'c.x.cache.amazonaws.com' },
        })
      ),
    };
    const value = await resolveGetAtt(
      contextFor('AWS::ElastiCache::CacheCluster', 'c', { Engine: 'redis' }, deferred),
      'RedisEndpoint.Address'
    );
    expect(value).toBe('c.x.cache.amazonaws.com');
    expect(deferred.awaitReady).toHaveBeenCalledTimes(1);
  });

  it("a just-written role's recorded Arn and RoleId never wait for its IAM settle (#6967)", async () => {
    // The role reported an `iam-propagation` readiness: only a custom resource
    // downstream waits for it. A function's `Role: !GetAtt Role.Arn` reads the
    // record and proceeds.
    const deferred: Deferred = {
      awaitReady: vi.fn(() => Promise.resolve()),
      readAfterReady: vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'not-attempted' })),
    };
    const context = contextFor(
      'AWS::IAM::Role',
      'handler-role',
      { Arn: 'arn:aws:iam::123456789012:role/handler-role', RoleId: 'AROA1' },
      deferred
    );
    expect(await resolveGetAtt(context, 'Arn')).toBe('arn:aws:iam::123456789012:role/handler-role');
    expect(await resolveGetAtt(context, 'RoleId')).toBe('AROA1');
    expect(deferred.awaitReady).not.toHaveBeenCalled();
  });

  it('a value that exists at once (a constructed ARN) never waits', async () => {
    const deferred: Deferred = {
      awaitReady: vi.fn(() => Promise.resolve()),
      readAfterReady: vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'not-attempted' })),
    };
    const value = await resolveGetAtt(
      contextFor('AWS::RDS::DBInstance', 'mydb', {}, deferred),
      'DBInstanceArn'
    );
    expect(value).toBe('arn:aws:rds:us-east-1:123456789012:db:mydb');
    expect(deferred.awaitReady).not.toHaveBeenCalled();
  });

  it('a resource whose wait was not deferred keeps the #1852 heal path', async () => {
    const deferred: Deferred = {
      awaitReady: vi.fn(() => undefined),
      readAfterReady: vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'not-attempted' })),
    };
    const healer = vi.fn(
      async (): Promise<StaleAttributeHealOutcome> => ({
        kind: 'read',
        attributes: { 'Endpoint.Address': 'healed.rds.amazonaws.com' },
      })
    );
    const value = await resolveGetAtt(
      contextFor('AWS::RDS::DBInstance', 'mydb', {}, deferred, healer),
      'Endpoint.Address'
    );
    expect(value).toBe('healed.rds.amazonaws.com');
    expect(healer).toHaveBeenCalledTimes(1);
    expect(deferred.readAfterReady).not.toHaveBeenCalled();
  });

  it('a resource that ends failed fails the resolution with its own error', async () => {
    const failure = new ProvisioningError(
      'Db (AWS::RDS::DBInstance) did not become ready (...): entered status failed',
      'AWS::RDS::DBInstance',
      'X'
    );
    const deferred: Deferred = {
      awaitReady: vi.fn(() => Promise.reject(failure)),
      readAfterReady: vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'not-attempted' })),
    };
    await expect(
      resolveGetAtt(contextFor('AWS::RDS::DBInstance', 'mydb', {}, deferred), 'Endpoint.Address')
    ).rejects.toBe(failure);
    expect(deferred.readAfterReady).not.toHaveBeenCalled();
  });

  it('a read after readiness that still lacks the value refuses, no physical-id stand-in', async () => {
    const deferred: Deferred = {
      awaitReady: vi.fn(() => Promise.resolve()),
      readAfterReady: vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'read', attributes: {} })),
    };
    await expect(
      resolveGetAtt(contextFor('AWS::RDS::DBInstance', 'mydb', {}, deferred), 'Endpoint.Address')
    ).rejects.toThrow(/Cannot resolve Fn::GetAtt/);
  });

  describe('EC2 instance address', () => {
    const describeAnswer = (state: string, ip?: string) => ({
      Reservations: [
        {
          Instances: [
            { State: { Name: state }, ...(ip !== undefined && { PrivateIpAddress: ip }) },
          ],
        },
      ],
    });

    it('a pending instance launched under --no-wait waits for running, then reads again', async () => {
      mocks.ec2Send
        .mockResolvedValueOnce(describeAnswer('pending'))
        .mockResolvedValueOnce(describeAnswer('running', '10.0.0.7'));
      const deferred: Deferred = {
        awaitReady: vi.fn(() => Promise.resolve()),
        readAfterReady: vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'not-attempted' })),
      };
      const value = await resolveGetAtt(
        contextFor('AWS::EC2::Instance', 'i-0000000000006940a', {}, deferred),
        'PrivateIp'
      );
      expect(value).toBe('10.0.0.7');
      expect(deferred.awaitReady).toHaveBeenCalledWith('X', expect.stringContaining('PrivateIp'));
      expect(mocks.ec2Send).toHaveBeenCalledTimes(2);
    });

    it('a pending instance whose wait was not deferred still refuses after one read', async () => {
      mocks.ec2Send.mockResolvedValueOnce(describeAnswer('pending'));
      const deferred: Deferred = {
        awaitReady: vi.fn(() => undefined),
        readAfterReady: vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'not-attempted' })),
      };
      await expect(
        resolveGetAtt(
          contextFor('AWS::EC2::Instance', 'i-0000000000006940b', {}, deferred),
          'PrivateIp'
        )
      ).rejects.toThrow(/state pending/);
      expect(mocks.ec2Send).toHaveBeenCalledTimes(1);
    });

    it('a just-launched instance reading NotFound waits for running, then reads again', async () => {
      const notFound = Object.assign(new Error('The instance ID does not exist'), {
        name: 'InvalidInstanceID.NotFound',
      });
      mocks.ec2Send
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce(describeAnswer('running', '10.0.0.9'));
      const deferred: Deferred = {
        awaitReady: vi.fn(() => Promise.resolve()),
        readAfterReady: vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'not-attempted' })),
      };
      const value = await resolveGetAtt(
        contextFor('AWS::EC2::Instance', 'i-0000000000006940c', {}, deferred),
        'PrivateIp'
      );
      expect(value).toBe('10.0.0.9');
      expect(deferred.awaitReady).toHaveBeenCalledTimes(1);
    });

    it('NotFound on an instance whose wait was not deferred still refuses at once', async () => {
      const notFound = Object.assign(new Error('The instance ID does not exist'), {
        name: 'InvalidInstanceID.NotFound',
      });
      mocks.ec2Send.mockRejectedValueOnce(notFound);
      const deferred: Deferred = {
        awaitReady: vi.fn(() => undefined),
        readAfterReady: vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'not-attempted' })),
      };
      await expect(
        resolveGetAtt(contextFor('AWS::EC2::Instance', 'i-0000000000006940d', {}, deferred), 'PrivateIp')
      ).rejects.toThrow(/Cannot resolve Fn::GetAtt/);
      expect(mocks.ec2Send).toHaveBeenCalledTimes(1);
    });
  });
});
