import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import { pickRefLogicalId } from './intrinsic-utils.js';
import type { DiscoveredRoute } from './route-discovery.js';

/**
 * Per-API stage selection and stage-variable lookup for `cdkd local
 * start-api` (PR 8c, issue #235).
 *
 * Background: PR 8a hardcoded `event.stageVariables = null` for every
 * route (cited in `local-start-api.ts`'s out-of-scope list). That blocked
 * any local handler that reads its API Gateway Stage Variables —
 * `event.stageVariables.foo` returned `null.foo` and crashed.
 *
 * This module walks the synthesized template once at server boot (and
 * again on every hot-reload) and produces a `Map<apiLogicalId,
 * ResolvedStage>` keyed by the **API resource's** logical id (the
 * `AWS::ApiGateway::RestApi` or `AWS::ApiGatewayV2::Api`). Routes
 * resolve their `stageVariables` by looking up their API's logical id
 * in that map — see `attachStageContext` below.
 *
 * Stage selection rules (locked in the issue brief):
 *   - Default: the **first** Stage attached to the RestApi/Api in the
 *     order they appear in `template.Resources`. This matches what PR 8a
 *     did for `requestContext.stage`.
 *   - `--stage <name>` override: select the Stage whose `StageName`
 *     property equals the given name. When the user passes `--stage` and
 *     no API has a Stage with that name, that's a hard CLI error — but
 *     this module only surfaces the resolution result; the CLI raises.
 *   - `Function URL` routes don't have a Stage (and the CDK construct
 *     never emits one); their `stageVariables` stays `null` and their
 *     `stage` stays `'$default'` (PR 8a's behavior).
 */

/**
 * Resolved per-API stage info. `apiVersion` discriminates the two
 * AWS Stage resource types — REST v1 uses `Variables`, HTTP API v2 uses
 * `StageVariables`. We normalize both to a single `variables` map.
 */
export interface ResolvedStage {
  /** Stage logical id in the template (for diagnostics). */
  stageLogicalId: string;
  /** The selected stage's name (from `Properties.StageName`). */
  stageName: string;
  /** Either v1 or v2 — which AWS Stage resource type this came from. */
  apiVersion: 'v1' | 'v2';
  /** Resolved variables map. `null` when the Stage carries no variables. */
  variables: Record<string, string> | null;
}

/**
 * Build the `apiLogicalId → ResolvedStage` map for a single template.
 *
 * Result-map population rules:
 *
 *   - **No matching Stage in template** (the API has zero `AWS::ApiGateway::Stage`
 *     / `AWS::ApiGatewayV2::Stage` resources pointing at it): the API
 *     never enters the result map. `attachStageContext` then leaves
 *     `stageVariables: null` AND keeps `route.stage` at the discovery-
 *     time placeholder (`'$default'` for HTTP API v2 / Function URL,
 *     or whatever the discovery layer parsed for REST v1).
 *
 *   - **`stageOverride` provided but no Stage matches** (e.g. user
 *     passed `--stage staging`, API only has `prod` / `dev`): same as
 *     above — API is LEFT OUT of the result map. The CLI surfaces a
 *     deduplicated warn line for each such API up front so users
 *     aren't surprised by silent `stageVariables: null` at runtime.
 *
 *   - **Match found**: API enters the result map with the picked
 *     Stage's `StageName` + variables. `attachStageContext` then sets
 *     `route.stageVariables` from the resolved Stage AND overrides
 *     `route.stage` with the picked Stage's `StageName` for **both**
 *     REST v1 and HTTP API v2 routes. HTTP API v2's auto-deploy default
 *     is `'$default'`, but AWS also supports named stages (the
 *     `CreateStage` API accepts any name); when the template carries a
 *     named v2 Stage we surface that name through `requestContext.stage`
 *     so a handler that reads `event.requestContext.stage` sees the
 *     same value AWS would surface in the deployed environment.
 */
export function buildStageMap(
  template: CloudFormationTemplate,
  stageOverride?: string
): Map<string, ResolvedStage> {
  const out = new Map<string, ResolvedStage>();
  const resources = template.Resources ?? {};

  // Group every Stage by the API it points at, in template order.
  // `Object.entries` preserves insertion order — CDK emits Stages after
  // their parent API, but we don't actually rely on that ordering; we
  // just pick the first one we find.
  const restStagesByApi = new Map<string, Array<{ id: string; resource: TemplateResource }>>();
  const v2StagesByApi = new Map<string, Array<{ id: string; resource: TemplateResource }>>();

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type === 'AWS::ApiGateway::Stage') {
      const apiId = pickRefLogicalId((resource.Properties ?? {})['RestApiId']);
      if (apiId) appendByApi(restStagesByApi, apiId, logicalId, resource);
    } else if (resource.Type === 'AWS::ApiGatewayV2::Stage') {
      const apiId = pickRefLogicalId((resource.Properties ?? {})['ApiId']);
      if (apiId) appendByApi(v2StagesByApi, apiId, logicalId, resource);
    }
  }

  for (const [apiId, stages] of restStagesByApi) {
    const picked = pickStage(stages, stageOverride);
    if (picked) out.set(apiId, toResolvedStage(picked, 'v1'));
  }
  for (const [apiId, stages] of v2StagesByApi) {
    const picked = pickStage(stages, stageOverride);
    if (picked) out.set(apiId, toResolvedStage(picked, 'v2'));
  }

  return out;
}

