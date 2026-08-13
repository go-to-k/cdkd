import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
    ec2: { send: vi.fn() },
  }),
}));

/**
 * Issue #1850: `constructAttribute` destructures the region ONCE and feeds it
 * to every ARN / URI it builds, so an upper-cased `--region` was recorded into
 * every constructed attribute verbatim.
 *
 * `cdkd deploy --region US-EAST-1` is REACHABLE — DNS is case-insensitive, so
 * the SDK endpoint resolves and the deploy SUCCEEDS — after which the resolved
 * value is one no IAM policy matches (policy matching IS case-sensitive).
 *
 * Every case below is asserted in BOTH polarities: the upper-cased region must
 * fold to the canonical segment, AND the already-canonical region must produce
 * a BYTE-IDENTICAL value. The second half is what stops the fold being
 * satisfied by a test that only ever sees one spelling.
 */
describe('IntrinsicFunctionResolver - constructed-attribute region fold (issue #1850)', () => {
  const savedAwsRegion = process.env['AWS_REGION'];

  beforeEach(() => {
    resetAccountInfoCache();
    delete process.env['AWS_REGION'];
  });

  // Vitest reuses workers across FILES, so an un-restored env var leaks into
  // whatever runs next in the same worker.
  afterEach(() => {
    if (savedAwsRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedAwsRegion;
  });

  const mkContext = (resourceType: string, physicalId: string): ResolverContext => {
    const template: CloudFormationTemplate = {
      Resources: { Thing: { Type: resourceType, Properties: {} } },
    };
    return {
      template,
      resources: {
        Thing: {
          physicalId,
          resourceType,
          properties: {},
          // Deliberately EMPTY: `constructAttribute` is only reached when the
          // attribute is not already cached on the state record.
          attributes: {},
          dependencies: [],
        },
      },
    };
  };

  /** Resolve one `Fn::GetAtt` with the resolver pinned to `region`. */
  const resolveAttr = async (
    region: string,
    resourceType: string,
    physicalId: string,
    attribute: string
  ): Promise<unknown> => {
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver(region);
    return resolver.resolve(
      { 'Fn::GetAtt': ['Thing', attribute] },
      mkContext(resourceType, physicalId)
    );
  };

  // One row per SHAPE the destructured region reaches: a plain service ARN, an
  // ARN whose resource segment carries a suffix, and the ECR registry HOST
  // (not an ARN at all — the value handed to `docker`).
  const CASES: ReadonlyArray<{
    readonly name: string;
    readonly resourceType: string;
    readonly physicalId: string;
    readonly attribute: string;
    readonly expected: string;
  }> = [
    {
      name: 'AWS::SNS::Topic TopicArn',
      resourceType: 'AWS::SNS::Topic',
      physicalId: 'my-topic',
      attribute: 'TopicArn',
      expected: 'arn:aws:sns:us-east-1:123456789012:my-topic',
    },
    {
      name: 'AWS::Logs::LogGroup Arn (trailing :* segment)',
      resourceType: 'AWS::Logs::LogGroup',
      physicalId: '/aws/lambda/my-fn',
      attribute: 'Arn',
      expected: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-fn:*',
    },
    {
      name: 'AWS::ECR::Repository Arn',
      resourceType: 'AWS::ECR::Repository',
      physicalId: 'my-repo',
      attribute: 'Arn',
      expected: 'arn:aws:ecr:us-east-1:123456789012:repository/my-repo',
    },
    {
      name: 'AWS::ECR::Repository RepositoryUri (a HOST, not an ARN)',
      resourceType: 'AWS::ECR::Repository',
      physicalId: 'my-repo',
      attribute: 'RepositoryUri',
      expected: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo',
    },
    {
      name: 'AWS::DynamoDB::Table Arn',
      resourceType: 'AWS::DynamoDB::Table',
      physicalId: 'my-table',
      attribute: 'Arn',
      expected: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table',
    },
  ];

  for (const c of CASES) {
    it(`folds an upper-cased region in ${c.name}`, async () => {
      const result = await resolveAttr('US-EAST-1', c.resourceType, c.physicalId, c.attribute);
      expect(result).toBe(c.expected);
    });

    it(`leaves an already-canonical region byte-identical in ${c.name}`, async () => {
      const result = await resolveAttr('us-east-1', c.resourceType, c.physicalId, c.attribute);
      expect(result).toBe(c.expected);
    });
  }

  it('folds a MIXED-case region, not only a fully upper-cased one', async () => {
    const result = await resolveAttr('Us-East-1', 'AWS::SNS::Topic', 'my-topic', 'TopicArn');
    expect(result).toBe('arn:aws:sns:us-east-1:123456789012:my-topic');
  });

  /**
   * The PARTITION is derived through `derivePartitionAndUrlSuffix`, which
   * canonicalizes its own input (issue #1795) — so it was already correct for
   * an upper-cased region and must STAY correct now that the region segment is
   * folded too. Pins that the two folds compose rather than fight: a China
   * region must still yield `aws-cn` AND the canonical region spelling.
   */
  it('keeps the partition correct while folding the region (aws-cn)', async () => {
    const result = await resolveAttr('CN-NORTH-1', 'AWS::SNS::Topic', 'my-topic', 'TopicArn');
    expect(result).toBe('arn:aws-cn:sns:cn-north-1:123456789012:my-topic');
  });

  /**
   * The URL SUFFIX is partition-derived too, and the ECR host is where the
   * region and the suffix appear side by side — so an upper-cased China region
   * must fold the region AND keep `amazonaws.com.cn`.
   */
  it('keeps the URL suffix correct while folding the region (aws-cn ECR host)', async () => {
    const result = await resolveAttr(
      'CN-NORTH-1',
      'AWS::ECR::Repository',
      'my-repo',
      'RepositoryUri'
    );
    expect(result).toBe('123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo');
  });
  /**
   * The S3 branches are the ONLY ones that hand the folded region OUT to
   * another module (`src/utils/s3-endpoints.ts`), and `WebsiteURL` is the only
   * value in the whole resolver where the region flips a BRANCH rather than a
   * substring: the separator comes from a case-sensitive Set lookup, so an
   * upper-cased region misses the legacy-dash set entirely.
   *
   * That module folds on entry too, so this row would pass even with the
   * destructure fold reverted — it is here to pin the END-TO-END answer
   * through the cross-module hop, not to discriminate the local fold. The
   * discriminating test for the helpers themselves lives in
   * `tests/unit/utils/s3-endpoints.test.ts`.
   */
  it('resolves an S3 WebsiteURL through the legacy-dash branch for an upper-cased region', async () => {
    const result = await resolveAttr('US-EAST-1', 'AWS::S3::Bucket', 'my-bucket', 'WebsiteURL');
    expect(result).toBe('http://my-bucket.s3-website-us-east-1.amazonaws.com');
  });

  it('resolves an S3 RegionalDomainName with the canonical region for an upper-cased region', async () => {
    const result = await resolveAttr(
      'US-EAST-1',
      'AWS::S3::Bucket',
      'my-bucket',
      'RegionalDomainName'
    );
    expect(result).toBe('my-bucket.s3.us-east-1.amazonaws.com');
  });
  /**
   * `AWS::StackId` is built in `resolvePseudoParameter`, NOT in
   * `constructAttribute`, so it does not inherit the destructure fold and needs
   * its own. The row exists because the fold's comment calls itself exhaustive
   * and that is only true within the one method — this is the sibling that
   * proves the scoping is real rather than assumed.
   *
   * Its neighbour `AWS::Region` is deliberately NOT folded (issue #1882): it is
   * CloudFormation's own passthrough, so changing what a user reads back needs
   * a live CFn A/B first. Pinned here so the divergence is a recorded decision
   * rather than an oversight the next reader has to re-derive.
   */
  it('folds the region in the synthetic AWS::StackId', async () => {
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('US-EAST-1');
    const ctx = { ...mkContext('AWS::SNS::Topic', 'my-topic'), stackName: 'MyStack' };
    const result = await resolver.resolve({ Ref: 'AWS::StackId' }, ctx);
    expect(result).toBe(
      'arn:aws:cloudformation:us-east-1:123456789012:stack/MyStack/cdkd'
    );
  });

  it('leaves AWS::Region as the raw spelling (issue #1882, deliberate)', async () => {
    resetAccountInfoCache();
    const resolver = new IntrinsicFunctionResolver('US-EAST-1');
    const ctx = mkContext('AWS::SNS::Topic', 'my-topic');
    expect(await resolver.resolve({ Ref: 'AWS::Region' }, ctx)).toBe('US-EAST-1');
  });
});
