/**
 * State-driven env-var resolution for `cdkd local invoke --from-state`.
 *
 * The PR 1 env-resolver classifies any non-literal env-var value (a CFn
 * intrinsic like `Ref` / `Fn::GetAtt` / `Fn::Sub`) as "unresolved" and
 * drops it. That's correct when there's no source of truth for the
 * deployed value — which is also the SAM behavior — but it's wrong when
 * cdkd has already deployed the stack and the AWS-current physical IDs
 * sit in the cdkd state file.
 *
 * `--from-state` closes that gap: it loads cdkd's S3 state for the target
 * stack and substitutes `Ref` / `Fn::GetAtt` / `Fn::Sub` placeholders in
 * the function's `Properties.Environment.Variables` with the deployed
 * values. The result feeds back into the existing
 * `resolveEnvVars(...)` pipeline so `--env-vars` overrides still take
 * precedence — that ordering matters because users routinely override a
 * single variable while using `--from-state` to recover the rest.
 *
 * Scope:
 *
 *   - `Ref: <LogicalId>` — substituted with `state.resources[id].physicalId`.
 *   - `Fn::GetAtt: [<LogicalId>, <attr>]` (and the `"LogicalId.attr"`
 *     string form) — substituted with
 *     `state.resources[id].attributes[attr]`. We deliberately do NOT
 *     synthesize attributes the provider would normally compute (e.g.
 *     IAM role ARNs derived from physicalId + accountId) — `--from-state`
 *     surfaces only what cdkd recorded at deploy time, which is what the
 *     deployed Lambda's env actually saw.
 *   - `Fn::Sub: '<template>'` (and the two-argument `[template, vars]`
 *     form) — `${LogicalId}` / `${LogicalId.attr}` placeholders are
 *     substituted in place; pseudo parameters (`${AWS::AccountId}` /
 *     `${AWS::Region}` / `${AWS::Partition}` / `${AWS::URLSuffix}`) are
 *     substituted from the optional `pseudoParameters` bag; unrelated
 *     placeholders (mapping references, parameters) are left untouched
 *     and the value is treated as unresolved.
 *   - `Fn::Join: [<delimiter>, [<elements>...]]` — every element is
 *     recursively resolved via this same module and joined with the
 *     delimiter. Closes Gap 1 of issue #286 (the SSM Parameter
 *     `ecs.Secret.fromSsmParameter` shape CDK synthesizes is
 *     `Fn::Join` with pseudo-parameter `Ref`s + a `Ref` to the
 *     parameter; without Fn::Join support the secret silently drops).
 *   - `Ref: AWS::AccountId` / `AWS::Region` / `AWS::Partition` /
 *     `AWS::URLSuffix` — substituted from the optional
 *     `pseudoParameters` bag the caller supplies. When the bag is
 *     missing (or the specific key isn't set), the placeholder reports
 *     unresolved — same warn-and-drop policy as every other miss.
 *
 * Out of scope (deferred):
 *
 *   - Cross-stack `Fn::ImportValue` / `Fn::GetStackOutput`.
 *   - Other intrinsics (`Fn::Select`, `Fn::Split`, `Fn::If`, etc.).
 *     Anything beyond the five above is reported as unresolved and the
 *     env var is dropped, matching PR 1's "warn-and-drop" semantics.
 *
 * Failure mode: per-key best-effort. When a substitution can't be
 * produced (state missing for the referenced logical ID, attribute not
 * captured at deploy time, unsupported intrinsic in `Fn::Sub`), the key
 * is reported as unresolved and the caller drops it from the env block
 * with a warn. We never throw out of substitution — a bad reference in
 * one env var must not abort the whole `cdkd local invoke` call.
 */

import type { ResourceState } from '../types/state.js';

/**
 * Result of substituting a single env-var value against state.
 *
 * The discriminated union is load-bearing: callers decide whether to
 * pass the substituted value into the regular env-resolver pipeline
 * (which then accepts it as a literal) or to drop the key with a warn.
 */
export type StateSubstitutionResult =
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'unresolved'; reason: string };

