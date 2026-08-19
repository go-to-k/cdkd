import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import { ProvisioningError, formatError } from '../../../src/utils/error-handler.js';

// Issue #2038 acceptance item 1, deploy-engine half. The audit the issue asked
// for named `deploy-engine.ts:4631` (`DeployEngine.withRetry`) as deserving the
// same check as the rollback replay, and it leaked for the same reason: the raw
// `Logger` was threaded into `withRetry`, whose give-up summary interpolates the
// AWS message verbatim at `warn` — i.e. at DEFAULT verbosity. The bag this
// engine hands a provider is RESOLVED (`perResourceSecrets` is populated right
// after `resolver.resolve` and BEFORE the provider call), so a validation error
// quoting the offending value back printed the plaintext.
//
// The retry mock keeps the REAL `withRetry` and only makes its sleeps instant,
// so the assertion is on production's own summary string rather than a stand-in.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return {
    ...actual,
    withRetry: (
      fn: Parameters<typeof actual.withRetry>[0],
      logicalId: string,
      opts: Parameters<typeof actual.withRetry>[2] = {}
    ) => actual.withRetry(fn, logicalId, { ...opts, sleep: async () => {} }),
  };
});

const warns: string[] = [];
const debugs: string[] = [];
// `error` is CAPTURED, not discarded. It was a `() => {}` stub through the first
// cut of #2038, which is exactly why the leak one statement above the masked
// event survived review: `provisionResource` logs the raw AWS message at
// `error` — a HIGHER level than the give-up `warn` this file was written for —
// and a suite that throws that sink away cannot see it. A sink a test discards
// is a sink the test cannot fence.
const errors: string[] = [];
const thrown: unknown[] = [];
const childLogger = {
  debug: (m: string) => debugs.push(m),
  info: () => {},
  warn: (m: string) => warns.push(m),
  error: (m: string) => errors.push(m),
  child: () => childLogger,
};
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => childLogger,
}));

const SECRET_PLAINTEXT = 'deploy-side-secret-4b7e';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:client_secret::}}';

// Same sentinel resolver the sibling masker test uses.
function resolveWithSecrets(
  value: unknown,
  ctx: { recordedSecretValues?: Map<string, string> }
): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveWithSecrets(v, ctx));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('__resolveSecret' in obj) {
      const [plaintext, expr] = obj['__resolveSecret'] as [string, string];
      ctx.recordedSecretValues?.set(plaintext, expr);
      return plaintext;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveWithSecrets(v, ctx);
    return out;
  }
  return value;
}

