import {
  IAMClient,
  CreatePolicyCommand,
  GetPolicyCommand,
  DeletePolicyCommand,
  CreatePolicyVersionCommand,
  DeletePolicyVersionCommand,
  GetPolicyVersionCommand,
  ListPolicyVersionsCommand,
  ListEntitiesForPolicyCommand,
  ListPoliciesCommand,
  ListPolicyTagsCommand,
  TagPolicyCommand,
  UntagPolicyCommand,
  AttachGroupPolicyCommand,
  DetachGroupPolicyCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  AttachUserPolicyCommand,
  DetachUserPolicyCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure, safeStringify } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceNameWithFallback } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
} from '../masked-retry-logger.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import { markAuxiliaryFailure } from '../auxiliary-failure.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import {
  onlySecretDerived,
  readPrincipalLists,
  recordedPrincipalsRepair,
  SECRET_DERIVED_READ_LIVE,
} from '../iam-policy-targets.js';

/** A bag's three principal lists, read by literal key (see `readPrincipalLists`). */
const principalsOf = (bag: Record<string, unknown>) =>
  readPrincipalLists({ Groups: bag['Groups'], Roles: bag['Roles'], Users: bag['Users'] });
const PRINCIPAL_NAMES = 'group / role / user names';

/**
 * Matches an AWS-managed IAM policy ARN in ANY AWS partition (issue #1815).
 *
 * AWS-managed policies are the ones whose ACCOUNT segment is the literal
 * `aws` — `arn:<partition>:iam::aws:policy/<path><name>` — as opposed to a
 * customer-managed policy, which carries a 12-digit account id. They exist
 * under every partition (`arn:aws-us-gov:iam::aws:policy/AdministratorAccess`
 * is a real, attachable ARN in GovCloud), so pinning the PARTITION segment to
 * the commercial `aws` recognised only a third of them.
 *
 * The partition is read OFF THE ARN rather than derived from a region through
 * `derivePartitionAndUrlSuffix` (`src/utils/aws-partition.ts`): that helper
 * answers "given a region, which partition am I in", which is the right
 * question when BUILDING an ARN (the seven sites PR #1834 fixed) and the wrong
 * one when CLASSIFYING an ARN the caller already holds. The loose
 * `aws[a-z0-9-]*` partition segment matches `IAM_ROLE_ARN_RE` in
 * `src/utils/role-arn.ts`; a closed partition list is precisely what goes
 * stale when AWS adds a partition, and here staleness fails DANGEROUS (see the
 * refusal's own comment — an unrecognised AWS-managed policy gets adopted, and
 * destroy then detaches it from every principal in the account).
 */
const AWS_MANAGED_POLICY_ARN_RE = /^arn:aws[a-z0-9-]*:iam::aws:/;

/**
 * AWS IAM Managed Policy Provider
 *
 * Implements resource provisioning for AWS::IAM::ManagedPolicy using the IAM SDK.
 * Cloud Control API does support this type, but a dedicated SDK provider wins
 * via Tier 1 of the provider registry and gives cdkd direct control over:
 *   - PolicyDocument updates (via CreatePolicyVersion + SetDefaultPolicyVersion +
 *     prune oldest non-default when at the 5-version limit)
 *   - Attachment fan-out (Groups / Roles / Users) on create + update
 *   - Detach-before-delete cleanup (a ManagedPolicy with attached principals
 *     or with non-default versions cannot be deleted directly)
 *
 * Physical id is the policy ARN (`arn:<partition>:iam::<account>:policy/<path><name>`)
 * since path is part of the identity — two policies with the same name in
 * different paths are distinct.
 */
