import { readFileSync, readdirSync } from 'node:fs';
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
  // `local-invoke-agentcore.ts` was added by issue
  // [#1814](https://github.com/go-to-k/cdkd/issues/1814): it is the one
  // region-taking `cdkd local` command the #1795 sweep skipped, and its raw
  // `--region` reached three consumers that are case-SENSITIVE in the same
  // direction the partition table is — the SigV4 signing SCOPE (where
  // `--region` has the highest precedence), the `STSClient` endpoint
  // resolution, and `applyRoleArnIfSet`. None of those are reachable from a
  // unit test, which is exactly why the fold is pinned at source level here
  // rather than asserted through a behavior test.
  const FOLD = 'options.region = canonicalizeRegion(options.region)';
  const commandsDir = join(repoRoot, 'src', 'cli', 'commands');

  /**
   * LIVE lines only — a commented-out fold must FAIL this pin, not satisfy it,
   * and a JSDoc that merely MENTIONS `options.region` above the fold must not
   * false-fail the ordering check below.
   *
   * Comment lines are BLANKED rather than dropped, so indices stay aligned with
   * the real file and the failure message can quote a usable line number. Block
   * comments are blanked across their whole span for the same reason (the
   * sibling `intrinsic-image.test.ts` strips them instead — it reports no line
   * numbers, so it does not need the alignment).
   */
  const liveLinesOf = (file: string): string[] => {
    let inBlock = false;
    return readFileSync(join(commandsDir, file), 'utf8')
      .split('\n')
      .map((line) => {
        const trimmed = line.trimStart();
        if (inBlock) {
          if (trimmed.includes('*/')) inBlock = false;
          return '';
        }
        if (trimmed.startsWith('/*')) {
          if (!trimmed.includes('*/')) inBlock = true;
          return '';
        }
        if (trimmed.startsWith('//')) return '';
        return line.replace(/\/\/.*$/, '');
      });
  };

  /**
   * DERIVED, not hand-listed. A hardcoded array cannot fail for a command that
   * does not exist yet — the same reason the #1814 binding proof sweeps `src/`
   * rather than naming its call sites. Every `local-*` command that READS
   * `options.region` must fold it; one that never reads it needs nothing.
   * (Measured 2026-08-13: exactly four do. `local-start-{cloudfront,service,alb}.ts`
   * read it zero times.)
   */
  const commands = readdirSync(commandsDir)
    .filter((f) => f.startsWith('local-') && f.endsWith('.ts'))
    .filter((f) => liveLinesOf(f).some((line) => line.includes('options.region')));

  it('the sweep found the commands it is supposed to check', () => {
    // Without a floor, a glob that matched nothing would pass every row below
    // vacuously — and this suite's whole job is to be non-vacuous.
    expect(commands.length).toBeGreaterThanOrEqual(4);
    expect(commands).toContain('local-invoke-agentcore.ts');
  });

  it.each(commands)('%s canonicalizes options.region before using it', (file) => {
    const lines = liveLinesOf(file);
    const foldAt = lines.findIndex((line) => line.includes(FOLD));

    expect(foldAt, `${file}: live options.region canonicalization not found`).toBeGreaterThan(-1);

    /**
     * PRESENCE is not enough — the fold has to come FIRST. Moving it below
     * `applyRoleArnIfSet(...)` left every assertion green under the previous
     * `toContain` form, while the consumer this exists to protect went back to
     * receiving the raw value. So: no OTHER read of `options.region` may
     * precede the fold.
     */
    const firstOtherRead = lines.findIndex(
      (line, i) => i !== foldAt && line.includes('options.region')
    );

    if (firstOtherRead !== -1) {
      expect(
        foldAt,
        `${file}: options.region is read at line ${firstOtherRead + 1}, BEFORE the fold at line ${foldAt + 1}`
      ).toBeLessThan(firstOtherRead);
    }
  });
});
