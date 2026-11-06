import type { CloudFormationTemplate } from '../../../types/resource.js';
import { producerCoordinateKey } from '../../../state/malformed-resources-bag.js';

/**
 * How confidently the producer's TEMPLATE says its export is secret-bearing
 * (issue #2133 review).
 *
 * - `declared` — an output matched `key` by name or by literal `Export.Name`,
 *   and ITS declared `Value` carries a `{{resolve:` expression.
 * - `widened` — NO output matched `key`, so the test fell back to scanning
 *   every output of the producer, and one of them carries a `{{resolve:`
 *   expression or RE-EXPORTS a value some stack up the chain declares from one.
 *   The key is secret-bearing only by over-approximation, which the refusal
 *   message must not overstate. `via` is populated when the evidence came from
 *   up the chain, for the reason the `chained` entry gives — WITHOUT it the
 *   message claimed the producer "publishes at least one output from a
 *   `{{resolve:...}}` expression" when the walk had just established that none
 *   of them does, and the remedy degraded to the single `cdkd scrub <producer>`
 *   that sends the user into a second refusal.
 * - `chained` — no output of the producer carries a `{{resolve:` expression
 *   itself, but a matched output RE-EXPORTS an import whose own producer (or
 *   one further up the chain) declares one (issue
 *   [#2146](https://github.com/go-to-k/cdkd/issues/2146)). `via` names the
 *   stacks the walk crossed, nearest first, ending at the one whose template
 *   carries the literal expression.
 * - `no` — neither the producer's outputs nor anything reachable from them by
 *   re-export carries a `{{resolve:` expression.
 */
export interface SecretExpressionVerdict {
  kind: 'declared' | 'widened' | 'chained' | 'no';
  /**
   * The stacks the evidence was followed THROUGH, nearest producer first, the
   * stack that declares the expression last. Populated for `chained` and for a
   * `widened` verdict whose evidence came from up the chain; EMPTY otherwise,
   * so the refusal message can never name a chain the walk did not cross.
   */
  via: readonly string[];
}

/** The `no` verdict, shared so the walk allocates nothing for the common case. */
const NO_SECRET_EXPRESSION: SecretExpressionVerdict = { kind: 'no', via: [] };

/**
 * Can the producer's STORED value be a legacy plaintext secret at all (issue
 * #2133 review)?
 *
 * `false` for a value that carries no text: `null` / `undefined`, the empty
 * string, and every non-string scalar. A resolved `{{resolve:...}}` reference
 * is always a STRING — `resolveDynamicReferences` substitutes text — so a
 * number or a boolean cannot be one, and an empty string holds nothing to
 * redact. Without this, `carriesDynamicReference` being false for those shapes
 * made a `widened` verdict refuse the consumer over a value with nothing behind
 * it, in a refusal that no re-run could clear (scrubbing the producer cannot
 * turn an empty value into an expression).
 *
 * Containers are NOT included: an array or object can nest a plaintext string,
 * and `carriesDynamicReference` already walks them, so the classification for
 * those is left exactly as it was.
 */
export function storedValueCarriesNoPlaintext(stored: unknown): boolean {
  if (stored === null || stored === undefined) return true;
  if (typeof stored === 'string') return stored === '';
  return typeof stored !== 'object';
}

