/**
 * go-to-k/cdkd#6843: a rollback revert that Cloud Control failed only because
 * the resource had not settled from the forward update is re-sent after a
 * wait.
 *
 * Measured on `AWS::RedshiftServerless::Namespace`: a password change keeps
 * the namespace `MODIFYING` for minutes, and the automatic rollback's revert,
 * sent right after the forward update, ended `NotStabilized` ("Exceeded
 * attempts to wait") with no `UpdateNamespace` call, or `ResourceConflict`
 * ("There is an operation running on the namespace").
 *
 * `withRetry` is the REAL implementation; only its `sleep` is recorded, so the
 * outer loop's schedule is observable.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  isUnsettledUpdateFailure,
  updateWithRollbackRetry,
} from '../../../src/deployment/rollback-executor/replay-retry.js';
import {
  CloudControlOperationFailedError,
  CloudControlWaitAbandonedError,
} from '../../../src/provisioning/cloud-control/shared.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { markNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

type RetryCallRecord = { outer: boolean; delays: number[] };
const { retryCalls } = vi.hoisted(() => ({ retryCalls: [] as RetryCallRecord[] }));

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return {
    ...actual,
    withRetry: (
      operation: () => Promise<unknown>,
      logicalId: string,
      opts: Record<string, unknown> = {}
    ) => {
      const record: RetryCallRecord = { outer: opts['isRetryable'] !== undefined, delays: [] };
      retryCalls.push(record);
      return actual.withRetry(operation, logicalId, {
        ...opts,
        sleep: async (ms: number) => {
          record.delays.push(ms);
        },
      });
    },
  };
});

const TYPE = 'AWS::RedshiftServerless::Namespace';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

function ccFailure(code: string, operation = 'UPDATE'): CloudControlOperationFailedError {
  return new CloudControlOperationFailedError(
    `${operation} failed for Ns: ${code === 'NotStabilized' ? 'Exceeded attempts to wait' : code}`,
    TYPE,
    'Ns',
    'ns',
    code,
    operation
  );
}

function providerFailing(errors: unknown[], extra: Partial<ResourceProvider> = {}) {
  let seen = 0;
  const update = vi.fn(async () => {
    if (seen < errors.length) throw errors[seen++];
    return { physicalId: 'ns', wasReplaced: false };
  });
  return { provider: { update, ...extra } as unknown as ResourceProvider, update };
}

async function revert(provider: ResourceProvider) {
  return updateWithRollbackRetry(
    provider,
    ['Ns', 'ns', TYPE, { AdminUserPassword: 'old' }, { AdminUserPassword: 'new' }, {}],
    'Ns',
    logger,
    undefined,
    new Map(),
    (s) => s
  );
}

/** The outer loop's total sleep (`retry.ts` sleeps in 1 s ticks). */
const outerSleptMs = (): number =>
  (retryCalls.find((c) => c.outer)?.delays ?? []).reduce((a, b) => a + b, 0);

beforeEach(() => {
  vi.clearAllMocks();
  retryCalls.length = 0;
});

