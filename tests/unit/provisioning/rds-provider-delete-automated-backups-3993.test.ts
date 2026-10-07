import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #3993, the wire half: a Cloud Control-routed RDS cluster or instance
 * reaches AWS as `DeleteDB*` with `SkipFinalSnapshot: true`, and the recorded
 * `DeleteAutomatedBackups` rides along as the registry handler it replaces
 * sent it. The routing half is `cloud-control-rds-delete-3993.test.ts`.
 */

const rdsSend = vi.hoisted(() => vi.fn());
const rdsClientRegions = vi.hoisted(() => [] as Array<string | undefined>);
const cloudControlSend = vi.hoisted(() => vi.fn());
const ccRegion = vi.hoisted(() => ({ value: 'us-east-1' }));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation((config: { region?: string }) => {
      rdsClientRegions.push(config.region);
      return {
        send: rdsSend,
        config: { region: () => Promise.resolve(config.region ?? 'us-east-1') },
      };
    }),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: cloudControlSend,
      config: { region: () => Promise.resolve(ccRegion.value) },
    },
    ec2: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';

const CASES = [
  {
    type: 'AWS::RDS::DBCluster',
    del: 'DeleteDBClusterCommand',
    describe: 'DescribeDBClustersCommand',
    fault: 'DBClusterNotFoundFault',
  },
  {
    type: 'AWS::RDS::DBInstance',
    del: 'DeleteDBInstanceCommand',
    describe: 'DescribeDBInstancesCommand',
    fault: 'DBInstanceNotFoundFault',
  },
] as const;

function deleteInputs(name: string): Array<Record<string, unknown>> {
  return rdsSend.mock.calls
    .filter((c) => c[0].constructor.name === name)
    .map((c) => c[0].input as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  rdsSend.mockReset();
  cloudControlSend.mockReset();
  rdsClientRegions.length = 0;
  ccRegion.value = 'us-east-1';
  // The post-delete wait reads the resource as gone at once.
  rdsSend.mockImplementation((cmd) => {
    const name = cmd.constructor.name as string;
    const match = CASES.find((c) => c.describe === name);
    if (match) {
      return Promise.reject(Object.assign(new Error('gone'), { name: match.fault }));
    }
    return Promise.resolve({});
  });
});

describe.each(CASES)('$type delete', ({ type, del }) => {
  it.each([
    [false, { DeleteAutomatedBackups: false }],
    [true, { DeleteAutomatedBackups: true }],
    ['false', { DeleteAutomatedBackups: false }],
    ['true', { DeleteAutomatedBackups: true }],
  ])('recorded DeleteAutomatedBackups %j is sent as %j', async (recorded, expected) => {
    await new RDSProvider().delete('Db', 'db-1', type, { DeleteAutomatedBackups: recorded });

    const [input] = deleteInputs(del);
    expect(input).toEqual(expect.objectContaining({ SkipFinalSnapshot: true, ...expected }));
  });

  it.each([[undefined], [null], ['yes'], [{ Ref: 'Flag' }], [0]])(
    'recorded DeleteAutomatedBackups %j sends NO member (AWS default)',
    async (recorded) => {
      await new RDSProvider().delete('Db', 'db-1', type, { DeleteAutomatedBackups: recorded });

      const [input] = deleteInputs(del);
      expect(input).not.toHaveProperty('DeleteAutomatedBackups');
      expect(input?.['SkipFinalSnapshot']).toBe(true);
    }
  );

  it('with no properties at all, sends no member', async () => {
    await new RDSProvider().delete('Db', 'db-1', type);

    const [input] = deleteInputs(del);
    expect(input).not.toHaveProperty('DeleteAutomatedBackups');
  });

  it('through CloudControlProvider: ONE DeleteDB* with SkipFinalSnapshot: true and no Cloud Control call', async () => {
    const result = await new CloudControlProvider().delete(
      'Db',
      'db-1',
      type,
      { DeleteAutomatedBackups: false },
      { expectedRegion: 'us-east-1', deletionPolicy: 'Delete' }
    );

    expect(result).toBeUndefined();
    const inputs = deleteInputs(del);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual(
      expect.objectContaining({ SkipFinalSnapshot: true, DeleteAutomatedBackups: false })
    );
    expect(inputs[0]).not.toHaveProperty('FinalDBSnapshotIdentifier');
    expect(cloudControlSend).not.toHaveBeenCalled();
  });

  it('through CloudControlProvider: the RDS client targets the Cloud Control region, not the ambient one', async () => {
    // Issue #3993 review: `cdkd rollback` swaps the AWS clients to the
    // stack's region without touching AWS_REGION.
    const saved = process.env['AWS_REGION'];
    process.env['AWS_REGION'] = 'us-east-1';
    ccRegion.value = 'eu-west-1';
    try {
      await new CloudControlProvider().delete(
        'Db',
        'db-1',
        type,
        {},
        { expectedRegion: 'eu-west-1', deletionPolicy: 'Delete' }
      );
    } finally {
      if (saved === undefined) delete process.env['AWS_REGION'];
      else process.env['AWS_REGION'] = saved;
    }

    // The shared client and the create client built with it (#4639).
    expect(rdsClientRegions).toEqual(['eu-west-1', 'eu-west-1']);
    expect(deleteInputs(del)).toHaveLength(1);
  });
});
