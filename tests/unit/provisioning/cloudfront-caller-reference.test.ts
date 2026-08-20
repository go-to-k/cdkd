import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateDistributionCommand, DistributionAlreadyExists } from '@aws-sdk/client-cloudfront';

// Issue #2079: `CallerReference` IS CloudFront's idempotency key, and it was
// minted afresh inside `create()` from `Date.now()` + `Math.random()`. The
// deploy engine wraps `create()` in its outer transient-error retry, and issue
// #2026 made HTTP 500 / 502 / 504 retryable — so a 500 whose
// `CreateDistribution` actually SUCCEEDED re-invoked `create()`, minted a new
// reference, and CloudFront created a SECOND distribution with no state record.
//
// The discriminator is IDENTITY across two attempts of one logical create, and
// DIFFERENCE after a release. "A token exists" is satisfied by the defect.
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFront: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const warnSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
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

import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import {
  isMarkedNonRetryable,
  isNameCollisionError,
  isRecreateRetryableError,
  RETRYABLE_ERROR_MESSAGE_PATTERNS,
} from '../../../src/deployment/retryable-errors.js';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';

const ORIGIN_DOMAIN = 'my-assets-bucket.s3.us-east-1.amazonaws.com';

const PROPERTIES = {
  DistributionConfig: {
    Enabled: true,
    Comment: 'assets edge',
    DefaultCacheBehavior: { TargetOriginId: 'origin1', ViewerProtocolPolicy: 'redirect-to-https' },
    Origins: [{ Id: 'origin1', DomainName: ORIGIN_DOMAIN, S3OriginConfig: {} }],
  },
};

/** Every `CallerReference` the provider handed to `CreateDistribution`, in order. */
function callerReferences(): string[] {
  return mockSend.mock.calls
    .filter((call) => call[0] instanceof CreateDistributionCommand)
    .map(
      (call) =>
        (call[0] as CreateDistributionCommand).input.DistributionConfig
          ?.CallerReference as string
    );
}

function wireSuccess(distributionId: string): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof CreateDistributionCommand) {
      return Promise.resolve({
        Distribution: {
          Id: distributionId,
          DomainName: `${distributionId}.cloudfront.net`,
          Status: 'Deployed',
        },
      });
    }
    // GetDistribution, consulted only under --full-wait.
    return Promise.resolve({
      Distribution: { Status: 'Deployed', DistributionConfig: { Enabled: true } },
    });
  });
}

