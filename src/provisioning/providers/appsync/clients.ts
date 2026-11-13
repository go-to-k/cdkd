import { AppSyncClient } from '@aws-sdk/client-appsync';
import { S3Client } from '@aws-sdk/client-s3';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { getAccountInfo } from '../../../deployment/intrinsic-function-resolver.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import type { ResourceUpdateResult } from '../../../types/resource.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import { s3ClientDefaults } from '../../../utils/s3-client-defaults.js';
import type { AppSyncProvider } from '../appsync-provider.js';
import { displayAppSyncPhysicalId } from './shared.js';

export function getClient(this: AppSyncProvider): AppSyncClient {
  if (!this.client) {
    this.client = new AppSyncClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.client;
}

/**
 * The client the two tokenless creates, `CreateGraphqlApi` and
 * `CreateApiKey`, go through: SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`, issue #2080). Separate so every other call
 * keeps the full SDK retry.
 */
export function getCreateClient(this: AppSyncProvider): AppSyncClient {
  if (!this.createClient) {
    this.createClient = withoutServerErrorRetries(
      new AppSyncClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      })
    );
  }
  return this.createClient;
}

/**
 * Build a child-resource ARN from the deploy's REAL partition / region /
 * account (issue #1681).
 *
 * The three child types record an ARN attribute because CloudFormation's
 * `Ref` for each of them returns the resource ARN (docs-verified 2026-08-12)
 * and `Fn::GetAtt` serves the same value from the same cached map — this
 * provider's `getAttribute` always resolves `undefined`, so the recorded
 * attribute is the ONLY source for both intrinsics.
 *
 * Until #1681 those attributes were string-built as
 * `arn:aws:appsync:*:*:...`, i.e. with literal `*` in the region and account
 * positions, so every consumer received an ARN AWS cannot resolve. Prefer the
 * ARN the create response reports (`dataSourceArn` / `resolverArn`); this
 * helper is for `AWS::AppSync::ApiKey`, whose `CreateApiKey` response carries
 * no ARN field at all, and as the fallback for the other two when a response
 * comes back without one.
 *
 * `getAccountInfo` is the same STS-backed, process-cached resolver
 * `CloudControlProvider` uses for its own ARN reconstruction, so this costs
 * at most one `GetCallerIdentity` per deploy.
 */
