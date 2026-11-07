export interface LocalInvokeOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  event?: string;
  eventStdin?: boolean;
  envVars?: string;
  /**
   * Commander maps `--no-pull` to `pull: boolean` (default `true`). When
   * the user passes `--no-pull` the value flips to `false` and we skip
   * `docker pull`. Naming-wise `pull` reads as "should pull" so the
   * skip-when-false logic stays the right way around.
   */
  pull: boolean;
  /**
   * Commander maps `--no-build` to `build: boolean` (default `true`).
   * When the user passes `--no-build` the value flips to `false` and we
   * skip `docker build` on the IMAGE local-build path, requiring the
   * previously-built deterministic tag to already be in the local
   * registry. No-op for ZIP Lambdas and the IMAGE ECR-pull path
   * (matches `--no-pull`'s per-path behavior). Closes #233.
   */
  build: boolean;
  debugPort?: string;
  containerHost: string;
  /**
   * Optional Lambda execution role to assume before invoking. When set,
   * cdkd calls `sts:AssumeRole` against the resolved ARN and forwards
   * the resulting temporary credentials into the container so the
   * handler runs under the deployed function's narrow permissions
   * (instead of the developer's typically-admin shell credentials).
   *
   * Commander's `[arn]` syntax maps to `string | boolean` here:
   *   - flag absent → `undefined` (pass dev creds through; SAM-compatible default)
   *   - `--assume-role` (bare) → `true` (auto-resolve from state; requires `--from-state`)
   *   - `--assume-role <arn>` → `'<arn>'` (explicit ARN; precedence wins)
   *   - `--no-assume-role` → `false` (explicit opt-out; forces dev creds even with `--from-state`)
   *
   * Auto-resolve walks the function's `Properties.Role` in cdkd state
   * (`Fn::GetAtt: [<RoleId>, 'Arn']` is resolved against the sibling
   * IAM Role resource's `attributes.Arn`; literal ARNs pass through).
   * STS failures degrade to a warn + dev-creds fallback — this is a
   * developer-loop tool, not a security boundary.
   */
  assumeRole?: string | boolean;
  /**
   * Issue #448: explicit role to `sts:AssumeRole` into before calling
   * `lambda:GetLayerVersion` for every literal-ARN entry in a Lambda's
   * `Properties.Layers`. Required only when the dev's default
   * credentials cannot read the layer — typically cross-account layers
   * (AWS-published `public` layers like Lambda Powertools are readable
   * from every account and need no role).
   *
   * Independent of `--assume-role`: that flag scopes the Lambda
   * handler's runtime AWS calls, this flag scopes only the layer-fetch
   * step. Carrying it on a separate switch keeps the cross-account
   * layer use case decoupled from the rest of the credential plumbing.
   */
  layerRoleArn?: string;
  /**
   * Optional role ARN passed to `pullEcrImage` when the IMAGE ECR-pull
   * path fires (no matching cdk.out asset and `Code.ImageUri` is an ECR
   * URI). Used to authenticate against a centralized / cross-account
   * registry whose `ecr:GetAuthorizationToken` permission is granted to
   * the assumed role rather than the developer's identity. Closes #455.
   * When omitted, cdkd uses the default credential chain (which is
   * sufficient for same-account pulls AND for cross-account pulls when
   * the ECR repository's resource policy grants the caller directly).
   */
  ecrRoleArn?: string;
  /**
   * PR 2: when set, cdkd reads its S3 state for the target stack and
   * substitutes intrinsic-valued env vars (`Ref` / `Fn::GetAtt` /
   * `Fn::Sub`) with the deployed physical IDs / attributes. Closes the
   * "intrinsic-valued env vars are dropped" gap that PR 1 left
   * explicit. Off by default — PR 1 behavior is preserved when the
   * flag is not set.
   */
  fromState: boolean;
  /**
   * Issue #606: alternative state source for CDK apps deployed via the
   * upstream CDK CLI (`cdk deploy` → CloudFormation). Reads the named
   * CFn stack via `ListStackResources` to populate physical IDs.
   * Mutually exclusive with `--from-state`. Commander maps:
   *   - flag absent → `undefined`
   *   - `--from-cfn-stack` (bare) → `true` (use the cdkd stack name)
   *   - `--from-cfn-stack <name>` → `'<name>'`
   */
  fromCfnStack?: string | boolean;
  stateBucket?: string;
  statePrefix: string;
  /**
   * Region of the state record to read. Required when the same stack
   * name has state in multiple regions. Mirrors `cdkd state show
   * --stack-region`. Also drives the CFn client's region when
   * `--from-cfn-stack` is set (issue #606 — no separate
   * `--cfn-stack-region` flag).
   */
  stackRegion?: string;
  /**
   * The user's UNFOLDED `--stack-region` spelling, captured at handler entry
   * before the fold above it (issue #1836 round 3). Consumed ONLY by the
   * state-record match in `local-state-loader.ts`, which resolves an
   * exactly-spelled region in preference to a case-variant record — a rule the
   * folded value cannot express. Never reaches an SDK client or an endpoint.
   */
  rawStackRegion?: string;
}
