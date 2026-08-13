import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Issue [#1795](https://github.com/go-to-k/cdkd/issues/1795): the three
 * `cdkd local *` commands derive `${AWS::URLSuffix}` from the RAW `--region`
 * the user typed, and `derivePartitionAndUrlSuffix` classified a region by
 * case-SENSITIVE `startsWith`. So `--region CN-NORTH-1` fell through to the
 * COMMERCIAL partition and each command synthesized
 * `<acct>.dkr.ecr.CN-NORTH-1.amazonaws.com/...` — a `cn-` region carrying the
 * commercial suffix, a host that does not exist.
 *
 * The fix canonicalizes inside the shared helper (`src/utils/aws-partition.ts`)
 * so every caller inherits ONE normalization point. These tests assert the
 * consumer-visible effect at EACH of the three call sites rather than only on
 * the helper: an upper-cased `--region` must produce the same
 * `${AWS::URLSuffix}` as its lower-cased form, with a commercial counter-case
 * pinning that the fallback path is byte-identical.
 *
 * STS is mocked because every one of the three resolvers issues a single
 * `GetCallerIdentity` for `${AWS::AccountId}` before deriving the suffix.
 */
const stsMock = vi.hoisted(() => ({
  send: vi.fn(async () => ({ Account: '123456789012' })),
  destroy: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => stsMock),
  GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand(this: unknown) {}),
}));

const { resolvePseudoParametersForInvoke } = await import(
  '../../../src/cli/commands/local-invoke.js'
);
const { resolvePseudoParametersForStartApi } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { buildEcsImageResolutionContext } = await import(
  '../../../src/cli/commands/local-run-task.js'
);

/**
 * A stack whose only ECS container image is an `Fn::Sub` over the AWS pseudo
 * parameters — the canonical `ContainerImage.fromEcrRepository` shape, and the
 * one `detectEcsImageResolutionNeeds` flags as needing pseudo parameters.
 */
function ecsStack(): StackInfo {
  return {
    stackName: 'RegionCaseStack',
    displayName: 'RegionCaseStack',
    artifactId: 'RegionCaseStack',
    dependencyNames: [],
    template: {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: {
                  'Fn::Sub':
                    '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/my-repo:latest',
                },
              },
            ],
          },
        },
      },
    },
  };
}

beforeEach(() => {
  stsMock.send.mockClear();
  stsMock.destroy.mockClear();
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
});

describe('cdkd local invoke: --region case does not change ${AWS::URLSuffix} (issue #1795)', () => {
  it('derives the aws-cn suffix for CN-NORTH-1, same as cn-north-1', async () => {
    const upper = await resolvePseudoParametersForInvoke(undefined, {
      region: 'CN-NORTH-1',
    } as never);
    const lower = await resolvePseudoParametersForInvoke(undefined, {
      region: 'cn-north-1',
    } as never);

    expect(upper?.urlSuffix).toBe('amazonaws.com.cn');
    expect(upper?.partition).toBe('aws-cn');
    expect(upper?.urlSuffix).toBe(lower?.urlSuffix);
    expect(upper?.partition).toBe(lower?.partition);
  });

  it('leaves the commercial partition byte-identical in either case', async () => {
    const upper = await resolvePseudoParametersForInvoke(undefined, {
      region: 'US-EAST-1',
    } as never);
    const lower = await resolvePseudoParametersForInvoke(undefined, {
      region: 'us-east-1',
    } as never);

    expect(upper?.urlSuffix).toBe('amazonaws.com');
    expect(upper?.partition).toBe('aws');
    expect(upper?.urlSuffix).toBe(lower?.urlSuffix);
    expect(upper?.partition).toBe(lower?.partition);
  });
});

describe('cdkd local start-api: --region case does not change ${AWS::URLSuffix} (issue #1795)', () => {
  it('derives the aws-cn suffix for CN-NORTH-1, same as cn-north-1', async () => {
    const upper = await resolvePseudoParametersForStartApi('cn-north-1', {
      region: 'CN-NORTH-1',
    } as never);
    const lower = await resolvePseudoParametersForStartApi('cn-north-1', {
      region: 'cn-north-1',
    } as never);

    expect(upper?.urlSuffix).toBe('amazonaws.com.cn');
    expect(upper?.partition).toBe('aws-cn');
    expect(upper?.urlSuffix).toBe(lower?.urlSuffix);
    expect(upper?.partition).toBe(lower?.partition);
  });

  it('leaves the commercial partition byte-identical in either case', async () => {
    const upper = await resolvePseudoParametersForStartApi('us-east-1', {
      region: 'US-EAST-1',
    } as never);
    const lower = await resolvePseudoParametersForStartApi('us-east-1', {
      region: 'us-east-1',
    } as never);

    expect(upper?.urlSuffix).toBe('amazonaws.com');
    expect(upper?.partition).toBe('aws');
    expect(upper?.urlSuffix).toBe(lower?.urlSuffix);
    expect(upper?.partition).toBe(lower?.partition);
  });
});

describe('cdkd local run-task: --region case does not change ${AWS::URLSuffix} (issue #1795)', () => {
  it('derives the aws-cn suffix for CN-NORTH-1, same as cn-north-1', async () => {
    const upper = await buildEcsImageResolutionContext(ecsStack(), undefined, {
      region: 'CN-NORTH-1',
    } as never);
    const lower = await buildEcsImageResolutionContext(ecsStack(), undefined, {
      region: 'cn-north-1',
    } as never);

    expect(upper?.pseudoParameters?.urlSuffix).toBe('amazonaws.com.cn');
    expect(upper?.pseudoParameters?.partition).toBe('aws-cn');
    expect(upper?.pseudoParameters?.urlSuffix).toBe(lower?.pseudoParameters?.urlSuffix);
    expect(upper?.pseudoParameters?.partition).toBe(lower?.pseudoParameters?.partition);
  });

  it('leaves the commercial partition byte-identical in either case', async () => {
    const upper = await buildEcsImageResolutionContext(ecsStack(), undefined, {
      region: 'US-EAST-1',
    } as never);
    const lower = await buildEcsImageResolutionContext(ecsStack(), undefined, {
      region: 'us-east-1',
    } as never);

    expect(upper?.pseudoParameters?.urlSuffix).toBe('amazonaws.com');
    expect(upper?.pseudoParameters?.partition).toBe('aws');
    expect(upper?.pseudoParameters?.urlSuffix).toBe(lower?.pseudoParameters?.urlSuffix);
    expect(upper?.pseudoParameters?.partition).toBe(lower?.pseudoParameters?.partition);
  });
});
