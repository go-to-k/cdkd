import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  recordResolvedPair,
  redactSecretsForState,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

/**
 * Issue [#2516](https://github.com/go-to-k/cdkd/issues/2516): an embedded
 * secret whose resolved value is 1-3 characters long sits BELOW the value
 * scan's needle floor, so `positionByEmbeddedSpan`'s scan-equivalence bound
 * left it in plaintext in every bag the persist choke point writes. The fix
 * admits the sub-floor middle only on a bag the ENGINE marked as this pass's
 * own (`markSameGenerationBag`), and this file pins the engine half: WHICH
 * objects get the mark, and — as load-bearing — which do not.
 *
 * The plaintext is two characters on purpose: long enough to read in a
 * failure message, short enough that no needle is ever built from it.
 */
const PIN_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:pin}}';
const PIN_EXPR_STAGED = '{{resolve:secretsmanager:prod/db:SecretString:pin:AWSCURRENT}}';
const PIN = 'q7';
const SECRET_BY_EXPRESSION: Record<string, string> = {
  [PIN_EXPR]: PIN,
  [PIN_EXPR_STAGED]: PIN,
};
const PORT_LITERAL_SOURCE = `port:${PIN_EXPR}`;
const PORT_LITERAL_PLAINTEXT = `port:${PIN}`;

// Flipped by ONE case: the resolver refuses everything, so a deploy fails
// before its attempted bag is recorded.
let resolverRefuses = false;

