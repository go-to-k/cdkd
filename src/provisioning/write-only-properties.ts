/**
 * Write-only property resolution for Cloud Control API updates (issue #809).
 *
 * Cloud Control API applies UPDATE patch documents with read-modify-write
 * semantics: the type's read handler returns the current model, the patch is
 * applied on top, and the result becomes the desired state handed to the
 * update handler. Read handlers cannot return write-only properties, so any
 * write-only property that is not explicitly present in the patch document
 * vanishes from the desired state on every CC-routed UPDATE (e.g.
 * `AWS::ECS::Service` loses `VolumeConfigurations` and the update hard-fails;
 * for other types the loss is silent).
 *
 * This module resolves each resource type's `writeOnlyProperties` from the
 * CloudFormation registry schema via `cloudformation:DescribeType`, reduced
 * to the TOP-LEVEL containing property names (a nested path like
 * `/properties/Foo/Bar` strips to `Foo` — re-adding the whole containing
 * property is sufficient and matches terraform-provider-awscc's approach of
 * clearing write-only attribute paths in the prior state so the patch
 * generator always emits `add` ops for them). Two kinds of UNCHANGED key are
 * the exception: one whose value holds a create-only path overlapping a
 * write-only one ({@link getTopLevelKeysHoldingUnreadableCreateOnly},
 * go-to-k/cdkd#4416), and one the type's handler keeps without it and acts on
 * when it is re-sent ({@link getWriteOnlyKeysKeptWhenOmitted},
 * go-to-k/cdkd#6709).
 *
 * Only SUCCESSFUL lookups are cached per resource type for the process
 * (deploy) lifetime — `cloudformation:DescribeType` is throttled per-account,
 * and the schema cannot change mid-deploy. A FAILED lookup (missing IAM
 * permission, transient throttle / 5xx) is logged as a warning and resolves
 * to an empty set WITHOUT poisoning the cache, so the caller gracefully falls
 * back to the minimal patch for THIS update while a later update of the same
 * type retries `DescribeType`. Caching failures would let a single transient
 * throttle on the first CC-routed UPDATE silently disable write-only
 * re-inclusion for every CC-routed type for the rest of the deploy —
 * reintroducing the exact hard-fail this module fixes. No regression for
 * callers permanently without the `cloudformation:DescribeType` permission:
 * each update simply re-warns and re-falls-back.
 */

import { isDeepStrictEqual } from 'node:util';
import {
  describeTypeWithThrottleRetry,
  hasNoRegistrySchema,
  isAwsEmulatorRegistryMiss,
  reportAwsEmulatorRegistryMiss,
} from './describe-type.js';
import { parseCreateOnlyPropertyPointers } from './create-only-paths.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { getLogger } from '../utils/logger.js';
import { parseJsonNamingNoBody } from '../utils/json-parse-failure.js';
import { safeMsg } from '../utils/display-safe.js';

/**
 * Per-type cache of SUCCESSFUL lookups only. The value is the in-flight (or
 * settled) promise so that concurrent updates of the same resource type share
 * a single DescribeType call. A failed lookup removes its own entry so a
 * later call retries instead of being permanently poisoned by a transient
 * throttle / 5xx.
 */
const writeOnlyPropertiesCache = new Map<string, Promise<ReadonlySet<string>>>();

/**
 * The SETTLED successes of either lookup variant, per type. What
 * {@link tryGetTopLevelWriteOnlyProperties} reads first: unlike the promise
 * cache it never holds an in-flight lookup, whose failure would read as "none".
 */
const settledWriteOnlyProperties = new Map<string, ReadonlySet<string>>();

/**
 * Per settled success, the create-only paths a write-only path covers, read
 * from the same DescribeType schema, for
 * {@link getTopLevelKeysHoldingUnreadableCreateOnly}.
 */
const settledUnreadableCreateOnlyPaths = new Map<string, ReadonlyArray<readonly string[]>>();

/**
 * Per settled success, every write-only path as segments under `properties`
 * (`*` for an array element), for {@link getSettledWriteOnlyPropertyPaths}.
 */
const settledWriteOnlyPaths = new Map<string, ReadonlyArray<readonly string[]>>();

/**
 * Clear the per-type cache. Test-only helper.
 */
