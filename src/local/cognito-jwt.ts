/**
 * Shim: re-exports cdk-local's Cognito User Pool / JWT authorizer support
 * for `cdkd local start-api` (verifies JWTs locally against the user pool's
 * published JWKS, with a pass-through fallback) AND for
 * `cdkd local invoke-agentcore` (verifies the inbound JWT against a discovery
 * URL when the target uses `customJwtAuthorizer`). The implementation lives in
 * cdk-local and cdkd consumes it verbatim instead of carrying a byte-identical
 * copy. See cdk-local's `src/local/cognito-jwt.ts`.
 */
export {
  createJwksCache,
  buildCognitoJwksUrl,
  buildJwksUrlFromIssuer,
  verifyCognitoJwt,
  verifyJwtAuthorizer,
  verifyJwtViaDiscovery,
  type JwksCache,
  type DiscoveryJwtAuthorizer,
  type JwtCustomClaim,
} from 'cdk-local/internal';
