/**
 * Values shared by `agentcore-runtime-provider.ts` and its companion files
 * (go-to-k/cdkd#5835).
 */

/**
 * The members whose VALUE is a user-keyed string map, so the case flip must
 * stop at the member name: its keys are tag keys / scope names, not shape
 * fields (issue #5433 — a `ManagedVpcResource.Tags` key `Env` went out as
 * `env`). Listed by name rather than derived from the schema: the cdkd
 * schema digest does not tell a map apart from an unexpanded struct, and the
 * names below are maps wherever they occur in the Runtime shapes.
 * `Tags`: `AuthorizerConfiguration.CustomJWTAuthorizer.PrivateEndpoint` and
 * `.PrivateEndpointOverrides[].PrivateEndpoint` `ManagedVpcResource.Tags`.
 * `AdvertisedScopeMapping`: `CustomJWTAuthorizer` in the SDK shape (not yet
 * in the CFn schema, but `GetAgentRuntime` returns it). `EnvironmentVariables`
 * is a top-level map passed through verbatim, never converted.
 */
export const CFN_MAP_KEYS: ReadonlySet<string> = new Set(['Tags', 'AdvertisedScopeMapping']);
export const SDK_MAP_KEYS: ReadonlySet<string> = new Set(['tags', 'advertisedScopeMapping']);

/** `aws:`-prefixed keys are reserved: AWS refuses a user's attempt to set or remove them. */
export function isUserTagKey(key: string): boolean {
  return !key.startsWith('aws:');
}
