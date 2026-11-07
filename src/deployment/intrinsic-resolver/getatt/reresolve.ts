import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import { displayMasked } from '../masking-display.js';
import { resolveDynamicReferences } from '../dynamic-refs.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX,
  type ResolverContext,
  carriesDynamicReference,
} from '../support.js';
import { classifyReplaySecretRegion } from '../../secret-region-classification.js';
import {
  carriesSecretMask,
  dynamicReferenceTokens,
  MIN_NEEDLE_LENGTH,
  splitGetAttStringForm,
  wholeStringLeavesOf,
} from '../../secret-redaction.js';
import {
  type TokenResolution,
  recordedTokenRoutes,
  recordedTokenVersions,
  reresolveByRecordedRoutes,
} from '../recorded-reference-routes.js';
import { reresolveCrossStackValue } from '../cross-stack.js';

/**
 * Re-resolve the `{{resolve:...}}` references in a value served out of a
 * PERSISTED record of this stack (go-to-k/cdkd#4800). State stores a secret
 * plaintext as the expression that produced it, in `attributes` too (an SQS
 * `Arn` around a queue NAMED from a secret persists as
 * `arn:...:{{resolve:secretsmanager:...}}`), so serving the leaf as it is sends
 * that spelling to AWS whenever the producer is `NO_CHANGE`. A producer updated
 * in this run serves the provider's fresh value and never reaches here with one.
 *
 * Resolved by THIS resolver, and only when every token's region is PROVEN: one
 * the producer's own template leaves spell (see {@link referencesProvenLocal}),
 * or any token when the deploy's producer-region evidence is complete and names
 * no producer in another region ({@link referencesRegionProven},
 * go-to-k/cdkd#4805). A record can also hold the expression a cross-region
 * `Fn::GetStackOutput` handed it, which this region would answer from a
 * same-named secret, silently.
 * Each plaintext is recorded into the reader's bag, so the reader's record
 * persists the expression back, and a diff context (`skipDynamicReferences`)
 * keeps the secret's spelling, comparing expression with expression.
 *
 * Unchanged: a value carrying no reference; one carrying the MASK, which
 * {@link noteAttributeSecrecy} already reported for the deploy to refuse; a
 * value with a token not proven local, or whose resolution the producer's
 * physical id does not contain ({@link referencesMatchPhysicalId}: a rotated
 * secret, or a value that is no name), served as before with a warning; and
 * any value in a context with no bag to record the plaintext into, since its
 * caller could persist the plaintext unredacted.
 */
