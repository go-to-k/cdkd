/**
 * The option bag Commander hands `cdkd local run-task`'s handler. Its own module
 * so the handler and the helpers that take a `Pick` of it share one declaration.
 */

export interface LocalRunTaskOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  cluster: string;
  envVars?: string;
  containerHost: string;
  /**
   * Commander's `[<arg>]` syntax maps to `string | boolean` here:
   *   - flag absent → `undefined`
   *   - `--assume-task-role` (bare) → `true`
   *   - `--assume-task-role <arn>` → `'<arn>'`
   * The runner branches on `typeof options.assumeTaskRole`.
   */
  assumeTaskRole?: string | boolean;
  pull: boolean;
  /**
   * Optional role ARN passed to `pullEcrImage` for cross-account /
   * centralized registry pulls (#455). Issues `sts:AssumeRole` via the
   * default credential chain and uses the resulting temp credentials to
   * authenticate against the target ECR repository. A same-account pull in
   * ANY region does not need this flag — `pullEcrImage` builds its ECR client
   * for the image URI's own region, so crossing a region costs nothing extra
   * (issue #2536). Mirrors `cdkd local invoke --ecr-role-arn`.
   */
  ecrRoleArn?: string;
  platform?: string;
  keepRunning: boolean;
  detach: boolean;
  /**
   * Issue #264: read cdkd's S3 state for the target stack so the resolver
   * can substitute `Fn::Sub` placeholders that reference a same-stack
   * `AWS::ECR::Repository`. Tier 1 (pseudo parameters only) does NOT need
   * this flag — STS GetCallerIdentity + the resolved region cover those.
   * Off by default.
   */
  fromState: boolean;
  /**
   * Issue #606: alternative state source. Reads physical IDs from a
   * deployed CloudFormation stack via `ListStackResources` instead
   * of cdkd's S3 state. Mutually exclusive with `--from-state`.
   */
  fromCfnStack?: string | boolean;
  stateBucket?: string;
  statePrefix: string;
  /**
   * Region of the state record to read. Required for `--from-state` when
   * the same stack name has state in multiple regions; reused as the
   * CFn client region for `--from-cfn-stack`. Mirrors `cdkd local
   * invoke --stack-region`.
   */
  stackRegion?: string;
  /**
   * The user's UNFOLDED `--stack-region` spelling, captured at handler entry
   * before the fold above it (issue #1836 round 3). Consumed by exactly TWO
   * things in `local-state-loader.ts`, both of which need a spelling the fold
   * has destroyed: the state-record match in `loadStateForStack`, which resolves
   * an exactly-spelled region in preference to a case-variant record, and the
   * raw marker-key fallback probe in `loadBootstrapContainerRepo`, which this
   * file feeds from `options.rawStackRegion` further down (the `cdkd bootstrap`
   * WRITE side does not fold, so a canonical-only read would miss the
   * `cdkd-bootstrap/{RAW}.json` key an upper-cased bootstrap wrote). It never
   * reaches an SDK client or an endpoint. This differs from the three sibling
   * commands' copies of this comment, which say ONLY the record match: they do
   * not call `loadBootstrapContainerRepo` at all.
   */
  rawStackRegion?: string;
  /**
   * The user's UNFOLDED `AWS_REGION` (falling back to `AWS_DEFAULT_REGION`),
   * captured at handler entry BEFORE `foldRegionOption` rewrites both env vars
   * (issue #3622). Consumed only by the raw marker-key fallback probe in
   * `loadBootstrapContainerRepo`, for the same reason as `rawStackRegion`: a
   * pre-fold `AWS_REGION=US-EAST-1 cdkd bootstrap` wrote
   * `cdkd-bootstrap/US-EAST-1.json`. It never reaches an SDK client.
   */
  rawEnvRegion?: string;
  /**
   * The `--image-override` flag family, registered by cdk-local's
   * `addImageOverrideOptions` exactly as on `start-service` / `start-alb`
   * (go-to-k/cdkd#5768). The task definition's representative container is
   * rebuilt from a local Dockerfile when its image is a deployed-registry pin
   * (ECR, public, or a same-stack ECR repository with no state); see
   * {@link resolveRunTaskImageOverride}.
   */
  imageOverride?: string[];
  imageBuildArg?: string[];
  imageBuildSecret?: string[];
  imageTarget?: string | string[];
  imageContext?: string | string[];
  /** `false` under `--no-interactive-overrides`. */
  interactiveOverrides?: boolean;
  strictOverrides?: boolean;
}
