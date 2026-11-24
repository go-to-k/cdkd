import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

// go-to-k/cdkd#6437: `DeployEngineOptions.updatePolicy` reaches the provider's
// `update()` as `UpdateContext.updatePolicy` only when it is `true`; the
// default prints a hint for a policy the flag would honor; a CREATE of a
// resource declaring a `CreationPolicy` warns.

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...log, child: () => log }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK = 'update-policy-stack';
const ASG = 'AWS::AutoScaling::AutoScalingGroup';
const SCHEDULED = {
  AutoScalingScheduledAction: { IgnoreUnmodifiedGroupSizeProperties: true },
};
const PREVIOUS = { MinSize: '1', MaxSize: '4' };
const DESIRED = { MinSize: '1', MaxSize: '5' };

describe('DeployEngine UpdatePolicy / CreationPolicy (go-to-k/cdkd#6437)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let diffCalculator: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'asg' }),
      update: vi.fn().mockResolvedValue({ physicalId: 'asg' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
    diffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
  });

  function makeEngine(
    updatePolicy?: boolean,
    provisionedBy: 'sdk' | 'cc-api' = 'sdk',
    extra: Record<string, unknown> = {}
  ): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Group']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      diffCalculator as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false, ...extra, ...(updatePolicy !== undefined && { updatePolicy }) },
      'us-east-1'
    );
  }

  function primeUpdate(
    updatePolicy?: Record<string, unknown>,
    resourceType = ASG
  ): CloudFormationTemplate {
    stateBackend.getState!.mockResolvedValue({
      state: {
        version: 8,
        stackName: STACK,
        region: 'us-east-1',
        resources: {
          Group: { physicalId: 'asg', resourceType, properties: PREVIOUS },
        },
        outputs: {},
        lastModified: 1,
      },
      etag: 'etag-old',
    });
    diffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Group',
          {
            logicalId: 'Group',
            changeType: 'UPDATE',
            resourceType,
            desiredProperties: DESIRED,
            currentProperties: PREVIOUS,
          },
        ],
      ])
    );
    return {
      Resources: {
        Group: {
          Type: resourceType,
          Properties: DESIRED,
          ...(updatePolicy && { UpdatePolicy: updatePolicy }),
        },
      },
    };
  }

  const updateContext = (): UpdateContext =>
    provider.update!.mock.calls[0]![5] as UpdateContext;
  const hintLines = (): string[] =>
    log.info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('--update-policy'));

  it('--update-policy hands the template UpdatePolicy to update(), and prints no hint', async () => {
    await makeEngine(true).deploy(STACK, primeUpdate(SCHEDULED));
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(updateContext().updatePolicy).toEqual(SCHEDULED);
    expect(hintLines()).toEqual([]);
  });

  it('--no-update-policy hands nothing and prints no hint', async () => {
    await makeEngine(false).deploy(STACK, primeUpdate(SCHEDULED));
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(updateContext()).not.toHaveProperty('updatePolicy');
    expect(hintLines()).toEqual([]);
  });

  it('the default hands nothing and prints one hint naming the resource and the policy', async () => {
    await makeEngine().deploy(STACK, primeUpdate(SCHEDULED));
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(updateContext()).not.toHaveProperty('updatePolicy');
    expect(hintLines()).toHaveLength(1);
    expect(hintLines()[0]).toContain('Group');
    expect(hintLines()[0]).toContain('AutoScalingScheduledAction');
  });

  it('the default prints no hint for a rolling update whose trigger properties did not change', async () => {
    await makeEngine().deploy(
      STACK,
      primeUpdate({ AutoScalingRollingUpdate: { MaxBatchSize: 1 } })
    );
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(hintLines()).toEqual([]);
  });

  it('--update-policy hands nothing when the template declares no UpdatePolicy', async () => {
    await makeEngine(true).deploy(STACK, primeUpdate());
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(updateContext()).not.toHaveProperty('updatePolicy');
  });

  const routeWarnings = (): string[] =>
    log.warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Cloud Control route'));

  it('the default prints no hint when the update routes through Cloud Control', async () => {
    await makeEngine(undefined, 'cc-api').deploy(STACK, primeUpdate(SCHEDULED));
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(hintLines()).toEqual([]);
  });

  it('--update-policy on the Cloud Control route warns once that the policy is not honored', async () => {
    await makeEngine(true, 'cc-api').deploy(STACK, primeUpdate(SCHEDULED));
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(routeWarnings()).toHaveLength(1);
    expect(routeWarnings()[0]).toContain('AutoScalingScheduledAction');
  });

  it('--update-policy on the Cloud Control route does not warn about a policy no provider honors', async () => {
    await makeEngine(true, 'cc-api').deploy(
      STACK,
      primeUpdate({ AutoScalingRollingUpdate: { MaxBatchSize: 1 } })
    );
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(routeWarnings()).toEqual([]);
  });

  const SCHEDULED_OFF = {
    AutoScalingScheduledAction: { IgnoreUnmodifiedGroupSizeProperties: false },
  };

  it('the default prints no hint for a policy set to its no-op value', async () => {
    await makeEngine().deploy(STACK, primeUpdate(SCHEDULED_OFF));
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(hintLines()).toEqual([]);
  });

  it('--update-policy on the Cloud Control route does not warn about a no-op policy', async () => {
    await makeEngine(true, 'cc-api').deploy(STACK, primeUpdate(SCHEDULED_OFF));
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(routeWarnings()).toEqual([]);
  });

  it('hands nothing for a non-object UpdatePolicy', async () => {
    const template = primeUpdate();
    (template.Resources['Group'] as unknown as Record<string, unknown>)['UpdatePolicy'] =
      'not-an-object';
    await makeEngine(true).deploy(STACK, template);
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(updateContext()).not.toHaveProperty('updatePolicy');
  });

  it('a whole-attribute Fn::If is handed over as written and gets no hint', async () => {
    const wrapped = { 'Fn::If': ['Cond', SCHEDULED, { Ref: 'AWS::NoValue' }] };
    await makeEngine(true).deploy(STACK, primeUpdate(wrapped));
    expect(updateContext().updatePolicy).toEqual(wrapped);
    vi.clearAllMocks();
    await makeEngine().deploy(STACK, primeUpdate(wrapped));
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(hintLines()).toEqual([]);
  });

  it('--update-policy on the SDK route does not warn about the route', async () => {
    await makeEngine(true).deploy(STACK, primeUpdate(SCHEDULED));
    expect(routeWarnings()).toEqual([]);
  });

  it('the default prints no hint for a type whose provider honors no policy', async () => {
    await makeEngine().deploy(STACK, primeUpdate(SCHEDULED, 'AWS::SQS::Queue'));
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(hintLines()).toEqual([]);
  });

  it('prints the hint once even when the update is retried', async () => {
    provider.update!.mockRejectedValueOnce(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
    );
    await makeEngine().deploy(STACK, primeUpdate(SCHEDULED));
    expect(provider.update).toHaveBeenCalledTimes(2);
    expect(hintLines()).toHaveLength(1);
  });

  describe('CreationPolicy', () => {
    function primeCreate(withPolicy: boolean): CloudFormationTemplate {
      stateBackend.getState!.mockResolvedValue({ state: null, etag: undefined });
      diffCalculator.calculateDiff!.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Group',
            { logicalId: 'Group', changeType: 'CREATE', resourceType: ASG, desiredProperties: DESIRED },
          ],
        ])
      );
      return {
        Resources: {
          Group: {
            Type: ASG,
            Properties: DESIRED,
            ...(withPolicy && { CreationPolicy: { ResourceSignal: { Count: 1 } } }),
          },
        },
      };
    }
    const creationWarnings = (): string[] =>
      log.warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('CreationPolicy is not honored'));

    it('warns once on the create of a resource that declares one, and still creates it', async () => {
      await makeEngine().deploy(STACK, primeCreate(true));
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(creationWarnings()).toHaveLength(1);
      expect(creationWarnings()[0]).toContain('Group');
      expect(creationWarnings()[0]).toContain('cfn-signal');
    });

    const CREATE_FAILURE = 'synthetic create failure 6437';

    /** Rejects, and the synthetic create failure is in the error's cause chain. */
    async function expectCreateFailure(deploy: Promise<unknown>): Promise<void> {
      const error = await deploy.then(
        () => undefined,
        (e: unknown) => e
      );
      const messages: string[] = [];
      for (let e = error, depth = 0; e instanceof Error && depth < 10; depth++) {
        messages.push(e.message);
        e = e.cause;
      }
      expect(messages.some((m) => m.includes(CREATE_FAILURE))).toBe(true);
    }

    it('is silent when the create fails', async () => {
      provider.create!.mockRejectedValue(new Error(CREATE_FAILURE));
      await expectCreateFailure(makeEngine().deploy(STACK, primeCreate(true)));
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(creationWarnings()).toEqual([]);
    });

    /** An UPDATE whose `MaxSize` change requires replacement (`update/finish.ts`). */
    function primeReplacement(): CloudFormationTemplate {
      const template = primeUpdate();
      template.Resources['Group']!.CreationPolicy = { ResourceSignal: { Count: 1 } };
      diffCalculator.calculateDiff!.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Group',
            {
              logicalId: 'Group',
              changeType: 'UPDATE',
              resourceType: ASG,
              desiredProperties: DESIRED,
              currentProperties: PREVIOUS,
              propertyChanges: [
                { path: 'MaxSize', oldValue: '4', newValue: '5', requiresReplacement: true },
              ],
            } as unknown as ResourceChange,
          ],
        ])
      );
      return template;
    }

    /** An in-place update the provider rejects as unsupported (`--replace` fallback). */
    function primeFallback(): CloudFormationTemplate {
      const template = primeUpdate();
      template.Resources['Group']!.CreationPolicy = { ResourceSignal: { Count: 1 } };
      provider.update!.mockRejectedValue(
        new ResourceUpdateNotSupportedError(ASG, 'Group', 'immutable on AWS')
      );
      return template;
    }

    it('warns once when a replacement creates the resource anew', async () => {
      const template = primeReplacement();
      provider.create!.mockResolvedValue({ physicalId: 'asg-new' });
      await makeEngine().deploy(STACK, template);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(creationWarnings()).toHaveLength(1);
    });

    it('is silent when the replacement create fails', async () => {
      const template = primeReplacement();
      provider.create!.mockRejectedValue(new Error(CREATE_FAILURE));
      await expectCreateFailure(makeEngine().deploy(STACK, template));
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(creationWarnings()).toEqual([]);
    });

    it('warns once when an update-not-supported fallback replaces the resource (--replace)', async () => {
      const template = primeFallback();
      provider.create!.mockResolvedValue({ physicalId: 'asg-new' });
      await makeEngine(undefined, 'sdk', { replace: true }).deploy(STACK, template);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(creationWarnings()).toHaveLength(1);
    });

    it('is silent when the --replace fallback create fails', async () => {
      const template = primeFallback();
      provider.create!.mockRejectedValue(new Error(CREATE_FAILURE));
      await expectCreateFailure(makeEngine(undefined, 'sdk', { replace: true }).deploy(STACK, template));
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(creationWarnings()).toEqual([]);
    });

    it('is silent on an UPDATE of a resource that declares one', async () => {
      const template = primeUpdate();
      template.Resources['Group']!.CreationPolicy = { ResourceSignal: { Count: 1 } };
      await makeEngine().deploy(STACK, template);
      expect(provider.update).toHaveBeenCalledTimes(1);
      expect(creationWarnings()).toEqual([]);
    });
  });
});
