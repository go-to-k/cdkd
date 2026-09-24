import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';

const { mockDocdbSend, mockNeptuneSend } = vi.hoisted(() => ({
  mockDocdbSend: vi.fn(),
  mockNeptuneSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-docdb', async () => ({
  ...(await vi.importActual('@aws-sdk/client-docdb')),
  DocDBClient: vi.fn().mockImplementation(() => ({ send: mockDocdbSend })),
}));
vi.mock('@aws-sdk/client-neptune', async () => ({
  ...(await vi.importActual('@aws-sdk/client-neptune')),
  NeptuneClient: vi.fn().mockImplementation(() => ({ send: mockNeptuneSend })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';

/**
 * Issue #3650: DocDB / Neptune recorded only the RDS-style dotted keys
 * (`Endpoint.Address`, ...), which no `Fn::GetAtt` names for these services,
 * so `Fn::GetAtt [Cluster, Endpoint]` fell through to the cluster identifier.
 * Every endpoint-shaped attribute the CloudFormation schema declares must be a
 * recorded key, taken from the committed schema rather than a hand-written list.
 */
const schemaAttributes = (type: string): string[] => {
  const raw = JSON.parse(
    readFileSync(new URL(`../../fixtures/cfn-schemas/${type.replaceAll('::', '-')}.json`, import.meta.url), 'utf8')
  ) as { schema?: { readOnlyProperties?: string[] }; readOnlyProperties?: string[] };
  const ro = (raw.schema ?? raw).readOnlyProperties ?? [];
  const names = ro
    .map((p) => p.replace(/^\/properties\//, ''))
    .filter((p) => /Endpoint|Port/.test(p));
  // `AWS::DocDB::DBCluster` declares `Port` as a WRITABLE property, so the
  // schema's read-only list omits it, yet CloudFormation's `Fn::GetAtt` (and
  // CDK's `attrPort`) serve it.
  if (type === 'AWS::DocDB::DBCluster' && !names.includes('Port')) names.push('Port');
  return names;
};

const CLUSTER = {
  DBClusterIdentifier: 'c',
  Status: 'available',
  Endpoint: 'c.cluster-x.us-east-1.docdb.amazonaws.com',
  ReaderEndpoint: 'c.cluster-ro-x.us-east-1.docdb.amazonaws.com',
  Port: 27017,
  DbClusterResourceId: 'cluster-ABC',
  DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:c',
};
const INSTANCE = {
  DBInstanceIdentifier: 'i',
  DBInstanceStatus: 'available',
  DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:i',
  Endpoint: { Address: 'i.x.us-east-1.docdb.amazonaws.com', Port: 27017 },
};

describe.each([
  ['AWS::DocDB::DBCluster', () => new DocDBProvider(), mockDocdbSend, { DBClusters: [CLUSTER] }],
  ['AWS::Neptune::DBCluster', () => new NeptuneProvider(), mockNeptuneSend, { DBClusters: [CLUSTER] }],
  ['AWS::DocDB::DBInstance', () => new DocDBProvider(), mockDocdbSend, { DBInstances: [INSTANCE] }],
  ['AWS::Neptune::DBInstance', () => new NeptuneProvider(), mockNeptuneSend, { DBInstances: [INSTANCE] }],
] as const)('%s records the schema Fn::GetAtt names (issue #3650)', (type, make, send, describe) => {
  beforeEach(() => send.mockReset());

  const props = (): Record<string, unknown> =>
    type.endsWith('Cluster')
      ? { DBClusterIdentifier: 'c', MasterUsername: 'u', MasterUserPassword: 'password1234' }
      : { DBInstanceIdentifier: 'i', DBClusterIdentifier: 'c', DBInstanceClass: 'db.t3.medium' };
  const physicalId = type.endsWith('Cluster') ? 'c' : 'i';

  // Every attribute-map site: create(), update() and import() each build the
  // map, and a site reverting to the dotted-only literal must go red.
  const cases: ReadonlyArray<readonly [string, () => Promise<{ attributes?: Record<string, unknown> } | null>]> = [
    ['create()', () => make().create('X', type, props())],
    ['update()', () => make().update('X', physicalId, type, { ...props(), BackupRetentionPeriod: 3 }, props())],
    [
      'import()',
      () =>
        make().import({
          logicalId: 'X',
          resourceType: type,
          stackName: 'S',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: physicalId,
        }),
    ],
  ];

  it.each(cases)('%s records every endpoint-shaped schema attribute under its own name', async (_label, run) => {
    const names = schemaAttributes(type);
    expect(names.length).toBeGreaterThan(0);
    send.mockResolvedValue({ ...describe, DBCluster: CLUSTER, DBInstance: INSTANCE });
    const result = await run();
    for (const name of names) expect(result?.attributes).toHaveProperty([name]);
  });
});
