/**
 * Issue #3808: a replacement's create-first collision used to presume the old
 * resource held the name and advise `cdkd deploy --replace`, which deletes the
 * old resource FIRST. When the replacement also CHANGES the name, the holder
 * is another resource: `--replace` deleted the managed resource and collided
 * again. Every arm now refuses — without deleting — when the template's
 * explicit name is known to differ from the one the old resource holds, while
 * a same-name replacement keeps the `--replace` delete-first recovery.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ccUpdateUnsupportedRejection } from '../_cc-unsupported-action.js';
import { awsSdkError } from '../_aws-sdk-error.js';

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

/** Non-stateful, and `explicitNamePropertyFor` knows its name: `FunctionName`. */
const TYPE = 'AWS::Lambda::Function';

type Inner = Error & { code?: string; cause?: unknown };

/** Lambda's real collision spelling, anchored on the logical id. */
const collision = (name: string): Error =>
  new Error(`Failed to create Lambda function Fn: Function already exist: ${name}`, {
    cause: awsSdkError(`Function already exist: ${name}`),
  });

describe('DeployEngine — replacement collision on a name another resource holds (#3808)', () => {
  let callOrder: string[];
  let createFailures: Error[];
  let provider: ResourceProvider;

  beforeEach(() => {
    callOrder = [];
    createFailures = [];
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        const failure = createFailures.shift();
        if (failure) throw failure;
        return { physicalId: 'new-fn', attributes: {} };
      }),
      update: vi.fn().mockImplementation(async (logicalId: string) => {
        callOrder.push('update');
        throw ccUpdateUnsupportedRejection(TYPE, logicalId);
      }),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(opts: { replace?: boolean } = {}): InstanceType<typeof DeployEngine> {
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
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as unknown as never,
      { ...(opts.replace !== undefined && { replace: opts.replace }) },
      'us-east-1'
    );
  }

  /**
   * `recorded` is the name state holds for the old resource (`undefined`: the
   * record carries none, as for a generated name); `desired` is the template's.
   * `replacement: false` reaches the UPDATE-not-supported fallback instead of
   * the property-driven path.
   */
  async function provision(
    engine: InstanceType<typeof DeployEngine>,
    opts: {
      recorded: string | undefined;
      desired: string;
      physicalId?: string;
      retain?: boolean;
      replacement?: boolean;
      /** The state record's type, for a Type-change replacement. */
      oldType?: string;
      /** Replaces the recorded bag's name entry (for `oldType`). */
      oldProps?: Record<string, unknown>;
    }
  ): Promise<Inner | null> {
    const replacement = opts.replacement ?? true;
    const oldProps = opts.oldProps ?? {
      Runtime: 'nodejs20.x',
      ...(opts.recorded !== undefined && { FunctionName: opts.recorded }),
    };
    const newProps = { Runtime: 'nodejs22.x', FunctionName: opts.desired };
    const change: ResourceChange = {
      logicalId: 'Fn',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: oldProps,
      desiredProperties: newProps,
      propertyChanges: [
        {
          path: 'Runtime',
          oldValue: 'nodejs20.x',
          newValue: 'nodejs22.x',
          requiresReplacement: replacement,
        },
      ],
    };
    const stateResources = {
      Fn: {
        physicalId: opts.physicalId ?? opts.recorded ?? 'MyStack-Fn',
        resourceType: opts.oldType ?? TYPE,
        properties: oldProps,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk' as const,
      },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Fn: {
          Type: TYPE,
          Properties: newProps,
          ...(opts.retain === true && { UpdateReplacePolicy: 'Retain' }),
        },
      },
    };
    const run = (
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
    return run('Fn', change, stateResources, 'MyStack', template).then(
      () => null,
      (e) => (e as { cause?: unknown }).cause as Inner
    );
  }

  describe('the property-driven create-first path', () => {
    it('refuses under --replace and deletes NOTHING when the new name is held elsewhere', async () => {
      createFailures = [collision('taken-name')];

      const err = await provision(makeEngine({ replace: true }), {
        recorded: 'my-fn',
        desired: 'taken-name',
      });

      expect(err).not.toBeNull();
      expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(err!.message).toContain('held by ANOTHER existing resource');
      expect(err!.message).toContain('holds FunctionName "my-fn"');
      expect(err!.message).toContain('--replace was NOT applied and nothing was deleted');
      expect(isMarkedNonRetryable(err)).toBe(true);
      // Chained, so the persisted event can name the AWS rejection.
      expect((err!.cause as Error).message).toContain('Function already exist: taken-name');
      // The feared shape: create -> delete -> create.
      expect(callOrder).toEqual(['create']);
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('does not advise --replace without the flag', async () => {
      createFailures = [collision('taken-name')];

      const err = await provision(makeEngine(), { recorded: 'my-fn', desired: 'taken-name' });

      expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(err!.message).toContain('held by ANOTHER existing resource');
      expect(err!.message).toContain('would delete this resource and still collide');
      // The pre-fix remedy sentence.
      expect(err!.message).not.toContain('to delete the old resource FIRST');
      expect(callOrder).toEqual(['create']);
    });

    it('names removing Retain, not --replace alone, under Retain without the flag', async () => {
      createFailures = [collision('taken-name')];

      const err = await provision(makeEngine(), {
        recorded: 'my-fn',
        desired: 'taken-name',
        retain: true,
      });

      expect(err!.message).toContain('removing UpdateReplacePolicy: Retain and re-running with');
      expect(callOrder).toEqual(['create']);
    });

    it("reads the OLD type's name property across a Type change", async () => {
      // The record is an IAM role whose RoleName differs; its bag also carries
      // a `FunctionName` equal to the desired one, which only a read keyed on
      // the NEW type's property would find.
      createFailures = [collision('taken-name')];

      const err = await provision(makeEngine({ replace: true }), {
        recorded: undefined,
        desired: 'taken-name',
        physicalId: 'my-role',
        oldType: 'AWS::IAM::Role',
        oldProps: { RoleName: 'my-role', FunctionName: 'taken-name' },
      });

      expect(err!.message).toContain('holds RoleName "my-role"');
      expect(callOrder).toEqual(['create']);
    });

    it('does not claim the retained resource holds the name under Retain', async () => {
      createFailures = [collision('taken-name')];

      const err = await provision(makeEngine({ replace: true }), {
        recorded: 'my-fn',
        desired: 'taken-name',
        retain: true,
      });

      expect(err!.message).toContain('held by ANOTHER existing resource');
      expect(err!.message).not.toContain('still held by the existing resource');
      expect(callOrder).toEqual(['create']);
    });

    it('refuses when state records no name and the physical id does not hold the new one', async () => {
      // The template ADDS an explicit name to a resource cdkd named itself.
      createFailures = [collision('taken-name')];

      const err = await provision(makeEngine({ replace: true }), {
        recorded: undefined,
        desired: 'taken-name',
        physicalId: 'MyStack-Fn',
      });

      expect(err!.message).toContain('(MyStack-Fn) does not hold that name');
      expect(callOrder).toEqual(['create']);
    });

    it('keeps the --replace delete-first recovery for a same-name replacement (negative control)', async () => {
      createFailures = [collision('my-fn')];

      const err = await provision(makeEngine({ replace: true }), {
        recorded: 'my-fn',
        desired: 'my-fn',
      });

      expect(err).toBeNull();
      expect(callOrder).toEqual(['create', 'delete', 'create']);
    });

    it('keeps the --replace advice for a same-name replacement without the flag', async () => {
      createFailures = [collision('my-fn')];

      const err = await provision(makeEngine(), { recorded: 'my-fn', desired: 'my-fn' });

      expect(err!.message).toContain('cdkd deploy --replace');
      expect(err!.message).not.toContain('held by ANOTHER');
    });
  });

  describe('the UPDATE-not-supported fallback under Retain', () => {
    it('does not advise removing Retain when the new name is held elsewhere', async () => {
      createFailures = [collision('taken-name')];

      const err = await provision(makeEngine(), {
        recorded: 'my-fn',
        desired: 'taken-name',
        retain: true,
        replacement: false,
      });

      expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(err!.message).toContain('held by ANOTHER existing resource');
      expect(err!.message).toContain('removing UpdateReplacePolicy: Retain would delete');
      expect(err!.message).not.toContain('lets cdkd delete the old resource first');
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect((err!.cause as Error).message).toContain('Function already exist: taken-name');
      expect(callOrder).toEqual(['update', 'create']);
    });

    it('keeps the Retain wording for a same-name replacement (negative control)', async () => {
      createFailures = [collision('my-fn')];

      const err = await provision(makeEngine(), {
        recorded: 'my-fn',
        desired: 'my-fn',
        retain: true,
        replacement: false,
      });

      expect(err!.message).toContain('lets cdkd delete the old resource first');
      expect(err!.message).not.toContain('held by ANOTHER');
    });
  });
});