export async function reresolveRecordedReferences(
  resolver: IntrinsicFunctionResolver,
  value: unknown,
  logicalId: string,
  context: ResolverContext,
  origin: string,
  sourceKey: string | undefined
): Promise<unknown> {
  if (!carriesDynamicReference(value) || carriesSecretMask(value)) return value;
  if (context.recordedSecretValues === undefined) return value;
  const notReresolvingLine = (): void =>
    resolver.logger.debug(
      safeMsg`Not re-resolving the reference(s) in ${displayMasked(resolver, origin, context)}: the template of ${displayMasked(resolver, logicalId, context)} does not spell them, and this stack may read a stack in another region, so the region that resolved them is unknown`
    );
  const servingAsRecordedLine = (): void =>
    resolver.logger.warn(
      safeMsg`Serving ${displayMasked(resolver, origin, context)} as recorded, with its {{resolve:...}} reference(s) unresolved: cdkd cannot confirm the secret still holds the value ${displayMasked(resolver, logicalId, context)} was deployed with, because its physical id does not contain it. Either the secret changed since then (update ${displayMasked(resolver, logicalId, context)} so cdkd deploys it with the new value), or the value is not part of its name (a custom resource's Data, a name shorter than four characters), and cdkd sends the recorded reference as before.`
    );
  // go-to-k/cdkd#4847: a record carrying v12 provenance names each token's
  // region and version; each arm falls back to today's proof independently.
  const record = Object.hasOwn(context.resources, logicalId)
    ? context.resources[logicalId]
    : undefined;
  const routes = recordedTokenRoutes(value, record);
  if (routes !== undefined) {
    return await reresolveByRecordedRoutes(
      resolver,
      value,
      logicalId,
      context,
      origin,
      sourceKey,
      routes,
      {
        region: undefined,
        proofs: {
          regionProven: (tokens) =>
            referencesProvenLocal(tokens, logicalId, context) ||
            referencesRegionProven(tokens, context, resolver.resolverRegion),
          onRegionUnproven: notReresolvingLine,
          generationProven: (tokens, routeOf) =>
            referencesMatchPhysicalId(resolver, tokens, logicalId, context, routeOf),
          onGenerationUnproven: () => {
            if (context.provenanceCapture !== true) servingAsRecordedLine();
          },
        },
      }
    );
  }
  if (
    !referencesProvenLocal(value, logicalId, context) &&
    !referencesRegionProven(value, context, resolver.resolverRegion)
  ) {
    notReresolvingLine();
    return value;
  }
  // The GENERATION proof: each reference must still resolve to text the
  // producer's physical id holds. A secret rotated since the producer was
  // deployed leaves it NO_CHANGE (the diff compares references), still under
  // the old name, and today's value would name a resource that does not exist.
  if (!(await referencesMatchPhysicalId(resolver, value, logicalId, context))) {
    // The v12 migration capture resolves records the deploy itself resolves
    // too; the line is the deploy's to print.
    if (context.provenanceCapture) return value;
    servingAsRecordedLine();
    return value;
  }
  // go-to-k/cdkd#4852 (design §2.2): a record whose provenance gives no region
  // and no single version (two generations of a create-only token) still names
  // the versions it holds, which the read route records.
  const readVersions = recordedTokenVersions(value, record);
  return await reresolveCrossStackValue(
    resolver,
    value,
    undefined,
    readVersions === undefined ? context : { ...context, recordedReadVersions: readVersions },
    origin,
    sourceKey
  );
}

/**
 * Does every `{{resolve:...}}` token in `value` resolve to text the producer's
 * physical id contains (go-to-k/cdkd#4800 review)? The physical id is stored
 * in plaintext and names what was DEPLOYED, so a match proves the reference
 * still resolves to that generation. A plaintext under
 * {@link MIN_NEEDLE_LENGTH} proves nothing and refuses; a token left unresolved
 * (a diff context's `skipDynamicReferences`) is not sent resolved, so it passes.
 * Each token is resolved through the resolver's per-instance cache, so the
 * re-resolution that follows makes no second lookup.
 */
export async function referencesMatchPhysicalId(
  resolver: IntrinsicFunctionResolver,
  value: unknown,
  logicalId: string,
  context: ResolverContext,
  // go-to-k/cdkd#4847: the resolver and context each token resolves in (its
  // recorded region's); this resolver and `context` when absent.
  routeOf?: (token: string) => TokenResolution
): Promise<boolean> {
  const record = Object.hasOwn(context.resources, logicalId)
    ? context.resources[logicalId]
    : undefined;
  const physicalId = typeof record?.physicalId === 'string' ? record.physicalId.toLowerCase() : '';
  for (const leaf of wholeStringLeavesOf(value)) {
    for (const token of dynamicReferenceTokens(leaf)) {
      const route = routeOf?.(token);
      const plaintext =
        route === undefined
          ? await resolveDynamicReferences(resolver, token, context)
          : // The ROUTE's resolver (its recorded region's), never this one.
            await resolveDynamicReferences(route.resolver, token, route.context);
      if (plaintext.includes('{{resolve:')) continue;
      if (plaintext.length < MIN_NEEDLE_LENGTH) return false;
      if (!physicalId.includes(plaintext.toLowerCase())) return false;
    }
  }
  return true;
}

/**
 * Is every `{{resolve:...}}` token in `value` known to have been resolved in
 * this region, by the deploy's producer-region evidence
 * ({@link ResolverContext.secretRegionEvidence}, go-to-k/cdkd#4805)? A token
 * reaches this stack's record from its own resolution (this region), from a
 * same-account stack it reads (whose region its `imports` / `outputReads`
 * record; a cross-account read of a reference is refused), from a nested
 * parent (whose regions a child's evidence inherits), or from a nested
 * child's `Outputs.X` (re-resolved in the child's region, which is this
 * stack's). So with COMPLETE evidence naming no other region, a region-less
 * token is local; a token naming its region by ARN resolves there, through
 * the region-pinned sibling. Incomplete or absent evidence proves nothing,
 * an ARN token included.
 */
