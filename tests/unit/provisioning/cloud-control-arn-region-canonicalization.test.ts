import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const ccClientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));
const getAccountInfoCalls = vi.hoisted(() => [] as (string | undefined)[]);

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    // `config.region` is a PROVIDER function on a real SDK client, not a string
    // — `accountInfoForSynthesizedArn` awaits it.
    cloudControl: {
      send: vi.fn(),
      config: { region: () => Promise.resolve(ccClientRegion.value) },
    },
    cloudFormation: { send: vi.fn() },
  }),
}));

// Mirrors the real `getAccountInfo` (issue #1746): the answer's `region` is the
// caller's override spelled EXACTLY as supplied — `effectiveAccountInfoRegion`
// is `overrideRegion || AWS_REGION || 'us-east-1'`, folded nowhere — while the
// `partition` is derived through `derivePartitionAndUrlSuffix`, which
// canonicalizes its own input (issue #1795). A mock that folded the region
// would make every assertion below pass with the fix reverted.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async () => {
  const { derivePartitionAndUrlSuffix } = await vi.importActual<
    typeof import('../../../src/utils/aws-partition.js')
  >('../../../src/utils/aws-partition.js');
  return {
    getAccountInfo: (overrideRegion?: string) => {
      getAccountInfoCalls.push(overrideRegion);
      const region = overrideRegion ?? 'us-east-1';
      return Promise.resolve({
        accountId: '123456789012',
        region,
        partition: derivePartitionAndUrlSuffix(region).partition,
      });
    },
  };
});

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

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';

/**
 * Issue [#1850](https://github.com/go-to-k/cdkd/issues/1850), the enrichment
 * half — the same defect as `AppSyncProvider.buildAppSyncArn`, at the four
 * `enrichResourceAttributes` sites that construct an identifier from
 * `<x>AccountInfo.region`: the KMS Key ARN, the ECR Repository ARN, the ECR
 * `RepositoryUri` host, and the Kinesis Stream ARN.
 *
 * The region reaching them is the CC client's own (`accountInfoForSynthesizedArn`
 * passes it as the override), i.e. whatever spelling `--region` / `AWS_REGION`
 * carried. `cdkd deploy --region US-EAST-1` SUCCEEDS — DNS is case-insensitive
 * — and cdkd then records `arn:aws:kms:US-EAST-1:...`, which no IAM policy
 * matches and every SDK call taking it rejects, into state.json.
 *
 * BOTH polarities are pinned per site: an upper-cased region must fold, and an
 * already-canonical one must come out byte-identical. Without the second half a
 * fold could be "satisfied" by any transformation that lowercases, including
 * one that mangles a canonical value.
 */
