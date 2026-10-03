import {
  IAMClient,
  CreateUserCommand,
  DeleteUserCommand,
  GetUserCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupCommand,
  AttachGroupPolicyCommand,
  DetachGroupPolicyCommand,
  ListAttachedGroupPoliciesCommand,
  AttachUserPolicyCommand,
  DetachUserPolicyCommand,
  ListAttachedUserPoliciesCommand,
  PutUserPolicyCommand,
  DeleteUserPolicyCommand,
  ListUserPoliciesCommand,
  GetUserPolicyCommand,
  PutGroupPolicyCommand,
  DeleteGroupPolicyCommand,
  ListGroupPoliciesCommand,
  GetGroupPolicyCommand,
  CreateLoginProfileCommand,
  UpdateLoginProfileCommand,
  AddUserToGroupCommand,
  RemoveUserFromGroupCommand,
  ListGroupsForUserCommand,
  DeleteLoginProfileCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
  NoSuchEntityException,
  TagUserCommand,
  UntagUserCommand,
  PutUserPermissionsBoundaryCommand,
  DeleteUserPermissionsBoundaryCommand,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { definedAttributes } from '../attribute-map.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { wrapMaskedAwsError } from '../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceNameWithFallback } from '../resource-name.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import { collectInlinePolicyNamesManagedBySiblings } from './iam-role-provider.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import { markAuxiliaryFailure } from '../auxiliary-failure.js';
