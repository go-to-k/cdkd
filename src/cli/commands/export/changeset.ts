import { randomUUID } from 'node:crypto';
import { displayAwsMessage } from '../../../utils/display-safe.js';
import {
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  ExecuteChangeSetCommand,
  DeleteChangeSetCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  waitUntilChangeSetCreateComplete,
  waitUntilStackImportComplete,
  waitUntilStackUpdateComplete,
  type ResourceToImport,
  type Parameter,
} from '@aws-sdk/client-cloudformation';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import {
  CFN_TEMPLATE_BODY_LIMIT,
  CFN_TEMPLATE_URL_LIMIT,
  findLargeInlineResources,
  uploadCfnTemplate,
  type CfnUploadS3ClientOpts,
} from '../../upload-cfn-template.js';
import { stringifyCfnTemplate, type TemplateFormat } from '../../yaml-cfn.js';
import { quotedOrNotShown, rowIdent, safeDetail } from './render.js';
import { type ImportPlanEntry } from './plan-types.js';

export interface ChangeSetUploadOpts {
  /**
   * cdkd state bucket reused as transient template storage when the
   * serialized template exceeds the inline 51,200-byte TemplateBody
   * limit. Both phase-1 (IMPORT) and phase-2 (UPDATE) changesets share
   * this routing so the contract is symmetric — a stack that needs the
   * upload path in phase-1 will need it in phase-2 too, and the inline
   * path stays cheap (no S3 round-trip) for the common case.
   */
  stateBucket: string;
  /**
   * AWS auth context forwarded to the S3 client that performs the
   * transient upload + delete. Threaded from the export CLI's
   * `--profile` resolution so the upload uses the same identity that
   * resolved cdkd state.
   */
  s3ClientOpts?: CfnUploadS3ClientOpts;
}

/**
 * Decide whether to submit a CFn changeset's template inline via
 * `TemplateBody` or upload it to the cdkd state bucket and submit via
 * `TemplateURL`. Returns a discriminated outcome:
 *
 *   - `kind: 'inline'`  — payload <= 51,200 bytes; pass `TemplateBody`
 *     directly. No S3 round-trip; the caller's `finally` cleanup is a
 *     no-op.
 *   - `kind: 'url'`     — payload in (51,200, 1,048,576] bytes; helper
 *     uploaded to `cdkd-migrate-tmp/<stackName>/<ts>.{json,yaml}`. The
 *     caller MUST invoke the returned `cleanup` in a `finally` so the
 *     transient object is deleted regardless of CFn success / failure.
 *
 * Payloads > 1,048,576 bytes throw pre-flight (the 1 MB ceiling applies
 * to every CFn API surface; no S3 indirection helps). The error names the
 * top inline-payload contributors so the user knows what to shrink.
 *
 * `phaseLabel` is interpolated into the pre-flight error so the user
 * sees which phase tripped the ceiling ("phase-1 IMPORT" vs "phase-2
 * UPDATE").
 *
 * When `uploadOpts` is undefined (e.g. unit tests that exercise only the
 * inline path), templates over the inline limit throw with a clear
 * "no upload bucket configured" error rather than silently failing on a
 * downstream CFn rejection.
 *
 * `templateFormat` (default `'json'`) drives the transient S3 object's
 * key suffix + Content-Type so YAML-authored templates stay YAML on the
 * wire (`.yaml` / `application/x-yaml`).
 */
/* Exported for unit testing. Internal to the export flow otherwise. */
export async function selectChangeSetTemplateSource(
  template: Record<string, unknown>,
  templateBody: string,
  uploadOpts: ChangeSetUploadOpts | undefined,
  stackName: string,
  phaseLabel: string,
  templateFormat: TemplateFormat = 'json'
): Promise<
  | { kind: 'inline'; templateBody: string; cleanup: () => Promise<void> }
  | { kind: 'url'; templateUrl: string; cleanup: () => Promise<void> }
