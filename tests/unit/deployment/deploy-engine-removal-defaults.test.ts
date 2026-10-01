import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

/**
 * Issue #1160: the deploy's in-place UPDATE computes the properties the
 * previous TEMPLATE (the state record) declared and this one omits, injects
 * the provider's declared `removalDefaults` into the bag `update()` receives,
 * records the template as-is, and names an audited type's undeclared removal
 * in one warning line.
 */

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const warn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...a: unknown[]) => warn(...a),
    error: vi.fn(),
  };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
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

const TYPE = 'AWS::Lambda::Function';

describe('DeployEngine in-place UPDATE applies removalDefaults (issue #1160)', () => {
  const stackName = 'removal-stack';
  let provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    removalDefaults: Map<string, Map<string, unknown>>;
    removalHandledInUpdate: Map<string, Set<string>>;
  };
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let diffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let registry: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({ physicalId: 'fn', wasReplaced: false }),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      removalDefaults: new Map([[TYPE, new Map<string, unknown>([['Timeout', 3]])]]),
      removalHandledInUpdate: new Map([[TYPE, new Set(['Role'])]]),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
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
    registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
  });

  async function deploy(
    previous: Record<string, unknown>,
    desired: Record<string, unknown>
  ): Promise<void> {
    stateBackend.getState!.mockResolvedValue({
      state: {
        version: 8,
        stackName,
        region: 'us-east-1',
        resources: { Fn: { physicalId: 'fn', resourceType: TYPE, properties: previous } },
        outputs: {},
        lastModified: 1,
      },
      etag: 'etag-old',
    });
    diffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Fn',
          {
            logicalId: 'Fn',
            changeType: 'UPDATE',
            resourceType: TYPE,
            desiredProperties: desired,
            currentProperties: previous,
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: { Fn: { Type: TYPE, Properties: desired } },
    };
    await new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Fn']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      diffCalculator as never,
      registry as never,
      { dryRun: false },
      'us-east-1'
    ).deploy(stackName, template);
  }

  const removalWarnings = (): string[] =>
    warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('removed from the template'));

  const savedProperties = (): Record<string, unknown> => {
    const saved = stateBackend.saveState!.mock.calls.at(-1)![2] as {
      resources: Record<string, { properties: Record<string, unknown> }>;
    };
    return saved.resources['Fn']!.properties;
  };

  it('a removed DECLARED key reaches update() as its declared value; state keeps the template', async () => {
    await deploy({ Role: 'r', Timeout: 30 }, { Role: 'r' });

    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(provider.update.mock.calls[0]![3]).toEqual({ Role: 'r', Timeout: 3 });
    // The previous side is the state record, untouched.
    expect(provider.update.mock.calls[0]![4]).toEqual({ Role: 'r', Timeout: 30 });
    const context = provider.update.mock.calls[0]![5] as UpdateContext;
    expect([...context.removedProperties!]).toEqual(['Timeout']);
    expect(removalWarnings()).toEqual([]);
    expect(savedProperties()).toEqual({ Role: 'r' });
  });

  it('an echoed reset in effectiveProperties is not recorded', async () => {
    provider.update.mockImplementation(
      (_l: string, _p: string, _t: string, props: Record<string, unknown>) =>
        Promise.resolve({ physicalId: 'fn', wasReplaced: false, effectiveProperties: { ...props } })
    );
    await deploy({ Role: 'r', Timeout: 30 }, { Role: 'r' });

    expect(provider.update.mock.calls[0]![3]).toEqual({ Role: 'r', Timeout: 3 });
    expect(savedProperties()).toEqual({ Role: 'r' });
  });

  it('a removed UNDECLARED key on an audited type warns once and leaves the bag unchanged', async () => {
    await deploy({ Role: 'r', RecursiveLoop: 'Allow', Description: 'd' }, { Role: 'r' });

    expect(provider.update.mock.calls[0]![3]).toEqual({ Role: 'r' });
    expect(removalWarnings()).toEqual([
      'Fn (AWS::Lambda::Function): properties RecursiveLoop, Description were removed from the template; cdkd leaves the current AWS value in place (CloudFormation would reset it to its default).',
    ]);
  });

  it('a failed update prints no removal warning (nothing was left in place by an update)', async () => {
    provider.update.mockRejectedValue(new Error('AccessDenied'));
    await expect(deploy({ Role: 'r', RecursiveLoop: 'Allow' }, { Role: 'r' })).rejects.toThrow();

    expect(removalWarnings()).toEqual([]);
  });

  it('nothing removed: no warning, the bag passes through unchanged', async () => {
    await deploy({ Role: 'r', Timeout: 30 }, { Role: 'r', Timeout: 10 });

    expect(provider.update.mock.calls[0]![3]).toEqual({ Role: 'r', Timeout: 10 });
    const context = provider.update.mock.calls[0]![5] as UpdateContext;
    expect(context.removedProperties!.size).toBe(0);
    expect(removalWarnings()).toEqual([]);
  });

  it('a type with no removalHandledInUpdate entry is never warned about', async () => {
    provider.removalHandledInUpdate = new Map();
    await deploy({ Role: 'r', RecursiveLoop: 'Allow' }, { Role: 'r' });

    expect(removalWarnings()).toEqual([]);
  });
});
