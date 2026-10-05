import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#3938: a custom resource whose RECORDED `ServiceToken` is the
 * redaction mask `***`.
 *
 * A dependent custom resource that reads a `NoEcho` attribute EQUAL to its own
 * ServiceToken persists `ServiceToken: "***"`. `delete()` guarded only an
 * absent or non-string token, so the mask reached the issue-#804
 * `GetFunction` pre-check and the Delete invoke as a function name. It is now
 * a named skip, the sibling of the no-ServiceToken arm
 * (`provider-delete-skip-outcome.test.ts`, which this file mirrors).
 */

const warnSpy = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

const stubClient = vi.hoisted(
  () => () => ({ send, config: { region: () => Promise.resolve('us-east-1') } })
);

vi.mock('@aws-sdk/client-lambda', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-lambda');
  return { ...actual, LambdaClient: vi.fn().mockImplementation(stubClient) };
});
vi.mock('@aws-sdk/client-sns', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-sns');
  return { ...actual, SNSClient: vi.fn().mockImplementation(stubClient) };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  CustomResourceProvider,
  CR_MASKED_SERVICE_TOKEN_SKIP_REASON,
  CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON,
  CR_NO_PROPERTIES_SKIP_REASON,
  CR_NO_SERVICE_TOKEN_SKIP_REASON,
  CR_DELETE_INVOKE_FAILED_SKIP_REASON,
  CR_DELETE_HANDLER_FAILED_SKIP_REASON,
} from '../../../src/provisioning/providers/custom-resource-provider.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { deleteSkipReason } from '../../../src/deployment/delete-outcome.js';
import { withCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const LAMBDA_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:my-handler';

const warnText = () => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

describe('CustomResourceProvider.delete: a masked ServiceToken (issue #3938)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips with the masked-token reason and issues NO AWS call', async () => {
    const result = await new CustomResourceProvider().delete(
      'MaskedDependent',
      'cr-physical-id',
      'Custom::Thing',
      { ServiceToken: SECRET_MASK, Upstream: SECRET_MASK, Role: 'dependent' }
    );

    expect(result).toEqual({ outcome: 'skipped', reason: CR_MASKED_SERVICE_TOKEN_SKIP_REASON });
    // Not the pre-check, not the invoke: the mask names no function.
    expect(send).not.toHaveBeenCalled();
    // The runner reads this as NOT deleted, so the record is kept.
    expect(deleteSkipReason(result)).toBe(CR_MASKED_SERVICE_TOKEN_SKIP_REASON);
  });

  it('warns naming the mask, the logical id, LEFT IN PLACE and the remedies', async () => {
    await new CustomResourceProvider().delete('MaskedDependent', 'cr-physical-id', 'Custom::Thing', {
      ServiceToken: SECRET_MASK,
    });

    const text = warnText();
    expect(text).toContain(
      "ServiceToken for custom resource MaskedDependent is recorded in state as the redaction mask '***'"
    );
    expect(text).toContain('LEFT IN PLACE');
    expect(text).toContain("'cdkd state orphan <stack> --stack-region <region>'");
    // The restore remedy is bounded: a destroy deletes the backing Lambda in
    // the same run, after which the issue-#804 pre-check drops the record.
    expect(text).toContain('helps only while that handler still exists');
    // The deploy-side caveat every skip in this file carries (issue #1762).
    expect(text).toContain('https://github.com/go-to-k/cdkd/issues/1762');
  });

  it('keeps the reason short, state-named, not-invoked and distinct from its siblings', () => {
    // The destroy status line renders it inline; the same shape the shared
    // skip-outcome suite asks of every other skip reason.
    expect(CR_MASKED_SERVICE_TOKEN_SKIP_REASON.length).toBeLessThanOrEqual(64);
    expect(CR_MASKED_SERVICE_TOKEN_SKIP_REASON).toMatch(/state/);
    expect(CR_MASKED_SERVICE_TOKEN_SKIP_REASON).toMatch(/not invoked/);
    const siblings = [
      CR_NO_PROPERTIES_SKIP_REASON,
      CR_NO_SERVICE_TOKEN_SKIP_REASON,
      CR_DELETE_INVOKE_FAILED_SKIP_REASON,
      CR_DELETE_HANDLER_FAILED_SKIP_REASON,
    ];
    expect(siblings).not.toContain(CR_MASKED_SERVICE_TOKEN_SKIP_REASON);
    // A reason is rendered into an Error whose catch classifies "already
    // deleted" by substring (provider-delete-path.md).
    expect(CR_MASKED_SERVICE_TOKEN_SKIP_REASON).not.toMatch(/not found|does not exist|NotFound/i);
  });

  describe('inverted controls: only the WHOLE-leaf mask is refused', () => {
    // `carriesSecretMask` is whole-leaf equality. A token that merely CONTAINS
    // the three characters is not a mask this codebase wrote, and must reach
    // AWS exactly as before. The first call is the issue-#804 pre-check;
    // answering it `ResourceNotFoundException` ends the delete there (as
    // "already deleted"), so reaching it at all proves the guard stayed out.
    const notFound = () =>
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });

    it.each([
      ['a real Lambda ARN', LAMBDA_ARN],
      ['a value embedding the mask', `${LAMBDA_ARN}***`],
      ['a longer run of asterisks', '****'],
    ])('%s reaches the GetFunction pre-check', async (_label, token) => {
      send.mockRejectedValueOnce(notFound());

      await expect(
        new CustomResourceProvider().delete('MyCr', 'cr-physical-id', 'Custom::Thing', {
          ServiceToken: token,
        })
      ).resolves.toBeUndefined();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0].input).toEqual({ FunctionName: token });
      expect(warnText()).not.toContain('redaction mask');
    });

    it('a masked NON-token property does not block the delete', async () => {
      // The Delete request carries the record's other properties too; a mask
      // there is the handler's concern, not an addressing failure.
      send.mockRejectedValueOnce(notFound());

      await expect(
        new CustomResourceProvider().delete('MyCr', 'cr-physical-id', 'Custom::Thing', {
          ServiceToken: LAMBDA_ARN,
          Upstream: SECRET_MASK,
        })
      ).resolves.toBeUndefined();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0].input).toEqual({ FunctionName: LAMBDA_ARN });
    });
  });
});

