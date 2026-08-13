#!/usr/bin/env node
// @ts-check

/**
 * Refresh CFn schema property-name fixtures for the SDK Provider coverage test.
 *
 * For each resource type registered via `registerAllProviders` in
 * `src/provisioning/register-providers.ts`, this script:
 *   1. Calls `cloudformation:DescribeType` (RESOURCE) to fetch the canonical
 *      AWS-published schema.
 *   2. Extracts the top-level `properties` keys (mirrors what the deploy
 *      engine's `selectProviderWithSafetyNet` compares against).
 *   3. Writes a small JSON fixture at
 *      `tests/fixtures/cfn-schemas/<sanitized-type>.json` containing the
 *      property name array — NOT the full schema. Keeps fixtures < 2KB each.
 *
 * Re-run on demand when:
 *   - A new provider is added → fetches the new type's schema.
 *   - AWS publishes new properties on an existing type → diff surfaces as a
 *     gap in `tests/unit/provisioning/property-coverage.test.ts`.
 *
 * Requires AWS credentials with `cloudformation:DescribeType` permission
 * (read-only). Defaults to `us-east-1` since `AWS::*` schemas are
 * region-agnostic; override with `AWS_REGION` if your credentials are pinned
 * elsewhere.
 *
 * Concurrency is capped at 8 in-flight DescribeType calls to be polite to
 * the CFn registry; the full sweep typically completes in 30-60 seconds.
 */

import {
  CloudFormationClient,
  DescribeTypeCommand,
} from '@aws-sdk/client-cloudformation';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const REGISTER_PROVIDERS_PATH = join(
  REPO_ROOT,
  'src/provisioning/register-providers.ts'
);
const FIXTURES_DIR = join(REPO_ROOT, 'tests/fixtures/cfn-schemas');
// CloudFormation DescribeType is aggressively throttled per-account
// (~10 RPS measured); keep concurrency low and let withRetry handle the rest.
const CONCURRENCY = 3;
const MAX_RETRIES = 6;
/**
 * Caps on {@link extractNestedPropertyPaths}, whose per-branch cycle guard is
 * combinatorial rather than linear (see that function). Both are far above any
 * registered type's real yield — the deepest chain across the ~135 fixtures is
 * 6 segments and the largest single top-level is 223 paths — so they only fire
 * on the runaway shape, and they fire LOUDLY rather than emitting a
 * multi-megabyte fixture.
 */
const MAX_NESTED_PATHS_PER_PROPERTY = 5000;
const MAX_NESTED_PATH_DEPTH = 12;

/**
 * Convert a CFn resource type to a filesystem-safe filename.
 * `AWS::Lambda::Function` → `AWS-Lambda-Function.json`
 *
 * @param {string} type
 * @returns {string}
 */
export function fixtureFilename(type) {
  return type.replace(/::/g, '-') + '.json';
}

/**
 * Statically scan `register-providers.ts` for `registry.register('AWS::...')`
 * patterns. Avoids importing the TS source (no tsx dep) and avoids requiring
 * a prior `vp run build` step.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractRegisteredTypes(source) {
  const re = /registry\.register\(\s*['"]([A-Z][\w:]+)['"]/g;
  const types = new Set();
  let m;
  while ((m = re.exec(source)) !== null) {
    types.add(m[1]);
  }
  return Array.from(types).sort();
}

/**
 * Parse the CFn schema JSON returned by DescribeType and pull the top-level
 * property name list. The deploy engine's safety net compares against the
 * template's top-level property keys, so that is the right level of
 * granularity for this fixture.
 *
 * @param {string} schemaJson
 * @returns {string[]}
 */
export function extractTopLevelProperties(schemaJson) {
  /** @type {{properties?: Record<string, unknown>, readOnlyProperties?: string[]}} */
  const schema = JSON.parse(schemaJson);
  if (!schema.properties || typeof schema.properties !== 'object') {
    return [];
  }
  return Object.keys(schema.properties).sort();
}

/**
 * Extract the per-type read-only property list (CFn-side: properties AWS
 * computes and returns but never accepts as input). Saved alongside the
 * full property list so the coverage test can EXCLUDE them from the "gap"
 * — providers cannot wire a read-only property to a Create/Update call by
 * definition.
 *
 * Schema entries are JSON-pointer paths like `/properties/Arn`; we strip
 * the prefix and filter to top-level paths only.
 *
 * @param {string} schemaJson
 * @returns {string[]}
 */
