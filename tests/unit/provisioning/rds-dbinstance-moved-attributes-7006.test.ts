// go-to-k/cdkd#7006: an in-place AWS::RDS::DBInstance update changing Port,
// CACertificateIdentifier or MultiAZ records `Endpoint.Port` /
// `ListenerEndpoint.Port`, `CertificateDetails.*` and
// `SecondaryAvailabilityZone` once RDS has applied the change, as
// CloudFormation reports the update only once nothing is pending. Measured
// (us-east-1, MySQL db.t4g.micro, 2026-11-26): the ModifyDBInstance response
// and the reads for ~60 s after it report the old port with the new one under
// `PendingModifiedValues.Port`. Under `--no-wait` an unapplied value is left
// absent and the wait is handed to the deploy (`deferReadiness`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

// A short resource deadline: a wait that never settles fails its test at once
// instead of spinning (the provider's sleep is stubbed below).
vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enclosingDeadlineRemainingMs: () => 300,
}));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn(() => ({
      send: (command: unknown) => mockSend(command),
      destroy: vi.fn(),
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
    child: vi.fn(function (this: unknown) {
      return this;
    }),
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

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import {
  withDeferredReadinessScope,
  type DeferredReadinessScope,
} from '../../../src/provisioning/deferred-readiness.js';

type Input = Record<string, unknown>;

const INSTANCE = 'AWS::RDS::DBInstance';
const ARN = 'arn:aws:rds:us-east-1:123456789012:db:db-1';

const BASE: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t4g.micro',
  Engine: 'mysql',
  AllocatedStorage: '20',
  Port: '3306',
};

const ENDPOINT = { Address: 'db-1.abc.us-east-1.rds.amazonaws.com', HostedZoneId: 'Z2R2ITUGPM61AM' };
const OLD_CERT = { CAIdentifier: 'rds-ca-rsa2048-g1', ValidTill: new Date('2027-01-01T00:00:00Z') };
const NEW_CERT = { CAIdentifier: 'rds-ca-rsa4096-g1', ValidTill: new Date('2028-01-01T00:00:00Z') };

/** The instance as measured right after ModifyDBInstance changed the port. */
const PORT_PENDING: Input = {
  DBInstanceStatus: 'available',
  Endpoint: { ...ENDPOINT, Port: 3306 },
  PendingModifiedValues: { Port: 3307 },
};
/** ~60 s later: the port moved while the instance is still `modifying`. */
const PORT_MOVED: Input = {
  DBInstanceStatus: 'modifying',
  Endpoint: { ...ENDPOINT, Port: 3307 },
  PendingModifiedValues: {},
};

let reads: Input[] = [];

/** DescribeDBInstances answers each queued read in turn (the last repeats). */
function arm(queued: Input[]): void {
  reads = [...queued];
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Input }) => {
    switch (command.constructor.name) {
      case 'DescribeDBInstancesCommand': {
        const next = reads.length > 1 ? reads.shift()! : reads[0]!;
        return Promise.resolve({
          DBInstances: [
            {
              DBInstanceIdentifier: 'db-1',
              DBInstanceArn: ARN,
              Engine: 'mysql',
              CACertificateIdentifier: OLD_CERT.CAIdentifier,
              CertificateDetails: OLD_CERT,
              MultiAZ: false,
              Endpoint: { ...ENDPOINT, Port: 3306 },
              DBInstanceStatus: 'available',
              ...next,
            },
          ],
        });
      }
      case 'ListTagsForResourceCommand':
        return Promise.resolve({ TagList: [] });
      default:
        return Promise.resolve({});
    }
  });
}

function describes(): number {
  return mockSend.mock.calls.filter(
    ([command]) => (command as { constructor: { name: string } }).constructor.name === 'DescribeDBInstancesCommand'
  ).length;
}

function scope(): DeferredReadinessScope {
  return {
    logicalId: 'Db',
    resourceType: INSTANCE,
    deferred: new Map(),
    awaitUpstreamReadiness: async () => undefined,
    awaitUpstreamReadinessRaw: async () => undefined,
    awaitDeferredResource: () => undefined,
  } as DeferredReadinessScope;
}