/**
 * Append a Stage record to its API's bucket. Tiny helper so the loop
 * above stays readable.
 */
function appendByApi(
  bucket: Map<string, Array<{ id: string; resource: TemplateResource }>>,
  apiId: string,
  stageId: string,
  resource: TemplateResource
): void {
  const list = bucket.get(apiId) ?? [];
  list.push({ id: stageId, resource });
  bucket.set(apiId, list);
}

/**
 * Apply the stage-override / first-match rules to a list of Stage
 * resources for a single API. Returns the picked Stage or `undefined`
 * when no match. The selection is intentionally scoped per-API so a
 * `--stage prod` override against a multi-API app picks the matching
 * Stage on each API (rather than the first Stage globally).
 */
function pickStage(
  stages: Array<{ id: string; resource: TemplateResource }>,
  stageOverride: string | undefined
): { id: string; resource: TemplateResource } | undefined {
  if (stages.length === 0) return undefined;
  if (stageOverride) {
    for (const s of stages) {
      const props = s.resource.Properties ?? {};
      if (props['StageName'] === stageOverride) return s;
    }
    return undefined;
  }
  return stages[0];
}

/**
 * Build a `ResolvedStage` from a picked Stage resource. Both REST v1
 * (`Variables`) and HTTP API v2 (`StageVariables`) keys are accepted;
 * non-string values are dropped (CDK templates emit only strings, but
 * defense-in-depth keeps a malformed template from crashing the server).
 */
function toResolvedStage(
  stage: { id: string; resource: TemplateResource },
  apiVersion: 'v1' | 'v2'
): ResolvedStage {
  const props = stage.resource.Properties ?? {};
  const stageName = typeof props['StageName'] === 'string' ? props['StageName'] : '$default';
  const rawVars = apiVersion === 'v1' ? props['Variables'] : props['StageVariables'];
  let variables: Record<string, string> | null = null;
  if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawVars as Record<string, unknown>)) {
      if (typeof v === 'string') {
        map[k] = v;
      }
      // Intrinsic-valued entries (Ref / Fn::GetAtt / etc.) are dropped —
      // mirrors PR 1's env-var policy. The local server has no deploy
      // state to substitute them against; surfacing them as the literal
      // CFn intrinsic object would crash any handler that JSON-stringifies
      // `event.stageVariables`.
    }
    variables = Object.keys(map).length > 0 ? map : null;
  }
  return { stageLogicalId: stage.id, stageName, apiVersion, variables };
}

/**
 * Mutate every route in `routes` to set `stageVariables` and (for routes
 * that map to a resolved Stage) override `stage` with the resolved
 * Stage's `StageName`. Function URL routes are left untouched.
 *
 * Invariants:
 *
 *   - Routes whose `apiLogicalId` is missing from `stageMap` get
 *     `stageVariables: null`. For REST v1 that means "no Stage attached"
 *     (already represented by the discovery layer's `'$default'` placeholder).
 *     For HTTP API that means the user passed `--stage <name>` and no
 *     Stage on this API matched — the CLI is expected to surface a warn
 *     line up front; we just leave the route's variables null here.
 *
 *   - Routes whose `apiLogicalId` IS in the map get `stageVariables` set
 *     to the resolved Stage's variables (`null` when the Stage has none),
 *     and `route.stage` is overridden with the Stage's `StageName` for
 *     **both** REST v1 and HTTP API v2 routes. HTTP API v2's default
 *     auto-deployed stage is `$default`, but AWS supports named stages
 *     on v2 too (`CreateStage` accepts any name) — when the template
 *     carries one, surface it through `requestContext.stage` so the
 *     local event matches what AWS would emit at the deployed endpoint.
 */
export function attachStageContext(
  routes: DiscoveredRoute[],
  stageMap: Map<string, ResolvedStage>
): void {
  for (const route of routes) {
    if (!route.apiLogicalId) {
      route.stageVariables = null;
      continue;
    }
    const stage = stageMap.get(route.apiLogicalId);
    if (!stage) {
      route.stageVariables = null;
      continue;
    }
    route.stageVariables = stage.variables;
    route.stage = stage.stageName;
  }
}
