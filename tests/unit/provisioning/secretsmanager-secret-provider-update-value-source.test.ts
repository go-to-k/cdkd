import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateSecretCommand } from '@aws-sdk/client-secrets-manager';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    secretsManager: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SecretsManagerSecretProvider } from '../../../src/provisioning/providers/secretsmanager-secret-provider.js';
import { withCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:0:secret:my-secret-AbCdEf';
const TYPE = 'AWS::SecretsManager::Secret';

/** The single UpdateSecret input the provider sent. */
function updateInput(): { SecretString?: string; Description?: string } {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
  expect(calls).toHaveLength(1);
  return calls[0]![0].input as { SecretString?: string; Description?: string };
}

/**
 * Issue #2472: the secret VALUE rides an in-place update only when its SOURCE
 * changed. Pre-fix, `update()` re-ran `generateSecretString()` on every call
 * (a Tags-only or Description-only deploy minted a fresh password and staged
 * it AWSCURRENT) and re-sent an unchanged literal (stacking a new version per
 * update). CloudFormation regenerates only when the `GenerateSecretString`
 * block itself changes, and re-sends a literal only when it changes.
 */
describe('SecretsManagerSecretProvider update() value source (issue #2472)', () => {
  let provider: SecretsManagerSecretProvider;

  const generated = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    Name: 'my-secret',
    Description: 'app secret',
    GenerateSecretString: {
      SecretStringTemplate: '{"username":"admin"}',
      GenerateStringKey: 'password',
      PasswordLength: 32,
      ExcludePunctuation: true,
    },
    ...extra,
  });

  const literal = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    Name: 'my-secret',
    Description: 'app secret',
    SecretString: 'literal-value',
    ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SecretsManagerSecretProvider();
  });

  it('a Tags-only update of a GenerateSecretString secret sends NO SecretString', async () => {
    const prev = generated({ Tags: [{ Key: 'env', Value: 'dev' }] });
    const next = generated({ Tags: [{ Key: 'env', Value: 'prod' }] });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a Description-only update of a GenerateSecretString secret sends NO SecretString', async () => {
    const prev = generated();
    const next = generated({ Description: 'renamed' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    const input = updateInput();
    expect(input.SecretString).toBeUndefined();
    expect(input.Description).toBe('renamed');
  });

  it('a GenerateSecretString block with a DIFFERENT key order is not a change', async () => {
    // The previous bag is read back from state.json and the new one comes
    // from the resolver; a serialization-order difference must not re-roll
    // the password (which a JSON.stringify comparison would do).
    const prev = generated();
    const reordered = {
      ExcludePunctuation: true,
      PasswordLength: 32,
      GenerateStringKey: 'password',
      SecretStringTemplate: '{"username":"admin"}',
    };
    const next = generated({ GenerateSecretString: reordered, Description: 'renamed' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a CHANGED GenerateSecretString block mints a new value of the new shape', async () => {
    const prev = generated();
    const next = generated({
      GenerateSecretString: {
        ...(prev['GenerateSecretString'] as Record<string, unknown>),
        PasswordLength: 40,
      },
    });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    const sent = updateInput().SecretString;
    expect(sent).toBeDefined();
    const parsed = JSON.parse(sent!) as { username: string; password: string };
    expect(parsed.username).toBe('admin');
    expect(parsed.password).toHaveLength(40);
  });

  it('an unchanged literal SecretString is NOT re-sent on a Tags-only update', async () => {
    const prev = literal({ Tags: [{ Key: 'env', Value: 'dev' }] });
    const next = literal({ Tags: [{ Key: 'env', Value: 'prod' }] });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a CHANGED literal SecretString is sent', async () => {
    const prev = literal();
    const next = literal({ SecretString: 'literal-value-v2' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBe('literal-value-v2');
  });

  it('a literal changed to the EMPTY string is sent, not treated as absent', async () => {
    // A user-written `SecretString: ''` is a change; AWS decides whether to
    // accept it. Silently keeping the old value would hide the edit.
    const prev = literal();
    const next = literal({ SecretString: '' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBe('');
  });

  it('switching from GenerateSecretString to an EMPTY literal is sent', async () => {
    const prev = generated();
    const next = literal({ SecretString: '' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBe('');
  });

  it('switching from a literal to GenerateSecretString mints a value', async () => {
    const prev = literal();
    const next = generated();

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    const sent = updateInput().SecretString;
    expect(sent).toBeDefined();
    expect(sent).not.toBe('literal-value');
  });

  it('switching from GenerateSecretString to a literal sends the literal', async () => {
    const prev = generated();
    const next = literal();

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBe('literal-value');
  });

  it('GenerateSecretString wins over a literal on the same bag, and only its change counts', async () => {
    // CloudFormation gives GenerateSecretString precedence when both are set.
    // An unchanged block beside a changed literal is therefore NOT a change.
    const prev = generated({ SecretString: 'ignored-a' });
    const next = generated({ SecretString: 'ignored-b' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a rollback replay (previous bag == desired bag) sends NO SecretString', async () => {
    // rollback-executor replays previousState.properties through update();
    // the bag still carries GenerateSecretString, so pre-fix the recovery
    // path re-rolled the password too.
    const desired = generated();

    await provider.update('L', SECRET_ARN, TYPE, desired, { ...desired });

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a rollback revert of a Tags-only deploy (old bag as desired, new bag as previous) sends NO SecretString', async () => {
    // The revert arm passes (previousState.properties, currentProps): the
    // OLD bag is `properties` and the failed deploy's bag is
    // `previousProperties`. Same block on both sides either way.
    const old = generated({ Tags: [{ Key: 'env', Value: 'dev' }] });
    const failed = generated({ Tags: [{ Key: 'env', Value: 'prod' }] });

    await provider.update('L', SECRET_ARN, TYPE, old, failed);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a Description-only update of a literal secret sends NO SecretString', async () => {
    const prev = literal();
    const next = literal({ Description: 'renamed' });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    const input = updateInput();
    expect(input.SecretString).toBeUndefined();
    expect(input.Description).toBe('renamed');
  });

  it('the CDK-default empty GenerateSecretString block is unchanged across a Tags-only update', async () => {
    // `new secretsmanager.Secret(...)` synthesizes `GenerateSecretString: {}`;
    // this is the shape the issue names as the common trigger.
    const prev = generated({ GenerateSecretString: {}, Tags: [{ Key: 'env', Value: 'dev' }] });
    const next = generated({ GenerateSecretString: {}, Tags: [{ Key: 'env', Value: 'prod' }] });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('an explicit undefined member in the desired block is not a change', async () => {
    // state.json cannot hold `undefined`, so a resolver-side `{ ..., X: undefined }`
    // must compare equal to the persisted block without X — the failure
    // direction would be a silent re-roll.
    const prev = generated();
    const next = generated({
      GenerateSecretString: {
        ...(prev['GenerateSecretString'] as Record<string, unknown>),
        ExcludeCharacters: undefined,
      },
    });

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a bag with NEITHER source keeps the live value (no SecretString sent)', async () => {
    const prev = generated();
    const next = { Name: 'my-secret', Description: 'renamed' };

    await provider.update('L', SECRET_ARN, TYPE, next, prev);

    expect(updateInput().SecretString).toBeUndefined();
  });

  it('a non-string SecretString is refused by shape, without echoing the value', async () => {
    const prev = literal();
    const next = literal({ SecretString: { nested: 'super-secret-value' } });

    let message = '';
    try {
      await provider.update('L', SECRET_ARN, TYPE, next, prev);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/SecretString must be a string, got object/);
    expect(message).not.toMatch(/super-secret-value/);
    const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
    expect(calls).toHaveLength(0);
  });

  it('a null SecretString is refused as "null"', async () => {
    const prev = literal();
    const next = literal({ SecretString: null });

    await expect(provider.update('L', SECRET_ARN, TYPE, next, prev)).rejects.toThrow(
      /SecretString must be a string, got null/
    );
  });

  it('an array-valued SecretString is refused as "array"', async () => {
    const prev = literal();
    const next = literal({ SecretString: ['super-secret-value'] });

    let message = '';
    try {
      await provider.update('L', SECRET_ARN, TYPE, next, prev);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/SecretString must be a string, got array/);
    expect(message).not.toMatch(/super-secret-value/);
  });

  describe('a {{resolve:...}} inside the source (state holds the redacted expression)', () => {
    // On the deploy path the resolver hands update() PLAINTEXT while state.json
    // holds the `{{resolve:...}}` expression the value came from. The
    // per-resource secrets scope carries the plaintext -> expression pairs.
    const EXPR = '{{resolve:secretsmanager:upstream/creds:SecretString:password}}';
    const PLAIN = 'upstream-plaintext-pw';
    const scoped = <T>(fn: () => Promise<T>): Promise<T> =>
      withCurrentResourceSecrets(new Map([[PLAIN, EXPR]]), fn);

    it('a SecretStringTemplate embedding the reference is unchanged on a Tags-only update', async () => {
      const block = (username: string) => ({
        SecretStringTemplate: JSON.stringify({ username, password: PLAIN }),
        GenerateStringKey: 'token',
      });
      const prev = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: EXPR }),
          GenerateStringKey: 'token',
        },
        Tags: [{ Key: 'env', Value: 'dev' }],
      });
      const next = generated({
        GenerateSecretString: block('admin'),
        Tags: [{ Key: 'env', Value: 'prod' }],
      });

      await scoped(() => provider.update('L', SECRET_ARN, TYPE, next, prev));

      expect(updateInput().SecretString).toBeUndefined();
    });

    it('a SecretStringTemplate embedding the reference is re-generated when the template itself changed', async () => {
      const prev = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: EXPR }),
          GenerateStringKey: 'token',
        },
      });
      const next = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'root', password: PLAIN }),
          GenerateStringKey: 'token',
        },
      });

      await scoped(() => provider.update('L', SECRET_ARN, TYPE, next, prev));

      const sent = updateInput().SecretString;
      expect(sent).toBeDefined();
      const parsed = JSON.parse(sent!) as { username: string; password: string; token: string };
      expect(parsed.username).toBe('root');
      expect(parsed.password).toBe(PLAIN);
      expect(parsed.token).toHaveLength(32);
    });

    it('without the scope bound (drift --revert / import), the raw comparison still applies', async () => {
      const prev = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: EXPR }),
          GenerateStringKey: 'token',
        },
      });
      const next = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: PLAIN }),
          GenerateStringKey: 'token',
        },
      });

      await provider.update('L', SECRET_ARN, TYPE, next, prev);

      // No pairs to rewrite with: the two spellings differ, so a value is sent.
      // This is the pre-#2472 behaviour for this shape on the unscoped paths.
      expect(updateInput().SecretString).toBeDefined();
    });

    it('an upstream ROTATION behind an unchanged reference does not regenerate (intended trade)', async () => {
      // The reference in the template is unchanged; only the value it resolves
      // to moved. Both sides spell the expression, so nothing is sent. CFn
      // would re-resolve and regenerate; cdkd takes the no-re-roll side.
      const ROTATED = 'upstream-plaintext-pw-rotated';
      const prev = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: EXPR }),
          GenerateStringKey: 'token',
        },
        Tags: [{ Key: 'env', Value: 'dev' }],
      });
      const next = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: ROTATED }),
          GenerateStringKey: 'token',
        },
        Tags: [{ Key: 'env', Value: 'prod' }],
      });

      await withCurrentResourceSecrets(new Map([[ROTATED, EXPR]]), () =>
        provider.update('L', SECRET_ARN, TYPE, next, prev)
      );

      expect(updateInput().SecretString).toBeUndefined();
    });

    it('a pre-GHSA record still holding PLAINTEXT matches the raw comparison (no re-roll)', async () => {
      // A state record written before GHSA-p5qg-v9gv-hc7w redaction holds the
      // plaintext, not the expression. With the scope bound the redacted arm
      // would spell the desired block as EXPR and differ; the RAW arm is what
      // keeps such a record from re-rolling on every Tags-only update.
      const block = {
        SecretStringTemplate: JSON.stringify({ username: 'admin', password: PLAIN }),
        GenerateStringKey: 'token',
      };
      const prev = generated({ GenerateSecretString: block, Tags: [{ Key: 'env', Value: 'dev' }] });
      const next = generated({
        GenerateSecretString: { ...block },
        Tags: [{ Key: 'env', Value: 'prod' }],
      });

      await scoped(() => provider.update('L', SECRET_ARN, TYPE, next, prev));

      expect(updateInput().SecretString).toBeUndefined();
    });

    it('KNOWN EDGE: replacing the reference with its current plaintext literal does not regenerate', async () => {
      // The redaction is a VALUE scan: a literal equal to a plaintext this
      // resource resolved elsewhere is rewritten to the expression, so the
      // block compares equal to the persisted one. Pinned as the accepted
      // behaviour (safe direction: no unrequested re-roll) — see the
      // changedSecretValue JSDoc. If this test starts failing, the comparison
      // became position-aware and the JSDoc needs updating.
      const prev = generated({
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: EXPR }),
          GenerateStringKey: 'token',
        },
      });
      const next = generated({
        // Same plaintext, now written as a literal; the scope still carries
        // the pair because a sibling property of this resource resolved it.
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'admin', password: PLAIN }),
          GenerateStringKey: 'token',
        },
      });

      await scoped(() => provider.update('L', SECRET_ARN, TYPE, next, prev));

      expect(updateInput().SecretString).toBeUndefined();
    });

    it('a literal that IS the reference is re-sent on a Tags-only update (deliberate)', async () => {
      // cdkd cannot tell whether the REFERENCED value changed since the last
      // deploy, and CloudFormation re-applies it when it did; a redundant
      // version is the milder failure than a stale copy.
      const prev = literal({ SecretString: EXPR, Tags: [{ Key: 'env', Value: 'dev' }] });
      const next = literal({ SecretString: PLAIN, Tags: [{ Key: 'env', Value: 'prod' }] });

      await scoped(() => provider.update('L', SECRET_ARN, TYPE, next, prev));

      expect(updateInput().SecretString).toBe(PLAIN);
    });
  });
});
