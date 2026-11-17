/**
 * The AgentCore Runtime status waits (go-to-k/cdkd#6490): create and update
 * wait for READY unless `--no-wait`, and a delete first waits out a runtime
 * still CREATING / UPDATING.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { ResourceNotFoundException } from '@aws-sdk/client-bedrock-agentcore-control';

const mockSend = vi.fn();
const debug = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    bedrockAgentCoreControl: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: (...args: unknown[]) => debug(...args),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
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

import { AgentCoreRuntimeProvider } from '../../../src/provisioning/providers/agentcore-runtime-provider.js';
import {
  RUNTIME_WAIT_MAX_POLLS,
  RUNTIME_WAIT_POLL_MS,
} from '../../../src/provisioning/providers/agentcore-runtime/wait.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::BedrockAgentCore::Runtime';
const ID = 'rt_one-AbCdEf1234';
const ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${ID}`;
const PROPS = { AgentRuntimeName: 'rt_one', RoleArn: 'arn:aws:iam::123456789012:role/r' };
const UPDATE_PROPS = { ...PROPS, Description: 'b' };

/** The class names of the commands sent, in order. */
function sent(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
}

/** Answers each command by its class; GetAgentRuntime from `statuses` in turn. */
function answer(statuses: (string | Error)[], extra: Record<string, unknown> = {}): void {
  const queue = [...statuses];
  mockSend.mockImplementation(async (cmd: object) => {
    switch (cmd.constructor.name) {
      case 'CreateAgentRuntimeCommand':
        return { agentRuntimeId: ID, agentRuntimeArn: ARN, status: 'CREATING' };
      case 'UpdateAgentRuntimeCommand':
        return { agentRuntimeId: ID, agentRuntimeArn: ARN, status: 'UPDATING' };
      case 'DeleteAgentRuntimeCommand':
        return { agentRuntimeId: ID, status: 'DELETING' };
      case 'GetAgentRuntimeCommand': {
        const next = queue.length > 1 ? queue.shift()! : queue[0]!;
        if (next instanceof Error) throw next;
        return { agentRuntimeId: ID, agentRuntimeArn: ARN, status: next, ...extra };
      }
      default:
        throw new Error(`unexpected command ${cmd.constructor.name}`);
    }
  });
}

