/**
 * Pre-stringify secret-mask critic for provider message sites (issue #2178).
 *
 * WHAT THIS CHECKS
 * ----------------
 * `.claude/rules/provider-masking.md` has said since issue #1932 that a
 * provider interpolating a value derived from the `properties` bag into a
 * message must run it through the masker, and since issue #2176 that the walk
 * must happen BEFORE `JSON.stringify`, not after:
 *
 *  1. ESCAPING. `JSON.stringify` escapes `"`, `\` and newlines, so a secret
 *     containing any of them no longer OCCURS in the finished line and a
 *     message-level mask cannot find it. Measured on the pre-#2176 tree:
 *     `{"user":"admin","pw":"hunter2"}` came through a message-level mask
 *     COMPLETELY unchanged, while masking the leaves first rendered `"***"`.
 *  2. LENGTH. A finished message is longer than the value inside it, so it
 *     reaches only `maskSecretsInText`'s SUBSTRING arm, which ignores needles
 *     below `MIN_NEEDLE_LENGTH` (4). A 3-character secret survives.
 *
 * The rule was prose, and prose was not enough: the issue #2176 sweep found raw
 * `${JSON.stringify(...)}` sites sitting in files that had ALREADY been
 * hardened for this exact contract — `dynamodb-table-provider.ts` masked one
 * argument of a `warn` call and left the argument beside it raw, and
 * `sns-topic-provider.ts` carried seven masked sites and one raw. A rule
 * already written and violated anyway is the case where another sentence buys
 * nothing and a mechanical check is the remedy
 * (`.claude/skills/work-issues/references/retro.md` section 10-b).
 *
 * WHY THE OBVIOUS RULE DOES NOT WORK
 * ----------------------------------
 * "every `${JSON.stringify(X)}` must have X wrapped in `maskDeep(...)`" was
 * drafted, CALIBRATED against the tree, and false-positives on correct code
 * where the mask is UPSTREAM of the stringify rather than inside it:
 *
 *   - `asg-provider.ts` builds `const expectedSorted = [...expected].sort()
 *     .map((a) => maskSecrets(a))` one line above the interpolation. Every
 *     element is already masked.
 *   - `cloudfront-distribution-provider.ts` assigns
 *     `const comment = typeof config['Comment'] === 'string'
 *       ? maskSecrets(config['Comment']) : ''` and interpolates `comment`.
 *
 * Both are correct, and a fence that reds them would be argued down within a
 * release. So the check is DATAFLOW-aware: does the stringified expression
 * reach a masker anywhere upstream, through local `const` / `let` bindings,
 * `?:` / `??` arms, array and object literals, `.map()` callbacks, and helper
 * calls resolved to a FIXPOINT?
 *
 * WHAT THE POPULATION IS, AND WHY IT IS NOT DERIVED FROM THE DEFECT
 * -----------------------------------------------------------------
 * Every `JSON.stringify(...)` call INTERPOLATED into a template literal, found
 * by walking the AST rather than by matching lines. Two reasons the scanner has
 * to be a parser:
 *
 *  - a line-based regex MISSES a multi-line site — `dynamodb-table-provider.ts`
 *    and `lambda-function-provider.ts` both wrap the argument onto its own
 *    line;
 *  - and it MIS-REPORTS one — `sns-topic-provider.ts:1303` is masked via
 *    `maskValue(input)` on the line AFTER the `JSON.stringify(`.
 *
 * The population is deliberately NOT "sites that look wrong". Deleting a
 * `maskDeep` wrap KEEPS the site in the population and flips its verdict, so
 * the fence goes RED rather than having the site quietly drop out.
 *
 * WHAT COUNTS AS MASKED
 * ---------------------
 * A site is `masked` when {@link isMasked} accepts the stringified expression:
 * it is a call to a masker, a constant, or a composition of accepted parts.
 * Everything else — a bare parameter, a property or element access, a
 * `JSON.parse` result, an unmasked binding — is `raw`.
 *
 * The MASKER SET is DERIVED per file rather than hardcoded to `maskDeep`,
 * because the tree spells the same capability six ways. Roots:
 *
 *  - `maskDeep` imported from `masked-retry-logger.js` (import ALIASES
 *    resolved — a name-only match stops seeing a renamed site silently);
 *  - any binding or parameter DECLARED as `SecretMasker` / `MaskerFn`, which
 *    is how `maskLeafValue(value, maskSecrets: SecretMasker)` threads it;
 *  - any binding initialized from `maskerOrIdentity(...)`;
 *  - any binding initialized from a `.maskSecrets` read, i.e. the
 *    `context?.maskSecrets` the contract threads.
 *
 * Grown to a FIXPOINT, because the tree threads maskers through helpers:
 *
 *  - a local function whose every `return` is `<masker>(<its first parameter>,
 *    ...)` is itself a masker — `const maskLeaf = (v) => maskDeep(v, m)`
 *    (apigatewayv2, sns-topic), `maskLeaves` (cognito), `maskLeafValue`
 *    (both DynamoDB providers);
 *  - a PARAMETER that every call site hands a masker becomes a masker inside
 *    that function — `sns-topic-provider.ts`'s
 *    `normalizeDeliveryStatusProtocolOrThrow(..., maskValue)`, whose single
 *    caller passes `maskLeaf`. EVERY call site must pass one and there must be
 *    at least one; an EXPORTED function is refused outright, since its callers
 *    are not all visible here. That parameter's masker-ness is scoped to its
 *    own function rather than pooled per file, so a same-named parameter
 *    elsewhere cannot borrow it.
 *
 * WHAT DEFENDS THIS CHECKER FROM ITSELF
 * -------------------------------------
 * Two failure modes needing two different mechanisms, per the sibling critics:
 *
 *  1. COLLAPSE TOWARD ZERO — the parse yields nothing (a renamed directory, a
 *     compiler-API change, a file that stops parsing). The FLOORS below catch
 *     it: minimum files scanned, sites found, masked sites, files carrying a
 *     site, and derived masker names — plus a hard failure on ANY file with
 *     parse diagnostics, since an unparseable file contributes zero sites and
 *     reads exactly like a clean one.
 *  2. COLLAPSE TOWARD GREEN — {@link isMasked} degrades so everything reads as
 *     masked. No floor can see that: the counts are unchanged and the printed
 *     line is byte-identical. The SELF-PROBES catch it — fixed sources with
 *     known verdicts INCLUDING `raw` ones, analyzed on every run before the
 *     real tree is touched. Making `isMasked` return true unconditionally
 *     fails them.
 *
 *     Each ACCEPT arm needs its own PAIR of probes and shipped without them:
 *     review measured that emptying `MASK_PRESERVING_METHODS`, deleting the
 *     `+` / `&&` arm and making the template arm `return true` each left a
 *     real-tree run at exit 0 with every probe green. An accept probe dies
 *     when the arm is DELETED and a refuse probe dies when it degrades to
 *     `return true`; one alone leaves the other direction unfenced.
 *
 *     There is a THIRD collapse the two above do not name, and this critic
 *     shipped with it: COLLAPSE TOWARD A MASKER THAT MASKS NOTHING. An
 *     identity function typed `MaskerFn` used to be a masker root, so a raw
 *     site could be silenced with `maskerOrIdentity(undefined)` at exit 0 —
 *     and it COUNTED toward `MIN_MASKED_SITES`, inflating the floor that is
 *     supposed to notice the derivation failing. Issue #2007 states the
 *     principle this violates: a masker that fences nothing is worse than no
 *     masker, because its presence stops the next author looking.
 *     {@link isIdentityMaskerInitializer} refuses it, with four probes.
 *
 *     That refusal is SCOPED to the function that declares the binding (issue
 *     #2269 finding 2). Pooled per FILE, one `const mask =
 *     maskerOrIdentity(undefined)` in `delete()` reddened the correct `const
 *     mask = maskerOrIdentity(context?.maskSecrets)` in `create()`, and `mask`
 *     is the commonest local name in these providers. Scoping it alone would
 *     trade that false positive for a false NEGATIVE, since `names` is still a
 *     file-wide pool and the sibling's real binding would credit the delete
 *     arm — so {@link maskersAt} SUBTRACTS the refusals in scope at a site from
 *     the names in scope at it, and a wrapper declared inside a function is
 *     recorded at that function's scope rather than file-wide.
 *
 *     A FOURTH way to reach a masker that masks nothing, found by issue
 *     #2269's differential fence rather than by its finding list: LAUNDERING
 *     one through a named wrapper. `const mask = maskerOrIdentity(undefined);
 *     const maskLeaf = (v) => maskDeep(v, mask)` made `maskLeaf` a masker,
 *     because {@link wrapsFirstParameter} read only the CALLEE and never the
 *     masker the wrapped call was handed. Both spellings of the wrapper — the
 *     named one and the inline one — now judge that argument exactly as a site
 *     would, with an accept twin so the rule cannot degrade into refusing every
 *     wrapper (four real files use one).
 *
 * KNOWN BOUNDS, stated rather than discovered later
 * -------------------------------------------------
 *  (1) Only TEMPLATE interpolation is a site. A `'text ' + JSON.stringify(x)`
 *      concatenation is not — measured zero such sites in the scanned tree, so
 *      widening it today would fence nothing and calibrate against nothing.
 *      FENCED rather than merely stated (`MAX_CONCAT_SITES`): the count is
 *      measured on every run and anything above zero FAILS, so the bound
 *      cannot stop being true silently. A self-probe pins that the counter
 *      still SEES the shape, or the fence would go inert with the same
 *      byte-identical green.
 *  (2) `isMasked` is flow-INSENSITIVE for a binding: it resolves an identifier
 *      to the nearest LEXICAL declaration with an initializer, so a `let`
 *      reassigned after its declaration is judged on the declaration. Under-
 *      and over-crediting are both possible; the shape does not occur today.
 *  (3) A constant is accepted as masked. A string literal cannot carry a
 *      resolved secret, and refusing it would red the `: ''` arm of the real
 *      `cloudfront-distribution-provider.ts` binding.
 *  (4) A no-op DECLARED to be the capability is believed. This critic is
 *      syntactic: the declaration is the only evidence it has, so
 *      `const M: MaskerFn = someNoOp` and `{ maskSecrets: (t) => t }` are both
 *      accepted in the masker-ARGUMENT position. MEASURED, not assumed — both
 *      run green today and are pinned as self-probes expecting `masked`, so
 *      closing the bound fails here and forces this paragraph to change with
 *      it. What the argument allow-list buys is that the DEFAULT flipped: an
 *      unrecognised expression is now refused rather than accepted, so
 *      silencing a site takes a deliberate mis-declaration rather than any of
 *      the unbounded ways to spell a no-op. State the fence as "the value
 *      reached something declared to be the project's masker", never as "the
 *      value is masked".
 *
 *      RESTATED for issue #2269 finding 1, because the bound used to be WIDER
 *      than this paragraph said. Every masker position accepted any property
 *      access whose FINAL name landed in the file's derived set, so with ~108
 *      derived names tree-wide `const junk = { maskLeaf: (t) => t }` bought
 *      both `maskDeep(p, junk.maskLeaf)` and `junk.maskLeaf(p)` a `masked`
 *      verdict — the fence read "the value reached something whose last
 *      identifier collides with a masker name", which is not what any artifact
 *      claimed. What survives the narrowing, and is exactly what "DECLARED to
 *      be the capability" should have meant:
 *
 *        - `maskSecrets` — the CONTRACT's own property name — on ANY receiver.
 *          That is the declaration a syntactic critic can read, and closing it
 *          is a different change; `{ maskSecrets: (t) => t }` stays pinned as
 *          accepted.
 *        - a DERIVED name (`maskLeaf`, `maskValue`, an aliased `maskDeep`) only
 *          off a receiver the provider owns — `this`, or a chain rooted at it.
 *          A derived name is INFERRED from the file rather than declared by the
 *          contract, so a collision with an unrelated object is an accident.
 *
 *      FREE against the real tree, which is why the narrowing shipped rather
 *      than only this restatement: the corpus's only property-access maskers
 *      are `this.maskErrorMessage` (18) and `this.maskedRetryLogger` (5).
 *      See {@link isMaskerPropertyAccess}.
 *
 *  (5) A bare `logger.warn(JSON.stringify(x))` — the stringify handed STRAIGHT
 *      to a message sink, with neither a template nor a `+` — reaches the same
 *      sink as a site and is NOT classified. Measured at zero in the scanned
 *      tree (the only two bare-argument stringifies are a `Buffer.from(...)`
 *      and a `createHash('sha256').update(...)`, neither a message), so
 *      widening the population today would fence nothing. FENCED rather than
 *      merely stated, like bound (1):
 *      `MAX_BARE_SINK_SITES` counts the shape on every run and anything above
 *      zero FAILS, with an accept probe pinning that the counter still SEES it
 *      and a refuse twin pinning that it stays scoped to a SINK. Issue #2269
 *      finding 3, which the first cut left neither classified NOR counted.
 *
 *      FOUR things this bound is looser about than its name suggests, stated
 *      because an over-claimed fence is the failure this critic exists to
 *      prevent — and the DIRECTION of each is stated too, because a blanket
 *      "all of these are fail-closed" would be that same over-claim committed
 *      inside the remedy. ONE of the four is fail-CLOSED (it can only make the
 *      counter fire); THREE are fail-OPEN (they can hide a site), each measured
 *      at zero live hits today:
 *
 *        - FAIL-OPEN. A MASKED bare sink is not counted at all. The value
 *          reached the masker, so it is correct code — counting it failed CI
 *          over `throw this.wrapError(JSON.stringify(maskDeep(v, m)))`, and a
 *          guard that reds correct code is worse than the miss it replaced. The
 *          decision is {@link isMasked}'s, the same one the interpolated-site
 *          path makes, so the two cannot drift — which also means it inherits
 *          bound (4): what was established is that the value reached something
 *          DECLARED to be the project's masker, never that it was masked. Such
 *          a site is still NOT classified.
 *        - FAIL-CLOSED. {@link receiverNamesInclude} matches ANY name in a
 *          receiver chain, so `opts.db.error(...)` and
 *          `getLogger().db.error(...)` count; and the FACTORY arm ignores the
 *          receiver entirely, so a local `wrapError` helper or
 *          `registry.handleError(...)` counts. Deliberate: a counter fenced at
 *          zero should over-reach rather than under-reach, and narrowing it
 *          would re-open the direction this round just closed.
 *        - FAIL-OPEN. An ALIASED logger escapes:
 *          `const sink = this.logger; sink.warn(...)` counts zero, because the
 *          receiver is judged syntactically with no binding resolution.
 *          Recorded rather than fixed — it needs the dataflow walk
 *          {@link isMasked} has and this counter does not, and the corpus
 *          spells no such alias.
 *        - FAIL-OPEN. The counter accepts a factory in ANY position (measured:
 *          `const e = this.wrapDeleteError(JSON.stringify(p))` counts 1), but
 *          the completeness guard that keeps {@link isErrorFactoryName}'s name
 *          set honest enumerates only `throw <call>(...)` callees. So a factory
 *          that is neither in the set nor named `wrap<X>Error` AND is used only
 *          in non-throw position — `const e = buildError(JSON.stringify(v))` —
 *          escapes BOTH, and nothing in this file would say so. Measured at
 *          zero rather than assumed: the whole corpus has exactly TWO calls
 *          taking a bare `JSON.stringify` outside the sink set, `Buffer.from`
 *          and `createHash('sha256').update`, and neither builds a message, so
 *          the escaping population is empty today. Closing it needs the
 *          dataflow this counter does not have — following a binding to the
 *          `throw` that consumes it.
 *
 * USAGE
 *   node --experimental-strip-types scripts/check-provider-secret-mask.ts
 *   node --experimental-strip-types scripts/check-provider-secret-mask.ts --json
 *   node --experimental-strip-types scripts/check-provider-secret-mask.ts \
 *     --providers-dir=/tmp/scratch-copy    (test seam; probes never touch src/)
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript-v6';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const PROVIDERS_ROOT_REL = join('src', 'provisioning', 'providers');
const DEFAULT_PROVIDERS_DIR = join(REPO_ROOT, PROVIDERS_ROOT_REL);

/**
 * Files scanned in ADDITION to the providers directory, named relative to its
 * PARENT so the `--providers-dir=` seam carries them.
 *
 * `composite-id.ts` is issue #2176's other masking site: `packCompositeId` /
 * `compositeIdSeparatorRefusal` take a masker and mask the quoted segment
 * value RAW, which is one root cause behind 22 call sites across eight
 * providers. It carries no interpolated stringify today, and it is in scope
 * anyway so that adding one lands inside the fence rather than outside it.
 * A missing entry FAILS rather than being skipped.
 */
const EXTRA_FILES: readonly string[] = ['composite-id.ts'];

/** The shared deep-mask walk, and the module that exports it. */
const MASK_WALK_FN = 'maskDeep';
const MASKER_DEFAULT_FN = 'maskerOrIdentity';
/**
 * The module that exports the shared walk, matched by SEGMENT rather than by
 * suffix.
 *
 * `endsWith('masked-retry-logger.js')` — the first spelling — accepts
 * `./my-masked-retry-logger.js`, a file this repo does not have and a reviewer
 * could add, whose `maskDeep` would then be credited as the shared capability
 * on provenance it does not have. The specifier is resolved against the
 * IMPORTING file instead, so the match is on a whole path segment.
 */
