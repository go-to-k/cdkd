/**
 * `CDKD_CR_S3_ENDPOINT_URL`: the endpoint a custom resource's pre-signed
 * `ResponseURL` is signed against (issue
 * [#5745](https://github.com/go-to-k/cdkd/issues/5745)), modelled on the AWS
 * CDK CLI's `AWS_ENDPOINT_URL_S3_FOR_CLOUDFORMATION` (which serves the template
 * URL the CDK CLI hands to CloudFormation, not a custom-resource response).
 *
 * Against an S3 emulator, cdkd itself may reach S3 as `http://localhost:4566`
 * while the emulated Lambda that PUTs the response must use another name
 * (`http://s3:4566`, a container hostname). When the variable is set, ONLY the
 * `ResponseURL` is signed against it, by a dedicated presign client; every
 * other S3 call keeps cdkd's own endpoint. Unset, the URL is signed by the
 * response client exactly as before.
 *
 * The host is part of the SigV4 signature, so the URL is SIGNED for the target
 * endpoint rather than rewritten after signing (a rewritten host fails
 * `SignatureDoesNotMatch`). The client counts as having an endpoint override,
 * so it is path-style unless the profile says `addressing_style = virtual`
 * and `CDK_S3_FORCE_PATH_STYLE` is unset (`src/utils/s3-client-defaults.ts`).
 *
 * The presigned URL is a bearer credential for one PUT: never log it, its
 * query string, or anything but the endpoint's origin.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { s3ClientDefaults } from '../../utils/s3-client-defaults.js';
import { CdkdError } from '../../utils/error-handler.js';

export const CR_S3_ENDPOINT_ENV = 'CDKD_CR_S3_ENDPOINT_URL';

export interface CustomResourceS3Endpoint {
  /** The value as configured, handed to the SDK as `endpoint`. */
  readonly url: string;
  /** `scheme://host[:port]` — the only part of it that is ever logged. */
  readonly origin: string;
}

function refuse(reason: string): never {
  throw new CdkdError(
    `${CR_S3_ENDPOINT_ENV} ${reason}. Set it to an http:// or https:// endpoint ` +
      `(e.g. http://s3:4566) that the custom resource's Lambda can reach, or unset it.`,
    'INVALID_CR_S3_ENDPOINT_URL'
  );
}

/**
 * The configured endpoint, `undefined` when unset or empty, or a refusal for a
 * value that cannot be one. Read per call: the environment is the source of
 * truth and the parse is cheap.
 */
export function customResourceS3Endpoint(
  env: NodeJS.ProcessEnv = process.env
): CustomResourceS3Endpoint | undefined {
  const raw = env[CR_S3_ENDPOINT_ENV];
  if (raw === undefined || raw === '') return undefined;
  const value = raw.trim();
  if (value === '') refuse('is set to whitespace only');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    refuse('is not a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    refuse('must use http:// or https://');
  }
  // Each of these would ride into the signed URL handed to the Lambda; userinfo
  // would also be a credential cdkd is then holding in a log-adjacent value.
  if (parsed.username !== '' || parsed.password !== '') refuse('must not carry user info');
  if (parsed.search !== '' || parsed.hash !== '') refuse('must not carry a query or fragment');
  return { url: value, origin: parsed.origin };
}

/**
 * Presign clients, one per response client: the custom-resource provider swaps
 * its response client on a bucket-region rebuild, and a client keyed on the
 * one it replaced would sign for the wrong region. The PROMISE is cached, so
 * concurrent custom resources share one build. A presign client never sends a
 * request, so a dropped one holds no sockets.
 */
const presignClients = new WeakMap<S3Client, { url: string; client: Promise<S3Client> }>();

/**
 * The client that signs the `ResponseURL` for `endpoint`: the response client's
 * own region and credential provider (so the same identity signs, and a
 * rebuilt foreign-region client's region carries over), with `endpoint` set.
 */
export function responsePresignClient(
  base: S3Client,
  endpoint: CustomResourceS3Endpoint
): Promise<S3Client> {
  const cached = presignClients.get(base);
  if (cached !== undefined && cached.url === endpoint.url) return cached.client;
  const client = buildPresignClient(base, endpoint);
  presignClients.set(base, { url: endpoint.url, client });
  // A failed build is not cached: the next custom resource retries it.
  client.catch(() => {
    if (presignClients.get(base)?.client === client) presignClients.delete(base);
  });
  return client;
}

async function buildPresignClient(
  base: S3Client,
  endpoint: CustomResourceS3Endpoint
): Promise<S3Client> {
  const config = (base as { config?: { region?: unknown; credentials?: unknown } }).config;
  const region =
    typeof config?.region === 'function'
      ? await (config.region as () => Promise<unknown>)()
      : undefined;
  const credentials = config?.credentials;

  return new S3Client({
    ...ambientClientDefaults(),
    ...s3ClientDefaults({ explicitEndpoint: true }),
    ...(typeof region === 'string' && region !== '' && { region }),
    ...(credentials !== undefined && { credentials: credentials as never }),
    endpoint: endpoint.url,
  });
}