export async function buildAppSyncArn(
  this: AppSyncProvider,
  suffix: string,
  regionOverride?: string
): Promise<string> {
  // `regionOverride` is the IMPORT path's region (issue #1728 review):
  // the region `import.ts` keys the state record by (its resolved region,
  // held per stack since go-to-k/cdkd#2100). Since #2100 import builds its
  // providers' clients for that same region, so the two agree; the override
  // keeps the ARN tied to the record rather than to a client. The create /
  // update paths pass nothing and keep deriving it from the client, which is
  // the region their AWS calls actually went to.
  const region = regionOverride ?? this.providerRegion ?? (await this.getClient().config.region());
  // REJECTS when STS cannot name the account and `AWS_ACCOUNT_ID` is unset
  // (issue #1730) — there is no placeholder account to build from, and every
  // caller already has a degradation arm for a failed build. That matters
  // most on the UPDATE path: `childRefAttributes` rebuilds the ARN on every
  // in-place update, so building from a wrong account there would REPLACE a
  // correct, create-time-recorded ARN.
  const accountInfo = await getAccountInfo(region);
  // The PARTITION comes from the region via the closed mapping the repo
  // already uses for `${AWS::Partition}`. This USED to be load-bearing
  // because `accountInfo.partition` was hardcoded to `'aws'` — inert on the
  // create path (AWS reports the real ARN there) but actively WRONG on the
  // update path, where `childRefAttributes` rebuilds the ARN on every
  // in-place update and would overwrite a correct `arn:aws-cn:` /
  // `arn:aws-us-gov:` value with `arn:aws:`. Issue #1730 fixed that field to
  // derive through this same helper, so the two now agree; deriving here is
  // kept because it needs no STS hop and states the dependency locally.
  const { partition } = derivePartitionAndUrlSuffix(accountInfo.region);
  // The REGION SEGMENT is folded too (issue #1850). `derivePartitionAndUrlSuffix`
  // canonicalizes its own input (issue #1795), so the PARTITION above is already
  // right for an upper-cased region — but `accountInfo.region` is whatever
  // spelling the caller supplied (`--region || AWS_REGION || 'us-east-1'`);
  // the SOURCE now folds
  // (`effectiveAccountInfoRegion`, issue #1882), so this local fold is defense
  // in depth rather than the only one. Both are kept: double-folding is a
  // no-op, and an earlier revision of this comment called the region "folded
  // nowhere", which is exactly the claim that goes stale silently. The
  // reachability it also claimed -- that `cdkd deploy --region US-EAST-1`
  // SUCCEEDS because DNS is case-insensitive -- is FALSE and was corrected
  // with issue #1882's measurement -- but the mechanism is the
  // opposite of "it fails": `foldRegionOption` folds `--region` and
  // `AWS_REGION` at every handler's entry (issue #2065) and `AwsClients`
  // folds again, so the flag is CANONICAL before it can reach anything. It
  // never dies, because a raw spelling never gets that far. (It would if it
  // did: SigV4 compares a credential's region scope case-sensitively.) What
  // IS reachable is a Cloud Assembly carrying a raw region in its
  // `environment` string, which cdkd accepts and whose clients it folds.
  // Unfolded, cdkd records `arn:aws:appsync:US-EAST-1:...` -- a value
  // no IAM policy matches (policy matching IS case-sensitive) and every SDK
  // call taking the ARN rejects. It is persisted into state.json, so it
  // outlives the deploy and is what every later `Fn::GetAtt` / `cdkd drift`
  // reads. Double-folding is a no-op, so this is safe next to the derive.
  return `arn:${partition}:appsync:${canonicalizeRegion(accountInfo.region)}:${accountInfo.accountId}:${suffix}`;
}

/**
 * {@link buildAppSyncArn} for the POST-CREATE sites, where throwing is not an
 * option (issue #1681 PR review).
 *
 * Moving the ARN build outside the create `try` stops a failure being
 * re-labelled as a creation failure — but on its own it does NOT stop the
 * resource being orphaned: `create()` still throws, the engine still journals
 * no physicalId for a failed CREATE, and the resource still sits in AWS
 * untracked (the issue #1710 class). Since the ARN is bookkeeping and the
 * resource already exists, the honest answer is to never fail the create for
 * it: warn, omit the attribute, and let `Ref` fall back to the compound id
 * exactly as it does for an imported child. The resource's next update heals
 * the record via `childRefAttributes`.
 */
export async function buildAppSyncArnOrWarn(
  this: AppSyncProvider,
  suffix: string,
  logicalId: string,
  physicalId: string
): Promise<string | undefined> {
  try {
    return await this.buildAppSyncArn(suffix);
  } catch (error) {
    this.logger.warn(
      `Created ${logicalId} (${physicalId}) but could not build its ARN attribute: ` +
        `${describeAwsFailure(error).detail}. ` +
        `Ref will resolve to the compound physical id until the next update.`
    );
    return undefined;
  }
}

/**
 * Rebuild a child type's COMPLETE attribute set from its compound physical id
 * (issue #1681), for the update path to return.
 *
 * This is what heals a record written by a pre-#1681 binary. `update()`
 * previously returned no attributes, and the deploy engine carries the
 * existing ones forward when a provider reports none — so without this a
 * resource created before the fix would keep its `arn:aws:appsync:*:*:...`
 * placeholder for the rest of its life, since only a REPLACEMENT re-runs
 * `create()`. `Fn::GetAtt` reads the same cached map, so the placeholder was
 * breaking that intrinsic too, independently of the `Ref` defect #1681 is
 * about.
 *
 * It must return EVERY key the create path records, not just the ARN: an
 * `attributes` map returned from `update()` REPLACES the record's map
 * wholesale rather than merging into it (`deploy-engine.ts`), so a partial
 * answer would silently drop `Name` / `ApiKey`.
 *
 * Returns `undefined` for an id whose arity does not match the type — a
 * record that malformed cannot be healed by guessing, and carrying the
 * existing attributes forward is the safe answer.
 *
 * `omitArnOnFailure` is for the IMPORT path only (issue #1728 review). The
 * non-ARN keys — `Name`, `ApiKey` — are split straight out of the physical id
 * and involve no account at all, so dropping them because the ACCOUNT could
 * not be resolved would fail `Fn::GetAtt Name` for a reason that has nothing
 * to do with it. Import has no prior record to preserve, so keeping what it
 * can beats keeping nothing. `update()` must NOT pass it: there a partial map
 * replaces the record's wholesale and would delete a good ARN.
 */
