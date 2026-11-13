import { firstUsableRegion } from 'cdk-local/internal';
import { mixedModeActive, setContainerRegion } from '../../../local/local-aws-wiring.js';
import { getLogger } from '../../../utils/logger.js';
import { describeLocalAwsFailureForWarn } from '../../../utils/local-aws-failure.js';
import { displayIdent, ROLE_ARN_MAX_CODE_POINTS } from '../../../utils/display-safe.js';
import { assertSendableRoleArn, sendableAssumeRoleCommand } from '../../../utils/role-arn.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { awsClientDefaults } from '../../../utils/aws-client-defaults.js';
import {
  applyCallerIdentityCredentials,
  AWS_CREDENTIAL_ENV_KEYS,
} from '../../../utils/caller-credentials.js';

/**
 * Inject AWS credentials into the container env. Precedence:
 *   1. `--assume-role` → STS-issued temp creds for the resolved ARN (on
 *      STS failure, warn + fall through to dev creds). Swapping the
 *      developer's credentials for the function's deployed execution role
 *      degrades rather than hard-errors: this is a developer-loop tool, not
 *      a security boundary, and the most common cause is the role's
 *      `AssumeRolePolicy` not trusting the developer's IAM principal (a
 *      config gap, not a cdkd bug).
 *   2. dev shell creds (`forwardAwsEnv` — which folds the region case for the
 *      same reason arm 1 does) + `--profile` overlay
 *      ({@link applyProfileCredentialsOverlay}) + the bind-mounted
 *      credentials-file env so handler `fromIni({ profile })` resolves.
 *      Applied in that order: the overlay intentionally wins over whatever
 *      `forwardAwsEnv` copied, and the credentials-file env is additive.
 *
 * Extracted from `localInvokeCommand`'s body by issue
 * [#1836](https://github.com/go-to-k/cdkd/issues/1836) and shaped to mirror
 * `applyAgentCoreCredentialEnv` in `local-invoke-agentcore/env.ts` (the sibling
 * issue [#1814](https://github.com/go-to-k/cdkd/issues/1814) fixed), so a unit
 * test can lock the STS-client region binding with a mocked STS instead of
 * driving the full synth + docker pipeline.
 */
export async function applyLambdaCredentialEnv(
  dockerEnv: Record<string, string>,
  args: {
    assumeRoleArn?: string;
    region?: string;
    /** The stack's own region: the container's region when nothing names one. */
    stackRegion?: string;
    profileCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    profileCredsFile?: { containerPath: string; profileName: string };
  }
): Promise<void> {
  const logger = getLogger();
  let assumeSucceeded = false;
  if (args.assumeRoleArn) {
    // Issue #1836: the chain that ESCAPES the handler-entry fold. `--region`
    // arrives already folded, but the two env-var fall-throughs do not — so
    // `--assume-role` with `AWS_REGION=CN-NORTH-1` and no `--region` handed the
    // raw value BOTH to the AssumeRole STS client below (whose endpoint
    // resolution is case-SENSITIVE, so it talked to the COMMERCIAL partition)
    // and to the container's own `AWS_REGION`, i.e. to every SDK client the
    // handler builds. Same shape as `applyAgentCoreCredentialEnv`'s fourth
    // chain (issue #1814).
    //
    // This arm covers the `--assume-role` path ONLY. The default path's copy of
    // the container region is folded in {@link forwardAwsEnv} below — folding
    // just here made the same command answer differently depending on whether
    // `--assume-role` was passed.
    const stsRegion = canonicalizeRegion(
      args.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION']
    );
    try {
      const creds = await assumeLambdaExecutionRole(args.assumeRoleArn, stsRegion);
      // cdkd-local-env-identity: `--assume-role`'s own STS hop — the flag whose
      // entire job is to choose the emulated function's identity. Its STS client
      // opts out of the `--role-arn` role, so the hop is answered by the caller.
      dockerEnv['AWS_ACCESS_KEY_ID'] = creds.accessKeyId;
      dockerEnv['AWS_SECRET_ACCESS_KEY'] = creds.secretAccessKey;
      dockerEnv['AWS_SESSION_TOKEN'] = creds.sessionToken;
      setContainerRegion(dockerEnv, stsRegion);
      assumeSucceeded = true;
    } catch (err) {
      logger.warn(
        `--assume-role: STS AssumeRole(${displayIdent(args.assumeRoleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) failed: ${describeLocalAwsFailureForWarn(err, 'STS AssumeRole')}. ` +
          "Falling back to the developer's shell credentials."
      );
    }
  }
  if (!assumeSucceeded) {
    forwardAwsEnv(dockerEnv);
    // Issue #657: when `--profile <p>` was supplied AND assume-role
    // did not produce creds for this Lambda (either not asked for or
    // STS failed), overlay the profile-resolved {AKID, SAK,
    // sessionToken?} on top of whatever `forwardAwsEnv` copied from
    // `process.env`. See `applyProfileCredentialsOverlay`'s doc for
    // the full precedence table + session-token-strip rationale.
    applyProfileCredentialsOverlay(dockerEnv, args.profileCredentials, false);
    // Issue #2 deferred from #655: point the container's SDK chain at
    // the bind-mounted credentials file so `fromIni({ profile })` calls
    // inside the handler resolve to the same creds. `AWS_PROFILE` makes
    // `fromIni()` (no explicit arg) ALSO use this profile.
    if (args.profileCredsFile) {
      dockerEnv['AWS_SHARED_CREDENTIALS_FILE'] = args.profileCredsFile.containerPath;
      dockerEnv['AWS_PROFILE'] = args.profileCredsFile.profileName;
    }
    // A Lambda always runs with `AWS_REGION` set. The same chain the
    // `--assume-role` arm and `${AWS::Region}` use (`--region`, then the host
    // variables), then the stack's own region, as deployed Lambda would get;
    // without it a handler's first SDK call failed with `Region is missing`
    // (go-to-k/cdkd#6132's live run). `--region` wins over a host
    // `AWS_REGION` here exactly as it does on the `--assume-role` arm.
    const containerRegion = firstUsableRegion(
      args.region,
      process.env['AWS_REGION'],
      process.env['AWS_DEFAULT_REGION'],
      args.stackRegion
    );
    setContainerRegion(dockerEnv, containerRegion);
  }
}