// Issue #2038 review, item 5. The resolver mutates `context.recordedSecretValues`
// IN PLACE, so a throw from INSIDE `resolve()` — after a secret has already been
// substituted — is the window: the engine used to register the bag only AFTER
// the `await` returned, so that throw reached `provisionResource`'s catch with
// no entry for the resource and every masking site there ran against an EMPTY
// bag. Setting this makes `resolve` record and then reject, which is the only
// way to reach that ordering from a test.
let resolveThrowsAfterRecording: Error | undefined;

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi
      .fn()
      .mockImplementation((props: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        // Record FIRST, exactly as the real resolver does, then fail.
        const resolved = resolveWithSecrets(props, ctx ?? {});
        if (resolveThrowsAfterRecording) return Promise.reject(resolveThrowsAfterRecording);
        return Promise.resolve(resolved);
      }),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - the retry give-up summary is masked (issue #2038)', () => {
  const stackName = 'retry-mask-stack';
  const RESOURCE_TYPE = 'AWS::Cognito::UserPool';

  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    warns.length = 0;
    debugs.length = 0;
    errors.length = 0;
    thrown.length = 0;
    resolveThrowsAfterRecording = undefined;
    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Pool']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, noRollback: true },
      'us-east-1'
    );
  }

  const secretProps = {
    UserPoolName: 'pool',
    EnabledMfas: { __resolveSecret: [SECRET_PLAINTEXT, SECRET_EXPR] },
  };

  async function deployWithFailingCreate(message: string): Promise<void> {
    mockProvider.create!.mockRejectedValue(
      Object.assign(new Error(message), {
        name: 'InternalFailure',
        $metadata: { httpStatusCode: 500, requestId: 'req-abc' },
      })
    );
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Pool',
          {
            logicalId: 'Pool',
            changeType: 'CREATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: secretProps,
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: { Pool: { Type: RESOURCE_TYPE, Properties: secretProps } },
    };
    await makeEngine()
      .deploy(stackName, template)
      .catch((e) => {
        thrown.push(e);
      });
  }

  it('an exhausting retry on a CREATE does not print the resolved secret', async () => {
    await deployWithFailingCreate(
      `Value '${SECRET_PLAINTEXT}' at 'clientSecret' failed to satisfy constraint`
    );

    // Non-vacuity: the provider really did receive the plaintext, and the real
    // retry loop really did exhaust (1 attempt + 8 retries).
    expect(
      (mockProvider.create!.mock.calls[0]![2] as Record<string, unknown>)['EnabledMfas']
    ).toBe(SECRET_PLAINTEXT);
    expect(mockProvider.create!).toHaveBeenCalledTimes(9);

    // The FEARED SHAPE: production's own give-up summary line.
    const summary = warns.find((m) => m.includes('gave up after'));
    expect(summary).toBeDefined();
    expect(summary).toContain('transient server-error');
    expect(summary).not.toContain(SECRET_PLAINTEXT);
    expect(summary).toContain(SECRET_MASK);
  });

  it('the per-attempt retry debug line does not print the resolved secret', async () => {
    await deployWithFailingCreate(
      `Value '${SECRET_PLAINTEXT}' at 'clientSecret' failed to satisfy constraint`
    );

    const attemptLine = debugs.find((m) => m.includes('Retrying Pool in'));
    expect(attemptLine).toBeDefined();
    expect(attemptLine).not.toContain(SECRET_PLAINTEXT);
    expect(attemptLine).toContain(SECRET_MASK);
  });

  it('leaves a non-secret AWS message untouched (the mask is not blanket redaction)', async () => {
    await deployWithFailingCreate(`Value 'PLAINCONFIG' at 'clientSecret' failed to satisfy`);

    const summary = warns.find((m) => m.includes('gave up after'));
    expect(summary).toContain('PLAINCONFIG');
  });

  // Issue #2038 review, BLOCKER. `provisionResource`'s catch logs the raw AWS
  // message at `error` and then records the SAME error as an event through
  // `maskSecretsInEvent` — so the durable sink was masked while the terminal
  // printed the plaintext, at a strictly higher log level than the give-up
  // summary above. The bag is in scope at both (`perResourceSecrets` is set
  // right after `resolver.resolve`).
  it('the per-resource failure line logged at ERROR does not print the resolved secret', async () => {
    await deployWithFailingCreate(
      `Value '${SECRET_PLAINTEXT}' at 'clientSecret' failed to satisfy constraint`
    );

    const failLine = errors.find((m) => m.startsWith('Failed to create Pool'));
    expect(failLine).toBeDefined();
    expect(failLine).not.toContain(SECRET_PLAINTEXT);
    expect(failLine).toContain(SECRET_MASK);
    // Nothing else on the ERROR channel printed it either.
    expect(errors.join('\n')).not.toContain(SECRET_PLAINTEXT);
  });

  // Issue #2038 review, third sink — found while verifying the second. Masking
  // the two LOG sites is not enough: `formatError` renders a `CdkdError`'s CAUSE
  // as `Caused by: <cause.message>` and `handleError` logs that at `error` level
  // for anything escaping the command, so the raw provider error attached to
  // `ProvisioningError` printed the plaintext at the CLI boundary. Asserting on
  // `formatError` rather than on `.cause.message` is deliberate: the leak is
  // what the USER sees, and `.cause` is also read by things that must keep
  // seeing the untouched shape (asserted below).
  it('the ProvisioningError cause does not carry the resolved secret to formatError', async () => {
    await deployWithFailingCreate(
      `Value '${SECRET_PLAINTEXT}' at 'clientSecret' failed to satisfy constraint`
    );

    expect(thrown).toHaveLength(1);
    const err = thrown[0] as Error & { cause?: Error };
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(formatError(err)).toContain('Caused by:');
    expect(formatError(err)).not.toContain(SECRET_PLAINTEXT);
    expect(formatError(err)).toContain(SECRET_MASK);

    // The clone must stay usable by everything that reads a cause chain — the
    // retry classifiers and the event extractor both key on these.
    const cause = err.cause as Error & { $metadata?: { requestId?: string } };
    expect(cause.name).toBe('InternalFailure');
    expect(cause.$metadata?.requestId).toBe('req-abc');
    expect(cause).toBeInstanceOf(Error);
  });

  it('leaves the ERROR line untouched for a non-secret message (no blanket redaction)', async () => {
    await deployWithFailingCreate(`Value 'PLAINCONFIG' at 'clientSecret' failed to satisfy`);

    const failLine = errors.find((m) => m.startsWith('Failed to create Pool'));
    expect(failLine).toContain('PLAINCONFIG');
    expect(failLine).not.toContain(SECRET_MASK);
  });

  // Issue #2038 review, item 5. A throw from INSIDE `resolve()`, once a secret
  // has been substituted, is the one ordering in which the bag exists but the
  // engine had not yet published it. No resolver throw is known to inline a
  // resolved value today, so this fences a WINDOW rather than a demonstrated
  // leak — which is exactly why it needs a test: nothing else in the tree
  // reaches this ordering, and the fix is a two-line move that a later edit
  // could silently undo.
  it('a throw from INSIDE resolve, after a secret was substituted, is still masked', async () => {
    resolveThrowsAfterRecording = Object.assign(
      new Error(`Value '${SECRET_PLAINTEXT}' at 'clientSecret' failed to satisfy constraint`),
      { name: 'ValidationException', $metadata: { httpStatusCode: 400, requestId: 'req-mid' } }
    );
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Pool',
          {
            logicalId: 'Pool',
            changeType: 'CREATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: secretProps,
          },
        ],
      ])
    );
    await makeEngine()
      .deploy(stackName, {
        Resources: { Pool: { Type: RESOURCE_TYPE, Properties: secretProps } },
      } as CloudFormationTemplate)
      .catch((e) => {
        thrown.push(e);
      });

    // Non-vacuity: the resolution really did fail BEFORE the provider was
    // reached, so this is the mid-resolve window and not the ordinary
    // provider-failure path the cases above already cover.
    expect(mockProvider.create!).not.toHaveBeenCalled();

    const failLine = errors.find((m) => m.startsWith('Failed to create Pool'));
    expect(failLine).toBeDefined();
    expect(failLine).not.toContain(SECRET_PLAINTEXT);
    expect(failLine).toContain(SECRET_MASK);
    expect(errors.join('\n')).not.toContain(SECRET_PLAINTEXT);

    // ... and the CLI-boundary sink too, which reads the error OBJECT.
    expect(thrown).toHaveLength(1);
    const err = thrown[0] as Error;
    expect(formatError(err)).not.toContain(SECRET_PLAINTEXT);
    expect(formatError(err)).toContain(SECRET_MASK);
  });

  // The UPDATE half of the same hoist, fenced separately because it IS
  // separate: reverting ONLY the UPDATE path left all 84 files / 1370 tests of
  // `tests/unit/deployment` green, so the CREATE case above proves nothing
  // about it. Two adjacent one-line moves need two fences.
  it('the same window on the UPDATE path is masked too', async () => {
    resolveThrowsAfterRecording = Object.assign(
      new Error(`Value '${SECRET_PLAINTEXT}' at 'clientSecret' failed to satisfy constraint`),
      { name: 'ValidationException', $metadata: { httpStatusCode: 400, requestId: 'req-upd' } }
    );
    mockStateBackend.getState!.mockResolvedValue({
      state: {
        version: 8,
        stackName,
        region: 'us-east-1',
        resources: {
          Pool: {
            physicalId: 'pool-existing',
            resourceType: RESOURCE_TYPE,
            properties: { UserPoolName: 'pool' },
          },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: 'etag-1',
    });
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Pool',
          {
            logicalId: 'Pool',
            changeType: 'UPDATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: secretProps,
            currentProperties: { UserPoolName: 'pool' },
          },
        ],
      ])
    );
    await makeEngine()
      .deploy(stackName, {
        Resources: { Pool: { Type: RESOURCE_TYPE, Properties: secretProps } },
      } as CloudFormationTemplate)
      .catch((e) => {
        thrown.push(e);
      });

    // Non-vacuity: this really is the UPDATE arm, failing mid-resolution.
    expect(mockProvider.update!).not.toHaveBeenCalled();

    const failLine = errors.find((m) => m.startsWith('Failed to update Pool'));
    expect(failLine).toBeDefined();
    expect(failLine).not.toContain(SECRET_PLAINTEXT);
    expect(failLine).toContain(SECRET_MASK);
    expect(errors.join('\n')).not.toContain(SECRET_PLAINTEXT);
  });

  // Issue #2038 review, item 6: a resource that recorded NO secret must be
  // BYTE-IDENTICAL to the pre-fix output. `maskForResource` forwards verbatim
  // for a missing bag, and this pins the whole line rather than merely asserting
  // an absence (which any mangling would also satisfy).
  it('a resource with no recorded secret logs byte-identically to before the fix', async () => {
    const plainProps = { UserPoolName: 'pool' };
    mockProvider.create!.mockRejectedValue(new Error('Bad Request: something ordinary failed'));
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Pool',
          {
            logicalId: 'Pool',
            changeType: 'CREATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: plainProps,
          },
        ],
      ])
    );
    await makeEngine()
      .deploy(stackName, {
        Resources: { Pool: { Type: RESOURCE_TYPE, Properties: plainProps } },
      } as CloudFormationTemplate)
      .catch(() => undefined);

    expect(errors).toContain('Failed to create Pool: Bad Request: something ordinary failed');
  });
});

