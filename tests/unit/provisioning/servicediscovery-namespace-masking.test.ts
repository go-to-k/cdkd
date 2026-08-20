import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreatePrivateDnsNamespaceCommand,
  CreateHttpNamespaceCommand,
  CreatePublicDnsNamespaceCommand,
  UpdatePrivateDnsNamespaceCommand,
  UpdateHttpNamespaceCommand,
  UpdatePublicDnsNamespaceCommand,
  UpdateServiceCommand,
  GetOperationCommand,
  TagResourceCommand,
} from '@aws-sdk/client-servicediscovery';
import {
  MIN_NEEDLE_LENGTH,
  SECRET_MASK,
  createSecretMasker,
} from '../../../src/deployment/secret-redaction.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Issue #2063, ServiceDiscovery half — the SIX namespace arms issue #2050's
 * threading left out (three kinds x create/update; the issue body says "four",
 * corrected by its own review comment), plus `pollOperation`, which the issue
 * did not name at all.
 *
 * Two disclosure surfaces, and they need SEPARATE tests because one cannot
 * cover the other:
 *
 * 1. THE ARM'S OWN CATCH. A raw AWS rejection of the submit call, or of the
 *    `TagResource` in `syncNamespaceTags`, is interpolated into the arm's
 *    `ProvisioningError` — printed at ERROR, i.e. DEFAULT verbosity, by
 *    `deploy-engine.ts`.
 * 2. `pollOperation`'s `Operation.ErrorMessage`. Cloud Map's create / update
 *    are OPERATION-BASED, so the submit call usually succeeds and AWS reports
 *    its rejection asynchronously — quoting the offending value back. And
 *    because every arm's catch opens with
 *    `if (error instanceof ProvisioningError) throw error;`, the error built
 *    there is re-thrown VERBATIM: masking the arm does nothing for it. This is
 *    also live on `updateService`, an arm issue #2050 DID thread, which is why
 *    it is tested here too.
 *
 * Every assertion is on the STRING that escaped, never on a masker having been
 * passed.
 */

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-servicediscovery', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-servicediscovery')>(
    '@aws-sdk/client-servicediscovery'
  );
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger['child'] = () => logger;
  return { getLogger: () => logger };
});

import { getLogger } from '../../../src/utils/logger.js';
import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';

const logger = getLogger() as unknown as {
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

const PRIVATE_DNS = 'AWS::ServiceDiscovery::PrivateDnsNamespace';
const HTTP_NS = 'AWS::ServiceDiscovery::HttpNamespace';
const PUBLIC_DNS = 'AWS::ServiceDiscovery::PublicDnsNamespace';
const SERVICE = 'AWS::ServiceDiscovery::Service';

/**
 * A Secrets Manager JSON DOCUMENT, per issue #2063 acceptance item 4 — not a
 * scalar. A scalar passes under both orderings of mask-vs-stringify and so
 * cannot discriminate them; a document carries the `"` and `\` that
 * `JSON.stringify` escapes. Distinctive enough not to collide with another
 * suite's "must not appear" needle.
 */
const SECRET_PLAINTEXT = '{"user":"cloudmap-ns-2063","pass":"q\\x2fz#3a9d"}';
const SECRET_EXPR = '{{resolve:secretsmanager:cloudmap-ns-2063:SecretString:doc::}}';

const maskSecrets = createSecretMasker(new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]));

/** An AWS rejection that quotes the offending value back. */
function awsRejection(): Error {
  const err = new Error(`InvalidInput: namespace description ${SECRET_PLAINTEXT} is not permitted`);
  err.name = 'InvalidInput';
  (err as unknown as Record<string, unknown>)['$metadata'] = {
    httpStatusCode: 400,
    requestId: 'req-sd-ns-2063',
  };
  return err;
}

/**
 * A FAILED Cloud Map operation. The submit call SUCCEEDS here — this is the
 * asynchronous rejection path, which is the normal one for these arms.
 */
