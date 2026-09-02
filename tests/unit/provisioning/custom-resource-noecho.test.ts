import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #2274: a handler declares its response `Data` sensitive with the
// documented cfn-response `NoEcho: true` field. cdkd DECLARED that field and
// read it nowhere, so a handler-GENERATED secret was persisted verbatim into
// `state.json`.
//
// Two things are fenced here, and the second is the half that made the feature
// inert for the delivery shape this repo's own integ fixture uses:
//   1. the flag is RELAYED to the deploy engine as `noEchoAttributes`, from
//      every response shape it can arrive in, and
//   2. the SIMPLE-HANDLER synthesis — which builds a NEW envelope from two
//      named fields — carries it across instead of dropping it.
// Plus the invariant that must NOT change: `attributes` is returned in the
// CLEAR, because that is what `Fn::GetAtt` resolves to and CloudFormation
// delivers a `NoEcho` custom resource's `Data` to a dependent unmasked
// (measured against real CloudFormation on the issue thread).

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

const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:noecho-handler';
const GENERATED = 'handler-generated-secret-9f2a';

describe('CustomResourceProvider - NoEcho relay (issue #2274)', () => {
  let provider: CustomResourceProvider;

  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    provider = new CustomResourceProvider({ responseBucket: 'test-bucket' });
  });

  /** The two GetFunction polls the SDK waiters make before every Invoke. */
  const mockLambdaReady = (): void => {
    mockLambdaSend
      .mockResolvedValueOnce({ Configuration: { State: 'Active' } })
      .mockResolvedValueOnce({ Configuration: { LastUpdateStatus: 'Successful' } });
  };

  /** Queue one direct-payload invocation returning `payload`. */
  const queueDirectPayload = (payload: unknown): void => {
    mockS3Send.mockResolvedValueOnce({}); // response placeholder PutObject
    mockLambdaReady();
    mockLambdaSend.mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify(payload)) });
    mockS3Send.mockResolvedValueOnce({}); // cleanup DeleteObject
    mockS3Send.mockResolvedValueOnce({ Versions: [], DeleteMarkers: [], IsTruncated: false });
  };

  describe('the SIMPLE-HANDLER shape (no Status) — the one that DROPPED the flag', () => {
    it('relays NoEcho through the synthesized envelope on create', async () => {
      // The shape this repo's `custom-resource-getatt-data` fixture returns,
      // and the shape the CDK `custom_resources` sample handlers return.
      queueDirectPayload({
        PhysicalResourceId: 'cr-phys',
        Data: { Secret: GENERATED },
        NoEcho: true,
      });

      const result = await provider.create('Cr', 'Custom::Thing', {
        ServiceToken: SERVICE_TOKEN,
      });

      expect(result.noEchoAttributes).toBe(true);
      // ...and the value itself is UNTOUCHED: `Fn::GetAtt` must resolve to it.
      expect(result.attributes).toEqual({ Secret: GENERATED });
    });

    it('reports NOTHING when the handler sets no NoEcho (the negative case)', async () => {
      queueDirectPayload({ PhysicalResourceId: 'cr-phys', Data: { Secret: GENERATED } });

      const result = await provider.create('Cr', 'Custom::Thing', {
        ServiceToken: SERVICE_TOKEN,
      });

      expect(result.noEchoAttributes).toBeUndefined();
      expect(result.attributes).toEqual({ Secret: GENERATED });
    });

    it('does not read a non-boolean NoEcho as a declaration', async () => {
      // The payload is UNTRUSTED handler output, so a truthiness copy would
      // let `NoEcho: 'false'` mask everything.
      queueDirectPayload({
        PhysicalResourceId: 'cr-phys',
        Data: { Secret: GENERATED },
        NoEcho: 'false',
      });

      const result = await provider.create('Cr', 'Custom::Thing', {
        ServiceToken: SERVICE_TOKEN,
      });

      expect(result.noEchoAttributes).toBeUndefined();
    });
  });

  describe('the shapes that already PRESERVED the flag', () => {
    it('relays NoEcho from a full cfn-response in the direct payload', async () => {
      queueDirectPayload({
        Status: 'SUCCESS',
        PhysicalResourceId: 'cr-phys',
        Data: { Secret: GENERATED },
        NoEcho: true,
      });

      const result = await provider.create('Cr', 'Custom::Thing', {
        ServiceToken: SERVICE_TOKEN,
      });

      expect(result.noEchoAttributes).toBe(true);
      expect(result.attributes).toEqual({ Secret: GENERATED });
    });

    it('relays NoEcho from the S3 / ResponseURL envelope', async () => {
      mockS3Send.mockResolvedValueOnce({}); // placeholder PutObject
      mockLambdaReady();
      mockLambdaSend.mockResolvedValueOnce({ Payload: Buffer.from('null') });
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'cr-phys',
                Data: { Secret: GENERATED },
                NoEcho: true,
              })
            ),
        },
      });
      mockS3Send.mockResolvedValueOnce({}); // cleanup DeleteObject
      mockS3Send.mockResolvedValueOnce({ Versions: [], DeleteMarkers: [], IsTruncated: false });

      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 10_000,
      });
      const result = await asyncProvider.create('Cr', 'Custom::Thing', {
        ServiceToken: SERVICE_TOKEN,
      });

      expect(result.noEchoAttributes).toBe(true);
      expect(result.attributes).toEqual({ Secret: GENERATED });
    });
  });

  describe('update()', () => {
    it('relays NoEcho, and reports nothing when THIS response omits it', async () => {
      // `NoEcho` is per RESPONSE, so a handler that sets it on Create and
      // omits it on Update genuinely declares this response public. cdkd
      // reports what it was told rather than inferring from an earlier one.
      queueDirectPayload({
        PhysicalResourceId: 'cr-phys',
        Data: { Secret: GENERATED },
        NoEcho: true,
      });
      const masked = await provider.update('Cr', 'cr-phys', 'Custom::Thing', {
        ServiceToken: SERVICE_TOKEN,
      }, {});
      expect(masked.noEchoAttributes).toBe(true);
      expect(masked.attributes).toEqual({ Secret: GENERATED });

      queueDirectPayload({ PhysicalResourceId: 'cr-phys', Data: { Secret: GENERATED } });
      const clear = await provider.update('Cr', 'cr-phys', 'Custom::Thing', {
        ServiceToken: SERVICE_TOKEN,
      }, {});
      expect(clear.noEchoAttributes).toBeUndefined();
    });
  });
});