export function clearWriteOnlyPropertiesCache(): void {
  writeOnlyPropertiesCache.clear();
  settledWriteOnlyProperties.clear();
  settledUnreadableCreateOnlyPaths.clear();
  settledWriteOnlyPaths.clear();
}

/**
 * Resolve the TOP-LEVEL write-only property names for a resource type.
 *
 * Never throws: a DescribeType failure logs a warning and resolves to an
 * empty set (graceful fallback to the minimal patch). Only SUCCESSFUL
 * lookups are cached per resource type for the process lifetime; a failed
 * lookup is NOT cached, so a later call for the same type retries
 * DescribeType (a transient throttle must not poison the deploy).
 */
export function getTopLevelWriteOnlyProperties(resourceType: string): Promise<ReadonlySet<string>> {
  // Same schema-less short-circuit the sibling create-only resolver applies
  // ({@link hasNoRegistrySchema}): a type with no registry entry can only
  // produce a failed DescribeType plus a misleading "grant
  // cloudformation:DescribeType" warning. Defense-in-depth — today the CC
  // read-modify-write update path is the only caller and never routes a
  // custom resource / metadata sentinel there — so this shares the ONE list
  // rather than letting a future caller re-introduce the same waste.
  if (hasNoRegistrySchema(resourceType)) {
    return Promise.resolve(new Set<string>());
  }
  const cached = writeOnlyPropertiesCache.get(resourceType);
  if (cached) {
    return cached;
  }
  const entry = fetchTopLevelWriteOnlyProperties(resourceType)
    .then((result) => {
      settledWriteOnlyProperties.set(resourceType, result);
      return result;
    })
    .catch((error) => {
      // The lookup failed: drop the in-flight entry so a later call retries,
      // warn (once per failure), and fall back to an empty set for this call.
      writeOnlyPropertiesCache.delete(resourceType);
      // Under --aws-emulator a type the emulator's registry lacks is no
      // permission problem: one info line per run, not a warning per type (#6249).
      if (isAwsEmulatorRegistryMiss(error)) {
        reportAwsEmulatorRegistryMiss(resourceType, 'updates use a minimal patch');
        return new Set<string>();
      }
      const message = describeAwsFailure(error).detail;
      getLogger()
        .child('WriteOnlyProperties')
        .warn(
          `Failed to resolve write-only properties for ${resourceType} via ` +
            `cloudformation:DescribeType (${message}). Falling back to a minimal ` +
            `update patch — write-only properties (if any) may be dropped by the ` +
            `Cloud Control read-modify-write update. Grant cloudformation:DescribeType ` +
            `to enable write-only property re-inclusion.`
        );
      return new Set<string>();
    });
  writeOnlyPropertiesCache.set(resourceType, entry);
  return entry;
}

/**
 * {@link getTopLevelWriteOnlyProperties} for a caller that must tell "none"
 * from "unknown" (go-to-k/cdkd#3803): `undefined` when the lookup failed,
 * which that function reports as an empty set. Warns nothing (the other
 * variant's warning describes the Cloud Control update path). It reads and
 * writes the settled successes both variants record, and caches only a
 * success. It does not join the other variant's in-flight lookup, whose
 * failure would read as "none".
 */
export async function tryGetTopLevelWriteOnlyProperties(
  resourceType: string
): Promise<ReadonlySet<string> | undefined> {
  if (hasNoRegistrySchema(resourceType)) return new Set<string>();
  const settled = settledWriteOnlyProperties.get(resourceType);
  if (settled) return settled;
  try {
    const result = await fetchTopLevelWriteOnlyProperties(resourceType);
    settledWriteOnlyProperties.set(resourceType, result);
    if (!writeOnlyPropertiesCache.has(resourceType)) {
      writeOnlyPropertiesCache.set(resourceType, Promise.resolve(result));
    }
    return result;
  } catch {
    return undefined;
  }
}

/**
 * Fetch + parse the type's write-only properties. THROWS on a DescribeType
 * failure — the caller (`getTopLevelWriteOnlyProperties`) catches, warns, and
 * declines to cache so the lookup can be retried later.
 */