/**
 * Is `key` an export the producer's TEMPLATE declares from a `{{resolve:...}}`
 * expression (issue #2133 review)?
 *
 * This is HALF the discriminator, and the half the direct state read below
 * cannot supply. From the consumer's side, "the producer stored a plaintext
 * SECRET" and "the producer stored an ordinary non-secret value" are
 * indistinguishable — a bucket name and a leaked password are both bare
 * strings — so a refusal keyed on the producer's STORED value alone would fire
 * on every multi-stack app that imports anything at all. An export whose
 * declared `Value` contains no `{{resolve:` anywhere cannot be secret-bearing,
 * so its plaintext is nothing to redact.
 *
 * What it deliberately does NOT answer is whether the producer's own STATE has
 * been scrubbed down to that expression yet, which is the other half and the
 * one the three earlier cuts of this file each got wrong. See the discriminator
 * in {@link makeCrossStackPrePass}.
 *
 * `key` is the state.outputs KEY the read matched, which the deploy engine
 * writes under BOTH the output name and the literal `Export.Name` — hence both
 * are matched. When no output matches (an INTRINSIC `Export.Name`, which scrub
 * cannot reproduce from here) the test widens to every output of the producer,
 * which over-approximates in the SAFE direction: it can refuse a stack that
 * imports a non-secret export from a producer that has some other secret
 * output, and it never lets a secret-bearing one through. The widening is
 * REPORTED rather than folded into a boolean, because the refusal message
 * asserts what the producer declares and only the `declared` verdict has
 * checked that for THIS key.
 *
 * RE-EXPORT CHAINS ARE FOLLOWED (issue
 * [#2146](https://github.com/go-to-k/cdkd/issues/2146)). A MIDDLE stack whose
 * output is `{"Fn::ImportValue": "<upstream export>"}` declares no literal
 * `{{resolve:` of its own, so the single-template test returned `no` for it and
 * the consumer at the END of the chain was reported CLEAN over its surviving
 * plaintext — the #2133 silent success, reached through a re-export instead of
 * a direct import. (`cdkd scrub --all` masks it: `orderScrubTargets` scrubs
 * producers first, so the middle stack stores the expression by the time the
 * consumer is reached. `cdkd scrub <one stack>` does not.) This walk therefore
 * follows a matched output's `Fn::ImportValue` (through the export-name index)
 * and its `Fn::GetStackOutput` (through the literal `StackName` / `OutputName`)
 * into the next producer's template, and keeps going until it finds an
 * expression or runs out of reachable outputs.
 *
 * TERMINATION IS A VISITED SET over `(stack, key)` pairs, NOT a hop cap. Each
 * pair expands deterministically, so a second visit can never yield evidence
 * the first did not, and the pair space is finite (stacks x outputs) — so the
 * walk halts on a CYCLE (two stacks re-exporting each other; no deploy can
 * produce one, a template can express one) while losing no reach. A depth cap
 * was rejected because it is lossy in the one direction that matters: a chain
 * longer than the cap would return `no`, which is exactly the silent success
 * this walk exists to kill.
 *
 * WIDENING IS ROOT-ONLY, and that means WHERE THE FALLBACK FIRES, not what a
 * widened subject may expand into. The all-outputs fallback fires for the DIRECT
 * producer alone, where the key came from a read and may match nothing because
 * the producer's `Export.Name` is an intrinsic scrub cannot reproduce. One hop
 * up the key is a LITERAL export / output name read out of a template, so a miss
 * there means that template genuinely does not declare it, and widening THERE
 * would refuse the consumer over an unrelated secret two stacks away that no
 * scrub could ever clear.
 *
 * A widened root's subjects DO still expand into hops, deliberately, and the
 * trade is stated rather than hidden (issue #2146 review — an earlier revision
 * of this comment read as if they did not, which contradicted the code). Not
 * expanding them would make an intrinsic-`Export.Name` producer that re-exports
 * a secret undetectable — the exact silent success this walk exists to kill,
 * reintroduced for the one population the widening exists for. Expanding them
 * extends #2133's accepted over-approximation ("it can refuse a stack that
 * imports a non-secret export from a producer that has some other secret
 * output") by one hop, in the direction that repo rule calls safe; and the
 * refusal it produces now names the head of the chain and the order to scrub it
 * in, so it is at least as actionable as the root widening it extends.
 *
 * Residuals, stated rather than hidden. Each keeps the pre-#2133 outcome for
 * that one reference — a possible false CLEAN, never a refusal:
 * - a producer that publishes a secret with NO literal `{{resolve:` and no
 *   followable re-export: one reading it through `Ref` to a parameter, or
 *   re-exporting an export whose producer is outside this app (whose template
 *   scrub never sees), and a producer outside this app at all;
 * - a NON-LITERAL `Fn::ImportValue` argument (an `Fn::Sub`-assembled export
 *   name) and a NON-LITERAL or foreign `Fn::GetStackOutput` `StackName` /
 *   `OutputName`: the hop cannot be resolved statically, and guessing one would
 *   refuse over a reference the walk never established;
 * - a `Fn::GetStackOutput` naming a stack of this app in ANOTHER REGION:
 *   {@link buildExportOwnerIndex} and `producerTemplates` are keyed by stack
 *   NAME alone, so the walk reads that name's template regardless of `Region`;
 * - a secret reachable only through the TRUE branch of an `Fn::If` in a
 *   producer's output: see {@link selectTakenConditionalBranches}, which takes
 *   the FALSE branch for a condition it cannot evaluate -- and which, since
 *   issue [#2150](https://github.com/go-to-k/cdkd/issues/2150), feeds BOTH the
 *   literal scan below and {@link collectReExportHops} from that one
 *   selection.
 */
