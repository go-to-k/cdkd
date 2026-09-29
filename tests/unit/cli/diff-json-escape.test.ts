/**
 * `cdkd diff --json` escapes, rather than emits raw, every control, format and
 * separator character in the payload (go-to-k/cdkd#4045). A stored state value
 * is written by whoever can write the state bucket, so a C1 CSI or a LINE
 * SEPARATOR in it reached the operator's terminal verbatim through
 * `JSON.stringify` alone. The payload must still parse back to the stored
 * value, since `--json` is a machine contract.
 *
 * The harness is `diff-deploy-refusal-exit.test.ts`'s.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const mockLoggerError = vi.hoisted(() => vi.fn());
const stateForDiff = vi.hoisted(() => ({ value: null as StackState | null, reads: 0 }));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
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
    getState: vi.fn(async () => {
      stateForDiff.reads += 1;
      return stateForDiff.value ? { state: stateForDiff.value, etag: 'fake' } : null;
    }),
    listStacks: vi.fn(async () => []),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({ getProvider: vi.fn() })),
}));

import { createDiffCommand } from '../../../src/cli/commands/diff.js';

/** Drive the real command and return what it wrote to stdout. */
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

describe('cdkd diff --json escapes planted characters (go-to-k/cdkd#4045)', () => {
  it('writes a stored C1 CSI and LINE SEPARATOR as escapes and round-trips the value', async () => {
    const planted = 'q\u009b[2J\u2028FAKE';
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'S',
          displayName: 'S',
          artifactId: 'S',
          template: { Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } } },
          dependencyNames: [],
          assets: [],
        },
      ],
    });
    stateForDiff.value = {
      stackName: 'S',
      region: 'us-east-1',
      version: 10,
      resources: {
        Q: { physicalId: 'q', resourceType: 'AWS::SQS::Queue', properties: { QueueName: planted } },
      },
      outputs: {},
      lastModified: 0,
    };

    const stdout = await runDiffJson(['S', '--state-bucket', 'b', '--json']);

    expect(stdout).not.toContain('\u009b');
    expect(stdout).not.toContain('\u2028');
    expect(stdout).toContain('\\u009b');
    expect(stdout).toContain('\\u2028');
    const payload = JSON.parse(stdout) as Array<{
      changes: Array<{ logicalId: string; propertyChanges?: Array<{ oldValue?: unknown }> }>;
    }>;
    // Premise: the planted value reached the payload, so the absence above is
    // not the absence of the value.
    const change = payload[0]?.changes.find((c) => c.logicalId === 'Q');
    expect(change?.propertyChanges?.map((p) => p.oldValue)).toContain(planted);
  }, 30_000);
});
