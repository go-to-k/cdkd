import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NoSuchOriginAccessControl } from '@aws-sdk/client-cloudfront';

// Mock AWS clients before importing the provider
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

/** Minimal valid CFn `OriginAccessControlConfig` (what CDK's `S3BucketOrigin.withOriginAccessControl()` emits). */
function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    OriginAccessControlConfig: {
      Name: 'MyStack-MyOac-ABC123',
      OriginAccessControlOriginType: 's3',
      SigningBehavior: 'always',
      SigningProtocol: 'sigv4',
      ...overrides,
    },
  };
}

function notFound(): NoSuchOriginAccessControl {
  return new NoSuchOriginAccessControl({ $metadata: {}, message: 'not found' });
}

describe('CloudFrontOACProvider', () => {
  let provider: CloudFrontOACProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudFrontOACProvider();
  });

  describe('create', () => {
    it('creates via CreateOriginAccessControl and returns the OAC Id as physicalId', async () => {
      mockSend.mockResolvedValueOnce({
        OriginAccessControl: { Id: OAC_ID },
        ETag: 'etag-create',
      });

      const result = await provider.create('MyOac', TYPE, config({ Description: 'my oac' }));

      expect(result.physicalId).toBe(OAC_ID);
      expect(result.attributes).toEqual({ Id: OAC_ID });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateOriginAccessControlCommand');
      expect(createCall.input.OriginAccessControlConfig).toEqual({
        Name: 'MyStack-MyOac-ABC123',
        Description: 'my oac',
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      });
    });

    it('omits Description entirely when the template does not set it', async () => {
      mockSend.mockResolvedValueOnce({ OriginAccessControl: { Id: OAC_ID } });

      await provider.create('MyOac', TYPE, config());

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.OriginAccessControlConfig).not.toHaveProperty('Description');
    });

    it('passes an empty-string Description through (truthy-gate guard)', async () => {
      mockSend.mockResolvedValueOnce({ OriginAccessControl: { Id: OAC_ID } });

      await provider.create('MyOac', TYPE, config({ Description: '' }));

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.OriginAccessControlConfig.Description).toBe('');
    });

    it('throws a ProvisioningError naming every missing required config field', async () => {
      await expect(
        provider.create('MyOac', TYPE, { OriginAccessControlConfig: { Name: 'only-a-name' } })
      ).rejects.toThrow(
        /missing required field\(s\): OriginAccessControlOriginType, SigningBehavior, SigningProtocol/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects an EMPTY-STRING required field the same as a missing one', async () => {
      // `''` is what an unresolved intrinsic most often collapses into, and
      // CloudFront rejects it just as surely as an absent field — so the
      // validator has to catch it here, where the message can name the field,
      // rather than letting AWS answer with an opaque InvalidArgument. All
      // four required fields are covered; only the optional Description is
      // allowed to be `''` (see the truthy-gate guard tests).
      await expect(
        provider.create('MyOac', TYPE, {
          OriginAccessControlConfig: {
            Name: '',
            OriginAccessControlOriginType: '',
            SigningBehavior: '',
            SigningProtocol: '',
          },
        })
      ).rejects.toThrow(
        /missing required field\(s\): Name, OriginAccessControlOriginType, SigningBehavior, SigningProtocol/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('throws a ProvisioningError when the AWS call fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(provider.create('MyOac', TYPE, config())).rejects.toThrow(
        'Failed to create CloudFront Origin Access Control MyOac'
      );
    });

    it('throws a ProvisioningError when the create response carries no Id', async () => {
      mockSend.mockResolvedValueOnce({ OriginAccessControl: {} });

      await expect(provider.create('MyOac', TYPE, config())).rejects.toThrow(
        'CreateOriginAccessControl returned no OriginAccessControl.Id'
      );
    });
  });

  describe('update', () => {
    it('fetches the ETag with Get and passes it as IfMatch on Update', async () => {
      // 1) GetOriginAccessControl (ETag)
      mockSend.mockResolvedValueOnce({
        ETag: 'etag-abc',
        OriginAccessControl: {
          Id: OAC_ID,
          OriginAccessControlConfig: {
            Name: 'MyStack-MyOac-ABC123',
            Description: 'old',
            OriginAccessControlOriginType: 's3',
            SigningBehavior: 'always',
            SigningProtocol: 'sigv4',
          },
        },
      });
      // 2) UpdateOriginAccessControl
      mockSend.mockResolvedValueOnce({ ETag: 'etag-def' });

      const result = await provider.update(
        'MyOac',
        OAC_ID,
        TYPE,
        config({ Description: 'new' }),
        config({ Description: 'old' })
      );

      expect(result).toEqual({
        physicalId: OAC_ID,
        wasReplaced: false,
        attributes: { Id: OAC_ID },
      });
      expect(mockSend).toHaveBeenCalledTimes(2);

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetOriginAccessControlCommand');
      expect(getCall.input.Id).toBe(OAC_ID);

      const updateCall = mockSend.mock.calls[1][0];
      expect(updateCall.constructor.name).toBe('UpdateOriginAccessControlCommand');
      expect(updateCall.input.Id).toBe(OAC_ID);
      expect(updateCall.input.IfMatch).toBe('etag-abc');
      expect(updateCall.input.OriginAccessControlConfig.Description).toBe('new');
    });

    it('round-trips an empty-string Description to AWS (truthy-gate guard)', async () => {
      mockSend.mockResolvedValueOnce({
        ETag: 'etag-abc',
        OriginAccessControl: {
          Id: OAC_ID,
          OriginAccessControlConfig: {
            Name: 'MyStack-MyOac-ABC123',
            Description: 'a stale description',
            OriginAccessControlOriginType: 's3',
            SigningBehavior: 'always',
            SigningProtocol: 'sigv4',
          },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'MyOac',
        OAC_ID,
        TYPE,
        config({ Description: '' }),
        config({ Description: 'a stale description' })
      );

      const updateCall = mockSend.mock.calls[1][0];
      expect(updateCall.input.OriginAccessControlConfig.Description).toBe('');
    });

    it('throws a ProvisioningError when Get returns no ETag', async () => {
      mockSend.mockResolvedValueOnce({ OriginAccessControl: { Id: OAC_ID } });

      await expect(provider.update('MyOac', OAC_ID, TYPE, config(), config())).rejects.toThrow(
        'GetOriginAccessControl did not return ETag'
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('wraps AWS errors from the Update call in a ProvisioningError', async () => {
      mockSend.mockResolvedValueOnce({ ETag: 'etag-abc', OriginAccessControl: { Id: OAC_ID } });
      mockSend.mockRejectedValueOnce(new Error('PreconditionFailed'));

      await expect(provider.update('MyOac', OAC_ID, TYPE, config(), config())).rejects.toThrow(
        'Failed to update CloudFront Origin Access Control MyOac'
      );
    });

    it('re-throws a cdkd-typed error without re-labelling it (#1272)', async () => {
      // The config validator raises a ProvisioningError BEFORE any AWS call;
      // the outer catch must pass it through with its precise message.
      mockSend.mockResolvedValueOnce({ ETag: 'etag-abc', OriginAccessControl: { Id: OAC_ID } });

      await expect(
        provider.update('MyOac', OAC_ID, TYPE, { OriginAccessControlConfig: {} }, config())
      ).rejects.toThrow(/OriginAccessControlConfig is missing required field\(s\): Name/);
    });
  });

  describe('delete', () => {
    it('fetches the ETag and passes it as IfMatch on Delete', async () => {
      mockSend.mockResolvedValueOnce({ ETag: 'etag-abc', OriginAccessControl: { Id: OAC_ID } });
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyOac', OAC_ID, TYPE);

      expect(mockSend).toHaveBeenCalledTimes(2);

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetOriginAccessControlCommand');

      const deleteCall = mockSend.mock.calls[1][0];
      expect(deleteCall.constructor.name).toBe('DeleteOriginAccessControlCommand');
      expect(deleteCall.input.Id).toBe(OAC_ID);
      expect(deleteCall.input.IfMatch).toBe('etag-abc');
    });

    it('fails with a message naming the Get when it returns no ETag (never IfMatch: undefined)', async () => {
      // Mirrors the same guard on the update path. Without it, `IfMatch:
      // undefined` goes out on the wire and AWS answers with a generic
      // missing-parameter rejection that never mentions the Get — during
      // `cdkd destroy`, where the operator's next question is whether the OAC
      // is still there.
      mockSend.mockResolvedValueOnce({ OriginAccessControl: { Id: OAC_ID } });

      await expect(provider.delete('MyOac', OAC_ID, TYPE)).rejects.toThrow(
        'GetOriginAccessControl did not return ETag'
      );
      // The Delete was never attempted.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('treats NoSuchOriginAccessControl on Get as idempotent success', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await provider.delete('MyOac', OAC_ID, TYPE, undefined, { expectedRegion: 'us-east-1' });

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('treats NoSuchOriginAccessControl on Delete as idempotent success', async () => {
      mockSend.mockResolvedValueOnce({ ETag: 'etag-abc', OriginAccessControl: { Id: OAC_ID } });
      mockSend.mockRejectedValueOnce(notFound());

      await provider.delete('MyOac', OAC_ID, TYPE, undefined, { expectedRegion: 'us-east-1' });

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('refuses to treat NotFound as success when the client region differs from state', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.delete('MyOac', OAC_ID, TYPE, undefined, { expectedRegion: 'us-west-2' })
      ).rejects.toThrow(/does not match stack state region us-west-2/);
    });

    it('wraps unexpected AWS errors in a ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(provider.delete('MyOac', OAC_ID, TYPE)).rejects.toThrow(
        'Failed to delete CloudFront Origin Access Control MyOac'
      );
    });
  });

  describe('getAttribute', () => {
    it('returns the physicalId for Id without an AWS call', async () => {
      await expect(provider.getAttribute(OAC_ID, TYPE, 'Id')).resolves.toBe(OAC_ID);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('throws for an unsupported attribute', async () => {
      await expect(provider.getAttribute(OAC_ID, TYPE, 'Bogus')).rejects.toThrow(
        'Unsupported attribute: Bogus for AWS::CloudFront::OriginAccessControl'
      );
    });
  });

  describe('readCurrentState', () => {
    it('returns the AWS-current config in CFn property shape', async () => {
      mockSend.mockResolvedValueOnce({
        ETag: 'etag-abc',
        OriginAccessControl: {
          Id: OAC_ID,
          OriginAccessControlConfig: {
            Name: 'MyStack-MyOac-ABC123',
            Description: 'my oac',
            OriginAccessControlOriginType: 's3',
            SigningBehavior: 'always',
            SigningProtocol: 'sigv4',
          },
        },
      });

      const state = await provider.readCurrentState(OAC_ID, 'MyOac', TYPE);

      expect(state).toEqual({
        OriginAccessControlConfig: {
          Name: 'MyStack-MyOac-ABC123',
          Description: 'my oac',
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        },
      });
    });

    it('emits placeholders for every user-controllable key on AWS minimum response', async () => {
      // docs/provider-rules.md#readcurrentstate-for-drift-detection: an omitted key never reaches
      // observedProperties, so the comparator's keys-from-state walk could
      // never see a console-side edit to it. Description is optional AND
      // mutable, so it must always be emitted.
      mockSend.mockResolvedValueOnce({
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

      const state = (await provider.readCurrentState(OAC_ID, 'MyOac', TYPE)) as Record<
        string,
        Record<string, unknown>
      >;

      expect(Object.keys(state).sort()).toEqual(['OriginAccessControlConfig']);
      expect(Object.keys(state['OriginAccessControlConfig']!).sort()).toEqual(
        [
          'Name',
          'Description',
          'OriginAccessControlOriginType',
          'SigningBehavior',
          'SigningProtocol',
        ].sort()
      );
      expect(state['OriginAccessControlConfig']!['Description']).toBe('');
    });

    it('returns undefined when the OAC is gone', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(provider.readCurrentState(OAC_ID, 'MyOac', TYPE)).resolves.toBeUndefined();
    });

    it('returns undefined for a foreign resource type without calling AWS', async () => {
      await expect(
        provider.readCurrentState(OAC_ID, 'MyOac', 'AWS::CloudFront::Distribution')
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MyOac',
        resourceType: TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    it('verifies the supplied physical id with GetOriginAccessControl', async () => {
      mockSend.mockResolvedValueOnce({ ETag: 'etag-abc', OriginAccessControl: { Id: OAC_ID } });

      const result = await provider.import(makeInput({ knownPhysicalId: OAC_ID }));

      expect(result).toEqual({ physicalId: OAC_ID, attributes: { Id: OAC_ID } });
      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetOriginAccessControlCommand');
    });

    it('returns null when the supplied physical id does not exist', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(provider.import(makeInput({ knownPhysicalId: OAC_ID }))).resolves.toBeNull();
    });

    it('returns null without an AWS call when no physical id is supplied', async () => {
      await expect(provider.import(makeInput())).resolves.toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
