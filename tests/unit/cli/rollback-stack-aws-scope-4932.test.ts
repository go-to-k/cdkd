/**
 * A standalone `cdkd rollback` of a stack recorded in a region other than the
 * CLI's ambient `AWS_REGION` runs its providers in the STACK's region
 * (go-to-k/cdkd#4932). Providers that build their own SDK client read the
 * region from `ambientRegion()` (a `providerRegion = ambientRegion()` field
 * captured at construction, or `awsClientDefaults()` at call time); outside a
 * stack AWS scope both fall through to `process.env.AWS_REGION`, so the replay
 * would delete a same-named resource in the ambient region.
 *
 * Drives the REAL command with the REAL `aws-clients.ts` /
 * `aws-client-defaults.ts` / `stack-aws-scope.ts` modules and records the
 * three doors a provider reads its region through, at registration and at the
 * replay's delete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

/** `ambientRegion()` where `registerAllProviders` constructs the providers. */
const registeredRegions = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock('../../../src/provisioning/register-providers.js', async () => {
  const { ambientRegion } = await import('../../../src/utils/stack-aws-scope.js');
  return {
    loadProviderClasses: vi.fn(async () => ({})),
    registerAllProviders: vi.fn(() => {
      registeredRegions.push(ambientRegion());
    }),
  };
});

interface Observation {
  clientsRegion: string | undefined;
  ambientRegion: string | undefined;
  sdkClientRegion: string;
  envRegion: string | undefined;
}
const deleteObservations = vi.hoisted(() => [] as Observation[]);
const provider = vi.hoisted(() => ({
  delete: vi.fn(),
  isSameResource: vi.fn(),
  resourceIdentity: vi.fn(async () => 'created-token'),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
/** The region of the clients a nested child's revert / destroy is handed. */
const nestedCtxRegions = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: vi.fn(
    (ctx: { awsClients?: { configuredRegion?: string } }, fn: () => unknown) => {
      nestedCtxRegions.push(ctx.awsClients?.configuredRegion);
      return fn();
    }
  ),
}));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
const setupMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';
import { getAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import { awsClientDefaults } from '../../../src/utils/aws-client-defaults.js';
import { ambientRegion } from '../../../src/utils/stack-aws-scope.js';
import { SQSClient } from '@aws-sdk/client-sqs';

const AMBIENT_REGION = 'us-east-1';
const STACK_REGION = 'us-west-2';
const TYPE = 'AWS::Kinesis::Stream';

function install(): void {
  const orphanOp = {
    logicalId: 'Orphan',
    changeType: 'CREATE',
    resourceType: TYPE,
    provisionedBy: 'sdk',
    physicalId: 'shared-name',
    physicalIdRecoveredFromError: true,
    deletionPolicy: 'Delete',
    createdResourceIdentity: 'created-token',
    attemptedProperties: { Name: 'shared-name' },
  };
  setupMock.mockResolvedValue({
    stateBackend: {
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: STACK_REGION }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
      getRegistryMarker: vi.fn().mockResolvedValue(null),
      claimRegistryMarker: vi.fn().mockResolvedValue('claimed'),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: STACK_REGION,
          resources: {
            Orphan: {
              physicalId: 'other-stream',
              resourceType: TYPE,
              properties: { Name: 'other-stream' },
              attributes: {},
              dependencies: [],
              provisionedBy: 'sdk',
            },
          },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: STACK_REGION,
        segments: [
          {
            timestamp: 1,
            reason: 'no-rollback-failure',
            initialDeploy: false,
            operations: [],
            failedOperations: [orphanOp],
          },
        ],
      }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
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
    // Restored as the process-global by the command's finally.
    awsClients: { destroy: vi.fn(), configuredRegion: AMBIENT_REGION },
    region: AMBIENT_REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

const savedEnv: Record<string, string | undefined> = {};

describe('cdkd rollback runs providers in the stack region, not AWS_REGION (go-to-k/cdkd#4932)', () => {
  beforeEach(() => {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION']) savedEnv[key] = process.env[key];
    process.env['AWS_REGION'] = AMBIENT_REGION;
    process.env['AWS_DEFAULT_REGION'] = AMBIENT_REGION;
    registeredRegions.length = 0;
    deleteObservations.length = 0;
    nestedCtxRegions.length = 0;
    provider.isSameResource.mockReset().mockResolvedValue('different');
    provider.delete.mockReset().mockImplementation(async () => {
      // Built with NO region of its own, the way a provider builds a client
      // lazily. Never sent: region resolution is local.
      const client = new SQSClient({ ...awsClientDefaults() });
      deleteObservations.push({
        clientsRegion: getAwsClients().configuredRegion,
        ambientRegion: ambientRegion(),
        sdkClientRegion: await client.config.region(),
        envRegion: process.env['AWS_REGION'],
      });
      client.destroy();
    });
    install();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAwsClients();
  });

  it('constructs the providers inside the stack scope', async () => {
    await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true });

    expect(registeredRegions).toEqual([STACK_REGION]);
  });

  it("replays the orphan delete through the stack region's doors", async () => {
    await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true });

    // Floor: the replay reached the delete, so the comparisons are not vacuous.
    expect(provider.delete).toHaveBeenCalledOnce();
    expect(provider.delete.mock.calls[0]![1]).toBe('shared-name');
    const [seen] = deleteObservations;
    expect(seen!.clientsRegion, 'getAwsClients()').toBe(STACK_REGION);
    expect(seen!.ambientRegion, 'ambientRegion()').toBe(STACK_REGION);
    expect(seen!.sdkClientRegion, 'region-less SDK client').toBe(STACK_REGION);
    // The scope carries the region; the process-wide variable is left alone.
    expect(seen!.envRegion).toBe(AMBIENT_REGION);
    expect(process.env['AWS_REGION']).toBe(AMBIENT_REGION);
  });

  it("hands a nested child's revert the stack region's clients, not the CLI's", async () => {
    // A nested child's destroy takes its final snapshots through these, so a
    // CLI-region set would skip the snapshot on a wrong-region NotFound.
    await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true });

    expect(nestedCtxRegions).toEqual([STACK_REGION]);
  });

  it('restores the CLI-region global clients once the command returns', async () => {
    // The scope ends with the command by construction; the process-global set
    // does not: the command's `finally` must put the CLI's set back, or a
    // later consumer in the process reaches the stack's (destroyed) clients.
    await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true });

    expect(getAwsClients().configuredRegion).toBe(AMBIENT_REGION);
  });
});
