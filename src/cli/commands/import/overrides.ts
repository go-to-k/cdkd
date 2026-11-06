import { readFileSync, writeFileSync } from 'node:fs';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  describeJsonParseFailure,
  parseFailureDebugDetail,
  utf8ByteLength,
} from '../../../utils/json-parse-failure.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import { isPasteableIdent, safeMsg } from '../../../utils/display-safe.js';
import { defineOwnKey } from '../../../utils/own-keys.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../types/resource.js';
import type { CfnOverrideMergeStats, ImportRow } from './types.js';

/**
 * The stack as a refusal carrying a pasteable flag names it: `stack 'X'` when
 * `isPasteableIdent` admits the name, otherwise a description
 * (go-to-k/cdkd#4226). The name is the cloud assembly's, and a `'` in it
 * closed cdkd's own quote on a line that also offers `--resource`.
 */
export function stackShown(stackName: string): string {
  return isPasteableIdent(stackName)
    ? `stack '${stackName}'`
    : 'a stack whose name is not a plain identifier';
}

/**
 * Merge a CloudFormation-derived `logicalId -> physicalId` map into the run's
 * `overrides`, applying the three filters every CFn-derived seed needs, and
 * report what each filter dropped.
 *
 * The filters, in order:
 *   1. **Not an importable template resource** — CFn knows about sentinel rows
 *      like `AWS::CDK::Metadata` that cdkd silently skips on import. Merging
 *      those would make the typo-validation step reject them.
 *   2. **Nested-stack row** — the AWS-side physical ID of an
 *      `AWS::CloudFormation::Stack` row is the child stack ARN, which is NOT
 *      what we want as an import override. The parent's state entry carries
 *      the synthesized cdkd-local ARN (matching what `NestedStackProvider.create`
 *      writes at deploy time — design §6), populated by `importOne`'s
 *      short-circuit. Filtering here keeps the AWS ARN from overwriting it.
 *   3. **Already overridden** — user-supplied `--resource` /
 *      `--resource-mapping` entries are inserted before any CFn lookup and
 *      always win.
 *
 * Shared by all three CFn-derived seeding sites so a change to any filter
 * lands once: the `--migrate-from-cloudformation` root walk, the auto-mode
 * best-effort lookup (issue #1128), and the recursive nested-child walk.
 * The three differ only in their LOGGING, which stays at the call sites.
 *
 * **Second-order effect worth naming:** `overrides` is also consumed by
 * {@link substituteOverrideRefs}, so seeding it from CloudFormation means a
 * `{Ref: <X>}` in a resource's Properties pre-resolves to the CFn physical ID
 * before `provider.import()` sees it. That is intended — it is what makes
 * sub-resource providers (e.g. `SQSQueuePolicyProvider`, which reads
 * `properties.Queues[0]` as a literal queue URL) importable — but it is a
 * behavior beyond "resolve physical IDs", and it applies to every caller of
 * this helper, not just the migration path. See issue #1131.
 *
 * Mutates `overrides` in place; does not mutate `cfnMapping` or `template`.
 */
export function mergeCfnDerivedOverrides(params: {
  cfnMapping: ReadonlyMap<string, string>;
  template: CloudFormationTemplate;
  templateLogicalIds: ReadonlySet<string>;
  overrides: Map<string, string>;
}): CfnOverrideMergeStats {
  const { cfnMapping, template, templateLogicalIds, overrides } = params;
  const stats: CfnOverrideMergeStats = {
    derived: 0,
    skippedNonImportable: 0,
    skippedNestedStackRow: 0,
    overriddenByUser: 0,
  };
  for (const [logicalId, physicalId] of cfnMapping) {
    if (!templateLogicalIds.has(logicalId)) {
      stats.skippedNonImportable++;
      continue;
    }
    if (template.Resources[logicalId]?.Type === NESTED_STACK_RESOURCE_TYPE) {
      stats.skippedNestedStackRow++;
      continue;
    }
    if (overrides.has(logicalId)) {
      stats.overriddenByUser++;
      continue;
    }
    overrides.set(logicalId, physicalId);
    stats.derived++;
  }
  return stats;
}

