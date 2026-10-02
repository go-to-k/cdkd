/**
 * Pre-flight validation for `--recreate-via-cc-api <LogicalId>` deploy
 * flag (issue [#615]).
 *
 * Three things to validate before the deploy engine acts on the user's
 * recreate list:
 *
 *   1. Every named logical id MUST exist in the synth template. A typo
 *      should fail fast, not silently skip.
 *   2. Every named logical id MUST exist in cdkd state (the recreate
 *      operation requires an existing physical resource to destroy +
 *      recreate). A logical id in the template but absent from state
 *      is a CREATE on the next deploy regardless — recreate is a
 *      no-op for fresh deploys and should error out with a clear
 *      message rather than silently apply.
 *   3. Stateful-resource guard: every named target whose resource type
 *      is in {@link STATEFUL_TYPES} (or conditionally stateful — an S3
 *      bucket holding objects, a LogGroup with retention or with log
 *      streams) MUST be matched by an explicit
 *      `--force-stateful-recreation` flag. The sync first-cut runs from
 *      the recorded properties alone; the live probes promote a `null`
 *      reason afterwards — `s3:ListObjectVersions` to `'has-objects'`
 *      when a bucket actually contains data (issue [#648]), and
 *      `logs:DescribeLogStreams` to `'has-log-events'` when a log group
 *      is not provably empty (issue [#2558]).
 *   4. Multi-region refusal: every named target whose resource type
 *      is in `MULTI_REGION_RECREATE_BLOCKED_TYPES` (`validate.ts`) (e.g.
 *      `AWS::DynamoDB::GlobalTable`) is refused outright. Out of
 *      scope for v1; no `--force-stateful-recreation` bypass since
 *      this is a structural limitation, not a data-loss footgun.
 *
 * Plus one cross-flag invariant: `--recreate-via-cc-api MyApi`
 * combined with `--prefer-sdk-route AWS::ApiGatewayV2::Api:Body`
 * on a resource whose template carries `Body` is **ambiguous
 * intent** — does the user want SDK + silent drop, or CC migration?
 * Fail fast and let the user pick one strategy per resource.
 *
 * This module is a barrel: the implementation lives in `recreate-targets/*.ts`
 * (issue #4466), and it re-exports exactly the names it always exported,
 * so no importer changes.
 */
export {
  type RecreateTarget,
  type AmbiguousIntentOverlap,
  type RecreateTargetsValidation,
  validateRecreateTargets,
} from './recreate-targets/validate.js';
export { renderRecreateTargetsErrors } from './recreate-targets/render.js';
export {
  type StatefulProbeClients,
  probeStatefulRecreateTargetsAsync,
  probeAndRevalidateStateful,
} from './recreate-targets/probe.js';
