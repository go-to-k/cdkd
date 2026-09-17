import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getLogger } from './logger.js';
import {
  awsClientDefaults,
  getAssumedRoleCredentials,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
  SECOND_ROLE_PUBLISH_REFUSAL,
} from './aws-client-defaults.js';
import { readEnvCredentials } from './caller-credentials.js';
import { displaySafe } from './display-safe.js';

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
 *
 * **Expiration handling**: on every cache hit, the cached credentials'
 * `expiration` is compared against `Date.now()` with a 60-second safety
 * buffer to avoid the "STS expires 1-2s early due to clock skew" race.
 * Expired entries are evicted and a fresh AssumeRole is issued.
 *
 * **Rejection handling**: when the in-flight promise rejects (e.g.
 * transient STS throttle, AccessDenied), the cache entry is evicted so a
 * subsequent caller will retry. Without this, a single transient failure
 * would pin the rest of the deploy to the same error.
 */
const crossAccountCredentialsCache = new Map<string, Promise<AwsCredentials>>();

/**
 * Safety buffer applied when checking whether cached credentials are still
 * valid. STS occasionally reports `Expiration` 1-2 seconds AFTER the moment
 * the token actually stops working (clock skew between AWS's auth plane and
 * the local machine), so we evict the cache entry one minute BEFORE the
 * recorded expiration to keep long-running deploys safe.
 */
const CRED_EXPIRY_SAFETY_MS = 60_000;

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
 * `--role-arn` flag publishes its assumed credentials process-wide, so
 * EVERY subsequent SDK client picks them up. That is the right
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
 * **Cache miss / refresh paths.** On every call we look up the cached
 * entry. If it exists AND its `Expiration` is still further in the
 * future than {@link CRED_EXPIRY_SAFETY_MS}, we return it. Otherwise the
 * entry is evicted and a fresh AssumeRole hop runs — important for
 * deploys longer than the 1-hour STS session window (multi-stack
 * `--all` runs, big Custom-Resource trees, etc.).
 *
 * **Rejection handling.** When the underlying STS call throws (e.g.
 * transient throttle, AccessDenied, trust policy mismatch), the cache
 * entry is evicted INSIDE the IIFE before the error propagates, so a
 * subsequent caller will retry the AssumeRole hop rather than getting
 * pinned to the same rejection. Concurrent first-time callers still
 * share the SAME in-flight promise (so a single failure surfaces
 * uniformly), but the next caller after rejection gets a clean slate.
 */
export async function assumeRoleForCrossAccountStateRead(roleArn: string): Promise<AwsCredentials> {
  const cached = crossAccountCredentialsCache.get(roleArn);
  if (cached) {
    // Concurrent callers MUST share the same in-flight promise —
    // including its rejection. We propagate cached.then's outcome
    // directly: on resolve, check the expiration and either return
    // the creds or fall through to a fresh AssumeRole; on reject,
    // the cached promise's error surfaces uniformly to every concurrent
    // caller rather than cascading retries within the same call.
    // Subsequent calls (after the rejection / expiration) will see
    // an evicted cache entry and trigger a fresh STS hop.
    const cachedCreds = await cached;
    // Cached entry is still valid if either:
    //   (a) no expiration was recorded (defensive — STS always returns
    //       Expiration in practice but the type is optional), OR
    //   (b) the recorded expiration is still further in the future
    //       than our safety buffer.
    if (
      !cachedCreds.expiration ||
      Date.now() < cachedCreds.expiration.getTime() - CRED_EXPIRY_SAFETY_MS
    ) {
      return cachedCreds;
    }
    // Expired (or within the safety buffer) — evict and fall through
    // to the fresh AssumeRole path below.
    crossAccountCredentialsCache.delete(roleArn);
  }

  const promise = (async (): Promise<AwsCredentials> => {
    const logger = getLogger().child('role-arn');
    logger.debug(`Assuming role for cross-account state read: ${roleArn}`);

    const sts = new STSClient({ ...awsClientDefaults() });
    try {
      let response;
      try {
        response = await sts.send(
          new AssumeRoleCommand({
            RoleArn: roleArn,
            RoleSessionName: `cdkd-xacc-${Date.now()}`,
            DurationSeconds: 3600,
          })
        );
      } catch (err) {
        // Wrap STS errors with a trust-policy hint — the most common
        // cross-account misconfiguration is the producer's role not
        // allowing the consumer's principal in its trust policy, and
        // the raw SDK error ("AccessDenied: User ... is not authorized
        // to perform: sts:AssumeRole on resource: ...") is opaque to
        // anyone who hasn't seen it before.
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `AssumeRole into ${roleArn} failed: ${message}. ` +
            `If this is a trust-policy issue, the producer's role must allow sts:AssumeRole ` +
            `from the consumer's principal. See https://github.com/go-to-k/cdkd/blob/main/docs/cross-stack-references.md for the trust-policy template.`,
          { cause: err instanceof Error ? err : undefined }
        );
      }
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
  })().catch((err) => {
    // Evict the cache entry on rejection so subsequent calls retry the
    // STS hop instead of getting pinned to a transient failure. The
    // identity check (=== promise) guards against an edge case where a
    // concurrent caller has already started a fresh AssumeRole after
    // detecting expiration — in that case we don't want to clobber the
    // new entry.
    if (crossAccountCredentialsCache.get(roleArn) === promise) {
      crossAccountCredentialsCache.delete(roleArn);
    }
    throw err;
  });

  crossAccountCredentialsCache.set(roleArn, promise);
  return promise;
}

