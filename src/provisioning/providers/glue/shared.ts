import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  GlueClient,
  GetTagsCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type EncryptionConfiguration,
  type S3Encryption,
  type CloudWatchEncryption,
  type JobBookmarksEncryption,
} from '@aws-sdk/client-glue';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { getLogger } from '../../../utils/logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import {
  planTagDiff,
  refuseMalformedDesiredTags,
  tagMapAsList,
  tagPlanWarning,
} from '../../tag-list.js';
import { ambientRegion } from '../../../utils/stack-aws-scope.js';
import { derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';

// ─── Helpers (file-level) ──────────────────────────────────────────

/** Max GetCrawler polls while waiting for a stopped crawler to settle. */
export const CRAWLER_STOP_MAX_ATTEMPTS = 30;

/** Delay between GetCrawler polls while waiting for a crawler to stop. */
export const CRAWLER_STOP_POLL_INTERVAL_MS = 2000;

/** Max GetTrigger polls while waiting for a trigger to reach DEACTIVATED. */
export const TRIGGER_DEACTIVATE_MAX_ATTEMPTS = 30;

/** Delay between GetTrigger polls while waiting for a trigger to deactivate. */
export const TRIGGER_DEACTIVATE_POLL_INTERVAL_MS = 1000;

/** Promise-based sleep used by the crawler / trigger state-machine waiters. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Both spellings of the Iceberg table spec cdkd refuses inside
 * `OpenTableFormatInput.IcebergInput`: the CFn registry schema's
 * `IcebergTableInput` and `@aws-sdk/client-glue`'s `CreateIcebergTableInput`.
 * A hand-written template can carry either, and neither is deployable, so the
 * pre-flight matches both and names whichever it found.
 */
const ICEBERG_TABLE_INPUT_KEYS = ['IcebergTableInput', 'CreateIcebergTableInput'] as const;

/**
 * Return whichever {@link ICEBERG_TABLE_INPUT_KEYS} spelling the template
 * carries under `OpenTableFormatInput.IcebergInput`, or `undefined`.
 *
 * Non-object shapes at either level (an unresolved intrinsic) are treated as
 * "absent" so AWS surfaces the real validation error rather than this refusal.
 */
export function findIcebergTableInputKey(properties: Record<string, unknown>): string | undefined {
  const openTableFormatInput = properties['OpenTableFormatInput'];
  if (
    typeof openTableFormatInput !== 'object' ||
    openTableFormatInput === null ||
    Array.isArray(openTableFormatInput)
  ) {
    return undefined;
  }
  const iceberg = (openTableFormatInput as Record<string, unknown>)['IcebergInput'];
  if (typeof iceberg !== 'object' || iceberg === null || Array.isArray(iceberg)) {
    return undefined;
  }
  return ICEBERG_TABLE_INPUT_KEYS.find((key) => key in iceberg);
}

/**
 * PRE-FLIGHT REFUSAL of `AWS::Glue::Table`
 * `OpenTableFormatInput.IcebergInput.IcebergTableInput` (issue #1454).
 *
 * **This is a deliberate PARITY DIVERGENCE, and it was a conscious choice.**
 * cdkd's compatibility target is CloudFormation, and CloudFormation does not
 * validate this property — it forwards it and lets the deploy roll back. cdkd
 * refuses it EARLIER and with a better message instead. The justification is
 * that no user is losing a working deployment: the live probe on issue #1408
 * (2026-08-09, us-east-1 — 5 raw `glue:CreateTable` shapes plus 5
 * `AWS::Glue::Table` CloudFormation stacks) proved the property is undeployable
 * on BOTH paths.
 *
 * - **The raw `glue:CreateTable` API — the call cdkd itself makes** — rejects
 *   every `CreateIcebergTableInput` shape: without a
 *   `TableInput.StorageDescriptor` it fails `Location information cannot be
 *   null while creating an iceberg table`, and with one it fails `Table
 *   metadata information present at multiple parts of input request`. The
 *   spec's own `Location` is never read. So this is NOT merely cdkd declining
 *   what CloudFormation declines — cdkd's own path cannot deploy it either.
 * - **CloudFormation** rolls back all three variants with `Table metadata is
 *   expected only via TableInput or via IcebergTableInputProperties inside
 *   OpenTableFormatInput` — naming a property that exists in NEITHER the CFn
 *   registry schema (`IcebergInput.IcebergTableInput`) NOR
 *   `@aws-sdk/client-glue` (`IcebergInput.CreateIcebergTableInput`). That
 *   three-way contract mismatch is an AWS-side bug.
 *
 * Because there is no shape in which the property works, forwarding it can only
 * produce a late, cryptic AWS error. Failing fast with the working shape spelled
 * out is strictly more useful.
 *
 * **TEMPLATE creates only — every STATE REPLAY warns instead.** The refusal is
 * conditioned on the ORIGIN of the properties, not on the operation name:
 *
 * - `update()` warns unconditionally. Rollback replays from cdkd STATE, and a
 *   table created by a pre-#1390 build carries the key in its state record, so
 *   refusing there would make such a table unrollbackable with no
 *   template-side remedy. cdkd does not wire Glue's update-only
 *   `UpdateOpenTableFormatInput` shape and `buildTableInput` is an explicit
 *   allow-list, so warning forwards nothing and loses no protection.
 * - `create()` warns when {@link CreateContext.replayingState} is set — the
 *   rollback executor's reverse-replacement arm, which revives the OLD
 *   resource from `previousState.properties` (issue #1463). Same reasoning:
 *   the user cannot edit a state record from the template. Unlike the update
 *   path this one DOES forward the value, so the re-created table is degraded
 *   in exactly the way the original was (the CFn spelling is dropped by the
 *   SDK serializer per #1390; the SDK spelling is sent and Glue rejects it) —
 *   the warning says so, and the fix-forward is a `cdkd deploy`.
 * - Every deploy-engine `create()` refuses: the CREATE branch, the
 *   property-driven replacement, the `--recreate-via-*` destroy-then-create,
 *   the `--replace` delete-first fallback, and the update-failure replacement.
 *   All are driven by freshly resolved TEMPLATE properties, so the user CAN
 *   fix the input and a fast, actionable refusal is strictly better.
 *
 * The asymmetry constrains where this provider may re-create. `GlueProvider`
 * must never call `this.create()` from inside its own `update()` the way ACM /
 * IAM / Lambda-permission / SNS-subscription do: those internal re-creates
 * forward `update()`'s `properties` — a STATE record during a rollback replay —
 * and forward no `replayingState` (IAM role / IAM managed policy pass a
 * masker-only `CreateContext`, issue #2177), so this refusal would fire on a
 * replay with no way to detect it. (`update()` DOES take a context — an `UpdateContext` since
 * issue #1732 — and since issue #3141 that context carries its own
 * `replayingState`, set by the rollback executor's two revert arms. So the
 * information now reaches `update()`; what is missing is a re-create that
 * forwards it into a `CreateContext`, and none of those providers does. An
 * earlier revision said `update()` had "no context parameter to carry the
 * flag" — issue #1999.) Were GlueProvider ever to re-create inside `update()`,
 * it would have to forward a replay signal into that `create()` —
 * `context.replayingState` on the rollback path — and decide separately what
 * this refusal means for the `desiredFromAwsReadback` bag `cdkd drift --revert`
 * hands it, since that path sets no `replayingState`.
 *
 * **Known bypass: the sticky Cloud Control route.** This is a GlueProvider
 * pre-flight, so it only runs on the SDK route. When a table's state record
 * carries `provisionedBy: 'cc-api'`, `ProviderRegistry.getProviderFor` sticky-
 * routes it to `CloudControlProvider`, which forwards the property to
 * CloudFormation and gets AWS's rollback instead of this message. That route is
 * opt-in only (`--recreate-via-cc-api`, or a legacy state record) —
 * `AWS::Glue::Table` has an empty `sdkUnwired` map, so no ordinary deploy takes
 * it. The outcome there is still a failure, just a later and less helpful one,
 * which is why this is documented rather than duplicated into the CC provider.
 *
 * **WARNING before relaxing this refusal.** cdkd used to RENAME the CFn
 * `IcebergTableInput` to the SDK's `CreateIcebergTableInput` (issue #1390); that
 * rename existed because the AWS SDK v3 serializer DROPS unknown members, so the
 * CFn spelling silently discarded the entire Iceberg spec while `CreateTable`
 * reported success. The rename was removed here as unreachable once this
 * refusal landed. If AWS ever ships a deployable shape and this check is
 * relaxed, the rename MUST be restored in the same change — otherwise the
 * silent-drop bug of #1390 comes straight back.
 */
export function enforceIcebergTableInputAbsent(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  options: { warn: (message: string) => void; replayingState: boolean }
): void {
  const key = findIcebergTableInputKey(properties);
  if (key === undefined) {
    return;
  }
  if (options.replayingState) {
    options.warn(icebergTableInputRefusalMessage(logicalId, key, 'create-replay'));
    return;
  }
  throw new ProvisioningError(
    icebergTableInputRefusalMessage(logicalId, key, 'create'),
    resourceType,
    logicalId
  );
}

/**
 * The shared #1454 message body, so the CREATE refusal, the UPDATE warning and
 * the rollback-replay CREATE warning cannot drift apart. `mode` only changes
 * the lead clause — everything after it (the probe evidence and the working
 * shape) is identical, because the user's next action is the same either way.
 */
export function icebergTableInputRefusalMessage(
  logicalId: string,
  key: string,
  mode: 'create' | 'create-replay' | 'update'
): string {
  const lead =
    mode === 'create'
      ? `cannot be deployed by AWS in any shape, so cdkd refuses it before calling Glue.`
      : mode === 'create-replay'
        ? `cannot be deployed by AWS in any shape, so cdkd normally refuses it before calling ` +
          `Glue — but this create is REPLAYING a historical cdkd STATE record (a ` +
          `rollback reverse-replacement re-creating the OLD table), not your template, and ` +
          `refusing would leave that table unrestorable with no template-side remedy, only a ` +
          `hand-edit of state.json. cdkd therefore warns and proceeds. The ` +
          `re-created table is DEGRADED exactly as the original was: under the CFn spelling ` +
          `IcebergTableInput the AWS SDK serializer drops the unknown member, so ` +
          `the table comes back without its Iceberg metadata; under the SDK spelling ` +
          `CreateIcebergTableInput the value IS sent and Glue rejects the call, failing this ` +
          `one rollback operation. Either way, fix it forward with ${proseQuoted(cdkdRemedy('cdkd deploy'))} using the ` +
          `working shape below.`
        : `cannot be deployed by AWS in any shape and is IGNORED on update — cdkd does not wire ` +
          `Glue's update-only UpdateOpenTableFormatInput shape, so it forwards nothing here and ` +
          `only warns. A CREATE of this table would be refused outright.`;
  return (
    safeMsg`AWS::Glue::Table ${logicalId}: OpenTableFormatInput.IcebergInput.${key} ` +
    `${lead}\n` +
    `  Measured against AWS: glue:CreateTable — the API cdkd ` +
    `calls — rejects every Iceberg table spec ("Location information cannot be null while ` +
    `creating an iceberg table" without a TableInput.StorageDescriptor, "Table metadata ` +
    `information present at multiple parts of input request" with one), and CloudFormation ` +
    `rolls the same template back with "Table metadata is expected only via TableInput or ` +
    `via IcebergTableInputProperties inside OpenTableFormatInput" — a property name that ` +
    `exists in neither the CFn registry schema (IcebergInput.IcebergTableInput) nor ` +
    `@aws-sdk/client-glue (IcebergInput.CreateIcebergTableInput).\n` +
    `  Working shape — put the table metadata in TableInput and leave IcebergInput carrying ` +
    `only the create-time directive:\n` +
    `    TableInput: { Name, TableType: 'EXTERNAL_TABLE', StorageDescriptor: { Location: ` +
    `'s3://your-bucket/prefix/', Columns: [...] } }\n` +
    `    OpenTableFormatInput: { IcebergInput: { MetadataOperation: 'CREATE' } }   ` +
    `// Version: '2' is also accepted\n` +
    `  Glue then writes the Iceberg metadata itself — the created table comes back with ` +
    `Parameters.table_type = ICEBERG and a populated Parameters.metadata_location.`
  );
}

/**
 * Build the SDK `EncryptionConfiguration` from the CFn-shape input
 * (`AWS::Glue::SecurityConfiguration.EncryptionConfiguration`). Each
 * sub-config (`S3Encryptions[]` / `CloudWatchEncryption` /
 * `JobBookmarksEncryption`) maps to the SDK member names — `CloudWatchEncryption`
 * / `JobBookmarksEncryption` match verbatim, but the CFn `S3Encryptions` (plural)
 * list maps to the SDK `S3Encryption` (singular) field.
 */
export function buildEncryptionConfiguration(
  input: Record<string, unknown>
): EncryptionConfiguration {
  const result: EncryptionConfiguration = {};

  // CFn names this property `S3Encryptions` (PLURAL); the SDK input field is
  // `S3Encryption` (singular). Reading the singular CFn key silently dropped
  // S3 encryption on every create (CDK / a hand-authored template always emits
  // the plural form). CloudWatchEncryption / JobBookmarksEncryption ARE singular
  // in both CFn and the SDK, so only this one diverges.
  if (Array.isArray(input['S3Encryptions'])) {
    result.S3Encryption = input['S3Encryptions'].map((entry) => {
      const e = entry as Record<string, unknown>;
      const item: S3Encryption = {};
      if (typeof e['S3EncryptionMode'] === 'string') {
        item.S3EncryptionMode = e['S3EncryptionMode'] as S3Encryption['S3EncryptionMode'];
      }
      if (typeof e['KmsKeyArn'] === 'string') {
        item.KmsKeyArn = e['KmsKeyArn'];
      }
      return item;
    });
  }

  if (input['CloudWatchEncryption'] !== undefined) {
    const cw = input['CloudWatchEncryption'] as Record<string, unknown>;
    const item: CloudWatchEncryption = {};
    if (typeof cw['CloudWatchEncryptionMode'] === 'string') {
      item.CloudWatchEncryptionMode = cw[
        'CloudWatchEncryptionMode'
      ] as CloudWatchEncryption['CloudWatchEncryptionMode'];
    }
    if (typeof cw['KmsKeyArn'] === 'string') {
      item.KmsKeyArn = cw['KmsKeyArn'];
    }
    result.CloudWatchEncryption = item;
  }

  if (input['JobBookmarksEncryption'] !== undefined) {
    const jb = input['JobBookmarksEncryption'] as Record<string, unknown>;
    const item: JobBookmarksEncryption = {};
    if (typeof jb['JobBookmarksEncryptionMode'] === 'string') {
      item.JobBookmarksEncryptionMode = jb[
        'JobBookmarksEncryptionMode'
      ] as JobBookmarksEncryption['JobBookmarksEncryptionMode'];
    }
    if (typeof jb['KmsKeyArn'] === 'string') {
      item.KmsKeyArn = jb['KmsKeyArn'];
    }
    result.JobBookmarksEncryption = item;
  }

  return result;
}

/**
 * Reverse-map AWS's `EncryptionConfiguration` SDK shape into the CFn
 * shape with always-emit placeholders (PR #145):
 *   - `S3Encryptions[]` → `?? []` (so console-side ADD is detectable)
 *   - `CloudWatchEncryption` → `?? {}`
 *   - `JobBookmarksEncryption` → `?? {}`
 *   - `DataQualityEncryption` → silently dropped (not in CFn schema)
 */
export function mapEncryptionConfigurationToCfn(
  cfg: EncryptionConfiguration | undefined
): Record<string, unknown> {
  const c = cfg ?? {};
  return {
    // CFn shape uses `S3Encryptions` (plural) — see buildEncryptionConfiguration.
    S3Encryptions: (c.S3Encryption ?? []).map((entry) => {
      const out: Record<string, unknown> = {};
      if (entry.S3EncryptionMode !== undefined) out['S3EncryptionMode'] = entry.S3EncryptionMode;
      if (entry.KmsKeyArn !== undefined) out['KmsKeyArn'] = entry.KmsKeyArn;
      return out;
    }),
    CloudWatchEncryption: c.CloudWatchEncryption
      ? cleanCfnObject({
          CloudWatchEncryptionMode: c.CloudWatchEncryption.CloudWatchEncryptionMode,
          KmsKeyArn: c.CloudWatchEncryption.KmsKeyArn,
        })
      : {},
    JobBookmarksEncryption: c.JobBookmarksEncryption
      ? cleanCfnObject({
          JobBookmarksEncryptionMode: c.JobBookmarksEncryption.JobBookmarksEncryptionMode,
          KmsKeyArn: c.JobBookmarksEncryption.KmsKeyArn,
        })
      : {},
  };
}

function cleanCfnObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ─── Shared helpers for sibling Glue providers ──────────────────────────

/**
 * Build the ARN for a Glue resource. Used by tag-fetch via
 * `GetTagsCommand` which only accepts an ARN, and by the Job / Crawler /
 * Trigger `applyGlueTagDiff` as the `TagResource` / `UntagResource` target.
 * Account id falls back to STS when not provided.
 *
 * The partition is derived from the region (issue #1815). A hardcoded
 * `arn:aws:` is structurally valid everywhere, so in `aws-cn` / `aws-us-gov`
 * nothing rejected it: the tag MUTATION was aimed at an ARN naming no
 * resource, and the drift read's best-effort `GetTags` read the failure as
 * empty tags. A commercial region still derives to `aws`, so commercial output
 * is unchanged byte for byte.
 */
export async function buildGlueResourceArn(
  client: GlueClient,
  stsClient: STSClient,
  resource: 'job' | 'crawler' | 'connection' | 'trigger',
  name: string,
  accountId: string | undefined
): Promise<string> {
  const region = (await client.config.region()) || ambientRegion() || 'us-east-1';
  const account = accountId ?? (await resolveAccountId(stsClient));
  const { partition } = derivePartitionAndUrlSuffix(region);
  return `arn:${partition}:glue:${region}:${account}:${resource}/${name}`;
}

export async function resolveAccountId(stsClient: STSClient): Promise<string> {
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) {
    throw new Error('Failed to resolve AWS account id from STS');
  }
  return identity.Account;
}

