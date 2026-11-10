/**
 * go-to-k/cdkd#6088: a producer deploy that changes or removes an export a
 * consumer outside the run still imports is refused before any resource
 * change, as CloudFormation refuses it.
 *
 * Two halves: `findAffectedExports` (no I/O) decides which exports the plan
 * touches, and `refuseUnsafePlan` scans consumers only when it found one, so
 * the everyday deploy never lists the state bucket.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import { findAffectedExports, inRunStackKey } from '../../../src/deployment/export-change-guard.js';
import { refuseUnsafePlan } from '../../../src/deployment/deploy-engine/deploy-flow/plan-checks.js';
import { ExportInUseError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-resolver/context.js';

const EXPORT = 'Producer:ExportsOutputFnGetAttQArn';
const OLD_ARN = 'arn:aws:sqs:us-east-1:111122223333:q1';

function template(outputs: CloudFormationTemplate['Outputs']): CloudFormationTemplate {
  return {
    Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q2' } } },
    Outputs: outputs,
  };
}

const exportingQueueArn = template({
  ExportsOutputFnGetAttQArn: {
    Value: { 'Fn::GetAtt': ['Q', 'Arn'] },
    Export: { Name: EXPORT },
  },
});

function state(extra: Partial<StackState> = {}): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'Producer',
    region: 'us-east-1',
    resources: {
      Q: {
        physicalId: 'https://sqs.us-east-1.amazonaws.com/111122223333/q1',
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: 'q1' },
        attributes: { Arn: OLD_ARN },
        dependencies: [],
      },
    },
    outputs: { ExportsOutputFnGetAttQArn: OLD_ARN, [EXPORT]: OLD_ARN },
    exportNames: [EXPORT],
    lastModified: 0,
    ...extra,
  } as StackState;
}

function change(over: Partial<ResourceChange> & Pick<ResourceChange, 'changeType'>): ResourceChange {
  return { logicalId: 'Q', resourceType: 'AWS::SQS::Queue', ...over };
}

const replacingChange = change({
  changeType: 'UPDATE',
  propertyChanges: [{ path: 'QueueName', oldValue: 'q1', newValue: 'q2', requiresReplacement: true }],
});

const noReplace = (): boolean => false;

describe('findAffectedExports', () => {
  it('returns nothing, resolving nothing, for a stack that publishes no export', async () => {
    const resolve = vi.fn();
    const affected = await findAffectedExports({
      template: exportingQueueArn,
      conditions: {},
      changes: new Map([['Q', replacingChange]]),
      currentState: state({ outputs: {}, exportNames: [] }),
      resolve,
      replaces: () => true,
    });
    expect(affected).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('counts an export whose output reads a replaced resource as changed', async () => {
    const affected = await findAffectedExports({
      template: exportingQueueArn,
      conditions: {},
      changes: new Map([['Q', replacingChange]]),
      currentState: state(),
      // The diff context still answers with the OLD attribute.
      resolve: () => Promise.resolve(OLD_ARN),
      replaces: (id) => id === 'Q',
    });
    expect(affected).toEqual([{ exportName: EXPORT, reason: 'changed' }]);
  });

  it('counts an export no template output declares any more, or only under a false condition, as removed', async () => {
    const variants: Array<CloudFormationTemplate['Outputs']> = [
      {},
      {
        ExportsOutputFnGetAttQArn: {
          Value: { 'Fn::GetAtt': ['Q', 'Arn'] },
          Export: { Name: EXPORT },
          Condition: 'Off',
        },
      },
    ];
    for (const outputs of variants) {
      const affected = await findAffectedExports({
        template: template(outputs),
        conditions: { Off: false },
        changes: new Map(),
        currentState: state(),
        resolve: () => Promise.resolve(OLD_ARN),
        replaces: noReplace,
      });
      expect(affected).toEqual([{ exportName: EXPORT, reason: 'removed' }]);
    }
  });

  it('compares a resolvable value with the published one', async () => {
    const run = (resolved: unknown) =>
      findAffectedExports({
        template: exportingQueueArn,
        conditions: {},
        changes: new Map([['Q', change({ changeType: 'UPDATE' })]]),
        currentState: state(),
        resolve: () => Promise.resolve(resolved),
        replaces: noReplace,
      });
    expect(await run(OLD_ARN)).toEqual([]);
    expect(await run('arn:aws:sqs:us-east-1:111122223333:other')).toEqual([
      { exportName: EXPORT, reason: 'changed' },
    ]);
  });

  it('counts a value that cannot be resolved as changed only when it reads a resource the plan touches', async () => {
    const run = (changes: Map<string, ResourceChange>) =>
      findAffectedExports({
        template: exportingQueueArn,
        conditions: {},
        changes,
        currentState: state(),
        resolve: () => Promise.reject(new Error('unresolvable')),
        replaces: noReplace,
      });
    expect(await run(new Map([['Q', change({ changeType: 'NO_CHANGE' })]]))).toEqual([]);
    expect(await run(new Map([['Q', change({ changeType: 'UPDATE' })]]))).toEqual([
      { exportName: EXPORT, reason: 'changed' },
    ]);
  });

  it('keeps a pre-v9 record\'s plain output key published while the template still declares that output', async () => {
    const legacy = state({ exportNames: undefined, outputs: { Plain: 'v', Gone: 'w' } });
    const affected = await findAffectedExports({
      template: template({ Plain: { Value: 'v' } }),
      conditions: {},
      changes: new Map(),
      currentState: legacy,
      resolve: (value) => Promise.resolve(value),
      replaces: noReplace,
    });
    expect(affected).toEqual([{ exportName: 'Gone', reason: 'removed' }]);
  });

  it('resolves nothing that holds a dynamic reference', async () => {
    const resolve = vi.fn().mockResolvedValue('anything');
    const affected = await findAffectedExports({
      template: template({
        ByName: {
          Value: 'public',
          Export: { Name: { 'Fn::Sub': 'x-{{resolve:secretsmanager:s}}' } as never },
        },
        ExportsOutputFnGetAttQArn: {
          Value: { 'Fn::Sub': '${Q.Arn}-{{resolve:ssm:p}}' },
          Export: { Name: EXPORT },
        },
      }),
      conditions: {},
      changes: new Map([['Q', change({ changeType: 'NO_CHANGE' })]]),
      currentState: state(),
      resolve,
      replaces: noReplace,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(affected).toEqual([]);
  });

  it('leaves a published NoEcho mask uncompared', async () => {
    const affected = await findAffectedExports({
      template: exportingQueueArn,
      conditions: {},
      changes: new Map(),
      currentState: state({ outputs: { ExportsOutputFnGetAttQArn: '***', [EXPORT]: '***' } }),
      resolve: () => Promise.resolve('plaintext'),
      replaces: noReplace,
    });
    expect(affected).toEqual([]);
  });
});

describe('refuseUnsafePlan refuses an in-use export change (go-to-k/cdkd#6088)', () => {
  function engineDouble(opts: {
    consumers: Array<{ name: string; imports: string[]; unreadable?: boolean }>;
    inRun?: string[];
    inRunRegion?: string;
    options?: Record<string, unknown>;
  }) {
    const listStacks = vi.fn().mockResolvedValue(
      [{ stackName: 'Producer', region: 'us-east-1' }].concat(
        opts.consumers.map((c) => ({ stackName: c.name, region: 'us-east-1' }))
      )
    );
    const getState = vi.fn().mockImplementation((name: string) => {
      const consumer = opts.consumers.find((c) => c.name === name);
      if (!consumer) return Promise.resolve(null);
      if (consumer.unreadable) return Promise.reject(new Error('AccessDenied'));
      return Promise.resolve({
        state: {
          imports: consumer.imports.map((exportName) => ({
            sourceStack: 'Producer',
            sourceRegion: 'us-east-1',
            exportName,
          })),
        },
      });
    });
    const engine = {
      options: {
        ...opts.options,
        ...(opts.inRun && {
          inRunStacks: new Set(
            opts.inRun.map((n) => inRunStackKey(n, opts.inRunRegion ?? 'us-east-1'))
          ),
        }),
      },
      resolver: { resolve: vi.fn().mockResolvedValue(OLD_ARN) },
      stateBackend: { listStacks, getState },
      stackRegion: 'us-east-1',
      logger: { debug: vi.fn(), warn: vi.fn() },
    } as unknown as DeployEngine;
    return { engine, listStacks };
  }

  const plan = (
    changes: Map<string, ResourceChange>,
    effectiveTemplate: CloudFormationTemplate = exportingQueueArn
  ) => ({
    stackName: 'Producer',
    currentState: state(),
    effectiveTemplate,
    parameterValues: {},
    conditions: {},
    changes,
    diffResolverContext: {} as ResolverContext,
  });

  it('refuses, exit 1, naming the consumer outside the run', async () => {
    const { engine } = engineDouble({ consumers: [{ name: 'Consumer', imports: [EXPORT] }] });
    const error = await refuseUnsafePlan(engine, plan(new Map([['Q', replacingChange]]))).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ExportInUseError);
    // Exit 1 like every refused deploy: deploy's exit 2 means "deployed, and a
    // re-run usually clears it", which never holds here.
    expect((error as { exitCode?: number }).exitCode).toBeUndefined();
    expect((error as ExportInUseError).changes).toEqual([
      { consumerStack: 'Consumer', consumerRegion: 'us-east-1', exportName: EXPORT, reason: 'changed' },
    ]);
    expect((error as Error).message).toContain('which this deploy would change');
  });

  it('lets a consumer deployed in the same run through', async () => {
    const { engine } = engineDouble({
      consumers: [{ name: 'Consumer', imports: [EXPORT] }],
      inRun: ['Producer', 'Consumer'],
    });
    await expect(
      refuseUnsafePlan(engine, plan(new Map([['Q', replacingChange]])))
    ).resolves.toBeUndefined();
  });

  it('ignores a consumer importing an export the plan leaves alone', async () => {
    const { engine } = engineDouble({ consumers: [{ name: 'Consumer', imports: ['Other:Export'] }] });
    await expect(
      refuseUnsafePlan(engine, plan(new Map([['Q', replacingChange]])))
    ).resolves.toBeUndefined();
  });

  it('never lists the state bucket when no export is touched', async () => {
    const { engine, listStacks } = engineDouble({ consumers: [{ name: 'Consumer', imports: [EXPORT] }] });
    await refuseUnsafePlan(engine, plan(new Map([['Q', change({ changeType: 'NO_CHANGE' })]])));
    expect(listStacks).not.toHaveBeenCalled();
  });

  const refusal = async (
    engine: DeployEngine,
    changes: Map<string, ResourceChange>,
    template?: CloudFormationTemplate
  ): Promise<ExportInUseError | undefined> => {
    try {
      await refuseUnsafePlan(engine, plan(changes, template));
      return undefined;
    } catch (e) {
      expect(e).toBeInstanceOf(ExportInUseError);
      return e as ExportInUseError;
    }
  };

  it('counts a Type change of the referenced resource as a replacement', async () => {
    const { engine } = engineDouble({ consumers: [{ name: 'Consumer', imports: [EXPORT] }] });
    const typeChange = change({ changeType: 'UPDATE', resourceType: 'AWS::SNS::Topic' });
    expect(await refusal(engine, new Map([['Q', typeChange]]))).toBeDefined();
  });

  it('counts a --recreate-via-* target as a replacement, even with no template change', async () => {
    const { engine } = engineDouble({
      consumers: [{ name: 'Consumer', imports: [EXPORT] }],
      options: {
        recreateTargets: { stackName: 'Producer', viaCcApi: ['Q'], viaSdkProvider: [] },
      },
    });
    expect(await refusal(engine, new Map([['Q', change({ changeType: 'NO_CHANGE' })]]))).toBeDefined();
  });

  it('does not count an in-place propagation\'s replacement ceiling', async () => {
    const { engine } = engineDouble({ consumers: [{ name: 'Consumer', imports: [EXPORT] }] });
    const ceiling = change({
      changeType: 'UPDATE',
      propertyChanges: [
        {
          path: 'QueueName',
          oldValue: 'q1',
          newValue: 'q1',
          requiresReplacement: true,
          inPlacePropagated: true,
        },
      ],
    });
    expect(await refusal(engine, new Map([['Q', ceiling]]))).toBeUndefined();
  });

  it('refuses a removed export, worded as a removal', async () => {
    const { engine } = engineDouble({ consumers: [{ name: 'Consumer', imports: [EXPORT] }] });
    const error = await refusal(engine, new Map(), template({}));
    expect(error?.changes).toEqual([
      { consumerStack: 'Consumer', consumerRegion: 'us-east-1', exportName: EXPORT, reason: 'removed' },
    ]);
    expect(error?.message).toContain('which this deploy would remove');
  });

  it('refuses when a record that may hold an importer cannot be read', async () => {
    const { engine } = engineDouble({
      consumers: [{ name: 'Unreadable', imports: [], unreadable: true }],
    });
    const error = await refusal(engine, new Map([['Q', replacingChange]]));
    expect(error?.changes).toEqual([]);
    expect(error?.unreadable).toEqual([{ stackName: 'Unreadable', region: 'us-east-1' }]);
    expect(error?.message).toContain('could not be read');
  });

  it('does not refuse over an unreadable record of a stack in the same run', async () => {
    const { engine } = engineDouble({
      consumers: [{ name: 'Unreadable', imports: [], unreadable: true }],
      inRun: ['Producer', 'Unreadable'],
    });
    expect(await refusal(engine, new Map([['Q', replacingChange]]))).toBeUndefined();
  });

  it('says nothing was changed only outside a nested child', async () => {
    const top = engineDouble({ consumers: [{ name: 'Consumer', imports: [EXPORT] }] });
    expect((await refusal(top.engine, new Map([['Q', replacingChange]])))?.message).toContain(
      'Nothing was changed.'
    );
    const nested = engineDouble({
      consumers: [{ name: 'Consumer', imports: [EXPORT] }],
      options: { parentStackInfo: { stackName: 'Parent', logicalId: 'Child' } },
    });
    expect(
      (await refusal(nested.engine, new Map([['Q', replacingChange]])))?.message
    ).not.toContain('Nothing was changed.');
  });

  it('matches an in-run consumer whatever the case of its region', async () => {
    const { engine } = engineDouble({
      consumers: [{ name: 'Consumer', imports: [EXPORT] }],
      inRun: ['Producer', 'Consumer'],
      inRunRegion: 'US-EAST-1',
    });
    expect(await refusal(engine, new Map([['Q', replacingChange]]))).toBeUndefined();
  });
});

describe('findAffectedExports: what moves an exported value', () => {
  const run = (
    outputs: CloudFormationTemplate['Outputs'],
    changes: Map<string, ResourceChange>,
    resolve: (value: unknown) => Promise<unknown> = () => Promise.resolve(OLD_ARN)
  ) =>
    findAffectedExports({
      template: template(outputs),
      conditions: {},
      changes,
      currentState: state(),
      resolve,
      replaces: noReplace,
    });
  const exported = (value: unknown) => ({
    ExportsOutputFnGetAttQArn: { Value: value, Export: { Name: EXPORT } },
  });

  it('proves an intrinsic Export.Name by resolving it', async () => {
    const outputs = {
      ExportsOutputFnGetAttQArn: {
        Value: { 'Fn::GetAtt': ['Q', 'Arn'] },
        Export: { Name: { 'Fn::Sub': '${AWS::StackName}:QArn' } as never },
      },
    };
    const resolveName = (value: unknown) =>
      Promise.resolve(typeof value === 'object' && value !== null && 'Fn::Sub' in value ? EXPORT : OLD_ARN);
    expect(await run(outputs, new Map(), resolveName)).toEqual([]);
    expect(
      await run(outputs, new Map(), (value) =>
        typeof value === 'object' && value !== null && 'Fn::Sub' in value
          ? Promise.reject(new Error('unresolvable'))
          : Promise.resolve(OLD_ARN)
      )
    ).toEqual([{ exportName: EXPORT, reason: 'removed' }]);
  });

  it('counts a value now reading a resource this plan creates or deletes, though the diff context still resolves the old value', async () => {
    for (const changeType of ['CREATE', 'DELETE'] as const) {
      const changes = new Map([['Q', change({ changeType })]]);
      expect(await run(exportingQueueArn.Outputs, changes)).toEqual([
        { exportName: EXPORT, reason: 'changed' },
      ]);
    }
  });

  it('counts an in-place update that may move the read attribute, though the old value still resolves', async () => {
    const cases: Array<[unknown, ResourceChange]> = [
      // Arm 1: the attribute names a changed property.
      [
        { 'Fn::GetAtt': ['Q', 'Value'] },
        change({
          changeType: 'UPDATE',
          resourceType: 'AWS::SSM::Parameter',
          propertyChanges: [{ path: 'Value', oldValue: 'a', newValue: 'b', requiresReplacement: false }],
        }),
      ],
      // Arm 2: a derived attribute of the type.
      [
        { 'Fn::GetAtt': ['Q', 'LatestVersionNumber'] },
        change({ changeType: 'UPDATE', resourceType: 'AWS::EC2::LaunchTemplate' }),
      ],
      // Arm 3: a derived attribute family (a nested stack's outputs).
      [
        { 'Fn::GetAtt': ['Q', 'Outputs.Url'] },
        change({ changeType: 'UPDATE', resourceType: 'AWS::CloudFormation::Stack' }),
      ],
      // Arm 4: any read of a custom resource, its Ref included.
      [{ Ref: 'Q' }, change({ changeType: 'UPDATE', resourceType: 'Custom::Thing' })],
    ];
    for (const [value, upstream] of cases) {
      expect(await run(exported(value), new Map([['Q', upstream]]))).toEqual([
        { exportName: EXPORT, reason: 'changed' },
      ]);
    }
  });

  it('leaves an in-place update that cannot move the read attribute (a Lambda Arn on a code edit)', async () => {
    const lambdaEdit = change({
      changeType: 'UPDATE',
      resourceType: 'AWS::Lambda::Function',
      propertyChanges: [{ path: 'Code', oldValue: 'a', newValue: 'b', requiresReplacement: false }],
    });
    expect(await run(exported({ 'Fn::GetAtt': ['Q', 'Arn'] }), new Map([['Q', lambdaEdit]]))).toEqual([]);
  });
});
