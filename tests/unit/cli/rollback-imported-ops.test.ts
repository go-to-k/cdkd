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
const recorded = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({
    record: (e: Record<string, unknown>) => recorded.events.push(e),
    finalize: vi.fn().mockResolvedValue(undefined),
  }),
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
    recorded.events.length = 0;
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

  it('without --revert-failed, an adopted failed op is not offered to --revert-failed', async () => {
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

  // An op of a MARKED id that recorded another resource was DISPLACED by the
  // import: never replayed (each replay would act on, or rewrite, the imported
  // record), reported as a warning, and the run exits non-zero.
  const DISPLACED = 'cdkd import has since replaced';
  const inPlaceUpdate = (physicalId: string) => ({
    logicalId: 'Topic',
    changeType: 'UPDATE',
    resourceType: TOPIC,
    physicalId,
    properties: topicRecord('deployed').properties,
    previousResourceType: TOPIC,
    previousState: { ...topicRecord('pre-deploy'), physicalId },
    provisionedBy: 'sdk',
  });
  const failedUpdate = (physicalId: string) => ({
    logicalId: 'Topic',
    changeType: 'UPDATE',
    resourceType: TOPIC,
    physicalId,
    attemptedProperties: topicRecord('attempted').properties,
    previousState: { ...topicRecord('pre-deploy'), physicalId },
    provisionedBy: 'sdk',
  });

  it.each([
    ['a CREATE of another physical id', { ...createOp, physicalId: 'old-auto-name' }],
    // Security m3: a Type change under a stable id and a name-based physical
    // id — the OLD-type CREATE must not delete (and drop from state) anything.
    ['a CREATE of the OLD type under the same name', { ...createOp, resourceType: 'AWS::SQS::Queue' }],
    // Orchestrator T1: an in-place revert would push the old bag onto Q.
    ['an in-place UPDATE of another physical id', inPlaceUpdate('old-phys')],
  ])('a displaced op is left alone with a warning: %s', async (_what, op) => {
    install({ Topic: topicRecord('imported') }, [{ operations: [op], importedResources: [MARK] }]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(provider.delete).not.toHaveBeenCalled();
    expect(provider.update).not.toHaveBeenCalled();
    expect(backend['saveState']).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes(' Topic (') && l.includes(DISPLACED))).toBe(true);
    // The op's own physical id is named: after the pop, nothing else does.
    expect(infoLines().some((l) => l.includes(DISPLACED) && l.includes(op.physicalId))).toBe(true);
    expect(infoLines().some((l) => l.includes('adopted by cdkd import'))).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('skipped');
    // The durable event every warned skip records, without a physical id.
    const skips = recorded.events.filter((e) => e['eventType'] === 'ROLLBACK_RESOURCE_SKIPPED');
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ logicalId: 'Topic', resourceType: op.resourceType });
    expect(skips[0]).not.toHaveProperty('physicalId');
  });

  it('a displaced op whose name is secret-derived does not print its physical id (go-to-k/cdkd#4037 masker)', async () => {
    // The journal holds the reference, not the plaintext; the physical id is
    // the resolved name, so it is withheld like every id the replay prints.
    const secretNamed = {
      ...createOp,
      physicalId: 'name-from-a-secret',
      properties: { TopicName: '{{resolve:secretsmanager:app:SecretString:topic}}' },
    };
    install({ Topic: topicRecord('imported') }, [
      { operations: [secretNamed], importedResources: [MARK] },
    ]);

    await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    const lines = [
      ...infoLines(),
      ...(logger['warn'] as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])),
    ];
    expect(lines.some((l) => l.includes(' Topic (') && l.includes(DISPLACED))).toBe(true);
    expect(lines.some((l) => l.includes('name-from-a-secret'))).toBe(false);
  });

  it('--revert-failed: a displaced failed CREATE that recorded no physical id says so', async () => {
    install({ Topic: topicRecord('imported') }, [
      {
        operations: [],
        failedOperations: [{ ...OTHER_FAILED, logicalId: 'Topic' }],
        importedResources: [MARK],
      },
    ]);

    await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

    expect(provider.delete).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes(' Topic (') && l.includes('recorded no physical id'))).toBe(
      true
    );
  });

  // V3/V4: ONLY displaced failed ops in the segment, so nothing else warns.
  // Counted with or without `--revert-failed`: the plan lists them either
  // way and nothing ever reverts them.
  it.each([
    ['with --revert-failed', true],
    ['without --revert-failed', false],
  ])('a segment holding only a displaced failed op warns and exits non-zero %s', async (_what, revertFailed) => {
    install({ Topic: topicRecord('imported') }, [
      { operations: [], failedOperations: [failedUpdate('old-phys')], importedResources: [MARK] },
    ]);

    const thrown = await rollbackCommand(STACK, opts(revertFailed)).catch((e: unknown) => e);

    expect(provider.update).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('skipped');
    const skips = recorded.events.filter((e) => e['eventType'] === 'ROLLBACK_RESOURCE_SKIPPED');
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ logicalId: 'Topic', operation: 'UPDATE' });
    expect(skips[0]).not.toHaveProperty('physicalId');
    // The replay-time warn line, not only the plan line.
    const warns = (logger['warn'] as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warns.some((l) => l.includes('Topic (') && l.includes(DISPLACED) && l.includes('old-phys'))).toBe(true);
  });

  // V1: a completed DELETE carries no `physicalId`; its identity is the
  // record it deleted (or kept under Retain).
  it.each([
    ['the SAME resource (adopted, silent, exit 0)', NAME, false],
    ['ANOTHER resource (displaced, exit 2)', 'old-phys', true],
  ])('a DELETE whose previous record names %s', async (_what, prevId, displacedExpected) => {
    install({ Topic: topicRecord('imported') }, [
      {
        operations: [
          {
            logicalId: 'Topic',
            changeType: 'DELETE',
            resourceType: TOPIC,
            previousState: { ...topicRecord('pre-deploy'), physicalId: prevId },
            provisionedBy: 'sdk',
          },
        ],
        importedResources: [MARK],
      },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(thrown instanceof Error).toBe(displacedExpected);
    expect(infoLines().some((l) => l.includes(' Topic (') && l.includes('adopted by cdkd import'))).toBe(
      !displacedExpected
    );
    expect(infoLines().some((l) => l.includes(DISPLACED) && l.includes(prevId))).toBe(displacedExpected);
  });

  // V2 / security m5: a replacement UPDATE (old -> new). Whichever resource
  // the import took, the OTHER one is left running untracked, so the op is
  // reported (displaced), naming the one to check — never adopted silently.
  const replacementOp = (oldResourceRetained: boolean) => ({
    logicalId: 'Topic',
    changeType: 'UPDATE',
    resourceType: TOPIC,
    physicalId: 'new-phys',
    properties: topicRecord('deployed').properties,
    previousResourceType: TOPIC,
    oldResourceRetained,
    previousState: { ...topicRecord('pre-deploy'), physicalId: 'old-phys' },
    provisionedBy: 'sdk',
  });

  it.each([
    ['the import put the OLD resource back: names the replacement', 'old-phys', false, 'new-phys'],
    ['the import took the NEW resource while the old was RETAINED: names the old', 'new-phys', true, 'old-phys'],
    // Spec W1: the clause is decided from the MARK. The old resource imported
    // back under a RETAIN replacement still names the replacement left running.
    ['the import put the RETAINED old resource back: names the replacement', 'old-phys', true, 'new-phys'],
  ])('a replacement UPDATE where %s', async (_what, importedId, retained, named) => {
    install({ Topic: { ...topicRecord('imported'), physicalId: importedId } }, [
      { operations: [replacementOp(retained)], importedResources: [{ ...MARK, physicalId: importedId }] },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(Error);
    expect(infoLines().some((l) => l.includes('adopted by cdkd import'))).toBe(false);
    expect(infoLines().some((l) => l.includes(' Topic (') && l.includes(named) && l.includes('check that resource by hand'))).toBe(true);
    // "adopted the replacement" only when the import really took the new one.
    expect(infoLines().some((l) => l.includes('adopted the replacement'))).toBe(importedId === 'new-phys');
  });

  it('a replacement UPDATE whose NEW resource the import took, old NOT retained, is adopted silently', async () => {
    install({ Topic: { ...topicRecord('imported'), physicalId: 'new-phys' } }, [
      { operations: [replacementOp(false)], importedResources: [{ ...MARK, physicalId: 'new-phys' }] },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes('adopted by cdkd import'))).toBe(true);
  });

  it('--revert-failed: a displaced failed UPDATE is not force-reverted, warns, and stays in the journal', async () => {
    install({ Topic: topicRecord('imported') }, [
      {
        operations: [],
        failedOperations: [failedUpdate('old-phys'), OTHER_FAILED],
        importedResources: [MARK],
      },
    ]);

    const thrown = await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

    expect(provider.update).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes(' Topic (') && l.includes(DISPLACED))).toBe(true);
    expect(thrown).toBeInstanceOf(Error);
    // `Other` is handled (stripped); the displaced Topic op is kept.
    const kept = backend['setRollbackJournalFailedOperations']!.mock.calls[0]![2] as Array<{
      logicalId: string;
    }>;
    expect(kept.map((o) => o.logicalId)).toEqual(['Topic']);
  });

  // WITHOUT an import mark, a physical id that differs from the record is NOT
  // evidence of an import: a newer segment's reverse-replacement of an
  // AUTO-NAMED resource re-ids it, and the older in-place op must still revert.
  it('no mark: an in-place UPDATE whose id a reverse-replacement changed is still reverted', async () => {
    install({ Topic: { ...topicRecord('deployed'), physicalId: 'p3' } }, [
      { operations: [inPlaceUpdate('p1')] },
    ]);

    const thrown = await rollbackCommand(STACK, opts()).catch((e: unknown) => e);

    expect(thrown).toBeUndefined();
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(provider.update.mock.calls[0]![1]).toBe('p3');
  });

  it('no mark: --revert-failed still force-reverts a failed UPDATE whose id a reverse-replacement changed', async () => {
    install({ Topic: { ...topicRecord('deployed'), physicalId: 'p3' } }, [
      { operations: [], failedOperations: [failedUpdate('p1')] },
    ]);

    await rollbackCommand(STACK, opts(true)).catch((e: unknown) => e);

    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(infoLines().some((l) => l.includes(DISPLACED))).toBe(false);
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