export class IAMManagedPolicyProvider implements ResourceProvider {
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMManagedPolicyProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::IAM::ManagedPolicy',
      new Set([
        'ManagedPolicyName',
        'Description',
        'Path',
        'PolicyDocument',
        'Groups',
        'Roles',
        'Users',
        'Tags',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    // Issue #2177: ONE masked sink per operation (the `ssm-parameter-provider.ts`
    // shape), and every bag-derived value masked RAW as well. The ARN is
    // AWS-minted but EMBEDS the template-chosen name and path, so it is masked
    // like one. Absent context means identity.
    const policyName = generateResourceNameWithFallback(
      properties['ManagedPolicyName'] as string | undefined,
      logicalId,
      { maxLength: 128 }
    );
    // The physical name is REWRITTEN from the template value (stack prefix,
    // charset folding, truncation), so the masker cannot recognise it by
    // itself: add it as a needle when the value it came from is a secret.
    // The needle also matches the name INSIDE the policy ARN.
    const log = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      [[properties['ManagedPolicyName'], policyName]]
    );
    const { value: v } = log;
    log.debug(`Creating IAM managed policy ${logicalId}`);
    const policyDocument = properties['PolicyDocument'];

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for IAM managed policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Read before any call (go-to-k/cdkd#3906): a cast iterated a string by
    // character, attaching the policy to one-letter principals. A replacement
    // inside `update()` and a rollback's reverse-replacement create both pass
    // a recorded bag here, so this is not only a template-side check.
    const principals = principalsOf(properties);
    if ('malformed' in principals) {
      throw new ProvisioningError(
        `${principals.malformed.join(' / ')} of IAM managed policy ${logicalId} is not a list ` +
          `of IAM names — no managed policy was created or attached`,
        resourceType,
        logicalId
      );
    }

    const policyDoc =
      typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

    try {
      const createParams: {
        PolicyName: string;
        PolicyDocument: string;
        Description?: string;
        Path?: string;
        Tags?: Array<{ Key: string; Value: string }>;
      } = {
        PolicyName: policyName,
        PolicyDocument: policyDoc,
      };

      if (properties['Description']) {
        createParams.Description = properties['Description'] as string;
      }
      if (properties['Path']) {
        createParams.Path = properties['Path'] as string;
      }
      if (tags.length > 0) {
        createParams.Tags = tags;
      }

      const response = await this.iamClient.send(new CreatePolicyCommand(createParams));
      const policyArn = response.Policy?.Arn;
      if (!policyArn) {
        throw new ProvisioningError(
          `CreatePolicy succeeded but no Arn returned for ${logicalId}`,
          resourceType,
          logicalId,
          policyName
        );
      }
      log.debug(`Created IAM managed policy: ${v(policyArn)}`);

      // CreatePolicy has succeeded — AWS has committed the policy. Wire up
      // attachments next; if any fail, AWS-side cleanup mirrors `delete()`
      // (detach principals + delete non-default versions + DeletePolicy) so
      // the next redeploy doesn't trip over `EntityAlreadyExists`.
      try {
        await this.attachToPrincipals(
          policyArn,
          principals.lists.Groups,
          principals.lists.Roles,
          principals.lists.Users,
          log
        );
      } catch (innerError) {
        try {
          await this.detachAllPrincipals(policyArn);
          await this.deleteAllNonDefaultVersions(policyArn);
          await this.iamClient.send(new DeletePolicyCommand({ PolicyArn: policyArn }));
          log.debug(
            `Cleaned up partially-created managed policy ${logicalId} (${v(policyArn)}) after attachment failure`
          );
        } catch (cleanupError) {
          // The ARN is AWS-minted but embeds the TEMPLATE-chosen name and path,
          // so every command below renders through `pasteableAwsCommand`
          // (issue #3136): withheld when it cannot be printed exactly.
          // The masker is handed over too (issue #2177), so a secret-bearing
          // name withholds the command rather than printing it.
          const aws = pasteableAwsCommand(log.mask);
          log.warn(
            `Failed to clean up partially-created managed policy ${logicalId} (${v(policyArn)}): ${v(describeAwsFailure(cleanupError).detail)}. Manual deletion may be required: detach principals (${aws`aws iam list-entities-for-policy --policy-arn ${policyArn}`.render()}), delete versions (${aws`aws iam list-policy-versions --policy-arn ${policyArn}`.render()} then aws iam delete-policy-version), then ${aws`aws iam delete-policy --policy-arn ${policyArn}`.render()}`
          );
        }
        // The resource itself was created: an "already exists" from its wiring
        // is an auxiliary object's, not this resource's name collision (#3826).
        throw markAuxiliaryFailure(innerError, logicalId);
      }

      return {
        physicalId: policyArn,
        attributes: {
          PolicyArn: policyArn,
        },
      };
    } catch (error) {
      // Pass through cdkd-typed errors untouched (#1272): re-labelling an inner
      // ProvisioningError replaces its precise message with this outer one.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM managed policy ${logicalId}: ${v(error instanceof Error ? error.message : String(error))}`,
        resourceType,
        logicalId,
        policyName,
        cause
      );
    }
  }