/**
 * Best-effort fetch of CFn-shape `Tags: [{Key, Value}]` for a Glue resource.
 * Returns `[]` when no tags or on error (tags are non-critical for drift —
 * a permission failure should not abort the whole drift read).
 */
export async function fetchGlueTags(
  client: GlueClient,
  stsClient: STSClient,
  resource: 'job' | 'crawler' | 'connection' | 'trigger',
  name: string,
  accountId: string | undefined,
  logger: ReturnType<typeof getLogger>
): Promise<Array<{ Key: string; Value: string }>> {
  try {
    const arn = await buildGlueResourceArn(client, stsClient, resource, name, accountId);
    const resp = await client.send(new GetTagsCommand({ ResourceArn: arn }));
    return normalizeAwsTagsToCfn(resp.Tags);
  } catch (err) {
    // Neither the NAME nor AWS's own text: a Connection's name can be
    // secret-derived (go-to-k/cdkd#2007), and an AccessDenied message quotes
    // the resource ARN, which carries it. The summary is the error code.
    logger.debug(`GetTags failed for a Glue ${resource}: ${describeAwsFailure(err).summary}`);
    return [];
  }
}

/**
 * Narrow an unknown template / state value to a plain object, or `undefined`.
 * A malformed side (string / array / null) yields `undefined` and therefore
 * an empty key set — the tolerant treatment `parameterKeySet` already gives
 * bags, extended to the StorageDescriptor merge's containers. (An unresolved
 * intrinsic is itself a plain object, so it passes through and contributes
 * its `Fn::*`/`Ref` key — harmless here, since providers only ever see
 * resolved values.)
 */
