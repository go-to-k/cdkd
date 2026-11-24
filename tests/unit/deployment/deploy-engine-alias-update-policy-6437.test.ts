import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  journaledUpdatePolicy,
  resolveAliasUpdatePolicy,
} from '../../../src/deployment/deploy-engine/update-policy.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

// go-to-k/cdkd#6437 PR 3: the engine side of `CodeDeployLambdaAliasUpdate`.
// Under `--update-policy` the policy's `Ref`s are resolved in the update's own
// resolver context and handed to the provider; a failed update journals the
// resolved policy, and the rollback revert hands it back. Without the flag
// nothing is resolved and the default prints the hint.

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

/** `Ref`s resolve to these names; everything else passes through. */
const REFS: Record<string, string> = { App: 'my-app', Group: 'my-dg', Hook: 'my-hook' };
function resolveRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveRefs);
  if (typeof value === 'object' && value !== null) {
    const ref = (value as Record<string, unknown>)['Ref'];
    if (typeof ref === 'string' && Object.keys(value).length === 1) return REFS[ref] ?? ref;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v)]));
  }
  return value;
}
const resolveMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: resolveMock,
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK = 'alias-update-policy-stack';
const ALIAS = 'AWS::Lambda::Alias';
const PREVIOUS = { FunctionName: 'my-fn', FunctionVersion: '1', Name: 'live' };
const VERSION_CHANGE = { ...PREVIOUS, FunctionVersion: '2' };
const DESCRIPTION_CHANGE = { ...PREVIOUS, Description: 'new' };
const AS_WRITTEN = {
  CodeDeployLambdaAliasUpdate: {
    ApplicationName: { Ref: 'App' },
    DeploymentGroupName: { Ref: 'Group' },
    BeforeAllowTrafficHook: { Ref: 'Hook' },
  },
};
const RESOLVED = {
  CodeDeployLambdaAliasUpdate: {
    ApplicationName: 'my-app',
    DeploymentGroupName: 'my-dg',
    BeforeAllowTrafficHook: 'my-hook',
  },
};

