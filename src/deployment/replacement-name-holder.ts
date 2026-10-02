/**
 * Who holds a replacement's colliding name. Three questions:
 * {@link replacementRequestsDifferentName} (deploy: a KNOWN different explicit
 * name), and one proof per direction, sharing one rule —
 * {@link reverseReplacementNewHoldsName} (rollback) and
 * {@link replacementOldHoldsSentName} (deploy `--replace`), further down.
 *
 * Does a replacement ask for a physical name the resource being replaced does
 * NOT hold? (issue [#3808](https://github.com/go-to-k/cdkd/issues/3808))
 *
 * The replacement name-collision refusals presume the colliding name is held by
 * the old resource, and prescribe deleting that resource first (`--replace`, or
 * dropping `UpdateReplacePolicy: Retain`). That holds only when the replacement
 * keeps the name. When it CHANGES it — the template's explicit name property now
 * says something the old resource was never called — the holder is some other
 * resource, deleting the old one frees nothing, and the advice ends with the
 * managed resource gone and the same collision.
 *
 * Answers only when the difference is KNOWN; `undefined` otherwise, which keeps
 * the callers' pre-existing wording and behaviour. The asymmetry is deliberate:
 * a positive answer REFUSES the delete-first retry, so it must not fire on a
 * replacement that keeps its name.
 *
 * - The desired name is the TEMPLATE's explicit name property
 *   ({@link explicitNamePropertyFor}). With none, the answer is `undefined`:
 *   a generated name is not compared, so a replacement that DROPS an explicit
 *   name keeps the pre-existing behaviour (go-to-k/cdkd#3931 carries it).
 * - The held name is the state record's recorded, then observed, value of the
 *   OLD type's name property. A recorded value is the TEMPLATE's, which a
 *   provider may normalise before AWS sees it (IAM's `_` to `-`), so a physical
 *   id that names the desired name overrides a differing recorded one.
 * - With no held name, the physical id alone decides, and only when it does
 *   NOT name the desired name: equal, or a final segment after `|`, or after
 *   `:` / `/` in an ARN or a URL (a name-shaped id may contain `/`), or, in a Secrets Manager ARN, that segment plus its
 *   6-character suffix. Anything else — an opaque id like `sg-…` included — counts as
 *   different, which refuses without deleting.
 * - Names compare case-insensitively: several services (IAM among them) treat
 *   two spellings differing only in case as one name. The cost, on a
 *   case-sensitive service, is keeping `--replace` for a case-only rename.
 * - A redacted value ({@link SECRET_MASK}) or an unresolved dynamic reference
 *   (`{{resolve:…}}`, which state keeps as written) is not a name: skipped.
 *
 * This module is a barrel: the implementation lives in
 * `replacement-name-holder/*.ts` (issue #4463), and it re-exports exactly the
 * names it always exported, so no importer changes.
 */
export {
  type ReplacementNameChange,
  replacementRequestsDifferentName,
  replacementCreateAdoptsName,
  replacementNameProbe,
  type CreateNameQuestion,
  createNameQuestion,
  createLookupArn,
  probeErrorMeansNameHeld,
  renderReplacementNameChange,
  replacementOrderIsCaseSensitive,
  replacementMovesEventBus,
  probeFoundSameId,
  nameAdoptingSdkCreateTypes,
} from './replacement-name-holder/deploy-name.js';
export {
  type ReplayPrefixChoice,
  replayPrefixChoice,
  rewrittenNameSpellings,
  replacementSentNameMoves,
  maskRewrittenSentName,
  reverseReplacementRewrittenNameTypes,
  reverseReplacementCaseInsensitiveTypes,
  reverseReplacementVerbatimGeneratedTypes,
  reverseReplacementTrustsGeneratedName,
} from './replacement-name-holder/rewritten.js';
export {
  reverseReplacementNameKeyKind,
  type ReverseReplacementHolderVerdict,
  replacementDerivedGeneratedNames,
} from './replacement-name-holder/holder-probe.js';
export {
  reverseReplacementNewHoldsName,
  type ReverseReplacementHolderInput,
  replacementOldHoldsSentName,
  renderNameHeldElsewhere,
} from './replacement-name-holder/holder.js';