/**
 * AWS pseudo parameters supplied by the caller. When set, `Ref: AWS::*`
 * and `${AWS::*}` placeholders inside `Fn::Sub` / `Fn::Join` bodies are
 * substituted from this bag. The CLI layer typically derives every
 * field from the resolved region + an `sts:GetCallerIdentity` call
 * (see `derivePartitionAndUrlSuffix` in `ecs-task-resolver.ts`).
 *
 * Every key is optional; a missing key reports unresolved per the
 * standard warn-and-drop policy.
 */
export interface PseudoParameters {
  accountId?: string;
  region?: string;
  partition?: string;
  urlSuffix?: string;
}

export interface SubstitutionContext {
  /** State-recorded resources for `Ref` / `Fn::GetAtt` / `${LogicalId}` lookups. */
  resources: Record<string, ResourceState>;
  /** Optional pseudo-parameter bag for AWS::* placeholders. */
  pseudoParameters?: PseudoParameters;
}

/**
 * Substitute a single env-var / secret-ValueFrom value (which may be a
 * CFn intrinsic) against the provided state-recorded resources map and
 * optional pseudo-parameter bag.
 *
 * Pure / synchronous / no AWS calls. The caller fetches state via
 * `S3StateBackend.getState(...)` once and (when needed) calls
 * `sts:GetCallerIdentity` once for the `accountId`, then feeds both into
 * each intrinsic substitution.
 *
 * Backward compatible: callers may pass `resources` directly (the
 * pre-PR shape) and the helper will assume `pseudoParameters` is
 * unset — matching the `cdkd local invoke --from-state` v1 contract.
 */
export function substituteAgainstState(
  value: unknown,
  contextOrResources: SubstitutionContext | Record<string, ResourceState>
): StateSubstitutionResult {
  const context: SubstitutionContext = isContext(contextOrResources)
    ? contextOrResources
    : { resources: contextOrResources };

  // Primitives are already literal — nothing to substitute. The caller
  // (`mergeFromStateIntoTemplateEnv`) generally won't reach this path
  // because the env-resolver already keeps literals untouched, but we
  // accept it here so callers can treat the function uniformly.
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'literal', value };
  }

  if (value === null || typeof value !== 'object') {
    return {
      kind: 'unresolved',
      reason: `unsupported value type: ${value === null ? 'null' : typeof value}`,
    };
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    return {
      kind: 'unresolved',
      reason: `expected an intrinsic with one key, got ${keys.length} keys`,
    };
  }

  const intrinsic = keys[0]!;
  const arg = obj[intrinsic];

  if (intrinsic === 'Ref') {
    return resolveRef(arg, context);
  }
  if (intrinsic === 'Fn::GetAtt') {
    return resolveGetAtt(arg, context);
  }
  if (intrinsic === 'Fn::Sub') {
    return resolveSub(arg, context);
  }
  if (intrinsic === 'Fn::Join') {
    return resolveJoin(arg, context);
  }

  return {
    kind: 'unresolved',
    reason: `unsupported intrinsic '${intrinsic}' (supported: Ref, Fn::GetAtt, Fn::Sub, Fn::Join)`,
  };
}

function isContext(
  v: SubstitutionContext | Record<string, ResourceState>
): v is SubstitutionContext {
  // SubstitutionContext requires a `resources` key whose value is itself
  // an object; a bare `Record<string, ResourceState>` has logical-ID keys
  // whose values are ResourceState objects (with `physicalId` etc.). The
  // discriminator: if the value has a `resources` field that is itself an
  // object AND lacks the ResourceState-shaped fields, it's a context.
  if (typeof v !== 'object' || v === null) return false;
  const r = (v as Record<string, unknown>)['resources'];
  if (r === undefined) return false;
  if (typeof r !== 'object' || r === null) return false;
  // A ResourceState has `physicalId` + `resourceType` at the top level;
  // a SubstitutionContext's `resources` is a record of ResourceStates,
  // so the value under `resources` typically lacks `physicalId` itself.
  return !('physicalId' in r);
}