describe('CloudControlProvider folds the region in synthesized ARNs (issue #1850)', () => {
  let provider: CloudControlProvider;

  const enrich = (resourceType: string, physicalId: string) =>
    (
      provider as unknown as {
        enrichResourceAttributes: (
          resourceType: string,
          physicalId: string,
          attributes: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      }
    ).enrichResourceAttributes(resourceType, physicalId, {});

  beforeEach(() => {
    getAccountInfoCalls.length = 0;
    ccClientRegion.value = 'us-east-1';
    provider = new CloudControlProvider();
  });

  // One row per (site, polarity). The canonical rows are not padding: they are
  // what proves the fold is a no-op on the spelling every ordinary deploy uses.
  it.each([
    // KMS Key ARN
    [
      'US-EAST-1',
      'AWS::KMS::Key',
      'abcd-1234',
      'Arn',
      'arn:aws:kms:us-east-1:123456789012:key/abcd-1234',
    ],
    [
      'us-east-1',
      'AWS::KMS::Key',
      'abcd-1234',
      'Arn',
      'arn:aws:kms:us-east-1:123456789012:key/abcd-1234',
    ],
    // ECR Repository ARN
    [
      'US-EAST-1',
      'AWS::ECR::Repository',
      'my-repo',
      'Arn',
      'arn:aws:ecr:us-east-1:123456789012:repository/my-repo',
    ],
    [
      'us-east-1',
      'AWS::ECR::Repository',
      'my-repo',
      'Arn',
      'arn:aws:ecr:us-east-1:123456789012:repository/my-repo',
    ],
    // ECR RepositoryUri — a HOST rather than an ARN, and the site where the
    // spelling matters most: the value is handed to `docker` and parsed back by
    // `parseEcrRegistryHost`, whose canonical-segment guards an upper-cased
    // label has to get past.
    [
      'US-EAST-1',
      'AWS::ECR::Repository',
      'my-repo',
      'RepositoryUri',
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo',
    ],
    [
      'us-east-1',
      'AWS::ECR::Repository',
      'my-repo',
      'RepositoryUri',
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo',
    ],
    // Kinesis Stream ARN
    [
      'US-EAST-1',
      'AWS::Kinesis::Stream',
      'my-stream',
      'Arn',
      'arn:aws:kinesis:us-east-1:123456789012:stream/my-stream',
    ],
    [
      'us-east-1',
      'AWS::Kinesis::Stream',
      'my-stream',
      'Arn',
      'arn:aws:kinesis:us-east-1:123456789012:stream/my-stream',
    ],
  ])(
    'region %s: %s %s is enriched canonically',
    async (region, resourceType, physicalId, attribute, expected) => {
      ccClientRegion.value = region;

      const enriched = await enrich(resourceType, physicalId);

      expect(enriched[attribute]).toBe(expected);
      // The builder must have been handed the RAW spelling; otherwise the fold
      // under test is not what produced the canonical answer.
      expect(getAccountInfoCalls).toContain(region);
    }
  );

  // A non-commercial region, so the PARTITION and the region segment are folded
  // by two different mechanisms and both must land: the partition through
  // `derivePartitionAndUrlSuffix`'s own canonicalization (issue #1795), the
  // region segment through the fold this issue added.
  it.each([
    ['CN-NORTH-1', 'arn:aws-cn:kms:cn-north-1:123456789012:key/abcd-1234'],
    ['cn-north-1', 'arn:aws-cn:kms:cn-north-1:123456789012:key/abcd-1234'],
  ])('region %s carries the aws-cn partition AND a canonical region', async (region, expected) => {
    ccClientRegion.value = region;

    const enriched = await enrich('AWS::KMS::Key', 'abcd-1234');

    expect(enriched['Arn']).toBe(expected);
  });

  // The ECR host's URL SUFFIX must keep following the partition — the fold must
  // not have disturbed the issue #1730 derivation beside it.
  it.each([
    ['CN-NORTH-1', '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo'],
    ['cn-north-1', '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo'],
  ])('region %s keeps the partition URL suffix on RepositoryUri', async (region, expected) => {
    ccClientRegion.value = region;

    const enriched = await enrich('AWS::ECR::Repository', 'my-repo');

    expect(enriched['RepositoryUri']).toBe(expected);
  });

  // Same-string equality, not merely two values that each satisfy their own
  // expectation.
  it('an upper-cased region yields byte-identical values to the canonical one', async () => {
    ccClientRegion.value = 'US-EAST-1';
    const upperKms = await enrich('AWS::KMS::Key', 'abcd-1234');
    const upperEcr = await enrich('AWS::ECR::Repository', 'my-repo');
    const upperKinesis = await enrich('AWS::Kinesis::Stream', 'my-stream');

    ccClientRegion.value = 'us-east-1';
    const lowerKms = await enrich('AWS::KMS::Key', 'abcd-1234');
    const lowerEcr = await enrich('AWS::ECR::Repository', 'my-repo');
    const lowerKinesis = await enrich('AWS::Kinesis::Stream', 'my-stream');

    expect(upperKms['Arn']).toBe(lowerKms['Arn']);
    expect(upperEcr['Arn']).toBe(lowerEcr['Arn']);
    expect(upperEcr['RepositoryUri']).toBe(lowerEcr['RepositoryUri']);
    expect(upperKinesis['Arn']).toBe(lowerKinesis['Arn']);
  });

  // Whole-class fence over every synthesized value, so a NEW enrichment branch
  // that interpolates a raw region is caught here rather than in the field.
  it('no synthesized identifier carries an upper-cased region', async () => {
    ccClientRegion.value = 'US-EAST-1';

    const values: string[] = [];
    for (const [resourceType, physicalId] of [
      ['AWS::KMS::Key', 'abcd-1234'],
      ['AWS::ECR::Repository', 'my-repo'],
      ['AWS::Kinesis::Stream', 'my-stream'],
    ] as const) {
      const enriched = await enrich(resourceType, physicalId);
      values.push(
        ...Object.values(enriched).filter(
          (value): value is string =>
            typeof value === 'string' && (value.startsWith('arn:') || value.includes('.dkr.ecr.'))
        )
      );
    }

    // FLOOR, so the fence cannot go dark: an enrichment arm that stopped
    // recording its value would leave the loop below with nothing to check.
    expect(values.length).toBeGreaterThanOrEqual(4);
    for (const value of values) {
      expect(value).not.toContain('US-EAST-1');
      expect(value).toContain('us-east-1');
    }
  });
});
