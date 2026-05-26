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
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceNameWithFallback } from '../resource-name.js';
import {
  matchesCdkPath,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

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
 * Physical id is the policy ARN (`arn:aws:iam::<account>:policy/<path><name>`)
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
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating IAM managed policy ${logicalId}`);

    const policyName = generateResourceNameWithFallback(
      properties['ManagedPolicyName'] as string | undefined,
      logicalId,
      { maxLength: 128 }
    );
    const policyDocument = properties['PolicyDocument'];

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for IAM managed policy ${logicalId}`,
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
      const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
      if (tags && Array.isArray(tags) && tags.length > 0) {
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
      this.logger.debug(`Created IAM managed policy: ${policyArn}`);

      // CreatePolicy has succeeded — AWS has committed the policy. Wire up
      // attachments next; if any fail, AWS-side cleanup mirrors `delete()`
      // (detach principals + delete non-default versions + DeletePolicy) so
      // the next redeploy doesn't trip over `EntityAlreadyExists`.
      try {
        await this.attachToPrincipals(
          policyArn,
          properties['Groups'] as string[] | undefined,
          properties['Roles'] as string[] | undefined,
          properties['Users'] as string[] | undefined
        );
      } catch (innerError) {
        try {
          await this.detachAllPrincipals(policyArn);
          await this.deleteAllNonDefaultVersions(policyArn);
          await this.iamClient.send(new DeletePolicyCommand({ PolicyArn: policyArn }));
          this.logger.debug(
            `Cleaned up partially-created managed policy ${logicalId} (${policyArn}) after attachment failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created managed policy ${logicalId} (${policyArn}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required: detach principals (aws iam list-entities-for-policy --policy-arn ${policyArn}), delete versions (aws iam list-policy-versions --policy-arn ${policyArn} then aws iam delete-policy-version), then aws iam delete-policy --policy-arn ${policyArn}`
          );
        }
        throw innerError;
      }

      return {
        physicalId: policyArn,
        attributes: {
          PolicyArn: policyArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM managed policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating IAM managed policy ${logicalId}: ${physicalId}`);

    const newPolicyName = generateResourceNameWithFallback(
      properties['ManagedPolicyName'] as string | undefined,
      logicalId,
      { maxLength: 128 }
    );
    const oldPolicyName = derivePolicyNameFromArn(physicalId);
    const newPath = (properties['Path'] as string | undefined) || '/';
    const oldPath = (previousProperties['Path'] as string | undefined) || '/';
    const newDescription = properties['Description'] as string | undefined;
    const oldDescription = previousProperties['Description'] as string | undefined;

    // ManagedPolicyName, Path, and Description are all immutable on AWS.
    const needsReplacement =
      newPolicyName !== oldPolicyName ||
      newPath !== oldPath ||
      (newDescription ?? '') !== (oldDescription ?? '');

    if (needsReplacement) {
      const reason =
        newPolicyName !== oldPolicyName
          ? 'ManagedPolicyName'
          : newPath !== oldPath
            ? 'Path'
            : 'Description';
      this.logger.debug(
        `${reason} changed, replacing managed policy: ${physicalId} (${reason} mutation)`
      );

      const createResult = await this.create(logicalId, resourceType, properties);
      try {
        await this.delete(logicalId, physicalId, resourceType, previousProperties);
      } catch (error) {
        this.logger.warn(
          `Failed to delete old managed policy ${physicalId} during replacement: ${String(error)}. ` +
            `The old policy may be orphaned and require manual cleanup.`
        );
      }

      const result: ResourceUpdateResult = {
        physicalId: createResult.physicalId,
        wasReplaced: true,
      };
      if (createResult.attributes) {
        result.attributes = createResult.attributes;
      }
      return result;
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
          await this.ensureVersionCapacity(physicalId);
          await this.iamClient.send(
            new CreatePolicyVersionCommand({
              PolicyArn: physicalId,
              PolicyDocument: newDocStr,
              SetAsDefault: true,
            })
          );
          this.logger.debug(`Updated PolicyDocument for ${physicalId}`);
        }
      }

      // Diff principal attachments.
      await this.updatePrincipals(
        physicalId,
        properties['Groups'] as string[] | undefined,
        previousProperties['Groups'] as string[] | undefined,
        properties['Roles'] as string[] | undefined,
        previousProperties['Roles'] as string[] | undefined,
        properties['Users'] as string[] | undefined,
        previousProperties['Users'] as string[] | undefined
      );

      // Diff tags.
      await this.updateTags(
        physicalId,
        properties['Tags'] as Array<{ Key: string; Value: string }> | undefined,
        previousProperties['Tags'] as Array<{ Key: string; Value: string }> | undefined
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
        `Failed to update IAM managed policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
  ): Promise<void> {
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
   *  2. `ListPolicies(Scope: 'Local')` → for each candidate, `ListPolicyTags`
   *     and match against `aws:cdk:path`.
   *
   * Scope is forced to `'Local'` (customer-managed policies) — adopting an
   * AWS-managed policy would let cdkd delete it on next destroy, which would
   * be a major footgun.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'ManagedPolicyName');
    if (explicit) {
      // If the override is already an ARN, trust it (verify exists). But
      // refuse AWS-managed policies (`arn:aws:iam::aws:policy/...`) outright —
      // adopting one would let cdkd's destroy path attempt `DeletePolicy`
      // (always rejected by IAM) but only AFTER `detachAllPrincipals` has
      // forcibly detached the policy from every user / role / group in the
      // account. That's a major foot-gun (think `AdministratorAccess`); the
      // tag-based fallback path is already guarded by `Scope: 'Local'`, and
      // the explicit-ARN path needs the same guard.
      if (explicit.startsWith('arn:')) {
        if (explicit.startsWith('arn:aws:iam::aws:')) {
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

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.iamClient.send(
        new ListPoliciesCommand({ Scope: 'Local', ...(marker ? { Marker: marker } : {}) })
      );
      for (const policy of list.Policies ?? []) {
        if (!policy.Arn) continue;
        try {
          const tags = await this.iamClient.send(
            new ListPolicyTagsCommand({ PolicyArn: policy.Arn })
          );
          if (matchesCdkPath(tags.Tags, input.cdkPath)) {
            return { physicalId: policy.Arn, attributes: { PolicyArn: policy.Arn } };
          }
        } catch (err) {
          if (err instanceof NoSuchEntityException) continue;
          throw err;
        }
      }
      marker = list.IsTruncated ? list.Marker : undefined;
    } while (marker);
    return null;
  }

  // ── helpers ───────────────────────────────────────────────────────

  private async attachToPrincipals(
    policyArn: string,
    groups: string[] | undefined,
    roles: string[] | undefined,
    users: string[] | undefined
  ): Promise<void> {
    if (groups && Array.isArray(groups)) {
      for (const groupName of groups) {
        await this.iamClient.send(
          new AttachGroupPolicyCommand({ GroupName: groupName, PolicyArn: policyArn })
        );
        this.logger.debug(`Attached ${policyArn} to group ${groupName}`);
      }
    }
    if (roles && Array.isArray(roles)) {
      for (const roleName of roles) {
        await this.iamClient.send(
          new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn })
        );
        this.logger.debug(`Attached ${policyArn} to role ${roleName}`);
      }
    }
    if (users && Array.isArray(users)) {
      for (const userName of users) {
        await this.iamClient.send(
          new AttachUserPolicyCommand({ UserName: userName, PolicyArn: policyArn })
        );
        this.logger.debug(`Attached ${policyArn} to user ${userName}`);
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
    oldUsers: string[] | undefined
  ): Promise<void> {
    const newGroupSet = new Set(newGroups || []);
    const oldGroupSet = new Set(oldGroups || []);
    for (const g of newGroupSet) {
      if (!oldGroupSet.has(g)) {
        await this.iamClient.send(
          new AttachGroupPolicyCommand({ GroupName: g, PolicyArn: policyArn })
        );
        this.logger.debug(`Attached ${policyArn} to group ${g}`);
      }
    }
    for (const g of oldGroupSet) {
      if (!newGroupSet.has(g)) {
        try {
          await this.iamClient.send(
            new DetachGroupPolicyCommand({ GroupName: g, PolicyArn: policyArn })
          );
          this.logger.debug(`Detached ${policyArn} from group ${g}`);
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
        this.logger.debug(`Attached ${policyArn} to role ${r}`);
      }
    }
    for (const r of oldRoleSet) {
      if (!newRoleSet.has(r)) {
        try {
          await this.iamClient.send(
            new DetachRolePolicyCommand({ RoleName: r, PolicyArn: policyArn })
          );
          this.logger.debug(`Detached ${policyArn} from role ${r}`);
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
        this.logger.debug(`Attached ${policyArn} to user ${u}`);
      }
    }
    for (const u of oldUserSet) {
      if (!newUserSet.has(u)) {
        try {
          await this.iamClient.send(
            new DetachUserPolicyCommand({ UserName: u, PolicyArn: policyArn })
          );
          this.logger.debug(`Detached ${policyArn} from user ${u}`);
        } catch (err) {
          if (!(err instanceof NoSuchEntityException)) throw err;
        }
      }
    }
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
  private async ensureVersionCapacity(policyArn: string): Promise<void> {
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
    this.logger.debug(`Pruned oldest non-default version ${victim.VersionId} of ${policyArn}`);
  }

  private async updateTags(
    policyArn: string,
    newTags: Array<{ Key: string; Value: string }> | undefined,
    oldTags: Array<{ Key: string; Value: string }> | undefined
  ): Promise<void> {
    const newTagMap = new Map((newTags || []).map((t) => [t.Key, t.Value]));
    const oldTagMap = new Map((oldTags || []).map((t) => [t.Key, t.Value]));

    const tagsToRemove: string[] = [];
    for (const key of oldTagMap.keys()) {
      if (!newTagMap.has(key)) tagsToRemove.push(key);
    }
    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [key, value] of newTagMap) {
      if (oldTagMap.get(key) !== value) tagsToAdd.push({ Key: key, Value: value });
    }

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
 * Recover the policy name from `arn:aws:iam::<account>:policy/<path><name>`.
 * Used to decide whether `ManagedPolicyName` was mutated relative to the
 * physical id we recorded — name + path are immutable on AWS, so any
 * difference is a replacement signal.
 */
function derivePolicyNameFromArn(arn: string): string {
  // ARN shape: arn:aws:iam::<account>:policy/<path-may-contain-slashes>/<name>
  // The final '/'-delimited segment is the name; path is everything between
  // the leading 'policy/' and the name.
  const ix = arn.lastIndexOf('/');
  return ix >= 0 ? arn.slice(ix + 1) : arn;
}
