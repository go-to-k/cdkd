// issue #5995: `destroy --remove-protection` on an RDS-family cluster or
// instance that is busy (`backing-up` right after create) is refused the
// DeletionProtection flip. The flip-off and the compensating re-enable wait
// for the resource to read `available` and resend, as the RDS flips already
// did under #5639; a terminal status, and any other refusal, still fail at
// once. The RDS rows are the existing behaviour, kept on the same table so
// every site is fenced alike.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

function sdkClientMock(clientName: string) {
  return async (importOriginal: () => Promise<unknown>) => ({
    ...((await importOriginal()) as Record<string, unknown>),
    [clientName]: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  });
}

vi.mock('@aws-sdk/client-rds', sdkClientMock('RDSClient'));
vi.mock('@aws-sdk/client-docdb', sdkClientMock('DocDBClient'));
vi.mock('@aws-sdk/client-neptune', sdkClientMock('NeptuneClient'));

const childLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
};
/** What the enclosing resource deadline leaves; `Infinity` outside one. */
const deadline = vi.hoisted(() => ({ remainingMs: Number.POSITIVE_INFINITY }));
vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enclosingDeadlineRemainingMs: () => deadline.remainingMs,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';

function awsError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

type Provider = {
  delete: (
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown> | undefined,
    context: Record<string, unknown>
  ) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

interface Site {
  name: string;
  type: string;
  make: () => Provider;
  modify: string;
  describe: string;
  del: string;
  listKey: string;
  statusKey: string;
  notFoundFault: string;
  /** AWS's refusal of the flip while the resource is busy. */
  busy: () => Error;
  /** A terminal refusal of the delete itself, once the guard is off. */
  deleteRefusal: () => Error;
}

/** The cluster refusal read off CloudTrail on the rds-aurora integ (#5994). */
const clusterBusy = (): Error =>
  awsError(
    'InvalidDBClusterStateFault',
    "DB cluster isn't available for modification with status backing-up."
  );
const instanceBusy = (): Error =>
  awsError('InvalidDBInstanceStateFault', 'Database instance is not in available state.');

const cluster = {
  modify: 'ModifyDBClusterCommand',
  describe: 'DescribeDBClustersCommand',
  del: 'DeleteDBClusterCommand',
  listKey: 'DBClusters',
  statusKey: 'Status',
  notFoundFault: 'DBClusterNotFoundFault',
  busy: clusterBusy,
  deleteRefusal: () =>
    awsError(
      'InvalidDBClusterStateFault',
      'Cluster cannot be deleted, it still contains DB instances in non-deleting state.'
    ),
};
const instance = {
  modify: 'ModifyDBInstanceCommand',
  describe: 'DescribeDBInstancesCommand',
  del: 'DeleteDBInstanceCommand',
  listKey: 'DBInstances',
  statusKey: 'DBInstanceStatus',
  notFoundFault: 'DBInstanceNotFoundFault',
  busy: instanceBusy,
  deleteRefusal: () =>
    awsError('InvalidDBInstanceStateFault', 'DB instance db-1 is in a non-deleting state.'),
};

const SITES: Site[] = [
  {
    name: 'DocDB DBCluster',
    type: 'AWS::DocDB::DBCluster',
    make: () => new DocDBProvider() as unknown as Provider,
    ...cluster,
  },
  {
    name: 'Neptune DBCluster',
    type: 'AWS::Neptune::DBCluster',
    make: () => new NeptuneProvider() as unknown as Provider,
    ...cluster,
  },
  {
    name: 'Neptune DBInstance',
    type: 'AWS::Neptune::DBInstance',
    make: () => new NeptuneProvider() as unknown as Provider,
    ...instance,
  },
  {
    name: 'RDS DBCluster',
    type: 'AWS::RDS::DBCluster',
    make: () => new RDSProvider() as unknown as Provider,
    ...cluster,
  },
  {
    name: 'RDS DBInstance',
    type: 'AWS::RDS::DBInstance',
    make: () => new RDSProvider() as unknown as Provider,
    ...instance,
  },
];

interface Script {
  /** Refusals the flip-off meets, in turn, before AWS accepts it. */
  disable?: Error[];
  /** Refusals the re-enable meets, in turn, before AWS accepts it. */
  reEnable?: Error[];
  /** Statuses the readback returns, in turn, before `available`. */
  statuses?: string[];
  /** The delete's own failure once the guard is off. */
  del?: Error;
}

/**
 * Models the live resource: protected until a flip-off is ACCEPTED, and a
 * delete of a protected resource is refused as AWS refuses it.
 */
function arm(site: Site, s: Script): void {
  const disable = [...(s.disable ?? [])];
  const reEnable = [...(s.reEnable ?? [])];
  const statuses = [...(s.statuses ?? [])];
  let protectedNow = true;
  let deleteAccepted = false;
  mockSend.mockImplementation(
    async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      if (name === site.describe) {
        if (deleteAccepted) throw awsError(site.notFoundFault, 'not found');
        return {
          [site.listKey]: [
            {
              DeletionProtection: protectedNow,
              [site.statusKey]: statuses.shift() ?? 'available',
            },
          ],
        };
      }
      if (name === site.modify) {
        const turningOn = cmd.input['DeletionProtection'] === true;
        const refusal = (turningOn ? reEnable : disable).shift();
        if (refusal !== undefined) throw refusal;
        protectedNow = turningOn;
        return {};
      }
      if (name === site.del) {
        if (protectedNow) {
          throw awsError(
            'InvalidParameterCombination',
            'Cannot delete protected Cluster, please disable deletion protection and try again.'
          );
        }
        if (s.del) throw s.del;
        deleteAccepted = true;
        return {};
      }
      return {};
    }
  );
}