function referencesRegionProven(value: unknown, context: ResolverContext, region: string): boolean {
  const evidence = context.secretRegionEvidence?.();
  if (evidence?.complete !== true) return false;
  return [...wholeStringLeavesOf(value)].every((leaf) =>
    dynamicReferenceTokens(leaf).every(
      (token) => classifyReplaySecretRegion(token, region, evidence.regions).kind !== 'ambiguous'
    )
  );
}

/**
 * Is `node` a read whose value another stack resolved, possibly in another
 * region: `Fn::ImportValue`, `Fn::GetStackOutput`, or a nested stack's
 * `Fn::GetAtt Child.Outputs.X`? Such a read can hand the producer's record a
 * region-less expression spelled like a literal token beside it.
 */
function readsAnotherStack(node: Record<string, unknown>): boolean {
  if (Object.hasOwn(node, 'Fn::ImportValue') || Object.hasOwn(node, 'Fn::GetStackOutput')) {
    return true;
  }
  if (!Object.hasOwn(node, 'Fn::GetAtt')) return false;
  const getAtt = node['Fn::GetAtt'];
  const attributeName =
    typeof getAtt === 'string'
      ? splitGetAttStringForm(getAtt)?.attributeName
      : Array.isArray(getAtt)
        ? getAtt[1]
        : undefined;
  // A non-literal attribute name proves nothing either.
  return (
    typeof attributeName !== 'string' ||
    attributeName.startsWith(NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX)
  );
}

/** The taken branch of an `Fn::If` node whose condition `context` evaluated, else `undefined`. */
function takenIfBranch(node: object, context: ResolverContext): { branch: unknown } | undefined {
  if (Array.isArray(node) || !Object.hasOwn(node, 'Fn::If')) return undefined;
  const args = (node as Record<string, unknown>)['Fn::If'];
  if (!Array.isArray(args) || args.length !== 3 || typeof args[0] !== 'string') return undefined;
  const conditions = context.conditions;
  if (conditions === undefined || !Object.hasOwn(conditions, args[0])) return undefined;
  const verdict = conditions[args[0]];
  if (typeof verdict !== 'boolean') return undefined;
  return { branch: verdict ? args[1] : args[2] };
}

/**
 * Does the producer's own template `Properties` spell, as a literal string
 * leaf (or inside one), every `{{resolve:...}}` token `value` carries, with no
 * read of another stack anywhere in them ({@link readsAnotherStack})? A literal
 * token is resolved by the producer's template-leaf route in THIS resolver's
 * region, so re-resolving it here answers from the region the record's value
 * came from; whether it is still the same VALUE is
 * {@link referencesMatchPhysicalId}'s question. A token assembled by
 * an intrinsic, or read from another stack, proves nothing about its region
 * (go-to-k/cdkd#4800 security review). The walk covers one resource's
 * properties, so it does not scale with the stack.
 */
function referencesProvenLocal(
  value: unknown,
  logicalId: string,
  context: ResolverContext
): boolean {
  const resources = context.template.Resources ?? {};
  if (!Object.hasOwn(resources, logicalId)) return false;
  const literals: string[] = [];
  let crossStack = false;
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.includes('{{resolve:')) literals.push(node);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (!Array.isArray(node) && readsAnotherStack(node as Record<string, unknown>))
      crossStack = true;
    // An `Fn::If` whose condition is known contributes its TAKEN branch only:
    // a token spelled in the other one never reached the record.
    const taken = takenIfBranch(node, context);
    if (taken !== undefined) {
      walk(taken.branch);
      return;
    }
    for (const child of Object.values(node as Record<string, unknown>)) walk(child);
  };
  walk(resources[logicalId]?.Properties);
  if (crossStack) return false;
  return [...wholeStringLeavesOf(value)].every((leaf) =>
    dynamicReferenceTokens(leaf).every((token) => literals.some((l) => l.includes(token)))
  );
}
