/**
 * go-to-k/cdkd#2319: the deploy engine's `update-replace.ts` refusals and the
 * event recorder name an AWS-authored failure by its class. The
 * `--recreate-via-*` destroy wrap, the create-first collision refusals and
 * the `RESOURCE_FAILED` event a raw create failure records are persisted to
 * `deployments/{runId}.jsonl`, and AWS words a denial with the caller's
 * account, role and session. Harness shared in shape with
 * `deploy-engine-rewrap-masked-cause-1889.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource as provisionResourceFn } from '../../../src/deployment/deploy-engine/provision.js';
import { printingSecretsFor } from '../../../src/deployment/deploy-engine/masking.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  markNonRetryable,
} from '../../../src/deployment/retryable-errors.js';
import { awsSdkError, ccAlreadyExistsError } from '../_aws-sdk-error.js';
import { getLogger } from '../../../src/utils/logger.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/**
 * go-to-k/cdkd#2319: an AWS-authored failure's text moved from the persisted
 * wrap message to `debug`, so the masking cases read it there.
 */
function debugLines(): string[] {
  return vi.mocked(getLogger().debug).mock.calls.map(([m]) => String(m));
}

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/**
 * The resolver mock records `secretsToRecord` into the context's
 * `recordedSecretValues`, as the real one does: that map is the bag both
 * wrap sites mask with.
 */
let secretsToRecord: Array<[string, string]> = [];

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi
      .fn()
      .mockImplementation(
        (value: unknown, context?: { recordedSecretValues?: Map<string, string> }) => {
          if (context?.recordedSecretValues) {
            for (const [plaintext, expression] of secretsToRecord) {
              context.recordedSecretValues.set(plaintext, expression);
            }
          }
          return Promise.resolve(value);
        }
      ),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

// The printing bag a case stubs (`masking.ts`'s `printingSecretsFor`); every
// other case runs the real one, which `mockReset` restores.
vi.mock('../../../src/deployment/deploy-engine/masking.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/deploy-engine/masking.js')>();
  return { ...actual, printingSecretsFor: vi.fn(actual.printingSecretsFor) };
});

/**
 * Per arm: a non-stateful type, so the stateful guard stays out of the way.
 * The recreate arm takes Lambda because `AWS::Pipes::Pipe` is refused by the
 * `--recreate-via-cc-api` pre-check (Cloud Control cannot manage it).
 */
const TYPE_FOR = { replace: 'AWS::Pipes::Pipe', recreate: 'AWS::Lambda::Function' } as const;
const STACK_NAME = 'MyStack';
const SECRET = 's3cr3t-p4ssw0rd-value';

type Chained = Error & { cause?: unknown; $metadata?: unknown };

