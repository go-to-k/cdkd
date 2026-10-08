/**
 * `cdkd destroy` masks a physical name derived from a secret on two more
 * surfaces (go-to-k/cdkd#3869):
 *
 *  - a journaled failed-CREATE orphan's delete (`deleteJournaledOrphans`): no
 *    state record holds it, so it is judged from its own journal entry, and
 *    its provider's lines ran under no printing bag;
 *  - destroy's events (`RESOURCE_FAILED`'s error text, a `RESOURCE_SKIPPED` /
 *    `RESOURCE_GUARD_INDETERMINATE` reason, and a journaled orphan's rollback
 *    events for a name it READ), which the durable events store kept verbatim
 *    while the log line beside each was masked.
 *
 * The event's `physicalId` FIELD stays exact.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { DeploymentEventRecorder } from '../../../src/types/deployment-events.js';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

const REGION = 'us-east-1';
const REF = '{{resolve:secretsmanager:team:SecretString:queue::}}';
const NAME = 'team-secret-queue';
const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${NAME}`;

function orphanOp(queueName: string) {
  return {
    logicalId: 'Orphan',
    changeType: 'CREATE',
    resourceType: 'AWS::SQS::Queue',
    physicalId: URL,
    provisionedBy: 'sdk',
    physicalIdRecoveredFromError: true,
    attemptedProperties: { QueueName: queueName },
  };
}

const STREAM_REF = '{{resolve:secretsmanager:team:SecretString:stream::}}';
const STREAM = 'team-secret-stream';

/** A Kinesis stream orphan, which journals its creation identity. */
function streamOp(streamName: string) {
  return {
    logicalId: 'Orphan',
    changeType: 'CREATE',
    resourceType: 'AWS::Kinesis::Stream',
    physicalId: STREAM,
    provisionedBy: 'sdk',
    physicalIdRecoveredFromError: true,
    createdResourceIdentity: 'created-token',
    attemptedProperties: { Name: streamName },
  };
}

function journalOf(failedOperations: unknown[]) {
  return {
    journalVersion: 1,
    stackName: 'TestStack',
    region: REGION,
    segments: [
      {
        timestamp: 1,
        reason: 'no-rollback-failure',
        initialDeploy: false,
        skipPrefix: false,
        operations: [],
        failedOperations,
      },
    ],
  };
}

function stateOf(resources: Record<string, ResourceState>): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    lastModified: 1,
  };
}