export function extractReadOnlyProperties(schemaJson) {
  /** @type {{readOnlyProperties?: string[]}} */
  const schema = JSON.parse(schemaJson);
  if (!Array.isArray(schema.readOnlyProperties)) {
    return [];
  }
  return schema.readOnlyProperties
    .filter((p) => typeof p === 'string' && p.startsWith('/properties/'))
    .map((p) => p.replace(/^\/properties\//, ''))
    .filter((p) => !p.includes('/')) // top-level only
    .sort();
}

/**
 * Extract the per-type create-only property list (immutable on update —
 * AWS rejects modify calls). Surfaced so the coverage test report can
 * annotate them in the gap output.
 *
 * @param {string} schemaJson
 * @returns {string[]}
 */
export function extractCreateOnlyProperties(schemaJson) {
  /** @type {{createOnlyProperties?: string[]}} */
  const schema = JSON.parse(schemaJson);
  if (!Array.isArray(schema.createOnlyProperties)) {
    return [];
  }
  return schema.createOnlyProperties
    .filter((p) => typeof p === 'string' && p.startsWith('/properties/'))
    .map((p) => p.replace(/^\/properties\//, ''))
    .filter((p) => !p.includes('/'))
    .sort();
}

/**
 * Extract the per-type primary-identifier property list (the property names
 * whose values together form the CC-API physicalId). cdkd's intrinsic resolver
 * resolves a `Fn::GetAtt` against the primaryIdentifier correctly via the
 * physicalId fallback, so a readOnly attribute that IS the primaryIdentifier
 * does NOT need enrichment — consumed by scripts/gen-enrichment-coverage.ts to
 * auto-classify those as not-a-gap instead of requiring a hand-written
 * ENRICHMENT_ALLOW_LIST entry per type. Same top-level JSON-pointer stripping
 * as the read-only / create-only extractors above.
 *
 * @param {string} schemaJson
 * @returns {string[]}
 */
export function extractPrimaryIdentifier(schemaJson) {
  /** @type {{primaryIdentifier?: string[]}} */
  const schema = JSON.parse(schemaJson);
  if (!Array.isArray(schema.primaryIdentifier)) {
    return [];
  }
  return schema.primaryIdentifier
    .filter((p) => typeof p === 'string' && p.startsWith('/properties/'))
    .map((p) => p.replace(/^\/properties\//, ''))
    .filter((p) => !p.includes('/'))
    .sort();
}

/**
 * Extract, per top-level property, the set of NESTED property names reachable
 * beneath it (following local `#/definitions/...` refs, cycle-guarded).
 *
 * Consumed by `scripts/gen-nested-key-coverage.ts` (issue #1373): the AWS SDK
 * v3 serializer silently drops unknown keys, so an SDK provider forwarding a
 * nested CFn config blob must convert every key whose spelling diverges from
 * the SDK model — and the pre-flight `property-coverage` check compares
 * TOP-LEVEL names only. This capture gives the critic the CFn-side nested key
 * names to diff against the SDK client's model.
 *
 * Only top-level properties with at least one nested name get an entry, so
 * scalar-heavy fixtures stay small.
 *
 * @param {string} schemaJson
 * @returns {Record<string, string[]>}
 */
export function extractNestedPropertyNames(schemaJson) {
  /** @type {{properties?: Record<string, unknown>, definitions?: Record<string, unknown>}} */
  const schema = JSON.parse(schemaJson);
  if (!schema.properties || typeof schema.properties !== 'object') {
    return {};
  }
  const definitions =
    schema.definitions && typeof schema.definitions === 'object' ? schema.definitions : {};

  /**
   * @param {unknown} node
   * @param {Set<string>} names
   * @param {Set<string>} seenRefs
   */
  function walk(node, names, seenRefs) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, names, seenRefs);
      return;
    }
    const obj = /** @type {Record<string, unknown>} */ (node);
    const ref = obj['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/definitions/')) {
      const defName = ref.slice('#/definitions/'.length);
      if (!seenRefs.has(defName)) {
        seenRefs.add(defName);
        walk(definitions[defName], names, seenRefs);
      }
    }
    const props = obj['properties'];
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [key, sub] of Object.entries(props)) {
        names.add(key);
        walk(sub, names, seenRefs);
      }
    }
    // Schema combinators / containers that can hold further property maps.
    // `patternProperties` KEYS are regexes, not property names — walk only the
    // value schemas.
    for (const key of ['items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf']) {
      if (obj[key] && typeof obj[key] === 'object') walk(obj[key], names, seenRefs);
    }
    const patternProps = obj['patternProperties'];
    if (patternProps && typeof patternProps === 'object' && !Array.isArray(patternProps)) {
      for (const sub of Object.values(patternProps)) walk(sub, names, seenRefs);
    }
  }

  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [topName, sub] of Object.entries(schema.properties)) {
    const names = new Set();
    walk(sub, names, new Set());
    if (names.size > 0) {
      out[topName] = Array.from(names).sort();
    }
  }
  return out;
}

