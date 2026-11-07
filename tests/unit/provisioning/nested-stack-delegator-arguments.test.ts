/**
 * The `NestedStackProvider` method bodies live in
 * `src/provisioning/providers/nested-stack/*.ts`; the class keeps one
 * `return f.call(this, ...)` delegator per moved method, and each argument a
 * delegator hands on is a hand-off the split introduced.
 *
 * Every companion function is a pass-through spy on the real one. The first
 * block stubs each spy once and pins, for EVERY delegator, that it calls its
 * own function with the provider as `this`, every argument in declared order,
 * and returns that function's result. The second block runs real bodies end to
 * end through the delegators: this provider sends no SDK command, so it pins
 * the child engine it constructs (by class) and the state reads it makes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const engine = vi.hoisted(() => ({
  ctor: [] as unknown[][],
  deploy: [] as Array<[string, unknown]>,
  deployedBy: [] as unknown[],
}));

vi.mock('../../../src/deployment/deploy-engine.js', () => {
  class DeployEngine {
    constructor(...args: unknown[]) {
      engine.ctor.push(args);
    }
    async deploy(stackName: string, template: unknown) {
      engine.deploy.push([stackName, template]);
      engine.deployedBy.push(this);
      return { deleteSkipped: 0, updatePartial: 0 };
    }
  }
  return { DeployEngine };
});

/** Replace every function a module exports with a pass-through spy. */
async function spied(path: string): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<Record<string, unknown>>(path);
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(v as (...a: unknown[]) => unknown) : v,
    ])
  );
}

vi.mock('../../../src/provisioning/providers/nested-stack/shared.js', () =>
  spied('../../../src/provisioning/providers/nested-stack/shared.js')
);
vi.mock('../../../src/provisioning/providers/nested-stack/create-update.js', () =>
  spied('../../../src/provisioning/providers/nested-stack/create-update.js')
);
vi.mock('../../../src/provisioning/providers/nested-stack/delete.js', () =>
  spied('../../../src/provisioning/providers/nested-stack/delete.js')
);
vi.mock('../../../src/provisioning/providers/nested-stack/child-deploy.js', () =>
  spied('../../../src/provisioning/providers/nested-stack/child-deploy.js')
);
vi.mock('../../../src/provisioning/providers/nested-stack/outputs.js', () =>
  spied('../../../src/provisioning/providers/nested-stack/outputs.js')
);
vi.mock('../../../src/provisioning/providers/nested-stack/template.js', () =>
  spied('../../../src/provisioning/providers/nested-stack/template.js')
);

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import * as shared from '../../../src/provisioning/providers/nested-stack/shared.js';
import * as createUpdate from '../../../src/provisioning/providers/nested-stack/create-update.js';
import * as del from '../../../src/provisioning/providers/nested-stack/delete.js';
import * as childDeploy from '../../../src/provisioning/providers/nested-stack/child-deploy.js';
import * as outputs from '../../../src/provisioning/providers/nested-stack/outputs.js';
import * as template from '../../../src/provisioning/providers/nested-stack/template.js';