export async function childRefAttributes(
  this: AppSyncProvider,
  resourceType: string,
  physicalId: string,
  regionOverride?: string,
  omitArnOnFailure = false
): Promise<Record<string, unknown> | undefined> {
  const parts = physicalId.split('|');
  // An ApiKey id's key segment is the credential (go-to-k/cdkd#5860).
  const shownId = displayAppSyncPhysicalId(resourceType, physicalId);
  // Resolves to the ARN, or to `undefined` when the build refused AND the
  // caller opted into omitting it. A refusal with the flag unset propagates.
  const arn = async (suffix: string): Promise<string | undefined> => {
    try {
      return await this.buildAppSyncArn(suffix, regionOverride);
    } catch (error) {
      if (!omitArnOnFailure) throw error;
      this.logger.warn(
        `Imported ${resourceType} (${shownId}) but its ARN attribute was NOT ` +
          `recorded: ${describeAwsFailure(error).detail}. ` +
          `Ref will resolve to the compound physical id, and Fn::GetAtt on the ARN ` +
          `will fail, until the resource's next update — or a later deploy that needs the ` +
          `attribute and re-reads it from AWS — heals the record.`
      );
      return undefined;
    }
  };
  if (resourceType === 'AWS::AppSync::DataSource' && parts.length === 2) {
    const [apiId, name] = parts as [string, string];
    const dataSourceArn = await arn(`apis/${apiId}/datasources/${name}`);
    return { ...(dataSourceArn && { DataSourceArn: dataSourceArn }), Name: name };
  }
  if (resourceType === 'AWS::AppSync::Resolver' && parts.length === 3) {
    const [apiId, typeName, fieldName] = parts as [string, string, string];
    const resolverArn = await arn(`apis/${apiId}/types/${typeName}/resolvers/${fieldName}`);
    return { ...(resolverArn && { ResolverArn: resolverArn }) };
  }
  if (resourceType === 'AWS::AppSync::ApiKey' && parts.length === 2) {
    const [apiId, apiKeyId] = parts as [string, string];
    const apiKeyArn = await arn(`apis/${apiId}/apikeys/${apiKeyId}`);
    // `ApiKeyId` is CloudFormation's own attribute for the same value as
    // `ApiKey` (issue #6238); both are the key credential.
    return { ApiKey: apiKeyId, ApiKeyId: apiKeyId, ...(apiKeyArn && { Arn: apiKeyArn }) };
  }
  return undefined;
}

/**
 * The no-replacement update result for a child type, carrying the healed
 * attribute set (issue #1681). Reporting none is still the correct answer for
 * an unhealable id — the engine then carries the existing attributes forward.
 *
 * An ARN that cannot be built takes the SAME answer, and it must (issue #1728
 * review). An `update()` attribute map REPLACES the record's wholesale, so
 * reporting a partial set here would DELETE the ARN a previous deploy
 * correctly recorded; reporting none carries it forward untouched. That is
 * why this arm differs from the import one below, which has no prior record
 * to preserve and therefore keeps what it can.
 */
