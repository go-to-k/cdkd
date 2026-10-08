import {
  type RecordedSecretValues,
  markSameGenerationBag,
  resolvedPlaintextOf,
  substitutedSpellingOf,
} from './pairs.js';
import {
  type CrossStackAssociations,
  storeAssociation,
  crossStackAssociations,
  crossStackSourceKey,
} from './cross-stack.js';
import {
  type PathSourceRules,
  TEMPLATE_DERIVED_RULES,
  isPlainObject,
  isSingleDynamicReferenceToken,
  MIN_NEEDLE_LENGTH,
} from './rules.js';
import { redactSecretsForState } from './redact-state.js';
import {
  plaintextIndexOf,
  certifiedListForLeaf,
  certifiedExpressionForLeaf,
} from './certified-positions.js';
import {
  intrinsicSkeletonSegments,
  UNKNOWN_PART,
  UNKNOWN_PART_PLACEHOLDER,
  singleSpanFrame,
  rendersLiteralTo,
  renderedTokenOf,
} from './positions.js';
import { dynamicReferenceSpans, deepEqualJsonValue } from './redact-path.js';
import { SPELLED_SECRET_REFERENCE_PREFIXES } from './anchors.js';
import { wholeStringLeavesOf } from './mask-only.js';
import { substringNeedlesOf } from './fresh-noecho.js';

/**
 * The `AWS::CloudFormation::Stack` type string, named once because the recorder
 * below gates on it and the tests assert against the same population.
 *
 * DUPLICATED, deliberately: `intrinsic-resolver/context.ts` declares the same
 * literal under the same name (for the `Outputs.<Name>` re-resolution of issue
 * #2055). This family is a LEAF by design -- see the header of
 * `secret-redaction.ts`, it imports nothing outside `secret-redaction/`,
 * because both the resolver and the deploy engine consume it -- so
 * importing that spelling would close a cycle, and exporting this one for the
 * resolver to import would make the leaf a source of values rather than of
 * pure functions. The two cannot drift into DISAGREEMENT in any way that
 * matters: an AWS resource type string is fixed by AWS, and a typo in either
 * copy makes that copy's gate simply never fire (no-op), never fire wrongly.
 */
const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';

/**
 * What a PARENT stack's resolution proved about each `Parameters` entry of an
 * `AWS::CloudFormation::Stack` row it is about to provision, keyed by the
 * child's PARAMETER NAME (issue
 * [#2291](https://github.com/go-to-k/cdkd/issues/2291)).
 *
 * WHY A THIRD STORE, when {@link crossStackAssociations} already holds
 * per-leaf associations. This one is OUTBOUND: it is written against the
 * PARENT's bag and describes leaves of the CHILD's template, so it has to be
 * transported across the engine boundary before any reader can use it. The
 * child's per-resource bag then receives those entries as ORDINARY
 * {@link crossStackAssociations} rows (see
 * {@link inheritNestedStackParameterAssociations}), which is what lets the
 * existing three-condition reader answer for them with no new arm.
 *
 * KEEPING THE TWO TABLES SEPARATE IS LOAD-BEARING, not tidiness. A child engine
 * that itself owns a grandchild `AWS::CloudFormation::Stack` row records the
 * GRANDCHILD's parameter names against the CHILD's bag — the same bag that
 * already carries the child's own INBOUND `Ref` associations. Writing both into
 * one table means a grandchild parameter sharing a NAME with a child parameter
 * poisons the child's entry (two expressions under one key), so a leaf that was
 * being certified correctly falls back to the value scan the moment a
 * same-named parameter appears one level down. Two tables make the collision
 * impossible rather than unlikely.
 *
 * A `WeakMap` keyed by the parent pass's own bag, for the reason
 * {@link crossStackAssociations} gives: the entries hold PLAINTEXT, and they
 * must not outlive the pass that fetched them.
 */
const nestedStackParameterExpressions = new WeakMap<RecordedSecretValues, CrossStackAssociations>();

/**
 * The parent's LITERAL spelling of each `Parameters` entry whose resolved value
 * EMBEDS its tokens -- `postgres://{{U}}:{{A}}@host` -- keyed by the pass's bag,
 * then by the child's parameter name (issue
 * [#4644](https://github.com/go-to-k/cdkd/issues/4644)).
 *
 * A separate table from {@link nestedStackParameterExpressions} because its
 * reader asks a different question: that table certifies a value that IS a
 * recorded plaintext (or the sub-floor carry's entry), this one a value that
 * merely CONTAINS plaintexts, by re-rendering the spelling
 * ({@link rendersLiteralTo}). It is never inherited into the child's
 * {@link crossStackAssociations}, whose readers require a whole plaintext; it is
 * read only through {@link renderedParameterSpelling}: by
 * {@link inheritedParameterExpression} (the diff side, a `{Ref}` leaf, the
 * carry) and by {@link inheritedRenderedSpan} (a child leaf EMBEDDING the
 * parameter, which the diff side renders from that same binding). A name
 * recorded twice against a different entry is POISONED rather than
 * overwritten.
 */
const renderedParameterSpellings = new WeakMap<
  RecordedSecretValues,
  Map<string, { readonly spelling: string; readonly value: string } | null>
>();

/**
 * Condition (iv)'s key (see {@link recordNestedStackParameterExpressions}) for
 * a `Parameters` spelling that is not a single-span literal frame of its
 * resolved value carrying this pass's pair for its token: an object source, a
 * plain literal, a two-span literal, a bag equal to its source, and a frame
 * whose token this pass never resolved to the middle (a PUBLIC sibling).
 */
const UNFRAMED_SPELLING: unique symbol = Symbol('cdkd.nested-parameter.unframed-spelling');

