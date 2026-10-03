import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return { getLogger: () => ({ child: () => child, ...child }) };
});

import {
  CreateTokenLedger,
  earliestDefined,
  forgetRecordedCreateTokens,
  noteDeployStateRecord,
  noteRetainedResource,
  reserveStackCreateToken,
  withCreateTokenLedger,
  type CreateTokenLedgerStore,
} from '../../../src/provisioning/providers/create-token-ledger.js';
import { stackScopedCreateToken } from '../../../src/provisioning/providers/idempotency-token.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import {
  notifyStateSaved,
  type CreateTokenLedgerDoc,
} from '../../../src/state/create-token-ledger.js';

/**
 * go-to-k/cdkd#4438: the create-token ledger -- a per-stack nonce folded into
 * the EFS / FSx / OAI create tokens, replaced whenever cdkd lets go of
 * resources it made, plus a marker of each create persisted before it is sent.
 */

/** A ledger store over one S3 object, as `S3StateBackend` keeps it. */
const memoryStore = () => {
  let body: string | undefined;
  const saves: CreateTokenLedgerDoc[] = [];
  const store: CreateTokenLedgerStore & { failLoad?: boolean; failSave?: boolean } = {
    load: async () => {
      if (store.failLoad) throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      return body === undefined ? null : (JSON.parse(body) as CreateTokenLedgerDoc);
    },
    save: async (doc) => {
      if (store.failSave) throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      body = JSON.stringify(doc);
      saves.push(JSON.parse(body) as CreateTokenLedgerDoc);
    },
  };
  return {
    store,
    saves,
    /** `deleteState`: the object is gone. */
    drop: () => {
      body = undefined;
    },
    current: () => (body === undefined ? undefined : (JSON.parse(body) as CreateTokenLedgerDoc)),
  };
};

const FS = { logicalId: 'Fs', immutableInputs: ['LUSTRE', ['subnet-1']], maxLength: 63 };

/** One deploy: a fresh ledger over `store`, inside the stack's scope. */
const inDeploy = <T,>(store: CreateTokenLedgerStore, fn: () => Promise<T>): Promise<T> =>
  withStackName('DevStack', () => withCreateTokenLedger(new CreateTokenLedger(store), fn));