/**
 * Extract, per top-level property, the set of NESTED property PATHS reachable
 * beneath it — the full `A.B.C` chain rather than the flattened bag of names
 * {@link extractNestedPropertyNames} produces (issue #1464).
 *
 * Same walk, same `$ref` resolution, same container handling; the only
 * differences are that the chain is KEPT and that the cycle guard is
 * PER-BRANCH rather than per-top-level. The flattened capture could share one
 * `seenRefs` set across the whole top-level because a definition visited twice
 * contributes the same NAMES both times. Paths are different: `EnvironmentImage`
 * reached under `Environment` and under `Environment.Fleet` are two distinct
 * facts, so the guard has to be "is this definition already an ANCESTOR of the
 * current path" (which stops infinite recursion) rather than "has it been seen
 * anywhere" (which would silently drop sibling occurrences).
 *
 * Chains are stored RELATIVE to the top-level property (the map key already
 * carries it), and ARRAYS ARE TRANSPARENT: `EnvironmentVariables` being a list
 * of `EnvironmentVariable` yields `EnvironmentVariables.Name`, not
 * `EnvironmentVariables[].Name`. That matches the write side, where
 * `envs.map((e) => ({ name: … }))` puts `name` exactly one level beneath
 * `environmentVariables`.
 *
 * Emitted ALONGSIDE `nestedProperties`, not instead of it: the shape pass and
 * the per-target `minNestedKeys` floors of
 * `scripts/gen-nested-key-coverage.ts` are calibrated against the flattened
 * capture, and the two must be able to coexist while targets migrate.
 *
 * BOUNDED, because per-branch ancestry trades the flattened walk's linear cost
 * for a combinatorial one: a DIAMOND-shaped definition graph (a definition
 * reachable down two sibling branches, whose children are the same shape again)
 * yields `2^k` paths, and a k=18 synthetic schema measured 786,430 paths in
 * about a second. The registered types are nowhere near that today (the biggest
 * is `AWS::S3::Bucket` at 223 paths, max depth 6), but `processType` runs this
 * for EVERY refreshed type, so an AWS schema that IS that shape would hang the
 * refresher and emit a multi-megabyte fixture. Both caps below throw a NAMED
 * error instead — the operator learns which type and which limit, and the
 * fixture is not written at all.
 *
 * @param {string} schemaJson
 * @param {string} [typeName] resource type, for the error message
 * @returns {Record<string, string[]>}
 */
