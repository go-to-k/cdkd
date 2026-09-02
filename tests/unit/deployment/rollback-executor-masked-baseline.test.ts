import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { ResourceState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

/**
 * Issue [#2274](https://github.com/go-to-k/cdkd/issues/2274) — the rollback
 * twin of `drift --revert`'s masked-baseline guard.
 *
 * A `NoEcho` custom resource's `Data` resolved into a dependent's property is
 * persisted as {@link SECRET_MASK}: there is no expression to store in its
 * place, so nothing downstream can re-resolve it. This executor REPLAYS a
 * persisted bag straight to `provider.update()` / `create()`, so without a
 * guard the literal `***` would be written onto the live resource — the issue
 * #1498 / #1501 data-corruption class, i.e. shipping the mask would trade a
 * disclosure for a data-destruction path.
 *
 * It REFUSES rather than substituting, unlike the drift twin: `--revert` holds
 * an AWS-current readback beside the baseline and can leave the position as
 * AWS has it, while a replay's only source IS `previousState.properties`.
 */

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    secretsManager: { send: vi.fn() },
    ssm: { send: vi.fn() },
  }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const PARAM_TYPE = 'AWS::SSM::Parameter';

// The per-op failure is reported through `warn` (best-effort: warn and continue
// with the remaining rollbacks), not `error` — capturing the wrong channel is
// how a message assertion silently becomes vacuous.
const warnLines: string[] = [];
const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn((line: unknown) => {
    warnLines.push(String(line));
  }),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: PARAM_TYPE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(provider: Record<string, unknown>): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
}

beforeEach(() => {
  warnLines.length = 0;
  resetAccountInfoCache();
});

describe('rollback replay refuses a REDACTED baseline (issue #2274)', () => {
  it('revert (UPDATE): does not call provider.update with the mask', async () => {
    const update = vi.fn();
    const ctx = makeCtx({ update });
    const prev = res({
      properties: { Name: '/app/token', Value: SECRET_MASK },
    });
    const state: Record<string, ResourceState> = {
      Param: res({ properties: { Name: '/app/token', Value: 'something-else' } }),
    };
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Param',
        changeType: 'UPDATE',
        resourceType: PARAM_TYPE,
        physicalId: 'phys',
        previousState: prev,
      },
    ];

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(update).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(warnLines.join('\n')).toContain('redaction mask');
    expect(warnLines.join('\n')).toContain("cdkd deploy");
  });

  it('reverse-replacement (CREATE): does not re-create from the mask', async () => {
    const create = vi.fn();
    const del = vi.fn();
    const ctx = makeCtx({ create, delete: del });
    // A replacement op: the recorded physicalId differs from the previous
    // state's, which is what routes this to the re-create arm.
    const prev = res({
      physicalId: 'phys-OLD',
      properties: { Name: '/app/token', Value: SECRET_MASK },
    });
    const state: Record<string, ResourceState> = {
      Param: res({ physicalId: 'phys-NEW', properties: { Name: '/app/token', Value: 'x' } }),
    };
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Param',
        changeType: 'UPDATE',
        resourceType: PARAM_TYPE,
        physicalId: 'phys-NEW',
        previousState: prev,
      },
    ];

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(create).not.toHaveBeenCalled();
    // The NEW resource is not deleted either — the refusal happens before any
    // AWS mutation, so nothing is half-applied.
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
  });

  it('--revert-failed: does not call provider.update with the mask', async () => {
    const update = vi.fn();
    const ctx = makeCtx({ update });
    const state: Record<string, ResourceState> = {
      Param: res({ properties: { Name: '/app/token', Value: 'attempted' } }),
    };
    const failed: FailedOperation[] = [
      {
        logicalId: 'Param',
        changeType: 'UPDATE',
        resourceType: PARAM_TYPE,
        physicalId: 'phys',
        previousState: res({ properties: { Name: '/app/token', Value: SECRET_MASK } }),
        attemptedProperties: { Name: '/app/token', Value: 'attempted' },
      },
    ];

    const result = await replayFailedOperations(failed, state, 'S', ctx, {});

    expect(update).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
  });

  it('does NOT refuse when only the CURRENT side carries a mask (the negative case)', async () => {
    // The current bag becomes `previousProperties`, where a mask is harmless: a
    // patch provider comparing it against the desired value simply sees a
    // change, which is the correct conclusion. Refusing there would block
    // rollbacks that have no problem.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys', wasReplaced: false });
    const ctx = makeCtx({ update });
    const prev = res({ properties: { Name: '/app/token', Value: 'baseline' } });
    const state: Record<string, ResourceState> = {
      Param: res({ properties: { Name: '/app/token', Value: SECRET_MASK } }),
    };
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Param',
        changeType: 'UPDATE',
        resourceType: PARAM_TYPE,
        physicalId: 'phys',
        previousState: prev,
      },
    ];

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0]![3] as Record<string, unknown>)['Value']).toBe('baseline');
    expect(result.failures).toBe(0);
  });
});