/**
 * Record, for the pass that owns `secrets`, which `{{resolve:...}}` expression
 * each `Parameters` entry of a nested-stack row was resolved FROM (issue
 * #2291). No-op for every other resource type.
 *
 * THE EXPRESSIONS COME FROM THE POSITION PASS, not from `secrets`, and that is
 * the whole reason this works at all. `RecordedSecretValues` is keyed by
 * PLAINTEXT, so two parameters resolving to one value have already collapsed to
 * a single entry there by the time this runs — asking the map which expression
 * a given parameter came from returns the SURVIVOR for both. What has not
 * collapsed is the parent's own template: `Properties.Parameters.<Name>` still
 * holds each entry's own source leaf. So this walks the parent's resolved
 * parameter bag against that source with {@link redactSecretsForState}, which
 * is exactly the machinery the parent's persist path already uses and which
 * certifies PER LEAF (measured on this issue: the parent's own two properties
 * come out correct while the child's collapse onto one). Deriving the answer
 * from the positioner rather than restating its rules is what keeps this from
 * drifting away from the persist path.
 *
 * THE `rules` PARAMETER IS THE CALLER'S GENERATION CLAIM, not a knob. The
 * DEPLOY path passes {@link TEMPLATE_DERIVED_RULES} (the default): its source is
 * the parent's TEMPLATE, which can carry a PUBLIC `ssm:` reference that must
 * stay resolved (issue #1901) and which cannot certify the generation of
 * anything. The rollback REPLAY passes {@link STATE_DERIVED_RULES}, because its
 * source is the JOURNAL record — a persisted bag holding no public expressions,
 * and the same generation the bag was resolved from one statement earlier. That
 * is the identical pairing `redactRollbackRecord` already makes for the record
 * it positions, so the two replay walks now agree about what their source is.
 * Since issue #3090 the `trustAnyExpression` half of that claim no longer
 * changes what THIS recorder writes for a reference the pass resolved:
 * refusal 5 asks the pair table under both rule sets, and a resolved unpinned
 * `ssm` reference has a pair (only its pin is withheld), so either ruleset
 * positions it through the span arm's empty frame. What the constants still
 * decide here is `sourceIsSameGeneration`, which a token-shaped plaintext
 * reaches (fenced by the replay call sites' own file).
 *
 * "No public expressions" carries the carve-out {@link PathSourceRules} states
 * and this note must not restate without it: `cdkd import` warns and persists
 * the RAW template intrinsic, so a public `ssm:` token CAN sit in a record. The
 * replay's POSITION pass then certifies one the deploy default would refuse;
 * since issue #3090 refusal 5 refuses to RECORD it under either ruleset (a
 * token resolved as public is never paired), so the child's leaf falls to the
 * value scan. Before that the cost was bounded to the issue #1901 class — a
 * spurious UPDATE over a value state should hold resolved, never a
 * disclosure, since an expression is what gets persisted either way. See the
 * replay call sites for why gating on {@link isKnownSecretExpression} is the
 * wrong way to close it.
 *
 * FIVE REFUSALS, each degrading to today's behaviour (the child leaf falls to
 * the plaintext-keyed value scan); the fifth is stated at its line:
 *
 * 1. REFUSAL — the resolved parameter value is not a WHOLE recorded plaintext.
 *    A parameter the parent built with an `Fn::Sub` merely EMBEDS the secret,
 *    so there is no single expression the child's leaf could be persisted as.
 *    It also bounds what this store HOLDS: an entry carries a plaintext, and
 *    remembering one this pass never resolved has no purpose.
 * 2. REFUSAL — the expression is not a single complete `{{resolve:...}}` token.
 *    The same test {@link recordCrossStackExpression} applies at its own
 *    boundary, spelled here because this writer populates a DIFFERENT table.
 *    This is what rejects an embedded case that survived refusal 1 (a value
 *    scan produced `postgres://u:{{resolve:...}}@host`, which is not a token).
 * 3. REFUSAL — the expression may never EQUAL the plaintext it is recorded
 *    against. The reader returns the expression to be PERSISTED, so an entry
 *    whose two halves coincide hands a SECRET back as though it were a
 *    reference.
 *
 *    THIS IS REACHABLE, and an earlier revision of this note called it an
 *    unreachable invariant and told the next reader not to try to fence it.
 *    That was wrong twice over: wrong on the fact, and wrong to assert it,
 *    because {@link plaintextIndexOf}'s own note records the rule that
 *    "asserting something cannot be fenced suppresses the attempt, so it needs
 *    the same evidence a fence does" -- and no such evidence existed. The
 *    reaching shape is the issue
 *    [#1917](https://github.com/go-to-k/cdkd/issues/1917) family: a
 *    SELF-REFERENTIAL secret, whose stored VALUE is byte-identical to its own
 *    `{{resolve:...}}` text, so the pass records `SELF -> SELF`. The route is
 *    NOT the value scan the old note named. It is {@link redactByPath}'s
 *    `!sourceIsSameGeneration && isSingleDynamicReferenceToken(bag)` arm, which
 *    returns `secrets.get(bag) ?? bag` -- and for a self-referential secret
 *    that IS the bag. Under {@link STATE_DERIVED_RULES} the same input arrives
 *    by the other door (`sourceIsSameGeneration` is true, so the arm takes
 *    `return source`, which is the same string again), so both callers reach it.
 *    Fenced by the self-referential case in
 *    `secret-redaction-nested-parameter-source.test.ts`.
 *
 * THE SUB-FLOOR CARRY (issue #2745, its nested-stack site). A parameter the
 * parent spelled as a LITERAL frame around one token -- `Pin:
 * 'port:{{resolve:secretsmanager:S:SecretString:pin::}}'` -- resolves to
 * `port:q7`: not a key of the map (refusal 1), with a middle below
 * `MIN_NEEDLE_LENGTH`, so the child's carry (`inheritedSecretsCarriedBy`:
 * whole value at any length, substring at or above the floor) misses it both
 * ways and the child persisted `port:q7`. This recorder is the only point
 * holding the literal frame beside the pair, so the carry is written HERE:
 * the position pass runs over a MARKED shallow copy, on which
 * {@link positionByEmbeddedSpan} writes the frame on pair evidence, and a
 * second walk records `resolvedValue -> sourceLeaf`
 * (`'port:q7' -> 'port:{{resolve:...}}'`) as an ordinary WHOLE-VALUE entry of
 * the parent's own bag, under five conditions:
 *
 *   (i)   The pass CERTIFIED the leaf, and the certified SPELLING is what
 *         every later condition reads. On a LITERAL source it is the source:
 *         the span arm returns the source verbatim, so `positioned[name] ===
 *         sourceLeaf` proves it fired -- refusal 2b's test, applied to a
 *         literal source; pinned by the "map NO RESOLVER populated" case,
 *         where (ii) and (iii) both pass and only the missing pair refuses.
 *         On an OBJECT source (`Fn::Join` / `Fn::Sub`, issue #3062) there is
 *         no source text to compare, so the spelling-based arm takes what
 *         the pass WROTE, admitted only when `positioned[name] !==
 *         resolvedValue`. Sound
 *         together with (ii), not alone: on a value the scan is silent on,
 *         the cross-stack and skeleton arms both refuse (each requires the
 *         WHOLE leaf to be a key of the map, which would make the scan's
 *         whole-value arm fire), the list arm needs an array, and the value
 *         scan leaves the leaf alone -- so the frame arm is the only writer
 *         that can have rewritten it, on its pair and the engine's mark. A
 *         frame that is not wholly literal makes that arm refuse, the leaf
 *         comes back unrewritten, and this arm refuses too. It certifies
 *         only a source whose OWN rendered token starts with a
 *         spelled-secret prefix (`secretsmanager:` / `ssm-secure:`), read from
 *         the source and never from what the pass wrote: the frame arm
 *         matches among RECORDED references and a public `ssm` parameter
 *         records none, so a public leaf whose source spells `ssm:`, or leaves
 *         the service to an intrinsic part, can match a recorded secret
 *         sibling and be written as the sibling's reference. Where it refuses,
 *         the PROVENANCE arm (issue #3156) certifies on the leaf's own
 *         resolution instead: the resolver records, per `Fn::Join` /
 *         `Fn::Sub` object and pass bag, every token it replaced with the
 *         verdict that replacement took, and one SECRET replacement that turns
 *         the record's input into the value certifies that input as the
 *         spelling -- an `ssm:` or intrinsic-service token, and a frame whose
 *         non-literal part sits OUTSIDE the token, which the frame arm never
 *         writes. `frameSpellingOf` states what it proves and what it does
 *         not. The STATE-derived
 *         call sites reach this arm as well: `cdkd import` can leave raw
 *         intrinsics in a record's `properties`, which a rollback replay
 *         passes as its source, and the frame arm does not read `rules`.
 *   (ii)  `redactSecretsForState(resolvedValue, secrets) === resolvedValue`
 *         -- the value scan is SILENT on it: the sub-floor gate, byte-for-byte
 *         the bound the span arm accepted. What it refuses is a middle at or
 *         above the floor, whose substring carry the child already has (the
 *         only refusal a test can see: the others coincide with (i) or with
 *         the map's own entry, as a whole-token source's would).
 *   (iii) `secrets.get(middle) === token` -- the token IS the map's survivor
 *         for the middle -- OR every framed spelling of the value in the row
 *         carries this token (issue #3079). Load-bearing: two framed
 *         parameters over ONE middle (`pin::` and `pin:AWSCURRENT:`) keep
 *         their own tokens on this row's record today because each reaches
 *         the span arm with the scan silent; once a `'port:q7'` entry exists
 *         the scan answers for the whole leaf and the arm's bound (`scanned
 *         === prefix + survivor + suffix`) decides. With the survivor's
 *         frame as the entry every same-frame leaf passes the bound and
 *         writes its own token; with a loser's, a same-frame sibling around
 *         another token would fail it and take the loser's frame -- so a
 *         loser's frame is the entry only when no such sibling exists, and
 *         then its own leaf reads the entry from the value scan after the
 *         bound refuses, which is its frame. Either way every parent leaf
 *         keeps its own token by construction rather than by recording
 *         order.
 *   (iv)  ONE FRAME per VALUE, across the whole row. Once the entry exists
 *         the scan is no longer silent on the value, so on the parent's
 *         record every leaf holding it answers against the entry through the
 *         span arm's bound (`scanned === prefix + survivor + suffix`). The
 *         SAME frame around another token -- the (iii) shape, `port:` + A
 *         beside `port:` + B -- passes that bound and keeps its own token. A
 *         DIFFERENT frame (`port:` + `q7` beside `port` + `:q7`, each passing
 *         (i)-(iii) on its own), a leaf (iii) refused under a different
 *         frame, an object spelling the frame arm refused and a plain
 *         literal equal to the value all fail it and would take the entry's
 *         frame (an object spelling (i) certified is a frame like a literal
 *         one, issues #3062 and #3156; one it refused counts as unframed) --
 *         and so would a
 *         same-frame sibling whose token this pass never resolved to the
 *         middle: a PUBLIC `ssm` reference in the same `port:` frame holding
 *         the same two characters is kept RESOLVED on the record, and the
 *         entry would rewrite it to the secret sibling's expression. So the
 *         frames (prefix + suffix) of every spelling of every string value in
 *         the row are gathered BEFORE the conditions run, a spelling that is
 *         not a single-span literal frame with this pass's pair for its token
 *         (`resolvedPlaintextOf`) counting as its own, and a value is
 *         recorded only when its certified frame is the row's only one. A
 *         value one of whose leaves the position pass did NOT write (the
 *         provenance arm's outside-the-token frame) also counts as unframed
 *         unless every framed spelling of it carries ONE token: the frame arm
 *         refuses that leaf on the parent's record, so the entry is written
 *         onto it by the value scan whatever its token, and (iii)'s rescue
 *         for a same-frame sibling does not reach it.
 *   (v)   No OTHER string leaf of the ROW would be rewritten by the entry,
 *         read over every leaf of the resolved row since the bag is per
 *         resource, not per `Parameters`. Two arms of the persist walk read
 *         a map entry. The WHOLE-VALUE arm is floorless, so a leaf EQUAL to
 *         the value OUTSIDE `Parameters` (a `TemplateURL` that happens to
 *         equal it has no frame of its own and escapes (iv)) or inside a
 *         LIST-valued sibling parameter (an array here; `extractParameters`
 *         joins it back for the wire) refuses at any length; equality
 *         between string parameters is (iv)'s frame identity. The SUBSTRING
 *         arm is reached only by a value at or above `MIN_NEEDLE_LENGTH`
 *         (`port:q7` clears the floor its bare middle sits under), so a
 *         sibling merely CONTAINING the value -- `x-port` + `:q7` from
 *         another token, a plain literal `literal-port:q7-end` -- refuses
 *         only then, or it would be spliced with this frame on the parent's
 *         record, exactly the #2087 splice the child side is scoped against;
 *         a 3-character `pq7` beside such a sibling is carried, since no
 *         needle exists for it.
 *
 * Written AFTER the walk, so no iteration reads the recorder's own write --
 * a statement of intent rather than a pinned behaviour: under (iv) and (v)
 * an in-loop write is EQUIVALENT (a later value the entry would rewrite is
 * refused by (v), an equal one by (iv) or as the same entry), so no test can
 * red on the order, and it is kept so (ii)'s reading of the map cannot come
 * to depend on iteration order. No pair and no pin are recorded for the
 * entry: it is not a token
 * ({@link recordedExpressionsOf} names the class), and no consumer needs one
 * -- the child's carry, the child's persist (the floorless whole-value arm),
 * the diff side (`redactParametersForDiff`'s fallback) and the parent's
 * rollback record all read the map by whole value. Refusal 3's
 * self-referential shape cannot reach the write: {@link singleSpanFrame}
 * refuses a middle that is itself a token, which is what a bag equal to its
 * source has.
 *
 * THE PER-NAME ASSOCIATION (issue #3079). The entry is keyed by VALUE, so over
 * one middle with TWO tokens in one frame it names one of them, and every
 * child leaf holding the value would take that one -- the loser's `{Ref}`
 * persisting the survivor's frame, which is the wrong reference the three
 * consumers below re-resolve after the sibling rotates. So beside the entry,
 * every leaf passing (i), (ii), the pair gate between (ii) and (iv), (iv)
 * and (v) -- the survivor's and the loser's alike, and whether or not (iii)
 * let its entry through -- is recorded BY NAME into {@link nestedStackParameterExpressions}, the table
 * the whole-token walk above fills, as `name -> (its own frame, the value)`.
 * The child inherits it ({@link inheritNestedStackParameterAssociations})
 * and reads it through {@link certifiedExpressionForLeaf} at all three
 * sites: the carry (`recordInheritedParameterSecrets` asks per plaintext),
 * the persist walk (`positionByCrossStackSource` on the `{Ref}` source) and
 * the diff side (`redactParametersForDiff`). Each requires the bag to HOLD
 * the value, which the entry provides -- or the child's OWN resolution of
 * the same plaintext, in which case the association answers with the leaf's
 * own frame, the right reference for it. So a FRAMED association whose value
 * (iii) refused is inert or correct, never wrong -- a claim the whole-token
 * walk's STRING-source half now earns the same way, through refusal 5 (issue
 * #3090); its intrinsic-source half rests on the reader's condition 3, less
 * the skeleton arm's own unpinned-`ssm` residual (stated on that arm).
 * The association's expression is
 * the FRAME, not a token -- the one writer into that table that stores a
 * non-token, said so on {@link storeAssociation}; its readers return it to be
 * persisted, which is exactly what the entry would have written.
 *
 * WHAT STAYS OPEN, weighed against the three live consumers named on
 * {@link positionByIntrinsicFrame} (`cdkd rollback`, `drift --revert`, a
 * consumer's cross-stack read). (a) CLOSED by the association above (was:
 * the loser's child leaf took the survivor's frame, or stayed plaintext
 * under a different frame -- the second half closed by (iii)'s second arm).
 * An `Fn::Sub` / `Fn::Join` leaf EMBEDDING the `{Ref}` in a resource that
 * consumes BOTH parameters is positioned by name too since issue #2320
 * (`positionByParameterPlaceholders`, pinned), from the spans the resolver
 * recorded (#4446). What remains: a leaf that arm refuses takes the value
 * scan, which reads the resource's ONE plaintext-keyed slot -- whichever
 * `{Ref}` resolved last. (b) The framed
 * value is a SUBSTRING needle (7 characters here) in every child resource
 * that consumed the parameter, so an unrelated literal there containing it
 * is spliced -- the #2087 class, bounded to resources whose own resolution
 * consumed the parameter; on the parent's own row (v) refuses the entry
 * instead, over the leaves visible at record time -- a readback leaf AWS
 * rewrote to contain the value is spliced like any 4+ character needle's.
 * (c) A frame longer than
 * `MAX_SKELETON_CANDIDATE_LENGTH` makes both intrinsic arms refuse every
 * INTRINSIC-sourced leaf of that child resource, which then falls to the
 * value scan (a literal-source leaf keeps the span arm). (d) A child
 * OUTPUT carrying the framed value re-resolves in the parent to `port:q7`,
 * where the cross-stack seam refuses a non-token and the consumer's leaf
 * persists the plaintext -- the same class as the nonliteral-frame deferral.
 * (e) CLOSED for a wholly literal frame by (i)'s object arm (issue #3062;
 * was: an `Fn::Join` / `Fn::Sub` source in the parent's own `Parameters`
 * block was never carried), and for the two spellings that arm refused -- a
 * token spelling `ssm:` or leaving its service to an intrinsic part, and a
 * frame whose non-literal part sits outside the token -- by its provenance
 * arm (issue #3156), which on the second also rewrites the PARENT's record of
 * the leaf through the entry, and since issue #3306 for a token spelled inside
 * a nested `Fn::Join` / `Fn::Sub` / `Fn::If` part, held by a used `Fn::Sub`
 * variable, or inside an `Fn::If` around the frame, whose records lend the
 * outer object the token raw (see {@link IntrinsicLeafResolution}). What
 * remains of it, each a refusal of a wrong reference or of a carried
 * plaintext: a leaf resolved two different ways in one pass (an `Fn::If` that
 * selected different branches included), one whose replacement took a public
 * verdict, one that replaced more than one token, one whose token sits in a
 * part with no record of its own (an `Fn::Select` element, an `Fn::If` branch
 * of that kind), one whose spelling holds a plaintext the bag holds
 * anywhere, prefix, token or suffix, bar its own value inside its token
 * (another secret a non-literal part
 * resolved into it, e.g. `{{resolve:ssm:/app/${Name}}}` with `Name` a secret;
 * {@link substitutedSpellingOf}) -- each keeps the plaintext in the child, and
 * for the outside-the-token frame in the parent's record; so does an
 * outside-the-token frame sharing its value with a leaf of another token,
 * which (iv) refuses. For a template's secret-assembled token the resolver
 * refuses first (go-to-k/cdkd#4166), recording nothing, so the carry's
 * refusal backs that one up. A rollback replay records
 * nothing here (`resolveReplayProps` resolves strings, not intrinsic objects):
 * a journal a
 * deploy wrote holds a carried frame's persisted spelling as a STRING, which
 * the literal arm reads, while a record `cdkd import` left holding the raw
 * intrinsic stays refused on this arm. Any other resolved text a non-literal
 * part contributes is carried verbatim in the spelling, as the value already
 * carries it.
 * (f) A child record persisted BEFORE this carry
 * keeps `port:q7` until the child is next redeployed: the parent's own row
 * already held the frame (the literal or frame arm), so a parent deploy whose child
 * row is unchanged never re-runs the child. `cdkd scrub` of the parent
 * repairs it: since go-to-k/cdkd#2252 scrub walks each nested child with the
 * parent row's bag as its inherited bag, re-running this carry for the row.
 */