async function fetchTopLevelWriteOnlyProperties(
  resourceType: string
): Promise<ReadonlySet<string>> {
  const logger = getLogger().child('WriteOnlyProperties');
  // Throttle-shaped DescribeType failures are retried with backoff (issue
  // #1236) — the graceful empty-set fallback below is safe for a missing
  // permission but converts a transient throttle into a dropped write-only
  // property, which hard-fails CC-routed updates of types like
  // AWS::ECS::Service.
  const response = await describeTypeWithThrottleRetry(resourceType);

  const result = new Set<string>();
  const paths: string[][] = [];
  const unreadableCreateOnlyPaths: string[][] = [];
  // A response without a Schema (e.g. a still-registering / publisher type)
  // carries no writeOnlyProperties to extract; treat it as "none" without a
  // warning — it is a successful, cacheable lookup, not a failure.
  if (response.Schema) {
    const parsed = parseRegistrySchema(resourceType, response.Schema) as {
      writeOnlyProperties?: unknown;
      createOnlyProperties?: unknown;
    };
    const writeOnly = parsed.writeOnlyProperties;
    if (Array.isArray(writeOnly)) {
      for (const path of writeOnly) {
        if (typeof path !== 'string') continue;
        // Schema entries are JSON pointers like "/properties/Foo" or
        // nested "/properties/Foo/Bar" — keep only the top-level
        // containing property name.
        const match = /^\/properties\/([^/]+)/.exec(path);
        if (match?.[1]) {
          result.add(unescapeJsonPointerSegment(match[1]));
          paths.push(
            path
              .slice('/properties/'.length)
              .split('/')
              .filter((segment) => segment.length > 0)
              .map(unescapeJsonPointerSegment)
          );
        }
      }
    }
    for (const createOnly of parseCreateOnlyPropertyPointers(parsed.createOnlyProperties)) {
      if (
        paths.some(
          (writeOnly) => pathCovers(writeOnly, createOnly) || pathCovers(createOnly, writeOnly)
        )
      ) {
        unreadableCreateOnlyPaths.push(createOnly);
      }
    }
  }

  settledUnreadableCreateOnlyPaths.set(resourceType, unreadableCreateOnlyPaths);
  settledWriteOnlyPaths.set(resourceType, paths);
  logger.debug(
    `Resolved ${result.size} top-level write-only properties for ${resourceType}` +
      (result.size > 0 ? `: ${[...result].join(', ')}` : '')
  );
  return result;
}

/**
 * The top-level keys of `properties` whose value holds a create-only path the
 * read handler cannot return whole, because it overlaps a write-only path
 * (go-to-k/cdkd#4416). Either direction: the write-only path covers it
 * (`AWS::Cognito::ManagedLoginBranding` `ClientId`; an `AWS::Pipes::Pipe`
 * `SourceParameters` holding the create-only
 * `KinesisStreamParameters/StartingPosition`), or it holds a write-only leaf
 * (`AWS::CodePipeline::CustomActionType` `Settings` /
 * `ThirdPartyConfigurationUrl`).
 *
 * Cloud Control refuses any patch that brings such a value into the model it
 * read, unchanged or not ("createOnlyProperties [...] cannot be updated";
 * measured on all three types), so `CloudControlProvider.update` must not
 * re-add an unchanged one. Judged on the VALUE, not the schema alone: an
 * SQS-source pipe's `SourceParameters` holds no such path, and re-adding it is
 * what keeps it.
 *
 * Read from the schema {@link getTopLevelWriteOnlyProperties} fetched, so call
 * it after that lookup resolved; a failed lookup yields an empty set.
 */
export function getTopLevelKeysHoldingUnreadableCreateOnly(
  resourceType: string,
  properties: Record<string, unknown>
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const path of settledUnreadableCreateOnlyPaths.get(resourceType) ?? []) {
    if (holdsValueAt(properties, path)) result.add(path[0]!);
  }
  return result;
}

