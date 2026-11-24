/**
 * go-to-k/cdkd#6796: `cdkd diff` over a producer and its consumer previews the
 * consumer against the exports the producer's deploy publishes, as the deploy
 * (which reaches the consumer after the producer saved them) does.
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

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { CrossStackPreview } from '../../../src/analyzer/cross-stack-preview.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const producerState: StackState = {
  stackName: 'Producer',
  region: 'us-east-1',
  version: 16,
  lastModified: 0,
  outputs: { Res: 'arn:old', 'p-res': 'arn:old', Name: 'p-1', 'p-name': 'p-1' },
  exportNames: ['p-res', 'p-name'],
  resources: {
    Param: {
      resourceType: 'AWS::SSM::Parameter',
      physicalId: 'p-1',
      properties: { Name: 'p-1', Type: 'String', Value: 'v' },
    },
  },
};

const producerTemplate = (name: string, res: string): CloudFormationTemplate => ({
  Resources: {
    Param: { Type: 'AWS::SSM::Parameter', Properties: { Name: name, Type: 'String', Value: 'v' } },
  },
  Outputs: {
    Res: { Value: res, Export: { Name: 'p-res' } },
    Name: { Value: { Ref: 'Param' }, Export: { Name: 'p-name' } },
  },
});

const consumerState: StackState = {
  stackName: 'Consumer',
  region: 'us-east-1',
  version: 16,
  lastModified: 0,
  outputs: {},
  resources: {
    Grant: {
      resourceType: 'AWS::SSM::Parameter',
      physicalId: 'c-grant',
      properties: { Type: 'String', Value: 'arn:old' },
    },
    Named: {
      resourceType: 'AWS::SSM::Parameter',
      physicalId: '/c/p-1',
      properties: { Name: '/c/p-1', Type: 'String', Value: 'x' },
    },
  },
};

const consumerTemplate: CloudFormationTemplate = {
  Resources: {
    Grant: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Type: 'String', Value: { 'Fn::ImportValue': 'p-res' } },
    },
    Named: {
      Type: 'AWS::SSM::Parameter',
      Properties: {
        Name: { 'Fn::Join': ['', ['/c/', { 'Fn::ImportValue': 'p-name' }]] },
        Type: 'String',
        Value: 'x',
      },
    },
  },
};

/** Serves the stored producer and consumer records, as the state scan reads them. */
const backend = {
  listStacks: async () => [
    { stackName: 'Producer', region: 'us-east-1' },
    { stackName: 'Consumer', region: 'us-east-1' },
  ],
  getState: async (name: string) =>
    name === 'Producer'
      ? { state: producerState, etag: 'e' }
      : name === 'Consumer'
        ? { state: consumerState, etag: 'e' }
        : null,
} as unknown as S3StateBackend;

async function run(producer: CloudFormationTemplate, record: boolean) {
  const preview = new CrossStackPreview();
  await computeStackDiff(producerState, producer, 'us-east-1', 'Producer', backend, new DiffCalculator(), {
    crossStackPreview: preview,
    recordCrossStackPreview: record,
  });
  return computeStackDiff(consumerState, consumerTemplate, 'us-east-1', 'Consumer', backend, new DiffCalculator(), {
    crossStackPreview: preview,
  });
}

describe('cdkd diff previews a consumer against its producer in the same run (go-to-k/cdkd#6796)', () => {
  it("shows the consumer's update to a changed export and its replacement over a replaced producer resource", async () => {
    const result = await run(producerTemplate('p-2', 'arn:new'), true);
    const grant = result.changes.get('Grant');
    expect(grant?.changeType).toBe('UPDATE');
    expect(grant?.propertyChanges?.find((pc) => pc.path === 'Value')?.newValue).toBe('arn:new');
    const named = result.changes.get('Named');
    expect(named?.changeType).toBe('UPDATE');
    expect(named?.propertyChanges?.find((pc) => pc.path === 'Name')?.requiresReplacement).toBe(true);
  });

  it('CONTROL: an unchanged producer leaves the consumer unchanged', async () => {
    const result = await run(producerTemplate('p-1', 'arn:old'), true);
    expect(result.changes.get('Grant')?.changeType).toBe('NO_CHANGE');
    expect(result.changes.get('Named')?.changeType).toBe('NO_CHANGE');
  });

  it('CONTROL: a node that does not record (a nested child) leaves the consumer on state', async () => {
    const result = await run(producerTemplate('p-2', 'arn:new'), false);
    expect(result.changes.get('Grant')?.changeType).toBe('NO_CHANGE');
    expect(result.changes.get('Named')?.changeType).toBe('NO_CHANGE');
  });
});
