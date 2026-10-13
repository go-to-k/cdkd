import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackResourcesCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  DeleteStackCommand,
  waitUntilStackUpdateComplete,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { displaySafe, isPasteableIdent, safeMsg } from '../../utils/display-safe.js';
import { commandHole } from '../../utils/pasteable-command.js';
import { confirmOrRefuse } from './confirm-prompt.js';
import { STABLE_TERMINAL_STATUSES } from '../cfn-stack-states.js';
import {
  CFN_TEMPLATE_BODY_LIMIT,
  CFN_TEMPLATE_URL_LIMIT,
  MIGRATE_TMP_PREFIX,
  uploadCfnTemplate,
  type CfnUploadS3ClientOpts,
} from '../upload-cfn-template.js';
import {
  detectTemplateFormat,
  parseCfnTemplate,
  stringifyCfnTemplate,
  type TemplateFormat,
} from '../yaml-cfn.js';

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
 * instead — see {@link uploadTemplateForUpdateStack}.
 *
 * Re-exported from `upload-cfn-template.ts` as the shared source of truth.
 */
const TEMPLATE_BODY_LIMIT = CFN_TEMPLATE_BODY_LIMIT;

/**
 * UpdateStack TemplateURL hard limit (1 MB / 1,048,576 bytes). Templates
 * larger than this cannot be submitted at all and require manual
 * intervention.
 */
const TEMPLATE_URL_LIMIT = CFN_TEMPLATE_URL_LIMIT;

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
   * {@link getCloudFormationResourceTree} on first need — adding at most one
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
 * What {@link prepareCloudFormationStackRetirement} left behind.
 *
 * - `cancelled`: the operator declined; the stack is untouched and must not be
 *   deleted.
 * - `ready`: every resource now carries `DeletionPolicy: Retain`, so
 *   {@link deleteRetiredCloudFormationStack} may run. `templateUpdated` says
 *   whether an `UpdateStack` actually completed — only then can CloudFormation
 *   have REPLACED a resource, so only then must the caller re-read the
 *   physical ids before it writes state (issue #4873).
 */
export type CloudFormationRetirementPreparation =
  | { outcome: 'cancelled' }
  | { outcome: 'ready'; templateUpdated: boolean };

/**
 * Best-effort reaper for the transient template bodies this flow uploads to
 * the state bucket under `cdkd-migrate-tmp/`.
 *
 * ONE implementation because {@link prepareCloudFormationStackRetirement} drains from
 * four different exits — the recursive walk's `catch`, the confirmation
 * gate's decline AND its non-interactive refusal, the no-modification fast
 * path, and the post-`UpdateStack` `finally`. Each used to carry its own copy
 * of this loop, and the copies were how the refusal exit came to have none at
 * all: a `throw` from the gate passes every one of the other three.
 *
 * Best-effort by design. A leaked transient object costs pennies and lives
 * under an explicitly-named prefix, while a failed DELETE that propagated
 * would turn a successful retire into a reported failure. The retire's
 * success is governed by CloudFormation, not by S3 — so each cleanup's own
 * error becomes a `warn` naming the prefix to sweep manually.
 *
 * `what` / `when` keep the four sites' distinct wording (a caller says
 * whether these are the parent's own upload or a nested child's, and whether
 * it is unwinding); the SENTENCE they sit in is shared.
 */
async function drainTemplateUploads(
  cleanups: readonly (() => Promise<void>)[],
  stateBucket: string,
  labels: { what: string; when?: string }
): Promise<void> {
  const logger = getLogger();
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (cleanupErr) {
      const msg = describeAwsFailure(cleanupErr).detail;
      logger.warn(
        `Failed to delete ${labels.what} from '${stateBucket}'${labels.when ? ` ${labels.when}` : ''}. ` +
          `Clean up manually under prefix '${MIGRATE_TMP_PREFIX}/'. Cause: ${msg}`
      );
    }
  }
}

/**
 * Steps 1-3 of retiring a CloudFormation stack whose resources cdkd is about
 * to adopt; {@link deleteRetiredCloudFormationStack} is step 4. The procedure
 * is the one AWS recommends for handing resources between management tools
 * without deleting them:
 *
 *   1. DescribeStacks — verify the stack is in a stable terminal state and
 *      capture its existing Capabilities so the UpdateStack call doesn't
 *      strip them.
 *   2. GetTemplate (Original stage) — fetch the template the user submitted,
 *      then inject `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`
 *      on every resource that doesn't already have them.
 *   3. UpdateStack — usually a metadata-only change. We wait for completion
 *      so step 4 doesn't race it.
 *   4. DeleteStack — every resource is now Retain, so CloudFormation walks
 *      the stack and skips every resource. The stack record disappears;
 *      the underlying AWS resources are left intact for cdkd to manage.
 *
 * Step 3 is skipped when every resource already has both policies (idempotent
 * re-runs after a partial failure don't need to round-trip an UpdateStack).
 *
 * Step 3 is NOT always metadata-only: CloudFormation can decide the update
 * REPLACES a resource (an auto-named `AWS::SSM::Document`, whose `Content` it
 * re-serializes, is the observed case — issue #4873). It then repoints the
 * stack at a new physical resource. That is why the split exists: the caller
 * runs steps 1-3 BEFORE it builds cdkd state, re-reads the physical ids when
 * `templateUpdated` is true, and writes state from those — so no crash at any
 * point leaves state naming a resource CloudFormation has superseded. The
 * injected `UpdateReplacePolicy: Retain` keeps the superseded copy (and its
 * data): an update cdkd made must never delete a user's resource, so the
 * caller reports that copy instead.
 *
 * Templates over the inline 51,200-byte `TemplateBody` limit are uploaded to
 * the cdkd state bucket and submitted via `TemplateURL`; the transient
 * object is deleted in a `finally` immediately after `UpdateStack`. Only
 * templates over the 1 MB CloudFormation `TemplateURL` limit fail outright.
 *
 * Failure model: this runs before the caller writes cdkd state, so a failure
 * here leaves no record from this run to repair; the user re-runs the command
 * once the cause is fixed.
 */
