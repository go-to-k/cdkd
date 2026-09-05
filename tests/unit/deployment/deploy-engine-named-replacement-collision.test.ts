import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

type StateRecord = {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  dependencies: string[];
  provisionedBy?: 'sdk' | 'cc-api';
};

/**
 * Custom-named resource requiring a property-driven replacement (issue #960
 * follow-up): the CFn-safe create-first order collides with the old resource
 * still holding the user-supplied name. Without --replace the deploy must
 * fail with the actionable NAMED_REPLACEMENT_COLLISION error (CloudFormation
 * parity: "cannot update a stack when a custom-named resource requires
 * replacing"); with --replace the engine falls back to delete-first and the
 * replacement proceeds under the same name.
 */
describe('DeployEngine — custom-named replacement collision', () => {
  let callOrder: string[];
  let provider: ResourceProvider;
  let createFailures: Error[];

  const TYPE = 'AWS::Pipes::Pipe'; // non-stateful: the stateful guard stays out of the way

  const alreadyExists = () =>
    new Error(
      "CREATE failed for Pipe: Resource of type 'AWS::Pipes::Pipe' with identifier 'my-pipe' already exists."
    );

  // SQS same-name re-creation cooldown in its error-CODE form.
  //
  // Choosing the code form used to be what made the cooldown test
  // discriminating: only `isNameCooldownError` matched it, while the wire
  // message ("wait 60 seconds") was ALSO in the generic transient table, so
  // the INNER generic retry would have absorbed it and the test could have
  // passed with the outer filter regressed to collision-only.
  //
  // Issue [#2116](https://github.com/go-to-k/cdkd/issues/2116) removed that
  // asymmetry on purpose — every cooldown spelling is now retryable on the
  // ordinary create path too, so BOTH forms reach the inner retry and no
  // message choice can isolate the outer filter any more. Measured rather
  // than assumed: with `isRecreateRetryableError` cut back to collision-only,
  // this whole suite stayed green (10/10). The discriminator therefore moved
  // to the PROVIDER — see `disableOuterRetry` in the cooldown test below.
  const queueDeletedRecently = () =>
    new Error('Failed to create SQS queue Pipe: AWS.SimpleQueueService.QueueDeletedRecently');

  // The SINGULAR spelling, which is what AWS Lambda actually raises
  // (`ResourceConflictException: Function already exist: <name>`, verified
  // live 2026-08-12 — issue #1625). Every other case in this suite uses the
  // PLURAL Pipes wording, so before the matcher was widened this shape
  // reached NEITHER the actionable refusal NOR the delete-first fallback:
  // the raw SDK error escaped and the replacement was unperformable by any
  // flag. Kept at the CONSUMER level rather than only in the matcher's own
  // unit test, because it is the consumer's behavior that regresses.
  const alreadyExistSingular = () =>
    new Error('Failed to create Lambda function Pipe: Function already exist: MyStack-Pipe');

  beforeEach(() => {
    callOrder = [];
    createFailures = [];
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        const failure = createFailures.shift();
        if (failure) throw failure;
        return { physicalId: 'my-pipe', attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(opts: { replace?: boolean } = {}): InstanceType<typeof DeployEngine> {
    const mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    return new DeployEngine(
      mockStateBackend as unknown as never,
      mockLockManager as unknown as never,
      mockDagBuilder as unknown as never,
      mockDiffCalculator as unknown as never,
      mockProviderRegistry as unknown as never,
      { ...(opts.replace !== undefined && { replace: opts.replace }) },
      'us-east-1'
    );
  }

  async function invokeProvision(
    engine: InstanceType<typeof DeployEngine>,
    { retain = false }: { retain?: boolean } = {}
  ): Promise<void> {
    const change: ResourceChange = {
      logicalId: 'Pipe',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { Name: 'my-pipe', Source: 'arn:a' },
      desiredProperties: { Name: 'my-pipe', Source: 'arn:b' },
      propertyChanges: [
        { path: 'Source', oldValue: 'arn:a', newValue: 'arn:b', requiresReplacement: true },
      ],
    };
    const stateResources: Record<string, StateRecord> = {
      Pipe: {
        physicalId: 'my-pipe',
        resourceType: TYPE,
        properties: { Name: 'my-pipe', Source: 'arn:a' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Pipe: {
          Type: TYPE,
          Properties: { Name: 'my-pipe', Source: 'arn:b' },
          ...(retain && { UpdateReplacePolicy: 'Retain' }),
        },
      },
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
    await provisionResource('Pipe', change, stateResources, 'MyStack', template);
  }

  it('fails with the actionable collision error without --replace (old resource untouched)', async () => {
    createFailures = [alreadyExists()];

    const err = await invokeProvision(makeEngine()).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/custom-named resource requires replacing/);
    expect(err!.cause?.message).toMatch(/rename the resource/i);
    expect(err!.cause?.message).toMatch(/cdkd deploy --replace/);
    // The safe create-first order left the old resource alive.
    expect(callOrder).toEqual(['create']);
  });

  // The SAME two behaviors over the SINGULAR spelling (#1625). Before the
  // matcher was widened these two cases threw the RAW SDK error instead: the
  // first without any of the actionable text, the second without ever
  // deleting the old name holder.
  it('fails with the actionable collision error for the SINGULAR spelling (#1625)', async () => {
    createFailures = [alreadyExistSingular()];

    const err = await invokeProvision(makeEngine()).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/custom-named resource requires replacing/);
    expect(err!.cause?.message).toMatch(/cdkd deploy --replace/);
    expect(callOrder).toEqual(['create']);
  });

  it('falls back to delete-first for the SINGULAR spelling under --replace (#1625)', async () => {
    createFailures = [alreadyExistSingular()];

    await invokeProvision(makeEngine({ replace: true }));

    expect(callOrder).toEqual(['create', 'delete', 'create']);
  });

  it('falls back to delete-first under --replace and re-creates under the same name', async () => {
    createFailures = [alreadyExists()];

    await invokeProvision(makeEngine({ replace: true }));

    // Collided create-first -> delete the old name holder -> re-create.
    expect(callOrder).toEqual(['create', 'delete', 'create']);
    expect(provider.delete).toHaveBeenCalledWith(
      'Pipe',
      'my-pipe',
      TYPE,
      { Name: 'my-pipe', Source: 'arn:a' },
      { expectedRegion: 'us-east-1', forceDataDelete: false }
    );
  });

  it('neither the create-first attempt nor the --replace delete-first re-create sets replayingState; both pass a masker-ONLY context (#1463 inverse fence)', async () => {
    // `CreateContext.replayingState` is the rollback executor's signal that a
    // create replays a cdkd STATE record, and a provider pre-flight refusal
    // DOWNGRADES to a warning when it is set. Both creates on this path are
    // template-driven, so neither may set it — the refusal has to stand where
    // the user can fix the input.
    //
    // Pinned by the context's EXACT key set, not by value: a reviewer injected
    // `{ replayingState: true }` at each deploy-engine create site and the full
    // suite stayed green, so nothing pinned this direction. This used to assert
    // `call.length === 3` — no 4th argument at all — which issue #1932 item 3
    // made impossible: every create site now carries a `maskSecrets` capability
    // so a provider warn cannot echo a resolved secret. Asserting the key set is
    // EXACTLY `['maskSecrets']` keeps the original fence's power (it fails on
    // `replayingState`, and on any OTHER field a future edit adds) while
    // admitting the one field that is deliberately universal.
    createFailures = [alreadyExists()];

    await invokeProvision(makeEngine({ replace: true }));

    const calls = vi.mocked(provider.create).mock.calls;
    // The collided create-first AND the post-delete re-create.
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toHaveLength(4);
      // Exactly the masker, nothing else. `replayingState` in here would mean a
      // template-driven replacement had started claiming to be a state replay.
      expect(Object.keys((call[3] ?? {}) as Record<string, unknown>)).toEqual(['maskSecrets']);
    }
  });

  it('refuses a same-name replacement under UpdateReplacePolicy: Retain even with --replace', async () => {
    createFailures = [alreadyExists()];

    const err = await invokeProvision(makeEngine({ replace: true }), { retain: true }).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/UpdateReplacePolicy: Retain pins that resource/);
    expect(callOrder).toEqual(['create']);
  });

  it('retries the re-create while an async delete releases the name (bounded collision retry)', async () => {
    // First create: collision (old holds the name). After the delete, the
    // SECOND create still collides once (async delete not settled), then
    // succeeds — the bounded collision retry absorbs the release window.
    createFailures = [alreadyExists(), alreadyExists()];

    await invokeProvision(makeEngine({ replace: true }));

    expect(callOrder).toEqual(['create', 'delete', 'create', 'create']);
  }, 15_000);

  it('retries the re-create through the SQS QueueDeletedRecently cooldown (issue #1206)', async () => {
    // First create: collision (old holds the name). After the delete-first
    // fallback, the re-create hits the SQS 60s same-name cooldown once, then
    // succeeds — the cooldown signature matches NEITHER the collision
    // detector NOR the old collision-only retry filter, so pre-fix this
    // failed fast with the old resource already gone.
    //
    // `disableOuterRetry` is what keeps this test pointed at the OUTER filter
    // now that #2116 has made every cooldown spelling retryable on the inner
    // generic path as well (see the `queueDeletedRecently` note above). It
    // makes `DeployEngine.withRetry` single-shot, so the only thing that can
    // absorb the cooldown is `isRecreateRetryableError` at the re-create site.
    // Without it this assertion passes with that filter cut back to
    // collision-only — measured, not assumed.
    provider.disableOuterRetry = true;
    createFailures = [alreadyExists(), queueDeletedRecently()];

    await invokeProvision(makeEngine({ replace: true }));

    expect(callOrder).toEqual(['create', 'delete', 'create', 'create']);
  }, 15_000);

  it('reports that the old resource is already gone when the re-create ultimately fails', async () => {
    const raw = new Error('AccessDenied: not authorized');
    createFailures = [alreadyExists(), raw];

    const err = await invokeProvision(makeEngine({ replace: true })).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string; cause?: unknown } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/already deleted the old resource/);
    expect(err!.cause?.message).toMatch(/AccessDenied/);
    // Issue #2616 chained the AWS rejection here so `extractDeploymentEventError`
    // can still walk to its `$metadata` / `Code` and the persisted
    // `RESOURCE_FAILED` event names the AWS failure. Unfenced until the review
    // of that PR: deleting the `cause` left 64 tests green, while the sibling
    // wrap in the UPDATE-not-supported fallback WAS pinned. Identity, not a
    // message match — the message already appears in the wrap's own text, so
    // only the object proves the chain survived.
    //
    // `toBe` holds because this fixture records NO secret:
    // `provisionResource`'s boundary masker clones the whole chain when the
    // bag is non-empty and a message changes, which would break identity. A
    // secret-bearing variant added to this file must assert on the chained
    // error's SHAPE (`$metadata` / `Code`) rather than its identity.
    expect(err!.cause?.cause).toBe(raw);
  });

  it('passes a NON-collision create failure through unchanged', async () => {
    createFailures = [new Error('AccessDenied: not authorized')];

    const err = await invokeProvision(makeEngine({ replace: true })).then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );

    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/AccessDenied/);
    expect(err!.cause?.message).not.toMatch(/custom-named/);
    expect(callOrder).toEqual(['create']);
  });
});