/**
 * The CFn members of the two `DatabaseInput` object blocks, as the SENDABLE-ness
 * test sees them. They must stay in step with the per-member writes in
 * `buildDatabaseInput` — a name here that the builder does not write would let
 * an EMPTY block onto the wire, and one the builder writes but this list omits
 * would refuse a valid template that names only it. The unit suite fences both
 * directions by asserting each member ALONE reaches AWS, which fails on a
 * dropped entry (the member stops being sendable) and on an added one (the
 * block builds empty).
 */
export const TARGET_DATABASE_MEMBERS = ['CatalogId', 'DatabaseName', 'Region'] as const;

export const FEDERATED_DATABASE_MEMBERS = ['ConnectionName', 'Identifier'] as const;

/**
 * Is this leaf value one cdkd can put on the wire? A STRING or a NUMBER — CFn
 * is stringly typed, and an account id can reach a provider as a JSON number
 * (the reason {@link catalogIdForApi} exists; that function's note carries the
 * two producers, neither of which is a YAML read — an earlier version of this
 * sentence said "an unquoted YAML account id" and was wrong the same way) —
 * and nothing else, so an unresolved intrinsic cannot ride an unchecked cast
 * into the request.
 */
export const isSendableLeaf = (value: unknown): boolean =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/**
 * The refusal sentence for a `DatabaseInput` block that IS a plain object and
 * still names nothing cdkd can send — an unresolved intrinsic or a bare `{}`.
 * Shared so the create refusal and the update warning cannot drift apart.
 */
