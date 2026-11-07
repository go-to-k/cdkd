import { getLogger } from '../../../utils/logger.js';
import { quotedOrDescribed } from '../../../utils/pasteable-command.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { CdkdError } from '../../../utils/error-handler.js';
import type { LocalStateRecord } from 'cdk-local';
import { type ResolvedAgentCoreRuntime } from '../../../local/agentcore-resolver.js';
import {
  signAgentCoreInvocation,
  type SigV4Credentials,
} from '../../../local/agentcore-sigv4-sign.js';
import { createJwksCache, verifyJwtViaDiscovery } from '../../../local/cognito-jwt.js';
import { resolveProfileCredentials } from '../local-start-api.js';
import {
  callerEnvCredentials,
  envCredentialsAreAssumedRole,
} from '../../../utils/caller-credentials.js';
import {
  assumeRoleFallbackWarning,
  resolveAssumeRoleArn,
  assumeAgentCoreExecutionRole,
} from './env.js';
import type { LocalInvokeAgentCoreOptions } from './types.js';

/**
 * Enforce the runtime's inbound JWT authorizer (when declared) and return
 * the `Authorization` header to forward to `/invocations`.
 *
 * - No authorizer → forward the token verbatim if one was given (no-op
 *   otherwise).
 * - `--no-verify-auth` → warn + forward without verifying (local-dev escape).
 * - Authorizer + no token → reject (AgentCore returns 401).
 * - Authorizer + token → verify against the OIDC discovery URL; reject on
 *   failure (AgentCore returns 403); forward on success. An unreachable
 *   discovery URL falls back to pass-through accept (offline-dev fallback in
 *   {@link verifyJwtViaDiscovery}).
 *
 * Exported so a unit test can drive the gate without the full Docker pipeline.
 */
export async function resolveInboundAuthorization(
  resolved: ResolvedAgentCoreRuntime,
  options: { bearerToken?: string; verifyAuth: boolean }
): Promise<string | undefined> {
  const logger = getLogger();
  const authorizer = resolved.jwtAuthorizer;
  const header = options.bearerToken ? `Bearer ${options.bearerToken}` : undefined;

  if (!authorizer) return header;

  if (options.verifyAuth === false) {
    logger.warn(
      `Runtime '${resolved.logicalId}' declares a customJwtAuthorizer, but --no-verify-auth was set — ` +
        `skipping inbound JWT verification (local-dev escape hatch).`
    );
    return header;
  }

  if (!header) {
    throw new CdkdError(
      `Runtime ${quotedOrDescribed(resolved.logicalId, 'logical id')} requires an inbound JWT (customJwtAuthorizer). ` +
        `Pass --bearer-token '<jwt>', or --no-verify-auth to skip verification for local dev.`,
      'LOCAL_INVOKE_AGENTCORE_AUTH_REQUIRED'
    );
  }

  const result = await verifyJwtViaDiscovery(
    {
      discoveryUrl: authorizer.discoveryUrl,
      ...(authorizer.allowedAudience && { allowedAudience: authorizer.allowedAudience }),
      ...(authorizer.allowedClients && { allowedClients: authorizer.allowedClients }),
      ...(authorizer.allowedScopes && { allowedScopes: authorizer.allowedScopes }),
      ...(authorizer.customClaims && { customClaims: authorizer.customClaims }),
    },
    header,
    createJwksCache(),
    // cdk-local #252: per-time-window warn dedup (URL -> last-warned epoch ms).
    { warnedAt: new Map<string, number>() }
  );
  if (!result.allow) {
    throw new CdkdError(
      `Inbound JWT rejected by the runtime's customJwtAuthorizer ` +
        `(signature / issuer / expiry / audience check failed against ${authorizer.discoveryUrl}).`,
      'LOCAL_INVOKE_AGENTCORE_AUTH_DENIED'
    );
  }
  logger.info(`Inbound JWT verified against ${authorizer.discoveryUrl}.`);
  return header;
}

/**
 * Compute the SigV4 headers for the `/invocations` POST when `--sigv4` is
 * requested. Returns `undefined` (no header overlay) when:
 *
 * - `--sigv4` is not set,
 * - the runtime declares a `customJwtAuthorizer` (the JWT path wins; warns),
 *
 * Throws a {@link CdkdError} when `--sigv4` conflicts with
 * `--bearer-token`, or when no AWS credentials are resolvable for signing.
 *
 * Exported so a unit test can drive the gate without the full Docker pipeline.
 */
