import type { IAMRoleProvider } from '../iam-role-provider.js';
import {
  UpdateRoleCommand,
  UpdateAssumeRolePolicyCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  TagRoleCommand,
  UntagRoleCommand,
  PutRolePermissionsBoundaryCommand,
  DeleteRolePermissionsBoundaryCommand,
} from '@aws-sdk/client-iam';
import { safeStringify } from '../../../utils/aws-failure-text.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import {
  generateResourceNameWithFallback,
  recordedGeneratedNameKept,
} from '../../resource-name.js';
import { withRemovalDefaults } from '../../update-removal.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import {
  createMaskedLogSinks,
  isSecretDerivedValue,
  maskerOrIdentity,
  withDerivedNameMasks,
  type MaskedLogSinks,
} from '../../masked-retry-logger.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import type {
  UpdateContext,
  InlinePolicyClaimed,
  ResourceUpdateResult,
} from '../../../types/resource.js';

/**
 * Update an IAM role
 */
export async function update(
  this: IAMRoleProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // The re-create below takes the template bag: a reset is an UPDATE value,
  // so a key the caller injected one for (#1160) is taken back out. Defensive
  // since #5004: the only reset left is Description '', which create() skips
  // anyway because it sends Description only when truthy.
  const templateProperties: Record<string, unknown> = { ...properties };
  for (const key of context?.removedProperties ?? []) {
    if (this.removalDefaults.get(resourceType)?.has(key) === true) delete templateProperties[key];
  }
  properties = withRemovalDefaults(
    this.removalDefaults,
    resourceType,
    properties,
    previousProperties,
    context
  );
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const derivedRoleName = generateResourceNameWithFallback(
    properties['RoleName'] as string | undefined,
    logicalId,
    { maxLength: 64 }
  );
  // Issue #2177 -- see `create()`, including the derived-name needles. The
  // recorded name is paired with the PREVIOUS value it was derived from, and
  // with the DESIRED one too: on a `drift --revert` the previous side is an
  // AWS readback (never secret-derived) while the desired bag re-resolved the
  // secret the recorded name was built from, and a truncated recorded name
  // contains no copy of the derived needle (issue #4023).
  const log = withDerivedNameMasks(
    this.logger,
    createMaskedLogSinks(this.logger, context?.maskSecrets),
    [
      [properties['RoleName'], derivedRoleName],
      [previousProperties['RoleName'], physicalId],
      // Only on a revert: on a template-path rename the recorded name is
      // NOT derived from the desired value, and masking it would hide the
      // old name for no reason.
      ...(context?.desiredFromAwsReadback === true
        ? [[properties['RoleName'], physicalId] as [unknown, string]]
        : []),
    ]
  );
  const { value: v } = log;
  log.debug(`Updating IAM role ${logicalId}: ${v(physicalId)}`);

  // Issue #4023: `cdkd drift --revert` keeps the recorded name. The name is
  // derived in the CALLER's stack-name / prefix scope, which a revert does
  // not reproduce, and its desired bag can carry the template's pre-prefix
  // name (a legacy `--prefix-user-supplied-names` stack with no observed
  // baseline) — so a mismatch there is not a rename the user asked for, and
  // the replacement arm below would create a role under the derived name and
  // delete the live one. A role cannot be renamed in place anyway.
  const revertKeepsName =
    context?.desiredFromAwsReadback === true && derivedRoleName !== physicalId;
  if (revertKeepsName) {
    log.warn(
      `IAM role ${logicalId}: RoleName is not reverted — the role ${v(physicalId)} keeps ` +
        `its name (the reverted properties derive ${v(derivedRoleName)}), since a drift ` +
        `revert never replaces a role. 'cdkd drift' keeps reporting the name until ` +
        `'cdkd drift --accept' records the live one; only a deploy renames the role.`
    );
  }
  // go-to-k/cdkd#5064: an un-named role whose recorded name differs from the
  // derivation only by the naming scheme keeps it, never a replacement.
  const generatedNameKept = recordedGeneratedNameKept({
    recorded: physicalId,
    derived: derivedRoleName,
    declaredName: properties['RoleName'],
    previousDeclaredName: previousProperties['RoleName'],
    logicalId,
    options: { maxLength: 64 },
  });
  if (generatedNameKept) {
    log.debug(
      `IAM role ${logicalId}: keeping its generated name ${v(physicalId)} (the template names no role)`
    );
  }
  const newRoleName = revertKeepsName || generatedNameKept ? physicalId : derivedRoleName;

  // Check if immutable properties changed (requires replacement)
  // RoleName and Path are immutable - cannot be changed after creation
  const newPath = (properties['Path'] as string | undefined) || '/';
  const oldPath = (previousProperties['Path'] as string | undefined) || '/';
  // A secret-derived Path is recorded as its `{{resolve:...}}` reference and
  // handed here resolved (go-to-k/cdkd#4275). The template did not change it:
  // a changed reference is a replacement the engine plans before any update.
  // So it is never a Path change here — refusing it would let `--replace`'s
  // fallback delete and re-create the role on an unrelated update. A secret
  // ROTATED under the reference is not applied, as CloudFormation keeps a
  // create-only value its template did not change; the live path is read to
  // say so. A rename needs no Path evidence, so it reads nothing.
  const pathBehindSecret =
    newRoleName === physicalId &&
    newPath !== oldPath &&
    isSecretDerivedValue(previousProperties['Path'], maskerOrIdentity(undefined));
  let livePath: string | undefined;
  if (pathBehindSecret) {
    try {
      livePath = (await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }))).Role
        ?.Path;
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to read the path of IAM role ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }
  if (pathBehindSecret) {
    // No live path means the role cannot be shown to be the recorded one:
    // fail closed, and NOT as update-not-supported, which `--replace` would
    // turn into a delete.
    if (livePath === undefined || livePath === '') {
      throw markNonRetryable(
        new ProvisioningError(
          `IAM role ${logicalId}: its Path comes from a secret reference, and IAM returned no ` +
            `path for ${v(physicalId)} to confirm it against. Nothing was changed.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    if (livePath !== newPath) {
      // Neither path is printed: both are secret values.
      log.warn(
        `IAM role ${logicalId}: the secret its Path comes from now resolves to a different ` +
          `path than the role ${v(physicalId)} has. A role cannot move in place, so it keeps ` +
          `its path; the new value takes effect when the template changes the reference, ` +
          `which replaces the role.`
      );
    }
  }
  const pathChanged = newPath !== oldPath && !pathBehindSecret;
  const needsReplacement = newRoleName !== physicalId || pathChanged;

  // Issue #4023: the replacement arm re-derives the name inside `create()`,
  // so on a revert it would still create under the derived name and delete
  // the recorded role. A revert restores the recorded resource and never
  // replaces it: refuse before any call.
  if (needsReplacement && context?.desiredFromAwsReadback === true) {
    throw markNonRetryable(
      new ProvisioningError(
        `IAM role ${logicalId}: Path cannot be reverted to ${v(newPath)} — a role's Path ` +
          `cannot change in place, and a drift revert never replaces the role ` +
          `${v(physicalId)}. Nothing was changed; deploy the stack to replace it.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }

  // Issue #4739: the re-create below asks for `newRoleName`, which a Path-only
  // change leaves equal to the live role's name, and IAM role names are unique
  // whatever the path, so CreateRole could only fail `EntityAlreadyExists`.
  // The registry classifies a Path change as a replacement, so a deploy never
  // routes one here; a caller that still does gets the update-not-supported
  // refusal, which the engine's fallback turns into a delete-first replacement
  // under `--replace`, before any call.
  if (needsReplacement && newRoleName === physicalId) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      log.mask(
        `Path changed from ${v(oldPath)} to ${v(newPath)}, and an IAM role cannot move to ` +
          `another path; a replacement under the same name ${v(physicalId)} must delete the ` +
          `role first — re-deploy with --replace, or give the role a new name`
      )
    );
  }

  if (needsReplacement) {
    // Only a rename reaches here: a Path-only change was refused above.
    log.debug(
      `RoleName changed, replacing role: ${v(physicalId)} (RoleName: from ${v(physicalId)} to ${v(newRoleName)})`
    );

    // Create new role. The masker is forwarded (issue #2177) and NOTHING
    // else: this context never carries `replayingState`, so a create-side
    // pre-flight refusal would still fire on a rollback replay (see
    // `CreateContext`).
    // Rebound rather than passed by its own name, so the wiring generator
    // still traces the bag into `create()`.
    properties = templateProperties;
    const createResult = await this.create(logicalId, resourceType, properties, {
      maskSecrets: log.mask,
    });

    // Delete old role with full cleanup (managed policies, inline policies, instance profiles)
    // What the inner delete left behind, if anything (issue #1819). The new
    // role already exists, so the replacement cannot be aborted — the honest
    // outcome is "updated, and the old role survives", which is what the
    // update's `'partial'` arm says. Before that channel existed this was a
    // `logger.warn` and the deploy exited 0 with the old role alive and no
    // longer in cdkd state.
    let orphanReason: string | undefined;
    try {
      // The OLD name can be secret-derived too (go-to-k/cdkd#2007).
      const deleteResult = await this.delete(logicalId, physicalId, resourceType, undefined, {
        maskSecrets: log.mask,
      });
      // Issue #1778: a SKIP is a non-throwing "I did not address this
      // resource", so it sails straight past the catch below — the one path
      // that would have told the user the old role is still there.
      if (deleteResult?.outcome === 'skipped') {
        orphanReason = log.mask(
          `old role ${v(physicalId)} was not deleted: ${deleteResult.reason}`
        );
        log.warn(
          `Skipped deleting old role ${v(physicalId)} during replacement: ${deleteResult.reason}. ` +
            `The old role may be orphaned and require manual cleanup.`
        );
      }
    } catch (error) {
      // No `oldResourceSurvivor: 'kept'` (go-to-k/cdkd#4911): `delete()`
      // strips the role before `DeleteRole` refuses, so it is not whole.
      // `error` is `delete()`'s wrap, which names an AWS failure by its class
      // (go-to-k/cdkd#2319): this reason is persisted as a RESOURCE_SKIPPED.
      orphanReason = log.mask(
        `old role ${v(physicalId)} could not be deleted: ${safeStringify(error)}`
      );
      log.warn(
        `Failed to delete old role ${v(physicalId)} during replacement: ${v(safeStringify(error))}. ` +
          `The old role may be orphaned and require manual cleanup.`
      );
    }

    const base = {
      physicalId: createResult.physicalId,
      wasReplaced: true as const,
      ...(createResult.attributes ? { attributes: createResult.attributes } : {}),
    };
    // The old physical id travels in the reason: state now points at the NEW
    // role and nothing else downstream still knows the one that survived.
    return orphanReason !== undefined
      ? { ...base, outcome: 'partial' as const, reason: orphanReason }
      : base;
  }

  try {
    // Update role properties (Description, MaxSessionDuration)
    const updateParams: {
      RoleName: string;
      Description?: string;
      MaxSessionDuration?: number;
    } = {
      RoleName: physicalId,
    };

    // A REMOVED field arrives as its `removalDefaults` reset (issue
    // #1160); a field that was never set stays absent (no spurious
    // reset). An explicit user-supplied '' Description passes through
    // too — the `!== undefined` behavior that fixed the `cdkd drift
    // --revert` "reverted but re-detected" symptom; a truthy gate would
    // silently drop the empty string.
    const descriptionInput = properties['Description'] as string | undefined;
    if (descriptionInput !== undefined) {
      updateParams.Description = descriptionInput;
    }
    const maxSessionDurationInput = properties['MaxSessionDuration'] as number | undefined;
    if (maxSessionDurationInput !== undefined) {
      updateParams.MaxSessionDuration = maxSessionDurationInput;
    }

    await this.iamClient.send(new UpdateRoleCommand(updateParams));

    // Update AssumeRolePolicyDocument if changed
    const newAssumePolicy = properties['AssumeRolePolicyDocument'];
    const oldAssumePolicy = previousProperties['AssumeRolePolicyDocument'];
    if (newAssumePolicy) {
      const newPolicyStr =
        typeof newAssumePolicy === 'string' ? newAssumePolicy : JSON.stringify(newAssumePolicy);
      const oldPolicyStr = oldAssumePolicy
        ? typeof oldAssumePolicy === 'string'
          ? oldAssumePolicy
          : JSON.stringify(oldAssumePolicy)
        : '';

      if (newPolicyStr !== oldPolicyStr) {
        await this.iamClient.send(
          new UpdateAssumeRolePolicyCommand({
            RoleName: physicalId,
            PolicyDocument: newPolicyStr,
          })
        );
        log.debug(`Updated assume role policy for ${v(physicalId)}`);
      }
    }

    // Update PermissionsBoundary
    const newBoundary = properties['PermissionsBoundary'] as string | undefined;
    const oldBoundary = previousProperties['PermissionsBoundary'] as string | undefined;
    if (newBoundary !== oldBoundary) {
      if (newBoundary) {
        await this.iamClient.send(
          new PutRolePermissionsBoundaryCommand({
            RoleName: physicalId,
            PermissionsBoundary: newBoundary,
          })
        );
        log.debug(`Set permissions boundary for ${v(physicalId)}: ${v(newBoundary)}`);
      } else if (oldBoundary) {
        await this.iamClient.send(
          new DeleteRolePermissionsBoundaryCommand({
            RoleName: physicalId,
          })
        );
        log.debug(`Removed permissions boundary from ${v(physicalId)}`);
      }
    }

    // Update managed policies
    await this.updateManagedPolicies(
      physicalId,
      properties['ManagedPolicyArns'] as string[] | undefined,
      previousProperties['ManagedPolicyArns'] as string[] | undefined,
      log
    );

    // Update inline policies
    await this.updateInlinePolicies(
      physicalId,
      properties['Policies'] as Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
      previousProperties['Policies'] as
        | Array<{ PolicyName: string; PolicyDocument: unknown }>
        | undefined,
      log,
      context?.inlinePolicyClaimed
    );

    // Update tags
    await this.updateTags(
      physicalId,
      resourceType,
      logicalId,
      properties['Tags'],
      previousProperties['Tags'],
      log
    );

    log.debug(`Successfully updated IAM role ${logicalId}`);

    // Get updated role info
    const getRoleResponse = await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));

    const attributes = {
      Arn: getRoleResponse.Role?.Arn,
      RoleId: getRoleResponse.Role?.RoleId,
    };

    return {
      physicalId,
      wasReplaced: false,
      attributes,
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    // Redacted or masked RAW, and stamped, as in `create()` (`wrapMaskedError`).
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update IAM role ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Update managed policies attached to role
 */
export async function updateManagedPolicies(
  this: IAMRoleProvider,
  roleName: string,
  newPolicies: string[] | undefined,
  oldPolicies: string[] | undefined,
  log: MaskedLogSinks
): Promise<void> {
  const { value: v } = log;
  const newSet = new Set(newPolicies || []);
  const oldSet = new Set(oldPolicies || []);

  // Attach new policies
  for (const policyArn of newSet) {
    if (!oldSet.has(policyArn)) {
      await this.iamClient.send(
        new AttachRolePolicyCommand({
          RoleName: roleName,
          PolicyArn: policyArn,
        })
      );
      log.debug(`Attached managed policy ${v(policyArn)}`);
    }
  }

  // Detach removed policies
  for (const policyArn of oldSet) {
    if (!newSet.has(policyArn)) {
      await this.iamClient.send(
        new DetachRolePolicyCommand({
          RoleName: roleName,
          PolicyArn: policyArn,
        })
      );
      log.debug(`Detached managed policy ${v(policyArn)}`);
    }
  }
}

/**
 * Update inline policies
 */
export async function updateInlinePolicies(
  this: IAMRoleProvider,
  roleName: string,
  newPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
  oldPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
  log: MaskedLogSinks,
  claimed?: InlinePolicyClaimed
): Promise<void> {
  const { value: v } = log;
  const newMap = new Map((newPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));
  const oldMap = new Map((oldPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));

  // Add or update policies
  for (const [policyName, policyDoc] of newMap) {
    const policyDocument = typeof policyDoc === 'string' ? policyDoc : JSON.stringify(policyDoc);

    await this.iamClient.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: policyName,
        PolicyDocument: policyDocument,
      })
    );
    log.debug(`Updated inline policy ${v(policyName)}`);
  }

  // Delete removed policies
  // go-to-k/cdkd#4225: a name another resource has ALREADY written onto
  // this role in the same run is not removed. Set by a rollback revert,
  // where the policy that took this name over may have been put back
  // before this principal's own revert drops it.
  for (const policyName of oldMap.keys()) {
    if (!newMap.has(policyName)) {
      if (claimed?.('role', roleName, policyName) === true) {
        log.debug(
          `Kept inline policy ${v(policyName)} on role ${v(roleName)}: another resource of this deploy or rollback wrote it`
        );
        continue;
      }
      await this.iamClient.send(
        new DeleteRolePolicyCommand({
          RoleName: roleName,
          PolicyName: policyName,
        })
      );
      log.debug(`Deleted inline policy ${v(policyName)}`);
    }
  }
}

/**
 * Update tags on the role. Both sides are read through `planTagDiff`
 * (go-to-k/cdkd#3994): an unreadable record untags nothing.
 */
export async function updateTags(
  this: IAMRoleProvider,
  roleName: string,
  resourceType: string,
  logicalId: string,
  newTags: unknown,
  oldTags: unknown,
  log: MaskedLogSinks
): Promise<void> {
  const { value: v } = log;
  const plan = planTagDiff(oldTags, newTags);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    log.warn(tagWarning);
  }
  const tagsToRemove = plan.remove;
  const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));

  if (tagsToRemove.length > 0) {
    await this.iamClient.send(
      new UntagRoleCommand({
        RoleName: roleName,
        TagKeys: tagsToRemove,
      })
    );
    log.debug(`Removed ${tagsToRemove.length} tags from role ${v(roleName)}`);
  }

  if (tagsToAdd.length > 0) {
    await this.iamClient.send(
      new TagRoleCommand({
        RoleName: roleName,
        Tags: tagsToAdd,
      })
    );
    log.debug(`Added/updated ${tagsToAdd.length} tags on role ${v(roleName)}`);
  }
}
