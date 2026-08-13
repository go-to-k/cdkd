import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { substituteAgainstState } from '../../../src/local/state-resolver.js';

/**
 * Issue [#1795](https://github.com/go-to-k/cdkd/issues/1795): the three
 * `cdkd local *` commands derive `${AWS::URLSuffix}` from the RAW `--region`
 * the user typed, and `derivePartitionAndUrlSuffix` classified a region by
 * case-SENSITIVE `startsWith`. So `--region CN-NORTH-1` fell through to the
 * COMMERCIAL partition and each command synthesized
 * `<acct>.dkr.ecr.CN-NORTH-1.amazonaws.com/...` — a `cn-` region carrying the
 * commercial suffix, a host that does not exist.
 *
 * The fix has TWO halves and both are pinned here. `canonicalizeRegion` inside
 * `derivePartitionAndUrlSuffix` (`src/utils/aws-partition.ts`) fixes the
 * derived SUFFIX for every caller from ONE normalization point; each of the
 * three call sites ALSO folds the region VALUE, because the raw value seeds
 * every SDK client the command builds — AWS SDK endpoint resolution is
 * case-sensitive in exactly the same way, so `CN-NORTH-1` reached the
 * COMMERCIAL `sts.CN-NORTH-1.amazonaws.com` and `GetCallerIdentity` failed —
 * and is substituted verbatim as `${AWS::Region}` into every ARN.
 *
 * So each call site is asserted three ways: the suffix, the region VALUE, and
 * the RESOLVED image `Fn::Sub` those two compose into (the assertion that would
 * have caught a fix covering only the suffix). Every one is paired with a
 * commercial counter-case pinning byte-identical behavior.
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

/**
 * The `Fn::Sub` an ECS / Lambda template actually carries for the canonical
 * `ContainerImage.fromEcrRepository` shape, resolved against a pseudo-parameter
 * bag. Asserting the SUBSTITUTED host rather than the bag's individual fields
 * is what catches a bag whose `urlSuffix` is right but whose `region` is not —
 * the two compose into ONE hostname, and only the composition is the thing the
 * user's docker daemon has to resolve.
 */
const IMAGE_FN_SUB = {
  'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/my-repo:latest',
};

interface PseudoBag {
  accountId?: string | undefined;
  region?: string | undefined;
  partition?: string | undefined;
  urlSuffix?: string | undefined;
}

function resolveImageUri(pseudoParameters: PseudoBag | undefined): string {
  const result = substituteAgainstState(IMAGE_FN_SUB, {
    resources: {},
    pseudoParameters: pseudoParameters as never,
  });
  if (result.kind !== 'literal') {
    throw new Error(`image Fn::Sub did not resolve: ${result.reason}`);
  }
  return String(result.value);
}

describe('cdkd local invoke: --region case (issue #1795)', () => {
  const resolve = (region: string) =>
    resolvePseudoParametersForInvoke(undefined, { region } as never);

  it('derives the aws-cn suffix for CN-NORTH-1, same as cn-north-1', async () => {
    const upper = await resolve('CN-NORTH-1');
    const lower = await resolve('cn-north-1');

    expect(upper?.urlSuffix).toBe('amazonaws.com.cn');
    expect(upper?.partition).toBe('aws-cn');
    expect(upper?.urlSuffix).toBe(lower?.urlSuffix);
    expect(upper?.partition).toBe(lower?.partition);
  });

  it('canonicalizes the ${AWS::Region} VALUE, so the SDK client and every ARN agree', async () => {
    // The suffix alone is only half the fix: the region value seeds every SDK
    // client the command builds (endpoint resolution is case-sensitive too) and
    // is substituted verbatim into every ARN.
    expect((await resolve('CN-NORTH-1'))?.region).toBe('cn-north-1');
    expect((await resolve('US-EAST-1'))?.region).toBe('us-east-1');
  });

  it('resolves the image Fn::Sub to the SAME host for either --region case', async () => {
    expect(resolveImageUri(await resolve('CN-NORTH-1'))).toBe(
      '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo:latest'
    );
    expect(resolveImageUri(await resolve('CN-NORTH-1'))).toBe(
      resolveImageUri(await resolve('cn-north-1'))
    );
  });

  it('leaves the commercial partition byte-identical in either case', async () => {
    const upper = await resolve('US-EAST-1');
    const lower = await resolve('us-east-1');

    expect(upper).toEqual(lower);
    expect(resolveImageUri(upper)).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest'
    );
    expect(resolveImageUri(upper)).toBe(resolveImageUri(lower));
  });
});