function failedOperation(errorMessage?: string): Record<string, unknown> {
  return {
    Operation: {
      Status: 'FAIL',
      ErrorMessage: errorMessage ?? `InvalidInput: value ${SECRET_PLAINTEXT} was rejected`,
    },
  };
}

function payloadHasSecretLeaf(value: unknown): boolean {
  if (typeof value === 'string') return value === SECRET_PLAINTEXT;
  if (Array.isArray(value)) return value.some(payloadHasSecretLeaf);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(payloadHasSecretLeaf);
  }
  return false;
}

/**
 * Non-vacuity: the plaintext really did go out on the wire, so a masked message
 * means the fix worked rather than the value never having arrived.
 *
 * Walks the LEAVES rather than `JSON.stringify(input).includes(...)`, because
 * the fixture secret is a JSON document whose quotes `stringify` escapes — the
 * very gap acceptance item 4 is about.
 */
function expectPayloadCarriedThePlaintext(cls: abstract new (...args: never[]) => object): void {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof cls);
  expect(call).toBeDefined();
  expect(payloadHasSecretLeaf((call![0] as { input: unknown }).input)).toBe(true);
}

function loggedLines(): string {
  return [...logger.debug.mock.calls, ...logger.warn.mock.calls]
    .map((c) => String(c[0]))
    .join('\n');
}

async function captureThrow(fn: () => Promise<unknown>): Promise<ProvisioningError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisioningError);
    return error as ProvisioningError;
  }
  throw new Error('expected the provider call to reject, but it resolved');
}

/** The submit call rejects synchronously; the arm's own catch is the surface. */
function primeSubmitRejection(cls: abstract new (...args: never[]) => object): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof cls) return Promise.reject(awsRejection());
    return Promise.resolve({});
  });
}

/** The submit call succeeds; the OPERATION then reports FAIL. */
function primeOperationFailure(errorMessage?: string): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof GetOperationCommand)
      return Promise.resolve(failedOperation(errorMessage));
    return Promise.resolve({ OperationId: 'op-1' });
  });
}

/**
 * The four namespace arms under test, as data. Each row is (arm label, the
 * command class the submit uses, the provider call, the sentence the arm's own
 * catch builds).
 */
const NAMESPACE_CREATE_ARMS = [
  {
    label: 'PrivateDnsNamespace',
    submit: CreatePrivateDnsNamespaceCommand,
    type: PRIVATE_DNS,
    props: { Name: 'ns.local', Vpc: 'vpc-1', Description: SECRET_PLAINTEXT },
    sentence: 'Failed to create private DNS namespace Ns',
  },
  {
    label: 'HttpNamespace',
    submit: CreateHttpNamespaceCommand,
    type: HTTP_NS,
    props: { Name: 'ns-http', Description: SECRET_PLAINTEXT },
    sentence: 'Failed to create HTTP namespace Ns',
  },
  {
    label: 'PublicDnsNamespace',
    submit: CreatePublicDnsNamespaceCommand,
    type: PUBLIC_DNS,
    props: { Name: 'ns.example.com', Description: SECRET_PLAINTEXT },
    sentence: 'Failed to create public DNS namespace Ns',
  },
] as const;

const NAMESPACE_UPDATE_ARMS = [
  {
    label: 'PrivateDnsNamespace',
    submit: UpdatePrivateDnsNamespaceCommand,
    type: PRIVATE_DNS,
    sentence: 'Failed to update private DNS namespace Ns',
  },
  {
    label: 'HttpNamespace',
    submit: UpdateHttpNamespaceCommand,
    type: HTTP_NS,
    sentence: 'Failed to update HTTP namespace Ns',
  },
  {
    label: 'PublicDnsNamespace',
    submit: UpdatePublicDnsNamespaceCommand,
    type: PUBLIC_DNS,
    sentence: 'Failed to update public DNS namespace Ns',
  },
] as const;

