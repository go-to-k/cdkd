import type { StackInfo } from '../../synthesis/assembly-reader.js';
import { stringifyValue } from '../../utils/stringify.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { LocalInvokeResolutionError, type ResolvedLambdaLayer } from './types.js';
import { resolveAssetCodePath } from './asset-code.js';

/**
 * Resolve a Lambda's `Properties.Layers` references to local asset
 * directories (PR 6 of #224, issue #232).
 *
 * Each entry in the synthesized template is an intrinsic pointing at an
 * `AWS::Lambda::LayerVersion` resource in the same stack — most commonly
 * `{Ref: '<LayerLogicalId>'}` (which CDK uses for `LayerVersion.layerArn`)
 * or `{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}`. Once we have the
 * layer's logical ID we look up its `aws:asset:path` Metadata the same
 * way function code is located (the layer asset is unzipped under
 * `cdk.out/asset.<hash>/` ready to bind-mount).
 *
 * **Order is preserved**: `Properties.Layers` is iterated left-to-right
 * and the resulting `ResolvedLambdaLayer[]` carries the same order. The
 * caller (`local-invoke.ts`'s `materializeLambdaLayers` and
 * `local-start-api.ts`'s server-boot pre-merge) merges every
 * entry into one host tmpdir in template order to honor AWS's
 * "last-layer-wins" file-collision semantics — Docker rejects multiple
 * bind mounts at the same target so cdkd cannot rely on overlay
 * layering.
 *
 * **Same-stack handling** (`{Ref: <Id>}` / `{Fn::GetAtt: [<Id>, 'Ref']}`):
 *
 *   - Refs that don't point at an `AWS::Lambda::LayerVersion` resource
 *     hard-error — almost always a typo'd logical ID.
 *   - Refs to a `LayerVersion` whose `Metadata['aws:asset:path']` is
 *     missing hard-error — the layer's content is `S3Bucket` / `S3Key`
 *     from outside cdk.out and there's no local directory to bind-mount.
 *
 * **Literal-ARN handling** (issue #448): entries shaped like the string
 * `arn:aws:lambda:<region>:<account>:layer:<name>:<version>` are parsed
 * into a `{kind: 'arn', ...}` resolved layer. The actual
 * `lambda:GetLayerVersion` + presigned-URL download + unzip happens
 * later in the CLI (`materializeLayerFromArn(...)`), which can optionally
 * `sts:AssumeRole` into the layer's account when the dev's default
 * credentials cannot read it. Covers AWS-published public layers (Lambda
 * Powertools, Datadog Extension, etc.) and cross-account / cross-region
 * shared layers.
 */
export function resolveLambdaLayers(
  stack: StackInfo,
  logicalId: string,
  props: Record<string, unknown>
): ResolvedLambdaLayer[] {
  const layers = props['Layers'];
  if (layers === undefined) return [];
  if (!Array.isArray(layers)) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has a non-array Layers property. Expected an array of LayerVersion references.`
    );
  }
  if (layers.length === 0) return [];

  const resources = stack.template.Resources ?? {};
  const out: ResolvedLambdaLayer[] = [];
  for (let i = 0; i < layers.length; i++) {
    const entry: unknown = layers[i];

    // Literal-ARN entry (issue #448) — recognized before the
    // logical-ID lookup so users who reference AWS-published layers
    // (Lambda Powertools etc.) or cross-account / cross-region shared
    // layers bypass the same-stack resource scan.
    if (typeof entry === 'string') {
      const parsed = classifyLayerVersionArn(entry);
      if (!parsed.ok) {
        throw new LocalInvokeResolutionError(
          `Lambda '${logicalId}' has a Layers entry [${i}] cdkd cannot resolve locally: literal string '${entry}'. ` +
            'Expected a same-stack Ref / Fn::GetAtt to an AWS::Lambda::LayerVersion ' +
            'OR a literal layer-version ARN of the form ' +
            'arn:aws:lambda:<region>:<account>:layer:<name>:<version>.' +
            describeLayerArnRejection(parsed.rejection)
        );
      }
      out.push({ kind: 'arn', logicalId: parsed.value.arn, ...parsed.value });
      continue;
    }

    const layerLogicalId = pickLayerLogicalId(entry);
    if (!layerLogicalId) {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' has a Layers entry [${i}] cdkd cannot resolve locally: ${describeLayerEntry(entry)}. ` +
          'Expected a same-stack Ref / Fn::GetAtt to an AWS::Lambda::LayerVersion ' +
          'OR a literal layer-version ARN of the form ' +
          'arn:aws:lambda:<region>:<account>:layer:<name>:<version>.'
      );
    }

    const layerResource = resources[layerLogicalId];
    if (!layerResource) {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' Layers entry [${i}] references '${layerLogicalId}', ` +
          `but no resource with that logical ID exists in stack '${stack.stackName}'.`
      );
    }
    if (layerResource.Type !== 'AWS::Lambda::LayerVersion') {
      throw new LocalInvokeResolutionError(
        `Lambda '${logicalId}' Layers entry [${i}] references '${layerLogicalId}' (${layerResource.Type}), ` +
          'which is not an AWS::Lambda::LayerVersion.'
      );
    }

    const assetPath = resolveAssetCodePath(stack, layerLogicalId, layerResource);
    out.push({ kind: 'asset', logicalId: layerLogicalId, assetPath });
  }
  return out;
}

