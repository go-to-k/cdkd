import { getLogger } from '../utils/logger.js';
import type { RouteWithAuth } from './authorizer-resolver.js';
import type { ContainerPool, ContainerSpec } from './container-pool.js';
import type { CorsConfig } from './cors-handler.js';
import type { DiscoveredRoute } from './route-discovery.js';
import type { ServerState } from './http-server.js';

/**
 * Hot-reload orchestrator for `cdkd local start-api --watch` (PR 8c,
 * issue #235).
 *
 * The watcher fires `'reload'` whenever the user touches a watched
 * file. The orchestrator then runs the full reload sequence:
 *
 *   1. Re-synth (skip when `-a <dir>` was passed at server boot — the
 *      directory is treated as already-synthesized).
 *   2. Re-run `discoverRoutes` against the new template + reattach the
 *      stage / CORS context.
 *   3. Diff the old and new {@link ServerState} to decide:
 *        - Routes added: register them on the new state.
 *        - Routes removed: unregister; if the affected Lambda has no
 *          remaining routes, schedule its container pool entry for
 *          teardown.
 *        - Lambdas whose code path or env changed: schedule their pool
 *          entry for teardown so the next request gets a fresh container.
 *   4. Atomically swap the server state via
 *      {@link import('./http-server.js').StartedApiServer.setServerState}.
 *   5. Dispose the previous pool in the background. `pool.dispose()`
 *      now AWAITS every in-flight `inUse` handle's release (bounded by
 *      a per-entry 30s drain timeout) before tearing down the
 *      underlying container — a request mid-`invokeRie()` against the
 *      old pool when reload fires runs to completion against its
 *      original container instead of getting it killed (502 leak). See
 *      `container-pool.ts:dispose()` for the drain mechanics.
 *
 * Synth failures keep the previous state serving and emit a warn line
 * — the issue brief explicitly rules out crashing the server on a
 * transient synth error.
 */

/**
 * One reload result. Returned by `Orchestrator.reload()` so callers
 * (and tests) can inspect what changed without scraping log lines.
 */
export interface ReloadResult {
  ok: boolean;
  /** Set when `ok === false`. Human-readable explanation. */
  reason?: string;
  /** Routes added by this reload (carry their attached authorizer info). */
  added: RouteWithAuth[];
  /** Routes removed by this reload (carry their attached authorizer info). */
  removed: RouteWithAuth[];
  /** Lambdas torn down by this reload (no more routes OR spec changed). */
  rebuiltLambdas: string[];
  /** New ServerState that was swapped in. */
  newState?: ServerState;
}

/**
 * The next-state material produced by the synth + discovery pipeline.
 * Returned by the {@link OrchestratorDeps.synthesizeAndBuild} callback;
 * consumed by the diff + swap step.
 */
export interface NextStateMaterial {
  /**
   * Discovered routes with attached authorizer info (output of
   * `attachAuthorizers(discoverRoutes(...))`). Routes without an
   * authorizer carry `authorizer: undefined`.
   */
  routes: RouteWithAuth[];
  /** Full per-Lambda spec map (every Lambda reachable through `routes`). */
  specs: Map<string, ContainerSpec>;
  corsConfigByApiId: Map<string, CorsConfig>;
  /**
   * The target StackInfo[] used to build this material. Carried so the
   * caller (initial boot only) can run startup-only side effects like
   * `warnVpcConfigLambdas` without re-issuing synth. The orchestrator
   * does not consume this field.
   */
  stacks?: readonly import('../synthesis/assembly-reader.js').StackInfo[];
}

export interface OrchestratorDeps {
  /**
   * Re-run synth + discoverRoutes + spec building. Returns the next
   * {@link NextStateMaterial} or rejects on synth failure.
   *
   * The orchestrator catches the rejection and keeps the previous
   * state serving — see {@link Orchestrator.reload}.
   */
  synthesizeAndBuild: () => Promise<NextStateMaterial>;
  /**
   * Build a fresh {@link ContainerPool} for a given spec map. Called
   * each reload — the orchestrator does NOT reuse the previous pool
   * because a single pool's `Map<logicalId, ContainerSpec>` is set at
   * construction (the existing PR 8a contract). The previous pool is
   * disposed in the background after the swap.
   */
  buildPool: (specs: Map<string, ContainerSpec>) => ContainerPool;
  /**
   * The server's atomic state-swap callback (returns the previous
   * state). Wraps {@link StartedApiServer.setServerState} verbatim.
   */
  setServerState: (next: ServerState) => ServerState;
  /**
   * The server's current state reader. Used to compute the diff
   * against the new state.
   */
  getServerState: () => ServerState;
}

export interface Orchestrator {
  /** Run one reload cycle. Resolves with the diff result. */
  reload(): Promise<ReloadResult>;
}

/**
 * Construct an Orchestrator. The orchestrator is stateless — every
 * call to `reload()` reads `getServerState()` for the baseline.
 */
export function createReloadOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const logger = getLogger().child('start-api-reload');

  // Serialize concurrent reload calls. The watcher's debounce already
  // collapses bursts to one event, but a manual integration test or a
  // future SIGUSR1 trigger could fire two reloads in quick succession;
  // serializing avoids tearing down a pool the previous reload just
  // built.
  let chain: Promise<unknown> = Promise.resolve();

  return {
    reload(): Promise<ReloadResult> {
      const next = chain.then(() => runOneReload(deps, logger));
      // Defense-in-depth: `runOneReload` traps every expected failure
      // (synth error, etc.) and returns `{ ok: false }` — the chain
      // itself shouldn't reject in the steady state. But `buildPool`
      // is a synchronous user callback that could throw, and any
      // future bug in `runOneReload` could leak a rejection. The
      // `.catch(() => undefined)` swallows such a rejection on the
      // chain reference only (the original `next` promise still
      // rejects to the caller) so a single broken reload doesn't
      // poison every subsequent reload.
      chain = next.catch(() => undefined);
      return next;
    },
  };
}