export async function prepareCloudFormationStackRetirement(
  options: RetireCloudFormationStackOptions
): Promise<CloudFormationRetirementPreparation> {
  const logger = getLogger();
  const { cfnStackName, cfnClient, yes, stateBucket, s3ClientOpts, resourceTree } = options;

  if (resourceTree && resourceTree.stackName !== cfnStackName) {
    throw new Error(
      `prepareCloudFormationStackRetirement: caller-supplied resourceTree.stackName='${resourceTree.stackName}' ` +
        `does not match cfnStackName='${cfnStackName}'. The tree's root must be the stack being retired.`
    );
  }

  // ---- Step 1: validate state, capture capabilities ----
  logger.info(`[1/4] Inspecting CloudFormation stack '${cfnStackName}'...`);
  const desc = await cfnClient.send(new DescribeStacksCommand({ StackName: cfnStackName }));
  const stack = desc.Stacks?.[0];
  if (!stack) {
    throw new Error(`CloudFormation stack '${cfnStackName}' not found.`);
  }
  const status = stack.StackStatus ?? '';
  if (!STABLE_TERMINAL_STATUSES.has(status)) {
    throw new Error(
      `CloudFormation stack '${cfnStackName}' is in status '${status}', ` +
        `which is not a stable terminal state. Wait for the stack to settle ` +
        `(or roll back) before retiring it.`
    );
  }
  // Forward whatever Capabilities the stack already has so UpdateStack
  // doesn't fail with InsufficientCapabilities. CDK stacks routinely require
  // CAPABILITY_IAM / CAPABILITY_NAMED_IAM / CAPABILITY_AUTO_EXPAND.
  const capabilities = stack.Capabilities ?? [];

  // ---- Step 2: fetch + mutate template ----
  // GetTemplate up front; the resource tree is only built lazily when
  // (a) the parent template actually contains nested-stack rows AND (b)
  // the caller didn't already supply one. The lazy build adds at most
  // one `DescribeStackResources` round-trip per nesting level, and zero
  // overhead for the non-nested case. See the `resourceTree` JSDoc above for
  // why the lazy arm is kept although `cdkd import`'s migration path always
  // supplies the tree.
  const tpl = await cfnClient.send(
    new GetTemplateCommand({ StackName: cfnStackName, TemplateStage: 'Original' })
  );
  if (!tpl.TemplateBody) {
    throw new Error(`GetTemplate returned no body for '${cfnStackName}'.`);
  }
  // Cleanups for any transient child-template S3 uploads produced by the
  // recursive walk. Drained in the same `finally` as the parent's
  // `s3Cleanup` so the success path AND every failure path reaps every
  // transient object the recursive walk produced.
  const nestedCleanups: (() => Promise<void>)[] = [];
  const hasNestedChildren = templateContainsNestedStackRows(tpl.TemplateBody);
  let newBody: string;
  let modified: boolean;
  let format: TemplateFormat;
  if (hasNestedChildren) {
    const tree = resourceTree ?? (await getCloudFormationResourceTree(cfnStackName, cfnClient));
    try {
      const recursive = await injectRetainPoliciesRecursive(tpl.TemplateBody, cfnStackName, tree, {
        cfnClient,
        stateBucket,
        ...(s3ClientOpts && { s3ClientOpts }),
      });
      newBody = recursive.body;
      modified = recursive.modified;
      format = recursive.format;
      nestedCleanups.push(...recursive.cleanups);
    } catch (err) {
      // The recursive walk threw mid-flight; reap every transient upload it
      // had managed to produce before the throw. RecursiveRetainInjectionError
      // carries the partial-cleanup array specifically so we don't leak S3
      // objects when a deep recursion fails (the parent's `finally` block
      // for the UpdateStack call is unreachable here — `modified` is never
      // assigned, so the `if (modified)` branch + its `finally` never run).
      if (err instanceof RecursiveRetainInjectionError) {
        await drainTemplateUploads(err.cleanups, stateBucket, {
          what: 'partial nested-template upload',
          when: 'during error recovery',
        });
      }
      throw err;
    }
  } else {
    ({ body: newBody, modified, format } = injectRetainPolicies(tpl.TemplateBody, cfnStackName));
  }

  // ---- Confirmation gate (after we know what we're about to change) ----
  if (!yes) {
    // The recursive Retain-injection walk may have already uploaded one or
    // more transient child-template bodies to the cdkd state bucket BEFORE
    // this prompt. There are THREE ways out of this gate and only one of them
    // may keep those objects:
    //
    //   proceed  -> keep; the post-UpdateStack `finally` below reaps them.
    //   decline  -> drain; a cancelled retire must not leak S3 objects under
    //               the `cdkd-migrate-tmp/` prefix.
    //   REFUSE   -> drain; `confirmOrRefuse` THROWS on a non-interactive
    //               stdin (issue #2275), and that throw passes none of this
    //               function's three other drains — the recursive `catch`
    //               above has already been left, and the `if (modified)`
    //               branch with its `finally` is still below.
    //
    // The last one is why the drain hangs off a `finally` keyed on `proceed`
    // rather than living inside the decline branch: a second copy of the
    // decline branch's loop is the duplication class issue #2275 exists to
    // remove, and it is exactly the shape that let the refusal path leak.
    let proceed = false;
    try {
      proceed = await confirmPrompt(
        `Set DeletionPolicy=Retain and UpdateReplacePolicy=Retain on every resource in ` +
          `CloudFormation stack '${cfnStackName}', and delete the stack once cdkd state ` +
          `is written? AWS resources will NOT be deleted.`
      );
    } finally {
      if (!proceed) {
        await drainTemplateUploads(nestedCleanups, stateBucket, {
          what: 'temporary nested-template upload',
          when: 'during cancel cleanup',
        });
      }
    }
    if (!proceed) {
      logger.info(
        'CloudFormation stack retirement cancelled. The stack is unchanged and will not be deleted.'
      );
      return { outcome: 'cancelled' };
    }
  }

  // ---- Step 3: UpdateStack (skipped when nothing changed) ----
  let templateUpdated = false;
  if (!modified) {
    logger.info(`[2/4] Template already has Retain on every resource — skipping UpdateStack.`);
    // No-modification fast path can still have produced transient uploads
    // (e.g. a child's recursive walk did not modify the child itself BUT
    // grandchildren were uploaded). Reap them defensively. In practice
    // the `injectRetainPoliciesRecursive` "skip upload when child not
    // modified" rule means this branch is unreachable today, but keeping
    // the drain wired in means future ordering changes to the recursive
    // walk cannot silently regress to leaking S3 objects.
    await drainTemplateUploads(nestedCleanups, stateBucket, {
      what: 'temporary nested-template upload',
    });
  } else {
    logger.info(`[2/4] Injected DeletionPolicy=Retain and UpdateReplacePolicy=Retain.`);
    // Pick the UpdateStack input shape based on the modified template's size.
    // Inline `TemplateBody` is preferred (no S3 round-trip); for templates
    // over 51,200 bytes we upload to the cdkd state bucket and submit a
    // `TemplateURL` instead. Anything over the 1 MB CloudFormation
    // TemplateURL limit is structurally unsubmittable — surface a clear
    // error so the user can finish manually (this run has not written cdkd
    // state yet, so no rollback is needed).
    if (newBody.length > TEMPLATE_URL_LIMIT) {
      throw new Error(
        `Modified template is ${newBody.length} bytes, exceeds the ` +
          `CloudFormation UpdateStack TemplateURL limit (${TEMPLATE_URL_LIMIT}). ` +
          `cdkd state has not been written; shrink or split the template and retry. ` +
          MANUAL_RETIREMENT_ROUTE
      );
    }
    type UpdateInput = { TemplateBody: string } | { TemplateURL: string };
    let updateInput: UpdateInput;
    let s3Cleanup: (() => Promise<void>) | undefined;
    if (newBody.length <= TEMPLATE_BODY_LIMIT) {
      updateInput = { TemplateBody: newBody };
    } else {
      logger.info(
        `  Template is ${newBody.length} bytes (over ${TEMPLATE_BODY_LIMIT} inline limit) — ` +
          `uploading to state bucket '${stateBucket}'.`
      );
      const uploaded = await uploadTemplateForUpdateStack({
        bucket: stateBucket,
        body: newBody,
        cfnStackName,
        format,
        ...(s3ClientOpts && { s3ClientOpts }),
      });
      updateInput = { TemplateURL: uploaded.url };
      s3Cleanup = uploaded.cleanup;
    }
    try {
      logger.info(`[3/4] Updating CloudFormation stack with Retain policies...`);
      let updateRan = false;
      try {
        // Forward existing Parameters via `UsePreviousValue: true` so the
        // metadata-only Retain injection doesn't fall back to CFn defaults
        // (which can fail validation when a parameter has no default, or
        // change resource shape when defaults differ from current values).
        // Pre-fix this caused UPDATE_ROLLBACK on any source stack with
        // declared Parameters — surfaced by the `migrate-from-bare-cfn` integ,
        // whose template carried a ResourceSuffix parameter. That fixture was
        // retired with `cdkd migrate` (issue #2572), which left this arm
        // covered by unit tests only — against a MOCK of CloudFormation, which
        // cannot falsify a claim about what CloudFormation does with
        // `UsePreviousValue`. Issue #2587 restored the real-AWS half: the
        // `migrate-from-cfn` fixture's small stack now declares a
        // `TopicDisplayName` parameter with NO DEFAULT, so dropping this
        // forwarding fails its UpdateStack outright rather than silently
        // substituting a default.
        const previousParameters = (stack.Parameters ?? []).map((p) => ({
          ParameterKey: p.ParameterKey,
          UsePreviousValue: true,
        }));
        await cfnClient.send(
          new UpdateStackCommand({
            StackName: cfnStackName,
            ...updateInput,
            Capabilities: capabilities,
            ...(previousParameters.length > 0 && { Parameters: previousParameters }),
          })
        );
        updateRan = true;
      } catch (err) {
        // CFn returns ValidationError "No updates are to be performed" when
        // the diff is empty. That can happen if cdkd's whitespace-canonicalized
        // re-serialization matches the in-CFn stored template byte-for-byte
        // even though we believed we modified it.
        const msg = describeAwsFailure(err).detail;
        if (/No updates are to be performed/i.test(msg)) {
          logger.info(`  CloudFormation reports no updates needed.`);
        } else {
          throw new RetainUpdateFailedError(cfnStackName, 'rejected', err);
        }
      }
      if (updateRan) {
        try {
          await waitUntilStackUpdateComplete(
            // Minutes-scale CFn operation: 10s polling is dense enough and stays
            // within the repo-wide waiter cap (issue #1291 item 5).
            { client: cfnClient, maxWaitTime: 1800, minDelay: 5, maxDelay: 10 },
            { StackName: cfnStackName }
          );
        } catch (err) {
          throw new RetainUpdateFailedError(cfnStackName, 'unfinished', err);
        }
        templateUpdated = true;
      }
    } finally {
      // Drain transient S3 uploads from BOTH the parent's > 51,200-byte
      // template upload AND every nested child's upload accumulated by
      // `injectRetainPoliciesRecursive`. Each cleanup is best-effort —
      // a leaked transient object costs pennies and lives under the
      // explicitly-named `cdkd-migrate-tmp/` prefix, so a stale object is
      // easy to identify and reap manually. The retire flow's
      // success/failure is governed by CFn, not by S3.
      await drainTemplateUploads(
        [...(s3Cleanup ? [s3Cleanup] : []), ...nestedCleanups],
        stateBucket,
        {
          what: 'temporary template upload',
        }
      );
    }
  }

  return { outcome: 'ready', templateUpdated };
}

