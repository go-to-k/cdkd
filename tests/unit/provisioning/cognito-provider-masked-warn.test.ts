import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #1932 item 3: the dropped-factor warning interpolates a RESOLVED
// `EnabledMfas` value straight into `logger.warn`. cdkd's secret masking lives
// at the deploy engine (error / reason text) and the resolver's debug line
// only, so a `{{resolve:secretsmanager:...}}` scalar reaching this warning
// printed in plaintext. The provider now masks through the `maskSecrets`
// capability its caller puts on `CreateContext` / `UpdateContext`.

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));
childLogger.child.mockReturnValue(childLogger);

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// A plaintext long enough to be a redaction needle (`MIN_NEEDLE_LENGTH`) and
// distinctive enough that a `toContain` assertion cannot pass by accident.
const SECRET_PLAINTEXT = 'super-secret-mfa-factor-value';
const SECRET_EXPR = '{{resolve:secretsmanager:mfa/factor:SecretString:name::}}';

function secretBag(): RecordedSecretValues {
  return new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]);
}

function warnings(): string {
  return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('CognitoUserPoolProvider - resolved secrets in the MFA warnings (issue #1932 item 3)', () => {
  let provider: CognitoUserPoolProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CognitoUserPoolProvider();
  });

  /** CreateUserPool then SetUserPoolMfaConfig. */
  function primeCreate(): void {
    mockSend.mockResolvedValueOnce({
      UserPool: { Id: 'us-east-1_abc123', Arn: 'arn:masked-warn' },
    });
    mockSend.mockResolvedValueOnce({});
  }

  /** UpdateUserPool, DescribeUserPool (pre-read), SetUserPoolMfaConfig, DescribeUserPool. */
  function primeUpdate(): void {
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'DescribeUserPoolCommand') {
        return Promise.resolve({
          UserPool: {
            Id: 'us-east-1_abc123',
            Arn: 'arn:masked-warn-update',
            MfaConfiguration: 'OFF',
          },
        });
      }
      return Promise.resolve({});
    });
  }

  describe('create', () => {
    // The `(not a list)` arm: the whole property value is interpolated.
    it('masks a resolved secret in the non-list EnabledMfas warning', async () => {
      primeCreate();

      await provider.create(
        'MyUserPool',
        'AWS::Cognito::UserPool',
        {
          // What the deploy engine hands a provider is already RESOLVED — the
          // `{{resolve:...}}` scalar became this plaintext during resolution.
          EnabledMfas: SECRET_PLAINTEXT,
          WebAuthnRelyingPartyID: 'auth.example.com',
        },
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      const warned = warnings();
      // Non-vacuity: the warning DID fire, so the assertion below is about
      // masking rather than about an absent message.
      expect(warned).toContain('(not a list)');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    // The unrecognized-member arm: a LIST member is interpolated. Both halves
    // of `dropped` are resolved property values, so masking only one leaves the
    // other leaking.
    it('masks a resolved secret in an unrecognized EnabledMfas LIST member', async () => {
      primeCreate();

      await provider.create(
        'MyUserPool',
        'AWS::Cognito::UserPool',
        { EnabledMfas: [SECRET_PLAINTEXT, 'SOFTWARE_TOKEN_MFA'] },
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      const warned = warnings();
      expect(warned).toContain('do not map to an MFA');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    // Back-compat: the ~130 providers and every caller that passes no context
    // must be byte-identical to before. This is what makes the contract
    // optional rather than a breaking interface change.
    it('leaves the warning unmasked when the caller passes no context', async () => {
      primeCreate();

      await provider.create('MyUserPool', 'AWS::Cognito::UserPool', {
        EnabledMfas: SECRET_PLAINTEXT,
        WebAuthnRelyingPartyID: 'auth.example.com',
      });

      const warned = warnings();
      expect(warned).toContain('(not a list)');
      expect(warned).toContain(SECRET_PLAINTEXT);
    });

    // A context WITHOUT `maskSecrets` (e.g. the rollback executor before this
    // change, or a caller that only sets `replayingState`) must not throw.
    it('does not throw for a context that carries no masker', async () => {
      primeCreate();

      await expect(
        provider.create(
          'MyUserPool',
          'AWS::Cognito::UserPool',
          { EnabledMfas: SECRET_PLAINTEXT, WebAuthnRelyingPartyID: 'auth.example.com' },
          { replayingState: true }
        )
      ).resolves.toBeDefined();
      expect(warnings()).toContain('(not a list)');
    });

    // The needle-floor case, and the reason the provider masks each string LEAF
    // rather than only the finished message. `maskSecretsInText` masks an exact
    // whole-value match at ANY length, but only scans for SUBSTRING needles of
    // >= MIN_NEEDLE_LENGTH (4) characters. A finished warning is always longer
    // than the value inside it, so a message-only mask can reach ONLY the
    // substring arm -- and a 1-3 character secret survives it untouched.
    // Deleting `maskLeaf` from the provider leaves this the only failing test.
    it('masks a SHORT secret, which only the value-level pass can reach', async () => {
      primeCreate();
      const SHORT = 'pin';
      const shortBag: RecordedSecretValues = new Map([
        [SHORT, '{{resolve:secretsmanager:pin:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyUserPool',
        'AWS::Cognito::UserPool',
        { EnabledMfas: SHORT, WebAuthnRelyingPartyID: 'auth.example.com' },
        { maskSecrets: createSecretMasker(shortBag) }
      );

      const warned = warnings();
      expect(warned).toContain('(not a list)');
      // The quoted plaintext must be gone. Asserted as the QUOTED form so the
      // three letters cannot match incidentally inside another word in the
      // message (there is no such word today, but the bare string is exactly
      // the kind of assertion that goes vacuous on a reword).
      expect(warned).not.toContain(`"${SHORT}"`);
      expect(warned).toContain(`"${SECRET_MASK}"`);
    });

    // The same floor reached through a LIST member rather than the whole
    // property, so removing `maskLeaf` from either half of `dropped` fails.
    it('masks a SHORT secret in an unrecognized EnabledMfas LIST member', async () => {
      primeCreate();
      const SHORT = 'otp';
      const shortBag: RecordedSecretValues = new Map([
        [SHORT, '{{resolve:secretsmanager:otp:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyUserPool',
        'AWS::Cognito::UserPool',
        { EnabledMfas: [SHORT, 'SOFTWARE_TOKEN_MFA'] },
        { maskSecrets: createSecretMasker(shortBag) }
      );

      const warned = warnings();
      expect(warned).toContain('do not map to an MFA');
      expect(warned).not.toContain(`"${SHORT}"`);
      expect(warned).toContain(`"${SECRET_MASK}"`);
    });

    // THE realistic secret shape, and the case a message-only mask cannot
    // reach at any length. `JSON.stringify` escapes `"` / `\\` / newlines, so
    // the needle no longer OCCURS in the finished line and the sink's substring
    // scan finds nothing. Measured on the pre-fix code: the line came through
    // completely unchanged. Every other fixture here uses escape-free
    // plaintext, so this is the only test that discriminates.
    it('masks a secret that JSON escaping would otherwise hide', async () => {
      primeCreate();
      const ESCAPED = 'a"b-super-secret';
      const bag: RecordedSecretValues = new Map([
        [ESCAPED, '{{resolve:secretsmanager:doc:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyUserPool',
        'AWS::Cognito::UserPool',
        { EnabledMfas: ESCAPED, WebAuthnRelyingPartyID: 'auth.example.com' },
        { maskSecrets: createSecretMasker(bag) }
      );

      const warned = warnings();
      expect(warned).toContain('(not a list)');
      // Neither the raw plaintext nor its JSON-ESCAPED rendering may appear.
      // The escaped form is the one that actually leaked, so asserting only
      // the raw form would pass on the broken code.
      expect(warned).not.toContain(ESCAPED);
      expect(warned).not.toContain(JSON.stringify(ESCAPED).slice(1, -1));
      expect(warned).toContain(SECRET_MASK);
    });

    // The walk, not just the top-level string test: a secret NESTED inside an
    // object leaf is stringified -- and therefore escaped -- the same way, so a
    // `typeof v === 'string'` check at the top level alone would miss it.
    it('masks a secret nested inside a non-string EnabledMfas value', async () => {
      primeCreate();
      const NESTED = 'q"z-super-secret';
      const bag: RecordedSecretValues = new Map([
        [NESTED, '{{resolve:secretsmanager:nested:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyUserPool',
        'AWS::Cognito::UserPool',
        { EnabledMfas: { Ref: NESTED }, WebAuthnRelyingPartyID: 'auth.example.com' },
        { maskSecrets: createSecretMasker(bag) }
      );

      const warned = warnings();
      expect(warned).toContain('(not a list)');
      expect(warned).not.toContain(NESTED);
      expect(warned).not.toContain(JSON.stringify(NESTED).slice(1, -1));
      expect(warned).toContain(SECRET_MASK);
    });

    // Per-SITE coverage for the blank-EnabledMfas warning, which is a
    // DIFFERENT `warn(...)` call from the dropped-entry one the cases above
    // exercise. It interpolates `request.MfaConfiguration`, which is a resolved
    // property value, so neutralizing the sink at that one site must fail here
    // rather than being caught only by the dropped-entry tests.
    it('masks a resolved secret in the blank-EnabledMfas warning', async () => {
      primeCreate();

      await provider.create(
        'MyUserPool',
        'AWS::Cognito::UserPool',
        // `WebAuthnRelyingPartyID` is load-bearing, not decoration: the blank
        // warning is scoped to "another MFA-routed property is present", and
        // `MfaConfiguration` is not one of them. Without it `hasMfaConfigProps`
        // is false, no SetUserPoolMfaConfig call is made, and this test both
        // asserts nothing AND leaves its second `mockResolvedValueOnce` primer
        // undrained -- which shifts every later test in the file.
        { EnabledMfas: '', MfaConfiguration: SECRET_PLAINTEXT, WebAuthnRelyingPartyID: 'auth.example.com' },
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      const warned = warnings();
      expect(warned).toContain('EnabledMfas is an empty string');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    // A non-secret value must survive verbatim, or the fix would have bought
    // confidentiality by destroying the warning's diagnostic value.
    it('does not mangle a non-secret value when a masker IS supplied', async () => {
      primeCreate();

      await provider.create(
        'MyUserPool',
        'AWS::Cognito::UserPool',
        { EnabledMfas: ['SOFTWARE_TOKEN', 'SOFTWARE_TOKEN_MFA'] },
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      const warned = warnings();
      expect(warned).toContain('"SOFTWARE_TOKEN"');
      expect(warned).not.toContain(SECRET_MASK);
    });
  });

  describe('update', () => {
    // The twin. `update()` reaches the SAME `buildMfaConfigRequest` warnings
    // with the same resolved bag, so a masker on create alone leaves the fix
    // conditional on which path a given deploy happens to take.
    it('masks a resolved secret in the non-list EnabledMfas warning', async () => {
      primeUpdate();

      await provider.update(
        'MyUserPool',
        'us-east-1_abc123',
        'AWS::Cognito::UserPool',
        { EnabledMfas: SECRET_PLAINTEXT, WebAuthnRelyingPartyID: 'auth.example.com' },
        {},
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      const warned = warnings();
      expect(warned).toContain('(not a list)');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    it('masks a resolved secret in an unrecognized EnabledMfas LIST member', async () => {
      primeUpdate();

      await provider.update(
        'MyUserPool',
        'us-east-1_abc123',
        'AWS::Cognito::UserPool',
        { EnabledMfas: [SECRET_PLAINTEXT, 'SOFTWARE_TOKEN_MFA'] },
        {},
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      const warned = warnings();
      expect(warned).toContain('do not map to an MFA');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    it('leaves the warning unmasked when the caller passes no context', async () => {
      primeUpdate();

      await provider.update(
        'MyUserPool',
        'us-east-1_abc123',
        'AWS::Cognito::UserPool',
        { EnabledMfas: SECRET_PLAINTEXT, WebAuthnRelyingPartyID: 'auth.example.com' },
        {}
      );

      const warned = warnings();
      expect(warned).toContain('(not a list)');
      expect(warned).toContain(SECRET_PLAINTEXT);
    });
  });
});
