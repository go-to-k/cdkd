import * as readline from 'node:readline/promises';
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

/**
 * Stack states from which an UpdateStack call is safe. Anything else (an
 * IN_PROGRESS, FAILED, or REVIEW_IN_PROGRESS state) means the stack is
 * mid-operation or in an unhealthy state we should not touch.
 */
const STABLE_TERMINAL_STATUSES = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);

/**
 * UpdateStack TemplateBody hard limit (51,200 bytes). Templates larger than
 * this can only be submitted via TemplateURL backed by S3 — supporting that
 * is a follow-up; for now we surface a clear error pointing to the manual
 * 3-step procedure so the user is not stuck.
 */
const TEMPLATE_BODY_LIMIT = 51200;

export interface RetireCloudFormationStackOptions {
  cfnStackName: string;
  cfnClient: CloudFormationClient;
  /** Skip the interactive confirmation prompt (CDK CLI parity for `-y` / `--yes`). */
  yes: boolean;
}

export type RetireCloudFormationOutcome =
  | { outcome: 'retired' }
  | { outcome: 'cancelled' }
  | { outcome: 'no-template-change' };

/**
 * Retire a CloudFormation stack whose resources have just been adopted into
 * cdkd state. The 4-step procedure is the one AWS recommends for handing
 * over resources between management tools without deleting them:
 *
 *   1. DescribeStacks — verify the stack is in a stable terminal state and
 *      capture its existing Capabilities so the UpdateStack call doesn't
 *      strip them.
 *   2. GetTemplate (Original stage) — fetch the template the user submitted,
 *      then inject `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`
 *      on every resource that doesn't already have them.
 *   3. UpdateStack — the modified template is a metadata-only change, so
 *      AWS makes no actual resource modifications. We wait for completion
 *      so step 4 doesn't race the previous operation.
 *   4. DeleteStack — every resource is now Retain, so CloudFormation walks
 *      the stack and skips every resource. The stack record disappears;
 *      the underlying AWS resources are left intact for cdkd to manage.
 *
 * Step 3 is skipped when every resource already has both policies (idempotent
 * re-runs after a partial failure don't need to round-trip an UpdateStack).
 *
 * Failure model: this is invoked AFTER cdkd state has been written
 * successfully, so any failure here leaves cdkd state intact and the user
 * can re-run the command — or fall back to the manual 3-step procedure if
 * the failure is structural (e.g. template too large for inline
 * TemplateBody).
 */
export async function retireCloudFormationStack(
  options: RetireCloudFormationStackOptions
): Promise<RetireCloudFormationOutcome> {
  const logger = getLogger();
  const { cfnStackName, cfnClient, yes } = options;

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
  const tpl = await cfnClient.send(
    new GetTemplateCommand({ StackName: cfnStackName, TemplateStage: 'Original' })
  );
  if (!tpl.TemplateBody) {
    throw new Error(`GetTemplate returned no body for '${cfnStackName}'.`);
  }
  const { body: newBody, modified } = injectRetainPolicies(tpl.TemplateBody, cfnStackName);

  // ---- Confirmation gate (after we know what we're about to change) ----
  if (!yes) {
    const ok = await confirmPrompt(
      `Set DeletionPolicy=Retain and UpdateReplacePolicy=Retain on every resource in ` +
        `CloudFormation stack '${cfnStackName}', then delete the stack? ` +
        `AWS resources will NOT be deleted (cdkd state has been written).`
    );
    if (!ok) {
      logger.info('CloudFormation stack retirement cancelled. cdkd state is unaffected.');
      return { outcome: 'cancelled' };
    }
  }

  // ---- Step 3: UpdateStack (skipped when nothing changed) ----
  let updateRan = false;
  if (!modified) {
    logger.info(`[2/4] Template already has Retain on every resource — skipping UpdateStack.`);
  } else {
    logger.info(`[2/4] Injected DeletionPolicy=Retain and UpdateReplacePolicy=Retain.`);
    if (newBody.length > TEMPLATE_BODY_LIMIT) {
      throw new Error(
        `Modified template is ${newBody.length} bytes, exceeds the inline ` +
          `UpdateStack TemplateBody limit (${TEMPLATE_BODY_LIMIT}). cdkd state has ` +
          `already been written; retire the stack manually with: (1) edit the ` +
          `template to add DeletionPolicy: Retain and UpdateReplacePolicy: Retain ` +
          `to every resource, (2) UpdateStack with the modified template via ` +
          `S3 TemplateURL, (3) DeleteStack. Inline TemplateURL fallback is a ` +
          `planned follow-up.`
      );
    }
    logger.info(`[3/4] Updating CloudFormation stack with Retain policies...`);
    try {
      await cfnClient.send(
        new UpdateStackCommand({
          StackName: cfnStackName,
          TemplateBody: newBody,
          Capabilities: capabilities,
        })
      );
      updateRan = true;
    } catch (err) {
      // CFn returns ValidationError "No updates are to be performed" when
      // the diff is empty. That can happen if cdkd's whitespace-canonicalized
      // re-serialization matches the in-CFn stored template byte-for-byte
      // even though we believed we modified it.
      const msg = err instanceof Error ? err.message : String(err);
      if (/No updates are to be performed/i.test(msg)) {
        logger.info(`  CloudFormation reports no updates needed — proceeding to delete.`);
      } else {
        throw err;
      }
    }
    if (updateRan) {
      await waitUntilStackUpdateComplete(
        { client: cfnClient, maxWaitTime: 1800 },
        { StackName: cfnStackName }
      );
    }
  }

  // ---- Step 4: DeleteStack ----
  logger.info(`[4/4] Deleting CloudFormation stack '${cfnStackName}' (resources retained)...`);
  await cfnClient.send(new DeleteStackCommand({ StackName: cfnStackName }));
  await waitUntilStackDeleteComplete(
    { client: cfnClient, maxWaitTime: 1800 },
    { StackName: cfnStackName }
  );
  logger.info(
    `✓ CloudFormation stack '${cfnStackName}' retired. AWS resources are now ` +
      `solely managed by cdkd.`
  );
  return { outcome: modified ? 'retired' : 'no-template-change' };
}