export const emptyBlockMessage = (block: string): string =>
  `AWS::Glue::Database DatabaseInput.${block} declares no member cdkd can send ` +
  `(an unresolved intrinsic, an empty block), or mixes sendable members with ` +
  `unreadable ones; sending it would put an empty or NARROWED ${block} on the ` +
  `wire. Where this is only WARNED — a rollback revert, drift --revert, or a ` +
  `state replay — the ` +
  `previously applied block is retained if cdkd can still read one, and ` +
  `otherwise the key is omitted, which UpdateDatabase applies as a removal ` +
  `because it replaces DatabaseInput wholesale`;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * `text` without one trailing period, for a builder that appends its own
 * sentence end: a redacted summary ends in one (go-to-k/cdkd#2319), and so
 * does most AWS text.
 */
export function withoutFinalPeriod(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

/**
 * Message for a failed pre-update `Get*` read (issue #1461). Names the IAM
 * action so a permission gap is one line away from fixed, and says what the
 * read is FOR so the failure does not read as gratuitous. `detail` is AWS's
 * text already masked through the update's masker (#2177): AWS quotes the
 * request back.
 */
export function preUpdateReadFailureMessage(
  kind: 'Table' | 'Database',
  iamAction: string,
  logicalId: string,
  detail: string
): string {
  return (
    `Failed to read the current Glue ${kind} ${logicalId} before update: ${withoutFinalPeriod(detail)}. ` +
    `cdkd reads the live ${kind.toLowerCase()} so AWS-managed Parameters (Apache Iceberg's ` +
    `table_type / metadata_location, a crawler's classification, Lake Formation markers) ` +
    `survive an update that Glue applies as a full replace. Grant ${iamAction} to the ` +
    `deploy identity — proceeding without the read would silently erase them.`
  );
}

/**
 * Coerce a CFn-delivered numeric property (often a string like `"10"`) to a
 * JS number at the SDK wire boundary. Non-finite / unparseable inputs are
 * returned unchanged so AWS surfaces a clear validation error rather than
 * silently sending `NaN`.
 */
export function coerceNumber(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

/**
 * The shape a refused Glue `Tags` names. Every Glue type's CloudFormation
 * `Tags` is a key -> value MAP; `readCurrentState` emits the `{Key,Value}[]`
 * list, which a `drift --revert` hands back as the desired side, so both are
 * read.
 */
const GLUE_TAGS_WHAT =
  'a map of tag keys to scalar values or a list of tags with a non-empty string Key and a scalar Value';

/**
 * Refuse a malformed desired Glue `Tags` before any call (go-to-k/cdkd#4073)
 * and return it as the Glue `Record<string,string>` a Create command takes, or
 * `undefined` when there are no tags so the caller elides the key. `physicalId`
 * is set on the update path.
 */
export function desiredGlueTags(
  raw: unknown,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): Record<string, string> | undefined {
  const tags = refuseMalformedDesiredTags(
    tagMapAsList(raw),
    resourceType,
    logicalId,
    physicalId,
    'Tags',
    GLUE_TAGS_WHAT
  );
  return tags.length > 0 ? Object.fromEntries(tags.map((t) => [t.Key, t.Value])) : undefined;
}

/**
 * Reconcile a Glue resource's tags through `planTagDiff` (go-to-k/cdkd#4073):
 * only the keys the desired side dropped are untagged and only new or changed
 * tags are set; a recorded `Tags` cdkd cannot read untags nothing, and a
 * recorded secret-derived key is never untagged. The desired side must already
 * have passed {@link desiredGlueTags}. The ARN is resolved only when there is
 * something to send.
 */
export async function applyGlueTagDiff(
  client: GlueClient,
  resourceArn: () => Promise<string>,
  recorded: unknown,
  desired: unknown,
  resourceType: string,
  logicalId: string,
  warn: (message: string) => void,
  unsettled: { forceUpsert: boolean; beforeWrite: () => void } = {
    forceUpsert: false,
    beforeWrite: () => undefined,
  }
): Promise<void> {
  const plan = planTagDiff(tagMapAsList(recorded), tagMapAsList(desired));
  const warning = tagPlanWarning(plan, resourceType, logicalId);
  if (warning !== undefined) warn(warning);
  // go-to-k/cdkd#5487: unsettled Tags re-send every template tag (AWS may lack
  // the ones a failed update did not reach) and remove only the recorded ones
  // the template dropped.
  const toSet = unsettled.forceUpsert ? planTagDiff([], tagMapAsList(desired)).set : plan.set;
  if (toSet.size === 0 && plan.remove.length === 0) return;
  unsettled.beforeWrite();
  const arn = await resourceArn();
  if (toSet.size > 0) {
    await client.send(
      new TagResourceCommand({ ResourceArn: arn, TagsToAdd: Object.fromEntries(toSet) })
    );
  }
  if (plan.remove.length > 0) {
    await client.send(new UntagResourceCommand({ ResourceArn: arn, TagsToRemove: plan.remove }));
  }
}

/**
 * Recursively strip undefined / null values and empty objects from a plain
 * record, returning the cleaned shape. Used by `readCurrentState` to emit
 * tight CFn-shape sub-objects without leaking SDK-injected `undefined` keys.
 */
export function pickDefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = pickDefined(v as Record<string, unknown>);
      out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out;
}