function resolveRef(arg: unknown, context: SubstitutionContext): StateSubstitutionResult {
  if (typeof arg !== 'string' || arg.length === 0) {
    return { kind: 'unresolved', reason: `Ref expects a non-empty logical ID, got ${typeof arg}` };
  }
  if (arg.startsWith('AWS::')) {
    return resolvePseudoParameter(arg, context.pseudoParameters);
  }
  const resource = context.resources[arg];
  if (!resource) {
    return {
      kind: 'unresolved',
      reason: `Ref '${arg}': no record in cdkd state (was the resource deployed?)`,
    };
  }
  return { kind: 'literal', value: resource.physicalId };
}

function resolvePseudoParameter(
  name: string,
  pseudo: PseudoParameters | undefined
): StateSubstitutionResult {
  if (!pseudo) {
    return {
      kind: 'unresolved',
      reason: `Ref '${name}': pseudo parameter not supplied (need --from-state context)`,
    };
  }
  switch (name) {
    case 'AWS::AccountId':
      if (pseudo.accountId !== undefined) return { kind: 'literal', value: pseudo.accountId };
      break;
    case 'AWS::Region':
      if (pseudo.region !== undefined) return { kind: 'literal', value: pseudo.region };
      break;
    case 'AWS::Partition':
      if (pseudo.partition !== undefined) return { kind: 'literal', value: pseudo.partition };
      break;
    case 'AWS::URLSuffix':
      if (pseudo.urlSuffix !== undefined) return { kind: 'literal', value: pseudo.urlSuffix };
      break;
    default:
      return {
        kind: 'unresolved',
        reason: `Ref '${name}': pseudo parameter not supported (supported: AWS::AccountId, AWS::Region, AWS::Partition, AWS::URLSuffix)`,
      };
  }
  return { kind: 'unresolved', reason: `Ref '${name}': pseudo parameter value not resolved` };
}

function resolveGetAtt(arg: unknown, context: SubstitutionContext): StateSubstitutionResult {
  let logicalId: string;
  let attr: string;
  if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string') {
    logicalId = arg[0];
    if (typeof arg[1] !== 'string') {
      return {
        kind: 'unresolved',
        reason: `Fn::GetAtt's second arg must be a string attribute name, got ${typeof arg[1]} (nested intrinsics in attribute names are not supported)`,
      };
    }
    attr = arg[1];
  } else if (typeof arg === 'string') {
    const dot = arg.indexOf('.');
    if (dot <= 0 || dot === arg.length - 1) {
      return {
        kind: 'unresolved',
        reason: `Fn::GetAtt string form must be '<LogicalId>.<Attribute>', got '${arg}'`,
      };
    }
    logicalId = arg.slice(0, dot);
    attr = arg.slice(dot + 1);
  } else {
    return {
      kind: 'unresolved',
      reason: `Fn::GetAtt expects [LogicalId, Attribute] or 'LogicalId.Attribute', got ${
        Array.isArray(arg) ? `array of length ${arg.length}` : typeof arg
      }`,
    };
  }

  const resource = context.resources[logicalId];
  if (!resource) {
    return {
      kind: 'unresolved',
      reason: `Fn::GetAtt '${logicalId}.${attr}': no record in cdkd state`,
    };
  }
  const cached = resource.attributes?.[attr];
  if (cached === undefined) {
    return {
      kind: 'unresolved',
      reason: `Fn::GetAtt '${logicalId}.${attr}': attribute not captured in cdkd state at deploy time`,
    };
  }
  if (typeof cached === 'string' || typeof cached === 'number' || typeof cached === 'boolean') {
    return { kind: 'literal', value: cached };
  }
  // Object/array attribute values (e.g. `S3CanonicalUserId` is a string,
  // but `Endpoints` on some resources is an object). Lambda env vars
  // have to be flat strings, so we surface them as JSON — same posture
  // CFn / SAM take, and lets the handler re-parse if it knows the shape.
  return { kind: 'literal', value: JSON.stringify(cached) };
}