> {
  const logger = getLogger();
  if (templateBody.length <= CFN_TEMPLATE_BODY_LIMIT) {
    return { kind: 'inline', templateBody, cleanup: async () => undefined };
  }
  if (templateBody.length > CFN_TEMPLATE_URL_LIMIT) {
    // Pre-flight refusal: the 1 MB ceiling applies to every CFn API
    // surface, so no S3 indirection helps. Surface the heaviest
    // contributors (typically inline Code.ZipFile Lambdas) so the user
    // knows what to shrink — `lambda.Code.fromAsset(...)` is the
    // typical fix for the >1 MB common case; otherwise split the stack
    // via nested `AWS::CloudFormation::Stack` resources.
    const offenders = findLargeInlineResources(template);
    let detail = '';
    if (offenders.length > 0) {
      const lines = offenders
        .slice(0, 10)
        .map(
          (o) =>
            `  - ${rowIdent(o.logicalId)} (${rowIdent(o.resourceType)}): ` +
            `~${o.approxBytes} bytes`
        );
      detail = `\nLargest inline payloads (move these to lambda.Code.fromAsset or split into nested stacks):\n${lines.join('\n')}`;
      if (offenders.length > 10) {
        detail += `\n  (and ${offenders.length - 10} more above the 4096-byte threshold)`;
      }
    }
    throw new Error(
      `${phaseLabel} template is ${templateBody.length} bytes, over the ` +
        `${CFN_TEMPLATE_URL_LIMIT}-byte CloudFormation TemplateURL limit. Templates that ` +
        `large cannot be submitted to CloudFormation — shrink inline payloads (e.g. ` +
        `inline Lambda Code.ZipFile larger than ~4 KB → switch to lambda.Code.fromAsset) ` +
        `or split the stack into nested AWS::CloudFormation::Stack resources.${detail}`
    );
  }
  if (!uploadOpts) {
    throw new Error(
      `${phaseLabel} template is ${templateBody.length} bytes, over the inline ` +
        `${CFN_TEMPLATE_BODY_LIMIT}-byte TemplateBody limit, but no upload bucket was ` +
        `provided to selectChangeSetTemplateSource — pass uploadOpts to enable the ` +
        `TemplateURL upload path.`
    );
  }
  logger.info(
    `  Template is ${templateBody.length} bytes (over ${CFN_TEMPLATE_BODY_LIMIT} inline limit) — ` +
      `uploading to state bucket ${quotedOrNotShown(uploadOpts.stateBucket)}.`
  );
  const uploaded = await uploadCfnTemplate({
    bucket: uploadOpts.stateBucket,
    body: templateBody,
    stackName,
    format: templateFormat,
    ...(uploadOpts.s3ClientOpts && { s3ClientOpts: uploadOpts.s3ClientOpts }),
  });
  return { kind: 'url', templateUrl: uploaded.url, cleanup: uploaded.cleanup };
}

/**
 * Best-effort wrapper around the `cleanup` callback returned by
 * {@link selectChangeSetTemplateSource}. Mirrors the warn-on-failure
 * pattern from `prepareCloudFormationStackRetirement` so a stranded `cdkd-migrate-tmp/`
 * object never blocks the calling command — it lives under an obviously
 * named prefix and can be reaped manually.
 */
export async function runTemplateUploadCleanup(
  cleanup: () => Promise<void>,
  bucket: string
): Promise<void> {
  const logger = getLogger();
  try {
    await cleanup();
  } catch (cleanupErr) {
    const msg = describeAwsFailure(cleanupErr).detail;
    logger.warn(
      `Failed to delete temporary template upload from ${quotedOrNotShown(bucket)}. ` +
        `Clean up manually under prefix 'cdkd-migrate-tmp/'. Cause: ${safeDetail(msg)}`
    );
  }
}

export async function executeImportChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  plan: ImportPlanEntry[],
  parameters: Parameter[],
  templateFormat: TemplateFormat = 'json',
  uploadOpts?: ChangeSetUploadOpts
): Promise<void> {
  const resourcesToImport: ResourceToImport[] = plan.map((entry) => ({
    ResourceType: entry.resourceType,
    LogicalResourceId: entry.logicalId,
    ResourceIdentifier: entry.resourceIdentifier,
  }));
  await submitImportChangeSet(
    cfnClient,
    stackName,
    template,
    resourcesToImport,
    parameters,
    templateFormat,
    uploadOpts
  );
}

