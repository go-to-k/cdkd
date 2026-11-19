import {
  DescribeRepositoriesCommand,
  GetLifecyclePolicyCommand,
  GetRepositoryPolicyCommand,
  ListTagsForResourceCommand,
  LifecyclePolicyNotFoundException,
  RepositoryNotFoundException,
  RepositoryPolicyNotFoundException,
} from '@aws-sdk/client-ecr';
import type { ECRProvider } from '../ecr-provider.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import {
  RESOURCE_NOT_FOUND,
  type ReadCurrentStateContext,
  type ResourceNotFound,
} from '../../../types/resource.js';
import {
  declaredMemberDocument,
  type MemberRead,
  memberReadFailure,
  policyDocumentMatchesDeclared,
  settleDeclaredMember,
  warnUnsettledMember,
} from '../../settle-after-own-write.js';

const REPOSITORY_TYPE = 'AWS::ECR::Repository';

/**
 * SDK `[{ filterType, filter }]` back to the CFn
 * `ImageTagMutabilityExclusionFilters` shape, so `cdkd drift` compares the
 * AWS-current exclusions against the template-shaped baseline instead of a
 * guaranteed false positive. `undefined` for an absent / empty list, so the
 * read omits the key (a repository with no exclusions).
 */
function toCfnTagMutabilityExclusionFilters(
  sdk: Array<{ filterType?: string; filter?: string }> | undefined
): Array<Record<string, unknown>> | undefined {
  if (!sdk || sdk.length === 0) return undefined;
  // Undefined-valued keys are omitted rather than emitted: S3 drops them when
  // `observedProperties` is serialized, so a later drift read that DID carry
  // them would differ by key count and report phantom drift. Both members are
  // required in the SDK model, so this is defense against a shape AWS should
  // never return.
  return sdk.map((f) => ({
    ...(f.filterType !== undefined && {
      ImageTagMutabilityExclusionFilterType: f.filterType,
    }),
    ...(f.filter !== undefined && { ImageTagMutabilityExclusionFilterValue: f.filter }),
  }));
}

/**
 * One `GetRepositoryPolicy`: the policy JSON-parsed when it parses (the shape
 * cdkd state records a resolved `RepositoryPolicyText` in), `'absent'` on
 * `RepositoryPolicyNotFoundException` or an empty answer. Every other error
 * throws, `RepositoryNotFoundException` included.
 */
async function readRepositoryPolicy(
  this: ECRProvider,
  repositoryName: string
): Promise<MemberRead<unknown>> {
  let policyText: string | undefined;
  try {
    policyText = (await this.getClient().send(new GetRepositoryPolicyCommand({ repositoryName })))
      .policyText;
  } catch (err) {
    if (err instanceof RepositoryPolicyNotFoundException) return 'absent';
    throw err;
  }
  if (!policyText) return 'absent';
  try {
    return { value: JSON.parse(policyText) as unknown };
  } catch {
    return { value: policyText };
  }
}

/**
 * `RepositoryPolicyText` as the read records it: `undefined` for no policy,
 * else the parsed document.
 *
 * The capture right after cdkd's own write (`afterOwnWrite`,
 * go-to-k/cdkd#6609) asks only when the template declares a policy: the
 * write just set it, or just removed it, so a template without one records
 * none without a call, and a lagging read cannot freeze the removed policy
 * into the baseline. A declared policy the read does not show yet is re-read
 * until it does ({@link settleDeclaredMember}); still none after the
 * schedule, the declared policy is recorded. Every other read believes the
 * first answer and throws what the call threw, so an unreadable policy fails
 * the read rather than reading as "no policy".
 */
async function readPolicyMember(
  this: ECRProvider,
  repositoryName: string,
  logicalId: string,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): Promise<{ value: unknown } | undefined> {
  if (context?.afterOwnWrite !== true) {
    const read = await readRepositoryPolicy.call(this, repositoryName);
    return typeof read === 'object' ? read : undefined;
  }
  const declared = declaredMemberDocument(properties?.['RepositoryPolicyText']);
  if (declared === undefined) return undefined;
  let firstError: unknown;
  let first: MemberRead<unknown>;
  try {
    first = await readRepositoryPolicy.call(this, repositoryName);
  } catch (err) {
    if (err instanceof RepositoryNotFoundException) throw err;
    firstError = err;
    first = memberReadFailure(err);
  }
  const settled = await settleDeclaredMember(
    first,
    () => readRepositoryPolicy.call(this, repositoryName),
    (document) => policyDocumentMatchesDeclared(document, declared),
    declared,
    this.ownWriteRereadDelaysMs,
    () => warnUnsettledMember(this.logger, logicalId, REPOSITORY_TYPE, 'RepositoryPolicyText')
  );
  // No read answered: fail the capture as the single read did.
  if (settled === 'failed' || settled === 'refused') throw firstError;
  return typeof settled === 'object' ? settled : undefined;
}