/**
 * go-to-k/cdkd#6709: write-only top-level keys the type's update handler keeps
 * when a patch omits them, and ACTS ON when a patch re-sends them unchanged.
 * `AWS::Lambda::Function` `Code`: a patch without it left the code in place,
 * while one re-adding the same value made the handler call
 * `UpdateFunctionCode` (measured on a container image on Lambda Managed
 * Instances and on an inline zip). A CloudFormation stack update changing only
 * `FunctionScalingConfig` on the Managed Instances image function made no such
 * call, so leaving the key out in that case serves parity and speed alike.
 *
 * Each key maps to the sibling keys it must still TRAVEL WITH: a change to one
 * of those re-adds the unchanged key as before. `Architectures` is a parameter
 * of Lambda's `UpdateFunctionCode`, not of `UpdateFunctionConfiguration`: a
 * Cloud Control patch changing it without `Code` fails with Lambda's 400
 * "Please provide a source for function code", while the same patch with
 * `Code` re-added succeeds (measured on an inline zip function, x86_64 ->
 * arm64, go-to-k/cdkd#6709).
 *
 * go-to-k/cdkd#6788 measured the rest the same way (us-east-1, CloudTrail per
 * update): a patch changing only an unrelated property (usually `Tags`)
 * succeeded and kept the value, while the same patch re-adding the unchanged
 * key either made the handler call the API noted beside the entry or made the
 * update fail. A sibling listed beside one of them was NOT measured: it names
 * a property the service may need with the key (an API that takes both
 * together, or one that decides how the key applies), so a change to it keeps
 * today's re-send.
 *
 * Require handler measurements before adding an entry, or before dropping a
 * sibling. Readback omits write-only values, so omitting them from a Cloud
 * Control patch can lose them (go-to-k/cdkd#809).
 */
const WRITE_ONLY_KEYS_KEPT_WHEN_OMITTED: ReadonlyMap<
  string,
  ReadonlyMap<string, readonly string[]>
