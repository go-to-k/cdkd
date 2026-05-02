import type { ProviderRegistry } from '../provisioning/provider-registry.js';
import type { ResourceState, StackState } from '../types/state.js';
import { getLogger } from '../utils/logger.js';

/**
 * One rewrite the orphan rewriter has applied (or wanted to apply but
 * couldn't). Rendered as the audit table that `cdkd orphan` prints before
 * (and during) state save.
 *
 * - `kind: 'ref'` — a `{Ref: O}` was replaced with `O.physicalId`.
 * - `kind: 'getAtt'` — a `{Fn::GetAtt: [O, attr]}` (array OR string form)
 *   was replaced with the live attribute value.
 * - `kind: 'sub'` — an `${O}` or `${O.attr}` placeholder inside an
 *   `Fn::Sub` template string was substituted in place. The substituted
 *   sub-template (rather than the whole Fn::Sub block) is recorded so the
 *   audit row shows exactly what changed.
 * - `kind: 'dependency'` — the orphan's logicalId was removed from the
 *   `dependencies` array of another resource.
 *
 * `before` and `after` are JSON-serializable snapshots; the CLI renders
 * them as `JSON.stringify(value)` in the audit table.
 */
export interface OrphanRewrite {
  /** logicalId of the resource whose state was rewritten. */
  logicalId: string;
  /** Dotted JSON-pointer-ish path within the resource (e.g. `properties.Bucket`). */
  path: string;
  kind: 'ref' | 'getAtt' | 'sub' | 'dependency';
  before: unknown;
  after: unknown;
  /**
   * logicalId of the orphan that this rewrite resolved. Useful for the
   * audit table header ("rewrites caused by orphaning O") and for
   * grouping unresolvable-attribute errors by orphan.
   */
  orphanLogicalId: string;
}

/**
 * One reference to an orphan that the rewriter could not resolve.
 *
 * Collected up front (rather than thrown immediately) so a single failed
 * orphan run can list every unresolvable site at once instead of forcing
 * the user through one fix-rerun-fix cycle per attribute.
 */
export interface UnresolvableReference {
  /** logicalId of the resource that holds the unresolvable reference. */
  logicalId: string;
  path: string;
  /** logicalId of the orphan whose attribute could not be fetched. */
  orphanLogicalId: string;
  /** The CFn attribute name (`Arn`, `Ref`, `WebsiteURL`, …). `Ref` for `{Ref: O}` and Fn::Sub `${O}`. */
  attribute: string;
  /** Human-readable reason. */
  reason: string;
}

/**
 * Result of {@link rewriteResourceReferences}.
 *
 * `state` is a brand-new `StackState` value (input is not mutated). When
 * `unresolvable` is non-empty the caller decides whether to abort
 * (default) or to fall back to cached attributes via `--force`. The
 * `rewrites` audit log is always populated even on failure so users see
 * what _would_ have changed.
 */
export interface OrphanRewriteResult {
  state: StackState;
  rewrites: OrphanRewrite[];
  unresolvable: UnresolvableReference[];
}

/**
 * Caller-supplied options that control how unresolvable references are
 * handled.
 *
 * - `force = false` (default): unresolvable references are collected and
 *   returned via `unresolvable`; the caller is expected to abort.
 * - `force = true`: the rewriter consults the orphan's
 *   `state.attributes` cache as a fallback. If the cache holds a value
 *   for the attribute, the original intrinsic is replaced with that
 *   value and a warning is logged. If the cache also lacks the attr,
 *   the rewriter leaves the original intrinsic untouched (it does NOT
 *   substitute a literal `undefined` / `null`) and surfaces the site
 *   via `unresolvable` for visibility.
 */
export interface OrphanRewriteOptions {
  force?: boolean;
}

/**
 * Live-fetch helper. Wraps `provider.getAttribute(...)` for one orphan
 * resource and memoizes results so multiple references to the same
 * `(orphan, attr)` pair only hit AWS once.
 *
 * Exposed as a class so the unit tests can plug in a fake registry
 * without faking the AWS SDK.
 */
class AttributeFetcher {
  private cache = new Map<string, unknown>();
  private logger = getLogger().child('OrphanRewriter');

