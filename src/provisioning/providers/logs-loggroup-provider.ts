import {
  AssociateKmsKeyCommand,
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DisassociateKmsKeyCommand,
  DeleteIndexPolicyCommand,
  DeleteLogGroupCommand,
  DescribeIndexPoliciesCommand,
  DescribeLogGroupsCommand,
  GetDataProtectionPolicyCommand,
  ListTagsForResourceCommand,
  PutBearerTokenAuthenticationCommand,
  PutIndexPolicyCommand,
  PutLogGroupDeletionProtectionCommand,
  PutRetentionPolicyCommand,
  DeleteRetentionPolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  PutDataProtectionPolicyCommand,
  DeleteDataProtectionPolicyCommand,
  ResourceNotFoundException,
  ResourceAlreadyExistsException,
} from '@aws-sdk/client-cloudwatch-logs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { isTruthyCfnBoolean } from '../data-delete-intent.js';
import { toCfnInteger, toFiniteNumber } from '../dynamodb-warm-throughput.js';
import { renderDisableCommand, UNNAMEABLE_ID_CLAUSE } from '../replacement-protection-advice.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';

/**
 * Whether a raw `RetentionInDays` is CloudFormation's spelling of "no
 * retention" — the shapes the send path SKIPS on create and routes to
 * `DeleteRetentionPolicy` on update, rather than refusing.
 *
 * MEASURED, not read off the docs (issue
 * [#2699](https://github.com/go-to-k/cdkd/issues/2699), live CloudFormation
 * A/B on `AWS::Logs::LogGroup`, us-east-1, 2026-09-14; the full table is on
 * `toCfnInteger` in `../dynamodb-warm-throughput.ts`): an ABSENT property, an
 * EMPTY string and a WHITESPACE-ONLY string are all accepted by CloudFormation
 * and all REMOVE the live retention policy. Nothing else in the falsy family
 * is: `false`, `0`, `"0"` and `null` are every one REJECTED (the first three by
 * the Logs handler, `null` at `update-stack` itself), so routing them here
 * would make cdkd delete a live retention on a template CloudFormation refuses
 * to deploy. They go to {@link assertUsableRetention}.
 *
 * The ONE cdkd-side exception is a numeric `0` when `desiredFromAwsReadback`
 * is set. `0` is what {@link LogsLogGroupProvider.readCurrentState} records for
 * a log group with no retention policy — cdkd's OWN never-expire spelling,
 * persisted into `observedProperties` at every deploy — and `cdkd drift
 * --revert` hands `update()` that baseline as the DESIRED bag. Reverting a
 * console-added retention on a never-expiring log group is therefore desired
 * `0` over live `30`, and it must reach the delete arm; refusing it would leave
 * `--revert` unable to undo exactly the drift it reports. `UpdateContext`'s
 * own contract licenses this reading and nothing wider: the flag says every
 * value in the bag describes what AWS held, so `0` there is a report of "no
 * retention", not a template's request. On the template path `0` stays
 * refused, matching CloudFormation. `"0"` is never cdkd-produced (the readback
 * writes a number) and is refused everywhere.
 */
function isAbsentRetention(raw: unknown, desiredFromAwsReadback: boolean): boolean {
  if (raw === undefined) return true;
  if (typeof raw === 'string' && raw.trim() === '') return true;
  return desiredFromAwsReadback && raw === 0;
}

/**
 * Refuse a `RetentionInDays` the send path cannot USE (issues [#2521],
 * [#2698], [#2699]).
 *
 * **The scope of this refusal is a TEST, not a paragraph.** Every review round
 * on issue [#2521] found a hole in a PROSE statement of it — a coercible
 * negative that fell through to `DeleteRetentionPolicy`, an unusable value
 * silenced by the wrong change gate, wrong cells in the hand-written table
 * that replaced those sentences, and then the one non-finite number
 * JavaScript makes FALSY. No count is given here: the count itself drifted
 * between this comment and the changelog, which is the same failure one level
 * up. The table now lives in
 * `tests/unit/provisioning/logs-loggroup-provider-retention-coercion.test.ts`
 * as `CREATE_MATRIX` / `UPDATE_MATRIX`: one row per (value, previous) pair,
 * each asserting which AWS call goes out, each carrying what the pre-#2521
 * code did. Read a change against those rows and add one for any pair they do
 * not cover; do not restate the rule here, because a fourth restatement is
 * the thing that keeps being wrong.
 *
 * What IS stated here is the RULE the rows pin, because since issues #2698 /
 * #2699 it is a measurement rather than a guess: the value is read through
 * `toCfnInteger` — CloudFormation's own Integer grammar, `optional sign +
 * decimal digits`, surrounding whitespace trimmed — and anything that grammar
 * rejects is refused here where CloudFormation would have refused it at
 * deploy time. The pre-#2698 reader was `Number()`, which FORWARDED `'0x1e'`
 * as 30 and `'30.5'` as 30.5 on a template CloudFormation rejects outright.
 * Five refusal ARMS, each with its own `detail` clause; only the WHY of each:
 *
 *  - **a non-finite NUMBER** (`NaN`, `Infinity`, `-Infinity`). Unreachable in
 *    production — both bags are `JSON.parse` output, which cannot express one —
 *    and kept as defence so the family is named whole. Sits BEFORE the null /
 *    type arms because `NaN` is a number whose siblings were already refused.
 *  - **`null`**. CloudFormation rejects it at `update-stack` (`'null' values
 *    are not allowed in templates`), and cdkd's own resolver never
 *    manufactures one for this key: an `AWS::NoValue` — bare or as an `Fn::If`
 *    branch — OMITS the property (`intrinsic-function-resolver.ts`,
 *    `resolveValue`'s object arm), so `null` arriving here is a literal the
 *    template wrote, not cdkd's spelling of absent. Issue #2521 left it in the
 *    delete arm on the guess that it was; the measurement settled it.
 *  - **not a CloudFormation Integer at all** (`'abc'`, `'0x1e'`, `'1e3'`,
 *    `'30.5'`, `[]`, `{}`, `true`, `false`). The pre-coercion code handed the
 *    raw value to `PutRetentionPolicyCommand` and CloudWatch Logs rejected it;
 *    refusing moves that rejection one layer earlier and names the property.
 *    `false` joined this arm with #2699 — it was in the delete arm before, on
 *    the same guess as `null`.
 *  - **ZERO** (`0`, `'0'`). The Logs handler rejects it by enum (`Valid values
 *    are: [1, 3, 5, ...]`), so it is not CloudFormation's never-expire — the
 *    ABSENT property or an empty string is. Numeric `0` under
 *    `desiredFromAwsReadback` never reaches this arm; see
 *    {@link isAbsentRetention} for why that one is cdkd's own spelling.
 *  - **a NEGATIVE number** (`-1`, `'-1'`). It coerces, so a refusal gated on
 *    coercibility alone let it through; it then failed the `> 0` send test and
 *    fell into the UPDATE path's `else`, which issues
 *    `DeleteRetentionPolicy` — a template typo SILENTLY REMOVING a live
 *    retention where the old code sent `-1` and failed loudly.
 *
 * The message names the value's TYPE and never the value. A provider's
 * `properties` bag arrives with dynamic references already RESOLVED, so a
 * `{{resolve:secretsmanager:...}}` scalar is PLAINTEXT by the time it reaches
 * here, and this function has no masker threaded
 * (`.claude/rules/provider-masking.md`). Interpolating it as
 * `${JSON.stringify(raw)}` was the first draft and
 * `vp run audit:provider-secret-mask:check` refused it — but read that as one
 * SPELLING being fenced, not the rule: the critic's population is
 * interpolated `JSON.stringify` calls, so a bare `${raw}` here would leave it
 * green. Do not put the value back without threading the capability first.
 *
 * The caller decides the ABSENT family FIRST, through {@link isAbsentRetention},
 * and never calls this for one: an absent value is not an error, and the
 * readback-only reading of `0` lives in that predicate rather than here, so
 * the zero arm below can stay unconditional.
 */
