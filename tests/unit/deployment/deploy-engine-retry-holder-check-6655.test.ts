/**
 * go-to-k/cdkd#6655: the cleanup pass deletes a replaced S3 bucket BY NAME, so
 * before it sends that delete it compares the holder of the name with the
 * generation the deferral journaled (go-to-k/cdkd#6621). A holder proven not
 * the stack's is left alone and its superseded entry dropped; an unreadable
 * holder is never deleted by name; no journaled generation keeps today's
 * delete.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  deleteReplacedAfterCreate,
  retryDeferredReplacedDeletes,
} from '../../../src/deployment/deploy-engine/replacement.js';
import { journaledHolderRead } from '../../../src/deployment/journaled-holder.js';
import { SUPERSEDED_KEPT_REMEDY } from '../../../src/deployment/superseded-resources.js';
import type { ResourceProvider, SurvivorIdentityRead } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const printed = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', async () => {
  const sink = (level: 'info' | 'warn') =>
    vi.fn((message: unknown) => {
      printed[level].push(String(message));
    });
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: sink('info'),
    warn: sink('warn'),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const BUCKET = 'AWS::S3::Bucket';
const D1 = '2026-11-01T00:00:00.000Z';
const D2 = '2026-11-20T00:00:00.000Z';

describe('the cleanup pass compares a replaced bucket holder before deleting it (go-to-k/cdkd#6655)', () => {
  let provider: ResourceProvider;
  /** What `replacedSurvivorIdentity` answers, per read. */
  let holder: () => Promise<SurvivorIdentityRead>;
  let reads: number;
  const saved = { ...journaledHolderRead };

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    journaledHolderRead.delayMs = 0;
    reads = 0;
    holder = async () => ({ kind: 'owned', identity: `us-east-1|${D1}` });
    provider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(async () => undefined),
      getAttribute: vi.fn(),
      replacedSurvivorIdentity: vi.fn(() => {
        reads++;
        return holder();
      }),
    } as unknown as ResourceProvider;
  });

  afterEach(() => {
    Object.assign(journaledHolderRead, saved);
  });

  function inDeploy(region = 'us-east-1') {
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { getProvider: () => provider } as never,
      { concurrency: 1 } as never,
      region
    );
    const run = engine.replacementRun;
    run.deferredReplacedDeletes = new Map();
    const host: Pick<StackState, 'supersededResources'> = {};
    run.supersededHost = host;
    return { engine, run, host };
  }

  const old = (resourceType = BUCKET): ResourceState =>
    ({
      physicalId: 'bucket-old',
      resourceType,
      properties: { BucketName: 'bucket-old' },
    }) as unknown as ResourceState;

  /** Defer the old bucket's delete (one read journals its generation), then run the cleanup pass. */
  async function deferThenClean(
    ctx: ReturnType<typeof inDeploy>,
    atCleanup: () => Promise<SurvivorIdentityRead>,
    record = old()
  ): Promise<number> {
    await deleteReplacedAfterCreate(
      ctx.run,
      ctx.engine.replacementDeps(),
      'Bucket',
      record.resourceType,
      record,
      provider,
      record.properties,
      undefined,
      undefined,
      new Map(),
      'cc-api'
    );
    expect(provider.delete).not.toHaveBeenCalled();
    const atDeferral = reads;
    holder = atCleanup;
    await retryDeferredReplacedDeletes(ctx.run, ctx.engine.replacementDeps(), 'S', {
      updated: 1,
      updatePartial: 0,
    });
    return reads - atDeferral;
  }

  const warned = () => printed.warn.join('\n');

  // go-to-k/cdkd#6668: the deferral puts the generation on the superseded
  // entry too, before the row's save, for a later run's carried delete.
  it('records the journaled generation on the superseded entry, and none when the read did not answer', async () => {
    const ctx = inDeploy();
    const record = old();
    await deleteReplacedAfterCreate(
      ctx.run,
      ctx.engine.replacementDeps(),
      'Bucket',
      record.resourceType,
      record,
      provider,
      record.properties,
      undefined,
      undefined,
      new Map(),
      'cc-api'
    );
    expect(ctx.host.supersededResources).toHaveLength(1);
    expect(ctx.host.supersededResources![0]!.identity).toBe(`us-east-1|${D1}`);
    expect(ctx.run.supersededEntries.get('Bucket')!.identity).toBe(`us-east-1|${D1}`);

    holder = async () => ({ kind: 'unknown' });
    const other = inDeploy();
    await deleteReplacedAfterCreate(
      other.run,
      other.engine.replacementDeps(),
      'Bucket',
      record.resourceType,
      record,
      provider,
      record.properties,
      undefined,
      undefined,
      new Map(),
      'cc-api'
    );
    expect(other.host.supersededResources).toHaveLength(1);
    expect('identity' in other.host.supersededResources![0]!).toBe(false);
  });

  it('deletes the bucket the deferral journaled', async () => {
    const ctx = inDeploy();
    const cleanupReads = await deferThenClean(ctx, async () => ({ kind: 'owned', identity: `us-east-1|${D1}` }));
    expect(ctx.run.replacedOldIdentity.get('Bucket')).toBe(`us-east-1|${D1}`);
    expect(cleanupReads).toBe(1);
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(ctx.host.supersededResources ?? []).toHaveLength(0);
    expect(printed.warn).toEqual([]);
  });

  // Measured for #6671 (2026-11-20, us-east-1): a bucket policy's put and
  // delete and an object's put and delete leave CreationDate alone, so a
  // difference there proves a re-create.
  it('refuses another generation in us-east-1, drops the entry, and prints no generation value', async () => {
    const ctx = inDeploy();
    expect(ctx.host.supersededResources).toBeUndefined();
    await deferThenClean(ctx, async () => ({ kind: 'owned', identity: `us-east-1|${D2}` }));
    expect(provider.delete).not.toHaveBeenCalled();
    expect(ctx.host.supersededResources ?? []).toHaveLength(0);
    expect(ctx.run.supersededEntries.has('Bucket')).toBe(false);
    expect(ctx.run.replacedOldMaySurvive.has('Bucket')).toBe(false);
    expect(warned()).toContain('its creation time differs from what cdkd read when it deferred the delete');
    expect(warned()).toContain('no delete was sent and that resource was left alone');
    expect(warned()).not.toContain(D1);
    expect(warned()).not.toContain(D2);
  });

  it.each([
    ['another account', 'other-account', 'owning account'],
    ['another region', 'other-region', 'region'],
  ] as const)('refuses a holder in %s in every region', async (_l, seen, attribute) => {
    for (const region of ['us-east-1', 'us-west-2']) {
      vi.mocked(provider.delete).mockClear();
      printed.warn.length = 0;
      holder = async () => ({ kind: 'owned', identity: `${region}|${D1}` });
      const ctx = inDeploy(region);
      await deferThenClean(ctx, async () => ({ kind: 'foreign', seen }));
      expect(provider.delete).not.toHaveBeenCalled();
      expect(ctx.host.supersededResources ?? []).toHaveLength(0);
      expect(ctx.run.replacedOldMaySurvive.has('Bucket')).toBe(false);
      expect(warned()).toContain(`its ${attribute} differs`);
      expect(warned()).toContain('that resource was left alone');
    }
  });

  it('outside us-east-1, deletes despite another generation: writes move it there', async () => {
    holder = async () => ({ kind: 'owned', identity: `us-west-2|${D1}` });
    const ctx = inDeploy('us-west-2');
    await deferThenClean(ctx, async () => ({ kind: 'owned', identity: `us-west-2|${D2}` }));
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(printed.warn).toEqual([]);
  });

  it('sends no delete when the name is free, and counts the old bucket as deleted', async () => {
    const ctx = inDeploy();
    await deferThenClean(ctx, async () => ({ kind: 'gone' }));
    expect(provider.delete).not.toHaveBeenCalled();
    expect(ctx.host.supersededResources ?? []).toHaveLength(0);
    expect(ctx.run.replacedOldMaySurvive.has('Bucket')).toBe(false);
    expect(printed.info.join('\n')).toContain('is already gone; no delete was sent');
    expect(printed.warn).toEqual([]);
  });

  it('makes the row partial when an untracked (in-memory) deferral cannot read its holder', async () => {
    const ctx = inDeploy();
    holder = async () => ({ kind: 'unknown' });
    ctx.run.replacedOldIdentity.set('Bucket', `us-east-1|${D1}`);
    const record = old();
    await deleteReplacedAfterCreate(
      ctx.run,
      ctx.engine.replacementDeps(),
      'Bucket',
      record.resourceType,
      record,
      provider,
      record.properties,
      undefined,
      undefined,
      new Map(),
      'cc-api',
      undefined,
      true
    );
    expect(provider.delete).not.toHaveBeenCalled();
    expect(ctx.run.replacedDeleteSkips.get('Bucket')).toContain('is no longer tracked by cdkd');
    expect(ctx.run.replacedOldMaySurvive.get('Bucket')).toBe('unconfirmed');
    expect(warned()).toContain('It is no longer tracked in state: delete it manually');
  });

  it('reads nothing and deletes as before when the deferral journaled no generation', async () => {
    holder = async () => ({ kind: 'unknown' });
    const ctx = inDeploy();
    const cleanupReads = await deferThenClean(ctx, async () => ({ kind: 'owned', identity: `us-east-1|${D2}` }));
    expect(ctx.run.replacedOldIdentity.has('Bucket')).toBe(false);
    expect(cleanupReads).toBe(0);
    expect(provider.delete).toHaveBeenCalledTimes(1);
  });

  it('reads nothing for a type outside the journaled set', async () => {
    const ctx = inDeploy();
    const cleanupReads = await deferThenClean(
      ctx,
      async () => ({ kind: 'foreign', seen: 'other-account' }),
      old('AWS::SNS::Topic')
    );
    expect(reads).toBe(0);
    expect(cleanupReads).toBe(0);
    expect(provider.delete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['does not answer', { kind: 'unknown' }],
    ['cannot read the generation', { kind: 'owned', identity: undefined }],
  ] as const)(
    'never deletes by name when the holder read %s, and keeps the entry',
    async (_l, answer) => {
      const ctx = inDeploy();
      const cleanupReads = await deferThenClean(ctx, async () => answer as SurvivorIdentityRead);
      expect(cleanupReads).toBe(journaledHolderRead.attempts);
      expect(provider.delete).not.toHaveBeenCalled();
      expect(ctx.host.supersededResources ?? []).toHaveLength(1);
      expect(warned()).toContain('could not read what holds that name now');
      expect(warned()).toContain(SUPERSEDED_KEPT_REMEDY);
    }
  );

  it('never deletes by name when the holder read throws', async () => {
    const ctx = inDeploy();
    await deferThenClean(ctx, async () => {
      throw new Error('SlowDown');
    });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(ctx.host.supersededResources ?? []).toHaveLength(1);
  });

  it('reads again after an unanswered read, and deletes once the holder matches', async () => {
    const ctx = inDeploy();
    let n = 0;
    const cleanupReads = await deferThenClean(ctx, async () =>
      ++n === 1 ? { kind: 'unknown' } : { kind: 'owned', identity: `us-east-1|${D1}` }
    );
    expect(cleanupReads).toBe(2);
    expect(provider.delete).toHaveBeenCalledTimes(1);
  });

  it('stops reading again once the deploy is interrupted', async () => {
    const ctx = inDeploy();
    let interrupted = false;
    vi.spyOn(ctx.engine, 'replacementDeps').mockImplementation(function (this: DeployEngine) {
      const deps = DeployEngine.prototype.replacementDeps.call(this);
      return { ...deps, interrupted: () => interrupted };
    });
    const cleanupReads = await deferThenClean(ctx, async () => {
      interrupted = true;
      return { kind: 'unknown' };
    });
    expect(cleanupReads).toBe(1);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(warned()).toContain('the run was interrupted before cdkd could read what holds that name now');
    expect(ctx.host.supersededResources ?? []).toHaveLength(1);
  });

  // The population the compare guards: every deferred delete is queued with
  // a `retry` closure, and each one reaches `deleteReplacedAfterCreate(...,
  // isRetry)`, where the compare runs. Measured before the fix: three
  // producers (delete-replaced.ts: the cleanup-phase deferral and the
  // failure retry; cleanup-old-id.ts: a custom resource's old id).
  it('the deferred-delete producers are the three the compare covers', () => {
    const root = join(__dirname, '../../../src/deployment/deploy-engine');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const n = readFileSync(p, 'utf8').match(/^\s+retry: \(\) =>(?! Promise<)/gm)?.length ?? 0;
          for (let i = 0; i < n; i++) hits.push(p.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual([
      'replacement/cleanup-old-id.ts',
      'replacement/delete-replaced.ts',
      'replacement/delete-replaced.ts',
    ]);
    const cleanupOldId = readFileSync(join(root, 'replacement/cleanup-old-id.ts'), 'utf8');
    expect(cleanupOldId).toMatch(/retry: \(\) => send\(true\)/);
    expect(cleanupOldId).toMatch(/await deleteReplacedAfterCreate\(/);
  });
});
