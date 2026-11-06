import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { ContainerSpec, ContainerPool } from '../../../local/container-pool.js';
import type { ServerState } from '../../../local/http-server.js';
import { groupRoutesByServer } from '../../../local/api-server-grouping.js';
import type { NextStateMaterial, BootedApiServer } from './types.js';
import {
  filterSpecsForGroup,
  corsConfigForGroup,
  printPerServerRouteTables,
  warnUnsupportedRoutes,
  warnSsrfRiskyIntegrations,
} from './servers.js';

/**
 * One reload cycle for the multi-server topology (issue #260). The
 * watcher serializes calls via a chain promise; this function:
 *
 *   1. Re-runs `synthesizeAndBuild()` once (failure → warn + keep
 *      previous version serving on every server).
 *   2. Re-groups the new routes by API server key.
 *   3. For each existing server, swaps state to the new group's
 *      routes + a freshly-built pool filtered to that group's
 *      Lambdas. Disposes the previous pool in the background.
 *   4. Warns about new groups (= an API was added in CDK code) and
 *      vanished groups (= an API was removed) — those require a
 *      server restart in v1.
 */
export async function reloadAllServers(args: {
  synthesizeAndBuild: () => Promise<NextStateMaterial>;
  servers: readonly BootedApiServer[];
  buildPool: (specs: Map<string, ContainerSpec>) => ContainerPool;
  logger: ReturnType<typeof getLogger>;
  /** True once shutdown began; the reload then swaps nothing (issue #4495). */
  isClosing?: () => boolean;
  /**
   * Receives each swapped-out pool's background dispose for as long as it
   * runs, so shutdown can await it (issue #4495).
   */
  retiredPoolDisposals?: Set<Promise<void>>;
}): Promise<void> {
  const { synthesizeAndBuild, servers, buildPool, logger, isClosing, retiredPoolDisposals } = args;
  let material: NextStateMaterial;
  try {
    material = await synthesizeAndBuild();
  } catch (err) {
    logger.warn(
      `cdk synth failed during reload; keeping previous version. (${describeAwsFailure(err).detail})`
    );
    return;
  }
  // Shutdown began during the re-synth: it disposed the pools it found, so a
  // pool swapped in now would be one nothing disposes.
  if (isClosing?.()) return;
  const newGroups = groupRoutesByServer(material.routes);
  const newByKey = new Map(newGroups.map((g) => [g.serverKey, g] as const));
  const oldKeys = new Set(servers.map((s) => s.group.serverKey));
  const newKeys = new Set(newByKey.keys());

  // Warn on add/remove — v1 requires restart for topology changes.
  const added = [...newKeys].filter((k) => !oldKeys.has(k));
  const removed = [...oldKeys].filter((k) => !newKeys.has(k));
  if (added.length > 0) {
    logger.warn(
      `Reload detected new API surface(s): ${added.join(', ')}. Restart 'cdkd local start-api' to serve them.`
    );
  }
  if (removed.length > 0) {
    logger.warn(
      `Reload detected removed API surface(s): ${removed.join(', ')}. Their servers will keep serving stale routes until restart.`
    );
  }

  // Per-server: filter material → build pool → swap state → dispose old.
  for (const booted of servers) {
    const group = newByKey.get(booted.group.serverKey);
    if (!group) continue; // removed — skip swap, server keeps stale state until restart
    const groupSpecs = filterSpecsForGroup(group, material);
    const newPool = buildPool(groupSpecs);
    const newState: ServerState = {
      routes: group.routes,
      pool: newPool,
      corsConfigByApiId: corsConfigForGroup(group, material),
    };
    const previousState = booted.server.setServerState(newState);
    // Update the BootedApiServer's `group` in place so post-reload
    // `printPerServerRouteTables(servers)` reads the new routes,
    // including any new mockCors / unsupported classifications. Pre-fix
    // the printed table always reflected the boot-time routes.
    booted.group = group;
    // Dispose the previous pool in the background. `pool.dispose()`
    // waits for in-flight requests to drain (30s per-entry cap).
    const disposal = previousState.pool.dispose().catch((err) => {
      logger.debug(
        `Previous pool dispose() failed for ${group.displayName}: ${describeAwsFailure(err).detail}`
      );
    });
    retiredPoolDisposals?.add(disposal);
    void disposal.then(() => retiredPoolDisposals?.delete(disposal));
  }

  // Re-print the per-server route table when any routes changed.
  // Cheap heuristic: always re-print after a successful reload — the
  // user is watching for the diff and a stable table reassures them
  // that the swap landed. `booted.group` was mutated above so this
  // reflects the post-swap routes (including any new mockCors /
  // unsupported classifications introduced mid-edit).
  printPerServerRouteTables(servers);
  const allRoutes = servers.flatMap((s) => s.group.routes.map((r) => r.route));
  warnUnsupportedRoutes(allRoutes, logger);
  warnSsrfRiskyIntegrations(allRoutes, logger);
}
