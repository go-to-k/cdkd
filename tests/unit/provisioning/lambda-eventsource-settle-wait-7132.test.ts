import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateEventSourceMappingCommand,
  GetEventSourceMappingCommand,
  ResourceNotFoundException,
  UpdateEventSourceMappingCommand,
  type LambdaClient,
} from '@aws-sdk/client-lambda';

const { mockSend, debugSpy, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debugSpy: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Issue #2080: the create call goes through a dedicated `LambdaClient`.
vi.mock('@aws-sdk/client-lambda', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-lambda')>()),
  LambdaClient: vi.fn(() => ({ send: (command: unknown) => mockSend(command), config: {} })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';
import {
  waitForMappingSettled,
  MAPPING_STALE_READ_GRACE_POLLS,
} from '../../../src/provisioning/providers/lambda-eventsource/settle-wait.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import { createMaskedLogSinks } from '../../../src/provisioning/masked-retry-logger.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * go-to-k/cdkd#7132: CloudFormation completes an event source mapping's
 * create / update only once it leaves `Creating` / `Updating`; cdkd returned
 * while it was still settling (#5737 fixed only the baseline read).
 */

const TYPE = 'AWS::Lambda::EventSourceMapping';
const UUID = '11111111-2222-3333-4444-555555555555';
const ARN = `arn:aws:lambda:us-east-1:123456789012:event-source-mapping:${UUID}`;
const PROPS = {
  FunctionName: 'fn',
  EventSourceArn: 'arn:aws:sqs:us-east-1:123456789012:q',
};

/** Route the provider's calls; `states` answers the successive Get reads. */
function route(states: Array<string | { State: string; StateTransitionReason: string }>): void {
  const queue = [...states];
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof GetEventSourceMappingCommand) {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return typeof next === 'string' ? { UUID, State: next } : { UUID, ...next };
    }
    return { UUID, EventSourceMappingArn: ARN };
  });
}

const sentNames = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);

