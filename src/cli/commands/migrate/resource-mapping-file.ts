import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalMigrateError } from '../../../utils/error-handler.js';
import type { ResourceMappingResult, ResourceMappingUnmatched } from './resource-mapper.js';

/**
 * On-disk format for `<outputDir>/cdkd-resource-mapping.json`.
 *
 * Sidecar audit trail written by `cdkd migrate --from-cfn-stack`
 * BEFORE the import confirmation prompt, on every code path — success
 * (full mapping resolved), partial failure (some sources unmatched),
 * full failure (zero matches), AND --dry-run. The user always has a
 * file they can either replay via `--resource-mapping <file>` (success
 * path / non-interactive CI) or hand-edit and replay (partial-failure
 * path).
 *
 * `_unmatched` is included only when at least one source resource went
 * unmatched. The reader tolerates it on input (a user that runs the
 * partial-failure file back through without editing should get the
 * same partial failure, not a parse error) but ignores it — only
 * `mapping` matters on input.
 *
 * `version` is a forward-compat hook for schema evolution. Reader
 * accepts `version: 1` only in this PR; a future PR that adds fields
 * may bump it.
 */
export interface ResourceMappingFile {
  version: 1;
  /** ISO 8601 timestamp the file was written. Surfaced for the user's audit log. */
  generatedAt: string;
  /** Source CFn stack name the mapping was built against. Cross-references with the user's CLI invocation. */
  sourceStack: string;
  /** cdkd stack name the import flow will write state under. */
  outputStack: string;
  /** Canonical `{<sourceLogicalId>: <synthLogicalId>}` map. */
  mapping: Record<string, string>;
  /**
   * Per-source-resource unmatched entries, present only on partial
   * failure. Carries the diagnostic context the user needs to fix the
   * mapping by hand (candidate synth ids of the same Type + the reason
   * Pass 1 / Pass 2 could not auto-resolve).
   */
  _unmatched?: ResourceMappingUnmatched[];
}

/** Conventional filename inside the migrate output dir. */
export const RESOURCE_MAPPING_FILENAME = 'cdkd-resource-mapping.json';

/**
 * Build the on-disk file shape from a {@link ResourceMappingResult} +
 * the source / output stack names, then write it to
 * `<outputDir>/cdkd-resource-mapping.json` (overwriting any prior file
 * on the same path — same idempotency contract as `cdk migrate`'s own
 * codegen, and the user expects a re-run to refresh stale data).
 *
 * Returns the absolute on-disk path so the orchestrator can name it in
 * the error message when the mapping is incomplete.
 */
export function writeMappingFile(
  outputDir: string,
  args: {
    sourceStack: string;
    outputStack: string;
    result: ResourceMappingResult;
  }
): string {
  const path = join(outputDir, RESOURCE_MAPPING_FILENAME);
  const file: ResourceMappingFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceStack: args.sourceStack,
    outputStack: args.outputStack,
    mapping: args.result.mapping,
  };
  if (args.result.unmatched.length > 0) {
    file._unmatched = args.result.unmatched;
  }
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf-8');
  return path;
}

/**
 * Read a user-supplied resource-mapping file from disk and return the
 * `{<srcLogicalId>: <synthLogicalId>}` overrides for the mapper.
 *
 * Tolerates `_unmatched` on input (a user that re-runs against a
 * partial-failure file without editing should hit the same failure on
 * the resolution side — not a parse error here). Hard-errors on
 * structurally invalid input (missing `mapping`, non-object root,
 * non-string values, wrong `version`).
 *
 * Surfaces every shape error as `LocalMigrateError` (exit code 2) so
 * the CLI handler routes it through the normal error path.
 */
export function readMappingFile(path: string): ResourceMappingFile {
  if (!existsSync(path)) {
    throw new LocalMigrateError(
      `Resource-mapping file not found: ${path}. ` +
        `Drop the --resource-mapping flag or supply a valid path.`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LocalMigrateError(`Resource-mapping file '${path}' is not valid JSON: ${detail}`);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LocalMigrateError(
      `Resource-mapping file '${path}' must contain a JSON object at the top level.`
    );
  }
  const obj = raw as Record<string, unknown>;

  if (obj['version'] !== 1) {
    throw new LocalMigrateError(
      `Resource-mapping file '${path}' has unsupported version '${String(obj['version'])}'. ` +
        `Expected version 1.`
    );
  }
  if (typeof obj['sourceStack'] !== 'string' || obj['sourceStack'].length === 0) {
    throw new LocalMigrateError(
      `Resource-mapping file '${path}' is missing the required 'sourceStack' field.`
    );
  }
  if (typeof obj['outputStack'] !== 'string' || obj['outputStack'].length === 0) {
    throw new LocalMigrateError(
      `Resource-mapping file '${path}' is missing the required 'outputStack' field.`
    );
  }
  if (typeof obj['generatedAt'] !== 'string') {
    throw new LocalMigrateError(
      `Resource-mapping file '${path}' is missing the required 'generatedAt' field.`
    );
  }
  const mappingRaw = obj['mapping'];
  if (!mappingRaw || typeof mappingRaw !== 'object' || Array.isArray(mappingRaw)) {
    throw new LocalMigrateError(
      `Resource-mapping file '${path}' is missing the required 'mapping' object.`
    );
  }
  const mapping: Record<string, string> = {};
  for (const [k, v] of Object.entries(mappingRaw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new LocalMigrateError(
        `Resource-mapping file '${path}' has a non-string value for key '${k}'.`
      );
    }
    mapping[k] = v;
  }

  const result: ResourceMappingFile = {
    version: 1,
    generatedAt: obj['generatedAt'] as string,
    sourceStack: obj['sourceStack'] as string,
    outputStack: obj['outputStack'] as string,
    mapping,
  };
  // _unmatched is best-effort — preserve when shape-valid, drop silently
  // on malformed entries (the user re-running a partial-failure file
  // does not want a parse error here; the auto-mapping will re-derive
  // the unmatched list anyway).
  if (Array.isArray(obj['_unmatched'])) {
    const cleaned: ResourceMappingUnmatched[] = [];
    for (const entry of obj['_unmatched']) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (
        typeof e['sourceLogicalId'] !== 'string' ||
        typeof e['resourceType'] !== 'string' ||
        !Array.isArray(e['candidates']) ||
        (e['reason'] !== 'no-match' && e['reason'] !== 'logical-id-collision')
      ) {
        continue;
      }
      cleaned.push({
        sourceLogicalId: e['sourceLogicalId'] as string,
        resourceType: e['resourceType'] as string,
        candidates: (e['candidates'] as unknown[]).filter(
          (c): c is string => typeof c === 'string'
        ),
        reason: e['reason'] as 'no-match' | 'logical-id-collision',
      });
    }
    if (cleaned.length > 0) {
      result._unmatched = cleaned;
    }
  }
  return result;
}
