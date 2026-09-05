/**
 * Issue [#2668](https://github.com/go-to-k/cdkd/issues/2668): a resource whose
 * `Type` changes is diffed as an UPDATE carrying the TEMPLATE's (NEW) type, and
 * `provisionResource` routes BOTH halves of the resulting replacement on that
 * one type — so the OLD resource's delete is dispatched at the NEW type's
 * provider. For `AWS::CloudFormation::Stack` that provider is
 * `NestedStackProvider`, whose `delete` ignores the physical id it is handed
 * and destroys `<parent>~<logicalId>` — a child stack, and every resource it
 * owns, that the changed resource has nothing to do with.
 *
 * This suite pins the STOPGAP: the deploy is refused at plan time, before any
 * provider call, in BOTH directions.
 *
 * Both polarities are asserted throughout, because either alone is satisfiable
 * by a wrong implementation — a guard that refused every deploy would close the
 * hazard by breaking cdkd, which the ALLOWED arms refuse:
 *
 *   - a Type change with `AWS::CloudFormation::Stack` on either side → refused
 *     with `TYPE_CHANGE_NESTED_STACK`, no provider touched;
 *   - an ordinary Type change (no nested stack involved) → NOT refused. It is
 *     still mis-routed (that is #2668's full fix, a routing change with a
 *     design fork of its own), but its failure mode is bounded to the two
 *     resources involved — a loud API error, a leak of the old resource, or at
 *     worst a same-named live resource of the new type — never the destruction
 *     of a whole stack the user did not name; and refusing every Type change
 *     would refuse a deploy that is
 *     correct today: under `UpdateReplacePolicy: Retain` the replacement skips
 *     the old delete entirely;
 *   - an ordinary nested-stack UPDATE (`AWS::CloudFormation::Stack` on BOTH
 *     sides) → NOT refused. This is the arm a "does the type appear anywhere?"
 *     implementation would break, and it is every nested-stack deploy cdkd
 *     does.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  findNestedStackTypeChanges,
  renderNestedStackTypeChangeRefusal,
} from '../../../src/deployment/type-change-guard.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

// Pass-through resolver — nothing in this suite depends on intrinsic
// resolution, and the real one would reach AWS.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const NESTED = 'AWS::CloudFormation::Stack';
const STACK_NAME = 'MyStack';
const LOGICAL_ID = 'Thing';
/** The physical id `NestedStackProvider.delete` would IGNORE. */
const OLD_PHYSICAL_ID = 'arn:aws:sns:us-east-1:111122223333:old-topic';

/**
 * The recorded and templated property bags DIFFER, and that is load-bearing
 * rather than decoration: `provisionResource`'s UPDATE arm re-compares the
 * resolved template bag against the state bag and SKIPS the provider entirely
 * when they match (`deploy-engine.ts`, the "DiffCalculator ... false positives"
 * re-check). With two empty bags every case in this file reached `saveState`
 * having called no provider at all — so "the guard refused before any provider
 * call" was satisfied by a deploy that never provisioned anything, which is a
 * confluence point, not a discriminator.
 */
const RECORDED_PROPS = { Marker: 'old' } as const;
const TEMPLATE_PROPS = { Marker: 'new' } as const;

function stateRecord(resourceType: string, physicalId = OLD_PHYSICAL_ID): ResourceState {
  return {
    physicalId,
    resourceType,
    properties: { ...RECORDED_PROPS },
    attributes: {},
    dependencies: [],
  } as unknown as ResourceState;
}

/**
 * The two UPDATE shapes `DiffCalculator` emits (`src/analyzer/diff-calculator.ts`),
 * chosen by whether the types differ — the same discriminator the real producer
 * uses, so no case can feed a shape the diff never builds:
 *
 *   - types DIFFER → a synthetic `{ path: 'Type', requiresReplacement: true }`
 *     change whose `oldValue` is the STATE record's type;
 *   - types MATCH → an ordinary in-place property change.
 *
 * The guard reads neither `propertyChanges` nor `oldValue`, but the engine
 * does: `requiresReplacement` is what selects the replacement path, so a
 * same-type fixture carrying a `Type` change would send an ordinary nested-stack
 * update down the DELETE + CREATE path and pin the wrong control.
 */
