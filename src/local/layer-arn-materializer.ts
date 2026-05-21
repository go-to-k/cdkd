import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getLogger } from '../utils/logger.js';
import type { ResolvedArnLambdaLayer } from './lambda-resolver.js';

/**
 * Materialize a literal-ARN Lambda Layer to a host tmpdir so it can be
 * bind-mounted at `/opt` alongside same-stack layers (issue #448).
 *
 * Steps:
 *
 *   1. Optional `sts:AssumeRole` against `roleArn` (the CLI's
 *      `--layer-role-arn <arn>` flag). When the dev's default
 *      credentials cannot read the layer (cross-account case) the role
 *      typically belongs to a trust-policy-permitted role in the layer's
 *      account.
 *   2. `lambda:GetLayerVersion` against the layer's region (parsed from
 *      the ARN by `parseLayerVersionArn` — NOT the dev's profile
 *      region) to recover the presigned S3 URL in `Content.Location`.
 *   3. Download the ZIP from the presigned URL via `fetch(...)` (no AWS
 *      credentials needed on the GET — the presign carries them).
 *   4. Unzip into a fresh tmpdir under `os.tmpdir()` using `node:zlib`
 *      + the documented ZIP-file format. AWS layer ZIPs use the
 *      DEFLATE compression method.
 *
 * Returns the absolute path to the unzipped directory; the caller
 * `cpSync`-merges it into the `/opt` host tmpdir alongside any
 * same-stack `kind: 'asset'` layers and records the path in the
 * tracking set for cleanup.
 *
 * Failures surface as `LayerMaterializationError` with the layer ARN
 * in the message so the user sees which layer broke (vs which
 * Lambda's `Properties.Layers` array hit which AWS error).
 *
 * **Network IO is gated by the `lambdaClientFactory` / `stsClientFactory`
 * options** to keep unit tests deterministic — production callers omit
 * both and the function builds the real SDK clients on the fly via
 * dynamic `import()` to keep the cold-start path small.
 */
export interface MaterializeLayerOptions {
  /**
   * Optional role to assume before calling `GetLayerVersion`. When
   * unset the dev's default credentials (whatever the SDK default
   * chain resolves) are used. Threading a per-CLI-invocation flag is
   * the canonical cross-account escape hatch — see `--layer-role-arn`
   * on `cdkd local invoke` / `cdkd local start-api`.
   */
  roleArn?: string;
  /**
   * Test seam: override the Lambda client (the production call goes
   * through `@aws-sdk/client-lambda`'s `LambdaClient.send(new
   * GetLayerVersionCommand(...))`).
   */
  lambdaClientFactory?: (region: string, credentials?: AwsCredentials) => LambdaSendClient;
  /**
   * Test seam: override the STS client (production goes through
   * `@aws-sdk/client-sts`'s `STSClient.send(new AssumeRoleCommand(...))`).
   */
  stsClientFactory?: (region: string) => StsSendClient;
  /**
   * Test seam: override the presigned-URL ZIP fetch. The production
   * call uses Node's built-in `fetch()`. Returns a `Uint8Array` (the
   * ZIP body) so the test can inject a fixture-built ZIP.
   */
  fetchZip?: (presignedUrl: string) => Promise<Uint8Array>;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Minimal slice of `LambdaClient` cdkd needs. Surfaced as an interface
 * so unit tests can mock without pulling the real SDK module.
 */
export interface LambdaSendClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<{ Content?: { Location?: string } }>;
  destroy?: () => void;
}

export interface StsSendClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<{
    Credentials?: {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      SessionToken?: string;
    };
  }>;
  destroy?: () => void;
}

export class LayerMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayerMaterializationError';
    Object.setPrototypeOf(this, LayerMaterializationError.prototype);
  }
}

