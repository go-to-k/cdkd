import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetTopicAttributesCommand } from '@aws-sdk/client-sns';

/**
 * The `create` / `update` / `delete` wraps must not write the CALLER'S
 * IDENTITY into a persisted store (go-to-k/cdkd#2319), nor out-throw the
 * failure they wrap (go-to-k/cdkd#3341).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and SNS words an `AuthorizationError` as `User:
 * arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized to
 * perform: ...`. Every AWS fixture carries that real wording.
 */

const { mockSend, debugSpy, warnSpy, infoSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debugSpy: vi.fn(),
  warnSpy: vi.fn(),
  infoSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { SNSTopicPolicyProvider } from '../../../src/provisioning/providers/sns-topic-policy-provider.js';
import {
  hasRedactedCause,
  isIamPropagationError,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { withRetry } from '../../../src/deployment/retry.js';

const RESOURCE_TYPE = 'AWS::SNS::TopicPolicy';
const LOGICAL_ID = 'MyTopicPolicy';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:my-topic';
const DOC = { Version: '2012-10-17', Statement: [{ Sid: 'Mine', Effect: 'Allow' }] };
const PROPERTIES = { Topics: [TOPIC], PolicyDocument: DOC };

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/** SNS's `AuthorizationError` as it really words it. */
function authorizationErrorNamingTheCaller(): Error {
  const e = new Error(
    `User: ${CALLER_ARN} is not authorized to perform: SNS:SetTopicAttributes on resource: ` +
      `${TOPIC} because no identity-based policy allows the SNS:SetTopicAttributes action`
  );
  return Object.assign(e, {
    name: 'AuthorizationErrorException',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });
}

/** Every SetTopicAttributes rejects with `err`; a read returns the attempted document. */
function rejectWrites(err: unknown): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof GetTopicAttributesCommand) {
      return Promise.resolve({ Attributes: { Policy: JSON.stringify(DOC) } });
    }
    return Promise.reject(err);
  });
}

