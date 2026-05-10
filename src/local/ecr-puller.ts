import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { LocalInvokeBuildError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * ECR pull fallback for `cdkd local invoke` against deployed container
 * Lambdas (PR 5, D5.2). When `Code.ImageUri` resolves to an ECR URI but
 * doesn't match any cdk.out asset (typical when invoking a stack
 * deployed elsewhere), cdkd attempts `docker pull` against the same
 * account/region.
 *
 * **Same-account / same-region only**:
 *   - Cross-account requires AssumeRole + a different ECR client. Hard
 *     error with a pointer at the deferred follow-up PR.
 *   - Cross-region requires a region-aware ECR client. Same hard error.
 *
 * The `--no-pull` semantics (C3 in the design doc):
 *   - When NOT set: `ecrLogin` + `docker pull <uri>`.
 *   - When set: skip `docker pull`. If the image isn't in the local
 *     cache, the subsequent `docker run` will fail; we surface a clearer
 *     "image not in local cache" error here so the user knows to drop
 *     `--no-pull` or pre-pull manually.
 */

/** Regex matching the `<acct>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>` shape. */
const ECR_URI_REGEX = /^(\d{12})\.dkr\.ecr\.([^.]+)\.amazonaws\.com(?:\.cn)?\/([^:]+):(.+)$/;

export interface ParsedEcrUri {
  accountId: string;
  region: string;
  repository: string;
  tag: string;
}

/**
 * Parse an ECR image URI. Returns `undefined` for non-ECR URIs (typically:
 * Docker Hub, public.ecr.aws, gcr.io, ...) — those are user-managed
 * images we don't try to authenticate against.
 */
export function parseEcrUri(imageUri: string): ParsedEcrUri | undefined {
  const m = ECR_URI_REGEX.exec(imageUri);
  if (!m) return undefined;
  return {
    accountId: m[1]!,
    region: m[2]!,
    repository: m[3]!,
    tag: m[4]!,
  };
}

export interface EcrPullOptions {
  /** When true, skip `docker pull` and require the image be in the local cache. */
  skipPull: boolean;
  /**
   * Caller's region for the same-region check. When set (typical: the
   * CLI plumbs `--region` through here), this wins over `AWS_REGION` /
   * `AWS_DEFAULT_REGION` env vars; when unset, env-var fallback applies.
   * Closes the gap where a user-supplied `--region` was silently ignored
   * by the cross-region guard.
   */
  region?: string;
}

/**
 * Pull (or verify locally cached) a container Lambda image from ECR.
 *
 * Verifies same-account / same-region against the caller's STS identity
 * before issuing any docker command. Returns the image URI the caller
 * should pass to `docker run` (same as the input — no rewriting).
 */
export async function pullEcrImage(imageUri: string, options: EcrPullOptions): Promise<string> {
  const logger = getLogger().child('ecr-puller');

  const parsed = parseEcrUri(imageUri);
  if (!parsed) {
    throw new LocalInvokeBuildError(
      `Image URI '${imageUri}' is not an ECR URI. ` +
        'cdkd local invoke v1 only authenticates against ECR for the deployed-image fallback path.'
    );
  }

  // Verify same-account / same-region. Cross-account / cross-region is a
  // documented v1 limitation — surface a single clear error so users
  // can route around it (deploy locally instead).
  const sts = new STSClient({ region: parsed.region });
  let callerAccount: string;
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    if (!identity.Account) {
      throw new LocalInvokeBuildError(
        'STS GetCallerIdentity returned no Account. Verify your AWS credentials.'
      );
    }
    callerAccount = identity.Account;
  } finally {
    sts.destroy();
  }

  if (callerAccount !== parsed.accountId) {
    throw new LocalInvokeBuildError(
      `Image URI '${imageUri}' is in account ${parsed.accountId}, but the caller is ${callerAccount}. ` +
        'Cross-account ECR pull is not supported in cdkd local invoke v1 — deferred to a follow-up PR. ' +
        'Workaround: assume a role in the target account before invoking, or build the image locally with `cdkd local invoke -a cdk.out` (no ECR pull).'
    );
  }

  const callerRegion =
    options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
  if (callerRegion && callerRegion !== parsed.region) {
    throw new LocalInvokeBuildError(
      `Image URI '${imageUri}' is in region ${parsed.region}, but the caller's region is ${callerRegion}. ` +
        'Cross-region ECR pull is not supported in cdkd local invoke v1 — deferred to a follow-up PR. ' +
        `Workaround: re-run with AWS_REGION=${parsed.region} set, or build the image locally with -a cdk.out.`
    );
  }

  if (options.skipPull) {
    logger.info(`Skipping ECR pull (--no-pull). Verifying ${imageUri} is in local cache...`);
    await verifyImageInLocalCache(imageUri);
    return imageUri;
  }

  // Authenticate + pull.
  const ecr = new ECRClient({ region: parsed.region });
  try {
    await ecrLogin(ecr, parsed.accountId, parsed.region);
  } finally {
    ecr.destroy();
  }

  logger.info(`Pulling ${imageUri}...`);
  await runForeground('docker', ['pull', imageUri]);

  return imageUri;
}

/**
 * Authenticate the local docker daemon against the same-account ECR
 * registry. Mirrors `DockerAssetPublisher.ecrLogin` but stays in this
 * module so the local-invoke path doesn't depend on the publisher's
 * larger surface area.
 */
async function ecrLogin(client: ECRClient, accountId: string, region: string): Promise<void> {
  const logger = getLogger().child('ecr-puller');
  logger.debug(`ECR login (account=${accountId}, region=${region})`);

  const response = await client.send(new GetAuthorizationTokenCommand({}));
  const authData = response.authorizationData?.[0];
  if (!authData?.authorizationToken) {
    throw new LocalInvokeBuildError('Failed to get ECR authorization token');
  }

  const token = Buffer.from(authData.authorizationToken, 'base64').toString();
  const [username, password] = token.split(':');
  const endpoint = authData.proxyEndpoint || `https://${accountId}.dkr.ecr.${region}.amazonaws.com`;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('docker', ['login', '--username', username!, '--password-stdin', endpoint], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new LocalInvokeBuildError(`ECR login failed: ${stderr.trim()}`));
    });
    proc.on('error', (err) => {
      reject(new LocalInvokeBuildError(`ECR login failed: ${err.message}`));
    });

    proc.stdin?.write(password);
    proc.stdin?.end();
  });
}

/**
 * `docker image inspect <uri>` returns non-zero when the image is not in
 * the local cache. Surface a clearer error than docker's raw output so
 * the user knows the `--no-pull` path requires a pre-cached image.
 */
async function verifyImageInLocalCache(imageUri: string): Promise<void> {
  try {
    await execFileAsync('docker', ['image', 'inspect', imageUri]);
  } catch {
    throw new LocalInvokeBuildError(
      `Image '${imageUri}' is not in the local docker cache and --no-pull was set. ` +
        'Either remove --no-pull (cdkd will pull from ECR) or pre-pull the image manually with `docker pull`.'
    );
  }
}

/**
 * `docker pull` plumbed to the parent's stdio so the user sees layer
 * pull progress. Mirrors the runtime image's `pullImage` plumbing in
 * `docker-runner.ts` but local to this module to avoid a circular
 * dependency.
 */
function runForeground(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('error', (err) => reject(new LocalInvokeBuildError(`${cmd} failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new LocalInvokeBuildError(`${cmd} exited with code ${code}`));
    });
  });
}