const MODULES: Record<string, Record<string, unknown>> = {
  shared,
  'create-update': createUpdate,
  delete: del,
  'child-deploy': childDeploy,
  outputs,
  template,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['create', 'create-update', 'create', 4],
  ['update', 'create-update', 'update', 6],
  ['revertFromChildJournal', 'create-update', 'revertFromChildJournal', 3],
  ['delete', 'delete', 'deleteImpl', 5],
  ['getAttribute', 'outputs', 'getAttribute', 3],
  ['runChildDeploy', 'child-deploy', 'runChildDeploy', 7],
  ['readChildOutputsAsAttributes', 'outputs', 'readChildOutputsAsAttributes', 3],
  ['requireContext', 'shared', 'requireContext', 0],
  ['requireDeployContext', 'shared', 'requireDeployContext', 2],
  ['refuseMalformedNestedTemplateTree', 'template', 'refuseMalformedNestedTemplateTree', 3],
  ['deriveChildStackName', 'shared', 'deriveChildStackName', 2],
  ['synthesizeArn', 'shared', 'synthesizeArn', 4],
  ['extractParameters', 'template', 'extractParameters', 1],
  ['refuseNonScalarParameter', 'template', 'refuseNonScalarParameter', 3],
  ['readChildTemplate', 'template', 'readChildTemplate', 2],
  ['indexGrandchildTemplates', 'template', 'indexGrandchildTemplates', 2],
  ['outputAttributeName', 'outputs', 'outputAttributeName', 1],
  ['buildOutputsAttributes', 'outputs', 'buildOutputsAttributes', 1],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set(['constructor']);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

describe('NestedStackProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(NestedStackProvider.prototype).filter(
      (m) => !KEPT_ON_CLASS.has(m)
    );
    expect(methods.sort()).toEqual(DELEGATORS.map(([m]) => m).sort());
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} calls ${mod}.${fn} with this, ${arity} argument(s) in order, and returns its result`, () => {
      const spy = MODULES[mod]![fn] as Spy;
      expect(vi.isMockFunction(spy), `${mod}.${fn} is not spied`).toBe(true);
      const result = { result: method };
      spy.mockImplementationOnce(() => result);
      const provider = new NestedStackProvider();
      const args = Array.from({ length: arity }, (_, i) => ({ arg: i }));
      const returned = (provider as unknown as Record<string, Callable>)[method]!(...args);
      expect(returned).toBe(result);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(args);
      spy.mock.calls[0]!.forEach((a, i) => expect(a).toBe(args[i]));
      expect(spy.mock.contexts[0]).toBe(provider);
    });
  }
});

describe('NestedStackProvider moved bodies run end to end through the delegators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engine.ctor.length = 0;
    engine.deploy.length = 0;
    engine.deployedBy.length = 0;
  });

  function context(over: Partial<NestedStackProviderContext>): NestedStackProviderContext {
    return {
      parentStackName: 'Parent',
      parentRegion: 'us-east-1',
      accountId: '123456789012',
      ...over,
    } as unknown as NestedStackProviderContext;
  }

  it('create builds a child DeployEngine, deploys the child under the derived name, and reads its outputs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-nested-delegator-'));
    try {
      const childPath = join(dir, 'child.template.json');
      writeFileSync(childPath, JSON.stringify({ Resources: { Q: { Type: 'AWS::SQS::Queue' } } }));
      const getState = vi.fn(async () => ({
        state: { resources: {}, outputs: { QueueArn: 'arn:aws:sqs:us-east-1:1:q' } },
      }));
      const ctx = context({
        nestedTemplates: { Child: childPath },
        dagBuilder: {},
        diffCalculator: {},
        stateBackend: { getState },
      } as unknown as Partial<NestedStackProviderContext>);
      const result = await withNestedStackContext(ctx, () =>
        new NestedStackProvider().create('Child', 'AWS::CloudFormation::Stack', {
          Parameters: { Size: 3, Names: ['a', 'b'] },
        })
      );
      expect(engine.ctor).toHaveLength(1);
      expect(engine.deployedBy[0]).toBeInstanceOf(DeployEngine);
      const options = engine.ctor[0]![5] as { parameters: Record<string, string> };
      expect(options.parameters).toEqual({ Size: '3', Names: 'a,b' });
      expect(engine.ctor[0]![6]).toBe('us-east-1');
      expect(engine.deploy.map(([name]) => name)).toEqual(['Parent~Child']);
      expect(getState).toHaveBeenCalledWith('Parent~Child', 'us-east-1');
      expect(result.physicalId).toBe(
        'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child'
      );
      expect(result.attributes).toEqual({ 'Outputs.QueueArn': 'arn:aws:sqs:us-east-1:1:q' });
      expect(vi.mocked(childDeploy.runChildDeploy)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(template.extractParameters)).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delete reads the child state by the derived name and region, and is idempotent when absent', async () => {
    const getState = vi.fn(async () => null);
    const ctx = context({ stateBackend: { getState } } as unknown as Partial<NestedStackProviderContext>);
    const result = await withNestedStackContext(ctx, () =>
      new NestedStackProvider().delete('Child', 'ignored', 'AWS::CloudFormation::Stack')
    );
    expect(result).toBeUndefined();
    expect(getState).toHaveBeenCalledWith('Parent~Child', 'us-east-1');
    expect(vi.mocked(shared.deriveChildStackName)).toHaveBeenCalledWith('Parent', 'Child');
  });

  it('extractParameters refuses a non-scalar array element through refuseNonScalarParameter', () => {
    expect(() =>
      new NestedStackProvider().extractParameters({ Parameters: { P: ['a', { Ref: 'X' }] } })
    ).toThrow(/child Parameter .*P.* element \[1\] resolved to a non-scalar value/);
    expect(vi.mocked(template.refuseNonScalarParameter)).toHaveBeenCalledTimes(1);
  });

  it('update with a replayed state and no rollback run refuses through revertFromChildJournal', async () => {
    const ctx = context({});
    await expect(
      withNestedStackContext(ctx, () =>
        new NestedStackProvider().update(
          'Child',
          'arn',
          'AWS::CloudFormation::Stack',
          {},
          {},
          { replayingState: true }
        )
      )
    ).rejects.toThrow(/Cannot revert nested stack/);
    expect(vi.mocked(createUpdate.revertFromChildJournal)).toHaveBeenCalledTimes(1);
  });
});