function assertUsableRetention(
  raw: unknown,
  coerced: number | undefined,
  logicalId: string,
  resourceType: string
): void {
  const detail = (() => {
    if (typeof raw === 'number' && !Number.isFinite(raw)) {
      return 'the template declares a non-finite number';
    }
    if (raw === null) {
      return (
        "the template declares null, which CloudFormation rejects ('null' values are not " +
        'allowed in templates); to declare no retention, omit the property'
      );
    }
    if (coerced === undefined) {
      if (typeof raw === 'string') {
        return (
          'the template declares a string that is not a CloudFormation Integer (hex, ' +
          'exponent and decimal-point spellings are rejected, as they are by CloudFormation)'
        );
      }
      return `the template's value is of type ${Array.isArray(raw) ? 'array' : typeof raw}`;
    }
    if (coerced === 0) {
      return (
        'the template declares zero, which CloudWatch Logs rejects; to declare no retention, ' +
        'omit the property or declare an empty string'
      );
    }
    if (coerced < 0) return 'the template declares a negative number';
    return undefined;
  })();
  if (detail === undefined) return;
  throw new ProvisioningError(
    `${logicalId} (${resourceType}): RetentionInDays must be a positive CloudFormation Integer ` +
      `(optional sign then decimal digits, as a number or a string — 30 or '30'); ${detail}`,
    resourceType,
    logicalId
  );
}