/**
 * The region segment of a layer-version ARN.
 *
 * Position, not shape, is what makes a segment a region here: it sits between
 * the literal `lambda` and a 12-digit account id inside an `arn:` string, so —
 * unlike `state-file-keys.ts`'s `REGION_SEGMENT`, which has to tell a region
 * apart from a STACK NAME occupying the same key position — this pattern has
 * nothing to disambiguate against and can take the region loosely. Both
 * bounds the pre-#2143 spelling carried are therefore gone:
 *
 * - the `^[a-z]{2}` first token, which rejected the European Sovereign Cloud
 *   partition's four-letter `eusc-de-east-1` (the same defect issue #2001
 *   fixed in `state-file-keys.ts`); and
 * - the `{1,2}` cap on interior `<word>-` chunks, an independent bound that
 *   happens to fit today's regions and would silently reject a longer one.
 *
 * **What it admits is therefore much wider than the set of real regions, and
 * that is deliberate rather than an oversight.** The first token is any run of
 * two or more lower-case letters and the interior chunks are unbounded, so
 * `garbage-junk-1` matches where the pre-#2143 pattern rejected it (measured).
 * Widening in that direction costs nothing HERE: the segment's position
 * already establishes it is the region field, so unlike a state-key segment
 * there is no second interpretation for a loose match to steal. What the shape
 * still buys, and why it is not simply `[a-z0-9-]+`, is a floor under what
 * reaches {@link derivePartitionAndUrlSuffix} — that helper answers `aws` for
 * anything it does not recognise, so a pure charset would let
 * `arn:aws:lambda:notaregion:...` through as a commercial layer ARN. Requiring
 * `<letters>(-<letters>)+-<digits>` keeps single-token and digit-free junk out
 * without pretending to enumerate AWS's region list.
 *
 * Lower-case only, matching the pre-#2143 spelling: AWS emits region ids
 * lower-case inside ARNs, and this parses an ARN AWS produced, not a
 * `--region` flag a human typed.
 */
const LAYER_ARN_REGION = '[a-z]{2,}(?:-[a-z]+)+-\\d+';

/**
 * `arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>`.
 *
 * The PARTITION group is deliberately loose. It is not validated by the
 * pattern at all — {@link classifyLayerVersionArn} checks it against the one
 * the REGION derives, which is a stronger check than any alternation.
 */
const LAYER_ARN_PATTERN = new RegExp(
  `^arn:([a-z][a-z0-9-]*):lambda:(${LAYER_ARN_REGION}):(\\d{12}):layer:([A-Za-z0-9_-]+):(\\d+)$`
);

/** The segments a well-formed layer-version ARN yields. */
export interface ParsedLayerVersionArn {
  arn: string;
  region: string;
  accountId: string;
  name: string;
  version: string;
}

/**
 * Why an ARN was refused — the input to the error message, so the message
 * cannot describe a different verdict than the one the parse reached.
 *
 * `'shape'` needs no words: a missing version, a 13-digit account or
 * `function` where `layer` belongs is visible in the string the user is
 * already looking at. `'partition'` is the opposite — the ARN looks perfectly
 * ordinary — so it carries what the message needs.
 *
 * `derivedFromTable` is the distinction that keeps the message HONEST.
 * {@link derivePartitionAndUrlSuffix} answers `aws` in two very different
 * situations: the region genuinely is commercial, or `PARTITION_TABLE` simply
 * has no prefix rule matching it. Both come back `aws`, and only the first
 * licenses saying "which is in partition 'aws'" — for
 * `arn:aws-iso-g:lambda:us-isog-east-1:...` that sentence would be a guess
 * asserted as fact.
 */
export type LayerArnRejection =
  | { kind: 'shape' }
  | {
      kind: 'partition';
      partition: string;
      region: string;
      derived: string;
      derivedFromTable: boolean;
    };

export type LayerArnClassification =
  | { ok: true; value: ParsedLayerVersionArn }
  | { ok: false; rejection: LayerArnRejection };

