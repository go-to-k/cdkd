import { describe, it, expect, vi } from 'vite-plus/test';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import {
  CDKD_NAMESPACE_ID_TYPES,
  CONTENT_COMPARED_DELETE_TYPES,
  RESOURCE_IDENTITY_TIMEOUT_MS,
  UNIQUE_PHYSICAL_ID_TYPES,
  orphanDeleteNeedsIdentity,
  readResourceIdentity,
} from '../../../src/deployment/rollback-executor/orphan-identity.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';
import type { ForeignHolding } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

// go-to-k/cdkd#4655: a successful deploy deletes a name-keyed proven orphan
// only when the live resource under its id still carries the identity its
// failed CREATE journaled. Otherwise it may be a resource that reused the name.

const REGION = 'us-east-1';
const TYPE = 'AWS::Kinesis::Stream';
const TOKEN = 'arn:aws:kinesis:us-east-1:123456789012:stream/orphan-stream@1700000000000';

const orphan = (extra: Record<string, unknown> = {}) => ({
  logicalId: 'Orphan',
  changeType: 'CREATE',
  resourceType: TYPE,
  physicalId: 'orphan-stream',
  provisionedBy: 'sdk',
  physicalIdRecoveredFromError: true,
  deletionPolicy: 'Delete',
  createdResourceIdentity: TOKEN,
  attemptedProperties: {},
  ...extra,
});

interface RunOptions {
  ops?: unknown[];
  /** The live read: a value, a throw, or `'absent'` for a provider without the method. */
  live?: string | typeof RESOURCE_NOT_FOUND | undefined | Error | 'absent';
  holding?: ForeignHolding;
  /** The record under `Orphan` and the provider's verdict on it (the fix-forward). */
  fixForward?: 'different';
}