export function extractNestedPropertyPaths(schemaJson, typeName = '<schema>') {
  /** @type {{properties?: Record<string, unknown>, definitions?: Record<string, unknown>}} */
  const schema = JSON.parse(schemaJson);
  if (!schema.properties || typeof schema.properties !== 'object') {
    return {};
  }
  const definitions =
    schema.definitions && typeof schema.definitions === 'object' ? schema.definitions : {};

  /**
   * @param {unknown} node
   * @param {readonly string[]} prefix
   * @param {ReadonlySet<string>} ancestorRefs
   * @param {Set<string>} paths
   */
  function walk(node, prefix, ancestorRefs, paths) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, prefix, ancestorRefs, paths);
      return;
    }
    if (prefix.length >= MAX_NESTED_PATH_DEPTH) return;
    const obj = /** @type {Record<string, unknown>} */ (node);
    const ref = obj['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/definitions/')) {
      const defName = ref.slice('#/definitions/'.length);
      if (!ancestorRefs.has(defName)) {
        walk(definitions[defName], prefix, new Set([...ancestorRefs, defName]), paths);
      }
    }
    const props = obj['properties'];
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [key, sub] of Object.entries(props)) {
        const next = [...prefix, key];
        paths.add(next.join('.'));
        walk(sub, next, ancestorRefs, paths);
      }
    }
    // Same combinator / container set as the flattened walk, and for the same
    // reason: `patternProperties` KEYS are regexes, not property names.
    for (const key of ['items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf']) {
      if (obj[key] && typeof obj[key] === 'object') {
        walk(obj[key], prefix, ancestorRefs, paths);
      }
    }
    const patternProps = obj['patternProperties'];
    if (patternProps && typeof patternProps === 'object' && !Array.isArray(patternProps)) {
      for (const sub of Object.values(patternProps)) walk(sub, prefix, ancestorRefs, paths);
    }
  }

  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [topName, sub] of Object.entries(schema.properties)) {
    /** @type {Set<string>} */
    const paths = new Set();
    walk(sub, [], new Set(), paths);
    if (paths.size > MAX_NESTED_PATHS_PER_PROPERTY) {
      throw new Error(
        `${typeName}: nested path capture for "${topName}" exceeded ` +
          `${MAX_NESTED_PATHS_PER_PROPERTY} paths (${paths.size}) — a diamond-shaped ` +
          'definition graph makes the per-branch walk combinatorial. Raise ' +
          'MAX_NESTED_PATHS_PER_PROPERTY in scripts/refresh-cfn-schemas.mjs only after ' +
          'confirming the fixture stays reviewable.'
      );
    }
    if (paths.size > 0) {
      out[topName] = Array.from(paths).sort();
    }
  }
  return out;
}

/**
 * Classify a schema node's terminal type kind, resolving local `$ref`s
 * (cycle-guarded — a cycle resolves to 'object', which is what a
 * self-referential definition is).
 *
 * @param {unknown} node
 * @param {Record<string, unknown>} definitions
 * @param {Set<string>} seenRefs
 * @returns {'array' | 'object' | 'scalar' | 'mixed'}
 */
function classifyShape(node, definitions, seenRefs) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return 'scalar';
  const obj = /** @type {Record<string, unknown>} */ (node);
  const ref = obj['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/definitions/')) {
    const defName = ref.slice('#/definitions/'.length);
    if (seenRefs.has(defName)) return 'object';
    seenRefs.add(defName);
    return classifyShape(definitions[defName], definitions, seenRefs);
  }
  // JSON-Schema array-form `type: ["array", "string"]` is legal in registry
  // schemas — surface it as 'mixed' (visible) rather than falling through to
  // a silent 'scalar'.
  if (Array.isArray(obj['type'])) return 'mixed';
  if (obj['type'] === 'array') return 'array';
  if (
    obj['type'] === 'object' ||
    obj['properties'] !== undefined ||
    obj['patternProperties'] !== undefined ||
    obj['additionalProperties'] !== undefined
  ) {
    return 'object';
  }
  if (typeof obj['type'] === 'string') return 'scalar';
  // oneOf / anyOf / allOf with no own type — classify each arm; agree or 'mixed'.
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const arms = obj[key];
    if (Array.isArray(arms) && arms.length > 0) {
      const kinds = new Set(arms.map((a) => classifyShape(a, definitions, new Set(seenRefs))));
      return kinds.size === 1 ? /** @type {any} */ ([...kinds][0]) : 'mixed';
    }
  }
  return 'scalar';
}

/**
 * Extract, per schema DEFINITION, its member names each classified to a
 * terminal type kind ('array' | 'object' | 'scalar' | 'mixed', `$ref`s
 * resolved). Consumed by the SHAPE pass of
 * `scripts/gen-nested-key-coverage.ts` (issue #1378): a CFn member that is a
 * bare array where the SDK member is a `{Quantity, Items}` wrapper, or a CFn
 * member missing from its same-named SDK interface (the CloudFront
 * `CachedMethods` sibling-vs-nested class), is invisible to the v1
 * key-spelling pass because the spelling exists SOMEWHERE in the SDK model.
 *
 * The top-level `properties` block is included under the reserved key
 * `#top` so top-level shapes are auditable through the same map (no CFn
 * definition may legally be named `#top` — `#` starts a JSON-pointer).
 *
 * @param {string} schemaJson
 * @returns {Record<string, Record<string, string>>}
 */
