/**
 * go-to-k/cdkd#7191: through `scrubCommand`, a rollback orphan whose logical
 * id has left the template, written before state schema v11 (no
 * `noEchoLeaves`), in a stack with a `NoEcho` parameter, is a FINDING: the
 * stack is not reported clean, and a real run's `--fail` exits through
 * `ScrubNeededError` with nothing left to rewrite.
 * The same stack with no such orphan is reported clean.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const logLines: string[] = [];
vi.mock('../../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void =>
      void logLines.push(`${level} ${args.map(String).join(' ')}`);
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  STSClient: class {
    readonly config = { region: (): Promise<string> => Promise.resolve('us-east-1') };
    send(): Promise<unknown> {
      return Promise.resolve({ Account: '111122223333', Arn: 'arn:aws:iam::111122223333:root' });
    }
    destroy(): void {}
  },
}));

const synthStacks = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn(() => ({
    synthesize: vi.fn().mockImplementation(() => Promise.resolve({ stacks: synthStacks })),
    expandMacrosForStacks: vi.fn().mockResolvedValue(undefined),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));

const stateStore = vi.hoisted(() => new Map<string, unknown>());
const stateBackend = vi.hoisted(() => ({
  prefix: 'cdkd',
  getState: vi.fn(),
  saveState: vi.fn(),
  purgeNoncurrentVersions: vi.fn(async (_keys: string[]): Promise<void> => undefined),
  getRawObject: vi.fn(async () => null),
  listStacks: vi.fn(),
}));
vi.mock('../../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => stateBackend),
}));
vi.mock('../../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn(() => ({
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn(() => ({
    readPersistedEntries: vi.fn().mockResolvedValue(undefined),
    patchEntry: vi.fn().mockResolvedValue(true),
  })),
}));

import { resetAwsClients } from '../../../../src/utils/aws-clients.js';
import { scrubCommand, ScrubNeededError } from '../../../../src/cli/commands/scrub.js';
import type { ResourceState, StackState } from '../../../../src/types/state.js';

const REGION = 'us-east-1';
const STACK = 'Stk7191Report';
const TYPE = 'AWS::Test::Db7191';

function seed(orphans: StackState['orphans']): void {
  const live: ResourceState = {
    physicalId: 'db-live',
    resourceType: TYPE,
    properties: { Password: '***', Name: 'public' },
    noEchoLeaves: [['Password']],
  };
  stateStore.set(`${STACK}|${REGION}`, {
    version: 18,
    region: REGION,
    stackName: STACK,
    resources: { Db: live },
    outputs: {},
    lastModified: 0,
    ...(orphans !== undefined && { orphans }),
  });
}

async function run(extra: Record<string, unknown> = {}): Promise<unknown> {
  try {
    await scrubCommand([STACK], {
      output: 'cdk.out',
      statePrefix: 'cdkd',
      verbose: false,
      ...extra,
    } as never);
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('cdkd scrub reports an orphan it cannot position (go-to-k/cdkd#7191)', () => {
  beforeEach(() => {
    logLines.length = 0;
    synthStacks.length = 0;
    synthStacks.push({
      stackName: STACK,
      displayName: STACK,
      artifactId: STACK,
      dependencyNames: [],
      region: REGION,
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: 'q7' } },
        Resources: {
          Db: { Type: TYPE, Properties: { Password: { Ref: 'Pw' }, Name: 'public' } },
        },
      },
    });
    stateStore.clear();
    process.env['AWS_REGION'] = REGION;
    resetAwsClients();
    stateBackend.getState.mockReset().mockImplementation((stack: string, region: string) => {
      const state = stateStore.get(`${stack}|${region}`);
      return Promise.resolve(
        state === undefined ? null : { state: structuredClone(state), etag: 'etag-1' }
      );
    });
    stateBackend.saveState.mockReset().mockResolvedValue('etag-2');
    stateBackend.listStacks.mockReset().mockResolvedValue([]);
  });

  it('is not reported clean, and --fail exits', async () => {
    seed([
      {
        logicalId: 'Gone',
        orphanedAt: 1,
        state: { physicalId: 'db-old', resourceType: TYPE, properties: { Password: 'x9' } },
      },
    ]);
    const err = await run({ fail: true });
    expect(err).toBeInstanceOf(ScrubNeededError);
    const text = logLines.join('\n');
    expect(text).not.toContain('No plaintext secrets found');
    expect(text).toContain('orphan record Gone');
    expect(text).toContain('orphan or superseded record(s)');
  });

  it('control: the same stack without that orphan is reported clean', async () => {
    seed(undefined);
    const err = await run({ fail: true });
    expect(err).toBeUndefined();
    expect(logLines.join('\n')).toContain('No plaintext secrets found');
  });
});
