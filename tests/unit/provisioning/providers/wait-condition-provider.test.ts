import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

const watch = { interrupted: false };
vi.mock('../../../../src/provisioning/interrupt-watch.js', () => ({
  startInterruptWatch: (what: string) => ({
    isInterrupted: () => watch.interrupted,
    onInterrupted: () => Object.assign(new Error(`${what} interrupted by user (SIGINT)`), {
      name: 'InterruptedWaitError',
    }),
    dispose: vi.fn(),
  }),
}));

import { WaitConditionProvider } from '../../../../src/provisioning/providers/wait-condition-provider.js';
import type {
  WaitConditionSignal,
  WaitConditionSignalStore,
} from '../../../../src/provisioning/wait-condition-signal-store.js';
import { isMarkedNonRetryable } from '../../../../src/deployment/retryable-errors.js';
import {
  clearResolvedResourceTimeouts,
  setResolvedResourceTimeouts,
} from '../../../../src/provisioning/resource-timeout-registry.js';

const TYPE = 'AWS::CloudFormation::WaitCondition';
const BUCKET = 'cdkd-state-123456789012';
const KEY = 'wait-condition-signals/Handle-0f8fad5b-d9cb-469f-a165-70867728950e.json';
const HANDLE = `https://${BUCKET}.s3.us-east-1.amazonaws.com/${KEY}?X-Amz-Signature=abc`;

const signal = (
  status: 'SUCCESS' | 'FAILURE',
  uniqueId: string,
  data = '',
  reason = ''
): WaitConditionSignal => ({ status, uniqueId, data, reason });

