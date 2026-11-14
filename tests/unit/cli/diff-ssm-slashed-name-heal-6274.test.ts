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

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
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