> = new Map<string, ReadonlyMap<string, readonly string[]>>([
  ['AWS::Lambda::Function', new Map([['Code', ['Architectures']]])],
  // Re-send called UpdateBroker + UpdateUser + RebootBroker (196 s vs 1 s).
  // Beside the other write-only keys re-added: 6 s, broker unchanged, vs 209 s.
  [
    'AWS::AmazonMQ::Broker',
    new Map([
      ['Users', []],
      ['Configuration', []],
      ['EngineVersion', []],
    ]),
  ],
  // Re-send called UpdateAppAuthorization.
  ['AWS::AppFabric::AppAuthorization', new Map([['Credential', []]])],
  // Re-send FAILED on a Fargate environment ("parameters can't be updated for
  // Fargate compute environment"). An infrastructure update, which these two
  // govern on EC2, comes only from a `ComputeResources` change. That key is
  // itself write-only, so while declared it keeps both re-sent, except on a
  // Fargate environment ({@link KEPT_WHATEVER_SIBLING_CHANGED}).
  [
    'AWS::Batch::ComputeEnvironment',
    new Map([
      ['ReplaceComputeEnvironment', ['ComputeResources']],
      ['UpdatePolicy', ['ComputeResources']],
    ]),
  ],
  // Re-send called UpdateApiKeyCredentialProvider and wrote a new Secrets
  // Manager secret version.
  [
    'AWS::BedrockAgentCore::ApiKeyCredentialProvider',
    new Map([['ApiKey', ['ApiKeySecretConfig', 'ApiKeySecretSource']]]),
  ],
  // Re-send called UpdateOauth2CredentialProvider and wrote a new secret version.
  ['AWS::BedrockAgentCore::OAuth2CredentialProvider', new Map([['Oauth2ProviderConfigInput', []]])],
  // Re-send FAILED: the read model holds `Definition`, and the handler refuses
  // both ("only one of Definition, DefinitionString or DefinitionS3Location").
  ['AWS::Bedrock::Flow', new Map([['DefinitionString', ['DefinitionSubstitutions']]])],
  // Re-send FAILED ("is not updatable with parameters provided").
  ['AWS::CloudFront::KeyValueStore', new Map([['ImportSource', []]])],
  // Re-send FAILED ("Password cannot be updated.").
  ['AWS::Connect::User', new Map([['Password', []]])],
  // Re-send called ModifyEndpoint. Beside the other write-only keys re-added,
  // mysql and sqlserver endpoints updated and stayed active without it.
  ['AWS::DMS::Endpoint', new Map([['Password', []]])],
  // Re-send rewrote the location's managed secret (Secrets Manager UpdateSecret).
  [
    'AWS::DataSync::LocationAzureBlob',
    new Map([
      [
        'AzureBlobSasConfiguration',
        ['AzureBlobAuthenticationType', 'CmkSecretConfig', 'CustomSecretConfig'],
      ],
    ]),
  ],
  // Re-send called UpdateCluster (37 s vs 2 s).
  ['AWS::DocDBElastic::Cluster', new Map([['AdminUserPassword', []]])],
  // Re-send called ModifyVpnTunnelOptions per tunnel (427 s vs 2 s).
  ['AWS::EC2::VPNConnection', new Map([['VpnTunnelOptionsSpecifications', []]])],
  // Re-send called ModifyReplicationGroup with the token (67 s vs 35 s).
  // Beside the other write-only keys re-added (their own ModifyReplicationGroup),
  // it only adds `authToken`; omitted, AuthTokenLastModifiedDate stayed.
  ['AWS::ElastiCache::ReplicationGroup', new Map([['AuthToken', []]])],
  // Re-send called ModifyUser.
  [
    'AWS::ElastiCache::User',
    new Map([['Passwords', ['AuthenticationMode', 'NoPasswordRequired']]]),
  ],
  // Re-send ran an extra configuration deployment. A configuration template
  // or platform change may reapply settings the options override.
  [
    'AWS::ElasticBeanstalk::Environment',
    new Map([['OptionSettings', ['TemplateName', 'PlatformArn']]]),
  ],
  // Re-send called UpdateStorageVirtualMachine.
  ['AWS::FSx::StorageVirtualMachine', new Map([['SvmAdminPassword', []]])],
  // Re-send called UpdateApplication: a running Flink application restarted
  // and took a snapshot (138-156 s vs 3 s); a Zeppelin one FAILED. Each
  // travels with the other: `RunConfiguration` sent alone FAILED (the handler
  // sent the read model's checkpoint values), and `ApplicationConfiguration`
  // sent alone restarted without the declared restore settings
  // (go-to-k/cdkd#6821).
  [
    'AWS::KinesisAnalyticsV2::Application',
    new Map([
      [
        'ApplicationConfiguration',
        ['RunConfiguration', 'RuntimeEnvironment', 'ServiceExecutionRole'],
      ],
      [
        'RunConfiguration',
        ['ApplicationConfiguration', 'RuntimeEnvironment', 'ServiceExecutionRole'],
      ],
    ]),
  ],
  // Re-send called UpdateUser.
  ['AWS::MemoryDB::User', new Map([['AuthenticationMode', []]])],
  // Re-send called ModifyCluster with the password (407 s vs 8 s).
  ['AWS::Redshift::Cluster', new Map([['MasterUserPassword', ['ManageMasterPassword']]])],
  // Re-send made UpdateNamespace re-set the admin password. UpdateNamespace
  // takes `adminUsername` and `adminUserPassword` together.
  [
    'AWS::RedshiftServerless::Namespace',
    new Map([['AdminUserPassword', ['AdminUsername', 'ManageAdminPassword']]]),
  ],
  // Re-send called UpdateFirewallDomains (REPLACE).
  ['AWS::Route53Resolver::FirewallDomainList', new Map([['Domains', ['DomainFileUrl']]])],
  // Re-send FAILED: the read model holds `RoutingConfiguration` ("Specify
  // exactly one of 'RoutingConfiguration' or 'DeploymentPreference'").
  ['AWS::StepFunctions::StateMachineAlias', new Map([['DeploymentPreference', []]])],
  // Re-send called the canary Lambda's UpdateFunctionCode. Beside the other
  // write-only keys re-added: 25 s, code layer and CodeSha256 unchanged.
  ['AWS::Synthetics::Canary', new Map([['Code', ['RuntimeVersion']]])],
]);

/**
 * Types whose row's keys stay out while UNCHANGED whatever sibling changed,
 * when both sides pass the check. A Fargate (`FARGATE` / `FARGATE_SPOT`) Batch
 * compute environment refused either key beside a `ComputeResources` change
 * too, and it has no infrastructure update for them to govern
 * (go-to-k/cdkd#6822).
 */
const KEPT_WHATEVER_SIBLING_CHANGED: ReadonlyMap<
  string,
  (properties: Record<string, unknown>) => boolean
