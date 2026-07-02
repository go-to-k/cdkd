import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudFormationSend = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockLoggerWarn,
      error: vi.fn(),
    }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  getCreateOnlyPropertyPaths,
  createOnlyChangeRequiresReplacement,
  clearCreateOnlyPropertiesCache,
} from '../../../src/provisioning/create-only-properties.js';

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function schemaResponse(createOnlyProperties: string[]): { Schema: string } {
  return { Schema: JSON.stringify({ createOnlyProperties }) };
}

describe('getCreateOnlyPropertyPaths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCreateOnlyPropertiesCache();
  });

  it('extracts createOnly property paths from the registry schema', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(
      schemaResponse([
        '/properties/PerformanceMode',
        '/properties/Encrypted',
        '/properties/KmsKeyId',
      ])
    );

    const result = await getCreateOnlyPropertyPaths('AWS::EFS::FileSystem');

    expect(result.map((p) => p.join('.')).sort()).toEqual([
      'Encrypted',
      'KmsKeyId',
      'PerformanceMode',
    ]);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('keeps the FULL segment path for nested createOnly JSON pointers (issue #960)', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(
      schemaResponse(['/properties/Foo/Bar', '/properties/Baz'])
    );

    const result = await getCreateOnlyPropertyPaths('AWS::Some::Type');

    expect(result.map((p) => p.join('.')).sort()).toEqual(['Baz', 'Foo.Bar']);
  });

  it('unescapes RFC 6901 JSON-pointer segments (~1 -> /, ~0 -> ~) in the property name', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(
      schemaResponse(['/properties/Foo~1Bar', '/properties/Tilde~0Name'])
    );

    const result = await getCreateOnlyPropertyPaths('AWS::Some::Type');

    expect(result.map((p) => p.join('.')).sort()).toEqual(['Foo/Bar', 'Tilde~Name']);
  });

  it('caches SUCCESSFUL lookups per type (one DescribeType for repeated calls)', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(schemaResponse(['/properties/Engine']));

    const a = await getCreateOnlyPropertyPaths('AWS::ElastiCache::CacheCluster');
    const b = await getCreateOnlyPropertyPaths('AWS::ElastiCache::CacheCluster');

    expect(a).toBe(b); // same cached promise result
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('a Schema-less response is a successful "no createOnly props" lookup (no warning)', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({});

    const result = await getCreateOnlyPropertyPaths('AWS::Private::Type');

    expect(result.length).toBe(0);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('degrades gracefully on DescribeType failure (empty list + warning, NOT cached)', async () => {
    mockCloudFormationSend
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValueOnce(schemaResponse(['/properties/ProtocolType']));

    const first = await getCreateOnlyPropertyPaths('AWS::ApiGatewayV2::Api');
    expect(first.length).toBe(0); // graceful fallback
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);

    // The failure was NOT cached — a later call retries DescribeType and succeeds.
    const second = await getCreateOnlyPropertyPaths('AWS::ApiGatewayV2::Api');
    expect(second.map((p) => p.join('.'))).toEqual(['ProtocolType']);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(2);
  });
});

describe('createOnlyChangeRequiresReplacement (pure path-granular comparison, issue #960)', () => {
  const PIPE_PATHS: string[][] = [
    ['Name'],
    ['Source'],
    ['SourceParameters', 'KinesisStreamParameters', 'StartingPosition'],
    ['SourceParameters', 'DynamoDBStreamParameters', 'StartingPosition'],
  ];

  it('length-1 path: any change to the whole property replaces', () => {
    expect(createOnlyChangeRequiresReplacement(PIPE_PATHS, 'Source', 'arn:a', 'arn:b', eq)).toBe(
      true
    );
  });

  it('nested path: a sibling sub-property change does NOT replace (Pipes SQS BatchSize)', () => {
    const oldV = { SqsQueueParameters: { BatchSize: 1 } };
    const newV = { SqsQueueParameters: { BatchSize: 2 } };
    expect(
      createOnlyChangeRequiresReplacement(PIPE_PATHS, 'SourceParameters', oldV, newV, eq)
    ).toBe(false);
  });

  it('nested path: a change AT the createOnly path replaces (StartingPosition)', () => {
    const oldV = { KinesisStreamParameters: { StartingPosition: 'LATEST' } };
    const newV = { KinesisStreamParameters: { StartingPosition: 'TRIM_HORIZON' } };
    expect(
      createOnlyChangeRequiresReplacement(PIPE_PATHS, 'SourceParameters', oldV, newV, eq)
    ).toBe(true);
  });

  it('nested path: removing the value at the createOnly path replaces', () => {
    const oldV = { KinesisStreamParameters: { StartingPosition: 'LATEST' } };
    const newV = { KinesisStreamParameters: {} };
    expect(
      createOnlyChangeRequiresReplacement(PIPE_PATHS, 'SourceParameters', oldV, newV, eq)
    ).toBe(true);
  });

  it('absent containers on both sides resolve to undefined (no replacement)', () => {
    // SQS pipe: neither side has the stream-source subtrees at all.
    const oldV = { SqsQueueParameters: { BatchSize: 1 } };
    const newV = { SqsQueueParameters: { BatchSize: 5 } };
    expect(
      createOnlyChangeRequiresReplacement(
        [['SourceParameters', 'ActiveMQBrokerParameters', 'QueueName']],
        'SourceParameters',
        oldV,
        newV,
        eq
      )
    ).toBe(false);
  });

  it('unresolvable shapes are conservative: array where an object is expected replaces', () => {
    expect(
      createOnlyChangeRequiresReplacement(
        [['Prop', 'Nested']],
        'Prop',
        [{ Nested: 1 }],
        [{ Nested: 2 }],
        eq
      )
    ).toBe(true);
  });

  it('unresolvable shapes are conservative: * wildcard segment replaces', () => {
    expect(
      createOnlyChangeRequiresReplacement([['Prop', '*', 'Key']], 'Prop', { a: 1 }, { a: 2 }, eq)
    ).toBe(true);
  });

  it('paths for OTHER top-level keys are ignored', () => {
    expect(createOnlyChangeRequiresReplacement(PIPE_PATHS, 'Target', 'arn:a', 'arn:b', eq)).toBe(
      false
    );
  });
});