export async function childUpdateResult(
  this: AppSyncProvider,
  resourceType: string,
  physicalId: string,
  // The composite physical id can carry a secret-derived name
  // (go-to-k/cdkd#4275); absent means unmasked.
  mask: MaskerFn = maskerOrIdentity(undefined)
): Promise<ResourceUpdateResult> {
  let attributes: Record<string, unknown> | undefined;
  try {
    attributes = await this.childRefAttributes(resourceType, physicalId);
  } catch (error) {
    this.logger.warn(
      mask(
        `Updated ${resourceType} (${displayAppSyncPhysicalId(resourceType, physicalId)}) but could not rebuild its ARN attribute: ` +
          `${describeAwsFailure(error).detail}. ` +
          `The previously recorded attributes are kept.`
      )
    );
  }
  return { physicalId, wasReplaced: false, ...(attributes && { attributes }) };
}

/**
 * The child attribute set for an ADOPTED resource (issue #1728).
 *
 * `import()` used to record `attributes: {}` for every child type, so a child
 * adopted via `cdkd import` had no ARN in state and the resolver's
 * `REF_RETURNS_ARN_FROM_STATE` lookup missed — `Ref` fell back to the raw
 * compound id, i.e. the pre-#1681 behavior, and `Fn::GetAtt DataSourceArn` /
 * `ResolverArn` / `Arn` were equally unresolved. The record healed only on the
 * resource's next UPDATE (#1727), so an imported-and-untouched child stayed
 * broken indefinitely.
 *
 * RECONSTRUCTED rather than read back from AWS. Every segment is already in
 * the physical id the import receives, `childRefAttributes` is the SAME
 * mapping `create()` / `update()` use (so the three spellings cannot drift),
 * and the reconstruction costs one process-cached STS call instead of one
 * DescribeApi-family call per imported child. A readback would be
 * authoritative but cannot be more correct for a well-formed id: `import`
 * adopts a resource in the caller's own account, which is exactly the context
 * `buildAppSyncArn` derives from.
 *
 * Never throws: a failure degrades to `{}` (or to the account-independent
 * keys — see `omitArnOnFailure`), which is at worst the exact pre-#1728
 * behavior, because adopting the resource is worth more than its bookkeeping
 * attribute. `childRefAttributes` already answers `undefined` for a mis-arity
 * id, which degrades the same way rather than guessing.
 *
 * When STS cannot name the account, `getAccountInfo` rejects inside
 * `buildAppSyncArn` (issue #1730), which lands in the catch below.
 */
export async function childImportAttributes(
  this: AppSyncProvider,
  resourceType: string,
  physicalId: string,
  region: string
): Promise<Record<string, unknown>> {
  try {
    // The region comes from the IMPORT input, not from the client: it is the
    // region `import.ts` keys the state record by, so the ARN always names
    // the record's region. Since go-to-k/cdkd#2100 the providers' clients
    // are built for that region too, so the two no longer disagree.
    //
    // `omitArnOnFailure`: an unknown account costs the ARN, not the whole
    // attribute set — `Name` / `ApiKey` come out of the physical id and are
    // account-independent.
    return (await this.childRefAttributes(resourceType, physicalId, region, true)) ?? {};
  } catch (error) {
    this.logger.warn(
      `Imported ${resourceType} (${displayAppSyncPhysicalId(resourceType, physicalId)}) ` +
        `but could not build its ARN attribute: ` +
        `${describeAwsFailure(error).detail}. ` +
        `Ref will resolve to the compound physical id, and Fn::GetAtt on the ARN will ` +
        `fail, until the resource's next update — or a later deploy that needs the ` +
        `attribute and re-reads it from AWS — heals the record.`
    );
    return {};
  }
}

/**
 * Lazy S3 client for the `*S3Location` properties (Resolver
 * `CodeS3Location` / `RequestMappingTemplateS3Location` /
 * `ResponseMappingTemplateS3Location`, GraphQLSchema
 * `DefinitionS3Location`) — CloudFormation reads the S3 object and inlines
 * its body, and cdkd mirrors that. Same construction as
 * `StepFunctionsProvider.getS3Client` (the sibling `DefinitionS3Location`
 * implementation).
 */
export function getS3Client(this: AppSyncProvider): S3Client {
  if (!this.s3Client) {
    this.s3Client = new S3Client({
      ...ambientClientDefaults(),
      ...s3ClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.s3Client;
}