> = new Map([['AWS::Batch::ComputeEnvironment', isFargateComputeEnvironment]]);

function isFargateComputeEnvironment(properties: Record<string, unknown>): boolean {
  const resources = properties['ComputeResources'];
  if (typeof resources !== 'object' || resources === null) return false;
  const type = (resources as Record<string, unknown>)['Type'];
  return type === 'FARGATE' || type === 'FARGATE_SPOT';
}

/**
 * Keys of {@link WRITE_ONLY_KEYS_KEPT_WHEN_OMITTED} whose handler refuses ANY
 * value on update, changed or not (go-to-k/cdkd#6820): a Connect user's
 * `Password` fails with "Password cannot be updated." whether re-sent or
 * changed (measured, us-east-1). State keeps a secret-derived one as its
 * `{{resolve:...}}` expression while the desired bag holds the resolved value,
 * so the two never compare equal; `CloudControlProvider.update` reads a
 * difference in secret references alone as unchanged for these keys, so a
 * rotated secret (same reference) is not re-sent, as CloudFormation sends
 * nothing for an unchanged template. A RE-POINTED reference is told apart one
 * layer up: the deploy engine compares the as-written values and refuses it
 * before any call ({@link movedReferencesRefusedOnUpdate}). A path without that
 * comparison (a rollback replay, `drift --revert`) keeps the omission.
 * Listing a key not also in `WRITE_ONLY_KEYS_KEPT_WHEN_OMITTED` is inert.
 */
const WRITE_ONLY_KEYS_REFUSED_ON_UPDATE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['AWS::Connect::User', new Set(['Password'])],
]);

/** Whether the handler of `resourceType` refuses `key` on every update. */
export function isWriteOnlyKeyRefusedOnUpdate(resourceType: string, key: string): boolean {
  return WRITE_ONLY_KEYS_REFUSED_ON_UPDATE.get(resourceType)?.has(key) === true;
}

/** `<type>:<key>` pairs refused on update but not kept when omitted (inert rows). */
export function refusedOnUpdateKeysNotKeptWhenOmitted(): string[] {
  return [...WRITE_ONLY_KEYS_REFUSED_ON_UPDATE].flatMap(([type, keys]) =>
    [...keys]
      .filter((key) => WRITE_ONLY_KEYS_KEPT_WHEN_OMITTED.get(type)?.has(key) !== true)
      .map((key) => `${type}:${key}`)
  );
}

/**
 * The keys of {@link WRITE_ONLY_KEYS_REFUSED_ON_UPDATE} whose AS-WRITTEN value
 * (the `{{resolve:...}}` spelling state records) differs between the template
 * and the record while either side holds a dynamic reference: the template
 * points at another secret, which no update can apply and which
 * `CloudControlProvider.update` would otherwise leave out silently (the record
 * would name the new secret while AWS keeps the old password). A changed
 * literal is not returned: it is sent, and AWS refuses it visibly. Nor is a key
 * absent from either side.
 */
export function movedReferencesRefusedOnUpdate(
  resourceType: string,
  desiredAsWritten: Record<string, unknown>,
  recordedAsWritten: Record<string, unknown>
): string[] {
  const keys = WRITE_ONLY_KEYS_REFUSED_ON_UPDATE.get(resourceType);
  if (keys === undefined) return [];
  const holdsReference = (value: unknown): boolean =>
    JSON.stringify(value)?.includes('{{resolve:') === true;
  return [...keys].filter((key) => {
    const desired = desiredAsWritten[key];
    const recorded = recordedAsWritten[key];
    if (desired === undefined || recorded === undefined) return false;
    if (isDeepStrictEqual(desired, recorded)) return false;
    return holdsReference(desired) || holdsReference(recorded);
  });
}

/**
 * The write-only top-level keys of `resourceType` that
 * `CloudControlProvider.update` must not re-add while UNCHANGED
 * (go-to-k/cdkd#6709, go-to-k/cdkd#6788). A changed one is still re-added:
 * that is the update.
 * A key is left out of the result when a sibling it travels with differs
 * between the two sides, so the caller re-adds it for that update. So is a
 * key whose sibling is itself write-only and declared in `properties`
 * (`writeOnly`, the type's top-level write-only keys) and not itself in the
 * result: the caller re-adds that sibling, and the sibling sent without the
 * key is a patch no one measured (go-to-k/cdkd#6788). A type in
 * {@link KEPT_WHATEVER_SIBLING_CHANGED} whose two sides pass its check names
 * its whole row (go-to-k/cdkd#6822).
 */
