import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The asset-bucket region refusal must not write the CALLER'S IDENTITY into a
 * persisted store (issue [#2302](https://github.com/go-to-k/cdkd/issues/2302)).
 *
 * `assertAssetBucketRegion` interpolated the raw `GetBucketLocation` failure
 * message into a THROWN `CdkdError`. A thrown message is not a terminal line:
 * `extractDeploymentEventError` captures it into `deployments/{runId}.jsonl`,
 * which outlives the run. On the headline population for a failing probe --
 * a missing `s3:GetBucketLocation` grant, or a bucket policy that `Deny`s it --
 * S3's own `AccessDenied` names the caller's account, role and session.
 *
 * Every fixture here therefore rejects with S3'S REAL WORDING, identity and
 * all. A fixture reading `Access Denied` cannot tell a message that prints the
 * CLASS from one that prints the MESSAGE, which is exactly how the sibling PR's
 * fixture passed for the wrong reason.
 */

const { mockS3Send, mockLoggerDebug, mockLoggerInfo, mockLoggerWarn } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  // Split by LEVEL rather than merged: the load-bearing claim is not "the text
  // was logged somewhere" but "it was logged where it is NOT persisted and NOT
  // shown by default". cdkd's default level is `info`.
  mockLoggerDebug: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation((cfg?: { region?: string }) => ({
    send: mockS3Send,
    destroy: vi.fn(),
    config: { region: async () => cfg?.region ?? 'us-east-1' },
  })),
  HeadBucketCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'HeadBucket' })),
  CreateBucketCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'CreateBucket' })),
  GetBucketLocationCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'GetBucketLocation' })),
  PutBucketEncryptionCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'PutBucketEncryption' })),
  PutPublicAccessBlockCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'PutPublicAccessBlock' })),
  PutBucketPolicyCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'PutBucketPolicy' })),
}));

vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: vi.fn().mockImplementation(() => ({ send: vi.fn().mockResolvedValue({}), destroy: vi.fn() })),
  DescribeRepositoriesCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'DescribeRepositories' })),
  CreateRepositoryCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'CreateRepository' })),
  PutImageTagMutabilityCommand: vi
    .fn()
    .mockImplementation((input) => ({ ...input, _type: 'PutImageTagMutability' })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const base = {
    debug: mockLoggerDebug,
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: vi.fn(),
  };
  return { getLogger: () => ({ ...base, child: () => ({ ...base }) }) };
});