/**
 * Run one reload cycle end-to-end. Extracted so the surrounding
 * `chain`-serializer is a one-liner.
 */
async function runOneReload(
  deps: OrchestratorDeps,
  logger: ReturnType<typeof getLogger>
): Promise<ReloadResult> {
  const previousState = deps.getServerState();
  const start = Date.now();

  let material: NextStateMaterial;
  try {
    material = await deps.synthesizeAndBuild();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`cdk synth failed during reload; keeping previous version. (${reason})`);
    return { ok: false, reason, added: [], removed: [], rebuiltLambdas: [] };
  }

  // Compute the diff. We diff routes by their (method, pathPattern,
  // lambdaLogicalId, source, apiVersion) tuple — anything else is
  // sugar that doesn't change routing. A route whose Lambda's spec
  // (codeDir / env / debugPort) changed is also a "rebuild": the
  // routes set might be unchanged but the pool entry must be
  // recreated.
  const oldRoutes = previousState.routes;
  const newRoutes = material.routes;
  const oldKeys = new Set(oldRoutes.map((r) => routeKey(r.route)));
  const newKeys = new Set(newRoutes.map((r) => routeKey(r.route)));
  const added = newRoutes.filter((r) => !oldKeys.has(routeKey(r.route)));
  const removed = oldRoutes.filter((r) => !newKeys.has(routeKey(r.route)));

  // Lambdas whose spec changed — compared via `JSON.stringify` of the
  // codeDir + env + debugPort fields. We do not compare `lambda` deep
  // because the synthesis step rebuilds the StackInfo + TemplateResource
  // shapes; their structural equality would only hold by accident.
  // We re-resolve specs at every reload so the comparison is an
  // approximation of "did the user change anything that requires a
  // fresh container".
  const previousSpecs = pickSpecsFromState(previousState);
  const rebuiltLambdas: string[] = [];
  for (const [logicalId, newSpec] of material.specs) {
    const oldSpec = previousSpecs.get(logicalId);
    if (!oldSpec) continue; // new Lambda — no rebuild semantics
    if (specSignature(oldSpec) !== specSignature(newSpec)) {
      rebuiltLambdas.push(logicalId);
    }
  }
  // Lambdas reachable in the previous state but not in the new state
  // are also "rebuilt" in the sense that their pool entry is gone.
  // They show up in `removed` already; their teardown is bundled into
  // the previous-pool dispose below.

  // Swap the server state atomically.
  const newPool = deps.buildPool(material.specs);
  // Tag the new pool with the spec map so the next reload can compare.
  // We hang it off the pool with a non-enumerable property for diagnostic
  // access without baking it into the public ContainerPool interface.
  Object.defineProperty(newPool, '__cdkdSpecs', {
    value: material.specs,
    enumerable: false,
    configurable: true,
  });
  const newState: ServerState = {
    routes: material.routes,
    pool: newPool,
    corsConfigByApiId: material.corsConfigByApiId,
  };
  deps.setServerState(newState);

  // Dispose the previous pool in the background. In-flight requests
  // against it complete naturally — `pool.dispose()` waits for every
  // in-use handle to release. Errors are swallowed at debug.
  void previousState.pool
    .dispose()
    .catch((err) =>
      logger.debug(
        `Previous pool dispose() failed: ${err instanceof Error ? err.message : String(err)}`
      )
    );

  const elapsed = Date.now() - start;
  logger.info(
    `Reloaded in ${elapsed}ms: +${added.length} route(s), -${removed.length} route(s), ${rebuiltLambdas.length} Lambda(s) rebuilt.`
  );

  return {
    ok: true,
    added,
    removed,
    rebuiltLambdas,
    newState,
  };
}

/**
 * Stable identity key for a {@link DiscoveredRoute} — used as the diff
 * primitive. We DON'T include `stage` / `stageVariables` because those
 * are runtime context (PR 8c may flip them mid-reload as a benign
 * change); routing identity is the (method, pathPattern, lambda, source)
 * tuple.
 */
function routeKey(route: DiscoveredRoute): string {
  return [route.method, route.pathPattern, route.lambdaLogicalId, route.source, route.apiVersion]
    .map((s) => String(s))
    .join('|');
}

/**
 * Compute a stable signature for a {@link ContainerSpec}'s mutable
 * surface. Equality of this string across reloads means "the next
 * request for this Lambda can hit a warm container without surprise";
 * inequality means "tear down + restart".
 */
function specSignature(spec: ContainerSpec): string {
  return JSON.stringify({
    codeDir: spec.codeDir,
    env: spec.env,
    handler: spec.lambda.handler,
    runtime: spec.lambda.runtime,
    containerHost: spec.containerHost,
    debugPort: spec.debugPort ?? null,
  });
}

/**
 * Recover the per-Lambda spec map from a {@link ServerState}'s pool.
 * Returns an empty map when the pool wasn't tagged via the
 * `__cdkdSpecs` non-enumerable property (which only happens on the
 * very first state set up by the CLI — that path goes through
 * `createContainerPool` directly without going through the orchestrator).
 *
 * The orchestrator tags every pool it builds; the CLI also tags the
 * initial pool at server boot so the first reload can compute the
 * spec diff against the starting baseline.
 */
function pickSpecsFromState(state: ServerState): Map<string, ContainerSpec> {
  const tagged = (state.pool as unknown as { __cdkdSpecs?: Map<string, ContainerSpec> })
    .__cdkdSpecs;
  return tagged ?? new Map<string, ContainerSpec>();
}