export function extractDefinitionShapes(schemaJson) {
  /** @type {{properties?: Record<string, unknown>, definitions?: Record<string, unknown>}} */
  const schema = JSON.parse(schemaJson);
  const definitions =
    schema.definitions && typeof schema.definitions === 'object' ? schema.definitions : {};

  /** @type {Record<string, Record<string, string>>} */
  const out = {};
  /**
   * @param {string} name
   * @param {unknown} def
   */
  const addDefinition = (name, def) => {
    if (def === null || typeof def !== 'object') return;
    const props = /** @type {Record<string, unknown>} */ (def)['properties'];
    if (!props || typeof props !== 'object' || Array.isArray(props)) return;
    /** @type {Record<string, string>} */
    const members = {};
    for (const [memberName, sub] of Object.entries(props)) {
      members[memberName] = classifyShape(sub, definitions, new Set());
    }
    if (Object.keys(members).length > 0) out[name] = members;
  };

  addDefinition('#top', { properties: schema.properties });
  for (const [name, def] of Object.entries(definitions)) {
    addDefinition(name, def);
  }
  return out;
}

/**
 * Extract, per schema DEFINITION, its `required` member list — the members
 * CloudFormation's own model validation refuses a payload for omitting
 * (issue #1800).
 *
 * Captured because a whole class of parity verdicts rests ENTIRELY on it. The
 * #1225 classification of `AWS::ECS::Service.DeploymentConfiguration` concluded
 * that cdkd's verbatim pass-through is CloudFormation parity at depth 2 only
 * because CFn REFUSES a kept-but-partial `DeploymentCircuitBreaker`
 * (`required: [Enable, Rollback]`), making the shape unreachable from a valid
 * template. Without this capture, the strongest available assertion is that the
 * member paths are still MODELLED — which stays true the day AWS relaxes the
 * `required` list, silently turning a "parity by loud reject" verdict into a
 * real silent drop with no test failing. `docs/provider-development.md` already
 * tells provider authors to check the nested definition's `required` list
 * before treating a depth-2 replace as reachable; this is the data that makes
 * that checkable.
 *
 * The top-level `required` block is included under the reserved key `#top`,
 * matching {@link extractDefinitionShapes} (no CFn definition may legally be
 * named `#top` — `#` starts a JSON-pointer).
 *
 * A definition with no `required` list, or an empty one, gets NO entry — the
 * absence IS the fact ("nothing is required here"), and emitting `[]` for the
 * ~90% of definitions in that state would triple the fixture size for no
 * signal. Consumers must therefore read a missing key as "no required members",
 * not as "not captured".
 *
 * The SECTION's presence does NOT distinguish the two, and an earlier revision
 * of this note claimed it did: seven re-captured fixtures legitimately carry no
 * `definitionRequired` at all, because nothing in those schemas requires
 * anything (`AWS-Glue-Workflow`, `AWS-ECS-Cluster`, `AWS-ApiGateway-Account`,
 * `AWS-ApiGatewayV2-Api`, `AWS-CloudFormation-WaitConditionHandle`, and the two
 * `AWS-BedrockAgentCore-*` types). The working discriminator is `generatedAt`:
 * a capture dated on or after 2026-08-13 ran this extractor.
 *
 * KNOWN BOUND, and it narrows the sentence above: only a definition's OWN,
 * top-level `required` array is captured. CloudFormation registry schemas also
 * express required-ness two other ways, and both are silently absent here:
 *
 * - inside a COMBINATOR — `AWS::S3::Bucket`'s `TargetObjectKeyFormat` is
 *   `oneOf: [{required: ['SimplePrefix']}, {required: ['PartitionedPrefix']}]`
 *   with no root `required` (measured live, us-east-1, 2026-08-13);
 * - on an INLINE nested object rather than a named definition —
 *   `AWS::WAFv2::WebACL`'s `FieldToMatch.SingleHeader` carries
 *   `required: ['Name']` and has no key of its own to hang an entry on.
 *
 * So for those shapes a missing entry means "no PLAIN required list", NOT
 * "CloudFormation requires nothing" — and a consumer that read it the strong
 * way would derive exactly the false "a kept-but-partial block is reachable"
 * verdict this capture exists to prevent. Treat a missing entry as UNKNOWN
 * rather than as proof of permissiveness before concluding a parity verdict;
 * measure the shape against the live schema first. Capturing the combinator
 * and inline forms is left undone deliberately: both need a shape richer than
 * `Record<string, string[]>` (an arm is an ALTERNATIVE, not an addition), and
 * no consumer needs them yet.
 *
 * @param {string} schemaJson
 * @returns {Record<string, string[]>}
 */
