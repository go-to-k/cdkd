import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';

const { mockSend, debug } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFront: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { CloudFrontOAIProvider } from '../../../src/provisioning/providers/cloudfront-oai-provider.js';
import {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';

// create() runs outside a withStackScope scope here, so the stack-scoped
// create token (go-to-k/cdkd#4428) is opted out of its guard.
beforeAll(() => {
  allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(false);
});

// go-to-k/cdkd#2319: every create / update / delete wrap is persisted to
// `deployments/{runId}.jsonl`, so an AWS-authored failure is named by its class
// plus the --verbose pointer; AWS's text (the caller's role ARN) goes to the
// masked debug line and stays on `cause` for the retry classifiers.
const TYPE = 'AWS::CloudFront::CloudFrontOriginAccessIdentity';
const DENIED =
  'User: arn:aws:sts::111122223333:assumed-role/deployer/s3cr3t is not authorized to perform: cloudfront:X';
const denied = (): Error =>
  Object.assign(new Error(DENIED), {
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

const PROPS = { CloudFrontOriginAccessIdentityConfig: { Comment: 'c' } };

const cases: Array<{ wrap: string; run: (p: CloudFrontOAIProvider) => Promise<unknown> }> = [
  {
    wrap: 'Failed to create CloudFront OAI Oai',
    run: (p) => p.create('Oai', TYPE, PROPS, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to update CloudFront OAI Oai',
    run: (p) => p.update('Oai', 'E123', TYPE, PROPS, PROPS, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to delete CloudFront OAI Oai',
    run: (p) => p.delete('Oai', 'E123', TYPE, undefined, { maskSecrets: mask }),
  },
];

describe('CloudFrontOAIProvider thrown wraps withhold AWS text (#2319)', () => {
  let provider: CloudFrontOAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new CloudFrontOAIProvider();
  });

  it.each(cases)('$wrap: an AWS-authored failure is named by its class', async (c) => {
    mockSend.mockRejectedValue(denied());

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`${c.wrap}: AccessDenied. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('111122223333');
    expect(failure.message).not.toContain('not authorized');
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines()).toContain(`${c.wrap}: ${mask(DENIED)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it.each(cases)('$wrap: a cdkd-authored failure keeps its text, masked', async (c) => {
    mockSend.mockRejectedValue(new Error('socket hang up near s3cr3t'));

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`${c.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('s3cr3t');
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it('a cdkd-authored failure the mask leaves alone is not stamped', async () => {
    mockSend.mockRejectedValue(new Error('socket hang up'));

    const failure = await caught(cases[0]!.run(provider));

    expect(failure.message).toBe(`${cases[0]!.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('a non-Error throw is withheld, unstamped', async () => {
    mockSend.mockRejectedValue('raw s3cr3t value');

    const failure = await caught(provider.delete('Oai', 'E123', TYPE));

    expect(failure.message).toBe(
      `Failed to delete CloudFront OAI Oai: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(false);
  });

  // A transport error the SDK retried carries `$metadata` with only the retry
  // counters (no `$fault`, no `httpStatusCode`): cdkd-side text, kept and masked.
  it('a retried transport error keeps its text, masked', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('socket hang up near s3cr3t'), {
        name: 'TimeoutError',
        $metadata: { attempts: 3, totalRetryDelay: 120 },
      })
    );

    const failure = await caught(cases[0]!.run(provider));

    expect(failure.message).toBe(`${cases[0]!.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('TimeoutError');
    expect(failure.message).not.toContain(VERBOSE_POINTER);
    expect(failure.message).not.toContain('s3cr3t');
  });

  // A reused CallerReference with another config is CloudFront's collision.
  it('restates an "already exists" from CreateCloudFrontOriginAccessIdentity', async () => {
    mockSend.mockRejectedValue(
      Object.assign(
        new Error(
          'If the CallerReference is a value you already sent in a previous request to create an identity but the content of the CloudFrontOriginAccessIdentityConfig is different from the original request, CloudFront returns a CloudFrontOriginAccessIdentityAlreadyExists error.'
        ),
        {
          name: 'CloudFrontOriginAccessIdentityAlreadyExists',
          $fault: 'client',
          $metadata: { httpStatusCode: 409 },
        }
      )
    );

    const failure = await caught(provider.create('Oai', TYPE, PROPS));

    expect(failure.message).toBe(
      `Failed to create CloudFront OAI Oai: CloudFrontOriginAccessIdentityAlreadyExists. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain('CallerReference');
    expect(isNameCollisionErrorFrom(failure, 'Oai')).toBe(true);
  });
});
