/**
 * The CALLER's own AWS identity, for the one channel that reaches a workload
 * cdkd merely emulates (issue
 * [#3130](https://github.com/go-to-k/cdkd/issues/3130)).
 *
 * WHY THIS EXISTS
 *
 * `applyRoleArnIfSet` (`src/utils/role-arn.ts`) assumes `--role-arn` /
 * `CDKD_ROLE_ARN` and then OVERWRITES `process.env.AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` with the role's, so that clients
 * built outside `src/**` (cdk-local's own, the CDK app subprocess) run as the
 * role too. Every `cdkd local *` command then COPIES that triple out of
 * `process.env` into the emulated Lambda / AgentCore container's environment —
 * so `cdkd local invoke --role-arn arn:aws:iam::222:role/cdkd-deploy MyFn` ran
 * the user's local handler AS THE DEPLOY ROLE, normally the more privileged of
 * the two identities and never the one the flag asked for.
 *
 * The SDK-client half of that class was closed by threading
 * `awsClientDefaults({ ignoreAssumedRole: true })` through every client on the
 * surface. That opt-out cannot reach this channel: the value here is not a
 * client config, it is three environment variables whose ORIGINAL contents the
 * assume already destroyed. So `applyRoleArnIfSet` snapshots them first
 * (`setPreAssumeEnvCredentials`) and this module is what turns the snapshot back
 * into an answer.
 *
 * THE ANSWER IS "WHAT WOULD THE CONTAINER HAVE RECEIVED WITHOUT `--role-arn`"
 *
 * Not "who is the caller" in the SDK's sense — that question has a different
 * answer when a profile is selected, and `resolveProfileCredentials` +
 * `applyProfileCredentialsOverlay` already answer it for the `--profile` case
 * and still win, because they are applied AFTER this restore. What this module
 * restores is exactly the status quo ante: the bytes `forwardAwsEnv` would have
 * copied had no role been assumed.
 *
 * WHEN THERE IS NOTHING TO RESTORE, NOTHING IS FORWARDED
 *
 * On an SSO / IMDS / container-role chain the triple was ABSENT before the
 * assume. Fabricating a replacement is not available and inheriting the role is
 * the defect, so the three keys are STRIPPED from the forwarded environment and
 * the container falls back to its own credential resolution — which, with no
 * mounted credentials file, usually means the handler's first AWS call fails
 * with `Could not load credentials from any providers`. That is the documented
 * outcome (`docs/cli-reference.md`), and it is the correct one: a loud missing
 * credential beats a silent privileged one.
 */

import {
  getAssumedRoleCredentials,
  getPreAssumeEnvCredentials,
  type CallerEnvCredentials,
} from './aws-client-defaults.js';

/**
 * The three environment variables that carry a static AWS identity into a child
 * process or container. Spelled once here so a forwarding site and the fence
 * that watches it cannot disagree about the population.
 */
export const AWS_CREDENTIAL_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

/**
 * Read a static credential triple out of an environment bag, or `undefined`
 * when it does not carry a complete one.
 *
 * BOTH halves of the key pair are required: an `AWS_ACCESS_KEY_ID` with no
 * secret is not an identity, and treating it as one would make the caller
 * "have credentials" while handing the container an unusable pair.
 */
export function readEnvCredentials(
  source: NodeJS.ProcessEnv = process.env
): CallerEnvCredentials | undefined {
  const accessKeyId = source['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = source['AWS_SECRET_ACCESS_KEY'];
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = source['AWS_SESSION_TOKEN'];
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

/**
 * The static credentials the caller's OWN environment carried — the process
 * environment when no role was assumed, the pre-assume snapshot when one was.
 *
 * For a site that needs the VALUE rather than an env bag to correct (the
 * `--sigv4` signing path in `local-invoke-agentcore.ts`). `undefined` means the
 * caller has no static credentials to offer; the site decides what that means
 * for it (that one refuses with an actionable error).
 *
 * **Do not mutate the returned bag.** On the assumed-role branch it is
 * `aws-client-defaults.ts`'s OWN copy of the pre-assume snapshot — the object
 * shape 2 of the `ignoreAssumedRole` opt-out resolves every opted-out client's
 * identity from — so a caller that edits it in place changes who those clients
 * run as. The note sits here as well as on `getPreAssumeEnvCredentials` because
 * this module's header directs callers to THIS function; reaching the snapshot
 * through the getter directly is what it tells them not to do.
 */
export function callerEnvCredentials(): CallerEnvCredentials | undefined {
  if (getAssumedRoleCredentials() === undefined) return readEnvCredentials();
  return getPreAssumeEnvCredentials();
}

/**
 * Correct an environment bag that was populated by copying `process.env`, so it
 * carries the CALLER's identity rather than a `--role-arn` assumed role's.
 *
 * A NO-OP when no role was assumed — the copied triple is already the caller's,
 * and this must not disturb the overwhelmingly common path.
 *
 * Otherwise the role's triple is replaced by the pre-assume snapshot, or — when
 * there was none — REMOVED outright (see this module's header). The
 * session-token handling mirrors `applyProfileCredentialsOverlay`: a restored
 * long-lived key pair strips any inherited token, because a long-lived
 * `AKIA...` beside a foreign session token makes the SDK inside the container
 * fail rather than fall back.
 *
 * Call it AFTER copying `process.env` and BEFORE any `--profile` overlay: the
 * profile identity is more specific and is also the caller's, so it wins.
 */
export function applyCallerIdentityCredentials(env: Record<string, string>): void {
  if (getAssumedRoleCredentials() === undefined) return;
  const caller = getPreAssumeEnvCredentials();
  if (!caller) {
    for (const key of AWS_CREDENTIAL_ENV_KEYS) delete env[key];
    return;
  }
  env['AWS_ACCESS_KEY_ID'] = caller.accessKeyId;
  env['AWS_SECRET_ACCESS_KEY'] = caller.secretAccessKey;
  if (caller.sessionToken) {
    env['AWS_SESSION_TOKEN'] = caller.sessionToken;
  } else {
    delete env['AWS_SESSION_TOKEN'];
  }
}
