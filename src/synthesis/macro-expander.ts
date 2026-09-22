import { randomUUID } from 'node:crypto';
import {
  type Capability,
  CloudFormationClient,
  CreateChangeSetCommand,
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
import type { Logger } from '../types/config.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import { MacroExpansionError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';
import {
  isListParameterType,
  SSM_PARAMETER_VALUE_PREFIX,
  ssmResolvedValueType,
} from '../utils/parameter-types.js';
import { containsMacro, enumerateMacros } from './macro-detector.js';
import { awsClientDefaults } from '../utils/aws-client-defaults.js';
import { displayAwsMessage, displaySafe } from '../utils/display-safe.js';

/**
 * A transform name comes from the TEMPLATE's own `Transform` / `Fn::Transform`
 * node, so every render of one goes through `displaySafe`, in thrown messages
 * and in the `debug` line alike
 * ([#3479](https://github.com/go-to-k/cdkd/issues/3479)). `displaySafe` neither
 * quotes nor truncates, so a legitimate `AWS::Serverless-2016-10-31` renders
 * byte-identically.
 *
 * Per ELEMENT rather than over the joined string, and the reason is FORMATTING
 * rather than safety — measured, because the first revision of this comment
 * claimed otherwise. `displaySafe` replaces globally, so a mid-value character
 * is stripped either way; what differs is an element EDGE, where the joined form
 * leaves the stripped character's replacement space beside the separator and
 * prints `A , B` for `['A<NEL>', 'B']`. The separator stays byte-exact only
 * per element.
 */
function displaySafeTransforms(names: readonly string[]): string {
  return names.map((name) => displaySafe(name)).join(', ');
}

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
  /**
   * State bucket consulted ONLY by the > 51,200-byte `TemplateURL`
   * upload branch. Sub-51 KB templates take the inline `TemplateBody`
   * path and ignore this field — pass `undefined` from callers that
   * cannot resolve a bucket and the inline branch will still work.
   * The upload branch hard-errors with a clear `MacroExpansionError`
   * when this is missing AND the template is oversize.
   */
  stateBucket?: string;
  cfnClient?: CloudFormationClient;
  s3ClientOpts?: CfnUploadS3ClientOpts;
  /**
   * Maximum total wait for the transient `CreateChangeSet` to settle,
   * **in seconds** (matches the SDK waiter's `maxWaitTime` contract).
   * Defaults to {@link WAITER_MAX_WAIT_SECONDS} (600s / 10 min) per
   * the design — SAM expansion typically completes in 30-60s but the
   * first-ever call against a fresh account pays a cold-start on the
   * SAM macro Lambda layer.
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

/** 600 seconds = 10 minutes. SDK waiter's `maxWaitTime` is in seconds. */
const WAITER_MAX_WAIT_SECONDS = 600;
const PARAMETER_PLACEHOLDER = 'cdkd-macro-expand-placeholder';

/**
 * AWS's managed pre-deployment validation hooks
 * (`AWS::EarlyValidation::*`, e.g. `ResourceExistenceCheck`) can
 * reject the transient expansion changeset INTERMITTENTLY (issue
 * #1151: two consecutive rejections followed by a clean pass on the
 * same template minutes later, with the same named resources
 * existing throughout). The changeset is never executed — cdkd only
 * reads the Processed-stage template — so a validation-hook rejection
 * carries no real risk and is worth retrying with a fresh transient
 * stack before failing the whole run.
 */
const EARLY_VALIDATION_MAX_ATTEMPTS = 3;
const EARLY_VALIDATION_RETRY_BASE_DELAY_MS = 2_000;

/** Matches the changeset FAILED StatusReason emitted by the hook family. */
const EARLY_VALIDATION_MARKER = /AWS::EarlyValidation::/;

/**
 * Where the retry verdict is CARRIED, rather than re-derived from the rendered
 * message.
 *
 * The verdict used to be `EARLY_VALIDATION_MARKER.test(err.message)`, and that
 * became wrong the moment AWS's reply started rendering through
 * `displayAwsMessage` ([#3479](https://github.com/go-to-k/cdkd/issues/3479)):
 * the cap CUTS at `AWS_MESSAGE_MAX_CODE_POINTS`, so a `StatusReason` carrying
 * the hook marker past that point would no longer match, and `cdkd deploy` of a
 * macro stack would hard-fail on attempt 1 where issue
 * [#1151](https://github.com/go-to-k/cdkd/issues/1151) says it must retry. The
 * sanitizer's CHARSET half was never the risk — the marker is plain ASCII —
 * but a decision re-derived from display text inherits every display rule,
 * including ones added later for unrelated reasons.
 *
 * So each throw site tests the RAW text once and records the answer here. A
 * symbol rather than a field on `MacroExpansionError`: the verdict is this
 * module's business, not the shared error class's.
 */
const EARLY_VALIDATION = Symbol('cdkd.macroExpansion.earlyValidationRejection');

/**
 * Tag `error` when `rawReason` — AWS's text BEFORE any display helper touches
 * it — names a validation hook.
 */
function withEarlyValidationVerdict(
  error: MacroExpansionError,
  rawReason: string
): MacroExpansionError {
  if (EARLY_VALIDATION_MARKER.test(rawReason)) {
    (error as MacroExpansionError & { [EARLY_VALIDATION]?: boolean })[EARLY_VALIDATION] = true;
  }
  return error;
}

function isEarlyValidationRejection(err: unknown): boolean {
  return (
    err instanceof MacroExpansionError &&
    (err as MacroExpansionError & { [EARLY_VALIDATION]?: boolean })[EARLY_VALIDATION] === true
  );
}

/** Test seam: overridable sleep so retry tests don't wait wall-clock. */
export const retryDelays = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};
/**
 * Capabilities sent on every `CreateChangeSet` call:
 *
 * - `CAPABILITY_AUTO_EXPAND` is the load-bearing one — required for CFn
 *   to actually run macro / `Transform` expansion (without it, CFn
 *   rejects the changeset on any template that declares a Transform).
 * - `CAPABILITY_NAMED_IAM` / `CAPABILITY_IAM` are defense-in-depth: SAM
 *   transforms (`AWS::Serverless-2016-10-31`) emit Lambda execution
 *   roles, and user-authored macros may emit arbitrary IAM resources
 *   too. Sending them unconditionally avoids a second round-trip when
 *   the expanded template carries IAM resources cdkd's deploy pipeline
 *   would otherwise complain about.
 */
