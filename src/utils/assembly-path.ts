import * as fs from 'node:fs';
import * as path from 'node:path';
import { displaySafe } from './display-safe.js';

/**
 * Containment for every path a Cloud Assembly names (issue
 * [#3489](https://github.com/go-to-k/cdkd/issues/3489)).
 *
 * A manifest's `directoryName` / `templateFile` / `file` /
 * `additionalMetadataFile`, and a nested-stack row's
 * `Metadata['aws:asset:path']`, are all strings chosen by whoever WROTE the
 * assembly. `cdkd deploy -a <dir>` / `cdkd synth -a <dir>` consume a
 * PRE-SYNTHESIZED assembly with no CDK subprocess in between, so nothing
 * upstream validates them, and every site that consumed one used to
 * `path.join` it onto a directory and read the result.
 *
 * `path.join` does NOT honour a leading separator, so an ABSOLUTE value stays
 * inside the directory (`join('/tmp/cdk.out', '/abs/foo')` is
 * `/tmp/cdk.out/abs/foo`). The shape that leaves it is `..`:
 * `join('/tmp/cdk.out', '../../etc/passwd')` is `/etc/passwd`. Where that read
 * succeeds and the content parses, it becomes the template cdkd deploys.
 *
 * This is deliberately NOT the absolute-path tripwire the nested-template
 * sites already carry (go-to-k/cdkd#595, hardened in go-to-k/cdkd#3481). That
 * one detects "the assembly was not CDK-generated" and is worth refusing on
 * its own; it does not and cannot detect the escape. The two refusals stay
 * separate and word themselves differently, so a reader can tell which fired.
 *
 * A LEAF apart from `display-safe.ts`, like `nested-template-cycle.ts`, so
 * layers 1, 2 and 7 may all import it without an illegal import direction.
 */

export type ResolvedAssemblyPath =
  | {
      readonly contained: true;
      /** The path the caller should read — what `path.join` would have produced. */
      readonly path: string;
    }
  | {
      readonly contained: false;
      readonly escape: 'lexical';
      /** The lexically resolved path, for the refusal message. */
      readonly path: string;
    }
  | {
      readonly contained: false;
      readonly escape: 'symlink';
      readonly path: string;
      /** Where the symbolic link(s) actually lead. */
      readonly realPath: string;
    };

/**
 * `true` when `candidate` names something strictly beneath `base`, both given
 * as already-resolved absolute paths.
 *
 * The `..` test is SEPARATOR-AWARE rather than a bare `startsWith('..')`,
 * which would also reject a legitimate sibling named `..foo`. The empty-string
 * case is `base` itself: a directory is never a template, a manifest or a
 * metadata side file, so `.` and `./` are refused rather than read.
 */
function isInside(base: string, candidate: string): boolean {
  const rel = path.relative(base, candidate);
  if (rel === '' || rel === '..') return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(rel);
}

/**
 * `realpath(3)`, or `undefined` for a path that does not fully resolve.
 *
 * `.native` IS load-bearing and must not be simplified to `fs.realpathSync`.
 * The plain form is a JavaScript walker that folds `..` LEXICALLY — the same
 * mistake this module's own model branch is careful not to make — so it
 * disagrees with the kernel on a target carrying a `..` after a symlinked
 * component, in both directions:
 *
 * - It answers `ENOENT` for a path the kernel resolves and `readFileSync`
 *   then reads. With `cdk.out/a -> <outside>/sub` and
 *   `cdk.out/LINK.json -> a/../c.json` (both live), the JS walker folds to
 *   `cdk.out/c.json`, finds nothing, and the verdict falls through to the
 *   model — which folds the same way and calls it CONTAINED while the read
 *   returns `<outside>/c.json`. That is go-to-k/cdkd#3489's original defect,
 *   reopened by the guard meant to close it.
 * - On a case-insensitive filesystem (APFS by default) the same shape can make
 *   it SPIN. A `try`/`catch` cannot catch a spin, so a hand-modified assembly
 *   hung the very commands this check protects.
 *
 * `.native` is libuv's `realpath(3)` (`GetFinalPathNameByHandle` on Windows),
 * available since Node 8 against a floor of 22, and throws the same
 * `ENOENT` / `ELOOP` / `EACCES`. Using it is what makes the "exact whenever
 * the path resolves" claim above TRUE rather than aspirational.
 */
function tryRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** `fs.readlinkSync`, or `undefined` when `p` is not a symbolic link. */
function tryReadlink(p: string): string | undefined {
  try {
    return fs.readlinkSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Link follows before the walk gives up and reports the path as unresolvable.
 * It does NOT refuse: an exhausted budget answers `undefined`, which leaves
 * the symlink arm silent and the lexical verdict standing. That is safe
 * because the OS gives up first — macOS caps at 32 (`ELOOP`) — so a chain that
 * reaches this cap is one nothing can read or create through anyway.
 */
const MAX_LINK_HOPS = 40;

/**
 * Unresolvable path COMPONENTS the climb walks before giving up. Bounds the
 * recursion below, which is one frame per component: 20 000 components raised
 * an uncaught `RangeError` and 5 000 cost ~200 ms per call. Like the hop cap
 * this gives up rather than refusing, which is safe for the same reason —
 * nothing can read or create through a path that deep.
 */
const MAX_PATH_COMPONENTS = 1000;

/**
 * Where `target` REALLY points, for a path that may not exist yet.
 *
 * `fs.realpathSync` answers only for a path that fully resolves, and it throws
 * `ENOENT` for a DANGLING symbolic link exactly as it does for an absent file
 * — the two are indistinguishable from its result. That difference is the
 * whole point here: a write FOLLOWS a dangling link and creates the file at
 * its target, so `cdk.out/Foo.template.json -> ~/.ssh/authorized_keys` (target
 * absent) is an out-of-directory write that a realpath-only check reports as
 * contained. Measured: `cdkd synth --verbose` created the victim file.
 *
 * So each unresolvable component is handled by hand: climb to the deepest
 * ancestor that DOES resolve, then re-apply the remaining components,
 * following any symbolic link with `readlink` and re-resolving its target.
 * `undefined` means the walk could not resolve the path at all, which for
 * every caller means their own open fails too.
 *
 * KNOW WHAT THIS IS EXACT ABOUT, because the distinction is what bounds it:
 *
 * - For a path that FULLY RESOLVES, the answer is `fs.realpathSync`'s and is
 *   therefore exact. Every READ site is in this case by construction — a file
 *   that does not resolve cannot be read — so the containment verdict there is
 *   the kernel's, not this function's. The BASE side is exact there too: every
 *   one is either user-supplied (`-a`, `--output`, `cdkOutDir`) or the
 *   `dirname` of a file cdkd has just read successfully, so neither operand of
 *   a read is in the model's territory.
 * - For a path that does NOT exist yet, this is a best-effort MODEL of kernel
 *   resolution, and a model can be wrong at an edge. The known one: `..` INSIDE
 *   an unresolvable link's target is folded lexically here, while the kernel
 *   folds it only after following each preceding component, so a target of
 *   `a/../c.json` under a symlinked `a` diverges.
 *
 * That edge decides which of the TWO sites that WRITE needs a second check,
 * and the difference is the BASE rather than the act of writing:
 *
 * - `resolveVerboseTemplatePath` (`src/cli/commands/synth.ts`) writes into
 *   `--output`, which may be a pre-existing directory the assembly's author
 *   supplied, so the leaf CAN already be a symbolic link. It therefore asks
 *   the kernel directly with `lstat` and refuses one whatever it points at. A
 *   path-string model can be argued around; `lstat` cannot.
 * - `resolveInlineCodeFilePath` (`src/cli/commands/local-invoke.ts`) writes
 *   into a `mkdtemp` cdkd has just created, mode 0700 and empty, so no
 *   component of the candidate can be a symbolic link at all and the edge is
 *   unreachable. It needs no `lstat`.
 *
 * **A third write site over a base cdkd did not create needs the `lstat`**,
 * and inherits nothing from this function that would give it one.
 *
 * That second site is also the repo's first caller to `mkdirSync(...,
 * { recursive: true })` through a resolved path, which an earlier revision of
 * this comment leaned on not existing. It is still safe: the climb charges no
 * hop for a component, and exhausting `MAX_PATH_COMPONENTS` gives up into the
 * lexical verdict, which a freshly created directory has no link to defeat.
 */
function resolveThroughLinks(target: string, hops = 0, climbs = 0): string | undefined {
  const direct = tryRealpath(target);
  if (direct !== undefined) return direct;
  if (hops >= MAX_LINK_HOPS) return undefined;
  // The climb recurses once per unresolvable COMPONENT, so a path with tens of
  // thousands of them overflowed the stack — and a `RangeError` raised inside
  // `tryRealpath`'s own `try` would be swallowed by its `catch`, turning a
  // crash into a silent `undefined`. A hostile `templateFile` got a
  // non-actionable stack trace instead of the refusal. Far above any real
  // assembly (a CDK path has tens of components, not hundreds).
  if (climbs >= MAX_PATH_COMPONENTS) return undefined;

  const parent = path.dirname(target);
  // `dirname` is idempotent at a root, which `realpathSync` above would have
  // resolved — so reaching here means there is nothing left to climb.
  if (parent === target) return undefined;

  // The climb costs no hop: `hops` bounds the LINK chain, and a deep path of
  // absent components is not one. Charging the climb made the cap mean
  // "unresolvable components plus hops", so a deep enough absent path
  // exhausted the budget and silenced the arm.
  const realParent = resolveThroughLinks(parent, hops, climbs + 1);
  if (realParent === undefined) return undefined;

  const link = tryReadlink(target);
  if (link === undefined) {
    // The component simply does not exist. Whatever is created there lands
    // under the real parent.
    return path.join(realParent, path.basename(target));
  }
  // A link whose target does not resolve yet: follow it by hand, relative to
  // the directory the link itself lives in.
  //
  // `realParent`, NOT `path.dirname(target)`, and the difference is load-bearing
  // rather than stylistic — an earlier revision of this comment claimed the
  // opposite and a mutation probe falsified it. A target with a LEADING `..`
  // folds against the directory the link REALLY lives in; fold it against the
  // lexical parent instead and an escape reads as contained:
  //
  //   cdk.out/d                -> <outside>/sub      (live dir link)
  //   <outside>/sub/L.template.json -> ../x.json      (relative, dangling)
  //
  // correct: <outside>/x.json (refused).  lexical parent: contained, and the
  // write lands outside. Fenced by "resolves a relative dangling target's
  // LEADING `..` against the link's REAL directory".
  return resolveThroughLinks(path.resolve(realParent, link), hops + 1, climbs);
}

/**
 * Resolve an assembly-supplied `candidate` against `dir` and report whether
 * the result stays inside it.
 *
 * The lexical arm joins exactly the way the call sites used to
 * (`path.join`, NOT `path.resolve`), so the verdict is about the path the
 * caller will actually open. `join`'s handling of an absolute candidate makes
 * this arm strictly more permissive than a `resolve`-based one would be; an
 * absolute value therefore stays a matter for each site's own tripwire — and
 * for a site that HONOURS one, {@link absoluteAssemblyPathEscape} below is the
 * sibling that answers containment for it, because this function structurally
 * cannot.
 *
 * The SYMLINK arm exists because the lexical arm alone leaves an equivalent
 * hole: `cdk.out/link -> /etc` plus a candidate of `link/passwd` is lexically
 * contained and still reads `/etc/passwd`. Both sides go through
 * {@link resolveThroughLinks}, so an assembly directory REACHED through a link
 * (macOS spells `/tmp` as `/private/tmp`; a user may symlink `cdk.out` itself)
 * is unaffected, while a candidate that does not exist YET — the shape
 * `cdkd synth --verbose` writes, and the shape a DANGLING link presents — is
 * still resolved to where it would actually land. A real `cdk synth` writes no symbolic link
 * along any of these paths (measured against a CDK 2.268 assembly carrying a
 * Stage, two nesting levels and an asset manifest), so the arm costs a
 * legitimate assembly nothing.
 *
 * Windows shapes need no special case HERE: `path.relative` is the platform's
 * own, so a drive-relative or UNC candidate is judged by `path.win32` on
 * Windows, while on POSIX `C:\evil` and `..\..\evil` are single filename
 * components that no `readFileSync` can follow out of the directory.
 *
 * The verdict is about the assembly AS IT SITS ON DISK, which is the whole
 * threat model: a hand-modified or third-party `cdk.out` the user then points
 * cdkd at. It is NOT a defence against a process rewriting that directory
 * concurrently — the caller opens by path after this returns, so a link
 * swapped in between is outside what any check here can see.
 */
export function resolveAssemblyPath(
  dir: string,
  candidate: string,
  options?: {
    /**
     * Contain within THIS directory instead of `dir`.
     *
     * A value still RESOLVES against `dir` — that part is the caller's own
     * `path.join` and must not change — but the containment test runs against
     * a wider root. The one case is an asset manifest: `cdk synth` stages a
     * Stage's assets into the APP's outdir while the Stage's manifest sits in
     * `cdk.out/assembly-<Stage>/`, so upstream emits `source.path` of
     * `../asset.<hash>` by design (issue
     * [#3489](https://github.com/go-to-k/cdkd/issues/3489); measured against
     * aws-cdk-lib 2.268 with no flags).
     *
     * This widens the BASE, never the RULE: `path.relative` must still be
     * non-empty, non-`..`-prefixed and relative. `../../etc/passwd` is refused
     * from a Stage manifest exactly as from a top-level one, because it leaves
     * the app outdir either way.
     *
     * One consequence to know rather than rediscover: the "names the directory
     * itself" refusal stops applying to the MANIFEST's directory, since `.`
     * from a Stage manifest resolves inside the wider bound. That is harmless
     * for the only callers — an asset `source.path` is legitimately a
     * directory — but it is a side effect of widening, not a decision.
     *
     * A consequence the ABSOLUTE sibling had to fix and this arm does not:
     * `absoluteAssemblyPathEscape` compares two paths that arrive
     * INDEPENDENTLY, so it exonerates two spellings of one directory
     * (go-to-k/cdkd#3532). Here the candidate is built BY JOINING onto `base`,
     * so base and candidate share the caller's spelling by construction and
     * the mismatch cannot arise — EXCEPT between `base` and `containWithin`,
     * which are two strings. Today both derive from one `assemblyDir` value
     * threaded unchanged through the Stage recursion, so they cannot disagree;
     * a future caller that computes them apart would get a spurious REFUSAL,
     * which is worse than the spurious warning the sibling had, and must add
     * the same real-path exoneration here.
     *
     * `containWithin` must never carry an assembly-supplied value. That is the
     * invariant; the sources that satisfy it today are `StackInfo.assetOutdir`
     * and the assembly root `Synthesizer.synthesize` returns, both derived from
     * the user's own `--app` / `--output` and passed through the Stage
     * recursion UNCHANGED, so a planted manifest cannot widen its own bound.
     * A WRONG bound is not uniformly safe, so pick it, do not guess it.
     * Nothing here checks how `containWithin` relates to `dir`: a DISJOINT
     * bound costs availability, refusing everything; but an ANCESTOR of the
     * real one WIDENS — `containWithin: '/'` admits `/etc/passwd`. The bound
     * must therefore be the assembly root ITSELF and never any parent of it.
     */
    containWithin?: string;
  }
): ResolvedAssemblyPath {
  const base = path.resolve(dir);
  const bound = options?.containWithin === undefined ? base : path.resolve(options.containWithin);
  const joined = path.resolve(path.join(base, candidate));

  if (!isInside(bound, joined)) {
    return { contained: false, escape: 'lexical', path: joined };
  }

  // The same resolver on the base, so an assembly directory that does not
  // exist yet — or is itself reached through a link — does not silence the
  // whole arm.
  //
  // DEFENCE IN DEPTH, and today the identity: a probe replacing this with
  // `tryRealpath(base)` reds nothing, because a base that does not resolve has
  // nothing resolvable beneath it either, so no candidate can differ. It is
  // written this way because the ASYMMETRY was the round-2 defect in this file
  // — an arm silently doing nothing because one operand failed to resolve —
  // and the guard belongs to both operands, not to today's set of reachable
  // inputs.
  const realBase = resolveThroughLinks(bound);
  if (realBase !== undefined) {
    const realTarget = resolveThroughLinks(joined);
    if (realTarget !== undefined && !isInside(realBase, realTarget)) {
      return { contained: false, escape: 'symlink', path: joined, realPath: realTarget };
    }
  }

  return { contained: true, path: joined };
}

/**
 * Whether an ALREADY-ABSOLUTE assembly-supplied path lies outside `bound`.
 *
 * {@link resolveAssemblyPath} cannot answer this, and the reason is structural
 * rather than an oversight: its lexical arm joins with `path.join`, which does
 * NOT honour a leading separator, so an absolute candidate is folded INTO the
 * directory (`join('/tmp/cdk.out', '/abs/foo')` is `/tmp/cdk.out/abs/foo`) and
 * the verdict describes a path no caller will open. A site that HONOURS an
 * absolute value needs the verdict about the value itself.
 *
 * The one caller is `cdkd local invoke` / `cdkd local start-api`'s
 * `Metadata['aws:asset:path']` (issue
 * [#3494](https://github.com/go-to-k/cdkd/issues/3494)). Those honour an
 * absolute path because `cdk synth --no-staging` emits one — CDK writes the
 * asset's absolute SOURCE directory under `aws:cdk:disable-asset-staging`,
 * usually outside the outdir — and they WARN rather than refuse when it leaves
 * the bound, so this returns a verdict rather than throwing.
 *
 * It exists HERE, beside `resolveAssemblyPath`, so the containment rule has one
 * spelling: it reuses this module's own {@link isInside} and
 * {@link resolveThroughLinks}, symlink arm included, rather than letting a
 * caller re-spell `path.relative` and drift from it.
 *
 * `bound` itself is NOT an escape, unlike in `resolveAssemblyPath`, where an
 * empty `path.relative` means "names the directory rather than a file inside
 * it". An asset path legitimately names a DIRECTORY, so a value equal to the
 * bound is inside it and reporting it as outside would be a false statement.
 *
 * **The real-path walk runs on the ACCEPTING side too, not only to find a
 * symlink escape.** The two paths arrive here INDEPENDENTLY — the bound from
 * `-a` or the assembly's own `directoryName`, the target from the manifest —
 * so they can be two spellings of one directory (`/var/…` and `/private/var/…`
 * on macOS). `resolveAssemblyPath` never meets that, its candidate being built
 * by joining onto the base. Left alone it warned "outside the assembly" about
 * an ordinary `cdk synth --no-staging` asset, and a warning that cries wolf is
 * worse than none.
 */
export function absoluteAssemblyPathEscape(
  bound: string,
  absolutePath: string
): Extract<ResolvedAssemblyPath, { contained: false }> | undefined {
  const resolvedBound = path.resolve(bound);
  const target = path.resolve(absolutePath);
  const realBound = resolveThroughLinks(resolvedBound);
  const realTarget = resolveThroughLinks(target);

  if (!isInside(resolvedBound, target) && target !== resolvedBound) {
    // EXONERATE two spellings of ONE directory before reporting a lexical
    // escape. `resolveAssemblyPath` never needs this: its candidate is built
    // BY JOINING onto the base, so both sides share the caller's spelling by
    // construction. Here the two arrive independently — the bound from the
    // CLI's `-a` / the assembly's own `directoryName`, the target from the
    // manifest — and on macOS `/var/...` and `/private/var/...` (or
    // `/tmp` and `/private/tmp`) are the same directory under different
    // spellings. Reporting that as "outside the assembly" is a FALSE
    // statement, and a warning that cries wolf on an ordinary
    // `cdk synth --no-staging` is worse than no warning: users learn to skip
    // the line that matters.
    //
    // This only ever exonerates; it never admits a real escape. A target
    // genuinely outside the bound is outside under `realpath` too, and one
    // reached THROUGH a link out of the bound is caught by the symlink arm
    // below, which asks the opposite question.
    if (
      realBound === undefined ||
      realTarget === undefined ||
      (!isInside(realBound, realTarget) && realTarget !== realBound)
    ) {
      return { contained: false, escape: 'lexical', path: target };
    }
    return undefined;
  }

  if (realBound !== undefined) {
    if (realTarget !== undefined && !isInside(realBound, realTarget) && realTarget !== realBound) {
      return { contained: false, escape: 'symlink', path: target, realPath: realTarget };
    }
  }
  return undefined;
}

/**
 * Whether `candidate` names the SAME DIRECTORY as `bound`, by any spelling.
 *
 * It lives here, beside {@link absoluteAssemblyPathEscape}, because it asks
 * that function's question one step further on and must use its machinery to
 * answer: `path.resolve` equality is a LEXICAL test, and the two paths reach a
 * caller independently — the bound from `-a` or the assembly's own
 * `directoryName`, the candidate from the manifest — so one directory has
 * several spellings. `/tmp/cdk.out` and `/private/tmp/cdk.out` on macOS;
 * `<cdk.out>/self` where `self` is a symlink to `cdk.out`; both at once.
 *
 * **A caller that re-spells this as `resolve(a) === resolve(b)` gets a test
 * that misses every spelling but one**, which is how
 * [#3532](https://github.com/go-to-k/cdkd/issues/3532)'s asset resolvers first
 * shipped their whole-assembly warning: `absoluteAssemblyPathEscape`
 * exonerates a second spelling of the bound as INSIDE — correctly — and the
 * lexical equality beside it then said "not the bound", so the one value
 * meaning "the entire assembly is this asset" passed both tests in silence.
 * Ask this instead; do not re-derive it.
 *
 * Conservative on failure: an unresolvable side answers from the lexical
 * comparison alone, so it can only ever say "not the same", never wrongly
 * claim identity.
 */
export function namesTheSameDirectory(bound: string, candidate: string): boolean {
  const resolvedBound = path.resolve(bound);
  const target = path.resolve(candidate);
  if (target === resolvedBound) return true;

  const realBound = resolveThroughLinks(resolvedBound);
  const realTarget = resolveThroughLinks(target);
  return realBound !== undefined && realTarget !== undefined && realBound === realTarget;
}

/**
 * The escape verdict for an assembly-supplied path WITHOUT throwing, taking
 * whichever arm the value's own shape calls for.
 *
 * `resolveAssemblyPath` answers for a RELATIVE value and
 * {@link absoluteAssemblyPathEscape} for an ABSOLUTE one, and a caller that
 * only wants to WARN would otherwise branch on `path.isAbsolute` and call
 * both itself. Three sites already do exactly that
 * ([#3532](https://github.com/go-to-k/cdkd/issues/3532)'s two asset resolvers,
 * which must also THROW and so keep their own spelling), and the fourth —
 * [#3497](https://github.com/go-to-k/cdkd/issues/3497)'s BuildKit
 * passthroughs — has nothing to throw and a dozen values to judge. This is the
 * one spelling for that case.
 *
 * `base` is what a relative value resolves against; `bound` is what the result
 * must stay inside. They differ for a Stage. Returns `undefined` when the
 * value is fine, including when it names `bound` itself, which
 * {@link namesTheSameDirectory} answers — an asset path legitimately names a
 * directory and a caller that WARNS has no reason to complain about the
 * assembly root.
 */
export function assemblyPathEscape(
  base: string,
  bound: string,
  candidate: string
): Extract<ResolvedAssemblyPath, { contained: false }> | undefined {
  if (path.isAbsolute(candidate)) {
    return absoluteAssemblyPathEscape(bound, candidate);
  }
  const resolved = resolveAssemblyPath(base, candidate, { containWithin: bound });
  if (resolved.contained || namesTheSameDirectory(bound, resolved.path)) return undefined;
  return resolved;
}

/**
 * A letter or digit that neither draws as a blank nor reads as a quote.
 * `\p{L}` alone admits both, so two classes are carved out: the
 * default-ignorables, which hold letters that draw as a blank (the Hangul
 * fillers U+3164 and U+FFA0), and the quote-shaped letters — the Spacing
 * Modifier Letters block (U+02BA reads as `"`, U+02BC as `'`) plus the ones
 * outside it (U+0374, U+0559, U+07F4-U+07F5, U+A78B-U+A78C, and the halfwidth
 * sound marks U+FF9E-U+FF9F). Not all of `\p{Lm}`: U+30FC is in it, and it is
 * an ordinary character of a Japanese directory name. `classify` tests
 * {@link DEFAULT_IGNORABLE} first, so that carve-out is a backstop here, kept
 * so the class matches cdk-local's `displayUntrustedValue`.
 */
const VISIBLE_LETTER = new RegExp(
  String.raw`^(?![\p{Default_Ignorable_Code_Point}\u02b0-\u02ff\u0374\u0559\u07f4\u07f5\ua78b\ua78c\uff9e\uff9f])[\p{L}\p{N}]$`,
  'u'
);

/**
 * A combining mark, which counts only DIRECTLY after a visible letter (or a
 * mark that itself counted): on a space or on punctuation it draws on its own,
 * and U+030B / U+030E there look like a quote.
 */
const COMBINING_MARK = /^\p{M}$/u;

/**
 * A default-ignorable code point, which draws as NOTHING. Tested before the
 * mark rule, because some are combining marks (U+034F, U+17B4, U+180B, the
 * variation selectors U+FE00-U+FE0F and U+E0100-U+E01EF): after a letter they
 * would otherwise pass as bare, and `/home/me/.ss\u034fh` would print exactly
 * like `.ssh` while naming a different path (go-to-k/cdkd#3656).
 */
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

/**
 * The ASCII a bare path may carry besides letters and digits. Everything else —
 * any whitespace, any quote, any other symbol — takes the boundary, which
 * costs a legitimate path nothing but a pair of quotes.
 */
const BARE_PUNCTUATION = /^[/\\._~+@:=-]$/;

/**
 * Classify each code point: `bare` (allowed in a bare path), `shown` (shown as
 * itself inside the boundary), or `escaped`. An ALLOWLIST, because a denylist
 * has to enumerate every character that draws as a blank or reads as a quote,
 * and JS `\s` alone already misses U+2800 and U+3164.
 *
 * Each test is ONE character and this walks the value — never `^(...)+$` over
 * the whole of it: alternatives that overlap (ASCII letters are in both
 * classes) under a quantifier backtrack exponentially on a long path that
 * fails near its end, which hangs the process uncatchably.
 */
function classify(chars: readonly string[]): Array<'bare' | 'shown' | 'escaped'> {
  let afterLetter = false;
  return chars.map((ch) => {
    if (DEFAULT_IGNORABLE.test(ch)) {
      afterLetter = false;
      return 'escaped';
    }
    if (COMBINING_MARK.test(ch)) return afterLetter ? 'bare' : 'escaped';
    afterLetter = VISIBLE_LETTER.test(ch);
    if (afterLetter || BARE_PUNCTUATION.test(ch)) return 'bare';
    return ch >= ' ' && ch <= '~' ? 'shown' : 'escaped';
  });
}

/**
 * Render a filesystem path that an assembly chose, or that embeds a value it
 * chose, into cdkd's own prose (go-to-k/cdkd#3509). The caller writes NO
 * quotes around the result.
 *
 * `displaySafe` alone is not enough inside quotes of cdkd's: it is a denylist
 * of control characters and passes `'`, so a value carrying one closed cdkd's
 * quote and wrote a clause of its own into the refusal. This keeps a plain path
 * bare and puts any other one inside a JSON string literal. Inside it, `"` and
 * `\` are escaped as JSON escapes them, and so is every character that is
 * neither printable ASCII nor a visible letter — a curly or fullwidth quote
 * that could pass for the boundary's own closing `"`, and a blank that could
 * pass for a space. The result stays valid JSON: `JSON.parse` returns the
 * sanitized value.
 *
 * Deliberately NOT `displayIdent`, which go-to-k/cdkd#3506 used for a Stage
 * path: that one is ASCII-only and capped at 255 code points, and a legitimate
 * path is neither — a non-ASCII directory name would render as spaces, naming
 * a path that does not exist. Here nothing is truncated and a non-ASCII letter
 * is shown as itself. A legitimate path with a space or any symbol outside
 * `/ \ . _ ~ + @ : = -` (`/Users/me/My Project/cdk.out`,
 * `C:\Program Files (x86)\app`) renders quoted, and a non-letter non-ASCII
 * character in it (an emoji, `©`) is shown as its `\u` escape.
 */
export function displayAssemblyPath(value: string): string {
  const clean = displaySafe(value);
  // `Array.from` walks CODE POINTS, so a lone surrogate arrives alone and is
  // escaped rather than shown.
  const chars = Array.from(clean);
  const kinds = classify(chars);
  // `clean === value`: a value `displaySafe` altered (padding trimmed, a
  // control character blanked) did not arrive plain, so it gets the boundary.
  if (clean === value && chars.length > 0 && kinds.every((k) => k === 'bare')) return clean;
  let body = '';
  chars.forEach((ch, i) => {
    if (ch === '"' || ch === '\\') body += `\\${ch}`;
    else if (kinds[i] !== 'escaped') body += ch;
    else {
      for (let u = 0; u < ch.length; u++) {
        body += `\\u${ch.charCodeAt(u).toString(16).padStart(4, '0')}`;
      }
    }
  });
  return `"${body}"`;
}

/**
 * A file read-or-parse failure's CAUSE, for a message whose subject already
 * renders the path through {@link displayAssemblyPath} (go-to-k/cdkd#3617).
 *
 * - Node's own errno text repeats the path inside Node's quotes
 *   (`ENOENT: no such file or directory, open '<path>'`), so printing
 *   `err.message` whole re-opens the clause-injection the subject closed, one
 *   colon later. Every occurrence of the path is replaced with `<path>` -- the
 *   subject names it, bounded -- and what is left is sanitized.
 * - A `JSON.parse` failure is reduced to `invalid JSON`: V8 echoes a window of
 *   the file's own bytes verbatim, `'` included, and the file is assembly-chosen
 *   too -- the rule `AssemblyReader`'s `manifestReadFailureText` already states.
 */
export function describeFileReadFailure(err: unknown, filePath: string): string {
  if (err instanceof SyntaxError) return 'invalid JSON';
  const message = err instanceof Error ? err.message : String(err);
  return displaySafe(filePath === '' ? message : message.split(filePath).join('<path>'));
}

/**
 * The shared tail of every containment refusal: what the value resolved to,
 * what it escaped, and why that means the assembly is not CDK-generated. Each
 * call site supplies its own subject ("Stack 'X' has templateFile='...' which
 * ") and its own error class, because the sites throw four different types.
 * `action` completes "Refusing to ..." for a caller that declines something
 * other than loading the file — `renderNestedTemplateTreeDefect` says "deploy"
 * or "diff", matching its own sibling refusals.
 *
 * Every path goes through {@link displayAssemblyPath}, with no quotes of this
 * function's own, for the reason `AssemblyReader`'s own refusals give
 * (go-to-k/cdkd#3277): this text exists FOR a hand-modified assembly, so the
 * candidate, the resolved path and even `dir` (below a Stage it derives from
 * the manifest's `directoryName`) are all attacker-chosen, and `formatError`
 * sanitizes only an error's `cause`, never its own `message`.
 */
export function renderAssemblyPathEscape(
  escape: Extract<ResolvedAssemblyPath, { contained: false }>,
  dir: string,
  action = 'load',
  /**
   * Replaces the default "CDK emits assembly paths ..." sentence for a caller
   * whose value is NOT an assembly path. `materializeInlineCode` refuses a
   * `Handler` escaping a temp directory cdkd just created, where the default
   * text would be false twice over. The containment CLAUSE stays shared —
   * that is the point of this function — only the provenance moves.
   */
  provenanceOverride?: string
): string {
  const provenance =
    provenanceOverride ??
    `CDK emits assembly paths that stay inside the assembly directory; one that leaves it ` +
      `indicates the synth output was hand-modified or generated by a non-CDK toolchain. ` +
      `Refusing to ${action}.`;
  const base = path.resolve(dir);
  // The SYMLINK arm compares against the base as the KERNEL sees it, because
  // that is what `escape.realPath` is. With `-a /tmp/cdk.out` on macOS
  // (`/tmp -> /private/tmp`) a link to the directory itself otherwise printed
  // "outside /tmp/cdk.out", a false clause about a path that IS the
  // directory.
  const realBase = resolveThroughLinks(base) ?? base;
  const shownPath = displayAssemblyPath(escape.path);
  const shownBase = displayAssemblyPath(base);
  if (escape.escape === 'symlink') {
    // A link pointing AT the directory reaches here with `realPath === base`,
    // where the "outside" clause below would be a false statement — the same
    // correction the lexical branch carries.
    if (escape.realPath === realBase) {
      return (
        `resolves to ${shownPath}, a symbolic link to the directory ` +
        `${shownBase} itself rather than to a file inside it. ${provenance}`
      );
    }
    return (
      `resolves to ${shownPath}, which leads through a symbolic link to ` +
      `${displayAssemblyPath(escape.realPath)}, outside ${shownBase}. ${provenance}`
    );
  }
  // `.`, `./` and `sub/..` are refused because a directory is never a file to
  // read — but they resolve TO the base, so the "outside" clause below would
  // be a false statement about them.
  if (escape.path === base) {
    return `names the directory ${shownBase} itself rather than a file inside it. ${provenance}`;
  }
  return `resolves to ${shownPath}, outside ${shownBase}. ${provenance}`;
}
