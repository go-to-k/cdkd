import type { IAMRoleProvider } from '../iam-role-provider.js';
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  AttachRolePolicyCommand,
  type Role,
} from '@aws-sdk/client-iam';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generateResourceNameWithFallback } from '../../resource-name.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { createMaskedLogSinks, withDerivedNameMasks } from '../../masked-retry-logger.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { iamEntityLeftByThisCreate } from '../iam-replay-adopt.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { roleIdentityToken } from './shared.js';

/**
 * Create an IAM role
 */
export async function create(
  this: IAMRoleProvider,
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

  // go-to-k/cdkd#4583: set once CreateRole returns, or a replay adopts its own
  // role (#5656); cleared when the partial-create cleanup deleted the role, so
  // only a left-behind one is marked.
  let leftBehind = false;
  // go-to-k/cdkd#4606: the RoleId CreateRole answered with (for an adopted
  // role, the same one, read back), carried on the mark so the journal needs
  // no read of a role whose failure may fail that read too.
  let createdRoleIdentity: string | undefined;
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
      Tags?: Array<{ Key: string; Value: string }>;
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
    // go-to-k/cdkd#4971: the tags ride on `CreateRole` itself, as
    // CloudFormation sends them, so an SCP requiring `aws:RequestTag/...` on
    // `iam:CreateRole` sees them. No separate `TagRole` follows. A tagged
    // `CreateRole` needs `iam:TagRole` (measured), the permission the
    // follow-up `TagRole` already needed, so no role that could create
    // before loses it.
    if (tags.length > 0) {
      createParams.Tags = tags;
    }

    const createClient = await this.createClient.get();
    let role: Role | undefined;
    let adopted = false;
    try {
      role = (await createClient.send(new CreateRoleCommand(createParams))).Role;
    } catch (createError) {
      // go-to-k/cdkd#5656: a replay colliding with the role its own earlier
      // attempt left behind finishes that role; anything else fails as before.
      // Repeating `AttachRolePolicy` succeeded when measured on real IAM
      // (2026-11-03); `PutRolePolicy` was not probed, while its siblings
      // `PutUserPolicy` and `PutGroupPolicy` were and succeeded.
      role = await iamEntityLeftByThisCreate({
        logicalId,
        resourceType,
        noun: 'role',
        displayName: roleName,
        createError,
        namesThisEntity: (reported) => reported === roleName,
        read: async () =>
          (await this.iamClient.send(new GetRoleCommand({ RoleName: roleName }))).Role,
        identityOf: (live) => roleIdentityToken(live?.RoleId),
        log,
      });
      if (role === undefined) throw createError;
      adopted = true;
    }
    leftBehind = true;
    createdRoleIdentity = roleIdentityToken(role?.RoleId);
    if (!adopted) {
      reportCreatedResource(logicalId, resourceType, roleName, createdRoleIdentity); // go-to-k/cdkd#5511
      log.debug(`Created IAM role: ${v(roleName)}`);
    }

    // CreateRoleCommand has succeeded (here or, for an adopted role, in an
    // earlier attempt) — AWS has now committed the Role.
    // Every subsequent call wires sub-resources onto it (managed-policy
    // attachments / inline policies); if any fail, the role
    // exists on AWS but cdkd state will NOT (the throw aborts before
    // the success-return). The next redeploy would then re-try CREATE
    // and AWS would reject with `EntityAlreadyExists: Role with name
    // <X> already exists`. Wrap the wiring in an inner try/catch that
    // issues best-effort `Detach*` + `DeleteRolePolicy` + `DeleteRole`
    // before re-throwing, so the failed attempt is self-healing on the
    // next redeploy; an adopted role skips this cleanup (see the catch).
    // The cleanup mirrors the order in `delete()`:
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
    } catch (innerError) {
      // go-to-k/cdkd#5656: the identity was read once, and every call here
      // goes by NAME, so a stripping delete is not repeated on the strength
      // of that read. The role stays reported and marked: the next replay
      // adopts it again, and a final failure leaves it to the journal, whose
      // settle compares the RoleId before deleting.
      if (!adopted) {
        try {
          await this.detachAllManagedPolicies(roleName, log);
          await this.deleteAllInlinePolicies(roleName, log);
          await this.iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
          retractCreatedResource(logicalId, resourceType, roleName);
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
          // An AWS-authored failure is named by its class at warn, and AWS's
          // text (a denied `DeleteRole` names the caller) goes to `debug` under
          // the same head (go-to-k/cdkd#2319).
          const cleanupFailure = describeAwsFailure(cleanupError);
          const cleanupHead = `Failed to clean up partially-created IAM role ${logicalId} (${v(roleName)}): `;
          if (cleanupFailure.redacted) log.debug(`${cleanupHead}${v(cleanupFailure.detail)}`);
          log.warn(
            `${cleanupHead}${cleanupFailure.redacted ? `${v(cleanupFailure.summary)} ` : `${v(cleanupFailure.detail)}. `}Manual deletion may be required before the next deploy: detach managed policies (${aws`aws iam list-attached-role-policies --role-name ${roleName}`.render()} then ${aws`aws iam detach-role-policy --role-name ${roleName} --policy-arn '<arn>'`.render()}), delete inline policies (${aws`aws iam list-role-policies --role-name ${roleName}`.render()} then ${aws`aws iam delete-role-policy --role-name ${roleName} --policy-name '<name>'`.render()}), then ${aws`aws iam delete-role --role-name ${roleName}`.render()}`
          );
        }
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    log.debug(`Successfully created IAM role ${logicalId}: ${v(roleName)}`);

    const attributes = {
      Arn: role?.Arn,
      RoleId: role?.RoleId,
    };

    return {
      physicalId: roleName,
      attributes,
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    // An AWS-authored failure is named by its class (issue #2319) and any
    // other text masked RAW (issue #2177). The cause stays unmasked, and the
    // stamp lets the retry classifiers read it (`wrapMaskedError`, #4244).
    throw this.wrapMaskedError(log.mask, error, (text) => {
      const built = new ProvisioningError(
        `Failed to create IAM role ${logicalId}: ${text}`,
        resourceType,
        logicalId,
        roleName,
        cause
      );
      // With its RoleId (go-to-k/cdkd#4606), which a later settle compares
      // before deleting the role by name.
      return leftBehind
        ? markCreatedBeforeFailure(built, logicalId, resourceType, roleName, createdRoleIdentity)
        : built;
    });
  }
}
