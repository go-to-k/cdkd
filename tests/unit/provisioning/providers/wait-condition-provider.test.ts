import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => child, ...child }) };
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
  const readSignals = vi.fn(async (key: string) => {
    expect(key).toBe(KEY);
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

    it('keeps polling through a failed read until the deadline', async () => {
      const { store, readSignals } = storeAnswering([
        Object.assign(new Error('slow down'), { name: 'SlowDown' }),
        [signal('SUCCESS', 'a')],
      ]);
      const result = await new TestProvider(store).create('Wait', TYPE, props());
      expect(result.attributes).toEqual({ Data: '{"a":""}' });
      expect(readSignals).toHaveBeenCalledTimes(2);
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

    it.each([
      [{ Handle: undefined }, /has no Handle.*CreationPolicy/],
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

    it('waits again when Handle, Count or Timeout changes', async () => {
      const { store } = storeAnswering([[signal('SUCCESS', 'a'), signal('SUCCESS', 'b')]]);
      const result = await new TestProvider(store).update(
        'Wait',
        'cdkd-wait-condition-Wait-x',
        TYPE,
        props({ Count: 2 }),
        props({ Count: 1 })
      );
      expect(result).toEqual({
        physicalId: 'cdkd-wait-condition-Wait-x',
        wasReplaced: false,
        attributes: { Data: '{"a":"","b":""}' },
      });
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
