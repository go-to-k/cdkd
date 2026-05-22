import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getLogger } from './logger.js';

/**
 * Temporary AWS credentials produced by `sts:AssumeRole`. Shape mirrors the
 * `credentials` field that the AWS SDK v3 client constructors accept (the
 * S3State backend's `S3ClientOptions.credentials` lines up too), so a caller
 * can pass the value straight through to `new S3Client({ credentials })`.
 *
 * `expiration` is captured so the per-deploy cache below can detect when a
 * cached entry has aged out within the same process lifetime (rare — STS
 * default session is 1 hour and a single `cdkd deploy` run typically
 * completes well within that — but a long-running deploy of a >1h stack
 * would otherwise hit `ExpiredTokenException` on the next state read).
 */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

/**
 * Process-lifetime cache of assumed credentials keyed by RoleArn.
 *
 * Storing the in-flight `Promise` (rather than the resolved value) collapses
 * concurrent first-time callers into a single `sts:AssumeRole` request. After
 * the promise resolves we keep the same entry for subsequent callers so a
 * stack that references the same producer N times via `Fn::GetStackOutput`
 * only pays the STS hop once.
 *
 * The cache is keyed by RoleArn alone (not RoleArn + region) because STS
 * credentials are global — assumed credentials work against any region's
 * service endpoint. The downstream S3 client built from these credentials
 * picks its own region via `GetBucketLocation`.
 */
const crossAccountCredentialsCache = new Map<string, Promise<AwsCredentials>>();

/**
 * Reset the cross-account credentials cache. Used by tests to isolate cases;
 * production code never needs to call this.
 */
export function clearCrossAccountCredentialsCache(): void {
  crossAccountCredentialsCache.clear();
}

/**
 * Regex for an IAM role ARN. Accepts every published AWS partition
 * (`aws`, `aws-us-gov`, `aws-cn`, `aws-iso`, `aws-iso-b`, etc. — matched
 * loosely as `aws[a-z0-9-]*`) and any role-name shape including
 * service-linked roles with a `/path/` prefix
 * (e.g. `arn:aws:iam::111122223333:role/aws-service-role/.../AWSServiceRoleForX`).
 *
 * Capture group 1 is the partition, group 2 is the 12-digit account ID.
 */
const IAM_ROLE_ARN_RE = /^arn:(aws[a-z0-9-]*):iam::(\d{12}):role\/[\w+=,.@-]+(?:\/[\w+=,.@-]+)*$/;

/**
 * Parse an IAM role ARN into its component parts.
 *
 * @param roleArn  The full role ARN to parse.
 * @returns        `{ partition, accountId }` on success, `null` on a
 *                 structurally-invalid input. The caller is responsible for
 *                 surfacing a clear error message when this returns `null`.
 */
export function parseIamRoleArn(roleArn: string): { partition: string; accountId: string } | null {
  const match = IAM_ROLE_ARN_RE.exec(roleArn);
  if (!match || !match[1] || !match[2]) return null;
  return { partition: match[1], accountId: match[2] };
}

/**
 * Assume an IAM role across accounts and return temporary credentials for
 * reading the producer account's cdkd state bucket.
 *
 * **Why a dedicated helper (instead of reusing `applyRoleArnIfSet`).** The
 * `--role-arn` flag writes assumed credentials into the process's `AWS_*`
 * env vars so EVERY subsequent SDK client picks them up. That is the right
 * behavior for the CLI-wide flag, but the wrong behavior for cross-account
 * `Fn::GetStackOutput`: the producer's role should authorize ONLY the S3
 * state read, not the consumer's provisioning calls (which still run under
 * the consumer account's normal credentials). Threading the credentials
 * through a fresh `S3Client` via this helper keeps the scope narrow.
 *
 * **Why cache per-RoleArn for the process lifetime.** A multi-resource
 * stack typically references `Fn::GetStackOutput` from many template sites
 * (every IAM policy / Lambda env / ALB listener that pulls a shared VPC ID
 * from a platform stack). Assuming the role once per deploy is sufficient;
 * the cached credentials are valid for the STS session lifetime (default
 * 1 hour) which dwarfs the typical deploy duration.
 *
 * **Stale-cache recovery.** If the cached promise rejected (e.g. transient
 * STS error), the rejection is left in the cache so concurrent callers
 * fail uniformly — but the next *new* RoleArn (or a manual
 * `clearCrossAccountCredentialsCache()` in tests) will retry. A future
 * follow-up may add per-entry expiry-aware refresh; today's 1-hour STS
 * window vs. typical deploy times makes it unnecessary.
 */
