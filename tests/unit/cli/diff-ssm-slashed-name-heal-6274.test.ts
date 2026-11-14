/**
 * go-to-k/cdkd#6274: `cdkd diff` re-spells a pre-#6272 generated SSM parameter
 * name `/<name>` as `<name>` exactly as the deploy does, so it previews the
 * update of each dependent holding the old Ref and names the heal.
 */

import { describe, expect, it, vi } from 'vite-plus/test';

const infos = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: (m: unknown): void => void infos.push(String(m)),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
      destroy: vi.fn(),
    })),
  };
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiffTree, computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import type { ResourceState } from '../../../src/types/state.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const backend = {
  getState: async () => null,
  saveState: vi.fn(),
  putState: vi.fn(),
  deleteState: vi.fn(),
} as unknown as S3StateBackend;

function stateWith(paramId: string): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    version: 16,
    lastModified: 0,
    outputs: {},
    resources: {
      Param: {
        resourceType: 'AWS::SSM::Parameter',
        physicalId: paramId,
        properties: { Type: 'String', Value: 'v' },
      },
      Reader: {
        resourceType: 'AWS::SSM::Parameter',
        physicalId: 'S-Reader',
        properties: { Type: 'String', Value: '/S-Param' },
        dependencies: ['Param'],
      },
    },
  };
}

const template: CloudFormationTemplate = {
  Resources: {
    Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'v' } },
    Reader: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: { Ref: 'Param' } } },
  },
};

async function diff(state: StackState) {
  infos.length = 0;
  return computeStackDiff(state, template, 'us-east-1', 'S', backend, new DiffCalculator());
}

describe('cdkd diff previews the SSM name heal (go-to-k/cdkd#6274)', () => {
  it('shows the dependent holding /<name> updating to <name>, and names the heal', async () => {
    const state = stateWith('/S-Param');
    const result = await diff(state);
    const reader = result.changes.get('Reader');
    expect(reader?.changeType).toBe('UPDATE');
    expect(reader?.propertyChanges?.find((pc) => pc.path === 'Value')?.newValue).toBe('S-Param');
    expect(infos.some((m) => m.includes('go-to-k/cdkd#6274') && m.includes('Param'))).toBe(true);
    // A preview never writes, and leaves the loaded record alone.
    expect(state.resources['Param']!.physicalId).toBe('/S-Param');
  });

  it('CONTROL: an already slash-less record previews no heal', async () => {
    const result = await diff(stateWith('S-Param'));
    expect(result.changes.get('Reader')?.changeType).toBe('UPDATE');
    expect(result.changes.get('Reader')?.propertyChanges?.find((pc) => pc.path === 'Value')?.newValue).toBe(
      'S-Param'
    );
    expect(infos.some((m) => m.includes('go-to-k/cdkd#6274'))).toBe(false);
  });
});

