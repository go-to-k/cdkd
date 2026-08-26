import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #2178 — the RUNTIME twin of `scripts/check-provider-secret-mask.ts` for
 * `CustomResourceProvider`.
 *
 * `parseLambdaPayload` refuses a payload that is not a cfn-response shape and
 * QUOTES THE WHOLE PARSED PAYLOAD. A handler routinely echoes its
 * `ResourceProperties` back in `Data`, and those arrive RESOLVED, so that
 * payload can carry plaintext. The site has TWO arms: the create / update paths
 * thread `maskerOrIdentity(context?.maskSecrets)`, and the DELETE path threads
 * `DELETE_PATH_UNMASKED` (`undefined`) because `DeleteContext` carries no
 * masker by the `SecretMaskingContext` contract. This file measures the MASKED
 * arm.
 *
 * HOW THE MESSAGE IS OBSERVED, and why it is not read off a logger or a
 * rejection. `parseLambdaPayload` is module-private and its only caller wraps
 * it in `try { … } catch { this.logger.debug('Lambda payload parse failed …') }`
 * — the error object is DISCARDED without `error.message` ever being read, and
 * the invocation then falls through to the S3 response poll and SUCCEEDS. So
 * there is no sink to assert against today; the provider says as much in its
 * own comment, and the mask is there because the bound is forward-looking (the
 * moment that catch logs `error.message`, the value is out).
 *
 * Asserting "the masker was called" alone would pin the THREADING and not the
 * TEXT, so instead this file records what `JSON.stringify` actually renders
 * during the invocation — the exact string the refusal interpolates — and
 * asserts over that. The recorder is installed only for the duration of the
 * drive and restored before any assertion runs.
 */

const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:Stack-Handler';
const RESOURCE_TYPE = 'Custom::Issue2178';

/** Distinctive, >= 8 chars, and a substring of nothing else in the payload. */
const SECRET_PLAINTEXT = 'customres2178-payload-plaintext';

/**
 * The invalid payload, written as a LITERAL rather than built with
 * `JSON.stringify`: the recorder below captures every `JSON.stringify` call
 * made while the drive runs, so building the fixture that way would seed the
 * transcript with the very string under assertion.
 *
 * Invalid because `PhysicalResourceId` is not a string, which is what routes it
 * into the refusal — and it puts the secret at a NESTED leaf, so the `maskDeep`
 * WALK is what has to find it.
 */
const BAD_PAYLOAD = `{"PhysicalResourceId":{"nested":{"bad":"${SECRET_PLAINTEXT}"}}}`;
const BAD_PAYLOAD_NON_SECRET = `{"PhysicalResourceId":{"nested":{"bad":"ordinary-handler-junk"}}}`;

/** Computed at module scope, i.e. before the recorder is ever installed. */
const realStringify = JSON.stringify;
const MASKED_RENDERING = realStringify({ PhysicalResourceId: { nested: { bad: SECRET_MASK } } });
const RAW_RENDERING = realStringify({
  PhysicalResourceId: { nested: { bad: SECRET_PLAINTEXT } },
});

function maskSecrets(): (text: string) => string {
  const bag: RecordedSecretValues = new Map([
    [SECRET_PLAINTEXT, '{{resolve:secretsmanager:cr/data:SecretString:v::}}'],
  ]);
  return createSecretMasker(bag);
}

/** The handler's own cfn-response, PUT to S3 — what makes the create succeed. */
function wireFlow(payloadJson: string): void {
  mockS3Send.mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'GetObjectCommand') {
      return Promise.resolve({
        Body: {
          transformToString: () =>
            Promise.resolve(
              '{"Status":"SUCCESS","PhysicalResourceId":"phys-2178","Data":{"Out":"ok"}}'
            ),
        },
      });
    }
    return Promise.resolve({});
  });

  mockLambdaSend.mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'InvokeCommand') {
      return Promise.resolve({ Payload: Buffer.from(payloadJson, 'utf8') });
    }
    return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
  });
}

function makeProvider(): CustomResourceProvider {
  return new CustomResourceProvider({
    responseBucket: 'test-bucket',
    asyncResponseTimeoutMs: 10_000,
  });
}

