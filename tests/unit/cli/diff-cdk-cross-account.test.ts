/**
 * `cdkd diff` hands its resolvers the cloud assembly's producer lookup, so an
 * aws-cdk-lib-generated cross-account `Fn::GetStackOutput` is classified as on
 * `cdkd deploy`. Driven through the real command over stacks aws-cdk-lib
 * synthesized. Harness: `diff-fail-on.test.ts`.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import {
  PRODUCER_ACCOUNT,
  synthesizeCrossAccountApp,
  type SynthesizedApp,
} from '../deployment/cdk-cross-account-fixture.js';

const mockLoggerError = vi.hoisted(() => vi.fn());
const stateForDiff = vi.hoisted(() => ({
  value: null as StackState | null,
  // Per state stack name, for a nested child's record; `value` otherwise.
  byStack: {} as Record<string, StackState>,
  reads: [] as string[],
}));

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
  runWithStackAwsClients: vi.fn((_clients: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../../../src/utils/role-arn.js', async () => ({
  ...(await vi.importActual<typeof import('../../../src/utils/role-arn.js')>(
    '../../../src/utils/role-arn.js'
  )),
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

// The command's lookup, wrapped: it answers NOTHING, so the reference is
// refused without any AWS call (and the best-effort diff keeps the intrinsic),
// while every call it receives is recorded.
const lookupCalls = vi.hoisted(() => [] as unknown[][]);
const lookupStacks = vi.hoisted(() => [] as string[][]);
vi.mock('../../../src/deployment/intrinsic-resolver/cdk-cross-account-ref.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/deployment/intrinsic-resolver/cdk-cross-account-ref.js')
  >('../../../src/deployment/intrinsic-resolver/cdk-cross-account-ref.js');
  return {
    ...actual,
    producerLookupOver: (stacks: readonly { stackName: string }[]) => {
      lookupStacks.push(stacks.map((st) => st.stackName));
      return (...args: unknown[]) => {
        lookupCalls.push(args);
        return undefined;
      };
    },
  };
});

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: vi.fn(async (stackName: string) => {
      stateForDiff.reads.push(stackName);
      const state = stateForDiff.byStack[stackName] ?? stateForDiff.value;
      return state ? { state, etag: 'fake' } : null;
    }),
    listStacks: vi.fn(async () => []),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({ getProvider: vi.fn() })),
}));

import { createDiffCommand } from '../../../src/cli/commands/diff.js';

async function runDiff(argv: string[]): Promise<{ code: number | undefined; said: string }> {
  let code: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('__process_exit__');
  }) as never);
  // Commander reports a usage error on stderr before exiting.
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let usage = '';
  try {
    const cmd = createDiffCommand().exitOverride();
    await cmd.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    if (err.message !== '__process_exit__') {
      // `exitOverride` turns a Commander usage error into a throw.
      const commanderCode = (err as { exitCode?: number }).exitCode;
      if (commanderCode === undefined) throw err;
      code = commanderCode;
      usage = err.message;
    }
  } finally {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  const said = [usage, ...mockLoggerError.mock.calls.map((c) => String(c[0]))].join('\n');
  return { code, said };
}

let app: SynthesizedApp;

beforeAll(() => {
  app = synthesizeCrossAccountApp('generated');
}, 120_000);

describe('cdkd diff and the aws-cdk-lib-generated cross-account reference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupCalls.length = 0;
    lookupStacks.length = 0;
  });

  it('consults the assembly producer lookup for the reference', async () => {
    mockSynthesize.mockResolvedValue({ stacks: app.stacks });
    const state: StackState = {
      stackName: 'Consumer',
      region: 'us-east-1',
      version: 10,
      resources: {
        Queue: { physicalId: 'q', resourceType: 'AWS::SQS::Queue', properties: {} },
      },
      outputs: {},
      lastModified: 0,
    };
    stateForDiff.byStack = { Consumer: state };
    stateForDiff.value = null;

    await runDiff(['Consumer']);

    expect(lookupStacks).toEqual([['Producer', 'Consumer']]);
    expect(lookupCalls).toContainEqual(['Producer', PRODUCER_ACCOUNT, 'us-east-1']);
  }, 60_000);
});
