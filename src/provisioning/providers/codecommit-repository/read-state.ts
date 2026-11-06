import {
  GetRepositoryCommand,
  ListTagsForResourceCommand,
  RepositoryDoesNotExistException,
  type RepositoryMetadata,
} from '@aws-sdk/client-codecommit';
import type { CodeCommitRepositoryProvider } from '../codecommit-repository-provider.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';

/**
 * Read the currently-deployed properties for `cdkd drift`.
 *
 * Maps the CodeCommit read side back to the flat CFn inputs cdkd stores
 * in state:
 *   - `repositoryName`        -> `RepositoryName`
 *   - `repositoryDescription` -> `RepositoryDescription` (placeholder `''`)
 *   - `kmsKeyId`              -> `KmsKeyId`
 *   - `ListTagsForResource`   -> `Tags` (CFn `[{Key, Value}]` list)
 *
 * Every user-controllable top-level key `update()` can mutate is emitted
 * ALWAYS — with a `?? ''` / `?? []` placeholder when AWS returns the field
 * as undefined / empty (docs/provider-rules.md#readcurrentstate-for-drift-detection). Omitting the key
 * on the empty path would let a resource deployed WITHOUT a description
 * never carry `RepositoryDescription` in `observedProperties`, making a
 * console-side ADD of a description invisible to drift forever. `Tags` are
 * returned in the CFn list shape and the comparator canonicalizes tag lists
 * order-independently (`drift-normalize.ts`), so a tag reorder never
 * surfaces as phantom drift. `aws:*` tags (CDK's `aws:cdk:path` etc.) are
 * dropped by `normalizeAwsTagsToCfn` so a CDK-deployed repository does not
 * report drift on the metadata tag cdkd never templated.
 *
 * Returns `RESOURCE_NOT_FOUND` when the repository no longer exists
 * (`RepositoryDoesNotExistException`), including one deleted BETWEEN the
 * `GetRepository` and `ListTagsForResource` calls (a race with a
 * concurrent destroy), so `cdkd drift` reports it as deleted. Returns
 * `undefined` when `GetRepository` returns no metadata.
 *
 * Caveat: `KmsKeyId` is returned as AWS resolves it — the full key ARN.
 * On the normal drift path the baseline is `observedProperties` (captured
 * via this same method at deploy time), so ARN == ARN and there is no
 * phantom drift; but on the `properties`-fallback path (older state with
 * no `observedProperties`) a template that set `KmsKeyId` as an alias or
 * bare key id would phantom-drift against the returned ARN. This is a
 * general fallback-path limitation shared with other providers.
 */
export async function readCurrentState(
  this: CodeCommitRepositoryProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let metadata: RepositoryMetadata | undefined;
  try {
    metadata = await this.getRepositoryMetadata(physicalId);
  } catch (err) {
    if (err instanceof RepositoryDoesNotExistException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!metadata) return undefined;

  // Tags via ListTagsForResource (needs the repository ARN — CodeCommit's
  // tag map is a flat `Record<string, string>`, normalized back to the CFn
  // list shape). GetRepository does not return tags inline. `?? []` when
  // the ARN is somehow absent so `Tags` is always emitted. A repo deleted
  // between the two reads throws NotFound here — report it as gone instead
  // of letting one racing delete abort the run.
  let tags: Array<{ Key: string; Value: string }> = [];
  if (metadata.Arn) {
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ resourceArn: metadata.Arn })
      );
      tags = normalizeAwsTagsToCfn(tagsResp.tags);
    } catch (err) {
      if (err instanceof RepositoryDoesNotExistException) return RESOURCE_NOT_FOUND;
      throw err;
    }
  }

  return {
    RepositoryName: metadata.repositoryName ?? '',
    RepositoryDescription: metadata.repositoryDescription ?? '',
    // AWS always assigns an encryption key (the AWS-managed
    // `aws/codecommit` key when none was requested), so `kmsKeyId` is
    // effectively never undefined; the `?? ''` placeholder satisfies the
    // always-emit convention for this mutable field regardless.
    KmsKeyId: metadata.kmsKeyId ?? '',
    Tags: tags,
  };
}

/**
 * Adopt an existing CodeCommit repository into cdkd state.
 *
 * Lookup order:
 *  1. `--resource` override or `Properties.RepositoryName` → verify via
 *     `GetRepository`.
 */
export async function importImpl(
  this: CodeCommitRepositoryProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'RepositoryName');
  if (explicit) {
    try {
      const resp = await this.getClient().send(
        new GetRepositoryCommand({ repositoryName: explicit })
      );
      return resp.repositoryMetadata?.repositoryName
        ? { physicalId: explicit, attributes: this.toAttributes(resp.repositoryMetadata) }
        : null;
    } catch (err) {
      if (err instanceof RepositoryDoesNotExistException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a
  // repository reaching here needs an explicit `--resource` override.
  return null;
}