describe('DeployEngine CodeDeployLambdaAliasUpdate (go-to-k/cdkd#6437)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let diffCalculator: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveMock.mockImplementation((value: unknown) => Promise.resolve(resolveRefs(value)));
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new' }),
      update: vi.fn().mockResolvedValue({ physicalId: 'alias-arn' }),
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
      saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
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

  function makeEngine(updatePolicy?: boolean, levels: string[][] = [['Alias']]): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue(levels),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      diffCalculator as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false, ...(updatePolicy !== undefined && { updatePolicy }) },
      'us-east-1'
    );
  }

  function prime(
    updatePolicy: Record<string, unknown> | undefined,
    desired: Record<string, unknown>,
    withOther = false
  ): CloudFormationTemplate {
    stateBackend.getState!.mockResolvedValue({
      state: {
        version: 8,
        stackName: STACK,
        region: 'us-east-1',
        resources: {
          Alias: { physicalId: 'alias-arn', resourceType: ALIAS, properties: PREVIOUS, provisionedBy: 'cc-api' },
          ...(withOther && {
            Other: { physicalId: 'other', resourceType: 'AWS::SQS::Queue', properties: { A: '1' } },
          }),
        },
        outputs: {},
        lastModified: 1,
      },
      etag: 'etag-old',
    });
    diffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Alias',
          {
            logicalId: 'Alias',
            changeType: 'UPDATE',
            resourceType: ALIAS,
            desiredProperties: desired,
            currentProperties: PREVIOUS,
          },
        ],
        ...(withOther
          ? ([
              [
                'Other',
                {
                  logicalId: 'Other',
                  changeType: 'UPDATE',
                  resourceType: 'AWS::SQS::Queue',
                  desiredProperties: { A: '2' },
                  currentProperties: { A: '1' },
                },
              ],
            ] as Array<[string, ResourceChange]>)
          : []),
      ])
    );
    return {
      Resources: {
        Alias: {
          Type: ALIAS,
          Properties: desired,
          ...(updatePolicy && { UpdatePolicy: updatePolicy }),
        },
        ...(withOther && {
          Other: { Type: 'AWS::SQS::Queue', Properties: { A: '2' }, DependsOn: ['Alias'] },
        }),
      },
    };
  }

  const aliasContexts = (): UpdateContext[] =>
    provider.update!.mock.calls.filter((c) => c[0] === 'Alias').map((c) => c[5] as UpdateContext);
  const lines = (fn: ReturnType<typeof vi.fn>, needle: string): string[] =>
    fn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(needle));
  const policyResolutions = () =>
    resolveMock.mock.calls.filter(
      (c) => typeof c[0] === 'object' && c[0] !== null && 'DeploymentGroupName' in c[0]
    );

  it('--update-policy hands the provider the policy with its names resolved', async () => {
    await makeEngine(true).deploy(STACK, prime(AS_WRITTEN, VERSION_CHANGE));
    expect(aliasContexts()).toHaveLength(1);
    expect(aliasContexts()[0]!.updatePolicy).toEqual(RESOLVED);
    expect(policyResolutions()).toHaveLength(1);
    // CodeDeployLambdaAliasUpdate is applied on Cloud Control: no route warning.
    expect(lines(log.warn, 'Cloud Control route')).toEqual([]);
  });

  it('keeps the policy\'s other keys as written', async () => {
    await makeEngine(true).deploy(STACK, prime({ ...AS_WRITTEN, Other: { X: { Ref: 'App' } } }, VERSION_CHANGE));
    expect(aliasContexts()[0]!.updatePolicy).toEqual({ ...RESOLVED, Other: { X: { Ref: 'App' } } });
  });

  it('without the flag resolves nothing, hands nothing and hints on a version change', async () => {
    await makeEngine().deploy(STACK, prime(AS_WRITTEN, VERSION_CHANGE));
    expect(aliasContexts()[0]).not.toHaveProperty('updatePolicy');
    expect(policyResolutions()).toEqual([]);
    const hints = lines(log.info, 'skipped by default');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('CodeDeployLambdaAliasUpdate');
  });

  it('the default does not hint when the version does not change', async () => {
    await makeEngine().deploy(STACK, prime(AS_WRITTEN, DESCRIPTION_CHANGE));
    expect(lines(log.info, 'skipped by default')).toEqual([]);
  });

  it('--no-update-policy resolves and hands nothing, silently', async () => {
    await makeEngine(false).deploy(STACK, prime(AS_WRITTEN, VERSION_CHANGE));
    expect(aliasContexts()[0]).not.toHaveProperty('updatePolicy');
    expect(policyResolutions()).toEqual([]);
    expect(lines(log.info, 'skipped by default')).toEqual([]);
  });

  it('refuses a dynamic reference in the policy before the provider is called', async () => {
    const policy = {
      CodeDeployLambdaAliasUpdate: {
        ApplicationName: '{{resolve:ssm:/app/name}}',
        DeploymentGroupName: { Ref: 'Group' },
      },
    };
    const error = await makeEngine(true)
      .deploy(STACK, prime(policy, VERSION_CHANGE))
      .catch((e: unknown) => e);
    const chain: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) chain.push(e.message);
    expect(chain.join('\n')).toContain('dynamic reference');
    expect(provider.update).not.toHaveBeenCalled();
    expect(policyResolutions()).toEqual([]);
  });

  it('does not resolve the policy for an alias update that keeps its version', async () => {
    await makeEngine(true).deploy(STACK, prime(AS_WRITTEN, DESCRIPTION_CHANGE));
    expect(policyResolutions()).toEqual([]);
    expect(aliasContexts()[0]!.updatePolicy).toEqual(AS_WRITTEN);
  });

  it.each([
    ['records a secret', (bag: Map<string, string>) => bag.set('plain-secret', '{{resolve:ssm-secure:/x}}')],
    ['resolves to a value already recorded as secret', undefined],
    ['records a NoEcho value (log-only)', (bag: Map<string, string>) => recordLogOnlyValue(bag, 'noecho-value')],
  ])('refuses a policy whose resolution %s', async (_label, record) => {
    resolveMock.mockImplementation((value: unknown, context: { recordedSecretValues?: Map<string, string> }) => {
      const isPolicy = typeof value === 'object' && value !== null && 'DeploymentGroupName' in value;
      if (!isPolicy) {
        // The properties' own resolution recorded a secret the policy then names.
        if (record === undefined) context.recordedSecretValues?.set('my-dg', '{{resolve:ssm-secure:/dg}}');
        return Promise.resolve(resolveRefs(value));
      }
      if (record !== undefined && context.recordedSecretValues) record(context.recordedSecretValues);
      return Promise.resolve(resolveRefs(value));
    });
    const error = await makeEngine(true)
      .deploy(STACK, prime(AS_WRITTEN, VERSION_CHANGE))
      .catch((e: unknown) => e);
    const chain: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) chain.push(e.message);
    expect(chain.join('\n')).toContain('names a secret');
    expect(provider.update).not.toHaveBeenCalled();
  });

  const journaledOps = (key: 'failedOperations' | 'completedOperations') =>
    stateBackend.appendRollbackJournalSegment!.mock.calls.flatMap((call) =>
      call
        .filter(
          (a: unknown): a is Record<string, Array<Record<string, unknown>>> =>
            typeof a === 'object' && a !== null && key in a
        )
        .flatMap((a) => a[key] ?? [])
    );

  it.each([
    ['journals the resolved policy on a failed UPDATE under --update-policy', true, RESOLVED],
    ['journals none without the flag', undefined, undefined],
  ])('%s', async (_label, flag, expected) => {
    provider.update!.mockRejectedValue(new Error('synthetic failure 6437'));
    await makeEngine(flag as boolean | undefined)
      .deploy(STACK, prime(AS_WRITTEN, VERSION_CHANGE))
      .catch(() => undefined);
    const ops = journaledOps('failedOperations').filter((op) => op['logicalId'] === 'Alias');
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      if (expected === undefined) expect(op).not.toHaveProperty('updatePolicy');
      else expect(op['updatePolicy']).toEqual(expected);
    }
  });

  it('the rollback revert of a completed alias update gets the resolved policy back', async () => {
    const template = prime(AS_WRITTEN, VERSION_CHANGE, true);
    provider.update!.mockImplementation((logicalId: string) =>
      logicalId === 'Other'
        ? Promise.reject(new Error('synthetic failure 6437'))
        : Promise.resolve({ physicalId: 'alias-arn' })
    );
    await makeEngine(true, [['Alias'], ['Other']])
      .deploy(STACK, template)
      .catch(() => undefined);
    const contexts = aliasContexts();
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.updatePolicy).toEqual(RESOLVED);
    expect(contexts[1]!.replayingState).toBe(true);
    expect(contexts[1]!.updatePolicy).toEqual(RESOLVED);
    // The revert puts the previous version back.
    expect(provider.update!.mock.calls.filter((c) => c[0] === 'Alias')[1]![3]).toMatchObject({
      FunctionVersion: '1',
    });
  });
});