export async function assumeRoleForCrossAccountStateRead(roleArn: string): Promise<AwsCredentials> {
  const cached = crossAccountCredentialsCache.get(roleArn);
  if (cached) return cached;

  const promise = (async (): Promise<AwsCredentials> => {
    const logger = getLogger().child('role-arn');
    logger.debug(`Assuming role for cross-account state read: ${roleArn}`);

    const sts = new STSClient({});
    try {
      const response = await sts.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: `cdkd-xacc-${Date.now()}`,
          DurationSeconds: 3600,
        })
      );
      if (!response.Credentials) {
        throw new Error(
          `AssumeRole for cross-account Fn::GetStackOutput returned no credentials (RoleArn=${roleArn})`
        );
      }
      const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = response.Credentials;
      if (!AccessKeyId || !SecretAccessKey || !SessionToken) {
        throw new Error(
          `AssumeRole response missing required credentials fields for cross-account state read (RoleArn=${roleArn})`
        );
      }
      logger.info(
        `Assumed role for cross-account state read: ${roleArn} (session expires ${
          Expiration?.toISOString() ?? 'unknown'
        })`
      );
      return {
        accessKeyId: AccessKeyId,
        secretAccessKey: SecretAccessKey,
        sessionToken: SessionToken,
        ...(Expiration && { expiration: Expiration }),
      };
    } finally {
      sts.destroy();
    }
  })();

  crossAccountCredentialsCache.set(roleArn, promise);
  return promise;
}

/**
 * Resolve the role-arn argument (CLI flag or `CDKD_ROLE_ARN` env var) and,
 * when set, assume the role and write the resulting temporary credentials
 * into `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`
 * for the rest of the process.
 *
 * **Why env vars, not threaded credentials.** cdkd constructs ~13
 * independent `AwsClients` instances across deploy / destroy / state /
 * import / etc. paths (each with its own region, sometimes — e.g. the
 * state-bucket client lives in a different region from the provisioning
 * clients). Threading a `credentials` object through every site is high
 * churn for an opt-in flag. AWS SDK v3 reads the standard `AWS_*` env
 * vars at the top of its default credentials chain, so writing into them
 * once at the command's entry makes every later `new XxxClient()` pick
 * up the assumed-role credentials automatically without touching the
 * client construction sites.
 *
 * **Why cdkd needs admin-equivalent on the assumed role.** Unlike `cdk
 * deploy`, cdkd does NOT route through CloudFormation. There is no
 * cfn-exec-role to delegate to. Every IAM / EC2 / Lambda / etc. API
 * call is issued from the cdkd process directly. The role you pass to
 * `--role-arn` (or set in `CDKD_ROLE_ARN`) MUST therefore have
 * admin-equivalent permissions on the resources being deployed; CDK
 * CLI's `cdk-hnb659fds-deploy-role-*` is NOT sufficient — that role
 * only carries CFn + asset-publish permissions.
 *
 * Default session duration is 1 hour. For longer-running deploys, the
 * caller should re-issue the cdkd command (the in-flight credentials
 * stay valid until expiry, but a re-run is the simplest recovery for
 * the rare case where a deploy outlives them).
 */
export async function applyRoleArnIfSet(opts: {
  roleArn: string | undefined;
  region: string | undefined;
}): Promise<void> {
  const roleArn = opts.roleArn || process.env['CDKD_ROLE_ARN'];
  if (!roleArn) return;

  const logger = getLogger().child('role-arn');
  logger.debug(`Assuming role ${roleArn}...`);

  const sts = new STSClient({ ...(opts.region && { region: opts.region }) });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkd-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    if (!response.Credentials) {
      throw new Error(`AssumeRole returned no credentials for role ${roleArn}`);
    }
    const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = response.Credentials;
    if (!AccessKeyId || !SecretAccessKey || !SessionToken) {
      throw new Error(`AssumeRole response missing credentials fields for role ${roleArn}`);
    }
    process.env['AWS_ACCESS_KEY_ID'] = AccessKeyId;
    process.env['AWS_SECRET_ACCESS_KEY'] = SecretAccessKey;
    process.env['AWS_SESSION_TOKEN'] = SessionToken;
    logger.info(
      `Assumed role ${roleArn} (session expires ${Expiration?.toISOString() ?? 'unknown'})`
    );
  } finally {
    sts.destroy();
  }
}
