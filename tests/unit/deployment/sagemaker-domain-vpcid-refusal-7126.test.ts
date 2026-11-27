/**
 * go-to-k/cdkd#7126: CloudFormation replaces a SageMaker domain on a VpcId
 * change (measured on #7083). cdkd now plans the same replacement, and the
 * type is stateful (the domain owns its users' home EFS), so the deploy refuses
 * it before any call unless --force-stateful-recreation is passed, saying
 * CloudFormation also replaces, and that its replacement fails on the
 * DomainName it keeps. The change here is preset `requiresReplacement`: the
 * diff's verdict is `spec-replacement-properties.test.ts`'s.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { replacementOldHoldsSentName } from '../../../src/deployment/replacement-name-holder.js';
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

describe('SageMaker domain VpcId replacement (go-to-k/cdkd#7126)', () => {
  it('refuses a VpcId replacement without the flag, citing the CloudFormation measurement', async () => {
    const text = await refusal('AWS::SageMaker::Domain', 'VpcId', 'vpc-a', 'vpc-b');
    expect(text).toContain('Rg (AWS::SageMaker::Domain) requires replacement (immutable property changed: VpcId)');
    expect(text).toContain(
      'CloudFormation was measured replacing it on a VpcId change, and failing that replacement on the DomainName it keeps (AlreadyExists): it replaces only when the name changes too.'
    );
    // CloudFormation keeps the domain's data on this change, so the refusal
    // must not say it is lost there.
    expect(text).not.toContain('so the data is lost there as well');
    // The flag alone would collide on the kept name, so the refusal must not
    // advise it alone.
    expect(text).not.toContain(SHORT_ADVICE);
    expect(text).toContain(KEPT_NAME_ADVICE);
    expect(text).toContain(LEFTOVERS);
  });

  // When the same deploy renames the domain, CloudFormation's replacement
  // succeeds, so the kept-name sentence must not be printed.
  it('drops the kept-name sentence when DomainName changes too', async () => {
    const recorded = { VpcId: 'vpc-a', DomainName: 'a' };
    const desired = { VpcId: 'vpc-b', DomainName: 'b' };
    const text = await refusalOf('AWS::SageMaker::Domain', recorded, desired, [
      { path: 'VpcId', oldValue: 'vpc-a', newValue: 'vpc-b', requiresReplacement: true },
      { path: 'DomainName', oldValue: 'a', newValue: 'b', requiresReplacement: true },
    ]);
    expect(text).not.toContain('it keeps (AlreadyExists)');
    expect(text).not.toContain(KEPT_NAME_ADVICE);
    expect(text).toContain(SHORT_ADVICE);
    expect(text).toContain(LEFTOVERS);
  });

  // With the flag, a create that collides (AlreadyExists) on the kept name is
  // refused and deletes nothing, with or without --replace.
  for (const replace of [false, true]) {
    it(`with --force-stateful-recreation${replace ? ' and --replace' : ''}, an AlreadyExists create never deletes`, async () => {
      provider.create = vi.fn().mockRejectedValue(
        Object.assign(new Error('Resource of type AWS::SageMaker::Domain with identifier d already exists.'), {
          ccErrorCode: 'AlreadyExists',
        })
      );
      const recorded = { DomainName: 'd', VpcId: 'vpc-a', AuthMode: 'IAM' };
      const desired = { ...recorded, VpcId: 'vpc-b' };
      const text = await failureOf(
        makeEngine({ forceStatefulRecreation: true, replace }),
        'AWS::SageMaker::Domain',
        recorded,
        desired,
        [{ path: 'VpcId', oldValue: 'vpc-a', newValue: 'vpc-b', requiresReplacement: true }]
      );
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(text).not.toContain('STATEFUL_REPLACE_BLOCKED');
      expect(text).toContain('requires replacement, but the create-first attempt collided');
      expect(provider.delete).not.toHaveBeenCalled();
    });
  }

  // With the flag, the create-first replacement collides on the kept
  // DomainName (probed: AlreadyExists). cdkd has no name key for the type, so
  // it cannot prove the old domain holds that name, and `--replace` refuses
  // rather than deleting it first.
  it('never proves the old domain holds the colliding name, so --replace deletes nothing', () => {
    const props = { DomainName: 'd', VpcId: 'vpc-b', AuthMode: 'IAM' };
    const verdict = replacementOldHoldsSentName({
      createType: 'AWS::SageMaker::Domain',
      holderType: 'AWS::SageMaker::Domain',
      requested: props,
      recorded: { ...props, VpcId: 'vpc-a' },
      observed: undefined,
      physicalId: 'd-abc123',
      createdVia: 'cc-api',
      holderVia: 'cc-api',
    });
    expect(verdict.holds).toBe(false);
  });

  // A control: passes before the fix too. DomainName is schema create-only, so
  // its replacement cites no measurement.
  it('does not claim CloudFormation replaces for a schema create-only property', async () => {
    const text = await refusal('AWS::SageMaker::Domain', 'DomainName', 'a', 'b');
    expect(text).not.toContain('CloudFormation was measured replacing');
  });
});
