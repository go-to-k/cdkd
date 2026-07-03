import { describe, it, expect } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

/**
 * `Architectures` on AWS::Lambda::Function is mutable in place (CFn "Update
 * requires: No interruption" — the provider re-sends the code with the new
 * instruction set via UpdateFunctionCode). It is now classified EXPLICITLY in
 * the registry's `updateableProperties` rather than relying on the DescribeType
 * `createOnlyProperties` fallback (which is behaviorally correct — Architectures
 * is not create-only — but costs a network round-trip and does not pin intent).
 *
 * `isClassified` returning true is the load-bearing assertion: it proves the
 * registry has an explicit opinion, so the schema-fallback path in
 * DiffCalculator.compareProperties never runs for this property.
 */
const LAMBDA = 'AWS::Lambda::Function';

describe('ReplacementRulesRegistry — Lambda Function Architectures (explicit updateable)', () => {
  const registry = new ReplacementRulesRegistry();

  it('classifies Architectures explicitly (not via the createOnly fallback)', () => {
    expect(registry.isClassified(LAMBDA, 'Architectures')).toBe(true);
  });

  it('does NOT require replacement on an x86_64 -> arm64 Architectures change', () => {
    expect(
      registry.requiresReplacement(LAMBDA, 'Architectures', ['x86_64'], ['arm64'])
    ).toBe(false);
  });
});