/**
 * Parse a CloudFormation template body (JSON), set `DeletionPolicy: Retain`
 * and `UpdateReplacePolicy: Retain` on every resource that doesn't already
 * have those exact values, and re-serialize.
 *
 * JSON-only by design: cdkd's `--migrate-from-cloudformation` flow targets CDK-
 * managed stacks, and CDK always emits JSON. Hand-written YAML CFn templates
 * can be retired manually with the standard 3-step procedure.
 *
 * Exported for unit testing (the AWS round-trips are mocked, but the
 * mutation logic itself is pure and worth exercising directly).
 */
export function injectRetainPolicies(
  templateBody: string,
  cfnStackName: string
): { body: string; modified: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(templateBody);
  } catch (err) {
    throw new Error(
      `Template for '${cfnStackName}' is not valid JSON. cdkd's ` +
        `--migrate-from-cloudformation flow only supports CDK-generated (JSON) templates. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('Resources' in parsed) ||
    typeof (parsed as { Resources: unknown }).Resources !== 'object' ||
    (parsed as { Resources: unknown }).Resources === null
  ) {
    throw new Error(
      `Template for '${cfnStackName}' has no Resources section — refusing to retire.`
    );
  }

  let modified = false;
  const resources = (parsed as { Resources: Record<string, unknown> }).Resources;
  for (const [, resource] of Object.entries(resources)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const r = resource as Record<string, unknown>;
    if (r['DeletionPolicy'] !== 'Retain') {
      r['DeletionPolicy'] = 'Retain';
      modified = true;
    }
    if (r['UpdateReplacePolicy'] !== 'Retain') {
      r['UpdateReplacePolicy'] = 'Retain';
      modified = true;
    }
  }
  // Two-space indent matches the CDK canonical form, keeping the diff a
  // reviewer might pull from CloudTrail or a CFn change set human-readable.
  return { body: JSON.stringify(parsed, null, 2), modified };
}

/**
 * Ask CloudFormation directly which physical id corresponds to each logical
 * id in the named stack. Used by `cdkd import --migrate-from-cloudformation`
 * to side-step cdkd's tag-based auto-lookup (which can't find resources
 * deployed by upstream `cdk deploy` — that flow doesn't propagate
 * `aws:cdk:path` as an AWS tag, and AWS reserves the `aws:` tag prefix so
 * we can't add it ourselves either).
 *
 * Pulls the entire stack with `DescribeStackResources` (one round-trip,
 * unbounded result by spec — CFn caps stacks at 500 resources). Resources
 * whose `PhysicalResourceId` is missing (rare; typically an import-failed
 * resource or `AWS::CDK::Metadata`) are skipped silently — the caller
 * already iterates the synthesized template separately and will surface
 * those as `skipped-no-impl` / `skipped-not-found`.
 */
export async function getCloudFormationResourceMapping(
  cfnStackName: string,
  cfnClient: CloudFormationClient
): Promise<Map<string, string>> {
  const resp = await cfnClient.send(new DescribeStackResourcesCommand({ StackName: cfnStackName }));
  const map = new Map<string, string>();
  for (const r of resp.StackResources ?? []) {
    if (!r.LogicalResourceId || !r.PhysicalResourceId) continue;
    map.set(r.LogicalResourceId, r.PhysicalResourceId);
  }
  return map;
}

async function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [y/N] `);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}