/**
 * go-to-k/cdkd#3960: the EXPRESSION channel. State keeps a secret reference's
 * `{{resolve:...}}` expression rather than its value, so a ServiceToken built
 * from one is recorded as that expression; the delete path used to send it to
 * `GetFunction` and the invoke as a function name.
 */
describe('CustomResourceProvider.delete: a secret-reference ServiceToken (issue #3960)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SECRET_REF = '{{resolve:secretsmanager:provider-arn:SecretString:arn}}';

  it.each([
    ['a whole secretsmanager reference', SECRET_REF],
    ['a whole ssm-secure reference', '{{resolve:ssm-secure:/provider/arn}}'],
    // Issue #2036: a PUBLIC ssm reference embedded in a longer leaf can still
    // be recorded as its expression where no type proof was available; it
    // cannot address the handler either.
    [
      'an ARN assembled around a plain ssm reference',
      'arn:aws:lambda:us-east-1:111122223333:function:{{resolve:ssm:/provider/fn-name}}',
    ],
    [
      'an ARN assembled around a reference',
      'arn:aws:lambda:us-east-1:111122223333:function:{{resolve:secretsmanager:fn:SecretString:name}}',
    ],
  ])('%s is skipped with the reference reason and NO AWS call', async (_label, token) => {
    const result = await new CustomResourceProvider().delete(
      'SecretTokenCr',
      'cr-physical-id',
      'Custom::Thing',
      { ServiceToken: token }
    );

    expect(result).toEqual({ outcome: 'skipped', reason: CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
    expect(deleteSkipReason(result)).toBe(CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON);
  });

  it('warns naming the logical id, the cause and the remedies, never the reference text', async () => {
    await new CustomResourceProvider().delete('SecretTokenCr', 'cr-physical-id', 'Custom::Thing', {
      ServiceToken: SECRET_REF,
    });

    const text = warnText();
    expect(text).toContain(
      "ServiceToken for custom resource SecretTokenCr is recorded in state as a '{{resolve:...}}' dynamic reference"
    );
    expect(text).toContain(
      'CloudFormation does not support secure (secretsmanager / ssm-secure) dynamic references'
    );
    expect(text).toContain('LEFT IN PLACE');
    // Region-scoped, and scoped to that region's records (go-to-k/cdkd#3996).
    expect(text).toContain("'cdkd state orphan <stack> --stack-region <region>'");
    expect(text).toContain('drops EVERY record for the stack in that region');
    expect(text).toContain('helps only while that handler still exists');
    expect(text).toContain('https://github.com/go-to-k/cdkd/issues/1762');
    // The logical id names the record; the expression (which names the
    // secret) is not repeated into a log line.
    expect(text).not.toContain('provider-arn');
    // Not the mask arm's wording.
    expect(text).not.toContain('redaction mask');
  });

  it('keeps the reason short, state-named, not-invoked and distinct from its siblings', () => {
    expect(CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON.length).toBeLessThanOrEqual(64);
    expect(CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON).toMatch(/state/);
    expect(CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON).toMatch(/not invoked/);
    expect([
      CR_MASKED_SERVICE_TOKEN_SKIP_REASON,
      CR_NO_PROPERTIES_SKIP_REASON,
      CR_NO_SERVICE_TOKEN_SKIP_REASON,
      CR_DELETE_INVOKE_FAILED_SKIP_REASON,
      CR_DELETE_HANDLER_FAILED_SKIP_REASON,
    ]).not.toContain(CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON);
    expect(CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON).not.toMatch(/not found|does not exist|NotFound/i);
  });

  it('a malformed, unterminated reference opener is NOT a reference and still reaches AWS', async () => {
    // `dynamicReferenceTokens` matches complete tokens only; a string that
    // merely starts like one is not a recorded expression.
    const token = '{{resolve:secretsmanager:unterminated';
    send.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' })
    );

    await expect(
      new CustomResourceProvider().delete('MyCr', 'cr-physical-id', 'Custom::Thing', {
        ServiceToken: token,
      })
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].input).toEqual({ FunctionName: token });
  });

  it('a reference in a NON-token property does not block the delete', async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' })
    );

    await expect(
      new CustomResourceProvider().delete('MyCr', 'cr-physical-id', 'Custom::Thing', {
        ServiceToken: LAMBDA_ARN,
        Password: SECRET_REF,
      })
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].input).toEqual({ FunctionName: LAMBDA_ARN });
  });
});

