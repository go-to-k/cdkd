/**
 * go-to-k/cdkd#4523: a journal segment kept from a failed deploy holds a
 * completed CREATE of an explicitly named resource; the user re-creates the
 * name by hand and `cdkd import`s it under the same logical id. The record's
 * physical id equals the op's, so the replay classified `delete` and removed
 * the resource the user had just adopted. The import now marks the id on the
 * segment (`importedResources`: logical AND physical id), and `cdkd rollback` leaves the segment's ops
 * of that id alone. Driven through the real command and the real executor.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import { readAtKeyRegion } from '../_state-read-double.js';

const logger = vi.hoisted(() => {
  const l: Record<string, unknown> = {};
  Object.assign(l, {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  });
  return l;
});
vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => logger }));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const provider = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({})),
}));
vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../../src/provisioning/resource-name.js', () => ({
  withStackName: (_name: string, fn: () => unknown) => fn(),
  withSkipPrefix: (_skip: boolean, fn: () => unknown) => fn(),
  getCurrentSkipPrefix: () => true,
  explicitNamePropertyFor: () => undefined,
}));

const setupMock = vi.fn();
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';

const REGION = 'us-east-1';
const STACK = 'S';
const TOPIC = 'AWS::SNS::Topic';
/** The explicit name: the physical id the deploy recorded AND the import adopted. */
const NAME = 'my-topic';

const topicRecord = (displayName: string) => ({
  physicalId: NAME,
  resourceType: TOPIC,
  properties: { TopicName: NAME, DisplayName: displayName },
  attributes: {},
  provisionedBy: 'sdk' as const,
});

/** The completed CREATE the failed deploy journaled. */
const createOp = {
  logicalId: 'Topic',
  changeType: 'CREATE',
  resourceType: TOPIC,
  physicalId: NAME,
  properties: topicRecord('deployed').properties,
  provisionedBy: 'sdk',
};

/** A failed CREATE of another resource, with no physical id (its outcome unknown). */
const OTHER_FAILED = {
  logicalId: 'Other',
  changeType: 'CREATE',
  resourceType: TOPIC,
  attemptedProperties: { TopicName: 'other' },
  provisionedBy: 'sdk',
};

/** The mark `cdkd import` writes for the topic it adopted. */
const MARK = { logicalId: 'Topic', physicalId: NAME, resourceType: TOPIC };

let backend: Record<string, ReturnType<typeof vi.fn>>;

