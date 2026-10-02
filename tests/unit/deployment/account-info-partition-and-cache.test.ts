import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  getAccountInfo,
  resetAccountInfoCache,
  accountInfoClock,
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  }),
}));

const stsSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: stsSend }, ec2: { send: vi.fn() } }),
}));

/**
 * Issue #1730. Two independent defects in `getAccountInfo`:
 *
 * 1. `partition` was hardcoded to `'aws'` on BOTH the success and the failure
 *    path, so every ARN built from it — this module's own `Fn::GetAtt`
 *    construction plus `CloudControlProvider`'s enrichment sites — was wrong
 *    outside the commercial partition, and structurally valid, so nothing
 *    downstream could catch it.
 * 2. The FABRICATED fallback was cached for the process, so one transient STS
 *    failure poisoned every later caller in the run.
 */
describe('getAccountInfo partition + caching (issue #1730)', () => {
  const originalRegion = process.env['AWS_REGION'];
  const originalAccountId = process.env['AWS_ACCOUNT_ID'];
  const realNow = accountInfoClock.now;
  let now = 1_000_000;

  beforeEach(() => {
    resetAccountInfoCache();
    stsSend.mockReset();
    warnSpy.mockClear();
    delete process.env['AWS_ACCOUNT_ID'];
    process.env['AWS_REGION'] = 'us-east-1';
    now = 1_000_000;
    accountInfoClock.now = () => now;
  });

  afterEach(() => {
    resetAccountInfoCache();
    accountInfoClock.now = realNow;
    if (originalRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalRegion;
    if (originalAccountId === undefined) delete process.env['AWS_ACCOUNT_ID'];
    else process.env['AWS_ACCOUNT_ID'] = originalAccountId;
  });

  const succeed = (account = '123456789012') =>
    stsSend.mockResolvedValue({ Account: account });

  it('derives the partition from the region on the success path', async () => {
    succeed();
    process.env['AWS_REGION'] = 'cn-north-1';
    const info = await getAccountInfo();
    expect(info.partition).toBe('aws-cn');
  });

  it('derives aws-us-gov for a GovCloud region', async () => {
    succeed();
    process.env['AWS_REGION'] = 'us-gov-west-1';
    const info = await getAccountInfo();
    expect(info.partition).toBe('aws-us-gov');
  });

  /**
   * Issue [#1882](https://github.com/go-to-k/cdkd/issues/1882): the ENV arm of
   * `effectiveAccountInfoRegion`'s fold.
   *
   * The fold is written over the whole `overrideRegion || AWS_REGION`
   * expression, so it has TWO input paths, and every case added with the fix
   * supplied an `overrideRegion` -- the resolver hands `resolverRegion` in
   * explicitly, and that is captured in the constructor and is always a
   * non-empty string, which short-circuits the env read. Two independent
   * reviewers measured the consequence: mutating the source to
   * `canonicalizeRegion(overrideRegion) || process.env['AWS_REGION'] || ...`
   * left 400 tests green, this repo's own recorded "a fixture tripping every
   * clause of a disjunction fences none" failure.
   *
   * The env arm is reachable in production:
   * `CustomResourceProvider.resolveSyntheticStackId` calls
   * `getAccountInfo(this.configuredRegion)` with `undefined` for a region-less
   * client bag, and `cdkd gc` deliberately does not run `foldRegionOption`.
   * This case is not the ONLY one that catches an override-only fold -- the
   * ambient-arm synthetic-StackId case reds under the same mutation -- but it
   * is the one that isolates the arm rather than reaching it through a
   * provider.
   *
   * Calling `getAccountInfo()` with NO argument is what makes this reach the
   * arm -- a region-less resolver does not, because its constructor
   * substitutes the env value and then passes it as the override.
   *
   * The region is deliberately NOT `us-east-1`. That value is also the
   * function's hard-coded fallback, so an expectation of `'us-east-1'` is a
   * CONFLUENCE POINT: deleting the env read entirely still produces it, and a
   * probe measured this case staying GREEN under exactly that mutation. A
   * region unequal to the default is what makes the assertion discriminate
   * between "the env arm was read and folded" and "the env arm was skipped".
   */
  it('folds the AWS_REGION arm, not only the explicit override (issue #1882)', async () => {
    succeed();
    process.env['AWS_REGION'] = 'SA-EAST-1';
    const info = await getAccountInfo();
    expect(info.region).toBe('sa-east-1');
  });

  it('folds the explicit override arm too, and leaves a canonical one alone', async () => {
    succeed();
    process.env['AWS_REGION'] = 'us-east-1';
    expect((await getAccountInfo('AP-NORTHEAST-1')).region).toBe('ap-northeast-1');
    resetAccountInfoCache();
    succeed();
    expect((await getAccountInfo('ap-northeast-1')).region).toBe('ap-northeast-1');
  });

  it('still answers aws for a commercial region', async () => {
    succeed();
    const info = await getAccountInfo();
    expect(info.partition).toBe('aws');
  });

  it('honors an override region for the partition on the FIRST call', async () => {
    succeed();
    const info = await getAccountInfo('cn-northwest-1');
    expect(info.region).toBe('cn-northwest-1');
    expect(info.partition).toBe('aws-cn');
  });

  it('re-derives the partition for an override served from the CACHE', async () => {
    succeed();
    const first = await getAccountInfo();
    expect(first.partition).toBe('aws');

    // Served from the cache, whose partition was derived for us-east-1.
    const overridden = await getAccountInfo('cn-north-1');
    expect(overridden.region).toBe('cn-north-1');
    expect(overridden.partition).toBe('aws-cn');
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  /**
   * Issue #1730, direction (1): with no account from STS and no
   * `AWS_ACCOUNT_ID`, there is no honest answer, so `getAccountInfo` REFUSES.
   * It used to answer the hardcoded `123456789012`, which no consumer could
   * tell from a real account.
   */
  it('REFUSES when STS fails and AWS_ACCOUNT_ID is unset — no placeholder account', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const error = await getAccountInfo().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/^Cannot determine the AWS account id: STS GetCallerIdentity failed/);
    expect(message).toContain('STS unreachable');
    expect(message).toContain('set AWS_ACCOUNT_ID');
    expect(message).toContain('aws sts get-caller-identity');
    expect(message).not.toContain('123456789012');
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe('STS unreachable');
  });

  it('REFUSES a SUCCESS that carried no Account too', async () => {
    stsSend.mockResolvedValue({});
    await expect(getAccountInfo()).rejects.toThrow(
      /Cannot determine the AWS account id: STS GetCallerIdentity returned no Account/
    );
  });

  /**
   * The refusal is THROWN, so it is persisted to the deployment event log; an
   * AWS-authored message can spell out the caller's identity. Only the wire
   * class reaches the thrown text.
   */
  it('puts only the AWS failure CLASS into the thrown message, never its text', async () => {
    const awsError = Object.assign(
      new Error('User arn:aws:sts::444455556666:assumed-role/Deployer/me is not authorized'),
      { name: 'AccessDenied', $fault: 'client', $metadata: { httpStatusCode: 403 } }
    );
    stsSend.mockRejectedValue(awsError);
    const error = await getAccountInfo().then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(error?.message).toContain('AccessDenied');
    expect(error?.message).not.toContain('444455556666');
    expect(error?.message).not.toContain('assumed-role');
  });

  it('does NOT cache a refusal — the next call asks STS again and heals', async () => {
    stsSend.mockRejectedValueOnce(new Error('transient STS blip'));
    await expect(getAccountInfo()).rejects.toThrow(/transient STS blip/);

    stsSend.mockResolvedValue({ Account: '999988887777' });
    const healed = await getAccountInfo();
    expect(healed.accountId).toBe('999988887777');
    expect(stsSend).toHaveBeenCalledTimes(2);
  });

  it('every sequential call after a failure re-asks STS (no negative cache)', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    for (let i = 0; i < 3; i++) await expect(getAccountInfo()).rejects.toThrow(/STS unreachable/);
    expect(stsSend).toHaveBeenCalledTimes(3);
  });

  it('uses AWS_ACCOUNT_ID when STS fails, deriving the partition from the region', async () => {
    process.env['AWS_ACCOUNT_ID'] = '111122223333';
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    process.env['AWS_REGION'] = 'us-gov-east-1';
    const info = await getAccountInfo();
    expect(info.accountId).toBe('111122223333');
    expect(info.partition).toBe('aws-us-gov');
    const overridden = await getAccountInfo('cn-northwest-1');
    expect(overridden.region).toBe('cn-northwest-1');
    expect(overridden.partition).toBe('aws-cn');
  });

  it('uses AWS_ACCOUNT_ID when STS answers with no Account', async () => {
    process.env['AWS_ACCOUNT_ID'] = '111122223333';
    stsSend.mockResolvedValue({});
    expect((await getAccountInfo()).accountId).toBe('111122223333');
  });

  it('prefers the REAL STS answer over AWS_ACCOUNT_ID when STS succeeds', async () => {
    process.env['AWS_ACCOUNT_ID'] = '111122223333';
    succeed('999988887777');
    expect((await getAccountInfo()).accountId).toBe('999988887777');
  });

  /**
   * PR review: the TTL collapses SEQUENTIAL callers only. `cdkd deploy
   * --concurrency 10` resolves ten resources' intrinsics at once, so without
   * in-flight dedup an STS outage still costs ten calls (each with the SDK's
   * own retry) and ten identical warnings per window.
   */
  it('shares ONE STS round trip across concurrent callers', async () => {
    let resolveSts: ((value: unknown) => void) | undefined;
    stsSend.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSts = resolve;
        })
    );
    const inFlight = Promise.all(Array.from({ length: 10 }, () => getAccountInfo()));
    await Promise.resolve();
    resolveSts?.({ Account: '999988887777' });
    const results = await inFlight;

    expect(stsSend).toHaveBeenCalledTimes(1);
    for (const info of results) expect(info.accountId).toBe('999988887777');
  });

  it('dedups concurrent callers on the FAILURE path too, rejecting each', async () => {
    let rejectSts: ((reason: unknown) => void) | undefined;
    stsSend.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSts = reject;
        })
    );
    const inFlight = Promise.allSettled(Array.from({ length: 10 }, () => getAccountInfo()));
    await Promise.resolve();
    rejectSts?.(new Error('STS unreachable'));
    const results = await inFlight;

    expect(stsSend).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result.status).toBe('rejected');
  });

  it('a concurrent caller with its own override still gets its own partition', async () => {
    let resolveSts: ((value: unknown) => void) | undefined;
    stsSend.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSts = resolve;
        })
    );
    const both = Promise.all([getAccountInfo(), getAccountInfo('cn-north-1')]);
    await Promise.resolve();
    resolveSts?.({ Account: '999988887777' });
    const [plain, overridden] = await both;

    expect(stsSend).toHaveBeenCalledTimes(1);
    expect(plain?.partition).toBe('aws');
    expect(overridden?.partition).toBe('aws-cn');
    expect(overridden?.region).toBe('cn-north-1');
  });

  it('releases the in-flight slot after a failure so a later call can retry', async () => {
    stsSend.mockRejectedValueOnce(new Error('blip'));
    await expect(getAccountInfo()).rejects.toThrow(/blip/);
    stsSend.mockResolvedValue({ Account: '999988887777' });
    const healed = await getAccountInfo();
    expect(healed.accountId).toBe('999988887777');
    expect(stsSend).toHaveBeenCalledTimes(2);
  });

  it('still caches a real answer (one STS round trip per run)', async () => {
    succeed('555566667777');
    await getAccountInfo();
    await getAccountInfo();
    await getAccountInfo();
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

});

