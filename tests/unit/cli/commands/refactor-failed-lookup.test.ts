/**
 * `cdkd refactor` and a failed context lookup (go-to-k/cdkd#5807): the lookup
 * blocks only a selection that holds the stack that asked, right after
 * selection and before macro expansion (the first step after it).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const loggerError = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerError,
    setLevel: vi.fn(),
  };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

const synthResult = vi.hoisted(() => ({
  stacks: [] as unknown[],
  failedLookups: undefined as Array<{ key: string; error: string }> | undefined,
  options: [] as unknown[],
}));
const expandMacros = vi.hoisted(() => ({ calls: [] as string[][] }));
const REACHED_EXPANSION = 'reached-macro-expansion';

vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation((opts: unknown) => {
      synthResult.options.push(opts);
      return Promise.resolve({
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
        stacks: synthResult.stacks,
        failedLookups: synthResult.failedLookups,
      });
    }),
    expandMacrosForStacks: vi.fn().mockImplementation((stacks: Array<{ stackName: string }>) => {
      expandMacros.calls.push(stacks.map((s) => s.stackName));
      return Promise.reject(new Error(REACHED_EXPANSION));
    }),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
  resolveUseCdkBootstrapAssets: () => false,
}));
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  setAwsClients: vi.fn(),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));

import { createRefactorCommand } from '../../../../src/cli/commands/refactor.js';

function stack(stackName: string, messages?: unknown[]): unknown {
  return { stackName, template: { Resources: {} }, ...(messages && { messages }) };
}

async function refactorReports(args: string[]): Promise<string> {
  loggerError.mockClear();
  const cmd = createRefactorCommand();
  cmd.exitOverride();
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__process.exit__');
  }) as never);
  try {
    await cmd.parseAsync(args, { from: 'user' }).catch(() => undefined);
  } finally {
    exitSpy.mockRestore();
  }
  return loggerError.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('cdkd refactor and a failed context lookup (go-to-k/cdkd#5807)', () => {
  beforeEach(() => {
    synthResult.options = [];
    expandMacros.calls = [];
    synthResult.failedLookups = [{ key: 'ssm:k', error: 'AccessDenied' }];
    synthResult.stacks = [
      stack('Other'),
      stack('Asking', [{ level: 'error', path: '/Asking', message: 'AccessDenied' }]),
    ];
  });

  it('refuses a selection holding the stack that asked, before macro expansion', async () => {
    expect(await refactorReports(['Asking', '--dry-run'])).toContain(
      'Context lookup failed: ssm:k: AccessDenied'
    );
    expect(synthResult.options[0]).toMatchObject({ failedLookupsCheckedByCaller: true });
    expect(expandMacros.calls).toEqual([]);
  });

  it('proceeds for a stack that did not ask', async () => {
    expect(await refactorReports(['Other', '--dry-run'])).toContain(REACHED_EXPANSION);
    expect(expandMacros.calls).toEqual([['Other']]);
  });
});
