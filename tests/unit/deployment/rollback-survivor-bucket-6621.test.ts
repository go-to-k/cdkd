/**
 * go-to-k/cdkd#6621: the rollback of a replaced S3 bucket judges WHO holds
 * the old name before it re-adopts it: a bucket this account does not own
 * (or in another region) is refused outright; with a generation journaled at
 * the deferral, the live one must equal it (a differing one is a re-create in
 * us-east-1, undecidable elsewhere); a journal without one keeps the
 * re-adopt; an unanswered read keeps the #6399 'unknown' semantics. The read
 * is taken before the replay applies any op.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import {
  REPLACED_SURVIVOR_PROBE_TIMEOUT_MS,
  snapshotSurvivorIdentities,
} from '../../../src/deployment/rollback-executor/replaced-survivor.js';
import { RESOURCE_NOT_FOUND, type SurvivorIdentityRead } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const BUCKET = 'AWS::S3::Bucket';
const D1 = '2026-11-01T00:00:00.000Z';
const D2 = '2026-11-19T00:00:00.000Z';

function rec(physicalId: string, overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId,
    resourceType: BUCKET,
    properties: { BucketName: physicalId },
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
    ...overrides,
  };
}

function op(extra: Partial<CompletedOperation> = {}): CompletedOperation {
  return {
    logicalId: 'Bucket',
    changeType: 'UPDATE',
    resourceType: BUCKET,
    provisionedBy: 'sdk',
    physicalId: 'bucket-new',
    previousState: rec('bucket-old'),
    oldResourceRetained: false,
    oldResourceMaySurvive: 'deferred',
    ...extra,
  };
}

describe('re-adopting a replaced S3 bucket (go-to-k/cdkd#6621)', () => {
  let live: Set<string>;
  let existence: (physicalId: string) => Promise<unknown>;
  let holder: () => Promise<SurvivorIdentityRead>;
  let identityReads: number;
  let provider: Record<string, unknown> & {
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let warns: string[];
  let ctx: RollbackExecutorContext;

  beforeEach(() => {
    live = new Set(['bucket-old', 'bucket-new']);
    existence = async (physicalId) =>
      live.has(physicalId) ? { BucketName: physicalId } : RESOURCE_NOT_FOUND;
    holder = async () => ({ kind: 'owned', identity: `us-east-1|${D1}` });
    identityReads = 0;
    provider = {
      create: vi.fn(async () => ({ physicalId: 'bucket-old', attributes: {} })),
      delete: vi.fn(async (_l: string, physicalId: string) => {
        live.delete(physicalId);
      }),
      readCurrentState: vi.fn(async (physicalId: string) => existence(physicalId)),
      replacedSurvivorIdentity: vi.fn(async () => {
        identityReads++;
        return holder();
      }),
    };
    warns = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((m: string) => warns.push(m)),
      error: vi.fn(),
      setLevel: vi.fn(),
      child: () => logger,
    } as unknown as RollbackExecutorContext['logger'];
    ctx = {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProvider: () => provider,
        getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
  });

  const state = (): Record<string, ResourceState> => ({ Bucket: rec('bucket-new') });

  async function replay(o: CompletedOperation) {
    const s = state();
    const result = await replayRollback([o], s, 'S', ctx);
    return { s, result, text: warns.join('\n') };
  }

  function expectReadopted(r: Awaited<ReturnType<typeof replay>>): void {
    expect(r.result.failures).toBe(0);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete.mock.calls.map((c) => c[1])).toEqual(['bucket-new']);
    expect(r.s['Bucket']!.physicalId).toBe('bucket-old');
  }

  function expectRefused(r: Awaited<ReturnType<typeof replay>>, ...needles: string[]): void {
    expect(r.result.failures).toBe(1);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(r.s['Bucket']!.physicalId).toBe('bucket-new');
    expect(r.text).toContain('Nothing was sent and the journal is kept.');
    expect(r.text).toContain('--orphan Bucket');
    for (const needle of needles) expect(r.text).toContain(needle);
  }

  const FOREIGN_HEAD =
    'Cannot reverse the replacement of Bucket (AWS::S3::Bucket): AWS reports a resource under ' +
    'the old physical id (bucket-old), but not the one this stack recorded (';

  // --- arm 1: the account ---------------------------------------------------
  it.each([
    ['a journaled generation', `us-east-1|${D1}`],
    ['no journaled generation (an older journal)', undefined],
  ] as const)("refuses another account's bucket with %s", async (_l, journaled) => {
    holder = async () => ({ kind: 'foreign', seen: 'other-account' });
    expectRefused(
      await replay(op({ oldResourceIdentity: journaled })),
      FOREIGN_HEAD + "it is not in this account's bucket list, so it belongs to another account)"
    );
  });

  it("refuses another account's bucket even when the existence read fails on it", async () => {
    existence = async () => {
      throw Object.assign(new Error('Forbidden'), { name: '403' });
    };
    holder = async () => ({ kind: 'foreign', seen: 'other-account' });
    // The #6399 arm would re-adopt an unanswered read while state lists it.
    ctx.supersededResources = [{ logicalId: 'Bucket', supersededAt: 1, state: rec('bucket-old') }];
    expectRefused(await replay(op()), 'belongs to another account');
  });

  it('refuses a bucket in another region than the stack', async () => {
    holder = async () => ({ kind: 'foreign', seen: 'other-region' });
    expectRefused(
      await replay(op({ oldResourceIdentity: `us-east-1|${D1}` })),
      "it is in another region than this stack's, and a bucket never moves region"
    );
  });

  // --- arm 2: the journaled generation ---------------------------------------
  it('re-adopts the generation the deploy journaled', async () => {
    expectReadopted(await replay(op({ oldResourceIdentity: `us-east-1|${D1}` })));
  });

  it('refuses another generation in us-east-1 as a re-create', async () => {
    holder = async () => ({ kind: 'owned', identity: `us-east-1|${D2}` });
    expectRefused(
      await replay(op({ oldResourceIdentity: `us-east-1|${D1}` })),
      FOREIGN_HEAD +
        "its creation date differs from the one read when the deploy deferred the old bucket's " +
        'delete, and in us-east-1 only a re-create changes it), so another resource took that name'
    );
  });

  it('refuses another generation outside us-east-1 as undecidable, saying why', async () => {
    ctx.region = 'us-west-2';
    holder = async () => ({ kind: 'owned', identity: `us-west-2|${D2}` });
    const r = await replay(op({ oldResourceIdentity: `us-west-2|${D1}` }));
    expectRefused(
      r,
      'Cannot reverse the replacement of Bucket (AWS::S3::Bucket): the bucket under the old name ' +
        '(bucket-old) may have been re-created or modified since the failed deploy',
      'outside us-east-1 S3 moves that date on a configuration write',
      'delete it by hand once its contents are no longer needed, and otherwise leave it alone'
    );
    expect(r.text).not.toContain('another resource took that name');
  });

  // --- a journal without the generation --------------------------------------
  it("re-adopts this account's bucket when the journal carries no generation", async () => {
    holder = async () => ({ kind: 'owned', identity: `us-east-1|${D2}` });
    expectReadopted(await replay(op()));
  });

  // --- unanswered reads keep the #6399 semantics -----------------------------
  describe.each([
    ['the holder read', () => ({ kind: 'unknown' }) as SurvivorIdentityRead],
    ['the generation', () => ({ kind: 'owned', identity: undefined }) as SurvivorIdentityRead],
  ])('when %s cannot be read', (_l, read) => {
    beforeEach(() => {
      holder = async () => read();
    });
    it('re-adopts while state still lists the old bucket as superseded', async () => {
      ctx.supersededResources = [{ logicalId: 'Bucket', supersededAt: 1, state: rec('bucket-old') }];
      expectReadopted(await replay(op({ oldResourceIdentity: `us-east-1|${D1}` })));
    });
    it('refuses once state no longer lists it', async () => {
      ctx.supersededResources = [];
      expectRefused(
        await replay(op({ oldResourceIdentity: `us-east-1|${D1}` })),
        'cdkd could not read whether it does'
      );
    });
  });

  it('re-creates when the bucket is gone', async () => {
    live.delete('bucket-old');
    holder = async () => ({ kind: 'gone' });
    const r = await replay(op({ oldResourceIdentity: `us-east-1|${D1}` }));
    expect(r.result.failures).toBe(0);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  // --- the snapshot before the replay ----------------------------------------
  describe('snapshotSurvivorIdentities', () => {
    it('reads each bucket survivor once, and the probe uses that read, not a later one', async () => {
      const o = op({ oldResourceIdentity: `us-east-1|${D1}` });
      await snapshotSurvivorIdentities(ctx, [o, op({ logicalId: 'Other', resourceType: 'AWS::SNS::Topic', previousState: rec('t', { resourceType: 'AWS::SNS::Topic' }) })]);
      expect(identityReads).toBe(1);
      // An earlier revert moves the date (a policy write outside us-east-1).
      holder = async () => ({ kind: 'owned', identity: `us-east-1|${D2}` });
      expectReadopted(await replay(o));
      expect(identityReads).toBe(1);
    });

    it('refuses a bucket that was absent when the rollback started', async () => {
      holder = async () => ({ kind: 'gone' });
      const o = op({ oldResourceIdentity: `us-east-1|${D1}` });
      await snapshotSurvivorIdentities(ctx, [o]);
      expectRefused(await replay(o), 'nothing held that id when this rollback started');
    });

    it('skips ops whose old resource may not survive, and other types', async () => {
      await snapshotSurvivorIdentities(ctx, [
        op({ oldResourceMaySurvive: undefined }),
        op({ resourceType: 'AWS::SNS::Topic', previousState: rec('t', { resourceType: 'AWS::SNS::Topic' }) }),
      ]);
      expect(identityReads).toBe(0);
      expect(ctx.survivorIdentities).toBeUndefined();
    });

    it("records 'unknown' for a read that does not answer in time", async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        holder = () => new Promise(() => {});
        const pending = snapshotSurvivorIdentities(ctx, [op()]);
        await vi.advanceTimersByTimeAsync(REPLACED_SURVIVOR_PROBE_TIMEOUT_MS);
        await pending;
        expect([...ctx.survivorIdentities!.values()]).toEqual([{ kind: 'unknown' }]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
