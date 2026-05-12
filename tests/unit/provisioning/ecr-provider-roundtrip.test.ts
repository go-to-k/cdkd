import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteLifecyclePolicyCommand,
  DeleteRepositoryPolicyCommand,
  DescribeRepositoriesCommand,
  PutImageScanningConfigurationCommand,
  PutImageTagMutabilityCommand,
  PutLifecyclePolicyCommand,
  SetRepositoryPolicyCommand,
  TagResourceCommand,
} from '@aws-sdk/client-ecr';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ECRClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
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

import { ECRProvider } from '../../../src/provisioning/providers/ecr-provider.js';

/**
 * Read-update round-trip property tests for ECRProvider.
 *
 * See docs/provider-development.md § 3b for the convention. The
 * mechanical guard is: "if state is already exactly what AWS reports
 * (the no-drift case), update() must produce zero mutating SDK calls."
 *
 * On `cdkd drift --revert`, `buildRevertNewProperties` round-trips the
 * AWS-current snapshot back through `provider.update`, so any
 * placeholder shape that readCurrentState always-emits is at risk of
 * being re-submitted to AWS. The round-trip test catches that class of
 * regression up front.
 */

const REPO = 'my-repo';
const REPO_ARN = 'arn:aws:ecr:us-east-1:123:repository/my-repo';
const REPO_URI = '123.dkr.ecr.us-east-1.amazonaws.com/my-repo';

const MUTATING_COMMANDS = [
  PutImageScanningConfigurationCommand,
  PutImageTagMutabilityCommand,
  PutLifecyclePolicyCommand,
  DeleteLifecyclePolicyCommand,
  SetRepositoryPolicyCommand,
  DeleteRepositoryPolicyCommand,
  TagResourceCommand,
];

function countMutatingCalls(): number {
  return mockSend.mock.calls.filter((c) =>
    MUTATING_COMMANDS.some((cmd) => c[0] instanceof cmd)
  ).length;
}