/**
 * AWS CloudWatch Logs LogGroup Provider
 *
 * Implements resource provisioning for AWS::Logs::LogGroup using the CloudWatch Logs SDK.
 * WHY: CreateLogGroup is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class LogsLogGroupProvider implements ResourceProvider {
  private logsClient: CloudWatchLogsClient;
  private stsClient: STSClient;
  private logger = getLogger().child('LogsLogGroupProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Logs::LogGroup',
      new Set([
        'LogGroupName',
        'KmsKeyId',
        'RetentionInDays',
        'Tags',
        'DataProtectionPolicy',
        'LogGroupClass',
        'FieldIndexPolicies',
        'DeletionProtectionEnabled',
        'BearerTokenAuthenticationEnabled',
      ]),
    ],
  ]);

  /**
   * Issue #1412. `ResourcePolicyDocument` used to sit in
   * {@link handledProperties} purely to keep the log group off the Cloud
   * Control fallback path — but nothing ever wired it, so a template setting
   * it deployed "successfully" with the policy silently discarded (the
   * #1392 silent-drop class the `handled-property-wiring` critic exists to
   * catch).
   *
   * It cannot be honestly wired from here. The value maps to the SEPARATE
   * `AWS::Logs::ResourcePolicy` resource type, whose CloudWatch Logs API
   * counterpart (`PutResourcePolicy` / `DeleteResourcePolicy`) is
   * **account-wide**, not per-log-group: the policy is keyed by a policy NAME
   * in the account, not by the log group. Owning it from the log group's
   * lifecycle would mean inventing an ownership/lifecycle answer cdkd has no
   * basis for — which policy name to claim, what to do on delete when the
   * account-wide policy may be shared, and how to resolve two log groups
   * declaring conflicting documents. Managing the sibling
   * `AWS::Logs::ResourcePolicy` resource is a separate feature (option 1 in
   * issue #1412), deliberately not attempted here.
   *
   * Declaring the drop instead makes the omission visible: the #614 routing
   * pass sends any log group whose template sets `ResourcePolicyDocument`
   * through the Cloud Control fallback, where AWS's own resource handler
   * applies the policy. This provider does NOT set `disableCcApiFallback`,
   * so that route is always available and no template is hard-rejected.
   */
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Logs::LogGroup',
      new Map<string, string>([
        [
          'ResourcePolicyDocument',
          'covered by the separate account-wide AWS::Logs::ResourcePolicy resource type; logs:PutResourcePolicy is account-scoped, not per-log-group, so it has no CreateLogGroup / PutRetentionPolicy counterpart — routed via Cloud Control instead',
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.logsClient = awsClients.cloudWatchLogs;
    this.stsClient = awsClients.sts;
  }

  /**
   * Create a CloudWatch Logs log group
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating log group ${logicalId}`);

    const logGroupName =
      (properties['LogGroupName'] as string | undefined) ||
      `/cdkd/${generateResourceName(logicalId, { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`;

    try {
      const createParams: import('@aws-sdk/client-cloudwatch-logs').CreateLogGroupCommandInput = {
        logGroupName,
      };
      if (properties['KmsKeyId']) createParams.kmsKeyId = properties['KmsKeyId'] as string;
      if (properties['LogGroupClass']) {
        createParams.logGroupClass = properties[
          'LogGroupClass'
        ] as import('@aws-sdk/client-cloudwatch-logs').LogGroupClass;
      }
      // DeletionProtectionEnabled is part of CreateLogGroupRequest and can
      // be applied in the same call. AWS rejects unknown / undefined values,
      // so only forward when the property is explicitly present.
      if (properties['DeletionProtectionEnabled'] !== undefined) {
        createParams.deletionProtectionEnabled = properties['DeletionProtectionEnabled'] as boolean;
      }
      if (properties['Tags']) {
        const cfnTags = properties['Tags'] as Array<{ Key: string; Value: string }>;
        createParams.tags = Object.fromEntries(cfnTags.map((t) => [t.Key, t.Value]));
      }

      // Track whether THIS call actually created the log group (vs hit the
      // idempotent `ResourceAlreadyExists` fallback). Only the truly-
      // created case is eligible for partial-failure cleanup — deleting a
      // pre-existing log group would destroy CloudWatch logs the user
      // cared about. AlreadyExists handling is INLINE here (rather than
      // at the outer catch) so the outer catch only ever sees genuine
      // failures, and the inner-cleanup branch below can rely on the
      // flag to decide whether to clean up.
      let createdNewLogGroup = false;
      try {
        await this.logsClient.send(new CreateLogGroupCommand(createParams));
        createdNewLogGroup = true;
      } catch (createError) {
        if (createError instanceof ResourceAlreadyExistsException) {
          this.logger.debug(`Log group ${logGroupName} already exists, using existing`);
        } else {
          throw createError;
        }
      }

      // Apply post-create configuration in an inner try so a wiring
      // failure can be self-healed by issuing a best-effort
      // `DeleteLogGroupCommand` cleanup. Without this, a post-create
      // failure leaves an orphan log group that AWS will reject on the
      // next redeploy. Cleanup is gated on `createdNewLogGroup` so we
      // never delete a pre-existing log group. See Issue #376 for the
      // cross-provider sweep.
      try {
        // Apply retention policy if specified.
        //
        // COERCED, not cast (issue [#2521]), and coerced the way
        // CLOUDFORMATION coerces (issue [#2698]). CloudFormation is stringly
        // typed and coerces `RetentionInDays: '30'` to the number its schema
        // declares; the SDK does not — it serializes whatever it is handed, so
        // a `'30'` reached CloudWatch Logs as a JSON string. `toCfnInteger` is
        // CloudFormation's own Integer grammar, measured (its doc carries the
        // table): the `Number()`-based `toFiniteNumber` this read used before
        // FORWARDED `'0x1e'` as 30 on a template CloudFormation rejects.
        const rawRetention = properties['RetentionInDays'];
        let retentionInDays = toCfnInteger(rawRetention);
        // Unconditional here, unlike the UPDATE path's twin, and the
        // asymmetry has ONE reason, not two: a create has no previous side, so
        // there is no "unchanged" case to exempt.
        //
        // It is NOT that nothing has been mutated yet — `CreateLogGroupCommand`
        // ran about a hundred lines up, so a throw here does leave AWS changed.
        // What keeps that from orphaning the log group is the inner `catch`
        // below, which issues a BEST-EFFORT `DeleteLogGroupCommand` gated on
        // `createdNewLogGroup`. Best-effort is the operative word: if that
        // delete itself fails, the failure is a `warn` naming the manual
        // `aws logs delete-log-group` and the group survives, so this refusal
        // can still cost an orphan on a bad day. That is the pre-existing
        // shape of every post-create wiring failure in this method, not
        // something the refusal introduced — and it is why the refusal is here
        // rather than further down.
        //
        // What each value does is the table on {@link assertUsableRetention};
        // on THIS path the refusal turns an AWS-side rejection into a
        // cdkd-side one naming the property. The ABSENT family (absent, `''`,
        // whitespace-only — CloudFormation's measured spellings of "no
        // retention", see {@link isAbsentRetention}) is skipped: a create has
        // no live retention to remove. Numeric `0` is NOT in that family here:
        // `desiredFromAwsReadback` is an `UpdateContext` field, and no create
        // caller hands this provider a readback bag.
        //
        // REPLAY downgrade (`.claude/rules/provider-replay-and-refusals.md`):
        // the rollback executor's reverse-replacement arm re-creates the OLD
        // log group from a STATE record, which the user cannot edit from the
        // template. A record can carry a value this refusal now rejects and
        // the pre-#2699 create accepted (`0`, `'0'`, `false`, `null` were
        // skipped; `'0x1e'` was forwarded as 30), so refusing there would
        // leave the old resource unrestorable — the case the MUST exists for.
        // The downgrade reproduces what the record CERTIFIES was sent (PR
        // #3137 security review): the binary that wrote the record read the
        // value with `Number()`-based `toFiniteNumber`, so a spelling that
        // read as a positive integer there (`'30.0'`, `'0x1e'`) was FORWARDED
        // as that integer, CloudWatch Logs accepted it, and a rollback that
        // re-creates the old log group without it silently drops a compliance
        // retention the deploy had applied. That reading is forwarded again
        // here, with a warning naming the spelling. Every other refused member
        // (`0`, `'0'`, `false`, `null`, `'abc'`, a non-integer) was SKIPPED or
        // rejected by AWS on the original create, so "no retention" is what
        // the record meant for it; those stay warn-and-skip.
        if (!isAbsentRetention(rawRetention, false)) {
          try {
            assertUsableRetention(rawRetention, retentionInDays, logicalId, resourceType);
          } catch (refusal) {
            if (context?.replayingState !== true || !(refusal instanceof ProvisioningError)) {
              throw refusal;
            }
            const legacyReading = toFiniteNumber(rawRetention);
            if (
              legacyReading !== undefined &&
              Number.isInteger(legacyReading) &&
              legacyReading > 0
            ) {
              retentionInDays = legacyReading;
              this.logger.warn(
                `${refusal.message}. This create replays a cdkd state record (rollback) written ` +
                  `by a cdkd that read the value as ${legacyReading} and applied it, so the ` +
                  `retention is RESTORED as ${legacyReading} days rather than refused. Fix the ` +
                  `template spelling and re-deploy.`
              );
            } else {
              this.logger.warn(
                `${refusal.message}. This create replays a cdkd state record (rollback), so the ` +
                  `retention is SKIPPED rather than refused: the log group is re-created with no ` +
                  `retention policy. Re-apply it by hand (aws logs put-retention-policy) or fix the ` +
                  `template and re-deploy.`
              );
            }
          }
        }
        if (retentionInDays !== undefined && retentionInDays > 0) {
          await this.logsClient.send(
            new PutRetentionPolicyCommand({
              logGroupName,
              retentionInDays,
            })
          );
        }

        // Apply DataProtectionPolicy if specified
        if (properties['DataProtectionPolicy']) {
          const policyDocument =
            typeof properties['DataProtectionPolicy'] === 'string'
              ? properties['DataProtectionPolicy']
              : JSON.stringify(properties['DataProtectionPolicy']);
          await this.logsClient.send(
            new PutDataProtectionPolicyCommand({
              logGroupIdentifier: logGroupName,
              policyDocument,
            })
          );
        }

        // Apply FieldIndexPolicies. CloudWatch Logs allows at most one
        // log-group-level index policy at a time (see PutIndexPolicy /
        // DeleteIndexPolicy semantics — both key on logGroupIdentifier
        // alone, no policyName), so the CFn `FieldIndexPolicies` array is
        // effectively 0-or-1. Apply the first entry; warn if more are
        // supplied.
        const fieldIndexPolicies = properties['FieldIndexPolicies'] as unknown[] | undefined;
        if (fieldIndexPolicies && fieldIndexPolicies.length > 0) {
          if (fieldIndexPolicies.length > 1) {
            this.logger.debug(
              `Log group ${logicalId} declares ${fieldIndexPolicies.length} FieldIndexPolicies; AWS only supports one log-group-level field index policy. Applying the first.`
            );
          }
          const first = fieldIndexPolicies[0];
          const policyDocument = typeof first === 'string' ? first : JSON.stringify(first);
          await this.logsClient.send(
            new PutIndexPolicyCommand({
              logGroupIdentifier: logGroupName,
              policyDocument,
            })
          );
        }

        // Apply BearerTokenAuthenticationEnabled. Not part of
        // CreateLogGroupRequest — needs a separate
        // PutBearerTokenAuthentication call after the log group exists.
        if (properties['BearerTokenAuthenticationEnabled'] !== undefined) {
          await this.logsClient.send(
            new PutBearerTokenAuthenticationCommand({
              logGroupIdentifier: logGroupName,
              bearerTokenAuthenticationEnabled: properties[
                'BearerTokenAuthenticationEnabled'
              ] as boolean,
            })
          );
        }
      } catch (innerError) {
        if (createdNewLogGroup) {
          try {
            await this.logsClient.send(new DeleteLogGroupCommand({ logGroupName }));
            this.logger.debug(
              `Cleaned up partially-created log group ${logicalId} (${logGroupName}) after wiring failure`
            );
          } catch (cleanupError) {
            // The same-file sibling of the #2669 remedy: a pasteable command
            // naming a TEMPLATE-chosen name, hand-quoted until that issue.
            // Rendered through the shared sanitize / quote / suppress, so the
            // COMMAND never carries a quote or a control byte raw. The prose
            // `(${logGroupName})` beside it is still interpolated as-is: this
            // line takes only the pasteable half, and display-sanitizing the
            // prose of provider warnings is a class no issue holds yet
            // (#3136 covers the COMMAND half across providers, not prose).
            const deleteCommand = renderDisableCommand({
              before: 'aws logs delete-log-group --log-group-name',
              identifier: logGroupName,
            });
            const manualStep = deleteCommand
              ? `Manual deletion may be required before the next deploy: ${deleteCommand}`
              : 'Manual deletion may be required before the next deploy, via the console: the log ' +
                'group name cannot be reproduced safely on a command line.';
            this.logger.warn(
              `Failed to clean up partially-created log group ${logicalId} (${logGroupName}): ${describeAwsFailure(cleanupError).detail}. ${manualStep}`
            );
          }
        }
        throw innerError;
      }

      this.logger.debug(`Successfully created log group ${logicalId}: ${logGroupName}`);

      // Construct ARN from region/account
      const arn = await this.buildArn(logGroupName);

      return {
        physicalId: logGroupName,
        attributes: {
          Arn: arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create log group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        logGroupName,
        cause
      );
    }
  }

  /**
   * Update a CloudWatch Logs log group
   *
   * Mutable: `RetentionInDays`, `DataProtectionPolicy`, `Tags`,
   * `DeletionProtectionEnabled`, `BearerTokenAuthenticationEnabled`,
   * `FieldIndexPolicies`, `KmsKeyId` (via AssociateKmsKey /
   * DisassociateKmsKey). `LogGroupName` requires replacement.
   * `LogGroupClass` cannot be changed at all (CFn: "Updates are not
   * supported" — there is no CloudWatch Logs API to change a log group's
   * class after creation), so a class change throws
   * {@link ResourceUpdateNotSupportedError} instead of being silently
   * dropped; `--replace` recreates the log group under the new class.
   *
   * Thin wrapper that maps any AWS SDK failure onto {@link ProvisioningError}
   * the same way {@link create} and {@link delete} do, so an update failure
   * carries cdkd's typed error formatting and exit-code handling instead of
   * surfacing raw (issue #1267). The body lives in {@link applyUpdate} so the
   * wrap is a boundary concern rather than a large indentation change.
   *
   * The {@link ResourceUpdateNotSupportedError} thrown by the LogGroupClass
   * guard is re-thrown untouched: the deploy engine matches it by class to
   * fall back to replacement, so swallowing it into a ProvisioningError would
   * turn a recoverable class change into a hard failure.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    try {
      return await this.applyUpdate(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    } catch (error) {
      // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
      // is control flow the deploy engine matches BY CLASS, and a ProvisioningError
      // raised deeper in the body already carries better context than a re-wrap.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update log group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async applyUpdate(
    logicalId: string,
    physicalId: string,
    // Threaded rather than re-spelled as a literal: `update()` already
    // receives it, and a hardcoded type in a refusal is a second place to
    // update if this provider ever serves another one.
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    // Read for TWO fields: `desiredFromAwsReadback`, which decides whether a
    // numeric `0` is cdkd's own never-expire readback or a template's rejected
    // zero (see `isAbsentRetention`), and `replayingState` (issue #3141), which
    // downgrades the refusal on a rollback replay. No masker is threaded from
    // it, and the one VALUE any of those warnings interpolates is
    // `toFiniteNumber`'s positive-integer reading of the retention itself —
    // a day count, not a carrier for secret material (PR #3246 security
    // review, which flagged the previous "names no value" wording as stale).
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating log group ${logicalId}: ${physicalId}`);

    // LogGroupClass is unchangeable after creation (no AWS API exists;
    // CloudFormation documents the property as "Update requires: Updates
    // are not supported" and fails the stack update). Guard BEFORE any
    // other mutation so a doomed deploy fails without partially applying
    // the rest of the diff — silently dropping the change would poison
    // state (state records the new class while AWS keeps the old one, and
    // the next diff sees no change, so it can never self-heal). An absent
    // property means the CloudWatch Logs default class (STANDARD), so an
    // explicit-STANDARD <-> absent transition is NOT a real change.
    const normalizeClass = (v: unknown): string =>
      typeof v === 'string' && v.length > 0 ? v : 'STANDARD';
    const prevClass = normalizeClass(previousProperties['LogGroupClass']);
    const nextClass = normalizeClass(properties['LogGroupClass']);
    if (prevClass !== nextClass) {
      // EVERY log group is in the stateful-recreate guard set on this path, so
      // a bare --replace would be stopped a second time by
      // STATEFUL_REPLACE_BLOCKED — name the full flag set upfront.
      //
      // UNCONDITIONAL since issue [#2558]. It used to read
      // `properties['RetentionInDays']`, on the premise that a log group with
      // no retention was not stateful; that premise was the defect — an unset
      // or zero retention is CloudWatch Logs' never-expire — and the
      // mid-deploy guard now refuses any log group the recorded bag cannot
      // prove empty. Advising a bare `--replace` would hand the user a remedy
      // guaranteed to fail on the second deploy. (This also retires the
      // ADVICE half of issue [#2521], which filed the same line for reading
      // the DESIRED bag while the guard reads the RECORDED one: with no
      // condition left, there is no bag to read. Its other two halves — a
      // string-valued retention defeating the guard's `typeof === 'number'`
      // test, and the guard never reading `observedProperties` — were closed
      // separately, in `stateful-types.ts`.)
      const replaceFlags = '--replace --force-stateful-recreation';

      // Issue [#2579]: those two flags are not sufficient on a log group that
      // carries DeletionProtectionEnabled. The replacement's DELETE runs from
      // the deploy engine, which never sets `DeleteContext.removeProtection`
      // (the flip-off in `delete()` below is gated on it, and only the destroy
      // paths set it — `cdkd deploy` has no `--remove-protection` flag at
      // all), so AWS refuses the DeleteLogGroup and the advised command dies
      // on a SECOND wall with nothing named to do about it.
      //
      // Read the RECORDED bag, not the desired one. On the DEPLOY path
      // `previousProperties` is `ResourceState.properties` for this resource
      // (`deploy-engine.ts` hands over `currentProps`, which
      // `diff-calculator.ts` sets from `currentResource.properties`) — what
      // cdkd last deployed, and so its best account of what AWS holds on the
      // log group that must be deleted. The DESIRED bag answers a different
      // question and would be wrong in both directions there: a template newly
      // ADDING protection alongside the class change leaves AWS unprotected,
      // because this very refusal fires before the flip is applied, so the
      // replacement's delete would have succeeded; and a template CLEARING it
      // does not clear it in AWS for the same reason, so the dead-end is still
      // ahead of the user.
      //
      // TWO of the four `update()` callers hand over something else, which is
      // why the message SAYS "cdkd's recorded properties" rather than asserting
      // AWS state. `drift.ts` passes `outcome.awsProperties`, a
      // `readCurrentState` snapshot — strictly better here, and the one bag
      // that ALWAYS carries this key (`readCurrentState` emits an explicit
      // `false` placeholder). `rollback-executor.ts`'s `--revert-failed` arm
      // passes `op.attemptedProperties ?? current.properties` — the DESIRED bag
      // of the failed attempt, i.e. exactly the read argued against above. (Its
      // `revert` arm passes `current.properties`, the state record, same as
      // deploy.) The advice survives being wrong on the `--revert-failed` arm:
      // the disable call is idempotent, and AWS accepts it on an
      // already-unprotected log group.
      //
      // Two residuals are ACCEPTED rather than fixed here. Protection enabled
      // OUT OF BAND is absent from every bag, so that log group still gets the
      // short advice and still hits the wall — cdkd cannot see what it never
      // recorded, and probing AWS from a refusal path would add a call to the
      // failure route. And `isTruthyCfnBoolean` matches `true` / `'true'` only,
      // so `'True'` or `1` falls through to the short advice: widening it is a
      // repo-wide change to a helper `hasCdkAutoDeleteTag` also uses, and the
      // fall-through direction is merely the pre-#2579 behaviour. It is the
      // same defect class issue [#2521] closed one property over, where the
      // stateful guard's `typeof === 'number'` test on `RetentionInDays` was
      // replaced by a coercion — so the shape has a fix to copy if this one is
      // ever taken up, not merely a sibling to point at.
      // The message deliberately STOPS at what this function can know, and
      // hands the rest to the doc. Three review rounds each proved a different
      // sentence about the downstream mechanism FALSE, because `update()` sees
      // neither `UpdateReplacePolicy` nor what the replacement then does:
      //
      //   1. "re-enable protection on the new log group afterwards" — wrong;
      //      `create()` re-applies the flag from the DESIRED bag, so a manual
      //      re-enable over a `false` template manufactures drift that never
      //      self-corrects (`applyUpdate` flips only when the two bags DIFFER).
      //   2. "the disable applies to the OLD log group, which the replacement
      //      deletes" — wrong under `UpdateReplacePolicy: Retain`, where both
      //      replacement paths skip the delete (`deploy-engine.ts`'s
      //      `retainOldOnReplace`).
      //   3. "under Retain it only strips a log group cdkd stops tracking" —
      //      wrong again: `LogGroupName` is this type's ONLY replacement
      //      property, so a same-name Retain replacement cannot complete at
      //      all. `create()` swallows `ResourceAlreadyExistsException` and
      //      returns the OLD physical id, and the engine refuses with
      //      `NAMED_REPLACEMENT_IDEMPOTENT_CREATE` before any state
      //      bookkeeping — i.e. the sentence promised an outcome the code
      //      makes unreachable, and hid a THIRD wall, which is the exact
      //      defect class issue [#2579] exists to close.
      //
      // So: state the refusal, the flag that does not exist, the disable
      // command, and the same-deploy trap — all knowable here — then point at
      // `docs/cli-deploy-safety.md`, which has the policy in view and room to
      // be precise. A shorter message that is TRUE beats a complete one that
      // is not.
      const deletionProtected = isTruthyCfnBoolean(previousProperties['DeletionProtectionEnabled']);
      // The id in the pasteable command is `state.json`-borne, not an
      // AWS-minted literal (issue [#2669]): the deploy engine hands this
      // method `currentResource.physicalId` straight off the record, which
      // `lock-manager.ts` already treats as attacker-influenced for anyone who
      // can write the bucket. It therefore gets exactly what the five
      // `protectedReplacementAdvice` callers get — `displaySafe(asciiOnly)`,
      // then `shellQuote`, and the WHOLE command suppressed when sanitizing
      // changed the id, since a command naming a sanitized id acts on a
      // DIFFERENT resource. Only the rendering is shared; the sentence around
      // it stays this type's own (the header of that module says why). For a
      // clean id `shellQuote` emits it UNQUOTED — its quote-free class is
      // `[A-Za-z0-9._/@:+-]`, which every ordinary CloudWatch Logs name is in
      // (a `#`, legal in a name, is outside it and gets quoted, correctly) —
      // and that bare form is what
      // `tests/integration/loggroup-class-guard/verify.sh` greps.
      const disableCommand = renderDisableCommand({
        before: 'aws logs put-log-group-deletion-protection --log-group-identifier',
        identifier: physicalId,
        after: '--no-deletion-protection-enabled',
      });
      const disableStep = disableCommand
        ? `Then disable deletion protection — \`${disableCommand}\`, or via the console — and re-deploy with ${replaceFlags}`
        : `${UNNAMEABLE_ID_CLAUSE} Then re-deploy with ${replaceFlags}`;
      const remedy = deletionProtected
        ? `cdkd's recorded properties for this log group carry DeletionProtectionEnabled, so ${replaceFlags} alone will NOT succeed while AWS still has it on: the replacement normally deletes the log group, AWS refuses that delete while protection is on, and cdkd deploy has no --remove-protection flag to clear it (only cdkd destroy and cdkd state destroy act on one). Read "Deletion protection blocks a replacement" in docs/cli-deploy-safety.md BEFORE you disable anything: whether disabling helps at all, and what the flag ends up as, depend on your UpdateReplacePolicy and on whether the deploy completes — neither of which this refusal can see. ${disableStep} to delete + recreate the log group under the new class (its stored log events are lost). Setting DeletionProtectionEnabled: false in the template does NOT clear it in the same deploy: this refusal fires before that property is applied, so that route needs its own deploy with the LogGroupClass change reverted. Or revert the LogGroupClass change and keep the current class.`
        : `Re-deploy with ${replaceFlags} to delete + recreate the log group under the new class (its stored log events are lost), or revert the LogGroupClass change.`;
      throw new ResourceUpdateNotSupportedError(
        'AWS::Logs::LogGroup',
        logicalId,
        `the LogGroupClass ('${prevClass}' -> '${nextClass}') cannot be changed after creation. ${remedy} Note --force-stateful-recreation has NO per-resource granularity: it clears the data guard for every replacement target in the run`
      );
    }

    // Read + VALIDATE the retention here, above every mutation, and send it
    // further down (issue [#2521]).
    //
    // BOTH sides go through `toCfnInteger`, and the comparison matters as
    // much as the send: a state record carrying the string `'30'` — what
    // `cdkd import --migrate-from-cloudformation` persists from a CFn template
    // that spelled it that way — is `!==` the template's numeric `30`, so
    // every deploy re-issued a PutRetentionPolicy for a retention that had not
    // changed.
    //
    // The refusal is gated on the RAW value CHANGING, and each half of that
    // was a review-round finding rather than a design:
    //
    //  - gating on a CHANGE at all, because an unusable value present
    //    identically in BOTH bags is what an import record produces, and the
    //    pre-coercion code compared it EQUAL and issued nothing; refusing it
    //    would fail an unrelated property change on a template nobody touched.
    //  - gating on RAW rather than on the COERCED comparison below, because
    //    `toCfnInteger` maps `'abc'`, `'  '`, `[]`, `{}`, `true`, `''` and
    //    ABSENT all to `undefined`. A coerced gate therefore reads `'abc'`
    //    against an absent-or-differently-unusable previous side as
    //    UNCHANGED, skips the refusal AND the send, and the deploy succeeds
    //    green with the property silently discarded while state records it —
    //    the state-poisoning silent-drop class the `LogGroupClass` guard above
    //    exists to prevent.
    //  - ABOVE the KMS block, so a refusal cannot leave the update
    //    half-applied with the key association changed and state unwritten.
    //
    // `sameRawRetention` is deliberately NOT a bare `JSON.stringify` compare,
    // and not a bare `Object.is` either. `Object.is` alone would refuse an
    // UNCHANGED `[]` or `{}`, because the template bag and the state bag never
    // share a reference — the import no-op above is exactly that shape.
    // `JSON.stringify` alone is not INJECTIVE: `Infinity`, `-Infinity` and
    // `NaN` all render `'null'`, so an `Infinity` over a recorded `null` would
    // compare UNCHANGED and take the refusal-skipped silent-drop route one
    // layer down from the bullet above. So: identical by reference, OR
    // structurally equal through a rendering that is FAITHFUL.
    //
    // BOTH exclusions are defence with no reachable case, labelled rather than
    // argued — `!== 'null'` only matters for a non-finite number and
    // `!== undefined` only for a symbol or function, and neither survives the
    // `JSON.parse` both bags come out of. The `Object.is` arm is in the same
    // position: the only pair it decides on its own is a non-finite value
    // against itself. What is REACHABLE, and what that arm is really for, is
    // the unchanged `[]` / `{}` — structurally equal, never the same
    // reference, and refused by a bare `Object.is`.
    //
    // One RESIDUAL is argued the same way and left unfenced: an object
    // carrying a `toJSON` that renders as the previous side's number would
    // compare unchanged and reach the delete arm — but `previousProperties` is
    // strictly `JSON.parse` output and no parse path builds a `toJSON` bearer,
    // and adding `typeof raw !== 'object'` here would refuse the unchanged
    // `[]` this arm exists for.
    const rawRetention = properties['RetentionInDays'];
    const rawPreviousRetention = previousProperties['RetentionInDays'];
    const renderedRetention = JSON.stringify(rawRetention);
    const sameRawRetention =
      Object.is(rawRetention, rawPreviousRetention) ||
      (renderedRetention !== undefined &&
        renderedRetention !== 'null' &&
        renderedRetention === JSON.stringify(rawPreviousRetention));
    // `toCfnInteger`, CloudFormation's measured Integer grammar (issue
    // [#2698]) — `Number()` forwarded `'0x1e'` as 30 here. The PREVIOUS side
    // reads through the same function so the two spellings of one retention
    // still compare equal; a previous value the grammar rejects is the
    // `previousRetentionUnknown` case below, exactly as an `'abc'` was.
    // `let`, because the REPLAY downgrade below can restore the reading the
    // binary that wrote the record took (see the `legacyReading` arm).
    let retentionInDays = toCfnInteger(rawRetention);
    const oldRetentionInDays = toCfnInteger(rawPreviousRetention);
    // Absent FIRST (issue [#2699]): absent / `''` / whitespace-only are
    // CloudFormation's measured spellings of "no retention" and take the
    // delete arm below; numeric `0` joins them ONLY on a readback bag. Every
    // other falsy value — `false`, `null`, a template `0` / `'0'` — is refused
    // by `assertUsableRetention` like `'abc'`, because CloudFormation rejects
    // the template and cdkd must not delete a live retention on its behalf.
    //
    // Decided per site, as `.claude/rules/provider-replay-and-refusals.md`
    // asks of an update-path refusal. Issue [#2699] left an ACCEPTED RESIDUAL
    // here and issue [#3141] CLOSES it: the rollback executor's revert arms
    // hand `update()` `previousState.properties`, and until #3141 they carried
    // no flag saying so (`desiredFromAwsReadback` says something else — the bag
    // is an AWS READBACK — and setting it on those arms would delete a live
    // configuration elsewhere, see `UpdateContext`'s own doc). So a record
    // whose `properties` spell the retention `0` / `'0'` / `false` / `null` —
    // a pre-#2699 template cdkd accepted and recorded, or `drift --accept`
    // writing the readback `0` into `properties` on a record with no
    // `observedProperties` — was REFUSED on a rollback where it used to take
    // the delete arm, and the resource stayed at the FAILED deploy's retention.
    //
    // `UpdateContext.replayingState` is now that flag, and the downgrade below
    // is the UPDATE twin of `create()`'s (read that one for the pattern; both
    // reproduce what the record CERTIFIES was applied rather than what the
    // template grammar allows):
    //
    //  - a spelling the WRITING binary read as a positive integer through
    //    `Number()`-based `toFiniteNumber` (`'30.0'`, `'0x1e'`) was FORWARDED
    //    as that integer and CloudWatch Logs accepted it, so the revert
    //    RESTORES it rather than refusing — otherwise the rollback leaves the
    //    failed deploy's retention in place on a log group whose recorded one
    //    is a compliance setting;
    //  - every other refused member (`0`, `'0'`, `false`, `null`, `'abc'`, a
    //    negative, a non-integer) was SKIPPED on create or rejected by AWS, so
    //    "no retention" is what the record meant for it — that is the DELETE
    //    arm below, which is exactly where it used to land.
    //
    // Both arms WARN naming the spelling; neither is silent, and neither
    // widens what a TEMPLATE bag may say. A template deploy and
    // `drift --revert` set no `replayingState`, so the refusal stands there.
    const desiredFromAwsReadback = context?.desiredFromAwsReadback === true;
    if (!sameRawRetention && !isAbsentRetention(rawRetention, desiredFromAwsReadback)) {
      try {
        assertUsableRetention(rawRetention, retentionInDays, logicalId, resourceType);
      } catch (refusal) {
        if (context?.replayingState !== true || !(refusal instanceof ProvisioningError)) {
          throw refusal;
        }
        const legacyReading = toFiniteNumber(rawRetention);
        if (legacyReading !== undefined && Number.isInteger(legacyReading) && legacyReading > 0) {
          retentionInDays = legacyReading;
          this.logger.warn(
            `${refusal.message}. This update replays a cdkd state record (rollback) written ` +
              `by a cdkd that read the value as ${legacyReading} and applied it, so the ` +
              `retention is RESTORED as ${legacyReading} days rather than refused. Fix the ` +
              `template spelling and re-deploy.`
          );
        } else {
          this.logger.warn(
            `${refusal.message}. This update replays a cdkd state record (rollback), so the ` +
              `value is read as the "no retention" the record meant rather than refused: the ` +
              `log group's retention policy is REMOVED, which is what the cdkd that wrote the ` +
              `record left in place. Re-apply it by hand (aws logs put-retention-policy) or fix ` +
              `the template and re-deploy.`
          );
        }
      }
    }

    // Update KmsKeyId if changed. CFn applies it in place ("Update
    // requires: No interruption") via AssociateKmsKey / DisassociateKmsKey;
    // this previously had NO branch at all, so a KMS key change was
    // silently dropped (deploy success, AWS unchanged, state poisoned) —
    // the exact bug class of the LogGroupClass guard above. A just-created
    // same-stack key can race its key-policy propagation; the engine's
    // withRetry absorbs it via the existing retryable patterns.
    const newKmsKeyId = properties['KmsKeyId'] as string | undefined;
    const oldKmsKeyId = previousProperties['KmsKeyId'] as string | undefined;
    if (newKmsKeyId !== oldKmsKeyId) {
      if (newKmsKeyId) {
        await this.logsClient.send(
          new AssociateKmsKeyCommand({
            logGroupName: physicalId,
            kmsKeyId: newKmsKeyId,
          })
        );
      } else {
        // Removed -> disassociate; newly-ingested data falls back to the
        // CloudWatch Logs default encryption (matches CFn).
        await this.logsClient.send(
          new DisassociateKmsKeyCommand({
            logGroupName: physicalId,
          })
        );
      }
      this.logger.debug(`Updated KMS key association for log group ${physicalId}`);
    }

    // Send the retention if the COERCED value changed. Coerced, so the two
    // spellings of one retention compare equal and no redundant call goes out;
    // the values were read and validated above, before any mutation.
    //
    // `previousRetentionUnknown` is the second trigger, and without it the
    // coerced comparison DROPS a call the pre-#2521 code made. `toCfnInteger`
    // answers `undefined` for two different things — "the previous deploy
    // applied no retention" and "cdkd cannot tell what it applied" — and a
    // PRESENT, TRUTHY previous value that does not coerce is the second. Remove
    // the property against such a record (`'abc'`, `[]`, an unresolved
    // `{Ref:...}`, all of which an imported record can carry) and both sides
    // coerce to `undefined`, the `!==` never opens, and cdkd issues nothing
    // while recording absence — so a real retention on the log group would
    // survive with nothing in state pointing at it, and the next diff would see
    // no change. That is the silent-drop class this file's `LogGroupClass`
    // guard exists to prevent, arriving through the coercion.
    //
    // Scoped by `!sameRawRetention` so the import NO-OP is untouched: an
    // unusable value present identically in both bags still issues nothing, as
    // it did before. And scoped by `Boolean(rawPreviousRetention)` because a
    // FALSY previous (`''`, `false`, `null`, absent) is not unknown at all —
    // every one of them was skipped by the pre-coercion truthiness test too, so
    // no `PutRetentionPolicy` was ever issued for it and AWS provably holds no
    // retention. Removing the property against one of those is the one place
    // this change still drops a pre-#2521 call, deliberately: the call was
    // redundant. `UPDATE_MATRIX` carries a row for it.
    //
    // A WHITESPACE-ONLY previous is excluded the same way since issue [#2699]:
    // it is CloudFormation's measured spelling of "absent" (an import record
    // is the only writer — cdkd never sent one), so AWS provably holds no
    // retention for it either. `isAbsentRetention` is called with the readback
    // flag OFF: a previous-side `0` is already excluded by the truthiness test.
    const previousRetentionUnknown =
      !sameRawRetention &&
      Boolean(rawPreviousRetention) &&
      !isAbsentRetention(rawPreviousRetention, false) &&
      oldRetentionInDays === undefined;
    if (retentionInDays !== oldRetentionInDays || previousRetentionUnknown) {
      if (retentionInDays !== undefined && retentionInDays > 0) {
        await this.logsClient.send(
          new PutRetentionPolicyCommand({
            logGroupName: physicalId,
            retentionInDays,
          })
        );
      } else {
        // Remove retention policy (never expire)
        await this.logsClient.send(
          new DeleteRetentionPolicyCommand({
            logGroupName: physicalId,
          })
        );
      }
    }

    // Update DataProtectionPolicy if changed
    if (
      JSON.stringify(properties['DataProtectionPolicy']) !==
      JSON.stringify(previousProperties['DataProtectionPolicy'])
    ) {
      if (properties['DataProtectionPolicy']) {
        const policyDocument =
          typeof properties['DataProtectionPolicy'] === 'string'
            ? properties['DataProtectionPolicy']
            : JSON.stringify(properties['DataProtectionPolicy']);
        await this.logsClient.send(
          new PutDataProtectionPolicyCommand({
            logGroupIdentifier: physicalId,
            policyDocument,
          })
        );
      } else {
        await this.logsClient.send(
          new DeleteDataProtectionPolicyCommand({
            logGroupIdentifier: physicalId,
          })
        );
      }
    }

    // Update DeletionProtectionEnabled if changed. Use !== undefined so
    // explicit `false` is honored (drift --revert needs to be able to
    // clear a console-side enable).
    if (
      properties['DeletionProtectionEnabled'] !== previousProperties['DeletionProtectionEnabled']
    ) {
      const next = properties['DeletionProtectionEnabled'];
      if (next !== undefined) {
        await this.logsClient.send(
          new PutLogGroupDeletionProtectionCommand({
            logGroupIdentifier: physicalId,
            deletionProtectionEnabled: next as boolean,
          })
        );
      } else {
        // State went from set -> undefined. AWS-side default is false;
        // disable explicitly so the round-trip lands at the default.
        await this.logsClient.send(
          new PutLogGroupDeletionProtectionCommand({
            logGroupIdentifier: physicalId,
            deletionProtectionEnabled: false,
          })
        );
      }
    }

    // Update BearerTokenAuthenticationEnabled if changed. Same pattern
    // as DeletionProtectionEnabled: use !== undefined so explicit
    // `false` reaches AWS.
    if (
      properties['BearerTokenAuthenticationEnabled'] !==
      previousProperties['BearerTokenAuthenticationEnabled']
    ) {
      const next = properties['BearerTokenAuthenticationEnabled'];
      if (next !== undefined) {
        await this.logsClient.send(
          new PutBearerTokenAuthenticationCommand({
            logGroupIdentifier: physicalId,
            bearerTokenAuthenticationEnabled: next as boolean,
          })
        );
      } else {
        // State went from set -> undefined. AWS-side default is false.
        await this.logsClient.send(
          new PutBearerTokenAuthenticationCommand({
            logGroupIdentifier: physicalId,
            bearerTokenAuthenticationEnabled: false,
          })
        );
      }
    }

    // Update FieldIndexPolicies if changed. AWS keys the index policy by
    // logGroupIdentifier alone (one log-group-level policy max), so the
    // diff is structurally trivial: same content -> no-op; new content
    // -> Put (replaces the old one); empty -> Delete.
    const newFieldIndex = properties['FieldIndexPolicies'] as unknown[] | undefined;
    const oldFieldIndex = previousProperties['FieldIndexPolicies'] as unknown[] | undefined;
    if (JSON.stringify(newFieldIndex) !== JSON.stringify(oldFieldIndex)) {
      if (newFieldIndex && newFieldIndex.length > 0) {
        if (newFieldIndex.length > 1) {
          this.logger.debug(
            `Log group ${physicalId} declares ${newFieldIndex.length} FieldIndexPolicies; AWS only supports one log-group-level field index policy. Applying the first.`
          );
        }
        const first = newFieldIndex[0];
        const policyDocument = typeof first === 'string' ? first : JSON.stringify(first);
        await this.logsClient.send(
          new PutIndexPolicyCommand({
            logGroupIdentifier: physicalId,
            policyDocument,
          })
        );
      } else {
        // Removed -> delete the log-group-level policy. The account-level
        // policy (if any) takes over.
        try {
          await this.logsClient.send(
            new DeleteIndexPolicyCommand({ logGroupIdentifier: physicalId })
          );
        } catch (err) {
          if (!(err instanceof ResourceNotFoundException)) throw err;
          // Already absent; treat as success.
        }
      }
    }

    // Update Tags if changed
    const newTags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    const oldTags = previousProperties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
      const arn = await this.buildArn(physicalId);
      // Remove old tags
      if (oldTags && oldTags.length > 0) {
        const oldTagKeys = oldTags.map((t) => t.Key);
        await this.logsClient.send(
          new UntagResourceCommand({
            resourceArn: arn,
            tagKeys: oldTagKeys,
          })
        );
      }
      // Apply new tags
      if (newTags && newTags.length > 0) {
        const tagsMap = Object.fromEntries(newTags.map((t) => [t.Key, t.Value]));
        await this.logsClient.send(
          new TagResourceCommand({
            resourceArn: arn,
            tags: tagsMap,
          })
        );
      }
      this.logger.debug(`Updated tags for log group ${physicalId}`);
    }

    const arn = await this.buildArn(physicalId);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: arn,
      },
    };
  }

  /**
   * Delete a CloudWatch Logs log group
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting log group ${logicalId}: ${physicalId}`);

    // `--remove-protection`: flip DeletionProtectionEnabled off before
    // delete. Idempotent — AWS accepts the call when protection is
    // already disabled. Non-fatal: log at debug if the flip-off itself
    // errors (NotFound / similar) so the actual delete attempt still
    // runs and surfaces its own error message.
    if (context?.removeProtection === true) {
      try {
        await this.logsClient.send(
          new PutLogGroupDeletionProtectionCommand({
            logGroupIdentifier: physicalId,
            deletionProtectionEnabled: false,
          })
        );
        this.logger.debug(
          `Disabled DeletionProtectionEnabled on log group ${logicalId} before delete`
        );
      } catch (flipError) {
        this.logger.debug(
          `Could not disable DeletionProtectionEnabled on ${physicalId}: ${describeAwsFailure(flipError).detail}`
        );
      }
    }

    try {
      await this.logsClient.send(new DeleteLogGroupCommand({ logGroupName: physicalId }));
      this.logger.debug(`Successfully deleted log group ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.logsClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Log group ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete log group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Build log group ARN from name.
   *
   * The partition is derived from the region through the same closed mapping
   * `${AWS::Partition}` uses (issue #1815) rather than hardcoded to `aws` —
   * this ARN is recorded into state and served as the log group's `Arn`
   * attribute, so a commercial literal is structurally valid but wrong in
   * `aws-cn` / `aws-us-gov` and nothing downstream rejects it.
   */
  private async buildArn(logGroupName: string): Promise<string> {
    try {
      const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
      const accountId = identity.Account;
      // Region comes from the client config
      const region = (await this.logsClient.config.region()) || ambientRegion() || 'us-east-1';
      const { partition } = derivePartitionAndUrlSuffix(region);
      return `arn:${partition}:logs:${region}:${accountId}:log-group:${logGroupName}:*`;
    } catch {
      // Fallback: return a placeholder ARN. The region / account segments stay
      // the pre-existing `unknown` sentinels — nothing resolved them.
      //
      // `AWS_REGION` is a BEST-EFFORT hint for the partition, not an
      // authoritative read: this arm is dominated by the STS failure above
      // (the account lookup runs first), so the client's own region is
      // usually still available, and `AWS_REGION` is only the SECOND source
      // in the try arm's chain — the shared `AwsClients` logs client may have
      // been built from an explicit `AwsClientConfig.region` or from the SDK's
      // own chain instead. What it does guarantee is the direction: an unset
      // or unrecognized value derives to the commercial `aws`, so this is
      // byte-identical to the old placeholder wherever it was right, and a
      // non-commercial `AWS_REGION` upgrades it rather than leaving a silent
      // commercial claim.
      const { partition } = derivePartitionAndUrlSuffix(ambientRegion() ?? '');
      return `arn:${partition}:logs:unknown:unknown:log-group:${logGroupName}:*`;
    }
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing log group.
   *
   * CloudFormation's `AWS::Logs::LogGroup` exposes only `Arn`. The ARN is
   * derivable from the log group name + account + region via the existing
   * `buildArn` helper. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-loggroup.html#aws-resource-logs-loggroup-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName !== 'Arn') {
      return undefined;
    }
    return this.buildArn(physicalId);
  }

  /**
   * Read the AWS-current log group configuration in CFn-property shape.
   *
   * Issues `DescribeLogGroups` filtered by exact name and picks the first
   * (and only) match. AWS uses camelCase field names in the API response
   * (`logGroupName`, `kmsKeyId`, `retentionInDays`); we map them back to
   * the CFn-cased keys cdkd state holds (`LogGroupName`, `KmsKeyId`,
   * `RetentionInDays`).
   *
   * Coverage: `LogGroupName`, `KmsKeyId`, `RetentionInDays`,
   * `LogGroupClass`, `Tags`, `DataProtectionPolicy` (via
   * `GetDataProtectionPolicy`, JSON-parsed back to the object form
   * cdkd state holds), `DeletionProtectionEnabled` and
   * `BearerTokenAuthenticationEnabled` (both surfaced directly from
   * `DescribeLogGroups` — the SDK's LogGroup type carries them as
   * `deletionProtectionEnabled` / `bearerTokenAuthenticationEnabled`),
   * and `FieldIndexPolicies` (via `DescribeIndexPolicies`, filtered to
   * log-group-level policies and JSON-parsed). Still out of scope:
   * `ResourcePolicyDocument`, which is declared in
   * {@link unhandledByDesign} (issue #1412) — it is managed by the separate
   * account-wide `AWS::Logs::ResourcePolicy` resource type, so a log group
   * whose template sets it routes via Cloud Control rather than through this
   * provider at all.
   *
   * Write-side coverage: `FieldIndexPolicies` is applied via
   * `PutIndexPolicy` (CloudWatch Logs allows at most one log-group-level
   * field index policy at a time, so the CFn array is effectively 0-or-1
   * — the first entry is applied and a debug log notes any additional
   * entries are ignored). `DeletionProtectionEnabled` is forwarded as
   * part of `CreateLogGroup` and updated via
   * `PutLogGroupDeletionProtection`. `BearerTokenAuthenticationEnabled`
   * is applied via `PutBearerTokenAuthentication` after the log group
   * exists (it is not part of `CreateLogGroupRequest`).
   *
   * Tags are read via `ListTagsForResource` (using the log-group ARN from
   * the same `DescribeLogGroups` response). CDK's `aws:*` auto-tags are
   * filtered out so they don't fire false-positive drift; the result key is
   * omitted entirely when AWS reports no user tags.
   *
   * Returns `undefined` when the log group is gone.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.logsClient.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: physicalId })
      );
      // logGroupNamePrefix is a prefix match; pick the exact match if any.
      const found = resp.logGroups?.find((g) => g.logGroupName === physicalId);
      if (!found) return undefined;

      const result: Record<string, unknown> = {};
      if (found.logGroupName !== undefined) result['LogGroupName'] = found.logGroupName;
      result['KmsKeyId'] = found.kmsKeyId ?? '';
      // Always-emit per docs/provider-rules.md#readcurrentstate-for-drift-detection: a console-side
      // attach of a retention policy on a previously-unbounded log group
      // must surface as drift. `0` is the semantic "never expire"
      // placeholder — `update()` sends `DeleteRetentionPolicyCommand` for it
      // (its send gate is `retentionInDays !== undefined && > 0` since issue
      // [#2521], where it used to be a bare truthiness test), so the
      // round-trip is a no-op when state and AWS both have no retention.
      result['RetentionInDays'] = found.retentionInDays ?? 0;
      if (found.logGroupClass !== undefined) result['LogGroupClass'] = found.logGroupClass;
      // DeletionProtectionEnabled / BearerTokenAuthenticationEnabled —
      // both are returned directly by DescribeLogGroups. Always-emit
      // false placeholder for console-side toggle detection.
      result['DeletionProtectionEnabled'] = found.deletionProtectionEnabled ?? false;
      result['BearerTokenAuthenticationEnabled'] = found.bearerTokenAuthenticationEnabled ?? false;

      // Tags via ListTagsForResource. Logs ARNs include a trailing ":*"
      // wildcard that ListTagsForResource rejects — strip it.
      let tags: Array<{ Key: string; Value: string }> = [];
      if (found.arn) {
        const arnForTags = found.arn.replace(/:\*$/, '');
        try {
          const tagsResp = await this.logsClient.send(
            new ListTagsForResourceCommand({ resourceArn: arnForTags })
          );
          tags = normalizeAwsTagsToCfn(tagsResp.tags);
        } catch (err) {
          if (err instanceof ResourceNotFoundException) return undefined;
          throw err;
        }
      }
      // Always-emit: a console-side tag add on an initially-untagged log
      // group must surface as drift (state=[] vs AWS=[{...}]).
      result['Tags'] = tags;

      // DataProtectionPolicy via GetDataProtectionPolicy. AWS returns the
      // policy as a JSON string; we re-parse so the comparator matches
      // cdkd state's already-resolved object form. Always-emit `''` when
      // no policy is configured so a console-side ADD is detectable on
      // the v3 observedProperties baseline. (The empty string round-trips
      // through update()'s truthy gate as DeleteDataProtectionPolicy.)
      let dpp: unknown = '';
      try {
        const dppResp = await this.logsClient.send(
          new GetDataProtectionPolicyCommand({ logGroupIdentifier: physicalId })
        );
        if (dppResp.policyDocument) {
          try {
            dpp = JSON.parse(dppResp.policyDocument);
          } catch {
            dpp = dppResp.policyDocument;
          }
        }
      } catch {
        // Best-effort — leave the empty placeholder.
      }
      result['DataProtectionPolicy'] = dpp;

      // FieldIndexPolicies via DescribeIndexPolicies. AWS returns
      // IndexPolicy[] where each entry has policyDocument (JSON string)
      // + source ('LOG_GROUP' / 'ACCOUNT'). We filter to log-group-level
      // policies (excluding inherited account-level policies) and parse
      // the JSON document so the comparator matches cdkd state's
      // already-resolved object form. CFn shape is an array of policy
      // documents (strings or objects). Always-emit [] for console-
      // side ADD detection.
      let fieldIndexPolicies: unknown[] = [];
      try {
        const idxResp = await this.logsClient.send(
          new DescribeIndexPoliciesCommand({ logGroupIdentifiers: [physicalId] })
        );
        const logGroupLevel = (idxResp.indexPolicies ?? []).filter((p) => p.source !== 'ACCOUNT');
        fieldIndexPolicies = logGroupLevel
          .map((p): unknown => {
            if (!p.policyDocument) return undefined;
            try {
              return JSON.parse(p.policyDocument) as unknown;
            } catch {
              return p.policyDocument;
            }
          })
          .filter((p): p is unknown => p !== undefined);
      } catch {
        // Best-effort.
      }
      result['FieldIndexPolicies'] = fieldIndexPolicies;

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Adopt an existing CloudWatch Logs log group into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.LogGroupName` → verify via
   *     `DescribeLogGroups` (filtered by name prefix).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'LogGroupName');
    if (explicit) {
      try {
        const resp = await this.logsClient.send(
          new DescribeLogGroupsCommand({ logGroupNamePrefix: explicit })
        );
        const found = resp.logGroups?.find((g) => g.logGroupName === explicit);
        return found ? { physicalId: explicit, attributes: {} } : null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a log
    // group reaching here needs an explicit `--resource` override.
    return null;
  }
}
