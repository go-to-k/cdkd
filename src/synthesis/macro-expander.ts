import { randomUUID } from 'node:crypto';
import {
  type Capability,
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  GetTemplateCommand,
  waitUntilChangeSetCreateComplete,
} from '@aws-sdk/client-cloudformation';
import {
  CFN_TEMPLATE_BODY_LIMIT,
  CFN_TEMPLATE_URL_LIMIT,
  type CfnUploadS3ClientOpts,
  uploadCfnTemplate,
} from '../cli/upload-cfn-template.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import { MacroExpansionError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';
import { containsMacro, enumerateMacros } from './macro-detector.js';

/**
 * Options threaded into {@link expandMacros}.
 *
 * `region` selects the CloudFormation API endpoint (and, structurally,
 * the partition / account context for any same-region custom macro
 * Lambdas). `stateBucket` is reused as the transient template storage
 * for templates larger than the inline `TemplateBody` ceiling (51,200
 * bytes) — see {@link uploadCfnTemplate}.
 *
 * `cfnClient` and `s3ClientOpts` are escape hatches for unit tests
 * (mock client) and the production STS-assume-role path (forwarding
 * the same credentials cdkd already resolved at command startup).
 */
export interface ExpandMacrosOptions {
  region: string;
  stateBucket: string;
  cfnClient?: CloudFormationClient;
  s3ClientOpts?: CfnUploadS3ClientOpts;
  /**
   * Maximum total wait for the transient `CreateChangeSet` to settle.
   * Defaults to 10 minutes per the design — SAM expansion typically
   * completes in 30-60s but the first-ever call against a fresh
   * account pays a cold-start on the SAM macro Lambda layer.
   */
  waiterMaxWaitSeconds?: number;
}

/**
 * Empirical verification (2026-05-23, us-east-1):
 *
 * Q1: `CreateChangeSet --change-set-type CREATE` against a non-existent
 *     stack name WITH `Transform: ['AWS::Serverless-2016-10-31']` and
 *     `Capabilities: ['CAPABILITY_AUTO_EXPAND','CAPABILITY_NAMED_IAM',
 *     'CAPABILITY_IAM']` is ACCEPTED. CFn auto-creates the stack in
 *     `REVIEW_IN_PROGRESS` and returns `Id` + `StackId`.
 *
 * Q2: `GetTemplate --change-set-name X --template-stage Processed`
 *     against the un-executed CREATE-type changeset returns the
 *     POST-EXPANSION template. **The `TemplateBody` field is returned
 *     as a parsed object (not a string) when the source body was JSON.**
 *     This is undocumented but consistent with AWS SDK behavior across
 *     services — the typed return shape is `string | undefined` but the
 *     wire shape may be either. The expander handles both.
 *
 * Q3: `DeleteStack` against a stack in `REVIEW_IN_PROGRESS` succeeds
 *     immediately with no prerequisites — the stack disappears from
 *     `DescribeStacks` within ~5 seconds. No need to execute the
 *     changeset, wait for a min lifetime, etc.
 *
 * Q4: Templates that declare `Parameters` without `Default` REQUIRE
 *     parameter values on `CreateChangeSet`. **Stripping the Parameters
 *     block fails** if any resource still carries a `Ref: <ParamName>`
 *     (`Template format error: Unresolved resource dependencies`). The
 *     expander passes **synthetic placeholder values** for every
 *     parameter (template Default when present, else
 *     `cdkd-macro-expand-placeholder`). The `Ref: <ParamName>` survives
 *     the expansion intact — CFn does NOT substitute parameter values
 *     into the Processed-stage template, only into the post-execution
 *     template — so cdkd's own resolver picks them up later with the
 *     real values.
 */
const EMPIRICAL_FINDINGS_VERIFIED_2026_05_23 = true;
void EMPIRICAL_FINDINGS_VERIFIED_2026_05_23;

const DEFAULT_WAITER_SECONDS = 600; // 10 min — see design §3 Approach A
const PARAMETER_PLACEHOLDER = 'cdkd-macro-expand-placeholder';
const CAPABILITIES: Capability[] = [
  'CAPABILITY_AUTO_EXPAND',
  'CAPABILITY_NAMED_IAM',
  'CAPABILITY_IAM',
];

