/**
 * go-to-k/cdkd#7057: `cdkd diff` runs the deploy's zone heal, so a DBInstance
 * record written before #5640 without the zone the template declares previews
 * what the deploy does: no change when the instance runs in that zone, the
 * replacement when it runs in another. Nothing is read for any other record.
 */
import { describe, expect, it, vi } from 'vite-plus/test';

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

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(() => ({
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
    STSClient: vi.fn(() => ({
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
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const BASE = { Engine: 'mysql', DBInstanceClass: 'db.t4g.micro' };

const backend = {
  getState: async () => null,
  saveState: vi.fn(),
  putState: vi.fn(),
  deleteState: vi.fn(),
} as unknown as S3StateBackend;

function stateWith(properties: Record<string, unknown>): StackState {
  return {
    stackName: 'S',
    region: 'eu-west-1',
    version: 16,
    lastModified: 0,
    outputs: {},
    resources: {
      Db: { resourceType: 'AWS::RDS::DBInstance', physicalId: 'db-legacy', properties },
    },
  };
}

const template: CloudFormationTemplate = {
  Resources: {
    Db: { Type: 'AWS::RDS::DBInstance', Properties: { ...BASE, AvailabilityZone: 'eu-west-1a' } },
  },
};

async function diff(state: StackState, zone: string | undefined | Error) {
  const reader = vi.fn(async (_id: string) => {
    if (zone instanceof Error) throw zone;
    return zone;
  });
  const result = await computeStackDiff(state, template, 'eu-west-1', 'S', backend, new DiffCalculator(), {
    readLiveDbInstanceZone: reader,
  });
  return { row: result.changes.get('Db'), reader };
}

describe('cdkd diff previews the zone heal (go-to-k/cdkd#7057)', () => {
  it('the instance runs in the declared zone: no change, one read by the recorded identifier', async () => {
    const state = stateWith(BASE);
    const { row, reader } = await diff(state, 'eu-west-1a');
    expect(row?.changeType).toBe('NO_CHANGE');
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith('db-legacy');
    // A preview writes nothing back to the record it loaded.
    expect(state.resources['Db']!.properties['AvailabilityZone']).toBeUndefined();
  });

  for (const [name, zone] of [
    ['runs in another zone', 'eu-west-1b'],
    ['reports no zone', undefined],
    ['cannot be read', Object.assign(new Error('denied'), { name: 'AccessDenied' })],
  ] as const) {
    it(`the instance ${name}: the zone added, a replacement`, async () => {
      const { row } = await diff(stateWith(BASE), zone);
      expect(row?.changeType).toBe('UPDATE');
      const pc = row?.propertyChanges?.find((p) => p.path === 'AvailabilityZone');
      expect(pc?.requiresReplacement).toBe(true);
    });
  }

  it('a record holding the zone reads nothing (#6438)', async () => {
    const { row, reader } = await diff(stateWith({ ...BASE, AvailabilityZone: 'eu-west-1a' }), 'x');
    expect(row?.changeType).toBe('NO_CHANGE');
    expect(reader).not.toHaveBeenCalled();
  });

  it('no reader: nothing is read, and the zone reads as added', async () => {
    const result = await computeStackDiff(
      stateWith(BASE),
      template,
      'eu-west-1',
      'S',
      backend,
      new DiffCalculator()
    );
    const pc = result.changes.get('Db')?.propertyChanges?.find((p) => p.path === 'AvailabilityZone');
    expect(pc?.requiresReplacement).toBe(true);
  });

  it('buildDiffTree hands each node the reader for its own region', async () => {
    const regions: string[] = [];
    const tree = await buildDiffTree({
      stackName: 'S',
      displayName: 'S',
      region: 'eu-west-1',
      template,
      nestedTemplates: {},
      recursive: false,
      stateBackend: {
        getState: async () => ({ state: stateWith(BASE), etag: 'e' }),
      } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
      liveDbInstanceZoneReaderFor: (region) => {
        regions.push(region);
        return async () => 'eu-west-1a';
      },
    });
    expect(regions).toEqual(['eu-west-1']);
    expect(tree.changes.get('Db')?.changeType).toBe('NO_CHANGE');
  });

  it('a nested child node gets the reader too, and previews the same verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-7057-'));
    try {
      writeFileSync(join(dir, 'child.json'), JSON.stringify(template));
      const parentTemplate = {
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: {},
          },
        },
      } as unknown as CloudFormationTemplate;
      const childRow: ResourceState = {
        physicalId: 'arn:aws:cloudformation:eu-west-1:123456789012:stack/x/1',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes: {},
        dependencies: [],
      };
      const states: Record<string, StackState> = {
        S: { ...stateWith(BASE), resources: { Child: childRow } },
        'S~Child': { ...stateWith(BASE), stackName: 'S~Child' },
      };
      const regions: string[] = [];
      const reads: string[] = [];
      const tree = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'eu-west-1',
        template: parentTemplate,
        nestedTemplates: { Child: join(dir, 'child.json') },
        recursive: true,
        stateBackend: {
          getState: async (name: string) => (states[name] ? { state: states[name], etag: 'e' } : null),
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
        liveDbInstanceZoneReaderFor: (region) => {
          regions.push(region);
          return async (id) => {
            reads.push(id);
            return 'eu-west-1a';
          };
        },
      });
      const child = tree.children.find((c) => c.stackName === 'S~Child');
      expect(child).toBeDefined();
      expect(regions).toEqual(['eu-west-1', 'eu-west-1']);
      expect(reads).toEqual(['db-legacy']);
      expect(child?.changes.get('Db')?.changeType).toBe('NO_CHANGE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
