/**
 * go-to-k/cdkd#7015: an RDS DB instance's `import()` read names the recorded
 * attribute keys a modification still pending under `PendingModifiedValues`
 * will move, so the stale-attribute heal serves their live value without
 * recording or stamping it. Absent when nothing that moves them is pending.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockRdsSend } = vi.hoisted(() => ({ mockRdsSend: vi.fn() }));
vi.mock('@aws-sdk/client-rds', async () => ({
  ...(await vi.importActual('@aws-sdk/client-rds')),
  RDSClient: vi.fn(() => ({ send: mockRdsSend })),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { pendingMovedAttributeKeys } from '../../../src/provisioning/providers/rds/instance-moved-attributes.js';

const INSTANCE = {
  DBInstanceIdentifier: 'mydb',
  DBInstanceStatus: 'modifying',
  Endpoint: { Address: 'mydb.x.us-east-1.rds.amazonaws.com', Port: 5432, HostedZoneId: 'Z' },
};

const importOnce = async (instance: Record<string, unknown>) => {
  mockRdsSend.mockResolvedValueOnce({ DBInstances: [instance] });
  return new RDSProvider().import({
    logicalId: 'Db',
    resourceType: 'AWS::RDS::DBInstance',
    stackName: 'S',
    region: 'us-east-1',
    properties: {},
    knownPhysicalId: 'mydb',
  });
};

describe('pending moved attribute keys (#7015)', () => {
  beforeEach(() => mockRdsSend.mockReset());

  it('names the keys each pending change moves', () => {
    expect(pendingMovedAttributeKeys({ PendingModifiedValues: { Port: 5433 } })).toEqual([
      'Endpoint.Port',
      'ListenerEndpoint.Port',
    ]);
    expect(
      pendingMovedAttributeKeys({ PendingModifiedValues: { CACertificateIdentifier: 'rds-ca-ecc384-g1' } })
    ).toEqual(['CertificateDetails.CAIdentifier', 'CertificateDetails.ValidTill']);
    expect(pendingMovedAttributeKeys({ PendingModifiedValues: { MultiAZ: false } })).toEqual([
      'SecondaryAvailabilityZone',
    ]);
    // Another pending change moves no recorded attribute.
    expect(pendingMovedAttributeKeys({ PendingModifiedValues: { AllocatedStorage: 30 } })).toEqual([]);
    expect(pendingMovedAttributeKeys({})).toEqual([]);
  });

  it('import() reports them beside the live attributes, and nothing when none is pending', async () => {
    const pending = await importOnce({ ...INSTANCE, PendingModifiedValues: { Port: 5433 } });
    // The live (old) port is still the one reported.
    expect(pending?.attributes?.['Endpoint.Port']).toBe('5432');
    expect(pending?.pendingAttributeKeys).toEqual(['Endpoint.Port', 'ListenerEndpoint.Port']);

    const settled = await importOnce({ ...INSTANCE, DBInstanceStatus: 'available' });
    expect(settled).not.toHaveProperty('pendingAttributeKeys');
  });
});
