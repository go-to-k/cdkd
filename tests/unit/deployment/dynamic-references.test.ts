import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// Mock functions for AWS clients
const mockSecretsManagerSend = vi.fn();
const mockSSMSend = vi.fn();

// Mock AWS clients
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
      }),
    },
    ec2: {
      send: vi.fn().mockResolvedValue({
        AvailabilityZones: [],
      }),
    },
    secretsManager: {
      send: mockSecretsManagerSend,
    },
    ssm: {
      send: mockSSMSend,
    },
  }),
}));

describe('IntrinsicFunctionResolver - Dynamic References', () => {
  let resolver: IntrinsicFunctionResolver;

  const defaultTemplate: CloudFormationTemplate = {
    Resources: {},
  };

  const defaultContext: ResolverContext = {
    template: defaultTemplate,
    resources: {},
  };

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    mockSecretsManagerSend.mockReset();
    mockSSMSend.mockReset();
  });

  describe('resolveDynamicReferences', () => {
    it('should resolve secretsmanager reference with JSON key', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: JSON.stringify({ username: 'admin', password: 's3cr3t' }),
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:my-secret:SecretString:password::}}'
      );

      expect(result).toBe('s3cr3t');
      expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
    });

    it('should resolve secretsmanager reference without JSON key (full value)', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: 'plain-secret-value',
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:my-secret:SecretString:::}}'
      );

      expect(result).toBe('plain-secret-value');
    });

    it('should resolve SSM parameter reference', async () => {
      mockSSMSend.mockResolvedValue({
        Parameter: {
          Value: 'my-param-value',
        },
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:ssm:my-parameter}}'
      );

      expect(result).toBe('my-param-value');
      expect(mockSSMSend).toHaveBeenCalledTimes(1);
    });

    it('should resolve SSM parameter with path-style name', async () => {
      mockSSMSend.mockResolvedValue({
        Parameter: {
          Value: '/prod/db/host-value',
        },
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:ssm:/prod/db/host}}'
      );

      expect(result).toBe('/prod/db/host-value');
    });

    it('should resolve multiple dynamic references in a single string', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: JSON.stringify({ username: 'admin', password: 'p@ss' }),
      });

      mockSSMSend.mockResolvedValue({
        Parameter: {
          Value: 'db.example.com',
        },
      });

      const result = await resolver.resolveDynamicReferences(
        'host={{resolve:ssm:/db/host}}&pass={{resolve:secretsmanager:db-creds:SecretString:password::}}'
      );

      expect(result).toBe('host=db.example.com&pass=p@ss');
    });

    it('should cache resolved values and avoid repeated API calls', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: JSON.stringify({ key: 'cached-value' }),
      });

      const ref = '{{resolve:secretsmanager:my-secret:SecretString:key::}}';

      const result1 = await resolver.resolveDynamicReferences(ref);
      const result2 = await resolver.resolveDynamicReferences(ref);

      expect(result1).toBe('cached-value');
      expect(result2).toBe('cached-value');
      // Should only call the API once due to caching
      expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
    });

    it('should return string as-is when no dynamic references present', async () => {
      const result = await resolver.resolveDynamicReferences('just a normal string');
      expect(result).toBe('just a normal string');
      expect(mockSecretsManagerSend).not.toHaveBeenCalled();
      expect(mockSSMSend).not.toHaveBeenCalled();
    });

    it('should throw when secret has no SecretString', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: undefined,
      });

      await expect(
        resolver.resolveDynamicReferences(
          '{{resolve:secretsmanager:my-secret:SecretString:key::}}'
        )
      ).rejects.toThrow("does not contain a SecretString value");
    });

    it('should throw when JSON key is not found in secret', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: JSON.stringify({ other: 'value' }),
      });

      await expect(
        resolver.resolveDynamicReferences(
          '{{resolve:secretsmanager:my-secret:SecretString:missing::}}'
        )
      ).rejects.toThrow("key 'missing' not found in secret 'my-secret'");
    });

    it('should throw when JSON key is specified but secret is not valid JSON', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: 'not-json',
      });

      await expect(
        resolver.resolveDynamicReferences(
          '{{resolve:secretsmanager:my-secret:SecretString:key::}}'
        )
      ).rejects.toThrow("is not valid JSON but JSON_KEY 'key' was specified");
    });

    it('should throw when SSM parameter has no value', async () => {
      mockSSMSend.mockResolvedValue({
        Parameter: {
          Value: undefined,
        },
      });

      await expect(
        resolver.resolveDynamicReferences('{{resolve:ssm:missing-param}}')
      ).rejects.toThrow("SSM parameter 'missing-param' not found or has no value");
    });

    it('should resolve secretsmanager reference with version stage', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: 'staged-value',
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:my-secret:SecretString::AWSPREVIOUS:}}'
      );

      expect(result).toBe('staged-value');
    });

    it('should resolve secretsmanager reference with version ID', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: 'versioned-value',
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:my-secret:SecretString:::abc-123}}'
      );

      expect(result).toBe('versioned-value');
    });

    it('should resolve secretsmanager reference with ARN-based secret ID', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: JSON.stringify({ password: 'arn-secret-pass' }),
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:123456789012:secret:SecretName-XXXXX:SecretString:password::}}'
      );

      expect(result).toBe('arn-secret-pass');
      expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
      // Verify the SecretId passed to the API is the full ARN
      const callArgs = mockSecretsManagerSend.mock.calls[0]![0];
      expect(callArgs.input.SecretId).toBe(
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:SecretName-XXXXX'
      );
    });

    it('should resolve secretsmanager ARN reference without JSON key', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: 'full-secret-value',
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:123456789012:secret:MySecret-abc123:SecretString:::}}'
      );

      expect(result).toBe('full-secret-value');
    });
  });

  describe('resolveValue integration with dynamic references', () => {
    it('should resolve dynamic references in property values during resolve()', async () => {
      mockSSMSend.mockResolvedValue({
        Parameter: {
          Value: 'resolved-db-name',
        },
      });

      const properties = {
        DatabaseName: '{{resolve:ssm:/app/db-name}}',
        StaticProp: 'no-change',
      };

      const result = await resolver.resolve(properties, defaultContext);

      expect(result).toEqual({
        DatabaseName: 'resolved-db-name',
        StaticProp: 'no-change',
      });
    });

    it('should resolve dynamic references nested in objects', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: JSON.stringify({ password: 'db-pass' }),
      });

      const properties = {
        Config: {
          Password: '{{resolve:secretsmanager:db-secret:SecretString:password::}}',
        },
      };

      const result = await resolver.resolve(properties, defaultContext);

      expect(result).toEqual({
        Config: {
          Password: 'db-pass',
        },
      });
    });

    it('should resolve dynamic references in array elements', async () => {
      mockSSMSend.mockResolvedValue({
        Parameter: {
          Value: 'ssm-value',
        },
      });

      const properties = {
        Items: ['static', '{{resolve:ssm:my-param}}'],
      };

      const result = await resolver.resolve(properties, defaultContext);

      expect(result).toEqual({
        Items: ['static', 'ssm-value'],
      });
    });
  });
});