/**
 * Where to look for the copies a replacing Retain update superseded when cdkd
 * could not compare the ids itself (issue #4873). Shared by the waiter failure
 * here and the import's failed re-read.
 */
export const SUPERSEDED_COPY_HINT =
  'If that update completes (now or later), CloudFormation may have replaced resources; ' +
  'each superseded copy is RETAINED and managed by neither CloudFormation nor cdkd. ' +
  "Find them in the stack's events: rows whose reason reads " +
  '"Requested update requires the creation of a new physical resource" name the old ' +
  'physical id. A re-run does not report them, because the template then already ' +
  'carries the Retain policies and no update runs.';

/**
 * The route by hand, in the order that cannot record a superseded id (issue
 * #4873): Retain first, adopt second, delete last. The import step reads ids
 * from a same-named CloudFormation stack in auto mode (#1128).
 */
export const MANUAL_RETIREMENT_ROUTE =
  'To retire the stack by hand: (1) UpdateStack with DeletionPolicy=Retain and ' +
  'UpdateReplacePolicy=Retain on every resource, (2) `cdkd import` without ' +
  '--migrate-from-cloudformation (it reads the physical ids from a same-named ' +
  'CloudFormation stack), (3) DeleteStack. The import must adopt every resource ' +
  'before you delete the stack: check its summary.';