  async update(
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
    const newPolicyName = revertKeepsName ? oldPolicyName : derivedPolicyName;
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
        ...('malformed' in oldPrincipals
          ? oldPrincipals.malformed.map((k) => `recorded ${k}`)
          : []),
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

    // ManagedPolicyName, Path, and Description are all immutable on AWS.
    const needsReplacement =
      newPolicyName !== oldPolicyName ||
      newPath !== oldPath ||
      (newDescription ?? '') !== (oldDescription ?? '');

    // Issue #4023: the replacement arm re-derives the name inside `create()`,
    // so on a revert it would still create under the derived name and delete
    // the recorded policy. A revert never replaces: refuse before any call.
    if (needsReplacement && context?.desiredFromAwsReadback === true) {
      throw markNonRetryable(
        new ProvisioningError(
          `IAM managed policy ${logicalId}: ${newPath !== oldPath ? 'Path' : 'Description'} ` +
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
        newPolicyName !== oldPolicyName
          ? 'ManagedPolicyName'
          : newPath !== oldPath
            ? 'Path'
            : 'Description';
      log.debug(
        `${reason} changed, replacing managed policy: ${v(physicalId)} (${reason} mutation)`
      );

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
        const deleteResult = await this.delete(
          logicalId,
          physicalId,
          resourceType,
          previousProperties
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

    try {
      // Update PolicyDocument by creating a new version + setting as default.
      // AWS caps managed policies at 5 versions; prune the oldest non-default
      // before creating a new one when already at the cap.
      const newDocument = properties['PolicyDocument'];
      const oldDocument = previousProperties['PolicyDocument'];
      if (newDocument) {
        const newDocStr =
          typeof newDocument === 'string' ? newDocument : JSON.stringify(newDocument);
        const oldDocStr = oldDocument
          ? typeof oldDocument === 'string'
            ? oldDocument
            : JSON.stringify(oldDocument)
          : '';
        if (newDocStr !== oldDocStr) {
          await this.ensureVersionCapacity(physicalId, log);
          await this.iamClient.send(
            new CreatePolicyVersionCommand({
              PolicyArn: physicalId,
              PolicyDocument: newDocStr,
              SetAsDefault: true,
            })
          );
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

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          PolicyArn: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update IAM managed policy ${logicalId}: ${v(error instanceof Error ? error.message : String(error))}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting IAM managed policy ${logicalId}: ${physicalId}`);

    try {
      try {
        await this.iamClient.send(new GetPolicyCommand({ PolicyArn: physicalId }));
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
          this.logger.debug(`Managed policy ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // 1. Detach from every group / role / user (AWS refuses to delete an
      //    attached managed policy). Use ListEntitiesForPolicy as the source
      //    of truth rather than state's Groups/Roles/Users so a console-side
      //    attach made after deploy is also cleaned up.
      await this.detachAllPrincipals(physicalId);

      // 2. Delete every non-default policy version (AWS refuses to delete a
      //    policy with non-default versions).
      await this.deleteAllNonDefaultVersions(physicalId);

      // 3. Delete the policy itself.
      await this.iamClient.send(new DeletePolicyCommand({ PolicyArn: physicalId }));

      this.logger.debug(`Successfully deleted IAM managed policy ${logicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM managed policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // CFn exposes only `PolicyArn` for `AWS::IAM::ManagedPolicy` (Ref also
    // returns the ARN). Other attribute names would be a template bug.
    if (attributeName === 'PolicyArn') return physicalId;
    return undefined;
  }

  /**
   * Read the AWS-current managed policy configuration in CFn-property shape.
   *
   * Coverage:
   *  - `ManagedPolicyName`, `Description`, `Path` — straight from `GetPolicy`.
   *  - `PolicyDocument` — fetched via `GetPolicyVersion` on the default
   *    version, URL-decoded + JSON-parsed.
   *  - `Groups` / `Roles` / `Users` — string arrays from
   *    `ListEntitiesForPolicy`.
   *  - `Tags` — via `ListPolicyTags`, with the `aws:cdk:path` etc. filtered
   *    out by `normalizeAwsTagsToCfn`.
   *
   * Returns `undefined` when the policy is gone (`NoSuchEntityException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    let policy;
    try {
      const resp = await this.iamClient.send(new GetPolicyCommand({ PolicyArn: physicalId }));
      policy = resp.Policy;
    } catch (err) {
      if (err instanceof NoSuchEntityException) return undefined;
      throw err;
    }
    if (!policy) return undefined;

    const result: Record<string, unknown> = {};
    if (policy.PolicyName !== undefined) result['ManagedPolicyName'] = policy.PolicyName;
    result['Description'] = policy.Description ?? '';
    if (policy.Path !== undefined) result['Path'] = policy.Path;

    if (policy.DefaultVersionId) {
      try {
        const versionResp = await this.iamClient.send(
          new GetPolicyVersionCommand({
            PolicyArn: physicalId,
            VersionId: policy.DefaultVersionId,
          })
        );
        const doc = versionResp.PolicyVersion?.Document;
        if (typeof doc === 'string') {
          try {
            result['PolicyDocument'] = JSON.parse(decodeURIComponent(doc));
          } catch {
            result['PolicyDocument'] = doc;
          }
        }
      } catch (err) {
        if (!(err instanceof NoSuchEntityException)) throw err;
      }
    }

    try {
      const groups: string[] = [];
      const roles: string[] = [];
      const users: string[] = [];
      let marker: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const resp = await this.iamClient.send(
          new ListEntitiesForPolicyCommand({
            PolicyArn: physicalId,
            ...(marker ? { Marker: marker } : {}),
          })
        );
        for (const g of resp.PolicyGroups ?? []) if (g.GroupName) groups.push(g.GroupName);
        for (const r of resp.PolicyRoles ?? []) if (r.RoleName) roles.push(r.RoleName);
        for (const u of resp.PolicyUsers ?? []) if (u.UserName) users.push(u.UserName);
        if (!resp.IsTruncated) break;
        marker = resp.Marker;
      }
      result['Groups'] = groups;
      result['Roles'] = roles;
      result['Users'] = users;
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }

    try {
      const collected: Array<{ Key?: string | undefined; Value?: string | undefined }> = [];
      let marker: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const tagsResp = await this.iamClient.send(
          new ListPolicyTagsCommand({
            PolicyArn: physicalId,
            ...(marker ? { Marker: marker } : {}),
          })
        );
        for (const t of tagsResp.Tags ?? []) {
          collected.push({ Key: t.Key, Value: t.Value });
        }
        if (!tagsResp.IsTruncated) break;
        marker = tagsResp.Marker;
      }
      result['Tags'] = normalizeAwsTagsToCfn(collected);
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }

    return result;
  }

  /**
   * Adopt an existing IAM managed policy into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.ManagedPolicyName` → walk
   *     `ListPolicies(Scope: 'Local')` to find the matching ARN.
   *
   * Scope is forced to `'Local'` (customer-managed policies) — adopting an
   * AWS-managed policy would let cdkd delete it on next destroy, which would
   * be a major footgun.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'ManagedPolicyName');
    if (explicit) {
      // If the override is already an ARN, trust it (verify exists). But
      // refuse AWS-managed policies (`arn:<partition>:iam::aws:policy/...`)
      // outright — adopting one would let cdkd's destroy path attempt
      // `DeletePolicy` (always rejected by IAM) but only AFTER
      // `detachAllPrincipals` has forcibly detached the policy from every
      // user / role / group in the account. That's a major foot-gun (think
      // `AdministratorAccess`); the tag-based fallback path is already guarded
      // by `Scope: 'Local'`, and the explicit-ARN path needs the same guard.
      // The partition segment is matched across ALL partitions (issue #1815):
      // this predicate's miss direction is the dangerous one, so a GovCloud /
      // China `AdministratorAccess` ARN must trip it too.
      if (explicit.startsWith('arn:')) {
        if (AWS_MANAGED_POLICY_ARN_RE.test(explicit)) {
          throw new Error(
            `Refusing to import AWS-managed policy ${explicit}: cdkd only adopts customer-managed policies. ` +
              `If you need to attach an AWS-managed policy to a role / user / group, reference it via ManagedPolicyArns on the principal instead.`
          );
        }
        try {
          await this.iamClient.send(new GetPolicyCommand({ PolicyArn: explicit }));
          return { physicalId: explicit, attributes: { PolicyArn: explicit } };
        } catch (err) {
          if (err instanceof NoSuchEntityException) return null;
          throw err;
        }
      }
      // Otherwise treat as a policy name + walk customer-managed policies.
      const arnByName = await this.findPolicyArnByName(explicit);
      if (arnByName) {
        return { physicalId: arnByName, attributes: { PolicyArn: arnByName } };
      }
      return null;
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a managed
    // policy reaching here needs an explicit `--resource` override.
    return null;
  }

  // ── helpers ───────────────────────────────────────────────────────

  private async attachToPrincipals(
    policyArn: string,
    groups: string[] | undefined,
    roles: string[] | undefined,
    users: string[] | undefined,
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    if (groups && Array.isArray(groups)) {
      for (const groupName of groups) {
        await this.iamClient.send(
          new AttachGroupPolicyCommand({ GroupName: groupName, PolicyArn: policyArn })
        );
        log.debug(`Attached ${v(policyArn)} to group ${v(groupName)}`);
      }
    }
    if (roles && Array.isArray(roles)) {
      for (const roleName of roles) {
        await this.iamClient.send(
          new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn })
        );
        log.debug(`Attached ${v(policyArn)} to role ${v(roleName)}`);
      }
    }
    if (users && Array.isArray(users)) {
      for (const userName of users) {
        await this.iamClient.send(
          new AttachUserPolicyCommand({ UserName: userName, PolicyArn: policyArn })
        );
        log.debug(`Attached ${v(policyArn)} to user ${v(userName)}`);
      }
    }
  }

  private async updatePrincipals(
    policyArn: string,
    newGroups: string[] | undefined,
    oldGroups: string[] | undefined,
    newRoles: string[] | undefined,
    oldRoles: string[] | undefined,
    newUsers: string[] | undefined,
    oldUsers: string[] | undefined,
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    const newGroupSet = new Set(newGroups || []);
    const oldGroupSet = new Set(oldGroups || []);
    for (const g of newGroupSet) {
      if (!oldGroupSet.has(g)) {
        await this.iamClient.send(
          new AttachGroupPolicyCommand({ GroupName: g, PolicyArn: policyArn })
        );
        log.debug(`Attached ${v(policyArn)} to group ${v(g)}`);
      }
    }
    for (const g of oldGroupSet) {
      if (!newGroupSet.has(g)) {
        try {
          await this.iamClient.send(
            new DetachGroupPolicyCommand({ GroupName: g, PolicyArn: policyArn })
          );
          log.debug(`Detached ${v(policyArn)} from group ${v(g)}`);
        } catch (err) {
          if (!(err instanceof NoSuchEntityException)) throw err;
        }
      }
    }

    const newRoleSet = new Set(newRoles || []);
    const oldRoleSet = new Set(oldRoles || []);
    for (const r of newRoleSet) {
      if (!oldRoleSet.has(r)) {
        await this.iamClient.send(
          new AttachRolePolicyCommand({ RoleName: r, PolicyArn: policyArn })
        );
        log.debug(`Attached ${v(policyArn)} to role ${v(r)}`);
      }
    }
    for (const r of oldRoleSet) {
      if (!newRoleSet.has(r)) {
        try {
          await this.iamClient.send(
            new DetachRolePolicyCommand({ RoleName: r, PolicyArn: policyArn })
          );
          log.debug(`Detached ${v(policyArn)} from role ${v(r)}`);
        } catch (err) {
          if (!(err instanceof NoSuchEntityException)) throw err;
        }
      }
    }

    const newUserSet = new Set(newUsers || []);
    const oldUserSet = new Set(oldUsers || []);
    for (const u of newUserSet) {
      if (!oldUserSet.has(u)) {
        await this.iamClient.send(
          new AttachUserPolicyCommand({ UserName: u, PolicyArn: policyArn })
        );
        log.debug(`Attached ${v(policyArn)} to user ${v(u)}`);
      }
    }
    for (const u of oldUserSet) {
      if (!newUserSet.has(u)) {
        try {
          await this.iamClient.send(
            new DetachUserPolicyCommand({ UserName: u, PolicyArn: policyArn })
          );
          log.debug(`Detached ${v(policyArn)} from user ${v(u)}`);
        } catch (err) {
          if (!(err instanceof NoSuchEntityException)) throw err;
        }
      }
    }
  }

  /** Every group, role and user the policy is attached to, read from IAM. */
  private async readLivePrincipals(
    policyArn: string
  ): Promise<{ Groups: string[]; Roles: string[]; Users: string[] }> {
    const live = { Groups: [] as string[], Roles: [] as string[], Users: [] as string[] };
    let marker: string | undefined;
    do {
      const resp = await this.iamClient.send(
        new ListEntitiesForPolicyCommand({
          PolicyArn: policyArn,
          ...(marker && { Marker: marker }),
        })
      );
      for (const g of resp.PolicyGroups ?? []) if (g.GroupName) live.Groups.push(g.GroupName);
      for (const r of resp.PolicyRoles ?? []) if (r.RoleName) live.Roles.push(r.RoleName);
      for (const u of resp.PolicyUsers ?? []) if (u.UserName) live.Users.push(u.UserName);
      marker = resp.IsTruncated ? resp.Marker : undefined;
    } while (marker);
    return live;
  }

  private async detachAllPrincipals(policyArn: string): Promise<void> {
    try {
      let marker: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const resp = await this.iamClient.send(
          new ListEntitiesForPolicyCommand({
            PolicyArn: policyArn,
            ...(marker ? { Marker: marker } : {}),
          })
        );
        for (const g of resp.PolicyGroups ?? []) {
          if (!g.GroupName) continue;
          try {
            await this.iamClient.send(
              new DetachGroupPolicyCommand({ GroupName: g.GroupName, PolicyArn: policyArn })
            );
          } catch (err) {
            if (!(err instanceof NoSuchEntityException)) throw err;
          }
        }
        for (const r of resp.PolicyRoles ?? []) {
          if (!r.RoleName) continue;
          try {
            await this.iamClient.send(
              new DetachRolePolicyCommand({ RoleName: r.RoleName, PolicyArn: policyArn })
            );
          } catch (err) {
            if (!(err instanceof NoSuchEntityException)) throw err;
          }
        }
        for (const u of resp.PolicyUsers ?? []) {
          if (!u.UserName) continue;
          try {
            await this.iamClient.send(
              new DetachUserPolicyCommand({ UserName: u.UserName, PolicyArn: policyArn })
            );
          } catch (err) {
            if (!(err instanceof NoSuchEntityException)) throw err;
          }
        }
        if (!resp.IsTruncated) break;
        marker = resp.Marker;
      }
    } catch (err) {
      if (err instanceof NoSuchEntityException) return;
      throw err;
    }
  }

  /**
   * Delete every non-default version of the policy. Required before
   * `DeletePolicy` — AWS refuses to delete a policy that still has
   * non-default versions.
   */
  private async deleteAllNonDefaultVersions(policyArn: string): Promise<void> {
    try {
      let marker: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const resp = await this.iamClient.send(
          new ListPolicyVersionsCommand({
            PolicyArn: policyArn,
            ...(marker ? { Marker: marker } : {}),
          })
        );
        for (const v of resp.Versions ?? []) {
          if (v.IsDefaultVersion) continue;
          if (!v.VersionId) continue;
          try {
            await this.iamClient.send(
              new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: v.VersionId })
            );
          } catch (err) {
            if (!(err instanceof NoSuchEntityException)) throw err;
          }
        }
        if (!resp.IsTruncated) break;
        marker = resp.Marker;
      }
    } catch (err) {
      if (err instanceof NoSuchEntityException) return;
      throw err;
    }
  }

  /**
   * AWS caps managed policies at 5 versions. Before creating a new version,
   * prune the oldest non-default version if at the cap.
   */
  private async ensureVersionCapacity(policyArn: string, log: MaskedLogSinks): Promise<void> {
    const { value: v } = log;
    const resp = await this.iamClient.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }));
    const versions = resp.Versions ?? [];
    if (versions.length < 5) return;
    // Sort by CreateDate ascending; delete oldest non-default.
    const nonDefault = versions
      .filter((v) => !v.IsDefaultVersion && v.VersionId)
      .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0));
    const victim = nonDefault[0];
    if (!victim?.VersionId) return;
    await this.iamClient.send(
      new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: victim.VersionId })
    );
    log.debug(`Pruned oldest non-default version ${v(victim.VersionId)} of ${v(policyArn)}`);
  }

  /**
   * Diff the policy's tags. Both sides are read through `planTagDiff`
   * (go-to-k/cdkd#3994): an unreadable record untags nothing.
   */
  private async updateTags(
    policyArn: string,
    resourceType: string,
    logicalId: string,
    newTags: unknown,
    oldTags: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    const plan = planTagDiff(oldTags, newTags);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      log.warn(tagWarning);
    }
    const tagsToRemove = plan.remove;
    const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));

    if (tagsToRemove.length > 0) {
      await this.iamClient.send(
        new UntagPolicyCommand({ PolicyArn: policyArn, TagKeys: tagsToRemove })
      );
    }
    if (tagsToAdd.length > 0) {
      await this.iamClient.send(new TagPolicyCommand({ PolicyArn: policyArn, Tags: tagsToAdd }));
    }
  }

  private async findPolicyArnByName(policyName: string): Promise<string | undefined> {
    let marker: string | undefined;
    do {
      const resp = await this.iamClient.send(
        new ListPoliciesCommand({ Scope: 'Local', ...(marker ? { Marker: marker } : {}) })
      );
      for (const p of resp.Policies ?? []) {
        if (p.PolicyName === policyName && p.Arn) return p.Arn;
      }
      marker = resp.IsTruncated ? resp.Marker : undefined;
    } while (marker);
    return undefined;
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