/**
 * Classify a Lambda layer-version ARN: its segments, or why it was refused.
 *
 * The single decision point behind both the resolved layer's fields and the
 * caller's error message, so the message cannot describe a different verdict
 * than the parse reached. An earlier revision had the message re-run the
 * pattern in a separate helper, which left an arm — "the partitions agree" —
 * that the sole call site could never reach, because it only asked after the
 * parse had already refused. One classifier with one return value removes the
 * arm rather than justifying it, and runs the regex once.
 *
 * **The partition is DERIVED from the region, not enumerated** (issue #2143).
 * The pre-#2143 spelling hard-listed `aws` / `aws-cn` / `aws-us-gov` and so
 * failed to parse a layer ARN in any of the other five partitions
 * (`aws-iso`, `aws-iso-b`, `aws-iso-e`, `aws-iso-f`, `aws-eusc`) — and the
 * caller HARD-THROWS on an unparsed ARN, so `cdkd local invoke` on a function
 * with a literal-ARN layer failed at RESOLUTION in each of them. Running the
 * region through `derivePartitionAndUrlSuffix` (`src/utils/aws-partition.ts`)
 * is what the repo already does everywhere else it needs a partition, so the
 * list is not spelled a fourth time and cannot go stale here independently.
 *
 * **The download behind it is no longer commercial-only.** This paragraph used
 * to say the opposite, citing a cdk-local build that rebuilt the ARN with a
 * hardcoded `aws` — go-to-k/cdk-local#575, which CLOSED on 2026-08-27 and
 * shipped in cdk-local 0.147.13 three minutes later. The text was wrong from
 * that moment, for USERS TOO and not only about upstream: cdkd declares
 * `cdk-local` as a plain runtime dependency with no `bundledDependencies`, so
 * a consumer resolves the RANGE rather than this repo's lockfile, and the
 * range then in effect (`^0.147.7`) already admitted 0.147.13. What lagged was
 * this repo's own pinned tree — `pnpm-lock.yaml` stayed on 0.147.7 until the
 * 0.148.4 bump on 2026-09-12 — so cdkd's CI ran the broken engine for sixteen
 * more days than anyone installing cdkd did. The claim survived all of it
 * because it cited a content-hashed bundle chunk and a line number, which
 * nobody could check (go-to-k/cdkd#3551). Measured on cdk-local 0.149.1:
 * `fetchLayerContentUrl` strips only the `:<version>` suffix from the ARN the
 * caller supplied and hands the remainder to `GetLayerVersionCommand` as
 * `LayerName`, so whatever partition the ARN names is preserved. Its own
 * refusal message spells the expected shape `arn:<partition>:lambda:...`.
 *
 * So the parse fix and the download now agree, and a layer ARN in any of the
 * eight partitions resolves as far as AWS itself allows. Re-check with
 * `grep -n 'function fetchLayerContentUrl' node_modules/cdk-local/dist/local-studio-*.js`
 * rather than by trusting this paragraph.
 *
 * Deriving also makes the pair SELF-CONSISTENT, which the alternation could
 * not: `arn:aws-cn:lambda:us-east-1:...` used to parse, pairing China's
 * partition with a commercial region. It is now REFUSED — a deliberate
 * behaviour break, asked for by issue #2143's own direction. The refusal stands
 * on its own terms rather than on the rebuild it used to lean on: a
 * region-partition pair that cannot both be true names a region that does not
 * exist in that partition, so the fetch could not have succeeded whatever the
 * downstream does with the ARN.
 *
 * The fallback direction is worth stating, since `derivePartitionAndUrlSuffix`
 * answers `aws` for a region it does not recognise. A brand-new COMMERCIAL
 * region therefore still parses with `arn:aws:` — the direction that must keep
 * working before the table hears about it — while a brand-new region in a
 * future partition is rejected rather than mis-attributed to commercial, which
 * is the same trade every other consumer of that table makes.
 *
 * Deliberately NOT `isClientSafeRegion` (`intrinsic-resolver/account-drain.ts`):
 * that predicate is charset-based because its job is to keep a value inside a
 * hostname label, so it accepts anything lower-case alphanumeric — including
 * strings no region grammar would admit. See the note it carries.
 *
 * THIS is the exported symbol, and a `parseLayerVersionArn` wrapper returning
 * `T | undefined` is deliberately not kept beside it. Once the caller moved to
 * the classifier, that wrapper had no `src/` reference left and existed only
 * for the tests — which `scripts/check-local-reachability.ts` reports as an
 * orphaned export, correctly. That critic's opt-out tag would have been a
 * false statement here — it means "cdk-local owns the live implementation",
 * and cdkd owns this one — so the wrapper is gone rather than tagged. Tests
 * drive this classifier or the real caller instead. (The tag is deliberately
 * not spelled out in this comment: the critic reads tags from JSDoc, so
 * naming it here registers an annotation on a LIVE symbol and is reported as
 * stale. Measured.)
 */
