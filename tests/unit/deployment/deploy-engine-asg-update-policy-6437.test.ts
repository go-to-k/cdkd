import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { findUpdatePolicyReplacementRefusals } from '../../../src/deployment/deploy-engine/update-policy.js';
import type { CloudFormationTemplate, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

// go-to-k/cdkd#6437 PR 2 + go-to-k/cdkd#6457: the engine side of the Auto
// Scaling rollouts. `AutoScalingReplacingUpdate` routes a trigger-property
// change through the create-first replacement under `--update-policy`; the
// hint / Cloud Control warning read the trigger properties; an UPDATE run under
// the flag journals its policy, and the rollback revert hands it back minus
// `AutoScalingScheduledAction`.

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

const STACK = 'asg-update-policy-stack';
const ASG = 'AWS::AutoScaling::AutoScalingGroup';
const LT = (version: string) => ({ LaunchTemplateId: 'lt-0abc', Version: version });
const PREVIOUS = { MinSize: '1', MaxSize: '2', LaunchTemplate: LT('1') };
const LT_CHANGE = { ...PREVIOUS, LaunchTemplate: LT('2') };
const SIZE_CHANGE = { ...PREVIOUS, MaxSize: '3' };
const SCHEDULED = { AutoScalingScheduledAction: { IgnoreUnmodifiedGroupSizeProperties: true } };
const ROLLING = { AutoScalingRollingUpdate: { MaxBatchSize: 1, MinInstancesInService: 1 } };
const REPLACING = { AutoScalingReplacingUpdate: { WillReplace: true } };
const INSTANCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('DeployEngine Auto Scaling UpdatePolicy rollouts (go-to-k/cdkd#6437, #6457)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let diffCalculator: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'asg-new' }),
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

  function makeEngine(
    updatePolicy?: boolean,
    provisionedBy: 'sdk' | 'cc-api' = 'sdk',
    extra: Record<string, unknown> = {},
    levels: string[][] = [['Group']]
  ): DeployEngine {
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
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false, ...extra, ...(updatePolicy !== undefined && { updatePolicy }) },
      'us-east-1'
    );
  }

  function prime(
    updatePolicy: Record<string, unknown> | undefined,
    desired: Record<string, unknown>,
    previous: Record<string, unknown> = PREVIOUS,
    // `null`: a legacy record with no id (an `undefined` argument takes the default).
    stackInstanceId: string | null = INSTANCE_ID
  ): CloudFormationTemplate {
    stateBackend.getState!.mockResolvedValue({
      state: {
        version: 8,
        stackName: STACK,
        region: 'us-east-1',
        ...(stackInstanceId !== null && { stackInstanceId }),
        resources: { Group: { physicalId: 'asg', resourceType: ASG, properties: previous } },
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
            resourceType: ASG,
            desiredProperties: desired,
            currentProperties: previous,
          },
        ],
      ])
    );
    return {
      Resources: {
        Group: {
          Type: ASG,
          Properties: desired,
          ...(updatePolicy && { UpdatePolicy: updatePolicy }),
        },
      },
    };
  }

  const lines = (fn: ReturnType<typeof vi.fn>, needle: string): string[] =>
    fn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(needle));
  const hints = (): string[] => lines(log.info, 'skipped by default');
  const routeWarnings = (): string[] => lines(log.warn, 'Cloud Control route');

  describe('hint and Cloud Control warning', () => {
    it.each([
      ['AutoScalingRollingUpdate', ROLLING],
      ['AutoScalingReplacingUpdate', REPLACING],
      ['AutoScalingInstanceRefresh', { AutoScalingInstanceRefresh: { Strategy: 'Rolling' } }],
    ])('the default hints %s on a launch template change', async (key, policy) => {
      await makeEngine().deploy(STACK, prime(policy, LT_CHANGE));
      expect(provider.update).toHaveBeenCalledTimes(1);
      expect(hints()).toHaveLength(1);
      expect(hints()[0]).toContain(key);
    });

    it.each([ROLLING, REPLACING])('the default does not hint on a size-only change', async (policy) => {
      await makeEngine().deploy(STACK, prime(policy, SIZE_CHANGE));
      expect(hints()).toEqual([]);
    });

    it('the default hints AutoScalingReplacingUpdate on the Cloud Control route, not the rolling update', async () => {
      await makeEngine(undefined, 'cc-api').deploy(STACK, prime({ ...ROLLING }, LT_CHANGE));
      expect(hints()).toEqual([]);
      await makeEngine(undefined, 'cc-api').deploy(STACK, prime(REPLACING, LT_CHANGE));
      expect(hints()).toHaveLength(1);
      expect(hints()[0]).toContain('AutoScalingReplacingUpdate');
    });

    it('--update-policy on the Cloud Control route warns about the rolling update only', async () => {
      await makeEngine(true, 'cc-api').deploy(STACK, prime(ROLLING, LT_CHANGE));
      expect(routeWarnings()).toHaveLength(1);
      expect(routeWarnings()[0]).toContain('AutoScalingRollingUpdate');
      expect(routeWarnings()[0]).not.toContain('AutoScalingReplacingUpdate');
    });

    it('--update-policy on the Cloud Control route does not warn for a size-only change', async () => {
      await makeEngine(true, 'cc-api').deploy(STACK, prime(ROLLING, SIZE_CHANGE));
      expect(routeWarnings()).toEqual([]);
    });
  });

  describe('AutoScalingReplacingUpdate', () => {
    /** The diff's verdict under --update-policy (`markUpdatePolicyReplacements`). */
    function primeFlagged(
      updatePolicy: Record<string, unknown>,
      desired: Record<string, unknown> = LT_CHANGE,
      previous: Record<string, unknown> = PREVIOUS,
      stackInstanceId: string | null = INSTANCE_ID
    ): CloudFormationTemplate {
      const template = prime(updatePolicy, desired, previous, stackInstanceId);
      diffCalculator.calculateDiff!.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Group',
            {
              logicalId: 'Group',
              changeType: 'UPDATE',
              resourceType: ASG,
              desiredProperties: desired,
              currentProperties: previous,
              propertyChanges: [
                {
                  path: 'LaunchTemplate',
                  oldValue: previous['LaunchTemplate'],
                  newValue: desired['LaunchTemplate'],
                  requiresReplacement: true,
                  updatePolicyReplacement: true,
                },
              ],
            } as ResourceChange,
          ],
        ])
      );
      return template;
    }
    const refusalOf = async (deploy: Promise<unknown>): Promise<string> => {
      const error = await deploy.then(
        () => undefined,
        (e: unknown) => e
      );
      const messages: string[] = [];
      for (let e = error, depth = 0; e instanceof Error && depth < 10; depth++) {
        messages.push(e.message);
        e = e.cause;
      }
      return messages.join('\n');
    };

    it.each([
      ['--update-policy', true, true],
      ['--no-update-policy', false, false],
      ['neither', undefined, false],
    ])('hands the diff updatePolicy=%s', async (_label, flag, expected) => {
      await makeEngine(flag as boolean | undefined).deploy(STACK, prime(REPLACING, LT_CHANGE));
      expect(diffCalculator.calculateDiff!.mock.calls[0]!.at(-1)).toBe(expected);
    });

    it('replaces the group create-first when the diff marked the policy replacement', async () => {
      await makeEngine(true).deploy(STACK, primeFlagged({ ...REPLACING, ...ROLLING }));
      expect(provider.update).not.toHaveBeenCalled();
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.create!.mock.calls[0]![2]).toMatchObject({ LaunchTemplate: LT('2') });
      // The new group waits for its instances before the old one goes.
      expect(provider.create!.mock.calls[0]![3]).toMatchObject({ awaitInService: true });
      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(provider.delete!.mock.calls[0]![1]).toBe('asg');
      expect(provider.create!.mock.invocationCallOrder[0]!).toBeLessThan(
        provider.delete!.mock.invocationCallOrder[0]!
      );
      expect(lines(log.info, 'Replacing Group')[0]).toContain(
        'UpdatePolicy AutoScalingReplacingUpdate (WillReplace: true)'
      );
      const saved = stateBackend.saveState!.mock.calls
        .at(-1)!
        .find((a: unknown) => typeof a === 'object' && a !== null && 'resources' in a) as {
        resources: Record<string, { physicalId: string }>;
      };
      expect(saved.resources['Group']!.physicalId).toBe('asg-new');
    });

    it('decides the Cloud Control refusal at the plan, from the create route', () => {
      const change = (ceiling: boolean): Map<string, ResourceChange> =>
        new Map([
          [
            'Group',
            {
              logicalId: 'Group',
              changeType: 'UPDATE',
              resourceType: ASG,
              desiredProperties: LT_CHANGE,
              propertyChanges: [
                {
                  path: 'LaunchTemplate',
                  oldValue: 1,
                  newValue: 2,
                  requiresReplacement: true,
                  updatePolicyReplacement: true,
                  ...(ceiling && { inPlacePropagated: true }),
                },
              ],
            } as ResourceChange,
          ],
        ]);
      const template = prime(REPLACING, LT_CHANGE);
      expect(findUpdatePolicyReplacementRefusals(change(false), template, true, () => true)[0]).toContain(
        'would be created through Cloud Control'
      );
      expect(findUpdatePolicyReplacementRefusals(change(false), template, true, () => false)).toEqual([]);
      // A ceiling (a GetAtt-read version) is left to the engine's check.
      expect(findUpdatePolicyReplacementRefusals(change(true), template, false, () => true)).toEqual([]);
    });

    it('refuses the replacement on the Cloud Control route, before anything is created', async () => {
      const text = await refusalOf(makeEngine(true, 'cc-api').deploy(STACK, primeFlagged(REPLACING)));
      expect(text).toContain('would be created through Cloud Control');
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.update).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('refuses at the plan, before an unrelated resource is created', async () => {
      const named = { ...LT_CHANGE, AutoScalingGroupName: 'fixed-name' };
      const template = primeFlagged(REPLACING, named, { ...PREVIOUS, AutoScalingGroupName: 'fixed-name' });
      const changes = new Map<string, ResourceChange>([
        [
          'Group',
          {
            logicalId: 'Group',
            changeType: 'UPDATE',
            resourceType: ASG,
            desiredProperties: named,
            currentProperties: { ...PREVIOUS, AutoScalingGroupName: 'fixed-name' },
            propertyChanges: [
              {
                path: 'LaunchTemplate',
                oldValue: LT('1'),
                newValue: LT('2'),
                requiresReplacement: true,
                updatePolicyReplacement: true,
              },
            ],
          } as ResourceChange,
        ],
        [
          'Other',
          { logicalId: 'Other', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue', desiredProperties: {} },
        ],
      ]);
      diffCalculator.calculateDiff!.mockReset();
      diffCalculator.calculateDiff!.mockResolvedValue(changes);
      template.Resources['Other'] = { Type: 'AWS::SQS::Queue', Properties: {} };
      const text = await refusalOf(makeEngine(true, 'sdk', {}, [['Other', 'Group']]).deploy(STACK, template));
      expect(text).toContain('the template names the group (AutoScalingGroupName)');
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.update).not.toHaveBeenCalled();
    });

    it('refuses a Cloud Control-routed new group at the plan, before an unrelated resource is created', async () => {
      const template = primeFlagged(REPLACING);
      const changes = new Map<string, ResourceChange>([
        [
          'Group',
          {
            logicalId: 'Group',
            changeType: 'UPDATE',
            resourceType: ASG,
            desiredProperties: LT_CHANGE,
            currentProperties: PREVIOUS,
            propertyChanges: [
              {
                path: 'LaunchTemplate',
                oldValue: LT('1'),
                newValue: LT('2'),
                requiresReplacement: true,
                updatePolicyReplacement: true,
              },
            ],
          } as ResourceChange,
        ],
        [
          'Other',
          { logicalId: 'Other', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue', desiredProperties: {} },
        ],
      ]);
      diffCalculator.calculateDiff!.mockReset();
      diffCalculator.calculateDiff!.mockResolvedValue(changes);
      template.Resources['Other'] = { Type: 'AWS::SQS::Queue', Properties: {} };
      const text = await refusalOf(
        makeEngine(true, 'cc-api', {}, [['Other', 'Group']]).deploy(STACK, template)
      );
      expect(text).toContain('would be created through Cloud Control');
      expect(provider.create).not.toHaveBeenCalled();
    });

    it('does not ask for the in-service wait on a property-driven replacement', async () => {
      const template = primeFlagged(REPLACING);
      diffCalculator.calculateDiff!.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Group',
            {
              logicalId: 'Group',
              changeType: 'UPDATE',
              resourceType: ASG,
              desiredProperties: LT_CHANGE,
              currentProperties: PREVIOUS,
              propertyChanges: [
                { path: 'LaunchTemplate', oldValue: 1, newValue: 2, requiresReplacement: true },
              ],
            } as ResourceChange,
          ],
        ])
      );
      await makeEngine(true).deploy(STACK, template);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.create!.mock.calls[0]![3]).not.toHaveProperty('awaitInService');
      expect(lines(log.info, 'Replacing Group')[0]).toContain('immutable properties changed');
    });

    it('updates in place when the diff marked nothing', async () => {
      await makeEngine(true).deploy(STACK, prime(REPLACING, SIZE_CHANGE));
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.update).toHaveBeenCalledTimes(1);
    });

    it('refuses a named group before anything is sent', async () => {
      const named = { ...LT_CHANGE, AutoScalingGroupName: 'fixed-name' };
      const text = await refusalOf(
        makeEngine(true).deploy(
          STACK,
          primeFlagged(REPLACING, named, { ...PREVIOUS, AutoScalingGroupName: 'fixed-name' })
        )
      );
      expect(text).toContain('the template names the group (AutoScalingGroupName)');
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.update).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('refuses on a stack with no instance id, before anything is sent', async () => {
      const text = await refusalOf(
        makeEngine(true).deploy(STACK, primeFlagged(REPLACING, LT_CHANGE, PREVIOUS, null))
      );
      expect(text).toContain("this stack's state predates cdkd's replacement names");
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.update).not.toHaveBeenCalled();
    });

    it('refuses WillReplace beside both AutoScalingInstanceRefresh and AutoScalingRollingUpdate', async () => {
      const text = await refusalOf(
        makeEngine(true).deploy(
          STACK,
          primeFlagged({
            ...REPLACING,
            ...ROLLING,
            AutoScalingInstanceRefresh: { Strategy: 'Rolling' },
          })
        )
      );
      expect(text).toContain('both AutoScalingInstanceRefresh and AutoScalingRollingUpdate');
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.update).not.toHaveBeenCalled();
    });
  });

  describe('rollback revert (go-to-k/cdkd#6457)', () => {
    /** Group updates, then Other fails, so the automatic rollback reverts Group. */
    function primeTwo(updatePolicy: Record<string, unknown>): CloudFormationTemplate {
      const template = prime(updatePolicy, LT_CHANGE);
      stateBackend.getState!.mockResolvedValue({
        state: {
          version: 8,
          stackName: STACK,
          region: 'us-east-1',
          resources: {
            Group: { physicalId: 'asg', resourceType: ASG, properties: PREVIOUS },
            Other: { physicalId: 'other', resourceType: 'AWS::SQS::Queue', properties: { A: '1' } },
          },
          outputs: {},
          lastModified: 1,
        },
        etag: 'etag-old',
      });
      const changes = new Map<string, ResourceChange>([
        [
          'Group',
          {
            logicalId: 'Group',
            changeType: 'UPDATE',
            resourceType: ASG,
            desiredProperties: LT_CHANGE,
            currentProperties: PREVIOUS,
          },
        ],
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
      ]);
      diffCalculator.calculateDiff!.mockResolvedValue(changes);
      template.Resources['Other'] = {
        Type: 'AWS::SQS::Queue',
        Properties: { A: '2' },
        DependsOn: ['Group'],
      };
      provider.update!.mockImplementation((logicalId: string) =>
        logicalId === 'Other'
          ? Promise.reject(new Error('synthetic failure 6457'))
          : Promise.resolve({ physicalId: 'asg' })
      );
      return template;
    }

    const groupContexts = (): UpdateContext[] =>
      provider.update!.mock.calls
        .filter((c) => c[0] === 'Group')
        .map((c) => c[5] as UpdateContext);

    it('hands the revert the forward policy without AutoScalingScheduledAction', async () => {
      await makeEngine(true, 'sdk', {}, [['Group'], ['Other']])
        .deploy(STACK, primeTwo({ ...SCHEDULED, ...ROLLING }))
        .catch(() => undefined);
      const contexts = groupContexts();
      expect(contexts).toHaveLength(2);
      expect(contexts[0]!.updatePolicy).toEqual({ ...SCHEDULED, ...ROLLING });
      expect(contexts[1]!.replayingState).toBe(true);
      expect(contexts[1]!.updatePolicy).toEqual(ROLLING);
    });

    it('hands the revert nothing when the forward policy was only AutoScalingScheduledAction', async () => {
      await makeEngine(true, 'sdk', {}, [['Group'], ['Other']])
        .deploy(STACK, primeTwo(SCHEDULED))
        .catch(() => undefined);
      const contexts = groupContexts();
      expect(contexts).toHaveLength(2);
      expect(contexts[1]!.replayingState).toBe(true);
      expect(contexts[1]).not.toHaveProperty('updatePolicy');
    });

    const journaledFailedOps = (): Array<Record<string, unknown>> =>
      stateBackend.appendRollbackJournalSegment!.mock.calls.flatMap((call) =>
        call
          .filter(
            (a: unknown): a is { failedOperations?: Array<Record<string, unknown>> } =>
              typeof a === 'object' && a !== null && 'failedOperations' in a
          )
          .flatMap((a) => a.failedOperations ?? [])
      );

    it.each([
      ['journals the policy on a failed UPDATE under --update-policy', true, { ...SCHEDULED, ...ROLLING }],
      ['journals none without the flag', undefined, undefined],
    ])('%s', async (_label, flag, expected) => {
      const template = prime({ ...SCHEDULED, ...ROLLING }, LT_CHANGE);
      provider.update!.mockRejectedValue(new Error('synthetic failure 6457'));
      await makeEngine(flag as boolean | undefined)
        .deploy(STACK, template)
        .catch(() => undefined);
      const ops = journaledFailedOps().filter((op) => op['logicalId'] === 'Group');
      expect(ops.length).toBeGreaterThan(0);
      for (const op of ops) {
        if (expected === undefined) expect(op).not.toHaveProperty('updatePolicy');
        else expect(op['updatePolicy']).toEqual(expected);
      }
    });

    it('reverts a group whose own refresh failed after its update landed (unsettled marks)', async () => {
      const template = prime(ROLLING, LT_CHANGE);
      // The convergence reads what AWS holds: the forward update landed.
      provider.readCurrentState!.mockResolvedValue(LT_CHANGE);
      let calls = 0;
      provider.update!.mockImplementation(
        (_id: string, _p: string, _t: string, _d: unknown, _prev: unknown, context: UpdateContext) => {
          calls++;
          if (calls === 1) {
            context.markUnsettled?.('LaunchTemplate');
            return Promise.reject(new Error('instance refresh r-1 ended Failed'));
          }
          return Promise.resolve({ physicalId: 'asg' });
        }
      );
      await makeEngine(true)
        .deploy(STACK, template)
        .catch(() => undefined);
      const contexts = groupContexts();
      expect(contexts).toHaveLength(2);
      expect(contexts[1]!.replayingState).toBe(true);
      expect(contexts[1]!.updatePolicy).toEqual(ROLLING);
      expect(provider.update!.mock.calls[1]![3]).toEqual(PREVIOUS);
      // The previous side is what AWS holds, so the provider's refresh sees the move.
      expect(provider.update!.mock.calls[1]![4]).toMatchObject({ LaunchTemplate: LT('2') });
      expect(contexts[1]!.unsettledProperties).toEqual(new Set(['LaunchTemplate']));
    });

    it('journals no updatePolicy on a failed CREATE', async () => {
      stateBackend.getState!.mockResolvedValue({
        state: {
          version: 8,
          stackName: STACK,
          region: 'us-east-1',
          resources: {},
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
              changeType: 'CREATE',
              resourceType: ASG,
              desiredProperties: LT_CHANGE,
            } as ResourceChange,
          ],
        ])
      );
      provider.create!.mockRejectedValue(new Error('synthetic create failure 6457'));
      await makeEngine(true)
        .deploy(STACK, { Resources: { Group: { Type: ASG, Properties: LT_CHANGE, UpdatePolicy: ROLLING } } })
        .catch(() => undefined);
      const ops = journaledFailedOps().filter((op) => op['logicalId'] === 'Group');
      expect(ops.length).toBeGreaterThan(0);
      for (const op of ops) expect(op).not.toHaveProperty('updatePolicy');
    });

    it('hands the revert nothing for a deploy without --update-policy', async () => {
      await makeEngine(undefined, 'sdk', {}, [['Group'], ['Other']])
        .deploy(STACK, primeTwo(ROLLING))
        .catch(() => undefined);
      const contexts = groupContexts();
      expect(contexts).toHaveLength(2);
      expect(contexts[1]).not.toHaveProperty('updatePolicy');
    });
  });
});
