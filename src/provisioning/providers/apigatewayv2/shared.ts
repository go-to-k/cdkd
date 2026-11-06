import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
} from '../../masked-retry-logger.js';
import type { CreateContext, UpdateContext } from '../../../types/resource.js';
import { AmbiguousCreateLatch, RecentIdSet } from '../ambiguous-create.js';

/**
 * Retry-safety state for the three API Gateway v2 creates that mint their id
 * and carry no idempotency token, `CreateApi`, `CreateIntegration` and
 * `CreateAuthorizer` (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)); see
 * `orphan-report.ts`. Module-scoped: a provider instance is per
 * registry, and one process can build several.
 */
export const createApiLatch = new AmbiguousCreateLatch('apigatewayv2:CreateApi');

export const createIntegrationLatch = new AmbiguousCreateLatch('apigatewayv2:CreateIntegration');

export const createAuthorizerLatch = new AmbiguousCreateLatch('apigatewayv2:CreateAuthorizer');

/**
 * Resources this process created and recorded, never reported as orphan
 * candidates. A child is keyed by `(apiId, id)`: its id is unique only inside
 * its API.
 */
export const apisCreatedByThisProcess = new RecentIdSet();

export const integrationsCreatedByThisProcess = new RecentIdSet();

export const authorizersCreatedByThisProcess = new RecentIdSet();

/** `MaxResults` of each list page; a string in the v2 API. */
export const ORPHAN_LIST_PAGE_SIZE = '100';

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetApiGatewayV2CreateRetryStateForTests(): void {
  createApiLatch.resetForTests();
  createIntegrationLatch.resetForTests();
  createAuthorizerLatch.resetForTests();
  apisCreatedByThisProcess.resetForTests();
  integrationsCreatedByThisProcess.resetForTests();
  authorizersCreatedByThisProcess.resetForTests();
}

/** The ApiGatewayV2 types whose delete addresses the child through `ApiId`. */
export const API_ID_ADDRESSED_TYPES: ReadonlySet<string> = new Set([
  'AWS::ApiGatewayV2::Stage',
  'AWS::ApiGatewayV2::Integration',
  'AWS::ApiGatewayV2::Route',
  'AWS::ApiGatewayV2::Authorizer',
]);

/**
 * The masked sinks ONE Stage `create()` / `update()` logs through (issue
 * #2177). A Stage's physical id IS its `StageName`, a template value that can
 * be secret-derived. The deploy's masker knows the name this deploy resolved;
 * what it cannot know is a name recorded from a PREVIOUS secret, which state
 * persists as its `{{resolve:` reference (or `***`) while the old plaintext
 * stays the physical id. `withDerivedNameMasks` masks the name whenever the
 * value it came from is secret-derived. No length floor, per that helper's
 * contract: a short secret-derived name over-masks this operation's lines
 * rather than printing.
 */
export function stageSinks(
  logger: { debug(message: string): void; warn(message: string): void },
  context: CreateContext | UpdateContext | undefined,
  pairs: ReadonlyArray<readonly [raw: unknown, name: string | undefined]>
): MaskedLogSinks {
  return withDerivedNameMasks(logger, createMaskedLogSinks(logger, context?.maskSecrets), pairs);
}

/** A planned `TagResource` / `UntagResource` pair for one Api or Stage (go-to-k/cdkd#5390). */
export interface TagChange {
  set: Record<string, string>;
  remove: string[];
  changed: boolean;
}

/** The tagging ARN path of a stage: `TagResource` addresses it under its API. */
export function stageTagPath(apiId: string, stageName: string): string {
  return `/apis/${apiId}/stages/${stageName}`;
}