export async function materializeLayerFromArn(
  layer: ResolvedArnLambdaLayer,
  options: MaterializeLayerOptions = {}
): Promise<string> {
  const logger = getLogger();

  let credentials: AwsCredentials | undefined;
  if (options.roleArn) {
    try {
      credentials = await assumeRoleForLayer(options.roleArn, layer.region, options);
      logger.debug(`Layer ${layer.arn}: assumed role ${options.roleArn} for GetLayerVersion`);
    } catch (err) {
      throw new LayerMaterializationError(
        `Layer ${layer.arn}: STS AssumeRole(${options.roleArn}) failed: ${errMsg(err)}. ` +
          'Check the role trust policy permits your principal and sts:AssumeRole is allowed.'
      );
    }
  }

  let presignedUrl: string;
  try {
    presignedUrl = await fetchLayerContentUrl(layer, credentials, options);
  } catch (err) {
    const hint = looksLikeAccessDenied(err)
      ? ' GetLayerVersion access denied; check the credentials / role can read the layer ' +
        '(grant lambda:GetLayerVersion on the layer ARN, or pass --layer-role-arn <arn> ' +
        'to assume a role in the layer account).'
      : '';
    throw new LayerMaterializationError(
      `Layer ${layer.arn}: GetLayerVersion failed in region ${layer.region}: ${errMsg(err)}.${hint}`
    );
  }

  let zipBytes: Uint8Array;
  try {
    zipBytes = await downloadPresignedZip(presignedUrl, options);
  } catch (err) {
    throw new LayerMaterializationError(
      `Layer ${layer.arn}: failed to download layer ZIP from the presigned URL: ${errMsg(err)}.`
    );
  }

  const dir = await mkdtemp(join(tmpdir(), `cdkd-local-arn-layer-${layer.name}-${layer.version}-`));
  try {
    await unzipBufferToDirectory(zipBytes, dir);
  } catch (err) {
    throw new LayerMaterializationError(
      `Layer ${layer.arn}: failed to unzip layer contents into '${dir}': ${errMsg(err)}.`
    );
  }
  return dir;
}

async function fetchLayerContentUrl(
  layer: ResolvedArnLambdaLayer,
  credentials: AwsCredentials | undefined,
  options: MaterializeLayerOptions
): Promise<string> {
  const factory = options.lambdaClientFactory ?? (await defaultLambdaClientFactory());
  const client = factory(layer.region, credentials);
  try {
    // Layer ARN form used as LayerName lets the SDK resolve cross-
    // account references without a separate account-id flag. AWS docs:
    // "When provided the layer-version's ARN as LayerName, the
    // VersionNumber must still be set."
    const versionLessArn = `arn:aws:lambda:${layer.region}:${layer.accountId}:layer:${layer.name}`;
    const command = await buildGetLayerVersionCommand(versionLessArn, Number(layer.version));
    const response = await client.send(command);
    const url = response?.Content?.Location;
    if (!url || typeof url !== 'string') {
      throw new Error(
        'GetLayerVersion response did not include Content.Location (presigned ZIP URL)'
      );
    }
    return url;
  } finally {
    client.destroy?.();
  }
}

async function assumeRoleForLayer(
  roleArn: string,
  region: string,
  options: MaterializeLayerOptions
): Promise<AwsCredentials> {
  const factory = options.stsClientFactory ?? (await defaultStsClientFactory());
  const client = factory(region);
  try {
    const command = await buildAssumeRoleCommand(roleArn);
    const response = await client.send(command);
    const creds = response?.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey) {
      throw new Error('AssumeRole returned no Credentials');
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      ...(creds.SessionToken !== undefined && { sessionToken: creds.SessionToken }),
    };
  } finally {
    client.destroy?.();
  }
}

async function defaultLambdaClientFactory(): Promise<
  (region: string, credentials?: AwsCredentials) => LambdaSendClient
> {
  const { LambdaClient } = await import('@aws-sdk/client-lambda');
  return (region, credentials) =>
    new LambdaClient({
      region,
      ...(credentials && {
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          ...(credentials.sessionToken !== undefined && {
            sessionToken: credentials.sessionToken,
          }),
        },
      }),
    });
}

