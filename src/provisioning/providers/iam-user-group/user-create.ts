import type { IAMUserGroupProvider } from '../iam-user-group-provider.js';
import {
  CreateUserCommand,
  DeleteUserCommand,
  GetUserCommand,
  AttachUserPolicyCommand,
  PutUserPolicyCommand,
  CreateLoginProfileCommand,
  UpdateLoginProfileCommand,
  AddUserToGroupCommand,
  DeleteLoginProfileCommand,
  NoSuchEntityException,
  PutUserPermissionsBoundaryCommand,
  DeleteUserPermissionsBoundaryCommand,
  type User,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generateResourceNameWithFallback } from '../../resource-name.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { iamEntityLeftByThisCreate, isEntityAlreadyExists } from '../iam-replay-adopt.js';
import { readPrincipalLists } from '../../iam-policy-targets.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import {
  userOrGroupIdentityToken,
  PROFILE_SETTLING_ERROR,
  LOGIN_PROFILE_SETTLING_MESSAGE,
  USER_NAME_MAX_LENGTH,
} from './shared.js';

export async function createUser(
  this: IAMUserGroupProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  const { value: v } = log;
  log.debug(`Creating IAM user ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const userName = generateResourceNameWithFallback(
    properties['UserName'] as string | undefined,
    logicalId,
    { maxLength: USER_NAME_MAX_LENGTH }
  );
  // Read before any call (go-to-k/cdkd#3888): a rollback's
  // reverse-replacement create passes a recorded bag here.
  const groups = readPrincipalLists({ Groups: properties['Groups'] });
  if ('malformed' in groups) {
    throw new ProvisioningError(
      `Groups of IAM user ${logicalId} is not a list of IAM group names — no user was created`,
      resourceType,
      logicalId
    );
  }

  // go-to-k/cdkd#4583: set once CreateUser returns, or a replay adopts its own
  // user (#5660); cleared when the partial-create cleanup deleted the user, so
  // only a left-behind one is marked.
  let leftBehind = false;
  // go-to-k/cdkd#4606: the UserId CreateUser answered with, carried on the
  // mark so the journal needs no read of a user whose failure may fail that
  // read too.
  let createdUserIdentity: string | undefined;
  try {
    const createParams: {
      UserName: string;
      Path?: string;
      Tags?: Array<{ Key: string; Value: string }>;
    } = {
      UserName: userName,
    };

    if (properties['Path']) {
      createParams.Path = properties['Path'] as string;
    }

    if (properties['Tags'] !== undefined && properties['Tags'] !== null) {
      createParams.Tags = desiredTags;
    }

    const createClient = await this.createClient.get();
    let user: User | undefined;
    let adopted = false;
    try {
      user = (await createClient.send(new CreateUserCommand(createParams))).User;
    } catch (createError) {
      // go-to-k/cdkd#5660: a replay colliding with the user its own earlier
      // attempt left behind finishes that user; anything else fails as before.
      // Repeating `PutUserPermissionsBoundary`, `AttachUserPolicy`,
      // `AddUserToGroup` and `PutUserPolicy` each succeeded when measured on
      // real IAM (2026-11-03). `CreateLoginProfile` answers
      // `EntityAlreadyExists`, which is handled where it is sent.
      user = await iamEntityLeftByThisCreate({
        logicalId,
        resourceType,
        noun: 'user',
        displayName: userName,
        createError,
        namesThisEntity: (reported) => reported === userName,
        read: async () =>
          (await this.iamClient.send(new GetUserCommand({ UserName: userName }))).User,
        identityOf: (live) => userOrGroupIdentityToken(live?.UserId),
        log,
      });
      if (user === undefined) throw createError;
      adopted = true;
    }
    leftBehind = true;
    createdUserIdentity = userOrGroupIdentityToken(user?.UserId);
    if (!adopted) {
      reportCreatedResource(logicalId, resourceType, userName, createdUserIdentity); // go-to-k/cdkd#5511
    }

    // CreateUserCommand has succeeded — AWS has now committed the User
    // (and the inline `Tags` from `createParams` if any). Every
    // subsequent call wires sub-resources onto it (permissions
    // boundary / login profile / managed-policy attachments / group
    // membership / inline policies); if any fail, the user exists on
    // AWS but cdkd state will NOT (the throw aborts before the
    // success-return). The next redeploy would then re-try CREATE and
    // AWS would reject with `EntityAlreadyExists: User with name
    // <X> already exists`. Wrap the wiring in an inner try/catch that
    // detaches every sub-resource (mirroring the order in
    // `deleteUser()`) before issuing `DeleteUserCommand` and
    // re-throwing the original error; an adopted user skips this cleanup
    // (see the catch).
    try {
      // Set permissions boundary if specified
      const permissionsBoundary = properties['PermissionsBoundary'] as string | undefined;
      if (permissionsBoundary) {
        await this.iamClient.send(
          new PutUserPermissionsBoundaryCommand({
            UserName: userName,
            PermissionsBoundary: permissionsBoundary,
          })
        );
        log.debug(`Set permissions boundary on user ${v(userName)}`);
      }

      // Create login profile if specified
      const loginProfile = properties['LoginProfile'] as
        | { Password: string; PasswordResetRequired?: boolean }
        | undefined;
      if (loginProfile) {
        const profile = {
          UserName: userName,
          Password: loginProfile.Password,
          PasswordResetRequired: loginProfile.PasswordResetRequired ?? false,
        };
        try {
          await this.iamClient.send(new CreateLoginProfileCommand(profile));
          log.debug(`Created login profile for user ${v(userName)}`);
        } catch (profileError) {
          // go-to-k/cdkd#5660: `CreateLoginProfile` is the one wiring call that
          // refuses a repeat. An adopted user's profile is set to the declared
          // one rather than taken on trust, so success never rests on a
          // password nobody confirmed.
          if (!adopted || !isEntityAlreadyExists(profileError)) throw profileError;
          try {
            await this.iamClient.send(new UpdateLoginProfileCommand(profile));
          } catch (updateError) {
            if ((updateError as { name?: unknown } | null)?.name !== PROFILE_SETTLING_ERROR) {
              throw updateError;
            }
            // Temporary, but no retry classifier knows this error, so it is
            // restated in the words one does: the next replay updates again.
            // Thrown as text of ours, carrying no AWS wording and no password.
            throw new Error(LOGIN_PROFILE_SETTLING_MESSAGE, { cause: updateError });
          }
          log.debug(`Updated login profile for user ${v(userName)}`);
        }
      }

      // Attach managed policies if specified
      const managedPolicyArns = properties['ManagedPolicyArns'] as string[] | undefined;
      if (managedPolicyArns && Array.isArray(managedPolicyArns)) {
        for (const policyArn of managedPolicyArns) {
          await this.iamClient.send(
            new AttachUserPolicyCommand({
              UserName: userName,
              PolicyArn: policyArn,
            })
          );
          log.debug(`Attached managed policy ${v(policyArn)} to user ${v(userName)}`);
        }
      }

      // Add user to groups if specified
      const userGroups = groups.lists.Groups;
      if (userGroups) {
        for (const groupName of userGroups) {
          await this.iamClient.send(
            new AddUserToGroupCommand({
              UserName: userName,
              GroupName: groupName,
            })
          );
          log.debug(`Added user ${v(userName)} to group ${v(groupName)}`);
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
            new PutUserPolicyCommand({
              UserName: userName,
              PolicyName: policy.PolicyName,
              PolicyDocument: policyDoc,
            })
          );
          log.debug(`Added inline policy ${v(policy.PolicyName)} to user ${v(userName)}`);
        }
      }
    } catch (innerError) {
      // go-to-k/cdkd#5660: an adopted user is not stripped or deleted, see
      // `iamEntityLeftByThisCreate`.
      if (!adopted) {
        try {
          await this.removeUserFromAllGroups(userName, log);
          await this.detachAllUserPolicies(userName, log);
          await this.deleteAllUserInlinePolicies(userName, log);
          try {
            await this.iamClient.send(new DeleteLoginProfileCommand({ UserName: userName }));
          } catch (err) {
            if (!(err instanceof NoSuchEntityException)) throw err;
          }
          try {
            await this.iamClient.send(
              new DeleteUserPermissionsBoundaryCommand({ UserName: userName })
            );
          } catch (err) {
            if (!(err instanceof NoSuchEntityException)) throw err;
          }
          await this.iamClient.send(new DeleteUserCommand({ UserName: userName }));
          retractCreatedResource(logicalId, resourceType, userName);
          leftBehind = false;
          log.debug(
            `Cleaned up partially-created IAM user ${logicalId} (${v(userName)}) after wiring failure`
          );
        } catch (cleanupError) {
          // The name is `generateResourceNameWithFallback`'s output, whose
          // default `allowedPattern` rewrites everything outside `[A-Za-z0-9-]`
          // (issue #3136), so it renders BARE -- but it can still BE a resolved
          // secret, so every command goes through `pasteableAwsCommand` with the
          // masker (issue #2177): a masked name is WITHHELD rather than printed
          // as `***`, which would act on a different principal. Pinned by this
          // type's partial-create cleanup test.
          const aws = pasteableAwsCommand(log.mask);
          const cleanupHead = `Failed to clean up partially-created IAM user ${logicalId} (${v(userName)}): `;
          log.warn(
            `${cleanupHead}${this.cleanupFailureText(cleanupHead, cleanupError, log)} Manual deletion may be required before the next deploy: remove from groups, detach managed policies, delete inline policies, delete login profile (${aws`aws iam delete-login-profile --user-name ${userName}`.render()}), remove permissions boundary (${aws`aws iam delete-user-permissions-boundary --user-name ${userName}`.render()}), then ${aws`aws iam delete-user --user-name ${userName}`.render()}`
          );
        }
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    log.debug(`Successfully created IAM user ${logicalId}: ${v(userName)}`);

    return {
      physicalId: userName,
      attributes: {
        Arn: user?.Arn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create IAM user ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          userName,
          cause
        )
    );
    // With its UserId (go-to-k/cdkd#4606), which a later settle compares
    // before deleting the user by name.
    if (leftBehind) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, userName, createdUserIdentity);
    }
    throw thrown;
  }
}
