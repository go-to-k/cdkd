/**
 * go-to-k/cdkd#1889 item 2: the replacement paths' delete wraps forward the
 * delete's error as a MASKED `cause`.
 *
 *   - `replacement.ts`, the `--replace` delete-first fallback: "Failed to
 *     delete old resource ..." (and its re-create twin, "Failed to re-create
 *     ...", whose cause is now masked the same way).
 *   - `update-replace.ts`, the `--recreate-via-*` destroy: "Failed to destroy
 *     old resource ...".
 *
 * A wrap with no `cause` severs every marker the original carried
 * (`markNonRetryable`, `$metadata`), so each site has a marker case. A bare
 * `cause` would carry the AWS text the message mask removed, so each site
 * also has a secret case — run with `provisionResource`'s boundary mask taken
 * out of the way (`printingSecretsFor` answering nothing), because that
 * boundary masks the whole chain again with the same values and would
 * otherwise hide which of the two did the work.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import {
  isMarkedNonRetryable,
  markNonRetryable,
} from '../../../src/deployment/retryable-errors.js';
import { awsSdkError, ccAlreadyExistsError } from '../_aws-sdk-error.js';

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

/**
 * Per arm: a non-stateful type, so the stateful guard stays out of the way.
 * The recreate arm takes Lambda because `AWS::Pipes::Pipe` is refused by the
 * `--recreate-via-cc-api` pre-check (Cloud Control cannot manage it).
 */
const TYPE_FOR = { replace: 'AWS::Pipes::Pipe', recreate: 'AWS::Lambda::Function' } as const;
const STACK_NAME = 'MyStack';
const SECRET = 's3cr3t-p4ssw0rd-value';

type Chained = Error & { cause?: unknown; $metadata?: unknown };

describe('replacement delete wraps chain a masked cause (go-to-k/cdkd#1889)', () => {
  let createFailures: Error[];
  let deleteRejection: (() => Error) | undefined;
  let provider: ResourceProvider;

  beforeEach(() => {
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
    (engine as unknown as { printingSecretsFor: () => undefined }).printingSecretsFor = () =>
      undefined;
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
    const provisionResource = (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate
        ) => Promise<void>;
      }
    ).provisionResource.bind(engine);
    const outer = await provisionResource('Pipe', change, stateResources, STACK_NAME, template).then(
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

  describe('replacement.ts: the --replace delete-first fallback delete wrap', () => {
    it('chains the delete error, so its non-retryable marker and $metadata survive', async () => {
      const raw = markNonRetryable(awsSdkError('Pipe is in use by another operation'));
      createFailures = [collision()];
      deleteRejection = () => raw;

      const engine = makeEngine('replace');
      const failedEventError = captureFailedEventError(engine);
      const wrap = await provisionExpectingWrap(engine, 'replace');

      expect(wrap.message).toContain(
        'Failed to delete old resource Pipe (my-pipe) during the --replace delete-first fallback'
      );
      // No secret recorded, so the mask hands the original back by identity.
      expect(wrap.cause).toBe(raw);
      expect(isMarkedNonRetryable(wrap)).toBe(true);
      // The persisted event names the AWS failure behind the wrap.
      expect(failedEventError()).toMatchObject({
        awsErrorCode: 'ResourceConflictException',
        requestId: 'req-test',
      });
    });

    it('masks a secret-bearing delete error in the chain, not only in the message', async () => {
      secretsToRecord = [[SECRET, '{{resolve:secretsmanager:db:SecretString:pw}}']];
      createFailures = [collision()];
      deleteRejection = () =>
        markNonRetryable(awsSdkError(`ValidationException: Value '${SECRET}' at 'Source' failed`));

      const wrap = await provisionExpectingWrap(
        withoutBoundaryMask(makeEngine('replace')),
        'replace'
      );
      const cause = wrap.cause as Chained;

      expect(cause).toBeInstanceOf(Error);
      expect(cause.message).not.toContain(SECRET);
      expect(cause.stack ?? '').not.toContain(SECRET);
      // The value was REPLACED, not the text dropped.
      expect(cause.message).toContain(`Value '***' at 'Source' failed`);
      // The masked clone keeps what the cause is chained for.
      expect(isMarkedNonRetryable(cause)).toBe(true);
      expect(cause.$metadata).toEqual({ httpStatusCode: 400, requestId: 'req-test' });
      expect(wrap.message).not.toContain(SECRET);
    });
  });

  describe('replacement.ts: the --replace delete-first fallback re-create wrap', () => {
    it('masks a secret-bearing create error in the chain', async () => {
      secretsToRecord = [[SECRET, '{{resolve:secretsmanager:db:SecretString:pw}}']];
      createFailures = [
        collision(),
        awsSdkError(`ValidationException: Value '${SECRET}' at 'Source' failed`, 'ValidationException'),
      ];

      const wrap = await provisionExpectingWrap(
        withoutBoundaryMask(makeEngine('replace')),
        'replace'
      );
      const cause = wrap.cause as Chained;

      expect(wrap.message).toContain('already deleted the old resource (my-pipe)');
      expect(cause).toBeInstanceOf(Error);
      expect(cause.message).not.toContain(SECRET);
      expect(cause.message).toContain(`Value '***' at 'Source' failed`);
      expect(cause.$metadata).toEqual({ httpStatusCode: 400, requestId: 'req-test' });
    });
  });

  describe('update-replace.ts: the --recreate-via-* destroy wrap', () => {
    it('chains the delete error, so its non-retryable marker and $metadata survive', async () => {
      const raw = markNonRetryable(awsSdkError('Pipe is in use by another operation'));
      deleteRejection = () => raw;

      const engine = makeEngine('recreate');
      const failedEventError = captureFailedEventError(engine);
      const wrap = await provisionExpectingWrap(engine, 'recreate');

      expect(wrap.message).toContain(
        'Failed to destroy old resource Pipe (my-pipe) during --recreate-via-cc-api'
      );
      expect(wrap.cause).toBe(raw);
      expect(isMarkedNonRetryable(wrap)).toBe(true);
      // The persisted event names the AWS failure behind the wrap.
      expect(failedEventError()).toMatchObject({
        awsErrorCode: 'ResourceConflictException',
        requestId: 'req-test',
      });
    });

    it('masks a secret-bearing delete error in the message and in the chain', async () => {
      secretsToRecord = [[SECRET, '{{resolve:secretsmanager:db:SecretString:pw}}']];
      deleteRejection = () =>
        markNonRetryable(awsSdkError(`ValidationException: Value '${SECRET}' at 'Source' failed`));

      const wrap = await provisionExpectingWrap(
        withoutBoundaryMask(makeEngine('recreate')),
        'recreate'
      );
      const cause = wrap.cause as Chained;

      expect(wrap.message).toContain('Failed to destroy old resource Pipe (my-pipe)');
      expect(wrap.message).not.toContain(SECRET);
      expect(wrap.message).toContain(`Value '***' at 'Source' failed`);
      expect(cause).toBeInstanceOf(Error);
      expect(cause.message).not.toContain(SECRET);
      expect(cause.stack ?? '').not.toContain(SECRET);
      expect(cause.message).toContain(`Value '***' at 'Source' failed`);
      expect(isMarkedNonRetryable(cause)).toBe(true);
      expect(cause.$metadata).toEqual({ httpStatusCode: 400, requestId: 'req-test' });
    });
  });
});