export function extractDefinitionRequired(schemaJson) {
  /** @type {{properties?: Record<string, unknown>, required?: unknown, definitions?: Record<string, unknown>}} */
  const schema = JSON.parse(schemaJson);
  const definitions =
    schema.definitions && typeof schema.definitions === 'object' ? schema.definitions : {};

  /** @type {Record<string, string[]>} */
  const out = {};
  /**
   * @param {string} name
   * @param {unknown} required
   */
  const addRequired = (name, required) => {
    if (!Array.isArray(required)) return;
    const members = required.filter((m) => typeof m === 'string').sort();
    if (members.length > 0) out[name] = members;
  };

  addRequired('#top', schema.required);
  for (const [name, def] of Object.entries(definitions)) {
    if (def === null || typeof def !== 'object') continue;
    addRequired(name, /** @type {Record<string, unknown>} */ (def)['required']);
  }
  return out;
}

/**
 * Retry on CloudFormation's throttling shape ("Rate exceeded" / HTTP 429).
 * Exponential backoff with jitter, 1s -> 2s -> 4s -> 8s -> 16s -> 32s.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
      const status =
        err && typeof err === 'object' && '$metadata' in err
          ? /** @type {{httpStatusCode?: number}} */ (err.$metadata)?.httpStatusCode
          : undefined;
      const retryable =
        /Rate exceeded|Throttl|TooManyRequests/i.test(msg) ||
        /Throttl/i.test(code) ||
        status === 429 ||
        status === 503;
      if (!retryable || attempt === MAX_RETRIES - 1) {
        throw err;
      }
      const baseMs = 1000 * 2 ** attempt;
      const jitterMs = Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, baseMs + jitterMs));
    }
  }
  throw lastErr;
}

/**
 * Process a single resource type: fetch schema, parse, write fixture.
 * Returns the outcome for the summary report.
 *
 * @param {CloudFormationClient} client
 * @param {string} resourceType
 * @returns {Promise<{type: string, ok: true, propertyCount: number} | {type: string, ok: false, error: string}>}
 */