const MASK_MODULE_BASENAME = 'masked-retry-logger.js';
const MASK_MODULE_PATH = join('src', 'provisioning', MASK_MODULE_BASENAME);
/** Type names that DECLARE a value to be the provider-facing masker. */
const MASKER_TYPE_NAMES: ReadonlySet<string> = new Set(['SecretMasker', 'MaskerFn']);
/** The contract's property name for the capability on `CreateContext` / `UpdateContext`. */
const MASKER_CONTEXT_PROPERTY = 'maskSecrets';

/**
 * Array / string methods that PRESERVE the masked-ness of what they are called
 * on, so the walk may look through them at the receiver.
 *
 * `map` is deliberately NOT here — it REPLACES each element, so it is handled
 * separately by inspecting the callback body. Treating it as transparent would
 * credit `[...secrets].map((s) => s.raw)` for its receiver's masking.
 */
const MASK_PRESERVING_METHODS: ReadonlySet<string> = new Set([
  'concat',
  'filter',
  'flat',
  'join',
  'reverse',
  'slice',
  'sort',
  'toReversed',
  'toSorted',
]);

// ---------------------------------------------------------------------------
// EXEMPTIONS — narrow, reasoned, and RE-AUDITED on every run
// ---------------------------------------------------------------------------

export interface Exemption {
  /** Repo-relative path of the file carrying the site. */
  readonly file: string;
  /** The stringified expression, whitespace-normalized exactly as reported. */
  readonly expression: string;
  /** How many RAW sites in that file carry that expression. Exact, not a floor. */
  readonly count: number;
  readonly reason: string;
}

/**
 * Sites deliberately outside the rule, or outside THIS change's edit scope.
 *
 * Keyed by file + the normalized stringified EXPRESSION rather than by line, so
 * an unrelated edit above does not silently re-point an entry, and a genuinely
 * NEW raw site in the same file still fails. `count` is exact: a second site
 * spelled the same way is a new defect, not a covered one.
 *
 * {@link auditExemptions} re-checks every entry on every run — an entry whose
 * file is gone, whose expression no longer appears, whose site has become
 * MASKED, or which gained a same-spelled sibling fails the build. The
 * became-MASKED arm is the one that had to be ADDED after review: the first cut
 * of this critic asserted it here and in four other places while the code only
 * ever compared file plus expression, so the retirement path these entries are
 * actually waiting on was the one direction that stayed silent. An exemption
 * nobody re-checks goes inert exactly when it stops being needed, and then
 * hides the next real entry.
 *
 * TWO categories, and they retire differently. A THIRD is gone: nine OTHER-LANE
 * rows recorded raw sites in `dynamodb-table-provider.ts`,
 * `dynamodb-globaltable-provider.ts` and `s3-bucket-provider.ts` while issue
 * #2177's per-family lanes owned those files. Both lanes merged (PRs #2248 and
 * #2251), so all nine were FIXED at the source and their rows dropped — which
 * is the retirement this mechanism exists to force, and it is the case the
 * verdict check below had to be added for: those sites now read `masked`, and
 * an audit that never looked at a verdict would have kept reporting them
 * exempt.
 *
 * The remaining categories:
 *
 *  - IMPORT PATH. `resolvePhysicalId` runs under `cdkd import`, reading a
 *    template whose dynamic references are NOT resolved (the messages
 *    themselves say so: "intrinsic-valued entries like {Ref: <Bucket>} are not
 *    resolved at import time"). `ImportInput` carries no masker by the
 *    contract, and there is no secret bag on that path to build one from — so
 *    there is nothing to mask and nothing to thread. These retire only if the
 *    import path ever gains a resolved bag.
 *  - DELETE PATH. `DeleteContext` carries no masker by the same contract, and
 *    `src/types/resource.ts` requires the capability to be THREADED (issue
 *    #2007) before a delete-path message may claim to mask. The custom-resource
 *    payload refusal has a DELETE arm and a create / update arm; the second is
 *    masked and fenced, the first is recorded HERE rather than handed a
 *    `maskerOrIdentity(undefined)` that would count toward the masked total
 *    while protecting nothing. That is what this entry buys over the spelling
 *    it replaced: the gap is COUNTED and re-audited every run instead of
 *    hiding inside the green number. It retires when `DeleteContext` gains the
 *    capability — at which point the site becomes masked and the audit fails.
 */
const EXEMPT: readonly Exemption[] = [
  // --- IMPORT PATH -------------------------------------------------------
  {
    file: 'src/provisioning/providers/s3-bucket-policy-provider.ts',
    expression: 'bucket',
    count: 1,
    reason:
      'import path: `resolvePhysicalId` reads an UNRESOLVED template and `ImportInput` carries ' +
      'no masker by the SecretMaskingContext contract, so no dynamic reference has been ' +
      'resolved to plaintext here',
  },
  {
    file: 'src/provisioning/providers/sns-topic-policy-provider.ts',
    expression: 'topics',
    count: 1,
    reason:
      'import path: `resolvePhysicalId` reads an UNRESOLVED template and `ImportInput` carries ' +
      'no masker by the SecretMaskingContext contract',
  },
  {
    file: 'src/provisioning/providers/sqs-queue-policy-provider.ts',
    expression: 'queues[0]',
    count: 1,
    reason:
      'import path: `resolvePhysicalId` reads an UNRESOLVED template and `ImportInput` carries ' +
      'no masker by the SecretMaskingContext contract',
  },
  // --- DELETE PATH -------------------------------------------------------
  {
    file: 'src/provisioning/providers/custom-resource-provider.ts',
    expression: 'parsed',
    count: 1,
    reason:
      'delete path: `DeleteContext` carries no masker by the SecretMaskingContext contract, and ' +
      'issue #2007 requires the capability to be THREADED before a delete-path message may claim ' +
      'to mask — see DELETE_PATH_UNMASKED; the create / update arm of the same refusal IS masked',
  },
];

// ---------------------------------------------------------------------------
// FLOORS — "found nothing" must never read as "everything is masked"
// ---------------------------------------------------------------------------
/** Minimum `.ts` files a healthy scan walks. Measured 83. */
const MIN_FILES_SCANNED = 60;
/** Minimum interpolated `JSON.stringify` sites a healthy scan FINDS. Measured 41. */
const MIN_SITES = 30;
/**
 * Minimum sites a healthy scan finds MASKED.
 *
 * A separate floor from the site count because they collapse for different
 * reasons: the site floor dies if the template-span walk breaks, this one if
 * the masker DERIVATION breaks (which would report every site raw and fail for
 * a misleading reason). Measured 37 after this change's sweep (19 before it):
 * 28 after the seven-provider threading, plus the 9 sites that were EXEMPT
 * while issue #2177's DynamoDB and S3 lanes owned their files and were closed
 * here once those lanes merged (PRs #2248 and #2251).
 *
 * WHAT THIS FLOOR CAN AND CANNOT FIRE ON, because 20 looks live and is not.
 * On a run that is otherwise PASSING, `masked === sites - exempt` (raw is zero
 * by definition of passing), so with `exempt` at 4 and MIN_SITES at 30 this
 * floor cannot be the first thing to break: the site floor gets there first.
 * It fires only on a run that is ALREADY failing for another reason — a
 * derivation collapse reports every site `raw`, which is a hard failure per
 * site, and this floor then adds the one line that names the collapse as a
 * collapse rather than leaving 37 individually-plausible site failures. That
 * is its real job, and `floors are observed failing by label` in the suite
 * pins it in exactly that state rather than in a passing one.
 *
 * It is ALSO the backstop for a future large EXEMPT set: once exemptions pass
 * ~11 entries, `sites - exempt` drops below this floor while the site count
 * stays healthy, which is the one shape no other floor sees. Retuning it
 * upward today would make it fire before MIN_SITES on a healthy tree and
 * report the wrong cause, so it stays at 20 deliberately.
 */
const MIN_MASKED_SITES = 20;
/** Minimum distinct files carrying at least one site. Measured 18. */
const MIN_FILES_WITH_SITES = 12;
/**
 * Minimum DERIVED masker names across the scanned tree.
 *
 * The fence on the derivation itself. It regresses independently of everything
 * above: an import-alias or type-annotation regression leaves every count
 * identical and simply stops recognising the capability. Measured 97.
 *
 * DELIBERATELY LOOSE at 36% of the measurement, and this line records why so a
 * later reader does not "tighten" it believing that improves anything. The
 * derivation's four ROOTS were each broken in turn against the real tree and
 * every one of them was caught by a SELF-PROBE, not by this floor — the probes
 * name the failing spelling while a floor only says a number moved. So the
 * floor's job is the total collapse (a compiler-API change, a renamed
 * directory), which lands far below 35; tightening it toward 98 buys no
 * detection and makes an ordinary provider deletion fail for a misleading
 * reason.
 */
const MIN_MASKER_NAMES = 35;

/**
 * KNOWN BOUND (1), fenced rather than merely stated.
 *
 * Only TEMPLATE interpolation is a site. A `'text ' + JSON.stringify(x)`
 * concatenation reaches exactly the same sinks and is NOT classified —
 * measured zero such sites in the scanned tree, which is why widening the
 * population today would fence nothing and calibrate against nothing. A stated
 * bound with no fence stops being true silently, so the count is measured on
 * every run and anything above this FAILS: the author either writes the
 * template form or widens {@link isInterpolated}'s population and re-calibrates
 * the floors.
 */
const MAX_CONCAT_SITES = 0;

/**
 * KNOWN BOUND (5), fenced rather than merely stated (issue #2269 finding 3).
 *
 * A `logger.warn(JSON.stringify(x))` — the stringify handed STRAIGHT to a
 * message sink, with no template and no `+` — reaches exactly the same sink as
 * the two spellings above and was, until this constant existed, neither
 * classified NOR counted: {@link isConcatOperand} fences only `+` operands, so
 * the shape fell out of the population silently. Measured at zero in the
 * scanned tree — and that zero is now MEASURED against the whole population
 * rather than against the shape the first matcher happened to see. Re-derived
 * 2026-08-27 over `src/provisioning/providers/**` plus `composite-id.ts`:
 * 331 `JSON.stringify` calls total = 41 interpolated SITES + 0 concat operands
 * (bound 1) + 0 bare message sinks (this bound) + 290 residue, and the residue
 * is entirely NON-message: 228 deep-equality comparisons (`!==` 172, `===` 56),
 * 41 `?:` value arms, 10 `return`s, 6 arrow bodies, one `??`, one `=`, one
 * `Message: JSON.stringify(request)` on an SNS `PublishCommand` at
 * `custom-resource-provider.ts:2182`, one `createHash('sha256').update(...)` at
 * `cloudwatch-anomaly-detector-provider.ts:421` and one `Buffer.from(...)`.
 * None is a sink; whether such a VALUE later reaches a message is decided at
 * the interpolation, which is already in the population.
 * It is the same deferred-because-empty shape bound (1)
 * already handles, and it gets the same treatment rather than a sentence: the
 * count is taken on every run and anything above this FAILS. A self-probe pins
 * that the counter still SEES the shape, and a refuse twin pins that it is
 * scoped to a SINK rather than to any call taking a stringify (the tree has two
 * of those — `Buffer.from(...)` and `createHash('sha256').update(...)` — and
 * neither is a message).
 */
const MAX_BARE_SINK_SITES = 0;

/**
 * Rounds the masker-set growth loop may take before it gives up.
 *
 * Hitting it is REPORTED rather than swallowed — see
 * {@link MaskerSet.fixpointTruncated}.
 */
const MAX_FIXPOINT_ROUNDS = 10;

/**
 * Method names a message SINK spells, for known bound (5).
 *
 * `log` is included because `console.log` is one; the RECEIVER check below is
 * what keeps an unrelated `x.log(...)` out.
 */
const MESSAGE_SINK_LEVELS: ReadonlySet<string> = new Set([
  'debug',
  'error',
  'info',
  'log',
  'trace',
  'warn',
]);

/**
 * Receivers whose `.warn` / `.debug` is a MESSAGE sink.
 *
 * Named rather than accepting any object with a `warn`, which is the same
 * receiver-blindness issue #2269 finding 1 records one function below. The set
 * is DERIVED from the corpus rather than imagined — every receiver of a
 * level-named call under the scanned tree. Re-derive with (one line, from the
 * repo root):
 *
 *   node --experimental-strip-types -e "const ts=require('typescript-v6');\
 *   const {readdirSync,readFileSync,statSync}=require('node:fs');\
 *   const {join}=require('node:path');const L=new Set(['debug','error','info',\
 *   'log','trace','warn']);const c=new Map();const w=d=>{for(const e of \
 *   readdirSync(d)){const f=join(d,e);if(statSync(f).isDirectory())w(f);\
 *   else if(e.endsWith('.ts')&&!e.endsWith('.d.ts')){const s=\
 *   ts.createSourceFile(f,readFileSync(f,'utf8'),ts.ScriptTarget.Latest,true);\
 *   const v=n=>{if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(\
 *   n.expression)&&ts.isIdentifier(n.expression.name)&&L.has(\
 *   n.expression.name.text)){const k=n.expression.expression.getText(s)\
 *   .replace(/\s+/g,'');c.set(k,(c.get(k)??0)+1);}ts.forEachChild(n,v);};\
 *   v(s);}}};w('src/provisioning/providers');console.log([...c].sort((a,b)=>\
 *   b[1]-a[1]))"
 *
 * Measured 2026-08-27:
 * `this.logger` (1714), `logger` (4), `opts.logger` (3), `options` (1) and
 * `getLogger().child('SNSTopicProvider')` (1). The last two were MISSED by the
 * first cut: `options` was absent from this set, and the `getLogger()` chain
 * resolves through a CallExpression, which the old receiver reader could not
 * walk — see {@link receiverNamesInclude}.
 */
const MESSAGE_SINK_RECEIVERS: ReadonlySet<string> = new Set([
  'console',
  'getLogger',
  'log',
  'logger',
  'maskedRetryLogger',
  'options',
  'opts',
]);

/**
 * Error FACTORIES a provider throws instead of constructing with `new`.
 *
 * The first cut of bound (5) looked only for `new <X>Error(...)`, and the
 * corpus throws 33 messages through a factory instead — `this.wrapError(...)`
 * (24) and `this.wrapUpdateError(...)` (9) — so
 * `throw this.wrapError(JSON.stringify(properties))` reached a message sink
 * while the counter reported zero and the run exited 0. Matched by NAME rather
 * than by receiver, unlike the level set above, because these names are
 * specific to this codebase's error plumbing while `warn` is a word any object
 * may own. `handleError` is included for the same family though the corpus
 * throws none today, so adding one lands inside the fence.
 */
const MESSAGE_SINK_FACTORIES: ReadonlySet<string> = new Set([
  'handleError',
  'wrapError',
  'wrapUpdateError',
]);

/**
 * Floor on the number of self-probes the ENTRYPOINT actually evaluated.
 *
 * Unlike the five population floors below, this one fences the checker's own
 * collapse-toward-green defense rather than its scan. 86 probes ship
 * (`node --experimental-strip-types scripts/check-provider-secret-mask.ts
 * --json | grep selfProbesRun`); the floor
 * sits at 40 so adding or retiring a handful does not force a re-tune, while any
 * real collapse (a deleted call site, a runner short-circuited to `[]`, a loop
 * that stops early) lands far below it. `runSelfProbes` counts INSIDE its loop,
 * so this cannot be satisfied by a constant.
 */
const MIN_SELF_PROBES = 40;

export type SiteVerdict = 'masked' | 'raw' | 'exempt';

export interface StringifySite {
  readonly file: string;
  readonly line: number;
  /** The stringified expression, whitespace-normalized. */
  readonly expression: string;
  readonly verdict: SiteVerdict;
  /** Why an exempt site is exempt. */
  readonly reason?: string;
}

export interface MaskReport {
  readonly filesScanned: number;
  readonly filesWithSites: number;
  readonly sites: number;
  readonly masked: number;
  readonly raw: number;
  readonly exempt: number;
  readonly maskerNames: number;
  /** `'x ' + JSON.stringify(y)` calls — known bound (1), fenced at zero. */
  readonly concatSites: number;
  /** UNMASKED `logger.warn(JSON.stringify(y))` calls — bound (5), fenced at zero. */
  readonly bareSinkSites: number;
  /**
   * WHERE they were, as `<file>:<line> (<form>)`.
   *
   * A bare count made the failure name no location across an 83-file corpus,
   * and -- once the factory arm landed -- name a SPELLING the author never
   * wrote. Same argument as {@link MaskReport.truncatedFiles}.
   */
  readonly bareSinkFiles: readonly string[];
  /** Files whose masker-set growth did not converge — see `fixpointTruncated`. */
  readonly fixpointTruncations: number;
  /**
   * WHICH files those were.
   *
   * A count alone makes a run fail naming nothing, which is the same
   * "a number moved" failure `MIN_MASKER_NAMES`'s comment warns about — and it
   * is worse here, because a truncated file's sites can still read `masked`, so
   * there is no site failure pointing at it either.
   */
  readonly truncatedFiles: readonly string[];
  readonly siteList: readonly StringifySite[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

class ScanFailure extends Error {}

function parseSource(fileName: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  // A file that fails to parse contributes ZERO sites, which reads exactly like
  // a file with none. The floors carry enough slack to hide several, so the
  // diagnostics are checked rather than left to the counts.
  const diagnostics =
    (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const detail = first ? ts.flattenDiagnosticMessageText(first.messageText, ' ') : 'unknown';
    throw new ScanFailure(`${fileName} failed to parse (${diagnostics.length} errors): ${detail}`);
  }
  return source;
}

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else return current;
  }
}

