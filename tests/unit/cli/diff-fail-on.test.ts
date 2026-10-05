/**
 * `cdkd diff --fail-on` (AWS CDK CLI parity, aws/aws-cdk-cli#2020 / #2011,
 * go-to-k/cdkd#4429): which kind of change makes the command exit 1, the
 * `--fail` / `--no-fail` aliases, and the refusals of an incompatible or
 * repeated flag. Driven through the real command, since the exit code is what
 * a CI gate observes. Harness: `diff-deploy-refusal-exit.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const mockLoggerError = vi.hoisted(() => vi.fn());
const stateForDiff = vi.hoisted(() => ({ value: null as StackState | null }));

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

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: vi.fn(async () =>
      stateForDiff.value ? { state: stateForDiff.value, etag: 'fake' } : null
    ),
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

import {
  createDiffCommand,
  parseFailOn,
  resolveFailOn,
} from '../../../src/cli/commands/diff.js';

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

const queue = (extra: Record<string, unknown> = {}) => ({
  physicalId: 'q',
  resourceType: 'AWS::SQS::Queue',
  properties: {},
  ...extra,
});

function stateWith(resources: StackState['resources']): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    version: 10,
    resources,
    outputs: {},
    lastModified: 0,
  };
}

function synthTemplate(resources: Record<string, unknown>): void {
  mockSynthesize.mockResolvedValue({
    stacks: [
      {
        stackName: 'S',
        displayName: 'S',
        artifactId: 'S',
        template: { Resources: resources },
        dependencyNames: [],
        assets: [],
      },
    ],
  });
}

const QUEUE_TEMPLATE = {
  Type: 'AWS::SQS::Queue',
  Metadata: { 'aws:cdk:path': 'S/Queue/Resource' },
};

describe('cdkd diff --fail-on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('an addition only (not destructive)', () => {
    beforeEach(() => {
      stateForDiff.value = stateWith({ Q: queue() });
      synthTemplate({ Q: QUEUE_TEMPLATE, R: { Type: 'AWS::SQS::Queue' } });
    });

    it.each([
      [['--fail-on', 'destructive'], undefined],
      [['--fail-on', 'never'], undefined],
      [['--no-fail'], undefined],
      [[], undefined],
      [['--fail-on', 'any-change'], 1],
      [['--fail'], 1],
    ])('%j exits %s', async (flags, expected) => {
      const { code, said } = await runDiff(['S', ...flags]);
      expect(code).toBe(expected);
      expect(said).not.toContain('destructive change(s)');
    }, 30_000);
  });

  describe('a deletion', () => {
    it('fails --fail-on=destructive and lists the destroyed resource', async () => {
      stateForDiff.value = stateWith({ Q: queue(), Gone: queue({ physicalId: 'g' }) });
      synthTemplate({ Q: QUEUE_TEMPLATE });
      const { code, said } = await runDiff(['S', '--fail-on=destructive']);
      expect(code).toBe(1);
      expect(said).toContain(
        '❌  Found 1 destructive change(s) (--fail-on=destructive):\n' +
          '  S: AWS::SQS::Queue Gone will be destroyed'
      );
    }, 30_000);

    it('reports a Retain-policy removal as orphaned', async () => {
      stateForDiff.value = stateWith({
        Q: queue(),
        Kept: queue({ physicalId: 'k', deletionPolicy: 'Retain' }),
      });
      synthTemplate({ Q: QUEUE_TEMPLATE });
      const { code, said } = await runDiff(['S', '--fail-on', 'destructive']);
      expect(code).toBe(1);
      expect(said).toContain('  S: AWS::SQS::Queue Kept will be orphaned');
    }, 30_000);
  });

  it('fails on a Type change (a replacement) and shows the construct path', async () => {
    stateForDiff.value = stateWith({ Q: queue() });
    synthTemplate({
      Q: { Type: 'AWS::SNS::Topic', Metadata: { 'aws:cdk:path': 'S/Queue/Resource' } },
    });
    const { code, said } = await runDiff(['S', '--fail-on', 'destructive']);
    expect(code).toBe(1);
    expect(said).toContain('  S: AWS::SQS::Queue Queue Q will be replaced');
  }, 30_000);

  it('passes --fail-on=destructive when nothing changed', async () => {
    stateForDiff.value = stateWith({ Q: queue() });
    synthTemplate({ Q: QUEUE_TEMPLATE });
    const { code } = await runDiff(['S', '--fail-on', 'destructive']);
    expect(code).toBeUndefined();
  }, 30_000);

  describe('refusals', () => {
    beforeEach(() => {
      stateForDiff.value = stateWith({ Q: queue() });
      synthTemplate({ Q: QUEUE_TEMPLATE });
    });

    it('refuses --fail beside --fail-on, naming the equivalent value', async () => {
      const { code, said } = await runDiff(['S', '--fail', '--fail-on', 'destructive']);
      expect(code).toBe(1);
      expect(said).toContain(
        '--fail cannot be used with --fail-on, use --fail-on=any-change instead of --fail'
      );
      expect(mockSynthesize).not.toHaveBeenCalled();
    });

    it('refuses --no-fail beside --fail-on, naming the equivalent value', async () => {
      const { code, said } = await runDiff(['S', '--no-fail', '--fail-on', 'any-change']);
      expect(code).toBe(1);
      expect(said).toContain(
        '--no-fail cannot be used with --fail-on, use --fail-on=never instead of --no-fail'
      );
    });

    it('refuses a repeated --fail-on rather than letting the last one win', async () => {
      const { code, said } = await runDiff([
        'S',
        '--fail-on',
        'destructive',
        '--fail-on',
        'never',
      ]);
      expect(code).toBe(1);
      expect(said).toContain('--fail-on can only be given once, got: destructive, never');
      expect(mockSynthesize).not.toHaveBeenCalled();
    });

    it('refuses broadening, which cdkd cannot decide', async () => {
      const { code, said } = await runDiff(['S', '--fail-on', 'broadening']);
      expect(code).toBe(1);
      expect(said).toContain('Allowed choices are never, any-change, destructive.');
    });
  });
});

describe('resolveFailOn / parseFailOn', () => {
  it('maps the aliases and the default', () => {
    expect(resolveFailOn({})).toBe('never');
    expect(resolveFailOn({ fail: true })).toBe('any-change');
    expect(resolveFailOn({ fail: false })).toBe('never');
    expect(resolveFailOn({ failOn: 'destructive' })).toBe('destructive');
  });

  it('accepts each value once', () => {
    expect(parseFailOn('destructive', undefined)).toBe('destructive');
    expect(() => parseFailOn('any-change', 'never')).toThrow(/only be given once/);
  });
});

describe('treeDestructiveChanges / diffTreeToJson', () => {
  it('collects the nested children and carries the classification into --json', async () => {
    const { treeDestructiveChanges, diffTreeToJson } = await import(
      '../../../src/cli/commands/diff-recursive.js'
    );
    const node = (stackName: string, destructive: unknown[], children: unknown[] = []) =>
      ({
        stackName,
        displayName: stackName,
        region: 'us-east-1',
        changes: new Map(),
        ccApiRoutes: new Map(),
        outputChanges: [],
        adoptedOrphans: [],
        blocking: [],
        unreadable: [],
        unreadableContainers: [],
        unreadableOrphans: [],
        destructiveChanges: destructive,
        children,
      }) as never;
    const child = {
      stackName: 'P~C',
      logicalId: 'T',
      resourceType: 'AWS::DynamoDB::Table',
      constructPath: 'P/C/T/Resource',
      impact: 'WILL_ORPHAN',
    };
    const tree = node('P', [], [node('P~C', [child])]);
    expect(treeDestructiveChanges(tree)).toEqual([child]);
    const json = diffTreeToJson(tree);
    expect(json.destructiveChanges).toEqual([]);
    expect(json.children[0]!.destructiveChanges).toEqual([
      {
        logicalId: 'T',
        resourceType: 'AWS::DynamoDB::Table',
        constructPath: 'P/C/T/Resource',
        impact: 'WILL_ORPHAN',
      },
    ]);
  });
});
