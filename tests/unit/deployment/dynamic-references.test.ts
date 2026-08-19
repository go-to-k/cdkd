import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
  dynamicReferenceRetryDelays,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { redactSecretsForState } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

// Mock logger. The spies are module-level rather than created fresh inside the
// factory so a test can ASSERT on them — `getLogger()` is called per resolver
// instance, and a factory returning a new object each time makes the warn
// unobservable. The unclassified-Type warning (issue #1901) is the only signal
// that a parameter silently changed what state stores, so it needs an assertion.
const mockLoggerWarn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockLoggerWarn,
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
    mockLoggerWarn.mockReset();
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
          Type: 'String',
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
          Type: 'String',
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
          Type: 'String',
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

    // Whole-secret form: ":SecretString" sits at the END of the reference with NO trailing
    // colon and no JSON_KEY. This is the CFn form CDK emits for the whole secret value.
    // Regression: previously the trailing-colon-only delimiter check missed it and leaked
    // ":SecretString" into the secret id (SecretId="my-secret:SecretString"), which AWS
    // rejected as an invalid secret name.
    it('should resolve secretsmanager whole-secret form (no JSON key, no trailing colon)', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: 'whole-secret-value',
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:my-secret:SecretString}}'
      );

      expect(result).toBe('whole-secret-value');
      expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
      // The SecretId must be the bare name, NOT "my-secret:SecretString".
      const callArgs = mockSecretsManagerSend.mock.calls[0]![0];
      expect(callArgs.input.SecretId).toBe('my-secret');
      // Whole-secret form defaults to the AWSCURRENT stage and carries no version id.
      expect(callArgs.input.VersionStage).toBe('AWSCURRENT');
      expect(callArgs.input.VersionId).toBeUndefined();
    });

    it('should resolve secretsmanager whole-secret form with an ARN secret id', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: 'whole-arn-secret-value',
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:123456789012:secret:MySecret-abc123:SecretString}}'
      );

      expect(result).toBe('whole-arn-secret-value');
      const callArgs = mockSecretsManagerSend.mock.calls[0]![0];
      expect(callArgs.input.SecretId).toBe(
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:MySecret-abc123'
      );
    });

    it('should not split a secret name that merely contains ":SecretString" mid-name (whole-secret)', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: 'tricky-secret-value',
      });

      // Name embeds ":SecretString" but the reference still ends with the real ":SecretString"
      // type segment. Only the END-anchored segment is the delimiter.
      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:my:SecretStringName:SecretString}}'
      );

      expect(result).toBe('tricky-secret-value');
      const callArgs = mockSecretsManagerSend.mock.calls[0]![0];
      expect(callArgs.input.SecretId).toBe('my:SecretStringName');
    });

    it('should resolve secretsmanager whole-secret form with a JSON key extracted', async () => {
      // Regression guard: the whole-secret-form fix must not change the JSON-key path.
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: JSON.stringify({ username: 'admin', password: 'json-key-pass' }),
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:my-secret:SecretString:password}}'
      );

      expect(result).toBe('json-key-pass');
      const callArgs = mockSecretsManagerSend.mock.calls[0]![0];
      expect(callArgs.input.SecretId).toBe('my-secret');
    });

    it('should resolve secretsmanager whole-secret form via SecretBinary type segment', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: 'binary-segment-value',
      });

      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:my-secret:SecretBinary}}'
      );

      expect(result).toBe('binary-segment-value');
      const callArgs = mockSecretsManagerSend.mock.calls[0]![0];
      expect(callArgs.input.SecretId).toBe('my-secret');
    });

    it('should not split a secret name that merely contains ":SecretBinary" mid-name (whole-secret)', async () => {
      mockSecretsManagerSend.mockResolvedValue({
        SecretString: 'tricky-binary-value',
      });

      // Symmetric to the SecretString mid-name guard: only the END-anchored
      // ":SecretBinary" segment is the delimiter, not the one embedded in the name.
      const result = await resolver.resolveDynamicReferences(
        '{{resolve:secretsmanager:my:SecretBinaryName:SecretBinary}}'
      );

      expect(result).toBe('tricky-binary-value');
      const callArgs = mockSecretsManagerSend.mock.calls[0]![0];
      expect(callArgs.input.SecretId).toBe('my:SecretBinaryName');
    });
  });

  describe('resolveValue integration with dynamic references', () => {
    it('should resolve dynamic references in property values during resolve()', async () => {
      mockSSMSend.mockResolvedValue({
        Parameter: {
          Value: 'resolved-db-name',
          Type: 'String',
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
          Type: 'String',
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

  describe('secret recording (GHSA fix)', () => {
    it('records the resolved secretsmanager plaintext -> expression into recordedSecretValues', async () => {
      mockSecretsManagerSend.mockResolvedValue({ SecretString: 'super-secret-plaintext' });
      const recordedSecretValues = new Map<string, string>();
      const expr = '{{resolve:secretsmanager:my-secret:SecretString:::}}';

      const result = await resolver.resolveDynamicReferences(expr, {
        ...defaultContext,
        recordedSecretValues,
      });

      expect(result).toBe('super-secret-plaintext');
      expect(recordedSecretValues.get('super-secret-plaintext')).toBe(expr);
    });

    it('does NOT record a plain ssm reference (public config, not a secret)', async () => {
      mockSSMSend.mockResolvedValue({ Parameter: { Value: 'public-config', Type: 'String' } });
      const recordedSecretValues = new Map<string, string>();

      await resolver.resolveDynamicReferences('{{resolve:ssm:/db/host}}', {
        ...defaultContext,
        recordedSecretValues,
      });

      expect(recordedSecretValues.size).toBe(0);
    });

    it('records a secret via resolve() through a nested property (Fn::Sub embedded)', async () => {
      mockSecretsManagerSend.mockResolvedValue({ SecretString: 'embedded-secret' });
      const recordedSecretValues = new Map<string, string>();

      const result = await resolver.resolve(
        { Url: { 'Fn::Sub': 'pw={{resolve:secretsmanager:s:SecretString:::}}' } },
        { ...defaultContext, recordedSecretValues }
      );

      expect(result).toEqual({ Url: 'pw=embedded-secret' });
      expect(recordedSecretValues.get('embedded-secret')).toBe(
        '{{resolve:secretsmanager:s:SecretString:::}}'
      );
    });

    it('leaves {{resolve:...}} unresolved and makes no AWS call when skipDynamicReferences is set', async () => {
      const recordedSecretValues = new Map<string, string>();
      const expr = '{{resolve:secretsmanager:my-secret:SecretString:::}}';

      const result = await resolver.resolve(
        { ClientSecret: expr },
        { ...defaultContext, recordedSecretValues, skipDynamicReferences: true }
      );

      expect(result).toEqual({ ClientSecret: expr });
      expect(mockSecretsManagerSend).not.toHaveBeenCalled();
      expect(recordedSecretValues.size).toBe(0);
    });

    it('still resolves plain {{resolve:ssm:...}} when skipDynamicReferences is set (only secrets are skipped)', async () => {
      // skipDynamicReferences skips SECRET references (secretsmanager) so a
      // diff / no-op compare does not fetch a secret or re-persist plaintext,
      // but plain ssm is public config that state stores RESOLVED — skipping
      // it would make every ssm-bearing resource a perpetual spurious UPDATE.
      mockSSMSend.mockResolvedValue({ Parameter: { Value: 'my-param-value', Type: 'String' } });
      const secretExpr = '{{resolve:secretsmanager:my-secret:SecretString:::}}';
      const recordedSecretValues = new Map<string, string>();

      const result = await resolver.resolve(
        { Config: '{{resolve:ssm:/prod/db/host}}', ClientSecret: secretExpr },
        { ...defaultContext, recordedSecretValues, skipDynamicReferences: true }
      );

      // ssm resolved, secret left as the unresolved expression.
      expect(result).toEqual({
        Config: 'my-param-value',
        ClientSecret: secretExpr,
      });
      expect(mockSSMSend).toHaveBeenCalledTimes(1);
      expect(mockSecretsManagerSend).not.toHaveBeenCalled();
      expect(recordedSecretValues.size).toBe(0);
    });
  });

  // Issue #1901: a SecureString parameter reached through the PLAIN
  // `{{resolve:ssm:...}}` form decrypts to a real secret, so it must be treated
  // exactly like a `{{resolve:secretsmanager:...}}` value — plaintext to the
  // provider, unresolved expression to state — while a `String` / `StringList`
  // parameter stays public config and keeps being stored RESOLVED.
  describe('SecureString ssm redaction (issue #1901)', () => {
    const secureExpr = '{{resolve:ssm:/prod/db/password}}';

    /** The `WithDecryption` value of the Nth GetParameter call. */
    const decryptionOfCall = (n: number): unknown =>
      (mockSSMSend.mock.calls[n]![0] as { input: { WithDecryption?: unknown } }).input
        .WithDecryption;

    it('records a SecureString parameter as a secret and resolves it to plaintext', async () => {
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: 'decrypted-password', Type: 'SecureString' },
      });
      const recordedSecretValues = new Map<string, string>();

      const result = await resolver.resolveDynamicReferences(secureExpr, {
        ...defaultContext,
        recordedSecretValues,
      });

      // The provider still receives the concrete value...
      expect(result).toBe('decrypted-password');
      // ...and the state-persist choke point learns how to redact it back.
      expect(recordedSecretValues.get('decrypted-password')).toBe(secureExpr);
      expect(decryptionOfCall(0)).toBe(true);
    });

    it('does NOT record a String parameter (public config, stored resolved)', async () => {
      mockSSMSend.mockResolvedValue({ Parameter: { Value: 'public-config', Type: 'String' } });
      const recordedSecretValues = new Map<string, string>();

      const result = await resolver.resolveDynamicReferences('{{resolve:ssm:/db/host}}', {
        ...defaultContext,
        recordedSecretValues,
      });

      expect(result).toBe('public-config');
      expect(recordedSecretValues.size).toBe(0);
    });

    it('does NOT record a StringList parameter', async () => {
      mockSSMSend.mockResolvedValue({ Parameter: { Value: 'a,b,c', Type: 'StringList' } });
      const recordedSecretValues = new Map<string, string>();

      await resolver.resolveDynamicReferences('{{resolve:ssm:/db/hosts}}', {
        ...defaultContext,
        recordedSecretValues,
      });

      expect(recordedSecretValues.size).toBe(0);
    });

    it('leaves a SecureString reference UNRESOLVED on the diff path, fetching only its type', async () => {
      // State holds the expression for a SecureString, so the diff must compare
      // expression-vs-expression. The type is not knowable without asking AWS,
      // so the lookup still happens — but with WithDecryption:false, which
      // returns the ENCRYPTED blob and never the plaintext.
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: 'AQICAHh-ciphertext-blob', Type: 'SecureString' },
      });
      const recordedSecretValues = new Map<string, string>();

      const result = await resolver.resolve(
        { Password: secureExpr },
        { ...defaultContext, recordedSecretValues, skipDynamicReferences: true }
      );

      expect(result).toEqual({ Password: secureExpr });
      expect(decryptionOfCall(0)).toBe(false);
      // Exactly ONE call: learning the type is all this path may do. Without
      // this pin, an implementation that classifies with WithDecryption:false
      // and THEN fetches the plaintext to cache it would still satisfy every
      // other assertion here.
      expect(mockSSMSend).toHaveBeenCalledTimes(1);
      // The ciphertext is neither substituted nor recorded as a secret.
      expect(recordedSecretValues.size).toBe(0);
    });

    it('still resolves a String parameter on the diff path (unchanged behavior)', async () => {
      mockSSMSend.mockResolvedValue({ Parameter: { Value: 'my-param-value', Type: 'String' } });

      const result = await resolver.resolve(
        { Config: '{{resolve:ssm:/prod/db/host}}' },
        { ...defaultContext, skipDynamicReferences: true }
      );

      expect(result).toEqual({ Config: 'my-param-value' });
      expect(decryptionOfCall(0)).toBe(false);
    });

    it('never caches the ciphertext: the deploy pass after a diff pass resolves the plaintext', async () => {
      // The diff pass must not poison the cache with the encrypted blob, or the
      // provider would receive ciphertext on the very next resolution.
      mockSSMSend
        .mockResolvedValueOnce({
          Parameter: { Value: 'AQICAHh-ciphertext-blob', Type: 'SecureString' },
        })
        .mockResolvedValueOnce({
          Parameter: { Value: 'decrypted-password', Type: 'SecureString' },
        });

      const diffed = await resolver.resolveDynamicReferences(secureExpr, {
        ...defaultContext,
        skipDynamicReferences: true,
      });
      expect(diffed).toBe(secureExpr);

      const recordedSecretValues = new Map<string, string>();
      const deployed = await resolver.resolveDynamicReferences(secureExpr, {
        ...defaultContext,
        recordedSecretValues,
      });

      expect(deployed).toBe('decrypted-password');
      expect(recordedSecretValues.get('decrypted-password')).toBe(secureExpr);
      expect(mockSSMSend).toHaveBeenCalledTimes(2);
      expect(decryptionOfCall(0)).toBe(false);
      expect(decryptionOfCall(1)).toBe(true);
    });

    it('short-circuits a later diff pass with NO AWS call once the type is known', async () => {
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: 'AQICAHh-ciphertext-blob', Type: 'SecureString' },
      });

      const skipContext = { ...defaultContext, skipDynamicReferences: true };
      const first = await resolver.resolveDynamicReferences(secureExpr, skipContext);
      const second = await resolver.resolveDynamicReferences(secureExpr, skipContext);

      // Only the FIRST pass had to ask AWS for the parameter's type...
      expect(mockSSMSend).toHaveBeenCalledTimes(1);
      // ...and the short-circuit must return the EXPRESSION, not an empty
      // string / undefined, or the comparison silently comes out equal.
      expect(first).toBe(secureExpr);
      expect(second).toBe(secureExpr);
    });

    it('re-records the secret on the cache-hit path for a fresh per-resource map', async () => {
      // Two resources referencing the same SecureString each get their own
      // recordedSecretValues map (the deploy engine's per-resource redaction),
      // so the cached value must be re-recorded rather than silently reused.
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: 'decrypted-password', Type: 'SecureString' },
      });

      const first = new Map<string, string>();
      await resolver.resolveDynamicReferences(secureExpr, {
        ...defaultContext,
        recordedSecretValues: first,
      });

      const second = new Map<string, string>();
      const result = await resolver.resolveDynamicReferences(secureExpr, {
        ...defaultContext,
        recordedSecretValues: second,
      });

      expect(result).toBe('decrypted-password');
      expect(second.get('decrypted-password')).toBe(secureExpr);
      expect(mockSSMSend).toHaveBeenCalledTimes(1);
    });

    it('records a SecureString embedded in an Fn::Sub result', async () => {
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: 'decrypted-password', Type: 'SecureString' },
      });
      const recordedSecretValues = new Map<string, string>();

      const result = await resolver.resolve(
        { Url: { 'Fn::Sub': `pw=${secureExpr}` } },
        { ...defaultContext, recordedSecretValues }
      );

      expect(result).toEqual({ Url: 'pw=decrypted-password' });
      expect(recordedSecretValues.get('decrypted-password')).toBe(secureExpr);
    });

    // The predicate names the PUBLIC types rather than testing for
    // `=== 'SecureString'`, so anything it cannot positively classify as public
    // is treated as a secret. Testing the other way round would persist
    // plaintext for every one of these — the disclosure the fix exists to close.
    it.each([
      ['an absent Type', undefined],
      ['an unrecognized Type', 'FutureSecretType'],
      ['a differently-cased Type', 'securestring'],
    ])('fails CLOSED and treats %s as a secret', async (_label, type) => {
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: 'unclassified-value', ...(type === undefined ? {} : { Type: type }) },
      });
      const recordedSecretValues = new Map<string, string>();

      await resolver.resolveDynamicReferences(secureExpr, {
        ...defaultContext,
        recordedSecretValues,
      });

      expect(recordedSecretValues.get('unclassified-value')).toBe(secureExpr);
      // The warn is the ONLY signal that this parameter silently changed what
      // state stores, so treating-as-secret without saying so is its own defect.
      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('unrecognized Type');
      expect(warned).toContain(type === undefined ? '(absent)' : String(type));
    });

    // `String.replace` interprets `$&` / "$`" / `$'` / `$1` inside a replacement
    // STRING. A secret is exactly the kind of value that legitimately contains
    // `$`, and `$&` would splice the matched `{{resolve:...}}` expression back
    // INTO the value shipped to AWS — corrupting the credential and leaking the
    // expression into it. Covers the fresh-resolve and the cache-hit arm.
    it.each([
      ['ab$&cd', 'a dollar-ampersand'],
      ["x$'y", 'a dollar-apostrophe'],
      ['p$1q', 'a dollar-digit'],
    ])('substitutes %s (%s) verbatim, on both the fresh and cached arms', async (plaintext) => {
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: plaintext, Type: 'SecureString' },
      });

      const fresh = await resolver.resolveDynamicReferences(`pw=${secureExpr}`, defaultContext);
      expect(fresh).toBe(`pw=${plaintext}`);

      const cached = await resolver.resolveDynamicReferences(`pw=${secureExpr}`, defaultContext);
      expect(cached).toBe(`pw=${plaintext}`);
      expect(mockSSMSend).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['SecureString', 'SecureString'],
      ['String', 'String'],
      ['StringList', 'StringList'],
    ])('does NOT warn for the recognized Type %s', async (_label, type) => {
      // Pairs with the fail-closed cases above: without this, an
      // always-warn implementation would satisfy them while making the
      // warning meaningless noise on every ordinary deploy.
      mockSSMSend.mockResolvedValue({ Parameter: { Value: 'v-known', Type: type } });

      await resolver.resolveDynamicReferences(secureExpr, defaultContext);

      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).not.toContain('unrecognized Type');
    });

    it('RETRACTS a stale secure verdict when a later lookup reports a public type', async () => {
      // The verdict used to be raise-only, so one transient unclassifiable
      // `Type` pinned "secret" for the process — and a pinned PUBLIC value then
      // becomes a redaction NEEDLE that rewrites any string containing it.
      mockSSMSend
        .mockResolvedValueOnce({ Parameter: { Value: 'prod' } }) // no Type -> fail-closed
        .mockResolvedValueOnce({ Parameter: { Value: 'prod', Type: 'String' } });

      const first = new Map<string, string>();
      await resolver.resolveDynamicReferences(secureExpr, {
        ...defaultContext,
        recordedSecretValues: first,
      });
      expect(first.get('prod')).toBe(secureExpr); // treated as secret this pass

      // The next pass asks AWS again with NO reset in between: a value judged
      // secret from a `Type` too anomalous to memoize is not cached either
      // (issue #1933), which is what lets a definitive public answer arrive and
      // clear the verdict.
      const second = new Map<string, string>();
      const result = await resolver.resolveDynamicReferences(secureExpr, {
        ...defaultContext,
        recordedSecretValues: second,
      });

      expect(result).toBe('prod');
      // NOT recorded — otherwise `prod` becomes a needle and redaction would
      // rewrite an unrelated `my-prod-bucket` in the same resource.
      expect(second.size).toBe(0);
      expect(mockSSMSend).toHaveBeenCalledTimes(2);
    });

    it('does not PIN an unclassifiable type — the next pass re-asks', async () => {
      // Only a definitive SecureString is memoized, so an anomalous response
      // cannot silently become a permanent verdict.
      mockSSMSend.mockResolvedValue({ Parameter: { Value: 'AQICAHh-blob' } });
      const skipContext = { ...defaultContext, skipDynamicReferences: true };

      await resolver.resolveDynamicReferences(secureExpr, skipContext);
      await resolver.resolveDynamicReferences(secureExpr, skipContext);

      // Contrast with the definitive-SecureString case, which short-circuits
      // to a single call.
      expect(mockSSMSend).toHaveBeenCalledTimes(2);
    });

    it('clears the SecureString verdict on reset, so a later pass re-asks AWS', async () => {
      // The verdict store is process-global (the resolved VALUES are not — they
      // live on the resolver instance since issue #1933), so the process-global
      // reset must clear it: keeping it would let a stale classification decide
      // secret-ness for a reference this call just asked to forget.
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: 'AQICAHh-ciphertext-blob', Type: 'SecureString' },
      });
      const skipContext = { ...defaultContext, skipDynamicReferences: true };

      await resolver.resolveDynamicReferences(secureExpr, skipContext);
      expect(mockSSMSend).toHaveBeenCalledTimes(1);
      // Without the reset this second pass short-circuits with no AWS call.
      await resolver.resolveDynamicReferences(secureExpr, skipContext);
      expect(mockSSMSend).toHaveBeenCalledTimes(1);

      resetAccountInfoCache();

      await resolver.resolveDynamicReferences(secureExpr, skipContext);
      expect(mockSSMSend).toHaveBeenCalledTimes(2);
    });

    it('redacts the resolved SecureString back to its expression for persisted state', async () => {
      // End-to-end with the state-persist choke point's helper: what AWS is
      // handed and what state records must differ.
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: 'decrypted-password', Type: 'SecureString' },
      });
      const recordedSecretValues = new Map<string, string>();

      const resolved = await resolver.resolve(
        { Password: secureExpr, Endpoint: 'db.example.com' },
        { ...defaultContext, recordedSecretValues }
      );

      expect(resolved).toEqual({ Password: 'decrypted-password', Endpoint: 'db.example.com' });
      expect(redactSecretsForState(resolved, recordedSecretValues)).toEqual({
        Password: secureExpr,
        Endpoint: 'db.example.com',
      });
    });
  });
  // The resolved-value cache lives on the RESOLVER INSTANCE, not on the module
  // (issue #1933). It used to be a process-global map keyed by the expression
  // alone, so its key and its lifetime were both narrower than the values they
  // stood for: no region component, and no reset between stacks.
  describe('resolved-value cache scope (issue #1933)', () => {
    const sharedSecretExpr = '{{resolve:secretsmanager:shared/db:SecretString}}';
    const sharedSsmExpr = '{{resolve:ssm:/shared/db/password}}';

    // SCOPE NOTE: both resolvers here share ONE mocked ambient client, so the
    // region dimension is SIMULATED — these cases prove per-RESOLVER isolation,
    // not region-correct lookup. A hypothetical global cache keyed by
    // `expression + region` would satisfy every assertion below. The lookup
    // genuinely going to the resolver's own region is the subject of
    // `dynamic-reference-region-scoped-clients.test.ts` (issue #1957), which
    // fakes the SDK client CLASSES rather than `getAwsClients()` precisely so
    // that the region a client was built with becomes observable; the real-AWS
    // cover is `tests/integration/dynamic-ref-cross-region`.

    it('does not serve one region resolution to a resolver built for another region', async () => {
      // Secrets Manager secrets are REGIONAL: the same NAME in two regions is
      // two different secrets, routinely two different credentials. With the
      // process-global map the first region to resolve the expression won it
      // for every later stack in every other region.
      mockSecretsManagerSend
        .mockResolvedValueOnce({ SecretString: 'virginia-password' })
        .mockResolvedValueOnce({ SecretString: 'tokyo-password' });

      const virginia = new IntrinsicFunctionResolver('us-east-1');
      const tokyo = new IntrinsicFunctionResolver('ap-northeast-1');

      expect(await virginia.resolveDynamicReferences(sharedSecretExpr, defaultContext)).toBe(
        'virginia-password'
      );
      expect(await tokyo.resolveDynamicReferences(sharedSecretExpr, defaultContext)).toBe(
        'tokyo-password'
      );
      expect(mockSecretsManagerSend).toHaveBeenCalledTimes(2);

      // The OTHER polarity of the same guard: isolation is between resolvers,
      // not per call. A second reference from the SAME resolver must still be
      // served from its own cache, or the fix would have simply disabled
      // caching (and every one of these lookups is a billed API call).
      expect(await virginia.resolveDynamicReferences(sharedSecretExpr, defaultContext)).toBe(
        'virginia-password'
      );
      expect(mockSecretsManagerSend).toHaveBeenCalledTimes(2);
    });

    it("records the secret into the SECOND stack's own map (the scrub --all clean report)", async () => {
      // `cdkd scrub --all` builds one resolver per stack and one secrets map
      // per resource. With the process-global cache, stack B's resolution
      // cache-HIT and the hit arm re-recorded only what it could still prove
      // secret — an ssm parameter whose `Type` came back unclassifiable is
      // never pinned in the verdict store, so B's map stayed empty and the scan
      // found nothing to redact. B was reported clean while its state held the
      // plaintext.
      mockSSMSend.mockResolvedValue({ Parameter: { Value: 'unclassified-secret' } });

      const stackA = new IntrinsicFunctionResolver('us-east-1');
      const stackB = new IntrinsicFunctionResolver('us-east-1');

      const aSecrets = new Map<string, string>();
      await stackA.resolveDynamicReferences(sharedSsmExpr, {
        ...defaultContext,
        recordedSecretValues: aSecrets,
      });
      expect(aSecrets.get('unclassified-secret')).toBe(sharedSsmExpr);

      const bSecrets = new Map<string, string>();
      const bResolved = await stackB.resolveDynamicReferences(sharedSsmExpr, {
        ...defaultContext,
        recordedSecretValues: bSecrets,
      });

      expect(bResolved).toBe('unclassified-secret');
      expect(bSecrets.get('unclassified-secret')).toBe(sharedSsmExpr);
      expect(mockSSMSend).toHaveBeenCalledTimes(2);
    });

    it('re-asks for an unclassifiable ssm value on the next resource of the SAME stack', async () => {
      // A `Type` too anomalous to memoize is too anomalous to cache: pinning
      // the value would inherit the transient answer for the whole resolver,
      // which is exactly what refusing to memoize the verdict prevents (issue
      // #1901). The definitive-`SecureString` polarity is the neighbouring
      // "re-records the secret on the cache-hit path" test — that one IS cached
      // and answers from the cache with a single lookup.
      mockSSMSend.mockResolvedValue({ Parameter: { Value: 'unclassified-secret' } });
      const resolverForStack = new IntrinsicFunctionResolver('us-east-1');

      const firstResource = new Map<string, string>();
      await resolverForStack.resolveDynamicReferences(sharedSsmExpr, {
        ...defaultContext,
        recordedSecretValues: firstResource,
      });

      const secondResource = new Map<string, string>();
      await resolverForStack.resolveDynamicReferences(sharedSsmExpr, {
        ...defaultContext,
        recordedSecretValues: secondResource,
      });

      expect(secondResource.get('unclassified-secret')).toBe(sharedSsmExpr);
      expect(mockSSMSend).toHaveBeenCalledTimes(2);
    });

    it('does not turn a PUBLIC cached value into a needle when a foreign resolver pins the memo', async () => {
      // The reverse of the retraction case, and the reason the cache-hit arm
      // reads ONLY `cached.secret`: ORing in `isKnownSecret` would consult the
      // process-global verdict store, which a FOREIGN resolver writes to.
      //
      //   virginia: `/env` -> `String`   -> retracts the memo, caches public
      //   tokyo:    same expr -> `SecureString` -> re-adds the memo
      //   virginia's NEXT resource cache-hits and would record 'prod' as a
      //   redaction needle, rewriting its own `my-prod-bucket` into
      //   `my-{{resolve:ssm:/env}}-bucket`.
      mockSSMSend
        .mockResolvedValueOnce({ Parameter: { Value: 'prod', Type: 'String' } })
        .mockResolvedValueOnce({ Parameter: { Value: 'tokyo-secret', Type: 'SecureString' } });

      const virginia = new IntrinsicFunctionResolver('us-east-1');
      const tokyo = new IntrinsicFunctionResolver('ap-northeast-1');

      const firstResource = new Map<string, string>();
      await virginia.resolveDynamicReferences(sharedSsmExpr, {
        ...defaultContext,
        recordedSecretValues: firstResource,
      });
      expect(firstResource.size).toBe(0); // public, correctly not recorded

      // The foreign resolver's definitive SecureString re-pins the shared memo.
      await tokyo.resolveDynamicReferences(sharedSsmExpr, defaultContext);

      const secondResource = new Map<string, string>();
      const resolved = await virginia.resolveDynamicReferences(sharedSsmExpr, {
        ...defaultContext,
        recordedSecretValues: secondResource,
      });

      expect(resolved).toBe('prod');
      // The needle must NOT be recorded — otherwise redaction rewrites an
      // unrelated `my-prod-bucket` in this resource's own record.
      expect(secondResource.size).toBe(0);
      // Served from virginia's own cache; the foreign pin cost no extra lookup.
      expect(mockSSMSend).toHaveBeenCalledTimes(2);
    });

    it('re-records an EMBEDDED occurrence on the cache hit, so its state keeps the expression', async () => {
      // This is the mechanism `tests/integration/dynamic-ref-cross-region`
      // phase 3c rests on, at unit scale.
      //
      // A leaf whose WHOLE value is the template's `{{resolve:...}}` token is
      // repositioned from the SOURCE bag by `redactSecretsForState`, so it comes
      // out redacted even when the pass recorded nothing — which is why a second
      // BARE reference cannot tell a working cache-hit re-record from a broken
      // one. An EMBEDDED occurrence has no such fallback: only the value map can
      // rewrite it, and on a cache hit the value map is filled from the verdict
      // the entry carries.
      mockSSMSend.mockResolvedValue({
        Parameter: { Value: 'decrypted-password', Type: 'SecureString' },
      });
      const stackResolver = new IntrinsicFunctionResolver('us-east-1');

      // Resource 1: the bare reference, fresh resolution (populates the cache).
      await stackResolver.resolveDynamicReferences(sharedSsmExpr, {
        ...defaultContext,
        recordedSecretValues: new Map<string, string>(),
      });

      // Resource 2: the SAME expression embedded in a longer string, resolved on
      // the cache hit, with its OWN per-resource bag.
      const embeddedSource = `db=${sharedSsmExpr};mode=test`;
      const secondResource = new Map<string, string>();
      const resolvedBag = await stackResolver.resolve(
        { ConnectionString: embeddedSource },
        { ...defaultContext, recordedSecretValues: secondResource }
      );

      expect(resolvedBag).toEqual({ ConnectionString: 'db=decrypted-password;mode=test' });
      expect(mockSSMSend).toHaveBeenCalledTimes(1); // it really was a cache hit
      // The persisted record must carry the expression back inside the string.
      expect(redactSecretsForState(resolvedBag, secondResource)).toEqual({
        ConnectionString: embeddedSource,
      });
    });

    it('keeps redacting after another region resolver RETRACTS the shared verdict', async () => {
      // The verdict store stayed process-global while the values moved onto the
      // instance, so the two lifetimes can now disagree: the same parameter
      // NAME can be a `SecureString` here and a plain `String` in another
      // region, and that region's resolver retracts the memo. This resolver's
      // later resources must keep redacting their own region's secret, which is
      // why the entry carries the verdict that produced it.
      mockSSMSend
        .mockResolvedValueOnce({ Parameter: { Value: 'tokyo-password', Type: 'SecureString' } })
        .mockResolvedValueOnce({ Parameter: { Value: 'public-value', Type: 'String' } });

      const tokyo = new IntrinsicFunctionResolver('ap-northeast-1');
      const virginia = new IntrinsicFunctionResolver('us-east-1');

      const firstResource = new Map<string, string>();
      await tokyo.resolveDynamicReferences(sharedSsmExpr, {
        ...defaultContext,
        recordedSecretValues: firstResource,
      });
      expect(firstResource.get('tokyo-password')).toBe(sharedSsmExpr);

      // The other region sees a plain String under the same name and retracts.
      const otherRegion = new Map<string, string>();
      await virginia.resolveDynamicReferences(sharedSsmExpr, {
        ...defaultContext,
        recordedSecretValues: otherRegion,
      });
      expect(otherRegion.size).toBe(0);

      const secondResource = new Map<string, string>();
      const resolved = await tokyo.resolveDynamicReferences(sharedSsmExpr, {
        ...defaultContext,
        recordedSecretValues: secondResource,
      });

      expect(resolved).toBe('tokyo-password');
      expect(secondResource.get('tokyo-password')).toBe(sharedSsmExpr);
      // Served from tokyo's own cache — the retraction cost no extra lookup.
      expect(mockSSMSend).toHaveBeenCalledTimes(2);
    });
  });
  // Call VOLUME rose with the per-resolver cache (one lookup per stack, not per
  // process) and with the refusal to cache an unclassifiable ssm `Type` (one per
  // OCCURRENCE, so the next pass re-asks). Both make a bare `send` a worse deal
  // than it already was, so the lookups retry the throttle shape only.
  describe('dynamic-reference lookup retries (issue #1933 review)', () => {
    const expr = '{{resolve:ssm:/shared/db/password}}';

    beforeEach(() => {
      // No real waits; the schedule itself is withRetry's and is tested there.
      dynamicReferenceRetryDelays.sleep = async () => {};
    });

    afterEach(() => {
      delete dynamicReferenceRetryDelays.sleep;
    });

    it('retries a THROTTLED lookup and returns the eventual value', async () => {
      const throttle = Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
      });
      mockSSMSend
        .mockRejectedValueOnce(throttle)
        .mockResolvedValueOnce({ Parameter: { Value: 'v-after-throttle', Type: 'String' } });

      const resolved = await resolver.resolveDynamicReferences(expr, defaultContext);

      expect(resolved).toBe('v-after-throttle');
      expect(mockSSMSend).toHaveBeenCalledTimes(2);
    });

    it('retries a THROTTLED secretsmanager lookup too', async () => {
      // The twin of the ssm case. Both lookups gained calls from the narrower
      // cache, so a wrapper on only one of them is an arbitrary split — and
      // removing the secretsmanager one reddened nothing before this test.
      const secretExpr = '{{resolve:secretsmanager:app/db:SecretString:password}}';
      const throttle = Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
      });
      mockSecretsManagerSend
        .mockRejectedValueOnce(throttle)
        .mockResolvedValueOnce({ SecretString: JSON.stringify({ password: 'pw-after-throttle' }) });

      const resolved = await resolver.resolveDynamicReferences(secretExpr, defaultContext);

      // Value AND attempt count: without the count a wrapper-less
      // implementation that happened to succeed first time would pass.
      expect(resolved).toBe('pw-after-throttle');
      expect(mockSecretsManagerSend).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a real answer — a missing parameter fails fast', async () => {
      // The other polarity, and the one that matters for correctness: retrying
      // ParameterNotFound would turn a template error into a slow template
      // error, and retrying AccessDenied would hammer a denied API.
      const notFound = Object.assign(new Error('Parameter /shared/db/password not found.'), {
        name: 'ParameterNotFound',
      });
      mockSSMSend.mockRejectedValue(notFound);

      await expect(resolver.resolveDynamicReferences(expr, defaultContext)).rejects.toThrow(
        /not found/i
      );
      expect(mockSSMSend).toHaveBeenCalledTimes(1);
    });

    it('warns ONCE per parameter per resolver about an unrecognized Type', async () => {
      // The value is deliberately not cached in this case, so the reference is
      // re-looked-up for every occurrence — one warn per occurrence would bury
      // the line on exactly the template that needs it read.
      mockSSMSend.mockResolvedValue({ Parameter: { Value: 'unclassified-secret' } });

      await resolver.resolveDynamicReferences(expr, defaultContext);
      await resolver.resolveDynamicReferences(expr, defaultContext);
      await resolver.resolveDynamicReferences(expr, defaultContext);

      const warns = mockLoggerWarn.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('unrecognized Type'));
      expect(warns).toHaveLength(1);
      // ...but it is NOT silenced process-wide: another stack's resolver may be
      // naming a different region's parameter and deserves its own line.
      const otherStack = new IntrinsicFunctionResolver('ap-northeast-1');
      await otherStack.resolveDynamicReferences(expr, defaultContext);
      const warnsAfter = mockLoggerWarn.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('unrecognized Type'));
      expect(warnsAfter).toHaveLength(2);
    });
  });
});
