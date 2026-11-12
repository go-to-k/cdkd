export interface LocalInvokeAgentCoreOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  /** `--aws-emulator [url]`: `true` for the bare flag (go-to-k/cdkd#6132). */
  awsEmulator?: string | boolean;
  /** `--ca-bundle <file>`: mounted into every workload container (go-to-k/cdkd#6131). */
  caBundle?: string;
  roleArn?: string;
  context?: string[];
  event?: string;
  eventStdin?: boolean;
  envVars?: string;
  pull: boolean;
  build: boolean;
  containerHost: string;
  /** `--platform <linux/amd64|linux/arm64>`. Defaults to AgentCore's required arm64. */
  platform: string;
  /**
   * `--ws`: use the HTTP-protocol agent's bidirectional `/ws` WebSocket
   * endpoint (on 8080) instead of `POST /invocations` — send `--event` as the
   * first frame and stream received frames to stdout until the agent closes.
   *
   * When stdin is a TTY (interactive terminal), additionally read stdin lines
   * as follow-up text frames (one frame per line, trailing newline stripped)
   * until stdin EOFs (Ctrl-D) or the agent closes the connection. This
   * matches the deployed `/ws` endpoint's bidirectional shape: a TTY user
   * gets a multi-turn REPL session by default. When stdin is NOT a TTY (piped
   * / redirected / CI), only the initial `--event` frame is sent and the
   * client only receives — the standard one-shot script-friendly shape.
   * Force one-shot in a TTY with `cdkd ... --ws </dev/null`.
   */
  ws?: boolean;
  /** Session id forwarded via the AgentCore session-id header (auto-generated when omitted). */
  sessionId?: string;
  /**
   * Bearer JWT to present when the runtime declares a `customJwtAuthorizer`.
   * Verified against the runtime's OIDC discovery URL before the container
   * starts, then forwarded to `/invocations` as `Authorization: Bearer <jwt>`.
   */
  bearerToken?: string;
  /**
   * Commander maps `--no-verify-auth` to `verifyAuth: boolean` (default
   * `true`). When `false`, skip inbound JWT verification entirely (local-dev
   * escape hatch) — the token, if any, is still forwarded.
   */
  verifyAuth: boolean;
  /**
   * `--sigv4`: sign the `/invocations` POST with AWS SigV4 (service
   * `bedrock-agentcore`) using the resolved credentials — matching the
   * cloud's default IAM-auth behavior when the runtime declares no
   * `customJwtAuthorizer`. The local agent receives the same `Authorization:
   * AWS4-HMAC-SHA256 ...` + `X-Amz-Date` / `X-Amz-Content-Sha256` /
   * `X-Amz-Security-Token` headers it would in the cloud. Opt-in: default
   * unsigned (preserves existing behavior). Mutually exclusive with
   * `--bearer-token` and ignored on a JWT-protected runtime.
   */
  sigv4?: boolean;
  /**
   * Optional execution role to assume before invoking. Commander's `[arn]`
   * maps to `string | boolean`:
   *   - absent → `undefined` (dev creds pass through; SAM-compatible default)
   *   - `--assume-role` (bare) → `true` (use the runtime's literal RoleArn)
   *   - `--assume-role <arn>` → `'<arn>'`
   *   - `--no-assume-role` → `false`
   */
  assumeRole?: string | boolean;
  /** Role ARN to assume before authenticating against ECR for the container image pull. */
  ecrRoleArn?: string;
  /** `--from-state` — load cdkd's S3 state for the target stack. */
  fromState: boolean;
  /** S3 bucket for `--from-state`. Falls back to CDKD_STATE_BUCKET / cdk.json. */
  stateBucket?: string;
  /** S3 key prefix for `--from-state` (commander always supplies the default). */
  statePrefix: string;
  /** `--from-cfn-stack` — read a deployed CFn stack via ListStackResources. */
  fromCfnStack?: string | boolean;
  /** `--stack-region` — region of the state record / CFn client (issue #606). */
  stackRegion?: string;
  /**
   * The user's UNFOLDED `--stack-region` spelling, captured at handler entry
   * before the fold above it (issue #1836 round 3). Consumed ONLY by the
   * state-record match in `local-state-loader.ts`, which resolves an
   * exactly-spelled region in preference to a case-variant record — a rule the
   * folded value cannot express. Never reaches an SDK client or an endpoint.
   */
  rawStackRegion?: string;
  /**
   * Per-request timeout in milliseconds, applied to the HTTP `/invocations`
   * POST, the MCP `POST /mcp` request, and the `/ws` open-to-close window.
   * Default 120000 (120s). Raise this for long-running agent calls that
   * exceed the default — the cloud's AgentCore quota goes well above 120s.
   */
  timeout: number;
  /**
   * `--watch` (follows cdk-local #270): re-synth + reload the agent container
   * on CDK source edits. Supported on the HTTP / AGUI protocols — both the
   * `--ws` session path AND the default one-shot `POST /invocations` (the
   * reload re-runs the one shot). An interpreted-language source edit inside a
   * CodeConfiguration source tree takes a soft-reload FAST PATH (`docker cp` +
   * `docker restart`); Dockerfile / compiled-source / asset-hash-changed /
   * ambiguous edits force a full rebuild. For MCP / A2A runtimes `--watch` is a
   * no-op WARN and the single shot proceeds.
   */
  watch?: boolean;
}