/**
 * Run `drive` with a `JSON.stringify` recorder installed, and hand back every
 * string it rendered. Restored in a `finally`, so no assertion ever runs under
 * the spy.
 */
async function renderingsDuring(drive: () => Promise<unknown>): Promise<string> {
  const rendered: string[] = [];
  const spy = vi.spyOn(JSON, 'stringify');
  spy.mockImplementation(((value: unknown, replacer?: unknown, space?: unknown) => {
    const out = realStringify(value as never, replacer as never, space as never);
    if (typeof out === 'string') rendered.push(out);
    return out;
  }) as typeof JSON.stringify);

  try {
    await drive();
  } finally {
    spy.mockRestore();
  }
  return rendered.join('\n---\n');
}

describe('CustomResourceProvider masks the invalid-payload refusal (issue #2178)', () => {
  let provider: CustomResourceProvider;

  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    provider = makeProvider();
  });

  it('masks the resolved secret in the payload the create() refusal renders', async () => {
    wireFlow(BAD_PAYLOAD);

    const rendered = await renderingsDuring(() =>
      provider.create('MyCR', RESOURCE_TYPE, { ServiceToken: SERVICE_TOKEN }, {
        maskSecrets: maskSecrets(),
      })
    );

    // Non-vacuity first: the refusal's rendering IS in the transcript, so the
    // absence assertion below is about masking and not about a path not taken.
    expect(rendered).toContain(MASKED_RENDERING);
    expect(rendered).not.toContain(SECRET_PLAINTEXT);
  });

  it('masks the resolved secret in the payload the update() refusal renders', async () => {
    wireFlow(BAD_PAYLOAD);

    const rendered = await renderingsDuring(() =>
      provider.update(
        'MyCR',
        'phys-2178',
        RESOURCE_TYPE,
        { ServiceToken: SERVICE_TOKEN, Changed: 'yes' },
        { ServiceToken: SERVICE_TOKEN, Changed: 'no' },
        { maskSecrets: maskSecrets() }
      )
    );

    expect(rendered).toContain(MASKED_RENDERING);
    expect(rendered).not.toContain(SECRET_PLAINTEXT);
  });

  // A DIRECT reading of the same fact, independent of the recorder: the masker
  // the provider threaded is handed the RAW leaf (so the walk ran BEFORE the
  // stringify) and answers with the marker (so it is not the identity
  // function). Both halves are what a threading bug would break.
  it('hands the threaded masker the raw leaf and takes back the marker', async () => {
    wireFlow(BAD_PAYLOAD);

    const real = maskSecrets();
    const maskSpy = vi.fn((text: string) => real(text));

    await provider.create('MyCR', RESOURCE_TYPE, { ServiceToken: SERVICE_TOKEN }, {
      maskSecrets: maskSpy,
    });

    const call = maskSpy.mock.calls.findIndex(([text]) => text === SECRET_PLAINTEXT);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(maskSpy.mock.results[call]?.value).toBe(SECRET_MASK);
  });

  // THE CONTROL. `maskerOrIdentity(undefined)` is identity, so with no context
  // the plaintext must survive INTACT — without this case a refusal that never
  // rendered the payload would satisfy both assertions above.
  it('leaves the plaintext INTACT when no context is supplied — the control', async () => {
    wireFlow(BAD_PAYLOAD);

    const rendered = await renderingsDuring(() =>
      provider.create('MyCR', RESOURCE_TYPE, { ServiceToken: SERVICE_TOKEN })
    );

    expect(rendered).toContain(RAW_RENDERING);
    expect(rendered).toContain(SECRET_PLAINTEXT);
  });

  it('does not mangle a non-secret payload when a masker IS supplied', async () => {
    wireFlow(BAD_PAYLOAD_NON_SECRET);

    const rendered = await renderingsDuring(() =>
      provider.create('MyCR', RESOURCE_TYPE, { ServiceToken: SERVICE_TOKEN }, {
        maskSecrets: maskSecrets(),
      })
    );

    expect(rendered).toContain('ordinary-handler-junk');
    expect(rendered).not.toContain(SECRET_MASK);
  });
});
