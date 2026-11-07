import type { ProviderRegistry } from '../../provisioning/provider-registry.js';
import type { ResourceState, StackState } from '../../types/state.js';
import { stackInstanceIdCarriedFrom } from '../../types/state.js';
import { retiredNameGenerationsAfter } from '../../state/name-generation.js';
import type {
  OrphanRewrite,
  OrphanRewriteOptions,
  OrphanRewriteResult,
  UnresolvableReference,
} from './types.js';
import { AttributeFetcher } from './attribute-fetcher.js';

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
 * 2. `{Fn::GetAtt: [O, attr]}` → the orphan's recorded `attributes[attr]`
 *    when servable (go-to-k/cdkd#4186), else live `provider.getAttribute(...)`
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
  //
  // PRESENCE is `Object.hasOwn`, not truthiness: a `null` entry IS in the map,
  // and `cdkd orphan` over it is the way out of it (go-to-k/cdkd#3350) — the
  // falsy test threw this internal error instead. What the fetcher then does
  // with a record it cannot read is `UNREADABLE_ORPHAN_RECORD_REASON`'s.
  const orphans: Record<string, ResourceState> = Object.create(null);
  for (const id of orphanLogicalIds) {
    if (!Object.hasOwn(state.resources, id)) {
      throw new Error(`rewriteResourceReferences: orphan '${id}' not found in state.resources`);
    }
    orphans[id] = state.resources[id]!;
  }

  const fetcher = new AttributeFetcher(orphans, providerRegistry, options);
  const rewrites: OrphanRewrite[] = [];
  const unresolvable: UnresolvableReference[] = [];

  // Build the new resources map, skipping the orphans themselves.
  const newResources: Record<string, ResourceState> = {};
  for (const [logicalId, resource] of Object.entries(state.resources ?? {})) {
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

  // `skippedOutputs` (issue #2740) is DROPPED rather than carried, as
  // `cdkd import`, `cdkd drift --accept` and `cdkd rollback` drop it. This
  // rewrite substitutes FETCHED values into `properties`, `attributes` and
  // `outputs`, and a substitution alone can repair an output: an attribute
  // holding `{ "Fn::GetAtt": ["O", "NameServers"] }` makes an enclosing
  // `Fn::Select` fail, and replacing it with the fetched array makes that
  // output resolve — with the output's own digest unmoved and no template
  // resource change for the diff's change map to un-bind on. Carried, the
  // record would preview a key as absent while the next deploy publishes it.
  const { skippedOutputs: _droppedByOrphanRewrite, ...carriedState } = state;
  return {
    state: {
      ...carriedState,
      ...stackInstanceIdCarriedFrom(state),
      // go-to-k/cdkd#5064 phase 2: an orphaned record left the stack, so a
      // later create of its logical id asks for a name it never held.
      ...retiredNameGenerationsAfter(
        state,
        orphanLogicalIds
          .map((logicalId) => ({ logicalId, record: orphans[logicalId] }))
          .filter(
            (entry): entry is { logicalId: string; record: ResourceState } =>
              entry.record !== null && typeof entry.record === 'object'
          )
      ),
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
 * orphan with the orphan's resolved physical id / attribute value /
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
      const result = fetcher.ref(target);
      if (!result.ok) {
        // Same shape as the `Fn::GetAtt` arm below: record the site and leave
        // the original intrinsic in place. `attribute` is the literal `Ref`,
        // which the `UnresolvableReference` doc already reserves for this form.
        unresolvable.push({
          logicalId: ownerLogicalId,
          path: pathPrefix,
          orphanLogicalId: target,
          attribute: 'Ref',
          reason: result.reason,
        });
        return value;
      }
      rewrites.push({
        logicalId: ownerLogicalId,
        path: pathPrefix,
        kind: 'ref',
        before: { Ref: target },
        after: result.value,
        orphanLogicalId: target,
      });
      return result.value;
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
    //
    // `in` over the CALLER's plain object, so it answers for an INHERITED name
    // too (`'constructor' in {}` is true). Wherever the writer binds own keys
    // only, this reader therefore shadows one placeholder more than the writer
    // substitutes. RETAINED as the conservative direction (issue #2767, the
    // sweep that made the resolver's resource / parameter / condition / mapping
    // reads own-keys): over-shadowing leaves the reference in the `Fn::Sub` for
    // the deploy engine to re-resolve, while `Object.hasOwn` here would REWRITE
    // a placeholder the writer may treat as bound, changing a live template.
    //
    // The disagreeing population is `constructor` / `toString` / `valueOf` /
    // `hasOwnProperty` and their siblings -- names that are `in` an object
    // without being own. It is NOT `__proto__`, which `JSON.parse` makes an own
    // key and both spellings therefore agree on. `crossStackSourceKey` in
    // `src/deployment/secret-redaction.ts` keeps the same wider test for the
    // same reason; this is the second copy of that decision.
    if (varMap && inner in varMap) {
      out += m[0];
      continue;
    }

    const dot = inner.indexOf('.');
    if (dot < 0) {
      // ${X} — Ref form.
      if (orphanSet.has(inner)) {
        const result = fetcher.ref(inner);
        if (!result.ok) {
          // Mirrors the `${X.attr}` arm below: preserve the placeholder and
          // record the site, so a non-`--force` run aborts instead of splicing
          // a value cdkd knows is wrong.
          unresolvable.push({
            logicalId: ownerLogicalId,
            path: pathPrefix,
            orphanLogicalId: inner,
            attribute: 'Ref',
            reason: result.reason,
          });
          out += m[0];
          hasUnresolvable = true;
        } else {
          rewrites.push({
            logicalId: ownerLogicalId,
            path: pathPrefix,
            kind: 'sub',
            before: m[0],
            after: result.value,
            orphanLogicalId: inner,
          });
          out += result.value;
          didChange = true;
        }
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