describe('cdkd diff heals only where the deploy runs an engine (go-to-k/cdkd#6274)', () => {
  it("names, but does not heal, a record of a nested child whose row the deploy leaves alone", async () => {
    infos.length = 0;
    const result = await computeStackDiff(
      stateWith('/S-Param'),
      template,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { ssmNameHeal: 'pending' }
    );
    expect(result.changes.get('Reader')?.changeType).toBe('NO_CHANGE');
    expect(infos.some((m) => m.includes('on the next deploy that updates this nested stack'))).toBe(
      true
    );
  });

  it('names the heal of a record the orphan pre-pass adopts, as the deploy does', async () => {
    infos.length = 0;
    const s = stateWith('/S-Param');
    const param = s.resources['Param'] as ResourceState;
    delete s.resources['Param'];
    s.orphans = [{ logicalId: 'Param', orphanedAt: 0, state: param }] as never;
    const result = await computeStackDiff(s, template, 'us-east-1', 'S', backend, new DiffCalculator(), {
      previewOrphanAdoption: async () => ({ adopted: { Param: param }, refusals: [] }),
    });
    expect(result.changes.has('Param')).toBe(true);
    expect(infos.filter((m) => m.includes('go-to-k/cdkd#6274'))).toHaveLength(1);
  });

  it.each([
    ['an unchanged row: named, not healed', 'same-input', 'NO_CHANGE', 'NO_CHANGE', false],
    ['a changed row: healed', 'new-input', 'UPDATE', 'UPDATE', false],
    // An UPDATE moving only the policy calls no provider, so no child engine.
    ['a row moving only DeletionPolicy: named, not healed', 'same-input', 'NO_CHANGE', 'UPDATE', true],
  ] as const)('a nested child under %s', async (_label, input, readerChange, rowChange, retain) => {
    infos.length = 0;
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-6274-child-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({
          Parameters: { In: { Type: 'String' } },
          Resources: {
            Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: { Ref: 'In' } } },
            Reader: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: { Ref: 'Param' } } },
          },
        })
      );
      const parentTemplate: CloudFormationTemplate = {
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { In: input } },
            ...(retain && { DeletionPolicy: 'Retain' }),
          },
        },
      } as CloudFormationTemplate;
      const parent: StackState = {
        stackName: 'S',
        region: 'us-east-1',
        version: 16,
        lastModified: 0,
        outputs: {},
        resources: {
          Child: {
            physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/S-Child/1',
            resourceType: 'AWS::CloudFormation::Stack',
            properties: { Parameters: { In: 'same-input' } },
            attributes: {},
            dependencies: [],
          },
        },
      };
      // The legacy generated name of the child's Param: `S~Child` sanitized.
      const old = '/S-Child-Param';
      const child: StackState = {
        stackName: 'S~Child',
        region: 'us-east-1',
        version: 16,
        lastModified: 0,
        outputs: {},
        resources: {
          Param: {
            physicalId: old,
            resourceType: 'AWS::SSM::Parameter',
            properties: { Type: 'String', Value: 'same-input' },
          },
          Reader: {
            physicalId: 'S-Child-Reader',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Type: 'String', Value: old },
            dependencies: ['Param'],
          },
        },
      };
      const states: Record<string, StackState> = { S: parent, 'S~Child': child };
      const tree = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: {
          getState: async (name: string) => (states[name] ? { state: states[name], etag: 'e' } : null),
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      // Premise: the parent's row is diffed as the case says.
      expect(tree.changes.get('Child')?.changeType).toBe(rowChange);
      const childNode = tree.children.find((c) => c.stackName === 'S~Child');
      expect(childNode?.changes.get('Reader')?.changeType).toBe(readerChange);
      expect(infos.some((m) => m.includes('go-to-k/cdkd#6274'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a grandchild under a child no engine runs for is only named, whatever its own row', async () => {
    infos.length = 0;
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-6274-grandchild-'));
    try {
      const ssmPair = {
        Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'v' } },
        Reader: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: { Ref: 'Param' } } },
      };
      writeFileSync(join(dir, 'grand.json'), JSON.stringify({ Resources: ssmPair }));
      // The child passes its grandchild a NEW input: an UPDATE in its preview.
      writeFileSync(
        join(dir, 'child.json'),
        JSON.stringify({
          Resources: {
            Grand: {
              Type: 'AWS::CloudFormation::Stack',
              Metadata: { 'aws:asset:path': 'grand.json' },
              Properties: { Parameters: { In: 'new-input' } },
            },
          },
        })
      );
      const parentTemplate = {
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: {},
          },
        },
      } as unknown as CloudFormationTemplate;
      const stackRow = (inputs: Record<string, string> | undefined): ResourceState => ({
        physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/x/1',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: inputs === undefined ? {} : { Parameters: inputs },
        attributes: {},
        dependencies: [],
      });
      const record = (resources: Record<string, ResourceState>, stackName: string): StackState => ({
        stackName,
        region: 'us-east-1',
        version: 16,
        lastModified: 0,
        outputs: {},
        resources,
      });
      const old = '/S-Child-Grand-Param';
      const states: Record<string, StackState> = {
        S: record({ Child: stackRow(undefined) }, 'S'),
        'S~Child': record({ Grand: stackRow({ In: 'old-input' }) }, 'S~Child'),
        'S~Child~Grand': record(
          {
            Param: { physicalId: old, resourceType: 'AWS::SSM::Parameter', properties: { Type: 'String', Value: 'v' } },
            Reader: {
              physicalId: 'r',
              resourceType: 'AWS::SSM::Parameter',
              properties: { Type: 'String', Value: old },
              dependencies: ['Param'],
            },
          },
          'S~Child~Grand'
        ),
      };
      const tree = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: { Child: join(dir, 'child.json') },
        recursive: true,
        stateBackend: {
          getState: async (name: string) => (states[name] ? { state: states[name], etag: 'e' } : null),
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      expect(tree.changes.get('Child')?.changeType).toBe('NO_CHANGE');
      const child = tree.children.find((c) => c.stackName === 'S~Child');
      // Premise: the child's preview diffs its grandchild row as an UPDATE.
      expect(child?.changes.get('Grand')?.changeType).toBe('UPDATE');
      const grand = child?.children.find((c) => c.stackName === 'S~Child~Grand');
      expect(grand?.changes.get('Reader')?.changeType).toBe('NO_CHANGE');
      expect(infos.some((m) => m.includes('on the next deploy that updates this nested stack'))).toBe(
        true
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
