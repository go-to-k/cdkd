/**
 * Reading statements, attachments and rules out of resource properties.
 * Split out of `../security-changes.ts` (#5835).
 */

import {
  ManagedPolicyAttachment,
  SecurityGroupRule,
  SsoElement,
  Statement,
  defaultPrincipal,
  defaultResource,
  parseLambdaPermission,
  parseStatements,
  renderIntrinsics,
  type Json,
} from './model.js';

export function readIdentityPolicies(policies: Json, logicalId: string): Statement[] {
  if (policies === undefined || !Array.isArray(policies)) return [];
  const appliesToPrincipal = 'AWS:${' + logicalId + '}';
  return policies.flatMap((policy: Json) => {
    // The policy itself may be an intrinsic, like an `Fn::If`.
    const unparsed = policy.PolicyDocument?.Statement ? policy.PolicyDocument.Statement : policy;
    return defaultPrincipal(appliesToPrincipal, parseStatements(renderIntrinsics(unparsed)));
  });
}

/** An `AWS::IAM::Policy`-like resource: its statements, once per attached identity. */
export function readIdentityPolicyResource(properties: Json): Statement[] {
  if (properties === undefined) return [];
  properties = renderIntrinsics(properties);
  const principals: Json[] = (properties.Groups || [])
    .concat(properties.Users || [])
    .concat(properties.Roles || []);
  return principals.flatMap((principal) =>
    defaultPrincipal('AWS:' + principal, parseStatements(properties.PolicyDocument.Statement))
  );
}

export function readPermissionSetInlinePolicy(policy: Json, logicalId: string): Statement[] {
  if (policy === undefined) return [];
  const statements = parseStatements(renderIntrinsics(policy.Statement));
  defaultResource('${' + logicalId + '.Arn}', statements);
  defaultPrincipal('AWS:${' + logicalId + '}', statements);
  return statements;
}

export function readResourceStatements(policy: Json, logicalId: string): Statement[] {
  if (policy === undefined) return [];
  return defaultResource(
    '${' + logicalId + '.Arn}',
    parseStatements(renderIntrinsics(policy.Statement))
  );
}

/** An `AWS::*::{Bucket,Queue,Topic}Policy`-like resource. */
export function readResourcePolicyResource(properties: Json): Statement[] {
  if (properties === undefined) return [];
  properties = renderIntrinsics(properties);
  const policyKeys = Object.keys(properties).filter((key) => key.indexOf('Policy') > -1);
  // The key naming what the policy applies to.
  const resourceKeys = Object.keys(properties).filter(
    (key) => !policyKeys.includes(key) && !key.endsWith('Name')
  );
  let resources: Json = resourceKeys.length === 1 ? properties[resourceKeys[0]!] : ['???'];
  if (!Array.isArray(resources)) resources = [resources];
  return (resources as Json[]).flatMap((resource) =>
    defaultResource(resource, parseStatements(properties[policyKeys[0]!].Statement))
  );
}

export function readManagedPolicies(
  policyArns: Json,
  logicalId: string
): ManagedPolicyAttachment[] {
  if (!policyArns) return [];
  const identity = '${' + logicalId + '}';
  const arns = renderIntrinsics(policyArns);
  return typeof arns === 'string'
    ? [new ManagedPolicyAttachment(identity, arns)]
    : arns.map((arn: Json) => new ManagedPolicyAttachment(identity, arn));
}

export function readLambdaStatements(properties: Json): Statement[] {
  if (!properties) return [];
  return [parseLambdaPermission(renderIntrinsics(properties))];
}

export function readInlineRules(rules: Json, logicalId: string): SecurityGroupRule[] {
  if (!rules || !Array.isArray(rules)) return [];
  const ref = '${' + logicalId + '.GroupId}';
  return rules.flatMap((rule: Json) => {
    const rendered = renderIntrinsics(rule);
    return typeof rendered === 'object' ? [new SecurityGroupRule(rendered, ref)] : [];
  });
}

export function readRuleResource(resource: Json): SecurityGroupRule[] {
  if (!resource) return [];
  return [new SecurityGroupRule(renderIntrinsics(resource))];
}

/** Each IAM Identity Center element's fields, in the order its table shows them. */
export const permissionSetFields = (p: Json): Record<string, Json> => ({
  name: p.Name,
  ssoInstanceArn: p.InstanceArn,
  ssoCustomerManagedPolicyReferences: p.CustomerManagedPolicyReferences,
  ssoPermissionsBoundary: p.PermissionsBoundary,
});
export const assignmentFields = (p: Json): Record<string, Json> => ({
  ssoInstanceArn: p.InstanceArn,
  permissionSetArn: p.PermissionSetArn,
  principalId: p.PrincipalId,
  principalType: p.PrincipalType,
  targetId: p.TargetId,
  targetType: p.TargetType,
});
export const acaConfigFields = (p: Json): Record<string, Json> => ({
  ssoInstanceArn: p.InstanceArn,
  accessControlAttributes: p.AccessControlAttributes,
});

export function readSso(
  properties: Json,
  logicalId: string,
  fields: (p: Json) => Record<string, Json>
): SsoElement[] {
  if (properties === undefined) return [];
  // `undefined` fields are left out, so an absent one equals a missing one.
  const values = Object.fromEntries(
    Object.entries({
      cfnLogicalId: '${' + logicalId + '}',
      ...fields(renderIntrinsics(properties)),
    }).filter(([, v]) => v !== undefined)
  );
  return [new SsoElement(values)];
}
