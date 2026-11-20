import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6704: two WaitCondition follow-ups that live in the analyzer.
 *
 * 1. The DAG orders a WaitCondition after every resource that references its
 *    handle (the signaller), so a small `--concurrency` cannot run the wait
 *    first and starve the signaller.
 * 2. The diff re-issues a referenced handle recorded before #6694 with a
 *    placeholder id: the handle row becomes an UPDATE its provider carries out
 *    by issuing a URL, and the readers of its `Ref` are promoted.
 *
 * The create-only lookup is mocked to FAIL, as in `diff-calculator.test.ts`.
 */
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: () =>
        Promise.reject(
          Object.assign(new Error('not authorized'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        ),
    },
  }),
}));

import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { LEGACY_HANDLE_HEAL_REASON } from '../../../src/analyzer/diff-calculator/legacy-handle-heal.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const userData = (handle: string) => ({
  'Fn::Base64': {
    'Fn::Join': ['', ['#!/bin/bash\ncurl -X PUT "', { Ref: handle }, '"\n']],
  },
});

function template(extra: Partial<CloudFormationTemplate['Resources']> = {}): CloudFormationTemplate {
  return {
    Resources: {
      Handle: { Type: 'AWS::CloudFormation::WaitConditionHandle' },
      Instance: {
        Type: 'AWS::EC2::Instance',
        Properties: { ImageId: 'ami-1', UserData: userData('Handle') },
      },
      Wait: {
        Type: 'AWS::CloudFormation::WaitCondition',
        Properties: { Handle: { Ref: 'Handle' }, Timeout: '600' },
      },
      ...extra,
    } as CloudFormationTemplate['Resources'],
  };
}

describe('DAG: a WaitCondition runs after its signallers (#6704)', () => {
  it('adds an edge from the resource that references the handle', () => {
    const builder = new DagBuilder();
    const graph = builder.buildGraph(template());
    expect(builder.getDirectDependencies(graph, 'Wait').sort()).toEqual(['Handle', 'Instance']);
  });

  it('reaches a reference inside Fn::Sub too', () => {
    const t = template();
    (t.Resources['Instance']!.Properties as Record<string, unknown>)['UserData'] = {
      'Fn::Base64': { 'Fn::Sub': 'curl -X PUT "${Handle}"' },
    };
    const builder = new DagBuilder();
    expect(builder.getDirectDependencies(builder.buildGraph(t), 'Wait').sort()).toEqual([
      'Handle',
      'Instance',
    ]);
  });

  it('skips the edge that would close a cycle, without failing the build', () => {
    const t = template();
    t.Resources['Instance']!.DependsOn = 'Wait';
    const builder = new DagBuilder();
    const graph = builder.buildGraph(t);
    expect(builder.getDirectDependencies(graph, 'Wait')).toEqual(['Handle']);
    expect(builder.getDirectDependencies(graph, 'Instance').sort()).toEqual(['Handle', 'Wait']);
  });

  it('adds nothing for a resource not referencing the handle, or with no WaitCondition', () => {
    const t = template({
      Other: { Type: 'AWS::SNS::Topic', Properties: {} },
    });
    const builder = new DagBuilder();
    expect(builder.getDirectDependencies(builder.buildGraph(t), 'Wait')).not.toContain('Other');

    const noWait = template();
    delete noWait.Resources['Wait'];
    const graph = builder.buildGraph(noWait);
    expect(builder.getDirectDependents(graph, 'Instance')).toEqual([]);
  });
});

const LEGACY_ID = 'cdkd-wait-condition-handle-Handle-0f8fad5b-d9cb-469f-a165-70867728950e';
const URL_ID =
  'https://b.s3.amazonaws.com/wait-condition-signals/Handle-0f8fad5b-d9cb-469f-a165-70867728950e.json?X-Amz-Signature=s';

function state(handleId: string): StackState {
  return {
    version: 1,
    stackName: 'S',
    outputs: {},
    lastModified: 0,
    resources: {
      Handle: {
        physicalId: handleId,
        resourceType: 'AWS::CloudFormation::WaitConditionHandle',
        properties: {},
        attributes: {},
      },
      Instance: {
        physicalId: 'i-1',
        resourceType: 'AWS::EC2::Instance',
        properties: { ImageId: 'ami-1', UserData: handleId },
        attributes: {},
      },
    },
  };
}

/** Resolves `Ref` to the RECORDED physical id, as the deploy's diff context does. */
const resolverFor =
  (s: StackState) =>
  async (value: unknown): Promise<unknown> => {
    const walk = (v: unknown): unknown => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(walk);
      const o = v as Record<string, unknown>;
      if ('Ref' in o) return s.resources[o['Ref'] as string]?.physicalId;
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    };
    return walk(value);
  };

/** The instance's user data is the handle's `Ref` itself, so the record compares exactly. */
function templateWithoutWait(): CloudFormationTemplate {
  const t = template();
  delete t.Resources['Wait'];
  (t.Resources['Instance']!.Properties as Record<string, unknown>)['UserData'] = { Ref: 'Handle' };
  return t;
}

describe('diff: a referenced legacy handle is re-issued (#6704)', () => {
  it('turns the handle into a provider re-create and promotes its reader', async () => {
    const s = state(LEGACY_ID);
    const changes = await new DiffCalculator().calculateDiff(s, templateWithoutWait(), resolverFor(s));
    const handle = changes.get('Handle')!;
    expect(handle.changeType).toBe('UPDATE');
    expect(handle.providerReplacement).toBe(LEGACY_HANDLE_HEAL_REASON);
    expect(handle.propertyChanges).toEqual([]);
    expect(changes.get('Instance')!.changeType).toBe('UPDATE');
  });

  it('leaves a handle that already holds a URL alone', async () => {
    const s = state(URL_ID);
    const changes = await new DiffCalculator().calculateDiff(s, templateWithoutWait(), resolverFor(s));
    expect(changes.get('Handle')!.changeType).toBe('NO_CHANGE');
    expect(changes.get('Instance')!.changeType).toBe('NO_CHANGE');
  });

  it('re-issues a handle only an output exposes', async () => {
    const s = state(LEGACY_ID);
    delete s.resources['Instance'];
    const t: CloudFormationTemplate = {
      Resources: { Handle: { Type: 'AWS::CloudFormation::WaitConditionHandle' } },
      Outputs: { HandleUrl: { Value: { Ref: 'Handle' } } },
    };
    const changes = await new DiffCalculator().calculateDiff(s, t, resolverFor(s));
    expect(changes.get('Handle')!.providerReplacement).toBe(LEGACY_HANDLE_HEAL_REASON);
  });

  it('leaves an unreferenced legacy handle (a placeholder resource) alone', async () => {
    const s = state(LEGACY_ID);
    delete s.resources['Instance'];
    const t: CloudFormationTemplate = {
      Resources: { Handle: { Type: 'AWS::CloudFormation::WaitConditionHandle' } },
    };
    const changes = await new DiffCalculator().calculateDiff(s, t, resolverFor(s));
    expect(changes.get('Handle')!.changeType).toBe('NO_CHANGE');
    expect(changes.get('Handle')!.providerReplacement).toBeUndefined();
  });
});