describe('AgentCoreRuntimeProvider status waits (go-to-k/cdkd#6490)', () => {
  let provider: AgentCoreRuntimeProvider;
  let sleeps: number[];

  beforeEach(() => {
    mockSend.mockReset();
    debug.mockReset();
    provider = new AgentCoreRuntimeProvider();
    sleeps = [];
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
      sleeps.push(ms);
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('create', () => {
    it('polls GetAgentRuntime until READY and records READY', async () => {
      answer(['CREATING', 'CREATING', 'READY']);
      const result = await provider.create('Rt', TYPE, PROPS);
      expect(sent()).toEqual([
        'CreateAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
      ]);
      expect(mockSend.mock.calls[1]![0].input).toEqual({ agentRuntimeId: ID });
      expect(sleeps).toEqual([RUNTIME_WAIT_POLL_MS, RUNTIME_WAIT_POLL_MS]);
      expect(result.physicalId).toBe(ID);
      expect(result.attributes?.['Status']).toBe('READY');
    });

    it('skips the wait under --no-wait and records the create status', async () => {
      vi.stubEnv('CDKD_NO_WAIT', 'true');
      answer(['READY']);
      const result = await provider.create('Rt', TYPE, PROPS);
      expect(sent()).toEqual(['CreateAgentRuntimeCommand']);
      expect(result.attributes?.['Status']).toBe('CREATING');
    });

    it('fails non-retryably on CREATE_FAILED, naming the created runtime, with failureReason only in debug', async () => {
      answer(['CREATING', 'CREATE_FAILED'], { failureReason: 'secret-ish reason text' });
      const error = await provider.create('Rt', TYPE, PROPS).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('CREATE_FAILED');
      expect((error as Error).message).not.toContain('secret-ish reason text');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBe(ID);
      expect(debug.mock.calls.some(([m]) => String(m).includes('secret-ish reason text'))).toBe(true);
      expect(sent().filter((c) => c === 'CreateAgentRuntimeCommand')).toHaveLength(1);
    });

    it('masks the failureReason it logs', async () => {
      answer(['CREATE_FAILED'], { failureReason: 'uses hunter2' });
      await provider
        .create('Rt', TYPE, PROPS, { maskSecrets: (t) => t.replaceAll('hunter2', '***') })
        .catch(() => undefined);
      const lines = debug.mock.calls.map(([m]) => String(m)).join('\n');
      expect(lines).toContain('uses ***');
      expect(lines).not.toContain('hunter2');
    });

    it('polls on through a transient status-read failure', async () => {
      const throttle = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
      answer(['CREATING', throttle, 'READY']);
      const result = await provider.create('Rt', TYPE, PROPS);
      expect(result.attributes?.['Status']).toBe('READY');
      expect(sent().filter((c) => c === 'GetAgentRuntimeCommand')).toHaveLength(3);
      expect(sent().filter((c) => c === 'CreateAgentRuntimeCommand')).toHaveLength(1);
    });

    it('fails non-retryably, keeping the AWS error as the cause, on a non-transient status-read failure', async () => {
      const denied = Object.assign(new Error('not allowed'), { name: 'AccessDeniedException' });
      answer([denied]);
      const error = await provider.create('Rt', TYPE, PROPS).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/could not be read while cdkd waited for READY/);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect((error as Error).cause).toBe(denied);
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBe(ID);
    });

    it('throws the wait failure as it is, not wrapped into a doubled message', async () => {
      answer(['CREATE_FAILED']);
      const error = await provider.create('Rt', TYPE, PROPS).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/^BedrockAgentCore Runtime Rt \(/);
      expect((error as Error).message).not.toContain('Failed to create');
    });

    it('fails on a status other than READY or in flight', async () => {
      answer(['DELETING']);
      await expect(provider.create('Rt', TYPE, PROPS)).rejects.toThrow(/reported status DELETING/);
    });

    it(`gives up after ${RUNTIME_WAIT_MAX_POLLS} reads of a runtime still in flight`, async () => {
      answer(['CREATING']);
      const error = await provider.create('Rt', TYPE, PROPS).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/was still CREATING .*--no-wait/);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(sent().filter((c) => c === 'GetAgentRuntimeCommand')).toHaveLength(
        RUNTIME_WAIT_MAX_POLLS
      );
    });
  });

  describe('update', () => {
    it('polls GetAgentRuntime until READY and records READY', async () => {
      answer(['UPDATING', 'READY']);
      const result = await provider.update('Rt', ID, TYPE, UPDATE_PROPS, PROPS);
      expect(sent()).toEqual([
        'UpdateAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
      ]);
      expect(result.physicalId).toBe(ID);
      expect(result.attributes?.['Status']).toBe('READY');
    });

    it('skips the wait under --no-wait', async () => {
      vi.stubEnv('CDKD_NO_WAIT', 'true');
      answer(['READY']);
      const result = await provider.update('Rt', ID, TYPE, UPDATE_PROPS, PROPS);
      expect(sent()).toEqual(['UpdateAgentRuntimeCommand']);
      expect(result.attributes?.['Status']).toBe('UPDATING');
    });

    it('fails non-retryably on UPDATE_FAILED', async () => {
      answer(['UPDATING', 'UPDATE_FAILED']);
      const error = await provider
        .update('Rt', ID, TYPE, UPDATE_PROPS, PROPS)
        .catch((e: unknown) => e);
      expect((error as Error).message).toContain('UPDATE_FAILED');
      expect(isMarkedNonRetryable(error)).toBe(true);
    });
  });

  describe('delete', () => {
    it('waits out a runtime still in flight, then deletes', async () => {
      answer(['UPDATING', 'CREATING', 'READY']);
      await provider.delete('Rt', ID, TYPE);
      expect(sent()).toEqual([
        'GetAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'DeleteAgentRuntimeCommand',
      ]);
      expect(sleeps).toEqual([RUNTIME_WAIT_POLL_MS, RUNTIME_WAIT_POLL_MS]);
    });

    it('deletes at once when the runtime is settled', async () => {
      answer(['READY']);
      await provider.delete('Rt', ID, TYPE);
      expect(sent()).toEqual(['GetAgentRuntimeCommand', 'DeleteAgentRuntimeCommand']);
      expect(sleeps).toEqual([]);
    });

    it('still deletes when the pre-delete read fails', async () => {
      answer([new Error('AccessDeniedException')]);
      await provider.delete('Rt', ID, TYPE);
      expect(sent()).toEqual(['GetAgentRuntimeCommand', 'DeleteAgentRuntimeCommand']);
    });

    it('reaches the delete not-found arm when the read answers not-found', async () => {
      answer([new ResourceNotFoundException({ $metadata: {}, message: 'gone' })]);
      mockSend.mockImplementation(async () => {
        throw new ResourceNotFoundException({ $metadata: {}, message: 'gone' });
      });
      await provider.delete('Rt', ID, TYPE);
      expect(sent()).toEqual(['GetAgentRuntimeCommand', 'DeleteAgentRuntimeCommand']);
    });

    it(`deletes anyway after ${RUNTIME_WAIT_MAX_POLLS} reads of a runtime still in flight`, async () => {
      answer(['CREATING']);
      await provider.delete('Rt', ID, TYPE);
      expect(sent().filter((c) => c === 'GetAgentRuntimeCommand')).toHaveLength(
        RUNTIME_WAIT_MAX_POLLS
      );
      expect(sent().at(-1)).toBe('DeleteAgentRuntimeCommand');
    });

    it('waits before a delete under --no-wait too', async () => {
      vi.stubEnv('CDKD_NO_WAIT', 'true');
      answer(['CREATING', 'READY']);
      await provider.delete('Rt', ID, TYPE);
      expect(sent()).toEqual([
        'GetAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'DeleteAgentRuntimeCommand',
      ]);
    });
  });
});