/** A sub-read's outcome, so the concurrent reads settle before any is judged. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error })
  );
}

/**
 * Read the AWS-current ECR repository configuration in CFn-property shape.
 *
 * `DescribeRepositories(filtered=[name])` first, for the configuration and the
 * ARN; then, CONCURRENTLY (so a deploy's post-write capture waits on the
 * slowest of them, not their sum), `GetLifecyclePolicy`, `GetRepositoryPolicy`
 * and `ListTagsForResource(arn)`.
 *
 * Surfaced keys: `RepositoryName`, `ImageTagMutability`,
 * `ImageTagMutabilityExclusionFilters` (when the repository has any, mapped
 * back to the CFn member names), `ImageScanningConfiguration`,
 * `EncryptionConfiguration`, `LifecyclePolicy` (when configured —
 * `LifecyclePolicyNotFoundException` omits the key), `RepositoryPolicyText`
 * (when set — `RepositoryPolicyNotFoundException` omits the key; see
 * {@link readPolicyMember} for the post-write capture), and `Tags` (CDK's
 * `aws:*` auto-tags filtered out; `[]` when AWS reports no user tags).
 *
 * `EmptyOnDelete` is never read: a delete-time intent flag with no AWS-side
 * value, declared a drift-unknown path by the provider.
 *
 * Returns `RESOURCE_NOT_FOUND` when any read answers
 * `RepositoryNotFoundException` (the repository vanished between the reads
 * too); any other failure of the three throws, the first in the order above.
 */
export async function readCurrentState(
  this: ECRProvider,
  physicalId: string,
  logicalId: string,
  properties?: Record<string, unknown>,
  context?: ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let repo: {
    repositories?: Array<{
      repositoryName?: string;
      repositoryArn?: string;
      imageTagMutability?: string;
      imageTagMutabilityExclusionFilters?: Array<{ filterType?: string; filter?: string }>;
      imageScanningConfiguration?: { scanOnPush?: boolean };
      encryptionConfiguration?: { encryptionType?: string; kmsKey?: string };
    }>;
  };
  try {
    repo = (await this.getClient().send(
      new DescribeRepositoriesCommand({ repositoryNames: [physicalId] })
    )) as unknown as typeof repo;
  } catch (err) {
    if (err instanceof RepositoryNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  const r = repo.repositories?.[0];
  if (!r) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (r.repositoryName !== undefined) result['RepositoryName'] = r.repositoryName;
  if (r.imageTagMutability !== undefined) result['ImageTagMutability'] = r.imageTagMutability;
  const cfnExclusionFilters = toCfnTagMutabilityExclusionFilters(
    r.imageTagMutabilityExclusionFilters
  );
  if (cfnExclusionFilters) {
    result['ImageTagMutabilityExclusionFilters'] = cfnExclusionFilters;
  }
  result['ImageScanningConfiguration'] = {
    ScanOnPush: r.imageScanningConfiguration?.scanOnPush ?? false,
  };
  {
    // Class 1 guard — `KmsKey` is only valid on `EncryptionType=KMS`.
    // AWS rejects `KmsKey` (including the empty string) on AES256
    // repositories, and `EncryptionConfiguration` is immutable so the
    // round-trip path doesn't actually re-submit it; even so, we don't
    // want to leak `KmsKey: ''` into observedProperties because the
    // drift comparator would surface a false positive against any
    // template that omits the field.
    const encType = r.encryptionConfiguration?.encryptionType ?? 'AES256';
    const enc: Record<string, unknown> = { EncryptionType: encType };
    if (encType === 'KMS' && r.encryptionConfiguration?.kmsKey) {
      enc['KmsKey'] = r.encryptionConfiguration.kmsKey;
    }
    result['EncryptionConfiguration'] = enc;
  }

  const client = this.getClient();
  const readLifecycle = async (): Promise<string | undefined> => {
    try {
      return (await client.send(new GetLifecyclePolicyCommand({ repositoryName: physicalId })))
        .lifecyclePolicyText;
    } catch (err) {
      // "Not configured" omits the key; it is not repo-gone.
      if (err instanceof LifecyclePolicyNotFoundException) return undefined;
      throw err;
    }
  };
  const arn = r.repositoryArn;
  const readTags = async (): Promise<Array<{ Key: string; Value: string }> | undefined> =>
    arn === undefined || arn === ''
      ? undefined
      : normalizeAwsTagsToCfn(
          (await client.send(new ListTagsForResourceCommand({ resourceArn: arn }))).tags
        );
  const [lifecycle, policy, tags] = await Promise.all([
    settle(readLifecycle()),
    settle(readPolicyMember.call(this, physicalId, logicalId, properties, context)),
    settle(readTags()),
  ]);
  const reads = [lifecycle, policy, tags];
  if (reads.some((s) => !s.ok && s.error instanceof RepositoryNotFoundException)) {
    return RESOURCE_NOT_FOUND;
  }
  for (const s of reads) if (!s.ok) throw s.error;

  if (lifecycle.ok && lifecycle.value) {
    result['LifecyclePolicy'] = { LifecyclePolicyText: lifecycle.value };
  }
  if (policy.ok && policy.value !== undefined) {
    result['RepositoryPolicyText'] = policy.value.value;
  }
  if (tags.ok && tags.value !== undefined) result['Tags'] = tags.value;
  return result;
}
