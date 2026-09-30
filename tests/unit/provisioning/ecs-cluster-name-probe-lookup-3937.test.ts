/**
 * go-to-k/cdkd#3937: ECS `CreateCluster` hands back an ACTIVE cluster that
 * already holds the name, so a replacement renamed onto it is probed first
 * through the cluster `import()`. Pinned here under the probe's exact input
 * (the create bag's `ClusterName`, no `knownPhysicalId`): an ACTIVE cluster is
 * the holder; a missing name and an INACTIVE (deleted) cluster, whose name is
 * free to create again, answer null; any other failure throws, so the probe
 * refuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeClustersCommand } from '@aws-sdk/client-ecs';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-ecs', async () => {
  const actual = await vi.importActual('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { replacementNameProbe } from '../../../src/deployment/replacement-name-holder.js';

const probe = replacementNameProbe({
  resourceType: 'AWS::ECS::Cluster',
  createdVia: 'sdk',
  change: {
    property: 'ClusterName',
    desiredName: 'theirs',
    heldName: 'mine',
    heldProperty: 'ClusterName',
    physicalId: 'mine',
  },
});

const input = {
  logicalId: 'Cluster',
  resourceType: 'AWS::ECS::Cluster',
  stackName: 'MyStack',
  region: 'us-east-1',
  properties: { ClusterName: 'theirs' },
  ...probe,
};

describe('the #3937 name probe against the real ECS cluster lookup', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('asks by the create bag ClusterName, with no known physical id', () => {
    expect(probe).toEqual({});
  });

  it('answers an ACTIVE cluster as the holder, by DescribeClusters on the name', async () => {
    mockSend.mockResolvedValueOnce({ clusters: [{ clusterName: 'theirs', status: 'ACTIVE' }] });

    const found = await new ECSProvider().import(input);

    expect(found).toEqual({ physicalId: 'theirs', attributes: {} });
    const command = mockSend.mock.calls[0]![0] as DescribeClustersCommand;
    expect(command).toBeInstanceOf(DescribeClustersCommand);
    expect(command.input).toEqual({ clusters: ['theirs'] });
  });

  it('answers a PROVISIONING or status-less cluster as the holder too (refusing is safe)', async () => {
    mockSend.mockResolvedValueOnce({
      clusters: [{ clusterName: 'theirs', status: 'PROVISIONING' }],
    });
    await expect(new ECSProvider().import(input)).resolves.toEqual({
      physicalId: 'theirs',
      attributes: {},
    });
    mockSend.mockResolvedValueOnce({ clusters: [{ clusterName: 'theirs' }] });
    await expect(new ECSProvider().import(input)).resolves.toEqual({
      physicalId: 'theirs',
      attributes: {},
    });
  });

  it('answers null for an INACTIVE (deleted) cluster, whose name is free', async () => {
    mockSend.mockResolvedValueOnce({ clusters: [{ clusterName: 'theirs', status: 'INACTIVE' }] });

    await expect(new ECSProvider().import(input)).resolves.toBeNull();
  });

  it('answers null for a name nobody holds (DescribeClusters lists it as a failure)', async () => {
    mockSend.mockResolvedValueOnce({
      clusters: [],
      failures: [{ arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/theirs', reason: 'MISSING' }],
    });

    await expect(new ECSProvider().import(input)).resolves.toBeNull();
  });

  it('throws when DescribeClusters lists no cluster for a reason other than MISSING', async () => {
    mockSend.mockResolvedValueOnce({
      clusters: [],
      failures: [
        {
          arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/theirs',
          reason: 'ACCESS_DENIED',
          detail: 'not authorized',
        },
      ],
    });

    await expect(new ECSProvider().import(input)).rejects.toThrow(
      'DescribeClusters did not answer for cluster theirs: ACCESS_DENIED (not authorized)'
    );
  });

  it('does not swallow its own refusal when the failure detail says "Cluster not found"', async () => {
    // The not-found arm matches message substrings; a non-MISSING failure
    // whose detail carries that phrase must still refuse, not read as free.
    mockSend.mockResolvedValueOnce({
      clusters: [],
      failures: [
        {
          arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/theirs',
          reason: 'ACCESS_DENIED',
          detail: 'Cluster not found or not authorized',
        },
      ],
    });

    await expect(new ECSProvider().import(input)).rejects.toThrow(
      'DescribeClusters did not answer for cluster theirs: ACCESS_DENIED'
    );
  });

  it('answers null for the cluster-not-found errors it swallows, and only those', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('Cluster not found.'), { name: 'ClusterNotFoundException' })
    );
    await expect(new ECSProvider().import(input)).resolves.toBeNull();

    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
    );
    await expect(new ECSProvider().import(input)).rejects.toThrow('Rate exceeded');
  });

  it('answers null for an INACTIVE cluster named by an explicit --resource override too', async () => {
    mockSend.mockResolvedValueOnce({ clusters: [{ clusterName: 'gone', status: 'INACTIVE' }] });

    await expect(
      new ECSProvider().import({ ...input, properties: {}, knownPhysicalId: 'gone' })
    ).resolves.toBeNull();
    const command = mockSend.mock.calls[0]![0] as DescribeClustersCommand;
    expect(command.input).toEqual({ clusters: ['gone'] });
  });

  it('throws any other failure, so the probe refuses', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('User is not authorized to perform: ecs:DescribeClusters'), {
        name: 'AccessDeniedException',
      })
    );

    await expect(new ECSProvider().import(input)).rejects.toThrow('not authorized');
  });
});