/**
 * Submit one CloudFormation IMPORT changeset for `stackName`, awaiting
 * both `CreateChangeSet` and `ExecuteChangeSet` to completion. Accepts a
 * pre-built `resourcesToImport` array (caller-controlled) so non-leaf
 * parents in the per-stack IMPORT loop (issue #464 PR B2) can pass a
 * mixed list of leaf resources AND `AWS::CloudFormation::Stack` adoption
 * entries (with `ResourceIdentifier: { StackId: <child-CFn-arn> }`).
 *
 * Extracted from {@link executeImportChangeSet} so the leaf-only callers
 * (top-level export, single-stack flow) and the non-leaf-parent caller
 * (nested per-stack loop) share the exact same submit + wait + cleanup
 * code path — no risk of divergence on retry shape, changeset cleanup
 * on failure, or transient-upload reaping.
 *
 * Exported for unit testing.
 */
export async function submitImportChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  resourcesToImport: ResourceToImport[],
  parameters: Parameter[],
  templateFormat: TemplateFormat = 'json',
  uploadOpts?: ChangeSetUploadOpts
): Promise<void> {
  const logger = getLogger();
  const changeSetName = `cdkd-migrate-${Date.now()}`;
  const templateBody = stringifyCfnTemplate(template, templateFormat);

  logger.info(
    `Creating IMPORT changeset '${changeSetName}' for stack ${quotedOrNotShown(stackName)} ` +
      `(${resourcesToImport.length} resource(s), ${templateBody.length} bytes)...`
  );

  // Route by serialized size: <= 51,200 inline TemplateBody, otherwise
  // upload to the cdkd state bucket and submit via TemplateURL. Templates
  // > 1 MB pre-flight refuse with the offending-resources list.
  const source = await selectChangeSetTemplateSource(
    template,
    templateBody,
    uploadOpts,
    stackName,
    'Filtered phase-1 IMPORT',
    templateFormat
  );
  try {
    try {
      await cfnClient.send(
        new CreateChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
          ChangeSetType: 'IMPORT',
          ...(source.kind === 'inline'
            ? { TemplateBody: source.templateBody }
            : { TemplateURL: source.templateUrl }),
          ResourcesToImport: resourcesToImport,
          ...(parameters.length > 0 && { Parameters: parameters }),
          // CDK templates routinely require CAPABILITY_IAM /
          // CAPABILITY_NAMED_IAM. Forward both so the user does not have to
          // re-discover and re-pass them.
          Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
        })
      );
    } catch (err) {
      const msg = describeAwsFailure(err).detail;
      throw new Error(`Failed to create IMPORT changeset: ${displayAwsMessage(msg)}`);
    }

    try {
      await waitUntilChangeSetCreateComplete(
        // Changeset creation settles in seconds; the SDK default cadence (30s
        // first poll) would dominate the wait (issue #1291 item 5).
        { client: cfnClient, maxWaitTime: 600, minDelay: 2, maxDelay: 5 },
        { StackName: stackName, ChangeSetName: changeSetName }
      );
    } catch (err) {
      // CreateChangeSet returns FAILED with a StatusReason on validation
      // problems (template error, identifier mismatch, etc.). Fetch the
      // reason and surface it before re-throwing.
      try {
        const desc = await cfnClient.send(
          new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
        );
        const reason = desc.StatusReason ?? 'unknown';
        // Clean up the failed changeset so the next attempt is not blocked
        // by a REVIEW_IN_PROGRESS phantom stack.
        await cfnClient
          .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
          .catch(() => {});
        // CloudFormation's reason can QUOTE the submitted ResourceIdentifier,
        // i.e. a state record's physical id, back verbatim.
        throw new Error(`IMPORT changeset FAILED: ${displayAwsMessage(reason)}`);
      } catch (innerErr) {
        if (innerErr instanceof Error && innerErr.message.startsWith('IMPORT changeset FAILED')) {
          throw innerErr;
        }
        throw err;
      }
    }

    // Execute + wait must clean up the changeset on failure too: if the
    // import errors after CreateChangeSet succeeded, the changeset sticks
    // around and a subsequent run hits `assertCfnStackAbsent`'s "stack
    // already exists" path (CFn parks the stack in REVIEW_IN_PROGRESS).
    // We delete the changeset best-effort and let the original error
    // propagate.
    logger.info(`Executing IMPORT changeset...`);
    try {
      await cfnClient.send(
        new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
      );
      await waitUntilStackImportComplete(
        // Minutes-scale CFn operation: 10s polling is dense enough and stays
        // within the repo-wide waiter cap (issue #1291 item 5).
        { client: cfnClient, maxWaitTime: 3600, minDelay: 5, maxDelay: 10 },
        { StackName: stackName }
      );
    } catch (err) {
      // On IMPORT failure, fetch the per-resource failure reasons from
      // CFn stack events so the user can see WHICH resource failed and
      // WHY. The waiter only reports the high-level rollback state.
      const failureSummary = await collectImportFailureSummary(cfnClient, stackName).catch(
        () => ''
      );
      await cfnClient
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
        .catch(() => {});
      if (failureSummary) {
        throw new Error(`IMPORT changeset failed:\n${failureSummary}`, { cause: err });
      }
      throw err;
    }
  } finally {
    // Best-effort delete of the transient template upload, if any. CFn has
    // already copied the template into its internal storage during the
    // synchronous CreateChangeSet call, so the S3 object is no longer
    // needed regardless of whether the wait / execute steps succeeded.
    // The cleanup callback for the inline path is a no-op, so this is
    // always cheap to invoke.
    await runTemplateUploadCleanup(source.cleanup, uploadOpts?.stateBucket ?? '');
  }
}

