import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeleteTriggerCommand, GetTriggerCommand, StopTriggerCommand } from '@aws-sdk/client-glue';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-glue', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-glue')>('@aws-sdk/client-glue');
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', () => {
  return {
    STSClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({ Account: '123456789012' }),
    })),
    GetCallerIdentityCommand: vi.fn(),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
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

import { GlueTriggerProvider } from '../../../src/provisioning/providers/glue-provider.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { replacedDeleteFailureVerdict } from '../../../src/deployment/rollback-executor/replaced-survivor.js';

const TYPE = 'AWS::Glue::Trigger';

function accessDenied(action: string): Error {
  const e = new Error(`User is not authorized to perform: glue:${action}`);
  e.name = 'AccessDeniedException';
  return e;
}

/**
 * Answer the delete's calls: GetTrigger answers `states` in turn (the last
 * repeats; `'denied'` throws), StopTrigger {}, DeleteTrigger AccessDenied.
 */
function answer(states: Array<string | 'denied'>, stop: () => Promise<unknown> = () => Promise.resolve({})): void {
  let reads = 0;
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetTriggerCommand) {
      const state = states[Math.min(reads++, states.length - 1)];
      if (state === 'denied') return Promise.reject(accessDenied('GetTrigger'));
      return Promise.resolve({ Trigger: { Name: 'trg', State: state } });
    }
    if (cmd instanceof StopTriggerCommand) return stop();
    if (cmd instanceof DeleteTriggerCommand) {
      return Promise.reject(accessDenied('DeleteTrigger'));
    }
    return Promise.reject(new Error(`unexpected command ${String(cmd)}`));
  });
}

async function deleteError(): Promise<unknown> {
  return new GlueTriggerProvider().delete('Trg', 'trg', TYPE).then(
    () => {
      throw new Error('delete resolved');
    },
    (error: unknown) => error
  );
}

function sent(command: abstract new (...args: never[]) => unknown): number {
  return mockSend.mock.calls.filter((c) => c[0] instanceof command).length;
}

describe('GlueTriggerProvider.delete marks a refusal after a stop (go-to-k/cdkd#4946)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks a refused DeleteTrigger once an ACTIVATED trigger was stopped', async () => {
    answer(['ACTIVATED', 'DEACTIVATED']);

    const err = await deleteError();

    expect(sent(StopTriggerCommand)).toBe(1);
    expect(sent(DeleteTriggerCommand)).toBe(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('leaves a refused DeleteTrigger of a trigger that was not ACTIVATED unmarked (kept)', async () => {
    answer(['CREATED']);

    const err = await deleteError();

    expect(sent(StopTriggerCommand)).toBe(0);
    expect(sent(DeleteTriggerCommand)).toBe(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });

  it('leaves it unmarked when AWS refused the stop by name: nothing changed (kept)', async () => {
    answer(['ACTIVATED'], () => Promise.reject(accessDenied('StopTrigger')));

    const err = await deleteError();

    expect(sent(StopTriggerCommand)).toBe(1);
    expect(sent(DeleteTriggerCommand)).toBe(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });

  it('marks it when the swallowed stop failed in a way that may have landed (unconfirmed)', async () => {
    answer(['ACTIVATED'], () => Promise.reject(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })));

    const err = await deleteError();

    expect(sent(StopTriggerCommand)).toBe(1);
    expect(sent(DeleteTriggerCommand)).toBe(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('leaves a refused DeleteTrigger unmarked when the pre-delete read was refused too (kept)', async () => {
    answer(['denied']);

    const err = await deleteError();

    expect(sent(StopTriggerCommand)).toBe(0);
    expect(sent(DeleteTriggerCommand)).toBe(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });
});