describe('CloudFrontDistributionProvider CallerReference (issue #2079)', () => {
  let provider: CloudFrontDistributionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotencyTokensForTests();
    delete process.env['CDKD_FULL_WAIT'];
    delete process.env['CDKD_WAIT_FLAGS_AVAILABLE'];
    provider = new CloudFrontDistributionProvider();
  });

  it('is IDENTICAL across two attempts of one logical create', async () => {
    // THE discriminator, and the whole defect: the deploy engine re-invokes
    // `create()` from the top on a retryable error, so a per-attempt token
    // makes the replay a fresh create rather than a refused one.
    mockSend.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('Internal Server Error'), { $metadata: { httpStatusCode: 500 } }))
    );
    wireSuccess('E1FIRSTATTEMPT');

    await expect(
      provider.create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES)
    ).rejects.toThrow(/Internal Server Error/);
    await provider.create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES);

    const references = callerReferences();
    expect(references).toHaveLength(2);
    expect(references[0]).toBe(references[1]);
  });

  it('is DIFFERENT for a fresh create after the previous one SUCCEEDED', async () => {
    // The other half of "stable" — a `--replace` delete-then-create in one
    // process must not be handed the reference of the distribution it just
    // tore down. `release()` on the success path is what supplies this.
    wireSuccess('E1FIRST');
    await provider.create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES);

    wireSuccess('E2SECOND');
    await provider.create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES);

    const references = callerReferences();
    expect(references).toHaveLength(2);
    expect(references[0]).not.toBe(references[1]);
  });

  it('gives two DIFFERENT logical ids different references', async () => {
    wireSuccess('E1ONE');
    await provider.create('CdnA', 'AWS::CloudFront::Distribution', PROPERTIES);
    await provider.create('CdnB', 'AWS::CloudFront::Distribution', PROPERTIES);

    const references = callerReferences();
    expect(references[0]).not.toBe(references[1]);
  });

  it('does not derive the reference from a clock or a random', async () => {
    // A weaker statement than the identity case above, kept because it is the
    // one a reader can check against the issue's own quoted line.
    wireSuccess('E1ONE');
    await provider.create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES);

    const reference = callerReferences()[0]!;
    expect(reference.startsWith('cdkd-')).toBe(true);
    expect(reference).not.toContain('-Cdn-');
  });

  it('pins the token LENGTH, so maxLength can neither truncate nor go unchecked', async () => {
    // `acquireIdempotencyToken` TRUNCATES to `maxLength`, and truncation is the
    // one way a stable token turns unsafe again: shorten it far enough and two
    // logical ids share a prefix, so the second create is answered with the
    // first one's distribution. `128` is CloudFront's documented cap for
    // `CallerReference` — asserting only `<= 128` would pass for a `maxLength`
    // of 8, so the FULL untruncated digest length is pinned as well.
    wireSuccess('E1ONE');
    await provider.create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES);

    const reference = callerReferences()[0]!;
    // `cdkd-` + a 64-char sha256 hex digest, untruncated.
    expect(reference).toHaveLength(69);
    expect(reference).toMatch(/^cdkd-[0-9a-f]{64}$/);
    expect(reference.length).toBeLessThanOrEqual(128);
  });

  it('tells the user an ORPHAN may exist, and how to find it, on the refused replay', async () => {
    // The message is load-bearing and is the reason the hard failure was
    // accepted: `DistributionSummary` carries `Comment` but NOT
    // `CallerReference`, so the first attempt's distribution cannot be searched
    // for by the key that refused this one.
    mockSend.mockImplementation(() =>
      Promise.reject(
        new DistributionAlreadyExists({ message: 'already exists', $metadata: {} })
      )
    );

    const error = await provider
      .create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES)
      .catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain('aws cloudfront list-distributions');
    expect(message).toContain(ORIGIN_DOMAIN);
    expect(message).toContain('assets edge');
    expect(message).toMatch(/earlier attempt/i);
    expect(message).toMatch(/not in cdkd state|bills until/i);
  });

  it('names only the fields ListDistributions actually returns', async () => {
    // A hint pointing at the caller reference would be worse than none: it is
    // the one field the user cannot match on.
    mockSend.mockImplementation(() =>
      Promise.reject(
        new DistributionAlreadyExists({ message: 'already exists', $metadata: {} })
      )
    );

    const error = await provider
      .create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES)
      .catch((e: unknown) => e);

    expect((error as Error).message).not.toContain(callerReferences()[0]!);
  });

  it('keeps the ORDINARY create failure message unchanged', async () => {
    // The orphan wording must not be attached to a failure that created
    // nothing — it would send the user hunting for a distribution AWS never
    // made.
    mockSend.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('InvalidOrigin: bad origin'), { name: 'InvalidOrigin' }))
    );

    const error = await provider
      .create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES)
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('InvalidOrigin');
    expect((error as Error).message).not.toContain('aws cloudfront list-distributions');
  });

  it('recognises the refusal by NAME when instanceof cannot see it', async () => {
    // Two copies of the SDK in one process, or a bundler re-instantiating the
    // class, make `instanceof` miss — and a miss degrades to the generic
    // message, which never mentions the orphan.
    mockSend.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error('The caller reference has already been used'), {
          name: 'DistributionAlreadyExists',
        })
      )
    );

    const error = await provider
      .create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES)
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('aws cloudfront list-distributions');
  });

  it('falls back to a usable hint when the template names neither origin nor comment', async () => {
    // An origin can arrive as an unresolved intrinsic and `Comment` is
    // optional, so the message must never end in a dangling "match on".
    mockSend.mockImplementation(() =>
      Promise.reject(
        new DistributionAlreadyExists({ message: 'already exists', $metadata: {} })
      )
    );

    const error = await provider
      .create('Cdn', 'AWS::CloudFront::Distribution', {
        DistributionConfig: { Enabled: true, Origins: [{ Id: 'origin1' }] },
      })
      .catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain('aws cloudfront list-distributions');
    expect(message).toMatch(/newest distribution/);
    expect(message).not.toMatch(/match on ;|match on \./);
  });

  it('reads the origin domain out of the SDK { Quantity, Items } spelling too', async () => {
    mockSend.mockImplementation(() =>
      Promise.reject(
        new DistributionAlreadyExists({ message: 'already exists', $metadata: {} })
      )
    );

    const error = await provider
      .create('Cdn', 'AWS::CloudFront::Distribution', {
        DistributionConfig: {
          Enabled: true,
          Origins: { Quantity: 1, Items: [{ Id: 'origin1', DomainName: ORIGIN_DOMAIN }] },
        },
      })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain(ORIGIN_DOMAIN);
  });
  // --- the refusal must not read as a NAME COLLISION -----------------------

  /**
   * `DistributionAlreadyExists` is a deterministic refusal, but its NAME is
   * collision-shaped, and two sites act on that shape from a bare message with
   * no marker gate: the deploy engine's create-first collision fallback and its
   * rollback twin. Their remedy is to DELETE the live, in-state old resource
   * and retry. The wording discipline and the marker are therefore BOTH
   * required — the marker cannot reach a message-only classifier, which is the
   * bound `sns-subscription-provider.ts` documents.
   */
  function refusalError(): Promise<unknown> {
    mockSend.mockImplementation(() =>
      Promise.reject(new DistributionAlreadyExists({ message: 'already exists', $metadata: {} }))
    );
    return provider
      .create('Cdn', 'AWS::CloudFront::Distribution', PROPERTIES)
      .catch((e: unknown) => e);
  }

  it('is marked NON-RETRYABLE, so the recreate path cannot replay a doomed create', async () => {
    // `--recreate-via-sdk-provider` has already DELETED the old distribution by
    // the time this fires; unmarked, `isRecreateRetryableError` spends 8
    // attempts over ~64s on the same in-flight token, every one certain to fail.
    const error = await refusalError();

    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('keeps the message clear of every retryable pattern the callers match on', async () => {
    // The same sweep `custom-resource-delete-failed-response.test.ts` and
    // `sns-subscription-thrown-delete.test.ts` carry for their own constants —
    // written twice in this lane and missing here, which is exactly the fence
    // that would have caught the `AlreadyExists` substring before review did.
    const error = await refusalError();
    const message = (error as Error).message.toLowerCase();

    for (const pattern of RETRYABLE_ERROR_MESSAGE_PATTERNS) {
      expect(message, `retryable pattern '${pattern}' is in the orphan message`).not.toContain(
        pattern.toLowerCase()
      );
    }
    // ...and the already-deleted family the delete-side catches match on, so a
    // future caller cannot read this create failure as an idempotent success.
    for (const phrase of ['does not exist', 'was not found', 'not found', 'nosuchentity']) {
      expect(message, `already-deleted phrase '${phrase}' is in the orphan message`).not.toContain(
        phrase
      );
    }
  });

  it('carries no collision-shaped token, so the DELETE-and-retry fallbacks stay shut', async () => {
    // The destructive half. These two classifiers read the MESSAGE only.
    const error = await refusalError();
    const message = (error as Error).message;

    expect(isNameCollisionError(message)).toBe(false);
    expect(isRecreateRetryableError(message)).toBe(false);
    expect(message).not.toContain('AlreadyExists');
    expect(message.toLowerCase()).not.toContain('already exist');
  });

  it('keeps the AWS error reachable on the cause, where classifiers already walk', async () => {
    // Dropping the token from the MESSAGE must not drop the diagnosis.
    const error = await refusalError();

    expect(((error as Error).cause as Error | undefined)?.name).toBe('DistributionAlreadyExists');
  });

  // --- resolved template values are masked AT THE LEAF ---------------------

  it('masks a SHORT secret the assembled-message mask cannot reach', async () => {
    // `maskSecretsInText` has two arms: whole-value equality, and a substring
    // scan that DROPS needles below MIN_NEEDLE_LENGTH (4). A 3-character secret
    // therefore survives any mask applied to the finished sentence, and is
    // caught only by masking the raw leaf — measured, both directions.
    const maskSecrets = createSecretMasker(new Map([['abc', '{{resolve:secretsmanager:s}}']]));
    mockSend.mockImplementation(() =>
      Promise.reject(new DistributionAlreadyExists({ message: 'already exists', $metadata: {} }))
    );

    const error = await provider
      .create(
        'Cdn',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: {
            Enabled: true,
            Comment: 'abc',
            Origins: [{ Id: 'origin1', DomainName: ORIGIN_DOMAIN }],
          },
        },
        { maskSecrets }
      )
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('***');
    expect((error as Error).message).not.toContain('"abc"');
  });

  it('masks a JSON-document secret BEFORE stringify escapes it out of reach', async () => {
    // The measured case in `.claude/rules/providers.md`: `JSON.stringify`
    // escapes the quotes, so a Secrets Manager JSON document no longer OCCURS
    // literally in the finished text and the outer substring mask misses it.
    const secret = '{"user":"admin"}';
    const maskSecrets = createSecretMasker(new Map([[secret, '{{resolve:secretsmanager:s}}']]));
    mockSend.mockImplementation(() =>
      Promise.reject(new DistributionAlreadyExists({ message: 'already exists', $metadata: {} }))
    );

    const error = await provider
      .create(
        'Cdn',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: {
            Enabled: true,
            Comment: secret,
            Origins: [{ Id: 'origin1', DomainName: ORIGIN_DOMAIN }],
          },
        },
        { maskSecrets }
      )
      .catch((e: unknown) => e);

    const message = (error as Error).message;
    expect(message).toContain('***');
    expect(message).not.toContain('admin');
  });

  it('masks a secret that is the ORIGIN DOMAIN, not only the comment', async () => {
    // Both leaves the hint can emit, so a fix applied to one of them is caught.
    const secret = 'secret-tenant-7.internal.example.com';
    const maskSecrets = createSecretMasker(new Map([[secret, '{{resolve:secretsmanager:s}}']]));
    mockSend.mockImplementation(() =>
      Promise.reject(new DistributionAlreadyExists({ message: 'already exists', $metadata: {} }))
    );

    const error = await provider
      .create(
        'Cdn',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: {
            Enabled: true,
            Comment: 'assets edge',
            Origins: [{ Id: 'origin1', DomainName: secret }],
          },
        },
        { maskSecrets }
      )
      .catch((e: unknown) => e);

    expect((error as Error).message).not.toContain('secret-tenant-7');
    expect((error as Error).message).toContain('***');
  });

  it('leaves the message unchanged when no masker is supplied', async () => {
    // The `SecretMaskingContext` contract: absent means unmasked, and
    // `create()` is also reached from drift --revert, the import path and tests.
    const error = await refusalError();

    expect((error as Error).message).toContain(ORIGIN_DOMAIN);
  });
});
