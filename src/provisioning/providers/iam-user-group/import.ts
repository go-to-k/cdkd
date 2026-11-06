import type { IAMUserGroupProvider } from '../iam-user-group-provider.js';
import { GetUserCommand, GetGroupCommand, NoSuchEntityException } from '@aws-sdk/client-iam';
import { definedAttributes } from '../../attribute-map.js';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';

/**
 * Adopt an existing IAM user / group / user-to-group addition into cdkd state.
 *
 *  - **AWS::IAM::User**: `--resource` override or `Properties.UserName`,
 *    verified via `GetUser`.
 *  - **AWS::IAM::Group**: `--resource` override or `Properties.GroupName`,
 *    verified via `GetGroup`.
 *  - **AWS::IAM::UserToGroupAddition**: explicit-override only. Has no
 *    AWS-side identity beyond the (group, users) attachment itself.
 */
export async function importImpl(
  this: IAMUserGroupProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::IAM::User':
      return this.importUser(input);
    case 'AWS::IAM::Group':
      return this.importGroup(input);
    case 'AWS::IAM::UserToGroupAddition':
      return this.importUserToGroupAddition(input);
    default:
      return null;
  }
}

export async function importUser(
  this: IAMUserGroupProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'UserName');
  if (explicit) {
    try {
      const resp = await this.iamClient.send(new GetUserCommand({ UserName: explicit }));
      // Issue #3627: the `Arn` `create()` records. The resolver's arm builds
      // `user/<name>` and drops a non-`/` `Path`, silently.
      return { physicalId: explicit, attributes: definedAttributes({ Arn: resp.User?.Arn }) };
    } catch (err) {
      if (err instanceof NoSuchEntityException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // user reaching here needs an explicit `--resource` override.
  return null;
}

export async function importGroup(
  this: IAMUserGroupProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'GroupName');
  if (explicit) {
    try {
      const resp = await this.iamClient.send(new GetGroupCommand({ GroupName: explicit }));
      // Issue #3627: the `Arn` `create()` records (the resolver's arm drops a
      // non-`/` `Path`).
      return { physicalId: explicit, attributes: definedAttributes({ Arn: resp.Group?.Arn }) };
    } catch (err) {
      if (err instanceof NoSuchEntityException) return null;
      throw err;
    }
  }

  // IAM groups are not taggable — there is no ListGroupTags API. Without
  // an explicit override and no template name, we cannot reliably match
  // a group to its CDK construct path. Fall back to "not found" so the
  // import command marks it as skipped.
  return null;
}

// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function importUserToGroupAddition(
  this: IAMUserGroupProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    return { physicalId: input.knownPhysicalId, attributes: {} };
  }
  return null;
}
