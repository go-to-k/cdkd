/**
 * Issue go-to-k/cdkd#2610, sites 9 and 10: the deploy engine's two
 * `STATEFUL_REPLACE_BLOCKED` refusals advise `--force-stateful-recreation`, but
 * the replacement's delete never carries `removeProtection`, so for a resource
 * whose record says it is protected that flag alone cannot remove it. Both
 * refusals now say so when the OLD resource's record carries the flag, and
 * keep the short advice otherwise.
 *
 * `AWS::Logs::LogGroup` is the subject: stateful under the mid-deploy guard
 * (no recorded retention reads as never-expire) and protectable through
 * `DeletionProtectionEnabled`, so one type drives both polarities.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
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

const TYPE = 'AWS::Logs::LogGroup';
const SHORT_ADVICE = 'Re-run with --force-stateful-recreation to confirm the data loss';
const NOTE_MARKER = 'cdkd deploy has no --remove-protection flag to clear it';

let provider: ResourceProvider;

beforeEach(() => {
  provider = {
    create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
    update: vi.fn().mockImplementation(async (logicalId: string, _p: string, rt: string) => {
      throw new ResourceUpdateNotSupportedError(rt, logicalId, 'immutable on AWS');
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
});

function makeEngine(opts: { replace?: boolean }): InstanceType<typeof DeployEngine> {
  const registry = {
    getProvider: vi.fn().mockReturnValue(provider),
    getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
    getRegisteredTypes: vi.fn().mockReturnValue([]),
    validateResourceTypes: vi.fn(),
    validateResourceProperties: vi.fn(),
  };
  return new DeployEngine(
    { getState: vi.fn(), saveState: vi.fn() } as unknown as never,
    { acquireLockWithRetry: vi.fn(), releaseLock: vi.fn() } as unknown as never,
    {
      buildGraph: vi.fn(),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as unknown as never,
    {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn(),
      filterByType: vi.fn().mockReturnValue([]),
    } as unknown as never,
    registry as unknown as never,
    { ...(opts.replace !== undefined && { replace: opts.replace }) },
    'us-east-1'
  );
}

/**
 * Drive one UPDATE and return the whole error chain's text. `propertyDriven`
 * picks the site: a `requiresReplacement` change reaches the property-driven
 * guard (site 9) before any provider call; otherwise the in-place update is
 * attempted, rejected, and the update-failure fallback's guard (site 10) runs.
 */
async function refusal(opts: {
  propertyDriven: boolean;
  replace?: boolean;
  recorded: Record<string, unknown>;
  observed?: Record<string, unknown>;
  type?: string;
  /** The STATE record's type, when the template changes the Type. */
  oldType?: string;
}): Promise<string> {
  const type = opts.type ?? TYPE;
  const oldType = opts.oldType ?? type;
  const desired = { ...opts.recorded, LogGroupName: 'new-name' };
  const change: ResourceChange = {
    logicalId: 'Logs',
    changeType: 'UPDATE',
    resourceType: type,
    currentProperties: opts.recorded,
    desiredProperties: desired,
    propertyChanges: [
      {
        path: 'LogGroupName',
        oldValue: opts.recorded['LogGroupName'],
        newValue: 'new-name',
        requiresReplacement: opts.propertyDriven,
      },
    ],
  };
  const stateResources = {
    Logs: {
      physicalId: 'old-name',
      resourceType: oldType,
      properties: opts.recorded,
      ...(opts.observed !== undefined && { observedProperties: opts.observed }),
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk' as const,
    },
  };
  const template: CloudFormationTemplate = {
    Resources: {
      Logs: {
        Type: type,
        Properties: desired,
      },
    },
  };
  const engine = makeEngine({ ...(opts.replace !== undefined && { replace: opts.replace }) });
  const provision = (
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
  const err = await provision('Logs', change, stateResources, 'MyStack', template).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).not.toBeNull();
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; cur instanceof Error && i < 10; i++) {
    parts.push(cur.message, String((cur as { code?: unknown }).code ?? ''));
    cur = (cur as { cause?: unknown }).cause;
  }
  const text = parts.join('\n');
  expect(text).toContain('STATEFUL_REPLACE_BLOCKED');
  // Refused before anything destructive, in every case here.
  expect(provider.delete).not.toHaveBeenCalled();
  expect(provider.create).not.toHaveBeenCalled();
  return text;
}

const PROTECTED = { LogGroupName: 'old-name', DeletionProtectionEnabled: true };
const UNPROTECTED = { LogGroupName: 'old-name', DeletionProtectionEnabled: false };