export function getWriteOnlyKeysKeptWhenOmitted(
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  writeOnly: ReadonlySet<string> = new Set()
): ReadonlySet<string> {
  const row = WRITE_ONLY_KEYS_KEPT_WHEN_OMITTED.get(resourceType);
  if (row === undefined) return new Set();
  const keptWhateverChanged = KEPT_WHATEVER_SIBLING_CHANGED.get(resourceType);
  if (keptWhateverChanged?.(properties) && keptWhateverChanged(previousProperties)) {
    return new Set(row.keys());
  }
  const result = new Set<string>();
  for (const [key, travelsWith] of row) {
    if (travelsWith.every((k) => isDeepStrictEqual(properties[k], previousProperties[k]))) {
      result.add(key);
    }
  }
  // Dropping a key re-adds it, which can re-add a key that travels with it.
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const key of result) {
      const reAddedSibling = row
        .get(key)!
        .some((k) => writeOnly.has(k) && properties[k] !== undefined && !result.has(k));
      if (reAddedSibling) {
        result.delete(key);
        dropped = true;
      }
    }
  }
  return result;
}

/**
 * Every key {@link getWriteOnlyKeysKeptWhenOmitted} can return for
 * `resourceType`, whatever its siblings: the keys whose `{{resolve:...}}`
 * tokens carry a send attestation and are written ahead of a rotated send
 * (go-to-k/cdkd#6824). Not a key refused on update
 * ({@link isWriteOnlyKeyRefusedOnUpdate}): a rotated value there is never
 * sent, so no write could attest the version AWS holds.
 */
export function writeOnlyKeysKeptWhenOmittedCandidates(resourceType: string): ReadonlySet<string> {
  return new Set(
    [...(WRITE_ONLY_KEYS_KEPT_WHEN_OMITTED.get(resourceType)?.keys() ?? [])].filter(
      (key) => !isWriteOnlyKeyRefusedOnUpdate(resourceType, key)
    )
  );
}

/**
 * Every write-only path of `resourceType` as segments under `properties` (`*`
 * for an array element), from the schema {@link getTopLevelWriteOnlyProperties}
 * or {@link tryGetTopLevelWriteOnlyProperties} fetched: call it after that
 * lookup resolved. `[]` when none settled. Keyed by type only, like every
 * cache here: a type's registry schema is taken to be the same in every
 * region, so the paths are whichever region's lookup settled first.
 */
export function getSettledWriteOnlyPropertyPaths(
  resourceType: string
): ReadonlyArray<readonly string[]> {
  return settledWriteOnlyPaths.get(resourceType) ?? [];
}

/** A value is present at `path` under `node`; `*` stands for every array element. */
function holdsValueAt(node: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return node !== undefined && node !== null;
  const [segment, ...rest] = path;
  if (segment === '*') {
    return Array.isArray(node) && node.some((element) => holdsValueAt(element, rest));
  }
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
  if (!Object.prototype.hasOwnProperty.call(node, segment!)) return false;
  return holdsValueAt((node as Record<string, unknown>)[segment!], rest);
}

/**
 * `prefix` equals or is an ancestor of `path`. Segments compare literally:
 * schemas spell an array element `*` on both sides.
 */
function pathCovers(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

/**
 * Unescape an RFC 6901 JSON Pointer segment (`~1` -> `/`, `~0` -> `~`).
 */
function unescapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * `JSON.parse` of a DescribeType `Schema`, whose failure names only its offset
 * and size (issue [#5254](https://github.com/go-to-k/cdkd/issues/5254)): the
 * caller's warning interpolates the thrown message.
 */
function parseRegistrySchema(resourceType: string, schema: string): unknown {
  return parseJsonNamingNoBody(schema, 'the DescribeType schema', (line) =>
    getLogger()
      .child('WriteOnlyProperties')
      .debug(safeMsg`${resourceType}: ${line}`)
  );
}
