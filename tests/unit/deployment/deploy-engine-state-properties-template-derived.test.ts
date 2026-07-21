import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

// Logger silenced — keep test output clean.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// A NON-identity resolver: it deep-replaces any `{ __resolveTo: X }`
// sentinel object with `X`. This lets each test feed RAW desired
// template properties carrying an unresolved intrinsic and then assert
// that the value persisted into `state.properties` is the RESOLVED form
// (template-derived), NOT the raw template and NOT any AWS-observed value.
function deepResolveSentinels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepResolveSentinels);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('__resolveTo' in obj) return obj['__resolveTo'];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepResolveSentinels(v);
    return out;
  }
  return value;
}

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(deepResolveSentinels(props))),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

// p-limit no-op so concurrency does not gate this test.
vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/**
 * Durable guard for the invariant PR #940 (symmetric `valuesEqual`) relies
 * on: `state.properties` is the RESOLVED DESIRED (template-derived)
 * property map — it must NOT carry AWS-observed values. AWS-observed data
 * lives in two SEPARATE fields:
 *   - `attributes`         — computed outputs from the provider's create/update result
 *   - `observedProperties` — the post-write AWS snapshot from `readCurrentState`
 *
 * If AWS-added default keys ever leaked into `state.properties`, the
 * symmetric object compare in `valuesEqual` would flag them as phantom
 * drift / spurious updates on every redeploy. This test pins the boundary
 * at the deploy-engine state-write layer so a future refactor of the
 * CREATE / UPDATE write sites (deploy-engine.ts ~L2161 / ~L2434 / ~L2599)
 * cannot silently start persisting observed data into `properties`.
 */
describe('DeployEngine - state.properties is resolved-desired (template-derived), never AWS-observed', () => {
  const stackName = 'state-properties-guard-stack';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };

  let mockStateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
  };

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

  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(),
    };

    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['MyResource']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };

    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) => {
          return Array.from(changes.values()).filter((c) => c.changeType === type);
        }),
    };

    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1'
    );
  }

  it('CREATE: persists the resolved-desired props, with AWS attributes/observed kept in separate fields', async () => {
    // No prior state — fresh CREATE.
    mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });

    // create() returns AWS-computed ATTRIBUTES distinct from the props.
    mockProvider.create.mockResolvedValue({
      physicalId: 'phys-my-resource',
      attributes: { Arn: 'arn:aws:s3:::phys-my-resource', AwsComputedOnly: 'xyz' },
    });

    // readCurrentState returns the AWS snapshot — note the AWS-added
    // default key that is NOT in the template. This is exactly the kind
    // of key the old asymmetric valuesEqual existed to ignore; it must
    // land in observedProperties, never in properties.
    mockProvider.readCurrentState.mockResolvedValue({
      Name: 'bucket',
      Tag: 'resolved-value',
      AwsAddedDefault: true,
    });

    const desiredProps = {
      Name: 'bucket',
      // Unresolved intrinsic in the raw template — the resolver turns
      // the sentinel into 'resolved-value'.
      Tag: { __resolveTo: 'resolved-value' },
    };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'MyResource',
          {
            logicalId: 'MyResource',
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: desiredProps,
          },
        ],
      ])
    );

    const template: CloudFormationTemplate = {
      Resources: {
        MyResource: { Type: 'AWS::S3::Bucket', Properties: desiredProps },
      },
    };

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);
    expect(result.created).toBe(1);

    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    const record = savedState.resources['MyResource']!;

    // properties = RESOLVED desired (template-derived). The intrinsic is
    // resolved (proves it's the resolved form, not the raw template), and
    // NO AWS-observed key (Arn / AwsComputedOnly / AwsAddedDefault) leaked in.
    expect(record.properties).toEqual({ Name: 'bucket', Tag: 'resolved-value' });
    expect(record.properties).not.toHaveProperty('Arn');
    expect(record.properties).not.toHaveProperty('AwsComputedOnly');
    expect(record.properties).not.toHaveProperty('AwsAddedDefault');

    // AWS-observed data lives in the dedicated fields.
    expect(record.attributes).toEqual({
      Arn: 'arn:aws:s3:::phys-my-resource',
      AwsComputedOnly: 'xyz',
    });
    expect(record.observedProperties).toEqual({
      Name: 'bucket',
      Tag: 'resolved-value',
      AwsAddedDefault: true,
    });
  });

  it('UPDATE (in-place): re-persists the resolved-desired props, not the AWS-observed snapshot', async () => {
    // Prior state with an AWS-added default already in observedProperties
    // (and crucially NOT in properties — the invariant under test).
    const priorState: StackState = {
      version: 3,
      region: 'us-east-1',
      stackName,
      resources: {
        MyResource: {
          physicalId: 'phys-my-resource',
          resourceType: 'AWS::S3::Bucket',
          properties: { Name: 'bucket', Tag: 'old-value' },
          observedProperties: { Name: 'bucket', Tag: 'old-value', AwsAddedDefault: true },
          attributes: { Arn: 'arn:aws:s3:::phys-my-resource' },
        },
      },
      outputs: {},
      lastModified: 0,
    };
    mockStateBackend.getState.mockResolvedValue({ state: priorState, etag: 'etag-old' });

    mockProvider.update.mockResolvedValue({ physicalId: 'phys-my-resource', wasReplaced: false });
    mockProvider.readCurrentState.mockResolvedValue({
      Name: 'bucket',
      Tag: 'new-value',
      AwsAddedDefault: true,
    });

    const desiredProps = { Name: 'bucket', Tag: { __resolveTo: 'new-value' } };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'MyResource',
          {
            logicalId: 'MyResource',
            changeType: 'UPDATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: desiredProps,
            currentProperties: { Name: 'bucket', Tag: 'old-value' },
            propertyChanges: [
              {
                path: 'Tag',
                oldValue: 'old-value',
                newValue: 'new-value',
                requiresReplacement: false,
              },
            ],
          },
        ],
      ])
    );

    const template: CloudFormationTemplate = {
      Resources: {
        MyResource: { Type: 'AWS::S3::Bucket', Properties: desiredProps },
      },
    };

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);
    expect(result.updated).toBe(1);

    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    const record = savedState.resources['MyResource']!;

    // properties tracks the new RESOLVED desired value, with no AWS-added
    // default — the symmetric-compare safety guarantee.
    expect(record.properties).toEqual({ Name: 'bucket', Tag: 'new-value' });
    expect(record.properties).not.toHaveProperty('AwsAddedDefault');

    // observedProperties carries the AWS snapshot (incl. the AWS-added key).
    expect(record.observedProperties).toEqual({
      Name: 'bucket',
      Tag: 'new-value',
      AwsAddedDefault: true,
    });
  });
});