describe('site 9: the property-driven replacement refusal', () => {
  it('names the protection and the dead end when the record carries it', async () => {
    const text = await refusal({ propertyDriven: true, recorded: PROTECTED });
    expect(text).toContain(
      "cdkd's recorded properties for this resource carry DeletionProtectionEnabled: true"
    );
    expect(text).toContain(NOTE_MARKER);
    expect(text).toContain('so --force-stateful-recreation alone does not remove the old resource');
    expect(text).toContain("Or change the resource's definition to avoid the immutable-property change.");
    expect(text).not.toContain(SHORT_ADVICE);
  });

  it('keeps the short advice when the record says protection is off', async () => {
    const text = await refusal({ propertyDriven: true, recorded: UNPROTECTED });
    expect(text).toContain(
      `${SHORT_ADVICE}, or change the resource definition to avoid the immutable-property change.`
    );
    expect(text).not.toContain(NOTE_MARKER);
  });

  it('reads the observed bag too, naming it', async () => {
    const text = await refusal({
      propertyDriven: true,
      recorded: UNPROTECTED,
      observed: { DeletionProtectionEnabled: true },
    });
    expect(text).toContain(
      'the AWS read-back cdkd stored for this resource carries DeletionProtectionEnabled: true'
    );
  });
});

describe("the engine passes the STACK's region (a global table's flag is per replica)", () => {
  const replicas = (onRegion: string) => ({
    Replicas: [
      { Region: 'us-east-1', DeletionProtectionEnabled: onRegion === 'us-east-1' },
      { Region: 'eu-west-1', DeletionProtectionEnabled: onRegion === 'eu-west-1' },
    ],
  });
  const GT = 'AWS::DynamoDB::GlobalTable';

  for (const [site, propertyDriven, replace] of [
    ['site 9', true, undefined],
    ['site 10', false, true],
  ] as const) {
    it(`${site}: the deploy region's replica decides`, async () => {
      // The engine is built for us-east-1.
      const on = await refusal({ propertyDriven, replace, type: GT, recorded: replicas('us-east-1') });
      expect(on).toContain('DeletionProtectionEnabled for the deploy region: true');
      const off = await refusal({ propertyDriven, replace, type: GT, recorded: replicas('eu-west-1') });
      expect(off).not.toContain(NOTE_MARKER);
    });
  }
});

describe('site 9 reads the OLD type\'s flag when the template changes the Type', () => {
  it('a protected RDS instance becoming a DynamoDB table is named by the RDS flag', async () => {
    // The two types keep their flag under different keys, so reading the bag
    // through the NEW type finds nothing and drops the note.
    const text = await refusal({
      propertyDriven: true,
      oldType: 'AWS::RDS::DBInstance',
      type: 'AWS::DynamoDB::Table',
      recorded: { LogGroupName: 'old-name', DeletionProtection: true },
    });
    expect(text).toContain('AWS::RDS::DBInstance');
    expect(text).toContain(
      "cdkd's recorded properties for this resource carry DeletionProtection: true"
    );
    expect(text).toContain(NOTE_MARKER);
  });
});

describe('site 10: the update-failure fallback refusal, both arms', () => {
  it('the --replace arm names the protection and re-runs with both flags', async () => {
    const text = await refusal({ propertyDriven: false, replace: true, recorded: PROTECTED });
    expect(text).toContain('--replace would DELETE + CREATE the stateful resource Logs');
    expect(text).toContain(NOTE_MARKER);
    expect(text).toContain(
      'so --replace --force-stateful-recreation alone does not remove the old resource'
    );
    expect(text).toContain("Or change the resource's definition to avoid the immutable-property change.");
    expect(text).not.toContain(SHORT_ADVICE);
  });

  it('the --replace arm keeps the short advice when unprotected', async () => {
    const text = await refusal({ propertyDriven: false, replace: true, recorded: UNPROTECTED });
    expect(text).toContain(
      `${SHORT_ADVICE}, or change the resource definition to avoid the immutable-property change.`
    );
    expect(text).not.toContain(NOTE_MARKER);
  });

  it('the --replace arm reads the observed bag too', async () => {
    const text = await refusal({
      propertyDriven: false,
      replace: true,
      recorded: UNPROTECTED,
      observed: { DeletionProtectionEnabled: true },
    });
    expect(text).toContain(
      'the AWS read-back cdkd stored for this resource carries DeletionProtectionEnabled: true'
    );
  });

  it('the no-flag arm keeps the short advice when unprotected', async () => {
    provider.update = vi.fn().mockRejectedValue(
      Object.assign(new Error('UnsupportedActionException'), {
        name: 'UnsupportedActionException',
      })
    );
    const text = await refusal({ propertyDriven: false, recorded: UNPROTECTED });
    expect(text).toContain('cannot be updated in place by the provisioning layer');
    expect(text).toContain(
      `${SHORT_ADVICE}, or change the resource definition to avoid the update.`
    );
    expect(text).not.toContain(NOTE_MARKER);
  });

  it('the no-flag arm names the protection too', async () => {
    // Only the Cloud Control auto-fallback reaches this arm without
    // `--replace`; the typed SDK rejection with no flag propagates instead.
    const ccRejection = Object.assign(new Error('UnsupportedActionException'), {
      name: 'UnsupportedActionException',
    });
    provider.update = vi.fn().mockRejectedValue(ccRejection);
    const text = await refusal({ propertyDriven: false, recorded: PROTECTED });
    expect(text).toContain('cannot be updated in place by the provisioning layer');
    expect(text).toContain('so --force-stateful-recreation alone does not remove the old resource');
    expect(text).toContain("Or change the resource's definition to avoid the update.");
    expect(text).not.toContain(SHORT_ADVICE);
  });
});