function flips(site: Site, value: boolean): unknown[] {
  return mockSend.mock.calls
    .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .filter((c) => c.constructor.name === site.modify && c.input['DeletionProtection'] === value)
    .map((c) => c.input);
}

function deletes(site: Site): number {
  return mockSend.mock.calls.filter(
    (c) => (c[0] as { constructor: { name: string } }).constructor.name === site.del
  ).length;
}

const CTX = { removeProtection: true, expectedRegion: 'us-east-1' };

describe.each(SITES)('$name: --remove-protection waits out a busy resource (#5995)', (site) => {
  let provider: Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    deadline.remainingMs = Number.POSITIVE_INFINITY;
    provider = site.make();
    provider.sleep = async () => {};
  });

  it('resends the flip-off once the resource reads available, and the delete goes through', async () => {
    arm(site, { disable: [site.busy()], statuses: ['available', 'backing-up'] });

    await provider.delete('Res', 'db-1', site.type, undefined, CTX);

    const sent = flips(site, false);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(deletes(site)).toBe(1);
  });

  it('resends the compensating re-enable after a busy refusal, so the guard is restored', async () => {
    const terminal = site.deleteRefusal();
    arm(site, { del: terminal, reEnable: [site.busy()] });

    await expect(provider.delete('Res', 'db-1', site.type, undefined, CTX)).rejects.toThrow(
      'non-deleting state'
    );

    const sent = flips(site, true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('re-enabled on db-1'));
  });

  it('does not resend the flip-off when the resource reads a terminal status', async () => {
    arm(site, {
      disable: [site.busy()],
      statuses: ['available', 'inaccessible-encryption-credentials'],
    });

    await expect(provider.delete('Res', 'db-1', site.type, undefined, CTX)).rejects.toThrow(
      /protected/
    );
    expect(flips(site, false)).toHaveLength(1);
  });

  it('does not resend the flip-off after a refusal no wait ends', async () => {
    arm(site, { disable: [awsError('InvalidParameterValue', 'bad request')] });

    await expect(provider.delete('Res', 'db-1', site.type, undefined, CTX)).rejects.toThrow(
      /protected/
    );
    expect(flips(site, false)).toHaveLength(1);
  });

  it('gives the flip-off up when the resource deadline leaves no time, and the delete is refused as protected', async () => {
    deadline.remainingMs = 0;
    arm(site, { disable: [site.busy()] });

    await expect(provider.delete('Res', 'db-1', site.type, undefined, CTX)).rejects.toThrow(
      /protected/
    );
    expect(flips(site, false)).toHaveLength(1);
    expect(childLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Could not disable deletion protection')
    );
  });

  it('gives the re-enable up when the resource deadline leaves no time, and says the guard is still off', async () => {
    const terminal = site.deleteRefusal();
    arm(site, { del: terminal, reEnable: [site.busy()] });
    // The flip-off runs with time to spare; the deadline is spent by the
    // time the delete fails, so only the re-enable meets it.
    const original = mockSend.getMockImplementation() as (cmd: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => Promise<unknown>;
    mockSend.mockImplementation(async (cmd) => {
      if (cmd.constructor.name === site.del) deadline.remainingMs = 0;
      return original(cmd);
    });

    await expect(provider.delete('Res', 'db-1', site.type, undefined, CTX)).rejects.toThrow(
      'non-deleting state'
    );

    expect(flips(site, true)).toHaveLength(1);
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('could NOT re-enable DeletionProtection on db-1')
    );
  });

  it('sends one flip-off when AWS accepts it', async () => {
    arm(site, {});

    await provider.delete('Res', 'db-1', site.type, undefined, CTX);

    expect(flips(site, false)).toHaveLength(1);
    expect(deletes(site)).toBe(1);
  });
});