export function producerPublishesSecretExpression(
  templates: ReadonlyMap<string, CloudFormationTemplate>,
  exportOwners: ReadonlyMap<string, readonly string[]>,
  producerStack: string,
  key: string
): SecretExpressionVerdict {
  interface Frame {
    stack: string;
    key: string;
    /** Stacks crossed to reach this frame, nearest first. Empty at the root. */
    via: readonly string[];
  }
  const seen = new Set<string>([producerCoordinateKey(producerStack, key)]);
  const queue: Frame[] = [{ stack: producerStack, key, via: [] }];
  // Set by the ROOT frame only (BFS visits it first), and read by every later
  // frame: a widened root can only ever justify the widened claim, however
  // precise the hop that finally found the expression was.
  let widened = false;
  while (queue.length > 0) {
    const frame = queue.shift();
    if (!frame) break;
    const template = templates.get(frame.stack);
    if (!template) continue;
    const outputs = (template.Outputs ?? {}) as Record<
      string,
      { Value?: unknown; Export?: { Name?: unknown } }
    >;
    const matched: unknown[] = [];
    for (const [name, output] of Object.entries(outputs)) {
      const exportName = output?.Export?.Name;
      if (name === frame.key || (typeof exportName === 'string' && exportName === frame.key)) {
        matched.push(output?.Value);
      }
    }
    const isRoot = frame.via.length === 0;
    let subjects: unknown[];
    if (matched.length > 0) {
      subjects = matched;
    } else if (isRoot) {
      widened = true;
      subjects = Object.values(outputs).map((o) => o?.Value);
    } else {
      // A hop that matched nothing: see WIDENING IS ROOT-ONLY above.
      continue;
    }
    for (const rawSubject of subjects) {
      // THE ONE SELECTION SITE (issue #2150), feeding BOTH halves of the
      // question below — the literal scan and the hop walk. See
      // {@link selectTakenConditionalBranches} for why an `Fn::If`'s untaken arm
      // must not answer either, and for the residual that accepts.
      const subject = selectTakenConditionalBranches(rawSubject);
      if (JSON.stringify(subject ?? null).includes('{{resolve:')) {
        // `via` is carried on the WIDENED verdict too (issue #2146 review).
        // Dropping it made the message assert the producer "publishes at least
        // one output from a {{resolve:...}} expression" in the one case the
        // walk had just proven otherwise, and cut the remedy back to the single
        // command the chain remedy exists to replace.
        if (widened) return { kind: 'widened', via: frame.via };
        return isRoot ? { kind: 'declared', via: [] } : { kind: 'chained', via: frame.via };
      }
      for (const hop of collectReExportHops(subject, templates, exportOwners)) {
        const id = producerCoordinateKey(hop.stack, hop.key);
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push({ stack: hop.stack, key: hop.key, via: [...frame.via, hop.stack] });
      }
    }
  }
  return NO_SECRET_EXPRESSION;
}

