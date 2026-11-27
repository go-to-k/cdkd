/**
 * go-to-k/cdkd#7083: a CloudFormation-measured replacement row can be nested
 * (an FSx file system's `LustreConfiguration.ImportedFileChunkSize`), while the
 * diff keys the property change by the top-level property. The stateful
 * refusal still names the measured member that changed, and only that one.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
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
  IntrinsicFunctionResolver: vi.fn(() => ({
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

const SHORT_ADVICE = 'Re-run with --force-stateful-recreation to confirm the data loss';
const KEPT_NAME_ADVICE =
  '--force-stateful-recreation alone cannot replace it: the new resource would keep the same DomainName and collide with the old one (AlreadyExists). Change DomainName as well and re-run with --force-stateful-recreation to confirm the data loss';
const LEFTOVERS =
  "On a replacement, the old domain's home EFS file system and its security groups are retained by AWS and keep billing.";

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

function makeEngine(opts: {
  replace?: boolean;
  forceStatefulRecreation?: boolean;
}): InstanceType<typeof DeployEngine> {
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
    {
      ...(opts.replace !== undefined && { replace: opts.replace }),
      ...(opts.forceStatefulRecreation !== undefined && {
        forceStatefulRecreation: opts.forceStatefulRecreation,
      }),
    },
    'us-east-1'
  );
}

async function refusal(type: string, path: string, oldValue: unknown, newValue: unknown): Promise<string> {
  return refusalOf(type, { [path]: oldValue }, { [path]: newValue }, [
    { path, oldValue, newValue, requiresReplacement: true },
  ]);
}

async function refusalOf(
  type: string,
  recorded: Record<string, unknown>,
  desired: Record<string, unknown>,
  propertyChanges: NonNullable<ResourceChange['propertyChanges']>
): Promise<string> {
  const text = await failureOf(makeEngine({}), type, recorded, desired, propertyChanges);
  expect(text).toContain('STATEFUL_REPLACE_BLOCKED');
  expect(provider.create).not.toHaveBeenCalled();
  return text;
}

/** The deploy's failure text (every message and code down the cause chain). */
async function failureOf(
  engine: InstanceType<typeof DeployEngine>,
  type: string,
  recorded: Record<string, unknown>,
  desired: Record<string, unknown>,
  propertyChanges: NonNullable<ResourceChange['propertyChanges']>
): Promise<string> {
  const change: ResourceChange = {
    logicalId: 'Rg',
    changeType: 'UPDATE',
    resourceType: type,
    currentProperties: recorded,
    desiredProperties: desired,
    propertyChanges,
  };
  const stateResources = {
    Rg: {
      physicalId: 'old-id',
      resourceType: type,
      properties: recorded,
      attributes: {},
      dependencies: [],
      provisionedBy: 'cc-api' as const,
    },
  };
  const template: CloudFormationTemplate = { Resources: { Rg: { Type: type, Properties: desired } } };
  const err = await provisionResource(
    engine,
    'Rg',
    change,
    stateResources as unknown as Record<string, never>,
    'MyStack',
    template
  ).then(
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
  expect(provider.delete).not.toHaveBeenCalled();
  return text;
}

describe('nested measured replacement in the stateful refusal (go-to-k/cdkd#7083)', () => {
  const TYPE = 'AWS::FSx::FileSystem';
  const lustre = (chunk: number, throughput: number) => ({
    LustreConfiguration: { ImportedFileChunkSize: chunk, PerUnitStorageThroughput: throughput },
  });
  const change = (from: Record<string, unknown>, to: Record<string, unknown>) => [
    {
      path: 'LustreConfiguration',
      oldValue: from['LustreConfiguration'],
      newValue: to['LustreConfiguration'],
      requiresReplacement: true,
    },
  ];

  it('names the nested member CloudFormation was measured replacing on', async () => {
    const text = await refusalOf(TYPE, lustre(1024, 50), lustre(2048, 50), change(lustre(1024, 50), lustre(2048, 50)));
    expect(text).toContain(
      'CloudFormation was measured replacing it on a LustreConfiguration.ImportedFileChunkSize change, so the data is lost there as well.'
    );
  });

  it('reads the resolved values: an intrinsic or a number spelled as a string is no change', async () => {
    const TYPE_Z = 'AWS::FSx::FileSystem';
    const ozfs = (rs: unknown, subnet: unknown, ro: unknown) => ({
      OpenZFSConfiguration: {
        PreferredSubnetId: subnet,
        RootVolumeConfiguration: { RecordSizeKiB: rs, ReadOnly: ro },
      },
    });
    const from = ozfs(128, 'subnet-a', true);
    const to = ozfs('64', 'subnet-a', 'true');
    const text = await refusalOf(TYPE_Z, from, ozfs('64', { Ref: 'Subnet' }, 'true'), [
      { path: 'OpenZFSConfiguration', oldValue: from.OpenZFSConfiguration, newValue: to.OpenZFSConfiguration, requiresReplacement: true },
    ]);
    expect(text).toContain(
      'CloudFormation was measured replacing it on a OpenZFSConfiguration.RootVolumeConfiguration.RecordSizeKiB change, so the data is lost there as well.'
    );
    expect(text).not.toContain('PreferredSubnetId');
    expect(text).not.toContain('ReadOnly');
  });

  it('names no member that did not change', async () => {
    const text = await refusalOf(TYPE, lustre(1024, 50), lustre(2048, 100), change(lustre(1024, 50), lustre(2048, 100)));
    expect(text).not.toContain('PerUnitStorageThroughput change');
  });
});