async function defaultStsClientFactory(): Promise<(region: string) => StsSendClient> {
  const { STSClient } = await import('@aws-sdk/client-sts');
  return (region) => new STSClient({ region });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildGetLayerVersionCommand(layerArn: string, versionNumber: number): Promise<any> {
  const { GetLayerVersionCommand } = await import('@aws-sdk/client-lambda');
  return new GetLayerVersionCommand({ LayerName: layerArn, VersionNumber: versionNumber });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildAssumeRoleCommand(roleArn: string): Promise<any> {
  const { AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  return new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: `cdkd-local-layer-${Date.now()}`,
    DurationSeconds: 3600,
  });
}

async function downloadPresignedZip(
  presignedUrl: string,
  options: MaterializeLayerOptions
): Promise<Uint8Array> {
  if (options.fetchZip) return options.fetchZip(presignedUrl);
  const response = await fetch(presignedUrl);
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} from layer Content.Location URL`
    );
  }
  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Minimal ZIP unzipper that handles the subset of the ZIP format Lambda
 * layer ZIPs ever use (DEFLATE compression method 8, STORE method 0).
 * Avoids bringing in a heavyweight dep for a 50-line task.
 *
 * Path-traversal guard: every entry's relative path is `normalize()`d
 * and rejected if the resulting absolute path escapes `destDir` (the
 * "Zip Slip" CVE class). Symlinks inside the ZIP are also rejected for
 * the same reason — they could point at arbitrary host paths.
 */
async function unzipBufferToDirectory(zipBytes: Uint8Array, destDir: string): Promise<void> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  // Find the End of Central Directory record (signature 0x06054b50) by
  // scanning the last ~64KB of the buffer backwards.
  const eocdSig = 0x06054b50;
  const maxComment = 0xffff;
  const minScan = Math.max(0, zipBytes.byteLength - maxComment - 22);
  let eocdOffset = -1;
  for (let i = zipBytes.byteLength - 22; i >= minScan; i--) {
    if (view.getUint32(i, true) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Not a ZIP file (no End of Central Directory record found)');
  }
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const destAbsolute = resolve(destDir);
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let parsed = 0;
  while (cursor < cdEnd && parsed < totalEntries) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`Corrupt ZIP: missing Central Directory header at offset ${cursor}`);
    }
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraFieldLength = view.getUint16(cursor + 30, true);
    const fileCommentLength = view.getUint16(cursor + 32, true);
    const externalAttrs = view.getUint32(cursor + 38, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const fileName = new TextDecoder('utf-8').decode(
      zipBytes.subarray(cursor + 46, cursor + 46 + fileNameLength)
    );
    cursor += 46 + fileNameLength + extraFieldLength + fileCommentLength;
    parsed++;

    // Reject anything that escapes destDir (Zip Slip).
    const normalized = normalize(fileName);
    const targetPath = resolve(destAbsolute, normalized);
    if (!targetPath.startsWith(destAbsolute + (destAbsolute.endsWith('/') ? '' : '/'))) {
      throw new Error(
        `Refusing to extract entry '${fileName}' — path escapes the destination directory`
      );
    }
    // Symlink entries on Unix encode 0xA in the high byte of external
    // attributes (Unix `mode & S_IFMT >> 16` => 0xA000). Rejected
    // because they could redirect to arbitrary host paths.
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new Error(`Refusing to extract symlink entry '${fileName}' from layer ZIP (security)`);
    }

    if (fileName.endsWith('/')) {
      await mkdir(targetPath, { recursive: true });
      continue;
    }
    await mkdir(dirname(targetPath), { recursive: true });

    // Read the Local File Header to locate the actual data payload.
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`Corrupt ZIP: missing Local File Header for '${fileName}'`);
    }
    const lfhFileNameLength = view.getUint16(localHeaderOffset + 26, true);
    const lfhExtraFieldLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + lfhFileNameLength + lfhExtraFieldLength;
    const compressedData = zipBytes.subarray(dataOffset, dataOffset + compressedSize);

    let payload: Uint8Array;
    if (compressionMethod === 0) {
      payload = compressedData;
    } else if (compressionMethod === 8) {
      payload = await inflateRaw(compressedData);
    } else {
      throw new Error(
        `Unsupported ZIP compression method ${compressionMethod} for entry '${fileName}' (only STORE and DEFLATE supported)`
      );
    }
    if (payload.length !== uncompressedSize && compressionMethod !== 0) {
      throw new Error(
        `ZIP entry '${fileName}': inflate produced ${payload.length} bytes, expected ${uncompressedSize}`
      );
    }
    // Stream the payload through fs.createWriteStream so we never hold
    // a 100MB+ layer ZIP entirely in memory after the network read.
    await pipeline(Readable.from(payload), createWriteStream(targetPath));
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const { inflateRaw: inflate } = await import('node:zlib');
  return new Promise((resolveP, rejectP) => {
    inflate(data, (err, out) => {
      if (err) rejectP(err);
      else resolveP(out);
    });
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function looksLikeAccessDenied(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = (err as { name?: string }).name ?? '';
  const code = (err as { Code?: string }).Code ?? '';
  const message = err.message ?? '';
  return (
    name === 'AccessDeniedException' ||
    code === 'AccessDeniedException' ||
    /access denied/i.test(message) ||
    /not authorized/i.test(message)
  );
}
