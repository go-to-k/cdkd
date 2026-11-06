import {
  describeLocalAwsFailureForWarn,
  redactedAwsCause,
} from '../../../utils/local-aws-failure.js';
import { assertSendableRoleArn, sendableAssumeRoleCommand } from '../../../utils/role-arn.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { displayIdent, ROLE_ARN_MAX_CODE_POINTS } from '../../../utils/display-safe.js';
import { isPasteableIdent } from '../state-file-keys.js';
import { strandedProfileCredentialsNotice } from '../local-profile-credentials-file.js';
import { awsClientDefaults } from '../../../utils/aws-client-defaults.js';

/**
 * Issue #654: resolve `--profile <p>` to a concrete credential set
 * for forwarding to Lambda containers.
 *
 * The dev's AWS credentials may live in any of:
 *   - `~/.aws/sso/cache/*.json` (AWS IAM Identity Center / legacy SSO)
 *   - `~/.aws/credentials` (regular long-lived access keys)
 *   - `~/.aws/config` profiles with `role_arn` + `source_profile` (chained AssumeRole)
 *   - `credential_process` external resolvers
 *
 * `forwardAwsEnv` only reads `process.env.AWS_*`, which is empty for
 * every shape except "user manually exported the env vars". The
 * Lambda container therefore boots without creds and the handler's
 * AWS SDK call fails with `Could not load credentials from any providers`.
 *
 * This helper constructs a transient `STSClient({ profile })` to drive
 * the SDK's default credential provider chain — same code path cdkd's
 * own CFn / CC API clients use when `--profile` is set, so SSO / IAM
 * Identity Center / role-assumption profiles all resolve the same way
 * they already do for cdkd's outbound calls. We then extract the
 * resolved `AwsCredentialIdentity` via `sts.config.credentials()` and
 * return the underlying `{ accessKeyId, secretAccessKey, sessionToken? }`
 * for env-var injection.
 *
 * Called ONCE at server boot; the resolved creds are reused for every
 * Lambda container's env overlay (when `--assume-role` is not set for
 * that Lambda — assume-role wins per the existing precedence). SSO
 * temp creds typically last 1h+, so a single resolve is fine for the
 * common dev session; long-running `--watch` sessions that outlive
 * the creds need a cdkd restart (deferred refresh out of scope for
 * v1, see issue #654).
 */
