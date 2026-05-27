/**
 * Resolve a Lambda function's `Properties.Environment.Variables` for
 * `cdkd local invoke`.
 *
 * Per the issue scope, v1 supports **literal values only**. Intrinsic
 * functions (`Ref` / `Fn::GetAtt` / `Fn::Sub` / etc.) in env vars are
 * unresolvable without state — they would substitute to whatever the
 * deployed value is, and we have no source for that here. Each unresolved
 * key is recorded in `unresolved` so the caller can warn the user; the
 * variable is **dropped** rather than silently substituted with garbage
 * (a bad env var that "exists" is harder to debug than one that's missing).
 *
 * `--env-vars <file>` overrides match SAM's shape (D5), with the
 * additional CDK ergonomics that a function-specific entry can be keyed
 * by either the CloudFormation logical ID or the CDK display path
 * (`Metadata['aws:cdk:path']`):
 *
 *   {
 *     "Parameters":           { "GLOBAL_KEY": "value" },
 *     "MyHandlerLogicalId":   { "FUNCTION_KEY": "value" },
 *     "MyStack/MyHandler":    { "FUNCTION_KEY": "value" }
 *   }
 *
 * Override merge order (lowest to highest priority):
 *   1. Template literal env vars
 *   2. `Parameters` (global, applied to every invoke)
 *   3. Function-specific entries (logical-ID or display-path keyed)
 *      applied in JSON insertion order, so a later key wins on conflict.
 *      This matches SAM's apply-in-order semantics; pick one form per
 *      function to avoid surprises.
 *
 * The override file may also clear a variable by setting it to `null`
 * (matches SAM behavior).
 */

export interface EnvResolutionResult {
  /** Variables that should be set on the container. */
  resolved: Record<string, string>;
  /** Template env-var keys whose value was an intrinsic and was dropped. */
  unresolved: string[];
}

export interface EnvOverrideFile {
  /** Variables applied to every function invocation. */
  Parameters?: Record<string, string | null>;
  /**
   * Function-specific overrides keyed by either the CloudFormation
   * logical ID or the CDK display path (`Metadata['aws:cdk:path']`).
   */
  [logicalIdOrDisplayPath: string]: Record<string, string | null> | undefined;
}

/**
 * Resolve Lambda env vars for local invocation.
 *
 * @param logicalId         The function's CloudFormation logical ID. Used
 *                          to look up function-specific overrides in the
 *                          `--env-vars` file.
 * @param displayPath       The function's CDK display path
 *                          (`Metadata['aws:cdk:path']`, e.g.
 *                          `"MyStack/MyHandler"`), or `undefined` when
 *                          the resource has no path metadata. Display-path
 *                          keys in the override file are matched against
 *                          this value in addition to `logicalId`. Pass
 *                          `undefined` rather than the logical ID when no
 *                          path is known, so the override lookup does not
 *                          accidentally double-match the same key.
 * @param templateEnv       The function's `Properties.Environment.Variables`
 *                          object from the synthesized template, or
 *                          `undefined` when the function has no env vars.
 * @param overrides         Parsed `--env-vars` file contents, or
 *                          `undefined` when the flag was not passed.
 */
export function resolveEnvVars(
  logicalId: string,
  displayPath: string | undefined,
  templateEnv: Record<string, unknown> | undefined,
  overrides?: EnvOverrideFile
): EnvResolutionResult {
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];

  if (templateEnv) {
    for (const [key, value] of Object.entries(templateEnv)) {
      if (isLiteralEnvValue(value)) {
        resolved[key] = String(value);
      } else {
        unresolved.push(key);
      }
    }
  }

  if (overrides) {
    applyOverrideMap(resolved, overrides.Parameters);
    // Iterate non-Parameters keys in JSON insertion order so a
    // logical-ID + display-path collision applies later-wins (SAM-compat).
    //
    // Display-path matching mirrors the prefix rule the rest of cdkd
    // uses for `cdkd local invoke <target>` (`src/cli/cdk-path.ts`
    // `resolveCdkPathToLogicalIds`): an override key matches when the
    // resource's `aws:cdk:path` is exactly that key OR starts with
    // `key + "/"`. That lets a user write `MyStack/MyFn` (the L2 form
    // they read from CDK app code, same form `cdkd local invoke`
    // accepts) and have it match the synthesized L1 resource at
    // `MyStack/MyFn/Resource` — without forcing them to look up the
    // `/Resource` suffix.
    for (const [key, val] of Object.entries(overrides)) {
      if (key === 'Parameters') continue;
      if (!val || typeof val !== 'object') continue;
      if (key === logicalId) {
        applyOverrideMap(resolved, val);
        continue;
      }
      if (displayPath && (displayPath === key || displayPath.startsWith(`${key}/`))) {
        applyOverrideMap(resolved, val);
      }
    }
  }

  return { resolved, unresolved };
}

/**
 * Apply one override map to the accumulator. `null` clears a key (SAM
 * compatibility); any other value is coerced to string. Unknown shapes are
 * silently skipped — the file format is loose and we don't want to fail a
 * whole run on one bad entry.
 */
function applyOverrideMap(
  acc: Record<string, string>,
  map: Record<string, string | null> | undefined
): void {
  if (!map) return;
  for (const [key, value] of Object.entries(map)) {
    if (value === null) {
      delete acc[key];
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      acc[key] = String(value);
    }
  }
}

/**
 * A value is "literal" iff it's a string / number / boolean. CFn intrinsic
 * functions are encoded as objects with a single key starting with `Fn::`
 * (or the special-case `Ref`). Anything that isn't a primitive is treated
 * as unresolvable — there is no safe way to substitute an object/array
 * into a Linux env var.
 */
function isLiteralEnvValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
