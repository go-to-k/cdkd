import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ChangeType, ResourceChange } from '../../../src/types/state.js';

// Hoisted so the cases can read what was LOGGED. The advice is a log line, not
// a thrown message -- the AWS sentence has to stay verbatim in the throw for
// the retry classifiers, which read it by substring.
const { loggerFns } = vi.hoisted(() => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): unknown => fns,
  };
  return { loggerFns: fns };
});

vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => loggerFns }));

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

/**
 * Issue #2902: a plain CREATE that collides on a name cdkd itself derived.
 *
 * The reported loop: a rollback leaves a `DeletionPolicy: Retain` resource in
 * AWS and drops its state record (CloudFormation semantics, deliberate), and
 * cdkd's generated names carry no random component -- so the next deploy asks
 * AWS for exactly the name the orphan still holds, fails, rolls back, and
 * repeats. CloudFormation never shows this because its generated names carry a
 * random suffix. Before the fix the user saw only the bare AWS sentence, and
 * the reported recovery was hand-deleting resources through the AWS API.
 *
 * The refusals matter as much as the advice, which is why most of the cases
 * below are negative: telling a user to `cdkd import` a name their template
 * supplied could be telling them to adopt a resource this stack does not own.
 */
describe('plain-CREATE collision on a cdkd-derived name (#2902)', () => {
  const TYPE = 'AWS::Pipes::Pipe'; // non-stateful: the stateful guard stays out of the way
  const STACK = 'MyStack';
  const LOGICAL = 'Pipe';

  let provider: ResourceProvider;
  let createError: Error;
  let providerHasImport: boolean;

  const collisionError = (physicalId: string | undefined) =>
    new ProvisioningError(
      `Failed to create IAM role ${LOGICAL}: Role with name ${physicalId ?? '?'} already exists.`,
      TYPE,
      LOGICAL,
      physicalId
    );

  beforeEach(() => {
    vi.clearAllMocks();
    providerHasImport = true;
    createError = collisionError(`${STACK}-${LOGICAL}`);
    provider = {
      create: vi.fn().mockImplementation(async () => {
        throw createError;
      }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const providerForRegistry = (): ResourceProvider =>
      providerHasImport
        ? ({ ...provider, import: vi.fn() } as unknown as ResourceProvider)
        : provider;
    const mockProviderRegistry = {
      getProvider: vi.fn().mockImplementation(providerForRegistry),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
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
      {},
      'us-east-1'
    );
  }

  /**
   * Drive `provisionResource` INSIDE a `withStackName` scope, as the engine's
   * own `deploy()` does: `looksLikeCdkdGeneratedName` reads it, and a test
   * without the scope takes the unresolvable branch and passes for the wrong
   * reason -- so every negative case here would be vacuous.
   */
  async function attempt(changeType: ChangeType = 'CREATE'): Promise<string[]> {
    const engine = makeEngine();
    const change: ResourceChange = {
      logicalId: LOGICAL,
      changeType,
      resourceType: TYPE,
      desiredProperties: { Source: 'arn:b' },
      propertyChanges: [],
      ...(changeType === 'CREATE' ? {} : { currentProperties: { Source: 'arn:a' } }),
    } as ResourceChange;
    const template: CloudFormationTemplate = {
      Resources: { [LOGICAL]: { Type: TYPE, Properties: { Source: 'arn:b' } } },
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

    await withStackName(STACK, () =>
      provisionResource(LOGICAL, change, {}, STACK, template).then(
        () => {
          throw new Error('expected the create to fail');
        },
        () => undefined
      )
    );
    return loggerFns.error.mock.calls.map((c: unknown[]) => String(c[0]));
  }

  const adviceIn = (lines: string[]): string | undefined =>
    lines.find((l) => l.includes('is one cdkd DERIVED from'));

  it('names the collision as cdkd’s own orphan and gives an import command', async () => {
    const advice = adviceIn(await attempt());

    expect(advice).toBeDefined();
    // The three facts the user cannot act without: WHICH name, WHY it is taken,
    // and WHAT to run. Asserted separately so a reword that drops one is red.
    expect(advice).toContain(`${STACK}-${LOGICAL}`);
    expect(advice).toContain('DeletionPolicy: Retain');
    expect(advice).toContain(`cdkd import ${STACK} --resource ${LOGICAL}=${STACK}-${LOGICAL}`);
  });

  it('leaves the raw AWS sentence intact on its own line', async () => {
    const lines = await attempt();
    // The retry classifiers read the AWS text by SUBSTRING, so the advice must
    // be a SEPARATE line rather than appended to it.
    expect(lines.some((l) => l.includes('already exists.') && !l.includes('cdkd DERIVED'))).toBe(
      true
    );
  });

  it('says nothing for a name the TEMPLATE supplied', async () => {
    // The load-bearing refusal: that resource may be someone else's entirely,
    // and `cdkd import` would be advice to adopt it.
    createError = collisionError('a-name-the-user-chose');
    expect(adviceIn(await attempt())).toBeUndefined();
  });

  it('says nothing when the failure is not a name collision', async () => {
    // The message is a TERMINAL validation failure, checked against the real
    // classifiers rather than picked by eye: the first attempt here used
    // `Rate exceeded`, which IS retryable, so the engine spent the real 47s
    // backoff and the case failed as a 5s TIMEOUT -- green for the wrong
    // reason had the timeout been generous.
    createError = new ProvisioningError(
      `Failed to create ${LOGICAL}: Member must satisfy constraint: [Source is required]`,
      TYPE,
      LOGICAL,
      `${STACK}-${LOGICAL}`
    );
    expect(adviceIn(await attempt())).toBeUndefined();
  });

  it('says nothing, and prints no `undefined`, when the error carries no id', async () => {
    // A create that failed BEFORE the AWS call names no id, so there is nothing
    // to diagnose and nothing to import.
    //
    // This does NOT fence the explicit `if (!physicalId)` guard -- measured,
    // deleting that guard leaves this green, because
    // `looksLikeCdkdGeneratedName` refuses a falsy id itself. What it pins is
    // the OUTCOME both guards exist for: no advice, and in particular no line
    // offering to import a resource called `undefined`.
    createError = collisionError(undefined);
    const lines = await attempt();

    expect(adviceIn(lines)).toBeUndefined();
    expect(lines.some((l) => l.includes('undefined'))).toBe(false);
  });

  it('leaves a REPLACEMENT collision to its own RENAME advice', async () => {
    // Confusing the two would be worse than silence: renaming does not recover
    // an orphan, and importing is wrong for a live resource being replaced.
    //
    // This case drives the REAL replacement path -- a state record whose
    // physicalId the create-first attempt then collides with. That matters:
    // the first version passed an EMPTY state map, which never reaches the
    // replacement branch at all, so it was green with the CREATE guard deleted
    // (measured). The engine refuses upstream at `NAMED_REPLACEMENT_COLLISION`
    // and never reaches the catch this issue's advice lives in, which is why
    // the `changeType !== 'CREATE'` guard there is defence in depth rather than
    // a live discriminator -- and why the assertion here is about the two
    // messages staying DISTINCT rather than about that guard.
    const engine = makeEngine();
    const change: ResourceChange = {
      logicalId: LOGICAL,
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { Source: 'arn:a' },
      desiredProperties: { Source: 'arn:b' },
      propertyChanges: [
        { path: 'Source', oldValue: 'arn:a', newValue: 'arn:b', requiresReplacement: true },
      ],
    };
    const stateResources = {
      [LOGICAL]: {
        physicalId: `${STACK}-${LOGICAL}`,
        resourceType: TYPE,
        properties: { Source: 'arn:a' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk' as const,
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { [LOGICAL]: { Type: TYPE, Properties: { Source: 'arn:b' } } },
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

    await withStackName(STACK, () =>
      provisionResource(LOGICAL, change, stateResources, STACK, template).then(
        () => {
          throw new Error('expected the replacement collision refusal');
        },
        () => undefined
      )
    );
    const lines = loggerFns.error.mock.calls.map((c: unknown[]) => String(c[0]));

    // The replacement path really did fire...
    expect(lines.some((l) => l.includes('requires replacement'))).toBe(true);
    expect(lines.some((l) => l.includes('rename the CONSTRUCT'))).toBe(true);
    // ...and this issue's advice stayed out of it.
    expect(adviceIn(lines)).toBeUndefined();
    expect(lines.some((l) => l.includes('cdkd import'))).toBe(false);
  });

  it('does not offer import for a type whose provider cannot import', async () => {
    providerHasImport = false;
    const advice = adviceIn(await attempt());

    expect(advice).toBeDefined();
    expect(advice).toContain('implements no import');
    // Naming a remedy whose precondition the code never checks is the #2610
    // class; `runImportForResource` would SKIP such a type with
    // `skipped-no-impl` and leave the user exactly where they started.
    expect(advice).not.toContain('cdkd import');
  });
});