// Issue #2038 review, item 3. The `maskingRetryLogger` JSDoc calls the
// per-resource scoping load-bearing ("Per-resource, never session-wide"), and
// it was UNFENCED: replacing `perResourceSecrets.get(logicalId)` with a union
// of every resource's bag passed the entire `tests/unit/deployment` suite. That
// is the over-redaction class of issues #1912 / #1918 — one resource's secret
// rewriting a SIBLING's ordinary literal into the sibling's `{{resolve:...}}`
// expression, which is wrong in the reported output and, for the state writers
// keyed on the same bags, wrong on disk.
describe('DeployEngine - masking is scoped to the resource that resolved it (issue #2038)', () => {
  const stackName = 'retry-mask-scope-stack';
  const RESOURCE_TYPE = 'AWS::Cognito::UserPool';
  const A_SECRET = 'pool-a-secret-11aa';
  const A_EXPR = '{{resolve:secretsmanager:a-secret:SecretString:client_secret::}}';
  // PoolB's SECRET, which PoolA's AWS error quotes as an ordinary literal — the
  // coincidence #1912 / #1918 are about. A session-wide bag rewrites it here.
  const B_SECRET = 'pool-b-secret-22bb';
  const B_EXPR = '{{resolve:secretsmanager:b-secret:SecretString:client_secret::}}';

  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    warns.length = 0;
    debugs.length = 0;
    errors.length = 0;
    mockProvider = {
      // PoolB succeeds (so its bag is recorded); PoolA fails with a message
      // quoting BOTH its own secret and PoolB's.
      create: vi.fn().mockImplementation((logicalId: string) => {
        if (logicalId === 'PoolB') return Promise.resolve({ physicalId: 'pool-b' });
        return Promise.reject(
          new Error(
            `Value '${A_SECRET}' at 'clientSecret' and '${B_SECRET}' at 'callbackUrl' ` +
              `failed to satisfy constraint`
          )
        );
      }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['PoolB'], ['PoolA']]),
      // Force PoolB first, so its bag is recorded BEFORE PoolA's failure is
      // logged. Without the ordering the test could pass vacuously (an empty
      // union is indistinguishable from correct scoping).
      getDirectDependencies: vi
        .fn()
        .mockImplementation((_dag: unknown, id: string) => (id === 'PoolA' ? ['PoolB'] : [])),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("one resource's secret does not rewrite a sibling's ordinary literal", async () => {
    const propsA = {
      UserPoolName: 'a',
      EnabledMfas: { __resolveSecret: [A_SECRET, A_EXPR] },
    };
    const propsB = {
      UserPoolName: 'b',
      EnabledMfas: { __resolveSecret: [B_SECRET, B_EXPR] },
    };
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'PoolB',
          {
            logicalId: 'PoolB',
            changeType: 'CREATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: propsB,
          },
        ],
        [
          'PoolA',
          {
            logicalId: 'PoolA',
            changeType: 'CREATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: propsA,
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: {
        PoolA: { Type: RESOURCE_TYPE, Properties: propsA },
        PoolB: { Type: RESOURCE_TYPE, Properties: propsB },
      },
    };

    await new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, noRollback: true },
      'us-east-1'
    )
      .deploy(stackName, template)
      .catch(() => undefined);

    // Non-vacuity, both halves. PoolB really resolved its own secret (so a
    // session-wide union would be non-empty), and PoolA really reached the
    // provider with ITS plaintext.
    const bCall = mockProvider.create!.mock.calls.find((c) => c[0] === 'PoolB');
    expect((bCall![2] as Record<string, unknown>)['EnabledMfas']).toBe(B_SECRET);
    const aCall = mockProvider.create!.mock.calls.find((c) => c[0] === 'PoolA');
    expect((aCall![2] as Record<string, unknown>)['EnabledMfas']).toBe(A_SECRET);

    const failLine = errors.find((m) => m.startsWith('Failed to create PoolA'));
    expect(failLine).toBeDefined();
    // Its OWN secret is masked ...
    expect(failLine).not.toContain(A_SECRET);
    expect(failLine).toContain(SECRET_MASK);
    // ... and the SIBLING's value, which is an ordinary literal here, is not.
    expect(failLine).toContain(B_SECRET);
    expect(failLine).not.toContain(B_EXPR);
  });
});
