import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  looksLikeCdkdGeneratedName,
  withStackName,
} from '../../../src/provisioning/resource-name.js';
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

/**
 * Issue #1636: the replacement-collision refusals called EVERY colliding
 * resource "custom-named" and told the user their template supplied the
 * physical name.
 *
 * For a resource the template never named that is false, and the false half is
 * the part the user is asked to act on: `generateResourceName` produces
 * `{stackName}-{logicalId}` with NO random component, so the create-first
 * attempt lands on the name the old resource still holds exactly as it would
 * for a user-named one — the collision is cdkd's own naming scheme, not the
 * template. And the prescribed remedy, "rename the resource in your CDK code",
 * would there mean renaming the CONSTRUCT (changing the logical id), a
 * materially more disruptive action. A reader who finds no such name in their
 * template cannot connect the message to their code at all.
 *
 * Observed live (us-east-1, 2026-08-12) on a Lambda function declared with no
 * `functionName`, whose collision message named
 * `CdkdLambdaDurableReplacementExample-DurableFn91E3F4D8` — a name cdkd
 * generated.
 */
describe('looksLikeCdkdGeneratedName (#1636)', () => {
  it('recognizes the plain `{stackName}-{logicalId}` derivation', () => {
    expect(looksLikeCdkdGeneratedName('MyStack-DurableFn', 'DurableFn', 'MyStack')).toBe(true);
  });

  it('recognizes it through a per-type sanitize (lowercase, dots)', () => {
    // An S3-style name goes through `lowercase: true` and a dot-permitting
    // pattern, so the engine — which does not know the per-type options —
    // compares the alphanumeric skeleton.
    expect(looksLikeCdkdGeneratedName('mystack.databucket', 'DataBucket', 'MyStack')).toBe(true);
  });

  it('recognizes the TRUNCATED `{prefix}-{8 hex}` form', () => {
    expect(
      looksLikeCdkdGeneratedName('MyVeryLongStackName-Data-a1b2c3d4', 'DataBucket', 'MyVeryLongStackName')
    ).toBe(true);
  });

  it('rejects a TEMPLATE-supplied name (the safe default)', () => {
    // The user wrote `functionName: 'my-pipe'`. Answering `false` keeps the
    // pre-#1636 wording, which is correct here.
    expect(looksLikeCdkdGeneratedName('my-pipe', 'Pipe', 'MyStack')).toBe(false);
  });

  it('rejects a template name that merely SHARES the stack prefix', () => {
    // `{stackName}-{userName}` is what a user-supplied name looks like when
    // the prefix is applied, so a stack-prefix test alone would misclassify
    // it. The logical id is what separates the two.
    expect(looksLikeCdkdGeneratedName('MyStack-my-pipe', 'Pipe', 'MyStack')).toBe(false);
  });

  it('rejects a truncated-LOOKING name whose prefix is not the derivation', () => {
    // The `-<8 hex>` suffix alone must not be enough, or any hash-suffixed
    // user name would be claimed as cdkd's.
    expect(looksLikeCdkdGeneratedName('totally-other-a1b2c3d4', 'DataBucket', 'MyStack')).toBe(
      false
    );
  });

  it('answers FALSE when the stack name is unresolvable', () => {
    // Outside a `withStackName` scope there is nothing to derive from, and an
    // unresolved case must never assert "cdkd generated this".
    expect(looksLikeCdkdGeneratedName('MyStack-DurableFn', 'DurableFn', undefined)).toBe(false);
  });
});

