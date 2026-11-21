import type { KMSProvider } from '../kms-provider.js';
import {
  DescribeKeyCommand,
  GetKeyPolicyCommand,
  GetKeyRotationStatusCommand,
  ListAliasesCommand,
  ListResourceTagsCommand,
  NotFoundException,
  UnsupportedOperationException,
} from '@aws-sdk/client-kms';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import {
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
  type ReadCurrentStateContext,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import {
  declaredMemberDocument,
  KMS_DEFAULT_KEY_POLICY_ID,
  type MemberRead,
  policyDocumentMatchesDeclared,
  memberReadFailure,
  settleDeclaredMember,
  warnUnsettledMember,
} from '../../settle-after-own-write.js';

/** One `GetKeyPolicy`, the policy JSON-parsed when it parses; throws what the call throws. */
async function readKeyPolicy(this: KMSProvider, keyId: string): Promise<MemberRead<unknown>> {
  const policyResp = await this.getClient().send(
    new GetKeyPolicyCommand({ KeyId: keyId, PolicyName: 'default' })
  );
  if (!policyResp.Policy) return 'failed';
  try {
    return { value: JSON.parse(policyResp.Policy) as unknown };
  } catch {
    return { value: policyResp.Policy };
  }
}

/**
 * The key policy to record on the capture right after cdkd's own write
 * (go-to-k/cdkd#6609): `PutKeyPolicy` is eventually consistent, so the read
 * can still answer with the policy the write replaced. Re-read until it is the
 * declared `KeyPolicy`. A key always holds a policy, so "none set yet" is
 * KMS's default policy (`Id: key-default-1`): still that after the schedule,
 * the declared policy is recorded; another policy is recorded as read.
 */
async function settleKeyPolicy(
  this: KMSProvider,
  keyId: string,
  logicalId: string,
  first: MemberRead<unknown>,
  declared: unknown
): Promise<MemberRead<unknown>> {
  const asMember = (answer: MemberRead<unknown>): MemberRead<unknown> =>
    typeof answer === 'object' &&
    !policyDocumentMatchesDeclared(answer.value, declared) &&
    isKmsDefaultKeyPolicy(answer.value)
      ? 'absent'
      : answer;
  return settleDeclaredMember(
    asMember(first),
    async () => asMember(await readKeyPolicy.call(this, keyId)),
    (value) => policyDocumentMatchesDeclared(value, declared),
    declared,
    this.ownWriteRereadDelaysMs,
    () => warnUnsettledMember(this.logger, logicalId, 'AWS::KMS::Key', 'KeyPolicy')
  );
}

function isKmsDefaultKeyPolicy(policy: unknown): boolean {
  return (
    typeof policy === 'object' &&
    policy !== null &&
    (policy as Record<string, unknown>)['Id'] === KMS_DEFAULT_KEY_POLICY_ID
  );
}

/**
 * The live key in CFn shape. On the capture right after cdkd's own write
 * (`context.afterOwnWrite`) a `KeyPolicy` the template declares is settled by
 * {@link settleKeyPolicy}; every other read takes the first answer.
 */
export async function readCurrentStateKey(
  this: KMSProvider,
  physicalId: string,
  properties?: Record<string, unknown>,
  context?: ReadCurrentStateContext,
  logicalId = physicalId
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let resp: {
    KeyMetadata?: {
      KeyId?: string;
      Description?: string;
      KeySpec?: string;
      KeyUsage?: string;
      Enabled?: boolean;
      MultiRegion?: boolean;
      Origin?: string;
    };
  };
  try {
    resp = (await this.getClient().send(
      new DescribeKeyCommand({ KeyId: physicalId })
    )) as unknown as typeof resp;
  } catch (err) {
    if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  const md = resp.KeyMetadata;
  if (!md) return undefined;

  const result: Record<string, unknown> = {};
  result['Description'] = md.Description ?? '';
  if (md.KeySpec !== undefined) result['KeySpec'] = md.KeySpec;
  if (md.KeyUsage !== undefined) result['KeyUsage'] = md.KeyUsage;
  if (md.Enabled !== undefined) result['Enabled'] = md.Enabled;
  if (md.MultiRegion !== undefined) result['MultiRegion'] = md.MultiRegion;
  if (md.Origin !== undefined) result['Origin'] = md.Origin;

  if (md.KeyId) {
    // KeyPolicy via GetKeyPolicy. AWS returns the policy as a JSON
    // string; we re-parse so the comparator can match cdkd state's
    // already-resolved object form. KMS keys always have a policy
    // (minimum is the implicit root statement KMS injects on
    // CreateKey), so the empty-response branch is unreachable in
    // practice — it omits the key rather than emit `{}`, which would
    // round-trip through update() as `'{}'` and KMS would reject ("KMS key
    // policy must include the JSON statement...").
    //
    // A FAILED read (an `AccessDenied`, a throttle) throws instead of
    // omitting the key (issue #6759): an omitted key is never compared, so
    // `cdkd drift` would report no drift for a policy it could not read. On
    // the post-write capture a transient failure is still re-read first, and
    // the error throws only when no re-read answered.
    let keyPolicy: MemberRead<unknown>;
    let keyPolicyError: unknown;
    let keyPolicyFailed = false;
    try {
      keyPolicy = await readKeyPolicy.call(this, md.KeyId);
    } catch (err) {
      if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
      keyPolicy = memberReadFailure(err);
      keyPolicyError = err;
      keyPolicyFailed = true;
    }
    const declared =
      context?.afterOwnWrite === true
        ? declaredMemberDocument(properties?.['KeyPolicy'])
        : undefined;
    if (declared !== undefined) {
      keyPolicy = await settleKeyPolicy.call(this, md.KeyId, logicalId, keyPolicy, declared);
    }
    if (keyPolicyFailed && (keyPolicy === 'failed' || keyPolicy === 'refused')) {
      throw keyPolicyError;
    }
    if (typeof keyPolicy === 'object') result['KeyPolicy'] = keyPolicy.value;

    // EnableKeyRotation / RotationPeriodInDays via GetKeyRotationStatus.
    // Class 1 discriminator: only valid for SYMMETRIC_DEFAULT keys —
    // asymmetric keys reject GetKeyRotationStatus with
    // UnsupportedOperationException, so we gate the emit on KeySpec.
    // (CFn defaults KeySpec to SYMMETRIC_DEFAULT when omitted, so
    // undefined is treated as symmetric.)
    const isSymmetric = md.KeySpec === undefined || md.KeySpec === 'SYMMETRIC_DEFAULT';
    if (isSymmetric) {
      try {
        const rotationResp = await this.getClient().send(
          new GetKeyRotationStatusCommand({ KeyId: md.KeyId })
        );
        result['EnableKeyRotation'] = rotationResp.KeyRotationEnabled ?? false;
        if (rotationResp.RotationPeriodInDays !== undefined) {
          result['RotationPeriodInDays'] = rotationResp.RotationPeriodInDays;
        }
      } catch (err) {
        if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
        // UnsupportedOperationException is KMS saying rotation does not apply
        // to this key (imported key material, a custom key store, asymmetric
        // edge cases AWS changes over time): leave the key absent. Any other
        // failure (AccessDenied, a throttle) throws (issue #6759).
        if (!(err instanceof UnsupportedOperationException)) throw err;
      }
    }

    // Tags via ListResourceTags. Any failure other than the key's
    // not-found throws (issue #6759) rather than omitting the key, which
    // would never compare it. That includes the AccessDenied an AWS-managed
    // key (alias/aws/*) answers; a template's AWS::KMS::Key creates a
    // customer-managed key.
    try {
      const tagsResp = await this.getClient().send(
        new ListResourceTagsCommand({ KeyId: md.KeyId })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
      result['Tags'] = tags;
    } catch (err) {
      if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }
  }
  return result;
}

export async function readCurrentStateAlias(
  this: KMSProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let marker: string | undefined;
  do {
    const list = await this.getClient().send(
      new ListAliasesCommand({ ...(marker && { Marker: marker }) })
    );
    const found = list.Aliases?.find(
      (a: { AliasName?: string | undefined }) => a.AliasName === physicalId
    );
    if (found) {
      const result: Record<string, unknown> = {};
      if (found.AliasName) result['AliasName'] = found.AliasName;
      if (found.TargetKeyId) result['TargetKeyId'] = found.TargetKeyId;
      return result;
    }
    marker = list.NextMarker;
  } while (marker);
  // Absent from every page: the alias is gone (go-to-k/cdkd#4283).
  return RESOURCE_NOT_FOUND;
}

/**
 * Adopt an existing KMS key or alias into cdkd state.
 *
 * KMS keys have no `Properties.KeyName` field — physical IDs are
 * AWS-generated UUIDs. So:
 *  - For `AWS::KMS::Key`: `--resource MyKey=<keyId>` is the only explicit
 *    path; there is no auto-lookup (a key reaching here without an explicit
 *    id or a CloudFormation-resolved physical id returns `null`).
 *  - For `AWS::KMS::Alias`: `Properties.AliasName` is explicit and reliable.
 */
export async function importImpl(
  this: KMSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.resourceType === 'AWS::KMS::Alias') {
    const aliasName =
      input.knownPhysicalId ??
      (typeof input.properties?.['AliasName'] === 'string'
        ? input.properties['AliasName']
        : undefined);
    if (!aliasName) return null;
    try {
      // ListAliases doesn't support filtering by name; walk to verify.
      let marker: string | undefined;
      do {
        const list = await this.getClient().send(
          new ListAliasesCommand({ ...(marker && { Marker: marker }) })
        );
        const found = list.Aliases?.find(
          (a: { AliasName?: string | undefined }) => a.AliasName === aliasName
        );
        if (found) return { physicalId: aliasName, attributes: {} };
        marker = list.NextMarker;
      } while (marker);
      return null;
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  // AWS::KMS::Key
  if (input.knownPhysicalId) {
    try {
      await this.getClient().send(new DescribeKeyCommand({ KeyId: input.knownPhysicalId }));
      return { physicalId: input.knownPhysicalId, attributes: {} };
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
  // tag never exists on a real resource and the walk could not match (issue
  // #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a key
  // reaching here needs an explicit `--resource` override.
  return null;
}