const CAPABILITIES: Capability[] = [
  'CAPABILITY_AUTO_EXPAND',
  'CAPABILITY_NAMED_IAM',
  'CAPABILITY_IAM',
];

/**
 * Per-Type placeholder values used when a template Parameter has no
 * `Default`. CFn validates Parameter `Type` BEFORE the macro Lambda
 * runs, so a single bare-string placeholder rejects `CreateChangeSet`
 * on `Number` / `List<*>` / `AWS::EC2::*::Id` typed parameters
 * (`Parameter '<X>' must be a number`, etc.). The actual values do NOT
 * leak into the Processed-stage template (CFn preserves
 * `Ref: <param>` intact through expansion — see {@link
 * EMPIRICAL_FINDINGS_VERIFIED_2026_05_23} Q4), so any type-valid value
 * is sufficient. AWS-published Parameter Types list:
 * <https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/parameters-section-structure.html#parameters-section-structure-properties>
 */
const PARAMETER_TYPE_PLACEHOLDERS: Record<string, string> = {
  // Scalar / list scalar
  String: PARAMETER_PLACEHOLDER,
  Number: '0',
  'List<Number>': '0',
  CommaDelimitedList: '',
  'List<String>': '',
  // AWS-specific scalars
  'AWS::EC2::AvailabilityZone::Name': 'us-east-1a',
  'AWS::EC2::Image::Id': 'ami-00000000',
  'AWS::EC2::Instance::Id': 'i-00000000',
  'AWS::EC2::KeyPair::KeyName': 'placeholder-key',
  'AWS::EC2::SecurityGroup::GroupName': 'placeholder-sg',
  'AWS::EC2::SecurityGroup::Id': 'sg-00000000',
  'AWS::EC2::Subnet::Id': 'subnet-00000000',
  'AWS::EC2::Volume::Id': 'vol-00000000',
  'AWS::EC2::VPC::Id': 'vpc-00000000',
  'AWS::Route53::HostedZone::Id': 'Z00000000000000000000',
  'AWS::SSM::Parameter::Name': 'placeholder',
  // AWS-specific lists (one valid element is enough; CFn validates each)
  'List<AWS::EC2::AvailabilityZone::Name>': 'us-east-1a',
  'List<AWS::EC2::Image::Id>': 'ami-00000000',
  'List<AWS::EC2::Instance::Id>': 'i-00000000',
  'List<AWS::EC2::SecurityGroup::GroupName>': 'placeholder-sg',
  'List<AWS::EC2::SecurityGroup::Id>': 'sg-00000000',
  'List<AWS::EC2::Subnet::Id>': 'subnet-00000000',
  'List<AWS::EC2::Volume::Id>': 'vol-00000000',
  'List<AWS::EC2::VPC::Id>': 'vpc-00000000',
  'List<AWS::Route53::HostedZone::Id>': 'Z00000000000000000000',
};

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

  // Issue #1151: AWS's EarlyValidation hook family rejects the
  // transient changeset intermittently. Each retry attempt mints a
  // FRESH transient stack name (inside expandMacrosAttempt) and the
  // failed attempt's stack is already torn down by its own finally.
  for (let attempt = 1; ; attempt++) {
    try {
      return await expandMacrosAttempt(template, opts, logger);
    } catch (err) {
      if (attempt < EARLY_VALIDATION_MAX_ATTEMPTS && isEarlyValidationRejection(err)) {
        const delayMs = EARLY_VALIDATION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(
          `Macro expansion changeset was rejected by an AWS EarlyValidation hook ` +
            `(attempt ${attempt}/${EARLY_VALIDATION_MAX_ATTEMPTS}); this rejection is ` +
            `known to be intermittent — retrying with a fresh transient stack in ` +
            `${delayMs / 1000}s...`
        );
        await retryDelays.sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}

async function expandMacrosAttempt(
  template: unknown,
  opts: ExpandMacrosOptions,
  logger: Logger
): Promise<CloudFormationTemplate> {
  const macros = enumerateMacros(template);
  logger.debug(
    `Macro expansion: detected transforms [${displaySafeTransforms(macros)}], starting CFn round-trip...`
  );

  // 16 chars of UUID hex → ~64 bits of entropy, ample collision
  // resistance for transient per-call stack names (concurrent calls
  // re-randomize, see the "concurrent UUID independence" test). The
  // 8-char form used pre-CR-MJ2 was already safe in practice but the
  // wider form is a free hardening — same readability, stronger
  // guarantees for high-fan-out CI environments.
  const transientStackName = `cdkd-macro-expand-${randomUUID().slice(0, 16)}`;
  const changeSetName = `${transientStackName}-changeset`;
  const region = opts.region;
  const stateBucket = opts.stateBucket;
  const waiterMaxWaitSeconds = opts.waiterMaxWaitSeconds ?? WAITER_MAX_WAIT_SECONDS;

  // CR-M1: declare BEFORE the try so the finally can see it, but
  // construct INSIDE the try (after the JSON.stringify / parameter-build
  // calls — both can theoretically throw on pathological inputs such
  // as a synth template carrying a cycle). This keeps the SDK client
  // teardown in `finally` from being skipped on those edge errors.
  let cfn: CloudFormationClient | undefined;
  let ownsClient = false;
  let s3Cleanup: (() => Promise<void>) | undefined;

  try {
    // Serialize the template (the inline / upload split runs on the
    // serialized bytes, and we always need to send it over the wire).
    // JSON.stringify can throw on a circular reference; the try /
    // finally now covers that case so the SDK client (if any) gets
    // properly destroyed.
    const serialized = JSON.stringify(template);

    // Parameter placeholders: per Q4 above, declared no-Default params
    // need values for the changeset to even validate. CFn does NOT
    // substitute these into the Processed-stage template.
    const parameters = buildParameterValues(template, logger);

    // CR-M1: construct the SDK client only AFTER the above potentially-
    // throwing calls have settled. `ownsClient = true` flips the
    // finally's `cfn.destroy()` switch ON; passing a mock client via
    // `opts.cfnClient` (tests) leaves it OFF.
    ownsClient = opts.cfnClient === undefined;
    cfn = opts.cfnClient ?? new CloudFormationClient({ ...awsClientDefaults(), region });

    // Pick inline vs TemplateURL based on the wire size.
    let templateInput: { TemplateBody: string } | { TemplateURL: string };
    if (serialized.length > CFN_TEMPLATE_URL_LIMIT) {
      throw new MacroExpansionError(
        `Template is ${serialized.length} bytes, which exceeds CloudFormation's ` +
          `${CFN_TEMPLATE_URL_LIMIT}-byte TemplateURL ceiling for macro expansion. ` +
          `Shrink inline payloads (move inline lambda.Code.ZipFile to ` +
          `lambda.Code.fromAsset, etc.) or split the stack before retrying.`
        // No `cause` — this is a cdkd-side pre-flight rejection, not a
        // wrapped AWS / SDK error. The size + remediation are the
        // entire story.
      );
    }
    if (serialized.length <= CFN_TEMPLATE_BODY_LIMIT) {
      templateInput = { TemplateBody: serialized };
    } else {
      // CR-MJ1: the upload branch is the ONLY path that consumes
      // stateBucket. Hard-error here when it's missing, rather than
      // threading a sentinel string into uploadCfnTemplate (which
      // would either fail with a confusing AWS-side error or — worse
      // — succeed against a real bucket whose name happens to match
      // the sentinel).
      if (!stateBucket) {
        throw new MacroExpansionError(
          `Template is ${serialized.length} bytes (over ${CFN_TEMPLATE_BODY_LIMIT} ` +
            `inline limit) — cdkd needs a state bucket to upload the transient ` +
            `template for CloudFormation's TemplateURL parameter. Pass --state-bucket <name> ` +
            `or ensure STS GetCallerIdentity can resolve a default bucket ` +
            `(cdkd-state-<accountId>).`
          // No `cause` — pre-flight rejection, not a wrapped failure.
        );
      }
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
      // CFn quotes the values it was SUBMITTED back in a validation error — the
      // transform names and the parameter placeholders built from this
      // template's own `Parameters` — so this is AWS text echoing assembly
      // content, the same class as the `StatusReason` below. `displayAwsMessage`
      // sanitizes AND bounds it; the retry verdict is taken from the RAW text,
      // because a hook rejection can surface here too.
      const rawMessage = err instanceof Error ? err.message : String(err);
      throw withEarlyValidationVerdict(
        new MacroExpansionError(
          `CloudFormation rejected the macro-expansion changeset: ` +
            `${displayAwsMessage(rawMessage)}`,
          err instanceof Error ? err : undefined
        ),
        rawMessage
      );
    }

    // ---- Wait for the changeset to settle ----
    // The SDK waiter throws on FAILED; we catch and surface the
    // StatusReason via a follow-up DescribeChangeSet.
    let waiterFailed = false;
    let waiterError: unknown;
    try {
      await waitUntilChangeSetCreateComplete(
        {
          client: cfn,
          maxWaitTime: waiterMaxWaitSeconds,
          // Changeset creation for a macro expansion settles in seconds and
          // this runs on the DEPLOY path -- the SDK default cadence (30s
          // first poll) would add a flat half-minute to every macro deploy
          // (issue #1291 item 5: unconfigured waiters run at SDK defaults).
          minDelay: 2,
          maxDelay: 5,
        },
        { StackName: transientStackName, ChangeSetName: changeSetName }
      );
    } catch (waiterErr) {
      waiterFailed = true;
      // Fall through — `describe` below will surface the actual
      // StatusReason (almost always more useful than the generic
      // waiter error). Only re-throw on describe failure.
      // CR-MJ4: keep the original waiter error so operators can
      // distinguish SDK-side timeout from CFn-side FAILED status
      // (e.g. when the waiter hit its bounded wait but CFn was still
      // making progress, the `cause` carries the SDK TimeoutError).
      waiterError = waiterErr;
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
      // AWS's own reply, and `displayAwsMessage` rather than `displaySafe`: CFn
      // ECHOES the template's transform name and the macro Lambda's error text
      // into `StatusReason`, so the value sanitized where the transform name is
      // first rendered re-enters here — at a length whoever wrote the template
      // chose. The cap marks its cut, so a bounded message cannot read as a
      // complete one.
      const rawReason = desc?.StatusReason ?? 'unknown (DescribeChangeSet failed)';
      const reason = displayAwsMessage(rawReason);
      const status = displaySafe(desc?.Status ?? 'UNKNOWN');
      // The retry verdict is taken from `rawReason`, never from the rendered
      // message — see `withEarlyValidationVerdict`.
      throw withEarlyValidationVerdict(
        new MacroExpansionError(
          `CloudFormation macro expansion failed (status=${status}): ${reason}`,
          waiterError instanceof Error ? waiterError : undefined
        ),
        rawReason
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
      // CR-MJ4: no underlying cause — this is a CFn-side response
      // shape problem (the SDK returned a successful response with no
      // TemplateBody field). Document inline rather than fabricating
      // a cause.
      throw new MacroExpansionError(
        `CloudFormation returned no Processed-stage template body for the ` +
          `macro-expansion changeset. This typically indicates a CFn-side ` +
          `regression — re-run, and if the failure persists open an issue ` +
          `with the transforms involved: [${displaySafeTransforms(macros)}].`
      );
    }
    const expanded = parseTemplateBody(tpl.TemplateBody);

    // ---- Multi-stage detection: reject ----
    if (containsMacro(expanded)) {
      const inner = enumerateMacros(expanded);
      // CR-MJ4: no underlying cause — this is a cdkd-side scope
      // decision (multi-stage expansion is intentionally out of scope
      // for v1, see issue #463). The error stems from cdkd's
      // policy, not a wrapped failure.
      throw new MacroExpansionError(
        `Macro expansion produced a template that still contains macros ` +
          `[${displaySafeTransforms(inner)}]. Multi-stage macros (a macro whose expansion ` +
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
    // ---- Cleanup: DeleteStack only ----
    // `DeleteStack` against a `REVIEW_IN_PROGRESS` stack CASCADE-deletes
    // every attached change-set (verified empirically 2026-05-23 — see
    // Q3 above), so an explicit `DeleteChangeSet` before this would race
    // on `DELETE_PENDING` under load. Idempotent: NotFound is silently
    // OK because the stack may already be gone (e.g. a concurrent
    // operator cleanup). Log failures at WARN so a stale stack is at
    // least visible to the operator.
    //
    // CR-M1: `cfn` may be `undefined` here if the pre-`CreateChangeSet`
    // path threw before the SDK client was constructed (e.g. a
    // pathological JSON.stringify failure). In that case there's no
    // transient stack to clean up and no SDK client to tear down —
    // skip both cleanup blocks silently.
    if (cfn !== undefined) {
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
    }
    if (s3Cleanup) {
      try {
        await s3Cleanup();
      } catch (cleanupErr) {
        // Surface the S3 key prefix so the operator can grep the
        // bucket for a stranded object (the per-key suffix is the
        // transientStackName + timestamp; see uploadCfnTemplate).
        logger.warn(
          `Failed to delete transient macro-expand template upload from ` +
            `state bucket '${stateBucket}' (key prefix ` +
            `'cdkd-migrate-tmp/${transientStackName}/'): ` +
            `${formatErr(cleanupErr)}. Sweep manually via ` +
            `'aws s3 rm s3://${stateBucket}/cdkd-migrate-tmp/${transientStackName}/ --recursive'.`
        );
      }
    }
    if (ownsClient && cfn !== undefined) {
      cfn.destroy();
    }
  }
}

/**
 * Build the `Parameters` list passed to `CreateChangeSet`. CFn requires
 * a value for every declared parameter; we fall back to a Type-aware
 * synthetic placeholder when the template has no Default. Per the
 * empirical verification above, these values do NOT leak into the
 * Processed template (CFn keeps `Ref: <param>` intact for cdkd's own
 * resolver to substitute later with the real values).
 */
function buildParameterValues(
  template: unknown,
  logger: Logger
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
    const defObj = def as Record<string, unknown>;
    const defDefault = defObj['Default'];
    const defType = typeof defObj['Type'] === 'string' ? (defObj['Type'] as string) : undefined;
    out.push({
      ParameterKey: key,
      ParameterValue: stringifyParamDefault(defDefault, defType, key, logger),
    });
  }
  return out;
}

/**
 * Coerce a CFn Parameter `Default` (or build a synthetic placeholder
 * when the Default is absent) into the string `CreateChangeSet`
 * requires. Strings / numbers / booleans pass through verbatim;
 * object-shaped Defaults (rare — array-typed Defaults that haven't
 * been comma-joined) are JSON-stringified. When no Default is present,
 * routes through {@link PARAMETER_TYPE_PLACEHOLDERS} so a `Number` /
 * `List<Number>` / `AWS::EC2::*::Id` Parameter sees a value CFn's
 * pre-macro Type validator accepts. The actual value does NOT leak
 * into the Processed-stage template (CFn preserves `Ref: <param>`
 * intact through expansion — see empirical findings).
 */
function stringifyParamDefault(
  value: unknown,
  type: string | undefined,
  paramKey: string,
  logger: Logger
): string {
  if (value !== undefined && value !== null) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      // Fall through to the placeholder below.
    }
  }
  // No Default (or non-serializable Default) → Type-aware placeholder.
  if (type !== undefined) {
    const known = PARAMETER_TYPE_PLACEHOLDERS[type];
    if (known !== undefined) return known;
    // SSM `AWS::SSM::Parameter::Value<*>` / `Type` values use angle
    // brackets to carry the inner shape: `Value<String>`,
    // `Value<List<String>>`, `Value<CommaDelimitedList>`,
    // `Value<AWS::EC2::VPC::Id>`, `Value<List<AWS::EC2::Subnet::Id>>`,
    // etc. (full grammar at
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/parameters-section-structure.html).
    //
    // The Parameter VALUE supplied to CFn is the **name of the SSM
    // parameter to resolve at deploy time** — a single string for
    // scalar `Value<...>` forms, but a comma-delimited list of SSM
    // parameter names for `Value<List<*>>` / `Value<CommaDelimitedList>`
    // forms. CFn validates that the supplied value PARSES per the
    // outer shape BEFORE the macro Lambda runs; a single-string
    // placeholder against a `Value<List<*>>` type would reject the
    // changeset with "Parameter ... must be a list" (CR-MJ3 fix). Emit
    // a 2-element comma-joined placeholder for list forms so the pre-
    // macro validator accepts it; the resolved value still doesn't
    // leak into the Processed-stage template either way.
    if (type.startsWith(SSM_PARAMETER_VALUE_PREFIX)) {
      // The PEEL is the SHARED {@link ssmResolvedValueType} (issue #2367),
      // which is also what `resolveParameters` in the deployment layer uses to
      // coerce an SSM-RESOLVED value. This site's inline `slice` and that one
      // were two spellings of one question -- exactly the shape issue #2347
      // deleted from this same module pair when it made
      // {@link isListParameterType} shared -- and the two disagreed on
      // strictness: this one required neither a closing `>` nor a non-empty
      // inner shape.
      //
      // THE MALFORMED CASE KEEPS THIS SITE'S OWN ANSWER, deliberately. The
      // shared peel is the STRICTER of the two originals and returns
      // `undefined` for `Value<` / `Value<>`; falling those through to the
      // generic warn below would change the emitted placeholder text
      // (`placeholder` -> PARAMETER_PLACEHOLDER) and add a warn line, an
      // unrelated behaviour change. `''` was never list-shaped, so the scalar
      // arm is what this site already did for them -- now stated rather than
      // implied.
      const inner = ssmResolvedValueType(type);
      // `Value<List<...>>` OR `Value<CommaDelimitedList>` need a list
      // shape; everything else (`Value<String>`, `Value<AWS::EC2::*::Id>`,
      // etc.) is a single SSM parameter name.
      //
      // Asked of the SHARED {@link isListParameterType} (issue #2347). This
      // site held the WIDER and correct view of "is this type list-shaped"
      // while `coerceParameterTypedValue` in the deployment layer held a
      // narrower one that named only two types; the divergence is what handed
      // a `List<AWS::EC2::Subnet::Id>` nested-stack parameter to the child as a
      // string. The predicate is applied to `inner` -- the shape already peeled
      // out of `Value<...>` -- which is exactly the question it answers.
      if (inner !== undefined && isListParameterType(inner)) {
        return 'placeholder,placeholder';
      }
      return 'placeholder';
    }
    // A `Parameters` KEY and its `Type` are both template-derived, and this is a
    // DEFAULT-verbosity warn reached before `CreateChangeSet` — so it prints
    // locally on `cdkd deploy -a ./cdk.out` over a crafted assembly. `type` is
    // free-form: it is whatever string the file carries in that slot.
    logger.warn(
      `Parameter '${displaySafe(paramKey)}' has unrecognized CFn Type ` +
        `'${displaySafe(type)}'; using a generic ` +
        `string placeholder for the transient macro-expansion changeset. If CFn rejects ` +
        `the changeset with a type error, file an issue with the offending Type.`
    );
    return PARAMETER_PLACEHOLDER;
  }
  // No Type declared (defensive — CFn requires Type on every Parameter).
  return PARAMETER_PLACEHOLDER;
}

/**
 * Parse the `TemplateBody` field returned by `GetTemplate`. The SDK
 * types it as `string | undefined`, but empirical observation shows
 * the wire shape may be either a string (for YAML or some pre-parsed
 * cases) or a parsed object (for JSON templates against
 * `--template-stage Processed`). Handle both.
 */
function parseTemplateBody(body: unknown): CloudFormationTemplate {
  let parsed: unknown;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      // GetTemplate Processed-stage emits JSON for JSON-source templates
      // and YAML for YAML-source ones. cdkd's CDK app outputs JSON, so a
      // non-JSON return is unexpected; surface as MacroExpansionError so
      // the caller sees the wire shape.
      //
      // `displayAwsMessage` on the cause, because a `JSON.parse` failure embeds
      // the OFFENDING INPUT verbatim (measured: `Unexpected token 'o',
      // "notjson <ESC>[2K forged" is not valid JSON`), and that input is the
      // round-tripped template. `assembly-reader.ts` avoids quoting a
      // `JSON.parse` snippet for exactly this reason; here the snippet is
      // already inside AWS's text, so it is sanitized and bounded instead.
      throw new MacroExpansionError(
        `CloudFormation returned a non-JSON Processed-stage template body. ` +
          `cdkd's macro-expansion path only supports JSON-shaped synth ` +
          `templates (CDK apps emit JSON by default). Cause: ` +
          `${displayAwsMessage(err instanceof Error ? err.message : String(err))}`,
        err instanceof Error ? err : undefined
      );
    }
  } else if (body && typeof body === 'object' && !Array.isArray(body)) {
    parsed = body;
  } else {
    throw new MacroExpansionError(
      `CloudFormation returned an unexpected TemplateBody shape (${typeof body}). ` +
        `Expected a JSON string or parsed object.`
    );
  }

  // CR-M2: structural sanity check. CFn's Processed-stage response is
  // supposed to be a CFn template object with `Resources` as an object
  // map. A malformed body (e.g. CFn-side regression that surfaces
  // `Resources: 'not-an-object'`) would otherwise leak into the
  // analyzer / DAG pipeline as a runtime crash with no useful
  // diagnostic. Surface here with a clear MacroExpansionError naming
  // the offending shape.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MacroExpansionError(
      `CloudFormation returned a malformed Processed-stage template body — ` +
        `expected a JSON object at the top level, got ` +
        `${Array.isArray(parsed) ? 'array' : typeof parsed}.`
    );
  }
  const resources = (parsed as Record<string, unknown>)['Resources'];
  if (
    resources !== undefined &&
    (typeof resources !== 'object' || resources === null || Array.isArray(resources))
  ) {
    throw new MacroExpansionError(
      `CloudFormation returned a malformed Processed-stage template body — ` +
        `'Resources' must be an object map, got ` +
        `${resources === null ? 'null' : Array.isArray(resources) ? 'array' : typeof resources}.`
    );
  }
  return parsed as CloudFormationTemplate;
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
