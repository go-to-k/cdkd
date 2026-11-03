/**
 * go-to-k/cdkd#5723: a freshly deployed secrets-auth `AWS::RDS::DBProxy`
 * reported phantom `Auth` drift whose two printed sides were identical.
 *
 * `readCurrentState` built each `Auth` element with every `UserAuthConfigInfo`
 * member, so the members AWS does not report for a secrets-auth entry
 * (`Description`, `UserName`) were present as `undefined`. The baseline is
 * persisted as JSON, which drops them, and the drift comparator's array-element
 * walk counts own keys: the element compared unequal, though both render the
 * same JSON.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-rds')>('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
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

import { RDSDBProxyProvider } from '../../../src/provisioning/providers/rds-dbproxy-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const PROXY_NAME = 'auroraproxy';
const SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:RdsAuroraStack-AuroraClusterSecret8E4F2BC8-AbCdEf';

// The `DescribeDBProxies` shape of the rds-aurora fixture's proxy: a
// secrets-auth entry carries no `Description` and no `UserName`.
const describeResponse = (auth: Record<string, unknown>[]) => ({
  DBProxies: [
    {
      DBProxyName: PROXY_NAME,
      DBProxyArn: 'arn:aws:rds:us-east-1:123456789012:db-proxy:prx-aaaa',
      EngineFamily: 'MYSQL',
      RoleArn: 'arn:aws:iam::123456789012:role/AuroraProxyRole',
      VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
      VpcSecurityGroupIds: ['sg-aaa'],
      RequireTLS: true,
      IdleClientTimeout: 1800,
      DebugLogging: false,
      Auth: auth,
    },
  ],
});

const SECRETS_AUTH = {
  AuthScheme: 'SECRETS',
  SecretArn: SECRET_ARN,
  IAMAuth: 'DISABLED',
  ClientPasswordAuthType: 'MYSQL_CACHING_SHA2_PASSWORD',
};

describe('RDSDBProxyProvider readCurrentState Auth (#5723)', () => {
  let provider: RDSDBProxyProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSDBProxyProvider();
  });

  const read = async (auth: Record<string, unknown>[]): Promise<Record<string, unknown>> => {
    mockSend
      .mockResolvedValueOnce(describeResponse(auth))
      .mockResolvedValueOnce({ TagList: [] }); // ListTagsForResource
    return (await provider.readCurrentState(PROXY_NAME)) as Record<string, unknown>;
  };

  it('a secrets-auth entry carries no key for the members AWS does not report', async () => {
    const result = await read([{ ...SECRETS_AUTH }]);
    const [entry] = result['Auth'] as Record<string, unknown>[];
    expect(Object.keys(entry!).sort()).toEqual([
      'AuthScheme',
      'ClientPasswordAuthType',
      'IAMAuth',
      'SecretArn',
    ]);
  });

  it('a fresh deploy reports no drift against the persisted baseline', async () => {
    // The deploy-time snapshot, as state.json holds it after the JSON write.
    const baseline = JSON.parse(JSON.stringify(await read([{ ...SECRETS_AUTH }]))) as Record<
      string,
      unknown
    >;
    const live = await read([{ ...SECRETS_AUTH }]);

    expect(calculateResourceDrift(baseline, live, { unionWalkObjects: true })).toEqual([]);
  });

  it('a template-declared Auth matches the readback', async () => {
    // The `properties` baseline: what the CDK template declares for the proxy.
    const declared = { Auth: [{ ...SECRETS_AUTH }] };
    const live = await read([{ ...SECRETS_AUTH }]);

    expect(calculateResourceDrift(declared, live)).toEqual([]);
  });

  it('a member AWS does report is kept, so a changed one is still drift', async () => {
    const baseline = JSON.parse(
      JSON.stringify(await read([{ ...SECRETS_AUTH, Description: 'app user' }]))
    ) as Record<string, unknown>;
    const live = await read([{ ...SECRETS_AUTH, Description: 'changed' }]);

    expect((live['Auth'] as Record<string, unknown>[])[0]).toMatchObject({
      Description: 'changed',
    });
    expect(calculateResourceDrift(baseline, live).map((d) => d.path)).toEqual(['Auth']);
  });

  it('an IAMAuth change on the live proxy is still drift', async () => {
    const baseline = JSON.parse(JSON.stringify(await read([{ ...SECRETS_AUTH }]))) as Record<
      string,
      unknown
    >;
    const live = await read([{ ...SECRETS_AUTH, IAMAuth: 'REQUIRED' }]);

    expect(calculateResourceDrift(baseline, live).map((d) => d.path)).toEqual(['Auth']);
  });
});