/**
 * Expand CloudFormation macros / `Fn::Transform` blocks in a synth
 * template via a transient CloudFormation changeset round-trip.
 *
 * The flow (per design §3 Approach A):
 *
 *  1. Mint a unique transient stack name (`cdkd-macro-expand-<id>`).
 *  2. Build parameter values for every declared template Parameter
 *     (template Default if present; synthetic placeholder otherwise).
 *     CFn does NOT substitute these into the Processed-stage
 *     template, but it requires them for the changeset to be valid.
 *  3. `CreateChangeSet --change-set-type CREATE` with
 *     `Capabilities: ['CAPABILITY_AUTO_EXPAND','CAPABILITY_NAMED_IAM',
 *     'CAPABILITY_IAM']`. Use inline `TemplateBody` when <= 51,200
 *     bytes; upload to the cdkd state bucket and pass `TemplateURL`
 *     when between 51,200 bytes and 1 MB; refuse outright when > 1 MB
 *     (CFn `TemplateURL` ceiling).
 *  4. Wait for `ChangeSetStatus: CREATE_COMPLETE`. On `FAILED`, surface
 *     the `StatusReason` verbatim — typically the macro Lambda's error
 *     message, or "no transforms found" for a template with an empty
 *     `Transform` array.
 *  5. `GetTemplate --template-stage Processed` returns the
 *     post-expansion template.
 *  6. Cleanup in `finally`: `DeleteChangeSet` + `DeleteStack`
 *     (idempotent — both tolerate `*NotFound` errors). The transient
 *     S3 upload (if any) is cleaned up too.
 *  7. Re-check `containsMacro(expanded)` and reject the multi-stage
 *     case — cdkd v1 does not support templates whose expansion emits
 *     ANOTHER macro reference. CFn handles single-step expansion
 *     natively; second-round expansion is intentionally out of scope.
 *
 * Returns the expanded template as a parsed `CloudFormationTemplate`.
 * Throws {@link MacroExpansionError} on any failure mode. Cleanup
 * failures during the `finally` block log at WARN but do not mask the
 * outer success / error.
 */
