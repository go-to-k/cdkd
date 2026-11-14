import type { IAMManagedPolicyProvider } from '../iam-managed-policy-provider.js';
import {
  CreatePolicyCommand,
  GetPolicyCommand,
  DeletePolicyCommand,
  type Policy,
} from '@aws-sdk/client-iam';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { CdkdError, ProvisioningError } from '../../../utils/error-handler.js';
import { generateResourceNameWithFallback } from '../../resource-name.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { createMaskedLogSinks, withDerivedNameMasks } from '../../masked-retry-logger.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { iamEntityLeftByThisCreate } from '../iam-replay-adopt.js';
import {
  managedPolicyAttributes,
  policyAfterWiring,
  principalsOf,
  policyIdentityToken,
} from './shared.js';

export async function create(
  this: IAMManagedPolicyProvider,
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

  // go-to-k/cdkd#4583: the ARN CreatePolicy returned (the id `delete()` takes),
  // or that a replay adopted (#5660), cleared when the partial-create cleanup
  // deleted the policy.
  let leftBehindArn: string | undefined;
  // go-to-k/cdkd#4606: the PolicyId CreatePolicy answered with, carried on
  // the mark so the journal needs no read of a policy whose failure may fail
  // that read too.
  let createdPolicyIdentity: string | undefined;
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

    const createClient = await this.createClient.get();
    let policy: Policy | undefined;
    let adopted = false;
    try {
      policy = (await createClient.send(new CreatePolicyCommand(createParams))).Policy;
    } catch (createError) {
      // go-to-k/cdkd#5660: a replay colliding with the policy its own earlier
      // attempt left behind finishes that policy; anything else fails as
      // before. The ARN a same-name re-create reuses proves nothing, so the
      // proof is the PolicyId. The wiring is `attachToPrincipals` alone, whose
      // three calls each succeeded on an attached policy when measured on real
      // IAM (2026-11-03); `CreatePolicyVersion` belongs to `update()`, and the
      // document came with `CreatePolicy`.
      const expectedArnTail = `:policy${createParams.Path ?? '/'}${policyName}`;
      policy = await iamEntityLeftByThisCreate({
        logicalId,
        resourceType,
        noun: 'managed policy',
        displayName: policyName,
        createError,
        namesThisEntity: (reported) => reported.endsWith(expectedArnTail),
        read: async (reportedArn) =>
          (await this.iamClient.send(new GetPolicyCommand({ PolicyArn: reportedArn }))).Policy,
        identityOf: (live) => policyIdentityToken(live?.PolicyId),
        log,
      });
      if (policy === undefined) throw createError;
      adopted = true;
    }
    const policyArn = policy?.Arn;
    if (!policyArn) {
      throw new ProvisioningError(
        `${adopted ? 'GetPolicy' : 'CreatePolicy'} succeeded but no Arn returned for ${logicalId}`,
        resourceType,
        logicalId,
        policyName
      );
    }
    leftBehindArn = policyArn;
    createdPolicyIdentity = policyIdentityToken(policy?.PolicyId);
    if (!adopted) {
      reportCreatedResource(logicalId, resourceType, policyArn, createdPolicyIdentity); // go-to-k/cdkd#5511
      log.debug(`Created IAM managed policy: ${v(policyArn)}`);
    }

    // CreatePolicy has succeeded — AWS has committed the policy. Wire up
    // attachments next; if any fail, AWS-side cleanup mirrors `delete()`
    // (detach principals + delete non-default versions + DeletePolicy) so
    // the next redeploy doesn't trip over `EntityAlreadyExists`; an adopted
    // policy skips this cleanup (see the catch).
    try {
      await this.attachToPrincipals(
        policyArn,
        principals.lists.Groups,
        principals.lists.Roles,
        principals.lists.Users,
        log
      );
    } catch (innerError) {
      // go-to-k/cdkd#5660: an adopted policy is not stripped or deleted, see
      // `iamEntityLeftByThisCreate`.
      if (!adopted) {
        try {
          await this.detachAllPrincipals(policyArn);
          await this.deleteAllNonDefaultVersions(policyArn);
          await this.iamClient.send(new DeletePolicyCommand({ PolicyArn: policyArn }));
          retractCreatedResource(logicalId, resourceType, policyArn);
          leftBehindArn = undefined;
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
          // An AWS-authored failure is named by its class at warn, and AWS's
          // text (a denied `DeletePolicy` names the caller) goes to `debug`
          // under the same head (go-to-k/cdkd#2319).
          const cleanupFailure = describeAwsFailure(cleanupError);
          const cleanupHead = `Failed to clean up partially-created managed policy ${logicalId} (${v(policyArn)}): `;
          if (cleanupFailure.redacted) log.debug(`${cleanupHead}${v(cleanupFailure.detail)}`);
          log.warn(
            `${cleanupHead}${cleanupFailure.redacted ? `${v(cleanupFailure.summary)} ` : `${v(cleanupFailure.detail)}. `}Manual deletion may be required: detach principals (${aws`aws iam list-entities-for-policy --policy-arn ${policyArn}`.render()}), delete versions (${aws`aws iam list-policy-versions --policy-arn ${policyArn}`.render()} then aws iam delete-policy-version), then ${aws`aws iam delete-policy --policy-arn ${policyArn}`.render()}`
          );
        }
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    // go-to-k/cdkd#6242: `AttachmentCount` is recorded as of the END of this
    // create, so a policy this create attached is re-read; one attached to
    // nothing keeps the read-back already in hand (no extra call).
    const attachedAny = [
      principals.lists.Groups,
      principals.lists.Roles,
      principals.lists.Users,
    ].some((names) => (names?.length ?? 0) > 0);
    const readBack = attachedAny
      ? await policyAfterWiring(
          async (arn) =>
            (await this.iamClient.send(new GetPolicyCommand({ PolicyArn: arn }))).Policy,
          policyArn,
          policy,
          ['AttachmentCount'],
          log.debug
        )
      : policy;
    return {
      physicalId: policyArn,
      attributes: managedPolicyAttributes(policyArn, readBack),
    };
  } catch (error) {
    // Pass through cdkd-typed errors untouched (#1272): re-labelling an inner
    // ProvisioningError replaces its precise message with this outer one.
    // The mark carries the PolicyId (go-to-k/cdkd#4606), which a later
    // settle compares before deleting the policy by ARN.
    const markLeftBehind = <E>(e: E): E =>
      leftBehindArn !== undefined
        ? markCreatedBeforeFailure(e, logicalId, resourceType, leftBehindArn, createdPolicyIdentity)
        : e;
    if (error instanceof CdkdError) {
      markLeftBehind(error);
      throw error;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(log.mask, error, (text) =>
      markLeftBehind(
        new ProvisioningError(
          `Failed to create IAM managed policy ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          policyName,
          cause
        )
      )
    );
  }
}