/**
 * What a CloudFormation stack waiter's failure may say in a message (issue
 * #4873). The SDK waiter throws `new Error(JSON.stringify(result))`, whose
 * `reason` is the last `DescribeStacks` response — Outputs and Parameters
 * included, so a NoEcho-derived Output would print in plaintext. Only the
 * waiter state and the stack's `StackStatus` / `StackStatusReason` are kept,
 * the precedent being `describeLambdaWaiterFailure` in
 * `custom-resource-provider.ts`. `undefined` when `error` is not a waiter
 * result.
 */
export function describeStackWaiterFailure(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.message);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('state' in parsed)) return undefined;
  const result = parsed as { state?: unknown; reason?: unknown };
  const state = typeof result.state === 'string' ? result.state : 'FAILURE';
  const reason = result.reason;
  const stacks =
    typeof reason === 'object' && reason !== null && 'Stacks' in reason
      ? (reason as { Stacks?: unknown }).Stacks
      : undefined;
  const stack = Array.isArray(stacks) && typeof stacks[0] === 'object' ? stacks[0] : undefined;
  const status = typeof stack?.StackStatus === 'string' ? stack.StackStatus : undefined;
  const statusReason =
    typeof stack?.StackStatusReason === 'string' ? stack.StackStatusReason : undefined;
  return (
    `waiter ${state}` +
    (status ? `, stack status ${status}` : typeof reason === 'string' ? `: ${reason}` : '') +
    (statusReason ? ` (${statusReason})` : '')
  );
}

/**
 * The text a message may carry for a CloudFormation call or waiter failure: the
 * reduced waiter text, else `describeAwsFailure(...).summary`. The withheld
 * detail goes to debug only. A waiter error kept as a `cause` has its own
 * message rewritten in place too, so a render that walks the chain cannot print
 * the payload either.
 */
