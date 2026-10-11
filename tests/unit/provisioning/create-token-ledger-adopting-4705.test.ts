/**
 * go-to-k/cdkd#4705 (C): the create-token ledger records a deploy's
 * name-adopting creates BEFORE they are sent, in one write, so a re-run after
 * a crash between such a create and its state record finds the name as its
 * own. The deploy's end drops the intents it no longer needs; a Retain reads
 * nothing (its license is `retained.json`).
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  quiet.child.mockReturnValue(quiet);
  return { getLogger: () => quiet };
});

import {
  ADOPTING_CREATE_BASE,
  CreateTokenLedger,
  ledgerAbandonedAt,
  noteAbandonedRun,
  noteRetainedResource,
  recordAdoptingCreates,
  recordedAdoptingCreates,
  settleAdoptingCreates,
  withCreateTokenLedger,
} from '../../../src/provisioning/providers/create-token-ledger.js';
import type { CreateTokenLedgerDoc } from '../../../src/state/create-token-ledger.js';

function storeOf(initial: CreateTokenLedgerDoc | null = null) {
  let doc = initial === null ? null : (JSON.parse(JSON.stringify(initial)) as CreateTokenLedgerDoc);
  const store = {
    load: vi.fn(async () => (doc === null ? null : (JSON.parse(JSON.stringify(doc)) as CreateTokenLedgerDoc))),
    save: vi.fn(async (next: CreateTokenLedgerDoc) => {
      doc = JSON.parse(JSON.stringify(next)) as CreateTokenLedgerDoc;
    }),
    current: () => doc,
  };
  return store;
}

const QUEUE = 'AWS::SQS::Queue';

describe('recording name-adopting creates', () => {
  it('records every create in ONE write, then reads them back by logical id', async () => {
    const store = storeOf();
    const ledger = new CreateTokenLedger(store);
    await withCreateTokenLedger(ledger, async () => {
      await recordAdoptingCreates([
        { logicalId: 'A', resourceType: QUEUE, name: 'App-A' },
        { logicalId: 'B', resourceType: QUEUE, name: 'App-B' },
      ]);
      expect(store.save).toHaveBeenCalledTimes(1);
      await expect(recordedAdoptingCreates()).resolves.toEqual(
        new Map([
          ['A', { resourceType: QUEUE, name: 'App-A', firstSentAt: expect.any(Number) }],
          ['B', { resourceType: QUEUE, name: 'App-B', firstSentAt: expect.any(Number) }],
        ])
      );
    });
    expect(store.current()!.sent['A']).toMatchObject({ base: `${ADOPTING_CREATE_BASE}${QUEUE}`, token: 'App-A' });
  });

  it('a re-run recording the same names writes nothing', async () => {
    const store = storeOf();
    await withCreateTokenLedger(new CreateTokenLedger(store), () =>
      recordAdoptingCreates([{ logicalId: 'A', resourceType: QUEUE, name: 'App-A' }])
    );
    const again = storeOf(store.current());
    await withCreateTokenLedger(new CreateTokenLedger(again), () =>
      recordAdoptingCreates([{ logicalId: 'A', resourceType: QUEUE, name: 'App-A' }])
    );
    expect(again.save).not.toHaveBeenCalled();
  });

  it('a write that fails throws (the caller refuses those creates)', async () => {
    const store = storeOf();
    store.save.mockRejectedValue(new Error('S3 down'));
    await expect(
      withCreateTokenLedger(new CreateTokenLedger(store), () =>
        recordAdoptingCreates([{ logicalId: 'A', resourceType: QUEUE, name: 'App-A' }])
      )
    ).rejects.toThrow('S3 down');
  });

  it('ignores token entries: only adopting creates are listed', async () => {
    const store = storeOf({
      ledgerVersion: 1,
      nonce: 'n',
      sent: { Efs: { base: 'efs-base', token: 't', firstSentAt: 1 } },
    });
    await withCreateTokenLedger(new CreateTokenLedger(store), async () => {
      await expect(recordedAdoptingCreates()).resolves.toEqual(new Map());
    });
  });

  it('with no ledger bound: nothing recorded, nothing listed', async () => {
    await expect(recordedAdoptingCreates()).resolves.toBeUndefined();
    await expect(recordAdoptingCreates([{ logicalId: 'A', resourceType: QUEUE, name: 'x' }])).resolves.toBeUndefined();
  });
});

describe('a Retain lets the resource go (review CB-19)', () => {
  it('reads and writes nothing for a type that takes no token: retained.json licenses taking it back', async () => {
    const store = storeOf();
    const ledger = new CreateTokenLedger(store);
    await withCreateTokenLedger(ledger, async () => {
      await noteRetainedResource(QUEUE, 'A');
      await noteRetainedResource('AWS::S3::Bucket', 'Bucket');
    });
    expect(store.load).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });
});

describe('dropping the intents of a finished deploy', () => {
  it('drops, in one write, only the adopting entries of the given logical ids', async () => {
    const store = storeOf({
      ledgerVersion: 1,
      nonce: 'n',
      sent: { Efs: { base: 'efs-base', token: 't', firstSentAt: 1 } },
    });
    await withCreateTokenLedger(new CreateTokenLedger(store), async () => {
      await recordAdoptingCreates([
        { logicalId: 'A', resourceType: QUEUE, name: 'App-A' },
        { logicalId: 'B', resourceType: QUEUE, name: 'App-B' },
      ]);
      store.save.mockClear();
      await settleAdoptingCreates(['A', 'Efs', 'Missing']);
    });
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(Object.keys(store.current()!.sent).sort()).toEqual(['B', 'Efs']);
  });

  it('S-6: stamps failedAt on a kept adopting intent in the same write, and reads it back', async () => {
    const store = storeOf();
    await withCreateTokenLedger(new CreateTokenLedger(store), async () => {
      await recordAdoptingCreates([
        { logicalId: 'A', resourceType: QUEUE, name: 'App-A' },
        { logicalId: 'B', resourceType: QUEUE, name: 'App-B' },
      ]);
      store.save.mockClear();
      await settleAdoptingCreates(['B'], new Map([['A', 4242]]));
      expect(store.save).toHaveBeenCalledTimes(1);
      expect((await recordedAdoptingCreates())!.get('A')).toMatchObject({ failedAt: 4242 });
    });
    expect(Object.keys(store.current()!.sent)).toEqual(['A']);
  });

  it('S-1: a failure rejects (the guard retries, then bounds what is left)', async () => {
    const store = storeOf();
    store.load.mockRejectedValue(new Error('S3 down'));
    await expect(
      withCreateTokenLedger(new CreateTokenLedger(store), () => settleAdoptingCreates(['A']))
    ).rejects.toThrow('S3 down');
  });
});

describe('recording an abandoned run (review G-1)', () => {
  it('writes `abandonedAt` only when the ledger holds an adopting intent, and only a newer time', async () => {
    const store = storeOf();
    await withCreateTokenLedger(new CreateTokenLedger(store), async () => {
      await recordAdoptingCreates([{ logicalId: 'A', resourceType: QUEUE, name: 'App-A' }]);
      store.save.mockClear();
      await noteAbandonedRun(5000);
      expect(store.save).toHaveBeenCalledTimes(1);
      await expect(ledgerAbandonedAt()).resolves.toBe(5000);
      await noteAbandonedRun(4000);
      await noteAbandonedRun(5000);
      expect(store.save).toHaveBeenCalledTimes(1);
      await noteAbandonedRun(6000);
      await expect(ledgerAbandonedAt()).resolves.toBe(6000);
    });
    expect(store.current()!.abandonedAt).toBe(6000);
  });

  it('writes nothing without an adopting intent (a token-only ledger, or none)', async () => {
    const tokensOnly = storeOf({
      ledgerVersion: 1,
      nonce: 'n',
      sent: { Fs: { base: 'cdkd-Fs-a', token: 'cdkd-Fs-b', firstSentAt: 1 } },
    } as CreateTokenLedgerDoc);
    await withCreateTokenLedger(new CreateTokenLedger(tokensOnly), () => noteAbandonedRun(5000));
    expect(tokensOnly.save).not.toHaveBeenCalled();

    const none = storeOf();
    await withCreateTokenLedger(new CreateTokenLedger(none), () => noteAbandonedRun(5000));
    expect(none.save).not.toHaveBeenCalled();
  });

  it('the ledger method itself rejects on a failure (force-unlock warns on it)', async () => {
    const store = storeOf();
    store.load.mockRejectedValue(new Error('S3 down'));
    await expect(new CreateTokenLedger(store).noteAbandoned(5000)).rejects.toThrow('S3 down');
  });

  it('the deploy-path wrapper swallows a failure, never throws, and says it did not record', async () => {
    const store = storeOf();
    store.load.mockRejectedValue(new Error('S3 down'));
    await expect(
      withCreateTokenLedger(new CreateTokenLedger(store), () => noteAbandonedRun(5000))
    ).resolves.toBe(false);
  });
});