/**
 * `Fn::Sub` accepts:
 *   - `'a-${LogicalId}-b'`  — single-string form, placeholders against
 *     the template / state / pseudo parameters.
 *   - `['a-${X}-b', { X: <intrinsic-or-literal> }]` — two-arg form, the
 *     map provides override values for placeholders that aren't logical
 *     IDs. We recursively resolve each map value via this same module
 *     so a placeholder bound to `{Ref: ...}` works.
 */
function resolveSub(arg: unknown, context: SubstitutionContext): StateSubstitutionResult {
  let template: string;
  let bindings: Record<string, unknown> = {};

  if (typeof arg === 'string') {
    template = arg;
  } else if (
    Array.isArray(arg) &&
    arg.length === 2 &&
    typeof arg[0] === 'string' &&
    arg[1] !== null &&
    typeof arg[1] === 'object' &&
    !Array.isArray(arg[1])
  ) {
    template = arg[0];
    bindings = arg[1] as Record<string, unknown>;
  } else {
    return {
      kind: 'unresolved',
      reason: `Fn::Sub expects a string or [string, object], got ${
        Array.isArray(arg) ? 'malformed array' : typeof arg
      }`,
    };
  }

  // Walk the template and substitute every `${...}` placeholder. We treat
  // any failure mid-walk as a failure for the whole value — partial
  // substitutions would silently produce wrong env vars.
  const placeholderRegex = /\$\{([^}]+)\}/g;
  const placeholders: string[] = [];
  template.replace(placeholderRegex, (_, key: string) => {
    placeholders.push(key);
    return '';
  });

  // Eagerly resolve every placeholder so we can fail fast with a clean
  // reason instead of leaving a half-rewritten string.
  const resolutions = new Map<string, string>();
  for (const placeholder of placeholders) {
    if (resolutions.has(placeholder)) continue;

    if (placeholder in bindings) {
      const sub = substituteAgainstState(bindings[placeholder], context);
      if (sub.kind !== 'literal') {
        return {
          kind: 'unresolved',
          reason: `Fn::Sub placeholder '\${${placeholder}}': ${sub.reason}`,
        };
      }
      resolutions.set(placeholder, String(sub.value));
      continue;
    }

    // Pseudo parameter (`${AWS::AccountId}` etc.)
    if (placeholder.startsWith('AWS::')) {
      const sub = resolvePseudoParameter(placeholder, context.pseudoParameters);
      if (sub.kind !== 'literal') {
        return {
          kind: 'unresolved',
          reason: `Fn::Sub placeholder '\${${placeholder}}': ${sub.reason}`,
        };
      }
      resolutions.set(placeholder, String(sub.value));
      continue;
    }

    // Not in bindings, not a pseudo → treat as a `${LogicalId}` or `${LogicalId.attr}`.
    const dot = placeholder.indexOf('.');
    if (dot === -1) {
      const sub = resolveRef(placeholder, context);
      if (sub.kind !== 'literal') {
        return {
          kind: 'unresolved',
          reason: `Fn::Sub placeholder '\${${placeholder}}': ${sub.reason}`,
        };
      }
      resolutions.set(placeholder, String(sub.value));
    } else {
      const sub = resolveGetAtt(placeholder, context);
      if (sub.kind !== 'literal') {
        return {
          kind: 'unresolved',
          reason: `Fn::Sub placeholder '\${${placeholder}}': ${sub.reason}`,
        };
      }
      resolutions.set(placeholder, String(sub.value));
    }
  }

  const out = template.replace(placeholderRegex, (_, key: string) => {
    return resolutions.get(key) ?? '';
  });
  return { kind: 'literal', value: out };
}

/**
 * `Fn::Join: [<delimiter>, [<elements>]]` — recursively resolve every
 * element through `substituteAgainstState` and join with the delimiter.
 * Closes the SSM Parameter `ecs.Secret.fromSsmParameter` shape (Gap 1
 * of #286) where CDK synthesizes a `Fn::Join` over pseudo-parameter
 * `Ref`s + a `Ref` to the parameter.
 *
 * String / number / boolean elements pass through as-is; intrinsic
 * elements (`Ref` / `Fn::GetAtt` / nested `Fn::Sub` / nested `Fn::Join`)
 * recurse. Any unresolvable element fails the whole join — partial
 * substitutions would silently produce wrong values.
 */