async function processType(client, resourceType) {
  try {
    const resp = await withRetry(() =>
      client.send(new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType }))
    );
    if (!resp.Schema) {
      return { type: resourceType, ok: false, error: 'DescribeType returned no Schema field' };
    }
    const properties = extractTopLevelProperties(resp.Schema);
    const readOnlyProperties = extractReadOnlyProperties(resp.Schema);
    const createOnlyProperties = extractCreateOnlyProperties(resp.Schema);
    const primaryIdentifier = extractPrimaryIdentifier(resp.Schema);
    const nestedProperties = extractNestedPropertyNames(resp.Schema);
    const nestedPropertyPaths = extractNestedPropertyPaths(resp.Schema, resourceType);
    const definitionShapes = extractDefinitionShapes(resp.Schema);
    const definitionRequired = extractDefinitionRequired(resp.Schema);
    const fixture = {
      resourceType,
      // YYYY-MM-DD only so an unchanged schema produces an unchanged fixture
      // (full timestamp would churn the git diff on every refresh).
      generatedAt: new Date().toISOString().split('T')[0],
      properties,
      readOnlyProperties,
      createOnlyProperties,
      primaryIdentifier,
      // Omitted entirely when the type has no nested property (keeps
      // scalar-only fixtures byte-stable vs the pre-#1373 shape).
      ...(Object.keys(nestedProperties).length > 0 ? { nestedProperties } : {}),
      // The PER-PATH twin (issue #1464), emitted alongside the flattened
      // capture rather than replacing it — see
      // {@link extractNestedPropertyPaths}. Same omit-when-empty rule, so a
      // scalar-only fixture keeps its pre-#1464 byte shape.
      ...(Object.keys(nestedPropertyPaths).length > 0 ? { nestedPropertyPaths } : {}),
      // `#top` is always present, so this field only stays out for a
      // fixture with no properties at all.
      ...(Object.keys(definitionShapes).length > 0 ? { definitionShapes } : {}),
      // The required-ness capture (issue #1800). Same omit-when-empty rule as
      // the two above — but here the omission is common rather than degenerate:
      // a type whose schema requires nothing anywhere legitimately has no
      // section at all.
      ...(Object.keys(definitionRequired).length > 0 ? { definitionRequired } : {}),
    };
    const path = join(FIXTURES_DIR, fixtureFilename(resourceType));
    await writeFile(path, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
    return { type: resourceType, ok: true, propertyCount: properties.length };
  } catch (err) {
    return {
      type: resourceType,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pool-based concurrent processor. Lighter than p-limit for a one-off script.
 *
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function pooled(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const usage =
    'Usage: node scripts/refresh-cfn-schemas.mjs [type-filter] [--only-missing]\n' +
    '  type-filter     substring (or exact) match against registered resource types;\n' +
    '                  WITHOUT it the FULL registered set (~135 types) is re-fetched\n' +
    '  --only-missing  fetch only types with no fixture file yet\n';
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage);
    return;
  }
  // An unrecognized flag must NOT silently fall through to a FULL re-fetch:
  // `--help` did exactly that before this guard (issue #1378 rider) — the
  // absent positional meant "no filter" and all ~135 fixtures churned.
  // Single-dash args are guarded too: a `-x` typo is a flag attempt, not a
  // type filter.
  const unknownFlags = args.filter((a) => a.startsWith('-') && a !== '--only-missing');
  if (unknownFlags.length > 0) {
    process.stderr.write(`Unknown flag(s): ${unknownFlags.join(', ')}\n${usage}`);
    process.exit(1);
  }
  const typeFilter = args.find((a) => !a.startsWith('--'));
  const onlyMissing = args.includes('--only-missing');

  const source = await readFile(REGISTER_PROVIDERS_PATH, 'utf8');
  const allRegisteredTypes = extractRegisteredTypes(source);
  let types = allRegisteredTypes;
  if (typeFilter) {
    types = types.filter((t) => t === typeFilter || t.includes(typeFilter));
    if (types.length === 0) {
      console.error(`No registered type matched "${typeFilter}".`);
      process.exit(1);
    }
  }

  await mkdir(FIXTURES_DIR, { recursive: true });

  if (onlyMissing) {
    const existing = new Set(await readdir(FIXTURES_DIR));
    const before = types.length;
    types = types.filter((t) => !existing.has(fixtureFilename(t)));
    console.log(`--only-missing: ${before - types.length} fixture(s) already exist, fetching ${types.length}`);
  }

  console.log(`Refreshing CFn schemas for ${types.length} resource type(s)`);
  if (types.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const client = new CloudFormationClient({
    region: process.env.AWS_REGION || 'us-east-1',
  });

  const results = await pooled(types, CONCURRENCY, (type) => processType(client, type));

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log('');
  console.log(`✓ ${ok.length} schema(s) refreshed`);
  if (failed.length > 0) {
    console.error(`✗ ${failed.length} schema(s) failed:`);
    for (const f of failed) {
      console.error(`  - ${f.type}: ${'error' in f ? f.error : 'unknown'}`);
    }
    process.exit(2);
  }

  // Diff helper: list fixture files that exist on disk but are no longer
  // registered. The script does NOT delete them automatically — a fixture
  // file lingering for a since-removed provider is a signal worth surfacing
  // to the operator, not silently swept.
  // Files starting with `_` (e.g. `_todo-backfill.json`) are control
  // files maintained by the property-coverage test, not per-type fixtures.
  const onDisk = (await readdir(FIXTURES_DIR)).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_')
  );
  const expected = new Set(allRegisteredTypes.map(fixtureFilename));
  const stale = onDisk.filter((f) => !expected.has(f));
  if (stale.length > 0) {
    console.log('');
    console.log('Stale fixture(s) — provider was unregistered. Delete manually:');
    for (const f of stale) {
      console.log(`  ${join('tests/fixtures/cfn-schemas', f)}`);
    }
  }
}

// Allow `import { extractRegisteredTypes } from '../../scripts/refresh-cfn-schemas.mjs'`
// in tests without running main().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