export function recordNestedStackParameterExpressions(
  secrets: RecordedSecretValues,
  resourceType: string,
  resolvedProperties: unknown,
  sourceProperties: unknown,
  rules: PathSourceRules = TEMPLATE_DERIVED_RULES
): void {
  if (resourceType !== NESTED_STACK_RESOURCE_TYPE) return;
  if (secrets.size === 0) return;
  if (!isPlainObject(resolvedProperties) || !isPlainObject(sourceProperties)) return;
  // `Object.hasOwn` for the reason the walks in this module use it: without it
  // the prototype chain can answer for a key a caller-constructed bag lacks.
  if (!Object.hasOwn(resolvedProperties, 'Parameters')) return;
  if (!Object.hasOwn(sourceProperties, 'Parameters')) return;
  const resolvedParameters = resolvedProperties['Parameters'];
  const sourceParameters = sourceProperties['Parameters'];
  if (!isPlainObject(resolvedParameters) || !isPlainObject(sourceParameters)) return;

  // A MARKED shallow copy (issue #2745, the nested-stack site): the copy is
  // this pass's own, so `positionByEmbeddedSpan` may write a sub-floor middle
  // as the token this pass resolved it from. The seventh site on
  // {@link markSameGenerationBag}'s list, which states the claim and why it
  // holds at every caller of this function. The caller's object is never
  // marked here -- what the record holds is the caller's business.
  const positioned = redactSecretsForState(
    markSameGenerationBag({ ...resolvedParameters }),
    secrets,
    sourceParameters,
    rules
  ) as Record<string, unknown>;

  let table = nestedStackParameterExpressions.get(secrets);
  // THE RENDERED SPELLING (issue #4644): a LITERAL source that is not one whole
  // token and that the position pass returned VERBATIM -- the identity proof
  // refusal 2b reads -- which for an embedding literal means the span arm or
  // the multi-span render certificate fired (`positionByEmbeddedSpan`). Only
  // the spelling is recorded here; {@link inheritedParameterExpression}
  // re-asks {@link rendersLiteralTo} of this bag at every read. A two-token
  // value has no per-name answer otherwise (refusal 2 below, and the
  // sub-floor carry's single span), so the child's `{Ref}` leaf and the diff
  // side fell to the parent value scan's SURVIVOR, which `cdkd diff
  // --recursive` -- binding the literal -- never renders.
  for (const [name, resolvedValue] of Object.entries(resolvedParameters)) {
    const sourceLeaf = sourceParameters[name];
    if (typeof resolvedValue !== 'string' || typeof sourceLeaf !== 'string') continue;
    if (isSingleDynamicReferenceToken(sourceLeaf) || positioned[name] !== sourceLeaf) continue;
    if (!rendersLiteralTo(sourceLeaf, secrets, resolvedValue)) continue;
    let rendered = renderedParameterSpellings.get(secrets);
    if (rendered === undefined) {
      rendered = new Map();
      renderedParameterSpellings.set(secrets, rendered);
    }
    const previous = rendered.get(name);
    if (previous === undefined) rendered.set(name, { spelling: sourceLeaf, value: resolvedValue });
    else if (previous?.spelling !== sourceLeaf || previous.value !== resolvedValue) {
      rendered.set(name, null);
    }
  }
  for (const [name, resolvedValue] of Object.entries(resolvedParameters)) {
    // Refusal 1.
    //
    // ITS STRING-ONLY HALF IS NOT A GAP, and this note exists so the next lane
    // does not "fix" it into certifying a shape production cannot deliver.
    // Issue [#2327](https://github.com/go-to-k/cdkd/issues/2327) was FILED
    // naming this test as the second broken half of the list-typed collapse,
    // beside the diff side. Measured against `NestedStackProvider` while fixing
    // that issue: `extractParameters` (`src/provisioning/providers/nested-stack-provider.ts`)
    // casts a scalar parent-side parameter value to a string, JOINS an array
    // back into the comma-delimited string the wire carries (issue #2347;
    // before it, arrays were refused with the rest), and REFUSES every other
    // non-scalar -- and it runs immediately after this recorder, so what
    // reaches a child engine is always a STRING. The ARRAY the issue is about
    // is produced INSIDE the child by its own `Type` coercion. That is why
    // #2327 changed the two READ sides and left this WRITE side exactly as it
    // was. (An array `resolvedValue` on the PARENT side is what condition (v)
    // of the sub-floor carry below walks leaf by leaf.)
    if (typeof resolvedValue !== 'string' || !secrets.has(resolvedValue)) continue;
    const expression = positioned[name];
    if (typeof expression !== 'string') continue;
    // Refusal 2.
    if (!isSingleDynamicReferenceToken(expression)) continue;
    // Refusal 2b — the position pass has to have CERTIFIED this leaf, not
    // merely fallen through to the value scan.
    //
    // `redactSecretsForState` returns a value either way, and for a leaf it
    // REFUSES it returns `secrets.get(resolvedValue)` — the collapsed map's
    // SURVIVOR. Recording that would store the survivor under the LOSING
    // parameter's name and label it certified, which is the collapse this whole
    // store exists to remove, arriving through the store itself.
    //
    // For a whole-token STRING source, "certified" has an exact spelling:
    // `redactByPath`'s source arm returns the SOURCE LEAF verbatim, so a
    // MISMATCH proves it did not fire. Not an iff, and the earlier wording said
    // so wrongly: the value scan COINCIDES with the source for the WINNING
    // parameter, whose survivor expression IS its own source leaf. The test is
    // therefore sound in the direction it is used -- it only ever REFUSES -- and
    // an entry it lets through on that coincidence is the survivor, which every
    // reader produces on a refusal anyway. Found by the `rules` probe: an `ssm`
    // reference whose `SecureString` verdict this process has not pinned fails
    // `isKnownSecretExpression` under {@link TEMPLATE_DERIVED_RULES}, takes the
    // public-reference branch, and value-scanned its way to the sibling's
    // expression — so the losing parameter of an unpinned ssm pair was recorded
    // against the WRONG reference.
    //
    // An INTRINSIC source has no such identity to test (both positioners return
    // a candidate on success and `undefined` on refusal, and the caller cannot
    // see which), so it is left as it is: there the fallback yields the survivor
    // too, which is exactly what every reader produces on a refusal anyway, so
    // the entry cannot change an answer.
    const sourceLeaf = sourceParameters[name];
    if (typeof sourceLeaf === 'string' && expression !== sourceLeaf) continue;
    // Refusal 3 — reachable via a self-referential secret; see the doc above.
    if (expression === resolvedValue) continue;
    // Refusal 4 — this pass SAW this expression resolve to something ELSE
    // (issue [#2327](https://github.com/go-to-k/cdkd/issues/2327) review).
    //
    // This is {@link certifiedExpressionForLeaf}'s condition 3, moved to WRITE
    // time, and the move is the whole point rather than an optimisation. That
    // condition reads the bag's VALUES through {@link plaintextIndexOf}, and
    // the two readers of this table hold DIFFERENT bags: the DIFF side gets the
    // parent's own map, the PERSIST side the issue #2087-scoped per-resource
    // child bag, whose values are each parameter's OWN expression. So the same
    // association could pass condition 3 on one side and fail it on the other
    // -- and it did. MEASURED over a sweep of bag configurations: with
    // `EXPR_A` also recorded against a DIFFERENT plaintext (the issue #1933
    // two-regions shape), the persist side certified `EXPR_A` while the diff
    // side refused and fell back to the survivor, on 4 of 16 configurations.
    //
    // The consequence is the one this whole store exists to prevent, one shape
    // over: the child persists the ONE expression this pass has direct evidence
    // resolves to a different plaintext, and `resolveReplayProps` re-resolves
    // it, so a rollback or `cdkd drift --revert` applies the WRONG secret.
    //
    // REFUSING IS CORRECT HERE, not a capitulation to the asymmetry. The
    // question "did this pass watch this expression resolve to something else"
    // is about the RESOLUTION, which happened in the PARENT -- so the parent's
    // map is the bag that can answer it, and the child's cannot: it holds only
    // what the parent handed down. Deciding once, here, is what makes the two
    // readers see the same table by construction rather than by two evaluations
    // agreeing. Both sides then degrade to the plaintext-keyed value scan
    // together, which is the pre-#2291 behaviour and the same answer they gave
    // before this arm existed.
    //
    // The read-time condition 3 STAYS. It still serves
    // {@link crossStackAssociations}'s other writers, which have no second
    // reader and no write-time twin, and for THIS family it is now belt and
    // braces -- on the diff side it is vacuous (same bag, same verdict), and on
    // the persist side it can only refuse, which the sweep below finds no
    // surviving association to do.
    const seenResolvingTo = plaintextIndexOf(secrets).get(expression);
    if (seenResolvingTo !== undefined && seenResolvingTo !== resolvedValue) continue;
    // Refusal 5 -- THIS pass resolved this expression to this value (issue
    // #3090). Refusals 1 and 4 read the map, which a PUBLIC token is never a
    // value of: under STATE_DERIVED_RULES the position pass certifies a raw
    // public `ssm` token a `cdkd import` record kept (the carve-out above)
    // with no pair, and when its plaintext COINCIDES with a secret the bag
    // holds, refusal 1 passes on the secret's key and refusal 4 finds
    // nothing to disagree with -- so the child's `{Ref}` leaf persisted the
    // public reference. The pair table names only what the resolver resolved
    // as a secret, uncollapsed: a losing sibling still passes (its pair is
    // recorded beside the survivor's), so does an unpinned `ssm` token (a
    // pass-local pair), and the sub-floor walk below asks the same question
    // of its frames. Refuses to the value scan, i.e. today's answer.
    //
    // STRING SOURCES ONLY, and the scope is load-bearing (#3093 review, all
    // three reviewers): a CHILD engine's bag is filled by
    // `recordInheritedParameterSecrets` -- entries, no pairs -- so inside a
    // child, a nested row spelling `{Ref: <Param>}` (a GRANDCHILD's
    // parameters) has NO pair to show, and an unscoped refusal collapsed
    // every three-level chain back onto the survivor (measured: the loser's
    // grandchild leaf took the sibling's expression). An intrinsic source is
    // not the #3090 shape: it positions only through an association -- a
    // `Ref` key the PARENT's recorder gated (this refusal on a string row,
    // its positioners' condition 3 otherwise, the sub-floor carry's pair
    // gate for a framed row), or a seam key (`Fn::ImportValue` /
    // `Fn::GetAtt` / `Fn::GetStackOutput`) gated at the resolver's recording
    // seam (`reresolveCrossStackValue`: presence plus secret verdict;
    // `recordCrossStackExpression` adds only the shape test), whose residual
    // that seam states -- or
    // through the skeleton / frame arms: the frame arm requires a pair, the
    // skeleton arm none, its safety being a candidate set (map values plus
    // the pinned verdict set) that holds secret-verdict expressions only.
    // Pairs are deliberately NOT recorded at the carry instead -- that would
    // newly arm `positionByEmbeddedSpan` on every child literal (a change
    // with its own review).
    //
    // REFUSAL 4 IS NOT SUBSUMED BY THIS ONE. On an intrinsic source the
    // reader's own condition 3 ({@link certifiedExpressionForLeaf}, same bag,
    // same index) has already refused what refusal 4 would. On a STRING
    // source in a bag whose map entries carry no pairs -- a child engine's,
    // inherited entries beside the child's own paired resolutions -- an
    // expression can hold a clean pair (its own resolution) while the map's
    // index says it resolved to an INHERITED plaintext: refusal 5 passes it,
    // refusal 4 alone refuses (pinned by the "child bag: refusal 4 alone"
    // case; measured in review as the one shape a deletion would change).
    if (
      typeof sourceLeaf === 'string' &&
      resolvedPlaintextOf(secrets, expression) !== resolvedValue
    ) {
      continue;
    }
    if (table === undefined) {
      table = new Map();
      nestedStackParameterExpressions.set(secrets, table);
    }
    storeAssociation(table, name, expression, resolvedValue);
  }

  // THE SUB-FLOOR CARRY (issue #2745). See the doc above for the shape, the
  // five conditions and what stays open. Collected first and written AFTER
  // the walk, so no iteration reads the recorder's own write.
  //
  // (iv) needs the FRAME of every spelling of every value, not only the
  // certified ones: a leaf (iii) refused, an object-spelled one the frame arm
  // refused and a plain literal all share the value the entry would be keyed
  // by, and the parent's record of such a leaf answers against the entry. So
  // the frames are gathered over the whole row first, keyed by prefix +
  // suffix; a spelling that is not a single-span frame of the value, or whose
  // token this pass did NOT resolve to the middle (a PUBLIC sibling in the
  // same frame, kept resolved on the record), is its own key.
  const framesByValue = new Map<string, Set<string | typeof UNFRAMED_SPELLING>>();
  // The TOKENS the row's framed spellings of each value carry -- (iii)'s
  // second arm (issue #3079) reads it. An unframed spelling adds nothing
  // here because (iv) refuses the value before (iii) is asked.
  const tokensOf = new Map<string, Set<string>>();
  // The TEXT a leaf's frame is read from. A LITERAL source is its own text,
  // certified or not. No case in the suite tells the two readings apart
  // (swapping `certifiedSpellingOf` into the frames loop reddens nothing),
  // so no claim that (iv) NEEDS the uncertified one is made; it is kept so
  // the loop reads a literal and an object source through one function. An
  // OBJECT source (`Fn::Join` / `Fn::Sub`, issue #3062) carries no text
  // about the frame, so on the spelling-based arm its text is what the
  // position pass WROTE for it, and only when the pass rewrote the leaf at
  // all: an unrewritten leaf has no frame to report there. `singleSpanFrame`
  // refuses that shape as well (a spelling equal to its bag has no middle
  // that is not itself a token), so the inequality states the rule rather
  // than being its only enforcement. The provenance arm below reads the
  // leaf's own resolution record instead, rewritten or not; an object leaf
  // neither arm certifies stays its own (unframed) key. Anything else -- an
  // array, a number -- has no frame.
  //
  // THE SPELLING-BASED ARM TAKES ONLY A SOURCE THAT SPELLS ITS SERVICE AS A
  // SECRET, read from the SOURCE's
  // own rendered text and never from what the pass wrote -- a refusal of the
  // WRONG REFERENCE, not tidiness. The frame arm picks the one candidate its
  // wildcard pattern matches among the references this pass RECORDED, so the
  // written token is always a recorded secret's, whatever the leaf really
  // referenced. A PUBLIC `ssm` parameter records nothing, so a public leaf
  // matches a recorded sibling whenever the source leaves room for one: an
  // `ssm:` service beside a SecureString sibling (`port:{{resolve:ssm:/app/` +
  // `{Ref: Env}` + `}}`), or a service that is itself an intrinsic part
  // (`port:{{resolve:` + `{Ref: Svc}` + `}}`, `${Svc}`) beside ANY recorded
  // secret. A token whose rendered text STARTS with a spelled-secret prefix
  // (`secretsmanager:` / `ssm-secure:`, the resolver refusing a public
  // parameter under the latter) names a reference this pass recorded if it
  // resolved it, so a second match refuses; a placeholder inside the prefix
  // fails `startsWith` and refuses. Refused here rather than after
  // certification so the leaf also counts as UNFRAMED in (iv), which keeps a
  // same-value literal sibling from taking the entry. The second match
  // refuses only while the leaf's OWN pair is intact: an own token that
  // resolved to two plaintexts in one pass (`CONFLICTING_PLAINTEXT`, which
  // `deploy-engine.ts` shows a non-cacheable re-resolution can produce) is
  // dropped from the frame arm's candidates by its plaintext test, a sibling
  // becomes the single match, and this arm carries the sibling's reference
  // to the child -- the frame arm's own residual, inherited rather than
  // added here.
  //
  // What each test below refuses. `written === resolvedValue` refuses an
  // unrewritten leaf on the spelled-secret arm, which `singleSpanFrame`
  // refuses too (a spelling equal to its bag has no middle that is not itself
  // a token); it states the rule.
  // The skeleton and its ONE span gate the spelled-secret arm only (issue
  // #3306): a source the skeleton cannot render (an `Fn::If`) or whose
  // rendering spells no token or several (a token held by a nested part or a
  // used `Fn::Sub` variable renders as a placeholder) has no own token to
  // read a service from, so it goes to the provenance arm alone, which reads
  // the leaf's record rather than its text. The MORE-than-one arm of the span
  // test is inert rather than unreachable: the value scan rewrites a
  // two-token source whose whole value is a recorded plaintext, but (ii)
  // then refuses that value for every leaf holding it, so a laxer count could
  // not change an entry or an association -- no case can pin it, and none is
  // claimed. `isPlainObject` and `typeof written` narrow the types the calls
  // below take.
  //
  // THE PROVENANCE ARM (issue #3156), asked only where the spelled-secret arm
  // refuses, so nothing that arm carries changes. It reads this leaf's OWN
  // resolution record ({@link substitutedSpellingOf}): exactly one token
  // replaced, under a SECRET verdict that replacement took, turning the
  // record's input into the resolved value. That is positive evidence where
  // the service spelling was only a proxy, so an `ssm:` token and a service
  // left to an intrinsic part are certified on it, and so is a frame whose
  // non-literal part sits OUTSIDE the token, which the frame arm refuses and
  // therefore never writes (`written === resolvedValue`). Where the frame arm
  // DID write, it must have written the record's spelling: a different one is
  // its wrong-reference residual (a public leaf matching a recorded sibling),
  // refused here as it was before. The accepting side runs whenever the frame
  // arm writes a leaf this arm certifies (a wholly literal `ssm:` frame). The
  // refusing side is reached by no case here: for a wholly literal token the
  // frame arm's pattern matches only that token, and for one with a
  // placeholder a sibling becomes its one match only when the arm dropped the
  // leaf's own token, which it does when the MAP's reverse index holds
  // `CONFLICTING_PLAINTEXT` for that token while its pair is intact (the
  // inherited-entry shape refusal 4 names). What the record proves is the substitution
  // it observed, not what a later lookup of the token returns; and a
  // non-literal part's resolved text is kept verbatim in the spelling, as the
  // resolved value already keeps it, unless it holds a plaintext the bag holds
  // (`substitutedSpellingOf` refuses that).
  // Memoized per parameter NAME, and the name is the ONLY input: the value is
  // read from `resolvedParameters` inside, so the key is total by construction
  // rather than by every caller passing the matching value. The frames loop
  // and (i) both ask, and the provenance arm's affix test scans every key of
  // `secrets`.
  const frameSpellings = new Map<string, string | undefined>();
  const frameSpellingOf = (name: string): string | undefined => {
    if (!frameSpellings.has(name)) frameSpellings.set(name, computeFrameSpelling(name));
    return frameSpellings.get(name);
  };
  const computeFrameSpelling = (name: string): string | undefined => {
    const resolvedValue = resolvedParameters[name];
    if (typeof resolvedValue !== 'string') return undefined;
    const sourceLeaf = sourceParameters[name];
    if (typeof sourceLeaf === 'string') return sourceLeaf;
    if (!isPlainObject(sourceLeaf)) return undefined;
    const written = positioned[name];
    if (typeof written !== 'string') return undefined;
    const segments = intrinsicSkeletonSegments(sourceLeaf);
    const rendered = segments
      ?.map((s) => (s === UNKNOWN_PART ? UNKNOWN_PART_PLACEHOLDER : s))
      .join('');
    const spans = rendered === undefined ? [] : dynamicReferenceSpans(rendered);
    if (rendered !== undefined && spans.length === 1) {
      const [span] = spans as [{ start: number; end: number }];
      const ownToken = rendered.slice(span.start, span.end);
      if (
        written !== resolvedValue &&
        SPELLED_SECRET_REFERENCE_PREFIXES.some((prefix) => ownToken.startsWith(prefix))
      ) {
        return written;
      }
    }
    const substituted = substitutedSpellingOf(secrets, sourceLeaf, resolvedValue);
    if (substituted === undefined) return undefined;
    return written === resolvedValue || written === substituted ? substituted : undefined;
  };
  // The spelling condition (i) CERTIFIED for a leaf, or `undefined`. See the
  // doc above for why each arm's test is sound: a literal is certified when
  // the pass returned it verbatim; an object when the pass rewrote a
  // spelled-secret leaf, which on a value (ii) finds silent only the frame arm
  // can do, or when its own resolution record proves the spelling.
  const certifiedSpellingOf = (name: string): string | undefined => {
    const sourceLeaf = sourceParameters[name];
    if (typeof sourceLeaf === 'string') {
      return positioned[name] === sourceLeaf ? sourceLeaf : undefined;
    }
    return frameSpellingOf(name);
  };
  // The values some framed leaf holds that the position pass did NOT write
  // (the provenance arm's frame outside a non-literal part, issue #3156). On
  // the parent's record such a leaf is refused by the frame arm and read by
  // the value scan alone, so the entry is written onto it whatever its token:
  // the (iii) rescue -- a same-frame sibling around another token keeps its
  // own token through the span or frame arm's bound -- does not exist for it.
  const unwrittenValues = new Set<string>();
  for (const [name, resolvedValue] of Object.entries(resolvedParameters)) {
    if (typeof resolvedValue !== 'string') continue;
    const spelling = frameSpellingOf(name);
    const frame = spelling === undefined ? undefined : singleSpanFrame(resolvedValue, spelling);
    const frames = framesByValue.get(resolvedValue) ?? new Set<string | typeof UNFRAMED_SPELLING>();
    const unframed =
      frame === undefined || resolvedPlaintextOf(secrets, frame.token) !== frame.middle;
    frames.add(
      unframed ? UNFRAMED_SPELLING : `${frame.prefix.length}:${frame.prefix}${frame.suffix}`
    );
    framesByValue.set(resolvedValue, frames);
    if (!unframed) {
      const tokens = tokensOf.get(resolvedValue) ?? new Set<string>();
      tokens.add(frame.token);
      tokensOf.set(resolvedValue, tokens);
      if (typeof sourceParameters[name] !== 'string' && positioned[name] !== spelling) {
        unwrittenValues.add(resolvedValue);
      }
    }
  }
  // So a value one of those leaves holds is recorded only when every framed
  // spelling of it carries ONE token; otherwise it counts as unframed, which
  // is the answer that leaf had before the provenance arm existed.
  for (const value of unwrittenValues) {
    if (tokensOf.get(value)?.size !== 1) framesByValue.get(value)?.add(UNFRAMED_SPELLING);
  }
  // (v) reads the string leaves of the ROW outside `Parameters` as well: the
  // bag is per resource, so the entry is a needle for `TemplateURL` too, and
  // a leaf there EQUAL to the value has no frame to answer with.
  const rowWithoutParameters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resolvedProperties)) {
    if (key !== 'Parameters') rowWithoutParameters[key] = value;
  }
  const outsideLeaves = wholeStringLeavesOf(rowWithoutParameters);
  const framed = new Map<string, string>();
  // The per-NAME associations (issue #3079): each framed leaf's OWN frame,
  // loser included, written into the same table the whole-token walk above
  // fills. Collected here, stored after the loop with the entries.
  const framedByName: Array<[name: string, expression: string, plaintext: string]> = [];
  for (const [name, resolvedValue] of Object.entries(resolvedParameters)) {
    if (typeof resolvedValue !== 'string') continue;
    // (i) the leaf is CERTIFIED. On a literal source the span arm returns the
    // source verbatim, so a mismatch proves it did not fire; on an object
    // source a REWRITE is the evidence for a spelled-secret token (issue
    // #3062), sound only together with (ii) below, and the leaf's own
    // resolution record is the evidence otherwise (issue #3156, which also
    // certifies a leaf the pass did not rewrite) -- see the doc above.
    const spelling = certifiedSpellingOf(name);
    if (spelling === undefined) continue;
    // (ii) the value scan is SILENT on the value: the sub-floor gate. A middle
    // at or above the floor is refused here -- the child's substring carry
    // already has it.
    if (redactSecretsForState(resolvedValue, secrets) !== resolvedValue) continue;
    // The frame, and THIS leaf's own pair evidence: the pass resolved the
    // frame's token to the middle. For a LITERAL spelling it is
    // LOAD-BEARING UNDER BOTH RULESETS, and not implied by (i) + (ii) -- two
    // arms of `redactByPath` return a source verbatim. For an OBJECT spelling
    // the frame arm WROTE it is implied (it writes only on that pair), and kept
    // so both spellings leave through one gate; for one the provenance arm
    // certified it refuses a token this pass saw resolve to two plaintexts
    // (`CONFLICTING_PLAINTEXT`), which a single record does not show. A LITERAL frame reaches here
    // only through the span arm,
    // which fires on pair evidence alone. An EMPTY frame (a whole-token
    // source) reaches here through the whole-token arm, which asks for NO
    // pair: under STATE_DERIVED_RULES it trusts any expression, so a raw
    // PUBLIC `ssm` token a `cdkd import` record kept (the carve-out the doc
    // above names) arrives around a value the map never held; under the
    // TEMPLATE rules it is merely SPELLING-gated (`isKnownSecretExpression`),
    // so a `secretsmanager` token a bag no resolver populated never paired
    // arrives the same way. Either would hand the child's leaf a reference
    // this pass has no evidence for (the #1901 class in the first case).
    // This gate refuses both (issue #3079 review, both rounds); do not scope
    // it to `rules.trustAnyExpression`. `singleSpanFrame` also refuses a
    // middle that is itself a token, which is what refusal 3's
    // self-referential shape has here (a bag equal to its source).
    const frame = singleSpanFrame(resolvedValue, spelling);
    if (frame === undefined || resolvedPlaintextOf(secrets, frame.token) !== frame.middle) continue;
    // (iv) ONE frame per value across the row. `port:` + `q7` beside `port` +
    // `:q7`, an object spelling (i) refused or a plain literal would each fail the span
    // arm's bound against this entry on the parent's record and take its
    // frame; the same frame around another token (the (iii) shape) passes
    // that bound and keeps its own token -- unless one leaf of the value is
    // a frame the pass did not write, which `unwrittenValues` already counted
    // as unframed. So the value is recorded only when every spelling of it in
    // the row is this one frame.
    if (framesByValue.get(resolvedValue)?.size !== 1) continue;
    // (v) no OTHER string leaf of the row would be rewritten by the entry.
    // Two arms read it: the WHOLE-VALUE arm, floorless, so a leaf EQUAL to the
    // value outside `Parameters` (a `TemplateURL`) or inside a LIST-valued
    // parameter refuses at any length (between string parameters equality is
    // (iv)'s frame identity); and the SUBSTRING arm, which only a value at or
    // above `MIN_NEEDLE_LENGTH` reaches, so a sibling merely CONTAINING it --
    // `x-port` + `:q7` from another token, a plain literal -- refuses only
    // then, and a 3-character `pq7` is carried beside such a sibling.
    const isNeedle = resolvedValue.length >= MIN_NEEDLE_LENGTH;
    const rewrites = (leaf: string): boolean =>
      leaf === resolvedValue || (isNeedle && leaf.includes(resolvedValue));
    let embedded = false;
    for (const leaf of outsideLeaves) {
      if (rewrites(leaf)) {
        embedded = true;
        break;
      }
    }
    for (const other of Object.values(resolvedParameters)) {
      if (embedded) break;
      if (typeof other === 'string') {
        if (other !== resolvedValue && rewrites(other)) embedded = true;
        continue;
      }
      // A LIST-valued parameter (`extractParameters` joins it back for the
      // wire) has no frame at all, so every leaf of it counts.
      for (const leaf of wholeStringLeavesOf(other)) {
        if (rewrites(leaf)) {
          embedded = true;
          break;
        }
      }
    }
    if (embedded) continue;
    // The association: this leaf's own frame, whatever the map's survivor for
    // the middle is. Its readers ({@link certifiedExpressionForLeaf}, through
    // the child's carry, its persist walk and `redactParametersForDiff`) each
    // require the bag to HOLD the value, which the entry below provides (or
    // the child's own resolution of the same plaintext, answered with this
    // leaf's own frame) -- so on a row where (iii) refuses every leaf of a
    // value, the association is inert or correct, never wrong.
    framedByName.push([name, spelling, resolvedValue]);
    // (iii) the token IS the map's survivor for the middle -- the collapse
    // hazard the doc above spells out -- OR every spelling of the value in
    // the row carries THIS token (issue #3079). The hazard is a same-frame
    // sibling around a DIFFERENT token: on the parent's record it answers
    // against the entry through the span arm's bound, which names the
    // SURVIVOR, so a loser's entry would be written onto it. With no such
    // sibling the entry is read correctly either way: the bound passes for
    // the survivor's token and the arm writes it; for a loser's the bound
    // fails, the value scan writes the entry, and the entry IS this leaf's
    // frame. (v) has already refused every other leaf the entry could reach.
    if (secrets.get(frame.middle) !== frame.token && tokensOf.get(resolvedValue)?.size !== 1) {
      continue;
    }
    framed.set(resolvedValue, spelling);
  }
  for (const [plaintext, expression] of framed) secrets.set(plaintext, expression);
  for (const [name, expression, plaintext] of framedByName) {
    if (table === undefined) {
      table = new Map();
      nestedStackParameterExpressions.set(secrets, table);
    }
    storeAssociation(table, name, expression, plaintext);
  }
}

