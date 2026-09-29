import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import {
  SECRET_MASK,
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { UpdateContext } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

// go-to-k/cdkd#1998, the ROLLBACK half. The in-process rollback re-resolves a
// journal that holds no parameter to `Ref`, so a `NoEcho` parameter's value in
// the reverted properties is known only to the DEPLOY's bag. The engine hands
// the replay that bag (`logOnlyNeedlesFor`), and each op's own bag is seeded
// with its LOG-ONLY needles.

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const NOECHO = 'hunter2-noecho-password';
const TYPE = 'AWS::SSM::Parameter';

const warnSpy = vi.fn();
const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: warnSpy,
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function res(properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'phys', resourceType: TYPE, properties, attributes: {}, dependencies: [] };
}

function revertUpdate(
  update: ReturnType<typeof vi.fn>,
  logOnlyNeedlesFor: RollbackExecutorContext['logOnlyNeedlesFor'],
  events: string[]
): Promise<unknown> {
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider: { update } }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (e) => {
      if (e.error?.message) events.push(e.error.message);
    },
    ...(logOnlyNeedlesFor && { logOnlyNeedlesFor }),
  };
  const ops: CompletedOperation[] = [
    {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: TYPE,
      physicalId: 'phys',
      previousState: res({ Value: NOECHO, Description: 'old' }),
    },
  ];
  return replayRollback(ops, { R: res({ Value: NOECHO, Description: 'new' }) }, 'S', ctx);
}

// A map ENTRY of the deploy bag: not a needle of this op's replay, which
// positions its redaction from its own re-resolution.
const DEPLOY_ONLY_PLAINTEXT = 'deploy-only-recorded-plaintext';

function deployBag(): RecordedSecretValues {
  const bag: RecordedSecretValues = new Map([
    [DEPLOY_ONLY_PLAINTEXT, '{{resolve:secretsmanager:x:SecretString:k::}}'],
  ]);
  recordLogOnlyValue(bag, NOECHO);
  return bag;
}

describe('rollback replay - the deploy bag seeds each op with its log-only needles (go-to-k/cdkd#1998)', () => {
  it("the revert's provider masker masks the value", async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys' });
    const bag = deployBag();
    await revertUpdate(update, (id) => (id === 'R' ? bag : undefined), []);
    const context = update.mock.calls[0]![5] as UpdateContext;
    expect(context.maskSecrets!(`Value '${NOECHO}' failed`)).toBe(`Value '${SECRET_MASK}' failed`);
    // Only the needles: the deploy bag's map ENTRY is not carried into the
    // op's bag, so the op's masker does not know it.
    expect(context.maskSecrets!(DEPLOY_ONLY_PLAINTEXT)).toBe(DEPLOY_ONLY_PLAINTEXT);
  });

  it('the rollback event of a failed revert quoting the value is masked', async () => {
    const update = vi.fn().mockRejectedValue(new Error(`Value '${NOECHO}' failed`));
    const events: string[] = [];
    warnSpy.mockClear();
    await revertUpdate(update, () => deployBag(), events);
    expect(events.join('\n')).toContain('failed');
    expect(events.join('\n')).not.toContain(NOECHO);
    // The per-op `Rollback failed for` warn masks with the same seeded bag.
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain(`Value '${SECRET_MASK}' failed`);
    expect(warned).not.toContain(NOECHO);
  });

  it('without the seed (cdkd rollback) the value is not known, which is the filed residual', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys' });
    await revertUpdate(update, undefined, []);
    const context = update.mock.calls[0]![5] as UpdateContext;
    expect(context.maskSecrets!(NOECHO)).toBe(NOECHO);
  });
});
