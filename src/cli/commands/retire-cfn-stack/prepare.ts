import {
  DescribeStacksCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  waitUntilStackUpdateComplete,
} from '@aws-sdk/client-cloudformation';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { confirmOrRefuse } from '../confirm-prompt.js';
import { STABLE_TERMINAL_STATUSES } from '../../cfn-stack-states.js';
import { MIGRATE_TMP_PREFIX } from '../../upload-cfn-template.js';
import type { TemplateFormat } from '../../yaml-cfn.js';
import {
  TEMPLATE_BODY_LIMIT,
  TEMPLATE_URL_LIMIT,
  type RetireCloudFormationStackOptions,
  type CloudFormationRetirementPreparation,
} from './types.js';
import { MANUAL_RETIREMENT_ROUTE, RetainUpdateFailedError } from './failure-text.js';
import {
  uploadTemplateForUpdateStack,
  injectRetainPolicies,
  templateContainsNestedStackRows,
  injectRetainPoliciesRecursive,
  RecursiveRetainInjectionError,
} from './retain-injection.js';
import { getCloudFormationResourceTree } from './resource-tree.js';

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
 * to adopt; `deleteRetiredCloudFormationStack` is step 4. The procedure
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
