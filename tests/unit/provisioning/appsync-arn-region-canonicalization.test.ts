import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-appsync', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-appsync')>(
    '@aws-sdk/client-appsync'
  );
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation((config?: { region?: string }) => ({
      send: mockSend,
      // Faithful to the real client: `config.region` is a PROVIDER function,
      // and it answers whatever region the constructor was handed — which is
      // how an upper-cased `--region` reaches the ARN builder on the paths that
      // take no explicit override.
      config: { region: () => Promise.resolve(config?.region ?? 'us-east-1') },
    })),
  };
});

// Mirrors the real `getAccountInfo`: the region it answers is the CALLER's
// override, spelled exactly as supplied (`effectiveAccountInfoRegion` is
// `overrideRegion || AWS_REGION || 'us-east-1'`, folded nowhere), while the
// PARTITION is derived through `derivePartitionAndUrlSuffix`, which
// canonicalizes its own input (issue #1795). Getting that asymmetry right in
// the mock is what makes the assertions below mean anything: a mock that folded
// the region would be green with the fix reverted.
const { mockGetAccountInfo } = vi.hoisted(() => ({
  mockGetAccountInfo: vi.fn(),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: mockGetAccountInfo,
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => child),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { derivePartitionAndUrlSuffix } from '../../../src/utils/aws-partition.js';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';

/**
 * Issue [#1850](https://github.com/go-to-k/cdkd/issues/1850) —
 * `AppSyncProvider.buildAppSyncArn` interpolated `accountInfo.region` VERBATIM.
 *
 * `cdkd deploy --region US-EAST-1` is REACHABLE rather than a typo the user is
 * punished for: DNS is case-insensitive, so the SDK endpoint still resolves and
 * the deploy SUCCEEDS — and cdkd then records
 * `arn:aws:appsync:US-EAST-1:...:apis/<id>/...` as the child's `Ref` /
 * `Fn::GetAtt` answer. IAM policy matching IS case-sensitive, so that value
 * matches no policy and is rejected by every SDK call that takes it; it is
 * persisted into state.json, so it also outlives the deploy.
 *
 * BOTH polarities are pinned at every arm. The upper-cased case proves the fold
 * happens; the already-canonical case proves it is a no-op there, byte for byte
 * — without which the fold could be "satisfied" by any transformation that
 * happens to lower-case, including one that mangles a canonical ARN.
 */
describe('AppSyncProvider folds the ARN region segment (issue #1850)', () => {
  const ACCOUNT = '123456789012';
  const originalAwsRegion = process.env['AWS_REGION'];

  const appsyncArn = (region: string, suffix: string) =>
    `arn:${derivePartitionAndUrlSuffix(region).partition}:appsync:${region}:${ACCOUNT}:${suffix}`;

  beforeEach(() => {
    mockSend.mockReset();
    mockGetAccountInfo.mockReset();
    mockGetAccountInfo.mockImplementation((overrideRegion?: string) => {
      const region = overrideRegion || process.env['AWS_REGION'] || 'us-east-1';
      return Promise.resolve({
        accountId: ACCOUNT,
        region,
        partition: derivePartitionAndUrlSuffix(region).partition,
      });
    });
  });

  afterEach(() => {
    if (originalAwsRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalAwsRegion;
  });

  const importInput = (resourceType: string, knownPhysicalId: string, region: string) => ({
    logicalId: 'X',
    resourceType,
    stackName: 'MyStack',
    region,
    properties: {},
    knownPhysicalId,
  });

  // The import path takes the region as an explicit override, which is exactly
  // how `cdkd import --region US-EAST-1` reaches the builder.
  it.each([
    ['US-EAST-1', 'us-east-1'],
    ['us-east-1', 'us-east-1'],
    ['Us-East-1', 'us-east-1'],
    ['CN-NORTH-1', 'cn-north-1'],
    ['cn-north-1', 'cn-north-1'],
  ])('import with --region %s records the ARN spelled %s', async (supplied, canonical) => {
    const provider = new AppSyncProvider();

    const result = await provider.import(
      importInput('AWS::AppSync::DataSource', 'abcd1234|myDataSource', supplied)
    );

    expect(result?.attributes?.['DataSourceArn']).toBe(
      appsyncArn(canonical, 'apis/abcd1234/datasources/myDataSource')
    );
    // The builder must have been handed the RAW spelling — otherwise this test
    // would pass with the fold reverted, because something upstream folded it.
    expect(mockGetAccountInfo).toHaveBeenCalledWith(supplied);
  });

  // The `appsyncArn` helper above derives the partition with the PRODUCTION
  // `derivePartitionAndUrlSuffix`, so the `CN-NORTH-1` row cannot catch a
  // partition that is wrong-but-consistent — the expectation would move with
  // the bug. One fully literal expectation closes that: nothing here is
  // computed by the code under test.
  it('records a literal aws-cn ARN for an upper-cased China region', async () => {
    const result = await new AppSyncProvider().import(
      importInput('AWS::AppSync::DataSource', 'abcd1234|myDataSource', 'CN-NORTH-1')
    );

    expect(result?.attributes?.['DataSourceArn']).toBe(
      'arn:aws-cn:appsync:cn-north-1:123456789012:apis/abcd1234/datasources/myDataSource'
    );
  });

  // ...and the two spellings must produce the SAME string, not merely two
  // strings that each satisfy their own expectation.
  it('an upper-cased region yields a byte-identical ARN to the canonical one', async () => {
    const upper = await new AppSyncProvider().import(
      importInput('AWS::AppSync::DataSource', 'abcd1234|myDataSource', 'US-EAST-1')
    );
    const canonical = await new AppSyncProvider().import(
      importInput('AWS::AppSync::DataSource', 'abcd1234|myDataSource', 'us-east-1')
    );

    expect(upper?.attributes?.['DataSourceArn']).toBe(canonical?.attributes?.['DataSourceArn']);
    expect(canonical?.attributes?.['DataSourceArn']).toBe(
      'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/datasources/myDataSource'
    );
  });

  // The CREATE path takes no override: the region comes from `AWS_REGION`,
  // which `cdkd deploy --region US-EAST-1` assigns before any provider runs.
  // `providerRegion` is read at field-init time, so the env var is set BEFORE
  // the provider is constructed.
  it.each([
    ['US-EAST-1', 'us-east-1'],
    ['us-east-1', 'us-east-1'],
  ])('create under AWS_REGION=%s records the ARN spelled %s', async (supplied, canonical) => {
    process.env['AWS_REGION'] = supplied;
    const provider = new AppSyncProvider();
    mockSend.mockResolvedValue({ apiKey: { id: 'da2-abcdefghij' } });

    const result = await provider.create('K', 'AWS::AppSync::ApiKey', { ApiId: 'abcd1234' });

    expect(result.attributes?.['Arn']).toBe(
      appsyncArn(canonical, 'apis/abcd1234/apikey/da2-abcdefghij')
    );
  });

  // The UPDATE path rebuilds the ARN on EVERY in-place update and its attribute
  // map REPLACES the record's, so an unfolded region here overwrites a
  // correctly-spelled create-time value rather than merely failing to write one.
  it.each([
    ['US-EAST-1', 'us-east-1'],
    ['us-east-1', 'us-east-1'],
  ])('update under AWS_REGION=%s records the ARN spelled %s', async (supplied, canonical) => {
    process.env['AWS_REGION'] = supplied;
    const provider = new AppSyncProvider();
    mockSend.mockResolvedValue({});

    const result = await provider.update(
      'X',
      'abcd1234|Query|getItem',
      'AWS::AppSync::Resolver',
      { DataSourceName: 'changed' },
      {}
    );

    expect(result.attributes?.['ResolverArn']).toBe(
      appsyncArn(canonical, 'apis/abcd1234/types/Query/resolvers/getItem')
    );
  });

  // Whole-class fence: no ARN this provider records may carry an upper-case
  // character in its REGION segment, whichever arm produced it. Asserted on the
  // segment rather than on the whole ARN, because the resource-name segments
  // are the user's and are legitimately mixed-case (`myDataSource`).
  it('no recorded ARN carries an upper-cased region segment', async () => {
    process.env['AWS_REGION'] = 'US-EAST-1';
    const provider = new AppSyncProvider();
    mockSend.mockResolvedValue({ dataSource: {} });

    const created = await provider.create('DS', 'AWS::AppSync::DataSource', {
      ApiId: 'abcd1234',
      Name: 'myDataSource',
      Type: 'NONE',
    });
    const imported = await provider.import(
      importInput('AWS::AppSync::Resolver', 'abcd1234|Query|getItem', 'US-EAST-1')
    );

    const arns = [
      ...Object.values(created.attributes ?? {}),
      ...Object.values(imported?.attributes ?? {}),
    ].filter((value): value is string => typeof value === 'string' && value.startsWith('arn:'));

    // FLOOR, so the fence cannot go dark: the check below loops over ARN-valued
    // attributes, so an arm that stopped recording one would run zero
    // iterations and pass green.
    expect(arns.length).toBeGreaterThanOrEqual(2);
    for (const arn of arns) {
      expect(arn.split(':')[3]).toBe('us-east-1');
    }
  });
});