/**
 * Render the human-readable breakdown of a {@link mergeCfnDerivedOverrides}
 * result — the parenthesized suffix of the `Resolved N physical ID(s)` line.
 * Returns `''` when nothing was dropped (no breakdown worth reporting).
 */
export function formatCfnOverrideMergeDetail(stats: CfnOverrideMergeStats): string {
  const detail: string[] = [];
  if (stats.overriddenByUser > 0)
    detail.push(`${stats.overriddenByUser} already overridden by --resource`);
  if (stats.skippedNonImportable > 0)
    detail.push(`${stats.skippedNonImportable} non-importable (e.g. CDKMetadata)`);
  if (stats.skippedNestedStackRow > 0)
    detail.push(`${stats.skippedNestedStackRow} nested-stack row(s) handled separately`);
  return detail.length > 0 ? ` (${detail.join(', ')})` : '';
}

/**
 * Recursively substitute `{Ref: <LogicalId>}` shapes in an arbitrary value
 * tree with the matching entry from `overrides`. Used to bridge the gap
 * between CDK synth's template (which carries raw intrinsics) and what a
 * provider's `import()` needs to see at the time it's called — specifically
 * for sub-resource providers like `SQSQueuePolicyProvider` whose fallback
 * path reads `properties.<ParentKey>` as a literal operational identifier
 * (queue URL / topic ARN / bucket name) rather than the unresolved intrinsic.
 *
 * Scope is intentionally narrow:
 *   - Only `{Ref: <X>}` shapes are substituted. `Fn::GetAtt` is NOT handled
 *     here — the overrides map carries physical IDs only, not the
 *     per-resource attributes a GetAtt resolution needs. Full GetAtt /
 *     Fn::Sub / Fn::Join handling happens later in
 *     `resolveImportedProperties` against the populated `stackState.resources`.
 *   - Pseudo-parameter refs (`AWS::Region` / `AWS::AccountId` / etc.) are
 *     left untouched here. The ones an import lookup can need — a name built
 *     from the account or region — are resolved BEFORE this runs, by
 *     {@link resolvePseudoParameterIntrinsics} (issue #1897); the rest wait
 *     for the full resolver post-import.
 *   - When the `Ref` target is NOT in the overrides map, the intrinsic is
 *     left in place (the post-import resolver may resolve it from the
 *     `stackState.resources` built by other imports).
 *
 * Closes issue #361 — `AWS::SQS::QueuePolicy` under
 * `--migrate-from-cloudformation` previously hard-errored because
 * `properties.Queues[0]` arrived at `provider.import()` as
 * `{Ref: <Queue>}` and the queue URL needed for the fallback identification
 * branch was never substituted in.
 *
 * Pure-functional — does not mutate `value`.
 */
export function substituteOverrideRefs(value: unknown, overrides: Map<string, string>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => substituteOverrideRefs(v, overrides));
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'Ref' && typeof obj['Ref'] === 'string') {
    const refTarget = obj['Ref'] as string;
    const resolved = overrides.get(refTarget);
    if (resolved !== undefined) {
      return resolved;
    }
    // Target not in overrides — leave intrinsic untouched for the
    // post-import resolver to handle.
    return value;
  }
  // An ordinary `{}` written through `defineOwnKey`, like
  // `resolvePseudoParameterIntrinsics`: the bag goes to a PROVIDER, and a
  // template key named `__proto__` assigned with `result[k] =` would become the
  // bag's PROTOTYPE, so its members (a `Name`) would shadow-read as properties.
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    defineOwnKey(result, k, substituteOverrideRefs(v, overrides));
  }
  return result;
}

/**
 * Parse `--resource MyBucket=my-bucket-name` flags (repeatable),
 * `--resource-mapping <file>` JSON file, and `--resource-mapping-inline
 * '<json>'` JSON string into a single override map.
 *
 * The JSON shape (file or inline) is `{ "<logicalId>": "<physicalId>", ... }`
 * for CDK CLI `cdk import --resource-mapping` / `--resource-mapping-inline`
 * parity.
 *
 * `--resource-mapping` and `--resource-mapping-inline` are mutually
 * exclusive (matches upstream `cdk import`): the user picks one source.
 *
 * `--resource` flags take precedence over the JSON source when a logicalId
 * appears in both — explicit-on-CLI wins.
 */