export async function resolveProfileCredentials(
  profile: string
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }> {
  const { STSClient } = await import('@aws-sdk/client-sts');
  // `ignoreAssumedRole` because the question here is "what does THIS profile
  // resolve to", and the answer is forwarded INTO the user's container. A
  // `--role-arn` assumed for cdkd's own calls would otherwise capture it and
  // run the emulated function as the deploy role (issue
  // [#3130](https://github.com/go-to-k/cdkd/issues/3130) review). The flag for
  // the function's identity is `--assume-role`, which still wins over this.
  const sts = new STSClient({
    ...awsClientDefaults({ profile, ignoreAssumedRole: true }),
    profile,
  });
  // Issue [#3377](https://github.com/go-to-k/cdkd/issues/3377). The profile
  // name is user-supplied argv and this message is terminal-bound, so it
  // renders through `src/utils/display-safe.ts` -- and the TWO occurrences
  // below take DIFFERENT helpers, because they are different shapes.
  //
  // The first is a MESSAGE: it names which `--profile` failed, so it takes
  // `displayIdent` -- the ASCII allowlist, the length cap, and the
  // JSON-quoted BOUNDARY that keeps an all-ASCII name from planting what
  // reads as cdkd's own annotation inside the sentence. The hand-written
  // `'...'` quotes are gone for the reason `displayIdent`'s rule 3 gives:
  // it quotes conditionally, so a legitimate name renders exactly as it
  // always did and only a spoofing one gains quotes.
  //
  // The second is a COMMAND WE TELL AN OPERATOR TO RUN, and `displayIdent`
  // is NOT enough for that -- `state-file-keys.ts`'s `isPasteableIdent`
  // exists because `displayIdent` correctly renders `--state-bucket=x`
  // bare, every character of it being a plain identifier character, while
  // that value is a FLAG once pasted. A profile name is in the same
  // position here: it is the word right after `--profile`, so a name
  // beginning `-` or `~` is an option or a home-directory expansion rather
  // than a name. Shell-quoting is not the answer either (an option is still
  // an option inside quotes), so the honest answer for a name failing the
  // test is to NOT print a command whose effect we cannot predict, and to
  // say so -- the same disposition `gc.ts` takes for an unpasteable stack
  // name. When the test passes, the value is `[A-Za-z0-9][A-Za-z0-9~_.-]*`,
  // which needs no quoting at all.
  const shownProfile = displayIdent(profile);
  // cdkd-profile-display: the true arm below is gated on `isPasteableIdent`
  // rather than rendered through `displayIdent`, because that arm IS the
  // pasteable command. The predicate admits only
  // `[A-Za-z0-9][A-Za-z0-9~_.-]*` AND requires a `displayIdent` round-trip
  // to be the identity, so a value reaching it is bare-safe by
  // construction; sanitizing it again could only CHANGE the name the
  // operator is told to log in to, which is the wrong-object harm the
  // false arm exists to avoid.
  const ssoHint = isPasteableIdent(profile)
    ? 'run `aws sso login --profile ' + profile + '`'
    : // The wording is precise on purpose, and two earlier drafts were not.
      // It does NOT say the name is absent -- `shownProfile` renders it in
      // the FIRST of the three sentences this message is now built from. And it does not call the name
      // unpasteable: `isPasteableIdent` is ASCII-only, so a perfectly
      // pasteable `prod-café` takes this arm too. What cdkd declines is to
      // WRITE THE COMMAND OUT, because the predicate is what licenses
      // putting a value on a command line bare, and outside it cdkd cannot
      // vouch that the rendered name is the one the shell would act on.
      'run `aws sso login` for that profile -- cdkd is not writing the command out, ' +
      'because it cannot vouch that the name as rendered is the one your shell would act on';
  try {
    const credsProvider = sts.config.credentials;
    const creds = typeof credsProvider === 'function' ? await credsProvider() : credsProvider;
    if (!creds || !creds.accessKeyId || !creds.secretAccessKey) {
      // The tail is a SENTENCE of its own rather than a `, or ...` clause hung
      // off `ssoHint`. The two arms differ in length by ~60 characters, and
      // trailing a comma-clause off the long one left a dangling
      // `..., or \`~/.aws/credentials\` ... for regular profiles.` that reads as
      // a third alternative to logging in (go-to-k/cdkd#3390 round 2).
      // cdkd-raw-beside-safe: `ssoHint` is the local two lines up, and it is
      // GATED rather than sanitized -- the only arm that interpolates the raw
      // profile is behind `isPasteableIdent`, and the other arm is a literal.
      // Sanitizing it here would be wrong for the same reason the gate exists:
      // `isPasteableIdent` admits only `[A-Za-z0-9][A-Za-z0-9~_.-]*`, so a
      // second pass could only alter a value already proven bare-safe, and the
      // command would then name a profile the operator does not have.
      // `shownProfile` beside it takes `displayIdent` because it is a MESSAGE.
      throw new CdkdError(
        `--profile ${shownProfile}: credential provider chain resolved without usable ` +
          `credentials. For SSO profiles, ${ssoHint}. For regular profiles, check ` +
          `\`~/.aws/credentials\` / \`~/.aws/config\`.`,
        'LOCAL_PROFILE_CREDENTIALS_UNUSABLE'
      );
    }
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken && { sessionToken: creds.sessionToken }),
    };
  } catch (err) {
    if (err instanceof CdkdError) throw err;
    // No caller catches this, so a credential-resolution failure reached
    // `formatError` raw -- a `credential_process` helper's command line
    // included (go-to-k/cdkd#4857).
    const rendered = describeLocalAwsFailureForWarn(err, '--profile credential resolution');
    // The SDK's own text is withheld, which for an expired SSO session is its
    // remedy, so the same login hint as the refusal above is given here.
    // cdkd-raw-beside-safe: `ssoHint` is gated on `isPasteableIdent` (see its
    // declaration), and the other arm is a literal.
    throw new CdkdError(
      `--profile ${shownProfile}: could not resolve the profile's credentials: ${rendered}. ` +
        `For SSO profiles, ${ssoHint}.`,
      'LOCAL_PROFILE_CREDENTIALS_FAILED',
      redactedAwsCause(err, 'credential resolution failed')
    );
  } finally {
    sts.destroy();
  }
}

