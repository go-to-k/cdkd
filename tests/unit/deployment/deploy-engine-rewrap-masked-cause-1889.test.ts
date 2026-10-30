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
import { provisionResource as provisionResourceFn } from '../../../src/deployment/deploy-engine/provision.js';
import { printingSecretsFor } from '../../../src/deployment/deploy-engine/masking.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  markNonRetryable,
} from '../../../src/deployment/retryable-errors.js';
import { getLogger } from '../../../src/utils/logger.js';
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

describe('replacement delete wraps chain a masked cause (go-to-k/cdkd#1889)', () => {
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
      // go-to-k/cdkd#2319: the persisted message names the class; AWS's text
      // is in debug, masked.
      expect(wrap.message).toContain(
        "during --recreate-via-cc-api: ResourceConflictException. Re-run with --verbose for AWS's own message."
      );
      expect(debugLines().some((l) => l.includes(`Value '***' at 'Source' failed`))).toBe(true);
      expect(debugLines().some((l) => l.includes(SECRET))).toBe(false);
      expect(cause).toBeInstanceOf(Error);
      expect(cause.message).not.toContain(SECRET);
      expect(cause.stack ?? '').not.toContain(SECRET);
      expect(cause.message).toContain(`Value '***' at 'Source' failed`);
      expect(isMarkedNonRetryable(cause)).toBe(true);
      expect(cause.$metadata).toEqual({ httpStatusCode: 400, requestId: 'req-test' });
    });

    // go-to-k/cdkd#2676: the wrapped message is embedded as-is (masked, not
    // flattened), so a secret spanning two lines (a PEM body an AWS error
    // quotes back) is masked whole.
    it('masks a MULTI-LINE secret in the embedded message (#2676)', async () => {
      const multiLine = 'pem-line-one-2676\npem-line-two-2676';
      secretsToRecord = [[multiLine, '{{resolve:secretsmanager:db:SecretString:pw}}']];
      deleteRejection = () =>
        markNonRetryable(
          awsSdkError(`ValidationException: Value '${multiLine}' failed\n[ERROR] forged`)
        );

      const wrap = await provisionExpectingWrap(
        withoutBoundaryMask(makeEngine('recreate')),
        'recreate'
      );

      expect(wrap.message).toContain('Failed to destroy old resource Pipe (my-pipe)');
      expect(wrap.message).not.toContain('pem-line-one-2676');
      expect(wrap.message).not.toContain('pem-line-two-2676');
      // go-to-k/cdkd#2319: AWS's text is on the debug line now, masked whole.
      expect(debugLines().some((l) => l.includes(`Value '***' failed\n[ERROR] forged`))).toBe(true);
      expect(debugLines().some((l) => l.includes('pem-line-'))).toBe(false);
    });

    // go-to-k/cdkd#2676: the wrapped error's message is embedded as-is and
    // last, so a wrapped cdkd refusal keeps its remedy command on its own line.
    it('keeps a wrapped refusal\'s command line as the last line of the wrap (#2676)', async () => {
      deleteRejection = () =>
        markNonRetryable(
          new Error(
            "Pipe refused the delete.\nRe-adopt with:\ncdkd import '<stack>' --resource 'Pipe=my-pipe'"
          )
        );

      const wrap = await provisionExpectingWrap(
        withoutBoundaryMask(makeEngine('recreate')),
        'recreate'
      );

      const lines = wrap.message.split('\n');
      expect(lines[0]).toMatch(/^Failed to destroy old resource Pipe \(my-pipe\) during/);
      expect(lines.at(-2)).toBe('Re-adopt with:');
      expect(lines.at(-1)).toBe("cdkd import '<stack>' --resource 'Pipe=my-pipe'");
    });

    // go-to-k/cdkd#2676 review: a needle only the PRINTING bag holds (a
    // secret-derived name, #4741's previous NoEcho value) used to be masked
    // by `provisionResource`'s boundary mask on the raw text. The wrap now
    // flattens at construction, so it must mask with that bag itself.
    // Discriminating against the OUTER boundary mask (`provisionResource`'s
    // catch in provision.ts, which also calls `printingSecretsFor`): if the
    // stub answered the needle bag unconditionally, the boundary would mask
    // the needle too and hide a deleted printing-bag argument at THIS wrap
    // site. The bag is handed back only to a caller inside update-replace.ts
    // (the wrap site itself) — by CALLER, not by call order/count, since a
    // call-count stub would still answer the boundary's lone remaining call
    // if this site's own call were deleted, defeating the discrimination.
    it('masks a multi-line needle held only by the printing bag (#2676)', async () => {
      const multiLine = 'prev-noecho-one-2676\nprev-noecho-two-2676';
      deleteRejection = () =>
        markNonRetryable(awsSdkError(`Handler failed: '${multiLine}' is still referenced`));
      const engine = makeEngine('recreate');
      vi.mocked(printingSecretsFor).mockImplementation(() =>
        // Discriminates the wrap site's OWN call from the outer boundary
        // mask's call (`provisionResource`'s catch in provision.ts) by
        // caller, not by call order/count: a call-count stub would still
        // answer the boundary's lone remaining call if this site's own call
        // were deleted, which is exactly the gap this case probes for.
        (new Error().stack ?? '').includes('update-replace.ts')
          ? new Map([[multiLine, '{{resolve:secretsmanager:prev:SecretString:pw}}']])
          : undefined
      );

      const wrap = await provisionExpectingWrap(engine, 'recreate');

      expect(printingSecretsFor).toHaveBeenCalledWith(engine.secretsRun, 'Pipe');
      expect(wrap.message).toContain('Failed to destroy old resource Pipe (my-pipe)');
      expect(wrap.message).not.toContain('prev-noecho-one-2676');
      expect(wrap.message).not.toContain('prev-noecho-two-2676');
      // go-to-k/cdkd#2319: AWS's text is on the debug line now, masked with
      // the printing bag too.
      expect(debugLines().some((l) => l.includes(`Handler failed: '***' is still referenced`))).toBe(
        true
      );
      expect(debugLines().some((l) => l.includes('prev-noecho-'))).toBe(false);
    });
  });

  describe('replacement.ts: the --replace re-create wrap masks its embedded message (#2676)', () => {
    it('masks a multi-line secret in the re-create failure', async () => {
      const multiLine = 'pem-line-one-2676\npem-line-two-2676';
      secretsToRecord = [[multiLine, '{{resolve:secretsmanager:db:SecretString:pw}}']];
      // A provider's own wrap (cdkd-authored), whose text the message still
      // embeds; an AWS-authored one is named by its class (#2319, below).
      createFailures.push(
        collision(),
        new Error(`Failed to create Pipe: Value '${multiLine}' at 'Source' failed`)
      );

      const wrap = await provisionExpectingWrap(withoutBoundaryMask(makeEngine('replace')), 'replace');

      expect(wrap.message).toContain('Failed to re-create Pipe after the --replace');
      expect(wrap.message).toContain(`Value '***' at 'Source' failed`);
      expect(wrap.message).not.toContain('pem-line-one-2676');
      expect(wrap.message).not.toContain('pem-line-two-2676');
    });
  });

  // go-to-k/cdkd#2319: both fallback wraps are persisted, and an SDK error a
  // provider let escape names the caller's ARN on an access denial.
  describe('replacement.ts: the --replace delete-first fallback wraps name an AWS failure by its class (#2319)', () => {
    const DENIAL =
      'User: arn:aws:sts::123456789012:assumed-role/Deployer/s is denied pipes:DeletePipe';

    it('the delete wrap: class in the message, AWS text in debug, cause kept and stamped', async () => {
      const raw = markNonRetryable(awsSdkError(DENIAL, 'AccessDeniedException'));
      createFailures = [collision()];
      deleteRejection = () => raw;

      const wrap = await provisionExpectingWrap(makeEngine('replace'), 'replace');

      expect(wrap.message).toBe(
        'Failed to delete old resource Pipe (my-pipe) during the --replace delete-first ' +
          "fallback: AccessDeniedException. Re-run with --verbose for AWS's own message."
      );
      expect(wrap.cause).toBe(raw);
      expect(hasRedactedCause(wrap)).toBe(true);
      expect(debugLines().some((l) => l.includes('Failed to delete old resource') && l.includes(DENIAL))).toBe(true);
    });

    it('the re-create wrap: class in the message, masked AWS text in debug', async () => {
      secretsToRecord = [[SECRET, '{{resolve:secretsmanager:db:SecretString:pw}}']];
      createFailures = [
        collision(),
        markNonRetryable(awsSdkError(`${DENIAL} for ${SECRET}`, 'AccessDeniedException')),
      ];

      const wrap = await provisionExpectingWrap(withoutBoundaryMask(makeEngine('replace')), 'replace');

      expect(wrap.message).toContain(
        "Re-run the deploy to create it fresh. Cause: AccessDeniedException. Re-run with --verbose for AWS's own message."
      );
      expect(wrap.message).not.toContain('123456789012');
      expect(hasRedactedCause(wrap)).toBe(true);
      const line = debugLines().find((l) => l.includes('Failed to re-create Pipe'));
      expect(line).toContain(`${DENIAL} for ***`);
      expect(debugLines().some((l) => l.includes(SECRET))).toBe(false);
    });

    // #2676: a multi-line secret in the withheld AWS text is masked in the
    // debug line too, for both wraps.
    it.each([
      ['delete', 'Failed to delete old resource Pipe'],
      ['re-create', 'Failed to re-create Pipe'],
    ] as const)('masks a multi-line secret in the %s wrap debug line', async (wrapKind, head) => {
      const multiLine = 'pem-line-one-2676\npem-line-two-2676';
      secretsToRecord = [[multiLine, '{{resolve:secretsmanager:db:SecretString:pw}}']];
      const denial = () =>
        markNonRetryable(awsSdkError(`${DENIAL} for '${multiLine}'`, 'AccessDeniedException'));
      if (wrapKind === 'delete') {
        createFailures = [collision()];
        deleteRejection = denial;
      } else {
        createFailures = [collision(), denial()];
      }

      const wrap = await provisionExpectingWrap(withoutBoundaryMask(makeEngine('replace')), 'replace');

      expect(wrap.message).toContain('AccessDeniedException. Re-run with --verbose');
      const line = debugLines().find((l) => l.includes(head));
      expect(line).toContain(`${DENIAL} for '***'`);
      expect(debugLines().some((l) => l.includes('pem-line-one-2676'))).toBe(false);
      expect(debugLines().some((l) => l.includes('pem-line-two-2676'))).toBe(false);
    });

    it('keeps a cdkd-authored delete failure text, unstamped', async () => {
      createFailures = [collision()];
      deleteRejection = () => markNonRetryable(new Error('Failed to delete Pipe: still in use'));

      const wrap = await provisionExpectingWrap(makeEngine('replace'), 'replace');

      expect(wrap.message).toContain('delete-first fallback: Failed to delete Pipe: still in use');
      expect(hasRedactedCause(wrap)).toBe(false);
    });
  });
});
