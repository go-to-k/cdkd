/**
 * The IAM and security-group change classifier behind `broadening`
 * (go-to-k/cdkd#4601): which statements, managed-policy attachments and
 * security-group rules two templates add or remove, whether that broadens
 * permissions, and the table that shows it.
 *
 * It follows the AWS CDK CLI's own classifier (`@aws-cdk/cloudformation-diff`,
 * Apache-2.0: `TemplateDiff.permissionsBroadened`, `IamChanges`,
 * `SecurityGroupChanges`, `formatSecurityChanges`) rule for rule, so a change
 * `cdk deploy --require-approval=broadening` stops for stops cdkd too. It is
 * cdkd's own code: cdkd has no runtime dependency on a CDK library.
 * `tests/unit/analyzer/security-changes-parity.test.ts` runs both over the same
 * templates (the package is a devDependency for that alone) and
 * its last case holds {@link RESOURCE_SCRUTINY} /
 * {@link PROPERTY_SCRUTINY} to the service-spec database they were read from.
 */

import { propertyScrutinies, resourceScrutiny } from './security-changes/scrutiny.js';
import {
  DiffableCollection,
  ManagedPolicyAttachment,
  SecurityGroupRule,
  SsoElement,
  Statement,
  normalize,
  resourceDiffers,
  type PropertyChange,
  type ResourceDiff,
  type ResourceScrutinyChange,
  type SecurityTemplate,
} from './security-changes/model.js';
import {
  acaConfigFields,
  assignmentFields,
  permissionSetFields,
  readIdentityPolicies,
  readIdentityPolicyResource,
  readInlineRules,
  readLambdaStatements,
  readManagedPolicies,
  readPermissionSetInlinePolicy,
  readResourcePolicyResource,
  readResourceStatements,
  readRuleResource,
  readSso,
} from './security-changes/readers.js';

export {
  RESOURCE_SCRUTINY,
  PROPERTY_SCRUTINY,
  isScrutinizedProperty,
} from './security-changes/scrutiny.js';
export type { SecurityTemplateResource, SecurityTemplate } from './security-changes/model.js';
export { formatSecurityChanges, stdoutSupportsColor } from './security-changes/format.js';

/** The IAM and security-group changes between two templates. */
export class SecurityChanges {
  readonly statements = new DiffableCollection<Statement>();
  readonly managedPolicies = new DiffableCollection<ManagedPolicyAttachment>();
  readonly ssoPermissionSets = new DiffableCollection<SsoElement>();
  readonly ssoAssignments = new DiffableCollection<SsoElement>();
  readonly ssoInstanceACAConfigs = new DiffableCollection<SsoElement>();
  readonly ingress = new DiffableCollection<SecurityGroupRule>();
  readonly egress = new DiffableCollection<SecurityGroupRule>();

  /** Normalizes both templates IN PLACE; pass copies. */
  constructor(oldTemplate: SecurityTemplate, newTemplate: SecurityTemplate) {
    normalize(oldTemplate);
    normalize(newTemplate);
    const oldResources = oldTemplate.Resources ?? {};
    const newResources = newTemplate.Resources ?? {};
    const changed: Array<[string, ResourceDiff]> = [];
    for (const id of new Set([...Object.keys(oldResources), ...Object.keys(newResources)])) {
      const oldValue = Object.hasOwn(oldResources, id) ? oldResources[id] : undefined;
      const newValue = Object.hasOwn(newResources, id) ? newResources[id] : undefined;
      if (oldValue === undefined && newValue === undefined) continue;
      if (resourceDiffers(oldValue, newValue)) changed.push([id, { oldValue, newValue }]);
    }
    for (const change of this.propertyChanges(changed)) this.readPropertyChange(change);
    for (const change of this.resourceChanges(changed)) this.readResourceChange(change);
    for (const collection of this.collections()) collection.calculateDiff();
  }

  private collections(): Array<DiffableCollection<never>> {
    return [
      this.statements,
      this.managedPolicies,
      this.ssoPermissionSets,
      this.ssoAssignments,
      this.ssoInstanceACAConfigs,
      this.ingress,
      this.egress,
    ] as unknown as Array<DiffableCollection<never>>;
  }

  private propertyChanges(changed: Array<[string, ResourceDiff]>): PropertyChange[] {
    const ret: PropertyChange[] = [];
    for (const [logicalId, { oldValue, newValue }] of changed) {
      const oldType = oldValue?.Type;
      const newType = newValue?.Type;
      // A type change is read as a resource removal plus an addition below.
      if (oldType !== undefined && newType !== undefined && oldType !== newType) continue;
      const resourceType = oldType ?? newType;
      if (!resourceType) continue;
      for (const [propertyName, scrutiny] of Object.entries(propertyScrutinies(resourceType))) {
        ret.push({
          logicalId,
          resourceType,
          scrutiny,
          oldValue: oldValue?.Properties?.[propertyName],
          newValue: newValue?.Properties?.[propertyName],
        });
      }
    }
    return ret;
  }

