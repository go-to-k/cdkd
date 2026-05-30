/**
 * Shim: re-exports cdk-local's ALB front-door target resolver for
 * `cdkd local start-alb` — maps an ALB target string to a `ResolvedFrontDoor`
 * (listener-by-listener forwarded targets, listener-rule conditions, redirect /
 * fixed-response actions, plus `default_action`). The implementation lives in
 * cdk-local and cdkd consumes it verbatim instead of carrying a byte-identical
 * copy. See cdk-local's `src/local/elb-front-door-resolver.ts`.
 */
export {
  resolveAlbFrontDoor,
  isApplicationLoadBalancer,
  type ResolvedListenerAction,
  type FrontDoorForwardTarget,
} from 'cdk-local/internal';