const debugText = (): string => debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
const defaultLevelText = (): string =>
  [...infoSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join('\n');

async function capture(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw, but it resolved');
}

/** The identity fragments, asserted one by one so a PARTIAL redaction cannot pass. */
function expectNoCallerIdentity(text: string): void {
  expect(text).not.toContain(CALLER_ARN);
  expect(text).not.toContain(CALLER_ACCOUNT);
  expect(text).not.toContain(CALLER_ROLE);
  expect(text).not.toContain(CALLER_SESSION);
  expect(text).not.toContain('assumed-role');
  expect(text).not.toContain('is not authorized to perform');
}

describe('SNSTopicPolicyProvider thrown-failure identity redaction (go-to-k/cdkd#2319)', () => {
  let provider: SNSTopicPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new SNSTopicPolicyProvider();
  });

  const operations: Array<{
    name: string;
    operation: 'create' | 'update' | 'delete';
    run: (p: SNSTopicPolicyProvider, maskSecrets?: (t: string) => string) => Promise<unknown>;
  }> = [
    {
      name: 'create()',
      operation: 'create',
      run: (p, maskSecrets) =>
        p.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES, maskSecrets && { maskSecrets }),
    },
    {
      name: 'update()',
      operation: 'update',
      run: (p, maskSecrets) =>
        p.update(
          LOGICAL_ID,
          TOPIC,
          RESOURCE_TYPE,
          PROPERTIES,
          PROPERTIES,
          maskSecrets && { maskSecrets }
        ),
    },
    {
      name: 'delete()',
      operation: 'delete',
      run: (p, maskSecrets) =>
        p.delete(LOGICAL_ID, TOPIC, RESOURCE_TYPE, PROPERTIES, maskSecrets && { maskSecrets }),
    },
    {
      name: "a failed create's delete",
      operation: 'delete',
      run: (p, maskSecrets) =>
        p.delete(LOGICAL_ID, TOPIC, RESOURCE_TYPE, PROPERTIES, {
          failedCreateOrphan: true,
          ...(maskSecrets && { maskSecrets }),
        }),
    },
  ];

  describe.each(operations)('$name', ({ operation, run }) => {
    it('names the CLASS and withholds the caller identity from the thrown message', async () => {
      rejectWrites(authorizationErrorNamingTheCaller());

      const thrown = await capture(() => run(provider));

      expect(thrown.name).toBe('ProvisioningError');
      expect(thrown.message).toContain(
        `Failed to ${operation} SNS topic policy ${LOGICAL_ID}: AuthorizationErrorException`
      );
      expect(thrown.message).toContain('--verbose');
      expectNoCallerIdentity(thrown.message);
    });

    it("keeps AWS's own message at logger.debug, and nowhere at default level", async () => {
      rejectWrites(authorizationErrorNamingTheCaller());

      await capture(() => run(provider));

      expect(debugText()).toContain('no identity-based policy allows');
      expect(debugText()).toContain(CALLER_ARN);
      expect(defaultLevelText()).not.toContain(CALLER_ARN);
    });

    it('keeps the AWS error as cause and stamps the redaction for the retry classifiers', async () => {
      const aws = authorizationErrorNamingTheCaller();
      rejectWrites(aws);

      const thrown = await capture(() => run(provider));

      expect(thrown.cause).toBe(aws);
      expect(hasRedactedCause(thrown)).toBe(true);
      const classify = retryClassificationText(thrown);
      expect(isRetryableTransientError(thrown, classify)).toBe(true);
      expect(isIamPropagationError(classify)).toBe(true);
    });

    it('does not out-throw a value String() cannot convert (go-to-k/cdkd#3341)', async () => {
      rejectWrites(Object.create(null));

      const thrown = await capture(() => run(provider));

      expect(thrown.name).toBe('ProvisioningError');
      expect(thrown.message).toContain(
        `Failed to ${operation} SNS topic policy ${LOGICAL_ID}: a non-Error value of type object`
      );
      expect(thrown.cause).toBeUndefined();
      expect(hasRedactedCause(thrown)).toBe(false);
    });

    it('NEGATIVE CONTROL: an Error AWS did not author passes through VERBATIM, unstamped', async () => {
      // No `$fault` / numeric `$metadata.httpStatusCode`: a transport failure,
      // whose text names a host, never a caller, and is the diagnosis.
      rejectWrites(new Error('connect ECONNREFUSED 10.0.0.1:443'));

      const thrown = await capture(() => run(provider));

      expect(thrown.message).toBe(
        `Failed to ${operation} SNS topic policy ${LOGICAL_ID}: connect ECONNREFUSED 10.0.0.1:443`
      );
      expect(hasRedactedCause(thrown)).toBe(false);
      expect(debugText()).not.toContain(`Failed to ${operation} SNS topic policy`);
    });

    it("routes the debug line through this operation's masker", async () => {
      // Each call site passes its own masker, so each is exercised.
      const secret = 'tok-SECRETVALUE-9f3a';
      rejectWrites(
        Object.assign(new Error(`Invalid parameter: Policy Error: ${secret}`), {
          name: 'InvalidParameterException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        })
      );

      await capture(() => run(provider, (t: string) => t.split(secret).join('***')));

      expect(debugText()).toContain('Policy Error: ***');
      expect(debugText()).not.toContain(secret);
    });
  });

  it('and withRetry ITSELF re-attempts the redacted wrap', async () => {
    rejectWrites(authorizationErrorNamingTheCaller());
    const attempts: unknown[] = [];
    const logLines: string[] = [];

    await expect(
      withRetry(
        async () => {
          attempts.push(1);
          return provider.create(LOGICAL_ID, RESOURCE_TYPE, PROPERTIES);
        },
        LOGICAL_ID,
        {
          maxRetries: 2,
          sleep: async () => {},
          logger: {
            debug: (line: string) => logLines.push(line),
            warn: (line: string) => logLines.push(line),
          },
        }
      )
    ).rejects.toThrow(/AuthorizationErrorException/);

    expect(attempts).toHaveLength(3);
    expect(logLines.join('\n')).not.toContain(CALLER_ARN);
  });
});