  constructor(
    private orphans: Record<string, ResourceState>,
    private providerRegistry: ProviderRegistry,
    private options: OrphanRewriteOptions
  ) {}

  /**
   * Return the orphan's resolved value for `Ref` (its physicalId) — never
   * needs an AWS call.
   */
  ref(orphanLogicalId: string): string {
    const o = this.orphans[orphanLogicalId];
    if (!o) {
      throw new Error(
        `Internal: Ref to '${orphanLogicalId}' has no orphan entry — should have been filtered out`
      );
    }
    return o.physicalId;
  }

  /**
   * Return the orphan's resolved value for `Fn::GetAtt`. Hits the live
   * provider on first call; subsequent calls reuse the cached result.
   *
   * Returns `{ ok: true, value }` on success; `{ ok: false, reason }`
   * when the live fetch failed AND the `--force` cache fallback either
   * was disabled or also lacked the attribute. In the cache-fallback
   * success path returns `{ ok: true, value, fromCache: true }`.
   */
  async getAtt(
    orphanLogicalId: string,
    attribute: string
  ): Promise<{ ok: true; value: unknown; fromCache?: boolean } | { ok: false; reason: string }> {
    const cacheKey = `${orphanLogicalId}\0${attribute}`;
    if (this.cache.has(cacheKey)) {
      return { ok: true, value: this.cache.get(cacheKey) };
    }

    const orphan = this.orphans[orphanLogicalId];
    if (!orphan) {
      return {
        ok: false,
        reason: `Internal: GetAtt to '${orphanLogicalId}' has no orphan entry`,
      };
    }

    let provider;
    try {
      provider = this.providerRegistry.getProvider(orphan.resourceType);
    } catch (err) {
      return {
        ok: false,
        reason: `no provider available for ${orphan.resourceType}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!provider.getAttribute) {
      return this.cacheFallback(
        orphanLogicalId,
        attribute,
        `provider for ${orphan.resourceType} does not implement getAttribute`
      );
    }

    try {
      const value = await provider.getAttribute(orphan.physicalId, orphan.resourceType, attribute);
      if (value === undefined) {
        return this.cacheFallback(
          orphanLogicalId,
          attribute,
          `provider returned undefined for ${orphan.resourceType}.${attribute}`
        );
      }
      this.cache.set(cacheKey, value);
      return { ok: true, value };
    } catch (err) {
      return this.cacheFallback(
        orphanLogicalId,
        attribute,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Try the orphan's `state.attributes[attribute]` as a last-resort value
   * source under `--force`. Without `--force`, returns the original
   * failure reason unchanged (caller pushes to `unresolvable`).
   */
  private cacheFallback(
    orphanLogicalId: string,
    attribute: string,
    reason: string
  ): { ok: true; value: unknown; fromCache: true } | { ok: false; reason: string } {
    if (!this.options.force) {
      return { ok: false, reason };
    }
    const orphan = this.orphans[orphanLogicalId]!;
    const cached = orphan.attributes?.[attribute];
    if (cached === undefined) {
      this.logger.warn(
        `--force: state.attributes also lacks '${orphanLogicalId}.${attribute}'; leaving the original intrinsic in place.`
      );
      return {
        ok: false,
        reason: `${reason}; state.attributes cache also has no value for '${attribute}'`,
      };
    }
    this.logger.warn(
      `--force: live fetch failed for '${orphanLogicalId}.${attribute}' (${reason}); ` +
        `falling back to cached value from state.attributes.`
    );
    const cacheKey = `${orphanLogicalId}\0${attribute}`;
    this.cache.set(cacheKey, cached);
    return { ok: true, value: cached, fromCache: true };
  }
}

/**
 * Rewrite every reference to the orphan resources in the rest of the
 * stack state, returning a NEW `StackState` (the input is treated as
 * immutable so callers can take a pre-orphan snapshot before invoking
 * this).
 *
 * Behavior is the inverse of `IntrinsicFunctionResolver`: the resolver
 * substitutes intrinsic functions when *deploying* a template; the
 * orphan rewriter substitutes them in *already-deployed state* so cdkd
 * forgets the orphan exists without breaking sibling resources that
 * still reference it.
 *
 * The rewriter handles the four reference shapes that show up in
 * persisted state:
 *
 * 1. `{Ref: O}` → orphan.physicalId
 * 2. `{Fn::GetAtt: [O, attr]}` → live `provider.getAttribute(...)` value
 * 3. `{Fn::GetAtt: "O.attr"}` (string form) → same as #2
 * 4. `Fn::Sub` template strings — `${O}` and `${O.attr}` placeholders
 *    are substituted in place; unrelated placeholders are preserved.
 *
 * Plus dependency-array entries equal to an orphan logicalId are
 * removed.
 *
 * If `options.force` is false (the default), any unresolvable
 * `Fn::GetAtt` (provider error, missing impl, undefined return) is
 * collected and returned via `unresolvable` instead of being fixed up;
 * the caller is expected to abort. With `--force`, unresolvable
 * fetches fall back to the orphan's cached `state.attributes` and emit
 * a warning per case; if the cache also lacks the attr, the original
 * intrinsic is left alone (NOT replaced with `undefined`/`null`).
 *
 * Multi-orphan circular references are handled by reading every
 * `Ref` / `GetAtt` from the *original* orphan snapshot rather than
 * the in-flight rewritten state, so orphan A's reference to orphan B
 * still resolves cleanly to B's pre-removal physicalId.
 */
export async function rewriteResourceReferences(
  state: StackState,
  orphanLogicalIds: string[],
  providerRegistry: ProviderRegistry,
  options: OrphanRewriteOptions = {}
): Promise<OrphanRewriteResult> {
  const orphanSet = new Set(orphanLogicalIds);

  // Snapshot the orphan resources so multi-orphan circular refs (orphan A
  // references orphan B and vice versa) resolve against original state,
  // not against the in-flight rewrites.
  const orphans: Record<string, ResourceState> = {};
  for (const id of orphanLogicalIds) {
    const r = state.resources[id];
    if (!r) {
      throw new Error(`rewriteResourceReferences: orphan '${id}' not found in state.resources`);
    }
    orphans[id] = r;
  }

  const fetcher = new AttributeFetcher(orphans, providerRegistry, options);
  const rewrites: OrphanRewrite[] = [];
  const unresolvable: UnresolvableReference[] = [];

  // Build the new resources map, skipping the orphans themselves.
  const newResources: Record<string, ResourceState> = {};
  for (const [logicalId, resource] of Object.entries(state.resources)) {
    if (orphanSet.has(logicalId)) continue;

    const rewrittenProperties = await rewriteValue(
      resource.properties as unknown,
      `properties`,
      logicalId,
      orphanSet,
      fetcher,
      rewrites,
      unresolvable
    );

    const rewrittenAttributes = resource.attributes
      ? await rewriteValue(
          resource.attributes as unknown,
          `attributes`,
          logicalId,
          orphanSet,
          fetcher,
          rewrites,
          unresolvable
        )
      : undefined;

    const newDeps = (resource.dependencies ?? []).filter((dep) => {
      if (orphanSet.has(dep)) {
        rewrites.push({
          logicalId,
          path: 'dependencies',
          kind: 'dependency',
          before: dep,
          after: null,
          orphanLogicalId: dep,
        });
        return false;
      }
      return true;
    });

    newResources[logicalId] = {
      ...resource,
      properties: rewrittenProperties as Record<string, unknown>,
      ...(rewrittenAttributes !== undefined && {
        attributes: rewrittenAttributes as Record<string, unknown>,
      }),
      dependencies: newDeps,
    };
  }

  // Outputs may also reference the orphan (e.g. CDK output { Value: { Ref: O } }).
  const newOutputs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(state.outputs ?? {})) {
    newOutputs[name] = await rewriteValue(
      value,
      `outputs.${name}`,
      `<output:${name}>`,
      orphanSet,
      fetcher,
      rewrites,
      unresolvable
    );
  }

  return {
    state: {
      ...state,
      resources: newResources,
      outputs: newOutputs,
      lastModified: Date.now(),
    },
    rewrites,
    unresolvable,
  };
}

/**
 * Recursively walk a value (property tree, attribute tree, output value)
 * and replace every `Ref` / `Fn::GetAtt` / `Fn::Sub` reference to an
 * orphan with the orphan's resolved physical id / live attribute /
 * substituted template string respectively.
 *
 * Mirrors the recursion structure of `IntrinsicFunctionResolver` but
 * works in the inverse direction: only orphan references are substituted,
 * every other intrinsic is left intact (the deploy engine will resolve
 * those again on the next deploy).
 */
export async function rewriteReferencesInValue(
  value: unknown,
  pathPrefix: string,
  ownerLogicalId: string,
  orphanSet: Set<string>,
  fetcher: AttributeFetcher,
  rewrites: OrphanRewrite[],
  unresolvable: UnresolvableReference[]
): Promise<unknown> {
  return rewriteValue(
    value,
    pathPrefix,
    ownerLogicalId,
    orphanSet,
    fetcher,
    rewrites,
    unresolvable
  );
}

async function rewriteValue(
  value: unknown,
  pathPrefix: string,
  ownerLogicalId: string,
  orphanSet: Set<string>,
  fetcher: AttributeFetcher,
  rewrites: OrphanRewrite[],
  unresolvable: UnresolvableReference[]
): Promise<unknown> {
  // Primitives: no references possible.
  if (typeof value !== 'object' || value === null) return value;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(
        await rewriteValue(
          value[i],
          `${pathPrefix}[${i}]`,
          ownerLogicalId,
          orphanSet,
          fetcher,
          rewrites,
          unresolvable
        )
      );
    }
    return out;
  }

  const obj = value as Record<string, unknown>;

  // {Ref: orphanLogicalId} → physicalId.
  // Only when the Ref target is in orphanSet — otherwise leave the
  // intrinsic alone so the deploy engine resolves it on next deploy.
  if ('Ref' in obj && Object.keys(obj).length === 1 && typeof obj['Ref'] === 'string') {
    const target = obj['Ref'];
    if (orphanSet.has(target)) {
      const replaced = fetcher.ref(target);
      rewrites.push({
        logicalId: ownerLogicalId,
        path: pathPrefix,
        kind: 'ref',
        before: { Ref: target },
        after: replaced,
        orphanLogicalId: target,
      });
      return replaced;
    }
    return value;
  }

  // {Fn::GetAtt: [orphan, attr]} or {Fn::GetAtt: "orphan.attr"}.
  if ('Fn::GetAtt' in obj && Object.keys(obj).length === 1) {
    const arg = obj['Fn::GetAtt'];
    let target: string | undefined;
    let attribute: string | undefined;
    if (
      Array.isArray(arg) &&
      arg.length === 2 &&
      typeof arg[0] === 'string' &&
      typeof arg[1] === 'string'
    ) {
      target = arg[0];
      attribute = arg[1];
    } else if (typeof arg === 'string') {
      const dot = arg.indexOf('.');
      if (dot > 0) {
        target = arg.slice(0, dot);
        attribute = arg.slice(dot + 1);
      }
    }

    if (target && attribute && orphanSet.has(target)) {
      const result = await fetcher.getAtt(target, attribute);
      if (result.ok) {
        rewrites.push({
          logicalId: ownerLogicalId,
          path: pathPrefix,
          kind: 'getAtt',
          before: { 'Fn::GetAtt': [target, attribute] },
          after: result.value,
          orphanLogicalId: target,
        });
        return result.value;
      }
      unresolvable.push({
        logicalId: ownerLogicalId,
        path: pathPrefix,
        orphanLogicalId: target,
        attribute,
        reason: result.reason,
      });
      // Leave original intrinsic in place when unresolvable.
      return value;
    }
    return value;
  }

  // Fn::Sub: scan ${O} and ${O.attr} placeholders that target an orphan;
  // splice in resolved values, preserve unrelated placeholders.
  if ('Fn::Sub' in obj && Object.keys(obj).length === 1) {
    const arg = obj['Fn::Sub'];
    let template: string | undefined;
    let varMap: Record<string, unknown> | undefined;
    if (typeof arg === 'string') {
      template = arg;
    } else if (
      Array.isArray(arg) &&
      arg.length === 2 &&
      typeof arg[0] === 'string' &&
      typeof arg[1] === 'object' &&
      arg[1] !== null
    ) {
      template = arg[0];
      varMap = arg[1] as Record<string, unknown>;
    }

    if (template !== undefined) {
      const { rewritten, didChange, hasUnresolvable } = await rewriteSubTemplate(
        template,
        ownerLogicalId,
        pathPrefix,
        orphanSet,
        fetcher,
        rewrites,
        unresolvable,
        varMap
      );

      if (didChange) {
        // If the rewrite consumed every reference to an orphan, the result
        // can collapse to a plain string. We keep the Fn::Sub wrapper if a
        // non-orphan placeholder remains so the deploy engine can re-resolve
        // it later.
        const stillHasIntrinsics = /\$\{[^}]+\}/.test(rewritten);
        if (varMap && stillHasIntrinsics) {
          return { 'Fn::Sub': [rewritten, varMap] };
        }
        if (stillHasIntrinsics) {
          return { 'Fn::Sub': rewritten };
        }
        return rewritten;
      }
      // No change but unresolvable: leave the Fn::Sub block alone.
      // (hasUnresolvable already pushed the failure into `unresolvable`.)
      void hasUnresolvable;
      return value;
    }
    return value;
  }

  // Plain object: recurse into each key.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = await rewriteValue(
      v,
      pathPrefix === '' ? k : `${pathPrefix}.${k}`,
      ownerLogicalId,
      orphanSet,
      fetcher,
      rewrites,
      unresolvable
    );
  }
  return out;
}

/**
 * Walk a single Fn::Sub template string and replace each `${X}` /
 * `${X.attr}` placeholder that points at an orphan. Unrelated
 * placeholders (refs to non-orphan resources, parameter / pseudo-parameter
 * placeholders) are preserved verbatim so the deploy engine can resolve
 * them on the next deploy.
 */
async function rewriteSubTemplate(
  template: string,
  ownerLogicalId: string,
  pathPrefix: string,
  orphanSet: Set<string>,
  fetcher: AttributeFetcher,
  rewrites: OrphanRewrite[],
  unresolvable: UnresolvableReference[],
  varMap?: Record<string, unknown>
): Promise<{ rewritten: string; didChange: boolean; hasUnresolvable: boolean }> {
  const placeholderRe = /\$\{([^}]+)\}/g;
  const matches = [...template.matchAll(placeholderRe)];
  if (matches.length === 0) {
    return { rewritten: template, didChange: false, hasUnresolvable: false };
  }

  let didChange = false;
  let hasUnresolvable = false;
  // Build the rewritten string by scanning left to right; matchAll preserves
  // index order so we can use match.index reliably.
  let cursor = 0;
  let out = '';
  for (const m of matches) {
    const inner = m[1] ?? '';
    const start = m.index ?? 0;
    out += template.slice(cursor, start);
    cursor = start + m[0].length;

    // Explicit Fn::Sub var map shadows resource references.
    if (varMap && inner in varMap) {
      out += m[0];
      continue;
    }

    const dot = inner.indexOf('.');
    if (dot < 0) {
      // ${X} — Ref form.
      if (orphanSet.has(inner)) {
        const replaced = fetcher.ref(inner);
        rewrites.push({
          logicalId: ownerLogicalId,
          path: pathPrefix,
          kind: 'sub',
          before: m[0],
          after: replaced,
          orphanLogicalId: inner,
        });
        out += replaced;
        didChange = true;
      } else {
        out += m[0];
      }
    } else {
      // ${X.attr} — GetAtt form.
      const target = inner.slice(0, dot);
      const attribute = inner.slice(dot + 1);
      if (orphanSet.has(target)) {
        const result = await fetcher.getAtt(target, attribute);
        if (result.ok) {
          const stringified = String(result.value);
          rewrites.push({
            logicalId: ownerLogicalId,
            path: pathPrefix,
            kind: 'sub',
            before: m[0],
            after: stringified,
            orphanLogicalId: target,
          });
          out += stringified;
          didChange = true;
        } else {
          unresolvable.push({
            logicalId: ownerLogicalId,
            path: pathPrefix,
            orphanLogicalId: target,
            attribute,
            reason: result.reason,
          });
          out += m[0];
          hasUnresolvable = true;
        }
      } else {
        out += m[0];
      }
    }
  }
  out += template.slice(cursor);
  return { rewritten: out, didChange, hasUnresolvable };
}
