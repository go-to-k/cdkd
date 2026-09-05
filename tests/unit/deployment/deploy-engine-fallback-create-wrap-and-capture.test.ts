/**
 * The update-failure replacement fallback's two review residues, both on the
 * SAME `catch (createError)` / post-create hunk of `DeployEngine`'s UPDATE
 * branch:
 *
 *  - issue [#2616](https://github.com/go-to-k/cdkd/issues/2616): the
 *    `!retainOldOnReplace` arm rethrew the provider's raw create error, with
 *    nothing saying the old resource had already been DELETED one block above.
 *    The `--replace` delete-first fallback (`replaceDeleteFirstAndRecreate`)
 *    already wraps the identical situation; this file pins that the two now
 *    say the same thing, that the `Retain` arm's issue #2518 collision
 *    translation is NOT re-wrapped, and that the wrap keeps the AWS rejection
 *    reachable as `cause`.
 *  - issue [#2608](https://github.com/go-to-k/cdkd/issues/2608): the
 *    observed-properties capture ran against `updateProvider` — the provider
 *    that FAILED the update — while the state record it had just written
 *    stamped the layer from the replacement's FRESH routing decision. The
 *    capture now moves in lockstep with that stamp.
 *
 * The fixture makes those two providers genuinely different objects with
 * different `readCurrentState` payloads, because "the capture happened" is a
 * confluence point both the fixed and the broken code produce — only WHICH
 * provider it ran against discriminates.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

/** What the engine's outer `ProvisioningError` carries as its `cause`. */
type InnerError = Error & { code?: string; cause?: unknown };

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
 * The resolver mock MUTATES the context's `recordedSecretValues` in place,
 * exactly as the real one does — that map is what the engine binds as
 * `updateSecrets`, and it is the only way a masking assertion can be written
 * without the real intrinsic resolver.
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
 * The Cloud Control "no UPDATE handler" prose, which
 * `isUpdateUnsupportedError` accepts as a top-level fallback. Reaching the
 * fallback off the REJECTION rather than off `--replace` is what keeps these
 * cases flag-free.
 */
const CC_UNSUPPORTED = 'Resource type AWS::Glue::SecurityConfiguration does not support UPDATE action';

/** A type with no data to lose, so the stateful guard never fires. */
const TYPE = 'AWS::Glue::SecurityConfiguration';

