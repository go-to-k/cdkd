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
  prefetchCreateOnlyPropertyPaths,
  templateResourceTypes,
  createOnlyChangeRequiresReplacement,
  clearCreateOnlyPropertiesCache,
} from '../../../src/provisioning/create-only-properties.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';
import { DESCRIBE_TYPE_MAX_IN_FLIGHT } from '../../../src/provisioning/describe-type.js';

/** A type cdkd holds no schema snapshot for. */
const UNSNAPSHOTTED = 'AWS::NoSnapshot::Type';

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

  it('degrades gracefully on DescribeType failure for a type with NO snapshot (empty list + warning, NOT cached)', async () => {
    expect(CREATE_ONLY_PATHS_SNAPSHOT.has(UNSNAPSHOTTED)).toBe(false);
    mockCloudFormationSend
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValueOnce(schemaResponse(['/properties/ProtocolType']));

    const first = await getCreateOnlyPropertyPaths(UNSNAPSHOTTED);
    expect(first.length).toBe(0); // graceful fallback
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0]![0]).toContain('registry-only replacement classification');

    // The failure was NOT cached — a later call retries DescribeType and succeeds.
    const second = await getCreateOnlyPropertyPaths(UNSNAPSHOTTED);
    expect(second.map((p) => p.join('.'))).toEqual(['ProtocolType']);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(2);
  });

  it('Custom::* types skip DescribeType entirely — no API call, no warning (issue #1016)', async () => {
    const result = await getCreateOnlyPropertyPaths('Custom::AWSCDKOpenIdConnectProvider');

    expect(result.length).toBe(0);
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('AWS::CloudFormation::CustomResource skips DescribeType entirely (issue #1016)', async () => {
    const result = await getCreateOnlyPropertyPaths('AWS::CloudFormation::CustomResource');

    expect(result.length).toBe(0);
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('AWS::CDK::Metadata skips DescribeType entirely — no API call, no misleading warning', async () => {
    // The CDK construct-tree sentinel every synthesized template carries. It
    // has no registry schema, so the lookup could only ever fail and emit a
    // "Grant cloudformation:DescribeType ..." warning naming a pseudo-resource
    // the user cannot act on.
    const result = await getCreateOnlyPropertyPaths('AWS::CDK::Metadata');

    expect(result.length).toBe(0);
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});

describe('getCreateOnlyPropertyPaths — committed-snapshot fallback on FAILURE only (issue #3718)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCreateOnlyPropertiesCache();
  });

  it('a failed live lookup resolves the snapshot paths and warns that it fell back to them', async () => {
    const snapshot = CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::SQS::Queue');
    expect(snapshot?.length).toBeGreaterThan(0);
    mockCloudFormationSend.mockRejectedValueOnce(new Error('AccessDenied'));

    const result = await getCreateOnlyPropertyPaths('AWS::SQS::Queue');

    expect(result).toEqual(snapshot);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const warning = mockLoggerWarn.mock.calls[0]![0] as string;
    expect(warning).toContain("cdkd's bundled schema snapshot");
    expect(warning).toContain('AccessDenied');
    expect(warning).not.toContain('registry-only');
  });

  it('a nested snapshot path survives the fallback (full paths, not top-level names)', async () => {
    // Pick any snapshot type carrying a NESTED path, so the fallback is shown
    // to serve the granularity the live parse does.
    const nested = [...CREATE_ONLY_PATHS_SNAPSHOT].find(([, paths]) =>
      paths.some((p) => p.length > 1)
    );
    expect(nested, 'no snapshot type carries a nested create-only path').toBeDefined();
    const [type, paths] = nested!;
    mockCloudFormationSend.mockRejectedValueOnce(new Error('AccessDenied'));

    expect(await getCreateOnlyPropertyPaths(type)).toEqual(paths);
  });

  it('a successful live lookup wins over the snapshot', async () => {
    mockCloudFormationSend.mockResolvedValueOnce(schemaResponse(['/properties/OnlyLive']));

    const result = await getCreateOnlyPropertyPaths('AWS::SQS::Queue');

    expect(result.map((p) => p.join('.'))).toEqual(['OnlyLive']);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('the fallback is NOT cached as a success: the next call retries live and takes its answer', async () => {
    mockCloudFormationSend
      .mockRejectedValueOnce(new Error('Rate exceeded'))
      .mockResolvedValueOnce(schemaResponse(['/properties/OnlyLive']));

    const first = await getCreateOnlyPropertyPaths('AWS::SQS::Queue');
    expect(first).toEqual(CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::SQS::Queue'));

    const second = await getCreateOnlyPropertyPaths('AWS::SQS::Queue');
    expect(second.map((p) => p.join('.'))).toEqual(['OnlyLive']);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(2);
  });

  it('an unparseable live Schema is a failure, and falls back too', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: '{not json' });

    expect(await getCreateOnlyPropertyPaths('AWS::SQS::Queue')).toEqual(
      CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::SQS::Queue')
    );
  });
});

/** A send() the test settles by hand, recording the order types were sent in. */
function deferredSends(): {
  sent: string[];
  release: (type: string) => void;
  releaseAll: () => Promise<void>;
} {
  const sent: string[] = [];
  const pending = new Map<string, () => void>();
  mockCloudFormationSend.mockImplementation(
    (command: { input: { TypeName: string } }) =>
      new Promise((resolve) => {
        const type = command.input.TypeName;
        sent.push(type);
        pending.set(type, () => resolve(schemaResponse([`/properties/${type.split('::')[2]}`])));
      })
  );
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    sent,
    release: (type) => {
      pending.get(type)!();
      pending.delete(type);
    },
    releaseAll: async () => {
      // Released slots start queued calls, which register new pending sends.
      for (let round = 0; round < 50 && pending.size > 0; round++) {
        for (const [type, resolve] of [...pending]) {
          pending.delete(type);
          resolve();
        }
        await flush();
      }
    },
  };
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('the DescribeType concurrency cap (issue #3718)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudFormationSend.mockReset();
    clearCreateOnlyPropertiesCache();
  });

  const types = (n: number, prefix = 'P'): string[] =>
    Array.from({ length: n }, (_, i) => `AWS::Test::${prefix}${i}`);

  it('a prefetch never has more than the cap in flight, and every type still resolves', async () => {
    const sends = deferredSends();
    const all = types(DESCRIBE_TYPE_MAX_IN_FLIGHT + 15);
    prefetchCreateOnlyPropertyPaths(all);
    await flushMicrotasks();
    expect(sends.sent).toHaveLength(DESCRIBE_TYPE_MAX_IN_FLIGHT);

    await sends.releaseAll();
    expect(new Set(sends.sent)).toEqual(new Set(all));
    // Each type was sent ONCE and is now a cache hit.
    expect(sends.sent).toHaveLength(all.length);
    const results = await Promise.all(all.map((t) => getCreateOnlyPropertyPaths(t)));
    expect(results.map((r) => r[0]![0])).toEqual(all.map((t) => t.split('::')[2]));
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(all.length);
  });

  it('failed lookups release their slot, so the queue behind them still drains', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    const all = types(DESCRIBE_TYPE_MAX_IN_FLIGHT * 2 + 3, 'F');
    const results = await Promise.all(all.map((t) => getCreateOnlyPropertyPaths(t)));
    expect(results.every((r) => r.length === 0)).toBe(true);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(all.length);
  });

  it('an awaited lookup of a type the prefetch already QUEUED shares that call and jumps the queue', async () => {
    const sends = deferredSends();
    const all = types(DESCRIBE_TYPE_MAX_IN_FLIGHT + 10);
    prefetchCreateOnlyPropertyPaths(all);
    await flushMicrotasks();
    const last = all[all.length - 1]!;
    expect(sends.sent).not.toContain(last);

    const awaited = getCreateOnlyPropertyPaths(last);
    // Freeing ONE slot must start the awaited type, not the next prefetch in line.
    sends.release(all[0]!);
    await flushMicrotasks();
    expect(sends.sent[DESCRIBE_TYPE_MAX_IN_FLIGHT]).toBe(last);

    sends.release(last);
    expect((await awaited).map((p) => p.join('.'))).toEqual([last.split('::')[2]]);
    await sends.releaseAll();
    // One DescribeType for that type, not a second one for the awaited caller.
    expect(sends.sent.filter((t) => t === last)).toHaveLength(1);
  });

  it('an awaited lookup of a type NOT prefetched still runs ahead of the queued prefetches', async () => {
    const sends = deferredSends();
    prefetchCreateOnlyPropertyPaths(types(DESCRIBE_TYPE_MAX_IN_FLIGHT + 10));
    await flushMicrotasks();

    const awaited = getCreateOnlyPropertyPaths('AWS::Test::Urgent');
    sends.release('AWS::Test::P0');
    await flushMicrotasks();
    expect(sends.sent[DESCRIBE_TYPE_MAX_IN_FLIGHT]).toBe('AWS::Test::Urgent');

    sends.release('AWS::Test::Urgent');
    await awaited;
    await sends.releaseAll();
  });

  it('a prefetch whose lookups all fail leaves no unhandled rejection', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      prefetchCreateOnlyPropertyPaths(types(5, 'U'));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('the prefetch skips schema-less types and duplicates', async () => {
    mockCloudFormationSend.mockResolvedValue({});
    prefetchCreateOnlyPropertyPaths([
      'AWS::Test::Dup',
      'AWS::Test::Dup',
      'AWS::CDK::Metadata',
      'Custom::Thing',
      'AWS::CloudFormation::CustomResource',
    ]);
    await flushMicrotasks();
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });
});

