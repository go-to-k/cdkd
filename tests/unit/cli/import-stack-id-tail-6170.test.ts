/**
 * go-to-k/cdkd#6170: `cdkd import` resolves `AWS::StackId` with the tail the
 * stack's deploys resolve it with, read from the record being built -- the UUID
 * derived from its instance id when the record is marked, else `cdkd` -- so the
 * imported record holds the value the next deploy compares. Run through the REAL
 * `resolveImportedProperties` and resolver.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { STATE_SCHEMA_VERSION_CURRENT, type StackState } from '../../../src/types/state.js';
import { stackIdTailFromInstanceId } from '../../../src/state/stack-id-tail.js';

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

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: async () => ({ Account: '123456789012' }) } }),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const { resolveImportedProperties } = await import('../../../src/cli/commands/import.js');
const { getLogger } = await import('../../../src/utils/logger.js');
const { resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const INSTANCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TAIL_PROP = { 'Fn::Select': [2, { 'Fn::Split': ['/', { Ref: 'AWS::StackId' }] }] };

async function importedTail(marker: Partial<StackState>): Promise<unknown> {
  resetAccountInfoCache();
  const template = {
    Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: { Tail: TAIL_PROP } } },
  } as unknown as CloudFormationTemplate;
  const state: StackState = {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'imp-stack',
    region: 'us-east-1',
    resources: {
      Res: {
        physicalId: 'res-phys',
        resourceType: 'AWS::SQS::Queue',
        properties: { Tail: structuredClone(TAIL_PROP) },
      },
    },
    outputs: {},
    lastModified: 0,
    ...marker,
  };
  await resolveImportedProperties(state, template, 'us-east-1', undefined as never, getLogger());
  return (state.resources['Res']!.properties as Record<string, unknown>)['Tail'];
}

describe('cdkd import resolves AWS::StackId with the record\'s tail (go-to-k/cdkd#6170)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a marked record records the derived UUID', async () => {
    const tail = await importedTail({ stackInstanceId: INSTANCE_ID, stackIdFromInstance: true });
    expect(tail).toBe(stackIdTailFromInstanceId(INSTANCE_ID));
    expect(tail).not.toBe('cdkd');
  });

  it('a record without the marker records cdkd, instance id or not', async () => {
    expect(await importedTail({ stackInstanceId: INSTANCE_ID })).toBe('cdkd');
    expect(await importedTail({})).toBe('cdkd');
  });
});