/**
 * The line the force-exit arm of {@link localStartApiCommand}'s shutdown
 * prints (go-to-k/cdkd#3435 review).
 *
 * PURE and EXPORTED for one reason: nothing stands this long-running server
 * command up in a unit test, so the force-exit arm's only fence was a
 * source-shape rule over the file — "does it CALL the notice builder". A
 * reviewer measured that predicate: mutating the rendered line to drop
 * `stranded` while keeping the call left the entire suite green, with the
 * operator never told the mode-0600 credentials tmpdir exists. That is exactly
 * go-to-k/cdkd#3410's defect, re-openable inside its own fix. The
 * CONCATENATION is what has to be asserted, so it lives here rather than
 * inline.
 *
 * `hostPath` is the credentials tmpdir's path or `undefined`; a run that passed
 * no `--profile` gets the container sentence alone, with no trailing space and
 * no mention of a file that does not exist.
 */
export function forceExitShutdownWarning(signal: string, hostPath: string | undefined): string {
  const stranded = strandedProfileCredentialsNotice(hostPath);
  return (
    `Received second ${signal}; force-exiting. Orphan containers may remain — run ` +
    `'docker ps --filter name=cdkd-local-' and 'docker rm -f' to clean up.` +
    (stranded === undefined ? '' : ` ${stranded}`)
  );
}

/**
 * Issue an STS AssumeRole and return temporary credentials. Mirrors
 * `cdkd local invoke`'s helper byte-for-byte; lifted here so the
 * start-api command stays self-contained.
 *
 * @internal exported for unit tests (go-to-k/cdkd#4857).
 */
export async function assumeLambdaExecutionRole(
  roleArn: string,
  region: string | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  assertSendableRoleArn(roleArn);
  const { STSClient } = await import('@aws-sdk/client-sts');
  // `ignoreAssumedRole` -- this resolves the execution role's credentials, injected into the container,
  // so it must be the caller's own identity, never a `--role-arn` assumed
  // for cdkd's own calls. See that option's JSDoc.
  const sts = new STSClient({
    ...awsClientDefaults({ ignoreAssumedRole: true }),
    ...(region && { region }),
  });
  try {
    const response = await sts.send(
      sendableAssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkd-local-start-api-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new CdkdError(
        `AssumeRole(${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) returned no usable credentials.`,
        'LOCAL_START_API_ASSUMEROLE_NO_CREDS'
      );
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } catch (err) {
    if (err instanceof CdkdError) throw err;
    // No caller catches this, so the raw SDK error reached `formatError`
    // unsanitized -- a `credential_process` command line included
    // (go-to-k/cdkd#4857).
    const rendered = describeLocalAwsFailureForWarn(err, 'STS AssumeRole');
    throw new CdkdError(
      `--assume-role: STS AssumeRole(${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) failed: ${rendered}.`,
      'LOCAL_START_API_ASSUMEROLE_FAILED',
      redactedAwsCause(err, 'STS AssumeRole failed')
    );
  } finally {
    sts.destroy();
  }
}
