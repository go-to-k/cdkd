import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier EMR cluster. Only `'different'` lets it
// delete. The instance fleet / group providers deliberately answer nothing.

const { mockSend, clientRegion, providerLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
  providerLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

import {
  DescribeClusterCommand,
  InvalidRequestException,
  SetTerminationProtectionCommand,
  TerminateJobFlowsCommand,
} from '@aws-sdk/client-emr';
import { EMRClusterProvider } from '../../../src/provisioning/providers/emr-cluster-provider.js';
import { EMRInstanceFleetConfigProvider } from '../../../src/provisioning/providers/emr-instance-fleet-config-provider.js';
import { EMRInstanceGroupConfigProvider } from '../../../src/provisioning/providers/emr-instance-group-config-provider.js';

const CLUSTER = 'AWS::EMR::Cluster';
const CTX = { expectedRegion: 'us-east-1' };
const J_A = 'j-1AAAAAAAAAAAA';
const J_B = 'j-2BBBBBBBBBBBB';

const invalidRequest = (): InvalidRequestException =>
  new InvalidRequestException({ message: 'Cluster id is not valid.', $metadata: {} });
const awsError = (name: string, message = name): Error => Object.assign(new Error(message), { name });

/** `DescribeCluster` answers per cluster id: its state, or EMR's unknown-id answer. */
function clusters(live: Record<string, string | 'gone' | Error>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof DescribeClusterCommand)) throw new Error('unexpected command');
    const id = cmd.input.ClusterId!;
    const entry = live[id];
    if (entry === undefined || entry === 'gone') throw invalidRequest();
    if (entry instanceof Error) throw entry;
    return { Cluster: { Id: id, Name: 'c', Status: { State: entry } } };
  });
}

const readIds = (): unknown[] =>
  mockSend.mock.calls.map(([c]) => (c as DescribeClusterCommand).input.ClusterId);

let provider: EMRClusterProvider;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  clientRegion.value = 'us-east-1';
  provider = new EMRClusterProvider({ pollIntervalMs: 0, maxWaitMs: 1000 });
});