/**
 * The consumer half: `constructAttribute` builds ~30 account-bearing ARNs, and
 * an ARN carrying the placeholder account has no wildcard for
 * `isPlaceholderArn` (#1681) to catch — it is served as the resource's
 * `Fn::GetAtt` answer and recorded into state.
 *
 * The refusal is keyed on the CONSTRUCTED VALUE containing the fabricated
 * account, never on the attribute NAME: `AWS::S3::Bucket`'s `Arn` has no
 * account field, so a name-based `*Arn` guard would refuse a value the
 * fabricated id cannot corrupt. The counter-cases are what pin that.
 */
describe('Fn::GetAtt refuses an ARN built from a fabricated account (issue #1730)', () => {
  const originalRegion = process.env['AWS_REGION'];
  const originalAccountId = process.env['AWS_ACCOUNT_ID'];

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
          attributes: {},
          dependencies: [],
        },
      },
    };
  };

  beforeEach(() => {
    resetAccountInfoCache();
    stsSend.mockReset();
    warnSpy.mockClear();
    delete process.env['AWS_ACCOUNT_ID'];
    process.env['AWS_REGION'] = 'us-east-1';
  });

  afterEach(() => {
    resetAccountInfoCache();
    if (originalRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalRegion;
    if (originalAccountId === undefined) delete process.env['AWS_ACCOUNT_ID'];
    else process.env['AWS_ACCOUNT_ID'] = originalAccountId;
  });

  /**
   * PR-review BLOCKER: the guard originally matched the colon-delimited
   * `:<accountId>:` an ARN uses, but `RepositoryUri` embeds the account with no
   * colons (`<acct>.dkr.ecr.<region>.amazonaws.com/<repo>`) — the only such site
   * in `constructAttribute`. `CloudControlProvider` omits that exact attribute
   * when the account is fabricated, and the resolver then served it anyway,
   * nullifying the omission.
   */
  it('refuses ECR RepositoryUri, whose account embedding has no colons', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['Thing', 'RepositoryUri'] },
        mkContext('AWS::ECR::Repository', 'my-repo')
      )
    ).rejects.toThrow(/placeholder account 123456789012/);
  });

  it('resolves ECR RepositoryUri normally for a REAL account (counter-case)', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });
    const resolver = new IntrinsicFunctionResolver();
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Thing', 'RepositoryUri'] },
      mkContext('AWS::ECR::Repository', 'my-repo')
    );
    expect(result).toBe('999988887777.dkr.ecr.us-east-1.amazonaws.com/my-repo');
  });

  it('the ECR registry host follows the partition URL suffix in aws-cn', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });
    process.env['AWS_REGION'] = 'cn-north-1';
    const resolver = new IntrinsicFunctionResolver('cn-north-1');
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Thing', 'RepositoryUri'] },
      mkContext('AWS::ECR::Repository', 'my-repo')
    );
    expect(result).toBe('999988887777.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo');
  });

  // The documented fail-SAFE over-refusal: a value that merely CONTAINS the
  // placeholder digits is refused rather than served, and only while STS fails.
  it('refuses a value that merely CONTAINS the placeholder digits (documented fail-safe)', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['Thing', 'Arn'] },
        mkContext('AWS::DynamoDB::Table', 'table-123456789012-x')
      )
    ).rejects.toThrow(IntrinsicResolutionRefusalError);
  });

  it('refuses an account-bearing ARN when STS could not answer', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['Thing', 'Arn'] },
        mkContext('AWS::DynamoDB::Table', 'my-table')
      )
    ).rejects.toThrow(IntrinsicResolutionRefusalError);
  });

  it('the refusal names the placeholder account and the remedy', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['Thing', 'Arn'] },
        mkContext('AWS::DynamoDB::Table', 'my-table')
      )
    ).rejects.toThrow(/placeholder account 123456789012.*set AWS_ACCOUNT_ID/s);
  });

  it('does NOT refuse an ARN with no account field (S3 bucket, counter-case)', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Thing', 'Arn'] },
      mkContext('AWS::S3::Bucket', 'my-bucket')
    );
    expect(result).toBe('arn:aws:s3:::my-bucket');
  });

  it('does NOT refuse a non-ARN attribute of the same resource (counter-case)', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Thing', 'DomainName'] },
      mkContext('AWS::S3::Bucket', 'my-bucket')
    );
    expect(result).toBe('my-bucket.s3.amazonaws.com');
  });

  it('resolves the account-bearing ARN normally for a REAL account (counter-case)', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });
    const resolver = new IntrinsicFunctionResolver();
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Thing', 'Arn'] },
      mkContext('AWS::DynamoDB::Table', 'my-table')
    );
    expect(result).toBe('arn:aws:dynamodb:us-east-1:999988887777:table/my-table');
  });

  it('an operator-supplied AWS_ACCOUNT_ID is trusted and resolves (counter-case)', async () => {
    process.env['AWS_ACCOUNT_ID'] = '111122223333';
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Thing', 'Arn'] },
      mkContext('AWS::DynamoDB::Table', 'my-table')
    );
    expect(result).toBe('arn:aws:dynamodb:us-east-1:111122223333:table/my-table');
  });

  /**
   * PR review: `AWS::StackId` and `AWS::URLSuffix` were the same hardcoded-
   * partition defect one site over, with the derived values already in scope.
   */
  it('AWS::StackId carries the derived partition, not a hardcoded aws', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });
    process.env['AWS_REGION'] = 'cn-north-1';
    const resolver = new IntrinsicFunctionResolver('cn-north-1');
    const result = await resolver.resolve(
      { Ref: 'AWS::StackId' },
      { ...mkContext('AWS::S3::Bucket', 'b'), stackName: 'MyStack' }
    );
    expect(result).toMatch(/^arn:aws-cn:cloudformation:cn-north-1:999988887777:stack\/MyStack\//);
  });

  it('AWS::URLSuffix follows the partition too', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });
    process.env['AWS_REGION'] = 'cn-north-1';
    const resolver = new IntrinsicFunctionResolver('cn-north-1');
    const result = await resolver.resolve(
      { Ref: 'AWS::URLSuffix' },
      mkContext('AWS::S3::Bucket', 'b')
    );
    expect(result).toBe('amazonaws.com.cn');
  });

  it('AWS::URLSuffix stays amazonaws.com in a commercial region (counter-case)', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const result = await resolver.resolve(
      { Ref: 'AWS::URLSuffix' },
      mkContext('AWS::S3::Bucket', 'b')
    );
    expect(result).toBe('amazonaws.com');
  });

  it('propagates out of an Fn::Sub too (the #1740 half, end to end)', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve(
        { 'Fn::Sub': 'x-${Thing.Arn}-y' },
        mkContext('AWS::DynamoDB::Table', 'my-table')
      )
    ).rejects.toThrow(/placeholder account 123456789012/);
  });
});