describe('cdkd destroy masks a secret-derived name on journaled-orphan deletes and events (go-to-k/cdkd#3869)', () => {
  const providerDelete = vi.fn();
  const loadJournal = vi.fn();
  const events: Array<Parameters<DeploymentEventRecorder['record']>[0]> = [];
  const lines: string[] = [];

  function ctx() {
    return {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockResolvedValue(null),
        loadRollbackJournal: loadJournal,
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(0),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        // go-to-k/cdkd#4658: the live identity matches the journaled token.
        // Real-shaped: only these types' providers read a creation identity.
        getProviderFor: ({ resourceType }: { resourceType: string }) => ({
          provider: ['AWS::Kinesis::Stream','AWS::RDS::DBCluster','AWS::RDS::DBInstance','AWS::DocDB::DBCluster','AWS::DocDB::DBInstance'].includes(resourceType)
            ? { delete: providerDelete, resourceIdentity: async () => 'created-token' }
            : { delete: providerDelete },
          provisionedBy: 'sdk',
        }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
      eventRecorder: { record: (e) => void events.push(e) } as DeploymentEventRecorder,
    };
  }

  /** A provider delete logging its own line, as the SQS provider does. */
  const logging = (fail: boolean) => (logicalId: string, physicalId: string) => {
    const line = `Deleting SQS queue ${logicalId}: ${physicalId}`;
    lines.push(currentLogLineMasker()?.(line) ?? line);
    return fail
      ? Promise.reject(new Error(`AccessDenied on ${physicalId}`))
      : Promise.resolve(undefined);
  };

  const failed = () =>
    events.filter((e) => e.eventType === 'RESOURCE_FAILED' || e.eventType === 'ROLLBACK_RESOURCE_FAILED');

  beforeEach(() => {
    providerDelete.mockReset();
    loadJournal.mockReset().mockResolvedValue(null);
    events.length = 0;
    lines.length = 0;
  });

  // go-to-k/cdkd#4658: an SQS queue journals no creation identity, so its
  // orphan is kept, not deleted: the warning naming it masks it as well.
  it.each([
    ['a secret-named orphan', REF, false],
    ['negative control, an ordinary name', 'plain-queue-name', true],
  ])('masks the warning that keeps an orphan of a type with no identity: %s', async (_l, queueName, shown) => {
    loadJournal.mockResolvedValue(journalOf([orphanOp(queueName)]));
    const result = await runDestroyForStack('TestStack', stateOf({}), ctx());
    expect(providerDelete).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
    const { getLogger } = await import('../../../src/utils/logger.js');
    const warn = getLogger().warn as unknown as ReturnType<typeof vi.fn>;
    const kept = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('Skipping failed CREATE of Orphan'));
    expect(kept).toHaveLength(1);
    expect(kept[0]!.includes(NAME)).toBe(shown);
  });

  // A stream journals its identity, so its orphan reaches the provider's
  // delete: its line and a failed delete's event text are masked.
  it.each([
    ['a secret-named orphan', STREAM_REF, false],
    ['negative control, an ordinary name', STREAM, true],
  ])("masks the orphan's provider delete line: %s", async (_l, streamName, shown) => {
    loadJournal.mockResolvedValue(journalOf([streamOp(streamName)]));
    providerDelete.mockImplementation(logging(false));
    const result = await runDestroyForStack('TestStack', stateOf({}), ctx());
    expect(result.errorCount).toBe(0);
    // Premise: the orphan's delete ran and logged its line.
    expect(lines).toEqual([expect.stringContaining('Deleting SQS queue Orphan: ')]);
    expect(lines[0]!.includes(STREAM)).toBe(shown);
  });

  it.each([
    ['a secret-named orphan', STREAM_REF, false],
    ['negative control, an ordinary name', STREAM, true],
  ])("masks a failed orphan delete's ROLLBACK_RESOURCE_FAILED error text: %s", async (_l, streamName, shown) => {
    loadJournal.mockResolvedValue(journalOf([streamOp(streamName)]));
    providerDelete.mockImplementation(logging(true));
    const result = await runDestroyForStack('TestStack', stateOf({}), ctx());
    expect(result.errorCount).toBe(1);
    // Premise: the failure was recorded, quoting AWS's text.
    expect(failed()).toHaveLength(1);
    expect(failed()[0]!.error?.message).toContain('AccessDenied on ');
    expect(failed()[0]!.error!.message!.includes(STREAM)).toBe(shown);
  });

  // go-to-k/cdkd#4696: a scan that cannot read a record keeps the orphan as
  // a failure whose error text names its physical id, masked as the rest.
  it.each([
    ['a secret-named orphan', REF, false],
    ['negative control, an ordinary name', 'plain-queue-name', true],
  ])('masks the kept-for-a-re-run failure of an unreadable holder scan: %s', async (_l, queueName, shown) => {
    loadJournal.mockResolvedValue(journalOf([orphanOp(queueName)]));
    const c = ctx();
    (c.stateBackend as unknown as { listStacks: ReturnType<typeof vi.fn> }).listStacks = vi
      .fn()
      .mockRejectedValue(new Error('AccessDenied'));
    const result = await runDestroyForStack('TestStack', stateOf({}), c);
    expect(providerDelete).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(1);
    // Premise: the failure was recorded, naming the id it kept.
    expect(failed()).toHaveLength(1);
    expect(failed()[0]!.error?.message).toContain('is not deleted: the state bucket listing');
    expect(failed()[0]!.error!.message!.includes(NAME)).toBe(shown);
  });

  it.each([
    ['a secret-named resource', REF, false],
    ['negative control, an ordinary name', 'plain-queue-name', true],
  ])("masks a state resource's RESOURCE_FAILED error text: %s", async (_l, queueName, shown) => {
    providerDelete.mockImplementation(logging(true));
    const result = await runDestroyForStack(
      'TestStack',
      stateOf({
        Queue: {
          physicalId: URL,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: queueName },
          attributes: {},
          dependencies: [],
        },
      }),
      ctx()
    );
    expect(result.errorCount).toBe(1);
    // Premise: the failure was recorded, quoting AWS's text.
    expect(failed()).toHaveLength(1);
    expect(failed()[0]!.error?.message).toContain('AccessDenied on ');
    expect(failed()[0]!.error!.message!.includes(NAME)).toBe(shown);
  });

  it.each([
    ['a secret-named user in state', REF, false],
    ['negative control, an ordinary user name', 'plain-user-name', true],
  ])("masks the name an orphan READ, on its line and its failure event: %s", async (_l, userName, shown) => {
    // An access key a failed deploy created for a user named from a secret:
    // the key's own id is no secret, the user name its entry holds is.
    const USER = 'team-secret-user';
    loadJournal.mockResolvedValue(
      journalOf([
        {
          logicalId: 'Key',
          changeType: 'CREATE',
          resourceType: 'AWS::IAM::AccessKey',
          physicalId: 'AKIAEXAMPLEKEY',
          provisionedBy: 'sdk',
          physicalIdRecoveredFromError: true,
          attemptedProperties: { UserName: USER },
        },
      ])
    );
    providerDelete.mockImplementation((logicalId: string, physicalId: string) => {
      const line = `Deleting access key ${logicalId} ${physicalId} of user ${USER}`;
      lines.push(currentLogLineMasker()?.(line) ?? line);
      return Promise.reject(new Error(`AccessDenied on user ${USER}`));
    });
    const result = await runDestroyForStack(
      'TestStack',
      stateOf({
        User: {
          physicalId: USER,
          resourceType: 'AWS::IAM::User',
          properties: { UserName: userName },
          attributes: {},
          dependencies: [],
        },
      }),
      ctx()
    );
    // Premise: the orphan's delete ran, logged, and failed (the user is not
    // deleted: the orphan's failure stops nothing else, so it may be too).
    expect(lines[0]).toContain('Deleting access key Key AKIAEXAMPLEKEY of user ');
    expect(result.errorCount).toBeGreaterThanOrEqual(1);
    const keyFailure = failed().find((e) => e.logicalId === 'Key');
    expect(keyFailure?.error?.message).toContain('AccessDenied on user ');
    expect(lines[0]!.includes(USER)).toBe(shown);
    expect(keyFailure!.error!.message!.includes(USER)).toBe(shown);
  });

  it.each([
    ['a secret-named resource', REF, false],
    ['negative control, an ordinary name', 'plain-queue-name', true],
  ])("masks a skipped delete's RESOURCE_SKIPPED reason: %s", async (_l, queueName, shown) => {
    // A provider that could not confirm the delete says why, naming the id.
    providerDelete.mockImplementation((_id: string, physicalId: string) =>
      Promise.resolve({ outcome: 'skipped', reason: `handler did not confirm ${physicalId}` })
    );
    await runDestroyForStack(
      'TestStack',
      stateOf({
        Queue: {
          physicalId: URL,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: queueName },
          attributes: {},
          dependencies: [],
        },
      }),
      ctx()
    );
    const skipped = events.filter((e) => e.eventType === 'RESOURCE_SKIPPED');
    // Premise: the skip was recorded with the provider's reason.
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toContain('handler did not confirm ');
    expect(skipped[0]!.reason!.includes(NAME)).toBe(shown);
  });

  it.each([
    ['a secret-named resource', REF, false],
    ['negative control, an ordinary name', 'plain-queue-name', true],
  ])("masks a RESOURCE_GUARD_INDETERMINATE reason: %s", async (_l, queueName, shown) => {
    // A pre-flight guard that could not answer names the id it probed.
    providerDelete.mockImplementation((_id: string, physicalId: string) =>
      Promise.resolve({
        outcome: 'deleted',
        indeterminateGuards: [
          { guard: 'cc-delete-region-identity', reason: `could not read the region of ${physicalId}` },
        ],
      })
    );
    await runDestroyForStack(
      'TestStack',
      stateOf({
        Queue: {
          physicalId: URL,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: queueName },
          attributes: {},
          dependencies: [],
        },
      }),
      ctx()
    );
    const guards = events.filter((e) => e.eventType === 'RESOURCE_GUARD_INDETERMINATE');
    // Premise: the guard was recorded with its reason.
    expect(guards).toHaveLength(1);
    expect(guards[0]!.reason).toContain('could not read the region of ');
    expect(guards[0]!.reason!.includes(NAME)).toBe(shown);
  });

  it.each([
    ['a secret-named user orphan', REF, false],
    ['negative control, an ordinary user name', 'plain-user-name', true],
  ])('masks a name an orphan read from an orphan in ANOTHER segment: %s', async (_l, userName, shown) => {
    // Two failed deploys: the older journaled a user named from a secret, the
    // newer an access key for it. One bag spans the batch, so the key's lines
    // carry the user's needles although no state record holds the user.
    const USER = 'team-secret-user';
    const segment = (timestamp: number, op: Record<string, unknown>) => ({
      timestamp,
      reason: 'no-rollback-failure',
      initialDeploy: false,
      skipPrefix: false,
      operations: [],
      failedOperations: [
        { changeType: 'CREATE', provisionedBy: 'sdk', physicalIdRecoveredFromError: true, ...op },
      ],
    });
    loadJournal.mockResolvedValue({
      journalVersion: 1,
      stackName: 'TestStack',
      region: REGION,
      segments: [
        segment(1, {
          logicalId: 'User',
          resourceType: 'AWS::IAM::User',
          physicalId: USER,
          attemptedProperties: { UserName: userName },
        }),
        segment(2, {
          logicalId: 'Key',
          resourceType: 'AWS::IAM::AccessKey',
          physicalId: 'AKIAEXAMPLEKEY',
          attemptedProperties: { UserName: USER },
        }),
      ],
    });
    providerDelete.mockImplementation((logicalId: string, physicalId: string) => {
      if (logicalId === 'Key') {
        const line = `Deleting access key ${physicalId} of user ${USER}`;
        lines.push(currentLogLineMasker()?.(line) ?? line);
        return Promise.reject(new Error(`AccessDenied on user ${USER}`));
      }
      return Promise.resolve(undefined);
    });
    await runDestroyForStack('TestStack', stateOf({}), ctx());
    // Premise: the key's delete ran, logged, and failed quoting AWS's text.
    expect(lines).toEqual([expect.stringContaining('Deleting access key AKIAEXAMPLEKEY of user ')]);
    const keyFailure = failed().find((e) => e.logicalId === 'Key');
    expect(keyFailure?.error?.message).toContain('AccessDenied on user ');
    expect(lines[0]!.includes(USER)).toBe(shown);
    expect(keyFailure!.error!.message!.includes(USER)).toBe(shown);
  });

  it('keeps an event physicalId FIELD exact while its reason is masked', async () => {
    // A RESOURCE_SKIPPED event carries both: the masker runs on it (no early
    // return), and must leave the identity field alone.
    providerDelete.mockImplementation((_id: string, physicalId: string) =>
      Promise.resolve({ outcome: 'skipped', reason: `handler did not confirm ${physicalId}` })
    );
    await runDestroyForStack(
      'TestStack',
      stateOf({
        Queue: {
          physicalId: URL,
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: REF },
          attributes: {},
          dependencies: [],
        },
      }),
      ctx()
    );
    const skipped = events.filter((e) => e.eventType === 'RESOURCE_SKIPPED');
    expect(skipped).toHaveLength(1);
    // Premise: the masker ran on this event.
    expect(skipped[0]!.reason).toContain('handler did not confirm ');
    expect(skipped[0]!.reason!.includes(NAME)).toBe(false);
    expect(skipped[0]!.physicalId).toBe(URL);
  });
});