export async function expandMacros(
  template: unknown,
  opts: ExpandMacrosOptions
): Promise<CloudFormationTemplate> {
  const logger = getLogger().child('MacroExpander');

  if (!containsMacro(template)) {
    // Defensive: the synthesizer is supposed to gate on
    // `containsMacro` before calling here, but a misconfigured caller
    // would otherwise pay the cost of a transient changeset for no
    // reason. Returning the template unchanged is the right no-op.
    return template as CloudFormationTemplate;
  }

  const macros = enumerateMacros(template);
  logger.debug(
    `Macro expansion: detected transforms [${macros.join(', ')}], starting CFn round-trip...`
  );

  const transientStackName = `cdkd-macro-expand-${randomUUID().slice(0, 8)}`;
  const changeSetName = `${transientStackName}-changeset`;
  const region = opts.region;
  const stateBucket = opts.stateBucket;
  const waiterMaxWaitSeconds = opts.waiterMaxWaitSeconds ?? DEFAULT_WAITER_SECONDS;

  const ownsClient = opts.cfnClient === undefined;
  const cfn = opts.cfnClient ?? new CloudFormationClient({ region });

  // Serialize the template (the inline / upload split runs on the
  // serialized bytes, and we always need to send it over the wire).
  const serialized = JSON.stringify(template);

  // Parameter placeholders: per Q4 above, declared no-Default params
  // need values for the changeset to even validate. CFn does NOT
  // substitute these into the Processed-stage template.
  const parameters = buildParameterValues(template);

  // Pick inline vs TemplateURL based on the wire size.
  let templateInput: { TemplateBody: string } | { TemplateURL: string };
  let s3Cleanup: (() => Promise<void>) | undefined;

  try {
    if (serialized.length > CFN_TEMPLATE_URL_LIMIT) {
      throw new MacroExpansionError(
        `Template is ${serialized.length} bytes, which exceeds CloudFormation's ` +
          `${CFN_TEMPLATE_URL_LIMIT}-byte TemplateURL ceiling for macro expansion. ` +
          `Shrink inline payloads (move inline lambda.Code.ZipFile to ` +
          `lambda.Code.fromAsset, etc.) or split the stack before retrying.`
      );
    }
    if (serialized.length <= CFN_TEMPLATE_BODY_LIMIT) {
      templateInput = { TemplateBody: serialized };
    } else {
      logger.debug(
        `Macro expansion: template is ${serialized.length} bytes (over ${CFN_TEMPLATE_BODY_LIMIT} ` +
          `inline limit) — uploading to state bucket '${stateBucket}' for TemplateURL.`
      );
      const uploaded = await uploadCfnTemplate({
        bucket: stateBucket,
        body: serialized,
        stackName: transientStackName,
        format: 'json',
        ...(opts.s3ClientOpts && { s3ClientOpts: opts.s3ClientOpts }),
      });
      templateInput = { TemplateURL: uploaded.url };
      s3Cleanup = uploaded.cleanup;
    }

    // ---- CreateChangeSet ----
    try {
      await cfn.send(
        new CreateChangeSetCommand({
          StackName: transientStackName,
          ChangeSetName: changeSetName,
          ChangeSetType: 'CREATE',
          ...templateInput,
          Capabilities: CAPABILITIES,
          ...(parameters.length > 0 && { Parameters: parameters }),
        })
      );
    } catch (err) {
      throw new MacroExpansionError(
        `CloudFormation rejected the macro-expansion changeset: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      );
    }

    // ---- Wait for the changeset to settle ----
    // The SDK waiter throws on FAILED; we catch and surface the
    // StatusReason via a follow-up DescribeChangeSet.
    let waiterFailed = false;
    try {
      await waitUntilChangeSetCreateComplete(
        { client: cfn, maxWaitTime: waiterMaxWaitSeconds },
        { StackName: transientStackName, ChangeSetName: changeSetName }
      );
    } catch (waiterErr) {
      waiterFailed = true;
      // Fall through — `describe` below will surface the actual
      // StatusReason (almost always more useful than the generic
      // waiter error). Only re-throw on describe failure.
      void waiterErr;
    }

    if (waiterFailed) {
      const desc = await cfn
        .send(
          new DescribeChangeSetCommand({
            StackName: transientStackName,
            ChangeSetName: changeSetName,
          })
        )
        .catch(() => undefined);
      const reason = desc?.StatusReason ?? 'unknown (DescribeChangeSet failed)';
      const status = desc?.Status ?? 'UNKNOWN';
      throw new MacroExpansionError(
        `CloudFormation macro expansion failed (status=${status}): ${reason}`
      );
    }

    // ---- GetTemplate Processed ----
    const tpl = await cfn.send(
      new GetTemplateCommand({
        StackName: transientStackName,
        ChangeSetName: changeSetName,
        TemplateStage: 'Processed',
      })
    );
    if (tpl.TemplateBody === undefined || tpl.TemplateBody === null) {
      throw new MacroExpansionError(
        `CloudFormation returned no Processed-stage template body for the ` +
          `macro-expansion changeset. This typically indicates a CFn-side ` +
          `regression — re-run, and if the failure persists open an issue ` +
          `with the transforms involved: [${macros.join(', ')}].`
      );
    }
    const expanded = parseTemplateBody(tpl.TemplateBody);

    // ---- Multi-stage detection: reject ----
    if (containsMacro(expanded)) {
      const inner = enumerateMacros(expanded);
      throw new MacroExpansionError(
        `Macro expansion produced a template that still contains macros ` +
          `[${inner.join(', ')}]. Multi-stage macros (a macro whose expansion ` +
          `emits another macro reference) are intentionally out of scope in ` +
          `cdkd v1 — see https://github.com/go-to-k/cdkd/issues/463. ` +
          `If you need this pattern, manually pre-expand the template and ` +
          `deploy the result.`
      );
    }

    logger.debug(
      `Macro expansion: success — ` +
        `${Object.keys(expanded.Resources ?? {}).length} resources after expansion.`
    );
    return expanded;
  } finally {
    // ---- Cleanup: DeleteChangeSet + DeleteStack ----
    // Both are idempotent (NotFound is silently OK). We want this to
    // run on every exit path so a CFn-side or cdkd-side failure does
    // not leave a transient `cdkd-macro-expand-*` stack behind. Log
    // each failure at WARN so a stale stack is at least visible to
    // the operator.
    try {
      await cfn.send(
        new DeleteChangeSetCommand({
          StackName: transientStackName,
          ChangeSetName: changeSetName,
        })
      );
    } catch (cleanupErr) {
      logger.warn(
        `Failed to delete transient macro-expand changeset ` +
          `'${changeSetName}': ${formatErr(cleanupErr)}. ` +
          `Clean up manually via 'aws cloudformation delete-change-set ` +
          `--stack-name ${transientStackName} --change-set-name ${changeSetName}'.`
      );
    }
    try {
      await cfn.send(new DeleteStackCommand({ StackName: transientStackName }));
    } catch (cleanupErr) {
      logger.warn(
        `Failed to delete transient macro-expand stack ` +
          `'${transientStackName}': ${formatErr(cleanupErr)}. ` +
          `Clean up manually via 'aws cloudformation delete-stack ` +
          `--stack-name ${transientStackName}'.`
      );
    }
    if (s3Cleanup) {
      try {
        await s3Cleanup();
      } catch (cleanupErr) {
        logger.warn(
          `Failed to delete transient macro-expand template upload from ` +
            `state bucket: ${formatErr(cleanupErr)}.`
        );
      }
    }
    if (ownsClient) {
      cfn.destroy();
    }
  }
}

