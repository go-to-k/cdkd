// go-to-k/cdkd#5984: an AWS::RDS::DBCluster declaring WithExpressConfiguration
// rides the SDK route. RDS creates a `<cluster>-instance-1` writer with it, which
// CloudFormation's create waits on and its delete removes first, by that name and
// with SkipFinalSnapshot, leaving every other member alone (measured with
// CloudTrail, us-east-1, 2026-11-10). cdkd also checks the recorded writer id
// and refuses, before any delete, when another member would make the cluster
// delete fail anyway.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { rdsSend, warnSpy } = vi.hoisted(() => ({ rdsSend: vi.fn(), warnSpy: vi.fn() }));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: rdsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() }),
  };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { EXPRESS_WRITER_RESOURCE_ID_KEY } from '../../../src/provisioning/providers/rds/express-writer.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { applyDefaultNameForFallback } from '../../../src/provisioning/resource-name/fallback.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const CLUSTER = 'AWS::RDS::DBCluster';
const ID = 'db-1';
const WRITER = `${ID}-instance-1`;
const WRITER_ID = 'db-WRITER1';
const EXPRESS_BAG = { Engine: 'aurora-postgresql', WithExpressConfiguration: true };

function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

interface Instance {
  status: string;
  resourceId: string;
  /** The cluster RDS reports it in; this test's cluster by default. */
  cluster?: string;
}

/**
 * A live cluster with the given members, answering the RDS calls the paths
 * send. Like RDS, it matches identifiers case-insensitively and reports them
 * lowercase.
 */
function script(
  members: Record<string, Instance>,
  { deletionProtection = false }: { deletionProtection?: boolean } = {}
): void {
  rdsSend.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    const input = cmd.input;
    switch (name) {
      case 'CreateDBClusterCommand':
        return Promise.resolve({
          DBCluster: { DBClusterIdentifier: ID, DbClusterResourceId: 'cluster-R' },
        });
      case 'DescribeDBClustersCommand':
        return Promise.resolve({
          DBClusters: [
            {
              DBClusterIdentifier: ID,
              DBClusterArn: `arn:aws:rds:us-east-1:111122223333:cluster:${ID}`,
              Status: 'available',
              DeletionProtection: deletionProtection,
              DbClusterResourceId: 'cluster-R',
              DBClusterMembers: Object.keys(members).map((id) => ({ DBInstanceIdentifier: id })),
            },
          ],
        });
      case 'DescribeDBInstancesCommand': {
        const id = (input['DBInstanceIdentifier'] as string).toLowerCase();
        const instance = members[id];
        if (instance === undefined) return Promise.reject(awsError('DBInstanceNotFoundFault'));
        return Promise.resolve({
          DBInstances: [
            {
              DBInstanceIdentifier: id,
              DBClusterIdentifier: instance.cluster ?? ID,
              DBInstanceStatus: instance.status,
              DbiResourceId: instance.resourceId,
            },
          ],
        });
      }
      case 'DeleteDBInstanceCommand': {
        const id = (input['DBInstanceIdentifier'] as string).toLowerCase();
        if (members[id] === undefined) return Promise.reject(awsError('DBInstanceNotFoundFault'));
        members[id] = { ...members[id]!, status: 'deleting' };
        return Promise.resolve({});
      }
      case 'ModifyDBClusterCommand':
      case 'DeleteDBClusterCommand':
        return Promise.resolve({});
      default:
        return Promise.reject(new Error(`unexpected command ${name}`));
    }
  });
}

function names(): string[] {
  return rdsSend.mock.calls.map((c) => String(c[0].constructor.name));
}

function inputOf(command: string): Record<string, unknown> | undefined {
  return rdsSend.mock.calls.find((c) => c[0].constructor.name === command)?.[0].input;
}

