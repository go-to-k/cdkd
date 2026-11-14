import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { assembleFlatObjectAttribute } from '../../../src/deployment/intrinsic-resolver/getatt/flat-object-attributes.js';
import type { StaleAttributeHealOutcome } from '../../../src/deployment/stale-attribute-heal.js';

// go-to-k/cdkd#6242: the whole-object read-only attributes CloudFormation
// answers for ElastiCache CacheCluster (`RedisEndpoint`, `ConfigurationEndpoint`),
// Lambda Function (`SnapStartResponse`), EC2 Instance (`State`) and Kinesis
// Stream (`WarmThroughputObject`) were refused. The ElastiCache objects are
// ASSEMBLED from the flat dot-keys the provider already recorded (so a record
// written before the change serves them too); the others are recorded as one
// nested object that also serves its dotted members.

vi.mock('../../../src/utils/logger.js', () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...log, child: () => log }) };
});

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: mockSend },
  }),
}));

function contextFor(
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown>,
  properties: Record<string, unknown> = {},
  healer?: ResolverContext['attributeHealer']
): ResolverContext {
  return {
    template: { Resources: { R: { Type: resourceType, Properties: properties } } },
    resources: {
      R: { physicalId, resourceType, properties, attributes, dependencies: [] },
    },
    ...(healer && { attributeHealer: healer }),
  };
}

const healerReading = (attributes: Record<string, unknown>) =>
  vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'read', attributes }));

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e
  );
}

const CACHE = 'AWS::ElastiCache::CacheCluster';
const REDIS_RECORD = {
  'RedisEndpoint.Address': 'c.abc.0001.use1.cache.amazonaws.com',
  'RedisEndpoint.Port': '6379',
};