function resolveWithSecrets(
  value: unknown,
  ctx: { recordedSecretValues?: Map<string, string> }
): unknown {
  if (resolverRefuses) throw new Error('resolver refused');
  if (typeof value === 'string') {
    const whole = SECRET_BY_EXPRESSION[value];
    if (whole !== undefined) {
      ctx.recordedSecretValues?.set(whole, value);
      if (ctx.recordedSecretValues) recordResolvedPair(ctx.recordedSecretValues, value, whole);
      return whole;
    }
    let out = value;
    for (const expr of Object.keys(SECRET_BY_EXPRESSION)) {
      if (!out.includes(expr)) continue;
      const pt = SECRET_BY_EXPRESSION[expr]!;
      ctx.recordedSecretValues?.set(pt, expr);
      if (ctx.recordedSecretValues) recordResolvedPair(ctx.recordedSecretValues, expr, pt);
      out = out.split(expr).join(pt);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => resolveWithSecrets(v, ctx));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value as Record<string, unknown>, 'Fn::GetAtt')) {
      throw new Error('cannot resolve Fn::GetAtt for a resource not in state');
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveWithSecrets(v, ctx);
    }
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
    // The rollback replay resolves the journaled record leaf by leaf through
    // this seam (`resolveReplayProps` -> `resolveLeafByRegion`), recording
    // pairs the same way.
    resolveDynamicReferences: vi
      .fn()
      .mockImplementation((leaf: string, ctx: { recordedSecretValues?: Map<string, string> }) =>
        Promise.resolve(resolveWithSecrets(leaf, ctx ?? {}))
      ),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - an embedded 1-3 character secret persists as its token on the bags this pass produced (issue #2516)', () => {
  const stackName = 'short-embedded-secret-stack';
  const RESOURCE_TYPE = 'AWS::Lambda::Function';

  // The literal leaf FIRST and the whole-value sibling LAST, so the collapsed
  // map's survivor is the STAGED spelling: the literal leaf must be written
  // from its own token, and a mutant writing the survivor is visible.
  const DESIRED = {
    Environment: {
      Variables: {
        PORT_LITERAL: PORT_LITERAL_SOURCE,
        PIN_WHOLE: PIN_EXPR_STAGED,
      },
    },
    Handler: 'index.handler',
  };
  const REDACTED = {
    Environment: {
      Variables: {
        PORT_LITERAL: PORT_LITERAL_SOURCE,
        PIN_WHOLE: PIN_EXPR_STAGED,
      },
    },
    Handler: 'index.handler',
  };
  // What AWS reports for the same resource: the plaintext at both leaves.
  const REDACTED_AS_LIVE = {
    Environment: {
      Variables: {
        PORT_LITERAL: PORT_LITERAL_PLAINTEXT,
        PIN_WHOLE: PIN,
      },
    },
    Handler: 'index.handler',
  };
  const template: CloudFormationTemplate = {
    Resources: { Fn: { Type: RESOURCE_TYPE, Properties: DESIRED } },
    Outputs: {
      // A literal `CfnOutput` embedding the same token: the same leaf shape as
      // the resource property, walked by `redactOutputs`.
      PortOut: { Value: PORT_LITERAL_SOURCE },
    },
  };

  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resolverRefuses = false;
    mockProvider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'fn-phys', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'fn-phys', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      // Echo the bag the engine handed the capture — what Lambda's
      // `GetFunctionConfiguration` does for env vars — so the readback carries
      // the plaintext at the same offset as `properties`.
      readCurrentState: vi
        .fn()
        .mockImplementation((_p: string, _l: string, _t: string, props: unknown) =>
          Promise.resolve(structuredClone(props))
        ),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Fn']]),
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
      hasProvider: vi.fn().mockReturnValue(true),
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      // Read at ONE place the engine reaches on these paths -- the input to
      // the mocked `calculateDiff` -- and NOT by `withoutSilentDropProperties`,
      // which takes no allow set. So the override in the SDK silent-drop case
      // below is inert for what that case asserts; it is set because a real
      // `--allow-unsupported-properties` run is the population the case
      // describes, not because the record-side narrowing consults it
      // (maintainer review of PR 2753, round 3).
      getAllowedUnsupportedProperties: vi.fn().mockReturnValue(new Set<string>()),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}) {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, ...options },
      'us-east-1'
    );
  }

  function changeMap(
    changeType: 'CREATE' | 'UPDATE',
    currentProperties?: Record<string, unknown>
  ): Map<string, ResourceChange> {
    return new Map<string, ResourceChange>([
      [
        'Fn',
        {
          logicalId: 'Fn',
          changeType,
          resourceType: RESOURCE_TYPE,
          desiredProperties: DESIRED,
          ...(currentProperties && { currentProperties }),
        },
      ],
    ]);
  }

  function priorState(properties: Record<string, unknown>): StackState {
    return {
      version: 9,
      region: 'us-east-1',
      stackName,
      resources: {
        Fn: {
          physicalId: 'fn-phys',
          resourceType: RESOURCE_TYPE,
          properties,
          observedProperties: structuredClone(properties),
        },
      },
      outputs: { PortOut: PORT_LITERAL_PLAINTEXT },
      lastModified: 1,
    };
  }

  function savedState(): StackState {
    return mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
  }

  function envOf(bag: Record<string, unknown> | undefined): Record<string, unknown> {
    return (bag?.['Environment'] as Record<string, Record<string, unknown>>)['Variables']!;
  }

  it('CREATE: the record properties, the readback of the same resource AND the outputs bag all hold the token', async () => {
    mockDiffCalculator.calculateDiff!.mockResolvedValue(changeMap('CREATE'));

    await makeEngine().deploy(stackName, template);

    // The provider received the plaintext — the fix changes what STATE holds,
    // never what AWS is handed.
    const createdProps = mockProvider.create!.mock.calls[0]![2] as Record<string, unknown>;
    expect(envOf(createdProps)['PORT_LITERAL']).toBe(PORT_LITERAL_PLAINTEXT);

    const record = savedState().resources['Fn']!;
    expect(record.properties).toEqual(REDACTED);
    // Its readback, installed by `drainObservedCaptures`: marked separately,
    // because the choke point walks it as its own bag against the template.
    expect(envOf(record.observedProperties)['PORT_LITERAL']).toBe(PORT_LITERAL_SOURCE);
    expect(envOf(record.observedProperties)['PIN_WHOLE']).toBe(PIN_EXPR_STAGED);
    // The outputs bag this pass resolved.
    expect(savedState().outputs['PortOut']).toBe(PORT_LITERAL_SOURCE);
    // The hard invariant, over the whole document.
    expect(JSON.stringify(savedState())).not.toContain(PORT_LITERAL_PLAINTEXT);
    expect(JSON.stringify(savedState())).not.toContain(`"${PIN}"`);
  });

  it('the rollback journal\'s completed-op `properties` is the same marked object, so the journal holds the token too', async () => {
    // A later resource fails after this one succeeded. The journal segment
    // records the completed CREATE with `properties: newResources[id].properties`
    // — the very object `propertiesToRecord` marked — and
    // `redactOperationsForJournal` walks it against the template bag. Pinned
    // because the journal is a persisted reader of its own: a leaf in
    // plaintext there is a disclosure in `rollback-journal.json`.
    mockDagBuilder.getExecutionLevels!.mockReturnValue([['Fn'], ['Bad']]);
    // `Bad` DEPENDS on `Fn`, so the executor dispatches it only after `Fn`
    // completed — otherwise the two run concurrently and the failure can
    // reach the catch before `Fn`'s completion is journaled.
    mockDagBuilder.getDirectDependencies!.mockImplementation((_dag: unknown, id: string) =>
      id === 'Bad' ? ['Fn'] : []
    );
    mockProvider.create!.mockImplementation((logicalId: string) =>
      logicalId === 'Bad'
        ? Promise.reject(new Error('AWS rejected the CREATE'))
        : Promise.resolve({ physicalId: 'fn-phys', attributes: {} })
    );
    mockProvider.readCurrentState!.mockResolvedValue(undefined);
    const twoResources: CloudFormationTemplate = {
      Resources: {
        Fn: { Type: RESOURCE_TYPE, Properties: DESIRED },
        Bad: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'bad' } },
      },
    };
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        ...changeMap('CREATE'),
        [
          'Bad',
          {
            logicalId: 'Bad',
            changeType: 'CREATE',
            resourceType: 'AWS::SQS::Queue',
            desiredProperties: { QueueName: 'bad' },
          },
        ],
      ])
    );

    await makeEngine({ noRollback: true })
      .deploy(stackName, twoResources)
      .catch(() => undefined);

    expect(mockStateBackend.appendRollbackJournalSegment).toHaveBeenCalled();
    const segment = mockStateBackend.appendRollbackJournalSegment!.mock.calls.at(-1)![2] as {
      operations?: Array<{ logicalId: string; properties?: Record<string, unknown> }>;
    };
    const completed = segment.operations!.find((op) => op.logicalId === 'Fn')!;
    expect(envOf(completed.properties)['PORT_LITERAL']).toBe(PORT_LITERAL_SOURCE);
    expect(JSON.stringify(segment)).not.toContain(PORT_LITERAL_PLAINTEXT);
    // ...and the failure persist's state record for the completed sibling
    // walks the same marked object.
    expect(mockStateBackend.saveState).toHaveBeenCalled();
    expect(envOf(savedState().resources['Fn']!.properties)['PORT_LITERAL']).toBe(
      PORT_LITERAL_SOURCE
    );
  });

  it('a FAILED op\'s journaled attemptedProperties is the resolver\'s own output and holds the token', async () => {
    // The provider threw, so `propertiesToRecord` never ran for this bag; the
    // journal's `attemptedProperties` is `resolvedProps` itself, redacted by
    // `redactOperationsForJournal`. Without a mark there the framed
    // plaintext would land in `rollback-journal.json` on exactly the failure
    // path. That the engine marks a COPY rather than the object is defensive
    // (nothing reads the original after the journal is written) and is NOT
    // pinned here — this case pins the journal's contents.
    mockProvider.create!.mockRejectedValue(new Error('AWS rejected the CREATE'));
    mockDiffCalculator.calculateDiff!.mockResolvedValue(changeMap('CREATE'));

    await makeEngine({ noRollback: true })
      .deploy(stackName, template)
      .catch(() => undefined);

    expect(mockStateBackend.appendRollbackJournalSegment).toHaveBeenCalled();
    const segment = mockStateBackend.appendRollbackJournalSegment!.mock.calls.at(-1)![2] as {
      failedOperations?: Array<{ attemptedProperties?: Record<string, unknown> }>;
    };
    const attempted = segment.failedOperations![0]!.attemptedProperties!;
    expect(envOf(attempted)['PORT_LITERAL']).toBe(PORT_LITERAL_SOURCE);
    expect(envOf(attempted)['PIN_WHOLE']).toBe(PIN_EXPR_STAGED);
    expect(JSON.stringify(segment)).not.toContain(PORT_LITERAL_PLAINTEXT);
  });

  it('a reused engine does not journal a PREVIOUS deploy\'s attempted bag as today\'s: attemptedResolvedProps is reset per deploy', async () => {
    // Deploy 1 fails at the provider, so its attempted bag is recorded and
    // journaled. Deploy 2 on the SAME engine fails at resolution, before any
    // attempted bag of its own exists; without the per-deploy reset the
    // journal would carry deploy 1's bag — walked against today's template
    // and pairs, and now marked as today's — for an op that never resolved.
    mockProvider.create!.mockRejectedValue(new Error('AWS rejected the CREATE'));
    mockDiffCalculator.calculateDiff!.mockResolvedValue(changeMap('CREATE'));
    const engine = makeEngine({ noRollback: true });

    await engine.deploy(stackName, template).catch(() => undefined);
    const first = mockStateBackend.appendRollbackJournalSegment!.mock.calls.at(-1)![2] as {
      failedOperations?: Array<{ attemptedProperties?: Record<string, unknown> }>;
    };
    expect(first.failedOperations![0]!.attemptedProperties).toBeDefined();

    resolverRefuses = true;
    await engine.deploy(stackName, template).catch(() => undefined);

    const second = mockStateBackend.appendRollbackJournalSegment!.mock.calls.at(-1)![2] as {
      failedOperations?: Array<{ attemptedProperties?: Record<string, unknown> }>;
    };
    expect(mockStateBackend.appendRollbackJournalSegment).toHaveBeenCalledTimes(2);
    expect(second.failedOperations![0]!.attemptedProperties).toBeUndefined();
  });

  it('the in-deploy automatic rollback re-persists the PREVIOUS generation record as stored — no mark reaches it', async () => {
    // The previous deploy (pre-fix) stored the plaintext. Today's UPDATE of
    // the resource succeeds (its record is marked), a sibling then fails, and
    // the automatic rollback reverts the resource to its journaled
    // `previousState`. The post-rollback save persists THAT record — the
    // previous generation's, never marked — so the leaf comes back exactly
    // as it was stored: the plaintext, unchanged. The journal written before
    // the rollback still holds the token for the completed op (its
    // `properties` is the marked object), which is the same deploy showing
    // both answers side by side.
    const previous = {
      Environment: {
        Variables: { PORT_LITERAL: PORT_LITERAL_PLAINTEXT, PIN_WHOLE: PIN_EXPR_STAGED },
      },
      Handler: 'old.handler',
    };
    mockStateBackend.getState!.mockResolvedValue({ state: priorState(previous), etag: 'etag-1' });
    mockDagBuilder.getExecutionLevels!.mockReturnValue([['Fn'], ['Bad']]);
    // `Bad` DEPENDS on `Fn`, so the executor dispatches it only after `Fn`
    // completed — otherwise the two run concurrently and the failure can
    // reach the catch before `Fn`'s completion is journaled.
    mockDagBuilder.getDirectDependencies!.mockImplementation((_dag: unknown, id: string) =>
      id === 'Bad' ? ['Fn'] : []
    );
    mockProvider.create!.mockRejectedValue(new Error('AWS rejected the CREATE'));
    mockProvider.readCurrentState!.mockResolvedValue(undefined);
    const twoResources: CloudFormationTemplate = {
      Resources: {
        Fn: { Type: RESOURCE_TYPE, Properties: DESIRED },
        Bad: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'bad' } },
      },
    };
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        ...changeMap('UPDATE', previous),
        [
          'Bad',
          {
            logicalId: 'Bad',
            changeType: 'CREATE',
            resourceType: 'AWS::SQS::Queue',
            desiredProperties: { QueueName: 'bad' },
          },
        ],
      ])
    );

    await makeEngine()
      .deploy(stackName, twoResources)
      .catch(() => undefined);

    // The rollback reverted the resource (a second `update`, back to the
    // previous bag) and then persisted.
    expect(mockProvider.update).toHaveBeenCalledTimes(2);
    const record = savedState().resources['Fn']!;
    expect(record.properties['Handler']).toBe('old.handler');
    expect(envOf(record.properties)['PORT_LITERAL']).toBe(PORT_LITERAL_PLAINTEXT);
    // The FIRST segment is the one written before the rollback started, the
    // one that carries the completed UPDATE; a later segment records the
    // rollback's own outcome and names no completed op.
    const segment = mockStateBackend.appendRollbackJournalSegment!.mock.calls[0]![2] as {
      operations?: Array<{ logicalId: string; properties?: Record<string, unknown> }>;
    };
    const completed = segment.operations!.find((op) => op.logicalId === 'Fn')!;
    expect(envOf(completed.properties)['PORT_LITERAL']).toBe(PORT_LITERAL_SOURCE);
  });

  it('the auto-refresh readback of a resource the re-check reduced to no-change is marked and walked with today\'s pair, and converges on the stored token', async () => {
    // The population the drain's comment names: the diff called this UPDATE,
    // so `perResourceSecrets` holds today's pair, but the re-check found the
    // stored record already equal (it holds the token) and skipped the
    // provider. The record lacks `observedProperties`, so the auto-refresh
    // reads it back — a readback carrying today's plaintext at that offset —
    // and the marked walk writes the token: the same answer the record holds.
    const state = priorState(REDACTED);
    delete state.resources['Fn']!.observedProperties;
    mockStateBackend.getState!.mockResolvedValue({ state, etag: 'etag-1' });
    mockProvider.readCurrentState!.mockResolvedValue(structuredClone(REDACTED_AS_LIVE));
    mockDiffCalculator.calculateDiff!.mockResolvedValue(changeMap('UPDATE', REDACTED));

    await makeEngine().deploy(stackName, template);

    expect(mockProvider.update).not.toHaveBeenCalled();
    const record = savedState().resources['Fn']!;
    expect(envOf(record.observedProperties)['PORT_LITERAL']).toBe(PORT_LITERAL_SOURCE);
    expect(envOf(record.observedProperties)['PIN_WHOLE']).toBe(PIN_EXPR_STAGED);
    expect(JSON.stringify(savedState())).not.toContain(PORT_LITERAL_PLAINTEXT);
  });

  it('a provider-substituted effectiveProperties bag is NOT marked: its sub-floor leaves keep the scan\'s answer', async () => {
    // A replacement bag is of MIXED provenance — here it carries a leaf the
    // provider restored from somewhere the pass never resolved (`Carried`)
    // beside today's two. Marking the object would vouch for all three, so
    // none is vouched for: the two literal leaves keep the plaintext (the
    // residual the fix states), while the whole-value sibling is still
    // positioned by the template source, which needs no generation claim.
    mockProvider.create!.mockResolvedValue({
      physicalId: 'fn-phys',
      attributes: {},
      effectiveProperties: {
        Environment: {
          Variables: {
            PORT_LITERAL: PORT_LITERAL_PLAINTEXT,
            PIN_WHOLE: PIN,
            Carried: PORT_LITERAL_PLAINTEXT,
          },
        },
        Handler: 'index.handler',
      },
    });
    mockProvider.readCurrentState!.mockResolvedValue(undefined);
    mockDiffCalculator.calculateDiff!.mockResolvedValue(changeMap('CREATE'));

    await makeEngine().deploy(stackName, template);

    const env = envOf(savedState().resources['Fn']!.properties);
    expect(env['PORT_LITERAL']).toBe(PORT_LITERAL_PLAINTEXT);
    expect(env['Carried']).toBe(PORT_LITERAL_PLAINTEXT);
    expect(env['PIN_WHOLE']).toBe(PIN_EXPR_STAGED);
  });

  it('a record the pass did NOT rewrite keeps its previous-generation plaintext when the deploy fails after resolution', async () => {
    // The previous deploy (pre-fix) persisted the plaintext. Today's template
    // resolves the same token to the same value, the record has entered the
    // update arm (so the choke point holds today's template AND today's pair
    // for it), and the provider call fails. The persisted record is still the
    // previous generation: no object the engine marked, so the leaf stays
    // exactly as stored. A caller- or rules-level "this walk is same
    // generation" claim would rewrite it here.
    const previous = {
      Environment: {
        Variables: { PORT_LITERAL: PORT_LITERAL_PLAINTEXT, PIN_WHOLE: PIN_EXPR_STAGED },
      },
      Handler: 'old.handler',
    };
    mockStateBackend.getState!.mockResolvedValue({ state: priorState(previous), etag: 'etag-1' });
    mockProvider.update!.mockRejectedValue(new Error('AWS rejected the UPDATE'));
    mockDiffCalculator.calculateDiff!.mockResolvedValue(changeMap('UPDATE', previous));

    await expect(makeEngine({ noRollback: true }).deploy(stackName, template)).rejects.toThrow(
      'Failed to update resource Fn'
    );

    expect(mockStateBackend.saveState).toHaveBeenCalled();
    const record = savedState().resources['Fn']!;
    expect(envOf(record.properties)['PORT_LITERAL']).toBe(PORT_LITERAL_PLAINTEXT);
    expect(envOf(record.observedProperties)['PORT_LITERAL']).toBe(PORT_LITERAL_PLAINTEXT);
    expect(record.properties['Handler']).toBe('old.handler');
  });

  it('the no-change re-check compares a MARKED copy of the resolved bag, so a stored token is a no-op rather than a perpetual UPDATE', async () => {
    // A deploy under this fix wrote the token; the next deploy of the same
    // template resolves to the same plaintext and must find NO change. The
    // re-check redacts the resolved bag before comparing, and without the
    // mark that bag reads `port:q7` against the stored `port:{{resolve:...}}`
    // — an UPDATE on every deploy, which is the regression the probe copy
    // exists to prevent.
    mockStateBackend.getState!.mockResolvedValue({ state: priorState(REDACTED), etag: 'etag-1' });
    mockDiffCalculator.calculateDiff!.mockResolvedValue(changeMap('UPDATE', REDACTED));

    await makeEngine().deploy(stackName, template);

    expect(mockProvider.update).not.toHaveBeenCalled();
    expect(mockProvider.create).not.toHaveBeenCalled();
  });

  it('the copy is what is marked, not the resolved bag itself: a later effectiveProperties substitution is still unmarked', async () => {
    // The re-check finds a real change (the handler moved), the provider
    // substitutes a replacement bag, and that bag must keep the residual —
    // which it would not if the re-check had marked `resolvedProps` in place
    // and a provider handed the SAME object back as `effectiveProperties`.
    const previous = {
      Environment: {
        Variables: { PORT_LITERAL: PORT_LITERAL_SOURCE, PIN_WHOLE: PIN_EXPR_STAGED },
      },
      Handler: 'old.handler',
    };
    mockStateBackend.getState!.mockResolvedValue({ state: priorState(previous), etag: 'etag-1' });
    mockProvider.update!.mockImplementation(
      (_l: string, _p: string, _t: string, props: Record<string, unknown>) =>
        Promise.resolve({ physicalId: 'fn-phys', wasReplaced: false, effectiveProperties: props })
    );
    mockProvider.readCurrentState!.mockResolvedValue(undefined);
    mockDiffCalculator.calculateDiff!.mockResolvedValue(changeMap('UPDATE', previous));

    await makeEngine().deploy(stackName, template);

    expect(mockProvider.update).toHaveBeenCalled();
    const env = envOf(savedState().resources['Fn']!.properties);
    expect(env['PORT_LITERAL']).toBe(PORT_LITERAL_PLAINTEXT);
    expect(env['PIN_WHOLE']).toBe(PIN_EXPR_STAGED);
  });

  it('the drained readback is marked as a COPY, so the object a provider returned by identity is left unmarked', async () => {
    // m1 of the PR 2753 review. The schema-upgrade auto-refresh hands
    // `readCurrentState` the record's own `properties` -- the PREVIOUS
    // generation's bag -- as its 4th argument, so a provider returning that
    // argument BY IDENTITY would put a permanent same-generation mark on an
    // object still installed on the record. No provider under
    // `src/provisioning/` does that today, so this case IS the population.
    //
    // The mark itself is module-private, so the assertion is what it BUYS:
    // after the deploy, the very object the provider handed back is walked
    // again through the public entry point with a TEMPLATE source spelling
    // the token and a pass map carrying the pair. Under
    // `TEMPLATE_DERIVED_RULES` the source makes no generation claim of its
    // own, so the OBJECT's mark is what decides -- marked, the sub-floor
    // middle becomes the token; unmarked, the scan's answer stands.
    const aliased = {
      Environment: { Variables: { PORT_LITERAL: PORT_LITERAL_PLAINTEXT, PIN_WHOLE: PIN } },
      Handler: 'index.handler',
    };
    const state = priorState(REDACTED);
    state.resources['Fn']!.properties = aliased;
    delete state.resources['Fn']!.observedProperties;
    mockStateBackend.getState!.mockResolvedValue({ state, etag: 'etag-1' });
    mockProvider.readCurrentState!.mockImplementation(
      // BY IDENTITY -- the return shape the mark's contract forbids.
      (_p: string, _l: string, _t: string, props: unknown) => Promise.resolve(props)
    );
    mockDiffCalculator.calculateDiff!.mockResolvedValue(new Map<string, ResourceChange>());
    mockDiffCalculator.hasChanges!.mockReturnValue(false);

    await makeEngine().deploy(stackName, template);

    expect(mockProvider.readCurrentState).toHaveBeenCalled();
    const passMap = new Map<string, string>([[PIN, PIN_EXPR]]);
    recordResolvedPair(passMap, PIN_EXPR, PIN);
    const walked = redactSecretsForState(aliased, passMap, {
      Environment: { Variables: { PORT_LITERAL: PORT_LITERAL_SOURCE, PIN_WHOLE: PIN_EXPR } },
    });
    expect(envOf(walked)['PORT_LITERAL']).toBe(PORT_LITERAL_PLAINTEXT);
  });

  it('an UNCHANGED resource auto-refresh walks an EMPTY secrets map, so no pair this pass never resolved reaches its readback', async () => {
    // m2 of the PR 2753 review. `drainObservedCaptures` marks EVERY capture
    // it drains, wider
    // than the issue's "freshly created / updated resource" wording; what
    // closes the gap is that `perResourceSecrets` is populated only in the
    // create / update arms, so an unchanged resource's auto-refresh walks an
    // empty map and the span arm cannot fire. That fact lived only in a
    // comment, and a future change to the persist walk's `secrets ?? new
    // Map()` fallback would fabricate a token onto a previous-generation
    // readback; the integ's Phase 1g cannot tell the two apart, because what
    // it asserts is the expression.
    //
    // The shape is the docstring's own hazard: the RECORD holds a previous
    // generation at the leaf while the READBACK coincides with today's
    // plaintext (`port:0` where AWS returns a default and today's secret
    // resolved to `0`). MEASURED, and stated exactly: a fallback carrying
    // THIS pass's own pair reds this case at the WHOLE-VALUE leaf, through
    // the value scan's floorless exact-match arm. It does NOT red at the
    // embedded leaf, because this record's source spells no token there and
    // the span arm has nothing to position from -- so what this case pins is
    // that an empty map admits no pair at all, not that the span arm is
    // separately fenced (maintainer-checklist round 2). The span arm's own
    // fence is the mark, pinned by the case above.
    const previous = {
      Environment: { Variables: { PORT_LITERAL: 'port:ZZ', PIN_WHOLE: 'ZZ' } },
      Handler: 'index.handler',
    };
    const state = priorState(previous);
    delete state.resources['Fn']!.observedProperties;
    mockStateBackend.getState!.mockResolvedValue({ state, etag: 'etag-1' });
    mockProvider.readCurrentState!.mockResolvedValue(structuredClone(REDACTED_AS_LIVE));
    // No CREATE and no UPDATE: nothing populates `perResourceSecrets`.
    mockDiffCalculator.calculateDiff!.mockResolvedValue(new Map<string, ResourceChange>());
    mockDiffCalculator.hasChanges!.mockReturnValue(false);

    await makeEngine().deploy(stackName, template);

    expect(mockProvider.update).not.toHaveBeenCalled();
    // The auto-refresh actually RAN: without this the assertions below would
    // be satisfied by a record that simply grew no `observedProperties`.
    expect(mockProvider.readCurrentState).toHaveBeenCalled();
    const record = savedState().resources['Fn']!;
    expect(record.observedProperties).toBeDefined();
    expect(envOf(record.observedProperties)['PORT_LITERAL']).toBe(PORT_LITERAL_PLAINTEXT);
    expect(envOf(record.observedProperties)['PIN_WHOLE']).toBe(PIN);
    // The decisive negative: no expression this pass never resolved reaches a
    // bag it never produced, at either offset.
    expect(JSON.stringify(record.observedProperties)).not.toContain(PIN_EXPR);
    expect(JSON.stringify(record.observedProperties)).not.toContain(PIN_EXPR_STAGED);
  });

  it('an engine-directed REPLACEMENT records the token: the re-create call site marks through the same helper', async () => {
    // m3 of the PR 2753 review: issue #2516 names three `propertiesToRecord`
    // call sites and this file reached only the create and ordinary-update
    // ones. The third is the PROPERTY-DRIVEN replacement, which the engine
    // reaches from `propertyChanges[].requiresReplacement` and which records
    // the bag against its own CREATE result -- not `wasReplaced` on an update
    // result, which stays on the ordinary update's site (found by review of
    // this very case). `AWS::Lambda::Function` is not a stateful recreate
    // target, so the replacement runs without `forceStatefulRecreation`.
    const previous = {
      Environment: { Variables: { PORT_LITERAL: 'port:ZZ', PIN_WHOLE: 'ZZ' } },
      Handler: 'old.handler',
    };
    mockStateBackend.getState!.mockResolvedValue({ state: priorState(previous), etag: 'etag-1' });
    mockProvider.create!.mockResolvedValue({ physicalId: 'fn-phys-2', attributes: {} });
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Fn',
          {
            logicalId: 'Fn',
            changeType: 'UPDATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: DESIRED,
            currentProperties: previous,
            propertyChanges: [
              {
                path: 'Handler',
                oldValue: 'old.handler',
                newValue: 'index.handler',
                requiresReplacement: true,
              },
            ],
          },
        ],
      ])
    );

    await makeEngine().deploy(stackName, template);

    // The replacement RAN through the create arm, so the assertions below are
    // about the site this case exists to reach.
    expect(mockProvider.create).toHaveBeenCalled();
    // The replacement is a CREATE plus a delete of the OLD physical id, so the
    // cleanup half is bounded by that id and not merely by the call: deleting
    // the NEW one instead leaks the old resource and satisfies a bare
    // `toHaveBeenCalled` (maintainer-checklist round 4).
    expect(mockProvider.delete).toHaveBeenCalledWith(
      'Fn',
      'fn-phys',
      RESOURCE_TYPE,
      // The OLD generation's bag, not today's: `expect.anything()` here would
      // refuse only `null` / `undefined`, so a delete handed the new bag would
      // satisfy it (maintainer review of PR 2753, round 3).
      expect.objectContaining({ Handler: 'old.handler' }),
      expect.anything()
    );
    const record = savedState().resources['Fn']!;
    expect(record.physicalId).toBe('fn-phys-2');
    const env = envOf(record.properties);
    expect(env['PORT_LITERAL']).toBe(PORT_LITERAL_SOURCE);
    expect(env['PIN_WHOLE']).toBe(PIN_EXPR_STAGED);
    expect(JSON.stringify(savedState())).not.toContain(PORT_LITERAL_PLAINTEXT);
  });

  it('the record\'s bag is marked AFTER the route drops a silent-drop key, so the narrowed object is the marked one', async () => {
    // The merge of issue #2750's route narrowing with this fix (PR 2753,
    // maintainer-checklist round 4). `withoutSilentDropProperties` returns a
    // NEW object whenever it removes a key, so marking before it would leave
    // the mark on an object the record never holds and the embedded leaf back
    // in plaintext. Every other case in this file drops nothing, which is why
    // that ordering is invisible to them: here the SDK route removes
    // `CapacityProviderConfig` and the embedded secret must still be written
    // as its token.
    const DROPPED = 'CapacityProviderConfig';
    const desired = { ...DESIRED, [DROPPED]: { Some: 'value' } };
    // Inert for the assertions below -- see the mock's own comment. Kept so the
    // case describes a real `--allow-unsupported-properties` deploy.
    mockProviderRegistry.getAllowedUnsupportedProperties!.mockReturnValue(
      new Set([`${RESOURCE_TYPE}:${DROPPED}`])
    );
    mockProvider.readCurrentState!.mockResolvedValue(undefined);
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Fn',
          {
            logicalId: 'Fn',
            changeType: 'CREATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: desired,
          },
        ],
      ])
    );

    await makeEngine().deploy(stackName, {
      Resources: { Fn: { Type: RESOURCE_TYPE, Properties: desired } },
    });

    const record = savedState().resources['Fn']!;
    // The premise: the route really did drop the key, so the marked object is
    // the narrowed copy and not the bag the engine resolved.
    expect(record.properties[DROPPED]).toBeUndefined();
    expect(envOf(record.properties)['PORT_LITERAL']).toBe(PORT_LITERAL_SOURCE);
    expect(envOf(record.properties)['PIN_WHOLE']).toBe(PIN_EXPR_STAGED);
  });

  it('a Cloud Control route keeps a property the SDK route would drop, and its effectiveProperties bag is still unmarked', async () => {
    // The negative control for the route guard the same merge preserves: the
    // narrowing is the SDK route's, so a `cc-api` resource keeps the key --
    // Cloud Control forwards the full map. The bag is a provider-substituted
    // `effectiveProperties`, so its sub-floor leaf keeps the scan's answer,
    // which is this fix's stated residual rather than a regression.
    const DROPPED = 'CapacityProviderConfig';
    mockProviderRegistry.getProviderFor!.mockReturnValue({
      provider: mockProvider,
      provisionedBy: 'cc-api',
    });
    mockProvider.create!.mockResolvedValue({
      physicalId: 'fn-phys',
      attributes: {},
      effectiveProperties: {
        ...REDACTED_AS_LIVE,
        [DROPPED]: { Some: 'value' },
      },
    });
    mockProvider.readCurrentState!.mockResolvedValue(undefined);
    mockDiffCalculator.calculateDiff!.mockResolvedValue(changeMap('CREATE'));

    await makeEngine().deploy(stackName, template);

    const record = savedState().resources['Fn']!;
    expect(record.properties[DROPPED]).toEqual({ Some: 'value' });
    expect(envOf(record.properties)['PORT_LITERAL']).toBe(PORT_LITERAL_PLAINTEXT);
  });
});