describe('update-replace.ts names an AWS failure by its class (go-to-k/cdkd#2319)', () => {
  let createFailures: Error[];
  let deleteRejection: (() => Error) | undefined;
  let provider: ResourceProvider;

  beforeEach(() => {
    vi.mocked(printingSecretsFor).mockReset();
    vi.mocked(getLogger().debug).mockClear();
    secretsToRecord = [];
    createFailures = [];
    deleteRejection = undefined;
    provider = {
      create: vi.fn().mockImplementation(async () => {
        const failure = createFailures.shift();
        if (failure) throw failure;
        return { physicalId: 'my-pipe', attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        if (deleteRejection) throw deleteRejection();
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(arm: 'replace' | 'recreate'): InstanceType<typeof DeployEngine> {
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') } as unknown as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as unknown as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as unknown as never,
      mockProviderRegistry as unknown as never,
      arm === 'replace'
        ? { replace: true }
        : {
            recreateTargets: {
              stackName: STACK_NAME,
              viaCcApi: new Set(['Pipe']),
              viaSdkProvider: new Set<string>(),
            },
          },
      'us-east-1'
    );
  }

  /**
   * Take `provisionResource`'s boundary mask out of the way, so the wrap
   * site's own mask is the only one between the plaintext and the assertion.
   */
  function withoutBoundaryMask(
    engine: InstanceType<typeof DeployEngine>
  ): InstanceType<typeof DeployEngine> {
    vi.mocked(printingSecretsFor).mockReturnValue(undefined);
    return engine;
  }

  /**
   * The `error` field of the `RESOURCE_FAILED` event the engine records:
   * `extractDeploymentEventError` walks the chain for the AWS `$metadata` /
   * code, which a wrap with no `cause` hides.
   */
  function captureFailedEventError(
    engine: InstanceType<typeof DeployEngine>
  ): () => { awsErrorCode?: string; requestId?: string } | undefined {
    const spy = vi.spyOn(
      engine as unknown as { recordEvent: (event: unknown) => void },
      'recordEvent'
    );
    return () => {
      const event = spy.mock.calls
        .map(([e]) => e as { eventType?: string; error?: { awsErrorCode?: string; requestId?: string } })
        .find((e) => e.eventType === 'RESOURCE_FAILED');
      return event?.error;
    };
  }

  /** The error the replacement branch raised: one link under `ProvisioningError`. */
  async function provisionExpectingWrap(
    engine: InstanceType<typeof DeployEngine>,
    arm: 'replace' | 'recreate'
  ): Promise<Chained> {
    const TYPE = TYPE_FOR[arm];
    const change: ResourceChange = {
      logicalId: 'Pipe',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { Name: 'my-pipe', Source: 'arn:a' },
      desiredProperties: { Name: 'my-pipe', Source: 'arn:b' },
      propertyChanges: [
        {
          path: 'Source',
          oldValue: 'arn:a',
          newValue: 'arn:b',
          requiresReplacement: arm === 'replace',
        },
      ],
    };
    const stateResources = {
      Pipe: {
        physicalId: 'my-pipe',
        resourceType: TYPE,
        properties: { Name: 'my-pipe', Source: 'arn:a' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'cc-api' as const,
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { Pipe: { Type: TYPE, Properties: { Name: 'my-pipe', Source: 'arn:b' } } },
    };
    const outer = await provisionResourceFn(
      engine,
      'Pipe',
      change,
      stateResources as unknown as Record<string, never>,
      STACK_NAME,
      template
    ).then(
      () => null,
      (e: unknown) => e as Chained
    );
    expect(outer).not.toBeNull();
    return outer!.cause as Chained;
  }

  const collision = () =>
    ccAlreadyExistsError(
      "CREATE failed for Pipe: Resource of type 'AWS::Pipes::Pipe' with identifier 'my-pipe' already exists."
    );

  // go-to-k/cdkd#2319: the wrap is persisted to `deployments/{runId}.jsonl`,
  // and AWS words a denial with the caller's account, role and session.
  describe('the --recreate-via-* destroy wrap and the create-first collision', () => {
    const DENIAL =
      'User: arn:aws:sts::123456789012:assumed-role/Deployer/s is denied pipes:DeletePipe';

    it('withholds AWS text from the wrap and its event, keeping it on the chain and in debug', async () => {
      const raw = markNonRetryable(awsSdkError(DENIAL, 'AccessDeniedException'));
      deleteRejection = () => raw;
      const engine = makeEngine('recreate');
      const failedEventError = captureFailedEventError(engine);

      const wrap = await provisionExpectingWrap(engine, 'recreate');

      expect(wrap.message).toBe(
        'Failed to destroy old resource Pipe (my-pipe) during --recreate-via-cc-api: ' +
          "AccessDeniedException. Re-run with --verbose for AWS's own message."
      );
      expect((wrap.cause as Error).message).toBe(DENIAL);
      expect(hasRedactedCause(wrap)).toBe(true);
      const event = failedEventError() as { message?: string } | undefined;
      expect(event?.message).not.toContain('123456789012');
      expect(event?.message).not.toContain('Deployer');
      const debugLine = debugLines().find((l) => l.includes('Deployer'));
      expect(debugLine).toContain('Failed to destroy old resource Pipe (my-pipe)');
    });

    it('quotes an AWS-authored create-first collision by its class in the refusal', async () => {
      const engine = makeEngine('replace');
      (engine.options as { replace?: boolean }).replace = false;
      createFailures = [
        markNonRetryable(
          awsSdkError(
            'Pipe my-pipe already exists for arn:aws:sts::123456789012:assumed-role/Deployer/s',
            'ConflictException'
          )
        ),
      ];
      const failedEventError = captureFailedEventError(engine);

      const refusal = await provisionExpectingWrap(engine, 'replace');

      expect((refusal as { code?: string }).code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(refusal.message).toContain(
        "collided with the existing resource: ConflictException. Re-run with --verbose for AWS's own message. "
      );
      expect(refusal.message).not.toContain('123456789012');
      expect(refusal.message).not.toContain('Deployer');
      const event = failedEventError() as { message?: string } | undefined;
      expect(event?.message).not.toContain('Deployer');
      const debugLine = debugLines().find((l) => l.includes('Deployer'));
      expect(debugLine).toContain('Pipe: the create-first attempt collided: Pipe my-pipe already exists');
    });

    // The recorder's own reduction: a non-collision create failure is
    // rethrown RAW, so AWS's text is the outermost message the event takes.
    it('records a raw AWS create failure in the RESOURCE_FAILED event by its class', async () => {
      const engine = makeEngine('replace');
      const denial = markNonRetryable(
        awsSdkError(
          'User: arn:aws:sts::123456789012:assumed-role/Deployer/s is denied pipes:CreatePipe',
          'AccessDeniedException'
        )
      );
      createFailures = [denial];
      const failedEventError = captureFailedEventError(engine);

      const raised = await provisionExpectingWrap(engine, 'replace');

      expect(raised.message).toBe(denial.message);
      expect(failedEventError()).toMatchObject({
        name: 'AccessDeniedException',
        message: "AccessDeniedException. Re-run with --verbose for AWS's own message.",
        awsErrorCode: 'AccessDeniedException',
        requestId: 'req-test',
      });
    });

    it('keeps a transport delete failure text, unstamped', async () => {
      deleteRejection = () => markNonRetryable(new Error('connect ECONNREFUSED 127.0.0.1:443'));

      const wrap = await provisionExpectingWrap(makeEngine('recreate'), 'recreate');

      expect(wrap.message).toContain(
        'during --recreate-via-cc-api: connect ECONNREFUSED 127.0.0.1:443'
      );
      expect(wrap.message).not.toContain('--verbose');
      expect(hasRedactedCause(wrap)).toBe(false);
    });
  });

});