  private resourceChanges(changed: Array<[string, ResourceDiff]>): ResourceScrutinyChange[] {
    const ret: ResourceScrutinyChange[] = [];
    for (const [logicalId, { oldValue, newValue }] of changed) {
      const oldType = oldValue?.Type;
      const newType = newValue?.Type;
      const common = {
        logicalId,
        oldProperties: oldValue?.Properties,
        newProperties: newValue?.Properties,
      };
      if (oldType !== undefined && newType !== undefined && oldType !== newType) {
        const oldScrutiny = resourceScrutiny(oldType);
        if (oldScrutiny) ret.push({ ...common, newProperties: undefined, scrutiny: oldScrutiny });
        const newScrutiny = resourceScrutiny(newType);
        if (newScrutiny) ret.push({ ...common, oldProperties: undefined, scrutiny: newScrutiny });
        continue;
      }
      const type = oldType ?? newType;
      const scrutiny = type ? resourceScrutiny(type) : undefined;
      if (scrutiny) ret.push({ ...common, scrutiny });
    }
    return ret;
  }

  /** Statements added that allow, removed that deny, or any attachment / rule added. */
  get permissionsBroadened(): boolean {
    return (
      this.statements.additions.some((s) => !s.isNegativeStatement) ||
      this.statements.removals.some((s) => s.isNegativeStatement) ||
      this.managedPolicies.hasAdditions ||
      this.ssoPermissionSets.hasAdditions ||
      this.ssoAssignments.hasAdditions ||
      this.ssoInstanceACAConfigs.hasAdditions ||
      this.ingress.hasAdditions ||
      this.egress.hasAdditions
    );
  }

  get iamHasChanges(): boolean {
    return (
      this.statements.hasChanges ||
      this.managedPolicies.hasChanges ||
      this.ssoPermissionSets.hasChanges ||
      this.ssoAssignments.hasChanges ||
      this.ssoInstanceACAConfigs.hasChanges
    );
  }

  get securityGroupsHaveChanges(): boolean {
    return this.ingress.hasChanges || this.egress.hasChanges;
  }

  get permissionsAnyChanges(): boolean {
    return this.iamHasChanges || this.securityGroupsHaveChanges;
  }

  private readPropertyChange(change: PropertyChange): void {
    switch (change.scrutiny) {
      case 'InlineIdentityPolicies':
        this.statements.addOld(...readIdentityPolicies(change.oldValue, change.logicalId));
        this.statements.addNew(...readIdentityPolicies(change.newValue, change.logicalId));
        break;
      case 'InlineResourcePolicy':
        if (change.resourceType === 'AWS::SSO::PermissionSet') {
          this.statements.addOld(
            ...readPermissionSetInlinePolicy(change.oldValue, change.logicalId)
          );
          this.statements.addNew(
            ...readPermissionSetInlinePolicy(change.newValue, change.logicalId)
          );
        } else {
          this.statements.addOld(...readResourceStatements(change.oldValue, change.logicalId));
          this.statements.addNew(...readResourceStatements(change.newValue, change.logicalId));
        }
        break;
      case 'ManagedPolicies':
        this.managedPolicies.addOld(...readManagedPolicies(change.oldValue, change.logicalId));
        this.managedPolicies.addNew(...readManagedPolicies(change.newValue, change.logicalId));
        break;
      case 'IngressRules':
        this.ingress.addOld(...readInlineRules(change.oldValue, change.logicalId));
        this.ingress.addNew(...readInlineRules(change.newValue, change.logicalId));
        break;
      case 'EgressRules':
        this.egress.addOld(...readInlineRules(change.oldValue, change.logicalId));
        this.egress.addNew(...readInlineRules(change.newValue, change.logicalId));
        break;
    }
  }

  private readResourceChange(change: ResourceScrutinyChange): void {
    const id = change.logicalId;
    switch (change.scrutiny) {
      case 'IdentityPolicyResource':
        this.statements.addOld(...readIdentityPolicyResource(change.oldProperties));
        this.statements.addNew(...readIdentityPolicyResource(change.newProperties));
        break;
      case 'ResourcePolicyResource':
        this.statements.addOld(...readResourcePolicyResource(change.oldProperties));
        this.statements.addNew(...readResourcePolicyResource(change.newProperties));
        break;
      case 'LambdaPermission':
        this.statements.addOld(...readLambdaStatements(change.oldProperties));
        this.statements.addNew(...readLambdaStatements(change.newProperties));
        break;
      case 'SsoPermissionSet':
        this.ssoPermissionSets.addOld(...readSso(change.oldProperties, id, permissionSetFields));
        this.ssoPermissionSets.addNew(...readSso(change.newProperties, id, permissionSetFields));
        break;
      case 'SsoAssignmentResource':
        this.ssoAssignments.addOld(...readSso(change.oldProperties, id, assignmentFields));
        this.ssoAssignments.addNew(...readSso(change.newProperties, id, assignmentFields));
        break;
      case 'SsoInstanceACAConfigResource':
        this.ssoInstanceACAConfigs.addOld(...readSso(change.oldProperties, id, acaConfigFields));
        this.ssoInstanceACAConfigs.addNew(...readSso(change.newProperties, id, acaConfigFields));
        break;
      case 'IngressRuleResource':
        this.ingress.addOld(...readRuleResource(change.oldProperties));
        this.ingress.addNew(...readRuleResource(change.newProperties));
        break;
      case 'EgressRuleResource':
        this.egress.addOld(...readRuleResource(change.oldProperties));
        this.egress.addNew(...readRuleResource(change.newProperties));
        break;
    }
  }
}
