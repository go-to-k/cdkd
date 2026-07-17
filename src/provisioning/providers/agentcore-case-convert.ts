/**
 * PascalCase <-> camelCase key conversion helpers shared by the
 * BedrockAgentCore SDK Providers (`agentcore-runtime-provider.ts`,
 * `agentcore-browser-provider.ts`, `agentcore-code-interpreter-provider.ts`,
 * `agentcore-evaluator-provider.ts`).
 *
 * CloudFormation templates carry PascalCase property keys while the
 * `bedrock-agentcore-control` SDK expects camelCase input shapes (and
 * returns camelCase output shapes). The BedrockAgentCore CFn schemas mirror
 * the SDK shapes 1:1 modulo casing, so a mechanical first-letter case flip
 * round-trips cleanly — including union members (`LlmAsAJudge` <->
 * `llmAsAJudge`, `CodeBased` <-> `codeBased`).
 *
 * `preserveKeys` opts specific keys out of DEEP conversion: the key itself
 * is still case-flipped, but its VALUE subtree is copied verbatim. Needed
 * for free-form JSON document properties whose inner keys are user-defined
 * model/request fields, NOT CFn property names — e.g. the Evaluator's
 * `AdditionalModelRequestFields` (model-specific request fields like
 * `top_k` that must reach the service byte-identical).
 */

/**
 * Recursively convert PascalCase object keys to camelCase.
 * Only converts keys of plain objects; string values, arrays of strings,
 * and other primitives are left untouched.
 *
 * @param preserveKeys - PascalCase key names whose value subtree is copied
 *   verbatim (the key itself is still converted to camelCase).
 */
export function pascalToCamelCaseKeys(value: unknown, preserveKeys?: ReadonlySet<string>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => pascalToCamelCaseKeys(item, preserveKeys));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const camelKey = key.charAt(0).toLowerCase() + key.slice(1);
      result[camelKey] = preserveKeys?.has(key) ? val : pascalToCamelCaseKeys(val, preserveKeys);
    }
    return result;
  }
  return value;
}

/**
 * Recursively convert camelCase object keys to PascalCase. Inverse of
 * `pascalToCamelCaseKeys`. Used by `readCurrentState` implementations to
 * re-shape AWS SDK responses back into the CFn property names cdkd state
 * stores.
 *
 * @param preserveKeys - camelCase key names whose value subtree is copied
 *   verbatim (the key itself is still converted to PascalCase).
 */
export function camelToPascalCaseKeys(value: unknown, preserveKeys?: ReadonlySet<string>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => camelToPascalCaseKeys(item, preserveKeys));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const pascalKey = key.charAt(0).toUpperCase() + key.slice(1);
      result[pascalKey] = preserveKeys?.has(key) ? val : camelToPascalCaseKeys(val, preserveKeys);
    }
    return result;
  }
  return value;
}
