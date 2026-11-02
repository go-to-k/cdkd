/**
 * SDK attempts for an IAM call. IAM allows few control-plane calls per second
 * per account, so a large app deploying many stacks in parallel that create
 * many roles, or several deploys to one account at the same time, get
 * `Throttling` on `AttachRolePolicy`, `PutRolePolicy` and `DeleteRole`. At the
 * SDK default of 3 attempts a throttled wiring call fails the role's create,
 * and a throttled cleanup leaves the role behind, which the create's replay
 * then collides with (`EntityAlreadyExists`). A throttle clears within seconds;
 * the SDK's backoff for it is exponential from 500 ms, capped at 20 s, with full
 * jitter (a random wait between 0 and that bound).
 *
 * More attempts lower the odds, they do not remove the leftover: the SDK's retry
 * quota is per client (500 tokens, 5 per retry, as `apigateway-pacing.ts` notes),
 * so one client absorbs only about 100 retries before a throttled call fails at
 * once, whatever its attempts.
 */
export const IAM_MAX_ATTEMPTS = 8;