/**
 * One node with every `Fn::If` collapsed to the branch scrub would TAKE
 * (issues #2146 and [#2150](https://github.com/go-to-k/cdkd/issues/2150)).
 *
 * ONE SPELLING, consumed verbatim by both halves of "does this producer publish
 * a secret expression?" — {@link collectReExportHops}, which follows the value
 * onward, and {@link producerPublishesSecretExpression}'s literal
 * `{{resolve:` scan, which tests the value itself. Those two are one question
 * asked twice, and they DISAGREED between #2146 and #2150: the hop walk took
 * the false branch while the scan `JSON.stringify`d the whole node and saw
 * both. A producer whose output is
 * `{"Fn::If": ["IsProd", "{{resolve:...}}", "plain"]}` deployed with `IsProd`
 * false therefore verdicted `declared`, the discriminator read the deployed
 * value `plain`, and scrub refused with `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`
 * — an UNCLEARABLE refusal, because no `cdkd scrub` of the producer can turn
 * `plain` into an expression and there is no bypass flag, so every other secret
 * in the consumer stack was stranded. A second spelling of the selection would
 * only move where the two can drift apart again, so there is exactly one.
 *
 * WHICH BRANCH: the FALSE one, unconditionally, mirroring `resolveIf`'s
 * unknown-condition arm. Every condition met on this path belongs to ANOTHER
 * stack, and scrub evaluates conditions only for the stack it is scrubbing,
 * from that template's parameter DEFAULTS (it takes no `--parameters`), so a
 * producer's condition is not evaluable here.
 *
 * TWO SHAPES COLLAPSE MORE THAN THE SELECTED BRANCH, both fail-OPEN, both
 * stated rather than implied because the old whole-node `JSON.stringify` saw
 * them and this does not. Neither is CloudFormation-emittable, which is why
 * they are accepted rather than fixed:
 *
 * - a MALFORMED `Fn::If` (args not a 3-tuple) collapses to `null` -- NO branch.
 *   Which branch is live is unknowable, so neither a hop nor a `{{resolve:`
 *   sighting may be claimed from it. CloudFormation refuses such a template, so
 *   a producer that reads this way cannot have been deployed carrying one.
 * - an object carrying `Fn::If` ALONGSIDE sibling keys keeps only the selected
 *   branch, so a `{{resolve:` under a sibling is not seen. An intrinsic node has
 *   exactly one key in any template CloudFormation accepts, and the hop walk
 *   dropped those siblings before this function existed (its `Fn::If` arm
 *   `return`ed rather than falling through), so this preserves that behaviour
 *   rather than introducing it.
 *
 * Residual, and it is the direction this file accepts elsewhere: a secret
 * reachable only through the TRUE branch is not detected, so that reference
 * keeps its pre-#2133 outcome. The hop walk already took this trade for the
 * chain it follows; #2150 extends it to the scan so that the two agree.
 */
function selectTakenConditionalBranches(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(selectTakenConditionalBranches);
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  if ('Fn::If' in obj) {
    const args = obj['Fn::If'];
    return Array.isArray(args) && args.length === 3
      ? selectTakenConditionalBranches(args[2])
      : null;
  }
  // `Object.create(null)`, the same `__proto__` hazard `pinCrossRegionSecrets`,
  // `redactByPath` and `reresolveCrossStackValue` answer this way: a JSON-parsed
  // template can carry an OWN `__proto__` key, and assigning it onto an object
  // LITERAL walks the prototype setter instead of defining the key -- so the
  // key, and any `{{resolve:` under it, would vanish from the pruned copy and
  // both consumers would go blind on that subtree. Fail-OPEN, which is the
  // direction that matters: the verdict comes back `no` and the producer looks
  // plaintext-free.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) out[key] = selectTakenConditionalBranches(child);
  return out;
}

/** One step of a re-export chain: whose template to read next, under which key. */
interface ReExportHop {
  stack: string;
  key: string;
}

