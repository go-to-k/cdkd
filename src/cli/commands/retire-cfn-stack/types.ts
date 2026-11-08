import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import {
  CFN_TEMPLATE_BODY_LIMIT,
  CFN_TEMPLATE_URL_LIMIT,
  type CfnUploadS3ClientOpts,
} from '../../upload-cfn-template.js';

/**
 * Resource type for a CloudFormation nested-stack child. Hoisted as a
 * constant so the recursive walker, the Retain-injection skip rule, and
 * the import-side short-circuit all reference the same literal — a typo
 * in any one of them would otherwise silently break nested-stack support
 * (the offending row would either be missed by the tree walk or have
 * Retain injected on it, both of which would orphan the child stack
 * record on AWS at retire time).
 */
export const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';

/**
 * Recursive tree of CloudFormation resources rooted at a parent stack.
 *
 * Built once per `cdkd import --migrate-from-cloudformation` invocation
 * (and used by both the per-child state-write walk in `importCommand` and the
 * recursive Retain-injection in `prepareCloudFormationStackRetirement`), so an
 * arbitrarily-deep nesting only costs one `DescribeStackResources` round-trip
 * per stack instead of repeating the walk per consumer.
 *
 * Each node's `resources` map is the flat `logicalId → physicalId` view of
 * the stack's own directly-owned resources (including nested-stack rows,
 * whose `physicalId` is the child stack ARN). The matching child tree
 * node lives under `nested[<logicalId>]` — separated so consumers can
 * walk the tree shape without re-classifying types.
 */
export interface CfnStackResourceTree {
  /**
   * Stack name as accepted by every CloudFormation API call (`StackName`).
   * For the root: the user-supplied stack name. For nested children: the
   * child stack's full ARN returned as `PhysicalResourceId` by AWS —
   * AWS accepts ARN, stack name, or stack ID interchangeably for the
   * `StackName` argument, and the ARN is the only identifier we have that
   * disambiguates a child stack with a colliding short name elsewhere.
   */
  stackName: string;
  /**
   * Same as `stackName` for the root; the child stack ARN for nested
   * children. Kept as a separate field so callers that want to surface
   * the human-readable name (extracted from the ARN's `stack/<name>/<uuid>`
   * segment) vs. the API-accepted identifier can do so without re-parsing.
   */
  physicalId: string;
  /**
   * `logicalId → physicalId` for every resource directly owned by this
   * stack. Includes nested-stack rows (whose `physicalId` is the child
   * stack ARN) so the flat-map view stays a faithful representation of
   * what AWS returned.
   */
  resources: Map<string, string>;
  /**
   * `childLogicalId → child tree node` for every nested-stack resource
   * directly under this stack. Empty when the stack has no nested children.
   * Recursion happens here — each child node carries its own `resources`
   * + `nested` populated by the same walker.
   */
  nested: Map<string, CfnStackResourceTree>;
}

/**
 * UpdateStack TemplateBody hard limit (51,200 bytes). Templates larger than
 * this are uploaded to cdkd's state S3 bucket and submitted via `TemplateURL`
 * instead — see `uploadTemplateForUpdateStack`.
 *
 * Re-exported from `upload-cfn-template.ts` as the shared source of truth.
 */
export const TEMPLATE_BODY_LIMIT = CFN_TEMPLATE_BODY_LIMIT;

/**
 * UpdateStack TemplateURL hard limit (1 MB / 1,048,576 bytes). Templates
 * larger than this cannot be submitted at all and require manual
 * intervention.
 */
export const TEMPLATE_URL_LIMIT = CFN_TEMPLATE_URL_LIMIT;

export interface RetireCloudFormationStackOptions {
  cfnStackName: string;
  cfnClient: CloudFormationClient;
  /** Skip the interactive confirmation prompt (CDK CLI parity for `-y` / `--yes`). */
  yes: boolean;
  /**
   * cdkd state bucket — reused as transient template storage when the
   * Retain-injected template exceeds the inline `TemplateBody` limit
   * (51,200 bytes). The object is deleted in a `finally` immediately after
   * `UpdateStack` completes, success or failure.
   *
   * The state bucket is preferred over a dedicated temporary bucket
   * (delstack-style) because (1) cdkd already manages it, so no
   * `CreateBucket` / `DeleteBucket` round-trips, no per-account bucket-count
   * pressure, and (2) the import command's IAM principal already has write
   * access to it.
   */
  stateBucket: string;
  /**
   * AWS auth context used to build a region-correct S3 client for the
   * upload + delete. Pass through the same `{profile, credentials}` the
   * import command resolved at startup so the upload uses the same identity
   * that writes cdkd state.
   */
  s3ClientOpts?: CfnUploadS3ClientOpts;
  /**
   * Pre-built recursive resource tree for the stack being retired. When
   * supplied, the retire flow walks every nested child's template and
   * injects `DeletionPolicy: Retain` on each child's leaf resources too —
   * load-bearing for the `cdkd import --migrate-from-cloudformation`
   * recursive flow (issue [#464](https://github.com/go-to-k/cdkd/issues/464)),
   * since AWS CFn's `DeleteStack` cascades into every nested child and
   * any child resource without Retain would be deleted as a side effect
   * of retiring the parent.
   *
   * When omitted, the retire flow builds the tree lazily via
   * `getCloudFormationResourceTree` on first need — adding at most one
   * `DescribeStackResources` round-trip per nesting level, and zero overhead
   * for the non-nested case. `cdkd import`'s migration path always supplies
   * the tree, so since `cdkd migrate` was removed (issue #2572) the lazy arm
   * has no in-repo caller; it is kept because `resourceTree` is optional in
   * this helper's contract and omitting it must stay correct.
   *
   * The tree's root `stackName` must match `cfnStackName`; otherwise the
   * retire flow throws an invariant error before any AWS mutation runs.
   */
  resourceTree?: CfnStackResourceTree;
}

/**
 * What `prepareCloudFormationStackRetirement` left behind.
 *
 * - `cancelled`: the operator declined; the stack is untouched and must not be
 *   deleted.
 * - `ready`: every resource now carries `DeletionPolicy: Retain`, so
 *   `deleteRetiredCloudFormationStack` may run. `templateUpdated` says
 *   whether an `UpdateStack` actually completed — only then can CloudFormation
 *   have REPLACED a resource, so only then must the caller re-read the
 *   physical ids before it writes state (issue #4873).
 */
export type CloudFormationRetirementPreparation =
  | { outcome: 'cancelled' }
  | { outcome: 'ready'; templateUpdated: boolean };