/**
 * Local names an import binds for `exported`, including ALIASES.
 *
 * A name-only match stops seeing a site the moment someone writes
 * `import { maskDeep as deepMask }` — and it stops seeing it SILENTLY while the
 * summary still reports a clean sweep, which is the direction floors cannot
 * detect.
 */
/**
 * Does `specifier`, written in `fromFile`, name the shared mask module?
 *
 * RESOLVED against the importing file rather than suffix-matched, so a
 * DIFFERENT module whose name merely ends the same way — `./my-masked-retry-
 * logger.js` — cannot lend its `maskDeep` the shared walk's provenance. Three
 * rules, in order:
 *
 *  - a BARE specifier is never this module (it is a package, and this one is
 *    relative in every file that imports it);
 *  - the resolved path's last SEGMENT must equal `masked-retry-logger.js`,
 *    which is the `endsWith` fix;
 *  - inside the real tree (`src/...`) the resolved path must be exactly
 *    `src/provisioning/masked-retry-logger.js`, so a same-BASENAME module added
 *    in another directory is not this one either. A self-probe source resolves
 *    outside `src/` and has only the basename to go on, which is why the last
 *    rule is scoped rather than unconditional.
 */
function resolvesToMaskModule(fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const resolved = normalize(join(dirname(fromFile), specifier));
  const segments = resolved.split(/[\\/]/);
  if (segments[segments.length - 1] !== MASK_MODULE_BASENAME) return false;
  if (segments[0] === 'src') return resolved === MASK_MODULE_PATH;
  return true;
}

function importedLocalNames(source: ts.SourceFile, exported: string): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (!resolvesToMaskModule(source.fileName, specifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const original = element.propertyName?.text ?? element.name.text;
      if (original === exported) names.add(element.name.text);
    }
  }
  return names;
}

/** Does a type annotation name one of {@link MASKER_TYPE_NAMES}, at any union arm? */
function isMaskerType(node: ts.TypeNode | undefined): boolean {
  if (node === undefined) return false;
  if (ts.isUnionTypeNode(node)) return node.types.some((t) => isMaskerType(t));
  if (ts.isParenthesizedTypeNode(node)) return isMaskerType(node.type);
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    return MASKER_TYPE_NAMES.has(node.typeName.text);
  }
  return false;
}

/** Is this expression a read of the contract's `maskSecrets` capability? */
function readsContextMasker(node: ts.Expression | undefined): boolean {
  if (node === undefined) return false;
  const inner = unwrap(node);
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
    return inner.name.text === MASKER_CONTEXT_PROPERTY;
  }
  if (
    ts.isBinaryExpression(inner) &&
    (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return readsContextMasker(inner.left);
  }
  return false;
}

/** The callee name a call uses, for `f(...)`, `this.f(...)` and `mod.f(...)`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;
  return undefined;
}

// ---------------------------------------------------------------------------
// Function-like collection, for the FIXPOINT
// ---------------------------------------------------------------------------

interface FunctionLike {
  readonly node: ts.SignatureDeclaration;
  readonly parameters: readonly string[];
  /** Exported functions have callers this file cannot see. */
  readonly exported: boolean;
}

function isExportedDeclaration(node: ts.Node): boolean {
  const modifiers = (node as unknown as { modifiers?: readonly ts.ModifierLike[] }).modifiers ?? [];
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  // `export const f = (...) => ...` carries the modifier on the STATEMENT.
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isVariableStatement(current)) {
      return (current.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    }
    if (ts.isSourceFile(current)) return false;
    current = current.parent;
  }
  return false;
}