export function classifyLayerVersionArn(input: string): LayerArnClassification {
  const m = LAYER_ARN_PATTERN.exec(input);
  if (!m) return { ok: false, rejection: { kind: 'shape' } };
  const partition = m[1]!;
  const region = m[2]!;
  const derived = derivePartitionAndUrlSuffix(region).partition;
  if (derived !== partition) {
    return {
      ok: false,
      rejection: {
        kind: 'partition',
        partition,
        region,
        derived,
        derivedFromTable: derived !== 'aws',
      },
    };
  }
  return {
    ok: true,
    value: { arn: input, region, accountId: m[3]!, name: m[4]!, version: m[5]! },
  };
}

/**
 * The one sentence a reader cannot derive from the ARN in front of them.
 *
 * A `'shape'` rejection gets nothing appended, so the message is
 * byte-identical to what it has always been for every pre-#2143 refusal. A
 * `'partition'` rejection is the class this change newly refuses AND the one
 * that looks perfectly well formed, so it says what disagrees.
 *
 * The two `'partition'` arms differ in what cdkd actually KNOWS. On a
 * `PARTITION_TABLE` hit the derived partition is a fact and is stated as one.
 * On a miss it is a FALLBACK, so the sentence states the RESOLUTION instead of
 * asserting membership: `us-east-1` and a hypothetical `us-isog-east-1` both
 * derive `aws`, but only the first is really commercial, and a message that
 * cannot tell them apart teaches the reader something false about the second.
 *
 * **The miss arm is the COMMERCIAL arm, and that is not obvious from its
 * name.** `PARTITION_TABLE` (`src/utils/aws-partition.ts`) holds seven rows
 * and none of them is `aws` — the commercial partition is the fallback
 * `return` at the bottom of `derivePartitionAndUrlSuffix`, not a row. So
 * `derivedFromTable` is FALSE for every genuinely commercial region, the fact
 * arm can never render `derived === 'aws'`, and the miss arm always does. Its
 * wording therefore has to read correctly for `us-east-1` — the commonest
 * region there is, and the one the docs, the integ fixture and the changelog
 * all use as the canonical example. An earlier revision said "no partition
 * prefix **cdkd knows** matches that region", which is true of the mechanism
 * and reads as cdkd failing to recognise `us-east-1`; it now leads with the
 * prefix test and ends on the resolution, which is the fact the reader needs.
 */
function describeLayerArnRejection(rejection: LayerArnRejection): string {
  if (rejection.kind === 'shape') return '';
  const { partition, region, derived, derivedFromTable } = rejection;
  const head = ` The partition '${partition}' does not match region '${region}'`;
  return derivedFromTable
    ? `${head}, which is in partition '${derived}'.`
    : `${head}: no partition prefix matches that region, so cdkd resolves it to the commercial partition '${derived}'.`;
}

/**
 * Walk a single Layers-array entry and return the referenced layer's
 * logical ID — or `undefined` for shapes we don't try to resolve in v1.
 *
 * Accepted shapes (what CDK actually synthesizes — JSON-only):
 *   - `{Ref: '<LayerLogicalId>'}`
 *   - `{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}` (rare; LayerVersion's
 *     Ref form is usually emitted as a flat `Ref`)
 *
 * Intentionally **rejected**: the YAML-only string form
 * `{Fn::GetAtt: '<LogicalId>.<attr>'}`. CloudFormation YAML accepts the
 * dot-shorthand and converts it to the array form on the wire, but
 * CloudFormation JSON (the output of `cdk synth`, which is the only
 * thing cdkd ingests) never emits the string form. Treating it as
 * resolvable here would silently accept hand-edited / malformed templates
 * that no real CDK flow can produce; instead we fall through to the
 * standard "cdkd cannot resolve this Layers entry locally" error so the
 * user sees the offending shape called out.
 */
function pickLayerLogicalId(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const obj = entry as Record<string, unknown>;
  if (typeof obj['Ref'] === 'string') return obj['Ref'];
  if ('Fn::GetAtt' in obj) {
    const arg = obj['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') return arg[0];
    // Deliberately not: `if (typeof arg === 'string') return arg.split('.')[0]`.
    // See docstring above — the string form is YAML-only and CFn JSON
    // never emits it.
  }
  return undefined;
}

/**
 * Stringify a Layers-array entry for use in error messages. Truncates
 * literal ARNs to a short form so the message stays one-line.
 */
function describeLayerEntry(entry: unknown): string {
  if (typeof entry === 'string') return `literal ARN '${entry}'`;
  if (entry === null) return 'null';
  if (typeof entry !== 'object') return stringifyValue(entry);
  try {
    const json = JSON.stringify(entry);
    return json.length > 120 ? json.substring(0, 117) + '...' : json;
  } catch {
    return Object.prototype.toString.call(entry);
  }
}
