/**
 * Shim: re-exports cdk-local's `start-api` authorizer detection +
 * identity-source parsing — `attachAuthorizers` walks discovered routes and
 * attaches the resolved authorizer descriptor (Lambda TOKEN / REQUEST,
 * Cognito User Pool / JWT, REST v1 + Function URL AWS_IAM SigV4) to each.
 * The implementation lives in cdk-local and cdkd consumes it verbatim
 * instead of carrying a byte-identical copy. See cdk-local's
 * `src/local/authorizer-resolver.ts`.
 */
export { attachAuthorizers, type AuthorizerInfo, type RouteWithAuth } from 'cdk-local';