export function cfnFailureText(error: unknown): string {
  const waiter = describeStackWaiterFailure(error);
  if (waiter !== undefined && error instanceof Error) {
    try {
      Object.defineProperty(error, 'message', {
        value: waiter,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      Object.defineProperty(error, 'stack', {
        value: `${error.name}: ${waiter}`,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch {
      // A frozen error keeps its message; the text returned below is still reduced.
    }
    return waiter;
  }
  const failure = describeAwsFailure(error);
  if (failure.redacted)
    getLogger().debug(safeMsg`CloudFormation failure detail: ${failure.detail}`);
  // Callers append their own `. `; the summary's pointer already ends a sentence.
  return failure.summary.replace(/\.+$/, '');
}

/**
 * The Retain `UpdateStack` failed, or its wait did not see it finish, before
 * any cdkd state was written (issue #4873). The message carries the manual
 * route because the failure can be DETERMINISTIC — a custom-named resource
 * CloudFormation must replace fails the same way on every re-run — and the
 * flow that used to write state first no longer does.
 */
export class RetainUpdateFailedError extends Error {
  override readonly cause?: unknown;
  constructor(cfnStackName: string, kind: 'rejected' | 'unfinished', cause: unknown) {
    const text = cfnFailureText(cause);
    super(
      safeMsg`The Retain-policy UpdateStack on CloudFormation stack ${displaySafe(cfnStackName)} ` +
        (kind === 'rejected' ? 'was rejected' : 'did not complete') +
        safeMsg`: ${text}. cdkd state has not been written. ` +
        (kind === 'unfinished' ? `${SUPERSEDED_COPY_HINT} ` : '') +
        'Re-run the same command once the cause is fixed. When the cause is a replacement ' +
        'CloudFormation cannot perform (a custom-named resource whose update requires ' +
        'replacing it), the same update by hand fails too: give that resource no custom ' +
        'name or a new one, or take it out of the stack, then re-run. ' +
        MANUAL_RETIREMENT_ROUTE
    );
    this.name = 'RetainUpdateFailedError';
    this.cause = cause;
  }
}

/**
 * Step 4 of the retirement {@link prepareCloudFormationStackRetirement}
 * describes: `DeleteStack`, after the caller has written cdkd state from the
 * physical ids CloudFormation holds once the Retain update completed. Every
 * resource carries `DeletionPolicy: Retain` by then, so CloudFormation deletes
 * only the stack record.
 */
export async function deleteRetiredCloudFormationStack(
  cfnStackName: string,
  cfnClient: CloudFormationClient
): Promise<void> {
  const logger = getLogger();
  logger.info(`[4/4] Deleting CloudFormation stack '${cfnStackName}' (resources retained)...`);
  try {
    await cfnClient.send(new DeleteStackCommand({ StackName: cfnStackName }));
    await waitUntilStackDeleteComplete(
      // Minutes-scale CFn operation: 10s polling is dense enough and stays
      // within the repo-wide waiter cap (issue #1291 item 5).
      { client: cfnClient, maxWaitTime: 1800, minDelay: 5, maxDelay: 10 },
      { StackName: cfnStackName }
    );
  } catch (err) {
    const error = new Error(
      safeMsg`CloudFormation stack ${displaySafe(cfnStackName)} was NOT confirmed deleted: ` +
        safeMsg`${cfnFailureText(err)}. cdkd state is written and correct, and every resource ` +
        `carries DeletionPolicy=Retain, so deleting the stack deletes no resource. Delete the ` +
        `stack by hand once its cause is resolved (for example an export another stack ` +
        `still imports).`
    );
    (error as Error & { cause?: unknown }).cause = err;
    throw error;
  }
  logger.info(
    `✓ CloudFormation stack '${cfnStackName}' retired. AWS resources are now ` +
      `solely managed by cdkd.`
  );
}

/**
 * Upload the Retain-injected template body to the cdkd state bucket and
 * return both a virtual-hosted-style HTTPS URL CloudFormation can fetch via
 * `UpdateStack TemplateURL` and a `cleanup` callback that deletes the object
 * (and destroys the S3 client).
 *
 * The state bucket's actual region is resolved via `GetBucketLocation`
 * (cached per-process) so the upload client and the URL match the bucket's
 * region — the `cdkd import` CLI's profile region is irrelevant here.
 *
 * Cleanup is the caller's responsibility: invoke `cleanup` in a `finally`
 * around the UpdateStack call. CloudFormation copies the template into its
 * own internal storage during the synchronous UpdateStack API call, so the
 * S3 object is no longer needed after that call returns (success or
 * failure).
 *
 * Exported for unit testing.
 */
export async function uploadTemplateForUpdateStack(args: {
  bucket: string;
  body: string;
  cfnStackName: string;
  /**
   * Source template format. Drives the S3 key extension and `Content-Type`
   * so a YAML-authored template stays YAML in the transient upload and
   * CloudFormation reads it as such.
   */
  format?: TemplateFormat;
  s3ClientOpts?: RetireCloudFormationStackOptions['s3ClientOpts'];
}): Promise<{ url: string; cleanup: () => Promise<void> }> {
  // Thin wrapper over the shared {@link uploadCfnTemplate} helper. Kept as
  // a named export so the legacy retire-cfn-stack call sites and tests
  // continue to work unchanged; the upload + cleanup contract lives in
  // `src/cli/upload-cfn-template.ts` and is also consumed by `cdkd
  // export`'s phase-1 / phase-2 changeset call paths. The optional
  // `format` argument is forwarded so YAML-authored templates stay YAML
  // on the transient S3 object (`.yaml` key + `application/x-yaml`).
  return uploadCfnTemplate({
    bucket: args.bucket,
    body: args.body,
    stackName: args.cfnStackName,
    ...(args.format && { format: args.format }),
    ...(args.s3ClientOpts && { s3ClientOpts: args.s3ClientOpts }),
  });
}

/**
 * Parse a CloudFormation template body (JSON or YAML), set
 * `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` on every
 * resource that doesn't already have those exact values, and re-serialize
 * in the SAME format as the input. Returns the resulting body, a
 * `modified` flag, and the detected source format so callers can stamp
 * the right content type / S3 key extension on follow-up uploads.
 *
 * YAML templates are routed through cdkd's CFn-aware YAML codec
 * (`src/cli/yaml-cfn.ts`), which preserves every CFn shorthand intrinsic
 * (`!Ref`, `!GetAtt`, `!Sub`, etc.) on round-trip. JSON templates take
 * the canonical two-space-indented JSON path.
 *
 * Exported for unit testing (the AWS round-trips are mocked, but the
 * mutation logic itself is pure and worth exercising directly).
 */
export function injectRetainPolicies(
  templateBody: string,
  cfnStackName: string
): { body: string; modified: boolean; format: TemplateFormat } {
  const format = detectTemplateFormat(templateBody);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCfnTemplate(templateBody);
  } catch (err) {
    throw new Error(
      `Template for '${cfnStackName}' is not a valid CloudFormation template. ` +
        `cdkd's --migrate-from-cloudformation flow supports both JSON and YAML templates ` +
        `(YAML via a CFn-aware codec that preserves !Ref / !GetAtt / !Sub shorthand). ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (
    !('Resources' in parsed) ||
    typeof parsed['Resources'] !== 'object' ||
    parsed['Resources'] === null ||
    Array.isArray(parsed['Resources'])
  ) {
    throw new Error(
      `Template for '${cfnStackName}' has no Resources section — refusing to retire.`
    );
  }

  const modified = injectRetainPoliciesOnParsedResources(
    parsed['Resources'] as Record<string, unknown>
  );
  return { body: stringifyCfnTemplate(parsed, format), modified, format };
}

/**
 * Cheap sniff: does the template body contain any `AWS::CloudFormation::Stack`
 * resource rows? Parses + walks `Resources` once (no recursive descent),
 * tolerating parse failures by returning `false` (the caller's downstream
 * parse step will surface the same error with a richer message). Used by
 * {@link prepareCloudFormationStackRetirement} to decide whether to lazily build the
 * recursive {@link CfnStackResourceTree} — non-nested templates skip the
 * extra `DescribeStackResources` round-trip entirely.
 */
function templateContainsNestedStackRows(templateBody: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCfnTemplate(templateBody);
  } catch {
    return false;
  }
  const resources = parsed['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return false;
  for (const resource of Object.values(resources as Record<string, unknown>)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    if ((resource as Record<string, unknown>)['Type'] === NESTED_STACK_RESOURCE_TYPE) {
      return true;
    }
  }
  return false;
}

/**
 * Mutate an already-parsed `Resources` map in place: set `DeletionPolicy: Retain`
 * and `UpdateReplacePolicy: Retain` on every leaf resource that doesn't
 * already have them. Returns the `modified` flag so the caller can decide
 * whether the round-trip is worth a `stringifyCfnTemplate` re-serialization
 * (and whether `UpdateStack` is needed at all).
 *
 * `AWS::CloudFormation::Stack` resources are **intentionally skipped** — see
 * issue [#464](https://github.com/go-to-k/cdkd/issues/464) and the design at
 * [docs/design/464-nested-stacks-export-import.md](../../../docs/design/464-nested-stacks-export-import.md)
 * §3.4. Retain on a nested-stack row tells AWS CFn's parent-side `DeleteStack`
 * to NOT cascade-delete the child stack record at all, which would leave a
 * stranded child stack record on AWS that the user has to clean up manually.
 * We want the cascade to descend (so child stack records get deleted as the
 * tree unwinds) while every child's own leaf resources stay because THEIR
 * Retain was injected on the previous recursion level — the recursive
 * Retain injection in {@link injectRetainPoliciesRecursive} relies on this
 * skip rule to behave correctly.
 *
 * `UpdateReplacePolicy: Retain` matters only when the Retain update REPLACES
 * a resource (issue #4873): the superseded copy is then kept rather than
 * deleted by an update the operator did not author, and the import reports it.
 *
 * Shared between the single-template path ({@link injectRetainPolicies}) and
 * the per-level walk inside {@link injectRetainPoliciesRecursive} so both
 * sites apply the exact same skip rule with no risk of drift.
 */
function injectRetainPoliciesOnParsedResources(resources: Record<string, unknown>): boolean {
  let modified = false;
  for (const [, resource] of Object.entries(resources)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const r = resource as Record<string, unknown>;
    if (r['Type'] === NESTED_STACK_RESOURCE_TYPE) continue;
    if (r['DeletionPolicy'] !== 'Retain') {
      r['DeletionPolicy'] = 'Retain';
      modified = true;
    }
    if (r['UpdateReplacePolicy'] !== 'Retain') {
      r['UpdateReplacePolicy'] = 'Retain';
      modified = true;
    }
  }
  return modified;
}

/**
 * Recursive variant of {@link injectRetainPolicies} that handles a parent
 * template containing one or more `AWS::CloudFormation::Stack` rows. Issue
 * [#464](https://github.com/go-to-k/cdkd/issues/464); see
 * [docs/design/464-nested-stacks-export-import.md](../../../docs/design/464-nested-stacks-export-import.md)
 * §3.4 for the design rationale.
 *
 * For each nested-stack row in the parent template:
 *   1. `GetTemplate` Original-stage on the corresponding child stack ARN (read
 *      from the supplied {@link CfnStackResourceTree}, populated up front by
 *      {@link getCloudFormationResourceTree}).
 *   2. Recursively process the child template — Retain injection on its
 *      leaves AND further recursion into any grandchildren.
 *   3. If the recursion produced a modified child body, upload the modified
 *      body to the cdkd state bucket via the shared {@link uploadCfnTemplate}
 *      helper and rewrite the parent's `Properties.TemplateURL` for that
 *      row to the uploaded URL — so the parent's eventual `UpdateStack`
 *      cascades into the child with the Retain-bearing template.
 *
 * After all nested-stack rows are processed, the parent's own leaf
 * resources get Retain injected via {@link injectRetainPoliciesOnParsedResources}
 * — the SAME helper the single-template path uses, applying the same
 * "skip `AWS::CloudFormation::Stack` rows" rule (those rows must NOT have
 * Retain or cascade-delete won't descend — see the helper's doc-comment).
 *
 * The returned `cleanups` array carries one S3 delete callback per
 * transient child-template upload made anywhere in the recursive walk.
 * The caller drains it in a `finally` block around the parent
 * `UpdateStack` call — CFn fetches each child template synchronously
 * during `UpdateStack`, so the transient objects can be reaped as soon
 * as that call returns (success OR failure). When the helper itself
 * throws mid-walk, the partial uploads accumulated so far are returned
 * via a thrown {@link RecursiveRetainInjectionError} so the outer
 * `finally` can still reap them — losing the throw stack vs. the
 * cleanups would have leaked transient S3 objects.
 *
 * Exported so the recursive call can be unit-tested end-to-end (the AWS
 * round-trips are mocked at the SDK boundary, but the recursion shape
 * itself is the load-bearing piece).
 */
export async function injectRetainPoliciesRecursive(
  rootTemplateBody: string,
  rootCfnStackName: string,
  rootTree: CfnStackResourceTree,
  deps: {
    cfnClient: CloudFormationClient;
    stateBucket: string;
    s3ClientOpts?: CfnUploadS3ClientOpts;
  }
): Promise<{
  body: string;
  modified: boolean;
  format: TemplateFormat;
  cleanups: (() => Promise<void>)[];
}> {
  const cleanups: (() => Promise<void>)[] = [];
  try {
    const result = await injectRetainPoliciesRecursiveInternal(
      rootTemplateBody,
      rootCfnStackName,
      rootTree,
      deps,
      cleanups
    );
    return { ...result, cleanups };
  } catch (err) {
    throw new RecursiveRetainInjectionError(
      describeAwsFailure(err).detail,
      cleanups,
      err instanceof Error ? err : undefined
    );
  }
}

/**
 * Thrown by {@link injectRetainPoliciesRecursive} when the recursive walk
 * fails partway through. Carries the array of cleanup callbacks for every
 * successful transient S3 upload made BEFORE the failure so the outer
 * `finally` in `prepareCloudFormationStackRetirement` can still reap them.
 *
 * Without this, a mid-walk error would lose every accumulated cleanup —
 * the error path would skip the parent's `finally` block that drains
 * `nestedCleanups`, leaking N transient S3 objects per failed retire.
 */
export class RecursiveRetainInjectionError extends Error {
  readonly cleanups: (() => Promise<void>)[];
  override readonly cause?: Error;
  constructor(message: string, cleanups: (() => Promise<void>)[], cause?: Error) {
    super(message);
    this.name = 'RecursiveRetainInjectionError';
    this.cleanups = cleanups;
    if (cause) this.cause = cause;
  }
}

async function injectRetainPoliciesRecursiveInternal(
  templateBody: string,
  cfnStackName: string,
  tree: CfnStackResourceTree,
  deps: {
    cfnClient: CloudFormationClient;
    stateBucket: string;
    s3ClientOpts?: CfnUploadS3ClientOpts;
  },
  cleanups: (() => Promise<void>)[]
): Promise<{ body: string; modified: boolean; format: TemplateFormat }> {
  const format = detectTemplateFormat(templateBody);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCfnTemplate(templateBody);
  } catch (err) {
    throw new Error(
      `Template for '${cfnStackName}' is not a valid CloudFormation template. ` +
        `cdkd's --migrate-from-cloudformation flow supports both JSON and YAML templates ` +
        `(YAML via a CFn-aware codec that preserves !Ref / !GetAtt / !Sub shorthand). ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (
    !('Resources' in parsed) ||
    typeof parsed['Resources'] !== 'object' ||
    parsed['Resources'] === null ||
    Array.isArray(parsed['Resources'])
  ) {
    throw new Error(
      `Template for '${cfnStackName}' has no Resources section — refusing to retire.`
    );
  }
  const resources = parsed['Resources'] as Record<string, unknown>;
  let modified = false;

  // 1. Recurse into each nested-stack row first. Done before the leaf-level
  //    Retain injection so we can rewrite `Properties.TemplateURL` and
  //    flip `modified` to true via the same `modified` accumulator the
  //    leaf injection uses below.
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const r = resource as Record<string, unknown>;
    if (r['Type'] !== NESTED_STACK_RESOURCE_TYPE) continue;

    const childNode = tree.nested.get(logicalId);
    if (!childNode) {
      throw new Error(
        `Template for '${cfnStackName}' has nested-stack '${logicalId}' (Type: ` +
          `${NESTED_STACK_RESOURCE_TYPE}) but the CloudFormation resource tree has no ` +
          `matching child entry. AWS may have removed the child since DescribeStackResources ` +
          `ran, or the template was hand-edited mid-flight — re-run \`cdkd import --migrate-from-cloudformation\` ` +
          `to refresh.`
      );
    }

    const childTpl = await deps.cfnClient.send(
      new GetTemplateCommand({ StackName: childNode.physicalId, TemplateStage: 'Original' })
    );
    if (!childTpl.TemplateBody) {
      throw new Error(
        `GetTemplate returned no body for nested stack '${logicalId}' ` +
          `(physicalId='${childNode.physicalId}', parent='${cfnStackName}').`
      );
    }

    const childResult = await injectRetainPoliciesRecursiveInternal(
      childTpl.TemplateBody,
      childNode.stackName,
      childNode,
      deps,
      cleanups
    );

    if (childResult.modified) {
      // Upload the modified child body and rewrite the parent's
      // TemplateURL to point at it. Done only when the child was actually
      // mutated — an already-fully-Retain'd child needs no re-upload, and
      // the parent's pre-existing TemplateURL (pointing at the CDK
      // asset bucket) is fine as-is. Per-child upload size is bounded by
      // the same 51,200-byte inline ceiling AND the 1 MB CloudFormation
      // TemplateURL ceiling that the parent enforces — overflow surfaces
      // the same hard error.
      if (childResult.body.length > TEMPLATE_URL_LIMIT) {
        throw new Error(
          `Modified nested-stack template for '${logicalId}' is ${childResult.body.length} ` +
            `bytes, exceeds the CloudFormation TemplateURL limit (${TEMPLATE_URL_LIMIT}). ` +
            `cdkd state has not been written; shrink the child template and retry, or ` +
            `retire the stack manually: (1) UpdateStack with Retain policies on the ` +
            `parent and each child, (2) cdkd import, (3) DeleteStack on the parent.`
        );
      }
      const uploaded = await uploadCfnTemplate({
        bucket: deps.stateBucket,
        body: childResult.body,
        // Include both parent + child in the S3 key prefix so leftover
        // transient objects (cleanup failures) are still traceable to the
        // exact migration call by humans grepping the bucket.
        stackName: `${cfnStackName}__nested__${logicalId}`,
        format: childResult.format,
        ...(deps.s3ClientOpts && { s3ClientOpts: deps.s3ClientOpts }),
      });
      cleanups.push(uploaded.cleanup);

      const propsRaw = r['Properties'];
      const props =
        propsRaw && typeof propsRaw === 'object' && !Array.isArray(propsRaw)
          ? (propsRaw as Record<string, unknown>)
          : ((r['Properties'] = {}) as Record<string, unknown>);
      props['TemplateURL'] = uploaded.url;
      modified = true;
    }
  }

  // 2. Inject Retain on every non-nested-stack resource at THIS level.
  //    Uses the shared helper so the skip rule for `AWS::CloudFormation::Stack`
  //    rows (must NOT have Retain — see the helper's doc-comment) lives in
  //    one place.
  if (injectRetainPoliciesOnParsedResources(resources)) {
    modified = true;
  }

  return { body: stringifyCfnTemplate(parsed, format), modified, format };
}

/**
 * Walk a CloudFormation stack and every nested child recursively, returning
 * the full {@link CfnStackResourceTree} rooted at `rootStackName`. Used by
 * `cdkd import --migrate-from-cloudformation` to drive BOTH per-child state
 * writes AND the recursive `injectRetainPoliciesRecursive` walk — both
 * consumers share this single `DescribeStackResources` tree so an
 * arbitrarily-deep nesting only costs one round-trip per stack.
 *
 * For each `AWS::CloudFormation::Stack` row in the root's resources, recursively
 * calls `DescribeStackResources(<child ARN>)` (AWS accepts the ARN as
 * `StackName`) to populate the child node, and so on to arbitrary depth.
 *
 * Issue [#464](https://github.com/go-to-k/cdkd/issues/464): the recursive
 * `cdkd import --migrate-from-cloudformation` flow uses this once at the
 * top of the import command to drive BOTH (a) per-child state writes
 * under the v6 state-key shape `cdkd/<parent>~<child>/<region>/state.json`
 * AND (b) the recursive `injectRetainPoliciesRecursive` walk that retires
 * the whole tree on AWS without orphaning any resources.
 *
 * Children at every level are fetched in parallel via `Promise.all` so an
 * N-stack-wide tree only takes log(depth) round-trips of wall-clock time
 * instead of N — load-bearing when a CDK app spreads micro-services across
 * many nested children.
 *
 * Tree node `physicalId` is the AWS-side identifier accepted by every
 * CFn API call (`DescribeStackResources` / `GetTemplate`). For the root,
 * that's the user-supplied stack name; for nested children, the child
 * stack ARN.
 */
export async function getCloudFormationResourceTree(
  rootStackName: string,
  cfnClient: CloudFormationClient
): Promise<CfnStackResourceTree> {
  return walkCfnStackTree(rootStackName, rootStackName, cfnClient);
}

async function walkCfnStackTree(
  stackName: string,
  physicalId: string,
  cfnClient: CloudFormationClient
): Promise<CfnStackResourceTree> {
  const resp = await cfnClient.send(new DescribeStackResourcesCommand({ StackName: physicalId }));
  const resources = new Map<string, string>();
  const nestedChildren: { logicalId: string; childArn: string }[] = [];
  for (const r of resp.StackResources ?? []) {
    if (!r.LogicalResourceId || !r.PhysicalResourceId) continue;
    resources.set(r.LogicalResourceId, r.PhysicalResourceId);
    if (r.ResourceType === NESTED_STACK_RESOURCE_TYPE) {
      nestedChildren.push({ logicalId: r.LogicalResourceId, childArn: r.PhysicalResourceId });
    }
  }
  const childPairs = await Promise.all(
    nestedChildren.map(async ({ logicalId, childArn }) => ({
      logicalId,
      node: await walkCfnStackTree(childArn, childArn, cfnClient),
    }))
  );
  const nested = new Map<string, CfnStackResourceTree>();
  for (const { logicalId, node } of childPairs) {
    nested.set(logicalId, node);
  }
  return { stackName, physicalId, resources, nested };
}

/** One resource whose physical id differs between two reads of a stack tree. */
export interface ReplacedCfnResource {
  /** Nested-stack logical ids from the root down to the owning stack; `[]` for the root. */
  nestedPath: string[];
  logicalId: string;
  before: string;
  after: string;
}

/**
 * Every resource present in BOTH trees whose physical id changed — what the
 * Retain update replaced (issue #4873). Walks nested children matched by
 * logical id. A row present in only one tree is not a replacement and is left
 * to the import's own not-found handling.
 */
export function findReplacedCfnResources(
  before: CfnStackResourceTree,
  after: CfnStackResourceTree,
  nestedPath: string[] = []
): ReplacedCfnResource[] {
  const replaced: ReplacedCfnResource[] = [];
  for (const [logicalId, beforeId] of before.resources) {
    const afterId = after.resources.get(logicalId);
    if (afterId !== undefined && afterId !== beforeId) {
      replaced.push({ nestedPath, logicalId, before: beforeId, after: afterId });
    }
  }
  for (const [childLogicalId, beforeChild] of before.nested) {
    const afterChild = after.nested.get(childLogicalId);
    if (afterChild) {
      replaced.push(
        ...findReplacedCfnResources(beforeChild, afterChild, [...nestedPath, childLogicalId])
      );
    }
  }
  return replaced;
}

/**
 * The CloudFormation-stack retirement confirmation prompt, reached from
 * `cdkd import --migrate-from-cloudformation` (skip flag `-y` / `--yes`). Its
 * only call site is inside the `if (!yes)` block above, which is what keeps
 * `confirmOrRefuse`'s non-interactive refusal (issue #2275) from firing on a
 * `--yes` run.
 *
 * The refusal NAMES that command, as every other site does, because
 * `confirmOrRefuse`'s contract is that the refusal is the only thing a CI user
 * sees: it has to say which invocation the missing flag belongs on. It named
 * TWO commands until `cdkd migrate --retire-cfn-stack` was removed with the
 * command itself (issue #2572); `cdkd import --migrate-from-cloudformation` is
 * now the sole way to reach this prompt.
 *
 * It also states that nothing has been written yet. The prompt fires BEFORE
 * the command's state write and before the Retain update (issue #4873), so a
 * refusal leaves both cdkd state and the CloudFormation stack as they were —
 * and the operator, who sees only the refusal, needs to know a plain re-run
 * with -y / --yes is the whole recovery.
 *
 * Exported for unit testing — internal to the command flow otherwise.
 */
export async function confirmPrompt(prompt: string): Promise<boolean> {
  return confirmOrRefuse(prompt, {
    refusal:
      'The CloudFormation stack retirement confirmation prompt cannot run in a ' +
      'non-interactive environment. Pass -y / --yes on ' +
      'cdkd import --migrate-from-cloudformation. ' +
      'Alternatively, run it from a real terminal. ' +
      'Nothing has been written yet: cdkd state and the CloudFormation stack are ' +
      'unchanged, so re-running with -y / --yes is the whole recovery.',
  });
}

/**
 * Flat `logicalId -> physicalId` map for ONE CloudFormation stack, or `null`
 * when no stack of that name exists.
 *
 * This is the non-recursive, non-throwing sibling of
 * {@link getCloudFormationResourceTree}, used by `cdkd import`'s auto mode as
 * a best-effort lookup (issue #1128). The distinction matters:
 *
 *   - the tree walk is for `--migrate-from-cloudformation`, where the stack is
 *     known to exist and nested children must be walked so each child's state
 *     can be written and the whole tree retired;
 *   - this one runs speculatively on every auto-mode import, so a missing
 *     stack is the NORMAL case (a cdkd-native stack has no CFn counterpart)
 *     and must return `null` rather than abort the import.
 *
 * NO failure is fatal. The lookup is an OPTIMIZATION: when it cannot answer,
 * the caller falls through to the per-provider lookups, which is exactly the
 * behavior that shipped before this function existed. Throwing would convert a
 * missed improvement into a hard failure — and it would do so precisely for the
 * users least likely to benefit. A cdkd-native stack has no CloudFormation
 * counterpart, so an operator whose IAM policy is scoped to cdkd's actual needs
 * (no `cloudformation:DescribeStackResources`) would see `AccessDenied` abort an
 * import that worked fine the day before.
 *
 * A missing stack is the expected case and logs at debug. Anything else logs a
 * WARN naming the cause, so a permissions gap or a throttle is visible rather
 * than silent — the user learns why the ids were not resolved, and still gets
 * the pre-existing behavior instead of an abort.
 */
export async function tryGetCloudFormationResourceMap(
  stackName: string,
  cfnClient: CloudFormationClient
): Promise<Map<string, string> | null> {
  const logger = getLogger();
  let resp;
  try {
    resp = await cfnClient.send(new DescribeStackResourcesCommand({ StackName: stackName }));
  } catch (err) {
    if (isStackNotFoundError(err)) {
      logger.debug(`No CloudFormation stack named '${stackName}'.`);
      return null;
    }
    const reason = describeAwsFailure(err).detail;
    // The stack name is shown only when plain and described otherwise, and
    // AWS's message (which can echo it) ends its own line, so the `--resource`
    // remedy starts the next one, with its holes quoted (go-to-k/cdkd#4226):
    // inside cdkd's own `'...'` a `'` in the name closed the quote, a
    // JSON-quoted `$( )` still runs when pasted, and a bare `<physicalId>`
    // redirects.
    const subject = isPasteableIdent(stackName)
      ? `CloudFormation stack '${stackName}'`
      : 'a CloudFormation stack whose name is not a plain identifier';
    logger.warn(
      `Could not read ${subject} to resolve physical IDs (${reason}).\n` +
        `Falling back to per-resource lookup; resources whose physical name CloudFormation ` +
        `generated may be reported as not found. Grant cloudformation:DescribeStackResources, ` +
        `or pass --resource ${commandHole('LogicalId')}=${commandHole('physicalId')} for those resources.`
    );
    return null;
  }

  const resources = new Map<string, string>();
  for (const r of resp.StackResources ?? []) {
    if (!r.LogicalResourceId || !r.PhysicalResourceId) continue;
    resources.set(r.LogicalResourceId, r.PhysicalResourceId);
  }
  return resources;
}

/**
 * CloudFormation reports an unknown stack as a `ValidationError` whose message
 * carries "does not exist" — there is no dedicated exception type to catch.
 * Matching the message is therefore required, but it is kept narrow so an
 * unrelated ValidationError (a malformed stack name, say) still surfaces.
 */
export function isStackNotFoundError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  const message = (err as { message?: string } | undefined)?.message ?? '';
  return name === 'ValidationError' && /does not exist/i.test(message);
}