function install(resources: StackState['resources'], segments: Record<string, unknown>[]): void {
  const record: StackState = {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: structuredClone(resources),
    outputs: {},
    lastModified: 1,
  };
  backend = {
    listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue(readAtKeyRegion(record, REGION)),
    loadRollbackJournal: vi.fn().mockResolvedValue({
      journalVersion: 1,
      stackName: STACK,
      region: REGION,
      segments: structuredClone(segments),
    }),
    saveState: vi.fn().mockResolvedValue('etag-2'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
  };
  setupMock.mockResolvedValue({
    stateBackend: backend,
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

const opts = (revertFailed?: boolean) =>
  ({
    yes: true,
    stateBucket: 'b',
    region: REGION,
    ...(revertFailed && { revertFailed: true }),
  }) as unknown as Parameters<typeof rollbackCommand>[1];

const infoLines = (): string[] =>
  (logger['info'] as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

describe('cdkd rollback leaves a resource cdkd import adopted after the deploy alone (go-to-k/cdkd#4523)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.delete.mockResolvedValue(undefined);
    provider.update.mockResolvedValue({ physicalId: NAME, wasReplaced: false });
  });

  it('a completed CREATE of an imported id is not replayed as a delete', async () => {
    install({ Topic: topicRecord('imported') }, [
      { operations: [createOp], importedResources: [MARK] },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(provider.delete).not.toHaveBeenCalled();
    // Nothing replayed, so the imported record is never rewritten or removed.
    expect(backend['saveState']).not.toHaveBeenCalled();
    expect(backend['deleteState']).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes('Topic') && l.includes('adopted by cdkd import'))).toBe(
      true
    );
    // ...and the plan does not ALSO promise its delete.
    expect(infoLines().some((l) => l.includes(' Topic (') && l.includes('delete'))).toBe(false);
    // The segment is still consumed: nothing in it is left to replay.
    expect(backend['popRollbackJournalSegment']).toHaveBeenCalledTimes(1);
  });

  it('control: the same segment WITHOUT the mark deletes the resource (the pre-fix replay)', async () => {
    install({ Topic: topicRecord('imported') }, [{ operations: [createOp] }]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.delete.mock.calls[0]![1]).toBe(NAME);
  });

  it('a later, unmarked segment of the same id is still reverted; only the marked one is left alone', async () => {
    // Older segment: the pre-import CREATE, marked. Newer segment: a deploy
    // AFTER the import changed the topic in place, then failed. Its revert
    // must run; the older CREATE must not delete what is left.
    install({ Topic: topicRecord('changed-after-import') }, [
      { operations: [createOp], importedResources: [MARK] },
      {
        operations: [
          {
            logicalId: 'Topic',
            changeType: 'UPDATE',
            resourceType: TOPIC,
            physicalId: NAME,
            properties: topicRecord('changed-after-import').properties,
            previousResourceType: TOPIC,
            previousState: topicRecord('imported'),
            provisionedBy: 'sdk',
          },
        ],
      },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(provider.update).toHaveBeenCalledTimes(1);
    // The revert restores the IMPORTED properties.
    expect(provider.update.mock.calls[0]![3]).toEqual(topicRecord('imported').properties);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(backend['popRollbackJournalSegment']).toHaveBeenCalledTimes(2);
  });

  it('--revert-failed: a failed CREATE of an imported id is neither planned nor replayed as a delete', async () => {
    const failedCreate = {
      logicalId: 'Topic',
      changeType: 'CREATE',
      resourceType: TOPIC,
      physicalId: NAME,
      attemptedProperties: topicRecord('deployed').properties,
      provisionedBy: 'sdk',
    };
    install({ Topic: topicRecord('imported') }, [
      // `Other` (no physical id: outcome unknown) keeps the failed-op plan and
      // replay REACHED, so an unfiltered list would show Topic there too.
      { operations: [], failedOperations: [failedCreate, OTHER_FAILED], importedResources: [MARK] },
    ]);

    await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

    expect(provider.delete).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes('Topic') && l.includes('adopted by cdkd import'))).toBe(
      true
    );
    expect(infoLines().some((l) => l.includes('Other'))).toBe(true);
    expect(infoLines().some((l) => l.includes(' Topic (') && l.includes('delete'))).toBe(false);
  });

  it('without --revert-failed, an imported failed op is not offered to --revert-failed', async () => {
    install({ Topic: topicRecord('imported') }, [
      {
        operations: [],
        failedOperations: [
          {
            logicalId: 'Topic',
            changeType: 'CREATE',
            resourceType: TOPIC,
            physicalId: NAME,
            attemptedProperties: topicRecord('deployed').properties,
            provisionedBy: 'sdk',
          },
          OTHER_FAILED,
        ],
        importedResources: [MARK],
      },
    ]);

    await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(infoLines().some((l) => l.includes('Topic') && l.includes('adopted by cdkd import'))).toBe(
      true
    );
    // The offer is printed (for Other), just never for the imported Topic.
    expect(infoLines().some((l) => l.includes('Other') && l.includes('pass --revert-failed'))).toBe(true);
    expect(infoLines().some((l) => l.includes(' Topic (') && l.includes('pass --revert-failed'))).toBe(false);
  });

  it('an op of the same logical id that recorded ANOTHER physical id still warns (security review)', async () => {
    // The deploy created an auto-named `old-auto-name`; the user then imported a
    // DIFFERENT resource under the id. The mark names only the imported one, so
    // the journal's CREATE keeps its "physical id changed" warning and the
    // non-zero exit instead of reading as adopted.
    install({ Topic: topicRecord('imported') }, [
      {
        operations: [{ ...createOp, physicalId: 'old-auto-name' }],
        importedResources: [MARK],
      },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(provider.delete).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes('adopted by cdkd import'))).toBe(false);
    expect(infoLines().some((l) => l.includes('physical id changed'))).toBe(true);
    expect(thrown).toBeInstanceOf(Error);
  });

  it.each([
    ['ANOTHER resource the import adopted', 'old-phys', 0],
    ['the same resource (control)', NAME, 1],
  ])(
    '--revert-failed: a failed UPDATE recorded against %s',
    async (_what, opPhysicalId, updates) => {
      // A deploy's UPDATE of Topic failed on `opPhysicalId`; the record now
      // names NAME. Only when they agree may the force-revert write to it.
      install({ Topic: topicRecord('imported') }, [
        {
          operations: [],
          failedOperations: [
            {
              logicalId: 'Topic',
              changeType: 'UPDATE',
              resourceType: TOPIC,
              physicalId: opPhysicalId,
              attemptedProperties: topicRecord('attempted').properties,
              previousState: { ...topicRecord('pre-deploy'), physicalId: opPhysicalId },
              provisionedBy: 'sdk',
            },
          ],
        },
      ]);

      await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

      expect(provider.update).toHaveBeenCalledTimes(updates);
      // The plan says why the mismatched op is skipped.
      expect(infoLines().some((l) => l.includes('no longer names'))).toBe(updates === 0);
    }
  );

  it.each([
    ['ANOTHER resource the import adopted (skip-mismatch)', 'old-phys', 0],
    ['the same resource (control: reverted)', NAME, 1],
  ])('a completed in-place UPDATE recorded against %s', async (_what, opPhysicalId, updates) => {
    // A deploy changed `opPhysicalId` in place; the record now names NAME (an
    // `import --force` of another resource). Only when they agree may the
    // revert push the pre-deploy bag onto the record's resource.
    install({ Topic: topicRecord('imported') }, [
      {
        operations: [
          {
            logicalId: 'Topic',
            changeType: 'UPDATE',
            resourceType: TOPIC,
            physicalId: opPhysicalId,
            properties: topicRecord('deployed').properties,
            previousResourceType: TOPIC,
            previousState: { ...topicRecord('pre-deploy'), physicalId: opPhysicalId },
            provisionedBy: 'sdk',
          },
        ],
      },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(provider.update).toHaveBeenCalledTimes(updates);
    expect(infoLines().some((l) => l.includes('physical id changed'))).toBe(updates === 0);
    // The mismatch warns and exits non-zero; the control is clean.
    expect(thrown instanceof Error).toBe(updates === 0);
  });

  it('a mark of the NEW type does not cover an op of the OLD type under the same id and name', async () => {
    // A Type change under a stable logical id and a name-based physical id:
    // the journal's CREATE made the OLD-type resource; the import adopted a
    // NEW-type one of the same name. The CREATE is not the imported resource,
    // so it is not set aside as one.
    const OLD = 'AWS::SQS::Queue';
    install({ Topic: topicRecord('imported') }, [
      {
        operations: [{ ...createOp, resourceType: OLD }],
        importedResources: [MARK],
      },
    ]);

    await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(infoLines().some((l) => l.includes('adopted by cdkd import'))).toBe(false);
    // The CREATE replays: its OLD-type resource is deleted, routed on the op's type.
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.delete.mock.calls[0]!.slice(0, 3)).toEqual(['Topic', NAME, OLD]);
  });

  it('--revert-failed: a failed Type-change UPDATE keeps its type-change skip whatever physical id it recorded', async () => {
    install({ Topic: topicRecord('imported') }, [
      {
        operations: [],
        failedOperations: [
          {
            logicalId: 'Topic',
            changeType: 'UPDATE',
            resourceType: TOPIC,
            physicalId: 'old-phys',
            previousResourceType: 'AWS::SQS::Queue',
            attemptedProperties: topicRecord('attempted').properties,
            previousState: { ...topicRecord('pre-deploy'), physicalId: 'old-phys', resourceType: 'AWS::SQS::Queue' },
            provisionedBy: 'sdk',
          },
        ],
      },
    ]);

    await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

    expect(provider.update).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes('failed Type change is a replacement'))).toBe(true);
  });

  it('--orphan on an imported id is honoured: the record is dropped from state, nothing is deleted', async () => {
    install({ Topic: topicRecord('imported') }, [{ operations: [createOp], importedResources: [MARK] }]);

    const thrown = await rollbackCommand(STACK, {
      ...opts(),
      orphan: ['Topic'],
    } as Parameters<typeof rollbackCommand>[1]).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes('[--orphan]'))).toBe(true);
    const saves = backend['saveState']!.mock.calls;
    expect(saves.length).toBeGreaterThan(0);
    expect((saves[saves.length - 1]![2] as StackState).resources).not.toHaveProperty('Topic');
  });

  it('--revert-failed: stripping the handled failed ops keeps the imported one in the journal', async () => {
    const failedCreate = (logicalId: string, physicalId: string) => ({
      logicalId,
      changeType: 'CREATE',
      resourceType: TOPIC,
      physicalId,
      attemptedProperties: { TopicName: physicalId },
      provisionedBy: 'sdk',
    });
    install({ Topic: topicRecord('imported'), Other: { ...topicRecord('x'), physicalId: 'other' } }, [
      {
        operations: [],
        failedOperations: [failedCreate('Topic', NAME), failedCreate('Other', 'other')],
        importedResources: [MARK],
      },
    ]);

    const thrown = await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    // Only `Other` is reverted.
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.delete.mock.calls[0]![1]).toBe('other');
    expect(backend['setRollbackJournalFailedOperations']).toHaveBeenCalledTimes(1);
    const kept = backend['setRollbackJournalFailedOperations']!.mock.calls[0]![2] as Array<{
      logicalId: string;
    }>;
    expect(kept.map((op) => op.logicalId)).toEqual(['Topic']);
  });

  it('control: --revert-failed deletes the same failed CREATE without the mark', async () => {
    install({ Topic: topicRecord('imported') }, [
      {
        operations: [],
        failedOperations: [
          {
            logicalId: 'Topic',
            changeType: 'CREATE',
            resourceType: TOPIC,
            physicalId: NAME,
            attemptedProperties: topicRecord('deployed').properties,
            provisionedBy: 'sdk',
          },
        ],
      },
    ]);

    await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

    expect(provider.delete).toHaveBeenCalledTimes(1);
  });
});