describe('EMRClusterProvider.isSameResource (go-to-k/cdkd#4606)', () => {
  it('another live cluster is different, after reading the record first, then the journaled one', async () => {
    clusters({ [J_A]: 'WAITING', [J_B]: 'WAITING' });
    expect(await provider.isSameResource(J_A, { physicalId: J_B }, CLUSTER, CTX)).toBe('different');
    expect(readIds()).toEqual([J_B, J_A]);
  });

  it.each(['TERMINATED_WITH_ERRORS', 'TERMINATED', 'TERMINATING', 'gone'])(
    'a journaled cluster %s is different once the record reads back live',
    async (journaled) => {
      clusters({ [J_A]: journaled, [J_B]: 'RUNNING' });
      expect(await provider.isSameResource(J_A, { physicalId: J_B }, CLUSTER, CTX)).toBe(
        'different'
      );
    }
  );

  it.each(['STARTING', 'BOOTSTRAPPING', 'RUNNING', 'WAITING'])(
    'a record cluster %s counts as live',
    async (recorded) => {
      clusters({ [J_A]: 'TERMINATED_WITH_ERRORS', [J_B]: recorded });
      expect(await provider.isSameResource(J_A, { physicalId: J_B }, CLUSTER, CTX)).toBe(
        'different'
      );
    }
  );

  it.each(['TERMINATING', 'TERMINATED', 'TERMINATED_WITH_ERRORS', 'gone'])(
    'the record cluster %s is unknown, not different, and the journaled one is not read',
    async (recorded) => {
      clusters({ [J_A]: 'WAITING', [J_B]: recorded });
      expect(await provider.isSameResource(J_A, { physicalId: J_B }, CLUSTER, CTX)).toBe('unknown');
      expect(readIds()).toEqual([J_B]);
    }
  );

  it('a record cluster read back with no state is unknown', async () => {
    mockSend.mockResolvedValue({ Cluster: { Id: J_B } });
    expect(await provider.isSameResource(J_A, { physicalId: J_B }, CLUSTER, CTX)).toBe('unknown');
    expect(readIds()).toEqual([J_B]);
  });

  it('a record read naming another cluster is unknown', async () => {
    mockSend.mockResolvedValue({ Cluster: { Id: J_A, Status: { State: 'WAITING' } } });
    expect(await provider.isSameResource(J_A, { physicalId: J_B }, CLUSTER, CTX)).toBe('unknown');
    expect(readIds()).toEqual([J_B]);
  });

  it('equal ids are the same without a read', async () => {
    clusters({});
    expect(await provider.isSameResource(J_A, { physicalId: J_A }, CLUSTER, CTX)).toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Defensive: EMR cannot answer one cluster id with another; the branch
  // exists so a read naming the record's cluster never reads as 'different'.
  it("a journaled id reading back as the record's cluster is the same", async () => {
    mockSend.mockResolvedValue({ Cluster: { Id: J_B, Status: { State: 'WAITING' } } });
    expect(await provider.isSameResource(J_A, { physicalId: J_B }, CLUSTER, CTX)).toBe('same');
    expect(readIds()).toEqual([J_B, J_A]);
  });

  it.each([
    ['the record', J_B],
    ['the journaled one', J_A],
  ])('a read of %s that fails other than InvalidRequestException throws', async (_label, id) => {
    clusters({ [J_A]: 'WAITING', [J_B]: 'WAITING', [id]: awsError('AccessDeniedException', 'denied') });
    await expect(provider.isSameResource(J_A, { physicalId: J_B }, CLUSTER, CTX)).rejects.toThrow(
      'denied'
    );
  });

  it('a response naming no cluster throws rather than reading as gone', async () => {
    mockSend.mockResolvedValueOnce({ Cluster: { Id: J_B, Status: { State: 'WAITING' } } });
    mockSend.mockResolvedValueOnce({});
    await expect(provider.isSameResource(J_A, { physicalId: J_B }, CLUSTER, CTX)).rejects.toThrow(
      'DescribeCluster did not return the cluster asked for'
    );
  });

  it('a client in another region is unknown without a read', async () => {
    clientRegion.value = 'us-west-2';
    clusters({ [J_A]: 'WAITING', [J_B]: 'WAITING' });
    expect(await provider.isSameResource(J_A, { physicalId: J_B }, CLUSTER, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a lower-case journaled id', 'j-1aaaaaaaaaaaa', J_B],
    ['a lower-case record id', J_A, 'j-2bbbbbbbbbbbb'],
    ['a journaled id of another form', 'ig-1AAAAAAAAAAAA', J_B],
    ['an empty record id', J_A, ''],
    ['a bare prefix', 'j-', J_B],
    ['a journaled id with text before the prefix', 'xj-1AAAAAAAAAAAA', J_B],
    ['a record id with text after the id', J_A, `${J_B}|x`],
  ])('%s is unknown without a read', async (_label, journaled, recorded) => {
    clusters({ [J_A]: 'WAITING', [J_B]: 'WAITING' });
    expect(
      await provider.isSameResource(journaled, { physicalId: recorded }, CLUSTER, CTX)
    ).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('another resource type is unknown without a read', async () => {
    clusters({ [J_A]: 'WAITING', [J_B]: 'WAITING' });
    expect(
      await provider.isSameResource(J_A, { physicalId: J_B }, 'AWS::EMR::InstanceGroupConfig', CTX)
    ).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EMRClusterProvider.delete of a journaled orphan already gone (go-to-k/cdkd#4606)', () => {
  const sentTerminate = (): boolean =>
    mockSend.mock.calls.some(
      ([c]) => c instanceof TerminateJobFlowsCommand || c instanceof SetTerminationProtectionCommand
    );

  it.each(['TERMINATED_WITH_ERRORS', 'TERMINATED'])(
    'a %s orphan is named once at info and nothing is sent',
    async (state) => {
      clusters({ [J_A]: state });
      await provider.delete('Orphan', J_A, CLUSTER, undefined, {
        expectedRegion: 'us-east-1',
        failedCreateOrphan: true,
      });
      expect(providerLogger.info).toHaveBeenCalledTimes(1);
      expect(providerLogger.info.mock.calls[0]![0]).toContain(
        `EMR cluster ${J_A} (Orphan), which a failed deploy created, is already ${state}`
      );
      expect(sentTerminate()).toBe(false);
    }
  );

  it('an orphan EMR no longer knows is named once at info as already gone', async () => {
    clusters({});
    await provider.delete('Orphan', J_A, CLUSTER, undefined, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    expect(providerLogger.info).toHaveBeenCalledTimes(1);
    expect(providerLogger.info.mock.calls[0]![0]).toContain(
      `EMR cluster ${J_A} (Orphan), which a failed deploy created, is already gone`
    );
  });

  it.each([
    ['TERMINATED', undefined, 'already TERMINATED, skipping deletion'],
    ['TERMINATED', false, 'already TERMINATED, skipping deletion'],
    ['gone', undefined, 'does not exist, skipping deletion'],
    ['gone', false, 'does not exist, skipping deletion'],
  ] as const)(
    'a record delete of a %s cluster (failedCreateOrphan %s) stays at debug',
    async (state, failedCreateOrphan, debugText) => {
      clusters({ [J_A]: state });
      await provider.delete('Cluster', J_A, CLUSTER, undefined, {
        expectedRegion: 'us-east-1',
        ...(failedCreateOrphan !== undefined && { failedCreateOrphan }),
      });
      expect(providerLogger.info).not.toHaveBeenCalled();
      expect(
        providerLogger.debug.mock.calls.some(([m]) => String(m).includes(`${J_A} ${debugText}`))
      ).toBe(true);
    }
  );

  it('a live orphan is still terminated', async () => {
    let terminated = false;
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof TerminateJobFlowsCommand) {
        terminated = true;
        return {};
      }
      if (cmd instanceof DescribeClusterCommand) {
        return { Cluster: { Id: J_A, Status: { State: terminated ? 'TERMINATED' : 'WAITING' } } };
      }
      throw new Error('unexpected command');
    });
    await provider.delete('Orphan', J_A, CLUSTER, undefined, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    expect(terminated).toBe(true);
    expect(providerLogger.info).not.toHaveBeenCalled();
  });
});

describe('EMR instance fleet / group providers (go-to-k/cdkd#4606)', () => {
  // No by-id read exists without the cluster id, and no delete API: the
  // settle's absent-method arm keeps the warning and exit 2.
  it.each([
    ['AWS::EMR::InstanceFleetConfig', new EMRInstanceFleetConfigProvider()],
    ['AWS::EMR::InstanceGroupConfig', new EMRInstanceGroupConfigProvider()],
  ])('%s declares no isSameResource', (_type, p) => {
    expect((p as { isSameResource?: unknown }).isSameResource).toBeUndefined();
  });
});