import { S3Client } from '@aws-sdk/client-s3';
import { ECRClient } from '@aws-sdk/client-ecr';
import { ensureAssetStorage } from '../../../src/assets/asset-storage.js';
import {
  hasRedactedCause,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const FOREIGN = 'ap-northeast-1';
const BUCKET = 'shared-assets';

/** The account id, the role name and the session name, each asserted separately. */
const CALLER_ACCOUNT = '123456789012';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/**
 * `GetBucketLocation`'s `AccessDenied` as S3 really words it.
 *
 * Copied from the shape S3 returns for a policy denial rather than shortened,
 * because WHICH substring reaches the thrown message is the whole point.
 */
function accessDeniedNamingTheCaller(): Error {
  const e = new Error(
    `User: ${CALLER_ARN} is not authorized to perform: s3:GetBucketLocation ` +
      `on resource: "arn:aws:s3:::${BUCKET}" because no identity-based policy ` +
      `allows the s3:GetBucketLocation action`
  );
  return Object.assign(e, { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
}

/**
 * A throttle as the SDK delivers it: the wire CODE on `name`, not in the text.
 *
 * Present so the class-naming assertion cannot pass against a hardcoded
 * `AccessDenied` -- the two cases must print two different classes.
 */
function throttled(): Error {
  const e = new Error('Please reduce your request rate.');
  return Object.assign(e, { name: 'ThrottlingException', $metadata: { httpStatusCode: 503 } });
}

/** A 409 `BucketAlreadyOwnedByYou` carrying NO region header, so the probe runs. */
function ownedByYouWithoutRegionHeader(): Error {
  const e = new Error('Your previous request to create the named bucket succeeded and you already own it.');
  return Object.assign(e, {
    name: 'BucketAlreadyOwnedByYou',
    $metadata: { httpStatusCode: 409 },
    $response: {
      headers: {
        'x-amz-request-id': 'ZZZ0000000000001',
        'content-type': 'application/xml',
        server: 'AmazonS3',
      },
    },
  });
}

/** A 409 whose header DOES name the bucket's region, so no probe is issued. */
function ownedByYouInRegion(bucketRegion: string): Error {
  const e = new Error('Your previous request to create the named bucket succeeded and you already own it.');
  return Object.assign(e, {
    name: 'BucketAlreadyOwnedByYou',
    $metadata: { httpStatusCode: 409 },
    $response: { headers: { 'x-amz-bucket-region': bucketRegion } },
  });
}

function notFound(): Error {
  return Object.assign(new Error('Not Found'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
}

function makeOptions() {
  const putRawObject = vi.fn().mockResolvedValue(undefined);
  const getRawObject = vi.fn().mockResolvedValue(null);
  return {
    putRawObject,
    options: {
      s3Client: new S3Client({ region: REGION }) as S3Client,
      ecrClient: new ECRClient({}) as ECRClient,
      stateBackend: { putRawObject, getRawObject } as unknown as S3StateBackend,
      accountId: ACCOUNT,
      region: REGION,
      force: false,
      // The region-FREE custom name is what makes the whole guard reachable:
      // the default `cdkd-assets-<acct>-<region>` embeds the region.
      assetBucketName: BUCKET,
    },
  };
}

/** Drive `assertAssetBucketRegion` into its probe-FAILED arm with `probeError`. */
function primeFailingProbe(probeError: Error): void {
  mockS3Send.mockImplementation((cmd: { _type: string }) => {
    if (cmd._type === 'HeadBucket') return Promise.reject(notFound());
    if (cmd._type === 'CreateBucket') return Promise.reject(ownedByYouWithoutRegionHeader());
    if (cmd._type === 'GetBucketLocation') return Promise.reject(probeError);
    return Promise.resolve({});
  });
}

const debugText = (): string => mockLoggerDebug.mock.calls.map((c) => String(c[0])).join('\n');
const defaultLevelText = (): string =>
  [...mockLoggerInfo.mock.calls, ...mockLoggerWarn.mock.calls]
    .map((c) => String(c[0]))
    .join('\n');

async function captureRefusal(): Promise<Error> {
  const { options } = makeOptions();
  try {
    await ensureAssetStorage(options);
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected ensureAssetStorage to refuse, but it resolved');
}

describe('asset-bucket region refusal: caller identity must not reach the THROWN message (issue #2302)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names the error CLASS and withholds the account id, role ARN and session name', async () => {
    primeFailingProbe(accessDeniedNamingTheCaller());

    const thrown = await captureRefusal();

    expect(thrown).toMatchObject({ code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET' });
    // The class IS surfaced -- a redaction that dropped it too would leave the
    // operator unable to tell a missing grant from a bucket-policy Deny even
    // with `--verbose` pointed at nothing.
    expect(thrown.message).toContain('region probe failed: AccessDenied');
    expect(thrown.message).toContain('--verbose');

    // ...and the three identity fragments are ABSENT, asserted one by one so a
    // partial redaction cannot pass on the strength of the others.
    expect(thrown.message).not.toContain(CALLER_ARN);
    expect(thrown.message).not.toContain(CALLER_ACCOUNT);
    expect(thrown.message).not.toContain(CALLER_ROLE);
    expect(thrown.message).not.toContain(CALLER_SESSION);
    expect(thrown.message).not.toContain('assumed-role');
    expect(thrown.message).not.toContain('is not authorized to perform');

    // ...and the refusal is deliberately NOT stamped `markRedactedCause`.
    // Pinned, because the opposite is the intuitive thing to write: the stamp
    // redirects a classifier onto the `.cause` chain, and this chain carries
    // the ORIGINATING error rather than the `probeError` whose text was
    // withheld -- so a stamp here would recover nothing and would only feed an
    // unrelated message to classification. `retryClassificationText` must
    // therefore return this message unchanged.
    expect(hasRedactedCause(thrown)).toBe(false);
    expect(retryClassificationText(thrown)).toBe(thrown.message);
  });

  it("keeps AWS's own message reachable at logger.debug, and nowhere at default level", async () => {
    primeFailingProbe(accessDeniedNamingTheCaller());

    await captureRefusal();

    // The message is what separates a missing IAM grant from a bucket-policy
    // Deny, so discarding it would be its own defect.
    const debug = debugText();
    expect(debug).toContain('no identity-based policy allows');
    expect(debug).toContain(CALLER_ARN);
    expect(debug).toContain(BUCKET);

    // `info` / `warn` are what an ordinary run shows. Neither may carry it.
    expect(defaultLevelText()).not.toContain(CALLER_ARN);
    expect(defaultLevelText()).not.toContain('assumed-role');
  });

  it('prints the ACTUAL class, not a hardcoded AccessDenied', async () => {
    // Without this arm, `region probe failed: AccessDenied` could be a literal.
    primeFailingProbe(throttled());

    const thrown = await captureRefusal();

    expect(thrown.message).toContain('region probe failed: ThrottlingException');
    expect(thrown.message).not.toContain('Please reduce your request rate');
    expect(debugText()).toContain('Please reduce your request rate');
  });

  it('withholds a NON-Error probe rejection entirely, and still routes it to debug', async () => {
    // `String(value)` was the old fallback and it is the shape with the fewest
    // guarantees about what is inside it -- there is no class to fall back to.
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(notFound());
      if (cmd._type === 'CreateBucket') return Promise.reject(ownedByYouWithoutRegionHeader());
      if (cmd._type === 'GetBucketLocation')
        return Promise.reject(`denied for ${CALLER_ARN}` as unknown as Error);
      return Promise.resolve({});
    });

    const thrown = await captureRefusal();

    expect(thrown.message).toContain('non-Error value of type string');
    expect(thrown.message).not.toContain(CALLER_ARN);
    expect(debugText()).toContain(CALLER_ARN);
  });

  it('NEGATIVE CONTROL: a NON-AWS probe failure is neither redacted nor echoed to debug', async () => {
    // The `failure.redacted` gate, which a mutation forcing the debug line ON
    // left green until this case existed. A probe that fails with a plain
    // `Error` -- no smithy marker, so cdkd or Node wrote the text -- must reach
    // the throw VERBATIM, and must not also produce a debug line repeating the
    // identical string to a second sink.
    const cdkdAuthored = new Error('the injected S3 client has no credentials configured');
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(notFound());
      if (cmd._type === 'CreateBucket') return Promise.reject(ownedByYouWithoutRegionHeader());
      if (cmd._type === 'GetBucketLocation') return Promise.reject(cdkdAuthored);
      return Promise.resolve({});
    });

    const thrown = await captureRefusal();

    expect(thrown.message).toContain(
      'region probe failed: the injected S3 client has no credentials configured'
    );
    expect(thrown.message).not.toContain('--verbose');
    expect(debugText()).not.toContain('GetBucketLocation failed for asset bucket');
    // Nothing was withheld, so there is nothing to declare: an unconditional
    // stamp would widen classification for a message that needs no widening.
    expect(hasRedactedCause(thrown)).toBe(false);
    expect(retryClassificationText(thrown)).toBe(thrown.message);
  });

  it('NEGATIVE CONTROL: the foreign-region refusal is unchanged and still names both regions', async () => {
    // This sibling refusal interpolates NO AWS message, so the fix must not
    // touch it. A redaction that fired on every thrown message -- or one that
    // reduced every refusal to a class -- goes red here while the assertions
    // above stay green.
    mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'HeadBucket') return Promise.reject(notFound());
      if (cmd._type === 'CreateBucket') return Promise.reject(ownedByYouInRegion(FOREIGN));
      return Promise.resolve({});
    });

    const thrown = await captureRefusal();

    expect(thrown).toMatchObject({ code: 'ASSET_STORAGE_FOREIGN_REGION_BUCKET' });
    expect(thrown.message).toContain(`resolves to a bucket in ${FOREIGN}`);
    expect(thrown.message).toContain(`while this operation targets ${REGION}`);
    expect(thrown.message).toContain('cdkd asset storage is per-region by design');
    expect(thrown.message).toContain(`cdkd bootstrap --region ${REGION} --asset-bucket`);
    // No probe ran, so there is no probe text to route anywhere.
    expect(thrown.message).not.toContain('region probe failed');
    expect(debugText()).not.toContain('GetBucketLocation failed');
  });
});
