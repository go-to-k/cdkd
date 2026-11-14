import type { LogsLogGroupProvider } from '../logs-loggroup-provider.js';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import {
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  PutBearerTokenAuthenticationCommand,
  PutIndexPolicyCommand,
  PutRetentionPolicyCommand,
  PutDataProtectionPolicyCommand,
  ResourceAlreadyExistsException,
} from '@aws-sdk/client-cloudwatch-logs';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { displaySafe } from '../../../utils/display-safe.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { toCfnInteger, toFiniteNumber } from '../../dynamodb-warm-throughput.js';
import { renderDisableCommand } from '../../replacement-protection-advice.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { isAbsentRetention, assertUsableRetention } from './shared.js';

/**
 * Create a CloudWatch Logs log group
 */
export async function create(
  this: LogsLogGroupProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating log group ${logicalId}`);

  const logGroupName =
    (properties['LogGroupName'] as string | undefined) ||
    (this.generatedCreateName(resourceType, logicalId, properties) as string);

  // go-to-k/cdkd#4073: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  // go-to-k/cdkd#4583: set once THIS call created the log group (never on the
  // ResourceAlreadyExists adoption); cleared when the cleanup deleted it.
  let leftBehind = false;
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
    if (desiredTags.length > 0) {
      createParams.tags = Object.fromEntries(desiredTags.map((t) => [t.Key, t.Value]));
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
      leftBehind = true;
      reportCreatedResource(logicalId, resourceType, logGroupName);
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
          if (legacyReading !== undefined && Number.isInteger(legacyReading) && legacyReading > 0) {
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
          leftBehind = false;
          retractCreatedResource(logicalId, resourceType, logGroupName);
          this.logger.debug(
            `Cleaned up partially-created log group ${displaySafe(logicalId)} (${displaySafe(logGroupName)}) after wiring failure`
          );
        } catch (cleanupError) {
          // The same-provider sibling of the #2669 remedy (`update.ts`): a pasteable command
          // naming a TEMPLATE-chosen name, hand-quoted until that issue.
          // Rendered through the shared sanitize / quote / suppress, so the
          // COMMAND never carries a quote or a control byte raw. The PROSE
          // copy of the name goes through `displaySafe` (issue #3269).
          //
          // Masked like the SSM and S3 twins of this arm: `logGroupName` is
          // a RESOLVED property value and a provider's own `logger.warn`
          // reaches no engine sink. The name is masked BEFORE `displaySafe`,
          // which rewrites characters a literal-occurrence masker matches
          // on, and the masker is threaded into the renderer so a
          // secret-bearing name suppresses the command rather than reaching
          // it through `shellQuote`'s escaping.
          const mask = maskerOrIdentity(context?.maskSecrets);
          const deleteCommand = renderDisableCommand({
            before: 'aws logs delete-log-group --log-group-name',
            identifier: logGroupName,
            maskSecrets: mask,
          });
          const manualStep = deleteCommand
            ? `Outside a rollback's re-create, the failed deploy's rollback journal records it for ${proseQuoted(cdkdRemedy('cdkd rollback', '--revert-failed'), '`')}; otherwise delete it yourself before the next deploy: ${deleteCommand}`
            : `Outside a rollback's re-create, the failed deploy's rollback journal records it for ${proseQuoted(cdkdRemedy('cdkd rollback', '--revert-failed'), '`')}; otherwise delete it yourself before the next deploy, via the console: the log ` +
              'group name cannot be reproduced safely on a command line.';
          // An AWS-authored failure is named by its class at warn, and AWS's
          // text (a denied `DeleteLogGroup` names the caller) goes to `debug`
          // under the same head (go-to-k/cdkd#2319).
          const cleanupFailure = describeAwsFailure(cleanupError);
          const cleanupHead = `Failed to clean up partially-created log group ${displaySafe(logicalId)} (${displaySafe(mask(logGroupName))}): `;
          if (cleanupFailure.redacted) {
            this.logger.debug(mask(`${cleanupHead}${cleanupFailure.detail}`));
          }
          this.logger.warn(
            mask(
              `${cleanupHead}${cleanupFailure.redacted ? `${cleanupFailure.summary} ` : `${cleanupFailure.detail}. `}${manualStep}`
            )
          );
        }
      }
      // The log group itself is in hand: an "already exists" from its wiring
      // is an auxiliary object's, not this log group's (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
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
    // CreateLogGroup sends the resolved tag values, which an AWS error can
    // echo: the message goes through the operation's masker.
    const mask = maskerOrIdentity(context?.maskSecrets);
    const thrown = this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create log group ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          logGroupName,
          cause
        )
    );
    if (leftBehind) markCreatedBeforeFailure(thrown, logicalId, resourceType, logGroupName);
    throw thrown;
  }
}
