import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';
import { NoSuchCloudFrontOriginAccessIdentity } from '@aws-sdk/client-cloudfront';

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

import { CloudFrontOAIProvider } from '../../../src/provisioning/providers/cloudfront-oai-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import {
  CreateTokenLedger,
  withCreateTokenLedger,
} from '../../../src/provisioning/providers/create-token-ledger.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';

// These cases drive create() directly, outside a withStackName scope, so the
// stack-scoped create token (go-to-k/cdkd#4428) is opted out of its guard.
beforeAll(() => {
  allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(false);
});

describe('CloudFrontOAIProvider', () => {
  let provider: CloudFrontOAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudFrontOAIProvider();
  });

  describe('create', () => {
    it('should create an OAI with Comment from config', async () => {
      mockSend.mockResolvedValueOnce({
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
          S3CanonicalUserId: 'abc123canonical',
        },
      });

      const result = await provider.create(
        'MyOAI',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: 'My OAI comment',
          },
        }
      );

      expect(result.physicalId).toBe('E1ABCDEF123456');
      expect(result.attributes).toEqual({
        Id: 'E1ABCDEF123456',
        S3CanonicalUserId: 'abc123canonical',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateCloudFrontOriginAccessIdentityCommand');
      expect(createCall.input.CloudFrontOriginAccessIdentityConfig.CallerReference).toMatch(
        /^cdkd-MyOAI-[0-9a-f]{12}$/
      );
      expect(createCall.input.CloudFrontOriginAccessIdentityConfig.Comment).toBe(
        'My OAI comment'
      );
    });

    it('scopes the CallerReference to the stack, so a second stack copy is not handed the first one\'s identity (go-to-k/cdkd#4428)', async () => {
      mockSend.mockResolvedValue({
        CloudFrontOriginAccessIdentity: { Id: 'E1', S3CanonicalUserId: 'c' },
      });
      // CDK's default OAI comment is a constant, so two copies send identical configs.
      const props = {
        CloudFrontOriginAccessIdentityConfig: { Comment: 'Allows CloudFront to reach the bucket' },
      };
      const type = 'AWS::CloudFront::CloudFrontOriginAccessIdentity';
      await withStackName('DevStack', () => provider.create('MyOAI', type, props));
      await withStackName('StagingStack', () => provider.create('MyOAI', type, props));
      await withStackName('DevStack', () => provider.create('MyOAI', type, props));

      const refs = mockSend.mock.calls.map(
        ([cmd]) => cmd.input.CloudFrontOriginAccessIdentityConfig.CallerReference
      );
      expect(refs[0]).not.toBe(refs[1]);
      // Deterministic within one stack: a retry after a lost response is
      // answered with the identity the first attempt made.
      expect(refs[0]).toBe(refs[2]);
    });

    it("folds the stack's create-token nonce into the CallerReference (go-to-k/cdkd#4438)", async () => {
      mockSend.mockResolvedValue({ CloudFrontOriginAccessIdentity: { Id: 'E1', S3CanonicalUserId: 'c' } });
      const type = 'AWS::CloudFront::CloudFrontOriginAccessIdentity';
      const props = { CloudFrontOriginAccessIdentityConfig: { Comment: 'c' } };
      let body: string | undefined;
      const ledger = () =>
        new CreateTokenLedger({
          load: async () => (body === undefined ? null : JSON.parse(body)),
          save: async (d) => {
            body = JSON.stringify(d);
          },
        });
      const deploy = (l: CreateTokenLedger) =>
        withStackName('DevStack', () => withCreateTokenLedger(l, () => provider.create('MyOAI', type, props)));

      await withStackName('DevStack', () => provider.create('MyOAI', type, props)); // no ledger
      await deploy(ledger());
      expect(Object.keys(JSON.parse(body!).sent)).toEqual(['MyOAI']);
      body = undefined; // the record and its ledger deleted: a destroy
      await deploy(ledger());

      const refs = mockSend.mock.calls.map(
        ([cmd]) => cmd.input.CloudFrontOriginAccessIdentityConfig.CallerReference
      );
      expect(refs[1]).not.toBe(refs[0]);
      expect(refs[2]).not.toBe(refs[1]);
    });

    it('should create an OAI with empty Comment when config is missing', async () => {
      mockSend.mockResolvedValueOnce({
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
          S3CanonicalUserId: 'abc123canonical',
        },
      });

      const result = await provider.create(
        'MyOAI',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        {}
      );

      expect(result.physicalId).toBe('E1ABCDEF123456');
      expect(mockSend).toHaveBeenCalledTimes(1);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.CloudFrontOriginAccessIdentityConfig.Comment).toBe('');
    });

    it('should throw ProvisioningError on failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.create('MyOAI', 'AWS::CloudFront::CloudFrontOriginAccessIdentity', {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: 'test',
          },
        })
      ).rejects.toThrow('Failed to create CloudFront OAI MyOAI');
    });
  });

  describe('update', () => {
    it('refuses an update when the identity read back carries no CallerReference, rather than guessing one (go-to-k/cdkd#4428)', async () => {
      mockSend.mockResolvedValueOnce({
        ETag: 'E1',
        CloudFrontOriginAccessIdentity: { Id: 'E1ABC', CloudFrontOriginAccessIdentityConfig: {} },
      });
      await expect(
        provider.update(
          'MyOAI',
          'E1ABC',
          'AWS::CloudFront::CloudFrontOriginAccessIdentity',
          { CloudFrontOriginAccessIdentityConfig: { Comment: 'x' } },
          {}
        )
      ).rejects.toThrow(/^GetCloudFrontOriginAccessIdentity returned no CallerReference/);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should call UpdateCloudFrontOriginAccessIdentity with the new Comment', async () => {
      // First send call: GetCloudFrontOriginAccessIdentity (fetch ETag)
      mockSend.mockResolvedValueOnce({
        ETag: 'etag-abc',
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
          S3CanonicalUserId: 'abc123canonical',
          CloudFrontOriginAccessIdentityConfig: {
            CallerReference: 'MyOAI',
            Comment: 'old comment',
          },
        },
      });
      // Second send call: UpdateCloudFrontOriginAccessIdentity
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'MyOAI',
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: 'new comment',
          },
        },
        {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: 'old comment',
          },
        }
      );

      expect(result.physicalId).toBe('E1ABCDEF123456');
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(2);

      // Verify Update command received the new comment + preserved CallerReference
      const updateCall = mockSend.mock.calls[1][0] as {
        input: {
          Id: string;
          IfMatch: string;
          CloudFrontOriginAccessIdentityConfig: { CallerReference: string; Comment: string };
        };
      };
      expect(updateCall.input.Id).toBe('E1ABCDEF123456');
      expect(updateCall.input.IfMatch).toBe('etag-abc');
      expect(updateCall.input.CloudFrontOriginAccessIdentityConfig.Comment).toBe('new comment');
      expect(updateCall.input.CloudFrontOriginAccessIdentityConfig.CallerReference).toBe('MyOAI');
    });
  });

  describe('delete', () => {
    it('should get ETag and delete OAI', async () => {
      // GetCloudFrontOriginAccessIdentity
      mockSend.mockResolvedValueOnce({
        ETag: 'E2QWRUHAPOMQZL',
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
          S3CanonicalUserId: 'abc123canonical',
        },
      });
      // DeleteCloudFrontOriginAccessIdentity
      mockSend.mockResolvedValueOnce({});

      await provider.delete(
        'MyOAI',
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity'
      );

      expect(mockSend).toHaveBeenCalledTimes(2);

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetCloudFrontOriginAccessIdentityCommand');
      expect(getCall.input.Id).toBe('E1ABCDEF123456');

      const deleteCall = mockSend.mock.calls[1][0];
      expect(deleteCall.constructor.name).toBe('DeleteCloudFrontOriginAccessIdentityCommand');
      expect(deleteCall.input.Id).toBe('E1ABCDEF123456');
      expect(deleteCall.input.IfMatch).toBe('E2QWRUHAPOMQZL');
    });

    it('should skip deletion when OAI does not exist (on Get)', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchCloudFrontOriginAccessIdentity({
          $metadata: {},
          message: 'not found',
        })
      );

      await provider.delete(
        'MyOAI',
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should handle NoSuchCloudFrontOriginAccessIdentity during Delete gracefully', async () => {
      // GetCloudFrontOriginAccessIdentity
      mockSend.mockResolvedValueOnce({
        ETag: 'E2QWRUHAPOMQZL',
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
        },
      });
      // DeleteCloudFrontOriginAccessIdentity - already gone
      mockSend.mockRejectedValueOnce(
        new NoSuchCloudFrontOriginAccessIdentity({
          $metadata: {},
          message: 'not found',
        })
      );

      await provider.delete(
        'MyOAI',
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity'
      );

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should throw ProvisioningError on unexpected failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.delete(
          'MyOAI',
          'E1ABCDEF123456',
          'AWS::CloudFront::CloudFrontOriginAccessIdentity'
        )
      ).rejects.toThrow('Failed to delete CloudFront OAI MyOAI');
    });
  });

  describe('getAttribute', () => {
    it('should return physicalId for Id attribute', async () => {
      const id = await provider.getAttribute(
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        'Id'
      );

      expect(id).toBe('E1ABCDEF123456');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should fetch S3CanonicalUserId from API', async () => {
      mockSend.mockResolvedValueOnce({
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
          S3CanonicalUserId: 'abc123canonical',
        },
      });

      const userId = await provider.getAttribute(
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        'S3CanonicalUserId'
      );

      expect(userId).toBe('abc123canonical');
      expect(mockSend).toHaveBeenCalledTimes(1);

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetCloudFrontOriginAccessIdentityCommand');
    });

    it('should throw for unsupported attribute', async () => {
      await expect(
        provider.getAttribute(
          'E1ABCDEF123456',
          'AWS::CloudFront::CloudFrontOriginAccessIdentity',
          'UnsupportedAttr'
        )
      ).rejects.toThrow('Unsupported attribute: UnsupportedAttr');
    });
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MyOai',
        resourceType: 'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    // Issue #3627: `S3CanonicalUserId` (what a bucket policy grants the OAI
    // by) is read back, as `create()` records it.
    it('records S3CanonicalUserId read back from GetCloudFrontOriginAccessIdentity', async () => {
      mockSend.mockResolvedValueOnce({
        CloudFrontOriginAccessIdentity: { Id: 'E1ABCDEF123456', S3CanonicalUserId: 'canon-123' },
      });
      const result = await provider.import(makeInput({ knownPhysicalId: 'E1ABCDEF123456' }));

      expect(result).toStrictEqual({
        physicalId: 'E1ABCDEF123456',
        attributes: { Id: 'E1ABCDEF123456', S3CanonicalUserId: 'canon-123' },
      });
      expect(mockSend.mock.calls[0]![0].input).toEqual({ Id: 'E1ABCDEF123456' });
    });

    it('propagates any other GetCloudFrontOriginAccessIdentity failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
      await expect(
        provider.import(makeInput({ knownPhysicalId: 'E1ABCDEF123456' }))
      ).rejects.toThrow('AccessDenied');
    });

    it('returns null when no OAI exists behind knownPhysicalId', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchCloudFrontOriginAccessIdentity({ message: 'gone', $metadata: {} })
      );
      const result = await provider.import(makeInput({ knownPhysicalId: 'EGONE' }));

      expect(result).toBeNull();
    });

    it('returns null when knownPhysicalId is not supplied (no auto lookup)', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
  // Nested-container guard for the `??` defaulting class (issue #1493). The
  // OAI Comment is read by INDEXING `CloudFrontOriginAccessIdentityConfig`,
  // so a malformed container silently sent a blank comment — and on update
  // that OVERWRITES the live one.
  describe('malformed CloudFrontOriginAccessIdentityConfig (issue #1493)', () => {
    it('refuses a string container on create', async () => {
      await expect(
        provider.create('MyOai', 'AWS::CloudFront::CloudFrontOriginAccessIdentity', {
          CloudFrontOriginAccessIdentityConfig: 'my comment',
        })
      ).rejects.toThrow(/CloudFrontOriginAccessIdentityConfig must be an object \(got a string\)/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a string container on update, so the live comment is not blanked', async () => {
      await expect(
        provider.update(
          'MyOai',
          'E1ABCDEF123456',
          'AWS::CloudFront::CloudFrontOriginAccessIdentity',
          { CloudFrontOriginAccessIdentityConfig: 'my comment' },
          { CloudFrontOriginAccessIdentityConfig: { Comment: 'old' } }
        )
      ).rejects.toThrow(/CloudFrontOriginAccessIdentityConfig must be an object/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses an UNRESOLVED INTRINSIC container on update for the same reason', async () => {
      // Issue #3032 widened the refusal to a shape the row above cannot reach:
      // a string fails the SHAPE test while an intrinsic PASSES it. The
      // refusal is the SAME deliberate decision (#1493) -- the fallback here
      // is `''`, which blanks the live comment -- so this pins that an
      // intrinsic inherits it rather than taking a downgrade. A review round
      // proposed exactly that downgrade; this case is what makes the reversal
      // visible if anyone applies it.
      await expect(
        provider.update(
          'MyOai',
          'E1ABCDEF123456',
          'AWS::CloudFront::CloudFrontOriginAccessIdentity',
          { CloudFrontOriginAccessIdentityConfig: { Ref: 'CommentParam' } },
          { CloudFrontOriginAccessIdentityConfig: { Comment: 'old' } }
        )
      ).rejects.toThrow(
          /CloudFrontOriginAccessIdentityConfig must be an object \(got an unresolved Ref intrinsic/
        );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('surfaces the refusal as a ProvisioningError, not a bare Error', async () => {
      const err = await provider
        .create('MyOai', 'AWS::CloudFront::CloudFrontOriginAccessIdentity', {
          CloudFrontOriginAccessIdentityConfig: 'my comment',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProvisioningError);
    });

    it('still defaults to a blank comment when the container is absent', async () => {
      mockSend.mockResolvedValueOnce({
        CloudFrontOriginAccessIdentity: { Id: 'E1ABCDEF123456', S3CanonicalUserId: 'abc' },
      });

      await provider.create('MyOai', 'AWS::CloudFront::CloudFrontOriginAccessIdentity', {});

      expect(
        mockSend.mock.calls[0][0].input.CloudFrontOriginAccessIdentityConfig.Comment
      ).toBe('');
    });
  });
});