/**
 * Resolve the role-arn argument (CLI flag or `CDKD_ROLE_ARN` env var) and,
 * when set, assume the role and write the resulting temporary credentials
 * into `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`
 * for the rest of the process.
 *
 * **Why not threaded credentials.** cdkd constructs ~13 independent
 * `AwsClients` instances across deploy / destroy / state / import / etc.
 * paths (each with its own region, sometimes — e.g. the state-bucket
 * client lives in a different region from the provisioning clients).
 * Threading a `credentials` object through every site is high churn for
 * an opt-in flag, so the assumed credentials are published ONCE, at the
 * command's entry, through two channels that between them reach every
 * consumer:
 *
 * 1. `setAssumedRoleCredentials` (`src/utils/aws-client-defaults.ts`) —
 *    every SDK client under `src/**` is required to spread
 *    `awsClientDefaults(...)` FIRST, so all of them receive the role as an
 *    EXPLICIT `credentials` value, which outranks a `profile` on the same
 *    config. That helper's header carries the full reasoning.
 * 2. The `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`
 *    env vars — for the consumers channel 1 cannot reach: cdk-local's own
 *    SDK clients and the CDK app subprocess, which inherit this process's
 *    environment.
 *
 * **Why channel 1 exists, and why `AWS_PROFILE` is nonetheless LEFT ALONE.**
 * Channel 2 used to be the whole mechanism, and it is silently inert
 * whenever a profile is selected: `@aws-sdk/credential-provider-node`
 * skips the env-var provider once `AWS_PROFILE` is set, so
 * `--profile ci --role-arn <r>` assumed the role, reported it assumed,
 * and then ran every call as `ci` — potentially in a different account
 * (issue [#3130](https://github.com/go-to-k/cdkd/issues/3130)). Deleting
 * `AWS_PROFILE` would not have fixed that on its own (cdkd also passes
 * `profile` as an explicit client-config key, which outranks the
 * environment), and it costs something real: `AWS_PROFILE` is the only
 * region source `Synthesizer.resolveSdkDefaultRegion` has when the user
 * exported a profile rather than passing `--profile`, so clearing it would
 * silently drop the CDK app's `CDK_DEFAULT_REGION` and synthesize an
 * env-agnostic stack for a different region than the profile named.
 *
 * **The one consumer channel 2 must NOT reach.** `cdkd local *` copies the
 * same three environment variables into the emulated Lambda / AgentCore
 * container, so the role reached the USER'S OWN CODE — which is what
 * `--assume-role` is for, and never what `--role-arn` asked for. Channel 1's
 * `ignoreAssumedRole` opt-out cannot express that here, because the value is
 * not a client config but three variables whose original contents the
 * overwrite below destroys. So the caller's own triple is SNAPSHOTTED first
 * (`setPreAssumeEnvCredentials`), and the local surface's forwarding sites
 * restore it — or, when the caller had none, strip the role's.
 * `src/utils/caller-credentials.ts` owns that decision and its reasoning.
 *
 * So the split is by ROLE, not by channel: `--role-arn` decides the
 * IDENTITY (channel 1, every client under `src/**`), and the profile keeps
 * the two jobs an assumed role cannot do — answering the `AssumeRole`
 * below, and supplying shared-config settings such as the region. The
 * bound that leaves: with both in play, a client built OUTSIDE `src/**`
 * still resolves the profile, because channel 2 stays inert for it.
 *
 * **What the assumed role must carry.** Unlike `cdk deploy`, cdkd does
 * NOT route through CloudFormation. There is no cfn-exec-role to
 * delegate to. Every IAM / EC2 / Lambda / etc. API call is issued from
 * the cdkd process directly. The role you pass to `--role-arn` (or set
 * in `CDKD_ROLE_ARN`) must therefore carry the actions for the resource
 * types being deployed plus cdkd's own bookkeeping set (Cloud Control,
 * `cloudformation:DescribeType` / `ListExports` / `DescribeStacks`,
 * `sts:GetCallerIdentity`, the state and asset storage) — i.e. exactly what the
 * caller's own principal would otherwise have needed, not
 * `AdministratorAccess`. CDK CLI's `cdk-hnb659fds-deploy-role-*` is NOT
 * sufficient — that role only carries CFn + asset-publish permissions.
 *
 * **Once per process, enforced at both ends.** Every command handler calls this
 * exactly once, at its entry, and a second call cannot quietly work: the
 * `AssumeRole` hop below opts out of the published role (so it is answered by
 * the identity the user started with, never by role A assuming role B — a chain
 * AWS caps at one hour and refuses unless B's trust policy names A), and
 * `setAssumedRoleCredentials` then REFUSES the second publish outright. Both
 * are needed: the opt-out alone would let two identities coexist, and the
 * refusal alone would leave the hop chaining.
 *
 * Default session duration is 1 hour. For longer-running deploys, the
 * caller should re-issue the cdkd command (the in-flight credentials
 * stay valid until expiry, but a re-run is the simplest recovery for
 * the rare case where a deploy outlives them). Nothing refreshes them —
 * `AssumedRoleCredentials.expiration` is carried for the log line, not acted
 * on; that field's doc in `aws-client-defaults.ts` records the bound.
 */
