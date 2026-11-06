import type { KMSProvider } from '../kms-provider.js';
import {
  DescribeKeyCommand,
  GetKeyPolicyCommand,
  GetKeyRotationStatusCommand,
  ListAliasesCommand,
  ListResourceTagsCommand,
  NotFoundException,
} from '@aws-sdk/client-kms';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import {
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';

export async function readCurrentStateKey(
  this: KMSProvider,
  physicalId: string
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
    // practice — we omit the key on a permission error rather than
    // emit `{}`, which would round-trip through update() as `'{}'`
    // and KMS would reject ("KMS key policy must include the JSON
    // statement..."), turning a transient permission blip into a
    // drift-detection false-positive cycle.
    try {
      const policyResp = await this.getClient().send(
        new GetKeyPolicyCommand({ KeyId: md.KeyId, PolicyName: 'default' })
      );
      if (policyResp.Policy) {
        try {
          result['KeyPolicy'] = JSON.parse(policyResp.Policy) as unknown;
        } catch {
          result['KeyPolicy'] = policyResp.Policy;
        }
      }
    } catch (err) {
      if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
      // Permission errors etc — leave key absent rather than firing
      // false drift on every run.
    }

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
        // UnsupportedOperationException (asymmetric edge cases AWS
        // changes over time) / AccessDenied — leave key absent.
      }
    }

    // Tags via ListResourceTags. AWS-managed keys (alias/aws/*) reject
    // ListResourceTags with AccessDenied — omit silently.
    try {
      const tagsResp = await this.getClient().send(
        new ListResourceTagsCommand({ KeyId: md.KeyId })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
      result['Tags'] = tags;
    } catch (err) {
      if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
      // Permission errors etc — leave key absent.
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
