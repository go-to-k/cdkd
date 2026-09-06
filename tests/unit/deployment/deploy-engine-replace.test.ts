/**
 * Unit coverage for the `--replace` engine wire-through.
 *
 * When a `provider.update()` hard-rejects an in-place update with a typed
 * `ResourceUpdateNotSupportedError` (an immutable property changed on a type
 * cdkd has no replacement rule for), the deploy engine's normal-update catch
 * block falls back to DELETE + CREATE — but ONLY when the user opted in via
 * `--replace`. Stateful types additionally require
 * `--force-stateful-recreation`.
 *
 * The happy path is verified end-to-end against real AWS by
 * `tests/integration/glue-securityconfig-replace/verify.sh` (a Glue
 * SecurityConfiguration whose EncryptionConfiguration change is immutable).
 * This file covers the branch logic a mocked test can assert cheaply:
 *   - replace=true + non-stateful type → DELETE then CREATE (in order).
 *   - replace unset → the ResourceUpdateNotSupportedError propagates (the
 *     pre-flag behavior: the deploy fails).
 *   - replace=true + stateful type WITHOUT forceStatefulRecreation → blocked
 *     with a STATEFUL_REPLACE_BLOCKED error, no delete/create issued.
 *   - replace=true + stateful type WITH forceStatefulRecreation → replaced.
 *
 * The same `catch` block has a SECOND trigger — the Cloud Control
 * "does not support UPDATE" auto-fallback, which needs no flag to reach the
 * replacement — and since issue #2514 it consults the same stateful guard. Its
 * own describe block at the bottom of this file covers both polarities.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { getLogger } from '../../../src/utils/logger.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../src/utils/error-handler.js';
import {
  isMarkedNonRetryable,
  isUpdateUnsupportedError,
} from '../../../src/deployment/retryable-errors.js';
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
  updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate';
};

describe('DeployEngine — --replace wire-through', () => {
  let callOrder: string[];
  let provider: ResourceProvider;
  /**
   * How the mocked `update()` rejects. Default: the typed
   * `ResourceUpdateNotSupportedError` an SDK provider raises (the `--replace`
   * trigger). The Cloud-Control arm's tests swap in a plain `Error` carrying
   * the wording the engine substring-matches, which is what makes the OTHER
   * trigger (`ccUnsupported`) fire — see the `#2514` describe below.
   */
  // Returns `unknown`, not `Error`: the engine reads the rejection through
  // `updateError instanceof Error ? … : String(updateError)` and chains it only
  // when it IS an `Error`, so a provider throwing a bare string has to be
  // expressible here to pin either branch.
  let updateRejection: (resourceType: string, logicalId: string) => unknown;

  beforeEach(() => {
    callOrder = [];
    updateRejection = (rt, logicalId) =>
      new ResourceUpdateNotSupportedError(
        rt,
        logicalId,
        'immutable on AWS — there is no update API; replacement required'
      );
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        return { physicalId: 'new-pid', attributes: {} };
      }),
      update: vi.fn().mockImplementation(async (logicalId: string, _p: string, rt: string) => {
        callOrder.push('update');
        throw updateRejection(rt, logicalId);
      }),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(opts: {
    replace?: boolean;
    forceStatefulRecreation?: boolean;
  }): InstanceType<typeof DeployEngine> {
    const mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
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
      getProviderFor: vi
        .fn()
        .mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
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
      {
        ...(opts.replace !== undefined && { replace: opts.replace }),
        ...(opts.forceStatefulRecreation !== undefined && {
          forceStatefulRecreation: opts.forceStatefulRecreation,
        }),
      },
      'us-east-1'
    );
  }

  async function invokeProvision(
    engine: InstanceType<typeof DeployEngine>,
    resourceType: string,
    // The template type's own union — narrower than `ResourceState`'s, which
    // also carries 'RetainExceptOnCreate'.
    updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot',
    // What the LAST deploy recorded, which is a different question from what
    // the template being applied says. Separate parameter so a test can make
    // the two disagree.
    recordedUpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate',
    // The three property bags the guard could plausibly be reading, made
    // INDEPENDENT so a test can tell them apart. The engine passes
    // `currentProps` — the RECORDED bag — to `isStatefulRecreateTargetForReplace`,
    // and every other candidate (`{}`, the desired bag, the change's own
    // `desiredProperties`) is a live mis-wiring a type-keyed fixture cannot
    // see: `AWS::DynamoDB::Table` / `AWS::S3::Bucket` / `AWS::Glue::SecurityConfiguration`
    // answer the same verdict whatever bag they are handed. `AWS::Logs::LogGroup`
    // is the discriminator — stateful iff the bag it reads carries
    // `RetentionInDays > 0` — so these two knobs let a test put the retention
    // in exactly one bag and pin which one the guard consulted.
    // `observed` is the state record's `observedProperties` -- a THIRD
    // independent bag since issue #2521, so a test can put the retention in
    // exactly the bag it means and pin which of the two recorded bags the
    // guard consulted. Left undefined by default, which is what every
    // pre-#2521 case here described.
    bags?: {
      recorded?: Record<string, unknown>;
      desired?: Record<string, unknown>;
      observed?: Record<string, unknown>;
    },
    // The recorded physical id. Overridable because `replacementNameOrigin`
    // classifies it against `${stackName}-${logicalId}` — the default is a
    // name no derivation produces, so it takes the user-supplied branch, and a
    // test wanting the GENERATED branch passes the derived form inside a
    // `withStackName` scope.
    physicalId = 'old-pid'
    // Returns the state record map the engine wrote into, so a test can assert
    // what the deploy PERSISTED (which physical id survived, which template
    // attributes were carried) rather than only which provider calls ran.
  ): Promise<Record<string, StateRecord>> {
    const recordedProps = bags?.recorded ?? { Mode: 'a' };
    const desiredProps = bags?.desired ?? { Mode: 'b' };
    const change: ResourceChange = {
      logicalId: 'MyResource',
      changeType: 'UPDATE',
      resourceType,
      currentProperties: recordedProps,
      desiredProperties: desiredProps,
      // No requiresReplacement — the in-place update is attempted, throws,
      // and only --replace turns the typed rejection into a replacement. The
      // path is derived from the recorded bag rather than hard-coded `Mode`,
      // so a test supplying its own bags does not describe a change to a key
      // neither bag contains. Nothing on this path reads the path (it matters
      // only when `requiresReplacement` is true), but a fixture that
      // contradicts itself is one a later reader has to re-derive.
      propertyChanges: [
        {
          path: Object.keys(recordedProps)[0] ?? 'Mode',
          oldValue: Object.values(recordedProps)[0] ?? 'a',
          newValue: Object.values(desiredProps)[0] ?? 'b',
          requiresReplacement: false,
        },
      ],
    };
    const stateResources: Record<string, StateRecord> = {
      MyResource: {
        physicalId,
        resourceType,
        properties: recordedProps,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
        ...(bags?.observed !== undefined && { observedProperties: bags.observed }),
        ...(recordedUpdateReplacePolicy !== undefined && {
          updateReplacePolicy: recordedUpdateReplacePolicy,
        }),
      },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        MyResource: {
          Type: resourceType,
          Properties: { Mode: 'a' },
          ...(updateReplacePolicy !== undefined && { UpdateReplacePolicy: updateReplacePolicy }),
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
    await provisionResource('MyResource', change, stateResources, 'MyStack', template);
    return stateResources;
  }

  it('replace=true on a non-stateful type falls back to DELETE then CREATE', async () => {
    const engine = makeEngine({ replace: true });
    await invokeProvision(engine, 'AWS::Glue::SecurityConfiguration');
    expect(callOrder).toEqual(['update', 'delete', 'create']);
  });

  it('the update-failure replacement create passes a masker-ONLY context, never replayingState (#1463 inverse fence)', async () => {
    // `CreateContext.replayingState` is the rollback executor's signal that a
    // create replays a cdkd STATE record, and a provider pre-flight refusal
    // DOWNGRADES to a warning when it is set. This arm is template-driven, so
    // it must never set it — the refusal has to stand where the user can fix
    // the input.
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
    const engine = makeEngine({ replace: true });
    await invokeProvision(engine, 'AWS::Glue::SecurityConfiguration');
    const calls = vi.mocked(provider.create).mock.calls;
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call).toHaveLength(4);
      // Exactly the masker, nothing else. `replayingState` in here would mean a
      // template-driven replacement had started claiming to be a state replay.
      expect(Object.keys((call[3] ?? {}) as Record<string, unknown>)).toEqual(['maskSecrets']);
    }
  });

  it('without --replace the ResourceUpdateNotSupportedError propagates (deploy fails)', async () => {
    const engine = makeEngine({});
    // provisionResource wraps the provider failure in a ProvisioningError; the
    // original typed rejection survives on `.cause`.
    const err = await invokeProvision(engine, 'AWS::Glue::SecurityConfiguration').then(
      () => null,
      (e) => e as Error & { cause?: unknown }
    );
    expect(err).not.toBeNull();
    expect(err!.cause).toBeInstanceOf(ResourceUpdateNotSupportedError);
    // No delete/create attempted — only the failed update.
    expect(callOrder).toEqual(['update']);
  });

  it('replace=true on a STATEFUL type is blocked without --force-stateful-recreation', async () => {
    const engine = makeEngine({ replace: true });
    const err = await invokeProvision(engine, 'AWS::DynamoDB::Table').then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );
    expect(err).not.toBeNull();
    // The block message (carried on `.cause`) names the escape-hatch flag.
    expect(err!.cause?.message).toMatch(/--force-stateful-recreation/);
    // The destructive delete/create must NOT run.
    expect(callOrder).toEqual(['update']);
  });

  it('replace=true + --force-stateful-recreation replaces a stateful type', async () => {
    const engine = makeEngine({ replace: true, forceStatefulRecreation: true });
    await invokeProvision(engine, 'AWS::DynamoDB::Table');
    expect(callOrder).toEqual(['update', 'delete', 'create']);
    // The consent must reach the provider's data guard (issue #1340): the
    // replacement delete carries forceDataDelete: true so S3/ECR force-cleanup
    // is authorized by the flag the user explicitly passed.
    expect(provider.delete).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ forceDataDelete: true })
    );
  });

  it('replace=true on an S3 bucket is blocked without --force-stateful-recreation (no mid-deploy probe)', async () => {
    // The --replace guard cannot run the async ListObjectVersions probe, so a
    // deferred S3 bucket is treated conservatively as data-bearing.
    const engine = makeEngine({ replace: true });
    const err = await invokeProvision(engine, 'AWS::S3::Bucket').then(
      () => null,
      (e) => e as Error & { cause?: { message?: string } }
    );
    expect(err).not.toBeNull();
    expect(err!.cause?.message).toMatch(/--force-stateful-recreation/);
    expect(callOrder).toEqual(['update']);
  });

  describe('the Cloud Control auto-fallback consults the same stateful guard (issue #2514)', () => {
    // This arm is reached off the update REJECTION, not off a flag. Since
    // issue #2520 the engine classifies it with `isUpdateUnsupportedError`,
    // which reads the exception NAME down the bounded cause chain and keeps
    // AWS's prose as a TOP-LEVEL-only fallback. Both accepted shapes are
    // pinned below — a fence for one says nothing about the other.
    //
    // Neither is invented. Probing Cloud Control on 2026-09-04 with `aws
    // cloudcontrol update-resource --type-name AWS::DocDB::DBCluster` (a type
    // whose `ProvisioningType` is `NON_PROVISIONABLE`, so it ships no UPDATE
    // handler) answered an error whose `name` is `UnsupportedActionException`
    // and whose `message` is `Resource type AWS::DocDB::DBCluster does not
    // support UPDATE action` — the name is NOT repeated in the message.
    // `CloudControlProvider.handleError` then wraps it in a
    // `ProvisioningError`, interpolating `err.message` only and passing the
    // raw error as `cause`.
    //
    // Fixture 1 is that full production object graph: the wrapper AND its
    // cause. It is what makes the STRUCTURED read load-bearing — the wrapper's
    // own message carries no name, so only the cause link can supply it.
    // Fixture 2 is the flat prose a provider could rethrow, which the
    // top-level fallback still accepts.
    //
    // The shape that is deliberately GONE is the exception name quoted inside
    // a message (`Error: UnsupportedActionException: ...`): the pre-#2520
    // predicate accepted it, nothing cdkd produces emits it, and its negative
    // is pinned in `tests/unit/deployment/retryable-errors.test.ts`.
    const CC_UNSUPPORTED_REJECTIONS: ReadonlyArray<readonly [string, () => unknown]> = [
      [
        "production's object graph: handleError's wrapper over the named cause",
        () => {
          const raw = new Error(
            'Resource type AWS::DynamoDB::Table does not support UPDATE action'
          );
          raw.name = 'UnsupportedActionException';
          return new ProvisioningError(
            'Resource type AWS::DynamoDB::Table is not supported by Cloud Control API and no ' +
              'SDK provider is registered.\nPlease report this issue at ' +
              'https://github.com/go-to-k/cdkd/issues so we can add SDK provider support.\n' +
              `Error: ${raw.message}`,
            'AWS::DynamoDB::Table',
            'MyResource',
            'old-pid',
            raw
          );
        },
      ],
      [
        "AWS's prose, flat at the top level — the retained fallback",
        () => new Error('Resource type AWS::DynamoDB::Table does not support UPDATE action'),
      ],
    ];

    function rejectWith(message: string): void {
      updateRejection = () => new Error(message);
    }

    for (const [label, makeRejection] of CC_UNSUPPORTED_REJECTIONS) {
      it(`blocks a STATEFUL type with no flags at all — ${label}`, async () => {
        updateRejection = makeRejection;
        // Neither --replace nor --force-stateful-recreation: exactly the plain
        // `cdkd deploy` that used to DELETE + CREATE a DynamoDB table.
        const engine = makeEngine({});
        const err = await invokeProvision(engine, 'AWS::DynamoDB::Table').then(
          () => null,
          (e) => e as Error & { cause?: { message?: string; code?: string } }
        );
        expect(err).not.toBeNull();
        expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
        expect(err!.cause?.message).toMatch(/--force-stateful-recreation/);
        // The destructive half must not have run: the guard sits ABOVE both
        // the snapshot preparation and the delete.
        expect(provider.delete).not.toHaveBeenCalled();
        expect(provider.create).not.toHaveBeenCalled();
        expect(callOrder).toEqual(['update']);
      });
    }

    it('blocks an S3 bucket conservatively (no mid-deploy object-count probe)', async () => {
      rejectWith('Resource type AWS::S3::Bucket does not support UPDATE action');
      const engine = makeEngine({});
      const err = await invokeProvision(engine, 'AWS::S3::Bucket').then(
        () => null,
        (e) => e as Error & { cause?: { message?: string; code?: string } }
      );
      expect(err).not.toBeNull();
      expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
      expect(provider.delete).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['update']);
    });

    it('still auto-replaces a NON-stateful type with no flags (the fallback itself is unchanged)', async () => {
      // The other polarity. Hoisting the guard must not turn the CC
      // auto-fallback into a `--replace`-gated path: a Glue
      // SecurityConfiguration carries no data, so it replaces exactly as
      // before, with no flag.
      rejectWith(
        'Resource type AWS::Glue::SecurityConfiguration does not support UPDATE action'
      );
      const engine = makeEngine({});
      await invokeProvision(engine, 'AWS::Glue::SecurityConfiguration');
      expect(callOrder).toEqual(['update', 'delete', 'create']);
    });

    it('--force-stateful-recreation ALONE (no --replace) lets a stateful type through and carries the consent to the delete', async () => {
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const engine = makeEngine({ forceStatefulRecreation: true });
      await invokeProvision(engine, 'AWS::DynamoDB::Table');
      expect(callOrder).toEqual(['update', 'delete', 'create']);
      expect(provider.delete).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ forceDataDelete: true })
      );
    });

    it('names the trigger the user actually hit — the CC arm never tells them to pass --replace', async () => {
      // The two arms must not share one message: `--replace` does not gate
      // this path, so advising it would send the user to a flag that changes
      // nothing. Asserted as a DIFFERENCE against the --replace arm's own
      // message so a future edit collapsing the two goes red.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const ccErr = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table').then(
        () => null,
        (e) => e as Error & { cause?: { message?: string } }
      );
      expect(ccErr!.cause?.message).toMatch(/cannot be updated in place by the provisioning layer/);
      expect(ccErr!.cause?.message).not.toMatch(/--replace/);
      // And the message must not satisfy the very predicate that routed us
      // here: `ccUnsupported` substring-matches the update error's message, so
      // a message containing either trigger phrase would re-fire the fallback
      // if it were ever re-thrown through an update. Neither substring, both
      // spelled out — a future reword back to "does not support UPDATE" reds.
      expect(ccErr!.cause?.message).not.toContain('does not support UPDATE');
      expect(ccErr!.cause?.message).not.toContain('UnsupportedActionException');

      callOrder = [];
      updateRejection = (rt, logicalId) => new ResourceUpdateNotSupportedError(rt, logicalId);
      const replaceErr = await invokeProvision(
        makeEngine({ replace: true }),
        'AWS::DynamoDB::Table'
      ).then(
        () => null,
        (e) => e as Error & { cause?: { message?: string } }
      );
      expect(replaceErr!.cause?.message).toMatch(/--replace would DELETE \+ CREATE/);
    });

    it('EXEMPTS a stateful type under UpdateReplacePolicy: Retain, retaining the old resource (issue #2518)', async () => {
      // The asymmetry #2518 closed: the property-driven replacement guard
      // EXEMPTS `Retain` because that path creates first and orphans the old
      // resource, while this fallback used to delete unconditionally a few
      // lines below the guard — so the SAME template attribute decided
      // retention on one path and nothing on the other.
      //
      // Now both paths retain. A stateful DynamoDB table declaring `Retain` is
      // therefore replaced with NO consent flag, because the replacement
      // destroys nothing: demanding `--force-stateful-recreation` here would
      // have been a refusal whose only remedy deletes the resource the user
      // explicitly asked to keep.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain');
      // The behavioural half, not just the absence of a throw: NO delete at
      // all, and the create still ran. A guard that merely stopped refusing
      // would show `['update', 'delete', 'create']` here.
      expect(callOrder).toEqual(['update', 'create']);
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('deletes the old resource when the template declares NO Retain (the exemption is conditional)', async () => {
      // The other polarity of the same knob, on the type whose verdict the
      // exemption changes. Without it, an exemption that fired unconditionally
      // — `retainOldOnReplace = true` — would satisfy the case above while
      // silently leaking every replaced resource.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      await invokeProvision(makeEngine({ forceStatefulRecreation: true }), 'AWS::DynamoDB::Table');
      expect(callOrder).toEqual(['update', 'delete', 'create']);
    });

    it('reads Retain from the TEMPLATE for the retain decision too, not from the state record', async () => {
      // The exemption asks the same template-only question the refusal note
      // used to: a policy the previous deploy applied but the template being
      // applied has DROPPED must not keep a resource alive that the user has
      // stopped asking to keep. State says Retain, template says nothing.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const err = await invokeProvision(
        makeEngine({}),
        'AWS::DynamoDB::Table',
        undefined,
        'Retain'
      ).then(
        () => null,
        (e) => e as Error & { cause?: { code?: string } }
      );
      expect(err).not.toBeNull();
      expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('a state-recorded Snapshot does not resurrect the delete under a template Retain', async () => {
      // A FIXTURE case, and it says so rather than claiming a fence it does not
      // provide. Its value is the input combination — the one place a state
      // record carries `Snapshot` while the template applies `Retain`, i.e.
      // the only fixture where the snapshot read's `?? currentResource
      // .updateReplacePolicy` fallback has anything to fall back TO.
      //
      // Two claims earlier revisions made here were MEASURED false and are
      // recorded so they are not re-made. (1) Hoisting
      // `prepareFinalSnapshotForDelete` above the retain branch does not red
      // it: that call reads the TEMPLATE first, the template says `Retain`,
      // and the helper returns `undefined` for anything that is not
      // `Snapshot`, so the hoist produces no observable. (2) Swapping
      // `retainOldOnReplace`'s template-only read for a state read does not
      // make this case DELETE — with `retainOldOnReplace` false the stateful
      // guard refuses first and `callOrder` is `['update']`. Measured on that
      // mutation: 14 of this file's 40 cases fail, i.e. 13 siblings besides
      // this one — the whole Retain arm, of which only two state the
      // template-only rule by name. So no single-edit mutation reds this case
      // ALONE; it is coverage of an INPUT, not of a branch.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain', 'Snapshot');
      expect(callOrder).toEqual(['update', 'create']);
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('refuses with NAMED_REPLACEMENT_COLLISION when the retained resource still holds the name', async () => {
      // Retaining makes this create-FIRST, so a physical name the retained old
      // resource still holds can never be reused — the same verdict, and the
      // same error code, the property-driven create-first path already
      // reaches. The failure has to be LOUD and name the cause: without the
      // translation the user sees a bare `AlreadyExists` with no link to the
      // policy that produced it.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      vi.mocked(provider.create).mockImplementation(async () => {
        callOrder.push('create');
        throw new Error('Table already exists: my-table');
      });
      const err = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain').then(
        () => null,
        (e) => e as Error & { cause?: { message?: string; code?: string } }
      );
      expect(err).not.toBeNull();
      expect(err!.cause?.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(err!.cause?.message).toMatch(/UpdateReplacePolicy: Retain pins that resource/);
      // The remedy must be actionable AND honest about its cost — dropping
      // Retain is the only way forward and it destroys the old resource.
      expect(err!.cause?.message).toMatch(/Removing UpdateReplacePolicy: Retain/);
      // Nothing destructive ran on the way to the refusal.
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('marks both Retain refusals non-retryable, and chains the create rejection on the collision one', async () => {
      // Both interpolate a template-controlled logical id (and, on the
      // collision arm, the AWS collision text riding on `cause`) into exactly
      // what the substring-matching retry classifiers read — and
      // `isNameCooldownError`'s spellings ARE retryable, so an unmarked
      // refusal carrying one would burn the full 64s schedule on a path that
      // cannot succeed. The chain is what makes the refusal diagnosable, and
      // it is safe only because the marker is consulted before any chain-text
      // classification.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      vi.mocked(provider.create).mockImplementation(async () => {
        callOrder.push('create');
        throw new Error('Table already exists: my-table');
      });
      const collision = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain').then(
        () => null,
        (e) => e as Error & { cause?: Error & { cause?: Error; code?: string } }
      );
      expect(collision!.cause?.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(isMarkedNonRetryable(collision!.cause!)).toBe(true);
      expect(collision!.cause?.cause?.message).toBe('Table already exists: my-table');

      callOrder = [];
      vi.mocked(provider.create).mockImplementation(async () => {
        callOrder.push('create');
        return { physicalId: 'old-pid', attributes: {} };
      });
      const idempotent = await invokeProvision(
        makeEngine({}),
        'AWS::DynamoDB::Table',
        'Retain'
      ).then(
        () => null,
        (e) => e as Error & { cause?: Error & { cause?: unknown; code?: string } }
      );
      expect(idempotent!.cause?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
      expect(isMarkedNonRetryable(idempotent!.cause!)).toBe(true);
      // Nothing to chain: the create SUCCEEDED and returned the wrong id.
      // Asserted so a future edit cannot put a non-Error on `cause`, where
      // `formatError` would read `.message` off it and render `undefined`.
      expect(idempotent!.cause?.cause).toBeUndefined();
    });

    it('neither Retain refusal can re-fire the fallback it was raised from', async () => {
      // `isUpdateUnsupportedError` reads the exception NAME down the cause
      // chain since issue #2520, and the collision refusal now CHAINS the
      // create rejection — so the pre-#2520 guarantee that a refusal cannot
      // satisfy its own trigger has to be re-established against the new
      // predicate rather than assumed from the old message check.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      vi.mocked(provider.create).mockImplementation(async () => {
        callOrder.push('create');
        throw new Error('Table already exists: my-table');
      });
      const err = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain').then(
        () => null,
        (e) => e as Error
      );
      expect(isUpdateUnsupportedError(err!, 'MyResource')).toBe(false);
      expect(isUpdateUnsupportedError(err!.cause as Error, 'MyResource')).toBe(false);
    });

    it('leaves a NON-Retain create failure completely alone — the translation is Retain-only', async () => {
      // The guard the reviewer found unpinned, and its consequence is not
      // cosmetic. On the NON-Retain path the old resource has ALREADY been
      // deleted by the time the create runs, so an `AlreadyExists` there is a
      // name-cooldown the retry layer is built to ride out. Dropping the
      // `if (!retainOldOnReplace) throw createError` line would rewrite it into
      // a refusal asserting "UpdateReplacePolicy: Retain pins that resource in
      // place" — false — and `markNonRetryable` it, turning a retryable
      // cooldown into a permanent failure. Every OTHER create-override case in
      // this file sits on the Retain path, so nothing watched this direction.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      vi.mocked(provider.create).mockImplementation(async () => {
        callOrder.push('create');
        throw new Error('Table already exists: my-table');
      });
      const err = await invokeProvision(
        makeEngine({ forceStatefulRecreation: true }),
        'AWS::DynamoDB::Table'
      ).then(
        () => null,
        (e) => e as Error & { cause?: Error & { code?: string } }
      );
      expect(err).not.toBeNull();
      // The raw AWS text survives, untranslated and unmarked.
      expect(err!.cause?.code).not.toBe('NAMED_REPLACEMENT_COLLISION');
      expect(err!.cause?.message).toContain('Table already exists: my-table');
      expect(err!.cause?.message).not.toMatch(/UpdateReplacePolicy: Retain/);
      expect(isMarkedNonRetryable(err!.cause!)).toBe(false);
      // And the delete DID run first, which is what makes this the cooldown
      // shape rather than the collision one.
      expect(callOrder).toEqual(['update', 'delete', 'create']);
    });

    it('WARNS that the retained resource is untracked and still costing money', async () => {
      // The LEVEL is the assertion, not just the text. This arm fires on
      // `ccUnsupported` alone — no flag, no diff signal — so a plain
      // `cdkd deploy` can leave a second live cluster behind; an `info` line
      // scrolls away on a green deploy, which is how a leak this surprising
      // goes unnoticed. The `--recreate-via-*` sibling already warns with the
      // same `⚠` shape for the strictly LESS surprising version of the same
      // leak, so a `logger.info` here would have been the quieter half of the
      // pair. Both polarities, so a warn that fired unconditionally reds too.
      //
      // The logger mock is a module-level singleton and nothing clears it
      // between cases, so an unclear'd read sees every earlier case's lines.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      vi.mocked(getLogger().info).mockClear();
      vi.mocked(getLogger().warn).mockClear();
      await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain');
      const info = vi.mocked(getLogger().info).mock.calls.map((c) => String(c[0]));
      const warn = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      expect(info.some((l) => l.includes('CREATE only — UpdateReplacePolicy: Retain'))).toBe(true);
      // On WARN, carrying the survivor's id and both consequences a user has
      // to act on: it costs money, and `cdkd destroy` will not clean it up.
      const leak = warn.find((l) => l.includes('UpdateReplacePolicy: Retain'));
      expect(leak).toBeDefined();
      expect(leak).toContain('⚠');
      expect(leak).toContain('old-pid');
      expect(leak).toContain('no longer');
      expect(leak).toContain('incurring cost');
      expect(leak).toContain('cdkd destroy');
      // ...and NOT on info, which is the half that would silently pass if the
      // level were downgraded back.
      expect(info.some((l) => l.includes('incurring cost'))).toBe(false);

      vi.mocked(getLogger().info).mockClear();
      vi.mocked(getLogger().warn).mockClear();
      callOrder = [];
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      await invokeProvision(makeEngine({ forceStatefulRecreation: true }), 'AWS::DynamoDB::Table');
      const plainInfo = vi.mocked(getLogger().info).mock.calls.map((c) => String(c[0]));
      const plainWarn = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      // The arm is bounded before its negative: without this, "no leak
      // warning" would also pass for a deploy that never reached the fallback.
      expect(callOrder).toEqual(['update', 'delete', 'create']);
      expect(plainWarn.some((l) => l.includes('UpdateReplacePolicy: Retain'))).toBe(false);
      expect(plainInfo.some((l) => l.includes('replacing (DELETE → CREATE)'))).toBe(true);
    });

    it('reports the retain arm as a PARTIAL update, so the run summary is not byte-identical to a clean one', async () => {
      // `updatePartial`'s own contract is this exact shape — "updated, but
      // something the update owned survives untracked" (issue #1819) — and
      // without it `updatePartialReason(result)` is `undefined`, the row prints
      // `updated`, the summary counts it under `updated`, and a run that left a
      // live cluster behind is indistinguishable from one that did not.
      //
      // Asserted through the rendered STATUS LINE — `updatePartialMessage`'s
      // `partial (<reason>)`, emitted at warn — because that is the artifact
      // `updatePartialReason` actually drives, and it carries the survivor's
      // id, which is the datum a user needs to clean up. Reading the result
      // object instead would assert the field rather than its consumption.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      vi.mocked(getLogger().warn).mockClear();
      vi.mocked(getLogger().info).mockClear();
      await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain');
      const warn = vi.mocked(getLogger().warn).mock.calls.map((c) => String(c[0]));
      const row = warn.find((l) => l.includes('partial ('));
      expect(row).toBeDefined();
      expect(row).toContain('old-pid');
      expect(row).toContain('UpdateReplacePolicy: Retain');
      // The row still names the resource as UPDATED — `partial` qualifies the
      // update, it does not replace it, and calling it `skipped` would put the
      // line at odds with the event store's own invariant.
      expect(row).toContain('MyResource');
      // ...and the clean `updated` status row must NOT also have been printed,
      // or the run prints both readings of the same resource. Scoped to the
      // row shape (`formatResourceLine('updated', ...)`) rather than to the
      // logical id, which the fallback's own progress lines also carry.
      expect(
        vi
          .mocked(getLogger().info)
          .mock.calls.map((c) => String(c[0]))
          .filter((l) => /\bupdated\b/.test(l) && l.includes('MyResource'))
      ).toEqual([]);

      // The other polarity, and the one that kills an unconditional `partial`:
      // a replacement that DELETED the old resource left nothing untracked, so
      // it must still read as a clean update.
      callOrder = [];
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      vi.mocked(getLogger().warn).mockClear();
      await invokeProvision(makeEngine({ forceStatefulRecreation: true }), 'AWS::DynamoDB::Table');
      expect(callOrder).toEqual(['update', 'delete', 'create']);
      expect(
        vi
          .mocked(getLogger().warn)
          .mock.calls.map((c) => String(c[0]))
          .some((l) => l.includes('partial ('))
      ).toBe(false);
    });

    describe('both Retain refusals name the ORIGIN of the physical name (issue #1636 class)', () => {
      // Measured unpinned before this block: deleting
      // `${nameOrigin.descriptor}. ${nameOrigin.remedy} ` from EITHER refusal
      // left all of this file's cases green. The existing coverage
      // (`deploy-engine-collision-name-origin.test.ts`) reaches only the
      // property-driven create-first sites, so the two Retain refusals
      // inherited the interpolation with nothing watching it.
      //
      // The negative is the load-bearing half, and it is the #1636 bug
      // exactly: telling a user their template supplies a name it does not,
      // for a name cdkd itself derived, leaves them nothing to search for.
      const STACK = 'MyStack';
      // `looksLikeCdkdGeneratedName` skeletonises `${stackName}-${logicalId}`,
      // so this is the derivation for logical id `MyResource` in `MyStack`.
      const GENERATED_PID = 'MyStack-MyResource';

      function collideOnCreate(): void {
        vi.mocked(provider.create).mockImplementation(async () => {
          callOrder.push('create');
          throw new Error('Table already exists');
        });
      }

      it('the COLLISION refusal quotes a user-supplied name as user-supplied', async () => {
        rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
        collideOnCreate();
        const err = await invokeProvision(
          makeEngine({}),
          'AWS::DynamoDB::Table',
          'Retain'
        ).then(
          () => null,
          (e) => e as Error & { cause?: { message?: string; code?: string } }
        );
        expect(err!.cause?.code).toBe('NAMED_REPLACEMENT_COLLISION');
        expect(err!.cause?.message).toMatch(/user-supplied physical name \(old-pid\)/);
        expect(err!.cause?.message).toMatch(/rename the resource in your CDK code/);
        expect(err!.cause?.message).not.toMatch(/GENERATED by cdkd/);
      });

      it('the COLLISION refusal says GENERATED for a name cdkd derived, and never claims the user supplied it', async () => {
        // Inside a `withStackName` scope, which is what the classifier reads —
        // without it every case takes the unresolvable branch and this one
        // would pass for the wrong reason.
        rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
        collideOnCreate();
        const err = await withStackName(STACK, () =>
          invokeProvision(
            makeEngine({}),
            'AWS::DynamoDB::Table',
            'Retain',
            undefined,
            undefined,
            GENERATED_PID
          ).then(
            () => null,
            (e) => e as Error & { cause?: { message?: string; code?: string } }
          )
        );
        expect(err!.cause?.code).toBe('NAMED_REPLACEMENT_COLLISION');
        expect(err!.cause?.message).toMatch(/GENERATED by cdkd/);
        expect(err!.cause?.message).toMatch(/rename the CONSTRUCT/);
        expect(err!.cause?.message).not.toMatch(/user-supplied physical name/);
      });

      it('the IDEMPOTENT-CREATE refusal quotes a user-supplied name as user-supplied', async () => {
        rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
        vi.mocked(provider.create).mockImplementation(async () => {
          callOrder.push('create');
          return { physicalId: 'old-pid', attributes: {} };
        });
        const err = await invokeProvision(
          makeEngine({}),
          'AWS::DynamoDB::Table',
          'Retain'
        ).then(
          () => null,
          (e) => e as Error & { cause?: { message?: string; code?: string } }
        );
        expect(err!.cause?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
        expect(err!.cause?.message).toMatch(/user-supplied physical name \(old-pid\)/);
        expect(err!.cause?.message).not.toMatch(/GENERATED by cdkd/);
      });

      it('the IDEMPOTENT-CREATE refusal says GENERATED for a derived name', async () => {
        rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
        vi.mocked(provider.create).mockImplementation(async () => {
          callOrder.push('create');
          // The name-idempotent Create API answers with the EXISTING id, which
          // here is the derived one.
          return { physicalId: GENERATED_PID, attributes: {} };
        });
        const err = await withStackName(STACK, () =>
          invokeProvision(
            makeEngine({}),
            'AWS::DynamoDB::Table',
            'Retain',
            undefined,
            undefined,
            GENERATED_PID
          ).then(
            () => null,
            (e) => e as Error & { cause?: { message?: string; code?: string } }
          )
        );
        expect(err!.cause?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
        expect(err!.cause?.message).toMatch(/GENERATED by cdkd/);
        expect(err!.cause?.message).toMatch(/rename the CONSTRUCT/);
        expect(err!.cause?.message).not.toMatch(/user-supplied physical name/);
      });
    });

    it('lets a NON-collision create failure through untranslated', async () => {
      // The other direction of the same translation: only a name collision is
      // rewritten. A throttle or a validation error must surface as itself, or
      // every failed replacement would be reported as a Retain problem.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      vi.mocked(provider.create).mockImplementation(async () => {
        callOrder.push('create');
        throw new Error('ValidationException: BillingMode is invalid');
      });
      const err = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain').then(
        () => null,
        (e) => e as Error & { cause?: { message?: string; code?: string } }
      );
      expect(err).not.toBeNull();
      expect(err!.cause?.code).not.toBe('NAMED_REPLACEMENT_COLLISION');
      expect(err!.cause?.message).toMatch(/BillingMode is invalid/);
    });

    it('refuses with NAMED_REPLACEMENT_IDEMPOTENT_CREATE when the create returns the retained resource', async () => {
      // Issue #1238's shape on this path: a name-idempotent Create API returns
      // the EXISTING resource rather than colliding. Recording that id as the
      // "new" resource would re-adopt the very resource Retain just orphaned,
      // with the new properties never applied — so the refusal has to happen
      // BEFORE any state bookkeeping.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      vi.mocked(provider.create).mockImplementation(async () => {
        callOrder.push('create');
        return { physicalId: 'old-pid', attributes: {} };
      });
      const err = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain').then(
        () => null,
        (e) => e as Error & { cause?: { message?: string; code?: string } }
      );
      expect(err).not.toBeNull();
      expect(err!.cause?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
      expect(err!.cause?.message).toMatch(/name-idempotent/);
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('does NOT refuse when the create returns a genuinely new id (the idempotency check is conditional)', async () => {
      // The polarity that kills a check comparing the wrong pair: a create
      // returning a fresh id is the normal Retain outcome and must proceed.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain');
      expect(callOrder).toEqual(['update', 'create']);
    });

    it('does not add the Retain note when the template declares no such policy', async () => {
      // The other polarity of the note: it is conditional, so an ordinary
      // refusal must not carry advice about an attribute nobody set.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const err = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table').then(
        () => null,
        (e) => e as Error & { cause?: { message?: string } }
      );
      expect(err!.cause?.message).not.toMatch(/Retain/);
    });

    it('marks the refusal non-retryable', async () => {
      // The verdict is computed from a CLI flag and a state-recorded property
      // bag: no retry can change either. The message interpolates a
      // template-controlled logical id into text the retry classifiers match
      // by SUBSTRING, and a nested stack's child engine re-throws into the
      // parent's `withRetry` — so the marker is a declaration, not a fix for
      // an observed retry.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const err = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table').then(
        () => null,
        (e) => e as Error & { cause?: Error }
      );
      expect(isMarkedNonRetryable(err!.cause!)).toBe(true);
    });

    it('a typed rejection whose message ALSO carries the trigger phrase takes the --replace wording', async () => {
      // Both triggers true at once: a provider is free to put "does not
      // support UPDATE" in its `ResourceUpdateNotSupportedError` suggestion,
      // which rides `.message`. `replaceOptIn` is the discriminator, and it is
      // the right one — the user passed `--replace`, so that is the flag whose
      // behaviour they are being told about.
      updateRejection = (rt, logicalId) =>
        new ResourceUpdateNotSupportedError(rt, logicalId, 'AWS does not support UPDATE for this');
      const err = await invokeProvision(
        makeEngine({ replace: true }),
        'AWS::DynamoDB::Table'
      ).then(
        () => null,
        (e) => e as Error & { cause?: { message?: string; code?: string } }
      );
      expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
      expect(err!.cause?.message).toMatch(/--replace would DELETE \+ CREATE/);
      // Explicitly the WRONG-ARM assertion too: matching one wording does not
      // prove the other was not chosen, since the two are selected by a
      // ternary a reorder could invert.
      expect(err!.cause?.message).not.toMatch(/cannot be updated in place/);
      expect(callOrder).toEqual(['update']);
    });

    it('the Retain exemption covers the --replace trigger too, not only the Cloud Control one', async () => {
      // Both triggers share this block, so a fix applied to one of them is the
      // classic half-landed change. The default `updateRejection` here is the
      // typed `ResourceUpdateNotSupportedError` an SDK provider raises, so this
      // is the OTHER trigger entirely — and it must retain identically.
      await invokeProvision(makeEngine({ replace: true }), 'AWS::DynamoDB::Table', 'Retain');
      expect(callOrder).toEqual(['update', 'create']);
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('no refusal message anywhere still claims Retain fails to protect this path', async () => {
      // PR #2519 shipped a note reading "UpdateReplacePolicy: Retain does NOT
      // protect this path — the replacement deletes the old resource
      // regardless." That sentence is now FALSE, and false documentation of a
      // data-loss path is worse than none. It cannot be reached any more —
      // `Retain` short-circuits the guard — so this asserts on the only shape
      // that still produces the refusal, with the policy ABSENT.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const err = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table').then(
        () => null,
        (e) => e as Error & { cause?: { message?: string; code?: string } }
      );
      // Bound the ARM before asserting its negatives: a refusal that reached a
      // DIFFERENT arm satisfies two `not.toMatch`es for free.
      expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
      expect(err!.cause?.message).not.toMatch(/does NOT protect this path/);
      expect(err!.cause?.message).not.toMatch(/Retain/);
    });

    it('reads the Retain policy from the TEMPLATE, not from the state record', async () => {
      // A previous deploy's `Retain` that the template being applied has
      // dropped must not produce the note: it would tell the user a policy
      // they no longer declare fails to protect them. The property-driven
      // guard resolves the same attribute template-only for the same reason —
      // unlike the snapshot attribute below the guard, whose state fallback is
      // deliberate because omitting a promised snapshot is destructive.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const err = await invokeProvision(
        makeEngine({}),
        'AWS::DynamoDB::Table',
        undefined,
        'Retain'
      ).then(
        () => null,
        (e) => e as Error & { cause?: { message?: string; code?: string } }
      );
      expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
      expect(err!.cause?.message).not.toMatch(/Retain/);
    });

    it('chains the update rejection as the refusal cause', async () => {
      // The refusal's own text names no layer and no AWS wording, so the
      // rejection that routed us here is the only record of WHY the update
      // could not be applied. Safe to chain because the refusal is marked
      // non-retryable, which is consulted before any chain-text classification.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const err = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table').then(
        () => null,
        (e) => e as Error & { cause?: { cause?: Error } }
      );
      expect(err!.cause?.cause?.message).toBe(
        'Resource type AWS::DynamoDB::Table does not support UPDATE action'
      );
    });

    describe('the guard reads the RECORDED property bag, not the desired one', () => {
      // Every other test in this file picks a type whose verdict is decided by
      // the TYPE alone — DynamoDB `always`, S3 `has-objects`,
      // Glue SecurityConfiguration `null` — so the second argument at the
      // `isStatefulRecreateTargetForReplace` call site was unpinned: swapping
      // `currentProps` for `{}`, for the resolved desired bag, or for
      // `change.desiredProperties` left all of them green.
      //
      // `AWS::Logs::LogGroup` is the discriminator, because its verdict is
      // computed from the bag: `has-retention` iff the bag it reads carries
      // `RetentionInDays > 0`, `has-log-events` otherwise (issue #2558 — an
      // unset retention is never-expire, so the deferral is stateful here).
      // Putting the retention in exactly one bag and asserting which REASON
      // each renders makes any bag swap red in one direction or the other.
      //
      // (`change.currentProperties` and the state record's `properties` stay
      // the SAME object here, which is what production does — the diff builds
      // `currentProperties` from the state record — so this pair discriminates
      // recorded-vs-desired, not the two spellings of "recorded".)
      const CC_REJECTION = 'Resource type AWS::Logs::LogGroup does not support UPDATE action';

      it('blocks when the RECORDED bag carries the retention and the desired bag does not', async () => {
        rejectWith(CC_REJECTION);
        const err = await invokeProvision(
          makeEngine({}),
          'AWS::Logs::LogGroup',
          undefined,
          undefined,
          { recorded: { RetentionInDays: 30 }, desired: { LogGroupName: 'x' } }
        ).then(
          () => null,
          (e) => e as Error & { cause?: { message?: string; code?: string } }
        );
        expect(err).not.toBeNull();
        expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
        // The reason renders the retention branch specifically, so this also
        // pins that the guard reached the conditional arm rather than some
        // type-keyed shortcut.
        expect(err!.cause?.message).toMatch(/log group retains data/);
        expect(provider.delete).not.toHaveBeenCalled();
        expect(callOrder).toEqual(['update']);
      });

      it('blocks with the NOT-PROVABLY-EMPTY reason when only the DESIRED bag carries the retention', async () => {
        // The other polarity, and the one that kills a swap to the desired bag.
        //
        // Both polarities now BLOCK — issue #2558 closed the gap this case used
        // to record, because an unset or zero recorded retention is CloudWatch
        // Logs' "never expire", the most data-bearing setting the type has, and
        // replacing such a log group with no consent flag destroyed every event
        // in it. What still discriminates the bags is the REASON: the recorded
        // bag answers `has-retention` ("log group retains data"), the deferral
        // answers `has-log-events` ("log group is not provably empty"). A swap
        // to the desired bag would render the retention reason here, and the
        // deferral reason in the case above — so each assertion pins its own
        // bag, exactly as before, and the fixture is unchanged.
        rejectWith(CC_REJECTION);
        const err = await invokeProvision(
          makeEngine({}),
          'AWS::Logs::LogGroup',
          undefined,
          undefined,
          { recorded: { LogGroupName: 'x' }, desired: { RetentionInDays: 30 } }
        ).then(
          () => null,
          (e) => e as Error & { cause?: { message?: string; code?: string } }
        );
        expect(err).not.toBeNull();
        expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
        expect(err!.cause?.message).toMatch(/log group is not provably empty/);
        expect(err!.cause?.message).not.toMatch(/log group retains data/);
        expect(provider.delete).not.toHaveBeenCalled();
        expect(callOrder).toEqual(['update']);
      });

      it('reads the OBSERVED bag when only it carries the retention (#2521)', async () => {
        // The out-of-band case, pinned at the ENGINE rather than only at the
        // predicate: the retention was set by the console or by
        // `aws logs put-retention-policy`, so it is in what the last deploy
        // READ BACK and in neither template bag. The engine used to hand the
        // guard `currentProps` alone, so this log group produced the deferral
        // reason and the cheap positive was unreachable from here no matter
        // what the predicate did.
        //
        // The reason is the discriminator, exactly as in the two cases above:
        // dropping the third argument at this call site leaves the refusal
        // firing (the deferral still blocks) but changes its wording, so this
        // reds on the wiring rather than only on the predicate.
        rejectWith(CC_REJECTION);
        const err = await invokeProvision(
          makeEngine({}),
          'AWS::Logs::LogGroup',
          undefined,
          undefined,
          {
            // The two template bags must DIFFER: `provisionResource` compares
            // the resolved desired bag against `currentProperties` and
            // short-circuits an identical pair as a no-op, so a fixture whose
            // only distinguishing bag is the observed one never reaches the
            // guard at all. Measured -- the first draft of this case used
            // `{ LogGroupName: 'x' }` on both sides and passed vacuously.
            recorded: { LogGroupName: 'x' },
            desired: { LogGroupName: 'y' },
            observed: { LogGroupName: 'x', RetentionInDays: 30 },
          }
        ).then(
          () => null,
          (e) => e as Error & { cause?: { message?: string; code?: string } }
        );
        expect(err).not.toBeNull();
        expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
        expect(err!.cause?.message).toMatch(/log group retains data/);
        expect(err!.cause?.message).not.toMatch(/log group is not provably empty/);
        expect(provider.delete).not.toHaveBeenCalled();
        expect(callOrder).toEqual(['update']);
      });

      it('a ZERO observed retention does not veto a positive RECORDED one (#2521)', async () => {
        // The asymmetry, pinned where a call site could break it. A log group
        // whose observed bag was captured before the retention was applied --
        // or which simply has none -- records `RetentionInDays: 0`, the
        // provider's never-expire placeholder. Reading the observed bag as
        // AUTHORITATIVE whenever the key is PRESENT would turn this into the
        // deferral reason and lose a positive the guard already produced.
        rejectWith(CC_REJECTION);
        const err = await invokeProvision(
          makeEngine({}),
          'AWS::Logs::LogGroup',
          undefined,
          undefined,
          {
            recorded: { RetentionInDays: 30 },
            desired: { LogGroupName: 'x' },
            observed: { LogGroupName: 'x', RetentionInDays: 0 },
          }
        ).then(
          () => null,
          (e) => e as Error & { cause?: { message?: string; code?: string } }
        );
        expect(err).not.toBeNull();
        expect(err!.cause?.message).toMatch(/log group retains data/);
      });

      it('replaces a log group under --force-stateful-recreation, deleting the old one', async () => {
        // The consent flag still works, and the refusal above is not a
        // dead-ended path: without this, a predicate that blocked
        // UNCONDITIONALLY (ignoring the flag) would satisfy both cases above.
        // Asserting the DELETE, not just the absence of the throw — the guard
        // refuses BEFORE the delete, so only the delete proves the replacement
        // actually ran.
        rejectWith(CC_REJECTION);
        await invokeProvision(
          makeEngine({ forceStatefulRecreation: true }),
          'AWS::Logs::LogGroup',
          undefined,
          undefined,
          { recorded: { LogGroupName: 'x' }, desired: { RetentionInDays: 30 } }
        );
        expect(callOrder).toEqual(['update', 'delete', 'create']);
        expect(provider.delete).toHaveBeenCalledWith(
          'MyResource',
          'old-pid',
          'AWS::Logs::LogGroup',
          expect.anything(),
          expect.objectContaining({ forceDataDelete: true })
        );
      });
    });

    it('`--force-stateful-recreation` does NOT override Retain — the old resource still survives', async () => {
      // Retain wins over the consent flag, and that ordering is the point
      // (issue #2518). `--force-stateful-recreation` means "yes, lose the
      // data"; `UpdateReplacePolicy: Retain` means "keep the resource". Since
      // nothing is lost when the old resource survives, there is no data loss
      // for the flag to consent to, and deleting anyway would honour a flag
      // over an explicit template attribute. The property-driven path makes
      // the same call — its `Retain` cleanup branch never consults the flag.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const engine = makeEngine({ forceStatefulRecreation: true });
      await invokeProvision(engine, 'AWS::DynamoDB::Table', 'Retain');
      expect(callOrder).toEqual(['update', 'create']);
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('carries the replacement create\'s NoEcho declaration onto the update result', async () => {
      // The result literal REPLACES the update result, so a `NoEcho`
      // declaration dropped here never reaches `registerNoEchoAttributes` and
      // the replacement's sensitive attributes land UNMASKED in state. The
      // property-driven twin passes `createResult` whole for exactly this
      // reason. Asserted through the observable the declaration reaches: a
      // declared attribute is masked in the persisted record.
      rejectWith('Resource type AWS::Glue::SecurityConfiguration does not support UPDATE action');
      vi.mocked(provider.create).mockImplementation(async () => {
        callOrder.push('create');
        return {
          physicalId: 'new-pid',
          attributes: { Secret: 'super-secret-value', Public: 'fine' },
          noEchoAttributeNames: ['Secret'],
        };
      });
      const engine = makeEngine({});
      await invokeProvision(engine, 'AWS::Glue::SecurityConfiguration');
      expect(callOrder).toEqual(['update', 'delete', 'create']);
      // The registration is the observable, and deliberately so: the record's
      // `attributes` keep the REAL values here — masking happens later, at
      // `scrubResourceRecord` — so there is no in-memory behavioural signal to
      // read instead. `registerNoEchoAttributes` records the declared NAMES
      // against the resource, which is what makes every later log line, event
      // and error mask those values. Asserted as the exact SET, which reds in
      // BOTH directions: a dropped declaration registers nothing, and an
      // over-broad one registers `true` instead of the set.
      const registered = (
        engine as unknown as {
          noEchoAttributeResources: Map<string, true | Set<string>>;
        }
      ).noEchoAttributeResources.get('MyResource');
      expect(registered).toEqual(new Set(['Secret']));
    });

    it("carries a WHOLE-BAG NoEcho declaration too, on the Retain arm the carry exists for", async () => {
      // The other polarity, and the one measured unpinned: deleting only the
      // `noEchoAttributes` spread while keeping `noEchoAttributeNames` left the
      // whole file green. That flag is the "mask everything this create
      // returned" declaration — dropping it lands EVERY replacement attribute
      // unmasked, which is the failure the carry-forward exists to prevent.
      //
      // Run on the RETAIN arm deliberately: the per-name case above exercises
      // the delete-then-create path, while the source comment justifies the
      // carry by "`Retain` makes this block the only thing that runs on the
      // path". One case per arm, so neither justification is unexercised.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      vi.mocked(provider.create).mockImplementation(async () => {
        callOrder.push('create');
        return {
          physicalId: 'new-pid',
          attributes: { Secret: 'super-secret-value' },
          noEchoAttributes: true,
        };
      });
      const engine = makeEngine({});
      await invokeProvision(engine, 'AWS::DynamoDB::Table', 'Retain');
      expect(callOrder).toEqual(['update', 'create']);
      const registered = (
        engine as unknown as {
          noEchoAttributeResources: Map<string, true | Set<string>>;
        }
      ).noEchoAttributeResources.get('MyResource');
      // `true`, not a Set: the whole-bag arm and the per-name arm are distinct
      // registrations, so asserting the exact value keeps them apart.
      expect(registered).toBe(true);
    });

    it('the retained old resource is dropped from state in favour of the new physical id', async () => {
      // What "orphaned" MEANS, asserted on the record the deploy writes rather
      // than on a log line: state points at the NEW resource, so the old one
      // is alive and no longer tracked. `rollback-executor.ts` then classifies
      // the op as `reverse-replacement-readopt`, which deletes the new
      // resource and points state back at the old physical id WITHOUT
      // re-creating it. That rollback re-adopted a DELETED id until this fix,
      // so the two now agree. (Which SOURCE the classifier asks moved in issue
      // #2603: it reads `CompletedOperation.oldResourceRetained`, stamped by
      // this very arm, instead of `previousState.updateReplacePolicy`.)
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const state = await invokeProvision(
        makeEngine({}),
        'AWS::DynamoDB::Table',
        'Retain'
      );
      expect(state['MyResource']?.physicalId).toBe('new-pid');
      expect(state['MyResource']?.updateReplacePolicy).toBe('Retain');
    });

    describe('a provider that rejects with a non-Error value', () => {
      // Both halves of the engine's `instanceof Error` handling are otherwise
      // untested: the trigger predicate reads `String(updateError)` and the
      // refusal chains `updateError instanceof Error ? updateError : undefined`.
      // A provider is free to `throw 'text'` (or a rejected promise carrying a
      // string), and nothing in the type system stops it.
      // The real Cloud Control wording names the type; a placeholder would make
      // the fixture look synthetic where it is deliberately production-shaped.
      const STRING_REJECTION =
        'Resource type AWS::DynamoDB::Table does not support UPDATE action';

      it('still reaches the guard, and chains no cause', async () => {
        updateRejection = () => STRING_REJECTION;
        const err = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table').then(
          () => null,
          (e) => e as Error & { cause?: { code?: string; cause?: unknown } }
        );
        expect(err).not.toBeNull();
        // `String(updateError)` matched the trigger substring, so the fallback
        // fired and the hoisted guard refused it.
        expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
        // Nothing to chain — a string is not an `Error`. Asserted so the
        // ternary cannot quietly become `updateError as Error` and put a
        // non-Error on `cause`, where `formatError` would read `.message` off
        // it and render `undefined`.
        expect(err!.cause?.cause).toBeUndefined();
        expect(provider.delete).not.toHaveBeenCalled();
      });

      it('still auto-replaces a NON-stateful type', async () => {
        // The trigger half on its own: `String(updateError)` is what makes the
        // fallback fire at all, independent of the guard's verdict.
        updateRejection = () => STRING_REJECTION;
        await invokeProvision(makeEngine({}), 'AWS::Glue::SecurityConfiguration');
        expect(callOrder).toEqual(['update', 'delete', 'create']);
      });
    });
  });
});
