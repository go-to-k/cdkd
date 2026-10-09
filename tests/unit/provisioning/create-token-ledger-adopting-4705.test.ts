/**
 * go-to-k/cdkd#4705 (C): the create-token ledger records a deploy's
 * name-adopting creates BEFORE they are sent, in one write, so a re-run after
 * a crash between such a create and its state record finds the name as its
 * own; a Retain that lets the resource go drops the entry.
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
  noteRetainedResource,
  recordAdoptingCreates,
  recordedAdoptingCreates,
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
          ['A', { resourceType: QUEUE, name: 'App-A' }],
          ['B', { resourceType: QUEUE, name: 'App-B' }],
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

describe('a Retain lets the resource go', () => {
  it("drops an adopting create's entry, so its name no longer licenses taking it back", async () => {
    const store = storeOf();
    const ledger = new CreateTokenLedger(store);
    await withCreateTokenLedger(ledger, async () => {
      await recordAdoptingCreates([{ logicalId: 'A', resourceType: QUEUE, name: 'App-A' }]);
      await noteRetainedResource(QUEUE, 'A');
      await expect(recordedAdoptingCreates()).resolves.toEqual(new Map());
    });
    expect(store.current()!.sent['A']).toBeUndefined();
  });

  it('leaves a token entry of another type alone', async () => {
    const store = storeOf({
      ledgerVersion: 1,
      nonce: 'n',
      sent: { Bucket: { base: 'not-adopting', token: 't', firstSentAt: 1 } },
    });
    await withCreateTokenLedger(new CreateTokenLedger(store), () =>
      noteRetainedResource('AWS::S3::Bucket', 'Bucket')
    );
    expect(store.save).not.toHaveBeenCalled();
  });
});
