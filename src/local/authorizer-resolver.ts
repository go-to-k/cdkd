/**
 * Shim: re-exports cdk-local's `start-api` authorizer detection +
 * identity-source parsing — `attachAuthorizers` walks discovered routes and
 * attaches the resolved authorizer descriptor (Lambda TOKEN / REQUEST,
 * Cognito User Pool / JWT, REST v1 + Function URL AWS_IAM SigV4) to each;
 * `resolveJwtAuthorizerIntrinsics` resolves an intrinsic auth setting from the
 * loaded state, and `warnUnenforcedRouteAuthSettings` warns per route for every
 * auth setting the local server does not enforce (go-to-k/cdkd#6717).
 * The implementation lives in cdk-local and cdkd consumes it verbatim
 * instead of carrying a byte-identical copy. See cdk-local's
 * `src/local/authorizer-resolver.ts`.
 */
export {
  attachAuthorizers,
  resolveJwtAuthorizerIntrinsics,
  warnUnenforcedRouteAuthSettings,
  type AuthorizerInfo,
  type RouteWithAuth,
} from 'cdk-local/internal';