/**
 * Copy a parent pass's per-PARAMETER associations onto a nested-stack CHILD
 * resource's own bag, as ordinary {@link crossStackAssociations} rows keyed by
 * `{Ref: <ParamName>}` (issue #2291).
 *
 * Called by the child {@link DeployEngine} once per resolver context, so each
 * child resource's fresh bag carries them. Pre-seeding every resource this way
 * does NOT reintroduce issue #2087's over-redaction: an association can only
 * change an answer through {@link positionByCrossStackSource}'s condition 1,
 * which requires the bag leaf to be a plaintext THIS resource's bag holds — and
 * since #2087 that is true only of resources whose own resolution consumed the
 * parameter. The scoping still comes from the plaintext bag; this table only
 * decides WHICH expression such a leaf takes.
 *
 * Nothing is copied when the parent recorded nothing, which is every non-nested
 * caller and every nested one whose parameters carry no secret.
 */
export function inheritNestedStackParameterAssociations(
  childSecrets: RecordedSecretValues,
  parentSecrets: RecordedSecretValues
): void {
  const table = nestedStackParameterExpressions.get(parentSecrets);
  if (table === undefined || table.size === 0) return;
  let associations = crossStackAssociations.get(childSecrets);
  for (const [name, association] of table) {
    const key = crossStackSourceKey({ Ref: name });
    if (key === undefined) continue;
    if (associations === undefined) {
      associations = new Map();
      crossStackAssociations.set(childSecrets, associations);
    }
    // A poisoned parent entry is copied AS the poison, so the child refuses for
    // the same reason the parent could not answer.
    //
    // NO PRODUCTION PATH DISCRIMINATES THIS, which is a narrower claim than the
    // one an earlier revision made ("no test can") — and that one was FALSE,
    // disproved in review by constructing the case through this module's own
    // API. Copying the poison and dropping the entry differ as soon as anything
    // writes the SAME key on the child bag afterwards: with the copy the key
    // stays poisoned and the reader refuses, without it the later write lands on
    // an empty slot and CERTIFIES. `recordCrossStackExpression` is exactly such
    // a writer, so a test reaches it (and now does).
    //
    // Production cannot, because the resolver only ever builds a `sourceKey`
    // from `Fn::ImportValue` / `Fn::GetStackOutput` / `Fn::GetAtt` and never
    // from a `Ref`, so no production writer can collide with an inherited
    // parameter key. That is the same standard the sibling note on
    // {@link storeAssociation} uses — "reachable only through this module's
    // API" — and it is the accurate one here.
    if (typeof association === 'symbol') {
      associations.set(key, association);
      continue;
    }
    storeAssociation(associations, key, association.expression, association.plaintext);
  }
}