import {
  onlySecretDerived,
  readPrincipalLists,
  recordedPrincipalsRepair,
  SECRET_DERIVED_READ_LIVE,
} from '../iam-policy-targets.js';
import {
  isResolvableSecretPrincipalList,
  resolveSecretDerivedPrincipals,
} from '../secret-principal-resolution.js';
import { safeMsg } from '../../utils/display-safe.js';
import { injectiveKey } from '../../state/record-keys.js';
import type {
  CreateContext,
  UpdateContext,
  InlinePolicyClaimed,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceDeleteResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../redacted-delete-address.js';

/**
 * The short `ResourceDeleteResult.reason` the no-properties
 * `AWS::IAM::UserToGroupAddition` DELETE arm reports (issue
 * [#1770](https://github.com/go-to-k/cdkd/issues/1770)).
 *
 * Rendered inline on the destroy status line, so it is the SHORT form; the full
 * remediation sentence goes out as the `logger.warn` beside it. It names the
 * MEMBERSHIP rather than the resource because that is what survives — the
 * resource itself is metadata, the users staying in the group is the residue.
 */
export const MEMBERSHIP_NO_PROPERTIES_SKIP_REASON =
  'no properties in state — group membership not removed';

/**
 * Sibling of {@link MEMBERSHIP_NO_PROPERTIES_SKIP_REASON} for the arm where the
 * record has properties but is missing `GroupName` or `Users` — both REQUIRED
 * by the CloudFormation schema, so their absence is corruption, not an
 * empty-but-valid membership list.
 */
export const MEMBERSHIP_MISSING_FIELDS_SKIP_REASON =
  'GroupName/Users missing from state — membership not removed';

/**
 * Sibling of {@link MEMBERSHIP_MISSING_FIELDS_SKIP_REASON} for a record whose
 * `Users` is present but not a list of IAM user names (go-to-k/cdkd#3888). A
 * cast iterated a string by character, removing one-letter users from the
 * group and never the recorded one; it is refused before any call.
 */
export const MEMBERSHIP_MALFORMED_USERS_SKIP_REASON =
  'malformed Users in state — membership not removed';

/**
 * Sibling of {@link MEMBERSHIP_MALFORMED_USERS_SKIP_REASON} for a destroy that
 * resolved a secret-derived `Users` and found a user the CURRENT value names
 * outside the group (go-to-k/cdkd#4150). The value may have rotated, so a user
 * only the OLD value named may still be a member: the record is kept rather
 * than read as deleted, which would drop the last trace of that membership.
 */
export const MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON =
  // Plain prose (no `'`, no `;`): `deleteSkippedMessage` shows only such a
  // reason (go-to-k/cdkd#4265).
  'the current value of the secret names a user outside the group — the value may have rotated';

/**
 * What an `AWS::IAM::UserToGroupAddition` update or delete says about a
 * secret-derived recorded `Users`: it has no live source (IAM lists a group's
 * members, not which of them this resource added), so cdkd cannot diff it, and
 * editing state is not the repair. `cdkd orphan` drops just this record, and
 * the next deploy re-creates it from the template (`AddUserToGroup` is
 * idempotent). An unchanged reference never reaches this: the engine drops
 * it from the previous side (go-to-k/cdkd#4064).
 */
const MEMBERSHIP_SECRET_DERIVED_REPAIR =
  'cdkd cannot diff it, so make the membership change by hand, then drop this record with ' +
  "'cdkd orphan <constructPath>' so the next deploy re-creates it from the template. A " +
  'later update proceeds only while the template spells the same reference and GroupName, so ' +
  'a changed reference, another group or a mask is refused this way again';

/**
 * Read a desired and a recorded principal list, refusing either when it is not
 * a list of IAM names, before any write (go-to-k/cdkd#3888). The previous side
 * is the state record, and a rollback revert or `drift --revert` replays
 * `update()` with a recorded bag as the desired side. With `readLive`, a
 * recorded list cdkd redacted (a dynamic reference or its mask) is read from
 * IAM instead when the desired side is well-formed (go-to-k/cdkd#3906) — ADD-
 * only: IAM's list also holds memberships made elsewhere (a
 * `UserToGroupAddition`, another stack, by hand), so the returned previous side
 * is IAM's list narrowed to the desired names, and nothing is removed on its
 * evidence. `unmatchedKinds` names the kinds read that way where IAM holds a
 * name the desired side does not, for the caller's warning.
 */
async function readPrincipalSides<K extends string>(opts: {
  desired: Record<K, unknown>;
  recorded: Record<K, unknown>;
  subject: string;
  nothingDone: string;
  names: string;
  secretDerivedRepair: string;
  readLive?: () => Promise<Record<K, string[]>>;
  resourceType: string;
  logicalId: string;
  physicalId: string;
}): Promise<{
  next: Record<K, string[] | undefined>;
  prev: Record<K, string[] | undefined>;
  unmatchedKinds: K[];
}> {
  const { subject, nothingDone, names, resourceType, logicalId, physicalId } = opts;
  const next = readPrincipalLists(opts.desired);
  let prev = readPrincipalLists(opts.recorded);
  const unmatchedKinds: K[] = [];
  if (opts.readLive && !('malformed' in next) && onlySecretDerived(prev)) {
    const kinds = prev.malformed.join(' / ');
    let live: Record<K, string[]>;
    try {
      live = await opts.readLive();
    } catch (error) {
      throw new ProvisioningError(
        `the recorded ${kinds} of ${subject} ${logicalId} is secret-derived and could not be ` +
          `read from IAM — ${nothingDone}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
    const lists = { ...prev.lists };
    for (const kind of prev.malformed) {
      const desired = next.lists[kind] ?? [];
      lists[kind] = live[kind].filter((name) => desired.includes(name));
      if (live[kind].some((name) => !desired.includes(name))) unmatchedKinds.push(kind);
    }
    prev = { lists };
  }
  if ('malformed' in next || 'malformed' in prev) {
    const which = [
      ...('malformed' in next ? next.malformed.map((k) => `desired ${k}`) : []),
      ...('malformed' in prev ? prev.malformed.map((k) => `recorded ${k}`) : []),
    ];
    throw new ProvisioningError(
      `${which.join(' / ')} of ${subject} ${logicalId} is not a list of ${names} — ` +
        nothingDone +
        ('malformed' in prev
          ? `: ${recordedPrincipalsRepair(
              prev.malformed,
              prev.secretDerived,
              names,
              opts.secretDerivedRepair
            )}`
          : ''),
      resourceType,
      logicalId,
      physicalId
    );
  }
  return { next: next.lists, prev: prev.lists, unmatchedKinds };
}

/**
 * The deploy-side caveat both `UserToGroupAddition` skip warnings carry (issue
 * [#1762](https://github.com/go-to-k/cdkd/issues/1762)).
 *
 * "Repair state.json and re-run" is only true on DESTROY, where the skip KEEPS
 * the record. The same arms are ALSO reached from `deploy-engine.ts` and
 * `rollback-executor.ts`, which discard the delete result and DROP the record —
 * there the id is gone, so re-running cannot help and the memberships have to
 * be removed by hand. Mirrors the caveat `compositeIdFormatMessage` already
 * carries for the composite-id family.
 */
const DEPLOY_SKIP_CAVEAT =
  `NOTE this arm is ALSO reached from cdkd deploy. Since issue 1762 the DELETE of a resource ` +
  `removed from the template behaves like destroy — the record is KEPT and the next deploy ` +
  `re-attempts it — but a REPLACEMENT / rollback delete FAILS the resource instead ` +
  `(https://github.com/go-to-k/cdkd/issues/1762), leaving the old one untracked; there, remove the memberships by hand.`;

/**
 * `generateResourceNameWithFallback`'s `maxLength` for a User / Group name:
 * ONE spelling, shared by the create arms and {@link derivedNamePairs}, so the
 * name a needle is built from cannot drift from the name the create sends.
 */
const USER_NAME_MAX_LENGTH = 64;
const GROUP_NAME_MAX_LENGTH = 128;

/**
 * `[template value, physical name derived from it]` for the types whose name
 * `generateResourceNameWithFallback` rewrites (issue #2177), with the SAME
 * options `createUser` / `createGroup` use (the constants above).
 * `UserToGroupAddition` names nothing.
 */
function derivedNamePairs(
  resourceType: string,
  logicalId: string,
  properties: Record<string, unknown>
): Array<readonly [unknown, string]> {
  const spec =
    resourceType === 'AWS::IAM::User'
      ? { key: 'UserName', maxLength: USER_NAME_MAX_LENGTH }
      : resourceType === 'AWS::IAM::Group'
        ? { key: 'GroupName', maxLength: GROUP_NAME_MAX_LENGTH }
        : undefined;
  if (!spec) return [];
  const raw = properties[spec.key];
  // Only a string can be a recorded secret, and deriving from anything else
  // could throw inside the generator on a path (`update()`) that never derived
  // a name before.
  if (typeof raw !== 'string') return [];
  return [[raw, generateResourceNameWithFallback(raw, logicalId, { maxLength: spec.maxLength })]];
}

/**
 * AWS IAM User / Group / UserToGroupAddition Provider
 *
 * Implements resource provisioning for:
 * - AWS::IAM::User
 * - AWS::IAM::Group
 * - AWS::IAM::UserToGroupAddition
 *
 * Uses multi-resource-type dispatch pattern.
 */
export class IAMUserGroupProvider implements ResourceProvider {
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMUserGroupProvider');

  /**
   * A failure wrap quoting the caught error's text through the operation's
   * masker (issue #2177), stamped when the mask changed it so the retry
   * classifiers read the unmasked `cause` chain (`wrapMaskedAwsError`, issue
   * #4244). A method, so `gen-update-wrap-coverage` sees the catch that throws
   * it as a wrap.
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
      'AWS::IAM::User',
      new Set([
        'UserName',
        'Path',
        'Tags',
        'LoginProfile',
        'ManagedPolicyArns',
        'Groups',
        'Policies',
        'PermissionsBoundary',
      ]),
    ],
    ['AWS::IAM::Group', new Set(['GroupName', 'Path', 'ManagedPolicyArns', 'Policies'])],
    ['AWS::IAM::UserToGroupAddition', new Set(['GroupName', 'Users'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    // Issue #2177: ONE masked sink per operation (the `ssm-parameter-provider.ts`
    // shape), built here and handed to whichever type's arm runs. Every
    // bag-derived value is masked RAW as well -- user / group names, attached
    // ARNs, group memberships and inline policy names all come out of the
    // resolved `properties` bag. Absent context means identity.
    //
    // A User / Group name is REWRITTEN from the template value (stack prefix,
    // charset folding, truncation), so the masker cannot recognise it by
    // itself: it is added as a needle when the value it came from is a secret.
    const log = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      derivedNamePairs(resourceType, logicalId, properties)
    );
    switch (resourceType) {
      case 'AWS::IAM::User':
        return this.createUser(logicalId, resourceType, properties, log);
      case 'AWS::IAM::Group':
        return this.createGroup(logicalId, resourceType, properties, log);
      case 'AWS::IAM::UserToGroupAddition':
        return this.createUserToGroupAddition(logicalId, resourceType, properties, log);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
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
    // Issue #2177 -- see `create()`. The recorded name is also paired with the
    // PREVIOUS value it was derived from.
    const log = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      [
        ...derivedNamePairs(resourceType, logicalId, properties),
        ...derivedNamePairs(resourceType, logicalId, previousProperties).map(
          ([raw]) => [raw, physicalId] as const
        ),
      ]
    );
    switch (resourceType) {
      case 'AWS::IAM::User':
        return this.updateUser(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          log,
          context?.inlinePolicyClaimed
        );
      case 'AWS::IAM::Group':
        return this.updateGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          log,
          context?.inlinePolicyClaimed
        );
      case 'AWS::IAM::UserToGroupAddition':
        return this.updateUserToGroupAddition(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          log
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    switch (resourceType) {
      case 'AWS::IAM::User':
        return this.deleteUser(logicalId, physicalId, resourceType, context);
      case 'AWS::IAM::Group':
        return this.deleteGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::IAM::UserToGroupAddition':
        return this.deleteUserToGroupAddition(
          logicalId,
          physicalId,
          resourceType,
          properties,
          context
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::IAM::User ──────────────────────────────────────────────

  private async createUser(
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

      const response = await this.iamClient.send(new CreateUserCommand(createParams));

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
      // re-throwing the original error.
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
          await this.iamClient.send(
            new CreateLoginProfileCommand({
              UserName: userName,
              Password: loginProfile.Password,
              PasswordResetRequired: loginProfile.PasswordResetRequired ?? false,
            })
          );
          log.debug(`Created login profile for user ${v(userName)}`);
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
          log.warn(
            `Failed to clean up partially-created IAM user ${logicalId} (${v(userName)}): ${v(describeAwsFailure(cleanupError).detail)}. Manual deletion may be required before the next deploy: remove from groups, detach managed policies, delete inline policies, delete login profile (${aws`aws iam delete-login-profile --user-name ${userName}`.render()}), remove permissions boundary (${aws`aws iam delete-user-permissions-boundary --user-name ${userName}`.render()}), then ${aws`aws iam delete-user --user-name ${userName}`.render()}`
          );
        }
        // The resource itself was created: an "already exists" from its wiring
        // is an auxiliary object's, not this resource's name collision (#3826).
        throw markAuxiliaryFailure(innerError, logicalId);
      }

      log.debug(`Successfully created IAM user ${logicalId}: ${v(userName)}`);

      return {
        physicalId: userName,
        attributes: {
          Arn: response.User?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
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
    }
  }

  private async updateUser(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    claimed: InlinePolicyClaimed | undefined
  ): Promise<ResourceUpdateResult> {
    const { value: v } = log;
    log.debug(`Updating IAM user ${logicalId}: ${v(physicalId)}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    // `Groups` on BOTH sides before any call (go-to-k/cdkd#3888): a string was
    // walked by character, removing the user from one-letter groups.
    const groups = await readPrincipalSides({
      desired: { Groups: properties['Groups'] },
      recorded: { Groups: previousProperties['Groups'] },
      subject: 'IAM user',
      nothingDone: 'no group membership, tag, policy or login profile was changed',
      names: 'group names',
      secretDerivedRepair: SECRET_DERIVED_READ_LIVE,
      // `deleteUser` reads the same list (`removeUserFromAllGroups`).
      readLive: async () => {
        try {
          return { Groups: await this.readLiveGroups(physicalId) };
        } catch (error) {
          throw new ProvisioningError(
            `ListGroupsForUser failed for IAM user ${logicalId}`,
            resourceType,
            logicalId,
            physicalId,
            error instanceof Error ? error : undefined
          );
        }
      },
      resourceType,
      logicalId,
      physicalId,
    });
    if (groups.unmatchedKinds.length > 0) {
      log.warn(
        `The recorded Groups of IAM user ${logicalId} is secret-derived, and IAM lists ` +
          `memberships the template does not name: cdkd removes the user from none of them, ` +
          `since IAM's list includes memberships made elsewhere. Remove the user by hand from ` +
          `any that this list used to name.`
      );
    }

    try {
      // Apply tag diff. IAM User uses TagUser/UntagUser keyed by UserName.
      await this.applyUserTagDiff(
        physicalId,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags'],
        log
      );

      // Update permissions boundary
      const newPermBoundary = properties['PermissionsBoundary'] as string | undefined;
      const oldPermBoundary = previousProperties['PermissionsBoundary'] as string | undefined;
      if (newPermBoundary !== oldPermBoundary) {
        if (newPermBoundary) {
          await this.iamClient.send(
            new PutUserPermissionsBoundaryCommand({
              UserName: physicalId,
              PermissionsBoundary: newPermBoundary,
            })
          );
          log.debug(`Updated permissions boundary on user ${v(physicalId)}`);
        } else if (oldPermBoundary) {
          await this.iamClient.send(
            new DeleteUserPermissionsBoundaryCommand({ UserName: physicalId })
          );
          log.debug(`Removed permissions boundary from user ${v(physicalId)}`);
        }
      }

      // Update login profile
      const newLoginProfile = properties['LoginProfile'] as
        | { Password: string; PasswordResetRequired?: boolean }
        | undefined;
      const oldLoginProfile = previousProperties['LoginProfile'] as
        | { Password: string; PasswordResetRequired?: boolean }
        | undefined;
      if (newLoginProfile && !oldLoginProfile) {
        await this.iamClient.send(
          new CreateLoginProfileCommand({
            UserName: physicalId,
            Password: newLoginProfile.Password,
            PasswordResetRequired: newLoginProfile.PasswordResetRequired ?? false,
          })
        );
        log.debug(`Created login profile for user ${v(physicalId)}`);
      } else if (
        newLoginProfile &&
        oldLoginProfile &&
        // Only on a CHANGE, as CloudFormation does (go-to-k/cdkd#4461): an
        // update reached for another reason -- a tag, or re-adding the user to
        // a group the deploy re-created -- must not reset the password and
        // re-force a reset at the next sign-in. A secret-derived password is
        // recorded as its reference, so it still compares unequal and is sent.
        (newLoginProfile.Password !== oldLoginProfile.Password ||
          (newLoginProfile.PasswordResetRequired ?? false) !==
            (oldLoginProfile.PasswordResetRequired ?? false))
      ) {
        await this.iamClient.send(
          new UpdateLoginProfileCommand({
            UserName: physicalId,
            Password: newLoginProfile.Password,
            PasswordResetRequired: newLoginProfile.PasswordResetRequired ?? false,
          })
        );
        log.debug(`Updated login profile for user ${v(physicalId)}`);
      } else if (!newLoginProfile && oldLoginProfile) {
        try {
          await this.iamClient.send(new DeleteLoginProfileCommand({ UserName: physicalId }));
          log.debug(`Deleted login profile for user ${v(physicalId)}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }

      // Update managed policies
      await this.updateUserManagedPolicies(
        physicalId,
        properties['ManagedPolicyArns'] as string[] | undefined,
        previousProperties['ManagedPolicyArns'] as string[] | undefined,
        log
      );

      // Update groups
      await this.updateUserGroups(physicalId, groups.next.Groups, groups.prev.Groups, log);

      // Update inline policies
      await this.updateUserInlinePolicies(
        physicalId,
        properties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined,
        previousProperties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined,
        log,
        claimed
      );

      // Get updated user info
      const getUserResponse = await this.iamClient.send(
        new GetUserCommand({ UserName: physicalId })
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: getUserResponse.User?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update IAM user ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async deleteUser(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting IAM user ${logicalId}: ${physicalId}`);

    try {
      // Check if user exists
      try {
        await this.iamClient.send(new GetUserCommand({ UserName: physicalId }));
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
          this.logger.debug(`User ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Step 1: Remove from all groups
      await this.removeUserFromAllGroups(physicalId, this.unmaskedDeleteSinks());

      // Step 2: Detach all managed policies
      await this.detachAllUserPolicies(physicalId, this.unmaskedDeleteSinks());

      // Step 3: Delete all inline policies
      await this.deleteAllUserInlinePolicies(physicalId, this.unmaskedDeleteSinks());

      // Step 4: Delete login profile if exists
      try {
        await this.iamClient.send(new DeleteLoginProfileCommand({ UserName: physicalId }));
        this.logger.debug(`Deleted login profile for user ${physicalId}`);
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }

      // Step 5: Delete all access keys
      await this.deleteAllAccessKeys(physicalId);

      // Step 6: Delete permissions boundary if exists
      try {
        await this.iamClient.send(
          new DeleteUserPermissionsBoundaryCommand({ UserName: physicalId })
        );
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }

      // Step 7: Delete the user
      await this.iamClient.send(new DeleteUserCommand({ UserName: physicalId }));

      this.logger.debug(`Successfully deleted IAM user ${logicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM user ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /** Every group the user belongs to, read from IAM (paginated). */
  private async readLiveGroups(userName: string): Promise<string[]> {
    const groups: string[] = [];
    let marker: string | undefined;
    do {
      const resp = await this.iamClient.send(
        new ListGroupsForUserCommand({ UserName: userName, ...(marker && { Marker: marker }) })
      );
      for (const g of resp.Groups ?? []) if (g.GroupName) groups.push(g.GroupName);
      marker = resp.IsTruncated ? resp.Marker : undefined;
    } while (marker);
    return groups;
  }

  private async removeUserFromAllGroups(
    userName: string,
    // REQUIRED, so a create-path caller cannot silently fall back to an
    // unmasked sink; the delete path passes `unmaskedDeleteSinks()` (issue #2007).
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    try {
      const response = await this.iamClient.send(
        new ListGroupsForUserCommand({ UserName: userName })
      );

      const groups = response.Groups || [];
      for (const group of groups) {
        if (group.GroupName) {
          try {
            await this.iamClient.send(
              new RemoveUserFromGroupCommand({
                UserName: userName,
                GroupName: group.GroupName,
              })
            );
            log.debug(`Removed user ${v(userName)} from group ${v(group.GroupName)}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async deleteAllAccessKeys(userName: string): Promise<void> {
    try {
      const response = await this.iamClient.send(new ListAccessKeysCommand({ UserName: userName }));

      const keys = response.AccessKeyMetadata || [];
      for (const key of keys) {
        if (key.AccessKeyId) {
          await this.iamClient.send(
            new DeleteAccessKeyCommand({
              UserName: userName,
              AccessKeyId: key.AccessKeyId,
            })
          );
          this.logger.debug(`Deleted access key ${key.AccessKeyId} for user ${userName}`);
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async detachAllUserPolicies(
    userName: string,
    // REQUIRED, so a create-path caller cannot silently fall back to an
    // unmasked sink; the delete path passes `unmaskedDeleteSinks()` (issue #2007).
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    try {
      const response = await this.iamClient.send(
        new ListAttachedUserPoliciesCommand({ UserName: userName })
      );

      const policies = response.AttachedPolicies || [];
      for (const policy of policies) {
        if (policy.PolicyArn) {
          try {
            await this.iamClient.send(
              new DetachUserPolicyCommand({
                UserName: userName,
                PolicyArn: policy.PolicyArn,
              })
            );
            log.debug(`Detached managed policy ${v(policy.PolicyArn)} from user ${v(userName)}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async deleteAllUserInlinePolicies(
    userName: string,
    // REQUIRED, so a create-path caller cannot silently fall back to an
    // unmasked sink; the delete path passes `unmaskedDeleteSinks()` (issue #2007).
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    try {
      const response = await this.iamClient.send(
        new ListUserPoliciesCommand({ UserName: userName })
      );

      const policyNames = response.PolicyNames || [];
      for (const policyName of policyNames) {
        try {
          await this.iamClient.send(
            new DeleteUserPolicyCommand({
              UserName: userName,
              PolicyName: policyName,
            })
          );
          log.debug(`Deleted inline policy ${v(policyName)} from user ${v(userName)}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via IAM's
   * `TagUser` / `UntagUser` APIs. Both sides are read through `planTagDiff`
   * (go-to-k/cdkd#3994): an unreadable record untags nothing.
   */
  private async applyUserTagDiff(
    userName: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      log.warn(tagWarning);
    }
    const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
    const tagsToRemove = plan.remove;

    if (tagsToRemove.length > 0) {
      await this.iamClient.send(
        new UntagUserCommand({ UserName: userName, TagKeys: tagsToRemove })
      );
      log.debug(`Removed ${tagsToRemove.length} tag(s) from IAM user ${v(userName)}`);
    }
    if (tagsToAdd.length > 0) {
      await this.iamClient.send(new TagUserCommand({ UserName: userName, Tags: tagsToAdd }));
      log.debug(`Added/updated ${tagsToAdd.length} tag(s) on IAM user ${v(userName)}`);
    }
  }

  private async updateUserManagedPolicies(
    userName: string,
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
          new AttachUserPolicyCommand({
            UserName: userName,
            PolicyArn: policyArn,
          })
        );
        log.debug(`Attached managed policy ${v(policyArn)} to user ${v(userName)}`);
      }
    }

    // Detach removed policies
    for (const policyArn of oldSet) {
      if (!newSet.has(policyArn)) {
        try {
          await this.iamClient.send(
            new DetachUserPolicyCommand({
              UserName: userName,
              PolicyArn: policyArn,
            })
          );
          log.debug(`Detached managed policy ${v(policyArn)} from user ${v(userName)}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    }
  }

  private async updateUserGroups(
    userName: string,
    newGroups: string[] | undefined,
    oldGroups: string[] | undefined,
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    const newSet = new Set(newGroups || []);
    const oldSet = new Set(oldGroups || []);

    // Add to new groups
    for (const groupName of newSet) {
      if (!oldSet.has(groupName)) {
        await this.iamClient.send(
          new AddUserToGroupCommand({
            UserName: userName,
            GroupName: groupName,
          })
        );
        log.debug(`Added user ${v(userName)} to group ${v(groupName)}`);
      }
    }

    // Remove from old groups
    for (const groupName of oldSet) {
      if (!newSet.has(groupName)) {
        try {
          await this.iamClient.send(
            new RemoveUserFromGroupCommand({
              UserName: userName,
              GroupName: groupName,
            })
          );
          log.debug(`Removed user ${v(userName)} from group ${v(groupName)}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    }
  }

  private async updateUserInlinePolicies(
    userName: string,
    newPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    oldPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    log: MaskedLogSinks,
    claimed: InlinePolicyClaimed | undefined
  ): Promise<void> {
    const { value: v } = log;
    const newMap = new Map((newPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));
    const oldMap = new Map((oldPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));

    // Add or update policies
    for (const [policyName, policyDoc] of newMap) {
      const policyDocument = typeof policyDoc === 'string' ? policyDoc : JSON.stringify(policyDoc);
      await this.iamClient.send(
        new PutUserPolicyCommand({
          UserName: userName,
          PolicyName: policyName,
          PolicyDocument: policyDocument,
        })
      );
      log.debug(`Updated inline policy ${v(policyName)} on user ${v(userName)}`);
    }

    // Delete removed policies
    // go-to-k/cdkd#4225: a name another resource has ALREADY written onto
    // this user in the same run is not removed. Set by a rollback revert,
    // where the policy that took this name over may have been put back
    // before this principal's own revert drops it.
    for (const policyName of oldMap.keys()) {
      if (!newMap.has(policyName)) {
        if (claimed?.('user', userName, policyName) === true) {
          log.debug(
            `Kept inline policy ${v(policyName)} on user ${v(userName)}: another resource of this deploy or rollback wrote it`
          );
          continue;
        }
        try {
          await this.iamClient.send(
            new DeleteUserPolicyCommand({
              UserName: userName,
              PolicyName: policyName,
            })
          );
          log.debug(`Deleted inline policy ${v(policyName)} from user ${v(userName)}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    }
  }

  // ─── AWS::IAM::Group ─────────────────────────────────────────────

  private async createGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    const { value: v } = log;
    log.debug(`Creating IAM group ${logicalId}`);

    const groupName = generateResourceNameWithFallback(
      properties['GroupName'] as string | undefined,
      logicalId,
      { maxLength: GROUP_NAME_MAX_LENGTH }
    );

    try {
      const createParams: {
        GroupName: string;
        Path?: string;
      } = {
        GroupName: groupName,
      };

      if (properties['Path']) {
        createParams.Path = properties['Path'] as string;
      }

      const response = await this.iamClient.send(new CreateGroupCommand(createParams));

      // CreateGroupCommand has succeeded — AWS has now committed the
      // Group. Every subsequent call wires sub-resources onto it
      // (managed-policy attachments / inline policies); if any fail, the
      // group exists on AWS but cdkd state will NOT (the throw aborts
      // before the success-return). The next redeploy would then re-try
      // CREATE and AWS would reject with `EntityAlreadyExists: Group
      // with name <X> already exists`. Wrap the wiring in an inner
      // try/catch that detaches managed policies + deletes inline
      // policies + DeleteGroupCommand before re-throwing the original
      // error. The cleanup mirrors the order in `deleteGroup()` (but
      // skips `removeAllUsersFromGroup` — a freshly-created group has
      // no users).
      try {
        // Attach managed policies if specified
        const managedPolicyArns = properties['ManagedPolicyArns'] as string[] | undefined;
        if (managedPolicyArns && Array.isArray(managedPolicyArns)) {
          for (const policyArn of managedPolicyArns) {
            await this.iamClient.send(
              new AttachGroupPolicyCommand({
                GroupName: groupName,
                PolicyArn: policyArn,
              })
            );
            log.debug(`Attached managed policy ${v(policyArn)} to group ${v(groupName)}`);
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
              new PutGroupPolicyCommand({
                GroupName: groupName,
                PolicyName: policy.PolicyName,
                PolicyDocument: policyDoc,
              })
            );
            log.debug(`Added inline policy ${v(policy.PolicyName)} to group ${v(groupName)}`);
          }
        }
      } catch (innerError) {
        try {
          await this.detachAllGroupPolicies(groupName, log);
          await this.deleteAllGroupInlinePolicies(groupName, log);
          await this.iamClient.send(new DeleteGroupCommand({ GroupName: groupName }));
          log.debug(
            `Cleaned up partially-created IAM group ${logicalId} (${v(groupName)}) after wiring failure`
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
          log.warn(
            `Failed to clean up partially-created IAM group ${logicalId} (${v(groupName)}): ${v(describeAwsFailure(cleanupError).detail)}. Manual deletion may be required before the next deploy: detach managed policies + delete inline policies, then ${aws`aws iam delete-group --group-name ${groupName}`.render()}`
          );
        }
        // The resource itself was created: an "already exists" from its wiring
        // is an auxiliary object's, not this resource's name collision (#3826).
        throw markAuxiliaryFailure(innerError, logicalId);
      }

      log.debug(`Successfully created IAM group ${logicalId}: ${v(groupName)}`);

      return {
        physicalId: groupName,
        attributes: {
          Arn: response.Group?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create IAM group ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            groupName,
            cause
          )
      );
    }
  }

  private async updateGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    claimed: InlinePolicyClaimed | undefined
  ): Promise<ResourceUpdateResult> {
    const { value: v } = log;
    log.debug(`Updating IAM group ${logicalId}: ${v(physicalId)}`);

    try {
      // Update managed policies
      await this.updateGroupManagedPolicies(
        physicalId,
        properties['ManagedPolicyArns'] as string[] | undefined,
        previousProperties['ManagedPolicyArns'] as string[] | undefined,
        log
      );

      // Update inline policies
      await this.updateGroupInlinePolicies(
        physicalId,
        properties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined,
        previousProperties['Policies'] as
          | Array<{ PolicyName: string; PolicyDocument: unknown }>
          | undefined,
        log,
        claimed
      );

      // Get updated group info
      const getGroupResponse = await this.iamClient.send(
        new GetGroupCommand({ GroupName: physicalId })
      );

      log.debug(`Successfully updated IAM group ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: getGroupResponse.Group?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update IAM group ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async deleteGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting IAM group ${logicalId}: ${physicalId}`);

    try {
      // Step 1: Detach all managed policies
      await this.detachAllGroupPolicies(physicalId, this.unmaskedDeleteSinks());

      // Step 2: Delete all inline policies
      await this.deleteAllGroupInlinePolicies(physicalId, this.unmaskedDeleteSinks());

      // Step 3: Remove all users from group
      await this.removeAllUsersFromGroup(physicalId);

      // Step 4: Delete the group
      await this.iamClient.send(new DeleteGroupCommand({ GroupName: physicalId }));

      this.logger.debug(`Successfully deleted IAM group ${logicalId}`);
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
        this.logger.debug(`Group ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async detachAllGroupPolicies(
    groupName: string,
    // REQUIRED, so a create-path caller cannot silently fall back to an
    // unmasked sink; the delete path passes `unmaskedDeleteSinks()` (issue #2007).
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    try {
      const response = await this.iamClient.send(
        new ListAttachedGroupPoliciesCommand({ GroupName: groupName })
      );

      const policies = response.AttachedPolicies || [];
      for (const policy of policies) {
        if (policy.PolicyArn) {
          try {
            await this.iamClient.send(
              new DetachGroupPolicyCommand({
                GroupName: groupName,
                PolicyArn: policy.PolicyArn,
              })
            );
            log.debug(`Detached managed policy ${v(policy.PolicyArn)} from group ${v(groupName)}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async removeAllUsersFromGroup(groupName: string): Promise<void> {
    try {
      const response = await this.iamClient.send(new GetGroupCommand({ GroupName: groupName }));

      const users = response.Users || [];
      for (const user of users) {
        if (user.UserName) {
          try {
            await this.iamClient.send(
              new RemoveUserFromGroupCommand({
                GroupName: groupName,
                UserName: user.UserName,
              })
            );
            this.logger.debug(`Removed user ${user.UserName} from group ${groupName}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async updateGroupManagedPolicies(
    groupName: string,
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
          new AttachGroupPolicyCommand({
            GroupName: groupName,
            PolicyArn: policyArn,
          })
        );
        log.debug(`Attached managed policy ${v(policyArn)} to group ${v(groupName)}`);
      }
    }

    // Detach removed policies
    for (const policyArn of oldSet) {
      if (!newSet.has(policyArn)) {
        await this.iamClient.send(
          new DetachGroupPolicyCommand({
            GroupName: groupName,
            PolicyArn: policyArn,
          })
        );
        log.debug(`Detached managed policy ${v(policyArn)} from group ${v(groupName)}`);
      }
    }
  }

  private async deleteAllGroupInlinePolicies(
    groupName: string,
    // REQUIRED, so a create-path caller cannot silently fall back to an
    // unmasked sink; the delete path passes `unmaskedDeleteSinks()` (issue #2007).
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    try {
      const response = await this.iamClient.send(
        new ListGroupPoliciesCommand({ GroupName: groupName })
      );

      const policyNames = response.PolicyNames || [];
      for (const policyName of policyNames) {
        try {
          await this.iamClient.send(
            new DeleteGroupPolicyCommand({
              GroupName: groupName,
              PolicyName: policyName,
            })
          );
          log.debug(`Deleted inline policy ${v(policyName)} from group ${v(groupName)}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        return;
      }
      throw error;
    }
  }

  private async updateGroupInlinePolicies(
    groupName: string,
    newPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    oldPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
    log: MaskedLogSinks,
    claimed: InlinePolicyClaimed | undefined
  ): Promise<void> {
    const { value: v } = log;
    const newMap = new Map((newPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));
    const oldMap = new Map((oldPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));

    // Add or update policies
    for (const [policyName, policyDoc] of newMap) {
      const policyDocument = typeof policyDoc === 'string' ? policyDoc : JSON.stringify(policyDoc);
      await this.iamClient.send(
        new PutGroupPolicyCommand({
          GroupName: groupName,
          PolicyName: policyName,
          PolicyDocument: policyDocument,
        })
      );
      log.debug(`Updated inline policy ${v(policyName)} on group ${v(groupName)}`);
    }

    // Delete removed policies
    // go-to-k/cdkd#4225: a name another resource has ALREADY written onto
    // this group in the same run is not removed. Set by a rollback revert,
    // where the policy that took this name over may have been put back
    // before this principal's own revert drops it.
    for (const policyName of oldMap.keys()) {
      if (!newMap.has(policyName)) {
        if (claimed?.('group', groupName, policyName) === true) {
          log.debug(
            `Kept inline policy ${v(policyName)} on group ${v(groupName)}: another resource of this deploy or rollback wrote it`
          );
          continue;
        }
        try {
          await this.iamClient.send(
            new DeleteGroupPolicyCommand({
              GroupName: groupName,
              PolicyName: policyName,
            })
          );
          log.debug(`Deleted inline policy ${v(policyName)} from group ${v(groupName)}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    }
  }

  // ─── AWS::IAM::UserToGroupAddition ────────────────────────────────

  private async createUserToGroupAddition(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    const { value: v } = log;
    log.debug(`Creating IAM UserToGroupAddition ${logicalId}`);

    const groupName = properties['GroupName'] as string;
    const read = readPrincipalLists({ Users: properties['Users'] });
    if ('malformed' in read) {
      // Before any call (go-to-k/cdkd#3888).
      throw new ProvisioningError(
        `Users of IAM UserToGroupAddition ${logicalId} is not a list of IAM user names — no ` +
          `user was added to the group`,
        resourceType,
        logicalId
      );
    }
    const users = read.lists.Users;

    if (!groupName) {
      throw new ProvisioningError(
        `GroupName is required for ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!users || users.length === 0) {
      throw new ProvisioningError(`Users is required for ${logicalId}`, resourceType, logicalId);
    }

    try {
      for (const userName of users) {
        await this.iamClient.send(
          new AddUserToGroupCommand({
            GroupName: groupName,
            UserName: userName,
          })
        );
        log.debug(`Added user ${v(userName)} to group ${v(groupName)}`);
      }

      log.debug(`Successfully created IAM UserToGroupAddition ${logicalId}`);

      // Physical ID is the logical ID (no AWS-generated ID for this resource)
      return {
        physicalId: logicalId,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create IAM UserToGroupAddition ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
    }
  }

  private async updateUserToGroupAddition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    const { value: v } = log;
    log.debug(`Updating IAM UserToGroupAddition ${logicalId}`);

    const users = await readPrincipalSides({
      desired: { Users: properties['Users'] },
      recorded: { Users: previousProperties['Users'] },
      subject: 'IAM UserToGroupAddition',
      nothingDone: 'no user was added to or removed from a group',
      names: 'user names',
      secretDerivedRepair: MEMBERSHIP_SECRET_DERIVED_REPAIR,
      resourceType,
      logicalId,
      physicalId,
    });
    const groupName = properties['GroupName'] as string;
    const newUsers = new Set(users.next.Users ?? []);
    const oldGroupName = previousProperties['GroupName'] as string;
    const oldUsers = new Set(users.prev.Users ?? []);

    try {
      // If group changed, remove from old group and add to new group
      if (oldGroupName && oldGroupName !== groupName) {
        for (const userName of oldUsers) {
          try {
            await this.iamClient.send(
              new RemoveUserFromGroupCommand({
                GroupName: oldGroupName,
                UserName: userName,
              })
            );
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
        for (const userName of newUsers) {
          await this.iamClient.send(
            new AddUserToGroupCommand({
              GroupName: groupName,
              UserName: userName,
            })
          );
        }
      } else {
        // Same group: add new users, remove old users
        for (const userName of newUsers) {
          if (!oldUsers.has(userName)) {
            await this.iamClient.send(
              new AddUserToGroupCommand({
                GroupName: groupName,
                UserName: userName,
              })
            );
            log.debug(`Added user ${v(userName)} to group ${v(groupName)}`);
          }
        }
        for (const userName of oldUsers) {
          if (!newUsers.has(userName)) {
            try {
              await this.iamClient.send(
                new RemoveUserFromGroupCommand({
                  GroupName: groupName,
                  UserName: userName,
                })
              );
              log.debug(`Removed user ${v(userName)} from group ${v(groupName)}`);
            } catch (error) {
              if (!(error instanceof NoSuchEntityException)) {
                throw error;
              }
            }
          }
        }
      }

      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update IAM UserToGroupAddition ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async deleteUserToGroupAddition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    // UserToGroupAddition is metadata-only (RemoveUserFromGroup); the
    // "skipping" returns below trigger when input properties are missing,
    // not when AWS reports the user/group missing, so the region check
    // does not apply here. The context is read only for the destroy's
    // secret-principal opt-in (go-to-k/cdkd#4150).
    //
    // Issue #1770 re-judged both arms and CONVERTED them to `'skipped'`. They
    // logged at DEBUG, which reads as "routine, nothing to do" — but it is not:
    // `GroupName` and `Users` are both REQUIRED by the CloudFormation schema
    // for AWS::IAM::UserToGroupAddition, and `createUserToGroupAddition` above
    // THROWS on either being absent, so a record missing one cannot have come
    // from a successful create — it is CORRUPT, not empty. The memberships its
    // AddUserToGroup calls made therefore survive the destroy, and the users
    // keep every permission the group grants. That is exactly "cdkd could not
    // address it", and it is why the level is now WARN — a skip preserves state
    // and exits non-zero, and the user needs to see why at normal verbosity.
    //
    // An empty `Users: []` is a genuinely different shape and stays a
    // `deleted`: an array is truthy, so it falls through to the loop below and
    // correctly does nothing. Its producer is UPDATE, not create —
    // `updateUserToGroupAddition` diffs against the new list, so an EMPTY desired
    // `Users: []` removes every old user and records `[]`.
    // (Create cannot produce it: it rejects `users.length === 0`.)
    this.logger.debug(`Deleting IAM UserToGroupAddition ${logicalId}`);

    // Neither arm has a second source to fall back on, unlike the
    // Lambda-permission / IAM-policy arms: `RemoveUserFromGroup` is addressed
    // by GroupName + UserName, and this resource's physicalId is just the
    // logicalId (see `createUserToGroupAddition`), so it names neither.
    if (!properties) {
      this.logger.warn(
        `No properties for UserToGroupAddition ${logicalId}, skipping deletion — GroupName and ` +
          `Users are both required to call RemoveUserFromGroup, so no AWS call is issued and ` +
          `the group memberships are LEFT IN PLACE, UNLESS the group or the users are ` +
          `themselves part of this stack (their own deletes remove exactly these memberships, ` +
          `and then only the cdkd record is stale — clear it with 'cdkd state orphan <stack> --stack-region <region>', which drops every record the stack has in that region). ` +
          `Otherwise restore the record's properties in state.json and re-run, or remove the ` +
          `users from the group by hand. ${DEPLOY_SKIP_CAVEAT}`
      );
      return { outcome: 'skipped', reason: MEMBERSHIP_NO_PROPERTIES_SKIP_REASON };
    }

    const groupName = properties['GroupName'] as string;
    const recordedUsers = properties['Users'] as string[];

    if (!groupName || !recordedUsers) {
      this.logger.warn(
        `Missing GroupName or Users for ${logicalId}, skipping deletion — both are required to ` +
          `call RemoveUserFromGroup, so no AWS call is issued and the group memberships are ` +
          `LEFT IN PLACE, UNLESS the group or the users are themselves part of this stack ` +
          `(their own deletes remove exactly these memberships, and then only the cdkd record ` +
          `is stale — clear it with 'cdkd state orphan <stack> --stack-region <region>', which drops every record the stack has in that region). Otherwise restore them in ` +
          `state.json and re-run, or remove the users from the group by hand. ` +
          `${DEPLOY_SKIP_CAVEAT}`
      );
      return { outcome: 'skipped', reason: MEMBERSHIP_MISSING_FIELDS_SKIP_REASON };
    }

    // go-to-k/cdkd#3952: Users is read below (a redacted entry is malformed
    // there); GroupName is the other half of the address.
    const redactedGroup = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      'UserToGroupAddition',
      redactedDeleteAddressFields({ GroupName: properties['GroupName'] })
    );
    if (redactedGroup) return redactedGroup;

    // A present `Users` that is not a list of IAM user names (go-to-k/cdkd#3888):
    // refused before any call rather than guessing which users it names.
    const read = readPrincipalLists({ Users: properties['Users'] });
    // go-to-k/cdkd#4150: a Users list that is malformed ONLY because it holds
    // secret references is resolved, on a caller that opts in (a destroy), to
    // the users the CURRENT secret value names; see
    // `DeleteContext.resolveSecretDerivedPrincipals` for why a deploy must not.
    let users: string[] | undefined = 'malformed' in read ? undefined : read.lists.Users;
    let mask: (text: string) => string = (text) => text;
    let maskError: <T>(error: T) => T = (error) => error;
    let resolvedNames: ReadonlySet<string> = new Set();
    const memo = context?.resolveSecretDerivedPrincipals?.retryMemo;
    const optIn = context?.resolveSecretDerivedPrincipals;
    // A mask never resolves, so a list holding one is not attempted (and its
    // skip does not say "fix that and re-run").
    const resolutionAttempted =
      'malformed' in read &&
      optIn !== undefined &&
      isResolvableSecretPrincipalList(properties['Users']);
    if (resolutionAttempted) {
      // A retry of this delete reuses the first attempt's resolution (and does
      // not repeat its warning).
      const reused = memo?.resolved;
      const resolved =
        reused ??
        (await resolveSecretDerivedPrincipals(
          { Users: properties['Users'] },
          context?.expectedRegion,
          optIn.importedProducerRegions
        ));
      if (resolved && memo) memo.resolved = resolved;
      if (resolved?.lists['Users'] !== undefined) {
        users = resolved.lists['Users'];
        mask = resolved.mask;
        maskError = resolved.maskError;
        resolvedNames = resolved.resolvedNames['Users'] ?? new Set();
        if (reused === undefined) {
          this.logger.warn(
            safeMsg`UserToGroupAddition ${logicalId}: the recorded Users holds a secret reference, resolved to the users the secret names NOW. If its value changed since they were added, a user only the OLD value named stays in the group (remove it by hand), and a user only the CURRENT value names is removed even if it joined from elsewhere.`
          );
        }
      }
    }
    if ('malformed' in read && users === undefined) {
      // The same parent clause the missing-fields arm carries: a group or users
      // deleted by this destroy remove exactly these memberships.
      const repair =
        read.secretDerived.length > 0
          ? 'The recorded Users is secret-derived (cdkd keeps the dynamic reference or its mask ' +
            'in state), so do not write the name into state.json' +
            (resolutionAttempted
              ? '; cdkd could not resolve the reference (its region, access to it, or its value), ' +
                'so fix that and re-run, or'
              : ':') +
            ' cdkd will keep skipping this record. Remove the users from the group by hand; on cdkd destroy every other ' +
            "resource is still deleted, so once this is the stack's last record " +
            "'cdkd state orphan <stack> --stack-region <region>' clears it."
          : 'Repair the recorded Users in state.json to a list of user names and re-run, or ' +
            'remove the users from the group by hand.';
      this.logger.warn(
        safeMsg`The state record for UserToGroupAddition ${logicalId} holds a Users that is not a list of IAM user names — skipping deletion rather than guessing which users it names. No AWS call is issued, so the group memberships are LEFT IN PLACE, UNLESS the group or the users are themselves part of this stack (their own deletes remove exactly these memberships, and then only the cdkd record is stale — clear it with 'cdkd state orphan <stack> --stack-region <region>', which drops every record the stack has in that region). ${repair} ${DEPLOY_SKIP_CAVEAT}`
      );
      return { outcome: 'skipped', reason: MEMBERSHIP_MALFORMED_USERS_SKIP_REASON };
    }

    // go-to-k/cdkd#4150: a user the secret's CURRENT value names outside the
    // group means the value may have rotated since the membership was added,
    // so a user only the OLD value named may still be a member. Reporting
    // DELETED would drop the record, the last trace of that membership.
    // `RemoveUserFromGroup` does NOT say so: for an existing user outside the
    // group it SUCCEEDS (measured), so membership is read first, from
    // `ListGroupsForUser` (paginated; a user holds at most 10 groups), for
    // each user a secret supplied that this delete has not removed already.
    let secretUserNotMember = false;
    try {
      for (const userName of users ?? []) {
        if (
          resolvedNames.has(userName) &&
          memo?.detached.has(injectiveKey('Users', userName)) !== true
        ) {
          let isMember: boolean;
          try {
            // IAM names are case-insensitive: a recorded GroupName in another
            // case names the same group.
            const wanted = groupName.toLowerCase();
            isMember = (await this.readLiveGroups(userName)).some(
              (g) => g.toLowerCase() === wanted
            );
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) throw error;
            isMember = false;
          }
          if (!isMember) {
            secretUserNotMember = true;
            continue;
          }
        }
        try {
          await this.iamClient.send(
            new RemoveUserFromGroupCommand({
              GroupName: groupName,
              UserName: userName,
            })
          );
          if (resolvedNames.has(userName)) memo?.detached.add(injectiveKey('Users', userName));
          this.logger.debug(`Removed user ${mask(userName)} from group ${groupName}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
          // An earlier attempt of THIS delete (the runner's retry) removing it
          // is not a rotation; a user gone since the membership read above is.
          if (
            resolvedNames.has(userName) &&
            memo?.detached.has(injectiveKey('Users', userName)) !== true
          ) {
            secretUserNotMember = true;
          }
        }
      }

      if (secretUserNotMember) {
        this.logger.warn(
          safeMsg`UserToGroupAddition ${logicalId}: a user the secret's CURRENT value names is not in the group. The value may have rotated since the membership was added, so a user only the OLD value named may still be a member; or an earlier cdkd run already removed it, or that user was deleted first. The record is KEPT rather than read as deleted: remove any old user from the group by hand (the users the current value names are done), then drop this record with 'cdkd orphan <constructPath>', or, with no CDK app, 'cdkd state orphan <stack> --stack-region <region>' once it is the stack's last record.`
        );
        return { outcome: 'skipped', reason: MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON };
      }
      this.logger.debug(`Successfully deleted IAM UserToGroupAddition ${logicalId}`);
    } catch (error) {
      // go-to-k/cdkd#4150: the whole chain is masked, cause included — an SDK
      // error body can quote a principal name resolved from a secret. The
      // clone keeps each link's prototype, `$metadata` and markers, so the
      // retry classifiers read it as before.
      const cause = error instanceof Error ? error : undefined;
      throw maskError(
        new ProvisioningError(
          `Failed to delete IAM UserToGroupAddition ${logicalId}: ${mask(error instanceof Error ? error.message : String(error))}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
      );
    }
  }

  // ─── readCurrentState dispatch ───────────────────────────────────

  /**
   * Read the AWS-current configuration for an IAM user / group /
   * UserToGroupAddition in CFn-property shape.
   *
   *  - **AWS::IAM::User**: `GetUser` for `UserName`, `Path`,
   *    `PermissionsBoundary` (re-shaped from `PermissionsBoundary.Arn`,
   *    always-emit `''` placeholder so console-side ADD on a user
   *    deployed without a boundary surfaces as drift);
   *    `ListAttachedUserPolicies` for `ManagedPolicyArns`;
   *    `ListGroupsForUser` for `Groups`; `ListUserPolicies` +
   *    `GetUserPolicy` per name for inline `Policies` (URL-decoded +
   *    JSON-parsed, capped at IAM's documented 10-per-user limit, order
   *    reconciled against state's `Policies` array). `Tags` and
   *    `LoginProfile` remain omitted — Tags will land in a follow-up,
   *    LoginProfile contains a one-time password we never want to surface
   *    through drift.
   *  - **AWS::IAM::Group**: `GetGroup` for `GroupName`, `Path`;
   *    `ListAttachedGroupPolicies` for `ManagedPolicyArns`;
   *    `ListGroupPolicies` + `GetGroupPolicy` per name for inline
   *    `Policies`.
   *  - **AWS::IAM::UserToGroupAddition**: SKIPPED — returns `undefined`
   *    because the resource is metadata-only (group-membership attachments
   *    written via `AddUserToGroup`). A meaningful drift check would
   *    require both the `GroupName` and the source-of-truth `Users` list
   *    from state, neither of which `readCurrentState` receives. The
   *    drift comparator falls back to "drift unknown" and the user can
   *    inspect the membership manually.
   *
   * Returns `RESOURCE_NOT_FOUND` when the user / group is gone
   * (`NoSuchEntityException`).
   */
  async readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: import('../../types/resource.js').ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    switch (resourceType) {
      case 'AWS::IAM::User':
        return this.readUserCurrentState(physicalId, properties, context);
      case 'AWS::IAM::Group':
        return this.readGroupCurrentState(physicalId, properties, context);
      case 'AWS::IAM::UserToGroupAddition':
        // Membership-only resource. See JSDoc above.
        return undefined;
      default:
        this.logger.debug(
          `readCurrentState: unsupported resource type ${resourceType} for ${logicalId}`
        );
        return undefined;
    }
  }

  private async readUserCurrentState(
    physicalId: string,
    properties?: Record<string, unknown>,
    context?: import('../../types/resource.js').ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let user;
    try {
      const resp = await this.iamClient.send(new GetUserCommand({ UserName: physicalId }));
      user = resp.User;
    } catch (err) {
      if (err instanceof NoSuchEntityException) return RESOURCE_NOT_FOUND;
      throw err;
    }
    if (!user) return undefined;

    const result: Record<string, unknown> = {};
    if (user.UserName !== undefined) result['UserName'] = user.UserName;
    if (user.Path !== undefined) result['Path'] = user.Path;
    // Always-emit so a console-side ADD on a user deployed without a
    // boundary surfaces as drift (top-level walk is state-keys-only).
    result['PermissionsBoundary'] = user.PermissionsBoundary?.PermissionsBoundaryArn ?? '';

    try {
      const attached = await this.iamClient.send(
        new ListAttachedUserPoliciesCommand({ UserName: physicalId })
      );
      const arns = (attached.AttachedPolicies ?? [])
        .map((p) => p.PolicyArn)
        .filter((arn): arn is string => !!arn);
      result['ManagedPolicyArns'] = arns;
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }

    try {
      const groups = await this.iamClient.send(
        new ListGroupsForUserCommand({ UserName: physicalId })
      );
      const names = (groups.Groups ?? []).map((g) => g.GroupName).filter((n): n is string => !!n);
      result['Groups'] = names;
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }

    // Inline Policies — same pattern as IAMRoleProvider.readCurrentState.
    // Capped at IAM's 10-per-user limit; ListUserPolicies is paginated for
    // forward-compat.
    try {
      const inline = await this.collectInlinePolicies(
        'user',
        physicalId,
        (properties?.['Policies'] as Array<{ PolicyName?: string }> | undefined) ?? [],
        context
      );
      result['Policies'] = inline;
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }

    return result;
  }

  private async readGroupCurrentState(
    physicalId: string,
    properties?: Record<string, unknown>,
    context?: import('../../types/resource.js').ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let group;
    try {
      const resp = await this.iamClient.send(new GetGroupCommand({ GroupName: physicalId }));
      group = resp.Group;
    } catch (err) {
      if (err instanceof NoSuchEntityException) return RESOURCE_NOT_FOUND;
      throw err;
    }
    if (!group) return undefined;

    const result: Record<string, unknown> = {};
    if (group.GroupName !== undefined) result['GroupName'] = group.GroupName;
    if (group.Path !== undefined) result['Path'] = group.Path;

    try {
      const attached = await this.iamClient.send(
        new ListAttachedGroupPoliciesCommand({ GroupName: physicalId })
      );
      const arns = (attached.AttachedPolicies ?? [])
        .map((p) => p.PolicyArn)
        .filter((arn): arn is string => !!arn);
      result['ManagedPolicyArns'] = arns;
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }

    try {
      const inline = await this.collectInlinePolicies(
        'group',
        physicalId,
        (properties?.['Policies'] as Array<{ PolicyName?: string }> | undefined) ?? [],
        context
      );
      result['Policies'] = inline;
    } catch (err) {
      if (!(err instanceof NoSuchEntityException)) throw err;
    }

    return result;
  }

  /**
   * Shared inline-policy fetcher for User / Group readCurrentState.
   * Mirrors `IAMRoleProvider.readCurrentState`'s inline-policy handling:
   * paginated `List*Policies` for names → parallel `Get*Policy` per name
   * for bodies (URL-decoded + JSON-parsed) → reconcile order against
   * `statePolicies` so a positional compare doesn't fire false drift on
   * the lexicographic order returned by AWS.
   *
   * Issue #323: filters out policies whose name matches an
   * `AWS::IAM::Policy` sibling in the same stack (via `Users`/`Groups`
   * attachment field), so policies attached by `iam.Policy({ users: [u] })` /
   * `groups: [g]` don't fire false drift on the User / Group itself.
   */
  private async collectInlinePolicies(
    kind: 'user' | 'group',
    physicalId: string,
    statePolicies: Array<{ PolicyName?: string }>,
    context: import('../../types/resource.js').ReadCurrentStateContext | undefined
  ): Promise<Array<{ PolicyName: string; PolicyDocument: unknown }>> {
    const policyNames: string[] = [];
    let marker: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const listResp =
        kind === 'user'
          ? await this.iamClient.send(
              new ListUserPoliciesCommand({
                UserName: physicalId,
                ...(marker ? { Marker: marker } : {}),
              })
            )
          : await this.iamClient.send(
              new ListGroupPoliciesCommand({
                GroupName: physicalId,
                ...(marker ? { Marker: marker } : {}),
              })
            );
      for (const name of listResp.PolicyNames ?? []) policyNames.push(name);
      if (!listResp.IsTruncated) break;
      marker = listResp.Marker;
    }

    const managedByOtherResource = collectInlinePolicyNamesManagedBySiblings(
      physicalId,
      context,
      kind === 'user' ? 'Users' : 'Groups'
    );
    const filteredNames = policyNames.filter((n) => !managedByOtherResource.has(n));

    const bodies = new Map<string, unknown>();
    await Promise.all(
      filteredNames.map(async (name) => {
        const resp =
          kind === 'user'
            ? await this.iamClient.send(
                new GetUserPolicyCommand({ UserName: physicalId, PolicyName: name })
              )
            : await this.iamClient.send(
                new GetGroupPolicyCommand({ GroupName: physicalId, PolicyName: name })
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
    return inline;
  }

  // ─── Import dispatch ──────────────────────────────────────────────

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
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
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

  private async importUser(input: ResourceImportInput): Promise<ResourceImportResult | null> {
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

  private async importGroup(input: ResourceImportInput): Promise<ResourceImportResult | null> {
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
  private async importUserToGroupAddition(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }
}