/** Every named function-like in a file, keyed by the name a caller would use. */
function collectFunctions(source: ts.SourceFile): Map<string, FunctionLike[]> {
  const functions = new Map<string, FunctionLike[]>();

  const record = (name: string, node: ts.SignatureDeclaration, exported: boolean): void => {
    const parameters = node.parameters.map((parameter) =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : ''
    );
    const existing = functions.get(name) ?? [];
    existing.push({ node, parameters, exported });
    functions.set(name, existing);
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
      if (ts.isIdentifier(node.name)) record(node.name.text, node, isExportedDeclaration(node));
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        record(node.name.text, initializer, isExportedDeclaration(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return functions;
}

/** Every expression a function-like RETURNS, plus a concise arrow body. */
function returnedExpressions(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = (fn as unknown as { body?: ts.Node }).body;
  if (body === undefined) return [];
  if (!ts.isBlock(body)) return [body as ts.Expression];
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    // A nested function's `return` belongs to IT, not to `fn`.
    if (node !== body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

// ---------------------------------------------------------------------------
// The masker set — DERIVED, then grown to a FIXPOINT
// ---------------------------------------------------------------------------

export interface MaskerSet {
  /** Names that mask their FIRST argument, file-wide. */
  readonly names: ReadonlySet<string>;
  /** Extra masker names in scope only inside a given function node. */
  readonly scoped: ReadonlyMap<ts.Node, ReadonlySet<string>>;
  /**
   * Bindings REFUSED as maskers for being statically identity.
   *
   * Kept rather than merely dropped, because refusing the NAME is only half the
   * rule: the shared walk takes its masker as an ARGUMENT
   * (`maskDeep(value, mask)`), so a refused name reappears there and
   * {@link isMasked} has to recognise it in that position too.
   */
  readonly identities: ReadonlySet<string>;
  /**
   * The same refusal, SCOPED to the function that declares it (issue #2269
   * finding 2).
   *
   * `identities` used to be one file-wide NAME pool, so a class whose
   * `create()` binds `const mask = maskerOrIdentity(context?.maskSecrets)` and
   * whose `delete()` binds `const mask = maskerOrIdentity(undefined)` had BOTH
   * arms read `raw` — a FALSE POSITIVE on the correct sibling, and `mask` is
   * the commonest local name in these providers. PR #2265 only dodged it by
   * spelling the delete arm `DELETE_PATH_UNMASKED`.
   *
   * Scoping it is not free in one direction: `names` is still a file-wide pool,
   * so the sibling's REAL `mask` would now credit the delete arm — trading a
   * false positive for a false NEGATIVE, which is the worse one. That is why
   * {@link maskersAt} SUBTRACTS the identities in scope at a node from the
   * names in scope at it, rather than merely stopping the deletion.
   *
   * A module-scope identity binding has no enclosing function and stays in
   * `identities` above, which is what keeps the top-level self-probes true.
   */
  readonly scopedIdentities: ReadonlyMap<ts.Node, ReadonlySet<string>>;
  /** Local names bound to the `maskerOrIdentity` import, for the same test. */
  readonly defaulters: ReadonlySet<string>;
  /**
   * Did the growth loop hit {@link MAX_FIXPOINT_ROUNDS} without converging?
   *
   * The loop used to stop silently, which is fail-CLOSED (an unfinished set
   * under-credits and reds correct code) but signal-free: the run would report
   * a plausible number of masker names and a reader would have no way to tell
   * the derivation was truncated. Surfaced to the entrypoint instead, which
   * FAILS on it — issue #2269's third nit.
   */
  readonly fixpointTruncated: boolean;
}

/** What {@link isStaticallyIdentityMasker} needs to judge one expression. */
export interface IdentityInfo {
  readonly identities: ReadonlySet<string>;
  readonly defaulters: ReadonlySet<string>;
}

/** Is `node` a function that returns its own first parameter unchanged? */
function isIdentityFunction(node: ts.Node): boolean {
  const inner = unwrap(node);
  if (!ts.isArrowFunction(inner) && !ts.isFunctionExpression(inner)) return false;
  const parameter = inner.parameters[0];
  if (parameter === undefined || !ts.isIdentifier(parameter.name)) return false;
  const first = parameter.name.text;
  const returns = returnedExpressions(inner);
  if (returns.length === 0) return false;
  return returns.every((expression) => {
    const returned = unwrap(expression);
    return ts.isIdentifier(returned) && returned.text === first;
  });
}

/**
 * Is this binding's initializer a masker that masks NOTHING, on every path?
 *
 * A masker set that accepts one is strictly worse than having no masker at
 * all, and the reason is issue
 * [#2007](https://github.com/go-to-k/cdkd/issues/2007)'s rather than this
 * critic's: a masker that fences nothing STOPS THE NEXT AUTHOR LOOKING. The
 * check makes that concrete — a genuinely raw site could be silenced with
 * `const m: MaskerFn = maskerOrIdentity(undefined); … JSON.stringify(m(secret))`
 * and CI would stay green, and the site would additionally COUNT toward
 * `MIN_MASKED_SITES`, inflating the very floor that is supposed to notice the
 * derivation collapsing. Measured on this branch before the fix: injecting one
 * such site took the tree from 40 sites / 28 masked to 41 / 29 at exit 0.
 *
 * The refusal is scoped to a BINDING, never to a parameter. A parameter's
 * identity DEFAULT is the `SecretMaskingContext` contract's own
 * back-compatible answer (`maskSecrets: SecretMasker = (text) => text`, eight
 * occurrences in the tree) and says nothing about what callers pass; that
 * question is rule 2's, which requires EVERY call site to thread a masker.
 * A binding has no call sites — its initializer is the whole story.
 *
 * `??` / `||` / `?:` are folded only when EVERY arm is identity, so the
 * contract's own `context?.maskSecrets ?? ((t) => t)` stays a real masker: its
 * left arm IS the capability, and the identity is the absent-means-unmasked
 * fallback rather than the value.
 */
function isIdentityMaskerInitializer(
  node: ts.Expression | undefined,
  info: IdentityInfo,
  depth = 0
): boolean {
  if (node === undefined || depth > 8) return false;
  const { identities, defaulters } = info;
  const inner = unwrap(node);
  if (isIdentityFunction(inner)) return true;

  // A NAME already refused as a binding, reused here — the shape that made the
  // first cut of this rule inert: refusing `const M: MaskerFn =
  // maskerOrIdentity(undefined)` as a masker ROOT does nothing for
  // `maskDeep(value, M)`, where M sits in the walk's MASKER ARGUMENT and the
  // callee (`maskDeep`) is a root on its own. Measured: that injection took the
  // tree from 41 sites / 37 masked to 42 / 38 at exit 0, with the derived
  // masker-name count UNCHANGED at 108 — which is exactly how the receipt
  // showed the acceptance came from the argument position rather than from the
  // derivation.
  if (ts.isIdentifier(inner)) {
    if (identities.has(inner.text)) return true;
    const initializer = nearestInitializer(inner, inner.text);
    return initializer ? isIdentityMaskerInitializer(initializer, info, depth + 1) : false;
  }

  if (ts.isCallExpression(inner)) {
    const callee = calleeName(inner);
    if (callee === undefined || !defaulters.has(callee)) return false;
    // `maskerOrIdentity(<nothing usable>)` IS the identity function.
    const argument = inner.arguments[0];
    if (argument === undefined) return true;
    const unwrapped = unwrap(argument);
    if (ts.isIdentifier(unwrapped) && unwrapped.text === 'undefined') return true;
    if (unwrapped.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isVoidExpression(unwrapped)) return true;
    return isIdentityFunction(unwrapped);
  }

  if (
    ts.isBinaryExpression(inner) &&
    (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return (
      isIdentityMaskerInitializer(inner.left, info, depth + 1) &&
      isIdentityMaskerInitializer(inner.right, info, depth + 1)
    );
  }
  if (ts.isConditionalExpression(inner)) {
    return (
      isIdentityMaskerInitializer(inner.whenTrue, info, depth + 1) &&
      isIdentityMaskerInitializer(inner.whenFalse, info, depth + 1)
    );
  }
  return false;
}

/**
 * ROOTS of the masker set for one file.
 *
 * Derived rather than hardcoded because the tree spells one capability several
 * ways, and a hardcoded list is the failure that is SILENT: a spelling missing
 * from it is not reported as unknown, it simply reads as "not a mask" and reds
 * correct code — or, in the mirror direction, a renamed import makes a masked
 * site read raw and the fence stops discriminating.
 */
function maskerRoots(source: ts.SourceFile): {
  names: Set<string>;
  identities: Set<string>;
  scopedIdentities: Map<ts.Node, Set<string>>;
  defaulters: Set<string>;
} {
  const names = new Set<string>([...importedLocalNames(source, MASK_WALK_FN)]);
  const defaulters = importedLocalNames(source, MASKER_DEFAULT_FN);
  // Refused bindings are RECORDED, not just dropped — see MaskerSet.identities.
  // Recorded WITH THEIR OWNER since issue #2269: a name refused inside one
  // method said nothing about the same name in its sibling, and pooling them
  // per file reddened the sibling.
  /** MODULE-scope refusals, the ones that may delete from the file-wide pool. */
  const identities = new Set<string>();
  const refused: { owner: ts.Node | undefined; name: string }[] = [];
  const refusedAt = (node: ts.Node): Set<string> => {
    const out = new Set<string>();
    for (const record of refused) {
      if (record.owner === undefined || containsNode(record.owner, node)) out.add(record.name);
    }
    return out;
  };
  const isIdentityBinding = (
    declaration: ts.Node,
    initializer: ts.Expression | undefined
  ): boolean =>
    isIdentityMaskerInitializer(initializer, { identities: refusedAt(declaration), defaulters });

  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && isMaskerType(node.type)) {
      // A PARAMETER is not judged by its DEFAULT. `maskSecrets: SecretMasker =
      // (text) => text` is the contract's own back-compatible default and the
      // tree carries eight of them; what decides whether the value is real is
      // the CALL SITE, which is rule 2's job below. Only a BINDING — whose
      // initializer is the whole story — can be refused here.
      names.add(node.name.text);
    } else if (ts.isPropertySignature(node) && ts.isIdentifier(node.name) && isMaskerType(node.type)) {
      names.add(node.name.text);
    } else if (
      ts.isPropertyDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isMaskerType(node.type)
    ) {
      if (!isIdentityBinding(node, node.initializer)) names.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const bindingName = node.name.text;
      if (isIdentityBinding(node, node.initializer)) {
        // REFUSED — see isIdentityMaskerInitializer. Recorded so the ARGUMENT
        // position of the shared walk can recognise the name too, and recorded
        // with the function that OWNS it so a sibling keeps its own verdict.
        const owner = enclosingFunction(node);
        if (!refused.some((record) => record.owner === owner && record.name === bindingName)) {
          refused.push({ owner, name: bindingName });
        }
      } else if (isMaskerType(node.type)) {
        names.add(node.name.text);
      } else if (node.initializer) {
        const init = unwrap(node.initializer);
        const callee = ts.isCallExpression(init) ? calleeName(init) : undefined;
        if (callee !== undefined && defaulters.has(callee)) names.add(node.name.text);
        else if (readsContextMasker(node.initializer)) names.add(node.name.text);
      }
    } else if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      (node.propertyName === undefined || !ts.isIdentifier(node.propertyName)
        ? node.name.text === MASKER_CONTEXT_PROPERTY
        : node.propertyName.text === MASKER_CONTEXT_PROPERTY)
    ) {
      // `const { maskSecrets } = context ?? {}` — a destructured capability.
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  // TWO passes. An identity binding declared BELOW its use (or below another
  // identity binding that names it) must still be recognised, and one pass in
  // source order would miss it — which is the same "the fence only catches the
  // spelling its author pictured" failure this critic exists to forbid.
  visit(source);
  visit(source);
  const scopedIdentities = new Map<ts.Node, Set<string>>();
  for (const record of refused) {
    if (record.owner === undefined) {
      identities.add(record.name);
      continue;
    }
    const set = scopedIdentities.get(record.owner) ?? new Set<string>();
    set.add(record.name);
    scopedIdentities.set(record.owner, set);
  }
  // Only a MODULE-scope refusal may delete from the file-wide pool. A
  // function-scoped one is subtracted at the USE site instead
  // ({@link maskersAt}), because the same name may be a real masker in the
  // method next door — which is the whole point of scoping it.
  for (const identity of identities) names.delete(identity);
  return { names, identities, scopedIdentities, defaulters };
}

/**
 * The nearest enclosing function-like of `node`, or `undefined` at module
 * scope.
 *
 * Derived from the PARENT CHAIN, a relation the syntax cannot omit — not from
 * a type annotation or an explicit return type, which TypeScript infers and a
 * site may simply leave off, making that site invisible to the derivation.
 */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/**
 * The masker set for a file, grown to a FIXPOINT.
 *
 * Two growth rules, both measured against the real tree rather than imagined:
 *
 *  - a local function whose every `return` is `<known masker>(<its own first
 *    parameter>, ...)` is a masker. Four files spell the shared walk this way.
 *  - a PARAMETER every call site hands a masker is a masker inside that
 *    function. Required by `sns-topic-provider.ts`'s
 *    `normalizeDeliveryStatusProtocolOrThrow(input, logicalId, maskValue)`,
 *    whose body stringifies `maskValue(input)` and whose single caller passes
 *    `maskLeaf`. STRICT on purpose: at least one call site, and EVERY call site
 *    must pass one, so a later caller that omits it flips the site back to
 *    `raw` rather than riding the first caller's diligence. An EXPORTED
 *    function is refused, since its callers are not all visible from here.
 */
/**
 * Does `fn` return `<known masker>(<its own first parameter>, ...)` on every
 * path?
 *
 * Shared by the two spellings of the same idea — a NAMED wrapper
 * (`const maskLeaf = (v) => maskDeep(v, m)`, which the tree uses four times)
 * and an INLINE one handed straight to a helper
 * (`refuse(v, (x) => maskDeep(x, m))`). Recognising only the named form would
 * make the fence match the spelling this tree happens to use rather than the
 * capability, which is the blindness the self-probes exist to forbid.
 */
function wrapsFirstParameter(
  fn: ts.SignatureDeclaration,
  names: ReadonlySet<string>,
  identity: IdentityInfo
): boolean {
  const parameter = fn.parameters[0];
  if (parameter === undefined || !ts.isIdentifier(parameter.name)) return false;
  const first = parameter.name.text;
  const returns = returnedExpressions(fn);
  if (returns.length === 0) return false;
  return returns.every((expression) => {
    const inner = unwrap(expression);
    if (!ts.isCallExpression(inner)) return false;
    const callee = calleeName(inner);
    if (callee === undefined || !names.has(callee)) return false;
    const argument = inner.arguments[0];
    if (argument === undefined) return false;
    const unwrapped = unwrap(argument);
    if (!ts.isIdentifier(unwrapped) || unwrapped.text !== first) return false;
    // The MASKER the wrapped call is handed, judged exactly as
    // {@link isMasked} judges it at a site. Surfaced by the issue #2269
    // differential: `const mask = maskerOrIdentity(undefined); const maskLeaf =
    // (v) => maskDeep(v, mask); … JSON.stringify(maskLeaf(x))` classified
    // `masked` on BOTH sides of that change, because this predicate read only
    // the CALLEE. The identity refusal covered the derivation root and a DIRECT
    // call's masker argument, and a named wrapper laundered a refused binding
    // straight past both -- a masker that masks nothing, which issue #2007 puts
    // BELOW having no masker at all.
    return inner.arguments
      .slice(1)
      .every(
        (extra, offset) =>
          isMaskerArgument(extra, names, identity) ||
          (offset > 0 && isConstant(unwrap(extra)))
      );
  });
}

export function buildMaskerSet(source: ts.SourceFile): MaskerSet {
  const { names, identities, scopedIdentities, defaulters } = maskerRoots(source);
  const functions = collectFunctions(source);
  const scoped = new Map<ts.Node, Set<string>>();

  /** Names refused as identity in scope at `node` — module-scope plus enclosing. */
  const refusedAt = (node: ts.Node): Set<string> => {
    const out = new Set(identities);
    for (const [owner, extra] of scopedIdentities) {
      if (containsNode(owner, node)) for (const name of extra) out.add(name);
    }
    return out;
  };
  /**
   * The file-wide pool minus the identities refused where `node` sits.
   *
   * The growth rules below have to ask the question AT A POSITION for the same
   * reason {@link maskersAt} does: with `identities` scoped, a sibling method's
   * real `mask` is still in `names`, so a wrapper or a call site inside the
   * method that refused `mask` would otherwise be credited by it.
   */
  const namesAt = (node: ts.Node): Set<string> => {
    const out = new Set(names);
    // Scoped names are visible here too, or a locally declared wrapper could
    // never be the base of another one: `const w1 = (v) => maskDeep(v, m);
    // const w2 = (v) => w1(v)` inside one method grew file-wide before rule 1
    // became lexical, and dropping it would be a silent NARROWING rather than
    // the false-negative fix it is meant to be.
    for (const [owner, extra] of scoped) {
      if (containsNode(owner, node)) for (const name of extra) out.add(name);
    }
    for (const name of refusedAt(node)) out.delete(name);
    return out;
  };

  const isMaskerExpression = (node: ts.Expression): boolean => {
    const inner = unwrap(node);
    const visible = namesAt(inner);
    // `namesAt` already folds in the enclosing function's scoped names.
    if (ts.isIdentifier(inner)) return visible.has(inner.text);
    if (ts.isPropertyAccessExpression(inner)) {
      return isMaskerPropertyAccess(inner, visible);
    }
    // An INLINE wrapper handed straight to the helper.
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
      return wrapsFirstParameter(inner, visible, {
        identities: refusedAt(inner),
        defaulters,
      });
    }
    return false;
  };

  let fixpointTruncated = true;
  for (let round = 0; round < MAX_FIXPOINT_ROUNDS; round += 1) {
    let changed = false;

    // RULE 1 — a NAMED wrapper around a known masker.
    //
    // Recorded at the wrapper's OWN lexical scope since issue #2269. A
    // top-level function or a class METHOD has no enclosing function and stays
    // file-wide, which is how `maskLeafValue` / `maskLeaves` are reached from
    // their siblings. A `const maskLeaf = (v) => maskDeep(v, mask)` declared
    // INSIDE a method is scoped to that method — file-wide was harmless while
    // `identities` was a file-wide pool too (an identity `mask` refused every
    // wrapper built on it), and became a false NEGATIVE the moment the refusal
    // was scoped: `create()`'s wrapper would have credited the identically
    // named wrapper in `delete()`.
    for (const [name, candidates] of functions) {
      if (names.has(name)) continue;
      for (const candidate of candidates) {
        const owner = enclosingFunction(candidate.node);
        const extra = owner === undefined ? undefined : (scoped.get(owner) ?? new Set<string>());
        if (extra?.has(name)) continue;
        if (
          !wrapsFirstParameter(candidate.node, namesAt(candidate.node), {
            identities: refusedAt(candidate.node),
            defaulters,
          })
        ) {
          continue;
        }
        if (owner === undefined || extra === undefined) names.add(name);
        else {
          extra.add(name);
          scoped.set(owner, extra);
        }
        changed = true;
      }
    }

    // RULE 2 — a parameter every call site hands a masker.
    const received = new Map<ts.Node, Map<number, { masked: number; total: number }>>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = calleeName(node);
        for (const candidate of callee ? (functions.get(callee) ?? []) : []) {
          const perIndex = received.get(candidate.node) ?? new Map();
          received.set(candidate.node, perIndex);
          for (let index = 0; index < candidate.parameters.length; index += 1) {
            const tally = perIndex.get(index) ?? { masked: 0, total: 0 };
            const argument = node.arguments[index];
            tally.total += 1;
            if (argument !== undefined && isMaskerExpression(argument)) tally.masked += 1;
            perIndex.set(index, tally);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    for (const candidates of functions.values()) {
      for (const candidate of candidates) {
        if (candidate.exported) continue;
        const perIndex = received.get(candidate.node);
        if (perIndex === undefined) continue;
        for (const [index, tally] of perIndex) {
          if (tally.total === 0 || tally.masked !== tally.total) continue;
          const parameter = candidate.parameters[index];
          if (parameter === undefined || parameter === '') continue;
          const extra = scoped.get(candidate.node) ?? new Set<string>();
          if (extra.has(parameter)) continue;
          extra.add(parameter);
          scoped.set(candidate.node, extra);
          changed = true;
        }
      }
    }

    if (!changed) {
      fixpointTruncated = false;
      break;
    }
  }

  return { names, scoped, identities, scopedIdentities, defaulters, fixpointTruncated };
}

function containsNode(container: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === container) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Names REFUSED as identity in scope at `node` — module-scope plus every
 * enclosing function's own.
 */
export function identitiesAt(node: ts.Node, set: MaskerSet): Set<string> {
  const out = new Set(set.identities);
  for (const [owner, extra] of set.scopedIdentities) {
    if (containsNode(owner, node)) for (const name of extra) out.add(name);
  }
  return out;
}

/**
 * Masker names in scope at `node`: the file-wide set plus any enclosing
 * function's, MINUS the identities refused where `node` sits.
 *
 * The subtraction is the half of issue #2269 finding 2 that is easy to miss.
 * Scoping `identities` fixes the false POSITIVE (the delete arm no longer reds
 * its create sibling) and creates a false NEGATIVE in the same move, because
 * `names` remains a file-wide pool and the sibling's real `mask` is in it. The
 * narrower scope has to WIN at the use site, or the trade is a bad one.
 */
function maskersAt(node: ts.Node, set: MaskerSet): Set<string> {
  const names = new Set(set.names);
  for (const [owner, extra] of set.scoped) {
    if (containsNode(owner, node)) for (const name of extra) names.add(name);
  }
  for (const name of identitiesAt(node, set)) names.delete(name);
  return names;
}

// ---------------------------------------------------------------------------
// The DATAFLOW predicate
// ---------------------------------------------------------------------------

/**
 * The declaration initializer `name` resolves to at `use`, by LEXICAL scope.
 *
 * Walks outward through enclosing blocks, taking the first declaration found,
 * so a `const comment = ...` in a SIBLING block cannot credit an unrelated
 * site. Only declarations WITH an initializer resolve — a bare parameter has no
 * upstream to inspect, and reading it as unresolvable (hence unmasked) is the
 * fail-closed direction.
 */
function nearestInitializer(use: ts.Node, name: string): ts.Expression | undefined {
  let current: ts.Node | undefined = use;
  while (current) {
    const statements = (current as unknown as { statements?: ts.NodeArray<ts.Statement> })
      .statements;
    if (statements) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer
          ) {
            return declaration.initializer;
          }
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

/** A literal with no interpolation and no upstream — it cannot carry a secret. */
function isConstant(node: ts.Node): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  );
}

/**
 * Is `node`, sitting in a masker's MASKER-ARGUMENT position, the project's
 * shared capability?
 *
 * ALLOW-LIST, and the polarity is the whole point. The first two rounds of this
 * rule were a DENY-list of identity spellings — `maskerOrIdentity(undefined)`,
 * then an inline `(t) => t`, then a two-hop alias — and each round was locally
 * correct while moving the hole one spelling over. A hand-rolled
 * `function noMask(v) { return v; }` passed all of them, and so would a cast, an
 * object property, or a default parameter value. The set of ways to write a
 * no-op is unbounded, so enumerating it can never terminate
 * (`.claude/skills/work-issues/references/verify.md` section 8: when the finding is a new
 * INPUT CLASS rather than a new place the logic is wrong, stop patching
 * instances).
 *
 * Inverted, the predicate is also the honest statement of the rule being
 * enforced. What the contract requires is that the value reached THE PROJECT'S
 * MASKER — not that it reached something which is not one of five known no-ops.
 * So this accepts exactly the derivation roots {@link maskerRoots} already
 * computes, and refuses everything else by default:
 *
 *  - a name in the file's derived masker set (which is where an aliased
 *    `maskDeep` import, a `SecretMasker` / `MaskerFn` binding or parameter, and
 *    a threaded helper parameter all land) — resolved through a binding when
 *    the name is a local `const`;
 *  - a `.maskSecrets` read, the capability the contract threads;
 *  - `maskerOrIdentity(<not statically identity>)`, the contract's own
 *    absent-means-unmasked wrapper;
 *  - an INLINE wrapper whose every return is a call to a known masker;
 *  - a `??` / `||` whose LEFT arm is accepted, which is the contract's
 *    `context?.maskSecrets ?? ((t) => t)` spelling.
 *
 * A hand-rolled no-op is refused for the right reason — it is not the shared
 * capability — with no enumeration and no next round.
 */
/**
 * Is a property-access RECEIVER one the provider OWNS?
 *
 * `this`, or a chain rooted at `this`. Nothing else — see
 * {@link isMaskerPropertyAccess} for why.
 */
function isMaskerReceiver(node: ts.Expression): boolean {
  const inner = unwrap(node);
  if (inner.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(inner)) return isMaskerReceiver(inner.expression);
  return false;
}

/**
 * Is a PROPERTY ACCESS in a masker position the project's capability — receiver
 * included?
 *
 * Issue #2269 finding 1. The three masker positions used to accept ANY property
 * access whose FINAL name landed in the file's derived masker set, and with
 * ~108 derived names tree-wide that made the fence read "the value reached
 * something whose last identifier collides with a masker name" rather than
 * "the value reached the project's masker". Probed on the branch that filed it:
 *
 *   const junk = { maskLeaf: (t) => t };
 *   maskDeep(p, junk.maskLeaf)   // -> masked
 *   junk.maskLeaf(p)             // -> masked
 *
 * Two arms, and the split is exactly KNOWN BOUND (4)'s line:
 *
 *  - the contract's OWN property name (`maskSecrets`) is believed on ANY
 *    receiver. That is the bound, stated and self-probed: a syntactic critic
 *    has the declaration and nothing else, so `{ maskSecrets: (t) => t }`
 *    passes here on purpose and closing it is a different change.
 *  - a DERIVED name (`maskLeaf`, `maskValue`, an aliased `maskDeep`, ...) is
 *    accepted only off a receiver the provider owns. A derived name is
 *    inferred from the file rather than declared by the contract, so a
 *    collision with an unrelated object's property is an accident, not a
 *    declaration.
 *
 * FREE on the real tree, which is why the narrowing ships rather than only the
 * restated bound: the only property-access maskers in the scanned corpus are
 * `this.maskErrorMessage` (18) and `this.maskedRetryLogger` (5), both `this`.
 */
function isMaskerPropertyAccess(
  node: ts.PropertyAccessExpression,
  maskers: ReadonlySet<string>
): boolean {
  if (!ts.isIdentifier(node.name)) return false;
  if (node.name.text === MASKER_CONTEXT_PROPERTY) return true;
  return maskers.has(node.name.text) && isMaskerReceiver(node.expression);
}

function isMaskerArgument(
  node: ts.Expression,
  maskers: ReadonlySet<string>,
  identity: IdentityInfo,
  depth = 0
): boolean {
  if (depth > 8) return false;
  const inner = unwrap(node);

  if (ts.isIdentifier(inner)) {
    if (identity.identities.has(inner.text)) return false;
    if (maskers.has(inner.text)) return true;
    const initializer = nearestInitializer(inner, inner.text);
    return initializer ? isMaskerArgument(initializer, maskers, identity, depth + 1) : false;
  }

  if (ts.isPropertyAccessExpression(inner)) {
    return isMaskerPropertyAccess(inner, maskers);
  }

  if (ts.isCallExpression(inner)) {
    const callee = calleeName(inner);
    if (callee === undefined || !identity.defaulters.has(callee)) return false;
    return !isIdentityMaskerInitializer(inner, identity);
  }

  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
    return wrapsFirstParameter(inner, maskers, identity);
  }

  if (
    ts.isBinaryExpression(inner) &&
    (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isMaskerArgument(inner.left, maskers, identity, depth + 1);
  }

  // `maskDeep(v, flag ? a : b)` — BOTH arms, unlike the `??` rule one line up.
  // `??`'s left-arm-only rule exists for the contract's
  // `context?.maskSecrets ?? ((t) => t)`, where the right arm is the
  // absent-means-unmasked fallback rather than a value the caller chose; a `?:`
  // has no such asymmetry, so an unaccepted arm refuses the whole thing.
  // {@link isIdentityMaskerInitializer} already had this arm and this one did
  // not, which made a conditional masker read `raw` — issue #2269's second nit,
  // a FALSE-POSITIVE direction.
  if (ts.isConditionalExpression(inner)) {
    return (
      isMaskerArgument(inner.whenTrue, maskers, identity, depth + 1) &&
      isMaskerArgument(inner.whenFalse, maskers, identity, depth + 1)
    );
  }

  return false;
}

/**
 * Does `expression` reach a masker before it is stringified?
 *
 * Structural and DATAFLOW-aware, which is the whole point of this critic: the
 * mask is correct wherever it sits on the path from the property bag to the
 * interpolation, and two real sites put it a line upstream rather than inside
 * the `JSON.stringify(...)` call.
 *
 * Accepts a call to a masker; a constant; and any COMPOSITION whose every
 * component is accepted — a `?:`, a `??` / `||`, an array or object literal, a
 * template, a `.map()` whose callback returns something accepted, and a chain
 * of mask-preserving array methods. Refuses everything else, in particular a
 * bare parameter, a property or element access, and a call to anything that is
 * not a masker. That refusal is what keeps the fence discriminating: an
 * expression that merely MENTIONS a masker (`someHelper(maskSecrets)`) is not
 * evidence that THIS value went through one.
 *
 * A call to a masker is additionally refused when the masker it is HANDED is
 * statically identity — `maskDeep(value, maskerOrIdentity(undefined))` walks
 * every leaf and changes nothing. Refusing the identity NAME as a derivation
 * root does not cover this: the callee here is `maskDeep`, a root in its own
 * right, so without the argument test the whole rule is inert in the position
 * the codebase actually writes.
 */
export function isMasked(
  expression: ts.Node,
  maskers: ReadonlySet<string>,
  identity: IdentityInfo,
  depth = 0
): boolean {
  if (depth > 12) return false;
  const node = unwrap(expression);

  if (isConstant(node)) return true;

  if (ts.isIdentifier(node)) {
    const initializer = nearestInitializer(node, node.text);
    return initializer ? isMasked(initializer, maskers, identity, depth + 1) : false;
  }

  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    // The masker a masker is HANDED. `maskDeep(value, mask)` is the shape the
    // whole codebase uses, so whatever sits there decides whether the call
    // masks anything, however real the callee is. Checked from index 1 —
    // index 0 is the VALUE — and by ALLOW-LIST: see isMaskerArgument for why
    // the deny-list this replaced could not terminate.
    // Index 1 must be the CAPABILITY. Index 2 and beyond may also be an
    // OPTION: `maskDeep`'s own third parameter is a `depth` number, and
    // requiring EVERY argument past 0 to be a masker classified
    // `maskDeep(v, m, 1)` raw — issue #2269's first nit, a FALSE-POSITIVE
    // direction. Widened to CONSTANTS only, and only past index 1, so
    // `maskDeep(v, undefined)` (where `undefined` is a constant too) stays
    // refused rather than riding the same relaxation.
    const handedARealMasker = node.arguments
      .slice(1)
      .every(
        (argument, offset) =>
          isMaskerArgument(argument, maskers, identity) ||
          (offset > 0 && isConstant(unwrap(argument)))
      );
    if (ts.isIdentifier(callee) && maskers.has(callee.text)) return handedARealMasker;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      const method = callee.name.text;
      // RECEIVER-checked since issue #2269 finding 1: `maskers.has(method)`
      // alone accepted `junk.maskLeaf(p)` for any object whose property name
      // collided with one of the ~108 derived masker names. The conjunction
      // keeps this position no WIDER than it was — `isMaskerPropertyAccess`
      // believes the contract's own property name on any receiver, which this
      // position did not, and the `maskers.has` term holds that line.
      if (maskers.has(method) && isMaskerPropertyAccess(callee, maskers)) {
        return handedARealMasker;
      }
      if (method === 'map') {
        // `.map()` REPLACES each element, so the receiver's state is
        // irrelevant and the callback's result is everything.
        const callback = node.arguments[0];
        if (callback === undefined) return false;
        const inner = unwrap(callback);
        if (!ts.isArrowFunction(inner) && !ts.isFunctionExpression(inner)) return false;
        const returns = returnedExpressions(inner);
        return returns.length > 0 && returns.every((r) => isMasked(r, maskers, identity, depth + 1));
      }
      if (MASK_PRESERVING_METHODS.has(method)) {
        return isMasked(callee.expression, maskers, identity, depth + 1);
      }
    }
    return false;
  }

  if (ts.isConditionalExpression(node)) {
    return (
      isMasked(node.whenTrue, maskers, identity, depth + 1) && isMasked(node.whenFalse, maskers, identity, depth + 1)
    );
  }

  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.PlusToken
    ) {
      return (
        isMasked(node.left, maskers, identity, depth + 1) && isMasked(node.right, maskers, identity, depth + 1)
      );
    }
    return false;
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) =>
      ts.isSpreadElement(element)
        ? isMasked(element.expression, maskers, identity, depth + 1)
        : isMasked(element, maskers, identity, depth + 1)
    );
  }

  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (ts.isPropertyAssignment(property)) {
        // A computed key is itself stringified, so it must be accepted too.
        if (ts.isComputedPropertyName(property.name)) {
          if (!isMasked(property.name.expression, maskers, identity, depth + 1)) return false;
        }
        return isMasked(property.initializer, maskers, identity, depth + 1);
      }
      if (ts.isSpreadAssignment(property)) return isMasked(property.expression, maskers, identity, depth + 1);
      // A shorthand `{ value }` carries the binding verbatim.
      if (ts.isShorthandPropertyAssignment(property)) {
        const initializer = nearestInitializer(property, property.name.text);
        return initializer ? isMasked(initializer, maskers, identity, depth + 1) : false;
      }
      return false;
    });
  }

  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.every((span) => isMasked(span.expression, maskers, identity, depth + 1));
  }

  // A property access, an element access, a `new`, an `await`, a spread — all
  // DERIVED values with no evidence of a mask on this path.
  return false;
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