describe('RDS DBInstance attributes an in-place update moves late (go-to-k/cdkd#7006)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const update = (next: Input, prev: Input = BASE) =>
    provider.update('Db', 'db-1', INSTANCE, { ...next }, { ...prev });

  describe('Port', () => {
    it('waits for the new port, then records it', async () => {
      arm([PORT_PENDING, PORT_PENDING, PORT_MOVED]);
      const result = await update({ ...BASE, Port: '3307' });
      expect(result.attributes?.['Endpoint.Port']).toBe('3307');
    });

    it('records a listener endpoint port once it moved too', async () => {
      arm([
        { ...PORT_PENDING, ListenerEndpoint: { ...ENDPOINT, Port: 3306 } },
        { ...PORT_MOVED, ListenerEndpoint: { ...ENDPOINT, Port: 3307 } },
      ]);
      const result = await update({ ...BASE, Port: '3307' });
      expect(result.attributes?.['ListenerEndpoint.Port']).toBe('3307');
    });

    it('waits for a listener endpoint port that lags the endpoint port', async () => {
      arm([
        { ...PORT_MOVED, ListenerEndpoint: { ...ENDPOINT, Port: 3306 } },
        { ...PORT_MOVED, ListenerEndpoint: { ...ENDPOINT, Port: 3307 } },
      ]);
      const result = await update({ ...BASE, Port: '3307' });
      expect(result.attributes?.['ListenerEndpoint.Port']).toBe('3307');
      // Two wait reads, then the attributes read.
      expect(describes()).toBe(3);
    });

    it("waits for nothing on a cluster member, whose port is the cluster's", async () => {
      arm([PORT_PENDING]);
      const member = { ...BASE, DBClusterIdentifier: 'aurora-1' };
      await update({ ...member, Port: '3307' }, member);
      expect(describes()).toBe(1);
    });

    it('waits while the port reads new but RDS still lists it pending', async () => {
      arm([
        { Endpoint: { ...ENDPOINT, Port: 3307 }, PendingModifiedValues: { Port: 3307 } },
        { Endpoint: { ...ENDPOINT, Port: 3307 }, PendingModifiedValues: { Port: 3307 } },
        PORT_MOVED,
      ]);
      await update({ ...BASE, Port: '3307' });
      // Three wait reads, then the attributes read.
      expect(describes()).toBe(4);
    });

    it('counts a read that has not registered the change yet as unapplied', async () => {
      // Neither the endpoint nor PendingModifiedValues names 3307 yet.
      arm([{ DBInstanceStatus: 'available' }, PORT_PENDING, PORT_MOVED]);
      const result = await update({ ...BASE, Port: '3307' });
      expect(result.attributes?.['Endpoint.Port']).toBe('3307');
    });

    it('fails rather than record the old port when the change never applies', async () => {
      arm([PORT_PENDING]);
      await expect(update({ ...BASE, Port: '3307' })).rejects.toThrow(
        /Timed out waiting for DBInstance Db's port change/
      );
    });

    it('adds no read for an unchanged port, which every update re-sends', async () => {
      arm([{}]);
      const result = await update({ ...BASE, DBInstanceClass: 'db.t4g.small' });
      expect(describes()).toBe(1);
      expect(result.attributes?.['Endpoint.Port']).toBe('3306');
    });

    it('adds no wait for a template newly declaring the port the instance has', async () => {
      arm([{}]);
      const { Port: _port, ...previous } = BASE;
      const result = await update(BASE, previous);
      // The wait reads once and finds it applied; the attributes read follows.
      expect(describes()).toBe(2);
      expect(result.attributes?.['Endpoint.Port']).toBe('3306');
    });
  });

  describe('CACertificateIdentifier', () => {
    const changed = { ...BASE, CACertificateIdentifier: NEW_CERT.CAIdentifier };
    const previous = { ...BASE, CACertificateIdentifier: OLD_CERT.CAIdentifier };

    it('waits for the new certificate, and for it to leave the pending values when the rotation restarts', async () => {
      arm([
        { PendingModifiedValues: { CACertificateIdentifier: NEW_CERT.CAIdentifier } },
        {
          DBInstanceStatus: 'modifying',
          CACertificateIdentifier: NEW_CERT.CAIdentifier,
          CertificateDetails: NEW_CERT,
          PendingModifiedValues: { CACertificateIdentifier: NEW_CERT.CAIdentifier },
        },
        { CACertificateIdentifier: NEW_CERT.CAIdentifier, CertificateDetails: NEW_CERT },
      ]);
      const result = await update(
        { ...changed, CertificateRotationRestart: true },
        { ...previous, CertificateRotationRestart: true }
      );
      expect(result.attributes?.['CertificateDetails.CAIdentifier']).toBe(NEW_CERT.CAIdentifier);
      expect(result.attributes?.['CertificateDetails.ValidTill']).toBe('2028-01-01T00:00:00Z');
      expect(describes()).toBe(4);
    });

    it.each([
      ['undeclared', undefined],
      ['false', false],
    ])(
      'with CertificateRotationRestart %s, a certificate the instance has not switched to (until the next reboot) holds nothing, and the certificate in use is recorded, as CloudFormation returns it',
      async (_label, restart) => {
        // The identifier never switches: an engine that cannot rotate in place.
        arm([{ PendingModifiedValues: { CACertificateIdentifier: NEW_CERT.CAIdentifier } }]);
        const result = await update(
          { ...changed, ...(restart !== undefined && { CertificateRotationRestart: restart }) },
          previous
        );
        expect(describes()).toBe(1);
        expect(result.attributes?.['CertificateDetails.CAIdentifier']).toBe(OLD_CERT.CAIdentifier);
        expect(result.attributes?.['CertificateDetails.ValidTill']).toBe('2027-01-01T00:00:00Z');
      }
    );

    it('without a restart, beside a port change, waits for the port only', async () => {
      // The certificate never switches; the port moves on the second read.
      arm([PORT_PENDING, PORT_MOVED]);
      const result = await update(
        { ...changed, Port: '3307' },
        previous
      );
      expect(result.attributes?.['Endpoint.Port']).toBe('3307');
      expect(result.attributes?.['CertificateDetails.CAIdentifier']).toBe(OLD_CERT.CAIdentifier);
      expect(describes()).toBe(3);
    });

    it('without a restart, under --no-wait, hands the deploy no wait for the certificate', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm([{ PendingModifiedValues: { CACertificateIdentifier: NEW_CERT.CAIdentifier } }]);
      const bound = scope();
      const result = await withDeferredReadinessScope(bound, () => update(changed, previous));
      expect(result.attributes?.['CertificateDetails.CAIdentifier']).toBe(OLD_CERT.CAIdentifier);
      expect(bound.deferred.size).toBe(0);
    });

    it('without a restart, records a certificate the instance already switched to', async () => {
      arm([
        {
          CACertificateIdentifier: NEW_CERT.CAIdentifier,
          CertificateDetails: NEW_CERT,
          PendingModifiedValues: { CACertificateIdentifier: NEW_CERT.CAIdentifier },
        },
      ]);
      const result = await update(changed, previous);
      expect(describes()).toBe(1);
      expect(result.attributes?.['CertificateDetails.CAIdentifier']).toBe(NEW_CERT.CAIdentifier);
    });

    it('compares the certificate as RDS stores it, lower-cased', async () => {
      arm([{ CACertificateIdentifier: NEW_CERT.CAIdentifier, CertificateDetails: NEW_CERT }]);
      const result = await update(
        {
          ...BASE,
          CACertificateIdentifier: NEW_CERT.CAIdentifier.toUpperCase(),
          CertificateRotationRestart: true,
        },
        previous
      );
      expect(result.attributes?.['CertificateDetails.CAIdentifier']).toBe(NEW_CERT.CAIdentifier);
      expect(describes()).toBe(2);
    });
  });

  describe('MultiAZ', () => {
    it('waits for the conversion to name the standby zone, then records it', async () => {
      arm([
        { PendingModifiedValues: { MultiAZ: true } },
        // Measured: MultiAZ reads true with nothing pending about a minute
        // before RDS names the standby's zone.
        { DBInstanceStatus: 'modifying', MultiAZ: true },
        { DBInstanceStatus: 'modifying', MultiAZ: true },
        { MultiAZ: true, SecondaryAvailabilityZone: 'us-east-1b' },
      ]);
      const result = await update({ ...BASE, MultiAZ: true }, { ...BASE, MultiAZ: false });
      expect(result.attributes?.['SecondaryAvailabilityZone']).toBe('us-east-1b');
    });

    it('takes the standby zone, once named, as converted while the instance is still modifying', async () => {
      arm([
        { PendingModifiedValues: { MultiAZ: true } },
        { DBInstanceStatus: 'modifying', MultiAZ: true, SecondaryAvailabilityZone: 'us-east-1b' },
        { MultiAZ: true, SecondaryAvailabilityZone: 'us-east-1b' },
      ]);
      await update({ ...BASE, MultiAZ: true }, { ...BASE, MultiAZ: false });
      // Two wait reads, then the attributes read.
      expect(describes()).toBe(3);
    });

    it('takes an available instance with nothing pending as converted, for a configuration naming no standby zone', async () => {
      arm([{ PendingModifiedValues: { MultiAZ: true } }, { DBInstanceStatus: 'modifying', MultiAZ: true }, { MultiAZ: true }]);
      const result = await update({ ...BASE, MultiAZ: true }, { ...BASE, MultiAZ: false });
      expect(result.attributes).not.toHaveProperty('SecondaryAvailabilityZone');
      expect(describes()).toBe(4);
    });

    it('waits for a conversion back to Single-AZ to drop the standby zone', async () => {
      arm([
        { MultiAZ: true, SecondaryAvailabilityZone: 'us-east-1b', PendingModifiedValues: { MultiAZ: false } },
        { MultiAZ: false },
      ]);
      const result = await update({ ...BASE, MultiAZ: false }, { ...BASE, MultiAZ: true });
      expect(result.attributes).not.toHaveProperty('SecondaryAvailabilityZone');
      expect(describes()).toBe(3);
    });
  });

  describe('--no-wait', () => {
    beforeEach(() => {
      process.env['CDKD_NO_WAIT'] = 'true';
    });

    it('leaves an unapplied port absent and hands the same wait to the deploy', async () => {
      arm([
        { ...PORT_PENDING, ListenerEndpoint: { ...ENDPOINT, Port: 3306 } },
        { ...PORT_MOVED, ListenerEndpoint: { ...ENDPOINT, Port: 3307 } },
      ]);
      const bound = scope();
      const result = await withDeferredReadinessScope(bound, () =>
        update({ ...BASE, Port: '3307' })
      );
      expect(describes()).toBe(1);
      expect(result.attributes).not.toHaveProperty('Endpoint.Port');
      expect(result.attributes).not.toHaveProperty('ListenerEndpoint.Port');
      // What the change does not move stays recorded.
      expect(result.attributes?.['Endpoint.Address']).toBe(ENDPOINT.Address);
      expect(result.attributes?.['ListenerEndpoint.Address']).toBe(ENDPOINT.Address);
      expect([...bound.deferred.keys()]).toStrictEqual(['db-1']);

      // The deferred wait is the default mode's: it ends once the port moved.
      const entry = bound.deferred.get('db-1')!;
      await entry.wait(new AbortController().signal);
      expect(describes()).toBe(2);
    });

    it('stops the deferred wait once the deploy aborts it', async () => {
      arm([PORT_PENDING]);
      const bound = scope();
      await withDeferredReadinessScope(bound, () => update({ ...BASE, Port: '3307' }));
      const controller = new AbortController();
      controller.abort();
      await expect(bound.deferred.get('db-1')!.wait(controller.signal)).rejects.toThrow(
        /readiness wait aborted/
      );
    });

    it('records a port the read already reports applied, and defers nothing', async () => {
      arm([PORT_MOVED]);
      const bound = scope();
      const result = await withDeferredReadinessScope(bound, () =>
        update({ ...BASE, Port: '3307' })
      );
      expect(result.attributes?.['Endpoint.Port']).toBe('3307');
      expect(bound.deferred.size).toBe(0);
    });

    it('leaves the certificate details and the standby zone absent while pending', async () => {
      arm([
        {
          MultiAZ: false,
          PendingModifiedValues: { MultiAZ: true, CACertificateIdentifier: NEW_CERT.CAIdentifier },
        },
      ]);
      const bound = scope();
      const result = await withDeferredReadinessScope(bound, () =>
        update(
          {
            ...BASE,
            MultiAZ: true,
            CACertificateIdentifier: NEW_CERT.CAIdentifier,
            CertificateRotationRestart: true,
          },
          { ...BASE, MultiAZ: false, CACertificateIdentifier: OLD_CERT.CAIdentifier }
        )
      );
      expect(result.attributes).not.toHaveProperty('CertificateDetails.CAIdentifier');
      expect(result.attributes).not.toHaveProperty('CertificateDetails.ValidTill');
      expect(result.attributes).not.toHaveProperty('SecondaryAvailabilityZone');
      expect(result.attributes?.['Endpoint.Port']).toBe('3306');
      expect(bound.deferred.size).toBe(1);
    });

    it('defers nothing for an update changing none of them', async () => {
      arm([{}]);
      const bound = scope();
      const result = await withDeferredReadinessScope(bound, () =>
        update({ ...BASE, DBInstanceClass: 'db.t4g.small' })
      );
      expect(result.attributes?.['Endpoint.Port']).toBe('3306');
      expect(bound.deferred.size).toBe(0);
    });
  });
});