describe('event source mapping settle wait (#7132)', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    mockSend.mockReset();
    debugSpy.mockReset();
    warnSpy.mockReset();
    provider = new LambdaEventSourceMappingProvider();
  });

  it('create() returns only after the mapping leaves Creating', async () => {
    route(['Creating', 'Enabled']);
    const result = await provider.create('M', TYPE, PROPS);
    expect(result.physicalId).toBe(UUID);
    expect(sentNames()).toEqual([
      'CreateEventSourceMappingCommand',
      'GetEventSourceMappingCommand',
      'GetEventSourceMappingCommand',
    ]);
    expect((mockSend.mock.calls[1]![0] as GetEventSourceMappingCommand).input).toEqual({
      UUID,
    });
  });

  it('--no-wait (CDKD_NO_WAIT=true) skips the create and update waits', async () => {
    vi.stubEnv('CDKD_NO_WAIT', 'true');
    try {
      route(['Creating']);
      await provider.create('M', TYPE, PROPS);
      await provider.update('M', UUID, TYPE, { ...PROPS, BatchSize: 5 }, { ...PROPS, BatchSize: 10 });
      expect(sentNames().filter((n) => n === 'GetEventSourceMappingCommand')).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('create() with Enabled: false waits for Disabled', async () => {
    route(['Disabled']);
    await provider.create('M', TYPE, { ...PROPS, Enabled: false });
    expect(sentNames()).toEqual([
      'CreateEventSourceMappingCommand',
      'GetEventSourceMappingCommand',
    ]);
  });

  it('a create that settles Disabled where Enabled was asked warns and returns (unmeasured against CloudFormation)', async () => {
    route([
      {
        State: 'Disabled',
        StateTransitionReason: 'PROBLEM: role arn:aws:iam::123456789012:role/r denied',
      },
    ]);
    const result = await provider.create('M', TYPE, PROPS);
    expect(result.physicalId).toBe(UUID);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('settled Disabled, but the template asks for Enabled')
    );
    expect(warnSpy.mock.calls.flat().join('\n')).not.toContain('role/r');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('role/r denied'));
    // A create has no earlier state to read back: no stale-read grace.
    expect(sentNames().filter((n) => n === 'GetEventSourceMappingCommand')).toHaveLength(1);
  });

  it('a create whose mapping reads Deleting fails, names the mapping it created, and is not retried', async () => {
    route(['Deleting']);
    const error = await provider.create('M', TYPE, PROPS).then(
      () => new Error('expected the create to fail'),
      (e: unknown) => e
    );
    expect(String(error)).toContain('settled as Deleting');
    // The mapping exists: the failed-CREATE journal names it for
    // --revert-failed, and no retry creates a second one beside it.
    expect(createdBeforeFailure(error, 'M', TYPE)).toBe(UUID);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof CreateEventSourceMappingCommand)
    ).toHaveLength(1);
    expect(sentNames().filter((n) => n === 'GetEventSourceMappingCommand')).toHaveLength(1);
  });

  it('a create whose mapping is not yet visible reads again within the grace', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      mockSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof GetEventSourceMappingCommand) {
          reads++;
          if (reads === 1) {
            throw new ResourceNotFoundException({ message: 'not found', $metadata: {} });
          }
          return { UUID, State: reads === 2 ? 'Creating' : 'Enabled' };
        }
        return { UUID, EventSourceMappingArn: ARN };
      });
      const p = provider.create('M', TYPE, PROPS);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await p).physicalId).toBe(UUID);
      expect(reads).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('update() does not end on a stale first read when the call answered Updating', async () => {
    vi.useFakeTimers();
    try {
      const states = ['Enabled', 'Updating', 'Enabled'];
      mockSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof GetEventSourceMappingCommand) return { UUID, State: states.shift() ?? 'Enabled' };
        if (cmd instanceof UpdateEventSourceMappingCommand) {
          return { UUID, EventSourceMappingArn: ARN, State: 'Updating' };
        }
        return {};
      });
      const p = provider.update('M', UUID, TYPE, { ...PROPS, BatchSize: 5 }, { ...PROPS, BatchSize: 10 });
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
      expect(sentNames().filter((n) => n === 'GetEventSourceMappingCommand')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('update() returns only after the mapping leaves Updating', async () => {
    route(['Updating', 'Enabled']);
    await provider.update('M', UUID, TYPE, { ...PROPS, BatchSize: 5 }, { ...PROPS, BatchSize: 10 });
    const names = sentNames();
    const at = names.indexOf('UpdateEventSourceMappingCommand');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(names.slice(at + 1, at + 3)).toEqual([
      'GetEventSourceMappingCommand',
      'GetEventSourceMappingCommand',
    ]);
  });

  it('update() that sends no Enabled accepts a mapping that stays Disabled', async () => {
    route(['Disabled']);
    await provider.update('M', UUID, TYPE, { ...PROPS, BatchSize: 5 }, { ...PROPS, BatchSize: 10 });
    const update = mockSend.mock.calls.find((c) => c[0] instanceof UpdateEventSourceMappingCommand);
    expect((update![0] as UpdateEventSourceMappingCommand).input.Enabled).toBeUndefined();
  });

  it('update() that sends Enabled: false reads a stale Enabled through the grace, then returns on Disabled', async () => {
    vi.useFakeTimers();
    try {
      route([...Array<string>(MAPPING_STALE_READ_GRACE_POLLS).fill('Enabled'), 'Disabled']);
      const p = provider.update('M', UUID, TYPE, { ...PROPS, Enabled: false }, PROPS);
      await vi.advanceTimersByTimeAsync(60_000);
      await p;
      expect(sentNames().filter((n) => n === 'GetEventSourceMappingCommand')).toHaveLength(
        MAPPING_STALE_READ_GRACE_POLLS + 1
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('update() that sends Enabled: true warns when the mapping stays Disabled past the grace', async () => {
    vi.useFakeTimers();
    try {
      route(['Disabled']);
      const p = provider.update(
        'M',
        UUID,
        TYPE,
        { ...PROPS, Enabled: true },
        { ...PROPS, Enabled: false }
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await p;
      expect(sentNames().filter((n) => n === 'GetEventSourceMappingCommand')).toHaveLength(
        MAPPING_STALE_READ_GRACE_POLLS + 1
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('settled Disabled, but the template asks for Enabled')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('update() that sends Enabled: false waits for Disabled', async () => {
    route(['Disabling', 'Disabled']);
    await provider.update('M', UUID, TYPE, { ...PROPS, Enabled: false }, PROPS);
    expect(sentNames().filter((n) => n === 'GetEventSourceMappingCommand')).toHaveLength(2);
  });
});

describe('waitForMappingSettled (#7132)', () => {
  it('reads again after a throttled read', async () => {
    send
      .mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'), { name: 'TooManyRequestsException', $metadata: { httpStatusCode: 429 } }))
      .mockResolvedValueOnce({ State: 'Enabled' });
    await waitForMappingSettled(client, 'M', UUID, true, log, opts);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('throws its own not-confirmed error once the resource deadline has expired', async () => {
    send.mockResolvedValue({ State: 'Creating' });
    const error = await withResourceDeadline(
      () => waitForMappingSettled(client, 'M', UUID, true, log, { pollMs: 60_000 }),
      { warnAfterMs: 20, timeoutMs: 40, onTimeout: () => new Error('resource deadline fired') }
    ).then(
      () => new Error('expected the wait to fail'),
      (e: unknown) => e
    );
    expect(String(error)).toMatch(/resource deadline fired|not confirmed/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stops on Ctrl-C with the interrupt error, without another read', async () => {
    const baseline = process.listeners('SIGINT');
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    interruptWatchTestSeam.forceQuit = vi.fn();
    try {
      send.mockImplementation(async () => {
        for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
          (l as unknown as () => void)();
        }
        return { State: 'Creating' };
      });
      const error = await waitForMappingSettled(client, 'M', UUID, true, log, opts).then(
        () => new Error('expected the wait to fail'),
        (e: unknown) => e
      );
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
      delete interruptWatchTestSeam.forceQuit;
    }
  });

  const send = vi.fn();
  const client = { send } as unknown as LambdaClient;
  const log = createMaskedLogSinks({ debug: vi.fn(), warn: vi.fn() }, undefined);
  const opts = { pollMs: 0 };

  beforeEach(() => send.mockReset());

  it('reads the opposite settled state as stale for the grace polls, then warns and returns', async () => {
    for (let i = 0; i < MAPPING_STALE_READ_GRACE_POLLS; i++) {
      send.mockResolvedValueOnce({ State: 'Enabled' });
    }
    send.mockResolvedValueOnce({ State: 'Disabled' });
    await waitForMappingSettled(client, 'M', UUID, false, log, opts);
    send.mockReset();
    send.mockResolvedValue({ State: 'Enabled' });
    await waitForMappingSettled(client, 'M', UUID, false, log, opts);
    expect(send).toHaveBeenCalledTimes(MAPPING_STALE_READ_GRACE_POLLS + 1);
  });

  it('fails on a ResourceNotFoundException past the not-visible grace', async () => {
    const gone = new ResourceNotFoundException({ message: 'gone', $metadata: {} });
    send.mockRejectedValueOnce(gone).mockRejectedValueOnce(gone).mockRejectedValueOnce(gone);
    let caught: unknown;
    try {
      await waitForMappingSettled(client, 'M', UUID, true, log, { ...opts, notFoundGracePolls: 2 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(gone);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('fails at once on Deleting', async () => {
    send.mockResolvedValue({ State: 'Deleting' });
    await expect(waitForMappingSettled(client, 'M', UUID, true, log, opts)).rejects.toThrow(
      'settled as Deleting'
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('throws a non-retryable not-confirmed error when its poll cap runs out', async () => {
    send.mockResolvedValue({ State: 'Creating' });
    const error = await waitForMappingSettled(client, 'M', UUID, true, log, {
      ...opts,
      maxPolls: 3,
    }).then(
      () => {
        throw new Error('expected the wait to fail');
      },
      (e: unknown) => e
    );
    expect(String(error)).toMatch(/still Creating .*not confirmed/);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