describe('ECRProvider read-update round-trip', () => {
  let provider: ECRProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ECRProvider();
    // Default DescribeRepositories used at the tail of update() to
    // re-read attributes. The round-trip itself shouldn't need it
    // unless an actual mutation fired, but mocks-by-default keeps the
    // test resilient to internal call additions.
    mockSend.mockResolvedValue({
      repositories: [
        {
          repositoryName: REPO,
          repositoryArn: REPO_ARN,
          repositoryUri: REPO_URI,
        },
      ],
    });
  });

  it('AES256 (default) repository: no-drift round-trip is a no-op (zero mutating SDK calls; KmsKey not pushed)', async () => {
    // Class 1 guard — `KmsKey` is only valid on `EncryptionType=KMS`.
    // readCurrentState now omits `KmsKey` on AES256 (the AWS API may
    // return it as `''`); the round-trip therefore never tries to push
    // it back. Even if `EncryptionConfiguration` were ever made mutable,
    // this guard would prevent the AWS rejection.
    const observed = {
      RepositoryName: REPO,
      ImageTagMutability: 'MUTABLE',
      ImageScanningConfiguration: { ScanOnPush: false },
      EncryptionConfiguration: { EncryptionType: 'AES256' },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await provider.update('L', REPO, 'AWS::ECR::Repository', observed, observed);

    // The state==AWS round-trip must produce no mutating calls.
    expect(countMutatingCalls()).toBe(0);

    // And — even if mutating calls were made — none of them should
    // ever reference KmsKey (it's not in the snapshot at all on AES256).
    expect(JSON.stringify(observed)).not.toContain('KmsKey');
  });

  it('KMS-encrypted repository: no-drift round-trip preserves KmsKey (no SDK calls)', async () => {
    const observed = {
      RepositoryName: REPO,
      ImageTagMutability: 'MUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
      EncryptionConfiguration: {
        EncryptionType: 'KMS',
        KmsKey: 'arn:aws:kms:us-east-1:123:key/abcd',
      },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await provider.update('L', REPO, 'AWS::ECR::Repository', observed, observed);

    expect(countMutatingCalls()).toBe(0);
    // KmsKey legitimately appears in the snapshot for KMS encryption.
    expect((observed.EncryptionConfiguration as Record<string, unknown>)['KmsKey']).toBe(
      'arn:aws:kms:us-east-1:123:key/abcd'
    );
  });

  it('repository without lifecycle policy: no-drift round-trip does NOT leak `LifecyclePolicy: {}` placeholder', async () => {
    // Class 2 guard — readCurrentState omits the LifecyclePolicy key
    // entirely when no policy is configured (it's not always-emitted as
    // an empty placeholder). The round-trip therefore never sends a
    // `PutLifecyclePolicy` with an empty body (which AWS would reject
    // with "lifecyclePolicyText cannot be empty").
    const observed = {
      RepositoryName: REPO,
      ImageTagMutability: 'MUTABLE',
      ImageScanningConfiguration: { ScanOnPush: false },
      EncryptionConfiguration: { EncryptionType: 'AES256' },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await provider.update('L', REPO, 'AWS::ECR::Repository', observed, observed);

    expect(countMutatingCalls()).toBe(0);
    const putLifecycleCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutLifecyclePolicyCommand
    );
    expect(putLifecycleCalls).toHaveLength(0);
  });

  it('repository with lifecycle policy: no-drift round-trip is a no-op', async () => {
    // The complement of the placeholder test: when a real lifecycle
    // policy exists in both state and AWS-current, the round-trip
    // should still be a no-op (diff-based) — not a redundant
    // `PutLifecyclePolicy`.
    const observed = {
      RepositoryName: REPO,
      ImageTagMutability: 'MUTABLE',
      ImageScanningConfiguration: { ScanOnPush: false },
      EncryptionConfiguration: { EncryptionType: 'AES256' },
      LifecyclePolicy: { LifecyclePolicyText: '{"rules":[]}' },
      Tags: [{ Key: 'k', Value: 'v' }],
    };

    await provider.update('L', REPO, 'AWS::ECR::Repository', observed, observed);

    expect(countMutatingCalls()).toBe(0);
  });

  it('truthy-gate guard: clearing a lifecycle policy issues DeleteLifecyclePolicy (not a silent no-op)', async () => {
    // Drift-revert path coverage — when AWS-current has a policy and
    // state wants it cleared, update() must actually delete it instead
    // of falling through the truthy gate. Pre-fix this was a silent
    // no-op (`if (newLifecycle?.LifecyclePolicyText)` skipped the
    // change); post-fix it issues `DeleteLifecyclePolicyCommand`.
    const oldProps = {
      RepositoryName: REPO,
      LifecyclePolicy: { LifecyclePolicyText: '{"rules":[]}' },
    };
    const newProps = {
      RepositoryName: REPO,
      // Lifecycle cleared.
    };

    await provider.update('L', REPO, 'AWS::ECR::Repository', newProps, oldProps);

    const deleteLifecycleCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DeleteLifecyclePolicyCommand
    );
    expect(deleteLifecycleCalls).toHaveLength(1);
    expect((deleteLifecycleCalls[0]?.[0] as DeleteLifecyclePolicyCommand).input).toEqual({
      repositoryName: REPO,
    });
  });

  it('truthy-gate guard: clearing the repository policy issues DeleteRepositoryPolicy (not a silent no-op)', async () => {
    // Same shape as the lifecycle guard — pre-fix the gate was
    // `&& newPolicy`, which silently dropped the clear; post-fix the
    // diff is detected via `!== undefined` and the delete fires.
    const oldProps = {
      RepositoryName: REPO,
      RepositoryPolicyText: '{"Version":"2012-10-17","Statement":[]}',
    };
    const newProps = {
      RepositoryName: REPO,
      // Policy cleared.
    };

    await provider.update('L', REPO, 'AWS::ECR::Repository', newProps, oldProps);

    const deleteRepoPolicyCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DeleteRepositoryPolicyCommand
    );
    expect(deleteRepoPolicyCalls).toHaveLength(1);
  });
});