/** Is `node` interpolated into a template literal? */
function isInterpolated(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isTemplateSpan(current)) return true;
    current = current.parent;
  }
  return false;
}

function isJsonStringifyCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'JSON' &&
    ts.isIdentifier(callee.name) &&
    callee.name.text === 'stringify'
  );
}

export function normalizeExpression(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Is `node` an OPERAND of a `+`, i.e. the string-CONCAT spelling of a site?
 *
 * The measured-zero population of known bound (1). Checked one level out
 * through parentheses only: a stringify nested inside a template that is itself
 * concatenated is already a SITE by {@link isInterpolated}, so this counts
 * exactly the calls the population does not reach.
 */
function isConcatOperand(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && ts.isParenthesizedExpression(current)) current = current.parent;
  return (
    current !== undefined &&
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  );
}

/**
 * Is `node` a DIRECT argument of a message SINK — `logger.warn(x)`,
 * `this.logger.debug(x)`, `new ProvisioningError(x)`?
 *
 * Known bound (5)'s population. Only the direct-argument shape: a stringify
 * inside a template argument is already a SITE, and one inside a `+` is
 * already bound (1)'s, so the three populations are disjoint and each is
 * counted once.
 *
 * A LEVEL call is matched RECEIVER-first for the same reason
 * {@link isMaskerPropertyAccess} is: a bare `.warn` / `.update` method-name
 * match would sweep in any object. Measured against the scanned tree, the two
 * non-sink calls that take a bare `JSON.stringify` — `Buffer.from(...)` and
 * `createHash('sha256').update(...)`
 * (`cloudwatch-anomaly-detector-provider.ts:421`) — are correctly outside it,
 * which is what keeps the fence at zero honest rather than merely empty.
 *
 * A FACTORY call is matched by NAME instead, and that arm exists because the
 * first cut of this bound was honest about the wrong population: it required
 * `new`, so the 33 messages this corpus throws through `this.wrapError(...)` /
 * `this.wrapUpdateError(...)` sat outside the count entirely and
 * `throw this.wrapError(JSON.stringify(properties))` ran at exit 0 with
 * `bareSinkSites` reporting zero. A fence whose prose claims a measurement its
 * matcher never took is the failure issue #2178 exists to prevent.
 */
function bareMessageSinkForm(node: ts.Node): BareSinkForm | undefined {
  // Walked through CASTS as well as parentheses. `unwrap` strips
  // `as` / `satisfies` / `!` / `<T>` everywhere else in this file, and the one
  // place that did not was this one: `logger.warn(JSON.stringify(v) as string)`
  // stopped at the `as` and counted zero.
  let current: ts.Node = node;
  while (current.parent && isTransparentWrapper(current.parent)) current = current.parent;
  const parent: ts.Node | undefined = current.parent;
  if (parent === undefined) return undefined;
  if (ts.isNewExpression(parent)) {
    if (!isErrorConstructor(parent.expression)) return undefined;
    return (parent.arguments ?? []).some((argument) => argument === current)
      ? 'error constructor'
      : undefined;
  }
  if (ts.isCallExpression(parent)) {
    const form = messageSinkCalleeForm(parent.expression);
    if (form === undefined) return undefined;
    return parent.arguments.some((argument) => argument === current) ? form : undefined;
  }
  return undefined;
}

/**
 * The wrappers {@link unwrap} strips, as a parent-chain test.
 *
 * The two are one question asked from two directions — "strip this node's
 * wrapper" and "is my parent a wrapper" — and a divergence between two
 * spellings of one question is this repo's recurring defect: the cast escape
 * this predicate exists to close WAS that divergence. A sixth wrapper added to
 * `unwrap` and not here would re-open it silently, so
 * `provider-secret-mask-recognition-2269.test.ts` parses the `ts.isX(` guards
 * out of BOTH function bodies and requires the two sets to be equal.
 */
export function isTransparentWrapper(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

/**
 * Does any name in a RECEIVER chain name a message sink?
 *
 * Walks property accesses AND calls, because
 * `getLogger().child('SNSTopicProvider').warn(...)`
 * (`sns-topic-provider.ts:1115`) puts a CallExpression in the receiver
 * position, where a reader that only understood `<id>` and `<id>.<id>` produced
 * `undefined` and silently dropped the site. `this` terminates the walk without
 * matching — `this.warn(...)` is not a logger, `this.logger.warn(...)` matches
 * on `logger`.
 */
function receiverNamesInclude(
  node: ts.Expression,
  allowed: ReadonlySet<string>,
  depth = 0
): boolean {
  if (depth > 8) return false;
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return allowed.has(inner.text);
  if (ts.isPropertyAccessExpression(inner)) {
    if (ts.isIdentifier(inner.name) && allowed.has(inner.name.text)) return true;
    return receiverNamesInclude(inner.expression, allowed, depth + 1);
  }
  if (ts.isCallExpression(inner)) {
    return receiverNamesInclude(inner.expression, allowed, depth + 1);
  }
  return false;
}

/**
 * Which SHAPE of message sink a bare stringify was handed to.
 *
 * Reported rather than reduced to a boolean because the failure message names
 * it: after the factory arm was added, "found 1 `logger.warn(...)` call" could
 * point at a form the author never wrote.
 */
export type BareSinkForm = 'logger call' | 'error factory' | 'error constructor';

/** `new Error(...)` / `new ProvisioningError(...)` — a message-carrying throw. */
function isErrorConstructor(expression: ts.Expression): boolean {
  const inner = unwrap(expression);
  const name = ts.isIdentifier(inner)
    ? inner.text
    : ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)
      ? inner.name.text
      : undefined;
  return name !== undefined && name.endsWith('Error');
}

/**
 * Is `name` an error FACTORY — one of the named ones, or a `wrap<X>Error`?
 *
 * The PATTERN is the half a list cannot give: review measured that
 * `throw this.wrapDeleteError(JSON.stringify(v))` escaped the set entirely,
 * which is the same shape this bound had just finished fixing — a spelling
 * outside the matcher while the prose calls the measured zero honest. The
 * durable half is not this pattern either but
 * `tests/unit/scripts/provider-secret-mask-recognition-2269.test.ts`'s
 * enumerating test, which walks EVERY `throw <call>(...)` callee in the corpus
 * and fails on a name neither this predicate nor its audited
 * not-a-factory list knows. A regex keeps today's zero honest; the enumeration
 * keeps it honest as the corpus grows.
 */
export function isErrorFactoryName(name: string): boolean {
  return MESSAGE_SINK_FACTORIES.has(name) || /^wrap[A-Za-z]*Error$/.test(name);
}

/**
 * `logger.warn` / `this.logger.debug` — the level AND the receiver must match —
 * or `this.wrapError` / `wrapUpdateError`, matched by NAME.
 */
function messageSinkCalleeForm(expression: ts.Expression): BareSinkForm | undefined {
  const inner = unwrap(expression);
  const calleeName = ts.isIdentifier(inner)
    ? inner.text
    : ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)
      ? inner.name.text
      : undefined;
  if (calleeName !== undefined && isErrorFactoryName(calleeName)) return 'error factory';
  if (!ts.isPropertyAccessExpression(inner) || !ts.isIdentifier(inner.name)) return undefined;
  if (!MESSAGE_SINK_LEVELS.has(inner.name.text)) return undefined;
  return receiverNamesInclude(inner.expression, MESSAGE_SINK_RECEIVERS) ? 'logger call' : undefined;
}

export interface AnalyzedFile {
  readonly sites: readonly StringifySite[];
  readonly maskerNames: number;
  /** `'x ' + JSON.stringify(y)` calls — known bound (1), fenced at zero. */
  readonly concatSites: number;
  /** UNMASKED `logger.warn(JSON.stringify(y))` calls — bound (5), fenced at zero. */
  readonly bareSinkSites: number;
  /** WHERE they were, as `<file>:<line> (<form>)`. */
  readonly bareSinkLocations: readonly string[];
  /** Did this file's masker-set growth hit {@link MAX_FIXPOINT_ROUNDS}? */
  readonly fixpointTruncated: boolean;
}