describe('cdkd local start-api: --region case (issue #1795)', () => {
  const resolve = (region: string, stateRegion = 'us-east-1') =>
    resolvePseudoParametersForStartApi(stateRegion, { region } as never);

  it('derives the aws-cn suffix for CN-NORTH-1, same as cn-north-1', async () => {
    const upper = await resolve('CN-NORTH-1', 'cn-north-1');
    const lower = await resolve('cn-north-1', 'cn-north-1');

    expect(upper?.urlSuffix).toBe('amazonaws.com.cn');
    expect(upper?.partition).toBe('aws-cn');
    expect(upper?.urlSuffix).toBe(lower?.urlSuffix);
    expect(upper?.partition).toBe(lower?.partition);
  });

  it('canonicalizes the ${AWS::Region} VALUE, so the SDK client and every ARN agree', async () => {
    expect((await resolve('CN-NORTH-1', 'cn-north-1'))?.region).toBe('cn-north-1');
    expect((await resolve('US-EAST-1'))?.region).toBe('us-east-1');
  });

  it('canonicalizes an upper-cased STATE region too, not only --region', async () => {
    // The state record's region is the last of the four sources; folding only
    // the flag would leave this one raw.
    const bag = await resolvePseudoParametersForStartApi('CN-NORTH-1', {} as never);
    expect(bag?.region).toBe('cn-north-1');
    expect(bag?.urlSuffix).toBe('amazonaws.com.cn');
  });

  it('resolves the image Fn::Sub to the SAME host for either --region case', async () => {
    expect(resolveImageUri(await resolve('CN-NORTH-1', 'cn-north-1'))).toBe(
      '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo:latest'
    );
    expect(resolveImageUri(await resolve('CN-NORTH-1', 'cn-north-1'))).toBe(
      resolveImageUri(await resolve('cn-north-1', 'cn-north-1'))
    );
  });

  it('leaves the commercial partition byte-identical in either case', async () => {
    const upper = await resolve('US-EAST-1');
    const lower = await resolve('us-east-1');

    expect(upper).toEqual(lower);
    expect(resolveImageUri(upper)).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest'
    );
  });
});

describe('cdkd local run-task: --region case (issue #1795)', () => {
  const resolve = async (region: string): Promise<PseudoBag | undefined> =>
    (await buildEcsImageResolutionContext(ecsStack(), undefined, { region } as never))
      ?.pseudoParameters;

  it('derives the aws-cn suffix for CN-NORTH-1, same as cn-north-1', async () => {
    const upper = await resolve('CN-NORTH-1');
    const lower = await resolve('cn-north-1');

    expect(upper?.urlSuffix).toBe('amazonaws.com.cn');
    expect(upper?.partition).toBe('aws-cn');
    expect(upper?.urlSuffix).toBe(lower?.urlSuffix);
    expect(upper?.partition).toBe(lower?.partition);
  });

  it('canonicalizes the ${AWS::Region} VALUE, so the SDK client and every ARN agree', async () => {
    expect((await resolve('CN-NORTH-1'))?.region).toBe('cn-north-1');
    expect((await resolve('US-EAST-1'))?.region).toBe('us-east-1');
  });

  it('resolves the container image Fn::Sub to the SAME host for either --region case', async () => {
    expect(resolveImageUri(await resolve('CN-NORTH-1'))).toBe(
      '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo:latest'
    );
    expect(resolveImageUri(await resolve('CN-NORTH-1'))).toBe(
      resolveImageUri(await resolve('cn-north-1'))
    );
  });

  it('leaves the commercial partition byte-identical in either case', async () => {
    const upper = await resolve('US-EAST-1');
    const lower = await resolve('us-east-1');

    expect(upper).toEqual(lower);
    expect(resolveImageUri(upper)).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest'
    );
  });
});

/**
 * The three resolvers above cover the pseudo-parameter bag, but each command
 * ALSO hands `options.region` straight to SDK clients this file cannot reach
 * from a unit test — `applyRoleArnIfSet` / `assumeTaskRole` /
 * `loadBootstrapContainerRepo` in `local-run-task.ts`, and further down
 * `ecs-task-runner` -> `ecs-secrets-resolver`'s SecretsManager + SSM clients.
 * Folding once at the handler entry is what makes those canonical, so the
 * statement is pinned at source level (same pattern as the resource-timeout
 * registry seeding pin in tests/unit/provisioning/resource-timeout-registry.test.ts).
 */
describe('cdkd local *: --region is folded at the handler entry (source-level pin)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const commands = ['local-run-task.ts', 'local-invoke.ts', 'local-start-api.ts'];

  it.each(commands)('%s canonicalizes options.region before using it', (file) => {
    const src = readFileSync(join(repoRoot, 'src', 'cli', 'commands', file), 'utf8');
    // LIVE lines only — a commented-out fold must fail this pin, not satisfy it.
    const liveLines = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(
      liveLines,
      `${file}: live options.region canonicalization not found`
    ).toContain('options.region = canonicalizeRegion(options.region)');
  });
});
