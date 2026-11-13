import type { IAMManagedPolicyProvider } from '../iam-managed-policy-provider.js';
import { CreatePolicyVersionCommand } from '@aws-sdk/client-iam';
import { safeStringify } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  generateResourceNameWithFallback,
  recordedGeneratedNameKept,
} from '../../resource-name.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { createMaskedLogSinks, withDerivedNameMasks } from '../../masked-retry-logger.js';
import type { UpdateContext, ResourceUpdateResult } from '../../../types/resource.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import {
  holdsSecretDerivedEntry,
  onlySecretDerived,
  recordedPrincipalsRepair,
  SECRET_DERIVED_READ_LIVE,
} from '../../iam-policy-targets.js';
import { managedPolicyAttributes, principalsOf, PRINCIPAL_NAMES } from './shared.js';

export async function update(
  this: IAMManagedPolicyProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const derivedPolicyName = generateResourceNameWithFallback(
    properties['ManagedPolicyName'] as string | undefined,
    logicalId,
    { maxLength: 128 }
  );
  const oldPolicyName = derivePolicyNameFromArn(physicalId);
  // Issue #2177 -- see `create()`, including the derived-name needles. The
  // recorded ARN's name is paired with the PREVIOUS value it was derived from,
  // and with the DESIRED one too, for the reason `IAMRoleProvider.update`
  // gives (issue #4023).
  const log = withDerivedNameMasks(
    this.logger,
    createMaskedLogSinks(this.logger, context?.maskSecrets),
    [
      [properties['ManagedPolicyName'], derivedPolicyName],
      [previousProperties['ManagedPolicyName'], oldPolicyName],
      // Only on a revert: on a template-path rename the recorded name is
      // NOT derived from the desired value, and masking it would hide the
      // old name for no reason.
      ...(context?.desiredFromAwsReadback === true
        ? [[properties['ManagedPolicyName'], oldPolicyName] as [unknown, string]]
        : []),
      // The ARN carries the PATH too (go-to-k/cdkd#4339): after a secret
      // rotation it names the pre-rotation path, which this deploy's masker
      // never resolved. The root path names nothing secret, and as a needle
      // it would hide every `/`.
      [previousProperties['Path'], recordedNonRootPath(physicalId)],
    ]
  );
  const { value: v } = log;
  log.debug(`Updating IAM managed policy ${logicalId}: ${v(physicalId)}`);
  // Issue #4023: `cdkd drift --revert` keeps the recorded name, as
  // `IAMRoleProvider.update` does and for the same reason — the derivation
  // runs outside the deploy's stack-name / prefix scope, and a policy's name
  // cannot change in place, so a mismatch would REPLACE the live policy.
  const revertKeepsName =
    context?.desiredFromAwsReadback === true && derivedPolicyName !== oldPolicyName;
  if (revertKeepsName) {
    log.warn(
      `IAM managed policy ${logicalId}: ManagedPolicyName is not reverted — the policy ` +
        `${v(oldPolicyName)} keeps its name (the reverted properties derive ` +
        `${v(derivedPolicyName)}), since a drift revert never replaces a policy. 'cdkd drift' ` +
        `keeps reporting the name until 'cdkd drift --accept' records the live one; only a ` +
        `deploy renames the policy.`
    );
  }
  // go-to-k/cdkd#5064: an un-named policy whose recorded name differs from
  // the derivation only by the naming scheme keeps it, never a replacement.
  const generatedNameKept = recordedGeneratedNameKept({
    recorded: oldPolicyName,
    derived: derivedPolicyName,
    declaredName: properties['ManagedPolicyName'],
    previousDeclaredName: previousProperties['ManagedPolicyName'],
    logicalId,
    options: { maxLength: 128 },
  });
  if (generatedNameKept) {
    log.debug(
      `IAM managed policy ${logicalId}: keeping its generated name ${v(oldPolicyName)} (the template names no policy)`
    );
  }
  const newPolicyName = revertKeepsName || generatedNameKept ? oldPolicyName : derivedPolicyName;
  // BOTH sides before any call (go-to-k/cdkd#3906). The previous side is the
  // state record, and a rollback revert or `drift --revert` replays this
  // method with a recorded bag as the DESIRED side: a string there was
  // walked by character, ATTACHING the policy to one-letter principals.
  const newPrincipals = principalsOf(properties);
  const oldPrincipals = principalsOf(previousProperties);
  // A recorded list cdkd redacted (a dynamic reference or its mask) cannot be
  // repaired in state. With a well-formed desired side it is not refused:
  // the in-place arm below reads that kind from IAM, ADD-only
  // (go-to-k/cdkd#3906).
  const liveKinds =
    !('malformed' in newPrincipals) && onlySecretDerived(oldPrincipals)
      ? oldPrincipals.malformed
      : [];
  if (liveKinds.length === 0 && ('malformed' in newPrincipals || 'malformed' in oldPrincipals)) {
    const which = [
      ...('malformed' in newPrincipals ? newPrincipals.malformed.map((k) => `desired ${k}`) : []),
      ...('malformed' in oldPrincipals ? oldPrincipals.malformed.map((k) => `recorded ${k}`) : []),
    ];
    throw new ProvisioningError(
      `${which.join(' / ')} of IAM managed policy ${logicalId} is not a list of IAM names — ` +
        `no managed policy was attached, detached or replaced` +
        ('malformed' in oldPrincipals
          ? `: ${recordedPrincipalsRepair(
              oldPrincipals.malformed,
              oldPrincipals.secretDerived,
              PRINCIPAL_NAMES,
              SECRET_DERIVED_READ_LIVE
            )}`
          : ''),
      resourceType,
      logicalId,
      physicalId
    );
  }
  const newPath = (properties['Path'] as string | undefined) || '/';
  const oldPath = (previousProperties['Path'] as string | undefined) || '/';
  const newDescription = properties['Description'] as string | undefined;
  const oldDescription = previousProperties['Description'] as string | undefined;

  // ManagedPolicyName, Path, and Description are all immutable on AWS. A
  // secret-derived Path / Description is recorded as its `{{resolve:...}}`
  // reference and handed here resolved, which is no change, so it must not
  // REPLACE the policy (go-to-k/cdkd#4275). The name is already compared with
  // the one the ARN carries; the ARN carries the path too. The description
  // has no non-secret identity, so it takes the masker arm.
  const pathChanged =
    newPath !== oldPath &&
    !(await unchangedBehindSecretReference({
      resourceType,
      key: 'Path',
      desired: newPath,
      previous: previousProperties['Path'],
      physicalName: derivePolicyPathFromArn(physicalId),
    }));
  const descriptionChanged =
    (newDescription ?? '') !== (oldDescription ?? '') &&
    !(await unchangedBehindSecretReference({
      resourceType,
      key: 'Description',
      desired: newDescription,
      previous: oldDescription,
      maskSecrets: context?.maskSecrets,
    }));
  const needsReplacement = newPolicyName !== oldPolicyName || pathChanged || descriptionChanged;

  // Issue #4023: the replacement arm re-derives the name inside `create()`,
  // so on a revert it would still create under the derived name and delete
  // the recorded policy. A revert never replaces: refuse before any call.
  if (needsReplacement && context?.desiredFromAwsReadback === true) {
    throw markNonRetryable(
      new ProvisioningError(
        `IAM managed policy ${logicalId}: ${pathChanged ? 'Path' : 'Description'} ` +
          `cannot be reverted — it cannot change in place, and a drift revert never replaces ` +
          `the policy ${v(physicalId)}. Nothing was changed; deploy the stack to replace it.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }

  if (needsReplacement) {
    const reason =
      newPolicyName !== oldPolicyName ? 'ManagedPolicyName' : pathChanged ? 'Path' : 'Description';
    log.debug(`${reason} changed, replacing managed policy: ${v(physicalId)} (${reason} mutation)`);

    // The masker is forwarded (issue #2177) and NOTHING else: this context
    // never carries `replayingState`, so a create-side pre-flight refusal
    // would still fire on a rollback replay (see `CreateContext`).
    const createResult = await this.create(logicalId, resourceType, properties, {
      maskSecrets: log.mask,
    });
    // What the inner delete left behind, if anything (issue #1819). The new
    // policy already exists, so the replacement cannot be aborted — the
    // honest outcome is "updated, and the old policy survives", which is what
    // the update's `'partial'` arm says. Before that channel existed this was
    // a `logger.warn` and the deploy exited 0 with the old policy alive and
    // no longer in cdkd state.
    let orphanReason: string | undefined;
    try {
      // This operation's masker reaches the delete's own lines too
      // (go-to-k/cdkd#4339): they name the OLD policy ARN.
      const deleteResult = await this.delete(
        logicalId,
        physicalId,
        resourceType,
        previousProperties,
        { maskSecrets: log.mask }
      );
      // Issue #1778: a SKIP is a non-throwing "I did not address this
      // resource", so it sails straight past the catch below — the one path
      // that would have told the user the old policy is still there.
      if (deleteResult?.outcome === 'skipped') {
        orphanReason = log.mask(
          `old managed policy ${v(physicalId)} was not deleted: ${deleteResult.reason}`
        );
        log.warn(
          `Skipped deleting old managed policy ${v(physicalId)} during replacement: ${deleteResult.reason}. ` +
            `The old policy may be orphaned and require manual cleanup.`
        );
      }
    } catch (error) {
      // No `oldResourceSurvivor: 'kept'` (go-to-k/cdkd#4911): `delete()`
      // detaches the policy before `DeletePolicy` refuses, so it is not whole.
      // `error` is `delete()`'s wrap, which names an AWS failure by its class
      // (go-to-k/cdkd#2319): this reason is persisted as a RESOURCE_SKIPPED.
      orphanReason = log.mask(
        `old managed policy ${v(physicalId)} could not be deleted: ${safeStringify(error)}`
      );
      log.warn(
        `Failed to delete old managed policy ${v(physicalId)} during replacement: ${v(safeStringify(error))}. ` +
          `The old policy may be orphaned and require manual cleanup.`
      );
    }

    const base = {
      physicalId: createResult.physicalId,
      wasReplaced: true as const,
      ...(createResult.attributes ? { attributes: createResult.attributes } : {}),
    };
    // The old physical id travels in the reason: state now points at the NEW
    // policy and nothing else downstream still knows the one that survived.
    return orphanReason !== undefined
      ? { ...base, outcome: 'partial' as const, reason: orphanReason }
      : base;
  }

  // The secret-derived recorded kinds come from IAM, and only to decide what
  // to ADD: IAM's list also holds attachments made elsewhere (a Role's
  // `ManagedPolicyArns`, another stack, the console), so nothing is detached
  // on its evidence. The well-formed recorded kinds keep the record.
  const oldLists = { ...oldPrincipals.lists };
  if (liveKinds.length > 0) {
    let live: Record<'Groups' | 'Roles' | 'Users', string[]>;
    try {
      live = await this.readLivePrincipals(physicalId);
    } catch (error) {
      throw new ProvisioningError(
        `the recorded ${liveKinds.join(' / ')} of IAM managed policy ${logicalId} is ` +
          `secret-derived and the policy's attachments could not be read from IAM — no ` +
          `managed policy was attached or detached`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
    // Warned only where IAM holds a name the template does not: the one case
    // the ADD-only diff leaves something the user may need to detach.
    const unmatched: string[] = [];
    for (const kind of liveKinds) {
      const desired = newPrincipals.lists[kind] ?? [];
      oldLists[kind] = live[kind].filter((name) => desired.includes(name));
      if (live[kind].some((name) => !desired.includes(name))) unmatched.push(kind);
    }
    if (unmatched.length > 0) {
      log.warn(
        `The recorded ${unmatched.join(' / ')} of IAM managed policy ${logicalId} is ` +
          `secret-derived, and IAM lists attachments the template does not name: cdkd ` +
          `detaches none of them, since IAM's list includes attachments made elsewhere. Detach ` +
          `by hand any that this list used to name.`
      );
    }
  }

  let createdVersionId: string | undefined;
  try {
    // Update PolicyDocument by creating a new version + setting as default.
    // AWS caps managed policies at 5 versions; prune the oldest non-default
    // before creating a new one when already at the cap.
    const newDocument = properties['PolicyDocument'];
    const oldDocument = previousProperties['PolicyDocument'];
    if (newDocument) {
      const newDocStr = typeof newDocument === 'string' ? newDocument : JSON.stringify(newDocument);
      const oldDocStr = oldDocument
        ? typeof oldDocument === 'string'
          ? oldDocument
          : JSON.stringify(oldDocument)
        : '';
      if (newDocStr !== oldDocStr) {
        await this.ensureVersionCapacity(physicalId, log);
        const versionResponse = await this.iamClient.send(
          new CreatePolicyVersionCommand({
            PolicyArn: physicalId,
            PolicyDocument: newDocStr,
            SetAsDefault: true,
          })
        );
        createdVersionId = versionResponse?.PolicyVersion?.VersionId;
        log.debug(`Updated PolicyDocument for ${v(physicalId)}`);
      }
    }

    // Diff principal attachments.
    await this.updatePrincipals(
      physicalId,
      newPrincipals.lists.Groups,
      oldLists.Groups,
      newPrincipals.lists.Roles,
      oldLists.Roles,
      newPrincipals.lists.Users,
      oldLists.Users,
      log
    );

    // Diff tags.
    await this.updateTags(
      physicalId,
      resourceType,
      logicalId,
      properties['Tags'],
      previousProperties['Tags'],
      log
    );

    // go-to-k/cdkd#6232: `attributes` REPLACES the record. The PolicyId never
    // changes for this ARN, so the record's is carried; the DefaultVersionId
    // is the new version's when this update created one, else the record's.
    // Anything not in hand stays absent and the resolver re-reads it.
    const recorded = context?.recordedAttributes;
    const recordedString = (key: string): string | undefined => {
      const value = recorded?.[key];
      // A redacted value (`***`, or an id the state redaction spliced a
      // `{{resolve:...}}` into) is never carried: left absent, it is re-read.
      return typeof value === 'string' && value !== '' && !holdsSecretDerivedEntry(value)
        ? value
        : undefined;
    };
    return {
      physicalId,
      wasReplaced: false,
      attributes: managedPolicyAttributes(physicalId, {
        PolicyId: recordedString('PolicyId'),
        DefaultVersionId: createdVersionId ?? recordedString('DefaultVersionId'),
      }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update IAM managed policy ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Recover the policy name from `arn:<partition>:iam::<account>:policy/<path><name>`.
 * Used to decide whether `ManagedPolicyName` was mutated relative to the
 * physical id we recorded — name + path are immutable on AWS, so any
 * difference is a replacement signal.
 */
function derivePolicyNameFromArn(arn: string): string {
  // ARN shape: arn:<partition>:iam::<account>:policy/<path-may-contain-slashes>/<name>
  // The final '/'-delimited segment is the name; path is everything between
  // the leading 'policy/' and the name. Partition-agnostic already: the parse
  // never looks left of the last '/', so no partition literal is involved.
  const ix = arn.lastIndexOf('/');
  return ix >= 0 ? arn.slice(ix + 1) : arn;
}

/**
 * The `Path` a policy ARN carries (`policy/team/a/Name` -> `/team/a/`, a bare
 * `policy/Name` -> `/`), or `undefined` when the physical id is not a policy
 * ARN, so the caller keeps its own comparison (go-to-k/cdkd#4275).
 */
function derivePolicyPathFromArn(arn: string): string | undefined {
  const marker = ':policy/';
  const at = arn.indexOf(marker);
  if (at < 0) return undefined;
  const resource = arn.slice(at + marker.length - 1);
  return resource.slice(0, resource.lastIndexOf('/') + 1);
}

/**
 * The recorded path the policy ARN carries, as a mask needle: `undefined` for
 * the root `/`, which names nothing secret and would hide every `/`
 * (go-to-k/cdkd#4339).
 */
function recordedNonRootPath(arn: string): string | undefined {
  const path = derivePolicyPathFromArn(arn);
  return path === '/' ? undefined : path;
}