/**
 * The expression a nested-stack child's PARAMETER was resolved from, or
 * `undefined` when this pass cannot certify one (issue #2291).
 *
 * The DIFF-side twin of {@link positionByCrossStackSource}, and it must exist
 * or the fix trades one bug for another. The child's persisted state now holds
 * each parameter-fed leaf's OWN expression, so the desired side of the next
 * diff has to hold it too; the engine's `redactParametersForDiff` rewrites the
 * parameter bag through the plaintext-keyed map alone, which hands BOTH members
 * of a coinciding pair the survivor's expression. The two sides would then
 * never match for the losing parameter: a perpetual UPDATE on every deploy of
 * such a child, which is issue #2087's user-visible symptom arriving through a
 * different door.
 *
 * `parentSecrets` is the INHERITED bag — the parent's own per-resource map, the
 * object this table is keyed by — not the child resource's bag.
 *
 * The same THREE conditions the persist side applies, because it is literally
 * the same code: {@link certifiedExpressionForLeaf} OWNS the question and both
 * halves call it. See that function for why condition 3 is not subsumed by
 * condition 2.
 *
 * RETURNS AN ARRAY for a LIST-typed parameter (issue
 * [#2327](https://github.com/go-to-k/cdkd/issues/2327)), through the same
 * {@link certifiedListForLeaf} the persist side reaches from
 * {@link positionListByCrossStackSource}. `coerceParameterTypedValue` splits a
 * `CommaDelimitedList` parameter's STRING into an array before either side sees
 * it, so a scalar answer here would be compared against an array in state and
 * report a change forever — this function's own failure mode, one shape over.
 *
 * TWO CALLERS, and the widened return type is why the second one asks a
 * different question. `redactParametersForDiff` assigns the result into a
 * `Record<string, unknown>` and needs the whole parameter's answer, array
 * included. `IntrinsicFunctionResolver.recordInheritedParameterSecrets` writes
 * into a `Map<string, string>` keyed by PLAINTEXT, so it asks this per
 * PLAINTEXT — passing the carried plaintext rather than the parameter's value —
 * and keeps only a `string` answer. That is not a workaround for the type: a
 * plaintext-keyed bag has one slot per plaintext, and the question it needs
 * answered is "does THIS parameter certify THIS plaintext", which is the same
 * question for a scalar and for an element of a list.
 */
