import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #2178 — the RUNTIME twin of `scripts/check-provider-secret-mask.ts`.
 *
 * The critic is STATIC: it proves the `DeltaSyncConfig` TTL refusal wraps its
 * value in a `maskDeep(...)` whose masker is reachable from the file's masker
 * SET. It cannot prove the masker that arrives at that call site is anything
 * other than the identity function — a threading bug (a `context` never passed
 * down, a helper parameter defaulted to identity) leaves the shape intact and
 * the disclosure open. That is what this file measures.
 *
 * The load-bearing assertion is `not.toContain(SECRET_PLAINTEXT)`: an identity
 * masker satisfies every other assertion here.
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-appsync', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-appsync')>(
    '@aws-sdk/client-appsync'
  );
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => ({
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

// The provider reconstructs child `Ref` ARNs through the STS-backed resolver;
// mocked so this suite never depends on the machine's AWS credentials.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const DATASOURCE_TYPE = 'AWS::AppSync::DataSource';

/**
 * The resolved plaintext. Distinctive and grepped against the whole tree before
 * being invented, so a `toContain` here cannot pass for another suite's reason,
 * and >= 8 characters so it is not a substring of any other literal in the
 * refusal.
 */
const SECRET_PLAINTEXT = 'appsync2178-deltasync-plaintext';

function maskSecrets(): (text: string) => string {
  const bag: RecordedSecretValues = new Map([
    [SECRET_PLAINTEXT, `{{resolve:secretsmanager:appsync/ttl:SecretString:v::}}`],
  ]);
  return createSecretMasker(bag);
}

/**
 * The offending TTL, with the secret at a NESTED string leaf rather than as the
 * top-level scalar. `maskDeep` walks leaves, so a top-level-only fixture would
 * still pass against a walk that never descends; this shape is what makes the
 * walk itself observable.
 */
function badTtl(): unknown {
  return { nested: { bad: SECRET_PLAINTEXT } };
}

/**
 * What the refusal must render for {@link badTtl} once the walk has run, and
 * what it renders when it has not. Asserting the EXACT rendering is what makes
 * these cases discriminating: `toContain(SECRET_MASK)` alone could in principle
 * match a `***` that came from somewhere else in the message.
 */
const MASKED_RENDERING = JSON.stringify({ nested: { bad: SECRET_MASK } });
const RAW_RENDERING = JSON.stringify({ nested: { bad: SECRET_PLAINTEXT } });

function dataSourceProps(ttl: unknown): Record<string, unknown> {
  return {
    ApiId: 'api123',
    Name: 'MyDataSource',
    Type: 'AMAZON_DYNAMODB',
    DynamoDBConfig: {
      TableName: 'my-table',
      AwsRegion: 'us-east-1',
      DeltaSyncConfig: { BaseTableTTL: ttl },
    },
  };
}

/** Await a call that MUST reject and hand back its message. */
async function refusalMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the DeltaSync TTL refusal, but the call resolved');
}

describe('AppSyncProvider DeltaSync TTL refusal masks the resolved value (issue #2178)', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new AppSyncProvider();
  });

  it('masks the resolved secret in the create() refusal', async () => {
    const message = await refusalMessage(
      provider.create('MyDataSource', DATASOURCE_TYPE, dataSourceProps(badTtl()), {
        maskSecrets: maskSecrets(),
      })
    );

    // Non-vacuity FIRST: the refusal fired and still quotes the value, so the
    // two assertions below are about masking rather than about a missing line.
    expect(message).toContain('must be a number of minutes');
    expect(message).toContain(MASKED_RENDERING);
    expect(message).toContain(SECRET_MASK);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  it('masks the resolved secret in the update() refusal', async () => {
    const message = await refusalMessage(
      provider.update(
        'MyDataSource',
        'api123|MyDataSource',
        DATASOURCE_TYPE,
        dataSourceProps(badTtl()),
        dataSourceProps(60),
        { maskSecrets: maskSecrets() }
      )
    );

    expect(message).toContain('must be a number of minutes');
    expect(message).toContain(MASKED_RENDERING);
    expect(message).toContain(SECRET_MASK);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  it('masks the DeltaSyncTableTTL refusal too — the second site the masker reaches', async () => {
    const props = dataSourceProps(30);
    (
      (props['DynamoDBConfig'] as Record<string, unknown>)['DeltaSyncConfig'] as Record<
        string,
        unknown
      >
    )['DeltaSyncTableTTL'] = badTtl();

    const message = await refusalMessage(
      provider.create('MyDataSource', DATASOURCE_TYPE, props, { maskSecrets: maskSecrets() })
    );

    expect(message).toContain('DeltaSyncTableTTL');
    expect(message).toContain(SECRET_MASK);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  // THE CONTROL. Without a case where the plaintext survives, every assertion
  // above is also satisfied by a refusal that dropped the value entirely — and
  // by a masker that masks nothing, since the plaintext would then be absent
  // for the wrong reason. Absent context means unmasked, by contract.
  it('leaves the plaintext INTACT when no context is supplied — the control', async () => {
    const message = await refusalMessage(
      provider.create('MyDataSource', DATASOURCE_TYPE, dataSourceProps(badTtl()))
    );

    expect(message).toContain('must be a number of minutes');
    expect(message).toContain(RAW_RENDERING);
    expect(message).toContain(SECRET_PLAINTEXT);
    expect(message).not.toContain(SECRET_MASK);
  });

  // A context without the capability must behave exactly like no context — the
  // back-compatible default, and the arm that would throw if the provider
  // assumed `context.maskSecrets` were required.
  it('leaves the plaintext INTACT for a context that carries no masker', async () => {
    const message = await refusalMessage(
      provider.create('MyDataSource', DATASOURCE_TYPE, dataSourceProps(badTtl()), {
        replayingState: true,
      })
    );

    expect(message).toContain(SECRET_PLAINTEXT);
  });

  // The masker must not eat a NON-secret value, or the fix would buy
  // confidentiality by destroying the refusal's diagnostic worth.
  it('does not mangle a non-secret value when a masker IS supplied', async () => {
    const message = await refusalMessage(
      provider.create(
        'MyDataSource',
        DATASOURCE_TYPE,
        dataSourceProps({ nested: { bad: 'definitely-not-a-ttl' } }),
        { maskSecrets: maskSecrets() }
      )
    );

    expect(message).toContain('definitely-not-a-ttl');
    expect(message).not.toContain(SECRET_MASK);
  });
});
