import { IAMClient } from '@aws-sdk/client-iam';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { IamCreateClientCache } from './iam-create-client.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { type DeleteContext } from '../region-check.js';
import { type MaskedLogSinks, type MaskerFn } from '../masked-retry-logger.js';
import { type DeleteProgress } from '../delete-started.js';
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
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { wrapMaskedError } from './iam-role/shared.js';
import { create } from './iam-role/create.js';
import {
  update,
  updateManagedPolicies,
  updateInlinePolicies,
  updateTags,
} from './iam-role/update.js';
import {
  deleteImpl,
  detachAllManagedPolicies,
  deleteAllInlinePolicies,
  removeFromAllInstanceProfiles,
} from './iam-role/delete.js';
import {
  getAttribute,
  isSameResource,
  resourceIdentity,
  readRoleIdIfExists,
  readCurrentState,
  importImpl,
} from './iam-role/read-state.js';

/**
 * AWS IAM Role Provider
 *
 * Implements resource provisioning for AWS::IAM::Role using the IAM SDK.
 * This is required because IAM Role is not supported by Cloud Control API.
 */
export class IAMRoleProvider implements ResourceProvider {
  iamClient: IAMClient;
  /** `CreateRole` goes through this client, which refuses the SDK retry of a 5xx (issue #4639). */
  readonly createClient = new IamCreateClientCache(() => this.iamClient);
  logger: ConsoleLogger = getLogger().child('IAMRoleProvider');

  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedError.call(this, mask, error, build);
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
   * means "no change" (live-verified 2026-07-27). CFn resets a
   * template-removed `Description` but KEEPS a removed `MaxSessionDuration`
   * at its live value (real CloudFormation A/B, go-to-k/cdkd#5004), so only
   * `Description` is reset here.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::IAM::Role',
      new Map<string, unknown>([
        // The AWS-documented clear sentinel; CFn resets it (#5004 A/B).
        ['Description', ''],
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
        // CFn keeps the live value on removal, and so does `update()`
        // (sends nothing; go-to-k/cdkd#5004 A/B).
        'MaxSessionDuration',
      ]),
    ],
  ]);

  constructor() {
    // Use global AWS clients manager for better resource management
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  detachAllManagedPolicies(
    roleName: string,
    // REQUIRED, so a create-path caller cannot silently fall back to an
    // unmasked sink; the delete path passes its own (issue #2007).
    log: MaskedLogSinks,
    progress?: DeleteProgress
  ): Promise<void> {
    return detachAllManagedPolicies.call(this, roleName, log, progress);
  }

  deleteAllInlinePolicies(
    roleName: string,
    // REQUIRED, so a create-path caller cannot silently fall back to an
    // unmasked sink; the delete path passes its own (issue #2007).
    log: MaskedLogSinks,
    progress?: DeleteProgress
  ): Promise<void> {
    return deleteAllInlinePolicies.call(this, roleName, log, progress);
  }

  removeFromAllInstanceProfiles(
    roleName: string,
    log: MaskedLogSinks,
    progress?: DeleteProgress
  ): Promise<void> {
    return removeFromAllInstanceProfiles.call(this, roleName, log, progress);
  }

  updateManagedPolicies(
    roleName: string,
    newPolicies: string[] | undefined,
    oldPolicies: string[] | undefined,
    log: MaskedLogSinks
  ): Promise<void> {
    return updateManagedPolicies.call(this, roleName, newPolicies, oldPolicies, log);
  }

  updateInlinePolicies(
    roleName: string,
    newPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    oldPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    log: MaskedLogSinks,
    claimed?: InlinePolicyClaimed
  ): Promise<void> {
    return updateInlinePolicies.call(this, roleName, newPolicies, oldPolicies, log, claimed);
  }

  updateTags(
    roleName: string,
    resourceType: string,
    logicalId: string,
    newTags: unknown,
    oldTags: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    return updateTags.call(this, roleName, resourceType, logicalId, newTags, oldTags, log);
  }

  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, _resourceType, attributeName);
  }

  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }

  resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    return resourceIdentity.call(this, physicalId, resourceType, context);
  }

  readRoleIdIfExists(roleName: string): Promise<string | undefined> {
    return readRoleIdIfExists.call(this, roleName);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>,
    context?: import('../../types/resource.js').ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType, properties, context);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}

/** The standalone inline policy type naming a principal of each kind, and its field. */
const STANDALONE_POLICY_SIBLINGS: Record<
  'Roles' | 'Users' | 'Groups',
  { type: string; field: string }
> = {
  Roles: { type: 'AWS::IAM::RolePolicy', field: 'RoleName' },
  Users: { type: 'AWS::IAM::UserPolicy', field: 'UserName' },
  Groups: { type: 'AWS::IAM::GroupPolicy', field: 'GroupName' },
};

/**
 * Issue #323: build the set of inline-policy names that are managed by
 * a sibling `AWS::IAM::Policy` resource in the same stack via the given
 * attachment field (`Roles` / `Users` / `Groups`), or by a sibling
 * `AWS::IAM::RolePolicy` / `UserPolicy` / `GroupPolicy` naming the
 * principal in `RoleName` / `UserName` / `GroupName`
 * (go-to-k/cdkd#4821). cdkd's IAM Role /
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
  // go-to-k/cdkd#4821: a standalone `AWS::IAM::RolePolicy` / `UserPolicy` /
  // `GroupPolicy` manages its ONE name on the principal its scalar field names.
  const standalone = STANDALONE_POLICY_SIBLINGS[attachmentField];
  for (const sibling of Object.values(siblings)) {
    if (sibling.resourceType === standalone.type) {
      const name = sibling.properties['PolicyName'];
      if (sibling.properties[standalone.field] === targetPhysicalId && typeof name === 'string') {
        result.add(name);
      }
      continue;
    }
    if (sibling.resourceType !== 'AWS::IAM::Policy') continue;
    const attachments = sibling.properties[attachmentField];
    if (!Array.isArray(attachments)) continue;
    if (!attachments.some((a) => a === targetPhysicalId)) continue;
    const name = sibling.properties['PolicyName'];
    if (typeof name === 'string') result.add(name);
  }
  return result;
}
