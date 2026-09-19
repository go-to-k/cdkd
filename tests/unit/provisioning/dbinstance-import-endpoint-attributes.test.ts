/**
 * `import()` of an RDS / DocDB / Neptune `DBInstance` returns the attribute map
 * `create()` records (issue [#1852](https://github.com/go-to-k/cdkd/issues/1852),
 * the go-to-k/cdkd#3077 checklist row).
 *
 * It returned `attributes: {}`. The deploy engine heals a stale record by
 * re-reading through `import()`, so an empty map made the heal a no-op for the
 * one row the issue names beyond the two ARN types: a `--no-wait` create whose
 * post-create describe ran while the instance was still `creating` records no
 * `Endpoint.Address` / `Endpoint.Port`, and nothing re-recorded them.
 *
 * Both polarities: an AVAILABLE instance reports the endpoint; a `creating` one
 * reports none and the keys must be ABSENT, never `''` / `'undefined'` — the
 * resolver serves any stored value, so an empty one would shadow every later
 * heal.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockRdsSend, mockDocdbSend, mockNeptuneSend } = vi.hoisted(() => ({
  mockRdsSend: vi.fn(),
  mockDocdbSend: vi.fn(),
  mockNeptuneSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-rds', async () => ({
  ...(await vi.importActual('@aws-sdk/client-rds')),
  RDSClient: vi.fn().mockImplementation(() => ({ send: mockRdsSend })),
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

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';

const CASES = [
  ['AWS::RDS::DBInstance', () => new RDSProvider(), mockRdsSend],
  ['AWS::DocDB::DBInstance', () => new DocDBProvider(), mockDocdbSend],
  ['AWS::Neptune::DBInstance', () => new NeptuneProvider(), mockNeptuneSend],
] as const;

const input = (resourceType: string) => ({
  logicalId: 'Db',
  resourceType,
  stackName: 'S',
  region: 'us-east-1',
  properties: {},
  knownPhysicalId: 'mydb',
});

describe.each(CASES)('%s import() attributes (#1852 / #3077)', (resourceType, make, send) => {
  beforeEach(() => {
    send.mockReset();
  });

  it('reports the endpoint and ARN of an AVAILABLE instance, from the one describe', async () => {
    send.mockResolvedValue({
      DBInstances: [
        {
          DBInstanceIdentifier: 'mydb',
          DBInstanceStatus: 'available',
          DBInstanceArn: 'arn:aws:rds:us-east-1:111122223333:db:mydb',
          Endpoint: { Address: 'mydb.abc.us-east-1.rds.amazonaws.com', Port: 5432 },
        },
      ],
    });

    const result = await make().import(input(resourceType));

    expect(result).toEqual({
      physicalId: 'mydb',
      attributes: {
        'Endpoint.Address': 'mydb.abc.us-east-1.rds.amazonaws.com',
        'Endpoint.Port': '5432',
        Arn: 'arn:aws:rds:us-east-1:111122223333:db:mydb',
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps an UNASSIGNED endpoint absent while the instance is still creating', async () => {
    send.mockResolvedValue({
      DBInstances: [
        {
          DBInstanceIdentifier: 'mydb',
          DBInstanceStatus: 'creating',
          DBInstanceArn: 'arn:aws:rds:us-east-1:111122223333:db:mydb',
        },
      ],
    });

    const result = await make().import(input(resourceType));

    expect(result?.attributes).toEqual({ Arn: 'arn:aws:rds:us-east-1:111122223333:db:mydb' });
    expect(Object.hasOwn(result!.attributes!, 'Endpoint.Address')).toBe(false);
    expect(Object.hasOwn(result!.attributes!, 'Endpoint.Port')).toBe(false);
  });

  it('still answers null for an instance AWS does not have', async () => {
    const notFound = new Error('DBInstance mydb not found.');
    notFound.name = 'DBInstanceNotFoundFault';
    send.mockRejectedValue(notFound);
    expect(await make().import(input(resourceType))).toBeNull();
  });
});
