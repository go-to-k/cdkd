/**
 * Wall-clock timeout floors (ms) for resource types whose asynchronous
 * CREATE / UPDATE / DELETE routinely exceeds cdkd's generic deadlines.
 *
 * Two independent caps otherwise limit a slow operation, and BOTH default
 * shorter than these resources need:
 *   1. The per-resource deploy/destroy deadline (`withResourceDeadline`),
 *      default 30 min (`DEFAULT_RESOURCE_TIMEOUT_MS`).
 *   2. The Cloud Control provider's internal poll cap (`MAX_WAIT_TIME_MS`),
 *      a flat 15 min — so a Cloud-Control-routed slow resource effectively
 *      gets HALF the advertised 30-min deadline.
 *
 * The 15-min inner cap is what aborted the `opensearch-domain-getatt` integ
 * mid-DELETE on 2026-07-20: an OpenSearch domain deletion routinely runs
 * 15-30 min, so `waitForOperation` threw `DELETE timeout ... after 900s`
 * while AWS was still `IN_PROGRESS`, leaving a partial destroy. cdkd's
 * destroy contract is "destroy complete = the resource is actually gone"
 * (the integ suite's 0-orphan guarantee + the `integ-destroy` gate depend
 * on it), and CloudFormation itself blocks synchronously for these deletes,
 * so the correct fix lifts the deadline rather than returning early.
 *
 * This table is the SINGLE source of truth consulted by all three cap sites
 * (the CC inner poll cap + both outer `withResourceDeadline` resolutions), so
 * the inner and outer budgets can never drift back apart. A user-supplied
 * per-type CLI override (`--resource-timeout TYPE=DURATION`) still wins at the
 * outer sites (explicit escape hatch); the inner CC cap takes the max of its
 * flat default and this floor, so it can only ever grow a slow type's budget.
 *
 * Entries are per-operation because the slow phase differs by type (every one
 * below is slow to CREATE and DELETE; only the domains are slow to UPDATE).
 */
export type ResourceOperation = 'CREATE' | 'UPDATE' | 'DELETE';

interface SlowOperationTimeouts {
  create?: number;
  update?: number;
  delete?: number;
}

const MINUTE_MS = 60 * 1000;

/**
 * 60 min covers the worst-case observed for each type with headroom over the
 * 15-30 min typical range. Keyed by CloudFormation type name. RDS / ElastiCache
 * carry SDK providers today (only CC-routed via #614), but the outer-deadline
 * sites are provider-agnostic, so listing them here also lifts their SDK-path
 * deletes, which are the same slow class.
 */
const SLOW_CC_OPERATION_TIMEOUTS: Record<string, SlowOperationTimeouts> = {
  'AWS::OpenSearchService::Domain': {
    create: 60 * MINUTE_MS,
    update: 60 * MINUTE_MS,
    delete: 60 * MINUTE_MS,
  },
  'AWS::Elasticsearch::Domain': {
    create: 60 * MINUTE_MS,
    update: 60 * MINUTE_MS,
    delete: 60 * MINUTE_MS,
  },
  'AWS::Redshift::Cluster': {
    create: 60 * MINUTE_MS,
    delete: 60 * MINUTE_MS,
  },
  'AWS::ElastiCache::ReplicationGroup': {
    create: 60 * MINUTE_MS,
    delete: 60 * MINUTE_MS,
  },
  'AWS::ElastiCache::CacheCluster': {
    create: 60 * MINUTE_MS,
    delete: 60 * MINUTE_MS,
  },
  'AWS::RDS::DBInstance': {
    create: 60 * MINUTE_MS,
    delete: 60 * MINUTE_MS,
  },
  'AWS::RDS::DBCluster': {
    create: 60 * MINUTE_MS,
    delete: 60 * MINUTE_MS,
  },
};

/**
 * The wall-clock floor (ms) a given resource type + operation needs, or `0`
 * when the type has no special requirement (the generic default applies).
 *
 * `0` is a safe additive identity for the outer `Math.max(...)` resolution
 * and a safe `Math.max` term for the inner CC cap (never shrinks a budget).
 */
export function slowCcOperationTimeoutMs(
  resourceType: string,
  operation: ResourceOperation
): number {
  const entry = SLOW_CC_OPERATION_TIMEOUTS[resourceType];
  if (!entry) {
    return 0;
  }
  switch (operation) {
    case 'CREATE':
      return entry.create ?? 0;
    case 'UPDATE':
      return entry.update ?? 0;
    case 'DELETE':
      return entry.delete ?? 0;
  }
}
