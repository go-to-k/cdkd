import { getLogger } from '../../../utils/logger.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import type { RouteWithAuth } from '../../../local/authorizer-resolver.js';
import { buildCognitoJwksUrl, buildJwksUrlFromIssuer } from '../../../local/cognito-jwt.js';
import { type ReachedLambda, lambdaOwners, servedLambdaKey } from './served-lambdas.js';

/**
 * Prefetch the JWKS for every Cognito / JWT authorizer attached to a
 * discovered route. Failures degrade to pass-through mode (verifier
 * surfaces a warn line on first hit); we still issue the prefetch so
 * the warn lands at startup rather than mid-request.
 */
export async function prewarmJwks(
  routesWithAuth: readonly RouteWithAuth[],
  jwksCache: import('../../../local/cognito-jwt.js').JwksCache
): Promise<void> {
  const urls = new Set<string>();
  for (const entry of routesWithAuth) {
    const auth = entry.authorizer;
    if (!auth) continue;
    if (auth.kind === 'cognito') {
      // Multi-pool federation: pre-warm JWKS for EVERY pool in
      // ProviderARNs[], so issuer-matched verification at request time
      // doesn't pay a cold-start latency on the first request to each
      // tenant's pool.
      for (const pool of auth.pools) {
        urls.add(buildCognitoJwksUrl(pool.region, pool.userPoolId));
      }
    } else if (auth.kind === 'jwt') {
      const url =
        auth.region && auth.userPoolId
          ? buildCognitoJwksUrl(auth.region, auth.userPoolId)
          : buildJwksUrlFromIssuer(auth.issuer);
      urls.add(url);
    }
  }
  await Promise.all([...urls].map((u) => jwksCache.fetchAndCache(u)));
}

/**
 * Emit a one-line warn for every VPC-config Lambda. The handler still
 * runs locally, but its container does not get attached to the AWS
 * VPC's subnets — calls to private RDS / ElastiCache will fail. cdkd
 * surfaces this so the developer can pin the unexpected behavior to
 * the VPC config rather than chasing a "connection refused" rabbit
 * hole.
 *
 * @internal exported for unit tests.
 */
export function warnVpcConfigLambdas(
  routesWithAuth: readonly RouteWithAuth[],
  stacks: readonly StackInfo[]
): void {
  const logger = getLogger();
  // Walk every route's Lambda and Lambda authorizer once, in its route's own
  // stack (#5181) -- unsupported / mockCors / service-integration routes
  // included, the set this warning has always covered.
  const warned = new Set<string>();
  const reached: ReachedLambda[] = [];
  for (const { route, authorizer: auth } of routesWithAuth) {
    reached.push({ stackName: route.apiStackName, logicalId: route.lambdaLogicalId });
    if (auth && (auth.kind === 'lambda-token' || auth.kind === 'lambda-request')) {
      reached.push({ stackName: route.apiStackName, logicalId: auth.lambdaLogicalId });
    }
  }
  for (const ref of reached) {
    const owner = lambdaOwners(ref, stacks)[0];
    if (owner === undefined) continue;
    const key = servedLambdaKey(owner.stackName, ref.logicalId);
    if (warned.has(key)) continue;
    warned.add(key);
    const props = owner.template.Resources?.[ref.logicalId]?.Properties ?? {};
    const vpcConfig = props['VpcConfig'];
    if (vpcConfig && typeof vpcConfig === 'object' && Object.keys(vpcConfig).length > 0) {
      const shown = stacks.length > 1 ? key : ref.logicalId;
      logger.warn(
        `Lambda ${shown} has VpcConfig — local container will reach external services via the host's network, NOT through the deployed VPC's NAT/private subnets. Calls to private RDS/ElastiCache will fail. See https://cdkd.dev/local-start-api/#vpc-config-lambdas for details.`
      );
    }
  }
}

/**
 * Walk the discovered routes for `AuthorizationType: 'AWS_IAM'` and emit
 * a one-line warn naming the affected routes. Returns `true` when at
 * least one IAM route is present so the caller wires the SigV4
 * credentials loader. Re-runs across hot reloads are silent — the warn
 * fires only at initial boot (matches `warnVpcConfigLambdas`'s policy).
 *
 * Implementation note: signature verification only — IAM policy
 * evaluation (resource / action / condition) is NOT emulated. See
 * `src/local/sigv4-verify.ts` and the help text in `docs/cli-reference.md`.
 */
export function warnIamRoutes(routesWithAuth: readonly RouteWithAuth[]): boolean {
  const logger = getLogger();
  const iamRoutes: string[] = [];
  for (const entry of routesWithAuth) {
    if (entry.authorizer?.kind === 'iam') {
      iamRoutes.push(entry.route.declaredAt);
    }
  }
  if (iamRoutes.length === 0) return false;
  logger.warn(
    `${iamRoutes.length} route(s) declare AuthorizationType: AWS_IAM — cdkd local start-api ` +
      `verifies SigV4 signatures against your local AWS credentials, but does NOT emulate IAM ` +
      `policy evaluation (resource / action / condition rules). Signature-verified callers reach ` +
      `the handler under their own identity; downstream authorization is the dev's responsibility. ` +
      `See https://cdkd.dev/local-start-api/#aws-iam-authorization for details.`
  );
  for (const declaredAt of iamRoutes) {
    logger.warn(`  - ${declaredAt}`);
  }
  return true;
}