export async function buildSigV4HeadersIfRequested(
  options: LocalInvokeAgentCoreOptions,
  resolved: ResolvedAgentCoreRuntime,
  loaded: LocalStateRecord | undefined,
  host: string,
  port: number,
  event: unknown,
  sessionId: string
): Promise<Record<string, string> | undefined> {
  if (!options.sigv4) return undefined;
  if (options.bearerToken) {
    throw new CdkdError(
      `--sigv4 and --bearer-token are mutually exclusive: pick one inbound auth.`,
      'LOCAL_INVOKE_AGENTCORE_AUTH_CONFLICT'
    );
  }
  if (resolved.jwtAuthorizer) {
    getLogger().warn(
      `Runtime '${resolved.logicalId}' declares a customJwtAuthorizer; --sigv4 ignored (JWT path takes precedence).`
    );
    return undefined;
  }
  const region = canonicalizeRegion(
    options.region ??
      options.stackRegion ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      resolved.stack.region
  );
  if (!region) {
    throw new CdkdError(
      `--sigv4: no region resolved for the AgentCore signing scope. ` +
        `Pass --region '<region>', set AWS_REGION, or use --from-cfn-stack with a region-bound stack.`,
      'LOCAL_INVOKE_AGENTCORE_SIGV4_NO_REGION'
    );
  }
  const credentials = await resolveHostCredentialsForSigV4(options, resolved, loaded, region);
  const signed = await signAgentCoreInvocation({
    credentials,
    region,
    host,
    port,
    path: '/invocations',
    body: JSON.stringify(event ?? {}),
    sessionId,
  });
  const headers: Record<string, string> = {
    Authorization: signed.authorization,
    'X-Amz-Date': signed.amzDate,
    'X-Amz-Content-Sha256': signed.amzContentSha256,
  };
  if (signed.amzSecurityToken) headers['X-Amz-Security-Token'] = signed.amzSecurityToken;
  getLogger().info(`Signed /invocations with SigV4 (region=${region}).`);
  return headers;
}

/**
 * The `--sigv4` refusal, as a pure function of the two facts that decide its
 * wording (issue [#3250](https://github.com/go-to-k/cdkd/issues/3250) item 5).
 *
 * NAMING THE EXCLUSION. On a `--role-arn` run over a caller with no static
 * triple, `AWS_ACCESS_KEY_ID` IS set in this process — cdkd set it, to the
 * role — so "set AWS_ACCESS_KEY_ID" alone reads as a bug report about cdkd
 * rather than as the refusal it is. The message has to say which value it
 * declines and why.
 *
 * THE REMEDY ORDER DIFFERS PER BRANCH, deliberately. The assumed-role branch
 * fires precisely when the caller has no static pair BY DESIGN — SSO, an
 * instance role, a container role — so leading with "mint an access key pair"
 * tells the one user who should not do that to do it first. The role-less
 * branch is the opposite: there the pair genuinely is the simplest answer.
 * `--profile` is dropped from either list when one was already passed and did
 * not produce a usable pair — the same already-followed-advice defect, one arm
 * over.
 *
 * PURE, and separate from its caller, for a reason the caller cannot give: the
 * `--profile` arm of {@link resolveHostCredentialsForSigV4} transacts with AWS,
 * so the unit suite's network fence refuses every route that reaches this throw
 * with `options.profile` set. As a helper, all four combinations are testable
 * with no network at all.
 */
