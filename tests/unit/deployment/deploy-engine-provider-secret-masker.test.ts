import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate, CreateContext, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

// Issue #1932 item 3. Masking used to live at two boundaries only — this
// engine's error / reason text and the resolver's own debug line — so a
// provider that interpolated a RESOLVED property value into its own
// `logger.warn` was outside all of it. The engine now hands every provider
// call a `maskSecrets` capability bound to THAT resource's resolution pass.
//
// These tests assert the capability is present AND WORKS (masks the plaintext
// this pass resolved), not merely that some function was passed: a masker
// bound to the wrong / an empty bag would satisfy a presence check and fix
// nothing.

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const SECRET_PLAINTEXT = 'super-secret-plaintext-value';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:client_secret::}}';

// Same sentinel resolver the sibling GHSA test uses: `{ __resolveSecret:
// [plaintext, expr] }` resolves to the PLAINTEXT and records
// (plaintext -> expr) into `ctx.recordedSecretValues`, exactly as the real
// resolver does for a `{{resolve:secretsmanager:...}}` reference.
function resolveWithSecrets(
  value: unknown,
  ctx: { recordedSecretValues?: Map<string, string> }
): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveWithSecrets(v, ctx));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('__resolveSecret' in obj) {
      const [plaintext, expr] = obj['__resolveSecret'] as [string, string];
      ctx.recordedSecretValues?.set(plaintext, expr);
      return plaintext;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveWithSecrets(v, ctx);
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
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - provider calls carry a working secret masker (issue #1932 item 3)', () => {
  const stackName = 'masker-stack';
  const RESOURCE_TYPE = 'AWS::Cognito::UserPool';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'phys' }),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Pool']]),
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
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  // Defaulted rather than fixed (issue #2301): `us-east-1` is also this repo's
  // fallback region, so a region assertion made against an engine built with it
  // holds just as well when the threaded binding is replaced by that literal.
  // The threading fence below builds the engine with a region no default
  // produces.
  function makeEngine(stackRegion = 'us-east-1'): DeployEngine {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      stackRegion
    );
  }

  /**
   * State + diff priming for the in-place UPDATE path, shared by the masker
   * test and the region-threading fence so the two cannot drift apart.
   */
  function primeUpdatePath(): CloudFormationTemplate {
    mockStateBackend.getState!.mockResolvedValue({
      state: {
        version: 8,
        stackName,
        region: 'us-east-1',
        resources: {
          Pool: {
            physicalId: 'phys',
            resourceType: RESOURCE_TYPE,
            properties: { UserPoolName: 'pool', EnabledMfas: 'PREVIOUS' },
          },
        },
        outputs: {},
        lastModified: 1,
      },
      etag: 'etag-old',
    });
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Pool',
          {
            logicalId: 'Pool',
            changeType: 'UPDATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: secretProps,
            currentProperties: { UserPoolName: 'pool', EnabledMfas: 'PREVIOUS' },
          },
        ],
      ])
    );
    return { Resources: { Pool: { Type: RESOURCE_TYPE, Properties: secretProps } } };
  }

  /**
   * The assertion both paths share: the context exists, carries a masker, and
   * that masker actually masks THIS pass's plaintext while leaving unrelated
   * text alone. A presence-only check would pass for a masker bound to an
   * empty bag, which is the likeliest way this threading regresses.
   */
  function expectWorkingMasker(context: CreateContext | UpdateContext | undefined): void {
    expect(context).toBeDefined();
    expect(typeof context!.maskSecrets).toBe('function');
    const mask = context!.maskSecrets!;
    expect(mask(`AWS rejected "${SECRET_PLAINTEXT}"`)).toBe(`AWS rejected "${SECRET_MASK}"`);
    expect(mask('AWS rejected "SOFTWARE_TOKEN"')).toBe('AWS rejected "SOFTWARE_TOKEN"');
  }

  const secretProps = {
    UserPoolName: 'pool',
    EnabledMfas: { __resolveSecret: [SECRET_PLAINTEXT, SECRET_EXPR] },
  };

  it('CREATE: passes a masker bound to this resource resolution pass', async () => {
    mockStateBackend.getState!.mockResolvedValue({ state: null, etag: undefined });
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Pool',
          {
            logicalId: 'Pool',
            changeType: 'CREATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: secretProps,
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: { Pool: { Type: RESOURCE_TYPE, Properties: secretProps } },
    };

    await makeEngine().deploy(stackName, template);

    expect(mockProvider.create).toHaveBeenCalledTimes(1);
    // Non-vacuity: the provider really did receive the resolved plaintext, so
    // there IS something for the masker to mask.
    expect((mockProvider.create.mock.calls[0]![2] as Record<string, unknown>)['EnabledMfas']).toBe(
      SECRET_PLAINTEXT
    );
    expectWorkingMasker(mockProvider.create.mock.calls[0]![3] as CreateContext | undefined);
  });

  it('UPDATE: passes a masker bound to this resource resolution pass', async () => {
    const template = primeUpdatePath();

    await makeEngine().deploy(stackName, template);

    expect(mockProvider.update).toHaveBeenCalledTimes(1);
    expect((mockProvider.update.mock.calls[0]![3] as Record<string, unknown>)['EnabledMfas']).toBe(
      SECRET_PLAINTEXT
    );
    // Arg 5 is the UpdateContext — the twin of the CREATE call's arg 3.
    const updateContext = mockProvider.update.mock.calls[0]![5] as UpdateContext | undefined;
    expectWorkingMasker(updateContext);
    // Issue #2301 item 1: the same context also carries the stack's region, so
    // a Cloud-Control-routed in-place update refuses rather than applying the
    // patch to whatever the recorded physical id names in the client's region.
    // PRESENCE only here; the value is fenced by the test below, where the
    // engine's region is one no default can produce.
    expect(updateContext?.expectedRegion).toBeDefined();
  });

  it("UPDATE: expectedRegion follows the engine's stackRegion, not a constant (issue #2301)", async () => {
    // `eu-central-1` rather than `us-east-1`: the latter is this repo's
    // fallback region, so substituting the literal for `this.stackRegion` at
    // the call site leaves a `us-east-1` assertion GREEN. This one must go RED.
    const template = primeUpdatePath();

    await makeEngine('eu-central-1').deploy(stackName, template);

    const updateContext = mockProvider.update.mock.calls[0]![5] as UpdateContext | undefined;
    expect(updateContext?.expectedRegion).toBe('eu-central-1');
    expect(updateContext?.expectedRegion).not.toBe('us-east-1');
  });

  it('CREATE: the masker is an identity when this pass resolved no secret', async () => {
    // The back-compat direction. A resource with no dynamic reference must
    // still get a masker (so a provider never has to branch), and that masker
    // must leave every message untouched.
    mockStateBackend.getState!.mockResolvedValue({ state: null, etag: undefined });
    const plainProps = { UserPoolName: 'pool', EnabledMfas: 'SOFTWARE_TOKEN' };
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Pool',
          {
            logicalId: 'Pool',
            changeType: 'CREATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: plainProps,
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: { Pool: { Type: RESOURCE_TYPE, Properties: plainProps } },
    };

    await makeEngine().deploy(stackName, template);

    const context = mockProvider.create.mock.calls[0]![3] as CreateContext | undefined;
    expect(typeof context?.maskSecrets).toBe('function');
    const text = `AWS rejected "${SECRET_PLAINTEXT}"`;
    expect(context!.maskSecrets!(text)).toBe(text);
  });

  it('scopes the masker PER RESOURCE, so one resource cannot mask another resource secret', async () => {
    // The same per-resource scoping the persisted-state redaction has. A
    // session-wide bag would let resource B's warning mask (and thereby name
    // as sensitive) a literal that is merely equal to resource A's secret.
    mockStateBackend.getState!.mockResolvedValue({ state: null, etag: undefined });
    mockDagBuilder.getExecutionLevels!.mockReturnValue([['Pool', 'Other']]);
    const otherProps = { UserPoolName: 'other', EnabledMfas: SECRET_PLAINTEXT };
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Pool',
          {
            logicalId: 'Pool',
            changeType: 'CREATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: secretProps,
          },
        ],
        [
          'Other',
          {
            logicalId: 'Other',
            changeType: 'CREATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: otherProps,
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: {
        Pool: { Type: RESOURCE_TYPE, Properties: secretProps },
        Other: { Type: RESOURCE_TYPE, Properties: otherProps },
      },
    };

    await makeEngine().deploy(stackName, template);

    const byLogicalId = new Map(
      mockProvider.create.mock.calls.map((c) => [c[0] as string, c[3] as CreateContext | undefined])
    );
    // The resource that RESOLVED the secret masks it...
    expect(byLogicalId.get('Pool')!.maskSecrets!(SECRET_PLAINTEXT)).toBe(SECRET_MASK);
    // ...the one that merely holds an equal literal does not.
    expect(byLogicalId.get('Other')!.maskSecrets!(SECRET_PLAINTEXT)).toBe(SECRET_PLAINTEXT);
  });

  // The UPDATE twin of the isolation test above. Wrong-bag binding is the
  // highest-severity failure this contract can have, and the CREATE-side test
  // alone leaves the UPDATE and replacement-create sites unfenced against it —
  // a shared or swapped bag there would be invisible.
  it('scopes the masker PER RESOURCE on the UPDATE path too', async () => {
    mockStateBackend.getState!.mockResolvedValue({
      state: {
        version: 8,
        stackName,
        region: 'us-east-1',
        resources: {
          Pool: {
            physicalId: 'phys-pool',
            resourceType: RESOURCE_TYPE,
            properties: { UserPoolName: 'pool', EnabledMfas: 'PREVIOUS' },
          },
          Other: {
            physicalId: 'phys-other',
            resourceType: RESOURCE_TYPE,
            properties: { UserPoolName: 'other', EnabledMfas: 'PREVIOUS' },
          },
        },
        outputs: {},
        lastModified: 1,
      },
      etag: 'etag-old',
    });
    mockDagBuilder.getExecutionLevels!.mockReturnValue([['Pool', 'Other']]);
    // `Pool` RESOLVES the secret; `Other` carries the identical plaintext as a
    // LITERAL, so a session-wide bag would mask it in `Other`'s messages too.
    const otherProps = { UserPoolName: 'other', EnabledMfas: SECRET_PLAINTEXT };
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Pool',
          {
            logicalId: 'Pool',
            changeType: 'UPDATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: secretProps,
            currentProperties: { UserPoolName: 'pool', EnabledMfas: 'PREVIOUS' },
          },
        ],
        [
          'Other',
          {
            logicalId: 'Other',
            changeType: 'UPDATE',
            resourceType: RESOURCE_TYPE,
            desiredProperties: otherProps,
            currentProperties: { UserPoolName: 'other', EnabledMfas: 'PREVIOUS' },
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: {
        Pool: { Type: RESOURCE_TYPE, Properties: secretProps },
        Other: { Type: RESOURCE_TYPE, Properties: otherProps },
      },
    };

    await makeEngine().deploy(stackName, template);

    expect(mockProvider.update).toHaveBeenCalledTimes(2);
    const byLogicalId = new Map(
      mockProvider.update.mock.calls.map((c) => [c[0] as string, c[5] as UpdateContext | undefined])
    );
    expect(byLogicalId.get('Pool')!.maskSecrets!(SECRET_PLAINTEXT)).toBe(SECRET_MASK);
    expect(byLogicalId.get('Other')!.maskSecrets!(SECRET_PLAINTEXT)).toBe(SECRET_PLAINTEXT);
  });
});