async function run(opts: RunOptions = {}) {
  const live = 'live' in opts ? opts.live : TOKEN;
  const provider: Record<string, unknown> = { delete: vi.fn().mockResolvedValue(undefined) };
  const identityRoutes: unknown[] = [];
  let lastRoute: unknown;
  const resourceIdentity = vi.fn(async () => {
    identityRoutes.push(lastRoute);
    if (live instanceof Error) throw live;
    return live;
  });
  if (live !== 'absent') provider['resourceIdentity'] = resourceIdentity;
  const isSameResource = vi.fn(async () => opts.fixForward);
  if (opts.fixForward !== undefined) provider['isSameResource'] = isSameResource;
  const journal = {
    journalVersion: 1,
    stackName: 'S',
    region: REGION,
    segments: [
      {
        timestamp: 1,
        reason: 'no-rollback-failure',
        initialDeploy: false,
        operations: [],
        failedOperations: opts.ops ?? [orphan()],
      },
    ],
  };
  const stateBackend = {
    loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
    reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
    markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
    dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const getProviderFor = vi.fn((input: unknown) => {
    lastRoute = input;
    return { provider, provisionedBy: 'sdk' };
  });
  const ctx = {
    providerRegistry: { getProviderFor, getProvider: vi.fn().mockReturnValue(provider) },
    region: REGION,
    logger,
  } as unknown as RollbackExecutorContext;
  const stateResources = (
    opts.fixForward === undefined
      ? {}
      : {
          Orphan: {
            physicalId: 'orphan-stream-b',
            resourceType: TYPE,
            provisionedBy: 'sdk',
            properties: {},
            attributes: {},
          },
        }
  ) as never;
  const out = await settleJournaledOrphansOnSuccess({
    stateBackend: stateBackend as never,
    stackName: 'S',
    region: REGION,
    stateResources,
    rollbackOrphans: undefined,
    newerOperations: [],
    foreignHolder: vi.fn(async () => opts.holding),
    ctx,
    logger: logger as never,
  });
  const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
  const info = logger.info.mock.calls.map((c) => String(c[0])).join('\n');
  return { out, provider, resourceIdentity, isSameResource, identityRoutes, warned, info };
}

const deleted = (r: Awaited<ReturnType<typeof run>>) =>
  (r.provider['delete'] as ReturnType<typeof vi.fn>).mock.calls.length;

const NOT_PROVEN = 'nothing proves the resource now under its physical id';
const MISMATCH = 'the resource now under its physical id is another one';

describe('settleJournaledOrphansOnSuccess: the created resource identity (go-to-k/cdkd#4655)', () => {
  it('deletes a name-keyed orphan whose live identity equals the journaled one', async () => {
    const r = await run();
    expect(deleted(r)).toBe(1);
    expect(r.resourceIdentity).toHaveBeenCalledWith('orphan-stream', TYPE, { expectedRegion: REGION });
    // The route the identity read itself was asked through: the orphan's.
    expect(r.identityRoutes).toEqual([{ resourceType: TYPE, provisionedBy: 'sdk' }]);
    expect(r.out).toEqual({ unaddressed: 0, keepJournal: false, stripCleared: expect.any(Function) });
    expect(r.warned).not.toContain(NOT_PROVEN);
    expect(r.warned).not.toContain(MISMATCH);
  });

  it.each([
    ['no journaled identity (a legacy journal)', { ops: [orphan({ createdResourceIdentity: undefined })] }],
    ['a provider without resourceIdentity', { live: 'absent' as const }],
    ['a live read that throws', { live: new Error('AccessDenied') }],
    ['a live read that names nothing', { live: undefined }],
    // Both absent: `undefined === undefined` must not read as a match.
    [
      'no journaled identity and a provider without resourceIdentity',
      { ops: [orphan({ createdResourceIdentity: undefined })], live: 'absent' as const },
    ],
    [
      'no journaled identity and a live read that names nothing',
      { ops: [orphan({ createdResourceIdentity: undefined })], live: undefined },
    ],
  ])('keeps and warns about it on %s: not deleted, exit 2, entry cleared', async (_label, opts) => {
    const r = await run(opts as RunOptions);
    expect(deleted(r)).toBe(0);
    expect(r.warned).toContain(NOT_PROVEN);
    // Nothing was read to compare, so it never claims the name was reused.
    expect(r.warned).not.toContain(MISMATCH);
    // Named by logical id and type; the replay names the physical id, masked.
    expect(r.warned).toContain('Orphan');
    expect(r.out.unaddressed).toBe(1);
    expect(r.out.keepJournal).toBe(false);
  });

  it('keeps and warns about it as a reused name when the live identity differs', async () => {
    const r = await run({ live: `${TOKEN.split('@')[0]}@1800000000000` });
    expect(deleted(r)).toBe(0);
    expect(r.warned).toContain(MISMATCH);
    expect(r.warned).not.toContain(NOT_PROVEN);
    expect(r.warned).toContain('Orphan');
    expect(r.out.unaddressed).toBe(1);
    expect(r.out.keepJournal).toBe(false);
  });

  // A delete sent later could reach a resource created under the name since.
  it('settles an orphan AWS reports gone without a delete, with or without a journaled identity', async () => {
    for (const ops of [[orphan()], [orphan({ createdResourceIdentity: undefined })]]) {
      const r = await run({ ops, live: RESOURCE_NOT_FOUND });
      expect(deleted(r)).toBe(0);
      expect(r.warned).not.toContain(NOT_PROVEN);
      expect(r.info).toContain('is already gone: nothing to delete');
      expect(r.out.unaddressed).toBe(0);
      expect(r.out.keepJournal).toBe(false);
    }
  });

  it('applies on the fix-forward path too: a "different" verdict still needs the identity', async () => {
    const match = await run({ fixForward: 'different' });
    expect(match.isSameResource).toHaveBeenCalledOnce();
    expect(deleted(match)).toBe(1);

    const reused = await run({ fixForward: 'different', live: 'arn:other@1' });
    expect(reused.isSameResource).toHaveBeenCalledOnce();
    expect(deleted(reused)).toBe(0);
    expect(reused.warned).toContain(MISMATCH);
    expect(reused.out.unaddressed).toBe(1);

    const gone = await run({ fixForward: 'different', live: RESOURCE_NOT_FOUND });
    expect(gone.isSameResource).toHaveBeenCalledOnce();
    expect(deleted(gone)).toBe(0);
    expect(gone.info).toContain('is already gone: nothing to delete');
    expect(gone.out.unaddressed).toBe(0);
  });

  it('asks nothing for an orphan another stack holds (already demoted)', async () => {
    const r = await run({ holding: { kind: 'held', by: 'stack Other' } });
    expect(r.resourceIdentity).not.toHaveBeenCalled();
    expect(deleted(r)).toBe(0);
    expect(r.warned).not.toContain(NOT_PROVEN);
  });

  it('reads nothing for a Retain orphan, which is left in AWS anyway', async () => {
    const r = await run({
      ops: [orphan({ deletionPolicy: 'Retain', createdResourceIdentity: undefined })],
      live: 'absent',
    });
    expect(r.resourceIdentity).not.toHaveBeenCalled();
    expect(r.warned).not.toContain(NOT_PROVEN);
    expect(deleted(r)).toBe(0);
    expect(r.out.unaddressed).toBe(0);
  });

  it.each([
    ['AWS::EC2::NatGateway', 'nat-0123456789abcdef0'],
    ['AWS::KMS::Key', '1234abcd-12ab-34cd-56ef-1234567890ab'],
    ['AWS::SQS::QueuePolicy', 'https://sqs.us-east-1.amazonaws.com/123456789012/q'],
    ['AWS::CloudFormation::Stack', 'arn:cdkd-local:us-east-1:123456789012:nested-stack/S/Child'],
  ])('deletes a %s orphan without an identity: its id is never reused, or its delete compares content', async (type, id) => {
    const r = await run({
      ops: [orphan({ resourceType: type, physicalId: id, createdResourceIdentity: undefined })],
      live: 'absent',
    });
    expect(deleted(r)).toBe(1);
    expect(r.resourceIdentity).not.toHaveBeenCalled();
    expect(r.warned).not.toContain(NOT_PROVEN);
  });

  it('needs an identity for a name-keyed type, and none for a type in either set', async () => {
    for (const type of ['AWS::SQS::Queue', 'AWS::S3::Bucket', 'AWS::ApiGateway::Stage', TYPE]) {
      expect(orphanDeleteNeedsIdentity(type)).toBe(true);
    }
    for (const type of [
      ...UNIQUE_PHYSICAL_ID_TYPES,
      ...CONTENT_COMPARED_DELETE_TYPES,
      ...CDKD_NAMESPACE_ID_TYPES,
    ]) {
      expect(orphanDeleteNeedsIdentity(type)).toBe(false);
    }
  });
});

describe('readResourceIdentity (go-to-k/cdkd#4655)', () => {
  const registryOf = (resourceIdentity: () => Promise<unknown>) => ({
    getProviderFor: () => ({ provider: { resourceIdentity }, provisionedBy: 'sdk' }) as never,
  });
  const target = { resourceType: TYPE, physicalId: 'orphan-stream', provisionedBy: 'sdk' as const };

  it('answers undefined for a read that does not answer within its bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = readResourceIdentity(registryOf(() => new Promise<never>(() => {})), target, REGION);
      await vi.advanceTimersByTimeAsync(RESOURCE_IDENTITY_TIMEOUT_MS - 1);
      let settled = false;
      void pending.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a prompt answer and leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(await readResourceIdentity(registryOf(async () => TOKEN), target, REGION)).toBe(TOKEN);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