export function sigv4NoCredentialsRefusal(args: {
  assumedRolePublished: boolean;
  profileAlreadyPassed: boolean;
}): CdkdError {
  const exportPair = `set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in your shell before running cdkd (the snapshot cdkd puts back is taken before it assumes the role, so exporting them afterwards is too late)`;
  const profileRemedy = args.profileAlreadyPassed ? '' : `pass --profile '<name>', `;
  // cdkd-profile-display: `profileRemedy` is a LITERAL, not the user's value --
  // either the empty string or the fixed advice `pass --profile '<name>', `, in
  // which `<name>` is a placeholder the reader substitutes. This function takes
  // two booleans and nothing else, so no argv can reach either interpolation
  // below. Its doc comment above says why it is PURE, which is the same fact.
  return new CdkdError(
    args.assumedRolePublished
      ? `--sigv4: no AWS credentials available to sign the request as YOU. ` +
          `AWS_ACCESS_KEY_ID is set in this process, but cdkd set it: it holds the --role-arn ` +
          `assumed role, and this signature is what the emulated agent sees as its INVOKER, so ` +
          `cdkd deliberately will not sign as that role. Your own credentials carried no static ` +
          `triple before the assume — an SSO / IAM Identity Center, EC2 instance or ECS ` +
          `container chain, or a profile you exported rather than passed — so there is nothing ` +
          `to put back. To fix: ${profileRemedy}pass --assume-role '<arn>', or ${exportPair}.`
      : `--sigv4: no AWS credentials available to sign the request. To fix: ` +
          `${exportPair}, ${profileRemedy}or pass --assume-role '<arn>'.`,
    'LOCAL_INVOKE_AGENTCORE_SIGV4_NO_CREDENTIALS'
  );
}

/**
 * Resolve credentials for host-side SigV4 signing. Precedence:
 *   1. `--assume-role` → STS temp creds (warn + fall through on STS failure);
 *   2. `--profile` → profile creds (sessionToken when the profile carries one);
 *   3. shell env (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / optional
 *      `AWS_SESSION_TOKEN`).
 *
 * Throws a {@link CdkdError} when none are available — `--sigv4` cannot
 * proceed without credentials, unlike the unsigned path.
 *
 * EXPORTED as a test seam, like the pure helpers this file already exports. It
 * is the only `reads-caller` site the env-channel fence
 * (`tests/unit/local/local-surface-env-identity.test.ts`) knows about, and that
 * fence sees the SITE, not the BEHAVIOUR — it cannot tell
 * `callerEnvCredentials()` from a `process.env` read that happens to compile.
 * What this function decides is who the emulated agent sees as its INVOKER, so
 * the arm that matters is not reachable from any other entry point: the command
 * handler builds a container around it. Kept in ONE block with the precedence
 * contract above deliberately — as two, a reader or a tool taking only the
 * adjacent block gets the seam rationale and loses the precedence.
 */
export async function resolveHostCredentialsForSigV4(
  options: LocalInvokeAgentCoreOptions,
  resolved: ResolvedAgentCoreRuntime,
  loaded: LocalStateRecord | undefined,
  region: string
): Promise<SigV4Credentials> {
  const logger = getLogger();
  const assumeRoleArn = resolveAssumeRoleArn(options, resolved, loaded);
  if (assumeRoleArn) {
    try {
      return await assumeAgentCoreExecutionRole(assumeRoleArn, region);
    } catch (err) {
      logger.warn(
        assumeRoleFallbackWarning({
          assumeRoleArn,
          purpose: '--sigv4 signing',
          error: err,
          profile: options.profile,
          fallbackWithoutProfile: 'shell credentials',
        })
      );
    }
  }
  if (options.profile) {
    const creds = await resolveProfileCredentials(options.profile);
    if (creds?.accessKeyId && creds.secretAccessKey) {
      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken && { sessionToken: creds.sessionToken }),
      };
    }
  }
  // Issue #3130: the CALLER's own shell credentials, not whatever
  // `applyRoleArnIfSet` left in `process.env`. `--role-arn` overwrites the
  // triple with cdkd's deploy role, and this signature is what the emulated
  // agent sees as its INVOKER — so reading the environment directly signed
  // `/invocations` as the deploy role on a `--sigv4` run that named no
  // `--profile`. When the caller had no static credentials, this is `undefined`
  // and the refusal below fires, naming the three ways to supply one.
  const shellCredentials = callerEnvCredentials();
  if (shellCredentials) {
    return {
      accessKeyId: shellCredentials.accessKeyId,
      secretAccessKey: shellCredentials.secretAccessKey,
      ...(shellCredentials.sessionToken && { sessionToken: shellCredentials.sessionToken }),
    };
  }
  throw sigv4NoCredentialsRefusal({
    assumedRolePublished: envCredentialsAreAssumedRole(),
    profileAlreadyPassed: options.profile !== undefined,
  });
}