function updateChange(resourceType: string, recordedType = 'AWS::SNS::Topic'): ResourceChange {
  const propertyChanges =
    recordedType === resourceType
      ? [
          {
            path: 'Marker',
            oldValue: RECORDED_PROPS.Marker,
            newValue: TEMPLATE_PROPS.Marker,
            requiresReplacement: false,
          },
        ]
      : [
          {
            path: 'Type',
            oldValue: recordedType,
            newValue: resourceType,
            requiresReplacement: true,
          },
        ];
  return {
    logicalId: LOGICAL_ID,
    changeType: 'UPDATE',
    resourceType,
    currentProperties: { ...RECORDED_PROPS },
    desiredProperties: { ...TEMPLATE_PROPS },
    propertyChanges,
  } as unknown as ResourceChange;
}

describe('findNestedStackTypeChanges (#2668)', () => {
  it('flags a Type change INTO AWS::CloudFormation::Stack', () => {
    const found = findNestedStackTypeChanges({
      changes: new Map([[LOGICAL_ID, updateChange(NESTED)]]),
      stateResources: { [LOGICAL_ID]: stateRecord('AWS::SNS::Topic') },
    });
    expect(found).toEqual([
      {
        logicalId: LOGICAL_ID,
        currentType: 'AWS::SNS::Topic',
        desiredType: NESTED,
        physicalId: OLD_PHYSICAL_ID,
        direction: 'into-nested-stack',
      },
    ]);
  });

  it('flags a Type change OUT OF AWS::CloudFormation::Stack', () => {
    const found = findNestedStackTypeChanges({
      changes: new Map([[LOGICAL_ID, updateChange('AWS::SNS::Topic')]]),
      stateResources: { [LOGICAL_ID]: stateRecord(NESTED, 'MyStack~Thing') },
    });
    expect(found).toEqual([
      {
        logicalId: LOGICAL_ID,
        currentType: NESTED,
        desiredType: 'AWS::SNS::Topic',
        physicalId: 'MyStack~Thing',
        direction: 'out-of-nested-stack',
      },
    ]);
  });

  it('does NOT flag an ordinary nested-stack UPDATE (the type on BOTH sides)', () => {
    // The arm a "does AWS::CloudFormation::Stack appear?" implementation breaks
    // — this is every nested-stack deploy cdkd performs.
    expect(
      findNestedStackTypeChanges({
        changes: new Map([[LOGICAL_ID, updateChange(NESTED, NESTED)]]),
        stateResources: { [LOGICAL_ID]: stateRecord(NESTED, 'MyStack~Thing') },
      })
    ).toEqual([]);
  });

  it('does NOT flag a Type change between two ordinary types', () => {
    expect(
      findNestedStackTypeChanges({
        changes: new Map([[LOGICAL_ID, updateChange('AWS::SQS::Queue')]]),
        stateResources: { [LOGICAL_ID]: stateRecord('AWS::SNS::Topic') },
      })
    ).toEqual([]);
  });

  it('does NOT flag a CREATE of a nested stack (no state record to mis-route)', () => {
    // A fresh nested stack has no recorded resource, so nothing is deleted and
    // nothing can be mis-routed. Without this arm the guard would refuse every
    // stack that ADDS a nested child.
    expect(
      findNestedStackTypeChanges({
        changes: new Map([
          [
            LOGICAL_ID,
            {
              logicalId: LOGICAL_ID,
              changeType: 'CREATE',
              resourceType: NESTED,
              desiredProperties: {},
            } as unknown as ResourceChange,
          ],
        ]),
        stateResources: {},
      })
    ).toEqual([]);
  });

  it('does NOT flag a CREATE at a logical id that names an Object.prototype member', () => {
    // `constructor` / `toString` / `valueOf` / `hasOwnProperty` are all valid
    // CFn logical ids, and `state.resources` is a JSON-parsed plain object — so
    // a bare index lookup resolves DOWN THE PROTOTYPE CHAIN to a truthy value
    // with no `resourceType`, and the fresh nested stack below was reported as
    // a Type change "from undefined": a refusal of a deploy with nothing to
    // refuse. Every prototype member is asserted, not just the one that found
    // it, because the hazard is the lookup and not the name.
    for (const inheritedName of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(
        findNestedStackTypeChanges({
          changes: new Map([
            [
              inheritedName,
              {
                logicalId: inheritedName,
                changeType: 'CREATE',
                resourceType: NESTED,
                desiredProperties: {},
              } as unknown as ResourceChange,
            ],
          ]),
          stateResources: {},
        }),
        `${inheritedName} was reported as a Type change`
      ).toEqual([]);
    }
  });

  it('does NOT flag — or throw on — an OWN state key whose record is missing', () => {
    // The `Object.hasOwn` guard above answers "is the key present", not "does
    // it hold a record": `state.json` is parsed from S3, so a truncated or
    // hand-edited file can carry `"Thing": null` on a key that IS its own. The
    // second check is what keeps that from throwing on `.resourceType` inside
    // the plan phase — which would fail the deploy with a TypeError naming no
    // resource, instead of proceeding to the code that reports a missing
    // record properly.
    expect(
      findNestedStackTypeChanges({
        changes: new Map([[LOGICAL_ID, updateChange(NESTED)]]),
        stateResources: { [LOGICAL_ID]: null as unknown as ResourceState },
      })
    ).toEqual([]);
  });

  it('reports every offending row, and only those', () => {
    const changes = new Map<string, ResourceChange>([
      ['IntoNested', { ...updateChange(NESTED), logicalId: 'IntoNested' } as ResourceChange],
      [
        'OutOfNested',
        { ...updateChange('AWS::SQS::Queue'), logicalId: 'OutOfNested' } as ResourceChange,
      ],
      [
        'OrdinaryTypeChange',
        { ...updateChange('AWS::SQS::Queue'), logicalId: 'OrdinaryTypeChange' } as ResourceChange,
      ],
      [
        'UnchangedChild',
        { ...updateChange(NESTED, NESTED), logicalId: 'UnchangedChild' } as ResourceChange,
      ],
    ]);
    const found = findNestedStackTypeChanges({
      changes,
      stateResources: {
        IntoNested: stateRecord('AWS::SNS::Topic'),
        OutOfNested: stateRecord(NESTED, 'MyStack~OutOfNested'),
        OrdinaryTypeChange: stateRecord('AWS::SNS::Topic'),
        UnchangedChild: stateRecord(NESTED, 'MyStack~UnchangedChild'),
      },
    });
    expect(found.map((f) => f.logicalId)).toEqual(['IntoNested', 'OutOfNested']);
    expect(found.map((f) => f.direction)).toEqual(['into-nested-stack', 'out-of-nested-stack']);
  });
});

