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
  return ro.map((p) => p.replace(/^\/properties\//, '')).filter((p) => /Endpoint|Port/.test(p));
};

const CLUSTER = {
  DBClusterIdentifier: 'c',
  Endpoint: 'c.cluster-x.us-east-1.docdb.amazonaws.com',
  ReaderEndpoint: 'c.cluster-ro-x.us-east-1.docdb.amazonaws.com',
  Port: 27017,
  DbClusterResourceId: 'cluster-ABC',
  DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:c',
};
const INSTANCE = {
  DBInstanceIdentifier: 'i',
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

  it('import() records every endpoint-shaped schema attribute under its own name', async () => {
    const names = schemaAttributes(type);
    expect(names.length).toBeGreaterThan(0);
    send.mockResolvedValue(describe);
    const result = await make().import({
      logicalId: 'X',
      resourceType: type,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: type.endsWith('Cluster') ? 'c' : 'i',
    });
    for (const name of names) expect(result?.attributes).toHaveProperty([name]);
  });
});
