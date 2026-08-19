import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

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
const childLogger = {
  debug: (m: string) => debugs.push(m),
  info: () => {},
  warn: (m: string) => warns.push(m),
  error: () => {},
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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi
      .fn()
      .mockImplementation((props: unknown, ctx: { recordedSecretValues?: Map<string, string> }) =>
        Promise.resolve(resolveWithSecrets(props, ctx ?? {}))
      ),
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
      .catch(() => undefined);
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
});