export async function applyRoleArnIfSet(opts: {
  roleArn: string | undefined;
  region: string | undefined;
}): Promise<void> {
  const roleArn = opts.roleArn || process.env['CDKD_ROLE_ARN'];
  if (!roleArn) return;

  // BEFORE the hop, not after it. `setAssumedRoleCredentials` refuses a second
  // publish too, but by the time that refusal fires this function has already
  // issued a real `sts:AssumeRole`, SNAPSHOTTED role A's triple as if it were
  // "the caller's own identity" — the value the `cdkd local` surface hands an
  // emulated workload — and overwritten `process.env` with role B's. Every
  // channel is corrupted before the guard trips, so the later refusal protects
  // only the bag. The two together are belt-and-braces on one invariant, with
  // this end deciding that NOTHING happens at all.
  //
  // The text is SHARED with the publish-side refusal rather than re-spelled:
  // one invariant must not grow two explanations that can drift apart.
  if (getAssumedRoleCredentials() !== undefined) {
    throw new Error(SECOND_ROLE_PUBLISH_REFUSAL);
  }

  const logger = getLogger().child('role-arn');
  // `roleArn` is user-controlled text (a CLI argument or `CDKD_ROLE_ARN`) on its
  // way to a terminal, and this line fires BEFORE any validation of it — the
  // same class the warning below withholds the profile name for. `asciiOnly`
  // because an ARN has a known charset, so a legitimate one renders unchanged.
  const displayRoleArn = displaySafe(roleArn, { asciiOnly: true });
  logger.debug(`Assuming role ${displayRoleArn}...`);

  // `ignoreAssumedRole` because this hop must be answered by the identity the
  // user STARTED with — a profile, the environment, an instance role — not by a
  // role this same function published earlier in the process, which would CHAIN
  // (role A assuming role B): AWS caps a chained session at one hour and
  // refuses it outright unless B's trust policy names A.
  //
  // The guard at the top of this function now makes that state unreachable, so
  // this is the inner of three fences rather than the one doing the work. It is
  // kept because it is the only one that would still hold if a role were ever
  // published by something other than this function, and because it is inert on
  // the reachable path: with no role published yet, the opt-out changes nothing
  // the helper returns.
  const sts = new STSClient({
    ...awsClientDefaults({ ignoreAssumedRole: true }),
    ...(opts.region && { region: opts.region }),
  });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkd-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    if (!response.Credentials) {
      throw new Error(`AssumeRole returned no credentials for role ${displayRoleArn}`);
    }
    const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = response.Credentials;
    if (!AccessKeyId || !SecretAccessKey || !SessionToken) {
      throw new Error(`AssumeRole response missing credentials fields for role ${displayRoleArn}`);
    }
    // Channel 2's carve-out (see this function's header): `cdkd local *` copies
    // this triple into the emulated container. Snapshot what it held BEFORE the
    // overwrite below —
    // after it, the caller's own identity is unrecoverable, and it is the only
    // identity the local surface may hand to a workload cdkd merely emulates.
    // `undefined` when the caller resolves through SSO / IMDS / a container
    // role; `src/utils/caller-credentials.ts` turns that into "strip the triple"
    // rather than "inherit the role". See that module's header.
    setPreAssumeEnvCredentials(readEnvCredentials());
    process.env['AWS_ACCESS_KEY_ID'] = AccessKeyId;
    process.env['AWS_SECRET_ACCESS_KEY'] = SecretAccessKey;
    process.env['AWS_SESSION_TOKEN'] = SessionToken;
    // Channel 1 (see this function's header): every SDK client under `src/**`
    // now receives these as an explicit `credentials` value, which beats a
    // `profile` passed on the same client config.
    setAssumedRoleCredentials({
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretAccessKey,
      sessionToken: SessionToken,
      ...(Expiration && { expiration: Expiration }),
    });
    logger.info(
      `Assumed role ${displayRoleArn} (session expires ${Expiration?.toISOString() ?? 'unknown'})`
    );
    // An empty `AWS_PROFILE` selects no profile — the SDK ignores it — so
    // warning on one would describe a conflict that does not exist. Matches
    // the `!== ''` guard `awsClientDefaults` already applies.
    const selectedProfile = process.env['AWS_PROFILE'];
    if (selectedProfile !== undefined && selectedProfile !== '') {
      // The one part of the combination cdkd CANNOT reconcile, said out loud so
      // the silent case of issue #3130 cannot come back in a narrower form: a
      // program cdkd launches inherits this environment, where a selected
      // profile still outranks the credential triple above. The profile NAME is
      // deliberately not interpolated — it is user-controlled text on its way
      // to a terminal — and neither is the flag, since the role may have come
      // from `CDKD_ROLE_ARN`.
      logger.warn(
        'AWS_PROFILE is set and a role has been assumed. The AWS calls cdkd makes to ' +
          'deploy and read state run as the role. The profile still decides the region, ' +
          'it is what your CDK app resolves during synthesis, and — when you passed ' +
          '`--profile` rather than exporting it — it is the identity a `cdkd local` ' +
          'emulated function or task is given. See ' +
          'https://github.com/go-to-k/cdkd/blob/main/docs/cli-reference.md'
      );
    }
  } finally {
    sts.destroy();
  }
}