describe('resolveAliasUpdatePolicy / journaledUpdatePolicy', () => {
  const resource = { Type: 'AWS::Lambda::Alias', UpdatePolicy: AS_WRITTEN };
  const resolve = (value: unknown) => Promise.resolve(resolveRefs(value));
  const noSecret = () => () => false;

  it.each([
    ['flag off', undefined, 'AWS::Lambda::Alias', resource],
    ['flag false', false, 'AWS::Lambda::Alias', resource],
    ['another type', true, 'AWS::AutoScaling::AutoScalingGroup', resource],
    ['no UpdatePolicy', true, 'AWS::Lambda::Alias', { Type: 'AWS::Lambda::Alias' }],
    [
      'no CodeDeployLambdaAliasUpdate',
      true,
      'AWS::Lambda::Alias',
      { Type: 'AWS::Lambda::Alias', UpdatePolicy: { Other: {} } },
    ],
  ])('%s: undefined, nothing resolved', async (_label, flag, type, res) => {
    const spy = vi.fn(resolve);
    expect(
      await resolveAliasUpdatePolicy(flag, 'Alias', type, res, true, spy, noSecret)
    ).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves only CodeDeployLambdaAliasUpdate', async () => {
    expect(
      await resolveAliasUpdatePolicy(true, 'Alias', 'AWS::Lambda::Alias', resource, true, resolve, noSecret)
    ).toEqual(RESOLVED);
  });

  it('resolves nothing when FunctionVersion does not change', async () => {
    const spy = vi.fn(resolve);
    expect(
      await resolveAliasUpdatePolicy(true, 'Alias', 'AWS::Lambda::Alias', resource, false, spy, noSecret)
    ).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a resolved value the secret guard flags, snapshotting before the resolution', async () => {
    const order: string[] = [];
    const error = await resolveAliasUpdatePolicy(
      true,
      'Alias',
      'AWS::Lambda::Alias',
      resource,
      true,
      (v) => {
        order.push('resolve');
        return resolve(v);
      },
      () => {
        order.push('snapshot');
        return (resolved) => {
          order.push('check');
          expect(resolved).toEqual(RESOLVED.CodeDeployLambdaAliasUpdate);
          return true;
        };
      }
    ).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
    expect(order).toEqual(['snapshot', 'resolve', 'check']);
  });

  it('refuses a dynamic reference, marked refused-before-applying', async () => {
    const error = await resolveAliasUpdatePolicy(
      true,
      'Alias',
      'AWS::Lambda::Alias',
      {
        Type: 'AWS::Lambda::Alias',
        UpdatePolicy: {
          CodeDeployLambdaAliasUpdate: {
            ApplicationName: { 'Fn::Sub': '{{resolve:secretsmanager:s}}' },
            DeploymentGroupName: 'g',
          },
        },
      },
      true,
      resolve,
      noSecret
    ).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'Alias')).toBe(true);
  });

  it('journaledUpdatePolicy prefers the resolved policy, only under the flag', () => {
    expect(journaledUpdatePolicy(true, resource, RESOLVED)).toEqual(RESOLVED);
    expect(journaledUpdatePolicy(true, resource)).toEqual(AS_WRITTEN);
    expect(journaledUpdatePolicy(undefined, resource, RESOLVED)).toBeUndefined();
  });
});