export function analyzeFile(file: string, text: string): AnalyzedFile {
  const source = parseSource(file, text);
  const maskerSet = buildMaskerSet(source);
  const sites: StringifySite[] = [];
  const bareSinkLocations: string[] = [];
  let concatSites = 0;

  /** The site-level verdict, reused by bound (5) so the two agree. */
  const reachesAMasker = (argument: ts.Expression | undefined): boolean =>
    argument !== undefined &&
    isMasked(argument, maskersAt(argument, maskerSet), {
      // Scoped to the site, not to the file — issue #2269 finding 2.
      identities: identitiesAt(argument, maskerSet),
      defaulters: maskerSet.defaulters,
    });

  const visit = (node: ts.Node): void => {
    if (isJsonStringifyCall(node) && !isInterpolated(node) && isConcatOperand(node)) {
      concatSites += 1;
    }
    if (isJsonStringifyCall(node) && !isInterpolated(node)) {
      const form = bareMessageSinkForm(node);
      // MASKED ones are NOT counted. The first cut of this arm counted every
      // bare sink, so `throw this.wrapError(JSON.stringify(maskDeep(v, m)))` --
      // correct code, with the value already through the project's masker --
      // failed CI. A guard that reds correct code is worse than the miss it
      // replaced, because the remedy the next author reaches for is to work
      // AROUND the fence. The decision is the SITE's own predicate, so the two
      // populations cannot drift apart.
      if (form !== undefined && !reachesAMasker(node.arguments[0])) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        bareSinkLocations.push(`${file}:${line} (${form})`);
      }
    }
    if (isJsonStringifyCall(node) && isInterpolated(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const argument = node.arguments[0];
      const expression =
        argument === undefined ? '<no argument>' : normalizeExpression(argument.getText(source));
      sites.push({
        file,
        line,
        expression,
        verdict: reachesAMasker(argument) ? 'masked' : 'raw',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return {
    sites,
    maskerNames: maskerSet.names.size + [...maskerSet.scoped.values()].reduce((n, s) => n + s.size, 0),
    concatSites,
    bareSinkSites: bareSinkLocations.length,
    bareSinkLocations,
    fixpointTruncated: maskerSet.fixpointTruncated,
  };
}

// ---------------------------------------------------------------------------
// Self-probes — the defense against COLLAPSE TOWARD GREEN
// ---------------------------------------------------------------------------

interface SelfProbe {
  readonly name: string;
  readonly source: string;
  readonly expected: readonly SiteVerdict[];
  /** Expected {@link AnalyzedFile.concatSites}. Omitted means zero. */
  readonly expectedConcat?: number;
  /** Expected {@link AnalyzedFile.bareSinkSites}. Omitted means zero. */
  readonly expectedBareSink?: number;
  /**
   * Expected {@link AnalyzedFile.fixpointTruncated}. Omitted means `false`.
   *
   * The truncation flag is a CLASSIFIER OUTPUT like the two counters above, so
   * it belongs in this channel rather than only in the unit suite: forcing it
   * to `false` left the real binary at exit 0 with every probe green, which is
   * precisely the collapse-toward-green this channel exists to catch.
   */
  readonly expectedTruncated?: boolean;
}

const MASK_IMPORT = `import { maskDeep, maskerOrIdentity } from '../masked-retry-logger.js';`;

/**
 * Floors cannot see a classifier that degrades to "everything is masked": the
 * counts are unchanged and the printed summary is byte-identical. These fixed
 * sources have known verdicts INCLUDING `raw` ones and are analyzed on every
 * run BEFORE the real tree is read, so such a degradation fails loudly.
 *
 * The SPELLINGS here are the ones a PERSON would reach for, not the ones that
 * are easiest to inject: the shared `maskDeep`, a context-bound `maskSecrets`,
 * a `maskerOrIdentity` default, a locally RENAMED wrapper, a mask applied
 * inside a `.map()`, and a mask threaded through a helper parameter. A rule
 * that only matched the spelling today's tree happens to use would be blind to
 * the next contributor.
 */
const SELF_PROBES: readonly SelfProbe[] = [
  {
    // ACCEPT side of the object-literal SHORTHAND arm (isMasked's
    // ShorthandPropertyAssignment branch). It had neither side probed: the arm
    // could be deleted and nothing would notice, even though `{ masked }` is
    // the spelling a provider reaches for when it names the value it is
    // reporting.
    name: 'an object-literal SHORTHAND carrying a masked binding is a mask',
    source: `${MASK_IMPORT}
    function f(value: unknown, maskSecrets: SecretMasker) {
      const masked = maskDeep(value, maskSecrets);
      throw new Error(\`got \${JSON.stringify({ masked })}\`);
    }`,
    expected: ['masked'],
  },
  {
    // REFUSE twin of the above — without it the arm could degrade to "any
    // shorthand is fine" and the accept probe would still pass.
    name: 'an object-literal SHORTHAND carrying a RAW binding is raw',
    source: `${MASK_IMPORT}
    function f(value: unknown) {
      const plain = value;
      throw new Error(\`got \${JSON.stringify({ plain })}\`);
    }`,
    expected: ['raw'],
  },
  {
    // ACCEPT side of the `??` / `||` LEFT-arm rule in isMaskerArgument. The
    // contract's own `context?.maskSecrets ?? ((t) => t)` takes this path, so
    // an unprobed arm here means the codebase's most common masker spelling
    // rests on nothing. The existing coverage only pinned the all-identity
    // REFUSAL, which passes even if the left arm stops being consulted.
    name: 'the contract `?? identity` fallback keeps its LEFT arm a mask',
    source: `${MASK_IMPORT}
    function f(value: unknown, context?: { maskSecrets?: SecretMasker }) {
      throw new Error(
        \`got \${JSON.stringify(maskDeep(value, context?.maskSecrets ?? ((t: string) => t)))}\`
      );
    }`,
    expected: ['masked'],
  },
  {
    // REFUSE twin: EVERY arm identity must still be refused, so the accept
    // above cannot be satisfied by "a `??` is always fine".
    name: 'a `??` whose every arm is identity is raw',
    source: `${MASK_IMPORT}
    function f(value: unknown) {
      const noop = (t: string) => t;
      throw new Error(\`got \${JSON.stringify(maskDeep(value, noop ?? ((t: string) => t)))}\`);
    }`,
    expected: ['raw'],
  },
  {
    name: 'the direct wrap is masked',
    source: `${MASK_IMPORT}
    function f(value: unknown, maskSecrets: SecretMasker) {
      throw new Error(\`got \${JSON.stringify(maskDeep(value, maskSecrets))}\`);
    }`,
    expected: ['masked'],
  },
  {
    name: 'an ALIASED maskDeep import is still a mask',
    source: `import { maskDeep as deepMask } from '../masked-retry-logger.js';
    function f(value: unknown, maskSecrets: SecretMasker) {
      throw new Error(\`got \${JSON.stringify(deepMask(value, maskSecrets))}\`);
    }`,
    expected: ['masked'],
  },
  {
    name: 'the bare context masker applied directly is a mask',
    source: `function f(value: string, context?: CreateContext) {
      const mask = context?.maskSecrets ?? ((t: string) => t);
      throw new Error(\`got \${JSON.stringify(mask(value))}\`);
    }`,
    expected: ['masked'],
  },
  {
    name: 'a maskerOrIdentity-bound masker is a mask',
    source: `${MASK_IMPORT}
    function f(value: string, context?: CreateContext) {
      const mask = maskerOrIdentity(context?.maskSecrets);
      throw new Error(\`got \${JSON.stringify(mask(value))}\`);
    }`,
    expected: ['masked'],
  },
  {
    name: 'a mask UPSTREAM of the stringify, through a const binding, is a mask',
    source: `function f(config: Record<string, unknown>, maskSecrets: SecretMasker) {
      const comment = typeof config['Comment'] === 'string' ? maskSecrets(config['Comment']) : '';
      return \`comment \${JSON.stringify(comment)}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'a mask applied inside a .map() callback, upstream, is a mask',
    source: `function f(expected: string[], maskSecrets: SecretMasker) {
      const expectedSorted = [...expected].sort().map((a) => maskSecrets(a));
      return \`expected=\${JSON.stringify(expectedSorted)}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'a locally RENAMED wrapper around the shared walk is a mask',
    source: `${MASK_IMPORT}
    function f(value: unknown, maskSecrets: SecretMasker) {
      const scrubLeaf = (v: unknown): unknown => maskDeep(v, maskSecrets);
      return \`got \${JSON.stringify(scrubLeaf(value))}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'a mask threaded through a HELPER PARAMETER is a mask',
    source: `${MASK_IMPORT}
    function refuse(input: unknown, maskValue: (v: unknown) => unknown = (v) => v) {
      throw new Error(\`unsupported \${JSON.stringify(maskValue(input))}\`);
    }
    function caller(value: unknown, maskSecrets: SecretMasker) {
      const maskLeaf = (v: unknown): unknown => maskDeep(v, maskSecrets);
      refuse(value, maskLeaf);
    }`,
    expected: ['masked'],
  },
  {
    name: 'a helper parameter ONE caller leaves unmasked is raw',
    source: `${MASK_IMPORT}
    function refuse(input: unknown, maskValue: (v: unknown) => unknown = (v) => v) {
      throw new Error(\`unsupported \${JSON.stringify(maskValue(input))}\`);
    }
    function a(value: unknown, maskSecrets: SecretMasker) {
      const maskLeaf = (v: unknown): unknown => maskDeep(v, maskSecrets);
      refuse(value, maskLeaf);
    }
    function b(value: unknown) {
      refuse(value);
    }`,
    expected: ['raw'],
  },
  {
    name: 'a bare parameter is raw',
    source: `function f(value: unknown) {
      throw new Error(\`got \${JSON.stringify(value)}\`);
    }`,
    expected: ['raw'],
  },
  {
    name: 'a property-bag read is raw',
    source: `function f(properties: Record<string, unknown>) {
      throw new Error(\`got \${JSON.stringify(properties['Value'])}\`);
    }`,
    expected: ['raw'],
  },
  {
    name: 'a masker MENTIONED but not applied to this value is raw',
    source: `${MASK_IMPORT}
    function f(value: unknown, other: unknown, maskSecrets: SecretMasker) {
      const masked = maskDeep(other, maskSecrets);
      use(masked);
      throw new Error(\`got \${JSON.stringify(value)}\`);
    }`,
    expected: ['raw'],
  },
  {
    name: 'masking the ELEMENTS but stringifying the pre-map array is raw',
    source: `function f(expected: string[], maskSecrets: SecretMasker) {
      const masked = expected.map((a) => maskSecrets(a));
      use(masked);
      return \`expected=\${JSON.stringify(expected)}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'a .map() whose callback does NOT mask is raw',
    source: `function f(expected: string[]) {
      const shaped = expected.map((a) => a.trim());
      return \`expected=\${JSON.stringify(shaped)}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'a conditional with ONE unmasked arm is raw',
    source: `function f(value: string, other: string, maskSecrets: SecretMasker) {
      const shown = value === '' ? maskSecrets(value) : other;
      return \`got \${JSON.stringify(shown)}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'an object literal with one raw member is raw',
    source: `function f(live: Record<string, unknown>, maskSecrets: SecretMasker) {
      return \`got \${JSON.stringify({ a: maskSecrets('x'), b: live['B'] })}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'a sibling block’s masked binding does not credit an unrelated site',
    source: `function f(value: unknown, maskSecrets: SecretMasker) {
      { const shown = maskSecrets('x'); use(shown); }
      return \`got \${JSON.stringify(shown)}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'a JSON.parse result is raw',
    source: `function f(text: string) {
      const parsed: unknown = JSON.parse(text);
      throw new Error(\`bad payload \${JSON.stringify(parsed)}\`);
    }`,
    expected: ['raw'],
  },
  {
    name: 'a NON-interpolated JSON.stringify is not a site at all',
    source: `function f(value: unknown) {
      return JSON.stringify(value);
    }`,
    expected: [],
  },
  {
    name: 'a string constant is masked (it cannot carry a secret)',
    source: `function f() {
      return \`got \${JSON.stringify('literal')}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'BOTH sites on one line are classified independently',
    source: `function f(a: string[], b: string[], maskSecrets: SecretMasker) {
      const masked = a.map((x) => maskSecrets(x));
      return \`x=\${JSON.stringify(masked)} y=\${JSON.stringify(b)}\`;
    }`,
    expected: ['masked', 'raw'],
  },
  {
    name: 'a MULTI-LINE site is found and classified',
    source: `${MASK_IMPORT}
    function f(value: unknown, maskSecrets: SecretMasker) {
      return \`got \${JSON.stringify(
        maskDeep(value, maskSecrets)
      )}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'a multi-line RAW site is found too',
    source: `function f(value: unknown) {
      return \`got \${JSON.stringify(
        value
      )}\`;
    }`,
    expected: ['raw'],
  },
  // --- an IDENTITY masker masks NOTHING and must classify raw --------------
  // These four pin the rule review added: without them a genuinely raw site
  // could be silenced with `maskerOrIdentity(undefined)` and the run stayed
  // green — with the site COUNTING toward MIN_MASKED_SITES on top.
  {
    name: 'a maskerOrIdentity(undefined) binding is NOT a mask',
    source: `${MASK_IMPORT}
    const IDENTITY: MaskerFn = maskerOrIdentity(undefined);
    function f(value: unknown) {
      throw new Error(\`got \${JSON.stringify(IDENTITY(value))}\`);
    }`,
    expected: ['raw'],
  },
  {
    name: 'a maskerOrIdentity() binding with NO argument is NOT a mask',
    source: `${MASK_IMPORT}
    const IDENTITY: MaskerFn = maskerOrIdentity();
    function f(value: unknown) {
      throw new Error(\`got \${JSON.stringify(IDENTITY(value))}\`);
    }`,
    expected: ['raw'],
  },
  {
    name: 'a MaskerFn-typed binding assigned the identity function is NOT a mask',
    source: `function f(value: unknown) {
      const mask: MaskerFn = (t) => t;
      throw new Error(\`got \${JSON.stringify(mask(value))}\`);
    }`,
    expected: ['raw'],
  },
  {
    name: 'the contract default keeps its capability arm, so it IS a mask',
    // The mirror of the three above, and the reason the refusal folds `??`
    // only when EVERY arm is identity: this spelling is the contract's own,
    // its left arm IS the capability, and refusing it would red ~10 correct
    // files.
    source: `function f(value: string, context?: CreateContext) {
      const mask: MaskerFn = context?.maskSecrets ?? ((t: string) => t);
      throw new Error(\`got \${JSON.stringify(mask(value))}\`);
    }`,
    expected: ['masked'],
  },
  // --- an identity in the walk's MASKER-ARGUMENT position ------------------
  // The position the first cut of the identity rule did NOT cover, and the one
  // the codebase actually writes: `maskDeep(value, mask)`. Refusing the identity
  // NAME as a derivation root is inert here, because the CALLEE (`maskDeep`) is
  // a root on its own. Measured before the fix: injecting the first of these
  // took the tree from 41 sites / 37 masked to 42 / 38 at exit 0, with the
  // derived masker-name count UNCHANGED at 108 -- the receipt that located the
  // hole in the argument rather than in the derivation.
  {
    name: 'the shared walk handed a named IDENTITY constant is NOT a mask',
    source: `${MASK_IMPORT}
    const IDENT: MaskerFn = maskerOrIdentity(undefined);
    function f(properties: Record<string, unknown>) {
      return \`got \${JSON.stringify(maskDeep(properties, IDENT))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'the same, with no type annotation on the constant, is NOT a mask',
    source: `${MASK_IMPORT}
    const IDENT = maskerOrIdentity(undefined);
    function f(properties: Record<string, unknown>) {
      return \`got \${JSON.stringify(maskDeep(properties, IDENT))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'the shared walk handed an INLINE identity arrow is NOT a mask',
    // No binding exists to refuse, so a rule that only inspects declarations
    // misses this one entirely.
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>) {
      return \`got \${JSON.stringify(maskDeep(properties, (t) => t))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'an identity reached through a SECOND binding hop is NOT a mask',
    source: `${MASK_IMPORT}
    const HOP_A: MaskerFn = maskerOrIdentity(undefined);
    const HOP_B = HOP_A;
    function f(properties: Record<string, unknown>) {
      return \`got \${JSON.stringify(maskDeep(properties, HOP_B))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'the shared walk handed a REAL capability is still a mask',
    // The control the four above need: without it, `isMasked` could refuse
    // every `maskDeep(...)` call and all four would still pass.
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>, context?: CreateContext) {
      return \`got \${JSON.stringify(maskDeep(properties, maskerOrIdentity(context?.maskSecrets)))}\`;
    }`,
    expected: ['masked'],
  },
  // --- the ALLOW-LIST in argument position, and its BOUND -----------------
  // The four above pin identity SPELLINGS; these pin the POLARITY. A deny-list
  // of no-op spellings cannot terminate -- a hand-rolled `function`, a cast and
  // an object property each defeated one -- so the argument position accepts
  // only the shared capability and refuses the rest by default.
  {
    name: 'a hand-rolled no-op FUNCTION DECLARATION is not the shared capability',
    source: `${MASK_IMPORT}
    function noMask(value: unknown): unknown { return value; }
    function f(p: Record<string, unknown>) {
      return \`got \${JSON.stringify(maskDeep(p, noMask))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'an identity CAST to MaskerFn is not the shared capability',
    source: `${MASK_IMPORT}
    function f(p: Record<string, unknown>) {
      return \`got \${JSON.stringify(maskDeep(p, ((t) => t) as MaskerFn))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'an arbitrary OBJECT PROPERTY is not the shared capability',
    source: `${MASK_IMPORT}
    const bag = { m: (t: unknown) => t };
    function f(p: Record<string, unknown>) {
      return \`got \${JSON.stringify(maskDeep(p, bag.m))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'a helper that FORWARDS a received masker stays a mask',
    // The control the three above need. An allow-list that refused this would
    // red the real tree, which is how a fence gets argued down rather than
    // fixed.
    source: `${MASK_IMPORT}
    function forward(value: unknown, mask: MaskerFn) {
      return \`got \${JSON.stringify(maskDeep(value, mask))}\`;
    }`,
    expected: ['masked'],
  },
  // KNOWN BOUND (4), pinned rather than discovered later. Both of these are
  // ACCEPTED, and both are measured, not assumed. A syntactic critic works from
  // the DECLARATION, so an author who declares a no-op to BE the capability is
  // believed. These probes exist so that closing the bound fails here and
  // forces the header's claim to be updated with it.
  {
    name: 'KNOWN BOUND: a no-op ANNOTATED MaskerFn is believed',
    source: `${MASK_IMPORT}
    function noMask(value: unknown): unknown { return value; }
    const FAKE: MaskerFn = noMask;
    function f(p: Record<string, unknown>) {
      return \`got \${JSON.stringify(maskDeep(p, FAKE))}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'KNOWN BOUND: a no-op named `maskSecrets` on any object is believed',
    source: `${MASK_IMPORT}
    const bag = { maskSecrets: (t: unknown) => t };
    function f(p: Record<string, unknown>) {
      return \`got \${JSON.stringify(maskDeep(p, bag.maskSecrets))}\`;
    }`,
    expected: ['masked'],
  },
  // --- provenance: the module SPECIFIER is resolved, not suffix-matched ----
  {
    name: 'a maskDeep from a same-SUFFIX but different module is NOT the shared walk',
    source: `import { maskDeep } from './my-masked-retry-logger.js';
    function f(value: unknown, maskSecrets: SecretMasker) {
      throw new Error(\`got \${JSON.stringify(maskDeep(value, maskSecrets))}\`);
    }`,
    expected: ['raw'],
  },
  // --- the ACCEPT arms review found untested anywhere ----------------------
  // Each is a PAIR: the accept probe dies if the arm is deleted, the refuse
  // probe dies if the arm degrades to `return true`. One alone leaves the
  // other direction green, which is how all three shipped unfenced.
  {
    name: 'a chain of mask-PRESERVING array methods keeps the mask',
    source: `function f(values: string[], m: MaskerFn) {
      const masked = values.map((v) => m(v));
      return \`got \${JSON.stringify(masked.filter(Boolean).sort().slice(0, 3))}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'a mask-preserving chain over a RAW receiver stays raw',
    source: `function f(values: string[]) {
      return \`got \${JSON.stringify(values.filter(Boolean).sort())}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'a `+` / `&&` composition of masked operands is masked',
    source: `function f(a: string, b: string, m: MaskerFn) {
      return \`x=\${JSON.stringify(m(a) + m(b))} y=\${JSON.stringify(m(a) && m(b))}\`;
    }`,
    expected: ['masked', 'masked'],
  },
  {
    name: 'a `+` / `&&` composition with ONE raw operand is raw',
    source: `function f(a: string, b: string, m: MaskerFn) {
      return \`x=\${JSON.stringify(m(a) + b)} y=\${JSON.stringify(b && m(a))}\`;
    }`,
    expected: ['raw', 'raw'],
  },
  {
    name: 'a TEMPLATE whose every span is masked is masked',
    source: `function f(a: string, m: MaskerFn) {
      return \`got \${JSON.stringify(\`[\${m(a)}]\`)}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'a TEMPLATE with one raw span is raw',
    source: `function f(a: string, b: string, m: MaskerFn) {
      return \`got \${JSON.stringify(\`[\${m(a)}:\${b}]\`)}\`;
    }`,
    expected: ['raw'],
  },
  // --- KNOWN BOUND (1): the concat counter must SEE its own population -----
  {
    name: 'a string-CONCAT stringify is counted but is not a site',
    source: `function f(value: unknown) {
      throw new Error('got ' + JSON.stringify(value));
    }`,
    expected: [],
    expectedConcat: 1,
  },
  // --- issue #2269 finding 1: the RECEIVER decides, not the final name -----
  // Each is a PAIR. The accept probe dies if the receiver rule is written so
  // strictly that `this` stops qualifying; the refuse probe dies the moment the
  // rule reverts to a bare `maskers.has(name)`, which is how the fence shipped.
  {
    name: 'a masker method called on `this` is a mask',
    source: `${MASK_IMPORT}
    class P {
      private maskLeaf(value: unknown, maskSecrets: SecretMasker) {
        return maskDeep(value, maskSecrets);
      }
      run(properties: Record<string, unknown>, maskSecrets: SecretMasker) {
        return \`got \${JSON.stringify(this.maskLeaf(properties, maskSecrets))}\`;
      }
    }`,
    expected: ['masked'],
  },
  {
    name: 'the same masker NAME on a FOREIGN receiver is NOT a mask',
    source: `${MASK_IMPORT}
    class P {
      private maskLeaf(value: unknown, maskSecrets: SecretMasker) {
        return maskDeep(value, maskSecrets);
      }
      run(properties: Record<string, unknown>, maskSecrets: SecretMasker) {
        const junk = { maskLeaf: (t: unknown) => t };
        return \`got \${JSON.stringify(junk.maskLeaf(properties, maskSecrets))}\`;
      }
    }`,
    expected: ['raw'],
  },
  {
    name: 'a masker method on `this` in the ARGUMENT position is a mask',
    source: `${MASK_IMPORT}
    class P {
      private maskLeaf(value: unknown, maskSecrets: SecretMasker) {
        return maskDeep(value, maskSecrets);
      }
      run(properties: Record<string, unknown>) {
        return \`got \${JSON.stringify(maskDeep(properties, this.maskLeaf))}\`;
      }
    }`,
    expected: ['masked'],
  },
  {
    name: 'the same NAME off a foreign receiver in the ARGUMENT position is raw',
    source: `${MASK_IMPORT}
    class P {
      private maskLeaf(value: unknown, maskSecrets: SecretMasker) {
        return maskDeep(value, maskSecrets);
      }
      run(properties: Record<string, unknown>) {
        const junk = { maskLeaf: (t: unknown) => t };
        return \`got \${JSON.stringify(maskDeep(properties, junk.maskLeaf))}\`;
      }
    }`,
    expected: ['raw'],
  },
  // --- issue #2269 finding 2: `identities` is scoped to its own function ---
  // The FALSE-POSITIVE direction, so the accept side is the load-bearing half:
  // a correct sibling must not be reddened by the unmasked arm next door. The
  // refuse side is the control -- without it, scoping could degrade into
  // "identity bindings no longer count anywhere" and the accept would still
  // pass.
  {
    name: 'an unmasked DELETE arm does not red its masked CREATE sibling',
    source: `${MASK_IMPORT}
    class P {
      create(properties: Record<string, unknown>, context?: CreateContext) {
        const mask = maskerOrIdentity(context?.maskSecrets);
        throw new Error(\`create \${JSON.stringify(maskDeep(properties, mask))}\`);
      }
      delete(properties: Record<string, unknown>) {
        const mask = maskerOrIdentity(undefined);
        throw new Error(\`delete \${JSON.stringify(maskDeep(properties, mask))}\`);
      }
    }`,
    expected: ['masked', 'raw'],
  },
  {
    name: 'a MODULE-scope identity still reds every function that names it',
    source: `${MASK_IMPORT}
    const mask = maskerOrIdentity(undefined);
    class P {
      create(properties: Record<string, unknown>) {
        throw new Error(\`create \${JSON.stringify(maskDeep(properties, mask))}\`);
      }
      delete(properties: Record<string, unknown>) {
        throw new Error(\`delete \${JSON.stringify(maskDeep(properties, mask))}\`);
      }
    }`,
    expected: ['raw', 'raw'],
  },
  {
    name: 'a sibling function’s REAL masker does not credit the arm that refused it',
    // The other half of the scoping trade: `names` is still a file-wide pool,
    // so without maskersAt subtracting the scoped refusal the delete arm would
    // be credited by create's binding of the same name -- a false NEGATIVE
    // bought with the false positive above, which is the worse direction.
    source: `${MASK_IMPORT}
    class P {
      create(properties: Record<string, unknown>, context?: CreateContext) {
        const mask = maskerOrIdentity(context?.maskSecrets);
        throw new Error(\`create \${JSON.stringify(mask(properties))}\`);
      }
      delete(properties: Record<string, unknown>) {
        const mask = maskerOrIdentity(undefined);
        throw new Error(\`delete \${JSON.stringify(mask(properties))}\`);
      }
    }`,
    expected: ['masked', 'raw'],
  },
  // --- issue #2269 nit 1: an OPTION argument past the masker ---------------
  {
    name: 'a trailing CONSTANT option does not unmask the call',
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>, maskSecrets: SecretMasker) {
      return \`got \${JSON.stringify(maskDeep(properties, maskSecrets, 1))}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'the option relaxation does NOT reach index 1, so `maskDeep(v, undefined)` is raw',
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>) {
      return \`got \${JSON.stringify(maskDeep(properties, undefined))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'a NON-constant extra argument is still refused',
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>, maskSecrets: SecretMasker, opts: unknown) {
      return \`got \${JSON.stringify(maskDeep(properties, maskSecrets, opts))}\`;
    }`,
    expected: ['raw'],
  },
  // --- issue #2269 nit 2: a CONDITIONAL masker argument -------------------
  {
    name: 'a `?:` whose BOTH arms are maskers is a mask',
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>, a: SecretMasker, b: SecretMasker, flag: boolean) {
      return \`got \${JSON.stringify(maskDeep(properties, flag ? a : b))}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'a `?:` with ONE identity arm is NOT a mask',
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>, a: SecretMasker, flag: boolean) {
      return \`got \${JSON.stringify(maskDeep(properties, flag ? a : ((t: string) => t)))}\`;
    }`,
    expected: ['raw'],
  },
  // --- KNOWN BOUND (5): the bare message-sink counter sees its population --
  {
    name: 'a bare `logger.warn(JSON.stringify(x))` is counted but is not a site',
    source: `function f(value: unknown, logger: { warn(m: string): void }) {
      logger.warn(JSON.stringify(value));
    }`,
    expected: [],
    expectedBareSink: 1,
  },
  {
    name: 'a bare `this.logger.debug(JSON.stringify(x))` is counted too',
    source: `class P {
      private readonly logger = { debug(m: string) { return m; } };
      run(value: unknown) {
        this.logger.debug(JSON.stringify(value));
      }
    }`,
    expected: [],
    expectedBareSink: 1,
  },
  {
    name: 'a bare `new ProvisioningError(JSON.stringify(x))` is counted too',
    source: `function f(value: unknown) {
      throw new ProvisioningError(JSON.stringify(value));
    }`,
    expected: [],
    expectedBareSink: 1,
  },
  {
    name: 'a LEVEL-named method on a non-logger receiver is not a sink',
    // The refuse twin for the RECEIVER half specifically. The `Buffer.from` /
    // `createHash(...).update` twin below cannot reach it: neither name is a level,
    // so the level test rejects them before the receiver is ever consulted, and
    // making the receiver check accept anything left every assertion green.
    // Measured while probing this suite, which is why the case exists.
    source: `function f(value: unknown, metrics: { warn(m: string): void }, report: { error(m: string): void }) {
      metrics.warn(JSON.stringify(value));
      report.error(JSON.stringify(value));
    }`,
    expected: [],
  },
  {
    name: 'a stringify handed to a NON-sink call is not counted',
    // The refuse twin. Without it the counter could degrade to "any call taking
    // a JSON.stringify", which would fail the real tree on `Buffer.from(...)`
    // and `createHash('sha256').update(...)` -- and a fence that reds correct code gets
    // argued down rather than fixed.
    source: `function f(value: unknown) {
      return Buffer.from(JSON.stringify(value));
    }`,
    expected: [],
  },
  // --- a named wrapper may not LAUNDER a refused identity -----------------
  // Surfaced by issue #2269's differential fence rather than by its finding
  // list: the identity refusal covered the derivation ROOT and a DIRECT call's
  // masker argument, and a one-line wrapper walked past both. The accept twin
  // is the control -- refusing every wrapper would red four real files.
  {
    name: 'a named wrapper around an IDENTITY binding does NOT launder it',
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>) {
      const mask = maskerOrIdentity(undefined);
      const maskLeaf = (v: unknown): unknown => maskDeep(v, mask);
      return \`got \${JSON.stringify(maskLeaf(properties))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'a named wrapper around a REAL capability is still a mask',
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>, context?: CreateContext) {
      const mask = maskerOrIdentity(context?.maskSecrets);
      const maskLeaf = (v: unknown): unknown => maskDeep(v, mask);
      return \`got \${JSON.stringify(maskLeaf(properties))}\`;
    }`,
    expected: ['masked'],
  },
  {
    name: 'an INLINE wrapper around an identity binding is refused too',
    source: `${MASK_IMPORT}
    function refuse(input: unknown, maskValue: (v: unknown) => unknown = (v) => v) {
      throw new Error(\`unsupported \${JSON.stringify(maskValue(input))}\`);
    }
    function caller(value: unknown) {
      const mask = maskerOrIdentity(undefined);
      refuse(value, (v: unknown) => maskDeep(v, mask));
    }`,
    expected: ['raw'],
  },
  // --- issue #2269 review round: the wrapper's OWN option guard ------------
  // The trailing-CONSTANT allowance exists TWICE -- in `isMasked` (probed by
  // "the option relaxation does NOT reach index 1") and in
  // `wrapsFirstParameter`. Only the first was fenced, so relaxing the second to
  // accept index 1 left every test green while making
  // `const maskLeaf = (v) => maskDeep(v, undefined)` a masker -- a wrapper
  // laundering a no-op, the issue #2007 class this change exists to refuse.
  {
    name: 'a wrapper handing the walk `undefined` is NOT a masker',
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>) {
      const maskLeaf = (v: unknown): unknown => maskDeep(v, undefined);
      return \`got \${JSON.stringify(maskLeaf(properties))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'a wrapper handing the walk `null` is NOT a masker',
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>) {
      const maskLeaf = (v: unknown): unknown => maskDeep(v, null);
      return \`got \${JSON.stringify(maskLeaf(properties))}\`;
    }`,
    expected: ['raw'],
  },
  {
    name: 'an INLINE wrapper handing the walk `undefined` is NOT a masker',
    source: `${MASK_IMPORT}
    function refuse(input: unknown, maskValue: (v: unknown) => unknown = (v) => v) {
      throw new Error(\`unsupported \${JSON.stringify(maskValue(input))}\`);
    }
    function caller(value: unknown) {
      refuse(value, (v: unknown) => maskDeep(v, undefined));
    }`,
    expected: ['raw'],
  },
  {
    name: 'a wrapper handing the walk a real masker AND a depth option IS a masker',
    // The accept control the three above need: the allowance is what lets a
    // wrapper carry `maskDeep`'s own third parameter, and refusing every extra
    // argument would red that spelling instead.
    source: `${MASK_IMPORT}
    function f(properties: Record<string, unknown>, maskSecrets: SecretMasker) {
      const maskLeaf = (v: unknown): unknown => maskDeep(v, maskSecrets, 1);
      return \`got \${JSON.stringify(maskLeaf(properties))}\`;
    }`,
    expected: ['masked'],
  },
  // --- issue #2269 review round: bound (5)'s FACTORY and chained receivers --
  {
    name: 'a factory throw `this.wrapError(JSON.stringify(x))` is counted',
    // The corpus throws 33 messages this way (24 `wrapError` + 9
    // `wrapUpdateError`), and the first cut of bound (5) required `new`, so all
    // 33 sat outside the count while the prose claimed the zero was measured.
    source: `class P {
      private wrapError(message: string): Error { return new Error(message); }
      run(value: unknown): never {
        throw this.wrapError(JSON.stringify(value));
      }
    }`,
    expected: [],
    expectedBareSink: 1,
  },
  {
    name: 'a CHAINED logger receiver is counted',
    // `getLogger().child('SNSTopicProvider').warn(...)` puts a CallExpression
    // in the receiver position, where the first receiver reader produced
    // `undefined` and dropped the site.
    source: `declare function getLogger(): { child(n: string): { warn(m: string): void } };
    function f(value: unknown) {
      getLogger().child('SNSTopicProvider').warn(JSON.stringify(value));
    }`,
    expected: [],
    expectedBareSink: 1,
  },
  {
    name: 'an `options.warn(...)` sink is counted',
    source: `function f(value: unknown, options: { warn(m: string): void }) {
      options.warn(JSON.stringify(value));
    }`,
    expected: [],
    expectedBareSink: 1,
  },
  {
    name: 'a factory-NAMED call that is not one of the error factories is not a sink',
    // The refuse twin for the factory arm: it matches by NAME, so it needs a
    // case proving the name set is consulted rather than every call accepted.
    source: `class P {
      private buildPayload(message: string): string { return message; }
      run(value: unknown): string {
        return this.buildPayload(JSON.stringify(value));
      }
    }`,
    expected: [],
  },
  // --- issue #2269 review round: the truncation flag is a probe output -----
  {
    name: 'a growth chain that does NOT converge reports itself truncated',
    // Eleven links, each declared ABOVE the one it depends on, so growth
    // advances exactly one per round and the ten-round cap bites. The verdict
    // is allowed to be wrong (fail-closed); the point is that it is no longer
    // wrong SILENTLY, and this probe is what makes the CLI say so.
    source: `import { maskDeep } from '../masked-retry-logger.js';
    function f(p: Record<string, unknown>, m: SecretMasker) {
      const w11 = (v: unknown): unknown => w10(v);
      const w10 = (v: unknown): unknown => w9(v);
      const w9 = (v: unknown): unknown => w8(v);
      const w8 = (v: unknown): unknown => w7(v);
      const w7 = (v: unknown): unknown => w6(v);
      const w6 = (v: unknown): unknown => w5(v);
      const w5 = (v: unknown): unknown => w4(v);
      const w4 = (v: unknown): unknown => w3(v);
      const w3 = (v: unknown): unknown => w2(v);
      const w2 = (v: unknown): unknown => w1(v);
      const w1 = (v: unknown): unknown => maskDeep(v, m);
      return \`got \${JSON.stringify(w11(p))}\`;
    }`,
    expected: ['raw'],
    expectedTruncated: true,
  },
  {
    name: 'a NINE-link chain converges, so the flag discriminates',
    source: `import { maskDeep } from '../masked-retry-logger.js';
    function f(p: Record<string, unknown>, m: SecretMasker) {
      const w9 = (v: unknown): unknown => w8(v);
      const w8 = (v: unknown): unknown => w7(v);
      const w7 = (v: unknown): unknown => w6(v);
      const w6 = (v: unknown): unknown => w5(v);
      const w5 = (v: unknown): unknown => w4(v);
      const w4 = (v: unknown): unknown => w3(v);
      const w3 = (v: unknown): unknown => w2(v);
      const w2 = (v: unknown): unknown => w1(v);
      const w1 = (v: unknown): unknown => maskDeep(v, m);
      return \`got \${JSON.stringify(w9(p))}\`;
    }`,
    expected: ['masked'],
  },
  // --- issue #2269 round 2: bound (5) must not red CORRECT code -----------
  // The counter's FALSE-POSITIVE direction, which the widening opened and a
  // review round measured: a factory throw whose value already reached the
  // project's masker is correct code, and failing CI over it teaches the next
  // author to work AROUND the fence. Each accept has its raw twin, so the fix
  // cannot degrade into "nothing is ever counted".
  {
    name: 'a MASKED factory throw is correct code and is NOT counted',
    source: `${MASK_IMPORT}
    class P {
      private wrapError(message: string): Error { return new Error(message); }
      run(value: unknown, maskSecrets: SecretMasker): never {
        throw this.wrapError(JSON.stringify(maskDeep(value, maskSecrets)));
      }
    }`,
    expected: [],
  },
  {
    name: 'an UNMASKED factory throw is still counted',
    source: `class P {
      private wrapError(message: string): Error { return new Error(message); }
      run(properties: Record<string, unknown>): never {
        throw this.wrapError(JSON.stringify(properties));
      }
    }`,
    expected: [],
    expectedBareSink: 1,
  },
  {
    name: 'a MASKED logger sink is NOT counted',
    source: `${MASK_IMPORT}
    function f(value: unknown, maskSecrets: SecretMasker, logger: { warn(m: string): void }) {
      logger.warn(JSON.stringify(maskDeep(value, maskSecrets)));
    }`,
    expected: [],
  },
  {
    name: 'a `wrap<X>Error` the name list never mentioned is counted',
    // `wrapDeleteError` escaped the SET entirely, which is the same shape this
    // bound had just finished fixing. Matched by PATTERN now, and fenced from
    // the other side by the enumerating test over every `throw <call>` callee
    // in the corpus.
    source: `class P {
      private wrapDeleteError(message: string): Error { return new Error(message); }
      run(properties: Record<string, unknown>): never {
        throw this.wrapDeleteError(JSON.stringify(properties));
      }
    }`,
    expected: [],
    expectedBareSink: 1,
  },
  {
    name: 'a CAST argument does not smuggle a bare sink past the counter',
    // `bareMessageSinkForm` walked up through parentheses only, while
    // `unwrap` strips casts everywhere else in this file, so
    // `logger.warn(JSON.stringify(v) as string)` counted zero.
    source: `function f(properties: Record<string, unknown>, logger: { warn(m: string): void }) {
      logger.warn(JSON.stringify(properties) as string);
    }`,
    expected: [],
    expectedBareSink: 1,
  },
  {
    name: 'a sink whose argument is a TEMPLATE is a SITE, not a bare-sink count',
    // The three populations are disjoint; this pins that the new counter does
    // not double-count the one the classifier already covers.
    source: `function f(value: unknown, logger: { warn(m: string): void }) {
      logger.warn(\`got \${JSON.stringify(value)}\`);
    }`,
    expected: ['raw'],
  },
];

/**
 * What `runSelfProbes` reports back: the failures AND how many probes were
 * actually EVALUATED.
 *
 * The count is not decoration. Before issue #2178's review round the entrypoint
 * did `failures.push(...runSelfProbes())` and NOTHING spawned the binary to
 * check it — deleting that single line left the CLI at exit 0 with a
 * byte-identical success line while every vitest test stayed green, because the
 * suite called this EXPORT directly. That is the collapse-toward-green defense
 * being itself unfenced, which is the one failure this critic cannot afford.
 *
 * A count derived from `SELF_PROBES.length` would not have closed it: it would
 * report 46 whether or not the loop ran. So `ran` is incremented INSIDE the
 * loop, which makes these two degradations distinguishable and both detectable:
 *   - the call site is deleted        -> `selfProbesRun` is 0 in `--json`
 *   - the runner degrades to `[]`     -> `ran` is 0, and MIN_SELF_PROBES fires
 *
 * What this does NOT close, stated rather than left to be discovered: a
 * `runSelfProbes` rewritten to RETURN a healthy-looking constant
 * (`{ failures: [], ran: 46 }`) without looping is still believed, for the same
 * reason KNOWN BOUND (4) exists — a fence cannot out-argue a deliberate
 * mis-declaration of itself. The bound is narrower than it looks, because the
 * suite's direct classifier assertions cover the same ground the probes do; it
 * is the probe CHANNEL, not the classifier, that would go dark.
 */
export interface SelfProbeOutcome {
  failures: string[];
  ran: number;
}

export function runSelfProbes(): SelfProbeOutcome {
  const failures: string[] = [];
  let ran = 0;
  for (const probe of SELF_PROBES) {
    ran++;
    let analyzed: AnalyzedFile;
    try {
      analyzed = analyzeFile(`self-probe/${probe.name}.ts`, probe.source);
    } catch (error) {
      failures.push(
        `self-probe "${probe.name}" threw: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    const actual = analyzed.sites.map((s) => s.verdict);
    if (actual.length !== probe.expected.length || actual.some((v, i) => v !== probe.expected[i])) {
      failures.push(
        `self-probe "${probe.name}": expected [${probe.expected.join(', ')}], got [${actual.join(', ')}]`
      );
    }
    const expectedConcat = probe.expectedConcat ?? 0;
    if (analyzed.concatSites !== expectedConcat) {
      failures.push(
        `self-probe "${probe.name}": expected ${expectedConcat} concat site(s), got ` +
          `${analyzed.concatSites}`
      );
    }
    const expectedBareSink = probe.expectedBareSink ?? 0;
    if (analyzed.bareSinkSites !== expectedBareSink) {
      failures.push(
        `self-probe "${probe.name}": expected ${expectedBareSink} bare message-sink site(s), got ` +
          `${analyzed.bareSinkSites}`
      );
    }
    const expectedTruncated = probe.expectedTruncated ?? false;
    if (analyzed.fixpointTruncated !== expectedTruncated) {
      failures.push(
        `self-probe "${probe.name}": expected fixpointTruncated=${expectedTruncated}, got ` +
          `${analyzed.fixpointTruncated}`
      );
    }
  }
  return { failures, ran };
}

// ---------------------------------------------------------------------------
// Exemption audit
// ---------------------------------------------------------------------------

/**
 * An exemption is only meaningful while the site it exempts still EXISTS and is
 * still RAW. Both are checked, and the second one is why this takes the report's
 * own verdicts rather than a list flattened to `raw`:
 *
 *  - the site is GONE (fixed by deletion, moved, or its expression rewritten) —
 *    the entry is now dead text a reader would trust;
 *  - the site became MASKED with its expression TEXT unchanged — the entry is
 *    now claiming an exemption for a site that no longer needs one, and this is
 *    the RETIREMENT path the nine issue #2177 entries below are waiting on: a
 *    lane that masks `describeValue`'s value UPSTREAM leaves `JSON.stringify(
 *    value)` spelled exactly as it is today. An earlier revision of this
 *    docstring claimed both directions were checked; the code filtered on file
 *    plus expression and never read the verdict, so masking `s3-bucket-
 *    provider.ts`'s exempted value upstream left the run at exit 0 still
 *    reporting the entry as exempt. Measured on this branch before the fix;
 *    four other places repeated the same false claim and are corrected too;
 *  - a same-spelled SIBLING appeared — that is a NEW defect the entry must not
 *    silently absorb, which is what makes `count` exact rather than a floor.
 */
export function auditExemptions(sites: readonly StringifySite[]): string[] {
  const failures: string[] = [];
  for (const entry of EXEMPT) {
    const matches = sites.filter(
      (site) => site.file === entry.file && site.expression === entry.expression
    );
    if (matches.length === 0) {
      failures.push(
        `exempt site ${entry.file} \`${entry.expression}\` no longer exists (reason on file: ` +
          `"${entry.reason}") — drop the entry`
      );
      continue;
    }
    const masked = matches.filter((site) => site.verdict === 'masked');
    if (masked.length > 0) {
      failures.push(
        `exempt site ${entry.file} \`${entry.expression}\` is now MASKED (reason on file: ` +
          `"${entry.reason}") — the mask moved UPSTREAM while the expression text stayed the ` +
          `same, so the exemption no longer covers anything; drop the entry`
      );
    }
    const covered = matches.length - masked.length;
    // Reported only when the shortfall is NOT already explained by the arm
    // above; otherwise every became-masked entry fails twice, once with the
    // remedy and once with a same-spelled-sibling message that is not what
    // happened. Dropping the entry (what the first message asks for) is what
    // the next run re-audits.
    if (covered !== entry.count && masked.length === 0) {
      failures.push(
        `exempt site ${entry.file} \`${entry.expression}\` matches ${covered} unmasked site(s), ` +
          `the entry claims ${entry.count} — a same-spelled sibling is a NEW defect, not a ` +
          `covered one; split the entry or fix the site`
      );
    }
  }
  return failures;
}

function exemptionFor(site: StringifySite): Exemption | undefined {
  return EXEMPT.find(
    (entry) => entry.file === site.file && entry.expression === site.expression
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch (error) {
      throw new ScanFailure(
        `cannot read directory ${current}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch (error) {
        // A dangling symlink is a broken tree, not something to skip quietly.
        throw new ScanFailure(
          `cannot stat ${full}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (isDirectory) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

export function buildReport(providersDir: string): MaskReport {
  const files = listSourceFiles(providersDir);
  for (const extra of EXTRA_FILES) {
    const full = resolve(providersDir, '..', extra);
    try {
      statSync(full);
    } catch {
      // Skipping it silently is the failure a critic exists not to have.
      throw new ScanFailure(
        `extra scanned file ${extra} is missing next to ${providersDir} — it was in scope for ` +
          `issue #2178; if it moved, update EXTRA_FILES rather than dropping the coverage`
      );
    }
    files.push(full);
  }

  const sites: StringifySite[] = [];
  let maskerNames = 0;
  let concatSites = 0;
  const bareSinkFiles: string[] = [];
  const truncatedFiles: string[] = [];

  for (const file of files) {
    // Reported relative to the REPO, and relative to the PROVIDERS ROOT when
    // the probe seam points elsewhere, so a scratch-copy run still prints a
    // path a reader can act on — and so EXEMPT keys match either way.
    const rel = isInsideDirectory(REPO_ROOT, file)
      ? relative(REPO_ROOT, file)
      : join(PROVIDERS_ROOT_REL, relative(providersDir, file));
    const analyzed = analyzeFile(rel, readFileSync(file, 'utf8'));
    maskerNames += analyzed.maskerNames;
    concatSites += analyzed.concatSites;
    bareSinkFiles.push(...analyzed.bareSinkLocations);
    if (analyzed.fixpointTruncated) truncatedFiles.push(rel);
    for (const site of analyzed.sites) {
      const exemption = site.verdict === 'raw' ? exemptionFor(site) : undefined;
      sites.push(
        exemption ? { ...site, verdict: 'exempt', reason: exemption.reason } : site
      );
    }
  }

  return {
    filesScanned: files.length,
    filesWithSites: new Set(sites.map((s) => s.file)).size,
    sites: sites.length,
    masked: sites.filter((s) => s.verdict === 'masked').length,
    raw: sites.filter((s) => s.verdict === 'raw').length,
    exempt: sites.filter((s) => s.verdict === 'exempt').length,
    maskerNames,
    concatSites,
    bareSinkSites: bareSinkFiles.length,
    bareSinkFiles,
    fixpointTruncations: truncatedFiles.length,
    truncatedFiles,
    siteList: sites,
  };
}

/**
 * Is `file` inside `root`, on a path-SEGMENT boundary?
 *
 * `startsWith(REPO_ROOT)` — the spelling this replaced — also matches a SIBLING
 * whose name merely extends the root's (`/…/cdkd-scratch/x.ts` for a repo at
 * `/…/cdkd`), and the consequence is not cosmetic: the branch decides whether a
 * site is reported under its repo-relative path or re-rooted under
 * `PROVIDERS_ROOT_REL`, and `EXEMPT` is keyed on exactly that string. A sibling
 * matching by prefix would produce keys no entry can match while the run still
 * looks healthy.
 */
export function isInsideDirectory(root: string, file: string): boolean {
  // NORMALIZED first, and both sides stripped of a trailing separator. Without
  // the normalize, `/repo/cdkd/../evil/a.ts` reads as INSIDE `/repo/cdkd`;
  // without the strip, the predicate disagreed with itself on whether a
  // directory contains itself depending on how the caller spelled the root.
  // Neither is reachable from today's two call sites (both pass resolved
  // paths), but the function is EXPORTED and its test claims a path-SEGMENT
  // boundary, which is a stronger statement than a prefix compare can make.
  const trim = (path: string): string =>
    path.length > 1 && path.endsWith(sep) ? path.slice(0, -sep.length) : path;
  const normalizedRoot = trim(normalize(root));
  const normalizedFile = trim(normalize(file));
  if (normalizedFile === normalizedRoot) return true;
  return normalizedFile.startsWith(`${normalizedRoot}${sep}`);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export function main(
  argv: readonly string[],
  // Injected so a test can drive the FAILURE direction: the default runner's
  // probes all pass by construction, so nothing else can prove that a probe
  // failure actually reaches the exit code. The `--json` `selfProbesRun` field
  // fences the opposite direction (that the real binary runs them at all).
  runProbes: () => SelfProbeOutcome = runSelfProbes
): number {
  let providersDir = DEFAULT_PROVIDERS_DIR;
  let json = false;

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--providers-dir=')) {
      providersDir = resolve(arg.slice('--providers-dir='.length));
    } else {
      process.stderr.write(`Unrecognized argument: ${arg}\n`);
      return 2;
    }
  }

  const failures: string[] = [];

  // COLLAPSE TOWARD GREEN — checked FIRST, before any real file is read.
  const probes = runProbes();
  failures.push(...probes.failures);
  if (probes.ran < MIN_SELF_PROBES) {
    failures.push(
      `ran ${probes.ran} self-probe(s), expected at least ${MIN_SELF_PROBES}. The self-probe ` +
        `channel is what stops this critic collapsing toward green, so a run that evaluates ` +
        `almost none of them proves nothing — see MIN_SELF_PROBES.`
    );
  }

  // A scan failure RETURNS here rather than falling through with an
  // `undefined` report. The old shape carried the report through as optional
  // and then read `report?.filesScanned` in the SUCCESS line — where the value
  // can never be absent, since every path that leaves it unset has pushed a
  // failure. That optional chaining was dead, and dead narrowing in a checker
  // reads as a case someone considered.
  let report: MaskReport;
  try {
    report = buildReport(providersDir);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return emitFailures(failures);
  }

  {
    // `selfProbesRun` rides the report rather than living in `MaskReport`:
    // `buildReport` scans files and knows nothing about probes. It exists so
    // an entrypoint test that SPAWNS this binary can assert the probes ran —
    // the gap that let the call site be deleted at exit 0.
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ...report, selfProbesRun: probes.ran }, null, 2)}\n`
      );
    }

    // The audit reads each site's VERDICT — an exempted site becoming `masked`
    // is one of the two ways an entry stops being meaningful — so it is handed
    // the report's own list, unflattened. Flattening `exempt` back to `raw`
    // here (the first spelling) is exactly what made the became-masked half of
    // the audit unreachable.
    failures.push(...auditExemptions(report.siteList));

    // COLLAPSE TOWARD ZERO.
    const floors: [number, number, string][] = [
      [report.filesScanned, MIN_FILES_SCANNED, 'source files scanned'],
      [report.sites, MIN_SITES, 'interpolated `JSON.stringify` sites found'],
      [report.masked, MIN_MASKED_SITES, 'pre-stringify masked sites'],
      [report.filesWithSites, MIN_FILES_WITH_SITES, 'files carrying a site'],
      [report.maskerNames, MIN_MASKER_NAMES, 'derived masker names'],
    ];
    for (const [actual, minimum, label] of floors) {
      if (actual < minimum) {
        failures.push(`found ${actual} ${label}, expected at least ${minimum} (scan regression?)`);
      }
    }

    // KNOWN BOUND (5), fenced rather than merely stated.
    if (report.bareSinkSites > MAX_BARE_SINK_SITES) {
      failures.push(
        `found ${report.bareSinkSites} UNMASKED call(s) handing a stringify STRAIGHT to a ` +
          `message sink, expected at most ${MAX_BARE_SINK_SITES}: ` +
          `${report.bareSinkFiles.join(', ')}. That spelling reaches the SAME sink as the ` +
          `template form and is NOT classified by this critic — the population was measured at ` +
          `zero, which is the only reason widening it was deferred (issue #2269). Mask the value ` +
          `(\`maskDeep(<value>, maskerOrIdentity(context?.maskSecrets))\`), or write the site ` +
          `as a template (\`\${JSON.stringify(x)}\`) so it is classified, or widen the ` +
          `population here and re-calibrate the floors.`
      );
    }

    // The masker DERIVATION did not finish — fail-closed, but no longer silent.
    if (report.fixpointTruncations > 0) {
      failures.push(
        `${report.fixpointTruncations} file(s) hit the ${MAX_FIXPOINT_ROUNDS}-round masker-set ` +
          `growth cap without converging, so their masker set is TRUNCATED and every verdict ` +
          `computed from it under-credits — and a truncated file's sites can still read ` +
          `\`masked\`, so nothing else in this run points at it: ` +
          `${report.truncatedFiles.join(', ')}. Raise MAX_FIXPOINT_ROUNDS after checking the ` +
          `growth rules are not cycling.`
      );
    }

    // KNOWN BOUND (1), fenced rather than merely stated.
    if (report.concatSites > MAX_CONCAT_SITES) {
      failures.push(
        `found ${report.concatSites} \`'text ' + JSON.stringify(...)\` concatenation(s), expected ` +
          `at most ${MAX_CONCAT_SITES}. That spelling reaches the SAME sinks as the template form ` +
          `and is NOT classified by this critic — the population was measured at zero, which is ` +
          `the only reason widening it was deferred. Write the site as a template ` +
          `(\`\${JSON.stringify(x)}\`) so it is fenced, or widen the population here and ` +
          `re-calibrate the floors.`
      );
    }

    for (const site of report.siteList) {
      if (site.verdict !== 'raw') continue;
      failures.push(
        `${site.file}:${site.line}: \`JSON.stringify(${site.expression})\` is interpolated into a ` +
          `message with NO masker anywhere upstream. A provider's \`properties\` bag arrives ` +
          `RESOLVED, so a \`{{resolve:secretsmanager:...}}\` scalar is already PLAINTEXT here, and ` +
          `masking the FINISHED message cannot recover it: \`JSON.stringify\` escapes \`"\` / \`\\\` ` +
          `/ newlines so the secret no longer OCCURS in the line, and a message is always longer ` +
          `than the value inside it so only \`maskSecretsInText\`'s >= 4-character SUBSTRING arm ` +
          `is reachable. Mask the VALUE first — \`maskDeep(<value>, maskerOrIdentity(` +
          `context?.maskSecrets))\` from \`src/provisioning/masked-retry-logger.ts\` — or mask it ` +
          `anywhere upstream on this path; both are accepted. Reference: ` +
          `src/provisioning/providers/ssm-parameter-provider.ts, rule: ` +
          `.claude/rules/provider-masking.md.`
      );
    }
  }

  if (failures.length > 0) return emitFailures(failures);

  // Under `--json`, stdout is a DATA channel: appending the human summary to it
  // makes `--json | jq` fail on trailing text (measured: `parse error: Invalid
  // numeric literal at line 266`), and a test that slices back to the last `}`
  // to work around it pins the defect instead of catching it. The sibling
  // critic `check-local-reachability.ts` already routes its summary this way.
  const summary = json ? process.stderr : process.stdout;
  summary.write(
    `provider secret-mask check OK — ${report.filesScanned} files scanned, ` +
      `${report.sites} interpolated \`JSON.stringify\` sites across ${report.filesWithSites} ` +
      `files, ${report.masked} masked before stringify via ${report.maskerNames} derived masker ` +
      `names (${report.exempt} exempt site(s), each re-audited)\n`
  );
  return 0;
}

/** The single failure-reporting exit, so the scan-failure path prints like the rest. */
function emitFailures(failures: readonly string[]): number {
  process.stderr.write(`provider secret-mask check FAILED (${failures.length} problems)\n\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.stderr.write('\n');
  return 1;
}

/**
 * `import.meta.url === \`file://${process.argv[1]}\`` is WRONG in two ways that
 * both end in the script exiting 0 having done nothing — the precise vacuous
 * green the FLOORS exist to forbid. Node resolves the main module to its
 * REALPATH while `argv[1]` keeps the symlink, and a path needing
 * percent-encoding (a space, a `#`) never string-matches its file URL.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // `process.exit()` truncates a large `--json` payload on a pipe. Setting the
  // code lets stdout drain and the process end on its own.
  process.exitCode = main(process.argv.slice(2));
}
