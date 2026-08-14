import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const SECRET_PLAINTEXT = 'super-secret-plaintext-value';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';

// Mock resolver: resolving a value equal to SECRET_EXPR records the secret and
// returns the plaintext (as the real resolver does). This lets scrubStack learn
// the plaintext->expression map without a live AWS GetSecretValue.
vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const walk = (v: unknown): unknown => {
          if (v === SECRET_EXPR) {
            ctx.recordedSecretValues?.set(SECRET_PLAINTEXT, SECRET_EXPR);
            return SECRET_PLAINTEXT;
          }
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
            return out;
          }
          return v;
        };
        return Promise.resolve(walk(value));
      }),
  })),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as never;

function makeStackInfo(): {
  stackName: string;
  displayName: string;
  artifactId: string;
  template: CloudFormationTemplate;
  dependencyNames: string[];
} {
  return {
    stackName: 'MyStack',
    displayName: 'MyStack',
    artifactId: 'MyStack',
    dependencyNames: [],
    // The TEMPLATE carries the {{resolve:...}} expression (what marks the secret).
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Environment: { Variables: { SECRET: SECRET_EXPR, PUBLIC: 'ok' } } },
        },
      },
      Outputs: { LeakedOut: { Value: SECRET_EXPR } },
    },
  };
}

// State written by an OLD binary: it holds the resolved PLAINTEXT (the bug).
function makeLeakyState(): StackState {
  return {
    version: 8,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources: {
      Fn: {
        physicalId: 'my-fn',
        resourceType: 'AWS::Lambda::Function',
        properties: { Environment: { Variables: { SECRET: SECRET_PLAINTEXT, PUBLIC: 'ok' } } },
      },
    },
    outputs: { LeakedOut: SECRET_PLAINTEXT },
    lastModified: 0,
  };
}

describe('cdkd scrub - scrubStack', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: makeLeakyState(), etag: 'etag-1' }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('rewrites leaked plaintext in properties AND outputs to the {{resolve:...}} expression', async () => {
    const res = await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    expect(res.secretsFound).toBeGreaterThanOrEqual(1);
    expect(res.recordsChanged).toBeGreaterThan(0);
    expect(lockManager.acquireLockWithRetry).toHaveBeenCalled();
    expect(lockManager.releaseLock).toHaveBeenCalled();

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    const env = (saved.resources['Fn']!.properties['Environment'] as Record<string, unknown>)[
      'Variables'
    ] as Record<string, unknown>;
    expect(env['SECRET']).toBe(SECRET_EXPR);
    expect(env['PUBLIC']).toBe('ok'); // non-secret untouched
    expect(saved.outputs['LeakedOut']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    // Saved under the optimistic lock etag.
    expect(stateBackend.saveState.mock.calls.at(-1)![3]).toEqual({ expectedEtag: 'etag-1' });
  });

  it('dry-run reports the secret but does NOT save or lock', async () => {
    const res = await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: true,
      logger,
    });

    expect(res.secretsFound).toBeGreaterThanOrEqual(1);
    expect(res.recordsChanged).toBeGreaterThan(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(lockManager.acquireLockWithRetry).not.toHaveBeenCalled();
  });

  it('reports nothing to scrub when state is already clean (holds the expression)', async () => {
    const clean = makeLeakyState();
    (
      (clean.resources['Fn']!.properties['Environment'] as Record<string, unknown>)[
        'Variables'
      ] as Record<string, unknown>
    )['SECRET'] = SECRET_EXPR;
    clean.outputs['LeakedOut'] = SECRET_EXPR;
    stateBackend.getState.mockResolvedValue({ state: clean, etag: 'etag-1' });

    const res = await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });

    expect(res.recordsChanged).toBe(0);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('returns zero when no state exists for the stack', async () => {
    stateBackend.getState.mockResolvedValue(null);
    const res = await scrubStack(makeStackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger,
    });
    expect(res).toEqual({ recordsChanged: 0, secretsFound: 0 });
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });
});
