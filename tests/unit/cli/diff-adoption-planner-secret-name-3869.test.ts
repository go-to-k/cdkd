/**
 * `cdkd diff` runs the orphan-adoption planner under a printing bag judged
 * from the stack's orphan records (go-to-k/cdkd#3869), as `cdkd deploy` does:
 * the planner's own lines (a vanished record's debug line, the provider
 * `import()` existence check) print a kept record's physical id, which can be
 * named from a secret. Driven through the real `diff` command; the provider's
 * `import()` reports what a line it logged there would print.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const stateForDiff = vi.hoisted(() => ({ value: null as StackState | null }));
const importLines = vi.hoisted(() => [] as string[]);

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation((opts?: { region?: string }) => ({
    s3: {},
    configuredRegion: opts?.region,
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  runWithStackAwsClients: vi.fn((_c: unknown, fn: () => unknown): unknown => fn()),
}));
vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: vi.fn(async () =>
      stateForDiff.value ? { state: stateForDiff.value, etag: 'fake' } : null
    ),
    saveState: vi.fn(),
    listStacks: vi.fn(async () => []),
  })),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: vi.fn(),
    getProviderFor: vi.fn(() => ({
      provisionedBy: 'sdk',
      provider: {
        // The existence check: logs the id it asks about, then finds nothing.
        import: async (input: { knownPhysicalId?: string }) => {
          const line = `Checking bucket ${String(input.knownPhysicalId)}`;
          importLines.push(currentLogLineMasker()?.(line) ?? line);
          return null;
        },
      },
    })),
  })),
}));

import { createDiffCommand } from '../../../src/cli/commands/diff.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

const REF = '{{resolve:secretsmanager:team:SecretString:bucket::}}';
const BUCKET = 'team-secret-bucket';

describe("cdkd diff runs the adoption planner under the orphan records' bag (go-to-k/cdkd#3869)", () => {
  beforeEach(() => {
    importLines.length = 0;
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'S',
          displayName: 'S',
          artifactId: 'S',
          region: 'us-east-1',
          template: { Resources: { Kept: { Type: 'AWS::S3::Bucket', Properties: {} } } },
          dependencyNames: [],
          assets: [],
        },
      ],
    });
  });

  it.each([
    ['a record naming it by its reference', REF, false],
    ['negative control, a literal name', BUCKET, true],
  ])("on the provider's existence-check line: %s", async (_l, name, shown) => {
    stateForDiff.value = {
      stackName: 'S',
      region: 'us-east-1',
      version: 10,
      resources: {},
      outputs: {},
      lastModified: 0,
      orphans: [
        {
          logicalId: 'Kept',
          orphanedAt: 1,
          state: {
            physicalId: BUCKET,
            resourceType: 'AWS::S3::Bucket',
            properties: { BucketName: name },
            deletionPolicy: 'Retain',
          },
        },
      ],
    } as StackState;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__process_exit__');
    }) as never);
    try {
      await createDiffCommand().parseAsync(['S', '--state-bucket', 'b'], { from: 'user' });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
    } finally {
      exitSpy.mockRestore();
    }
    // Premise: the planner asked the provider about the kept record.
    expect(importLines).toEqual([expect.stringContaining('Checking bucket ')]);
    expect(importLines[0]!.includes(BUCKET)).toBe(shown);
  }, 30_000);
});
