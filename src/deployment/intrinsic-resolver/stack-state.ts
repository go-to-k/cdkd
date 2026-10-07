import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { markNonRetryable } from '../retryable-errors.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { awsClientDefaults } from '../../utils/aws-client-defaults.js';
import { resolveCrossAccountStateBucket } from '../../utils/aws-region-resolver.js';
import { ROLE_ARN_MAX_CODE_POINTS, displayIdent } from '../../utils/display-safe.js';
import { UNSHOWABLE_VALUE, shellBoundedDisplay } from '../../utils/pasteable-command.js';
import { assumeRoleForCrossAccountStateRead, parseIamRoleArn } from '../../utils/role-arn.js';
import { type ResolverContext } from './support.js';
import { S3Client } from '@aws-sdk/client-s3';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    getSameAccountStackState: OmitThisParameter<typeof getSameAccountStackState>;
    /** @internal */
    getCrossAccountStackState: OmitThisParameter<typeof getCrossAccountStackState>;
  }
}

/**
 * Read the producer's state from the SAME AWS account (no RoleArn).
 *
 * Uses the consumer's shared `context.stateBackend` — the same backend
 * the consumer used to read / write its own state. The same-account
 * path covers cross-region cleanly because the bucket name is
 * account-scoped (not region-scoped).
 */
export async function getSameAccountStackState(
  this: IntrinsicFunctionResolver,
  stackName: string,
  region: string,
  context: ResolverContext
): ReturnType<S3StateBackend['getState']> {
  if (!context.stateBackend) {
    throw markNonRetryable(
      new Error('Fn::GetStackOutput: state backend is required for cross-stack references')
    );
  }
  return context.stateBackend.getState(stackName, region);
}

/**
 * Read the producer's state from a DIFFERENT AWS account (RoleArn set).
 *
 * Pipeline:
 *   1. Parse `roleArn` for the producer's account id (rejects malformed
 *      ARNs up front with a clear message — no opaque STS error later).
 *   2. `sts:AssumeRole` against `roleArn`, cached per role for the
 *      deploy lifetime (typical: 1 STS hop covering many `Fn::GetStackOutput`
 *      sites in the same deploy).
 *   3. Derive the producer's canonical state bucket
 *      (`cdkd-state-{producerAccountId}`) and auto-detect its region
 *      via `GetBucketLocation` with the assumed credentials.
 *   4. Build a fresh, narrowly-scoped `S3StateBackend` against that
 *      bucket with the assumed credentials and call `getState` —
 *      reuses the entire state-parsing + schema-version-tolerance
 *      machinery (legacy `version: 1` keys, migration warnings, etc.).
 *
 * The constructed `S3Client` and backend live only for the duration of
 * this call. cdkd does NOT mutate the process's `AWS_*` env vars (that
 * would leak the assumed credentials into every subsequent provisioning
 * client — opposite of what we want; provisioning still runs under the
 * consumer's normal credentials).
 */
export async function getCrossAccountStackState(
  this: IntrinsicFunctionResolver,
  roleArn: string,
  stackName: string,
  region: string,
  context: ResolverContext
): ReturnType<S3StateBackend['getState']> {
  const parsed = parseIamRoleArn(roleArn);
  if (!parsed) {
    // THE site of this class most worth sanitizing, and the reason is the
    // control flow (issue go-to-k/cdkd#3397): this is the refusal for a value
    // that JUST FAILED `parseIamRoleArn`, so the text reaching it is by
    // construction one no shape gate accepted — the argument issue
    // [#3377](https://github.com/go-to-k/cdkd/issues/3377) made about
    // `writeProfileCredentialsFile` interpolating the name it was refusing.
    // Sanitized at the RENDER rather than by narrowing `parseIamRoleArn`,
    // which must keep returning `undefined` for exactly these inputs.
    //
    // A plain value keeps its hand-written `'...'`. Any other is shown, since
    // the operator needs it to fix the template, as `displayIdent`'s JSON
    // shell-quoted by `shellBoundedDisplay`: a `'` in the value closed
    // cdkd's own quote, and bare JSON would let `$( )` run in a pasted
    // sentence (go-to-k/cdkd#3950).
    // not-in-class(displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })): the RoleArn argument, refused unless it is a literal template string.
    const shownRoleArn = displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS });
    // Whitespace FIRST: a value that IS `displayIdent`'s own cut output (the
    // cap's worth of plain characters, then ` [cut: N more characters
    // withheld, tail sha256:<hex>]`) would sit inside cdkd's `'...'` with `: `
    // in it, and only the marker's tail digest keeps the round-trip from
    // admitting it (go-to-k/cdkd#4002).
    const plain = !/\s/.test(roleArn) && shownRoleArn === roleArn;
    const bounded = plain ? `'${shownRoleArn}'` : shellBoundedDisplay(shownRoleArn);
    // A described value reads as a noun phrase, not as the ARN itself.
    const subject =
      bounded === UNSHOWABLE_VALUE
        ? `the RoleArn argument (${UNSHOWABLE_VALUE})`
        : `RoleArn ${bounded}`;
    throw markNonRetryable(
      new Error(
        `Fn::GetStackOutput: ${subject} is not a valid IAM role ARN. ` +
          `Expected shape: arn:<partition>:iam::<12-digit-account-id>:role/<role-name>` +
          ` (e.g. arn:aws:iam::123456789012:role/MyRole, arn:aws-us-gov:iam::...).`
      )
    );
  }

  const credentials = await assumeRoleForCrossAccountStateRead(roleArn);
  const { bucket, region: bucketRegion } = await resolveCrossAccountStateBucket(
    parsed.accountId,
    credentials
  );

  // Reuse the consumer-side state prefix (the cdkd convention is `cdkd`
  // and is the same on both sides — the producer's own `cdkd deploy`
  // wrote under the same prefix). Pulling the live value off the
  // consumer's backend keeps us in sync with `--state-prefix`
  // overrides at the consumer side; in practice both sides almost
  // always default to `cdkd`.
  const prefix = context.stateBackend?.prefix ?? 'cdkd';

  const s3 = new S3Client({
    ...awsClientDefaults(),
    region: bucketRegion,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    // Suppress the SDK's noisy "unknown Body length" warning; matches
    // the suppression in `AwsClients` and the consumer-side state
    // backend's region-rebuild path.
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });

  const crossAccountBackend = new S3StateBackend(
    s3,
    { bucket, prefix },
    {
      region: bucketRegion,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    }
  );

  return crossAccountBackend.getState(stackName, region);
}
