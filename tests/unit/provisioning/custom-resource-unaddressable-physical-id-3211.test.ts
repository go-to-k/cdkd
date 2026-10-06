import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3211: a handler's `PhysicalResourceId` that cdkd could not
// address later (whitespace-only; a non-string one is refused when the
// response is parsed) is read as ABSENT, the
// fallback an empty one always took. Recorded verbatim it made every later
// UPDATE of the resource refused and every DELETE skipped; on UPDATE a
// whitespace id also read as a REPLACEMENT of the current one.

const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:id-handler';

describe('CustomResourceProvider - an unaddressable PhysicalResourceId (go-to-k/cdkd#3211)', () => {
  let provider: CustomResourceProvider;

  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    provider = new CustomResourceProvider({ responseBucket: 'test-bucket' });
  });

  const mockLambdaReady = (): void => {
    mockLambdaSend
      .mockResolvedValueOnce({ Configuration: { State: 'Active' } })
      .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } });
  };

  const queueDirectPayload = (payload: unknown): void => {
    mockS3Send.mockResolvedValueOnce({});
    mockLambdaReady();
    mockLambdaSend.mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify(payload)) });
    mockS3Send.mockResolvedValueOnce({});
    mockS3Send.mockResolvedValueOnce({ Versions: [], DeleteMarkers: [], IsTruncated: false });
  };

  for (const [label, id] of [
    ['a whitespace-only', '   '],
    ['an empty', ''],
  ] as Array<[string, unknown]>) {
    it(`create records the logical id for ${label} PhysicalResourceId`, async () => {
      queueDirectPayload({ Status: 'SUCCESS', PhysicalResourceId: id, Data: { A: 'x' } });
      const result = await provider.create('Cr', 'Custom::Thing', { ServiceToken: SERVICE_TOKEN });
      expect(result.physicalId).toBe('Cr');
    });

    it(`update keeps the current id, not a replacement, for ${label} PhysicalResourceId`, async () => {
      queueDirectPayload({ Status: 'SUCCESS', PhysicalResourceId: id, Data: { A: 'x' } });
      const result = await provider.update(
        'Cr',
        'cr-phys',
        'Custom::Thing',
        { ServiceToken: SERVICE_TOKEN },
        {}
      );
      expect(result.physicalId).toBe('cr-phys');
      expect(result.wasReplaced).toBe(false);
    });
  }

  it('control: a usable PhysicalResourceId is recorded as given', async () => {
    queueDirectPayload({ Status: 'SUCCESS', PhysicalResourceId: 'given-id', Data: {} });
    const created = await provider.create('Cr', 'Custom::Thing', { ServiceToken: SERVICE_TOKEN });
    expect(created.physicalId).toBe('given-id');
    queueDirectPayload({ Status: 'SUCCESS', PhysicalResourceId: 'new-id', Data: {} });
    const updated = await provider.update(
      'Cr',
      'cr-phys',
      'Custom::Thing',
      { ServiceToken: SERVICE_TOKEN },
      {}
    );
    expect(updated.physicalId).toBe('new-id');
    expect(updated.wasReplaced).toBe(true);
  });
});