describe('Fn::GetAtt whole-object attributes (go-to-k/cdkd#6242)', () => {
  let resolver: IntrinsicFunctionResolver;
  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    mockSend.mockReset();
  });

  it('ElastiCache RedisEndpoint: assembled from the recorded flat keys, string Port, CFn member order', async () => {
    const value = await resolver.resolve(
      { 'Fn::GetAtt': ['R', 'RedisEndpoint'] },
      contextFor(CACHE, 'c', REDIS_RECORD)
    );
    expect(value).toStrictEqual({
      Address: 'c.abc.0001.use1.cache.amazonaws.com',
      Port: '6379',
    });
    expect(Object.keys(value as object)).toEqual(['Address', 'Port']);
  });

  it('ElastiCache: the dotted member and the whole object come from the same recorded key', async () => {
    const ctx = contextFor(CACHE, 'c', REDIS_RECORD);
    const port = await resolver.resolve({ 'Fn::GetAtt': ['R', 'RedisEndpoint.Port'] }, ctx);
    const whole = (await resolver.resolve({ 'Fn::GetAtt': ['R', 'RedisEndpoint'] }, ctx)) as {
      Port: unknown;
    };
    expect(port).toBe('6379');
    expect(whole.Port).toBe(port);
  });

  it('ElastiCache ConfigurationEndpoint: assembled for a memcached record', async () => {
    const value = await resolver.resolve(
      { 'Fn::GetAtt': ['R', 'ConfigurationEndpoint'] },
      contextFor(CACHE, 'm', {
        'RedisEndpoint.Address': 'm.abc.0001.use1.cache.amazonaws.com',
        'RedisEndpoint.Port': '11211',
        'ConfigurationEndpoint.Address': 'm.abc.cfg.use1.cache.amazonaws.com',
        'ConfigurationEndpoint.Port': '11211',
      })
    );
    expect(value).toStrictEqual({
      Address: 'm.abc.cfg.use1.cache.amazonaws.com',
      Port: '11211',
    });
  });

  it('ElastiCache: an endpoint the record holds no member of stays refused', async () => {
    const err = await rejectionOf(
      resolver.resolve(
        { 'Fn::GetAtt': ['R', 'ConfigurationEndpoint'] },
        contextFor(CACHE, 'c', REDIS_RECORD)
      )
    );
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain('ConfigurationEndpoint');
  });

  // Maintainer decision: an endpoint the engine does not have is refused,
  // where CloudFormation answers an empty Address and Port.
  it.each(['RedisEndpoint', 'RedisEndpoint.Address', 'RedisEndpoint.Port'])(
    'ElastiCache: %s of a Memcached cluster is refused, even from an older record holding the node endpoint',
    async (attribute) => {
      const err = await rejectionOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['R', attribute] },
          contextFor(
            CACHE,
            'm',
            {
              'RedisEndpoint.Address': 'm.abc.0001.use1.cache.amazonaws.com',
              'RedisEndpoint.Port': '11211',
            },
            { Engine: 'memcached' }
          )
        )
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('engine is memcached, which has no RedisEndpoint');
      expect((err as Error).message).toContain('Reference ConfigurationEndpoint instead');
    }
  );

  it.each([
    ['ConfigurationEndpoint', 'redis'],
    ['ConfigurationEndpoint.Address', 'redis'],
    ['ConfigurationEndpoint', 'valkey'],
  ])('ElastiCache: %s of a %s cluster is refused with the engine named', async (attribute, engine) => {
    const err = await rejectionOf(
      resolver.resolve(
        { 'Fn::GetAtt': ['R', attribute] },
        contextFor(CACHE, 'c', REDIS_RECORD, { Engine: engine })
      )
    );
    expect((err as Error).message).toContain(`engine is ${engine}, which has no ConfigurationEndpoint`);
  });

  it('ElastiCache: the Memcached engine is matched case-insensitively', async () => {
    const err = await rejectionOf(
      resolver.resolve(
        { 'Fn::GetAtt': ['R', 'RedisEndpoint'] },
        contextFor(CACHE, 'm', REDIS_RECORD, { Engine: 'Memcached' })
      )
    );
    expect((err as Error).message).toContain('engine is Memcached, which has no RedisEndpoint');
  });

  it('ElastiCache: a Redis cluster still serves its RedisEndpoint (the refusal is engine-scoped)', async () => {
    const ctx = contextFor(CACHE, 'c', REDIS_RECORD, { Engine: 'redis' });
    expect(await resolver.resolve({ 'Fn::GetAtt': ['R', 'RedisEndpoint.Port'] }, ctx)).toBe('6379');
    expect(await resolver.resolve({ 'Fn::GetAtt': ['R', 'RedisEndpoint'] }, ctx)).toStrictEqual({
      Address: 'c.abc.0001.use1.cache.amazonaws.com',
      Port: '6379',
    });
  });

  it('ElastiCache: a Memcached cluster still serves its ConfigurationEndpoint', async () => {
    const ctx = contextFor(
      CACHE,
      'm',
      { 'ConfigurationEndpoint.Address': 'm.cfg', 'ConfigurationEndpoint.Port': '11211' },
      { Engine: 'memcached' }
    );
    expect(await resolver.resolve({ 'Fn::GetAtt': ['R', 'ConfigurationEndpoint'] }, ctx)).toStrictEqual(
      { Address: 'm.cfg', Port: '11211' }
    );
  });

  it('ElastiCache: a record with no members (an import() on an older cdkd) heals and serves the whole object', async () => {
    const healer = healerReading(REDIS_RECORD);
    const ctx = contextFor(CACHE, 'c', {}, { Engine: 'redis' }, healer);
    expect(await resolver.resolve({ 'Fn::GetAtt': ['R', 'RedisEndpoint'] }, ctx)).toStrictEqual({
      Address: 'c.abc.0001.use1.cache.amazonaws.com',
      Port: '6379',
    });
    expect(healer).toHaveBeenCalledTimes(1);
  });

  it('ElastiCache: a record missing one member heals rather than serving a partial object', async () => {
    const healer = healerReading(REDIS_RECORD);
    const ctx = contextFor(
      CACHE,
      'c',
      { 'RedisEndpoint.Address': 'c.abc.0001.use1.cache.amazonaws.com' },
      { Engine: 'redis' },
      healer
    );
    expect(await resolver.resolve({ 'Fn::GetAtt': ['R', 'RedisEndpoint'] }, ctx)).toStrictEqual({
      Address: 'c.abc.0001.use1.cache.amazonaws.com',
      Port: '6379',
    });
    expect(healer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['RedisEndpoint', 'redis'],
    ['RedisEndpoint.Address', 'redis'],
    ['RedisEndpoint.Port', 'redis'],
    ['ConfigurationEndpoint', 'memcached'],
    ['ConfigurationEndpoint.Address', 'memcached'],
    ['ConfigurationEndpoint.Port', 'memcached'],
  ])(
    'ElastiCache: %s (%s) is refused when the heal reads no endpoint, worded for a cluster that may still be creating',
    async (attribute, engine) => {
      const healer = healerReading({});
      const err = await rejectionOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['R', attribute] },
          contextFor(CACHE, 'c', {}, { Engine: engine }, healer)
        )
      );
      expect((err as Error).message).toContain('cannot build it from the cache cluster id');
      expect((err as Error).message).toContain('may still be creating');
      expect(healer).toHaveBeenCalledTimes(1);
    }
  );

  it('ElastiCache: a Memcached record with no members heals and serves the whole ConfigurationEndpoint', async () => {
    const healer = healerReading({
      'ConfigurationEndpoint.Address': 'm.abc.cfg.use1.cache.amazonaws.com',
      'ConfigurationEndpoint.Port': '11211',
    });
    const ctx = contextFor(CACHE, 'm', {}, { Engine: 'memcached' }, healer);
    expect(await resolver.resolve({ 'Fn::GetAtt': ['R', 'ConfigurationEndpoint'] }, ctx)).toStrictEqual(
      { Address: 'm.abc.cfg.use1.cache.amazonaws.com', Port: '11211' }
    );
    expect(healer).toHaveBeenCalledTimes(1);
  });

  it('ElastiCache: the engine refusal runs before the heal (no re-read for an endpoint the engine cannot have)', async () => {
    const healer = healerReading({});
    const err = await rejectionOf(
      resolver.resolve(
        { 'Fn::GetAtt': ['R', 'RedisEndpoint'] },
        contextFor(CACHE, 'm', {}, { Engine: 'memcached' }, healer)
      )
    );
    expect((err as Error).message).toContain('which has no RedisEndpoint');
    expect(healer).not.toHaveBeenCalled();
  });

  it('a stored whole object wins over assembly (flat key first)', async () => {
    const value = await resolver.resolve(
      { 'Fn::GetAtt': ['R', 'RedisEndpoint'] },
      contextFor(CACHE, 'c', { ...REDIS_RECORD, RedisEndpoint: { Address: 'x', Port: '1' } })
    );
    expect(value).toStrictEqual({ Address: 'x', Port: '1' });
  });

  it('Lambda SnapStartResponse: the nested record serves the object and its members', async () => {
    const ctx = contextFor('AWS::Lambda::Function', 'fn', {
      Arn: 'arn:aws:lambda:us-east-1:123456789012:function:fn',
      FunctionName: 'fn',
      SnapStartResponse: { ApplyOn: 'None', OptimizationStatus: 'Off' },
    });
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['R', 'SnapStartResponse'] }, ctx)
    ).toStrictEqual({ ApplyOn: 'None', OptimizationStatus: 'Off' });
    expect(await resolver.resolve({ 'Fn::GetAtt': ['R', 'SnapStartResponse.ApplyOn'] }, ctx)).toBe(
      'None'
    );
  });

  it('EC2 Instance State: the nested record serves {Code (string), Name}', async () => {
    const ctx = contextFor('AWS::EC2::Instance', 'i-0123456789abcdef0', {
      InstanceId: 'i-0123456789abcdef0',
      State: { Code: '16', Name: 'running' },
    });
    expect(await resolver.resolve({ 'Fn::GetAtt': ['R', 'State'] }, ctx)).toStrictEqual({
      Code: '16',
      Name: 'running',
    });
    expect(await resolver.resolve({ 'Fn::GetAtt': ['R', 'State.Code'] }, ctx)).toBe('16');
    expect(await resolver.resolve({ 'Fn::GetAtt': ['R', 'State.Name'] }, ctx)).toBe('running');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Kinesis WarmThroughputObject: the nested record serves numbers', async () => {
    const ctx = contextFor('AWS::Kinesis::Stream', 's', {
      Arn: 'arn:aws:kinesis:us-east-1:123456789012:stream/s',
      WarmThroughputObject: { CurrentMiBps: 0, TargetMiBps: 0 },
    });
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['R', 'WarmThroughputObject'] }, ctx)
    ).toStrictEqual({ CurrentMiBps: 0, TargetMiBps: 0 });
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['R', 'WarmThroughputObject.TargetMiBps'] }, ctx)
    ).toBe(0);
  });
});

describe('the ElastiCache entries of assembleFlatObjectAttribute (go-to-k/cdkd#6242)', () => {
  it('assembles both endpoints with Address and Port required', () => {
    expect(assembleFlatObjectAttribute(CACHE, 'RedisEndpoint', REDIS_RECORD)).toStrictEqual({
      Address: 'c.abc.0001.use1.cache.amazonaws.com',
      Port: '6379',
    });
    expect(
      assembleFlatObjectAttribute(CACHE, 'ConfigurationEndpoint', {
        'ConfigurationEndpoint.Address': 'm.cfg',
        'ConfigurationEndpoint.Port': '11211',
      })
    ).toStrictEqual({ Address: 'm.cfg', Port: '11211' });
  });

  it('answers undefined for a record missing a required member, so the record heals', () => {
    expect(
      assembleFlatObjectAttribute(CACHE, 'RedisEndpoint', { 'RedisEndpoint.Address': 'a' })
    ).toBe(undefined);
    expect(assembleFlatObjectAttribute(CACHE, 'RedisEndpoint', {})).toBe(undefined);
    expect(assembleFlatObjectAttribute(CACHE, 'constructor', REDIS_RECORD)).toBe(undefined);
  });
});