/**
 * Fetch the most recent CFn stack events and extract the per-resource
 * failure reasons. Surfaced when `waitUntilStackImportComplete`'s waiter
 * reports FAILURE — the waiter itself only reports the high-level
 * rollback state, so the actionable detail is in the events.
 *
 * Returns up to 5 distinct failed resources, formatted as
 * `<LogicalId> (<Type>): <ResourceStatusReason>` per line. Returns an
 * empty string when DescribeStackEvents itself fails or no failure
 * events are found.
 */
async function collectImportFailureSummary(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string
): Promise<string> {
  const resp = await cfnClient.send(new DescribeStackEventsCommand({ StackName: stackName }));
  const events = resp.StackEvents ?? [];
  // Walk events newest-first (CFn returns them in reverse chronological
  // order) and collect distinct per-resource failure entries.
  const failures: { logicalId: string; type: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.ResourceStatus || !e.ResourceStatus.endsWith('FAILED')) continue;
    if (!e.LogicalResourceId) continue;
    if (seen.has(e.LogicalResourceId)) continue;
    seen.add(e.LogicalResourceId);
    failures.push({
      logicalId: e.LogicalResourceId,
      type: e.ResourceType ?? '<unknown>',
      reason: e.ResourceStatusReason ?? '<no reason reported>',
    });
    if (failures.length >= 5) break;
  }
  if (failures.length === 0) return '';
  // One row per failure, so each field is kept to its row: a reason can quote a
  // state record's physical id back verbatim.
  return failures
    .map(
      (f) => `  - ${rowIdent(f.logicalId)} (${rowIdent(f.type)}): ${displayAwsMessage(f.reason)}`
    )
    .join('\n');
}

