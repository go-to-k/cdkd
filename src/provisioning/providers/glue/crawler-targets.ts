import type {
  CrawlerTargets,
  SchemaChangePolicy,
  RecrawlPolicy,
  LineageConfiguration,
  LakeFormationConfiguration,
} from '@aws-sdk/client-glue';
import { coerceNumber } from './shared.js';

// ─── helpers shared by GlueCrawlerProvider ──────────────────────────────

/**
 * Crawler optional fields shared by `CreateCrawler` and `UpdateCrawler`.
 * `Schedule` is the bare cron string at the SDK layer, but CFn wraps it
 * in `{ ScheduleExpression: '...' }`. cdkd unwraps here.
 */
export function buildCrawlerCommonFields(p: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  if (p['DatabaseName'] !== undefined) r['DatabaseName'] = p['DatabaseName'] as string;
  if (p['Description'] !== undefined) r['Description'] = p['Description'] as string;
  if (p['Classifiers'] !== undefined) r['Classifiers'] = p['Classifiers'] as string[];
  if (p['TablePrefix'] !== undefined) r['TablePrefix'] = p['TablePrefix'] as string;
  if (p['Schedule'] !== undefined) {
    // Accept both the CFn structured shape and a bare string for forward-compat.
    const sched = p['Schedule'];
    if (typeof sched === 'string') {
      r['Schedule'] = sched;
    } else if (typeof sched === 'object' && sched !== null) {
      const wrap = sched as Record<string, unknown>;
      if (wrap['ScheduleExpression'] !== undefined) {
        r['Schedule'] = wrap['ScheduleExpression'] as string;
      }
    }
  }
  if (p['SchemaChangePolicy'] !== undefined) {
    r['SchemaChangePolicy'] = p['SchemaChangePolicy'] as SchemaChangePolicy;
  }
  if (p['RecrawlPolicy'] !== undefined) {
    r['RecrawlPolicy'] = p['RecrawlPolicy'] as RecrawlPolicy;
  }
  if (p['LineageConfiguration'] !== undefined) {
    r['LineageConfiguration'] = p['LineageConfiguration'] as LineageConfiguration;
  }
  if (p['LakeFormationConfiguration'] !== undefined) {
    r['LakeFormationConfiguration'] = p['LakeFormationConfiguration'] as LakeFormationConfiguration;
  }
  if (p['Configuration'] !== undefined) r['Configuration'] = p['Configuration'] as string;
  if (p['CrawlerSecurityConfiguration'] !== undefined) {
    r['CrawlerSecurityConfiguration'] = p['CrawlerSecurityConfiguration'] as string;
  }
  return r;
}

/**
 * CFn -> SDK key renames for `Targets.DynamoDBTargets[]`.
 *
 * The SDK's `DynamoDBTarget` is a lowercase island in an otherwise-PascalCase
 * model: `Path` is PascalCase but the scan-tuning members are `scanAll` /
 * `scanRate` (@aws-sdk/client-glue `models_0.d.ts` `DynamoDBTarget`), while CFn
 * spells them `ScanAll` / `ScanRate`. The AWS SDK v3 serializer drops unknown
 * members, so forwarding the CFn spelling silently loses the scan tuning while
 * the target itself (matched by `Path`) still reaches AWS. Every other
 * `CrawlerTargets` sub-type (`S3Target` / `JdbcTarget` / `MongoDBTarget` —
 * whose own `ScanAll` IS PascalCase — `CatalogTarget` / `DeltaTarget` /
 * `IcebergTarget` / `HudiTarget`) spells every member exactly as CFn does.
 */
const CFN_TO_SDK_DYNAMODB_TARGET_KEYS: Record<string, string> = {
  ScanAll: 'scanAll',
  ScanRate: 'scanRate',
};

/**
 * CFn is stringly typed, so a template (or an unresolved-then-resolved
 * intrinsic) can carry `ScanRate: "0.9"`. The SDK models it as a double and the
 * serializer forwards a string verbatim, so the value has to be coerced HERE —
 * this converter is the wire boundary for `Targets` now that it re-shapes the
 * blob. Non-numeric input passes through so AWS surfaces the real validation
 * error rather than cdkd mangling it.
 */
const SDK_DYNAMODB_TARGET_NUMERIC_KEYS: readonly string[] = ['scanRate'];

/**
 * Same stringly-typed-CFn reasoning as {@link SDK_DYNAMODB_TARGET_NUMERIC_KEYS},
 * for the boolean member: a hand-written `ScanAll: "false"` would otherwise
 * forward the STRING `"false"` — which is truthy — to a boolean member.
 */
const SDK_DYNAMODB_TARGET_BOOLEAN_KEYS: readonly string[] = ['scanAll'];

/** CFn booleans arrive as `true` / `false` or as the strings `"true"` / `"false"`. */
function coerceBoolean(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return value;
}

const SDK_TO_CFN_DYNAMODB_TARGET_KEYS: Record<string, string> = {
  scanAll: 'ScanAll',
  scanRate: 'ScanRate',
};

/**
 * Shallow-rename an object's keys per `renames`, leaving unlisted keys — and
 * non-object values (an unresolved intrinsic) — untouched.
 */
function renameRecordKeys(
  entry: unknown,
  renames: Record<string, string>,
  numericKeys: readonly string[] = [],
  booleanKeys: readonly string[] = []
): unknown {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
    const key = renames[k] ?? k;
    if (numericKeys.includes(key)) out[key] = coerceNumber(v);
    else if (booleanKeys.includes(key)) out[key] = coerceBoolean(v);
    else out[key] = v;
  }
  return out;
}

/**
 * Apply `renames` to every element of `targets[key]` when that entry is an
 * array, returning the original object untouched otherwise so a non-array value
 * reaches AWS verbatim and surfaces the real validation error.
 */
function renameCrawlerTargetList(
  targets: Record<string, unknown>,
  key: string,
  renames: Record<string, string>,
  numericKeys: readonly string[] = [],
  booleanKeys: readonly string[] = []
): Record<string, unknown> {
  const list = targets[key];
  if (!Array.isArray(list)) return targets;
  return {
    ...targets,
    [key]: list.map((entry) => renameRecordKeys(entry, renames, numericKeys, booleanKeys)),
  };
}

/**
 * Convert the CFn `AWS::Glue::Crawler.Targets` blob to the SDK `CrawlerTargets`
 * shape — see {@link CFN_TO_SDK_DYNAMODB_TARGET_KEYS} for the one divergence.
 */
export function toSdkCrawlerTargets(targets: Record<string, unknown>): CrawlerTargets {
  return renameCrawlerTargetList(
    targets,
    'DynamoDBTargets',
    CFN_TO_SDK_DYNAMODB_TARGET_KEYS,
    SDK_DYNAMODB_TARGET_NUMERIC_KEYS,
    SDK_DYNAMODB_TARGET_BOOLEAN_KEYS
  ) as CrawlerTargets;
}

/**
 * Inverse of {@link toSdkCrawlerTargets}: re-shape a `GetCrawler` `Targets`
 * blob back into the CFn spelling so `cdkd drift` compares like with like
 * instead of reporting a phantom `ScanRate` removal + `scanRate` addition.
 */
export function toCfnCrawlerTargets(targets: Record<string, unknown>): Record<string, unknown> {
  return renameCrawlerTargetList(targets, 'DynamoDBTargets', SDK_TO_CFN_DYNAMODB_TARGET_KEYS);
}
