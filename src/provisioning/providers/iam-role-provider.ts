import {
  IAMClient,
  CreateRoleCommand,
  UpdateRoleCommand,
  UpdateAssumeRolePolicyCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  ListRolePoliciesCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListInstanceProfilesForRoleCommand,
  RemoveRoleFromInstanceProfileCommand,
  TagRoleCommand,
  UntagRoleCommand,
  PutRolePermissionsBoundaryCommand,
  DeleteRolePermissionsBoundaryCommand,
  ListRoleTagsCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { definedAttributes } from '../attribute-map.js';
import { describeAwsFailure, safeStringify } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { IamCreateClientCache } from './iam-create-client.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceNameWithFallback } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { withRemovalDefaults } from '../update-removal.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { markNonRetryable, wrapMaskedAwsError } from '../../deployment/retryable-errors.js';
import type {
  CreateContext,
  UpdateContext,
  InlinePolicyClaimed,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';

/**
 * AWS IAM Role Provider
 *
 * Implements resource provisioning for AWS::IAM::Role using the IAM SDK.
 * This is required because IAM Role is not supported by Cloud Control API.
 */
export class IAMRoleProvider implements ResourceProvider {
  private iamClient: IAMClient;
  /** `CreateRole` goes through this client, which refuses the SDK retry of a 5xx (issue #4639). */
  private readonly createClient = new IamCreateClientCache(() => this.iamClient);
  private logger = getLogger().child('IAMRoleProvider');

  /**
   * A failure wrap quoting the caught error's text through the operation's
   * masker (issue #2177). The `cause` stays unmasked, and a message the mask
   * changed is stamped so the retry classifiers read that chain rather than
   * the masked message, whose IAM-propagation wording a secret needle could
   * cut (`wrapMaskedAwsError`, issue #4244). A method, so
   * `gen-update-wrap-coverage` sees the catch that throws it as a wrap.
   */
  private wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedAwsError(mask, error, build);
  }

  /**
   * The sinks the DELETE path hands the cleanup helpers it shares with
   * `create()`: `DeleteContext` carries no masker (issue #2007), so these are
   * identity. Spelled at the call site rather than as a parameter default, so a
   * create-path caller that forgets its own sinks is a type error.
   */
  private unmaskedDeleteSinks(): MaskedLogSinks {
    return createMaskedLogSinks(this.logger, undefined);
  }
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::IAM::Role',
      new Set([
        'RoleName',
        'AssumeRolePolicyDocument',
        'Description',
        'MaxSessionDuration',
        'Path',
        'PermissionsBoundary',
        'ManagedPolicyArns',
        'Policies',
        'Tags',
      ]),
    ],
  ]);

  /**
   * Issue #1160: IAM `UpdateRole` has merge semantics — an ABSENT input field
   * means "no change" (live-verified 2026-07-27) — while CFn resets a
   * template-removed property to its default.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::IAM::Role',
      new Map<string, unknown>([
        // The AWS-documented clear sentinel.
        ['Description', ''],
        // The IAM / CFn default.
        ['MaxSessionDuration', 3600],
      ]),
    ],
  ]);

  /** Issue #1160: every other property, each removal handled by `update()`. */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::IAM::Role',
      new Set([
        // Create-only, or required.
        'RoleName',
        'Path',
        'AssumeRolePolicyDocument',
        // Each diffed by its own call, removal included.
        'PermissionsBoundary',
        'ManagedPolicyArns',
        'Policies',
        'Tags',
      ]),
    ],
  ]);

  constructor() {
    // Use global AWS clients manager for better resource management
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  /**
   * Create an IAM role
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    // Issue #2177: ONE masked sink per operation (the `ssm-parameter-provider.ts`
    // shape), and every bag-derived value masked RAW as well -- the name, the
    // attached ARNs and the inline policy names all come out of the resolved
    // `properties` bag. Absent context means identity.
    const roleName = generateResourceNameWithFallback(
      properties['RoleName'] as string | undefined,
      logicalId,
      { maxLength: 64 }
    );
    // The physical name is REWRITTEN from the template value (stack prefix,
    // charset folding, truncation), so the masker cannot recognise it by
    // itself: add it as a needle when the value it came from is a secret.
    const log = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      [[properties['RoleName'], roleName]]
    );
    const { value: v } = log;
    log.debug(`Creating IAM role ${logicalId}`);
    const assumeRolePolicyDocument = properties['AssumeRolePolicyDocument'];

    if (!assumeRolePolicyDocument) {
      throw new ProvisioningError(
        `AssumeRolePolicyDocument is required for IAM role ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // go-to-k/cdkd#4583: set once CreateRole returns; cleared when the
    // partial-create cleanup deleted the role, so only a left-behind one is marked.
    let leftBehind = false;
    try {
      // Serialize policy document
      const policyDocument =
        typeof assumeRolePolicyDocument === 'string'
          ? assumeRolePolicyDocument
          : JSON.stringify(assumeRolePolicyDocument);

      // Create role
      const createParams: {
        RoleName: string;
        AssumeRolePolicyDocument: string;
        Description?: string;
        MaxSessionDuration?: number;
        Path?: string;
        PermissionsBoundary?: string;
      } = {
        RoleName: roleName,
        AssumeRolePolicyDocument: policyDocument,
      };

      if (properties['Description']) {
        createParams.Description = properties['Description'] as string;
      }
      if (properties['MaxSessionDuration']) {
        createParams.MaxSessionDuration = properties['MaxSessionDuration'] as number;
      }
      if (properties['Path']) {
        createParams.Path = properties['Path'] as string;
      }
      if (properties['PermissionsBoundary']) {
        createParams.PermissionsBoundary = properties['PermissionsBoundary'] as string;
      }

      const createClient = await this.createClient.get();
      const response = await createClient.send(new CreateRoleCommand(createParams));
      leftBehind = true;

      log.debug(`Created IAM role: ${v(roleName)}`);

      // CreateRoleCommand has succeeded — AWS has now committed the Role.
      // Every subsequent call wires sub-resources onto it (managed-policy
      // attachments / inline policies / tags); if any fail, the role
      // exists on AWS but cdkd state will NOT (the throw aborts before
      // the success-return). The next redeploy would then re-try CREATE
      // and AWS would reject with `EntityAlreadyExists: Role with name
      // <X> already exists`. Wrap the wiring in an inner try/catch that
      // issues best-effort `Detach*` + `DeleteRolePolicy` + `DeleteRole`
      // before re-throwing, so the failed attempt is self-healing on the
      // next redeploy. The cleanup mirrors the order in `delete()`:
      // managed-policy detach -> inline-policy delete -> DeleteRole
      // (instance profiles don't need removal on a freshly-created role).
      try {
        // Attach managed policies if specified
        const managedPolicyArns = properties['ManagedPolicyArns'] as string[] | undefined;
        if (managedPolicyArns && Array.isArray(managedPolicyArns)) {
          for (const policyArn of managedPolicyArns) {
            await this.iamClient.send(
              new AttachRolePolicyCommand({
                RoleName: roleName,
                PolicyArn: policyArn,
              })
            );
            log.debug(`Attached managed policy ${v(policyArn)} to role ${v(roleName)}`);
          }
        }

        // Add inline policies if specified
        const policies = properties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined;
        if (policies && Array.isArray(policies)) {
          for (const policy of policies) {
            const policyDoc =
              typeof policy.PolicyDocument === 'string'
                ? policy.PolicyDocument
                : JSON.stringify(policy.PolicyDocument);

            await this.iamClient.send(
              new PutRolePolicyCommand({
                RoleName: roleName,
                PolicyName: policy.PolicyName,
                PolicyDocument: policyDoc,
              })
            );
            log.debug(`Added inline policy ${v(policy.PolicyName)} to role ${v(roleName)}`);
          }
        }

        // Add tags if specified
        if (properties['Tags'] !== undefined && properties['Tags'] !== null) {
          await this.iamClient.send(
            new TagRoleCommand({
              RoleName: roleName,
              Tags: tags,
            })
          );
          log.debug(`Tagged role ${v(roleName)}`);
        }
      } catch (innerError) {
        try {
          await this.detachAllManagedPolicies(roleName, log);
          await this.deleteAllInlinePolicies(roleName, log);
          await this.iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
          leftBehind = false;
          log.debug(
            `Cleaned up partially-created IAM role ${logicalId} (${v(roleName)}) after wiring failure`
          );
        } catch (cleanupError) {
          // The name is `generateResourceNameWithFallback`'s output, whose
          // default `allowedPattern` rewrites everything outside `[A-Za-z0-9-]`
          // (issue #3136), so it renders BARE -- but it can still BE a resolved
          // secret, so every command goes through `pasteableAwsCommand` with the
          // masker (issue #2177): a masked name is WITHHELD rather than printed
          // as `***`, which would act on a different role. Pinned by this
          // type's partial-create cleanup test.
          // The `<arn>` / `<name>` holes are QUOTED: bare, each is two shell
          // redirections.
          const aws = pasteableAwsCommand(log.mask);
          log.warn(
            `Failed to clean up partially-created IAM role ${logicalId} (${v(roleName)}): ${v(describeAwsFailure(cleanupError).detail)}. Manual deletion may be required before the next deploy: detach managed policies (${aws`aws iam list-attached-role-policies --role-name ${roleName}`.render()} then ${aws`aws iam detach-role-policy --role-name ${roleName} --policy-arn '<arn>'`.render()}), delete inline policies (${aws`aws iam list-role-policies --role-name ${roleName}`.render()} then ${aws`aws iam delete-role-policy --role-name ${roleName} --policy-name '<name>'`.render()}), then ${aws`aws iam delete-role --role-name ${roleName}`.render()}`
          );
        }
        // The resource itself was created: an "already exists" from its wiring
        // is an auxiliary object's, not this resource's name collision (#3826).
        throw markAuxiliaryFailure(innerError, logicalId);
      }

      log.debug(`Successfully created IAM role ${logicalId}: ${v(roleName)}`);

      const attributes = {
        Arn: response.Role?.Arn,
        RoleId: response.Role?.RoleId,
      };

      return {
        physicalId: roleName,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      // Issue #2177: the AWS message is masked RAW before interpolation. The
      // cause stays unmasked: a masked message is stamped so the retry
      // classifiers read the chain (`wrapMaskedError`, issue #4244).
      throw this.wrapMaskedError(log.mask, error, (text) => {
        const built = new ProvisioningError(
          `Failed to create IAM role ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          roleName,
          cause
        );
        return leftBehind
          ? markCreatedBeforeFailure(built, logicalId, resourceType, roleName)
          : built;
      });
    }
  }

  /**
   * Update an IAM role
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // The re-create below takes the template bag: a reset is an UPDATE value,
    // so a key the caller injected one for (#1160) is taken back out.
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
    const newRoleName = revertKeepsName ? physicalId : derivedRoleName;

    // Check if immutable properties changed (requires replacement)
    // RoleName and Path are immutable - cannot be changed after creation
    const newPath = (properties['Path'] as string | undefined) || '/';
    const oldPath = (previousProperties['Path'] as string | undefined) || '/';
    const needsReplacement = newRoleName !== physicalId || newPath !== oldPath;

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
      const reason = newRoleName !== physicalId ? 'RoleName' : 'Path';
      log.debug(
        `${reason} changed, replacing role: ${v(physicalId)} (${reason}: ${reason === 'RoleName' ? `from ${v(physicalId)} to ${v(newRoleName)}` : `from ${v(oldPath)} to ${v(newPath)}`})`
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
        const deleteResult = await this.delete(logicalId, physicalId, resourceType);
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
        properties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined,
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
      const getRoleResponse = await this.iamClient.send(
        new GetRoleCommand({ RoleName: physicalId })
      );

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
      // Issue #2177 -- masked RAW and stamped, as in `create()`.
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
   * Delete an IAM role
   *
   * Before deleting, performs full cleanup:
   * 1. Detach all managed policies
   * 2. Delete all inline policies
   * 3. Remove role from all instance profiles
   * 4. Delete the role itself
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting IAM role ${logicalId}: ${physicalId}`);

    try {
      // Check if role exists
      try {
        await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));
      } catch (error) {
        if (error instanceof NoSuchEntityException) {
          const clientRegion = await this.iamClient.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Role ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Step 1: Detach all managed policies
      await this.detachAllManagedPolicies(physicalId, this.unmaskedDeleteSinks());

      // Step 2: Delete all inline policies
      await this.deleteAllInlinePolicies(physicalId, this.unmaskedDeleteSinks());

      // Step 3: Remove role from all instance profiles
      await this.removeFromAllInstanceProfiles(physicalId);

      // Step 4: Delete the role
      await this.iamClient.send(new DeleteRoleCommand({ RoleName: physicalId }));

      this.logger.debug(`Successfully deleted IAM role ${logicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM role ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Detach all managed policies from the role
   */
  private async detachAllManagedPolicies(
    roleName: string,
    // REQUIRED, so a create-path caller cannot silently fall back to an
    // unmasked sink; the delete path passes `unmaskedDeleteSinks()` (issue #2007).
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    log.debug(`Detaching all managed policies from role ${v(roleName)}`);

    try {
      const attachedPolicies = await this.iamClient.send(
        new ListAttachedRolePoliciesCommand({ RoleName: roleName })
      );

      const policies = attachedPolicies.AttachedPolicies || [];
      if (policies.length === 0) {
        log.debug(`No managed policies attached to role ${v(roleName)}`);
        return;
      }

      for (const policy of policies) {
        if (policy.PolicyArn) {
          try {
            await this.iamClient.send(
              new DetachRolePolicyCommand({
                RoleName: roleName,
                PolicyArn: policy.PolicyArn,
              })
            );
            log.debug(`Detached managed policy ${v(policy.PolicyArn)} from role ${v(roleName)}`);
          } catch (error) {
            if (error instanceof NoSuchEntityException) {
              log.debug(
                `Managed policy ${v(policy.PolicyArn)} already detached from role ${v(roleName)}`
              );
            } else {
              throw error;
            }
          }
        }
      }

      log.debug(`Detached ${policies.length} managed policies from role ${v(roleName)}`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        log.debug(`Role ${v(roleName)} not found when detaching managed policies`);
        return;
      }
      throw error;
    }
  }

  /**
   * Delete all inline policies from the role
   */
  private async deleteAllInlinePolicies(
    roleName: string,
    // REQUIRED, so a create-path caller cannot silently fall back to an
    // unmasked sink; the delete path passes `unmaskedDeleteSinks()` (issue #2007).
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    log.debug(`Deleting all inline policies from role ${v(roleName)}`);

    try {
      const inlinePolicies = await this.iamClient.send(
        new ListRolePoliciesCommand({ RoleName: roleName })
      );

      const policyNames = inlinePolicies.PolicyNames || [];
      if (policyNames.length === 0) {
        log.debug(`No inline policies on role ${v(roleName)}`);
        return;
      }

      for (const policyName of policyNames) {
        try {
          await this.iamClient.send(
            new DeleteRolePolicyCommand({
              RoleName: roleName,
              PolicyName: policyName,
            })
          );
          log.debug(`Deleted inline policy ${v(policyName)} from role ${v(roleName)}`);
        } catch (error) {
          if (error instanceof NoSuchEntityException) {
            log.debug(`Inline policy ${v(policyName)} already deleted from role ${v(roleName)}`);
          } else {
            throw error;
          }
        }
      }

      log.debug(`Deleted ${policyNames.length} inline policies from role ${v(roleName)}`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        log.debug(`Role ${v(roleName)} not found when deleting inline policies`);
        return;
      }
      throw error;
    }
  }

  /**
   * Remove the role from all instance profiles
   */
  private async removeFromAllInstanceProfiles(roleName: string): Promise<void> {
    this.logger.debug(`Removing role ${roleName} from all instance profiles`);

    try {
      const instanceProfiles = await this.iamClient.send(
        new ListInstanceProfilesForRoleCommand({ RoleName: roleName })
      );

      const profiles = instanceProfiles.InstanceProfiles || [];
      if (profiles.length === 0) {
        this.logger.debug(`No instance profiles associated with role ${roleName}`);
        return;
      }

      for (const profile of profiles) {
        if (profile.InstanceProfileName) {
          try {
            await this.iamClient.send(
              new RemoveRoleFromInstanceProfileCommand({
                RoleName: roleName,
                InstanceProfileName: profile.InstanceProfileName,
              })
            );
            this.logger.debug(
              `Removed role ${roleName} from instance profile ${profile.InstanceProfileName}`
            );
          } catch (error) {
            if (error instanceof NoSuchEntityException) {
              this.logger.debug(
                `Role ${roleName} already removed from instance profile ${profile.InstanceProfileName}`
              );
            } else {
              throw error;
            }
          }
        }
      }

      this.logger.debug(`Removed role ${roleName} from ${profiles.length} instance profiles`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        this.logger.debug(`Role ${roleName} not found when removing from instance profiles`);
        return;
      }
      throw error;
    }
  }

  /**
   * Update managed policies attached to role
   */
  private async updateManagedPolicies(
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
  private async updateInlinePolicies(
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
  private async updateTags(
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

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing IAM role.
   *
   * CloudFormation's `AWS::IAM::Role` exposes `Arn` and `RoleId`; both are
   * available from the `GetRole` response. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html#aws-resource-iam-role-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    try {
      const resp = await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));
      switch (attributeName) {
        case 'Arn':
          return resp.Role?.Arn;
        case 'RoleId':
          return resp.Role?.RoleId;
        default:
          return undefined;
      }
    } catch (err) {
      if (err instanceof NoSuchEntityException) return undefined;
      throw err;
    }
  }

  /**
   * Read the AWS-current IAM role configuration in CFn-property shape.
   *
   * Issues `GetRole` for the top-level role configuration and
   * `ListRolePolicies` + `ListAttachedRolePolicies` for inline / managed
   * policy *names*. AWS URL-decodes `AssumeRolePolicyDocument` for us
   * when it surfaces — we re-parse it as JSON so the comparator can match
   * against state's already-parsed object.
   *
   * Coverage and shape decisions:
   *  - `RoleName`, `Description`, `MaxSessionDuration`, `Path` — straight
   *    from `Role.*`.
   *  - `PermissionsBoundary` — emitted as `'' ` placeholder when AWS has
   *    none, so a console-side ADD on a role that was deployed without a
   *    boundary surfaces as drift. (The drift comparator's top-level walk
   *    is state-keys-only; without the always-emit placeholder a fresh
   *    `PermissionsBoundary` on the AWS side would never enter
   *    `observedProperties` and the comparator would silently ignore it.)
   *  - `AssumeRolePolicyDocument` — `Role.AssumeRolePolicyDocument` is a
   *    URL-encoded JSON string; we URL-decode + JSON-parse so cdkd state's
   *    object form compares cleanly. (Both shapes — string and object — are
   *    accepted by `create()`, but state typically stores the parsed object
   *    after intrinsic resolution.)
   *  - `ManagedPolicyArns` — array of ARN strings from
   *    `ListAttachedRolePolicies`.
   *  - `Policies` — inline policies surfaced as `[{PolicyName, PolicyDocument}]`.
   *    `ListRolePolicies` for names + `GetRolePolicy` per name for the
   *    body (URL-decoded + JSON-parsed). Ordering is reconciled against
   *    state's `Policies` array (when supplied via the `properties`
   *    parameter) so a state-vs-AWS positional compare doesn't fire false
   *    drift purely from `ListRolePolicies` returning lexicographic order;
   *    AWS-only policies (added via console) are appended at the end so
   *    they still surface as drift via length / content mismatch.
   *  - `Tags` is surfaced via `ListRoleTags` (paginated). CDK's `aws:*`
   *    auto-tags are filtered out by `normalizeAwsTagsToCfn` so they don't
   *    fire false-positive drift; always emitted (even when empty) so a
   *    console-side tag ADD on an originally-untagged role surfaces as
   *    drift on the v3 observedProperties baseline.
   *
   * Returns `RESOURCE_NOT_FOUND` when the role is gone (`NoSuchEntityException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>,
    context?: import('../../types/resource.js').ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let role;
    try {
      const resp = await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));
      role = resp.Role;
    } catch (err) {
      if (err instanceof NoSuchEntityException) return RESOURCE_NOT_FOUND;
      throw err;
    }
    if (!role) return undefined;

    const result: Record<string, unknown> = {};

    if (role.RoleName !== undefined) result['RoleName'] = role.RoleName;
    result['Description'] = role.Description ?? '';
    if (role.MaxSessionDuration !== undefined) {
      result['MaxSessionDuration'] = role.MaxSessionDuration;
    }
    if (role.Path !== undefined) result['Path'] = role.Path;
    // Always-emit (PR #145 pattern): surfaces console-side ADDs on roles
    // deployed without a boundary. AWS returns the boundary as a nested
    // `{ PermissionsBoundaryArn, PermissionsBoundaryType }` shape; cdkd
    // state stores the bare ARN string (matches CFn input shape).
    result['PermissionsBoundary'] = role.PermissionsBoundary?.PermissionsBoundaryArn ?? '';
    if (role.AssumeRolePolicyDocument) {
      // GetRole returns AssumeRolePolicyDocument URL-encoded. Decode and
      // parse so the comparator can match cdkd state (which holds the
      // already-resolved object form).
      try {
        result['AssumeRolePolicyDocument'] = JSON.parse(
          decodeURIComponent(role.AssumeRolePolicyDocument)
        ) as unknown;
      } catch {
        // Fall back to the raw string if decoding / parsing fails. The
        // comparator handles primitive vs object mismatches correctly.
        result['AssumeRolePolicyDocument'] = role.AssumeRolePolicyDocument;
      }
    }

    // ManagedPolicyArns — string[] of attached managed policy ARNs.
    try {
      const attached = await this.iamClient.send(
        new ListAttachedRolePoliciesCommand({ RoleName: physicalId })
      );
      const arns = (attached.AttachedPolicies ?? [])
        .map((p) => p.PolicyArn)
        .filter((arn): arn is string => !!arn);
      result['ManagedPolicyArns'] = arns;
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }

    // Inline Policies — `[{PolicyName, PolicyDocument}]`. Cap at IAM's
    // documented 10-inline-policies-per-role limit to bound the API
    // budget; ListRolePolicies is paginated for forward-compat anyway.
    try {
      const policyNames: string[] = [];
      let policyMarker: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const listResp = await this.iamClient.send(
          new ListRolePoliciesCommand({
            RoleName: physicalId,
            ...(policyMarker ? { Marker: policyMarker } : {}),
          })
        );
        for (const name of listResp.PolicyNames ?? []) policyNames.push(name);
        if (!listResp.IsTruncated) break;
        policyMarker = listResp.Marker;
      }

      // Issue #323: filter out inline policies that are managed by a
      // SEPARATE `AWS::IAM::Policy` resource attached via `Roles: [role]`.
      // CDK's `iam.Policy({ roles: [r] })` (and L2 helpers like
      // `taskRole.addToPolicy(...)` / `bucket.grantRead(role)` /
      // `ContainerImage.fromEcrRepository(repo)`'s execution-role grant)
      // creates a separate `AWS::IAM::Policy` resource — which AWS
      // implements via `iam:PutRolePolicy`, so those inline policies
      // appear in `ListRolePolicies` output. Without this filter every
      // such Role fires false drift (state.Policies = [] vs aws =
      // [{...DefaultPolicy*}]).
      const managedByOtherResource = collectInlinePolicyNamesManagedBySiblings(
        physicalId,
        context,
        'Roles'
      );
      const filteredNames = policyNames.filter((n) => !managedByOtherResource.has(n));

      // Fetch every body in parallel (max 10; well under any IAM rate
      // limit). URL-decode + JSON-parse so the comparator sees the same
      // object shape state holds after intrinsic resolution.
      const bodies = new Map<string, unknown>();
      await Promise.all(
        filteredNames.map(async (name) => {
          const resp = await this.iamClient.send(
            new GetRolePolicyCommand({ RoleName: physicalId, PolicyName: name })
          );
          if (!resp.PolicyDocument) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(decodeURIComponent(resp.PolicyDocument));
          } catch {
            parsed = resp.PolicyDocument;
          }
          bodies.set(name, parsed);
        })
      );

      // Reconcile order against state's `Policies` so a positional array
      // compare doesn't fire purely from `ListRolePolicies` returning
      // lexicographic order. AWS-only entries (console adds) tail-append
      // so length / content mismatch still surfaces them as drift.
      const statePolicies =
        (properties?.['Policies'] as Array<{ PolicyName?: string }> | undefined) ?? [];
      const remaining = new Set(bodies.keys());
      const inline: Array<{ PolicyName: string; PolicyDocument: unknown }> = [];
      for (const sp of statePolicies) {
        const name = sp?.PolicyName;
        if (typeof name !== 'string') continue;
        if (bodies.has(name)) {
          inline.push({ PolicyName: name, PolicyDocument: bodies.get(name) });
          remaining.delete(name);
        }
      }
      for (const name of [...remaining].sort()) {
        inline.push({ PolicyName: name, PolicyDocument: bodies.get(name) });
      }
      result['Policies'] = inline;
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }

    // Tags via ListRoleTags. Paginated — small page sizes are fine since
    // IAM enforces a 50-tag-per-role limit, but we still iterate Marker for
    // forward-compat.
    try {
      const collected: Array<{ Key?: string | undefined; Value?: string | undefined }> = [];
      let marker: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const tagsResp = await this.iamClient.send(
          new ListRoleTagsCommand({
            RoleName: physicalId,
            ...(marker ? { Marker: marker } : {}),
          })
        );
        if (tagsResp.Tags) {
          for (const t of tagsResp.Tags) {
            collected.push({ Key: t.Key, Value: t.Value });
          }
        }
        if (!tagsResp.IsTruncated) break;
        marker = tagsResp.Marker;
      }
      const tags = normalizeAwsTagsToCfn(collected);
      result['Tags'] = tags;
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }

    return result;
  }

  /**
   * Adopt an existing IAM role into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.RoleName` → use directly,
   *     verify via `GetRole`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'RoleName');
    if (explicit) {
      try {
        const resp = await this.iamClient.send(new GetRoleCommand({ RoleName: explicit }));
        // Issue #3627: the same map `create()` records. The resolver's
        // `RoleId` arm refuses the reference without it (issue #4077), and its `Arn` arm
        // ignores a non-`/` `Path`.
        return {
          physicalId: explicit,
          attributes: definedAttributes({ Arn: resp.Role?.Arn, RoleId: resp.Role?.RoleId }),
        };
      } catch (err) {
        if (err instanceof NoSuchEntityException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a role
    // reaching here needs an explicit `--resource` override.
    return null;
  }
}

/**
 * Issue #323: build the set of inline-policy names that are managed by
 * a sibling `AWS::IAM::Policy` resource in the same stack via the given
 * attachment field (`Roles` / `Users` / `Groups`). cdkd's IAM Role /
 * User / Group `readCurrentState` helpers exclude these from
 * `ListRolePolicies` / `ListUserPolicies` / `ListGroupPolicies` output
 * to avoid false drift — the inline policy is faithfully managed by
 * the sibling `AWS::IAM::Policy` resource, not the role/user/group
 * itself. The CDK patterns that produce this shape are pervasive:
 * `role.addToPolicy(...)`, `taskRole.addToPolicy(...)`,
 * `bucket.grantRead(role)`, `ContainerImage.fromEcrRepository(repo)`'s
 * execution-role grant, every L2-construct's auto-emitted `Default
 * Policy*`.
 *
 * @param targetPhysicalId  The physicalId of the role/user/group being
 *                          read (matches values in the sibling's
 *                          `Properties.Roles` / `Users` / `Groups`).
 * @param context           Cross-resource context (may be `undefined`
 *                          for callers that don't supply it — e.g.
 *                          deploy-time observed-capture before state
 *                          is complete; the filter then no-ops which
 *                          is safe because the sibling's
 *                          `PutRolePolicy` hasn't fired yet at that
 *                          point).
 * @param attachmentField   Which sibling field to inspect: `'Roles'`,
 *                          `'Users'`, or `'Groups'`.
 * @returns Set of `PolicyName` values to exclude. Empty when no
 *          sibling matches OR when context is undefined.
 */
export function collectInlinePolicyNamesManagedBySiblings(
  targetPhysicalId: string,
  context: import('../../types/resource.js').ReadCurrentStateContext | undefined,
  attachmentField: 'Roles' | 'Users' | 'Groups'
): Set<string> {
  const result = new Set<string>();
  const siblings = context?.siblings;
  if (!siblings) return result;
  for (const sibling of Object.values(siblings)) {
    if (sibling.resourceType !== 'AWS::IAM::Policy') continue;
    const attachments = sibling.properties[attachmentField];
    if (!Array.isArray(attachments)) continue;
    if (!attachments.some((a) => a === targetPhysicalId)) continue;
    const name = sibling.properties['PolicyName'];
    if (typeof name === 'string') result.add(name);
  }
  return result;
}