/**
 * Flip a CFn stack's status from `IMPORT_COMPLETE` to `UPDATE_COMPLETE`
 * via a no-op `UpdateStack` with a stack-level tag-only change. Used
 * after each non-root stack's Phase 1A IMPORT (and after each non-leaf
 * parent's Phase 1B IMPORT) so the stack can be referenced as a nested
 * member by its own parent's later Phase 1B adoption.
 *
 * Why this is needed: AWS's "Nest an existing stack" IMPORT changeset
 * validation rejects child stacks in `IMPORT_COMPLETE` status with
 * `Stack <arn> is not in an importable status, current stack status is
 * IMPORT_COMPLETE`. The accepted statuses for nesting are
 * `CREATE_COMPLETE` and `UPDATE_COMPLETE`. A no-op tag-only `UpdateStack`
 * with `UsePreviousTemplate: true` flips the status without mutating any
 * resources: the existing template is re-applied verbatim, only the
 * stack-level Tags collection changes (the timestamp-bearing
 * `cdkd:nested-export-flip` tag is the only delta). This is the canonical
 * AWS workaround for the IMPORT_COMPLETE → UPDATE_COMPLETE transition.
 *
 * Idempotency: each invocation uses a fresh ISO 8601 timestamp PLUS an
 * 8-char random UUID slice as the tag value so AWS never returns "No
 * updates are to be performed" (which would leave the stack stuck in
 * `IMPORT_COMPLETE`). The timestamp alone is insufficient — two rapid
 * back-to-back flips on the same stack within the same millisecond (e.g.
 * a retry after a transient SDK error) would otherwise emit identical
 * values; the UUID suffix guarantees uniqueness regardless of clock
 * resolution. The tag accumulates across retries — harmless and easy to
 * reap manually under the `cdkd:` prefix.
 *
 * `parameters` must be the SAME Parameters the stack was just IMPORTed
 * with: a `UsePreviousTemplate: true` update on a stack that declares
 * Parameters (especially no-`Default` ones fed by a parent-side `Ref`)
 * is rejected by CFn with `Parameters: [X] must have values` unless every
 * Parameter is re-supplied. We re-send the resolved values verbatim (a
 * true no-op — same template, same params, only the flip Tag changes).
 * Empty array = the stack has no Parameters, so the field is omitted.
 *
 * Exported for unit testing.
 */
export async function flipStackToUpdateComplete(
  cfnClient: AwsClients['cloudFormation'],
  cfnStackName: string,
  parameters: Parameter[]
): Promise<void> {
  await cfnClient.send(
    new UpdateStackCommand({
      StackName: cfnStackName,
      UsePreviousTemplate: true,
      // Re-supply the stack's Parameters (no-op values) so the
      // UsePreviousTemplate update validates against a template that
      // declares no-`Default` Parameters. Omitted when the stack has none.
      ...(parameters.length > 0 && { Parameters: parameters }),
      Tags: [
        {
          Key: 'cdkd:nested-export-flip',
          Value: `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`,
        },
      ],
      // Preserve all the standard cdkd export Capabilities (CDK templates
      // routinely declare IAM resources). The previous template's
      // capabilities are NOT auto-inherited — the SDK call needs them
      // explicitly or CFn rejects with `requires capabilities: [...]`.
      Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
    })
  );
  await waitUntilStackUpdateComplete(
    // Minutes-scale CFn operation: 10s polling is dense enough and stays
    // within the repo-wide waiter cap (issue #1291 item 5).
    { client: cfnClient, maxWaitTime: 1800, minDelay: 5, maxDelay: 10 },
    { StackName: cfnStackName }
  );
}

/**
 * Fetch a CFn stack's CURRENT template body via the CFn `GetTemplate`
 * `Processed` stage. Used by the non-leaf-parent branch of
 * {@link runPerStackImportLoop} to satisfy the AWS-docs "Nest an existing
 * stack" template-match requirement: the parent's
 * `AWS::CloudFormation::Stack.Properties.TemplateURL` must point at the
 * child stack's actual current template for the IMPORT changeset to
 * validate. Reading via `GetTemplate` (vs. the local cdk.out file) is
 * the only way to guarantee the AWS-side stored template byte-shape —
 * AWS may have normalized whitespace, parameter defaults, or intrinsic
 * shapes during the just-completed leaf IMPORT.
 *
 * `Processed` stage returns the template AWS has on file post-IMPORT
 * (with any macro / serverless-transform expansion already applied),
 * which is exactly what the parent's nested-stack row must reference.
 *
 * Exported for unit testing.
 */