describe('a revert Cloud Control abandoned on an unsettled resource is re-sent (#6843)', () => {
  it.each(['NotStabilized', 'ResourceConflict'])(
    '%s on the revert UPDATE: waited out, then the revert lands',
    async (code) => {
      const { provider, update } = providerFailing([ccFailure(code), ccFailure(code)]);
      await expect(revert(provider)).resolves.toMatchObject({ physicalId: 'ns' });
      expect(update).toHaveBeenCalledTimes(3);
      // The re-send is the SAME revert: desired and previous unchanged.
      for (const call of update.mock.calls) {
        expect((call as unknown[])[3]).toEqual({ AdminUserPassword: 'old' });
      }
      // 30 s, then 60 s.
      expect(outerSleptMs()).toBe(90_000);
      // Each wait is announced at the default level, naming the handler code.
      const waits = vi
        .mocked(logger.info)
        .mock.calls.map((c) => String(c[0]))
        .filter((l) => l.includes('has not settled'));
      expect(waits).toHaveLength(2);
      expect(waits[0]).toContain(`Cloud Control ${code}`);
    }
  );

  it('a resource that never settles: bounded, and the handler error surfaces unchanged', async () => {
    const stuck = ccFailure('NotStabilized');
    const { provider, update } = providerFailing(Array.from({ length: 50 }, () => stuck));
    await expect(revert(provider)).rejects.toBe(stuck);
    expect(update).toHaveBeenCalledTimes(5);
    // 30 s, then 60 s three times.
    expect(outerSleptMs()).toBe(210_000);
    // Four waits announced; the fifth failure, which is thrown, announces none.
    expect(
      vi.mocked(logger.info).mock.calls.filter((c) => String(c[0]).includes('has not settled'))
    ).toHaveLength(4);
  });

  it('the handler code on a wrapped cause is read too', async () => {
    const wrapped = new ProvisioningError('UPDATE failed for Ns', TYPE, 'Ns', 'ns', ccFailure('NotStabilized'));
    const { provider, update } = providerFailing([wrapped]);
    await expect(revert(provider)).resolves.toBeDefined();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another handler code', ccFailure('InvalidRequest')],
    ['NotStabilized on a non-UPDATE operation', ccFailure('NotStabilized', 'CREATE')],
    ['a cdkd refusal', markNonRetryable(ccFailure('NotStabilized'))],
    ['an abandoned wait (no handler verdict)', new CloudControlWaitAbandonedError('wait abandoned', TYPE, 'Ns', 'tok', 'UPDATE', 'ns')],
    ['a plain error naming the code', new Error('NotStabilized: Exceeded attempts to wait')],
  ])('%s: not re-sent, thrown on the first attempt', async (_name, error) => {
    const { provider, update } = providerFailing([error]);
    await expect(revert(provider)).rejects.toBe(error);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('the inner default transient schedule still runs under the outer loop', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const { provider, update } = providerFailing([throttle, ccFailure('NotStabilized')]);
    await expect(revert(provider)).resolves.toBeDefined();
    expect(update).toHaveBeenCalledTimes(3);
    expect(retryCalls.filter((c) => !c.outer).length).toBe(2);
  });

  it('a disableOuterRetry provider stays single-shot', async () => {
    const error = ccFailure('NotStabilized');
    const { provider, update } = providerFailing([error], { disableOuterRetry: true });
    await expect(revert(provider)).rejects.toBe(error);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

describe('the automatic rollback of a completed in-place update (#6843)', () => {
  function record(password: string): ResourceState {
    return {
      physicalId: 'ns',
      resourceType: TYPE,
      properties: { NamespaceName: 'ns', AdminUserPassword: password },
      attributes: {},
      dependencies: [],
    };
  }

  it('a revert first refused as NotStabilized lands, and the restored record is kept', async () => {
    const { provider, update } = providerFailing([ccFailure('NotStabilized')]);
    const events: string[] = [];
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: (e) => events.push(e.eventType),
    };
    const op: CompletedOperation = {
      logicalId: 'Ns',
      changeType: 'UPDATE',
      resourceType: TYPE,
      physicalId: 'ns',
      previousState: record('old'),
    };
    const state: Record<string, ResourceState> = { Ns: record('new') };

    const result = await replayRollback([op], state, 'S', ctx);

    expect(update).toHaveBeenCalledTimes(2);
    expect(result.failures).toBe(0);
    expect(events).toContain('ROLLBACK_RESOURCE_SUCCEEDED');
    expect(state['Ns']?.properties['AdminUserPassword']).toBe('old');
  });
});

describe('isUnsettledUpdateFailure', () => {
  it('reads an unreadable chain as not unsettled', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      }
    );
    expect(isUnsettledUpdateFailure(hostile)).toBe(false);
    expect(isUnsettledUpdateFailure(undefined)).toBe(false);
  });
});
