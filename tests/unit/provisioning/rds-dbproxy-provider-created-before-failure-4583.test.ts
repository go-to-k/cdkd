import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

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
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::RDS::DBProxy';
const PROXY_NAME = 'AuroraProxy';
const PROPS = {
  DBProxyName: PROXY_NAME,
  EngineFamily: 'MYSQL',
  Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db' }],
  RoleArn: 'arn:aws:iam::123456789012:role/AuroraProxyRole',
  VpcSubnetIds: ['subnet-a', 'subnet-b'],
};

async function createError(props: Record<string, unknown> = PROPS): Promise<unknown> {
  return new RDSDBProxyProvider().create('Proxy', TYPE, props).then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

describe('RDSDBProxyProvider create marks a created-before-failure proxy (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks the proxy name when the proxy enters a terminal failure state', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateDBProxy
    mockSend.mockResolvedValueOnce({ DBProxies: [{ Status: 'incompatible-network' }] });
    const error = await createError();
    expect(createdBeforeFailure(error, 'Proxy', TYPE)).toBe(PROXY_NAME);
  });

  it('marks the proxy name when the status poll throws', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateDBProxy
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('not authorized to perform rds:DescribeDBProxies'), {
        name: 'AccessDenied',
      })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Proxy', TYPE)).toBe(PROXY_NAME);
  });

  it('marks the proxy name when the wait for available times out', async () => {
    // The deadline is read once at 0; every later read is past it, so the loop
    // never polls and the timeout refusal fires.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(Number.MAX_SAFE_INTEGER);
    mockSend.mockResolvedValueOnce({}); // CreateDBProxy
    const error = await createError();
    expect(String(error)).toContain('Timed out');
    expect(createdBeforeFailure(error, 'Proxy', TYPE)).toBe(PROXY_NAME);
  });

  it('leaves no mark when CreateDBProxy itself fails', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('DB proxy already exists'), {
        name: 'DBProxyAlreadyExistsFault',
      })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Proxy', TYPE)).toBeUndefined();
  });

  it('leaves no mark on the pre-flight missing-VpcSubnetIds refusal', async () => {
    const { VpcSubnetIds: _omit, ...rest } = PROPS;
    const error = await createError(rest);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Proxy', TYPE)).toBeUndefined();
  });
});