export async function fetchCfnStackTemplate(
  cfnClient: AwsClients['cloudFormation'],
  cfnStackName: string
): Promise<string> {
  const resp = await cfnClient.send(
    new GetTemplateCommand({ StackName: cfnStackName, TemplateStage: 'Processed' })
  );
  if (!resp.TemplateBody) {
    throw new Error(
      `CFn GetTemplate returned no body for stack ${quotedOrNotShown(cfnStackName)}. ` +
        `The just-IMPORTed child stack may be in an unexpected state; ` +
        `check the CloudFormation console.`
    );
  }
  return resp.TemplateBody;
}

/**
 * Phase 2 of the 2-phase migration: a CFn UPDATE changeset that ADDs the
 * non-importable resources (`Custom::*`) to the just-created stack. CFn
 * diffs against the phase-1 stack state, sees the new resources, and
 * CREATEs them — which invokes each Custom Resource's backing Lambda
 * onCreate handler.
 *
 * Failure semantics: caller catches and surfaces a clear recovery path
 * (cdkd state is intentionally NOT deleted between phases, so a phase-2
 * failure leaves a recoverable state).
 */
export async function executeUpdateChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  parameters: Parameter[],
  templateFormat: TemplateFormat = 'json',
  uploadOpts?: ChangeSetUploadOpts
): Promise<void> {
  const logger = getLogger();
  const changeSetName = `cdkd-phase2-${Date.now()}`;
  const templateBody = stringifyCfnTemplate(template, templateFormat);

  logger.info(
    `Creating UPDATE changeset '${changeSetName}' for phase 2 ` +
      `(${templateBody.length} bytes)...`
  );

  // Same size routing as phase-1 IMPORT: <= 51,200 inline; > 51,200 and
  // <= 1,048,576 via TemplateURL upload; > 1,048,576 pre-flight refuse.
  // Phase-2 is the typical wire-format limit trigger because it submits
  // the FULL synth template (phase-1 only submits the importable subset).
  const source = await selectChangeSetTemplateSource(
    template,
    templateBody,
    uploadOpts,
    stackName,
    'Phase-2 UPDATE',
    templateFormat
  );

  try {
    try {
      await cfnClient.send(
        new CreateChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
          ChangeSetType: 'UPDATE',
          ...(source.kind === 'inline'
            ? { TemplateBody: source.templateBody }
            : { TemplateURL: source.templateUrl }),
          ...(parameters.length > 0 && { Parameters: parameters }),
          Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
        })
      );
    } catch (err) {
      const msg = describeAwsFailure(err).detail;
      throw new Error(`Failed to create UPDATE changeset: ${displayAwsMessage(msg)}`);
    }

    try {
      await waitUntilChangeSetCreateComplete(
        // Changeset creation settles in seconds; the SDK default cadence (30s
        // first poll) would dominate the wait (issue #1291 item 5).
        { client: cfnClient, maxWaitTime: 600, minDelay: 2, maxDelay: 5 },
        { StackName: stackName, ChangeSetName: changeSetName }
      );
    } catch (err) {
      try {
        const desc = await cfnClient.send(
          new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
        );
        const reason = desc.StatusReason ?? 'unknown';
        await cfnClient
          .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
          .catch(() => {});
        // As on the IMPORT side: the reason can quote a recorded value back.
        throw new Error(`UPDATE changeset FAILED: ${displayAwsMessage(reason)}`);
      } catch (innerErr) {
        if (innerErr instanceof Error && innerErr.message.startsWith('UPDATE changeset FAILED')) {
          throw innerErr;
        }
        throw err;
      }
    }

    logger.info(`Executing UPDATE changeset...`);
    try {
      await cfnClient.send(
        new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
      );
      await waitUntilStackUpdateComplete(
        // Minutes-scale CFn operation: 10s polling is dense enough and stays
        // within the repo-wide waiter cap (issue #1291 item 5).
        { client: cfnClient, maxWaitTime: 3600, minDelay: 5, maxDelay: 10 },
        { StackName: stackName }
      );
    } catch (err) {
      await cfnClient
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
        .catch(() => {});
      throw err;
    }
  } finally {
    // Always run the upload cleanup (no-op for the inline path) so the
    // transient S3 object is removed regardless of CFn success / failure.
    await runTemplateUploadCleanup(source.cleanup, uploadOpts?.stateBucket ?? '');
  }
}