describe('RDSProvider DBCluster WithExpressConfiguration (go-to-k/cdkd#5984)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    rdsSend.mockReset();
    provider = new RDSProvider();
    vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(
      undefined
    );
    // The cluster delete wait is not under test.
    vi.spyOn(
      provider as unknown as { waitForClusterDeleted: () => Promise<void> },
      'waitForClusterDeleted'
    ).mockResolvedValue(undefined);
  });

  describe('handledProperties', () => {
    it('handles WithExpressConfiguration and no longer lists it unhandled by design', () => {
      expect(provider.handledProperties.get(CLUSTER)?.has('WithExpressConfiguration')).toBe(true);
      expect(provider.unhandledByDesign.get(CLUSTER)?.has('WithExpressConfiguration')).toBe(false);
    });

    it('never compares it in drift: DescribeDBClusters has no member for it', () => {
      expect(
        provider.getDriftUnknownPaths(CLUSTER, { Engine: 'aurora-postgresql', WithExpressConfiguration: true })
      ).toContain('WithExpressConfiguration');
    });
  });

  describe('create', () => {
    it('sends the flag, waits for the writer RDS created, and records its id', async () => {
      script({ [WRITER]: { status: 'available', resourceId: WRITER_ID } });

      const result = await provider.create('Db', CLUSTER, {
        DBClusterIdentifier: ID,
        Engine: 'aurora-postgresql',
        WithExpressConfiguration: true,
      });

      expect(inputOf('CreateDBClusterCommand')?.['WithExpressConfiguration']).toBe(true);
      expect(
        rdsSend.mock.calls.some(
          (c) =>
            c[0].constructor.name === 'DescribeDBInstancesCommand' &&
            c[0].input['DBInstanceIdentifier'] === WRITER
        )
      ).toBe(true);
      expect(result.attributes?.[EXPRESS_WRITER_RESOURCE_ID_KEY]).toBe(WRITER_ID);
    });

    it("accepts CloudFormation's string spelling", async () => {
      script({ [WRITER]: { status: 'available', resourceId: WRITER_ID } });
      await provider.create('Db', CLUSTER, {
        DBClusterIdentifier: ID,
        Engine: 'aurora-postgresql',
        WithExpressConfiguration: 'true',
      });
      expect(inputOf('CreateDBClusterCommand')?.['WithExpressConfiguration']).toBe(true);
    });

    it('sends no flag and reads no writer for a cluster without express configuration', async () => {
      script({});
      const result = await provider.create('Db', CLUSTER, {
        DBClusterIdentifier: ID,
        Engine: 'aurora-postgresql',
      });
      expect(inputOf('CreateDBClusterCommand')).not.toHaveProperty('WithExpressConfiguration');
      expect(names()).not.toContain('DescribeDBInstancesCommand');
      expect(result.attributes).not.toHaveProperty(EXPRESS_WRITER_RESOURCE_ID_KEY);
    });

    it('refuses a malformed flag before any call', async () => {
      script({});
      await expect(
        provider.create('Db', CLUSTER, {
          DBClusterIdentifier: ID,
          Engine: 'aurora-postgresql',
          WithExpressConfiguration: 'yes',
        })
      ).rejects.toThrow(/WithExpressConfiguration must be true or false/);
      expect(rdsSend).not.toHaveBeenCalled();
    });

    it('deletes the writer before the cluster when the create fails after CreateDBCluster', async () => {
      script({ [WRITER]: { status: 'available', resourceId: WRITER_ID } });
      vi.spyOn(
        provider as unknown as { waitForClusterAvailable: () => Promise<void> },
        'waitForClusterAvailable'
      ).mockRejectedValue(new Error('wait failed'));

      await expect(
        provider.create('Db', CLUSTER, {
          DBClusterIdentifier: ID,
          Engine: 'aurora-postgresql',
          WithExpressConfiguration: true,
        })
      ).rejects.toThrow(/wait failed/);

      expect(names()).toEqual([
        'CreateDBClusterCommand',
        // Whether the writer is this cluster's member: a name is no attribution.
        'DescribeDBInstancesCommand',
        'DeleteDBInstanceCommand',
        'DeleteDBClusterCommand',
      ]);
      expect(inputOf('DeleteDBInstanceCommand')).toEqual({
        DBInstanceIdentifier: WRITER,
        SkipFinalSnapshot: true,
      });
    });
  });

  describe('names and ownership', () => {
    it('leaves room for the writer suffix in a generated name', async () => {
      script({});
      vi.spyOn(
        provider as unknown as { waitForInstanceAvailable: () => Promise<void> },
        'waitForInstanceAvailable'
      ).mockResolvedValue(undefined);
      await provider.create('ExpressCluster'.repeat(8), CLUSTER, {
        Engine: 'aurora-postgresql',
        WithExpressConfiguration: true,
      });
      const id = inputOf('CreateDBClusterCommand')?.['DBClusterIdentifier'] as string;
      // RDS refuses the create when `<cluster>-instance-1` would pass 63.
      expect(`${id}-instance-1`.length).toBeLessThanOrEqual(63);
    });

    it('keeps the full 63 characters for a cluster without express configuration', async () => {
      script({});
      await provider.create('ExpressCluster'.repeat(8), CLUSTER, { Engine: 'aurora-postgresql' });
      const id = inputOf('CreateDBClusterCommand')?.['DBClusterIdentifier'] as string;
      expect(id.length).toBe(63);
    });

    it('names it alike on the Cloud Control route, which shares the rule', () => {
      const long = 'ExpressCluster'.repeat(8);
      const express = applyDefaultNameForFallback(long, CLUSTER, { ...EXPRESS_BAG })[
        'DBClusterIdentifier'
      ] as string;
      const plain = applyDefaultNameForFallback(long, CLUSTER, { Engine: 'aurora-postgresql' })[
        'DBClusterIdentifier'
      ] as string;
      expect(`${express}-instance-1`.length).toBeLessThanOrEqual(63);
      expect(plain.length).toBe(63);
    });

    it('finds the writer of a cluster declared with uppercase letters', async () => {
      script({ [`${ID}-instance-1`]: { status: 'available', resourceId: WRITER_ID } });
      await provider.delete('Db', ID.toUpperCase(), CLUSTER, EXPRESS_BAG, {
        recordedAttributes: { [EXPRESS_WRITER_RESOURCE_ID_KEY]: WRITER_ID },
      });
      expect(names().filter((n) => n.startsWith('Delete'))).toEqual([
        'DeleteDBInstanceCommand',
        'DeleteDBClusterCommand',
      ]);
    });

    it("a failed create's cleanup leaves an instance of another cluster under the writer name", async () => {
      script({ [WRITER]: { status: 'available', resourceId: 'db-OTHER', cluster: 'other' } });
      vi.spyOn(
        provider as unknown as { waitForClusterAvailable: () => Promise<void> },
        'waitForClusterAvailable'
      ).mockRejectedValue(new Error('wait failed'));
      await expect(
        provider.create('Db', CLUSTER, { DBClusterIdentifier: ID, ...EXPRESS_BAG })
      ).rejects.toThrow(/wait failed/);
      expect(names()).not.toContain('DeleteDBInstanceCommand');
      expect(names()).toContain('DeleteDBClusterCommand');
    });

    it("leaves another cluster's instance out of a failed cleanup's recovery command", async () => {
      script({ [WRITER]: { status: 'available', resourceId: 'db-OTHER', cluster: 'other' } });
      const base = rdsSend.getMockImplementation()!;
      rdsSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'DeleteDBClusterCommand'
          ? Promise.reject(awsError('AccessDenied', 'not authorized: rds:DeleteDBCluster'))
          : base(cmd)
      );
      vi.spyOn(
        provider as unknown as { waitForClusterAvailable: () => Promise<void> },
        'waitForClusterAvailable'
      ).mockRejectedValue(new Error('wait failed'));
      await expect(
        provider.create('Db', CLUSTER, { DBClusterIdentifier: ID, ...EXPRESS_BAG })
      ).rejects.toThrow(/wait failed/);
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toMatch(/aws rds delete-db-cluster/);
      expect(warned).not.toMatch(/delete-db-instance/);
    });

    it("names the writer delete in a failed cleanup's recovery command", async () => {
      script({ [WRITER]: { status: 'available', resourceId: WRITER_ID } });
      const base = rdsSend.getMockImplementation()!;
      rdsSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'DeleteDBClusterCommand'
          ? Promise.reject(awsError('AccessDenied', 'not authorized: rds:DeleteDBCluster'))
          : base(cmd)
      );
      vi.spyOn(
        provider as unknown as { waitForClusterAvailable: () => Promise<void> },
        'waitForClusterAvailable'
      ).mockRejectedValue(new Error('wait failed'));
      await expect(
        provider.create('Db', CLUSTER, { DBClusterIdentifier: ID, ...EXPRESS_BAG })
      ).rejects.toThrow(/wait failed/);
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toMatch(
        new RegExp(`aws rds delete-db-instance --db-instance-identifier ${WRITER} --skip-final-snapshot; aws rds delete-db-cluster`)
      );
    });
  });

  describe('update', () => {
    it("carries the record's writer id over", async () => {
      script({ [WRITER]: { status: 'available', resourceId: WRITER_ID } });
      const bag = { Engine: 'aurora-postgresql', WithExpressConfiguration: true };
      const result = await provider.update('Db', ID, CLUSTER, bag, bag, {
        recordedAttributes: { [EXPRESS_WRITER_RESOURCE_ID_KEY]: WRITER_ID },
      });
      expect(result.attributes?.[EXPRESS_WRITER_RESOURCE_ID_KEY]).toBe(WRITER_ID);
    });
  });

  describe('delete', () => {
    const EXPRESS = { Engine: 'aurora-postgresql', WithExpressConfiguration: true };
    const RECORDED = { recordedAttributes: { [EXPRESS_WRITER_RESOURCE_ID_KEY]: WRITER_ID } };

    it('deletes the writer it recorded, then the cluster', async () => {
      script({ [WRITER]: { status: 'available', resourceId: WRITER_ID } });
      await provider.delete('Db', ID, CLUSTER, EXPRESS, RECORDED);

      const sent = names().filter((n) => n.startsWith('Delete'));
      expect(sent).toEqual(['DeleteDBInstanceCommand', 'DeleteDBClusterCommand']);
      expect(inputOf('DeleteDBInstanceCommand')).toEqual({
        DBInstanceIdentifier: WRITER,
        SkipFinalSnapshot: true,
      });
    });

    it('falls back to the name, as CloudFormation does, when the record holds no writer id', async () => {
      script({ [WRITER]: { status: 'available', resourceId: 'db-ANY' } });
      await provider.delete('Db', ID, CLUSTER, EXPRESS);
      expect(inputOf('DeleteDBInstanceCommand')?.['DBInstanceIdentifier']).toBe(WRITER);
    });

    it('refuses, deleting nothing, when the instance under the writer name is not the recorded one', async () => {
      script({ [WRITER]: { status: 'available', resourceId: 'db-SOMEONE-ELSE' } });
      const err = await provider.delete('Db', ID, CLUSTER, EXPRESS, RECORDED).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(String(err)).toMatch(/is not the writer express configuration created/);
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect(names().filter((n) => n.startsWith('Delete'))).toEqual([]);
    });

    it('refuses, deleting nothing, while another member is not already deleting', async () => {
      script({
        [WRITER]: { status: 'available', resourceId: WRITER_ID },
        'hand-made': { status: 'available', resourceId: 'db-HAND' },
      });
      const err = await provider.delete('Db', ID, CLUSTER, EXPRESS, RECORDED).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(String(err)).toMatch(/still has DB instance\(s\) hand-made besides the writer/);
      expect(isDeleteStarted(err)).toBe(false);
      expect(names().filter((n) => n.startsWith('Delete'))).toEqual([]);
    });

    it('goes ahead when the other member is already deleting (a template instance deleted first)', async () => {
      script({
        [WRITER]: { status: 'available', resourceId: WRITER_ID },
        'template-instance': { status: 'deleting', resourceId: 'db-T' },
      });
      await provider.delete('Db', ID, CLUSTER, EXPRESS, RECORDED);
      expect(names().filter((n) => n.startsWith('Delete'))).toEqual([
        'DeleteDBInstanceCommand',
        'DeleteDBClusterCommand',
      ]);
    });

    it('keeps the writer when the cluster has deletion protection on', async () => {
      script({ [WRITER]: { status: 'available', resourceId: WRITER_ID } }, { deletionProtection: true });
      await provider.delete('Db', ID, CLUSTER, EXPRESS, RECORDED);
      expect(names()).not.toContain('DeleteDBInstanceCommand');
      expect(names()).toContain('DeleteDBClusterCommand');
    });

    it('deletes the writer when this run turned protection off, though the read still lags', async () => {
      // The describe keeps answering protection on after the flip.
      script({ [WRITER]: { status: 'available', resourceId: WRITER_ID } }, { deletionProtection: true });
      await provider.delete('Db', ID, CLUSTER, EXPRESS, { ...RECORDED, removeProtection: true });
      expect(names()).toContain('ModifyDBClusterCommand');
      expect(names().filter((n) => n.startsWith('Delete'))).toEqual([
        'DeleteDBInstanceCommand',
        'DeleteDBClusterCommand',
      ]);
    });

    it('marks a refused cluster delete once the writer was deleted', async () => {
      script({ [WRITER]: { status: 'available', resourceId: WRITER_ID } });
      const base = rdsSend.getMockImplementation()!;
      rdsSend.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'DeleteDBClusterCommand'
          ? Promise.reject(awsError('AccessDenied', 'not authorized: rds:DeleteDBCluster'))
          : base(cmd)
      );
      const err = await provider.delete('Db', ID, CLUSTER, EXPRESS, RECORDED).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(isDeleteStarted(err)).toBe(true);
    });

    it('deletes no instance for a cluster without express configuration', async () => {
      script({ [WRITER]: { status: 'available', resourceId: WRITER_ID } });
      await provider.delete('Db', ID, CLUSTER, { Engine: 'aurora-postgresql' }, RECORDED);
      expect(names()).not.toContain('DeleteDBInstanceCommand');
    });

    it('sends only the cluster delete when the writer is already gone', async () => {
      script({});
      await provider.delete('Db', ID, CLUSTER, EXPRESS, RECORDED);
      expect(names().filter((n) => n.startsWith('Delete'))).toEqual(['DeleteDBClusterCommand']);
    });
  });
});