describe('the UPDATE-not-supported replacement fallback: create-failure wrap + observed capture', () => {
  /** The provider the UPDATE routes to — and, pre-#2608, the capture too. */
  let updateProvider: ResourceProvider & { readCurrentState: ReturnType<typeof vi.fn> };
  /** The provider the replacement's FRESH routing decision picks. */
  let replProvider: ResourceProvider & { readCurrentState: ReturnType<typeof vi.fn> };
  /** How the replacement's `create()` rejects; `undefined` means it succeeds. */
  let createRejection: (() => unknown) | undefined;
  /** How the old resource's `delete()` rejects; `undefined` means it succeeds. */
  let deleteRejection: (() => unknown) | undefined;
  let deleteCalls: string[];

  beforeEach(() => {
    secretsToRecord = [];
    createRejection = undefined;
    deleteRejection = undefined;
    deleteCalls = [];
    updateProvider = {
      create: vi.fn(),
      update: vi.fn().mockImplementation(async () => {
        throw new Error(CC_UNSUPPORTED);
      }),
      delete: vi.fn().mockImplementation(async (_lid: string, physicalId: string) => {
        deleteCalls.push(physicalId);
        if (deleteRejection) throw deleteRejection();
      }),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue({ readBy: 'update-provider' }),
    };
    replProvider = {
      create: vi.fn().mockImplementation(async () => {
        if (createRejection) throw createRejection();
        return { physicalId: 'new-pid', attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue({ readBy: 'repl-provider' }),
    };
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const mockProviderRegistry = {
      // The routing SPLIT this whole file rests on, in the direction PRODUCTION
      // can actually reach. The real registry
      // (`src/provisioning/provider-registry.ts`) is sticky on ONE value:
      // `provisionedBy: 'cc-api'` short-circuits to Cloud Control, while
      // `'sdk'` and absent both fall through to the same silent-drop check —
      // and both engine call sites pass the identical `resolvedProps`. So a
      // record stamped `'sdk'` can NEVER route differently from the
      // replacement's layer-less decision, and an earlier draft of this
      // fixture that split on `'sdk'` vs absent was pinning a pair the shipped
      // code cannot produce. The reachable #2608 scenario is the reverse: the
      // record is sticky `cc-api`, the replacement decision passes no recorded
      // layer, and the silent-drop check routes it to the SDK provider.
      getProviderFor: vi
        .fn()
        .mockImplementation((input: { provisionedBy?: 'sdk' | 'cc-api' }) =>
          input.provisionedBy === 'cc-api'
            ? { provider: updateProvider, provisionedBy: 'cc-api' as const }
            : { provider: replProvider, provisionedBy: 'sdk' as const }
        ),
      getProvider: vi.fn().mockReturnValue(updateProvider),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn() } as unknown as never,
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
      { captureObservedState: true },
      'us-east-1'
    );
  }

  async function invokeProvision(
    engine: InstanceType<typeof DeployEngine>,
    updateReplacePolicy?: 'Retain'
  ): Promise<Record<string, { physicalId: string; provisionedBy?: string }>> {
    const change: ResourceChange = {
      logicalId: 'MyResource',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { Mode: 'a' },
      desiredProperties: { Mode: 'b' },
      propertyChanges: [
        { path: 'Mode', oldValue: 'a', newValue: 'b', requiresReplacement: false },
      ],
    };
    const stateResources = {
      MyResource: {
        physicalId: 'old-pid',
        resourceType: TYPE,
        properties: { Mode: 'a' },
        attributes: {},
        dependencies: [],
        // Sticky Cloud Control: the ONLY recorded layer the real registry
        // short-circuits on, and therefore the only one that can disagree with
        // the replacement's layer-less re-decision.
        provisionedBy: 'cc-api' as const,
      },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        MyResource: {
          Type: TYPE,
          Properties: { Mode: 'a' },
          ...(updateReplacePolicy && { UpdateReplacePolicy: updateReplacePolicy }),
        },
      },
    };
    await (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate
        ) => Promise<void>;
      }
    ).provisionResource.bind(engine)('MyResource', change, stateResources, 'MyStack', template);
    return stateResources as unknown as Record<
      string,
      { physicalId: string; provisionedBy?: string }
    >;
  }

  /**
   * The engine's UPDATE branch wraps ANY escaping failure in a
   * `ProvisioningError('Failed to update resource <id>')` whose `cause` is the
   * error the branch actually raised — so every assertion below reads
   * `err.cause`, and the create rejection this file is about sits one link
   * deeper again at `err.cause.cause`.
   */
  function invokeExpectingFailure(
    engine: InstanceType<typeof DeployEngine>,
    updateReplacePolicy?: 'Retain'
  ): Promise<InnerError | null> {
    return invokeProvision(engine, updateReplacePolicy).then(
      () => null,
      (e) => (e as { cause?: unknown }).cause as InnerError
    );
  }

  describe('the create failure names the already-deleted old resource (issue #2616)', () => {
    it('wraps the DELETE-first arm: logical id, deleted physical id, cause text, re-run instruction', async () => {
      // Deliberately NOT an "is not authorized to perform" message: that
      // spelling is in the IAM-propagation retry table, so the create would
      // ride the full dense schedule before reaching the arm under test and
      // the case would fail as a timeout rather than an assertion.
      const raw = new Error('ValidationException: EncryptionConfiguration is invalid');
      createRejection = () => raw;

      const err = await invokeExpectingFailure(makeEngine());

      // The delete this message asserts actually ran — the claim in the text
      // is checked against the fixture, not just the fixture against the text.
      expect(deleteCalls).toEqual(['old-pid']);
      expect(err).not.toBeNull();
      expect(err!.message).toContain(
        'Failed to create MyResource after the UPDATE-not-supported replacement: the old resource (old-pid) is now gone.'
      );
      expect(err!.message).toContain('EncryptionConfiguration is invalid');
      expect(err!.message).toContain('Re-run the deploy to create it fresh.');
      // The discriminator against the pre-fix rethrow: `cause` is the ORIGINAL
      // provider error object, so `extractDeploymentEventError`'s bounded walk
      // still finds the AWS `$metadata` / `Code` the raw rethrow used to carry
      // straight to the persisted RESOURCE_FAILED event. A wrap with no cause
      // would pass every message assertion above and silently drop that.
      expect(err!.cause).toBe(raw);
    });

    it('names NO actor when the old resource was already gone before the delete', async () => {
      // The second sub-path into the same wrap: the delete rejects with a
      // not-found, the block's classifier reads it as "already gone", and the
      // create then fails. SOMETHING ELSE removed the resource here, so a
      // sentence whose subject is the replacement ("already deleted" /
      // "removed") is false. Two review rounds landed on the actor-free
      // wording; this is what stops a third from putting an actor back.
      deleteRejection = () => new Error('EntityNotFoundException: does not exist');
      createRejection = () => new Error('ValidationException: bad config');

      const err = await invokeExpectingFailure(makeEngine());

      expect(err).not.toBeNull();
      // The delete was ATTEMPTED and rejected — this arm was really taken.
      expect(deleteCalls).toEqual(['old-pid']);
      expect(err!.message).toContain('the old resource (old-pid) is now gone');
      // The claims the wording exists to avoid.
      expect(err!.message).not.toContain('replacement removed');
      expect(err!.message).not.toContain('already deleted');
    });

    it('puts no resolved-secret plaintext on the failure, wherever the mask runs', async () => {
      // The create was handed the RESOLVED `replProps`, so AWS can echo a
      // substituted secret in its rejection — the issue #2038 class.
      //
      // WHAT THIS PINS, corrected after the delta review MEASURED it: the
      // whole path emits no plaintext. It does NOT pin the CONSTRUCTION-time
      // mask, and the earlier wording here ("the masking has to happen at
      // construction") was false. Neutering `maskSecretsInText` at the wrap
      // leaves this green, and so does neutering only the downstream
      // `maskSecretsInError` at `provisionResource`'s boundary — the two sites
      // are mutually redundant, so neither is fenced by anything. Same
      // MEASURED UNFENCEABLE property `rollback-executor.ts` records for its
      // own wraps; the construction-time mask is kept as defense-in-depth so
      // the plaintext never exists inside a thrown `Error`, not because a test
      // holds it. Do not cite this case as coverage of the mask.
      secretsToRecord = [['s3cr3t-p4ssw0rd-value', '{{resolve:secretsmanager:db:SecretString:pw}}']];
      createRejection = () =>
        new Error(`ValidationException: Value 's3cr3t-p4ssw0rd-value' at 'config' failed`);

      const err = await invokeExpectingFailure(makeEngine());

      expect(err).not.toBeNull();
      expect(err!.message).not.toContain('s3cr3t-p4ssw0rd-value');
      // Positive half: the value was REPLACED, not merely absent — a wrap that
      // dropped the AWS text entirely would satisfy the negative alone. This
      // pair IS discriminating for "some reader masks"; it is only the WHICH
      // that is unfenceable.
      expect(err!.message).toContain(`Value '***' at 'config' failed`);
      // Still the #2616 sentence — masking must not have replaced the wrap.
      expect(err!.message).toContain('the old resource (old-pid) is now gone');
    });

    it('wraps a NAME COLLISION on the delete-first arm too — the Retain translation stays Retain-only', async () => {
      // The pre-#2616 comment reasoned that only `Retain` owes a translation
      // because only `Retain` makes the path create-FIRST. True for the
      // COLLISION verdict, and this pins that it stayed true: a collision here
      // gets the already-deleted sentence, never the "Retain pins that
      // resource in place" refusal, which would be a lie on a path that just
      // deleted the name holder.
      createRejection = () => new Error('Security configuration already exists: MyResource');

      const err = await invokeExpectingFailure(makeEngine());

      expect(err).not.toBeNull();
      expect(err!.message).toContain('the old resource (old-pid) is now gone');
      expect(err!.message).not.toContain('UpdateReplacePolicy: Retain pins');
      expect(err!.code).toBeUndefined();
    });

    it('leaves the Retain arm’s issue #2518 collision refusal untouched', async () => {
      createRejection = () => new Error('Security configuration already exists: MyResource');

      const err = await invokeExpectingFailure(makeEngine(), 'Retain');

      expect(err).not.toBeNull();
      expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
      // The other half of the same fence: Retain is create-ONLY, so nothing
      // was deleted and the #2616 sentence must NOT appear.
      expect(deleteCalls).toEqual([]);
      expect(JSON.stringify(err)).not.toContain('the old resource (old-pid) is now gone');
    });

    it('leaves a NON-collision Retain create failure as a raw rethrow', async () => {
      // The `Retain` arm's `if (!isNameCollisionError(createMsg)) throw
      // createError;` line. Nothing was deleted, so there is nothing to
      // announce — the #2616 wrap must not have widened to this arm.
      const raw = new Error('ValidationException: EncryptionConfiguration is invalid');
      createRejection = () => raw;

      const err = await invokeExpectingFailure(makeEngine(), 'Retain');

      // Identity, not a message match: a wrap carrying the same text would
      // pass a `toContain` and would be exactly the widening this pins out.
      expect(err).toBe(raw);
      expect(deleteCalls).toEqual([]);
    });
  });

  describe('the UPDATE-not-supported Retain arm records the retain verdict (issue #2603)', () => {
    // Coverage gap found by the test reviewer: three engine sites call
    // `retainedOldOnReplacement.add`, and only the property-driven one was
    // pinned — this arm and the `--recreate-via-*` one could both stop
    // recording with the whole suite green. Read through the PRIVATE Set
    // rather than the journal because `provisionResource` is invoked directly
    // here (the journal push lives one layer up in `doDeploy`); the
    // journal-side stamp has its own cases in
    // `deploy-engine-rollback-journal.test.ts`.
    const retainedSet = (engine: InstanceType<typeof DeployEngine>): Set<string> =>
      (engine as unknown as { retainedOldOnReplacement: Set<string> }).retainedOldOnReplacement;

    it('records the logical id when Retain makes the fallback create-ONLY', async () => {
      const engine = makeEngine();
      await invokeProvision(engine, 'Retain');
      expect([...retainedSet(engine)]).toEqual(['MyResource']);
      // The verdict and the fact must agree: nothing was deleted.
      expect(deleteCalls).toEqual([]);
    });

    it('records NOTHING when the same arm deletes the old resource', async () => {
      // The polarity that makes the case above discriminate: `false` is the
      // DROP direction's whole point, so an unconditional `add` would be as
      // wrong as a missing one.
      const engine = makeEngine();
      await invokeProvision(engine);
      expect([...retainedSet(engine)]).toEqual([]);
      expect(deleteCalls).toEqual(['old-pid']);
    });
  });

  describe('the observed capture runs against the layer state was stamped with (issue #2608)', () => {
    it('a re-routed replacement captures through the provider that CREATED the resource', async () => {
      const state = await invokeProvision(makeEngine());

      // The record names the replacement's fresh routing decision...
      expect(state['MyResource']?.physicalId).toBe('new-pid');
      expect(state['MyResource']?.provisionedBy).toBe('sdk');
      // ...and so does the capture. This is the whole discrimination: pre-fix
      // the capture ran on `updateProvider`, the STICKY `cc-api` provider that
      // just failed the update, against a record the replacement had stamped
      // `sdk`. (The polarity was the other way round in an earlier draft of
      // this fixture, which pinned a pair the real registry cannot produce.)
      expect(replProvider.readCurrentState).toHaveBeenCalledTimes(1);
      expect(updateProvider.readCurrentState).not.toHaveBeenCalled();
      // Read back through the NEW physical id, not the deleted one.
      expect(replProvider.readCurrentState).toHaveBeenCalledWith(
        'new-pid',
        'MyResource',
        TYPE,
        { Mode: 'b' },
        undefined
      );
    });

    it('a plain in-place update still captures through the update provider', async () => {
      // The call site is SHARED, so the fix had to be a per-path selection
      // rather than a blanket swap. Without this arm a `captureProvider`
      // hard-wired to `replProvider` would pass the case above.
      updateProvider.update = vi
        .fn()
        .mockResolvedValue({ physicalId: 'old-pid', wasReplaced: false });

      const state = await invokeProvision(makeEngine());

      expect(state['MyResource']?.provisionedBy).toBe('cc-api');
      expect(updateProvider.readCurrentState).toHaveBeenCalledTimes(1);
      expect(replProvider.readCurrentState).not.toHaveBeenCalled();
    });
  });
});