function resolveJoin(arg: unknown, context: SubstitutionContext): StateSubstitutionResult {
  if (!Array.isArray(arg) || arg.length !== 2 || !Array.isArray(arg[1])) {
    return {
      kind: 'unresolved',
      reason: `Fn::Join expects [delimiter, [elements]], got ${
        Array.isArray(arg) ? `array of length ${arg.length}` : typeof arg
      }`,
    };
  }
  const [delimiterRaw, elements] = arg as [unknown, unknown[]];
  if (typeof delimiterRaw !== 'string') {
    return {
      kind: 'unresolved',
      reason: `Fn::Join delimiter must be a string, got ${typeof delimiterRaw}`,
    };
  }

  const parts: string[] = [];
  for (let i = 0; i < elements.length; i += 1) {
    const sub = substituteAgainstState(elements[i], context);
    if (sub.kind !== 'literal') {
      return {
        kind: 'unresolved',
        reason: `Fn::Join element [${i}]: ${sub.reason}`,
      };
    }
    parts.push(String(sub.value));
  }
  return { kind: 'literal', value: parts.join(delimiterRaw) };
}

/**
 * High-level helper: walk the function's `Properties.Environment.Variables`
 * map and produce a pre-resolved version where every value is a literal
 * (substituted from state when possible). Values that can't be substituted
 * are removed so the downstream `resolveEnvVars` treats them as missing
 * and the caller's existing intrinsic-warn-and-drop path fires.
 *
 * Returns the substitution audit alongside the rewritten map so the CLI
 * layer can log per-key info (`STATE_BUCKET=bucket-1234` / `TABLE_ARN
 * skipped: state missing`).
 */
export interface StateEnvSubstitutionAudit {
  /** Keys whose substitution succeeded — surfaced as literals in `env`. */
  resolvedKeys: string[];
  /**
   * Keys that the substituter could not resolve (state missing,
   * unsupported intrinsic, etc.) — paired with a per-key reason so the
   * CLI layer can warn-and-drop with context.
   */
  unresolved: Array<{ key: string; reason: string }>;
}

/**
 * Build a pre-substituted env map from the template entry by feeding each
 * intrinsic value through `substituteAgainstState`. Literal entries pass
 * through untouched (the env-resolver handles them).
 *
 * @param templateEnv  The function's `Properties.Environment.Variables`
 *                     map from the synthesized template, or `undefined`
 *                     when the function has no env vars.
 * @param resources    `state.resources` from cdkd's S3 state file for
 *                     the function's stack.
 */
export function substituteEnvVarsFromState(
  templateEnv: Record<string, unknown> | undefined,
  contextOrResources: SubstitutionContext | Record<string, ResourceState>
): { env: Record<string, unknown>; audit: StateEnvSubstitutionAudit } {
  const env: Record<string, unknown> = {};
  const audit: StateEnvSubstitutionAudit = { resolvedKeys: [], unresolved: [] };

  if (!templateEnv) return { env, audit };

  const context: SubstitutionContext = isContext(contextOrResources)
    ? contextOrResources
    : { resources: contextOrResources };

  for (const [key, value] of Object.entries(templateEnv)) {
    // Cheap fast path for already-literal values: no substitution
    // attempted, no audit entry — env-resolver will simply keep them.
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      env[key] = value;
      continue;
    }

    const result = substituteAgainstState(value, context);
    if (result.kind === 'literal') {
      env[key] = result.value;
      audit.resolvedKeys.push(key);
    } else {
      audit.unresolved.push({ key, reason: result.reason });
      // Intentionally drop the key — that way the downstream
      // env-resolver sees "no template value for K" and the existing
      // PR 1 warn-and-drop fires with the same UX.
    }
  }

  return { env, audit };
}
