import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import { displayMasked, logRender, maskValueLeaves } from '../masking-display.js';
import { markNonRetryable } from '../../retryable-errors.js';
import { type ResolverContext, quotedRender } from '../support.js';

/**
 * Resolve Fn::FindInMap intrinsic function
 *
 * Fn::FindInMap: [MapName, TopLevelKey, SecondLevelKey]
 * Fn::FindInMap: [MapName, TopLevelKey, SecondLevelKey, { DefaultValue: <value> }]
 * Looks up a value in the Mappings section of the template. When the optional
 * 4th argument supplies a `DefaultValue` and the requested top-level OR
 * second-level key is absent, CloudFormation returns the DefaultValue instead
 * of failing; cdkd mirrors that here. Without a DefaultValue the missing-key
 * cases throw (backward compatible).
 */
export async function resolveFindInMap(
  resolver: IntrinsicFunctionResolver,
  findInMapArgs: [unknown, unknown, unknown] | [unknown, unknown, unknown, unknown],
  context: ResolverContext
): Promise<unknown> {
  const [rawMapName, rawTopLevelKey, rawSecondLevelKey, rawOptions] = findInMapArgs;

  // Recursively resolve each argument (they could be Refs or other intrinsic functions)
  const mapName = String(await resolver.resolveValue(rawMapName, context));
  const topLevelKey = String(await resolver.resolveValue(rawTopLevelKey, context));
  const secondLevelKey = String(await resolver.resolveValue(rawSecondLevelKey, context));

  // Optional 4th argument: { DefaultValue: <value> }. The DefaultValue may
  // itself be an intrinsic, so resolve it lazily only when we need to fall
  // back to it. `hasDefaultValue` distinguishes "no 4th arg" from a 4th arg
  // whose DefaultValue is intentionally undefined/null.
  const hasDefaultValue =
    typeof rawOptions === 'object' &&
    rawOptions !== null &&
    !Array.isArray(rawOptions) &&
    'DefaultValue' in (rawOptions as Record<string, unknown>);
  const resolveDefault = (): Promise<unknown> =>
    resolver.resolveValue((rawOptions as Record<string, unknown>)['DefaultValue'], context);

  // Access the Mappings section of the template
  const mappings = context.template.Mappings;
  // `Object.hasOwn` on all three lookups below (issue #2767). Every one of
  // `mapName` / `topLevelKey` / `secondLevelKey` is template-controlled, and
  // mapping keys are FREE-FORM text rather than logical ids, so this is the
  // most reachable site of the class: `Fn::FindInMap: [M, K, "constructor"]`
  // returned the `Object` function as the resolved VALUE instead of throwing,
  // and a `__proto__` top-level key returned `Object.prototype`.
  // `!= null`, NOT `!== undefined`: the read this replaced was `mappings?.[…]`,
  // whose optional chain short-circuits on NULL as well, and `Object.hasOwn`
  // throws `Cannot convert undefined or null to object`. A YAML `Mappings:`
  // with an empty body parses to `null` and reaches here through
  // `cdkd import --migrate-from-cloudformation`, so the narrower test turned
  // the `DefaultValue` arm and the named refusal below into a raw `TypeError`.
  // The `!mappings` guard underneath is falsy-checked for exactly that reason.
  const map = (
    mappings != null && Object.hasOwn(mappings, mapName) ? mappings[mapName] : undefined
  ) as Record<string, Record<string, unknown>> | undefined;

  if (!mappings) {
    if (hasDefaultValue) {
      return await resolveDefault();
    }
    throw markNonRetryable(new Error(`Fn::FindInMap: no Mappings section found in template`));
  }

  if (!map) {
    if (hasDefaultValue) {
      return await resolveDefault();
    }
    // MASKED at the throw (issue
    // [#2827](https://github.com/go-to-k/cdkd/issues/2827)): all three
    // `Fn::FindInMap` arguments come back from `resolveValue`, so any of
    // them can be a decrypted secret an `Fn::Sub` assembled. Masked per RAW
    // value, which is what reaches the floorless whole-value arm.
    throw markNonRetryable(
      new Error(
        `Fn::FindInMap: mapping ${quotedRender(displayMasked(resolver, mapName, context), "'")} not found in Mappings section`
      )
    );
  }

  const topLevel = Object.hasOwn(map, topLevelKey) ? map[topLevelKey] : undefined;
  if (!topLevel || typeof topLevel !== 'object') {
    if (hasDefaultValue) {
      return await resolveDefault();
    }
    throw markNonRetryable(
      new Error(
        `Fn::FindInMap: top-level key ${quotedRender(displayMasked(resolver, topLevelKey, context), "'")} ` +
          `not found in mapping ${quotedRender(displayMasked(resolver, mapName, context), "'")}`
      )
    );
  }

  if (!Object.hasOwn(topLevel, secondLevelKey)) {
    if (hasDefaultValue) {
      return await resolveDefault();
    }
    throw markNonRetryable(
      new Error(
        `Fn::FindInMap: second-level key ${quotedRender(displayMasked(resolver, secondLevelKey, context), "'")} ` +
          `not found in mapping ${quotedRender(displayMasked(resolver, mapName, context), "'")} under ` +
          // `under`, not `->`: pasted, `->` is `-` plus a `>` redirect onto the
          // quoted top-level key, which `QUOTABLE_RENDER` admits as a path
          // (`../x`, go-to-k/cdkd#4100 review M1).
          `top-level key ${quotedRender(displayMasked(resolver, topLevelKey, context), "'")}`
      )
    );
  }

  const result = topLevel[secondLevelKey];
  resolver.logger.debug(
    // MASKED like the three throws above (issue
    // [#2827](https://github.com/go-to-k/cdkd/issues/2827) review): all three
    // keys come back from `resolveValue`, and this is the SUCCESS path — the
    // common one — so leaving it bare printed at `--verbose` exactly the
    // values the neighbouring refusals mask. The mapped VALUE is leaf-masked
    // too: a mapping may legitimately hold a value assembled from a secret.
    `Resolved Fn::FindInMap: ${logRender(resolver, mapName, context)}.` +
      `${logRender(resolver, topLevelKey, context)}.` +
      `${logRender(resolver, secondLevelKey, context)} resolved to ` +
      `${logRender(resolver, JSON.stringify(maskValueLeaves(resolver, result, context)), context, { structured: true })}`
  );
  return result;
}