/**
 * Assume the Lambda execution role and return temporary credentials.
 *
 * Closes the "developer has admin creds, the deployed function has narrow
 * ones" skew that SAM users routinely hit. Off by default; opt-in via
 * `--assume-role <arn>` (explicit) or `--assume-role` (bare, auto-resolved
 * from cdkd state via `resolveExecutionRoleArnFromState`).
 *
 * Mirrors the env-var-write pattern from `applyRoleArnIfSet` in
 * `src/utils/role-arn.ts` but writes the temp creds onto the container's
 * env block (not the cdkd process's env), so the developer's outer
 * shell credentials still flow into any cdkd-side AWS calls (synthesis
 * context probes, etc.).
 */
async function assumeLambdaExecutionRole(
  roleArn: string,
  region: string | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  // A `CdkdError`, so the STS-failure warn this lands in prints its remedy
  // rather than withholding it (go-to-k/cdkd#2300).
  assertSendableRoleArn(roleArn, (m) => new CdkdError(m, 'LOCAL_INVOKE_ASSUME_ROLE_INVALID'));
  const { STSClient } = await import('@aws-sdk/client-sts');
  // `ignoreAssumedRole` -- this resolves the execution role's credentials, injected into the container,
  // so it must be the caller's own identity, never a `--role-arn` assumed
  // for cdkd's own calls. See that option's JSDoc.
  const sts = new STSClient({
    // Mixed mode: an STS hop establishing the REAL identity stays on real AWS (#6150).
    ...awsClientDefaults({ ignoreAssumedRole: true, realAws: mixedModeActive() }),
    ...(region && { region }),
  });
  try {
    const response = await sts.send(
      sendableAssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkd-local-invoke-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new CdkdError(
        `AssumeRole(${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) returned no usable credentials.`,
        'LOCAL_INVOKE_ASSUMEROLE_NO_CREDS'
      );
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } finally {
    sts.destroy();
  }
}

/**
 * Forward the developer's AWS credentials into the container so the
 * handler's AWS SDK calls can authenticate. Used when `--assume-role`
 * is NOT set — SAM-compatible default.
 *
 * Region is inherited from `AWS_REGION` / `AWS_DEFAULT_REGION` so
 * `aws.config.region` inside the handler works without extra setup.
 *
 * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836): the two REGION
 * entries are folded through `canonicalizeRegion` on the way in, the credentials
 * are copied verbatim. This is the DEFAULT path — no `--assume-role` — and it
 * carries the same exposure the assume-role branch had: the value lands in the
 * container's own `AWS_REGION`, i.e. in every SDK client the handler builds, and
 * SDK endpoint resolution is case-SENSITIVE (`CN-NORTH-1` resolves the
 * COMMERCIAL partition). Folding only inside `applyLambdaCredentialEnv`'s
 * assume-role arm made ONE command yield two different container regions for the
 * same shell — `cn-north-1` with `--assume-role`, `CN-NORTH-1` without.
 *
 * Exported for unit-test isolation (`local-container-caller-identity.test.ts`),
 * which drives the `--role-arn` cases without the synth + docker pipeline.
 */
export function forwardAwsEnv(env: Record<string, string>): void {
  // The credential triple comes from `AWS_CREDENTIAL_ENV_KEYS` rather than a
  // local copy so this site and the fence that watches it cannot disagree about
  // the population (issue #3250 item 4 — the constant documented that guarantee
  // while nothing imported it). The two region keys are this command's own
  // concern and stay here.
  const passThrough = [...AWS_CREDENTIAL_ENV_KEYS, 'AWS_REGION', 'AWS_DEFAULT_REGION'] as const;
  const regionKeys = new Set<string>(['AWS_REGION', 'AWS_DEFAULT_REGION']);
  for (const key of passThrough) {
    const value = process.env[key];
    if (value === undefined) continue;
    env[key] = regionKeys.has(key) ? canonicalizeRegion(value) : value;
  }
  // Issue #3130: `applyRoleArnIfSet` OVERWRITES the three credential variables
  // above with a `--role-arn` assumed role's, so the copy that just ran would
  // hand the emulated handler cdkd's deploy role. Put the caller's own identity
  // back (or strip the triple when there was none to restore). A no-op when no
  // role was assumed, so the ordinary path is unchanged. Applied INSIDE the
  // copy rather than at each call site so a site added later inherits it.
  applyCallerIdentityCredentials(env);
}

/**
 * Issue #657: overlay `--profile <p>`-resolved credentials onto the
 * Lambda container's env block AFTER `forwardAwsEnv` has copied
 * `process.env.AWS_*`. The overlay covers SSO / IAM Identity Center /
 * fromIni / role-assumption profiles uniformly (resolved via the SDK's
 * default credential chain in `resolveProfileCredentials`). Without
 * this overlay, a dev who runs `cdkd local invoke --profile dev`
 * AND has no `AWS_ACCESS_KEY_ID` env var (the common SSO / Identity
 * Center case) sees the Lambda boot with no creds → handler's AWS SDK
 * call fails with `Could not load credentials from any providers`.
 *
 * Precedence (codifies existing semantics + this new layer):
 *   1. `--assume-role <arn>` (per-Lambda STS creds) — unchanged
 *   2. NEW: `--profile <p>` resolved + cached (this helper)
 *   3. `process.env.AWS_*` forwarded — when `--profile` not set
 *
 * Region from `forwardAwsEnv` is preserved — only the credential
 * triple is overlaid.
 *
 * When the resolved profile is long-lived (no `sessionToken`), any
 * inherited `AWS_SESSION_TOKEN` is stripped — a mismatched (long-
 * lived AKID + foreign session) would otherwise cause an SDK error
 * inside the container.
 *
 * No-op when `profileCreds` is `undefined` (profile not set) or when
 * `assumeRoleActive` is true (assume-role already won; its STS-issued
 * creds must not be clobbered by the profile overlay).
 *
 * Exported for unit-test isolation (see `local-invoke-profile-creds.test.ts`).
 */
export function applyProfileCredentialsOverlay(
  env: Record<string, string>,
  profileCreds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined,
  assumeRoleActive: boolean
): void {
  if (!profileCreds) return;
  if (assumeRoleActive) return;
  // cdkd-local-env-identity: `--profile`, resolved by `resolveProfileCredentials`
  // through `awsClientDefaults({ ignoreAssumedRole: true })` — the caller's own
  // chain, never the `--role-arn` role. Runs AFTER the caller-identity restore
  // in `forwardAwsEnv` and deliberately outranks it: both are the caller, and
  // the flag is the more specific of the two.
  env['AWS_ACCESS_KEY_ID'] = profileCreds.accessKeyId;
  env['AWS_SECRET_ACCESS_KEY'] = profileCreds.secretAccessKey;
  if (profileCreds.sessionToken) {
    env['AWS_SESSION_TOKEN'] = profileCreds.sessionToken;
  } else {
    // The profile resolved to long-lived creds (no session token).
    // Strip any inherited session token to avoid the SDK trying to
    // use a mismatched (long-lived AKID + foreign session).
    delete env['AWS_SESSION_TOKEN'];
  }
}