describe('renderNestedStackTypeChangeRefusal (#2668)', () => {
  it('names the logical id, BOTH types, the physical id, the derived child stack, and the remedy', () => {
    const message = renderNestedStackTypeChangeRefusal(
      findNestedStackTypeChanges({
        changes: new Map([[LOGICAL_ID, updateChange(NESTED)]]),
        stateResources: { [LOGICAL_ID]: stateRecord('AWS::SNS::Topic') },
      }),
      STACK_NAME
    );
    expect(message).toContain(LOGICAL_ID);
    expect(message).toContain('AWS::SNS::Topic');
    expect(message).toContain(NESTED);
    // The resource the mis-routed delete would be aimed at, and the one it
    // would actually destroy — the second is the piece the user cannot read
    // off their own template.
    expect(message).toContain(OLD_PHYSICAL_ID);
    expect(message).toContain(`${STACK_NAME}~${LOGICAL_ID}`);
    // The row head states each fact ONCE: both types and the physical id, with
    // no second restatement of the recorded type. Pinned as a whole string
    // because nothing else reddens when the head is reworded, and a row that
    // repeats itself is how the pre-collapse form drifts back.
    expect(message).toContain(
      `  - ${LOGICAL_ID}: Type changes from AWS::SNS::Topic to ${NESTED} ` +
        `(the existing AWS::SNS::Topic is ${OLD_PHYSICAL_ID}).`
    );
    // POSITIVELY fence the into-nested damage arm. Every needle above is also
    // satisfied by the out-of text plus the shared head, so without these three
    // the two arms could be SWAPPED and this case would stay green — the
    // one-sided-fence shape: the out-of case's `not.toMatch` watched this
    // sentence, and nothing watched the out-of sentence from here.
    expect(message).toMatch(/destroys the nested child stack/);
    expect(message).toMatch(/ignores the physical id it is handed/);
    // The second outcome of the same arm, unpinned until now: with no child
    // state the delete is a no-op and the OLD resource is stranded. A user who
    // reads only the destruction half will not go looking for the orphan.
    expect(message).toContain('silently leaked');
    // ...and the out-of arm's own wording must NOT appear here.
    expect(message).not.toMatch(/left behind/);
    // The SINGULAR headline arm. Only the plural one was pinned, so
    // `${n} resources change their Type` could have replaced both.
    expect(message).toContain(
      `Refusing to deploy ${STACK_NAME}: a resource changes its Type into or out of ${NESTED},`
    );
    // The remedy, and the absence of an override.
    expect(message).toMatch(/DIFFERENT logical id/);
    expect(message).toMatch(/no flag that overrides this refusal/);
    expect(message).toContain('#2668');
  });

  it('renders the PLURAL arm when more than one row offends', () => {
    // The singular/plural `if` is the one arm no single-row case can reach, and
    // it rendered "2 resources change its Type" until this case was written.
    const message = renderNestedStackTypeChangeRefusal(
      findNestedStackTypeChanges({
        changes: new Map<string, ResourceChange>([
          ['First', { ...updateChange(NESTED), logicalId: 'First' } as ResourceChange],
          ['Second', { ...updateChange(NESTED), logicalId: 'Second' } as ResourceChange],
        ]),
        stateResources: {
          First: stateRecord('AWS::SNS::Topic'),
          Second: stateRecord('AWS::SQS::Queue'),
        },
      }),
      STACK_NAME
    );
    expect(message).toContain('2 resources change their Type');
    expect(message).not.toContain('resources change its Type');
    // Both rows are rendered, each naming its own recorded type.
    expect(message).toContain('First');
    expect(message).toContain('Second');
    expect(message).toContain('AWS::SQS::Queue');
  });

  it('describes the OUT-OF direction as an orphaned child stack, not a destroyed one', () => {
    const message = renderNestedStackTypeChangeRefusal(
      findNestedStackTypeChanges({
        changes: new Map([[LOGICAL_ID, updateChange('AWS::SQS::Queue')]]),
        stateResources: { [LOGICAL_ID]: stateRecord(NESTED, 'MyStack~Thing') },
      }),
      STACK_NAME
    );
    expect(message).toContain('AWS::SQS::Queue');
    expect(message).toMatch(/left behind/);
    expect(message).toMatch(/cannot delete a nested stack/);
    // The into-nested damage sentence must NOT be reused here: nothing is
    // destroyed in this direction, and telling a user their child stack will be
    // destroyed when it will be orphaned sends them to the wrong recovery.
    expect(message).not.toMatch(/destroys the nested child stack/);
  });
});

