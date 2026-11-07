import type { IAMPolicyProvider } from '../iam-policy-provider.js';
import {
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  PutGroupPolicyCommand,
  DeleteGroupPolicyCommand,
  PutUserPolicyCommand,
  DeleteUserPolicyCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import { describeAwsFailure, VERBOSE_POINTER } from '../../../utils/aws-failure-text.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { type AttachedPrincipals, readPolicyTargetLists } from './shared.js';

/**
 * Create an IAM inline policy
 */
export async function create(
  this: IAMPolicyProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: ONE masked sink per operation (the `ssm-parameter-provider.ts`
  // shape), and every bag-derived value masked RAW as well. Absent context
  // means identity.
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  const { value: v } = log;
  log.debug(`Creating IAM policy ${logicalId}`);

  const policyName =
    (properties['PolicyName'] as string | undefined) ||
    generatedNameFor('AWS::IAM::Policy', logicalId);
  const policyDocument = properties['PolicyDocument'];
  const targets = readPolicyTargetLists(properties);
  if ('malformed' in targets) {
    // CloudFormation rejects a non-list here too; refused before any call.
    throw new ProvisioningError(
      `${targets.malformed.join(' / ')} of IAM policy ${logicalId} is not a list of IAM ` +
        `names — no inline policy was attached`,
      resourceType,
      logicalId
    );
  }
  const { roles, groups, users } = targets;

  if (!policyDocument) {
    throw new ProvisioningError(
      `PolicyDocument is required for IAM policy ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // At least one of Roles, Groups, or Users must be specified
  const hasTargets =
    (roles && roles.length > 0) || (groups && groups.length > 0) || (users && users.length > 0);
  if (!hasTargets) {
    throw new ProvisioningError(
      `At least one of Roles, Groups, or Users is required for IAM policy ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // go-to-k/cdkd#4583: the principals whose Put*Policy RETURNED, the only
  // ones a failed create may detach the policy from again.
  const attached: AttachedPrincipals = { roles: [], groups: [], users: [] };
  try {
    // Serialize policy document
    const policyDoc =
      typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

    // Attach policy to all roles
    // Note: AWS::IAM::Policy in CloudFormation is actually an inline policy
    if (roles) {
      for (const roleName of roles) {
        await this.iamClient.send(
          new PutRolePolicyCommand({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: policyDoc,
          })
        );
        attached.roles.push(roleName);
        log.debug(`Attached inline policy ${v(policyName)} to role ${v(roleName)}`);
      }
    }

    // Attach policy to all groups
    if (groups) {
      for (const groupName of groups) {
        await this.iamClient.send(
          new PutGroupPolicyCommand({
            GroupName: groupName,
            PolicyName: policyName,
            PolicyDocument: policyDoc,
          })
        );
        attached.groups.push(groupName);
        log.debug(`Attached inline policy ${v(policyName)} to group ${v(groupName)}`);
      }
    }

    // Attach policy to all users
    if (users) {
      for (const userName of users) {
        await this.iamClient.send(
          new PutUserPolicyCommand({
            UserName: userName,
            PolicyName: policyName,
            PolicyDocument: policyDoc,
          })
        );
        attached.users.push(userName);
        log.debug(`Attached inline policy ${v(policyName)} to user ${v(userName)}`);
      }
    }

    log.debug(`Successfully created IAM policy ${logicalId}: ${v(policyName)}`);

    // For inline policies, physical ID is the policy name
    const physicalId = policyName;

    return {
      physicalId,
      attributes: {
        PolicyName: policyName,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    // go-to-k/cdkd#4583: detach the policy from exactly the principals this
    // create attached it to. It is NOT marked for --revert-failed: delete()
    // walks every recorded principal, including one this create never
    // reached that may hold a same-named inline policy from elsewhere.
    await this.detachPartialPolicy(logicalId, policyName, attached, log, context?.maskSecrets);
    // AWS's own error text quotes the principal it refused, so every listed
    // principal name is a needle for the thrown message as well.
    const errorSinks = withDerivedNameMasks(
      this.logger,
      log,
      [...(roles ?? []), ...(groups ?? []), ...(users ?? [])].map((n) => [n, n] as const)
    );
    throw this.wrapMaskedError(
      errorSinks.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create IAM policy ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          policyName,
          cause
        )
    );
  }
}

/**
 * Remove the inline policy a failed `create()` attached, from the principals
 * whose put returned and no other (go-to-k/cdkd#4583). A principal that no
 * longer has it (NoSuchEntity) is clean. One the delete fails on is named in
 * a warning with its pasteable command; nothing is thrown, so the create's
 * own failure stays the error.
 */
export async function detachPartialPolicy(
  this: IAMPolicyProvider,
  logicalId: string,
  policyName: string,
  attached: AttachedPrincipals,
  sinks: MaskedLogSinks,
  maskSecrets: MaskerFn | undefined
): Promise<void> {
  const aws = pasteableAwsCommand(maskSecrets);
  // Each value masked RAW before interpolation: a short secret-derived name
  // falls below the whole-line masker's substring floor. The principal names
  // are needles too, since AWS's own error text quotes them
  // ("... on resource: role <name>").
  const log = withDerivedNameMasks(
    this.logger,
    sinks,
    [...attached.roles, ...attached.groups, ...attached.users].map((n) => [n, n] as const)
  );
  const { value: v } = log;
  const steps: Array<{ what: string; send: () => Promise<unknown>; command: string }> = [
    ...attached.roles.map((name) => ({
      what: `role ${v(name)}`,
      send: () =>
        this.iamClient.send(
          new DeleteRolePolicyCommand({ RoleName: name, PolicyName: policyName })
        ),
      command:
        aws`aws iam delete-role-policy --role-name ${name} --policy-name ${policyName}`.render(),
    })),
    ...attached.groups.map((name) => ({
      what: `group ${v(name)}`,
      send: () =>
        this.iamClient.send(
          new DeleteGroupPolicyCommand({ GroupName: name, PolicyName: policyName })
        ),
      command:
        aws`aws iam delete-group-policy --group-name ${name} --policy-name ${policyName}`.render(),
    })),
    ...attached.users.map((name) => ({
      what: `user ${v(name)}`,
      send: () =>
        this.iamClient.send(
          new DeleteUserPolicyCommand({ UserName: name, PolicyName: policyName })
        ),
      command:
        aws`aws iam delete-user-policy --user-name ${name} --policy-name ${policyName}`.render(),
    })),
  ];
  const failed: string[] = [];
  let withheld = false;
  for (const step of steps) {
    try {
      await step.send();
      log.debug(
        `Detached inline policy ${v(policyName)} from ${step.what} after the create failed`
      );
    } catch (error) {
      if (error instanceof NoSuchEntityException) continue;
      // An AWS-authored failure is named by its class at warn, and AWS's
      // text (a denied detach names the caller) goes to `debug`
      // (go-to-k/cdkd#2319).
      const failure = describeAwsFailure(error);
      if (failure.redacted) {
        log.debug(
          `Failed to detach the partially-created IAM policy ${logicalId} (${v(policyName)}) from ${step.what}: ${failure.detail}`
        );
      }
      // The class alone per step; the --verbose pointer once, after the list.
      withheld ||= failure.redacted;
      const tail = ` ${VERBOSE_POINTER}`;
      const reason = !failure.redacted
        ? failure.detail
        : failure.summary.endsWith(tail)
          ? failure.summary.slice(0, -tail.length).replace(/\.$/, '')
          : failure.summary;
      failed.push(`${step.what} (${log.mask(reason)}): ${step.command}`);
    }
  }
  if (failed.length > 0) {
    log.warn(
      `Failed to detach the partially-created IAM policy ${logicalId} (${v(policyName)}) after ` +
        `its create failed; cdkd has no record of it, so it stays attached and granting until ` +
        // The pointer comes before the list: after it, a period would join
        // the last pasteable command.
        `it is removed by hand${withheld ? ` (${VERBOSE_POINTER.replace(/\.$/, '')})` : ''}: ${failed.join('; ')}`
    );
  }
}
