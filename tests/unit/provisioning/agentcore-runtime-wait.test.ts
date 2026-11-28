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
    child: vi.fn(function (this: unknown) { return this; }),
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
import { attributesAfterUpdate } from '../../../src/deployment/recorded-identity-attributes.js';
import {
  InterruptedWaitError,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

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
function answer(
  statuses: (string | Error)[],
  extra: Record<string, unknown> = {},
  afterDelete: string[] = []
): void {
  const queue = [...statuses];
  // go-to-k/cdkd#7132: after the delete, GetAgentRuntime answers
  // `afterDelete` in turn, then not-found.
  let deleted = false;
  const deleting = [...afterDelete];
  mockSend.mockImplementation(async (cmd: object) => {
    switch (cmd.constructor.name) {
      case 'CreateAgentRuntimeCommand':
        return { agentRuntimeId: ID, agentRuntimeArn: ARN, status: 'CREATING' };
      case 'UpdateAgentRuntimeCommand':
        return { agentRuntimeId: ID, agentRuntimeArn: ARN, status: 'UPDATING' };
      case 'DeleteAgentRuntimeCommand':
        deleted = true;
        return { agentRuntimeId: ID, status: 'DELETING' };
      case 'GetAgentRuntimeCommand': {
        if (deleted) {
          const status = deleting.shift();
          if (status === undefined) {
            throw new ResourceNotFoundException({ $metadata: {}, message: 'gone' });
          }
          return { agentRuntimeId: ID, agentRuntimeArn: ARN, status };
        }
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
      // Retired by the create's catch (go-to-k/cdkd#2169): nothing to journal.
      expect(sent().at(-1)).toBe('DeleteAgentRuntimeCommand');
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBeUndefined();
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
      // Retired by the create's catch (go-to-k/cdkd#2169): nothing to journal.
      expect(sent().at(-1)).toBe('DeleteAgentRuntimeCommand');
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBeUndefined();
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

  describe('retiring a runtime the failing create made (go-to-k/cdkd#2169)', () => {
    it('deletes the runtime by the id CreateAgentRuntime returned and re-throws the original failure', async () => {
      answer(['CREATE_FAILED']);
      const error = await provider.create('Rt', TYPE, PROPS).catch((e: unknown) => e);
      expect(sent()).toEqual([
        'CreateAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'DeleteAgentRuntimeCommand',
      ]);
      expect(mockSend.mock.calls[2]![0].input).toEqual({ agentRuntimeId: ID });
      expect((error as Error).message).toBe(
        `BedrockAgentCore Runtime Rt (${ID}) entered CREATE_FAILED during create; its failureReason (GetAgentRuntime) says why`
      );
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('appends the survivor and its delete command when the retire fails, and journals it', async () => {
      answer(['CREATE_FAILED']);
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(async (cmd: object) => {
        if (cmd.constructor.name === 'DeleteAgentRuntimeCommand') {
          throw Object.assign(new Error('busy'), { name: 'ConflictException', $metadata: {} });
        }
        return inner(cmd);
      });
      const error = await provider.create('Rt', TYPE, PROPS).catch((e: unknown) => e);
      const message = (error as Error).message;
      expect(message).toMatch(/^BedrockAgentCore Runtime Rt \(.*\) entered CREATE_FAILED during create/);
      expect(message).toContain(`The runtime ${ID} it created could not be deleted`);
      expect(message).toContain(
        `aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id ${ID} --region us-east-1`
      );
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBe(ID);
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('appends the survivor to a wrapped AWS failure too', async () => {
      const tagFailure = Object.assign(new Error('nope'), { name: 'ValidationException', $metadata: {} });
      mockSend.mockImplementation(async (cmd: object) => {
        switch (cmd.constructor.name) {
          case 'CreateAgentRuntimeCommand':
            return { agentRuntimeId: ID, agentRuntimeArn: ARN, status: 'CREATING' };
          case 'GetAgentRuntimeCommand':
            return { status: 'READY' };
          case 'ListTagsForResourceCommand':
            return { tags: {} };
          case 'TagResourceCommand':
            throw tagFailure;
          default:
            throw Object.assign(new Error('busy'), { name: 'ConflictException', $metadata: {} });
        }
      });
      const error = await provider
        .create('Rt', TYPE, { ...PROPS, Tags: { A: '1' } })
        .catch((e: unknown) => e);
      const message = (error as Error).message;
      expect(message).toMatch(/^Failed to create BedrockAgentCore Runtime Rt: /);
      expect(message).toContain(`The runtime ${ID} it created could not be deleted`);
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBe(ID);
      // A replayed create could only meet the survivor under its name.
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('counts a not-found answer to the retire as gone', async () => {
      answer(['CREATE_FAILED']);
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(async (cmd: object) => {
        if (cmd.constructor.name === 'DeleteAgentRuntimeCommand') {
          throw new ResourceNotFoundException({ $metadata: {}, message: 'gone' });
        }
        return inner(cmd);
      });
      const error = await provider.create('Rt', TYPE, PROPS).catch((e: unknown) => e);
      expect((error as Error).message).not.toContain('could not be deleted');
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBeUndefined();
    });

    it('deletes nothing under a declared ClientToken, which may have returned an existing runtime, and journals it', async () => {
      answer(['CREATE_FAILED']);
      const error = await provider
        .create('Rt', TYPE, { ...PROPS, ClientToken: 'token-1234567890-abcdefghijklmnop' })
        .catch((e: unknown) => e);
      expect(sent()).not.toContain('DeleteAgentRuntimeCommand');
      const message = (error as Error).message;
      expect(message).toMatch(/^BedrockAgentCore Runtime Rt \(.*\) entered CREATE_FAILED during create/);
      expect(message).toContain('AWS may have returned an existing runtime');
      expect(message).toContain(
        `aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id ${ID} --region us-east-1`
      );
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBe(ID);
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('deletes nothing on an interrupt, leaving the journaled runtime to cdkd rollback', async () => {
      answer(['CREATING']);
      const interrupted = new InterruptedWaitError('BedrockAgentCore Runtime Rt create wait');
      (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {
        throw interrupted;
      };
      const error = await provider.create('Rt', TYPE, PROPS).catch((e: unknown) => e);
      expect(sent()).not.toContain('DeleteAgentRuntimeCommand');
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBe(ID);
    });

    it('fails non-retryably once the runtime is retired, since it may still be DELETING', async () => {
      const tagFailure = Object.assign(new Error('nope'), { name: 'ValidationException', $metadata: {} });
      mockSend.mockImplementation(async (cmd: object) => {
        switch (cmd.constructor.name) {
          case 'CreateAgentRuntimeCommand':
            return { agentRuntimeId: ID, agentRuntimeArn: ARN, status: 'CREATING' };
          case 'GetAgentRuntimeCommand':
            return { status: 'READY' };
          case 'ListTagsForResourceCommand':
            return { tags: {} };
          case 'TagResourceCommand':
            throw tagFailure;
          default:
            return { status: 'DELETING' };
        }
      });
      const error = await provider
        .create('Rt', TYPE, { ...PROPS, Tags: { A: '1' } })
        .catch((e: unknown) => e);
      expect(sent().at(-1)).toBe('DeleteAgentRuntimeCommand');
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBeUndefined();
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('deletes nothing when CreateAgentRuntime itself fails', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('bad'), { name: 'ValidationException', $metadata: {} })
      );
      const error = await provider.create('Rt', TYPE, PROPS).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(sent()).toEqual(['CreateAgentRuntimeCommand']);
      expect(createdBeforeFailure(error, 'Rt', TYPE)).toBeUndefined();
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
        'GetAgentRuntimeCommand',
      ]);
      expect(sleeps).toEqual([RUNTIME_WAIT_POLL_MS, RUNTIME_WAIT_POLL_MS]);
    });

    it('deletes at once when the runtime is settled', async () => {
      answer(['READY']);
      await provider.delete('Rt', ID, TYPE);
      expect(sent()).toEqual([
        'GetAgentRuntimeCommand',
        'DeleteAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
      ]);
      expect(sleeps).toEqual([]);
    });

    it('still deletes when the pre-delete read fails', async () => {
      answer([new Error('AccessDeniedException')]);
      await provider.delete('Rt', ID, TYPE);
      expect(sent()).toEqual([
        'GetAgentRuntimeCommand',
        'DeleteAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
      ]);
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
        RUNTIME_WAIT_MAX_POLLS + 1
      );
      expect(sent().at(-2)).toBe('DeleteAgentRuntimeCommand');
    });

    it('waits before a delete under --no-wait too', async () => {
      vi.stubEnv('CDKD_NO_WAIT', 'true');
      answer(['CREATING', 'READY']);
      await provider.delete('Rt', ID, TYPE);
      expect(sent()).toEqual([
        'GetAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'DeleteAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
      ]);
    });

    it('waits after the delete until the runtime is gone, which holds its name while DELETING (go-to-k/cdkd#7132)', async () => {
      answer(['READY'], {}, ['DELETING', 'DELETING']);
      await provider.delete('Rt', ID, TYPE);
      expect(sent()).toEqual([
        'GetAgentRuntimeCommand',
        'DeleteAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
      ]);
      expect(sleeps).toEqual([RUNTIME_WAIT_POLL_MS, RUNTIME_WAIT_POLL_MS]);
    });

    it('waits after the delete under --no-wait too (go-to-k/cdkd#7132)', async () => {
      vi.stubEnv('CDKD_NO_WAIT', 'true');
      answer(['READY'], {}, ['DELETING']);
      await provider.delete('Rt', ID, TYPE);
      expect(sent().slice(1)).toEqual([
        'DeleteAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
        'GetAgentRuntimeCommand',
      ]);
    });
  });
});

describe('AgentCoreRuntimeProvider records LastUpdatedAt from the READY read (go-to-k/cdkd#7009)', () => {
  // Measured: CreateAgentRuntime answers no lastUpdatedAt; UpdateAgentRuntime
  // answers one that moves again by the time GetAgentRuntime reads READY.
  const CREATED = new Date('2026-11-26T01:07:02.146Z');
  const READY_AFTER_CREATE = new Date('2026-11-26T01:07:10.272Z');
  const UPDATE_ANSWER = new Date('2026-11-26T01:07:20.456Z');
  const READY_AFTER_UPDATE = new Date('2026-11-26T01:07:24.437Z');
  let readyAt = READY_AFTER_CREATE;

  beforeEach(() => {
    mockSend.mockReset();
    readyAt = READY_AFTER_CREATE;
    mockSend.mockImplementation(async (cmd: object) => {
      switch (cmd.constructor.name) {
        case 'CreateAgentRuntimeCommand':
          return { agentRuntimeId: ID, agentRuntimeArn: ARN, status: 'CREATING', createdAt: CREATED };
        case 'UpdateAgentRuntimeCommand':
          readyAt = READY_AFTER_UPDATE;
          return {
            agentRuntimeId: ID,
            agentRuntimeArn: ARN,
            status: 'UPDATING',
            createdAt: CREATED,
            lastUpdatedAt: UPDATE_ANSWER,
          };
        case 'GetAgentRuntimeCommand':
          return { agentRuntimeId: ID, agentRuntimeArn: ARN, status: 'READY', createdAt: CREATED, lastUpdatedAt: readyAt };
        default:
          throw new Error(`unexpected command ${cmd.constructor.name}`);
      }
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('create records the READY read, and an in-place update moves it to its own READY read', async () => {
    const provider = new AgentCoreRuntimeProvider();
    const created = await provider.create('Rt', TYPE, PROPS);
    expect(created.attributes?.['LastUpdatedAt']).toBe(READY_AFTER_CREATE.toISOString());
    const updated = await provider.update('Rt', created.physicalId, TYPE, UPDATE_PROPS, PROPS);
    const recorded = attributesAfterUpdate(TYPE, created.attributes, updated);
    expect(Object.keys(recorded ?? {}).sort()).toEqual(Object.keys(created.attributes ?? {}).sort());
    expect(recorded?.['LastUpdatedAt']).toBe(READY_AFTER_UPDATE.toISOString());
    expect(recorded?.['CreatedAt']).toBe(CREATED.toISOString());
  });

  it('under --no-wait an update records no LastUpdatedAt: its own answer moves by READY', async () => {
    const provider = new AgentCoreRuntimeProvider();
    const created = await provider.create('Rt', TYPE, PROPS);
    expect(created.attributes?.['LastUpdatedAt']).toBe(READY_AFTER_CREATE.toISOString());
    vi.stubEnv('CDKD_NO_WAIT', 'true');
    const updated = await provider.update('Rt', created.physicalId, TYPE, UPDATE_PROPS, PROPS);
    const recorded = attributesAfterUpdate(TYPE, created.attributes, updated);
    // The create-recorded value predates this update: dropped, not kept. The
    // deferred readiness re-read fills the key the record lacks (#6940).
    expect(recorded).not.toHaveProperty('LastUpdatedAt');
    expect(recorded?.['CreatedAt']).toBe(CREATED.toISOString());
  });

  it('import records LastUpdatedAt, the same key set as a READY create', async () => {
    const provider = new AgentCoreRuntimeProvider();
    const created = await provider.create('Rt', TYPE, PROPS);
    const imported = await provider.import({
      logicalId: 'Rt',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: PROPS,
      knownPhysicalId: ID,
    });
    expect(imported?.attributes?.['LastUpdatedAt']).toBe(READY_AFTER_CREATE.toISOString());
    const createdKeys = Object.keys(created.attributes ?? {}).filter((k) => k !== 'AgentRuntimeName');
    expect(Object.keys(imported?.attributes ?? {})).toEqual(expect.arrayContaining(createdKeys));
  });
});