describe('reserveStackCreateToken', () => {
  beforeEach(() => {
    warn.mockClear();
    process.env['AWS_REGION'] = 'us-east-1';
  });

  it('outside a bound ledger is the nonce-free stack-scoped token', async () => {
    const token = await withStackName('DevStack', () => reserveStackCreateToken(FS));
    expect(token.value).toBe(withStackName('DevStack', () => stackScopedCreateToken(FS)));
    expect(token.earlierFirstSentAt).toBeUndefined();
  });

  it('persists the nonce and the sent entry BEFORE returning the token', async () => {
    const mem = memoryStore();
    const token = await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    const saved = mem.current()!;
    expect(saved.sent['Fs']?.token).toBe(token.value);
    expect(token.value).not.toBe(withStackName('DevStack', () => stackScopedCreateToken(FS)));
    expect(token.value).toMatch(/^cdkd-Fs-[0-9a-f]{12}$/);
  });

  it('a re-run after an interruption ANYWHERE in the deploy sends the same token and reports its first send', async () => {
    // The entry is kept after the create returned too: a deploy killed before
    // the state record named the resource is the case #4437 had to refuse.
    const mem = memoryStore();
    const first = await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    const firstSentAt = mem.current()!.sent['Fs']!.firstSentAt;

    const rerun = await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    expect(rerun.value).toBe(first.value);
    expect(rerun.earlierFirstSentAt).toBe(firstSentAt);
  });

  it('after the ledger is deleted with the state record (destroy), the next create sends a NEW token', async () => {
    const mem = memoryStore();
    const first = await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    mem.drop();
    const afterDestroy = await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    expect(afterDestroy.value).not.toBe(first.value);
    expect(afterDestroy.earlierFirstSentAt).toBeUndefined();
  });

  it('a Retain that lets a logical id go drops ITS entry and the nonce: its next create sends a NEW token', async () => {
    const mem = memoryStore();
    const other = { ...FS, logicalId: 'Other' };
    const [first, otherToken] = await inDeploy(mem.store, async () => {
      const t = await reserveStackCreateToken(FS);
      const o = await reserveStackCreateToken(other);
      await noteRetainedResource('AWS::FSx::FileSystem', 'Fs');
      return [t, o] as const;
    });
    expect(mem.current()!.sent['Fs']).toBeUndefined();
    const [next, otherRerun] = await inDeploy(mem.store, async () => [
      await reserveStackCreateToken(FS),
      await reserveStackCreateToken(other),
    ]);
    expect(next.value).not.toBe(first.value);
    expect(next.earlierFirstSentAt).toBeUndefined();
    // Another logical id keeps the token it sent: a re-run of it still finds its resource.
    expect(otherRerun.value).toBe(otherToken.value);
  });

  it('concurrent first reserves of one deploy share ONE nonce and keep BOTH entries', async () => {
    const mem = memoryStore();
    const other = { ...FS, logicalId: 'Other' };
    await inDeploy(mem.store, async () => {
      await Promise.all([reserveStackCreateToken(FS), reserveStackCreateToken(other)]);
    });
    const saved = mem.current()!;
    expect(Object.keys(saved.sent).sort()).toEqual(['Fs', 'Other']);
    // Both derive from the saved nonce: a re-run reproduces both.
    const rerun = await inDeploy(mem.store, async () => [
      await reserveStackCreateToken(FS),
      await reserveStackCreateToken(other),
    ]);
    expect(rerun.map((t) => t.value)).toEqual([saved.sent['Fs']!.token, saved.sent['Other']!.token]);
  });

  it('rotates only for a type that takes a ledger token', async () => {
    const mem = memoryStore();
    await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    const nonce = mem.current()!.nonce;
    await inDeploy(mem.store, () => noteRetainedResource('AWS::S3::Bucket', 'Fs'));
    expect(mem.current()!.nonce).toBe(nonce);
    expect(mem.current()!.sent['Fs']).toBeDefined();
    await inDeploy(mem.store, () => noteRetainedResource('AWS::EFS::FileSystem', 'Fs'));
    expect(mem.current()!.nonce).not.toBe(nonce);
    await expect(noteRetainedResource('AWS::EFS::FileSystem', 'Fs')).resolves.toBeUndefined();
  });

  it('does not create a ledger on a rotation when the stack has none', async () => {
    const mem = memoryStore();
    await inDeploy(mem.store, () => noteRetainedResource('AWS::EFS::FileSystem', 'Fs'));
    expect(mem.saves).toHaveLength(0);
  });

  it('a sent entry for DIFFERENT create-only inputs is not this create: a new token', async () => {
    const mem = memoryStore();
    const first = await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    const changed = await inDeploy(mem.store, () =>
      reserveStackCreateToken({ ...FS, immutableInputs: ['LUSTRE', ['subnet-2']] })
    );
    expect(changed.value).not.toBe(first.value);
    expect(changed.earlierFirstSentAt).toBeUndefined();
  });

  it('an unreadable ledger REFUSES the create, naming the stack and logical id, with the read failure as its cause', async () => {
    // Sending the nonce-free token instead would fail open: a re-run that can
    // read the ledger sends a different token, and this attempt's resource leaks.
    const mem = memoryStore();
    mem.store.failLoad = true;
    const ledger = new CreateTokenLedger(mem.store, {
      stackName: 'Evil\n[ok] FORGED\u001b[2J',
      region: 'us-east-1',
    });
    const error = await withStackName('DevStack', () =>
      withCreateTokenLedger(ledger, () => reserveStackCreateToken(FS))
    ).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('the create of Fs was not sent');
    expect(error!.message).toContain('Evil [ok] FORGED');
    expect(error!.message).not.toMatch(/[\u0000-\u001f]/);
    expect((error as Error & { cause?: { name?: string } }).cause?.name).toBe('AccessDenied');
    // Nothing was minted over the ledger it could not read.
    expect(mem.saves).toHaveLength(0);
  });

  it('the refusal flattens a hostile logical id and AWS message', async () => {
    const mem = memoryStore();
    mem.store.load = async () => {
      throw Object.assign(new Error('denied\n[ok] FORGED-ERROR\u001b[2J'), { name: 'AccessDenied' });
    };
    const error = await inDeploy(mem.store, () =>
      reserveStackCreateToken({ ...FS, logicalId: 'Fs\n[ok] FORGED-ID\u001b[2J' })
    ).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(error!.message).toContain('FORGED-ID');
    expect(error!.message).toContain('FORGED-ERROR');
    expect(error!.message).not.toMatch(/[\u0000-\u001f]/);
  });

  it('an unwritable ledger REFUSES the create and takes back the entry it could not save; a retry reads again', async () => {
    const mem = memoryStore();
    mem.store.failSave = true;
    await withStackName('DevStack', () => {
      const ledger = new CreateTokenLedger(mem.store);
      return withCreateTokenLedger(ledger, async () => {
        await expect(reserveStackCreateToken(FS)).rejects.toThrow('the create of Fs was not sent');
        // A retry of the same create must not be handed the unsaved token ...
        await expect(reserveStackCreateToken(FS)).rejects.toThrow('the create of Fs was not sent');
        // ... and once the ledger is writable again, the retry goes through.
        mem.store.failSave = false;
        const token = await reserveStackCreateToken(FS);
        expect(mem.current()!.sent['Fs']!.token).toBe(token.value);
      });
    });
  });

  it('a failed read leaves the ledger usable: a let-go and a forget read it again', async () => {
    const mem = memoryStore();
    await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    await inDeploy(mem.store, () => reserveStackCreateToken({ ...FS, logicalId: 'Kept' }));
    const nonce = mem.current()!.nonce;
    await withStackName('DevStack', () => {
      const ledger = new CreateTokenLedger(mem.store);
      return withCreateTokenLedger(ledger, async () => {
        mem.store.failLoad = true;
        await expect(reserveStackCreateToken({ ...FS, logicalId: 'Other' })).rejects.toThrow();
        mem.store.failLoad = false;
        await noteRetainedResource('AWS::EFS::FileSystem', 'Kept');
        await forgetRecordedCreateTokens(['Fs']);
      });
    });
    expect(mem.current()!.nonce).not.toBe(nonce);
    expect(Object.keys(mem.current()!.sent)).toEqual([]);
  });

  it('a forget after a failed write reads the ledger again instead of trusting memory', async () => {
    // The failed rotation changed the nonce and dropped Kept in memory only;
    // a forget that saved that memory would persist a rotation nobody saw
    // succeed, and would skip the reread that finds what is really stored.
    const mem = memoryStore();
    await inDeploy(mem.store, async () => {
      await reserveStackCreateToken(FS);
      await reserveStackCreateToken({ ...FS, logicalId: 'Kept' });
    });
    const stored = mem.current()!;
    await withStackName('DevStack', () => {
      const ledger = new CreateTokenLedger(mem.store);
      return withCreateTokenLedger(ledger, async () => {
        await forgetRecordedCreateTokens(['Nothing']); // loads the ledger
        mem.store.failSave = true;
        await noteRetainedResource('AWS::EFS::FileSystem', 'Kept'); // fails
        mem.store.failSave = false;
        await forgetRecordedCreateTokens(['Fs']);
      });
    });
    expect(mem.current()!.nonce).toBe(stored.nonce);
    expect(Object.keys(mem.current()!.sent)).toEqual(['Kept']);
  });

  it.each([
    ['its write', 'failSave'],
    ['its read', 'failLoad'],
  ] as const)(
    'a let-go whose rotation failed (%s) refuses a later create of that id in the deploy, instead of sending the token the kept resource holds',
    async (_label, failure) => {
      // An OAI: CloudFront hands the identity holding the token back. The
      // stored ledger still has the OLD nonce and Fs's entry, so a reread
      // would derive (or re-send) exactly that token.
      const mem = memoryStore();
      const kept = await inDeploy(mem.store, () => reserveStackCreateToken(FS));
      await inDeploy(mem.store, async () => {
        // A failed write needs a ledger the deploy has read; a failed read, one it has not.
        if (failure === 'failSave') await forgetRecordedCreateTokens(['Nothing']);
        mem.store[failure] = true;
        await noteRetainedResource('AWS::CloudFront::CloudFrontOriginAccessIdentity', 'Fs');
        mem.store[failure] = false;
        await expect(reserveStackCreateToken(FS)).rejects.toThrow('the create of Fs was not sent');
        // Another logical id is unaffected.
        const other = await reserveStackCreateToken({ ...FS, logicalId: 'Other' });
        expect(other.value).not.toBe(kept.value);
      });
    }
  );

  it('a let-go whose rotation succeeds on a later attempt no longer refuses', async () => {
    const mem = memoryStore();
    const kept = await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    await inDeploy(mem.store, async () => {
      mem.store.failSave = true;
      await noteRetainedResource('AWS::EFS::FileSystem', 'Fs');
      mem.store.failSave = false;
      await noteRetainedResource('AWS::EFS::FileSystem', 'Fs');
      const next = await reserveStackCreateToken(FS);
      expect(next.value).not.toBe(kept.value);
      expect(next.earlierFirstSentAt).toBeUndefined();
    });
  });

  it('a let-go that cannot be recorded warns, naming the logical id', async () => {
    const mem = memoryStore();
    await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    mem.store.failSave = true;
    await inDeploy(mem.store, () => noteRetainedResource('AWS::EFS::FileSystem', 'Fs'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('that Fs was kept'));
  });

  it("a successful deploy forgets the entries its record now names, and only those", async () => {
    const mem = memoryStore();
    const other = { ...FS, logicalId: 'Other' };
    await inDeploy(mem.store, async () => {
      await reserveStackCreateToken(FS);
      await reserveStackCreateToken(other);
      await forgetRecordedCreateTokens(['Fs', 'Unrelated']);
    });
    expect(Object.keys(mem.current()!.sent)).toEqual(['Other']);
  });

  it('a successful deploy that created nothing forgets an entry an EARLIER failed deploy left for what its record names', async () => {
    const mem = memoryStore();
    await inDeploy(mem.store, () => reserveStackCreateToken(FS)); // the failed deploy: entry stays
    await inDeploy(mem.store, () => forgetRecordedCreateTokens(['Fs']));
    expect(mem.current()!.sent['Fs']).toBeUndefined();
  });

  it('writes nothing when the record names no logical id the ledger holds', async () => {
    const mem = memoryStore();
    await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    const saves = mem.saves.length;
    await inDeploy(mem.store, () => forgetRecordedCreateTokens(['Unrelated']));
    expect(mem.saves.length).toBe(saves);
  });

  it('forgets nothing, and writes nothing, when the stack has no ledger', async () => {
    const mem = memoryStore();
    await inDeploy(mem.store, () => forgetRecordedCreateTokens(['Fs']));
    expect(mem.saves).toHaveLength(0);
  });

  it('a forget that cannot be persisted warns and never throws', async () => {
    const mem = memoryStore();
    await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    mem.store.failSave = true;
    await expect(inDeploy(mem.store, () => forgetRecordedCreateTokens(['Fs']))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not clear recorded creates'));
  });

  it('a token issued in this deploy is issued again for a retry even after the ledger failed', async () => {
    const mem = memoryStore();
    await withStackName('DevStack', () => {
      const ledger = new CreateTokenLedger(mem.store);
      return withCreateTokenLedger(ledger, async () => {
        const first = await reserveStackCreateToken(FS);
        mem.store.failSave = true;
        mem.store.failLoad = true;
        // Another create's save fails ...
        await expect(reserveStackCreateToken({ ...FS, logicalId: 'Other' })).rejects.toThrow();
        // ... but a retry of the first create must still agree with itself,
        // even while the ledger cannot be read.
        const retry = await reserveStackCreateToken(FS);
        expect(retry.value).toBe(first.value);
      });
    });
  });

  it('a recorded entry for DIFFERENT create-only inputs is not this create, even after the deploy loaded the ledger', async () => {
    // A replacement: the previous create of Fs left its entry; another create
    // loads the ledger first, then Fs is re-created with changed inputs. The
    // OLD token must not be sent: under create-first it would hand the old
    // file system back.
    const mem = memoryStore();
    const old = await inDeploy(mem.store, () => reserveStackCreateToken(FS));
    const changed = await inDeploy(mem.store, async () => {
      await reserveStackCreateToken({ ...FS, logicalId: 'Other' });
      return reserveStackCreateToken({ ...FS, immutableInputs: ['LUSTRE', ['subnet-2']] });
    });
    expect(changed.value).not.toBe(old.value);
    expect(changed.earlierFirstSentAt).toBeUndefined();
  });
});

describe('a ledger that outlived its state record (go-to-k/cdkd#4438, mixed versions)', () => {
  const STACK = { stackName: 'DevStack', region: 'us-east-1' };

  /**
   * One deploy as the engine runs it: the ledger bound with the stack's
   * coordinates, told whether a state record exists, and -- when
   * `savesState` -- told of a state save after the creates.
   */
  const deploy = <T,>(
    store: CreateTokenLedgerStore,
    opts: { stateExists: boolean; savesState: boolean },
    fn: () => Promise<T>
  ): Promise<T> =>
    withStackName('DevStack', () =>
      withCreateTokenLedger(new CreateTokenLedger(store, STACK), async () => {
        noteDeployStateRecord(opts.stateExists);
        const result = await fn();
        if (opts.savesState) await notifyStateSaved('DevStack', 'us-east-1');
        return result;
      })
    );

  it('a state save marks the ledger, once per deploy', async () => {
    const mem = memoryStore();
    await deploy(mem.store, { stateExists: false, savesState: true }, async () => {
      await reserveStackCreateToken(FS);
      await notifyStateSaved('DevStack', 'us-east-1'); // a second save writes nothing more
    });
    expect(mem.current()!.stateRecorded).toBe(true);
    expect(mem.saves).toHaveLength(2);
  });

  it("another stack's state save does not mark this one's ledger", async () => {
    const mem = memoryStore();
    await deploy(mem.store, { stateExists: false, savesState: false }, async () => {
      await reserveStackCreateToken(FS);
      await notifyStateSaved('OtherStack', 'us-east-1');
      await notifyStateSaved('DevStack', 'eu-west-1');
    });
    expect(mem.current()!.stateRecorded).toBeUndefined();
  });

  it('a ledger whose state record is gone is replaced: the kept resource is not handed back', async () => {
    // 1. A deploy creates Fs, saves state, then fails: Fs's entry survives.
    // 2. An older cdkd destroys the stack, keeping Fs (RETAIN), and never
    //    deletes the ledger.
    // 3. The next deploy finds no state record but that ledger: resuming would
    //    send Fs's old token and take the kept file system over.
    const mem = memoryStore();
    const first = await deploy(mem.store, { stateExists: false, savesState: true }, () =>
      reserveStackCreateToken(FS)
    );
    expect(mem.current()!.stateRecorded).toBe(true);
    const oldNonce = mem.current()!.nonce;
    const next = await deploy(mem.store, { stateExists: false, savesState: false }, () =>
      reserveStackCreateToken(FS)
    );
    expect(next.value).not.toBe(first.value);
    expect(next.earlierFirstSentAt).toBeUndefined();
    expect(next.ledgerStartedThisDeploy).toBe(true);
    expect(mem.current()!.nonce).not.toBe(oldNonce);
    expect(mem.current()!.sent['Fs']!.token).toBe(next.value);
    // The replacement is what is stored now, unmarked until a state save.
    expect(mem.current()!.stateRecorded).toBeUndefined();
  });

  it('a replacement, once saved, is not replaced again when a failure makes the deploy read the ledger anew', async () => {
    const mem = memoryStore();
    await deploy(mem.store, { stateExists: false, savesState: true }, () =>
      reserveStackCreateToken(FS)
    );
    // The record is gone; this deploy replaces the ledger, saves state, then
    // a failed write makes it read the (now marked) ledger again.
    await deploy(mem.store, { stateExists: false, savesState: false }, async () => {
      await reserveStackCreateToken(FS);
      await notifyStateSaved('DevStack', 'us-east-1');
      mem.store.failSave = true;
      await noteRetainedResource('AWS::EFS::FileSystem', 'Zed');
      mem.store.failSave = false;
      await reserveStackCreateToken({ ...FS, logicalId: 'Other' });
    });
    expect(Object.keys(mem.current()!.sent).sort()).toEqual(['Fs', 'Other']);
  });

  it('a first deploy interrupted before any state save still resumes', async () => {
    const mem = memoryStore();
    const first = await deploy(mem.store, { stateExists: false, savesState: false }, () =>
      reserveStackCreateToken(FS)
    );
    const rerun = await deploy(mem.store, { stateExists: false, savesState: false }, () =>
      reserveStackCreateToken(FS)
    );
    expect(rerun.value).toBe(first.value);
    expect(rerun.earlierFirstSentAt).toBeDefined();
  });

  it('with its state record present, a marked ledger resumes', async () => {
    const mem = memoryStore();
    const first = await deploy(mem.store, { stateExists: false, savesState: true }, () =>
      reserveStackCreateToken(FS)
    );
    const rerun = await deploy(mem.store, { stateExists: true, savesState: false }, () =>
      reserveStackCreateToken(FS)
    );
    expect(rerun.value).toBe(first.value);
  });

  it('a deploy against an existing record marks every ledger it writes', async () => {
    const mem = memoryStore();
    await deploy(mem.store, { stateExists: true, savesState: false }, () =>
      reserveStackCreateToken(FS)
    );
    expect(mem.current()!.stateRecorded).toBe(true);
  });

  it('a mark that cannot be written warns and is tried again on the next state save', async () => {
    const mem = memoryStore();
    await deploy(mem.store, { stateExists: false, savesState: false }, async () => {
      await reserveStackCreateToken(FS);
      mem.store.failSave = true;
      await notifyStateSaved('DevStack', 'us-east-1');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mark this stack'));
      mem.store.failSave = false;
      await notifyStateSaved('DevStack', 'us-east-1');
    });
    expect(mem.current()!.stateRecorded).toBe(true);
  });
});

describe('earliestDefined', () => {
  it('is the earliest of the defined times, and undefined when none is', () => {
    expect(earliestDefined(5, 3, undefined)).toBe(3);
    expect(earliestDefined(undefined, 7)).toBe(7);
    expect(earliestDefined(2, 9)).toBe(2);
    expect(earliestDefined(undefined, undefined)).toBeUndefined();
  });
});