describe('DeployEngine replacement-collision message names the RIGHT name origin (#1636)', () => {
  let provider: ResourceProvider;
  let createFailures: Error[];
  let createdPhysicalId: string;

  const TYPE = 'AWS::Pipes::Pipe'; // non-stateful: the stateful guard stays out of the way
  const STACK = 'MyStack';

  const alreadyExists = (name: string) =>
    new Error(
      `CREATE failed for Pipe: Resource of type '${TYPE}' with identifier '${name}' already exists.`
    );

  beforeEach(() => {
    createFailures = [];
    createdPhysicalId = 'my-pipe';
    provider = {
      create: vi.fn().mockImplementation(async () => {
        const failure = createFailures.shift();
        if (failure) throw failure;
        return { physicalId: createdPhysicalId, attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
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
   * Drive `provisionResource` INSIDE a `withStackName` scope — the engine's own
   * `deploy()` opens one, and the classifier reads it. A test that skipped the
   * scope would silently take the unresolvable branch and pass for the wrong
   * reason.
   */
  async function collide(physicalId: string): Promise<Error & { cause?: { message?: string } }> {
    const engine = makeEngine();
    createdPhysicalId = physicalId;
    createFailures = [alreadyExists(physicalId)];

    const change: ResourceChange = {
      logicalId: 'Pipe',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { Source: 'arn:a' },
      desiredProperties: { Source: 'arn:b' },
      propertyChanges: [
        { path: 'Source', oldValue: 'arn:a', newValue: 'arn:b', requiresReplacement: true },
      ],
    };
    const stateResources = {
      Pipe: {
        physicalId,
        resourceType: TYPE,
        properties: { Source: 'arn:a' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk' as const,
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { Pipe: { Type: TYPE, Properties: { Source: 'arn:b' } } },
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

    return withStackName(STACK, () =>
      provisionResource('Pipe', change, stateResources, STACK, template).then(
        () => {
          throw new Error('expected the collision refusal');
        },
        (e) => e as Error & { cause?: { message?: string } }
      )
    );
  }

  describe('a cdkd-GENERATED name', () => {
    it('says the name was generated, and does NOT claim the user supplied it', async () => {
      const err = await collide(`${STACK}-Pipe`);

      expect(err.cause?.message).toMatch(/GENERATED by cdkd/);
      // The load-bearing negative: this exact false assertion is the bug.
      expect(err.cause?.message).not.toMatch(/user-supplied physical name/);
    });

    it('prescribes renaming the CONSTRUCT, not "the resource"', async () => {
      const err = await collide(`${STACK}-Pipe`);

      expect(err.cause?.message).toMatch(/rename the CONSTRUCT/);
      // ...and warns that doing so replaces rather than renames, which is the
      // part that makes the advice actionable rather than merely accurate.
      expect(err.cause?.message).toMatch(/replaces the\s+resource/);
    });

    it('still offers --replace, which is the same escape hatch either way', async () => {
      const err = await collide(`${STACK}-Pipe`);

      expect(err.cause?.message).toMatch(/cdkd deploy --replace/);
    });

    it('still reports the CloudFormation-parity framing', async () => {
      // The CFn quote explains WHY create-first cannot proceed; it is about
      // the ordering, not about who chose the name, so it stays in both arms.
      const err = await collide(`${STACK}-Pipe`);

      expect(err.cause?.message).toMatch(/custom-named resource requires replacing/);
    });
  });

  describe('a TEMPLATE-supplied name (unchanged)', () => {
    it('keeps the user-supplied wording and the plain rename remedy', async () => {
      const err = await collide('my-pipe');

      expect(err.cause?.message).toMatch(/user-supplied physical name \(my-pipe\)/);
      expect(err.cause?.message).toMatch(/rename the resource in your CDK code/);
      expect(err.cause?.message).not.toMatch(/GENERATED by cdkd/);
    });
  });

  describe('the name-idempotent Create arm carries the same split', () => {
    it('does not claim a user-supplied name for a generated one', async () => {
      // This arm is reached when the Create API returns the EXISTING resource
      // instead of colliding. It carried the identical false assertion, so
      // fixing only the two sites the issue named would have left a sibling
      // telling the same untruth.
      const engine = makeEngine();
      createdPhysicalId = `${STACK}-Pipe`;
      createFailures = [];

      const change: ResourceChange = {
        logicalId: 'Pipe',
        changeType: 'UPDATE',
        resourceType: TYPE,
        currentProperties: { Source: 'arn:a' },
        desiredProperties: { Source: 'arn:b' },
        propertyChanges: [
          { path: 'Source', oldValue: 'arn:a', newValue: 'arn:b', requiresReplacement: true },
        ],
      };
      const stateResources = {
        Pipe: {
          physicalId: `${STACK}-Pipe`,
          resourceType: TYPE,
          properties: { Source: 'arn:a' },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk' as const,
        },
      };
      const template: CloudFormationTemplate = {
        Resources: { Pipe: { Type: TYPE, Properties: { Source: 'arn:b' } } },
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

      const err = await withStackName(STACK, () =>
        provisionResource('Pipe', change, stateResources, STACK, template).then(
          () => {
            throw new Error('expected the idempotent-create refusal');
          },
          (e) => e as Error & { cause?: { message?: string } }
        )
      );

      expect(err.cause?.message).toMatch(/name-idempotent/);
      expect(err.cause?.message).toMatch(/GENERATED by cdkd/);
      expect(err.cause?.message).not.toMatch(/user-supplied physical name/);
    });
  });
});