export function inheritedParameterExpression(
  parentSecrets: RecordedSecretValues,
  parameterName: string,
  resolvedValue: unknown
): string | unknown[] | undefined {
  const association = nestedStackParameterExpressions.get(parentSecrets)?.get(parameterName);
  if (association === undefined) {
    return renderedParameterSpelling(parentSecrets, parameterName, resolvedValue);
  }
  if (typeof association === 'symbol') return undefined;

  // A LIST-typed parameter (issue #2327). `coerceParameterTypedValue` split the
  // parent's STRING into an array before this side ever saw it, so the answer
  // has to be an array too — a string here would make the desired side a scalar
  // against an array in state and report a change forever, which is the very
  // failure this function exists to prevent, one shape over.
  //
  // THE SAME {@link certifiedListForLeaf} THE PERSIST SIDE CALLS, not a second
  // spelling of it. The two halves have to agree element for element; sharing
  // the rule is what makes that a property of the code.
  if (Array.isArray(resolvedValue)) {
    return certifiedListForLeaf(parentSecrets, association, resolvedValue);
  }

  // No rendered-spelling fallback here or on the poisoned arm above: an
  // association needs a value that IS a recorded plaintext, which
  // {@link renderedParameterSpelling} refuses.
  return certifiedExpressionForLeaf(parentSecrets, association, resolvedValue);
}

