/**
 * Issue #6421: `cdkd diff` of a LegacyStackSynthesizer stack binds the asset
 * parameters `cdkd deploy` binds, so a property built from them compares as
 * the literal the deploy recorded instead of an unresolved value.
 *
 * The harness is `diff-json-escape.test.ts`'s.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const modeFailure = vi.hoisted(() => ({ value: undefined as Error | undefined }));
const stateForDiff = vi.hoisted(() => ({ value: null as StackState | null, reads: 0 }));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
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
  // No cdk.json "tags" (go-to-k/cdkd#6886).
  loadCdkJson: vi.fn(() => null),
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveUpdatePolicy: vi.fn(() => undefined),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ destroy: vi.fn() })),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: vi.fn(async () => {
      stateForDiff.reads += 1;
      return stateForDiff.value ? { state: stateForDiff.value, etag: 'fake' } : null;
    }),
    listStacks: vi.fn(async () => []),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/assets/asset-redirect.js')>()),
  createLazyAssetModeContext: () => ({
    accountId: async () => '123456789012',
    resolveMode: async () => {
      if (modeFailure.value) throw modeFailure.value;
      return { mode: 'cdkd-assets', marker: { assetBucket: 'cdkd-asset-bucket' } };
    },
  }),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({ getProvider: vi.fn(), ccRouteUnavailableReason: vi.fn() })),
}));

import { createDiffCommand } from '../../../src/cli/commands/diff.js';

async function runDiffJson(argv: string[]): Promise<string> {
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    throw new Error(`__process_exit__ ${String(c)}`);
  }) as never);
  try {
    await createDiffCommand().parseAsync(argv, { from: 'user' });
    return writeSpy.mock.calls.map((call) => String(call[0])).join('');
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
}

/** A fresh synthesized legacy stack per call: binding mutates its template. */
function synthResult(): unknown {
  return {
      stacks: [
        {
          stackName: 'S',
          displayName: 'S',
          artifactId: 'S',
          region: 'us-east-1',
          template: {
            Parameters: {
              BucketP: { Type: 'String' },
              KeyP: { Type: 'String' },
              HashP: { Type: 'String' },
            },
            Resources: {
              Q: {
                Type: 'AWS::SQS::Queue',
                Properties: {
                  QueueName: {
                    'Fn::Join': [
                      '-',
                      [
                        { Ref: 'BucketP' },
                        { 'Fn::Select': [1, { 'Fn::Split': ['||', { Ref: 'KeyP' }] }] },
                      ],
                    ],
                  },
                },
              },
            },
          },
          dependencyNames: [],
          legacyAssets: {
            assemblyDir: '/tmp/cdk.out',
            entries: [
              {
                packaging: 'zip',
                id: 'h',
                path: 'asset.h',
                sourceHash: 'h',
                s3BucketParameter: 'BucketP',
                s3KeyParameter: 'KeyP',
                artifactHashParameter: 'HashP',
              },
            ],
          },
        },
      ],
    };
}

describe('cdkd diff: LegacyStackSynthesizer asset parameters (issue #6421)', () => {
  it('shows no change for a property the deploy resolved from the bound parameters', async () => {
    mockSynthesize.mockResolvedValue(synthResult());
    stateForDiff.value = {
      stackName: 'S',
      region: 'us-east-1',
      version: 10,
      resources: {
        Q: {
          physicalId: 'q',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: 'cdkd-asset-bucket-h.zip' },
        },
      },
      outputs: {},
      lastModified: 0,
    };

    const stdout = await runDiffJson(['S', '--state-bucket', 'b', '--json']);
    const payload = JSON.parse(stdout) as Array<{
      changes: Array<{ logicalId: string; changeType?: string }>;
    }>;
    expect(payload[0]?.changes.filter((c) => c.changeType !== 'NO_CHANGE')).toEqual([]);
  }, 30_000);

  it('warns and shows the values unresolved when the parameters cannot be bound', async () => {
    // A fresh copy of the same stack; the recorded state persists from above.
    mockSynthesize.mockResolvedValue(synthResult());
    modeFailure.value = new Error('marker unreadable');
    try {
      const stdout = await runDiffJson(['S', '--state-bucket', 'b', '--json']);
      const payload = JSON.parse(stdout) as Array<{ changes: Array<{ changeType?: string }> }>;
      expect(payload[0]?.changes.some((c) => c.changeType !== 'NO_CHANGE')).toBe(true);
      expect(mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'Could not bind the LegacyStackSynthesizer asset parameters of stack S'
      );
    } finally {
      modeFailure.value = undefined;
    }
  }, 30_000);
});