/**
 * go-to-k/cdkd#4009: the handler is never sent a secret's plaintext. The bag is
 * the one the deploy engine / rollback replay / nested child engine binds for
 * the resource with `withCurrentResourceSecrets`.
 */
describe('CustomResourceProvider create / update refuse a resolved secret (issue #4009)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PLAINTEXT = 'db-password-plaintext';
  const secrets = () =>
    new Map<string, string>([[PLAINTEXT, '{{resolve:ssm:/app/db-password}}']]);

  it('create: refuses, non-retryable, naming the path and never the value, with no AWS call', async () => {
    let caught: unknown;
    try {
      await withCurrentResourceSecrets(secrets(), () =>
        new CustomResourceProvider().create('DbInit', 'Custom::DbInit', {
          ServiceToken: LAMBDA_ARN,
          Password: PLAINTEXT,
        })
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('Custom resource DbInit: Password resolved to the value of a secret');
    expect(message).toContain('CloudFormation does not support secure dynamic references');
    expect(message).not.toContain(PLAINTEXT);
    expect(isMarkedNonRetryable(caught)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('update: refuses on the NEW properties, non-retryable, carrying the physical id', async () => {
    let caught: unknown;
    try {
      await withCurrentResourceSecrets(secrets(), () =>
        new CustomResourceProvider().update(
          'DbInit',
          'phys-1',
          'Custom::DbInit',
          { ServiceToken: LAMBDA_ARN, Nested: { Conn: `user:${PLAINTEXT}@db` } },
          { ServiceToken: LAMBDA_ARN, Nested: { Conn: '{{resolve:ssm:/app/db-password}}' } }
        )
      );
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).toMatch(/Custom resource DbInit: Nested\.Conn resolved to the value of a secret/);
    expect(message).not.toContain(PLAINTEXT);
    expect(isMarkedNonRetryable(caught)).toBe(true);
    expect((caught as { physicalId?: string }).physicalId).toBe('phys-1');
    expect(send).not.toHaveBeenCalled();
  });

  it('update: refuses a plaintext on the PREVIOUS side (sent as OldResourceProperties)', async () => {
    // `cdkd rollback --revert-failed` re-resolves a failed op's attempted
    // properties into exactly this side.
    await expect(
      withCurrentResourceSecrets(secrets(), () =>
        new CustomResourceProvider().update(
          'DbInit',
          'phys-1',
          'Custom::DbInit',
          { ServiceToken: LAMBDA_ARN, Value: 'clean' },
          { ServiceToken: LAMBDA_ARN, Value: PLAINTEXT }
        )
      )
    ).rejects.toThrow(/Custom resource DbInit: OldResourceProperties\.Value resolved to the value/);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a secret that reached the properties only in a derived form (base64)', async () => {
    const encoded = Buffer.from(PLAINTEXT).toString('base64');
    const bag = new Map<string, string>([
      [PLAINTEXT, '{{resolve:ssm:/app/db-password}}'],
      [encoded, SECRET_MASK],
    ]);
    await expect(
      withCurrentResourceSecrets(bag, () =>
        new CustomResourceProvider().create('DbInit', 'Custom::DbInit', {
          ServiceToken: LAMBDA_ARN,
          Blob: encoded,
        })
      )
    ).rejects.toThrow(/a property \(in a form cdkd cannot point to, e\.g\. base64-encoded or a fragment\) resolved to/);
    expect(send).not.toHaveBeenCalled();
  });

  // The two negatives stop at the invoke itself: a provider whose invoke is
  // stubbed to fail with a sentinel proves the guard let the call through.
  const reachingInvoke = () => {
    const provider = new CustomResourceProvider();
    (provider as unknown as { invokeCustomResourceWithRetry: unknown }).invokeCustomResourceWithRetry =
      vi.fn().mockRejectedValue(new Error('reached-invoke'));
    return provider;
  };

  it('a NoEcho (mask-only) value in the bag does not block the invoke', async () => {
    await expect(
      withCurrentResourceSecrets(new Map([[PLAINTEXT, SECRET_MASK]]), () =>
        reachingInvoke().create('Dependent', 'Custom::Dependent', {
          ServiceToken: LAMBDA_ARN,
          Upstream: PLAINTEXT,
        })
      )
    ).rejects.toThrow(/reached-invoke/);
  });

  it('with no bound bag (a caller that binds none) the guard is inert', async () => {
    await expect(
      reachingInvoke().create('Plain', 'Custom::Plain', {
        ServiceToken: LAMBDA_ARN,
        Password: PLAINTEXT,
      })
    ).rejects.toThrow(/reached-invoke/);
  });
});
