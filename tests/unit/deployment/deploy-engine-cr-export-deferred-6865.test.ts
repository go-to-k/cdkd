/**
 * go-to-k/cdkd#6865, through the real `DeployEngine`: a producer whose custom
 * resource is updated in place (a fresh `Timestamp`) and whose export reads
 * that resource, while a stack outside the run imports the export.
 *
 * CloudFormation (measured 2026-11-23) updates the custom resource first and
 * refuses only when the export's value then differs, rolling back by
 * re-invoking the handler with the old properties. The deploy does the same:
 * the same value deploys; a different value fails the deploy after the update
 * and the automatic rollback re-sends the previous properties; under
 * `--no-rollback` nothing is reverted and the journal keeps the update.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const log = vi.hoisted(() => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): unknown => fns,
  };
  return fns;
});
vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => log }));
vi.mock('../../../src/utils/aws-clients.js', () => {
  const clients = (region: string): Record<string, unknown> => ({
    sts: { send: async () => ({ Account: '123456789012' }) },
    credentialConfig: {},
    config: { region: () => Promise.resolve(region) },
    withRegion: (target: string) => clients(target),
  });
  return { getAwsClients: () => clients('us-east-1') };
});
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { ExportInUseError } from '../../../src/utils/error-handler.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const CR = 'Custom::Probe';
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:handler';
const EXPORT = 'Producer:Value';

interface UpdateCall {
  ts: unknown;
  previousTs: unknown;
}

async function deploy(opts: {
  returns: string;
  noRollback?: boolean;
  consumerImports?: boolean;
  /** A queue record the template drops: the plan DELETEs it. */
  withDelete?: boolean;
  /** A queue whose name changes: the plan REPLACES it. */
  withReplacement?: boolean;
}): Promise<{
  provider: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  updates: UpdateCall[];
  thrown: unknown;
  listStacks: ReturnType<typeof vi.fn>;
  journalReasons: unknown[];
}> {
  const updates: UpdateCall[] = [];
  const provider = {
    create: vi.fn(async () => ({ physicalId: 'new-queue', attributes: {} })),
    update: vi.fn(
      async (
        _logicalId: string,
        pid: string,
        _type: string,
        props: Record<string, unknown>,
        prev: Record<string, unknown>
      ) => {
        updates.push({ ts: props['Ts'], previousTs: prev['Ts'] });
        // The handler: the deploy's update returns `opts.returns`; the
        // rollback's re-send of the old properties returns the old value.
        const value = props['Ts'] === '1' ? 'v1' : opts.returns;
        return { physicalId: pid, attributes: { Value: value } };
      }
    ),
    delete: vi.fn(async () => undefined),
    getAttribute: vi.fn(),
  };
  const queue = (name: string): ResourceState =>
    ({
      physicalId: `https://sqs.us-east-1.amazonaws.com/123456789012/${name}`,
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: name },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    }) as ResourceState;
  const producer: StackState = {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'Producer',
    region: 'us-east-1',
    resources: {
      Cr: {
        physicalId: 'cr-1',
        resourceType: CR,
        properties: { ServiceToken: TOKEN, Ts: '1' },
        attributes: { Value: 'v1' },
        dependencies: [],
        provisionedBy: 'sdk',
      } as ResourceState,
      ...(opts.withDelete === true && { Gone: queue('gone-q') }),
      ...(opts.withReplacement === true && { Q: queue('q1') }),
    },
    outputs: { Exported: 'v1', [EXPORT]: 'v1' },
    exportNames: [EXPORT],
    lastModified: 0,
  } as StackState;
  const consumer = {
    imports:
      opts.consumerImports === false
        ? []
        : [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: EXPORT }],
  };
  const template = {
    Resources: {
      Cr: { Type: CR, Properties: { ServiceToken: TOKEN, Ts: '2' } },
      ...(opts.withReplacement === true && {
        Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q2' } },
      }),
    },
    Outputs: {
      Exported: { Value: { 'Fn::GetAtt': ['Cr', 'Value'] }, Export: { Name: EXPORT } },
    },
  } as unknown as CloudFormationTemplate;
  const listStacks = vi.fn().mockResolvedValue([
    { stackName: 'Producer', region: 'us-east-1' },
    { stackName: 'Consumer', region: 'us-east-1' },
  ]);
  const getState = vi.fn(async (name: string) =>
    name === 'Producer' ? { state: producer, etag: 'e0' } : { state: consumer, etag: 'c0' }
  );
  const journalReasons: unknown[] = [];
  const engine = new DeployEngine(
    {
      getState,
      listStacks,
      saveState: vi.fn(async () => 'etag'),
      getStateIfExists: vi.fn(async () => ({ state: producer, etag: 'e0' })),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(async (_s: string, _r: string, segment: unknown) => {
        journalReasons.push((segment as { reason?: unknown }).reason);
      }),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi
        .fn()
        .mockReturnValue([opts.withReplacement === true ? ['Cr', 'Q'] : ['Cr']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    { dryRun: false, ...(opts.noRollback === true && { noRollback: true }) },
    'us-east-1'
  );
  let thrown: unknown;
  await engine.deploy('Producer', template).catch((e: unknown) => {
    thrown = e;
  });
  return { provider, updates, thrown, listStacks, journalReasons };
}

beforeEach(() => {
  log.warn.mockClear();
});

describe('a custom resource feeding an imported export (#6865)', () => {
  it('deploys when the handler returns the published value, as CloudFormation does', async () => {
    const run = await deploy({ returns: 'v1' });
    expect(run.thrown).toBeUndefined();
    expect(run.updates).toEqual([{ ts: '2', previousTs: '1' }]);
    // The value did not move, so no consumer was looked for.
    expect(run.listStacks).not.toHaveBeenCalled();
  });

  it('fails after the update when the value moved, and the rollback re-sends the old properties', async () => {
    const run = await deploy({ returns: 'v2' });
    expect(run.thrown).toBeInstanceOf(ExportInUseError);
    expect((run.thrown as Error).message).toContain('so this deploy fails and is rolled back');
    // The deploy's update, then the rollback's re-send of Ts=1 (from Ts=2).
    expect(run.updates).toEqual([
      { ts: '2', previousTs: '1' },
      { ts: '1', previousTs: '2' },
    ]);
    expect(run.journalReasons).toContain('auto-rollback-started');
    // An UPDATE's rollback deletes nothing.
    expect(run.provider.delete).not.toHaveBeenCalled();
  });

  // The post-update check runs after the create / update phase, where a
  // replacement's old copy and a nested child's deletes are already gone: such
  // a plan keeps the plan-time refusal, before anything is touched.
  it.each([
    ['a DELETE', { withDelete: true }],
    ['a replacement', { withReplacement: true }],
  ])('refuses at plan time, touching nothing, when the plan also has %s', async (_label, extra) => {
    const run = await deploy({ returns: 'v1', ...extra });
    expect(run.thrown).toBeInstanceOf(ExportInUseError);
    expect((run.thrown as Error).message).toContain('Nothing was changed.');
    expect(run.updates).toEqual([]);
    expect(run.provider.create).not.toHaveBeenCalled();
    expect(run.provider.delete).not.toHaveBeenCalled();
  });

  it('under --no-rollback, fails without reverting and journals the update for cdkd rollback', async () => {
    const run = await deploy({ returns: 'v2', noRollback: true });
    expect(run.thrown).toBeInstanceOf(ExportInUseError);
    expect(run.updates).toEqual([{ ts: '2', previousTs: '1' }]);
    expect(run.journalReasons).toEqual(['no-rollback-failure']);
  });

  it('deploys a moved value no stack imports', async () => {
    const run = await deploy({ returns: 'v2', consumerImports: false });
    expect(run.thrown).toBeUndefined();
    expect(run.updates).toEqual([{ ts: '2', previousTs: '1' }]);
    expect(run.listStacks).toHaveBeenCalled();
  });
});
