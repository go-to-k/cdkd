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

import { RDSDBProxyEndpointProvider } from '../../../src/provisioning/providers/rds-dbproxy-endpoint-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::RDS::DBProxyEndpoint';
const EP_NAME = 'MyEndpoint';
const PROPS = {
  DBProxyName: 'AuroraProxy',
  DBProxyEndpointName: EP_NAME,
  VpcSubnetIds: ['subnet-a', 'subnet-b'],
};

async function createError(props: Record<string, unknown> = PROPS): Promise<unknown> {
  return new RDSDBProxyEndpointProvider().create('Endpoint', TYPE, props).then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

describe('RDSDBProxyEndpointProvider create marks a created-before-failure endpoint (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks the endpoint name when the endpoint enters a terminal failure state', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateDBProxyEndpoint
    mockSend.mockResolvedValueOnce({
      DBProxyEndpoints: [{ Status: 'insufficient-resource-limits' }],
    });
    const error = await createError();
    expect(createdBeforeFailure(error, 'Endpoint', TYPE)).toBe(EP_NAME);
  });

  it('marks the endpoint name when the status poll throws', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateDBProxyEndpoint
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('not authorized to perform rds:DescribeDBProxyEndpoints'), {
        name: 'AccessDenied',
      })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Endpoint', TYPE)).toBe(EP_NAME);
  });

  it('marks the endpoint name when the wait for available times out', async () => {
    // The deadline is read once at 0; every later read is past it.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(Number.MAX_SAFE_INTEGER);
    mockSend.mockResolvedValueOnce({}); // CreateDBProxyEndpoint
    const error = await createError();
    expect(String(error)).toContain('Timed out');
    expect(createdBeforeFailure(error, 'Endpoint', TYPE)).toBe(EP_NAME);
  });

  it('leaves no mark when CreateDBProxyEndpoint itself fails', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('DB proxy endpoint already exists'), {
        name: 'DBProxyEndpointAlreadyExistsFault',
      })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Endpoint', TYPE)).toBeUndefined();
  });

  it('leaves no mark on the pre-flight missing-DBProxyName refusal', async () => {
    const { DBProxyName: _omit, ...rest } = PROPS;
    const error = await createError(rest);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Endpoint', TYPE)).toBeUndefined();
  });
});
