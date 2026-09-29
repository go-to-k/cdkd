import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';

/**
 * Read the `aws:cdk:path` value that CDK encodes into every resource's
 * `Metadata`. Returns the empty string when not present so callers don't
 * have to special-case `undefined`.
 *
 * Hoisted out of `src/cli/commands/import.ts` so `cdkd orphan` can reuse the
 * same lookup without duplicating the metadata-walking code.
 */
export function readCdkPath(resource: TemplateResource): string {
  const meta = resource.Metadata;
  if (!meta) return '';
  const v = (meta as { 'aws:cdk:path'?: unknown })['aws:cdk:path'];
  return typeof v === 'string' ? v : '';
}

/**
 * Same lookup as `readCdkPath`, but returns `undefined` instead of an
 * empty string when no `aws:cdk:path` metadata is present.
 *
 * Use this variant when the caller passes the value into APIs whose
 * contract distinguishes "no path known" from "empty path". For example,
 * `resolveEnvVars(logicalId, displayPath, ...)` short-circuits the
 * display-path lookup when `displayPath` is `undefined`, but an empty
 * string `''` would still hit the loop and could spuriously match a
 * malformed override key.
 */
export function readCdkPathOrUndefined(resource: TemplateResource): string | undefined {
  const path = readCdkPath(resource);
  return path === '' ? undefined : path;
}

/**
 * Build a `Map<cdkPath, logicalId>` from a synthesized template.
 *
 * Used by `cdkd orphan <constructPath>` to translate user-supplied
 * construct paths (which mirror the upstream `cdk orphan` UX) back to the
 * logical IDs that the rest of the pipeline (state, dependency analysis,
 * provider lookup) is keyed on.
 *
 * `AWS::CDK::Metadata` resources are excluded — the synthesized
 * `<Stack>/CDKMetadata/Default` sentinel exists in every stack but is
 * never user-managed, so listing it as an "available path" in the
 * not-found error is just noise and orphaning it is meaningless.
 *
 * Resources without a `aws:cdk:path` metadata entry are silently skipped
 * for the same reason — they cannot be addressed by construct path.
 *
 * In practice each path maps to a single logical ID. If the same path
 * happens to appear twice (which would itself be a bug in the synthesized
 * template), the last entry wins — `cdkd orphan` will still surface a
 * clean "path not found" diff against the indexed map rather than
 * silently grabbing both.
 */
export function buildCdkPathIndex(template: CloudFormationTemplate): Map<string, string> {
  const index = new Map<string, string>();
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    const path = readCdkPath(resource);
    if (path) index.set(path, logicalId);
  }
  return index;
}

/**
 * Resolve a user-supplied construct path to every logical ID it covers.
 *
 * Mirrors `cdk orphan --unstable=orphan` (`packages/@aws-cdk/toolkit-lib/
 * lib/api/orphan/orphaner.ts` line 90 in aws-cdk-cli): users typically
 * pass an L2 path like `MyStack/MyConstruct/MyBucket` rather than the
 * synthesized L1 path `MyStack/MyConstruct/MyBucket/Resource`, and an L2
 * with multiple children (e.g. a CDK pattern that wraps several CFn
 * resources) should orphan all of them in one go.
 *
 * Match rule: a resource matches `input` when its `aws:cdk:path` is
 * exactly `input` OR starts with `${input}/`. The trailing slash matters
 * — without it `MyStack/MyBucket` would also match
 * `MyStack/MyBucketBackup/Resource`.
 */
export function resolveCdkPathToLogicalIds(
  input: string,
  index: Map<string, string>
): { logicalId: string; cdkPath: string }[] {
  const seen = new Map<string, string>();
  const prefix = `${input}/`;
  for (const [path, logicalId] of index) {
    if (path === input || path.startsWith(prefix)) {
      if (!seen.has(logicalId)) seen.set(logicalId, path);
    }
  }
  return [...seen.entries()].map(([logicalId, cdkPath]) => ({ logicalId, cdkPath }));
}

/** The two names a stack can be addressed by at the head of a construct path. */
export interface ConstructPathStack {
  stackName: string;
  displayName?: string;
}

/**
 * The stack a construct path addresses: the one whose `displayName` (or
 * `stackName`) followed by `/` is the LONGEST prefix of `path`.
 *
 * Longest wins because a Stage nests: `Outer/Inner/Api/Bucket` must pick
 * `Outer/Inner/Api` even if a stack displayed `Outer` exists. The trailing `/`
 * keeps `MyStage/Api` from claiming `MyStage/ApiV2/Bucket`. On a tie in length
 * a `displayName` beats another stack's `stackName`, the precedence the
 * first-segment lookup this replaced gave the two maps (go-to-k/cdkd#3943).
 *
 * Shared by `cdkd orphan` and the `cdkd local` target resolvers, which split
 * a path at its first `/` the same way (go-to-k/cdkd#3953).
 */
export function stackForConstructPath<T extends ConstructPathStack>(
  path: string,
  stacks: readonly T[]
): T | undefined {
  let best: T | undefined;
  let bestRank = -1;
  for (const s of stacks) {
    const names: Array<[string | undefined, number]> = [
      [s.displayName, 1],
      [s.stackName, 0],
    ];
    for (const [name, preference] of names) {
      if (typeof name !== 'string' || name.length === 0) continue;
      if (!path.startsWith(`${name}/`)) continue;
      const rank = name.length * 2 + preference;
      if (rank > bestRank) {
        best = s;
        bestRank = rank;
      }
    }
  }
  return best;
}

/**
 * The stack a `cdkd local` PATH-form target (`<stack path>/<construct path>`)
 * addresses, or `undefined` when the target is not in that form or no stack
 * path prefixes it -- the caller then falls back to its own stack pattern.
 *
 * Path form is recognised by `pathOrId === target`: the colon form
 * (`Stack:LogicalId`) strips its stack head, so its `pathOrId` is always
 * shorter, and the stack it NAMES must win even when its path part starts with
 * another stack's path. One copy for every caller -- the invoke and run-task
 * resolvers AND run-task's state-source candidate, which picked the Stage id
 * on its own while the resolver moved on (go-to-k/cdkd#3953).
 */
export function stackForPathFormTarget<T extends ConstructPathStack>(
  parsed: { isPath: boolean; pathOrId: string },
  target: string,
  stacks: readonly T[]
): T | undefined {
  if (!parsed.isPath || parsed.pathOrId !== target) return undefined;
  return stackForConstructPath(parsed.pathOrId, stacks);
}