describe('DeployEngine refuses a nested-stack Type change before provisioning (#2668)', () => {
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let mockLockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  let mockDagBuilder: {
    buildGraph: ReturnType<typeof vi.fn>;
    getExecutionLevels: ReturnType<typeof vi.fn>;
    getDirectDependencies: ReturnType<typeof vi.fn>;
  };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };
  let provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
  };
  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
  };
  let mockExportIndexStore: {
    updateForStack: ReturnType<typeof vi.fn>;
    lookup: ReturnType<typeof vi.fn>;
    patchEntry: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
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
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: OLD_PHYSICAL_ID }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    mockExportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}) {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, ...options } as never,
      'us-east-1',
      mockExportIndexStore as never
    );
  }

  /** State + diff for a run whose single row changes Type as given. */
  function arrange(recordedType: string, templateType: string): CloudFormationTemplate {
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: STACK_NAME,
      resources: {
        [LOGICAL_ID]: stateRecord(
          recordedType,
          recordedType === NESTED ? `${STACK_NAME}~${LOGICAL_ID}` : OLD_PHYSICAL_ID
        ),
      },
      outputs: {},
      lastModified: 0,
    };
    mockStateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([[LOGICAL_ID, updateChange(templateType, recordedType)]])
    );
    return {
      Resources: { [LOGICAL_ID]: { Type: templateType, Properties: { ...TEMPLATE_PROPS } } },
    } as CloudFormationTemplate;
  }

  async function deployAndCatch(
    engine: InstanceType<typeof DeployEngine>,
    template: CloudFormationTemplate,
    stackName: string = STACK_NAME
  ): Promise<unknown> {
    return engine.deploy(stackName, template).then(
      () => undefined,
      (e: unknown) => e
    );
  }

  for (const [label, recorded, desired] of [
    ['INTO a nested stack', 'AWS::SNS::Topic', NESTED],
    ['OUT OF a nested stack', NESTED, 'AWS::SQS::Queue'],
  ] as const) {
    it(`refuses a Type change ${label}, before any provider call`, async () => {
      const template = arrange(recorded, desired);
      const err = (await deployAndCatch(makeEngine(), template)) as
        | { message: string; code?: string }
        | undefined;

      expect(err, 'the deploy did not throw').toBeDefined();
      expect(err!.code).toBe('TYPE_CHANGE_NESTED_STACK');
      expect(err!.message).toContain(LOGICAL_ID);
      expect(err!.message).toContain(recorded);
      expect(err!.message).toContain(desired);

      // The discriminator: pre-fix the deploy ran the replacement and called
      // the NEW type's provider to delete the OLD resource. Not "the deploy
      // failed" — a failure downstream of the delete still leaves the child
      // stack destroyed.
      expect(provider.delete).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.update).not.toHaveBeenCalled();
      // Nothing is provisioned, so nothing is persisted either.
      expect(mockStateBackend.saveState).not.toHaveBeenCalled();
      // The refusal happens after the lock is taken, so it must go back.
      expect(mockLockManager.releaseLock).toHaveBeenCalledWith(STACK_NAME, 'us-east-1');
    });

    it(`refuses the same change under --dry-run (${label})`, async () => {
      // A dry run previews a plan; previewing one cdkd will refuse to run —
      // and describing it as a routine replacement — is the report the user
      // would act on.
      const template = arrange(recorded, desired);
      const err = (await deployAndCatch(makeEngine({ dryRun: true }), template)) as
        | { code?: string }
        | undefined;
      expect(err?.code).toBe('TYPE_CHANGE_NESTED_STACK');
    });
  }

  it('does NOT refuse an ordinary Type change between two non-nested types', async () => {
    // The width control. This deploy is still mis-routed (#2668's full fix),
    // but its failure mode is bounded to the resource itself, and refusing it
    // would refuse the `UpdateReplacePolicy: Retain` shape that is correct
    // today.
    const template = arrange('AWS::SNS::Topic', 'AWS::SQS::Queue');
    const err = await deployAndCatch(makeEngine(), template);
    expect(err).toBeUndefined();
    expect(mockStateBackend.saveState).toHaveBeenCalled();
    // Not merely "no throw": the row must still REACH provisioning and take the
    // replacement. Without this a future change that dropped Type-change rows
    // from the plan entirely would keep the arm green while removing the very
    // behaviour it exists to protect.
    expect(provider.create).toHaveBeenCalled();
    expect(provider.delete).toHaveBeenCalled();
  });

  it('does NOT refuse an ordinary nested-stack update', async () => {
    const template = arrange(NESTED, NESTED);
    const err = await deployAndCatch(makeEngine(), template);
    expect(err).toBeUndefined();
    expect(mockStateBackend.saveState).toHaveBeenCalled();
    expect(provider.update).toHaveBeenCalled();
  });

  it('refuses inside a nested CHILD deploy, naming the grandchild stack it would destroy', async () => {
    // The reason the check lives in the engine rather than in a CLI pre-flight:
    // a child stack is deployed by its OWN `DeployEngine`, created by
    // `NestedStackProvider.runChildDeploy`, and never passes through
    // `src/cli/commands/deploy.ts`. The child's stack name is `<parent>~<child>`,
    // so the derived name in the message nests once more.
    const childStack = `${STACK_NAME}~Child`;
    const template = arrange('AWS::SNS::Topic', NESTED);
    const err = (await deployAndCatch(makeEngine(), template, childStack)) as
      | { message: string; code?: string }
      | undefined;
    expect(err?.code).toBe('TYPE_CHANGE_NESTED_STACK');
    expect(err!.message).toContain(`${childStack}~${LOGICAL_ID}`);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it('marks the refusal NON-RETRYABLE', async () => {
    // `retry.ts` consults the marker AHEAD of any classifier, so the mark is a
    // DECLARATION rather than a fix for a live loop: no retry loop reaches this
    // refusal today (`NestedStackProvider` sets `disableOuterRetry`, and the two
    // outer loops that ignore that flag cannot bind it). Pinned so a caller that
    // later opts back into retrying this path inherits the refusal's terminal
    // status instead of a message-matching guess.
    const template = arrange('AWS::SNS::Topic', NESTED);
    const err = await deployAndCatch(makeEngine(), template);
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('a refusal message quoting a retryable pattern is still not retried', async () => {
    // What the marker buys, exercised rather than asserted: template-controlled
    // text inside the refusal can spell one of
    // `RETRYABLE_ERROR_MESSAGE_PATTERNS`, so a message-matching classifier
    // would call a permanent refusal transient. This drives the real
    // classifier, not a re-implementation of it.
    const template = arrange('AWS::SNS::Topic', NESTED);
    const err = await deployAndCatch(makeEngine(), template);
    const poisoned = new Error(
      `${(err as Error).message}\nRate exceeded`
    ) as Error & { cause?: unknown };
    poisoned.cause = err;
    expect(isRetryableTransientError(poisoned, poisoned.message)).toBe(false);
  });
});
