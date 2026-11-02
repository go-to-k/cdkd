/**
 * SDK attempts for an IAM call. IAM allows few control-plane calls per second
 * per account, so a large app deploying many stacks in parallel that create
 * many roles, or several deploys to one account at the same time, get
 * `Throttling` on `AttachRolePolicy`, `PutRolePolicy` and `DeleteRole`. At the
 * SDK default of 3 attempts a throttled wiring call fails the role's create,
 * and a throttled cleanup leaves the role behind, which the create's replay
 * then collides with (`EntityAlreadyExists`). A throttle clears within seconds;
 * the SDK's backoff for it is exponential from 500 ms, capped at 20 s.
 */
export const IAM_MAX_ATTEMPTS = 8;
