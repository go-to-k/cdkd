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
   * that wrote cdkd state.
   */
  s3ClientOpts?: CfnUploadS3ClientOpts;
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
 * Templates over the inline 51,200-byte `TemplateBody` limit are uploaded to
 * the cdkd state bucket and submitted via `TemplateURL`; the transient
 * object is deleted in a `finally` immediately after `UpdateStack`. Only
 * templates over the 1 MB CloudFormation `TemplateURL` limit fail outright.
 *
 * Failure model: this is invoked AFTER cdkd state has been written
 * successfully, so any failure here leaves cdkd state intact and the user
 * can re-run the command — or fall back to the manual 3-step procedure if
 * the failure is structural (e.g. template over the 1 MB TemplateURL limit).
 */
export async function retireCloudFormationStack(
  options: RetireCloudFormationStackOptions
): Promise<RetireCloudFormationOutcome> {
  const logger = getLogger();
  const { cfnStackName, cfnClient, yes, stateBucket, s3ClientOpts } = options;

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
  const { body: newBody, modified, format } = injectRetainPolicies(tpl.TemplateBody, cfnStackName);

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
  if (!modified) {
    logger.info(`[2/4] Template already has Retain on every resource — skipping UpdateStack.`);
  } else {
    logger.info(`[2/4] Injected DeletionPolicy=Retain and UpdateReplacePolicy=Retain.`);
    // Pick the UpdateStack input shape based on the modified template's size.
    // Inline `TemplateBody` is preferred (no S3 round-trip); for templates
    // over 51,200 bytes we upload to the cdkd state bucket and submit a
    // `TemplateURL` instead. Anything over the 1 MB CloudFormation
    // TemplateURL limit is structurally unsubmittable — surface a clear
    // error so the user can finish manually (state has already been
    // written, so no rollback is needed).
    if (newBody.length > TEMPLATE_URL_LIMIT) {
      throw new Error(
        `Modified template is ${newBody.length} bytes, exceeds the ` +
          `CloudFormation UpdateStack TemplateURL limit (${TEMPLATE_URL_LIMIT}). ` +
          `cdkd state has already been written; retire the stack manually with ` +
          `(1) shrink the template, then (2) UpdateStack with Retain policies, ` +
          `(3) DeleteStack — or split the stack and retry.`
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
        await cfnClient.send(
          new UpdateStackCommand({
            StackName: cfnStackName,
            ...updateInput,
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
    } finally {
      if (s3Cleanup) {
        // Cleanup is best-effort: a leaked transient template object costs
        // pennies and lives under the explicitly-named `cdkd-migrate-tmp/`
        // prefix, so a stale object is easy to identify and reap manually.
        // The retire flow's success/failure is governed by CFn, not by S3.
        try {
          await s3Cleanup();
        } catch (cleanupErr) {
          const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          logger.warn(
            `Failed to delete temporary template upload from '${stateBucket}'. ` +
              `Clean up manually under prefix '${MIGRATE_TMP_PREFIX}/'. Cause: ${msg}`
          );
        }
      }
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

  let modified = false;
  const resources = parsed['Resources'] as Record<string, unknown>;
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
  return { body: stringifyCfnTemplate(parsed, format), modified, format };
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
