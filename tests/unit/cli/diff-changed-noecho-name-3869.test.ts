import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3869 item 3 in `cdkd diff`: a pre-v11 record holds a name
// minted from a `NoEcho` value since CHANGED (RDS folds it to lower case), so
// no value the diff binds spells it. The record's own leaf at the `NoEcho`
// position is what judges it, for the resolver's reads and the stored side.
const debugLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', async () => {
  const { currentLogLineMasker: sink } = await import('../../../src/utils/log-line-masker.js');
  const fns = {
    setLevel: vi.fn(),
    debug: (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      debugLines.push(sink()?.(line) ?? line);
    },
    info: vi.fn(),
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
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiffTree, computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const OLD_DB = 'TeamOldDb1';
const OLD_ID = OLD_DB.toLowerCase();

function template(noEcho: boolean, readerValue: unknown): CloudFormationTemplate {
  return {
    Parameters: { DbName: { Type: 'String', Default: 'TeamNewDb2', ...(noEcho && { NoEcho: true }) } },
    Resources: {
      Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: { Ref: 'DbName' } } },
      Reader: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: readerValue } },
    },
  } as CloudFormationTemplate;
}

function state(): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    version: 10,
    resources: {
      Db: {
        physicalId: OLD_ID,
        resourceType: 'AWS::RDS::DBInstance',
        properties: { DBInstanceIdentifier: OLD_DB },
        attributes: {},
        dependencies: [],
      },
      Reader: {
        physicalId: 'reader',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Type: 'String', Value: OLD_ID },
        attributes: {},
        dependencies: ['Db'],
      },
    },
    outputs: {},
    exportNames: [],
    lastModified: 0,
  };
}

const backend = { getState: async () => null } as unknown as S3StateBackend;

beforeEach(() => {
  debugLines.length = 0;
});

describe('cdkd diff judges a name taken from a NoEcho value since changed (go-to-k/cdkd#3869)', () => {
  it.each([
    ['the parameter is NoEcho', true, false],
    ['negative control, an ordinary parameter', false, true],
  ])("masks a reader's Ref on the resolver's line: %s", async (_l, noEcho, shown) => {
    await computeStackDiff(
      state(),
      template(noEcho, { Ref: 'Db' }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    const lines = debugLines.join('\n');
    expect(lines).toContain('Ref to resource: Db resolved to');
    expect(lines.includes(OLD_ID)).toBe(shown);
  });

  it.each([
    ['the parameter is NoEcho', true, false],
    ['negative control, an ordinary parameter', false, true],
  ])("masks a reader's stored copy on its rendered old side: %s", async (_l, noEcho, shown) => {
    const result = await computeStackDiff(
      state(),
      template(noEcho, 'a-new-literal-value'),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    const row = JSON.stringify(result.changes.get('Reader')?.propertyChanges);
    expect(row).toContain('a-new-literal-value');
    expect(row.includes(OLD_ID)).toBe(shown);
  });
});

describe('cdkd diff judges an ADOPTED record named from a NoEcho value since changed (go-to-k/cdkd#3869)', () => {
  it.each([
    ['the parameter is NoEcho', true, false],
    ['negative control, an ordinary parameter', false, true],
  ])("masks a reader's stored copy of its name: %s", async (_l, noEcho, shown) => {
    // The DB exists only as a kept orphan the diff adopts back, so only the
    // judge over the spliced records sees it.
    const s = state();
    const db = s.resources['Db'] as ResourceState;
    delete s.resources['Db'];
    s.orphans = [{ logicalId: 'Db', orphanedAt: 0, state: db }] as never;
    const result = await computeStackDiff(
      s,
      template(noEcho, 'a-new-literal-value'),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { previewOrphanAdoption: async () => ({ adopted: { Db: db }, refusals: [] }) }
    );
    const row = JSON.stringify(result.changes.get('Reader')?.propertyChanges);
    expect(row).toContain('a-new-literal-value');
    expect(row.includes(OLD_ID)).toBe(shown);
  });
});

describe("cdkd diff masks a name a nested row USED to pass, judged with the parent's stored NoEcho values (go-to-k/cdkd#3869)", () => {
  it.each([
    ['the parameter is NoEcho', true, false],
    ['negative control, an ordinary parameter', false, true],
  ])("in the child's rendered row: %s", async (_l, noEcho, shown) => {
    // The row passed the old DB name down once; it now passes a literal, so
    // no read of this diff names it, while the child's record still holds it.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3869-noecho-child-'));
    try {
      const childPath = join(dir, 'child.json');
      writeFileSync(
        childPath,
        JSON.stringify({
          Parameters: { In: { Type: 'String' } },
          Resources: {
            Consumer: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: { Ref: 'In' } } },
          },
        })
      );
      const tpl = template(noEcho, 'a-new-literal-value');
      tpl.Resources['Child'] = {
        Type: 'AWS::CloudFormation::Stack',
        Metadata: { 'aws:asset:path': 'child.json' },
        Properties: { Parameters: { In: 'plain-literal-input' } },
      };
      const parent = state();
      parent.resources['Child'] = {
        physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/S-Child/1',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: { Parameters: { In: OLD_ID } },
        attributes: {},
        dependencies: [],
      };
      const child: StackState = {
        stackName: 'S~Child',
        region: 'us-east-1',
        version: 10,
        resources: {
          Consumer: {
            physicalId: 'consumer-param',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Type: 'String', Value: OLD_ID },
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        lastModified: 0,
      };
      const states: Record<string, StackState> = { S: parent, 'S~Child': child };
      const tree = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: tpl,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: {
          getState: async (name: string) => (states[name] ? { state: states[name], etag: 'e' } : null),
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      const childNode = tree.children.find((c) => c.stackName === 'S~Child');
      const row = JSON.stringify(childNode?.changes.get('Consumer')?.propertyChanges);
      // Premise: the child's row renders the value it now receives.
      expect(row).toContain('plain-literal-input');
      expect(row.includes(OLD_ID)).toBe(shown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