describe('templateResourceTypes', () => {
  it('returns the distinct string Types and tolerates malformed sections', () => {
    expect(
      templateResourceTypes({
        A: { Type: 'AWS::S3::Bucket' },
        B: { Type: 'AWS::S3::Bucket' },
        C: { Type: 'AWS::SQS::Queue' },
        D: null,
        E: { Type: 42 },
        F: 'nope',
      })
    ).toEqual(['AWS::S3::Bucket', 'AWS::SQS::Queue']);
    expect(templateResourceTypes(undefined)).toEqual([]);
    expect(templateResourceTypes('x')).toEqual([]);
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

  it('unresolved intrinsics along the path are conservative (fails-safe toward replacement)', () => {
    // {'Fn::If': ...} is not a plain container — descending into it would
    // compare undefined === undefined and let the change slip through
    // in-place where CloudFormation would replace.
    const oldV = { 'Fn::If': ['Cond', { KinesisStreamParameters: { StartingPosition: 'LATEST' } }, {}] };
    const newV = { SqsQueueParameters: { BatchSize: 1 } };
    expect(
      createOnlyChangeRequiresReplacement(
        [['SourceParameters', 'KinesisStreamParameters', 'StartingPosition']],
        'SourceParameters',
        oldV,
        newV,
        eq
      )
    ).toBe(true);
  });

  it('paths for OTHER top-level keys are ignored', () => {
    expect(createOnlyChangeRequiresReplacement(PIPE_PATHS, 'Target', 'arn:a', 'arn:b', eq)).toBe(
      false
    );
  });
});