/**
 * The re-export hops one output VALUE carries (issue #2146).
 *
 * Only STATICALLY resolvable references produce a hop, mirroring
 * {@link inferCrossStackStackDeps}: an `Fn::ImportValue` of a literal export
 * name (looked up in `exportOwners`) and an `Fn::GetStackOutput` whose
 * `StackName` and `OutputName` are both literal strings and whose stack is one
 * of this app's. An assembled name resolves to a hop the walk cannot follow,
 * which keeps the pre-#2146 outcome for that value rather than guessing.
 *
 * EVERY owner of a duplicated export name is returned, not the first (issue
 * #2146 review). See {@link buildExportOwnerIndex}: picking one silently
 * decides the verdict on insertion order, and the visited set makes following
 * all of them cheap and terminating.
 *
 * The WHOLE node is walked, not just its top level, because a re-export is
 * routinely wrapped — `Fn::Join`ing an imported password into a URL is the
 * shape the live fixture uses.
 *
 * `Fn::If` NEVER REACHES THIS WALK, and the selection that used to live here
 * is load-bearing rather than tidy (issue #2146 review). `makeCrossStackPrePass`
 * deliberately mirrors
 * `resolveIf` — selected branch only — so that a conditional import of a
 * not-yet-deployed producer cannot refuse a whole stack, unbypassably, over a
 * reference the deploy never read. A hop walk that descended into both arms
 * broke that mirror and produced something worse: a producer whose output is
 * `{"Fn::If": ["IsProd", {"Fn::ImportValue": "ProdSecret"}, {"Fn::ImportValue":
 * "DevPlain"}]}`, deployed in dev with a benign stored value, yielded a
 * `chained` verdict and a refusal NO `cdkd scrub` can clear — nothing can turn
 * that producer's non-secret value into an expression, and there is no bypass
 * flag. On main the same input answered `no`, so it would have been a
 * regression this change introduced.
 *
 * `selectedValue` IS THE CONTRACT, and it is why this function carries no
 * `Fn::If` handling of its own: the only caller,
 * {@link producerPublishesSecretExpression}, applies
 * {@link selectTakenConditionalBranches} ONCE and hands the result to BOTH the
 * literal `{{resolve:` scan and this walk, so a node reaching here holds no
 * `Fn::If` at all. Issue [#2150](https://github.com/go-to-k/cdkd/issues/2150)
 * collapsed the two to one site deliberately: the scan used to `JSON.stringify`
 * the whole subject and therefore see BOTH arms while this walk took only the
 * false one, and two spellings of one question are exactly how they came to
 * disagree. A second selection HERE would restore that, and be worse than
 * useless — measured on the #2150 lane, a per-site copy was invisible to every
 * test in the suite, because the caller had already pruned, so deleting it
 * changed nothing and no probe could fence it.
 * {@link selectTakenConditionalBranches}'s own doc carries which branch is
 * selected, what a malformed `Fn::If` yields, and the TRUE-branch residual both
 * halves accept.
 */
function collectReExportHops(
  selectedValue: unknown,
  templates: ReadonlyMap<string, CloudFormationTemplate>,
  exportOwners: ReadonlyMap<string, readonly string[]>
): ReExportHop[] {
  const hops: ReExportHop[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const imported = obj['Fn::ImportValue'];
    if (typeof imported === 'string') {
      for (const owner of exportOwners.get(imported) ?? []) {
        hops.push({ stack: owner, key: imported });
      }
    }
    const read = obj['Fn::GetStackOutput'];
    if (read !== null && typeof read === 'object' && !Array.isArray(read)) {
      const args = read as Record<string, unknown>;
      const stack = args['StackName'];
      const outputName = args['OutputName'];
      if (typeof stack === 'string' && typeof outputName === 'string' && templates.has(stack)) {
        hops.push({ stack, key: outputName });
      }
    }
    for (const child of Object.values(obj)) walk(child);
  };
  walk(selectedValue);
  return hops;
}

/**
 * `Export.Name` -> EVERY app stack that declares it (issue #2146), for literal
 * export names only. Built ONCE per stack scrub rather than per reference,
 * since {@link producerPublishesSecretExpression} needs it on every cross-stack
 * read the pre-pass performs.
 *
 * ALL OWNERS, not the first (issue #2146 review). `inferCrossStackStackDeps`
 * keeps one because it is choosing a deploy EDGE and either choice orders the
 * graph; this index decides whether a value is SECRET-BEARING, where following
 * the wrong twin returns `no` and reports a stack clean over surviving
 * plaintext. Two stacks declaring one export name is an AWS-side error, but
 * scrub reads TEMPLATES — an app that has never been deployed, or one deployed
 * to two regions, presents it routinely — so there IS a better answer than the
 * first writer: take the over-approximation and follow both. The visited set
 * bounds the cost and guarantees termination either way.
 *
 * Keyed by stack NAME with no region, which is the residual
 * {@link producerPublishesSecretExpression} lists: an `Fn::GetStackOutput`
 * naming this app's stack in another region reads the template of the name,
 * since `producerTemplates` has no region either.
 */
export function buildExportOwnerIndex(
  templates: ReadonlyMap<string, CloudFormationTemplate>
): ReadonlyMap<string, readonly string[]> {
  const owners = new Map<string, string[]>();
  for (const [stackName, template] of templates) {
    const outputs = (template.Outputs ?? {}) as Record<string, { Export?: { Name?: unknown } }>;
    for (const output of Object.values(outputs)) {
      const name = output?.Export?.Name;
      if (typeof name !== 'string' || name === '') continue;
      const existing = owners.get(name);
      if (existing) {
        if (!existing.includes(stackName)) existing.push(stackName);
      } else {
        owners.set(name, [stackName]);
      }
    }
  }
  return owners;
}
