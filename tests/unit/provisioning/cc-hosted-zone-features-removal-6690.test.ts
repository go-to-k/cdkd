import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6690: Cloud Control refuses `remove /HostedZoneFeatures`
// (`readOnlyProperties [/properties/HostedZoneFeatures/ChangeHistory] cannot be
// updated`): the live block holds the read-only `ChangeHistory`. Measured
// us-east-1: a `replace` holding only the live `ChangeHistory` is applied and
// clears the writable members, so that is what a removal sends.

const mockCloudControlSend = vi.hoisted(() => vi.fn());
const mockCloudFormationSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => child),
  };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { withMeasuredRemovalsAsEmpty } from '../../../src/provisioning/cc-nested-create-only-patch.js';
import { clearWriteOnlyPropertiesCache } from '../../../src/provisioning/write-only-properties.js';
import { clearReadOnlyPropertiesCache } from '../../../src/provisioning/read-only-properties.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';

const TYPE = 'AWS::Route53::HostedZone';

describe('withMeasuredRemovalsAsEmpty', () => {
  it('sends a measured removal as an empty object, on a copy', () => {
    const patch = [{ op: 'remove' as const, path: '/HostedZoneFeatures' }];
    expect(withMeasuredRemovalsAsEmpty(patch, TYPE)).toEqual([
      { op: 'replace', path: '/HostedZoneFeatures', value: {} },
    ]);
    expect(patch[0]!.op).toBe('remove');
  });

  it('leaves other paths, other types and prototype keys alone', () => {
    const patch = [
      { op: 'remove' as const, path: '/HostedZoneConfig' },
      { op: 'remove' as const, path: '/HostedZoneFeatures/ChangeGuardrails' },
    ];
    expect(withMeasuredRemovalsAsEmpty(patch, TYPE)).toEqual(patch);
    const zoneRemoval = [{ op: 'remove' as const, path: '/HostedZoneFeatures' }];
    expect(withMeasuredRemovalsAsEmpty(zoneRemoval, 'AWS::SQS::Queue')).toEqual(zoneRemoval);
    expect(withMeasuredRemovalsAsEmpty(zoneRemoval, 'constructor')).toEqual(zoneRemoval);
  });
});

describe('CloudControlProvider update: a hosted zone dropping HostedZoneFeatures', () => {
  const SCHEMA = JSON.stringify({
    readOnlyProperties: [
      '/properties/Id',
      '/properties/NameServers',
      '/properties/HostedZoneFeatures/ChangeHistory',
    ],
    createOnlyProperties: ['/properties/Name', '/properties/DelegationSetId'],
  });
  const CHANGE_HISTORY = { Status: 'DISABLED' };

  function featureOps(): unknown[] {
    return mockCloudControlSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: { PatchDocument?: string } })
      .filter((cmd) => cmd.constructor.name === 'UpdateResourceCommand')
      .flatMap((cmd) => JSON.parse(cmd.input.PatchDocument!) as Array<{ path: string }>)
      .filter((patchOp) => patchOp.path === '/HostedZoneFeatures');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearWriteOnlyPropertiesCache();
    clearReadOnlyPropertiesCache();
    clearCreateOnlyPropertiesCache();
    mockCloudFormationSend.mockResolvedValue({ Schema: SCHEMA });
    const live = {
      Id: 'Z1',
      Name: 'example.internal.',
      HostedZoneFeatures: {
        ChangeHistory: CHANGE_HISTORY,
        EnableAcceleratedRecovery: false,
        ChangeGuardrails: [{ Name: 'NS_OCCLUSION_CHECK', Status: 'ENABLED' }],
      },
    };
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'UpdateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS', Identifier: 'Z1' } });
      }
      if (name === 'GetResourceCommand') {
        return Promise.resolve({
          ResourceDescription: { Identifier: 'Z1', Properties: JSON.stringify(live) },
        });
      }
      return Promise.resolve({});
    });
  });

  it('sends the removal as the live ChangeHistory alone', async () => {
    await new CloudControlProvider().update(
      'Zone',
      'Z1',
      TYPE,
      { Name: 'example.internal' },
      {
        Name: 'example.internal',
        HostedZoneFeatures: { ChangeGuardrails: [{ Name: 'NS_OCCLUSION_CHECK', Status: 'ENABLED' }] },
      }
    );
    expect(featureOps()).toEqual([
      { op: 'replace', path: '/HostedZoneFeatures', value: { ChangeHistory: CHANGE_HISTORY } },
    ]);
  });
});