/**
 * The parent's literal spelling of `parameterName` when it EMBEDS the value's
 * plaintexts (issue [#4644](https://github.com/go-to-k/cdkd/issues/4644)), or
 * `undefined`. Two tests, both against the bag this is asked of:
 *
 * 1. WHOLE-VALUE identity: the recorder saw this parameter resolve to exactly
 *    `resolvedValue`, and that value is NOT itself a key of the bag. Such a
 *    value belongs to the association table, and the carry asks per PLAINTEXT:
 *    without the key test a value that a concatenation of tokens happens to
 *    spell (`{{A}}{{B}}`, or another token resolving to the whole string)
 *    would hand the child bag a multi-token entry. The identity half is
 *    implied by 2 while the pairs stand (a pair is never rewritten, only
 *    poisoned), and stated so the answer never rests on that table's write
 *    rule alone.
 * 2. The spelling RE-RENDERS to the value through the bag's own pairs and
 *    holds no plaintext in its literal text ({@link rendersLiteralTo}): the
 *    recorder's word is not taken alone.
 *
 * Nothing is fabricated: the answer is a string the parent's template spells
 * at this parameter, and whose every non-literal character is a plaintext the
 * parent pass resolved that very token to.
 */
function renderedParameterSpelling(
  parentSecrets: RecordedSecretValues,
  parameterName: string,
  resolvedValue: unknown
): string | undefined {
  if (typeof resolvedValue !== 'string' || parentSecrets.has(resolvedValue)) return undefined;
  const rendered = renderedParameterSpellings.get(parentSecrets)?.get(parameterName);
  if (rendered == null || rendered.value !== resolvedValue) return undefined;
  if (!rendersLiteralTo(rendered.spelling, parentSecrets, resolvedValue)) return undefined;
  return rendered.spelling;
}

/**
 * The token `parameterName`'s rendered spelling (the answer
 * {@link inheritedParameterExpression} gives for its whole `value`) spells at
 * `plaintext`, for the nested-stack carry (issue
 * [#4644](https://github.com/go-to-k/cdkd/issues/4644)); `undefined` when the
 * parameter has no rendered spelling or it names no single token there.
 *
 * WHY THE CARRY. The diff side binds the parameter to that spelling at EVERY
 * child read site -- `Fn::Select`, `Fn::Split`, an array, an `Fn::If` -- while
 * the persist side positions only a bare `{Ref}` and the placeholder arms;
 * every other shape falls to the child bag's value scan, which reads the
 * carry's entry. Recording the spelling's own token there makes the scan
 * agree with the diff side for any shape. Which plaintexts are carried (the
 * #2087 scope) is untouched; only the expression attached changes, and only
 * where this certifies one.
 */
export function inheritedRenderedToken(
  parentSecrets: RecordedSecretValues,
  parameterName: string,
  value: unknown,
  plaintext: string
): string | undefined {
  const spelling = inheritedParameterExpression(parentSecrets, parameterName, value);
  if (typeof spelling !== 'string' || isSingleDynamicReferenceToken(spelling)) return undefined;
  return renderedTokenOf(spelling, parentSecrets, plaintext);
}

/**
 * The parent's rendered spelling for a `{Ref: <Param>}` span of a child leaf
 * that EMBEDS the parameter -- `Fn::Join ['x-', {Ref: Conn}]` -- keyed by the
 * span's {@link crossStackSourceKey}, or `undefined` (issue
 * [#4644](https://github.com/go-to-k/cdkd/issues/4644)). Read by the
 * placeholder arms (`placeholder-positions.ts`) for a span no association
 * certifies.
 *
 * The diff side substitutes {@link inheritedParameterExpression}'s answer for
 * the parameter wherever the child template reads it, so an embedding leaf's
 * desired value is the template's literals around that answer. Without this
 * the persist side scanned such a span with the CHILD bag (its survivor for
 * the plaintext) while the diff side held the parameter's own spelling: an
 * UPDATE on every deploy.
 *
 * {@link positionByInheritedParameter}'s conditions, over the span: this
 * resource's resolution READ the parameter while it carried an inherited
 * secret (the #2087 scope), the span's text is the recorded value
 * (`text`, when the caller has it), it carries no child-only plaintext, and
 * the child bag would not rewrite the spelling. `value` is what the span
 * renders to, for a caller aligning the template against the leaf.
 */
