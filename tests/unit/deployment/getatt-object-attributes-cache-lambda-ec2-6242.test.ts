import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { flatMemberObject } from '../../../src/deployment/intrinsic-resolver/getatt-construct-flat-members.js';

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
  attributes: Record<string, unknown>
): ResolverContext {
  return {
    template: { Resources: { R: { Type: resourceType, Properties: {} } } },
    resources: {
      R: { physicalId, resourceType, properties: {}, attributes, dependencies: [] },
    },
  };
}

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

describe('flatMemberObject (go-to-k/cdkd#6242)', () => {
  it('is scoped to the listed (type, attribute) pairs', () => {
    expect(flatMemberObject('AWS::RDS::DBInstance', 'Endpoint', { 'Endpoint.Address': 'a' })).toBe(
      undefined
    );
    expect(flatMemberObject(CACHE, 'constructor', { 'constructor.Address': 'a' })).toBe(undefined);
    expect(flatMemberObject('constructor', 'RedisEndpoint', REDIS_RECORD)).toBe(undefined);
  });

  it('leaves out a member the record lacks, and answers undefined for none', () => {
    expect(flatMemberObject(CACHE, 'RedisEndpoint', { 'RedisEndpoint.Address': 'a' })).toStrictEqual(
      { Address: 'a' }
    );
    expect(flatMemberObject(CACHE, 'RedisEndpoint', {})).toBe(undefined);
  });
});