/** A store whose `readSignals` answers one batch per poll (the last one repeats). */
function storeAnswering(polls: Array<WaitConditionSignal[] | Error>) {
  const seenMaps = new Set<unknown>();
  const readSignals = vi.fn(async (key: string, seen: unknown, _maxVersions?: number) => {
    expect(key).toBe(KEY);
    // One cache for the whole wait, so a poll GETs only new versions.
    seenMaps.add(seen);
    expect(seenMaps.size).toBe(1);
    const next = polls.length > 1 ? polls.shift()! : polls[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const store = {
    requireBucket: () => BUCKET,
    readSignals,
  } as unknown as WaitConditionSignalStore;
  return { store, readSignals };
}

/** The provider with a virtual clock: each sleep advances it. */
class TestProvider extends WaitConditionProvider {
  clock = 0;
  sleeps: number[] = [];
  constructor(store: WaitConditionSignalStore) {
    super(store);
    this.now = () => this.clock;
    this.sleep = async (ms: number) => {
      this.sleeps.push(ms);
      this.clock += ms;
    };
  }
}

const props = (over: Record<string, unknown> = {}) => ({
  Handle: HANDLE,
  Timeout: '600',
  ...over,
});

describe('WaitConditionProvider', () => {
  beforeEach(() => {
    watch.interrupted = false;
  });

  describe('create', () => {
    it('completes on the first SUCCESS signal and records Data', async () => {
      const { store } = storeAnswering([[], [signal('SUCCESS', 'i-1', 'ready')]]);
      const provider = new TestProvider(store);
      const result = await provider.create('Wait', TYPE, props());
      expect(result.physicalId).toMatch(/^cdkd-wait-condition-Wait-[0-9a-f-]{36}$/);
      expect(result.attributes).toEqual({ Data: '{"i-1":"ready"}' });
      expect(provider.sleeps).toEqual([2000]);
    });

    it('waits for Count distinct signals', async () => {
      const { store, readSignals } = storeAnswering([
        [signal('SUCCESS', 'a', '1')],
        [signal('SUCCESS', 'a', '1'), signal('SUCCESS', 'a', '1b')],
        [signal('SUCCESS', 'a', '1'), signal('SUCCESS', 'b', '2')],
      ]);
      const result = await new TestProvider(store).create('Wait', TYPE, props({ Count: 2 }));
      expect(result.attributes).toEqual({ Data: '{"a":"1","b":"2"}' });
      expect(readSignals).toHaveBeenCalledTimes(3);
    });

    it('accepts a numeric-string Count and a numeric Timeout', async () => {
      const { store } = storeAnswering([[signal('SUCCESS', 'a'), signal('SUCCESS', 'b')]]);
      const result = await new TestProvider(store).create(
        'Wait',
        TYPE,
        props({ Count: '2', Timeout: 60 })
      );
      expect(result.attributes).toEqual({ Data: '{"a":"","b":""}' });
    });

    it('fails, non-retryably, on a FAILURE signal and shows its reason', async () => {
      const { store } = storeAnswering([[signal('FAILURE', 'i-1', '', 'disk full\nnext line')]]);
      const error = await new TestProvider(store)
        .create('Wait', TYPE, props())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/received a FAILURE signal from i-1: disk full/);
      expect((error as Error).message).not.toContain('\n');
      expect(isMarkedNonRetryable(error as Error)).toBe(true);
    });

    it('times out after Timeout seconds, naming how many signals arrived', async () => {
      const { store } = storeAnswering([[]]);
      const provider = new TestProvider(store);
      const error = await provider.create('Wait', TYPE, props({ Timeout: '30', Count: 2 })).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/timed out after 30s with 0 of 2 SUCCESS signal/);
      expect(isMarkedNonRetryable(error as Error)).toBe(true);
      expect(provider.clock).toBe(30000);
      expect(Math.max(...provider.sleeps)).toBeLessThanOrEqual(10000);
    });

    it.each([
      ['a throttle', Object.assign(new Error('slow down'), { name: 'SlowDown' })],
      ['a 503', Object.assign(new Error('unavailable'), { $metadata: { httpStatusCode: 503 } })],
      ['a reset socket', Object.assign(new Error('socket'), { code: 'ECONNRESET' })],
      ['a version deleted mid-read', Object.assign(new Error('gone'), { name: 'NoSuchVersion' })],
    ])('keeps polling through %s', async (_what, failure) => {
      const { store, readSignals } = storeAnswering([failure, [signal('SUCCESS', 'a')]]);
      const result = await new TestProvider(store).create('Wait', TYPE, props());
      expect(result.attributes).toEqual({ Data: '{"a":""}' });
      expect(readSignals).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['access denied', 'AccessDenied'],
      ['a signal flood', 'WaitConditionSignalFlood'],
    ])('refuses at once, non-retryably, on %s', async (_what, name) => {
      const { store, readSignals } = storeAnswering([
        Object.assign(new Error('x'), { name }),
        [signal('SUCCESS', 'a')],
      ]);
      const error = await new TestProvider(store)
        .create('Wait', TYPE, props())
        .catch((e: unknown) => e);
      expect((error as Error).message).toBe(
        `WaitCondition Wait could not read its signals from the cdkd state bucket (${name}).`
      );
      expect(isMarkedNonRetryable(error as Error)).toBe(true);
      expect(readSignals).toHaveBeenCalledTimes(1);
    });

    it('bounds the versions it will read by Count', async () => {
      const { store, readSignals } = storeAnswering([[signal('SUCCESS', 'a'), signal('SUCCESS', 'b')]]);
      await new TestProvider(store).create('Wait', TYPE, props({ Count: 2 }));
      expect(readSignals.mock.calls[0]![2]).toBe(120);
    });

    it('reports the successes received when it times out', async () => {
      const { store } = storeAnswering([[signal('SUCCESS', 'a')]]);
      const error = await new TestProvider(store)
        .create('Wait', TYPE, props({ Timeout: '30', Count: 2 }))
        .catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/with 1 of 2 SUCCESS signal/);
    });

    it('stops polling at a shorter per-type --resource-timeout', async () => {
      setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 20_000 }, globalMs: 3_600_000 });
      try {
        const { store } = storeAnswering([[]]);
        const provider = new TestProvider(store);
        const error = await provider.create('Wait', TYPE, props()).catch((e: unknown) => e);
        expect((error as Error).message).toMatch(/timed out after 20s/);
        expect(provider.clock).toBe(20_000);
      } finally {
        clearResolvedResourceTimeouts();
      }
    });

    it('ignores a global --resource-timeout (the engine lifts it to the 12 h floor)', async () => {
      setResolvedResourceTimeouts({ globalMs: 10_000 });
      try {
        const { store } = storeAnswering([[]]);
        const provider = new TestProvider(store);
        await provider.create('Wait', TYPE, props({ Timeout: '30' })).catch(() => undefined);
        expect(provider.clock).toBe(30_000);
      } finally {
        clearResolvedResourceTimeouts();
      }
    });

    it('caps a FAILURE reason and omits empty fields', async () => {
      const long = 'x'.repeat(600);
      const { store } = storeAnswering([[signal('FAILURE', 'i-1', '', long)]]);
      const message = await new TestProvider(store)
        .create('Wait', TYPE, props())
        .catch((e: unknown) => (e as Error).message);
      expect(message).toBe(`WaitCondition Wait received a FAILURE signal from i-1: ${'x'.repeat(512)}...`);

      const bare = storeAnswering([[signal('FAILURE', '')]]);
      await expect(new TestProvider(bare.store).create('Wait', TYPE, props())).rejects.toThrow(
        /^WaitCondition Wait received a FAILURE signal$/
      );
    });

    it('stops on Ctrl-C', async () => {
      const { store } = storeAnswering([[]]);
      const provider = new TestProvider(store);
      provider['sleep'] = async () => {
        watch.interrupted = true;
      };
      await expect(provider.create('Wait', TYPE, props())).rejects.toThrow(/interrupted by user/);
    });

    it('refuses a handle from a cdkd that issued no URL, with the remedy', async () => {
      const { store, readSignals } = storeAnswering([[]]);
      await expect(
        new TestProvider(store).create(
          'Wait',
          TYPE,
          props({ Handle: 'cdkd-wait-condition-handle-Handle-0f8fad5b-d9cb-469f-a165-70867728950e' })
        )
      ).rejects.toThrow(/issued no signal URL\. Give the WaitConditionHandle a new logical id/);
      expect(readSignals).not.toHaveBeenCalled();
    });

    it("refuses a handle cdkd did not issue (CloudFormation's)", async () => {
      const { store, readSignals } = storeAnswering([[]]);
      await expect(
        new TestProvider(store).create(
          'Wait',
          TYPE,
          props({ Handle: 'https://cloudformation-waitcondition-us-east-1.s3.amazonaws.com/arn' })
        )
      ).rejects.toThrow(/not a signal URL cdkd issued/);
      expect(readSignals).not.toHaveBeenCalled();
    });

    it('creates the CreationPolicy form (no Handle) without polling: the engine waits on it (#6705)', async () => {
      const { store, readSignals } = storeAnswering([[]]);
      const result = await new TestProvider(store).create('Wait', TYPE, { Timeout: '600' });
      expect(result.physicalId).toMatch(/^cdkd-wait-condition-Wait-/);
      expect(result.attributes).toEqual({ Data: '{}' });
      expect(readSignals).not.toHaveBeenCalled();
    });

    it.each([
      [{ Handle: { Ref: 'X' } }, /Handle must resolve to a string/],
      [{ Timeout: undefined }, /Timeout must be a whole number/],
      [{ Timeout: '0' }, /Timeout must be a whole number/],
      [{ Timeout: '43201' }, /Timeout must be a whole number/],
      [{ Timeout: '1.5' }, /Timeout must be a whole number/],
      [{ Count: 0 }, /Count must be a whole number of at least 1/],
      [{ Count: 'two' }, /Count must be a whole number of at least 1/],
    ])('refuses malformed properties %j before reading signals', async (over, message) => {
      const { store, readSignals } = storeAnswering([[]]);
      const error = await new TestProvider(store)
        .create('Wait', TYPE, props(over))
        .catch((e: unknown) => e);
      expect((error as Error).message).toMatch(message);
      expect(isMarkedNonRetryable(error as Error)).toBe(true);
      expect(readSignals).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('keeps the recorded Data and waits for nothing when the wait is unchanged', async () => {
      const { store, readSignals } = storeAnswering([[]]);
      const result = await new TestProvider(store).update(
        'Wait',
        'cdkd-wait-condition-Wait-x',
        TYPE,
        props({ Count: 1 }),
        props({ Count: 1 })
      );
      expect(result).toEqual({ physicalId: 'cdkd-wait-condition-Wait-x', wasReplaced: false });
      expect(readSignals).not.toHaveBeenCalled();
    });

    it.each([
      ['Handle', { Handle: HANDLE }, { Handle: HANDLE.replace('Handle-', 'Handle2-') }],
      ['Count', { Count: 2 }, { Count: 1 }],
      ['Timeout', { Timeout: '600' }, { Timeout: '300' }],
    ])('waits again when %s changes', async (_what, next, prev) => {
      const { store, readSignals } = storeAnswering([
        [signal('SUCCESS', 'a'), signal('SUCCESS', 'b')],
      ]);
      const result = await new TestProvider(store).update(
        'Wait',
        'cdkd-wait-condition-Wait-x',
        TYPE,
        props({ Count: 2, ...next }),
        props({ Count: 2, ...prev })
      );
      expect(readSignals).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        physicalId: 'cdkd-wait-condition-Wait-x',
        wasReplaced: false,
        attributes: { Data: '{"a":"","b":""}' },
      });
    });

    it.each([
      ['a rollback replay', { replayingState: true }],
      ['drift --revert', { desiredFromAwsReadback: true }],
    ])('restores a recorded wait without waiting on %s', async (_what, context) => {
      const { store, readSignals } = storeAnswering([[]]);
      const result = await new TestProvider(store).update(
        'Wait',
        'cdkd-wait-condition-Wait-x',
        TYPE,
        props({ Count: 2 }),
        props({ Count: 1 }),
        context
      );
      expect(result).toEqual({ physicalId: 'cdkd-wait-condition-Wait-x', wasReplaced: false });
      expect(readSignals).not.toHaveBeenCalled();
    });
  });

  it('lifts the per-resource deadline over the 12 h maximum Timeout', () => {
    const { store } = storeAnswering([[]]);
    expect(new TestProvider(store).getMinResourceTimeoutMs()).toBeGreaterThan(43200 * 1000);
  });

  it('delete is a no-op; getAttribute refuses; nothing drifts', async () => {
    const { store } = storeAnswering([[]]);
    const provider = new TestProvider(store);
    await expect(provider.delete('Wait', 'id', TYPE)).resolves.toBeUndefined();
    await expect(provider.getAttribute('id', TYPE, 'Data', 'Wait')).rejects.toMatchObject({
      logicalId: 'Wait',
      physicalId: 'id',
    });
    await expect(provider.readCurrentState()).resolves.toEqual({});
  });

  it('import accepts only a known physical id', async () => {
    const { store } = storeAnswering([[]]);
    const provider = new TestProvider(store);
    const base = { logicalId: 'Wait', resourceType: TYPE, stackName: 'S', region: 'us-east-1', properties: {} };
    await expect(provider.import(base)).resolves.toBeNull();
    await expect(provider.import({ ...base, knownPhysicalId: 'arn:x' })).resolves.toEqual({
      physicalId: 'arn:x',
      attributes: {},
    });
  });
});
