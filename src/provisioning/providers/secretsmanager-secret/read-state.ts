import type { SecretsManagerSecretProvider } from '../secretsmanager-secret-provider.js';
import { DescribeSecretCommand, ResourceNotFoundException } from '@aws-sdk/client-secrets-manager';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import {
  type ReadTag,
  settleWrittenTags,
  takeTagWrite,
  type TagWrite,
} from '../../tags-own-write-baseline.js';
import { warnUnsettledMember } from '../../settle-after-own-write.js';
import {
  RESOURCE_NOT_FOUND,
  type ReadCurrentStateContext,
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
} from '../../../types/resource.js';

/**
 * Read the AWS-current secret configuration in CFn-property shape.
 *
 * Issues `DescribeSecret` and surfaces `Name`, `Description`, `KmsKeyId`,
 * and `ReplicaRegions` (re-shaping `ReplicationStatus[]` to CFn's
 * `[{Region, KmsKeyId}]`).
 *
 * Intentionally omitted:
 *   - `SecretString` / `GenerateSecretString`: `DescribeSecret` does not
 *     return the secret value (that's `GetSecretValue`, which we never
 *     call to avoid surfacing plaintext through drift). Cdkd state holds
 *     the user-supplied string verbatim; comparing against AWS would
 *     require pulling the value, so this is deliberately deferred.
 *
 * `Tags` is surfaced from the same `DescribeSecret` response (no extra
 * round-trip). CDK's `aws:*` auto-tags are filtered out; no user tags
 * record `Tags: []`.
 *
 * Returns `RESOURCE_NOT_FOUND` when the secret is gone (`ResourceNotFoundException`).
 */
export async function readCurrentState(
  this: SecretsManagerSecretProvider,
  physicalId: string,
  logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>,
  context?: ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  // go-to-k/cdkd#6609: on the capture right after an update that SENT a tag
  // call (`recordTagWrite`), the tags are re-read until they show what that
  // call wrote (`tags-own-write-baseline.ts`). The note is consumed here.
  const tagsWritten =
    context?.afterOwnWrite === true
      ? takeTagWrite('AWS::SecretsManager::Secret', physicalId)
      : undefined;
  const tagsSettle =
    properties !== undefined && Object.keys(properties).length > 0 ? tagsWritten : undefined;
  try {
    const resp = await this.smClient.send(new DescribeSecretCommand({ SecretId: physicalId }));
    const result: Record<string, unknown> = {};
    if (resp.Name !== undefined) result['Name'] = resp.Name;
    result['Description'] = resp.Description ?? '';
    result['KmsKeyId'] = resp.KmsKeyId ?? '';
    result['ReplicaRegions'] = (resp.ReplicationStatus ?? []).map((r) => {
      const out: Record<string, unknown> = {};
      if (r.Region) out['Region'] = r.Region;
      if (r.KmsKeyId) out['KmsKeyId'] = r.KmsKeyId;
      return out;
    });
    // Tags from the same DescribeSecret response.
    const tags = normalizeAwsTagsToCfn(resp.Tags);
    result['Tags'] =
      tagsSettle === undefined
        ? tags
        : await this.settleSecretTags(physicalId, logicalId, tags, tagsSettle);
    // `Type`: emit-when-present. AWS returns undefined for the typical
    // (non-partner-managed) secret; emitting a `''` placeholder would
    // force a guaranteed drift on every clean run for the common case.
    if (resp.Type !== undefined) result['Type'] = resp.Type;
    return result;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}

/**
 * The post-write capture's `Tags` (go-to-k/cdkd#6609): `first` (from the
 * resource's `DescribeSecret`) unless it does not show what the update's tag
 * calls wrote, then `DescribeSecret` re-asked until it does, else the newest
 * answer with that write overlaid. One matching answer settles it: the
 * measured misses were single reads. A first `DescribeSecret` that throws
 * fails the resource read, as before.
 */
export async function settleSecretTags(
  this: SecretsManagerSecretProvider,
  physicalId: string,
  logicalId: string,
  first: ReadTag[],
  written: TagWrite
): Promise<ReadTag[]> {
  // Positional, not an options literal: `gen-nested-key-coverage` reads an
  // object literal in a readCurrentState path as reverse-map keys.
  return settleWrittenTags(
    () => Promise.resolve(first),
    async () =>
      normalizeAwsTagsToCfn(
        (await this.smClient.send(new DescribeSecretCommand({ SecretId: physicalId }))).Tags
      ),
    written,
    this.tagsBaselineRereadDelaysMs,
    () => warnUnsettledMember(this.logger, logicalId, 'AWS::SecretsManager::Secret', 'Tags')
  );
}

/**
 * Adopt an existing Secrets Manager secret into cdkd state.
 *
 * Secrets Manager physical IDs are full secret ARNs. The CDK template's
 * `Properties.Name` (secret name) is enough to fetch the ARN via
 * `DescribeSecret`.
 *
 * Lookup order:
 *  1. `--resource` override (ARN) → verify via `DescribeSecret`.
 *  2. `Properties.Name` → `DescribeSecret` (accepts name).
 */
export async function importImpl(
  this: SecretsManagerSecretProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      const resp = await this.smClient.send(
        new DescribeSecretCommand({ SecretId: input.knownPhysicalId })
      );
      return resp.ARN ? { physicalId: resp.ARN, attributes: {} } : null;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  const name =
    typeof input.properties?.['Name'] === 'string' ? input.properties['Name'] : undefined;
  if (name) {
    try {
      const resp = await this.smClient.send(new DescribeSecretCommand({ SecretId: name }));
      return resp.ARN ? { physicalId: resp.ARN, attributes: {} } : null;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a secret
  // reaching here needs an explicit `--resource` override.
  return null;
}