describe('ServiceDiscoveryProvider namespace secret masking (#2063)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  describe('create arms — thrown ProvisioningError from the arm`s own catch', () => {
    for (const arm of NAMESPACE_CREATE_ARMS) {
      it(`masks the AWS message on ${arm.label}`, async () => {
        primeSubmitRejection(arm.submit);

        const thrown = await captureThrow(() =>
          provider.create('Ns', arm.type, arm.props, { maskSecrets })
        );

        expectPayloadCarriedThePlaintext(arm.submit);

        expect(thrown.message).toContain(arm.sentence);
        expect(thrown.message).toContain(SECRET_MASK);
        expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
      });

      it(`leaves ${arm.label} untouched when the caller threads no masker`, async () => {
        primeSubmitRejection(arm.submit);

        const thrown = await captureThrow(() => provider.create('Ns', arm.type, arm.props));

        // The back-compatible default the SecretMaskingContext contract
        // mandates: absent means unmasked, and the sentence still lands.
        expect(thrown.message).toContain(arm.sentence);
        expect(thrown.message).toContain(SECRET_PLAINTEXT);
      });
    }
  });

  describe('update arms — thrown ProvisioningError from the arm`s own catch', () => {
    for (const arm of NAMESPACE_UPDATE_ARMS) {
      it(`masks the AWS message on ${arm.label}`, async () => {
        primeSubmitRejection(arm.submit);

        const thrown = await captureThrow(() =>
          provider.update(
            'Ns',
            'ns-abc',
            arm.type,
            { Description: SECRET_PLAINTEXT },
            { Description: 'old' },
            { maskSecrets }
          )
        );

        expectPayloadCarriedThePlaintext(arm.submit);

        expect(thrown.message).toContain(arm.sentence);
        expect(thrown.message).toContain(SECRET_MASK);
        expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
      });

      it(`leaves ${arm.label} untouched when the caller threads no masker`, async () => {
        primeSubmitRejection(arm.submit);

        const thrown = await captureThrow(() =>
          provider.update(
            'Ns',
            'ns-abc',
            arm.type,
            { Description: SECRET_PLAINTEXT },
            { Description: 'old' }
          )
        );

        expect(thrown.message).toContain(arm.sentence);
        expect(thrown.message).toContain(SECRET_PLAINTEXT);
      });
    }

    /**
     * The `TagResource` path is a SECOND payload in the update arms that the
     * submit-rejection cases above never reach: it fires from
     * `syncNamespaceTags` AFTER the namespace body call, and carries resolved
     * tag VALUES rather than the Description.
     */
    it('masks a TagResource rejection carrying a resolved tag value', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof TagResourceCommand) return Promise.reject(awsRejection());
        if (command instanceof GetOperationCommand) {
          return Promise.resolve({ Operation: { Status: 'SUCCESS', Targets: { NAMESPACE: 'ns' } } });
        }
        return Promise.resolve({ OperationId: 'op-1', Namespace: { Arn: 'arn:ns' } });
      });

      const thrown = await captureThrow(() =>
        provider.update(
          'Ns',
          'ns-abc',
          HTTP_NS,
          { Tags: [{ Key: 'owner', Value: SECRET_PLAINTEXT }] },
          {},
          { maskSecrets }
        )
      );

      expectPayloadCarriedThePlaintext(TagResourceCommand);

      expect(thrown.message).toContain('Failed to update HTTP namespace Ns');
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
    });
  });

  /**
   * The site the issue did not name. Distinct from every test above: the submit
   * SUCCEEDS, so no arm catch ever sees a raw error — and the
   * `ProvisioningError` `pollOperation` builds is re-thrown verbatim past the
   * arm's `maskErrorMessage`. Masking the arm alone leaves this open.
   */
  describe('pollOperation — the operation`s own ErrorMessage', () => {
    const OPERATION_ARMS = [
      { label: 'create PrivateDnsNamespace', run: (ctx?: object) =>
          provider.create('Ns', PRIVATE_DNS, { Name: 'ns.local', Vpc: 'vpc-1' }, ctx) },
      { label: 'create HttpNamespace', run: (ctx?: object) =>
          provider.create('Ns', HTTP_NS, { Name: 'ns-http' }, ctx) },
      { label: 'create PublicDnsNamespace', run: (ctx?: object) =>
          provider.create('Ns', PUBLIC_DNS, { Name: 'ns.example.com' }, ctx) },
      { label: 'update PrivateDnsNamespace', run: (ctx?: object) =>
          provider.update('Ns', 'ns-abc', PRIVATE_DNS, { Description: 'a' }, { Description: 'b' }, ctx) },
      { label: 'update HttpNamespace', run: (ctx?: object) =>
          provider.update('Ns', 'ns-abc', HTTP_NS, { Description: 'a' }, { Description: 'b' }, ctx) },
      { label: 'update PublicDnsNamespace', run: (ctx?: object) =>
          provider.update('Ns', 'ns-abc', PUBLIC_DNS, { Description: 'a' }, { Description: 'b' }, ctx) },
      // Threaded by issue #2050 for its `withRetry` calls, but its
      // `pollOperation` call was left unmasked — the same hole, on an arm that
      // already looked done.
      { label: 'update Service', run: (ctx?: object) =>
          provider.update('Svc', 'srv-1', SERVICE, { Description: 'a' }, { Description: 'b' }, ctx) },
    ] as const;

    for (const arm of OPERATION_ARMS) {
      it(`masks the FAILED operation message on ${arm.label}`, async () => {
        primeOperationFailure();

        const thrown = await captureThrow(() => arm.run({ maskSecrets }));

        // Non-vacuity, and what makes this NOT a duplicate of the arm tests:
        // the submit succeeded, so the arm's catch never saw a raw error.
        expect(mockSend.mock.calls.some((c) => c[0] instanceof GetOperationCommand)).toBe(true);
        expect(thrown.message).toContain('Operation failed for');

        expect(thrown.message).toContain(SECRET_MASK);
        expect(thrown.message).not.toContain(SECRET_PLAINTEXT);
        expect(loggedLines()).not.toContain(SECRET_PLAINTEXT);
      });

      it(`leaves ${arm.label} untouched when the caller threads no masker`, async () => {
        primeOperationFailure();

        const thrown = await captureThrow(() => arm.run());

        expect(thrown.message).toContain('Operation failed for');
        expect(thrown.message).toContain(SECRET_PLAINTEXT);
      });
    }

    // The case that fences WHERE the mask is applied rather than THAT it is.
    //
    // Every case above uses a long secret quoted inside an AWS sentence, which
    // `maskSecretsInText`'s SUBSTRING arm handles whether the masker runs on
    // the raw `ErrorMessage` or on the assembled `Operation failed for ...`
    // line — so moving the mask onto the finished sentence keeps them all
    // green (issue #2063 test review).
    //
    // What masking RAW actually buys is the WHOLE-VALUE arm, which fires only
    // when `secrets.has(text)` and therefore only when the text IS the secret
    // in its entirety — at any length, including below the 4-character
    // `MIN_NEEDLE_LENGTH` floor that the substring arm applies. So the
    // discriminating input is an `ErrorMessage` that is EXACTLY a sub-floor
    // secret: masked here, and unmaskable from the assembled line at any
    // point later.
    it('masks a sub-MIN_NEEDLE_LENGTH secret that IS the whole ErrorMessage', async () => {
      const shortSecret = 'a9d';
      expect(shortSecret.length).toBeLessThan(MIN_NEEDLE_LENGTH);
      const shortMasker = createSecretMasker(
        new Map([[shortSecret, '{{resolve:secretsmanager:cloudmap-short:SecretString:k::}}']])
      );

      // Proof the substring arm alone cannot do this: the assembled sentence
      // survives the same masker untouched, so a mask applied there is inert.
      const assembled = `Operation failed for Ns: ${shortSecret}`;
      expect(shortMasker(assembled)).toBe(assembled);

      primeOperationFailure(shortSecret);

      const thrown = await captureThrow(() =>
        provider.create('Ns', HTTP_NS, { Name: 'ns-http' }, { maskSecrets: shortMasker })
      );

      expect(thrown.message).toContain('Operation failed for');
      expect(thrown.message).toContain(SECRET_MASK);
      expect(thrown.message).not.toContain(shortSecret);
    });
  });
});
