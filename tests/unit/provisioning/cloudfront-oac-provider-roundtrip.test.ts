import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFront: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { CloudFrontOACProvider } from '../../../src/provisioning/providers/cloudfront-oac-provider.js';

const TYPE = 'AWS::CloudFront::OriginAccessControl';
const OAC_ID = 'E1ABCDEF123456';

/**
 * Round-trip guard (docs/provider-rules.md#readcurrentstate-for-drift-detection): the snapshot
 * `readCurrentState()` produces is what `cdkd drift --revert` feeds back into
 * `update()`. A placeholder the reverse-mapper emits (`Description: ''`) must
 * therefore survive the trip to `UpdateOriginAccessControl` in a shape AWS
 * accepts — not be dropped by a truthy gate, and not be turned into a missing
 * required field by the config validator.
 */
describe('CloudFrontOACProvider read-update round-trip', () => {
  let provider: CloudFrontOACProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudFrontOACProvider();
  });

  it('round-trips a minimum-response snapshot back through update() unchanged', async () => {
    // 1) readCurrentState: AWS returns only the required fields, so the
    //    reverse-mapper fills Description with its '' placeholder.
    mockSend.mockResolvedValueOnce({
      ETag: 'etag-read',
      OriginAccessControl: {
        Id: OAC_ID,
        OriginAccessControlConfig: {
          Name: 'MyStack-MyOac-ABC123',
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        },
      },
    });

    const snapshot = await provider.readCurrentState(OAC_ID, 'MyOac', TYPE);
    expect(snapshot).toBeDefined();

    // 2) update() with that snapshot as the desired properties (the
    //    `drift --revert` shape): Get for the ETag, then Update.
    mockSend.mockResolvedValueOnce({
      ETag: 'etag-abc',
      OriginAccessControl: { Id: OAC_ID },
    });
    mockSend.mockResolvedValueOnce({});

    await provider.update('MyOac', OAC_ID, TYPE, snapshot!, {});

    const updateCall = mockSend.mock.calls[2][0];
    expect(updateCall.constructor.name).toBe('UpdateOriginAccessControlCommand');
    expect(updateCall.input.IfMatch).toBe('etag-abc');
    // Every required field survives, and the '' placeholder is passed through
    // rather than dropped (a truthy gate would have removed it).
    expect(updateCall.input.OriginAccessControlConfig).toEqual({
      Name: 'MyStack-MyOac-ABC123',
      Description: '',
      OriginAccessControlOriginType: 's3',
      SigningBehavior: 'always',
      SigningProtocol: 'sigv4',
    });
  });

  it('round-trips a fully-populated snapshot back through update() unchanged', async () => {
    mockSend.mockResolvedValueOnce({
      ETag: 'etag-read',
      OriginAccessControl: {
        Id: OAC_ID,
        OriginAccessControlConfig: {
          Name: 'MyStack-MyOac-ABC123',
          Description: 'oac for the docs bucket',
          OriginAccessControlOriginType: 'lambda',
          SigningBehavior: 'no-override',
          SigningProtocol: 'sigv4',
        },
      },
    });

    const snapshot = await provider.readCurrentState(OAC_ID, 'MyOac', TYPE);

    mockSend.mockResolvedValueOnce({ ETag: 'etag-abc', OriginAccessControl: { Id: OAC_ID } });
    mockSend.mockResolvedValueOnce({});

    await provider.update('MyOac', OAC_ID, TYPE, snapshot!, {});

    const updateCall = mockSend.mock.calls[2][0];
    expect(updateCall.input.OriginAccessControlConfig).toEqual(
      (snapshot as Record<string, unknown>)['OriginAccessControlConfig']
    );
  });
});