/**
 * Build the `Parameters` list passed to `CreateChangeSet`. CFn requires
 * a value for every declared parameter; we fall back to a synthetic
 * placeholder when the template has no Default. Per the empirical
 * verification above, these values do NOT leak into the Processed
 * template (CFn keeps `Ref: <param>` intact for cdkd's own resolver to
 * substitute later with the real values).
 */
function buildParameterValues(
  template: unknown
): { ParameterKey: string; ParameterValue: string }[] {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return [];
  }
  const params = (template as Record<string, unknown>)['Parameters'];
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return [];
  }
  const out: { ParameterKey: string; ParameterValue: string }[] = [];
  for (const [key, def] of Object.entries(params as Record<string, unknown>)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
    const defDefault = (def as Record<string, unknown>)['Default'];
    out.push({ ParameterKey: key, ParameterValue: stringifyParamDefault(defDefault) });
  }
  return out;
}

/**
 * Coerce a CFn Parameter Default to the string `CreateChangeSet`
 * requires. Strings / numbers / booleans pass through verbatim; object-
 * shaped defaults (rare — `CommaDelimitedList`-style declarations
 * sometimes carry array Defaults) are JSON-stringified; undefined /
 * null fall back to the synthetic placeholder. The actual value does
 * NOT leak into the Processed-stage template (CFn preserves
 * `Ref: <param>` intact through expansion — see empirical findings).
 */
function stringifyParamDefault(value: unknown): string {
  if (value === undefined || value === null) return PARAMETER_PLACEHOLDER;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return PARAMETER_PLACEHOLDER;
  }
}

/**
 * Parse the `TemplateBody` field returned by `GetTemplate`. The SDK
 * types it as `string | undefined`, but empirical observation shows
 * the wire shape may be either a string (for YAML or some pre-parsed
 * cases) or a parsed object (for JSON templates against
 * `--template-stage Processed`). Handle both.
 */
function parseTemplateBody(body: unknown): CloudFormationTemplate {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as CloudFormationTemplate;
    } catch (err) {
      // GetTemplate Processed-stage emits JSON for JSON-source templates
      // and YAML for YAML-source ones. cdkd's CDK app outputs JSON, so a
      // non-JSON return is unexpected; surface as MacroExpansionError so
      // the caller sees the wire shape.
      throw new MacroExpansionError(
        `CloudFormation returned a non-JSON Processed-stage template body. ` +
          `cdkd's macro-expansion path only supports JSON-shaped synth ` +
          `templates (CDK apps emit JSON by default). Cause: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      );
    }
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as CloudFormationTemplate;
  }
  throw new MacroExpansionError(
    `CloudFormation returned an unexpected TemplateBody shape (${typeof body}). ` +
      `Expected a JSON string or parsed object.`
  );
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