export function parseResourceOverrides(
  flags: string[] | undefined,
  mappingFile: string | undefined,
  mappingInline: string | undefined
): Map<string, string> {
  const map = new Map<string, string>();

  if (mappingFile && mappingInline) {
    throw new Error(
      '--resource-mapping and --resource-mapping-inline are mutually exclusive; pass only one.'
    );
  }

  if (mappingFile) {
    let raw: string;
    try {
      raw = readFileSync(mappingFile, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read --resource-mapping file '${mappingFile}': ` + describeAwsFailure(err).detail
      );
    }
    const parsed = parseMappingJson(raw, `--resource-mapping file '${mappingFile}'`);
    for (const [key, value] of Object.entries(parsed)) {
      map.set(key, value);
    }
  }

  if (mappingInline) {
    const parsed = parseMappingJson(mappingInline, '--resource-mapping-inline');
    for (const [key, value] of Object.entries(parsed)) {
      map.set(key, value);
    }
  }

  for (const entry of flags ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq === entry.length - 1) {
      throw new Error(`--resource expects 'logicalId=physicalId', got '${entry}'`);
    }
    map.set(entry.slice(0, eq), entry.slice(eq + 1));
  }

  return map;
}

/**
 * Parse a `{logicalId: physicalId}` JSON document — either a file body
 * (for `--resource-mapping`) or an inline string (for
 * `--resource-mapping-inline`). The `source` label is woven into error
 * messages so the user can tell which input failed.
 */
function parseMappingJson(raw: string, source: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // V8's `SyntaxError` quotes a window of the input, so the message names
    // only the failure's offset and size (issue #5254); V8's text goes to
    // `debug` only.
    getLogger().debug(safeMsg`${source} failed to parse: ${parseFailureDebugDetail(err)}`);
    throw new Error(
      `Failed to parse ${source} as JSON: ` + describeJsonParseFailure(err, utf8ByteLength(raw))
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object {logicalId: physicalId}`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`${source}: value for '${key}' must be a string, got ${typeof value}`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Write the resolved `{logicalId: physicalId}` map to disk for re-use
 * (mirrors upstream `cdk import --record-resource-mapping <file>`).
 *
 * Inclusion rules: only `imported` rows. `skipped-*` and `failed` rows
 * are excluded — they do not represent a usable physical id.
 *
 * Format: pretty-printed JSON with 2-space indent + trailing newline,
 * so the file is human-reviewable before the user confirms the import.
 *
 * Failure: logged via `logger.error` but NOT thrown. The import has
 * already resolved every physical id in memory; failing to persist the
 * record file is a metadata problem, not a load-bearing one.
 */
export function writeRecordedMapping(filePath: string, rows: ImportRow[]): void {
  const logger = getLogger();
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.outcome === 'imported' && row.physicalId) {
      map[row.logicalId] = row.physicalId;
    }
  }
  const body = JSON.stringify(map, null, 2) + '\n';
  try {
    writeFileSync(filePath, body, 'utf-8');
    logger.info(`Wrote resolved mapping to ${filePath} (${Object.keys(map).length} entry(ies))`);
  } catch (err) {
    const msg = describeAwsFailure(err).detail;
    logger.error(
      `Failed to write --record-resource-mapping file '${filePath}': ${msg}. ` +
        `Continuing — the import already resolved every physical id in memory.`
    );
  }
}

/**
 * Walk the template's `Resources` and return the entries we should attempt
 * to import. Filters out CDK metadata sentinels (`AWS::CDK::Metadata`) which
 * are not real AWS resources.
 */
export function collectImportableResources(
  template: CloudFormationTemplate
): { logicalId: string; resource: TemplateResource }[] {
  const out: { logicalId: string; resource: TemplateResource }[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    out.push({ logicalId, resource });
  }
  return out;
}
