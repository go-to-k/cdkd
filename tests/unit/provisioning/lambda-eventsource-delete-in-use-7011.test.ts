import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DeleteEventSourceMappingCommand,
  GetEventSourceMappingCommand,
  ResourceInUseException,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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
  IN_USE_POLL_INTERVAL_MS,
  IN_USE_SETTLE_BUDGET_MS,
} from '../../../src/provisioning/providers/lambda-eventsource/delete.js';

const UUID = 'abcdef12-3456-7890-abcd-ef1234567890';
const TYPE = 'AWS::Lambda::EventSourceMapping';

function inUse(): ResourceInUseException {
  return new ResourceInUseException({
    message: 'Cannot delete the event source mapping because it is in use.',
    $metadata: {},
  });
}

function sentOf(ctor: abstract new (...args: never[]) => unknown): number {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).length;
}

// go-to-k/cdkd#7011: a rollback reversing a mapping replacement deletes the
// new mapping seconds after create() returned, while it is still `Creating`.
describe('LambdaEventSourceMappingProvider.delete — a mapping still settling', () => {
  let provider: LambdaEventSourceMappingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    provider = new LambdaEventSourceMappingProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a Creating mapping to settle, then deletes it', async () => {
    // existence check, the read after the refusal, then the settle poll
    const states = ['Creating', 'Creating', 'Creating', 'Enabled'];
    let deletes = 0;
    let gets = 0;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetEventSourceMappingCommand) {
        const state = states[gets] ?? 'Enabled';
        gets++;
        return Promise.resolve({ UUID, State: state });
      }
      if (cmd instanceof DeleteEventSourceMappingCommand) {
        deletes++;
        return deletes === 1 ? Promise.reject(inUse()) : Promise.resolve({ UUID, State: 'Deleting' });
      }
      return Promise.resolve({});
    });

    const done = provider.delete('L', UUID, TYPE, undefined, { expectedRegion: 'us-east-1' });
    await vi.advanceTimersByTimeAsync(IN_USE_POLL_INTERVAL_MS * 2);
    await expect(done).resolves.toBeUndefined();

    expect(sentOf(DeleteEventSourceMappingCommand)).toBe(2);
    expect(sentOf(GetEventSourceMappingCommand)).toBe(4);
  });

  it('rethrows at once when the refused mapping is not settling', async () => {
    // Its function being torn down, say: the caller's own retry handles it,
    // exactly as before #7011.
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetEventSourceMappingCommand) {
        return Promise.resolve({ UUID, State: 'Enabled' });
      }
      if (cmd instanceof DeleteEventSourceMappingCommand) return Promise.reject(inUse());
      return Promise.resolve({});
    });

    await expect(
      provider.delete('L', UUID, TYPE, undefined, { expectedRegion: 'us-east-1' })
    ).rejects.toThrow(/Failed to delete event source mapping L/);
    expect(sentOf(DeleteEventSourceMappingCommand)).toBe(1);
    expect(sentOf(GetEventSourceMappingCommand)).toBe(2);
  });

  it('treats a mapping that vanishes while waiting as deleted', async () => {
    let gets = 0;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetEventSourceMappingCommand) {
        gets++;
        if (gets === 1) return Promise.resolve({ UUID, State: 'Creating' });
        return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
      }
      if (cmd instanceof DeleteEventSourceMappingCommand) return Promise.reject(inUse());
      return Promise.resolve({});
    });

    await expect(
      provider.delete('L', UUID, TYPE, undefined, { expectedRegion: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(sentOf(DeleteEventSourceMappingCommand)).toBe(1);
  });

  it('fails with the refusal once the settle budget is spent', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetEventSourceMappingCommand) {
        return Promise.resolve({ UUID, State: 'Creating' });
      }
      if (cmd instanceof DeleteEventSourceMappingCommand) return Promise.reject(inUse());
      return Promise.resolve({});
    });

    const done = provider.delete('L', UUID, TYPE, undefined, { expectedRegion: 'us-east-1' });
    const settled = expect(done).rejects.toThrow(/Failed to delete event source mapping L/);
    await vi.advanceTimersByTimeAsync(IN_USE_SETTLE_BUDGET_MS + IN_USE_POLL_INTERVAL_MS * 2);
    await settled;
  });

  it('does not wait on any other delete failure', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetEventSourceMappingCommand) {
        return Promise.resolve({ UUID, State: 'Enabled' });
      }
      if (cmd instanceof DeleteEventSourceMappingCommand) {
        return Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
      }
      return Promise.resolve({});
    });

    await expect(
      provider.delete('L', UUID, TYPE, undefined, { expectedRegion: 'us-east-1' })
    ).rejects.toThrow(/Failed to delete event source mapping L/);
    expect(sentOf(DeleteEventSourceMappingCommand)).toBe(1);
    expect(sentOf(GetEventSourceMappingCommand)).toBe(1);
  });
});