export function inheritedRenderedSpan(
  childSecrets: RecordedSecretValues,
  key: string,
  text?: string
): { readonly value: string; readonly spelling: string } | undefined {
  const reads = inheritedParameterReads.get(childSecrets);
  if (reads === undefined || typeof reads === 'symbol') return undefined;
  for (const name of reads.names) {
    if (crossStackSourceKey({ Ref: name }) !== key) continue;
    const value = renderedParameterSpellings.get(reads.parent)?.get(name)?.value;
    if (value === undefined || (text !== undefined && text !== value)) return undefined;
    if (carriesChildOnlyPlaintext(value, childSecrets, reads.parent)) return undefined;
    // THE function the diff side binds, so a parameter the parent's
    // association table answers (or poisons) is answered here the same way.
    const spelling = inheritedParameterExpression(reads.parent, name, value);
    if (typeof spelling !== 'string') return undefined;
    if (redactSecretsForState(spelling, childSecrets) !== spelling) return undefined;
    return { value, spelling };
  }
  return undefined;
}

/**
 * The parameters a nested-stack CHILD resource's resolution READ while their
 * value carried an inherited secret, and the PARENT bag that value was
 * checked against, keyed by the child resource's own bag (issue
 * [#2349](https://github.com/go-to-k/cdkd/issues/2349)).
 *
 * A `WeakMap` keyed by the pass's bag, for the reason
 * {@link nestedStackParameterExpressions} gives: the parent bag holds
 * PLAINTEXT and must not outlive the pass. `POISONED_PARAMETER_READS` marks a
 * child bag that was handed TWO different parent bags; no engine does that
 * (one child engine has one `inheritedSecrets`), and the reader refuses it
 * rather than choose.
 */
const inheritedParameterReads = new WeakMap<
  RecordedSecretValues,
  { readonly parent: RecordedSecretValues; readonly names: Set<string> } | symbol
>();
const POISONED_PARAMETER_READS: unique symbol = Symbol('cdkd.inherited-parameter-reads.poisoned');

/**
 * Record that the child resource owning `childSecrets` read `parameterName`
 * and that its value carried a plaintext of `parentSecrets` (issue #2349).
 * Called by `IntrinsicFunctionResolver.recordInheritedParameterSecrets` at the
 * moment it carries such a pair into the child bag, so the record exists for
 * exactly the parameters the #2087 scoping already admits into that bag.
 */
export function recordInheritedParameterRead(
  childSecrets: RecordedSecretValues,
  parentSecrets: RecordedSecretValues,
  parameterName: string
): void {
  const reads = inheritedParameterReads.get(childSecrets);
  if (reads === undefined) {
    inheritedParameterReads.set(childSecrets, {
      parent: parentSecrets,
      names: new Set([parameterName]),
    });
    return;
  }
  if (typeof reads === 'symbol') return;
  if (reads.parent !== parentSecrets) {
    inheritedParameterReads.set(childSecrets, POISONED_PARAMETER_READS);
    return;
  }
  reads.names.add(parameterName);
}

/**
 * THE one answer for a nested-stack child PARAMETER's value with its inherited
 * secrets rewritten back to their expressions, read off the PARENT's bag
 * (issue [#2349](https://github.com/go-to-k/cdkd/issues/2349)).
 *
 * The DIFF side (`DeployEngine.redactParametersForDiff`) binds this for every
 * parameter, and the PERSIST side ({@link positionByInheritedParameter})
 * writes it for a leaf the child template spells `{Ref: <Param>}`. One
 * function, so the two cannot disagree on any input.
 *
 * Before #2349 the persist side certified through the same predicate but FELL
 * THROUGH to a value scan of the CHILD resource's bag, whose one slot per
 * plaintext holds whichever parameter's own expression resolved LAST, while
 * the diff side fell through to the parent's collapsed survivor. Two shapes
 * reached it: an element that EMBEDS the plaintext, and a bare one whose
 * parameter's association was refused while a sibling's survived. Either way
 * the next diff reported a change that no deploy could clear.
 */
export function redactInheritedParameterValue(
  parentSecrets: RecordedSecretValues,
  parameterName: string,
  value: unknown
): unknown {
  return (
    inheritedParameterExpression(parentSecrets, parameterName, value) ??
    redactSecretsForState(value, parentSecrets)
  );
}

/**
 * Persist a nested-stack child leaf spelled exactly `{Ref: <Param>}` as
 * {@link redactInheritedParameterValue} answers it, so the persisted value is
 * the diff side's desired value by construction (issue #2349).
 *
 * `undefined` (the caller keeps its existing arms) unless ALL of:
 *
 * 1. the source is a single-key `{Ref: <string>}`;
 * 2. this resource's own resolution read that parameter while its value
 *    carried an inherited secret ({@link recordInheritedParameterRead}). That
 *    is the #2087 scope: a resource that never consumed the parameter has no
 *    record, and a leaf of a resource that did is the parameter's own value,
 *    which is all the parent bag is asked about;
 * 3. the leaf is a string or a list, the two shapes a parameter takes once
 *    `coerceParameterValue` has run (a number that carried a secret is refused
 *    upstream by `refuseCoercedInheritedSecret`);
 * 4. FAIL-CLOSED, on the ORIGINAL value: it carries no child-bag key the
 *    parent does not hold (a child-only plaintext, needle or mask-only, which
 *    the parent scan would leave or cut apart where a parent needle overlaps
 *    it), and no child NEEDLE the parent holds only as mask-only (no parent
 *    needle, so cut apart the same way), and no parent needle the child bag
 *    lacks (which the parent scan could take first, cutting an overlapping
 *    child plaintext); and the answer holds nothing the child bag would still
 *    rewrite. The existing arms
 *    redact with the child bag, so falling back to them keeps every leaf at
 *    least as redacted as before #2349; only the agreement with the diff
 *    side is given up, on that row alone.
 */
export function positionByInheritedParameter(
  bag: unknown,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): unknown {
  const keys = Object.keys(source);
  if (keys.length !== 1 || keys[0] !== 'Ref') return undefined;
  const name = source['Ref'];
  if (typeof name !== 'string') return undefined;
  const reads = inheritedParameterReads.get(secrets);
  if (reads === undefined || typeof reads === 'symbol' || !reads.names.has(name)) {
    return undefined;
  }
  if (typeof bag !== 'string' && !Array.isArray(bag)) return undefined;
  // Condition 4, asked of the ORIGINAL value: a child-only plaintext the
  // parent-bag scan could cut apart (a parent needle overlapping it) would
  // leave fragments the answer's own re-scan can no longer find.
  if (carriesChildOnlyPlaintext(bag, secrets, reads.parent)) return undefined;
  const answer = redactInheritedParameterValue(reads.parent, name, bag);
  // ...and of the answer, for a parent expression that itself spells a
  // child needle. Deep equality, not identity: the value walk rebuilds every
  // array it visits, so `!==` would refuse every list leaf.
  if (!deepEqualJsonValue(redactSecretsForState(answer, secrets), answer)) return undefined;
  return answer;
}

/**
 * Does any string leaf of `value` contain a child-bag KEY the parent-bag scan
 * would not redact the way the child scan does? Two halves, mirroring the
 * child scan's whole-value arm (every key) and its substring arm (needles):
 *
 * - a key the parent does not HOLD at all -- needle or mask-only alike, since
 *   a parent needle overlapping it cuts it apart where the child scan took it
 *   whole;
 * - a child NEEDLE the parent holds only as mask-only, which is no parent
 *   needle, so the parent scan can cut it apart the same way.
 *
 * - a parent NEEDLE (at or above `MIN_NEEDLE_LENGTH`) the child bag does not
 *   hold, which the parent scan could take first and so cut a child plaintext
 *   overlapping it.
 *
 * A key both bags hold as needles, with different expressions, passes: that is
 * the #2349 row itself. Containment at ANY length; declining keeps the
 * pre-#2349 child-bag redaction.
 */
function carriesChildOnlyPlaintext(
  value: unknown,
  childSecrets: RecordedSecretValues,
  parentSecrets: RecordedSecretValues
): boolean {
  const parentNeedles = new Set(substringNeedlesOf(parentSecrets));
  const childNeedles = new Set(substringNeedlesOf(childSecrets));
  const childOnly = [...childSecrets.keys()].filter(
    (plaintext) =>
      plaintext !== '' &&
      (!parentSecrets.has(plaintext) ||
        (childNeedles.has(plaintext) && !parentNeedles.has(plaintext)))
  );
  // Third half: a PARENT needle the child bag does not hold. Today
  // `inheritedSecretsCarriedBy` puts every parent needle the value carries
  // into the child bag; asked here so the guarantee does not rest on that.
  // Floored at `MIN_NEEDLE_LENGTH`: the parent scan never takes a shorter key
  // as a substring, so it cannot cut anything (the first two halves stay
  // unfloored, as they guard the child's whole-value arm).
  for (const needle of parentNeedles) {
    if (needle.length >= MIN_NEEDLE_LENGTH && !childSecrets.has(needle)) childOnly.push(needle);
  }
  if (childOnly.length === 0) return false;
  const visit = (node: unknown): boolean => {
    if (typeof node === 'string') return childOnly.some((plaintext) => node.includes(plaintext));
    if (Array.isArray(node)) return node.some(visit);
    if (node !== null && typeof node === 'object') return Object.values(node).some(visit);
    return false;
  };
  return visit(value);
}
