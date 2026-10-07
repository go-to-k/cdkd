import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import { markAuxiliaryFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ChangeType, ResourceChange } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

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

  // `logicalId` is a parameter, not the closed-over `LOGICAL`, because
  // `isNameCollisionErrorFrom` is ANCHORED on it (issue go-to-k/cdkd#3208): a
  // link naming another resource cannot classify this one. Hardcoding `LOGICAL`
  // here while `attempt()` handed the engine a DIFFERENT id manufactured a
  // mismatch production cannot produce — both sides come from one
  // `change.logicalId` — and the anchor then correctly refused the error.
  const collisionError = (physicalId: string | undefined, logicalId: string = LOGICAL) =>
    new ProvisioningError(
      `Failed to create IAM role ${logicalId}: Role with name ${physicalId ?? '?'} already exists.`,
      TYPE,
      logicalId,
      physicalId,
      awsSdkError(
        `Role with name ${physicalId ?? '?'} already exists.`,
        'EntityAlreadyExistsException'
      )
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
  async function attempt(
    changeType: ChangeType = 'CREATE',
    stackName: string = STACK,
    physicalIdOverride?: string,
    logicalIdOverride?: string
  ): Promise<string[]> {
    const id = logicalIdOverride ?? LOGICAL;
    if (physicalIdOverride !== undefined || logicalIdOverride !== undefined) {
      createError = collisionError(physicalIdOverride ?? `${STACK}-${LOGICAL}`, id);
    }
    const engine = makeEngine();
    const change: ResourceChange = {
      logicalId: id,
      changeType,
      resourceType: TYPE,
      desiredProperties: { Source: 'arn:b' },
      propertyChanges: [],
      ...(changeType === 'CREATE' ? {} : { currentProperties: { Source: 'arn:a' } }),
    } as ResourceChange;
    const template: CloudFormationTemplate = {
      Resources: { [id]: { Type: TYPE, Properties: { Source: 'arn:b' } } },
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

    await withStackName(stackName, () =>
      provisionResource(id, change, {}, stackName, template).then(
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
  const replayAdviceIn = (lines: string[]): string | undefined =>
    lines.find((l) => l.includes('resource THIS create made'));

  it('names the collision as cdkd’s own orphan and gives an import command', async () => {
    const advice = adviceIn(await attempt());

    expect(advice).toBeDefined();
    // The three facts the user cannot act without: WHICH name, WHY it is taken,
    // and WHAT to run. Asserted separately so a reword that drops one is red.
    expect(advice).toContain(`${STACK}-${LOGICAL}`);
    expect(advice).toContain('DeletionPolicy: Retain');
    expect(advice).toContain(`cdkd import ${STACK} --resource '${LOGICAL}=${STACK}-${LOGICAL}'`);
  });

  it('names CloudFormation as the DIFFERENCE, not as doing the same thing', async () => {
    // The message is printed to someone whose deploy just got stuck. An earlier
    // revision said "(CloudFormation does the same)" immediately before the
    // clause where it does NOT -- which reads as "this is normal, cdk deploy
    // would stick too", and is false for exactly the population that hits this:
    // a resource the template did not name, for which CFn generates a fresh
    // random-suffixed name and redeploys clean.
    //
    // Fenced because nothing else would notice a reword back. The positive
    // half is asserted too, so deleting the sentence is not a way to pass.
    const advice = adviceIn(await attempt());

    expect(advice).toBeDefined();
    expect(advice).toContain('what differs is the name');
    expect(advice).toContain('CloudFormation would generate a fresh one');
    expect(advice).not.toContain('CloudFormation does the same');
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

  it('gives the REPLAY diagnosis after an auxiliary failure (#3972, #3984)', async () => {
    // `withRetry` carries an auxiliary attempt's mark onto the replay's
    // "already exists": that attempt's main create may have SUCCEEDED, so the
    // holder is most likely this create's own. The orphan-of-an-earlier-run
    // text (a `Retain`) would misdescribe it, which is why this case printed
    // nothing before #3984; it now gets the replay line. The first attempt
    // fails on a throttled auxiliary call (1s of real backoff), the replay
    // collides.
    const collision = createError;
    let calls = 0;
    provider.create = vi.fn().mockImplementation(async () => {
      if (calls++ > 0) throw collision;
      throw markAuxiliaryFailure(
        new ProvisioningError(
          `Failed to create ${LOGICAL}: Rate exceeded`,
          TYPE,
          LOGICAL,
          `${STACK}-${LOGICAL}`,
          awsSdkError('Rate exceeded', 'ThrottlingException')
        ),
        LOGICAL
      );
    });
    const lines = await attempt();

    expect(calls).toBe(2);
    expect(adviceIn(lines)).toBeUndefined();
    expect(replayAdviceIn(lines)).toBeDefined();
    expect(provider.delete).not.toHaveBeenCalled();
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
    // (measured).
    //
    // The refusal DOES reach the catch the advice lives in -- the
    // `NAMED_REPLACEMENT_COLLISION` throw happens inside `provisionUpdate`,
    // called inside the same `try`, and the `requires replacement` assertion
    // below only passes BECAUSE it was logged there. What refuses it is the
    // `ProvisioningError` check (the upstream throws `CdkdError`), so deleting
    // either that guard or the CREATE guard alone leaves this green. The
    // assertion is therefore about the two messages staying DISTINCT, which is
    // the property that matters: one says RENAME, which does not recover an
    // orphan.
    //
    // A nameless Lambda function, not the file's Pipe: its generated name is
    // one cdkd predicts, so the #3979 holder proof accepts the old function as
    // the collider and the rename advice is what this path prints.
    const REPLACED_TYPE = 'AWS::Lambda::Function';
    const engine = makeEngine();
    const change: ResourceChange = {
      logicalId: LOGICAL,
      changeType: 'UPDATE',
      resourceType: REPLACED_TYPE,
      currentProperties: { Source: 'arn:a' },
      desiredProperties: { Source: 'arn:b' },
      propertyChanges: [
        { path: 'Source', oldValue: 'arn:a', newValue: 'arn:b', requiresReplacement: true },
      ],
    };
    const stateResources = {
      [LOGICAL]: {
        physicalId: `${STACK}-${LOGICAL}`,
        resourceType: REPLACED_TYPE,
        properties: { Source: 'arn:a' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk' as const,
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { [LOGICAL]: { Type: REPLACED_TYPE, Properties: { Source: 'arn:b' } } },
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

  it('fires for the TRUNCATED name form the issue actually reported', async () => {
    // `<prefix>-<8 hex>`, which `generateResourceName` produces once the plain
    // derivation exceeds the type's length limit. This is the shape in issue
    // #2902's own transcript (`...-ApiGatewayAccoun-19184149`), and it takes a
    // DIFFERENT branch of `looksLikeCdkdGeneratedName` than the plain form
    // every other case here uses -- deleting that branch left this file green
    // before this case existed.
    const truncated = `${STACK.slice(0, 12).toLowerCase()}-19184149`;
    createError = collisionError(truncated);
    const advice = adviceIn(await attempt());

    expect(advice).toBeDefined();
    expect(advice).toContain(truncated);
  });

  it('HOLES a name carrying shell metacharacters in the pasteable command (go-to-k/cdkd#4205)', async () => {
    // `looksLikeCdkdGeneratedName` compares only the ALPHANUMERIC skeleton, so
    // a name whose extra characters are all metacharacters passes the guard --
    // and this line is built to be PASTED into a shell.
    //
    // `$()` and not `$(id)`: the skeleton strips only NON-alphanumerics, so a
    // payload carrying letters changes it and the guard refuses first.
    //
    // The outcome is a HOLE, not a quoted value: quoting held only while the
    // quote parity before the command was even, and text the operator pastes
    // ABOVE the advice sets that parity (go-to-k/cdkd#4205). The advice's own
    // prose carries no unpaired apostrophe.
    const hostile = `${STACK}-${LOGICAL}$()`;
    createError = collisionError(hostile);
    const advice = adviceIn(await attempt());

    expect(advice).toBeDefined();
    expect(advice!.split('\n').at(-1)).toBe(
      `Adopt with: cdkd import ${STACK} --resource '<logicalId=physicalId>'`
    );
    expect(advice).not.toContain(`'${LOGICAL}=${hostile}'`);
    // The prose DESCRIBES the id (JSON quotes would still run its `$( )`), and
    // the sentence says what the hole is.
    expect(advice).toContain('the name AWS reports as taken (a name that cannot be shown safely here)');
    expect(advice).toContain('delete it in AWS');
    expect(advice).not.toContain('$()');
    expect(advice).toContain('prints a quoted hole in place of a value cdkd will not name');
  });

  it('describes a non-inert LOGICAL id in the prose, and holes the pair (go-to-k/cdkd#4205)', async () => {
    const id = `${LOGICAL}$()`;
    const advice = adviceIn(await attempt('CREATE', STACK, `${STACK}-${LOGICAL}`, id));
    expect(advice).toBeDefined();
    expect(advice).toMatch(/^A resource whose logical id cannot be shown safely here: the name AWS/);
    expect(advice).not.toContain('$()');
    expect(advice!.split('\n').at(-1)).toBe(
      `Adopt with: cdkd import ${STACK} --resource '<logicalId=physicalId>'`
    );
  });

  it('names clean values in the prose and prints no hole note', async () => {
    const advice = adviceIn(await attempt());
    expect(advice).toMatch(new RegExp(`^${LOGICAL}: the name AWS reports as taken \\(${STACK}-${LOGICAL}\\)`));
    expect(advice).toContain(`delete ${STACK}-${LOGICAL} in AWS`);
    expect(advice).not.toContain('quoted hole');
  });

  it('holes a payload STACK name, and no pasted span runs (go-to-k/cdkd#4205)', async () => {
    // The stack name comes from the assembly, unvalidated. The id is derived
    // from its alphanumeric skeleton, so the guard admits it and the prose
    // (which never prints the stack name) stays plain. The prose has no
    // unpaired apostrophe, so it is the harness's OPERATOR_FLIP (text pasted
    // above the advice) that makes a shell-quoted stack name run here.
    const messages: Array<[string, string]> = [];
    for (const { label, value } of PASTE_PAYLOADS) {
      loggerFns.error.mockClear();
      const skeleton = value.replace(/[^A-Za-z0-9]/g, '');
      const advice = adviceIn(await attempt('CREATE', value, `${skeleton}-${LOGICAL}`));
      expect(advice, label).toBeDefined();
      expect(advice!.split('\n').at(-1), label).toBe(
        `Adopt with: cdkd import '<stack>' --resource '${LOGICAL}=${skeleton}-${LOGICAL}'`
      );
      expect(advice, label).toContain('prints a quoted hole in place of a value cdkd will not name');
      messages.push([label, advice!]);
    }
    withPasteDir((dir) => {
      for (const [label, message] of messages) expect(spansThatRun(message, dir), label).toEqual([]);
    });
  }, 120_000);

  it('withholds the command when sanitising CHANGES the name', async () => {
    // A control character survives `looksLikeCdkdGeneratedName` (its skeleton
    // strips every non-alphanumeric), so the guard admits the name -- and a
    // command carrying it would name a resource AWS does not hold. Both
    // suppression comparisons were unfenced before this case: deleting either
    // left the suite green.
    createError = collisionError(`${STACK}-${LOGICAL}\u0007`);
    const advice = adviceIn(await attempt());

    expect(advice).toBeDefined();
    expect(advice).not.toContain('--resource');
    // ...and the name is still printed, sanitised, in the prose.
    expect(advice).not.toContain('\u0007');
  });

  it('withholds the command when sanitising changes the LOGICAL id', async () => {
    // The third value the command carries. It was outside the comparison until
    // round 3: with a clean physical id, the guard admits a dirty logical id
    // (its skeleton strips the control character) and cdkd emitted a command
    // naming a logical id no template or state record holds.
    const advice = adviceIn(
      await attempt('CREATE', STACK, `${STACK}-${LOGICAL}`, `${LOGICAL}\u0007`)
    );

    expect(advice).toBeDefined();
    expect(advice).not.toContain('--resource');
  });

  it('withholds the command when sanitising changes the STACK name', async () => {
    // The stack-name half of the same comparison, ISOLATED from the id half.
    // The physical id is deliberately CLEAN: the guard's skeleton strips the
    // control character out of the stack name before comparing, so a clean
    // `MyStack-Pipe` still matches a dirty `MyStack\u0007` derivation -- which
    // leaves the stack comparison as the only thing that can refuse. The first
    // version dirtied BOTH, so the id comparison refused first and deleting the
    // stack one left the suite green (measured).
    const advice = adviceIn(await attempt('CREATE', `${STACK}\u0007`, `${STACK}-${LOGICAL}`));

    expect(advice).toBeDefined();
    expect(advice).not.toContain('--resource');
  });

  it('takes the delete-only arm inside a nested-stack child', async () => {
    // A child deploys as `<parent>~<logicalId>`, and CDK's stack-name rule bars
    // `~`, so no Cloud Assembly stack can carry that name -- `cdkd import`
    // resolves its target from the assembly and would never find it. Printing
    // the command there is the #2610 class one level down.
    const nested = `Parent~${STACK}`;
    createError = collisionError(`${nested}-${LOGICAL}`);
    const advice = adviceIn(await attempt('CREATE', nested));

    expect(advice).toBeDefined();
    // `--resource` and not `cdkd import`: THIS arm's reason names the command
    // while withholding it ("whose stack name cdkd import cannot resolve"), so
    // only the flag distinguishes it. Measured: swapping the assertion reddens
    // this case alone -- the other withholding arms' prose contains no
    // `cdkd import` at all, which is why this note lives here and nowhere else.
    expect(advice).not.toContain('--resource');
  });

  it('tells the reader to confirm ownership before adopting', async () => {
    // A cdkd-DERIVED name is predictable, so it is not proof the resource is
    // this stack's: a globally-namespaced type can collide with another
    // ACCOUNT's resource, and the same stack in another REGION derives the same
    // name for one. The first revision asserted the orphan as certain.
    const advice = adviceIn(await attempt());

    expect(advice).toContain('CONFIRM IT IS YOURS FIRST');
    expect(advice).toContain('another account');
  });

  it('does not offer import for a type whose provider cannot import', async () => {
    providerHasImport = false;
    const advice = adviceIn(await attempt());

    expect(advice).toBeDefined();
    expect(advice).toContain('implements no import');
    // Naming a remedy whose precondition the code never checks is the #2610
    // class; `runImportForResource` would SKIP such a type with
    // `skipped-no-impl` and leave the user exactly where they started.
    expect(advice).not.toContain('--resource');
  });

  describe('a create replayed after an ambiguous attempt (#3984)', () => {
    /**
     * A server fault as the SDK builds one (`$fault: 'server'`, the HTTP status
     * on `$metadata`), wrapped the way a provider threads it. `withRetry`
     * retries it and arms the replay latch, since the create may have
     * succeeded server-side.
     */
    const serverFault = (): ProvisioningError => {
      const sdk = new Error('UnknownError');
      sdk.name = 'InternalFailure';
      Object.assign(sdk, {
        $fault: 'server',
        $metadata: { httpStatusCode: 500, requestId: 'req-5xx', attempts: 3 },
      });
      return new ProvisioningError(
        `Failed to create ${LOGICAL}: UnknownError`,
        TYPE,
        LOGICAL,
        `${STACK}-${LOGICAL}`,
        sdk
      );
    };

    /** First call: `first`; every later call: `then`. Returns the call count. */
    const failFirstWith = (first: Error, then: () => Error): (() => number) => {
      let calls = 0;
      provider.create = vi.fn().mockImplementation(async () => {
        throw calls++ === 0 ? first : then();
      });
      return () => calls;
    };

    it('says this create most likely made the resource, and issues no delete', async () => {
      const calls = failFirstWith(serverFault(), () => createError);
      const lines = await attempt();

      expect(calls()).toBe(2);
      const advice = replayAdviceIn(lines);
      expect(advice).toBeDefined();
      // WHICH name, WHY it is taken, WHAT to run -- and the confirm-first
      // warning the import arm always carries.
      expect(advice).toContain(`${STACK}-${LOGICAL}`);
      expect(advice).toContain('ended without a clear verdict');
      // #4639: a dropped connection may precede the request reaching AWS.
      expect(advice).toContain('confirm it is yours before deleting or importing it');
      expect(advice).toContain('no rollback or cdkd destroy will remove it');
      expect(advice).toContain('CONFIRM IT IS YOURS FIRST');
      expect(advice!.split('\n').at(-1)).toBe(
        `Adopt with: cdkd import ${STACK} --resource '${LOGICAL}=${STACK}-${LOGICAL}'`
      );
      // Not the earlier-run orphan story: no Retain was involved here.
      expect(advice).not.toContain('Retain');
      expect(adviceIn(lines)).toBeUndefined();
      // Advice only: nothing reads the replayed verdict as a delete-first.
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('takes the delete-only arm for a type whose provider cannot import', async () => {
      providerHasImport = false;
      failFirstWith(serverFault(), () => createError);
      const advice = replayAdviceIn(await attempt());

      expect(advice).toBeDefined();
      expect(advice).toContain('implements no import');
      expect(advice).not.toContain('--resource');
    });

    it('says nothing when the replay fails on something other than a collision', async () => {
      failFirstWith(
        serverFault(),
        () =>
          new ProvisioningError(
            `Failed to create ${LOGICAL}: Member must satisfy constraint: [Source is required]`,
            TYPE,
            LOGICAL,
            `${STACK}-${LOGICAL}`,
            awsSdkError('Member must satisfy constraint: [Source is required]', 'ValidationException')
          )
      );
      const lines = await attempt();

      expect(replayAdviceIn(lines)).toBeUndefined();
      expect(adviceIn(lines)).toBeUndefined();
    });

    it('says nothing for a replayed name the TEMPLATE supplied', async () => {
      // An ambiguous first attempt does not prove the name was free before it,
      // so a template-supplied name may still be someone else's.
      createError = collisionError('a-name-the-user-chose');
      failFirstWith(serverFault(), () => createError);
      const lines = await attempt();

      expect(replayAdviceIn(lines)).toBeUndefined();
      expect(adviceIn(lines)).toBeUndefined();
    });

    it('says nothing when the replay collides on a PROVIDER-marked auxiliary object', async () => {
      // Only `withRetry`'s own mark is seen through. A provider's mark names an
      // auxiliary object (a tag, a policy), so that "already exists" is not
      // about this resource's name at all.
      failFirstWith(serverFault(), () =>
        markAuxiliaryFailure(
          new ProvisioningError(
            `Failed to create ${LOGICAL}: Policy already exists.`,
            TYPE,
            LOGICAL,
            `${STACK}-${LOGICAL}`,
            awsSdkError('Policy already exists.', 'EntityAlreadyExistsException')
          ),
          LOGICAL
        )
      );
      const lines = await attempt();

      expect(replayAdviceIn(lines)).toBeUndefined();
      expect(adviceIn(lines)).toBeUndefined();
    });
  });
});
