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
 * (`.claude/skills/work-issues/SKILL.md` section 10-b).
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
 * USAGE
 *   node --experimental-strip-types scripts/check-provider-secret-mask.ts
 *   node --experimental-strip-types scripts/check-provider-secret-mask.ts --json
 *   node --experimental-strip-types scripts/check-provider-secret-mask.ts \
 *     --providers-dir=/tmp/scratch-copy    (test seam; probes never touch src/)
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
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
 * Floor on the number of self-probes the ENTRYPOINT actually evaluated.
 *
 * Unlike the five population floors below, this one fences the checker's own
 * collapse-toward-green defense rather than its scan. 46 probes ship; the floor
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
  /** Local names bound to the `maskerOrIdentity` import, for the same test. */
  readonly defaulters: ReadonlySet<string>;
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
  defaulters: Set<string>;
} {
  const names = new Set<string>([...importedLocalNames(source, MASK_WALK_FN)]);
  const defaulters = importedLocalNames(source, MASKER_DEFAULT_FN);
  // Refused bindings are RECORDED, not just dropped — see MaskerSet.identities.
  const identities = new Set<string>();
  const isIdentityBinding = (initializer: ts.Expression | undefined): boolean =>
    isIdentityMaskerInitializer(initializer, { identities, defaulters });

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
      if (!isIdentityBinding(node.initializer)) names.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isIdentityBinding(node.initializer)) {
        // REFUSED — see isIdentityMaskerInitializer. Recorded so the ARGUMENT
        // position of the shared walk can recognise the name too.
        identities.add(node.name.text);
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
  for (const identity of identities) names.delete(identity);
  return { names, identities, defaulters };
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
  names: ReadonlySet<string>
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
    return ts.isIdentifier(unwrapped) && unwrapped.text === first;
  });
}

export function buildMaskerSet(source: ts.SourceFile): MaskerSet {
  const { names, identities, defaulters } = maskerRoots(source);
  const functions = collectFunctions(source);
  const scoped = new Map<ts.Node, Set<string>>();

  const isMaskerExpression = (node: ts.Expression): boolean => {
    const inner = unwrap(node);
    if (ts.isIdentifier(inner)) {
      if (names.has(inner.text)) return true;
      for (const [owner, extra] of scoped) {
        if (extra.has(inner.text) && containsNode(owner, inner)) return true;
      }
      return false;
    }
    if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
      return names.has(inner.name.text) || inner.name.text === MASKER_CONTEXT_PROPERTY;
    }
    // An INLINE wrapper handed straight to the helper.
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
      return wrapsFirstParameter(inner, names);
    }
    return false;
  };

  for (let round = 0; round < 10; round += 1) {
    let changed = false;

    // RULE 1 — a NAMED wrapper around a known masker.
    for (const [name, candidates] of functions) {
      if (names.has(name)) continue;
      if (candidates.some((candidate) => wrapsFirstParameter(candidate.node, names))) {
        names.add(name);
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

    if (!changed) break;
  }

  return { names, scoped, identities, defaulters };
}

function containsNode(container: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === container) return true;
    current = current.parent;
  }
  return false;
}

/** Masker names in scope at `node`: the file-wide set plus any enclosing function's. */
function maskersAt(node: ts.Node, set: MaskerSet): Set<string> {
  const names = new Set(set.names);
  for (const [owner, extra] of set.scoped) {
    if (containsNode(owner, node)) for (const name of extra) names.add(name);
  }
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
 * (`.claude/skills/work-issues/SKILL.md` section 8: when the finding is a new
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

  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
    return maskers.has(inner.name.text) || inner.name.text === MASKER_CONTEXT_PROPERTY;
  }

  if (ts.isCallExpression(inner)) {
    const callee = calleeName(inner);
    if (callee === undefined || !identity.defaulters.has(callee)) return false;
    return !isIdentityMaskerInitializer(inner, identity);
  }

  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
    return wrapsFirstParameter(inner, maskers);
  }

  if (
    ts.isBinaryExpression(inner) &&
    (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isMaskerArgument(inner.left, maskers, identity, depth + 1);
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
    const handedARealMasker = node.arguments
      .slice(1)
      .every((argument) => isMaskerArgument(argument, maskers, identity));
    if (ts.isIdentifier(callee) && maskers.has(callee.text)) return handedARealMasker;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      const method = callee.name.text;
      if (maskers.has(method)) return handedARealMasker;
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

export interface AnalyzedFile {
  readonly sites: readonly StringifySite[];
  readonly maskerNames: number;
  /** `'x ' + JSON.stringify(y)` calls — known bound (1), fenced at zero. */
  readonly concatSites: number;
}

export function analyzeFile(file: string, text: string): AnalyzedFile {
  const source = parseSource(file, text);
  const maskerSet = buildMaskerSet(source);
  const sites: StringifySite[] = [];
  let concatSites = 0;

  const visit = (node: ts.Node): void => {
    if (isJsonStringifyCall(node) && !isInterpolated(node) && isConcatOperand(node)) {
      concatSites += 1;
    }
    if (isJsonStringifyCall(node) && isInterpolated(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const argument = node.arguments[0];
      const expression =
        argument === undefined ? '<no argument>' : normalizeExpression(argument.getText(source));
      const masked =
        argument !== undefined &&
        isMasked(argument, maskersAt(argument, maskerSet), {
          identities: maskerSet.identities,
          defaulters: maskerSet.defaulters,
        });
      sites.push({ file, line, expression, verdict: masked ? 'masked' : 'raw' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return {
    sites,
    maskerNames: maskerSet.names.size + [...maskerSet.scoped.values()].reduce((n, s) => n + s.size, 0),
    concatSites,
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

  for (const file of files) {
    // Reported relative to the REPO, and relative to the PROVIDERS ROOT when
    // the probe seam points elsewhere, so a scratch-copy run still prints a
    // path a reader can act on — and so EXEMPT keys match either way.
    const rel = file.startsWith(REPO_ROOT)
      ? relative(REPO_ROOT, file)
      : join(PROVIDERS_ROOT_REL, relative(providersDir, file));
    const analyzed = analyzeFile(rel, readFileSync(file, 'utf8'));
    maskerNames += analyzed.maskerNames;
    concatSites += analyzed.concatSites;
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
    siteList: sites,
  };
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

  let report: MaskReport | undefined;
  try {
    report = buildReport(providersDir);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (report) {
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

  if (failures.length > 0) {
    process.stderr.write(`provider secret-mask check FAILED (${failures.length} problems)\n\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.stderr.write('\n');
    return 1;
  }

  process.stdout.write(
    `provider secret-mask check OK — ${report?.filesScanned} files scanned, ` +
      `${report?.sites} interpolated \`JSON.stringify\` sites across ${report?.filesWithSites} ` +
      `files, ${report?.masked} masked before stringify via ${report?.maskerNames} derived masker ` +
      `names (${report?.exempt} exempt site(s), each re-audited)\n`
  );
  return 0;
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
