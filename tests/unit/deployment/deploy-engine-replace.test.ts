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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
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
    bags?: { recorded?: Record<string, unknown>; desired?: Record<string, unknown> }
  ): Promise<void> {
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
        physicalId: 'old-pid',
        resourceType,
        properties: recordedProps,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
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
    // This arm is reached off the update error's MESSAGE, not off a flag:
    // `msg.includes('UnsupportedActionException') || msg.includes('does not
    // support UPDATE')`. Either substring alone fires the fallback, so both
    // spellings are pinned — a fence for one says nothing about the other.
    //
    // Fixture 1 is REAL AWS TEXT, not invented: probing Cloud Control on
    // 2026-09-04 with `aws cloudcontrol update-resource --type-name
    // AWS::DocDB::DBCluster` (a type whose `ProvisioningType` is
    // `NON_PROVISIONABLE`, so it ships no UPDATE handler) answered
    // `UnsupportedActionException` with the message `Resource type
    // AWS::DocDB::DBCluster does not support UPDATE action`. That is the text
    // `CloudControlProvider.handleError` interpolates into the error the deploy
    // engine sees, which is how the second substring matches in production.
    //
    // Fixture 2 pins the OTHER substring, and its own reachability is doubtful:
    // `handleError` (`src/provisioning/cloud-control-provider.ts`) interpolates
    // `err.message` only and never `err.name`, and AWS's message text (above)
    // does not repeat the name — so nothing cdkd produces is known to satisfy
    // `includes('UnsupportedActionException')`. The case stays because the
    // engine's predicate accepts it and an unfenced accepted branch is worse
    // than one whose production reachability is stated; issue #2520 tracks
    // replacing that half with the structured `ccErrorCode` cdkd already has.
    const CC_UNSUPPORTED_MESSAGES: ReadonlyArray<readonly [string, string]> = [
      [
        "production's byte shape: handleError's wrapper plus AWS's own text",
        'Resource type AWS::DynamoDB::Table is not supported by Cloud Control API and no SDK ' +
          'provider is registered.\nPlease report this issue at ' +
          'https://github.com/go-to-k/cdkd/issues so we can add SDK provider support.\n' +
          'Error: Resource type AWS::DynamoDB::Table does not support UPDATE action',
      ],
      [
        'the exception NAME, the predicate\'s other accepted substring',
        'Resource type AWS::DynamoDB::Table is not supported by Cloud Control API and no SDK ' +
          'provider is registered.\nError: UnsupportedActionException: update not available',
      ],
    ];

    function rejectWith(message: string): void {
      updateRejection = () => new Error(message);
    }

    for (const [label, message] of CC_UNSUPPORTED_MESSAGES) {
      it(`blocks a STATEFUL type with no flags at all — ${label}`, async () => {
        rejectWith(message);
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

    it('blocks a stateful type even under UpdateReplacePolicy: Retain, and says so', async () => {
      // The asymmetry this fixes in the DOCS: the property-driven replacement
      // guard EXEMPTS `Retain` (that path creates first and orphans the old
      // resource), while this fallback deletes unconditionally a few lines
      // below the guard — so `Retain` protects nothing here and must not be
      // read as an exemption. Without this test, adding
      // `&& updateReplacePolicy !== 'Retain'` to the new guard keeps every
      // other case in this file green while silently re-opening the data loss.
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const err = await invokeProvision(makeEngine({}), 'AWS::DynamoDB::Table', 'Retain').then(
        () => null,
        (e) => e as Error & { cause?: { message?: string; code?: string } }
      );
      expect(err).not.toBeNull();
      expect(err!.cause?.code).toBe('STATEFUL_REPLACE_BLOCKED');
      // The remedy it offers is `--force-stateful-recreation`, which DELETES —
      // so the message has to say that Retain will not save the data, or the
      // advice is a trap for exactly the user who declared Retain.
      expect(err!.cause?.message).toMatch(/Retain does NOT protect this path/);
      expect(provider.delete).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['update']);
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

    it('--replace on a Retain-declaring stateful type carries the Retain note too', async () => {
      // The note is appended to the COMBINED ternary, so both arms have it
      // today — but nothing pinned the `--replace` half, and a future split of
      // the two messages would drop it there silently. The trap is identical
      // on that arm: `--force-stateful-recreation` deletes a resource the
      // template asked to retain.
      const err = await invokeProvision(
        makeEngine({ replace: true }),
        'AWS::DynamoDB::Table',
        'Retain'
      ).then(
        () => null,
        (e) => e as Error & { cause?: { message?: string } }
      );
      expect(err!.cause?.message).toMatch(/--replace would DELETE \+ CREATE/);
      expect(err!.cause?.message).toMatch(/Retain does NOT protect this path/);
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
      // computed from the bag: `has-retention` iff `RetentionInDays > 0`.
      // Putting the retention in exactly one bag and asserting both polarities
      // makes any bag swap red in one direction or the other.
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

      it('replaces when only the DESIRED bag carries the retention', async () => {
        // The other polarity, and the one that kills a swap to the desired bag.
        // It pins BAG SELECTION, and nothing else: the guard's predicate is
        // `RetentionInDays > 0` on the RECORDED bag, so a template merely
        // ADDING retention replaces with no flag, exactly as it did before the
        // guard was hoisted.
        //
        // Deliberately NOT justified as "the recorded log group is ephemeral" —
        // that reading is FALSE. An unset or zero retention is CloudWatch Logs'
        // "never expire", the most data-bearing setting there is. The predicate
        // letting it through is a known gap (issue #2558), not a judgement this
        // assertion endorses.
        rejectWith(CC_REJECTION);
        await invokeProvision(makeEngine({}), 'AWS::Logs::LogGroup', undefined, undefined, {
          recorded: { LogGroupName: 'x' },
          desired: { RetentionInDays: 30 },
        });
        expect(callOrder).toEqual(['update', 'delete', 'create']);
      });
    });

    it('honours `--force-stateful-recreation` under Retain by actually DELETING the old resource', async () => {
      // The Retain asymmetry is asserted elsewhere only as message TEXT, which
      // proves the note is rendered, not that the behaviour behind it is real.
      // This is the behavioural half: `Retain` exempts the property-driven
      // guard (that path creates first and orphans the old resource), while on
      // THIS path the consent flag deletes the old resource regardless of the
      // policy. If a future edit ever taught this path to honour `Retain`, the
      // note would become a lie and only this assertion would catch it.
      // (The divergence itself is issue #2518.)
      rejectWith('Resource type AWS::DynamoDB::Table does not support UPDATE action');
      const engine = makeEngine({ forceStatefulRecreation: true });
      await invokeProvision(engine, 'AWS::DynamoDB::Table', 'Retain');
      expect(callOrder).toEqual(['update', 'delete', 'create']);
      expect(provider.delete).toHaveBeenCalledWith(
        'MyResource',
        'old-pid',
        'AWS::DynamoDB::Table',
        expect.anything(),
        expect.objectContaining({ forceDataDelete: true })
      );
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
