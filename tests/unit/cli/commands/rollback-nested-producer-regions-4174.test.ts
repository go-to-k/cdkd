import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4174: `cdkd rollback '<parent>~<child>'` has no parent to hand
 * down the producer regions its parent reads from, and a parent-supplied value
 * is recorded region-less in the child, so the replay's evidence is marked
 * INCOMPLETE (every region-less secret reference refuses). A top-level stack's
 * evidence is its own record, complete as before.
 *
 * Driven through the REAL `rollbackCommand`; `replayRollback` is replaced only
 * to read the context it is handed.
 */

const logger = vi.hoisted(() => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => l,
  };
  return l;
});
vi.mock('../../../../src/utils/logger.js', () => ({ getLogger: () => logger }));

vi.mock('../../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
}));

vi.mock('../../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: vi.fn(),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));

const contexts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../../../src/deployment/rollback-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/deployment/rollback-executor.js')>()),
  replayRollback: vi.fn(async (_ops: unknown, _res: unknown, _name: unknown, ctx: Record<string, unknown>) => {
    contexts.push(ctx);
    return { failures: 0, warnings: 0, interrupted: false, orphaned: [] };
  }),
}));

const setupMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/cli/commands/state.js')>(
    '../../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../../src/cli/commands/rollback.js';

function install(stackName: string, stateExtra: Record<string, unknown>): void {
  setupMock.mockResolvedValue({
    stateBackend: {
      listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
      listStacks: vi.fn().mockResolvedValue([{ stackName, region: 'us-east-1' }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 10,
          stackName,
          region: 'us-east-1',
          resources: {
            Q: {
              physicalId: 'q',
              resourceType: 'AWS::SQS::Queue',
              properties: {},
              attributes: {},
              dependencies: [],
            },
          },
          outputs: {},
          outputReads: [{ stackName: 'P', outputName: 'O', sourceRegion: 'eu-west-1' }],
          lastModified: 1,
          ...stateExtra,
        },
        etag: 'etag-1',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName,
        region: 'us-east-1',
        segments: [
          {
            timestamp: 1,
            reason: 'no-rollback-failure',
            initialDeploy: false,
            operations: [
              {
                logicalId: 'Q',
                changeType: 'CREATE',
                resourceType: 'AWS::SQS::Queue',
                physicalId: 'q',
              },
            ],
          },
        ],
      }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      getLockInfo: vi.fn().mockResolvedValue(null),
    },
    awsClients: {},
    region: 'us-east-1',
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

const opts = { statePrefix: 'cdkd', verbose: false, force: true };

beforeEach(() => {
  vi.clearAllMocks();
  contexts.length = 0;
  vi.stubEnv('AWS_REGION', 'us-east-1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cdkd rollback of a nested child on its own marks the producer regions incomplete (#4174)", () => {
  it('a nested child: incomplete, its own regions still passed', async () => {
    install('Top~Child', { parentStack: 'Top' });

    await rollbackCommand('Top~Child', { ...opts });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]!['producerRegionsIncomplete']).toBe(true);
    expect(contexts[0]!['importedProducerRegions']).toEqual(['eu-west-1']);
  });

  it('a nested child KEY whose record lost its parentStack is still incomplete', async () => {
    install('Top~Child', {});

    await rollbackCommand('Top~Child', { ...opts });

    expect(contexts[0]!['producerRegionsIncomplete']).toBe(true);
  });

  it('a record naming a parentStack is incomplete even under a key without `~`', async () => {
    install('Child', { parentStack: 'Top' });

    await rollbackCommand('Child', { ...opts });

    expect(contexts[0]!['producerRegionsIncomplete']).toBe(true);
  });

  it('CONTROL: a top-level stack is complete, as before', async () => {
    install('Top', {});

    await rollbackCommand('Top', { ...opts });

    expect(contexts).toHaveLength(1);
    expect('producerRegionsIncomplete' in contexts[0]!).toBe(false);
    expect(contexts[0]!['importedProducerRegions']).toEqual(['eu-west-1']);
  });
});
