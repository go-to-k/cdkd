import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

/**
 * Every site that RENDERS a user-supplied `--profile <name>` declares how.
 *
 * Issue [#3377](https://github.com/go-to-k/cdkd/issues/3377) reported TWO
 * unsanitized sites, and every widening of the derivation found more: the
 * hand sweep found four more across two directories, and replacing its
 * identifier allow-list with a SHAPE found three more still. That progression
 * is the argument `src/utils/display-safe.ts`'s own header makes about this
 * whole class -- the rule gets widened by hand, one module at a time, missing
 * an instance every round. A per-site fix is another round of it. This is the
 * structural half.
 *
 * **The measured partition lives in ONE place**, the floors case below, and is
 * not restated here: a count repeated in a header, a commit message and a PR
 * body is three copies that drift apart, which is exactly what happened to the
 * first revision of this file (go-to-k/cdkd#3390 spec review found a header
 * saying "FIVE, in three files" above a four-file list, beside its own floors
 * saying eight-in-four).
 *
 * WHAT IT DERIVES FROM. The population is not a list of files, and not the set
 * of sites that already sanitize (a grep for the REMEDY returns only the sites
 * that have it). It is the PRECONDITION: an expression rendering a value whose
 * NAME says it holds a profile. Each such site must then declare one of two
 * verdicts:
 *
 *   - SANITIZED -- the rendering expression calls `displayIdent` / `displaySafe`,
 *     or names a local whose own declaration PROVABLY did;
 *   - ANNOTATED -- a `cdkd-profile-display: <reason>` comment above it, for a
 *     site whose output is not terminal-bound at all (the INI section header, a
 *     `docker -e` argument), one gated by `isPasteableIdent` instead, one whose
 *     value is a LITERAL, or one whose same-named value is a different subject
 *     entirely (an IAM instance profile).
 *
 * Neither is the default, on purpose: `undeclared` is, so the site written next
 * year fails here rather than inheriting nothing.
 *
 * WHAT IT CANNOT DO, stated because the sibling issue
 * go-to-k/cdkd#3378 is exactly this failure mode one fence over: a source-shape
 * check sees that a site names a helper, never that it named the RIGHT one.
 * `displayIdent` and `isPasteableIdent` are both "declared" here and only one of
 * them is correct for a command cdkd tells an operator to paste.
 * `local-profile-name-display.test.ts` is the behavioural half, and the two are
 * not substitutes.
 */

/**
 * An identifier or property whose NAME contains `profile`, in any casing.
 *
 * A SHAPE, not a seven-spelling allow-list, and that is go-to-k/cdkd#3390's
 * test review rather than generality for its own sake. The allow-list version
 * dropped a site out of the population the moment anyone RENAMED its local:
 * rewriting a render as `const shownProfileName = options.profile; …
 * ${shownProfileName}` left the fence green with raw argv reaching the
 * terminal, and the per-shape floors absorbed the missing site exactly. A fence
 * whose population is a list of names it already knows cannot see the site
 * nobody has written yet, which is the only site it exists for.
 *
 * `safeProfile` / `shownProfile` match too, even though they are already
 * sanitized, and that is deliberate: they must stay SITES so the line still
 * renders a verdict. A derivation that excluded them would shrink by one every
 * time a site was FIXED -- a fence that erases itself as it succeeds.
 */
const IDENT_TOKEN = /[A-Za-z_$][\w$]*/g;

/**
 * The identifiers in an expression that could be a VALUE -- excluding a token
 * followed by `(` AND AN ARGUMENT, which is a callee whose value sits in the
 * arguments this same walk reads. A ZERO-ARG call is KEPT: its return is the
 * value and there is nothing else in the expression to see.
 *
 * go-to-k/cdkd#3390 round 5, measured rather than anticipated: widening the
 * arms to whole statements surfaced
 * `describeLayerArnRejection(parsed.rejection)` as a role-ARN site, because the
 * FUNCTION's name carries `Arn` while the value it renders is a rejection
 * reason. The same rule keeps `resolveProfileCredentials(x)` out of the profile
 * arm. What it must NOT do is hide the ARGUMENT -- `displayIdent(arn)` still
 * yields `arn`, which is exactly the token both arms need to see -- nor a
 * zero-arg call's RETURN, which round 6 corrected after an earlier draft of
 * this comment claimed a callee name is never a value.
 */
function valueTokens(expression: string): string[] {
  const out: string[] = [];
  for (const m of expression.matchAll(IDENT_TOKEN)) {
    const after = expression.slice(m.index + m[0].length);
    // A callee whose call takes ARGUMENTS is dropped: the value is in the
    // arguments, which this same walk still sees. A ZERO-ARG call is kept,
    // because its RETURN is the value and there is nothing else to see --
    // `${cfg.getProfile()}` would otherwise vanish entirely (go-to-k/cdkd#3390
    // round 6 corrected the header's "a callee name is not a value under any
    // reading", which is false as written).
    if (/^\s*\(\s*[^)\s]/.test(after)) continue;
    out.push(m[0]);
  }
  return out;
}

function namesAProfileValue(expression: string): boolean {
  return valueTokens(expression).some((t) => /profile/i.test(t));
}

/**
 * The SECOND value class: a `--assume-role` / `--ecr-role-arn` / template-sourced
 * ROLE ARN.
 *
 * Added in go-to-k/cdkd#3390 round 3, and the reason is the round itself. The
 * profile class got this fence; the ARN class got a HAND SWEEP, and the hand
 * sweep shipped twice and was short both times -- once by a site whose local was
 * named `arn` rather than `roleArn` (the identifier-allow-list failure this file
 * had already learned one class over), and once by four sites in
 * `ecs-secrets-resolver.ts` and `local-run-task.ts` that nobody thought to grep.
 * A class with a fence and a class without, in one PR, is the experiment and the
 * control.
 *
 * `arn` EXACTLY, or a token carrying `Arn` / `ARN` as a segment -- not a
 * substring test, which would match `warn` and `warning` and make the fence
 * noisy enough to be disabled.
 */
function namesARoleArn(expression: string): boolean {
  return valueTokens(expression).some(
    (t) => t === 'arn' || /[Rr]oleArn|ROLE_ARN/.test(t) || /(?:^|[a-z0-9_$])Arn(?:[A-Z0-9_]|$)/.test(t)
  );
}

/**
 * Names that CONTAIN the word and hold something else. Each is a claim about
 * the SUBJECT, so each is pinned by a case below rather than trusted.
 *
 * `profileCredsFile` / `profileCredentialsFile` are handles to the written
 * credentials FILE -- except for their own `.profileName`, which IS the user's
 * value. An IAM `instanceProfile` is an AWS resource name, a different concept
 * that merely shares the word.
 */
const NOT_A_PROFILE_NAME = /\b(profileCredsFile|profileCredentialsFile)\s*\.\s*(?!profileName)/;
const INSTANCE_PROFILE = /[Ii]nstanceProfile|\bprofiles\b/;

/**
 * Does this expression name a profile value that is actually the user's?
 *
 * The two exclusions are applied PER EXPRESSION, never per LINE. `INSTANCE_PROFILE`
 * used to return early for the whole line, so a line naming an instance profile
 * AND rendering `${options.profile}` dropped out entirely -- the silent
 * direction (go-to-k/cdkd#3390 review, which also pinned `NOT_A_PROFILE_NAME`
 * as already correct on this point).
 */
function isProfileSite(expression: string): boolean {
  if (!namesAProfileValue(expression)) return false;
  if (NOT_A_PROFILE_NAME.test(expression)) return false;
  if (INSTANCE_PROFILE.test(expression)) return false;
  return true;
}

/**
 * Which files the ARN class is derived over.
 *
 * The `cdkd local` surface ONLY, where the profile class is derived over all of
 * `src/**`. That is a scope decision rather than an oversight: the DEPLOY path
 * has its own raw ARN renders, in `src/deployment/intrinsic-function-resolver.ts`,
 * and go-to-k/cdkd#3397 owns them. Widening this arm to `src/**` would demand a
 * verdict on those five sites inside a PR whose session never opened that
 * module, which is how a security sweep loses track of what it verified. When
 * go-to-k/cdkd#3397 lands, drop this predicate and let the ARN arm run over the
 * whole tree like its sibling.
 */
function inArnScope(file: string): boolean {
  const posix = file.replace(/\\/g, '/');
  return /^src\/cli\/commands\/local-[^/]*\.ts$/.test(posix) || posix.startsWith('src/local/');
}

function isRoleArnSite(expression: string): boolean {
  return namesARoleArn(expression);
}

/** A direct call to the sanitizer, in the rendering expression itself. */
const SANITIZER_CALL = /\b(displayIdent|displaySafe)\s*\(/;

/**
 * A local holding an ALREADY-sanitized profile, as `safeProfile` / `shownProfile`
 * do at two of the sites -- and PROVEN so, rather than believed on the strength
 * of its name.
 *
 * The proof half is not decoration. A first cut listed the two names in the
 * sanitizer pattern, and a mutation probe (P3) turned
 * `const shownProfile = displayIdent(profile)` into
 * `const shownProfile = profile` -- a real regression, reddening the behavioural
 * test -- while this fence stayed GREEN, because the NAME still matched. A
 * spelling convention is not evidence about what a variable holds. So a local
 * counts only when its own `const` DECLARATION calls a sanitizer.
 *
 * The declaration is read to the end of its STATEMENT rather than over a fixed
 * window, the same correction `annotationAbove` needed: a three-line window
 * shipped first and missed `lock-contention-message.ts`'s `safeProfile`, which
 * `vp run format` wraps across FOUR lines. Comments are blanked before the join,
 * so a `// displaySafe is not needed here` above the declaration cannot prove
 * it -- the trailing-comment defect the sibling env fence had to fix. The
 * 20-line bound is a runaway guard for a malformed file, not a semantic rule.
 */
const SANITIZED_LOCAL_DECL = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/;

function sanitizedLocals(lines: string[]): Set<string> {
  const proven = new Set<string>();
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    const head = stripLineComment(line);
    const decl = SANITIZED_LOCAL_DECL.exec(head);
    if (!decl?.[1]) return;
    const parts: string[] = [];
    for (let j = i; j < Math.min(lines.length, i + 20); j++) {
      const raw = lines[j] ?? '';
      const code = isCommentLine(raw) ? '' : stripLineComment(raw);
      parts.push(code);
      if (CLOSES_A_STATEMENT.test(code)) break;
    }
    if (SANITIZER_CALL.test(parts.join(' '))) proven.add(decl[1]);
  });
  return proven;
}

/**
 * Does this rendering expression declare itself sanitized?
 *
 * A proven local is matched as a STANDALONE identifier — never as a property
 * name — which is the second half of go-to-k/cdkd#3390's test review. The bare
 * `\bname\b` form shipped first, and with a short proven name it matched
 * INSIDE a property access: a file containing an unrelated
 * `const profile = displayIdent(raw)` made every `${options.profile}` in that
 * file read as declared, because `\bprofile\b` matches after the dot. That is
 * the SAME defect the P3 probe found on the sanitizer side, surviving one
 * layer over -- the sanitizer side stopped trusting names and the consumer
 * side did not.
 */
function isDeclared(expression: string, proven: Set<string>): boolean {
  if (SANITIZER_CALL.test(expression)) return true;
  return [...proven].some((name) =>
    new RegExp(`(?<![.?\\w$])${name}(?![\\w$])`).test(expression)
  );
}

/**
 * One marker per value CLASS, deliberately. A single marker would let a
 * `cdkd-profile-display:` comment answer for an ARN rendered on the same
 * line, which is the confluence the two-pass collector exists to avoid.
 */
const PROFILE_ANNOTATION = 'cdkd-profile-display:';
const ARN_ANNOTATION = 'cdkd-arn-display:';
/** For a line that deliberately renders a constrained value beside a sanitized one. */
const MIXED_ANNOTATION = 'cdkd-raw-beside-safe:';

interface Site {
  file: string;
  line: number;
  text: string;
  /** Which untrusted value the site renders. */
  valueClass: 'profile' | 'role-arn';
  /** `'template'` for a `${...}` substitution, `'concat'` for `+ profile +`. */
  shape: 'template' | 'concat';
  verdict: 'sanitized' | 'annotated' | 'undeclared';
}

/**
 * Drop a `//` comment from one line -- QUOTE-AWARE.
 *
 * The naive `indexOf('//')` cut at the first slash pair anywhere, including
 * inside a string literal, so a line carrying a URL
 * (`\`${displayIdent(arn)} see https://x: ${err.message}\``) had everything from
 * `https://` onward deleted and the raw operand after it became invisible. Nine
 * such lines exist in scope today, none of them currently mixed -- so it was
 * blindness rather than exposure, which is exactly the kind that is cheap now
 * and expensive once something lands on one (go-to-k/cdkd#3390 round 5).
 *
 * It also stops a `'${'` inside a literal opening the substitution counter,
 * which was making three sites absorb up to the 20-line bound.
 */
function stripLineComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Does a `cdkd-profile-display:` comment WITH A REASON govern this line?
 *
 * A walk rather than a fixed line budget, for the reason
 * `tests/unit/local/_local-surface-scope.ts` records about its own: a fixed span
 * puts sites on a boundary, where one rewrapped word flips the verdict. It
 * climbs comments and blank lines, and climbs a code line that does NOT CLOSE A
 * STATEMENT -- stopping at the first line ending in `;` or `}`.
 *
 * The stop condition is stated as "closes a statement" rather than as a list of
 * OPENERS, and that is a correction rather than a preference: an opener list
 * shipped first and reported TWO annotated sites as undeclared, because it had
 * to enumerate every way a statement can continue. Both shapes are ordinary
 * formatted output rather than anything exotic -- the INI section header is an
 * element of an array literal whose opening line ends in `[`, and the SSO hint
 * is a ternary ARM whose condition line ends in `)`. An enumeration would have
 * needed a third entry the next `vp run format` invented.
 */
const CLOSES_A_STATEMENT = /[;}]\s*$/;

function annotationAbove(lines: string[], index: number, marker: string): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;
    if (!isCommentLine(raw)) {
      if (!CLOSES_A_STATEMENT.test(stripLineComment(raw))) continue;
      return false;
    }
    const at = raw.indexOf(marker);
    if (at !== -1 && raw.slice(at + marker.length).trim() !== '') return true;
  }
  return false;
}

/**
 * Every `.ts` under `src/`, as a repo-relative POSIX path.
 *
 * The WHOLE tree, not a scoped root, and that is the fence's finding rather
 * than a default: the class spans `src/cli/commands/` and `src/state/`, and the
 * fence that covered only the reported files would have been green while the
 * `cdkd force-unlock` hint beside it was still raw. A generated `.d.ts` is
 * excluded; nothing else is.
 */
function sourceFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The OPERANDS of a string concatenation on this line — the shape the template
 * scan cannot see, and the one the originally-reported `aws sso login --profile `
 * site is written in.
 *
 * Returns the operands rather than a boolean so the verdict is decided per
 * OPERAND, exactly as the template shape decides it per substitution: a line
 * concatenating a sanitized value and a raw one must not be declared by the
 * sanitized half.
 *
 * TWO accepted shapes. A line carrying a string or template DELIMITER is a
 * render -- without one, `a + b` is arithmetic and nothing reaches a terminal.
 * And a line that is a bare operand in a WRAPPED chain (`profile +`), which
 * carries no delimiter of its own because the formatter put the literals on the
 * neighbouring lines; that is the shape the originally-reported
 * `aws sso login --profile ` site was written in before this PR reflowed it.
 *
 * Operands are split on `+` AFTER the string literals are removed, since a `+`
 * inside one is not an operator. Deliberately NOT requiring the profile operand
 * to be ADJACENT to a literal, which was the first cut: `prefix + profile +
 * suffix` between two identifier operands is a real render and was invisible to
 * it (go-to-k/cdkd#3390 review).
 */
function concatOperands(code: string): string[] {
  const isWrappedChainOperand = /^\s*[A-Za-z_$][\w$.]*\s*\+\s*$/.test(code);
  if (!/['"`]/.test(code) && !isWrappedChainOperand) return [];
  const withoutLiterals = code.replace(/`[^`]*`|'[^']*'|"[^"]*"/g, ' ');
  if (!withoutLiterals.includes('+')) return [];
  return withoutLiterals
    .split('+')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * The template substitutions on one line, as EXPRESSIONS.
 *
 * Brace-BALANCED, and that is a correction the fence made against itself. The
 * first cut matched `\$\{([^{}]*)\}`, which cannot span a nested brace of any
 * kind -- so the moment go-to-k/cdkd#3390 round 3 gave every ARN render an
 * options object (`displayIdent(arn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })`),
 * 18 of the 20 ARN sites stopped matching and the population collapsed to two.
 * The per-class floor caught it, which is exactly what a floor is for: a
 * SANITIZING change made the fence blind, and nothing else would have noticed.
 *
 * INNERMOST when a substitution CONTAINS another, which keeps the original
 * reason for the flat scan: in
 * `${options.profile ? \`--profile ${displayIdent(options.profile)}\` : 'x'}` the
 * outer mention is a truthiness TEST that renders nothing, and reporting it
 * would make every such ternary a site whose only available verdict is "the
 * condition is not a render" -- noise the next author learns to paste past. So
 * a substitution with a nested `${` yields its children instead of itself; one
 * without yields itself, braces and all.
 */
function templateSubstitutions(code: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < code.length - 1; i++) {
    if (code[i] !== '$' || code[i + 1] !== '{') continue;
    let depth = 0;
    let end = -1;
    for (let j = i + 1; j < code.length; j++) {
      if (code[j] === '{') depth++;
      else if (code[j] === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break;
    const expression = code.slice(i + 2, end);
    const nested = templateSubstitutions(expression);
    out.push(...(nested.length > 0 ? nested : [expression]));
    i = end;
  }
  return out;
}

/**
 * A STATEMENT that sanitizes one substitution and renders another RAW.
 *
 * The shape both early go-to-k/cdkd#3390 review rounds kept finding, and the one
 * neither value-class arm above can see: a guard defeated by its own NEIGHBOUR.
 * `--assume-role: STS AssumeRole(${displayIdent(arn)}) failed: ${err.message}`
 * puts `displayIdent` on the line and is still forgeable, because STS answers an
 * unparseable RoleArn with a `ValidationError` that ECHOES THE SUBMITTED VALUE
 * VERBATIM -- so the ARN returns through the error string, past the guard.
 *
 * STATEMENT-keyed, not line-keyed, and that is round 4's blocker rather than a
 * refinement. The first cut ran `templateSubstitutions` per SOURCE LINE, so a
 * `${` opening at end-of-line found no closing brace and was dropped, while the
 * continuation line held no `${` at all and returned early for having nothing
 * sanitized. `vp run format` produces exactly that shape whenever a substitution
 * is long -- and TWO live instances were sitting in `ecs-secrets-resolver.ts`,
 * in the file this very PR had just swept, with a proven repro: an SSM parameter
 * name carrying an ESC (`classifySecretArn`'s `parameter(\/.+)$` admits it,
 * since `.` excludes only line terminators) comes back through SSM's
 * `ValidationException`, which echoes the submitted name. So the fence built to
 * catch this shape could not see the shape in its own subject. Continuation
 * lines are now absorbed until the braces balance.
 *
 * Keyed on the STATEMENT rather than on any value class, which is what frees it
 * from a list of which identifiers hold untrusted data: the only observation it
 * needs is that an author who reached for a sanitizer on one operand and not the
 * next either knows something worth writing down, or has a bug. Both known
 * exceptions here are the first case, and both say so.
 *
 * It runs over `inArnScope` only, like the ARN arm and for the same reason --
 * go-to-k/cdkd#3397 owns the deploy path. So it is value-class-INDEPENDENT but
 * not tree-wide, and `src/state/lock-contention-message.ts` is outside it today.
 * Widen both arms together when that issue lands.
 */
/**
 * The whole STATEMENT beginning at `lines[i]`, comment-stripped and joined.
 *
 * Shared by ALL THREE arms since go-to-k/cdkd#3390 round 5, and the sharing is
 * the finding rather than tidiness. Round 4's blocker was that the mixed-render
 * arm read one SOURCE LINE at a time, so a substitution opening at end-of-line
 * hid the defect; that arm was fixed and the two VALUE-CLASS arms were left
 * line-keyed, i.e. carrying the identical blindness. Worse, this PR RAISED the
 * risk for them: giving twenty ARN renders a `{ maxCodePoints: … }` argument
 * makes exactly those lines the ones `vp run format` wraps.
 *
 * Absorbs while EITHER a substitution is still open (`unclosedSubstitutions`,
 * which counts only braces reached from a `${`) OR the text so far ends in a
 * `+`, the concat-continuation shape -- the second is round 5's other blind
 * spot, where a sanitized operand and a raw one sit on consecutive lines of one
 * `+` chain. Bounded at 20 lines for a malformed file.
 *
 * Returns the join AND the last line it absorbed, so a caller can SKIP those
 * lines: without that, every line of a multi-line statement starts its own join
 * and the SAME statement is reported once per line. Measured while wiring this
 * -- the profile arm read 28 sites where the tree has 10, and its `annotated`
 * floor would then have been counting line breaks. Every arm reports at the
 * line the statement STARTS on, which is where a reader looks.
 */
function joinStatement(lines: string[], i: number): { text: string; end: number } {
  let text = stripLineComment(lines[i] ?? '');
  let end = i;
  for (let j = i + 1; j < Math.min(lines.length, i + 20); j++) {
    if (unclosedSubstitutions(text) === 0 && !/\+\s*$/.test(text)) break;
    const next = isCommentLine(lines[j] ?? '') ? '' : stripLineComment(lines[j] ?? '');
    text += ' ' + next;
    end = j;
  }
  return { text, end };
}

function mixedRenderLines(
  lines: string[],
  proven: Set<string> = new Set()
): { line: number; raw: string[]; exempt: boolean }[] {
  const out: { line: number; raw: string[]; exempt: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (isCommentLine(text)) continue;
    const code = stripLineComment(text);
    if (/^\s*import\b/.test(code)) continue;
    const statement = joinStatement(lines, i);
    // Substitutions AND concat operands. The arm read only `${}` until
    // go-to-k/cdkd#3390 round 6, which made `joinStatement`'s own doc about the
    // `+` chain true of the value-class arms and false of this one:
    // `` `x ${displayIdent(arn)} ` + err.message `` read as clean.
    const exprs = [...templateSubstitutions(statement.text), ...concatOperands(statement.text)];
    const safe = (e: string) => SANITIZER_CALL.test(e) || isDeclared(e, proven);
    const sanitized = exprs.filter(safe);
    const raw = exprs.filter((e) => !safe(e) && e.trim() !== '' && !/^\d+$/.test(e.trim()));
    if (sanitized.length > 0 && raw.length > 0) {
      out.push({ line: i + 1, raw, exempt: annotationAbove(lines, i, MIXED_ANNOTATION) });
    }
    i = statement.end;
  }
  return out;
}

/**
 * How many template substitutions are still OPEN at the end of this text.
 *
 * Counts only braces reached from a `${`, never every brace on the line -- the
 * first cut counted all of them and absorbed across whole statements, so an
 * object literal or a function body made unrelated later lines read as one
 * expression and produced eleven false positives. What decides whether a
 * statement continues is an unterminated SUBSTITUTION, nothing else.
 */
function unclosedSubstitutions(text: string): number {
  let open = 0;
  // A `${` inside a SINGLE- or DOUBLE-quoted string is a literal, not a
  // substitution -- three sites in scope carry one, each absorbing to the
  // 20-line bound before go-to-k/cdkd#3390 round 5 fixed it.
  //
  // BACKTICK STATE IS TRACKED SEPARATELY, and that is round 6's minor rather
  // than symmetry. A `${` inside a backtick IS the thing being counted, so
  // backticks must not be skipped -- but without knowing we are inside one, an
  // ordinary ASCII apostrophe (`` `cdkd can't resolve ${...}` ``) opened a
  // single-quote span that swallowed the rest of the statement, and the
  // multi-line mixed-render shape went unseen again. Zero live instances, but
  // 15 in-scope backtick lines already carry an odd apostrophe and one
  // `vp run format` wrap moves any of them into it silently -- which is
  // round 4's blocker returning by a side door.
  //
  // Only consulted while no substitution is open, so a quote INSIDE one cannot
  // confuse the brace count.
  let tick = false;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (open === 0) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === '`') {
        tick = !tick;
        continue;
      }
      if (!tick && (ch === "'" || ch === '"')) {
        quote = ch;
        continue;
      }
      if (ch === '$' && text[i + 1] === '{') {
        open = 1;
        i++;
      }
      continue;
    }
    if (ch === '{') open++;
    else if (ch === '}') open--;
  }
  return open;
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFilesUnder('src')) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const proven = sanitizedLocals(lines);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] ?? '';
      if (isCommentLine(text)) continue;
      const code = stripLineComment(text);
      if (/^\s*import\b/.test(code)) continue;

      // The whole STATEMENT, not this line: see `joinStatement`. A value-class
      // arm reading one line at a time carried round 4's blocker unfixed.
      const statement = joinStatement(lines, i);
      const exprs = templateSubstitutions(statement.text);
      const operands = concatOperands(statement.text);

      // One pass per value CLASS. A line can hold both -- the agentcore warning
      // renders an ARN and a profile name in one template -- and each gets its
      // own verdict, because a guard on one value is no evidence about the one
      // beside it. That is not hypothetical: go-to-k/cdkd#3390 round 2 found a
      // sanitized ARN two expressions left of a raw error on the same line.
      for (const [valueClass, belongs, marker] of [
        ['profile', isProfileSite, PROFILE_ANNOTATION],
        ['role-arn', isRoleArnSite, ARN_ANNOTATION],
      ] as const) {
        if (valueClass === 'role-arn' && !inArnScope(file)) continue;
        const matched = exprs.filter(belongs);
        let shape: Site['shape'] | undefined;
        if (matched.length > 0) shape = 'template';
        else if (operands.some(belongs)) shape = 'concat';
        if (shape === undefined) continue;

        const declared =
          shape === 'concat'
            ? operands.filter(belongs).every((e) => isDeclared(e, proven))
            : matched.every((e) => isDeclared(e, proven));
        const verdict = declared
          ? 'sanitized'
          : annotationAbove(lines, i, marker)
            ? 'annotated'
            : 'undeclared';
        sites.push({ file, line: i + 1, text: text.trim(), valueClass, shape, verdict });
      }
      i = statement.end;
    }
  }
  return sites;
}

describe('every rendering of a user-supplied --profile name declares a verdict (issue #3377)', () => {
  const sites = collectSites();

  it('sees the population it claims to guard, per shape and per verdict', () => {
    // Floors, so a renamed identifier or a regex that stopped matching reports
    // a failure rather than a vacuous pass. Measured 2026-09-18 on this tree:
    // 12 sites across 6 files -- by SHAPE 11 `template`, 1 `concat`; by VERDICT
    // 3 `sanitized`, 9 `annotated`. Literals typed from that measurement, not
    // read back out of anything this fence computes, and each arm carries its
    // OWN floor because a whole-population floor stays green while one empties.
    //
    // The numbers moved once, and the move IS the finding: an earlier
    // derivation keyed on a seven-spelling identifier allow-list and saw 8
    // sites in 4 files. Widening it to the SHAPE (any identifier whose name
    // contains `profile`) found three more -- `sigv4NoCredentialsRefusal`'s two
    // literal-only interpolations and `ec2-provider.ts`'s IAM instance-profile
    // hint -- none of which the allow-list could ever have reached, whatever it
    // listed. That is why the `annotated` arm is now the larger one: most of
    // what the wider shape catches is a DIFFERENT subject that shares the word,
    // and saying so once is the whole cost.
    // PER VALUE CLASS, never a combined total. The ARN arm is four times the
    // size of the profile arm, so one shared floor would be satisfied by the
    // ARN sites alone while the profile population emptied -- the exact way a
    // whole-population floor hides an arm going dark, one level up from the
    // per-shape floors this file already carried.
    const profile = sites.filter((s) => s.valueClass === 'profile');
    const roleArn = sites.filter((s) => s.valueClass === 'role-arn');

    expect(profile.length, 'profile-rendering sites').toBeGreaterThanOrEqual(11);
    expect(
      new Set(profile.map((s) => s.file)).size,
      'files with a profile site'
    ).toBeGreaterThanOrEqual(6);
    expect(
      profile.filter((s) => s.shape === 'template').length,
      'profile `template` shape'
    ).toBeGreaterThanOrEqual(10);
    expect(
      profile.filter((s) => s.shape === 'concat').length,
      'profile `concat` shape -- the wrapped chain the template scan cannot see'
    ).toBeGreaterThanOrEqual(1);
    expect(
      profile.filter((s) => s.verdict === 'sanitized').length,
      'profile `sanitized` verdict'
    ).toBeGreaterThanOrEqual(3);
    expect(
      profile.filter((s) => s.verdict === 'annotated').length,
      'profile `annotated` verdict'
    ).toBeGreaterThanOrEqual(8);

    // Measured 2026-09-18: 20 ARN sites across 7 files, 18 sanitized and 2
    // annotated. The arm exists because the ARN class was swept BY HAND twice
    // in go-to-k/cdkd#3390 and came up short both times -- by a local named
    // `arn`, and by four sites nobody thought to grep. Its scope is the `cdkd
    // local` surface; go-to-k/cdkd#3397 owns the deploy path's copies.
    expect(roleArn.length, 'role-ARN rendering sites').toBeGreaterThanOrEqual(18);
    expect(
      new Set(roleArn.map((s) => s.file)).size,
      'files with a role-ARN site'
    ).toBeGreaterThanOrEqual(6);
    expect(
      roleArn.filter((s) => s.verdict === 'sanitized').length,
      'role-ARN `sanitized` verdict'
    ).toBeGreaterThanOrEqual(16);
    expect(
      roleArn.filter((s) => s.verdict === 'annotated').length,
      'role-ARN `annotated` verdict -- the deliberately non-display ones'
    ).toBeGreaterThanOrEqual(2);
  });

  it('reaches every DIRECTORY the class spans, not just the reported one', () => {
    // The sweep's finding, pinned: this is not a `src/cli/commands/local-*.ts`
    // problem. `src/state/lock-contention-message.ts` builds a
    // `cdkd force-unlock ... --profile <name>` line out of the same argv, and
    // `src/provisioning/providers/ec2-provider.ts` renders a same-named value
    // that is a DIFFERENT subject -- a fence scoped to the reported files would
    // have looked at neither. Three directories, asserted separately: a single
    // "more than one directory" claim stays true while two of them empty.
    const files = new Set(sites.map((s) => s.file.replace(/\\/g, '/')));
    for (const dir of ['src/cli/commands/', 'src/state/', 'src/provisioning/']) {
      expect([...files].some((f) => f.startsWith(dir)), `no site under ${dir}`).toBe(true);
    }
  });

  it('has no site that leaves the question open', () => {
    const undeclared = sites
      .filter((s) => s.verdict === 'undeclared')
      .map((s) => `${s.file}:${s.line}  [${s.shape}]  ${s.text}`);

    expect(
      undeclared,
      'This interpolates a user-supplied `--profile <name>` -- argv, so untrusted text. ' +
        'If it is terminal-bound, render it through `displayIdent` (an untrusted IDENTIFIER: ' +
        'ASCII allowlist, length cap, visible boundary) -- NOT `displaySafe`, which is for ' +
        'free-form text. If it goes into a command cdkd tells an operator to RUN, gate it on ' +
        '`isPasteableIdent` as well and print no command when that fails: `displayIdent` ' +
        'renders `~evil` and `-rf` bare and the shell reads them as a home directory and a ' +
        'flag. If it is neither -- INI file bytes, a docker `-e` argument -- write a ' +
        '`cdkd-profile-display: <reason>` comment above it saying so.'
    ).toEqual([]);
  });

  it('refuses a bare marker and a mention inside code as an annotation', () => {
    // Guard-the-guard. Both classifiers below are substring tests, which is
    // exactly how the sibling env-identity fence acquired a defect: prose
    // ABOUT the rule, or a trailing comment on a CODE line, decided a verdict.
    expect(annotationAbove(['  // cdkd-profile-display:', '  const x = 1;'], 1, PROFILE_ANNOTATION)).toBe(false);
    expect(annotationAbove(['  // cdkd-profile-display:   ', '  const x = 1;'], 1, PROFILE_ANNOTATION)).toBe(false);
    expect(
      annotationAbove(["  const tag = 'cdkd-profile-display: x';", '  const x = 1;'], 1, PROFILE_ANNOTATION)
    ).toBe(false);
    expect(
      annotationAbove(['  // cdkd-profile-display: INI bytes, not terminal', '  const x = 1;'], 1, PROFILE_ANNOTATION)
    ).toBe(true);
    // The walk climbs blank lines and a comment block, and stops at code.
    expect(
      annotationAbove(
        ['  // cdkd-profile-display: a reason', '  // more prose', '', '  const x = 1;'],
        3, PROFILE_ANNOTATION
      )
    ).toBe(true);
    expect(
      annotationAbove(
        ['  // cdkd-profile-display: a reason', '  const other = 1;', '  const x = 1;'],
        2, PROFILE_ANNOTATION
      )
    ).toBe(false);
    // ...and it climbs a code line that does not CLOSE a statement -- both
    // measured shapes: the array literal the INI writer's header is an element
    // of, and the ternary arm the SSO hint is. This clause is the widening, so
    // it is pinned in BOTH directions: a CLOSED statement above must still stop
    // the walk, or an annotation's scope becomes the rest of the file.
    expect(
      annotationAbove(
        ['  // cdkd-profile-display: a reason', '  const lines: string[] = [', '    `[${p}]`,'],
        2, PROFILE_ANNOTATION
      )
    ).toBe(true);
    expect(
      annotationAbove(
        [
          '  // cdkd-profile-display: a reason',
          '  const hint = isPasteableIdent(profile)',
          "    ? 'x ' + profile",
        ],
        2, PROFILE_ANNOTATION
      )
    ).toBe(true);
    expect(
      annotationAbove(
        ['  // cdkd-profile-display: a reason', '  const other = compute();', '    `[${p}]`,'],
        2, PROFILE_ANNOTATION
      )
    ).toBe(false);
    expect(
      annotationAbove(
        ['  // cdkd-profile-display: a reason', '  }', '    `[${p}]`,'],
        2, PROFILE_ANNOTATION
      )
    ).toBe(false);
  });

  it('classifies the shapes and the exclusions it claims to', () => {
    // The exclusions are claims about the SUBJECT, so each is pinned rather
    // than trusted: a too-wide exclusion silently empties the population, which
    // is the direction that reads as a clean tree.
    expect(INSTANCE_PROFILE.test('`Created IAM instance profile: ${instanceProfileName}`')).toBe(
      true
    );
    expect(NOT_A_PROFILE_NAME.test('profileCredsFile.hostPath')).toBe(true);
    // ...but the file handle's `profileName` IS the user's value and must stay
    // a site -- the near-miss the exclusion must not swallow.
    expect(NOT_A_PROFILE_NAME.test('file.profileName')).toBe(false);
    expect(NOT_A_PROFILE_NAME.test('profileCredsFile.profileName')).toBe(false);
    // Applied PER EXPRESSION, never per line: a line naming an instance
    // profile AND rendering the user's value must stay a site.
    expect(isProfileSite('instanceProfileName')).toBe(false);
    expect(isProfileSite('options.profile')).toBe(true);
    expect(isProfileSite('recovery.profile')).toBe(true);
    expect(isProfileSite('profileCredsFile.hostPath')).toBe(false);
    expect(isProfileSite('file.profileName')).toBe(true);
    // The SHAPE, not a name list: a local nobody has named yet is still a site.
    // This is the case the seven-spelling allow-list failed -- renaming a
    // render's local to `shownProfileName` dropped it out of the population
    // with raw argv still reaching the terminal.
    expect(isProfileSite('shownProfileName')).toBe(true);
    expect(isProfileSite('myProfile')).toBe(true);
    expect(isProfileSite('AWS_PROFILE_NAME')).toBe(true);
    // ...and a name with nothing to do with it is not.
    expect(isProfileSite('stackName')).toBe(false);
    expect(isProfileSite('err.message')).toBe(false);

    expect(isDeclared('displayIdent(options.profile)', new Set())).toBe(true);
    expect(isDeclared('options.profile', new Set())).toBe(false);
  });

  it('matches a proven local as a standalone identifier, never as a property name', () => {
    // The consumer-side twin of the P3 finding. With the bare `\\bname\\b`
    // form, a file containing an unrelated `const profile = displayIdent(raw)`
    // made every `${options.profile}` in that file read as DECLARED, because
    // the word boundary sits right after the dot. Measured on the real tree:
    // that plus stripping one `displayIdent` left the fence fully green.
    const proven = new Set(['profile']);
    expect(isDeclared('profile', proven)).toBe(true);
    expect(isDeclared('options.profile', proven), 'a property access is NOT the local').toBe(
      false
    );
    expect(isDeclared('recovery?.profile', proven)).toBe(false);
    expect(isDeclared('shownProfile', proven), 'a longer name is not the local').toBe(false);
    expect(isDeclared('profileName', proven)).toBe(false);
    // The local itself still counts inside a larger expression.
    expect(isDeclared('`--profile ${profile}`', proven)).toBe(true);
  });

  it('classifies the ROLE-ARN class by shape, and does not match mere lookalikes', () => {
    // The predicate is a claim about the SUBJECT, so both directions are pinned.
    // The `arn` EXACTLY arm is the one that matters: go-to-k/cdkd#3390 round 3
    // found a state-record-sourced ARN held in a local simply named `arn`, and a
    // `roleArn`-keyed grep could never have seen it -- the same
    // identifier-allow-list failure the profile class had already learned.
    expect(isRoleArnSite('arn')).toBe(true);
    expect(isRoleArnSite('roleArn')).toBe(true);
    expect(isRoleArnSite('args.assumeRoleArn')).toBe(true);
    expect(isRoleArnSite('options.ecrRoleArn')).toBe(true);
    expect(isRoleArnSite('shape.baseArn')).toBe(true);
    expect(isRoleArnSite('displayIdent(arn)')).toBe(true);

    // ...and the lookalikes a substring test would have swept in. A noisy fence
    // gets disabled, which is the failure mode worth more than the coverage.
    expect(isRoleArnSite('warn')).toBe(false);
    expect(isRoleArnSite('logger.warn')).toBe(false);
    expect(isRoleArnSite('warning')).toBe(false);
    expect(isRoleArnSite('learned')).toBe(false);
    expect(isRoleArnSite('stackName')).toBe(false);
  });

  it('scopes the ROLE-ARN arm to the cdkd local surface, and says why', () => {
    // A scope decision, pinned so a later widening is deliberate rather than
    // accidental -- and so that when go-to-k/cdkd#3397 lands, THIS case is what
    // reds and points at the predicate to delete.
    expect(inArnScope('src/cli/commands/local-invoke.ts')).toBe(true);
    expect(inArnScope('src/cli/commands/local-run-task.ts')).toBe(true);
    expect(inArnScope('src/local/ecr-puller.ts')).toBe(true);
    expect(inArnScope('src/local/nested/deep.ts')).toBe(true);
    // The deploy path, which go-to-k/cdkd#3397 owns.
    expect(inArnScope('src/deployment/intrinsic-function-resolver.ts')).toBe(false);
    expect(inArnScope('src/utils/role-arn.ts')).toBe(false);
    // Not the whole command tree either -- `localish.ts` is the near-miss the
    // sibling env fence pins for the same reason.
    expect(inArnScope('src/cli/commands/deploy.ts')).toBe(false);
    expect(inArnScope('src/cli/commands/localish.ts')).toBe(false);
  });

  it('keeps the two value classes separate, so one verdict cannot answer for the other', () => {
    // A line CAN hold both, and go-to-k/cdkd#3390 round 2 found a sanitized ARN
    // two expressions to the left of a raw value on one. If a single marker or a
    // single pass covered the line, the guarded value would vouch for the
    // unguarded one.
    const both = '`AssumeRole(${displayIdent(args.assumeRoleArn)}) for ${options.profile}`';
    const exprs = [...both.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1] ?? '');
    expect(exprs.filter(isRoleArnSite)).toEqual(['displayIdent(args.assumeRoleArn)']);
    expect(exprs.filter(isProfileSite)).toEqual(['options.profile']);
    // And the markers are distinct, so a profile annotation cannot license an
    // ARN render sitting above it.
    expect(PROFILE_ANNOTATION).not.toBe(ARN_ANNOTATION);
    expect(
      annotationAbove(['  // cdkd-profile-display: a reason', '  const x = 1;'], 1, ARN_ANNOTATION)
    ).toBe(false);
    expect(
      annotationAbove(['  // cdkd-arn-display: a reason', '  const x = 1;'], 1, ARN_ANNOTATION)
    ).toBe(true);
  });

  it('has no STATEMENT that sanitizes one value and renders its NEIGHBOUR raw', () => {
    // Both early review rounds of go-to-k/cdkd#3390 found this shape by hand,
    // one instance each, and the second was on the MAIN path. It is invisible to
    // the per-class arms above -- the guarded value passes, and the value beside
    // it is not in any class the fence tracks -- so it gets its own derivation.
    const offenders: string[] = [];
    const exempted: string[] = [];
    const scanned: string[] = [];
    for (const file of sourceFilesUnder('src')) {
      if (!inArnScope(file)) continue;
      scanned.push(file);
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const hit of mixedRenderLines(lines, sanitizedLocals(lines))) {
        const row = `${file}:${hit.line}  raw: ${hit.raw.join(' | ')}`;
        (hit.exempt ? exempted : offenders).push(row);
      }
    }

    // TWO FLOORS, because an empty offender list is what a CLEAN TREE and a
    // BROKEN WALK both look like -- round 4 measured two mutations that emptied
    // this arm silently (an early `return` in the walk, and narrowing the loop
    // to one file), and the constructed-input case below could not see either,
    // since it feeds the predicate directly and never runs the loop.
    //
    // The EXEMPTED floor is the stronger of the two: an exemption is produced by
    // the same code path an offender is, one branch later, so a non-zero count
    // proves the offender path itself is live rather than merely that files were
    // opened. Measured 2026-09-18: 68 in-scope files scanned, 3 exempted.
    expect(scanned.length, 'files the mixed-render walk read').toBeGreaterThanOrEqual(60);
    expect(
      exempted.length,
      'statements that WOULD offend but carry a `cdkd-raw-beside-safe:` reason -- ' +
        'zero here means the walk found nothing at all, not that the tree is clean'
    ).toBeGreaterThanOrEqual(3);

    expect(
      offenders,
      'This statement renders one value through `displayIdent` / `displaySafe` and another ' +
        'RAW beside it, so the guard is defeated by its own neighbour -- an SDK error message ' +
        'is the usual culprit, and STS and SSM both echo a submitted value verbatim in a ' +
        'validation error, so it comes back in past the guard. Sanitize the neighbour too (an ' +
        'error message is free-form text: `displaySafe`), or write a ' +
        '`cdkd-raw-beside-safe: <reason>` comment above it saying why that operand cannot ' +
        'carry anything.'
    ).toEqual([]);
  });

  it('sees the mixed-render shape it claims to, in every direction', () => {
    // Guard-the-guard on the predicate. The floors above cover the WALK; this
    // covers what the walk asks.
    const offending = ['  `AssumeRole(${displayIdent(arn)}) failed: ${err.message}`'];
    expect(mixedRenderLines(offending)).toHaveLength(1);
    expect(mixedRenderLines(offending)[0]?.raw).toEqual(['err.message']);
    expect(mixedRenderLines(offending)[0]?.exempt).toBe(false);

    // THE MULTI-LINE SHAPE -- round 4's blocker. `vp run format` wraps a long
    // substitution like this, and the line-keyed first cut saw neither line:
    // the opener has no closing brace, and the continuation has no `${`.
    expect(
      mixedRenderLines([
        '      `failed for ${displayIdent(shape.name)}: ${',
        '        err instanceof Error ? err.message : String(err)',
        '      }`',
      ]),
      'the multi-line shape must be seen'
    ).toHaveLength(1);
    // ...and the same statement, sanitized, must be clean -- otherwise the case
    // above is satisfied by a walk that flags every wrapped template.
    expect(
      mixedRenderLines([
        '      `failed for ${displayIdent(shape.name)}: ${displaySafe(',
        '        err instanceof Error ? err.message : String(err)',
        '      )}`',
      ])
    ).toEqual([]);

    // Both sanitized -> clean.
    expect(
      mixedRenderLines(['  `${displayIdent(arn)} ${displaySafe(err.message)}`'])
    ).toEqual([]);
    // NEITHER sanitized -> not this fence's question. A statement that guards
    // nothing is a wider, pre-existing class; this one is about an INCOHERENT
    // statement, where the author's own sanitizer call is the evidence that the
    // value beside it needed one too.
    expect(mixedRenderLines(['  `${arn} failed: ${err.message}`'])).toEqual([]);
    // An annotation with a reason exempts -- and is REPORTED as exempt rather
    // than dropped, which is what lets the floor above count it.
    const annotated = mixedRenderLines([
      '  // cdkd-raw-beside-safe: the other operand is a caller literal',
      '  `${displayIdent(arn)} ${purpose}`',
    ]);
    expect(annotated).toHaveLength(1);
    expect(annotated[0]?.exempt).toBe(true);
    // A bare marker is not a reason.
    const bare = mixedRenderLines([
      '  // cdkd-raw-beside-safe:',
      '  `${displayIdent(arn)} ${purpose}`',
    ]);
    expect(bare[0]?.exempt).toBe(false);
  });

  it('strips a // comment but not a // INSIDE a string literal', () => {
    // go-to-k/cdkd#3390 round 5. The naive `indexOf('//')` cut at the first
    // slash pair anywhere, so a line carrying a URL lost everything after
    // `https://` -- including a raw operand sitting past it. Nine such lines
    // exist in scope, none of them currently mixed, so it was blindness rather
    // than exposure: the kind that is cheap now and expensive once something
    // lands on one.
    expect(stripLineComment('  const x = 1; // note')).toBe('  const x = 1; ');
    expect(stripLineComment('  // whole line')).toBe('  ');
    expect(stripLineComment('  const u = `see https://x`;')).toBe('  const u = `see https://x`;');
    expect(stripLineComment("  const u = 'a//b';")).toBe("  const u = 'a//b';");
    expect(stripLineComment('  const u = "a//b"; // tail')).toBe('  const u = "a//b"; ');
    // An ESCAPED quote must not end the literal early, or everything after it
    // is read as code and a later `//` cuts the line again.
    expect(stripLineComment("  const u = 'a\\'//b'; // tail")).toBe("  const u = 'a\\'//b'; ");
    // Its SIBLING rule -- `unclosedSubstitutions` skips a `${` inside a single-
    // or double-quoted string, so a literal one cannot open the counter and
    // absorb to the 20-line bound. Three sites in scope carry one. Backticks
    // are deliberately NOT skipped: a `${` inside one is the thing being
    // counted.
    expect(unclosedSubstitutions(stripLineComment("  const s = '\\${';"))).toBe(0);
  });

  it('is not fooled by an APOSTROPHE inside a template literal (round 6)', () => {
    // Round 4's blocker returning by a side door. Without backtick tracking, an
    // ordinary `can't` opened a single-quote span that swallowed the rest of
    // the statement, so the multi-line mixed-render shape went unseen again.
    // Zero live instances -- but 15 in-scope backtick lines carry an odd
    // apostrophe and one `vp run format` wrap moves any of them into it.
    const withApostrophe = [
      "      `cdkd can't resolve ${displayIdent(shape.name)}: ${",
      '        err instanceof Error ? err.message : String(err)',
      '      }`',
    ];
    expect(mixedRenderLines(withApostrophe), 'an apostrophe hid the shape').toHaveLength(1);
    // The control: the same statement with no apostrophe was ALREADY seen, so
    // the case above is not just re-asserting what already worked.
    const without = [
      '      `cdkd cannot resolve ${displayIdent(shape.name)}: ${',
      '        err instanceof Error ? err.message : String(err)',
      '      }`',
    ];
    expect(mixedRenderLines(without)).toHaveLength(1);
    // ...and a genuine single-quoted `${` is still skipped, which is the half
    // round 5 added and this must not undo.
    expect(unclosedSubstitutions(String.raw`  const s = '\${';`)).toBe(0);
    expect(unclosedSubstitutions('  `a ${')).toBe(1);
  });

  it('keeps a ZERO-ARG call as a value, and still drops a callee with arguments', () => {
    // Round 6's nit. A call's RETURN is a value, so dropping the name of
    // `cfg.getProfile()` hides the render entirely -- there is nothing else in
    // the expression to see. A callee WITH arguments is different: the value is
    // in the arguments, which the same walk still reads.
    expect(isProfileSite('cfg.getProfile()')).toBe(true);
    expect(isRoleArnSite('resolveArn()')).toBe(true);
    expect(isRoleArnSite('describeLayerArnRejection(parsed.rejection)')).toBe(false);
    // The DROP, pinned directly. `resolveProfileCredentials(options.profile)`
    // cannot show it -- the callee AND the argument both carry `profile`, so it
    // is true under every arm (measured in round 7) -- which is why the
    // argument-less form is asserted beside it.
    expect(isProfileSite('resolveProfileCredentials(x)')).toBe(false);
    expect(isProfileSite('resolveProfileCredentials(options.profile)')).toBe(true);
    expect(isProfileSite('displayIdent(options.profile)')).toBe(true);
  });

  it('sees a raw CONCAT operand beside a sanitized substitution (round 6)', () => {
    // The mixed arm read only `${}` until round 6, so this was clean while
    // `joinStatement`'s own doc claimed the `+` chain was covered.
    expect(
      mixedRenderLines(['  `x ${displayIdent(arn)} ` + err.message + \' y\''])
    ).toHaveLength(1);
    // Both sanitized -> still clean, so the case above is not satisfied by an
    // arm that flags every concat.
    expect(
      mixedRenderLines(['  `x ${displayIdent(arn)} ` + displaySafe(err.message)'])
    ).toEqual([]);
  });

  it('extracts a substitution whose expression CONTAINS braces', () => {
    // The regression that collapsed the ARN population from 20 to 2: giving
    // every ARN render an options object made the flat `[^{}]*` scan skip it.
    // Pinned in both shapes -- the options object, and the nested-template
    // ternary whose INNER expression is the one that renders.
    expect(
      templateSubstitutions('`x ${displayIdent(arn, { maxCodePoints: CAP })} y`')
    ).toEqual(['displayIdent(arn, { maxCodePoints: CAP })']);
    expect(
      templateSubstitutions("`${o.profile ? `--profile ${displayIdent(o.profile)}` : 'x'}`")
    ).toEqual(['displayIdent(o.profile)']);
    // Several on one line, and one with no braces at all.
    expect(templateSubstitutions('`${a} and ${f(b, { k: 1 })} and ${c}`')).toEqual([
      'a',
      'f(b, { k: 1 })',
      'c',
    ]);
    // An unterminated substitution stops the walk rather than looping.
    expect(templateSubstitutions('`${broken')).toEqual([]);
  });

  it('splits a concatenation into OPERANDS, and judges each on its own', () => {
    // Per-operand, exactly as the template shape is per-substitution: a line
    // concatenating a sanitized value and a raw one must not be declared by the
    // sanitized half.
    const mixed = "'a ' + displayIdent(x) + ' b ' + options.profile";
    expect(concatOperands(mixed).filter(isProfileSite)).toEqual(['options.profile']);
    // Identifier operands on BOTH sides -- the shape an adjacency rule missed.
    expect(concatOperands("prefix + profile + suffix + 'x'").filter(isProfileSite)).toEqual([
      'profile',
    ]);
    // The wrapped-chain line, which carries no delimiter of its own.
    expect(concatOperands('          profile +').filter(isProfileSite)).toEqual(['profile']);
    // Arithmetic is not a render: no delimiter, not a chain operand.
    expect(concatOperands('const n = a + b;')).toEqual([]);
    // A `+` INSIDE a literal is not an operator.
    expect(concatOperands("const s = 'a + b';").filter(isProfileSite)).toEqual([]);
  });

  it('accepts a sanitized LOCAL only when its declaration proves it', () => {
    // The P3 probe's finding, pinned. Listing `shownProfile` as a sanitizer
    // SPELLING left the fence green while
    // `const shownProfile = displayIdent(profile)` became
    // `const shownProfile = profile` -- a regression the behavioural test
    // caught and this one did not. A naming convention is not evidence.
    const real = ['  const shownProfile = displayIdent(profile);'];
    expect(sanitizedLocals(real).has('shownProfile')).toBe(true);
    expect(isDeclared('shownProfile', sanitizedLocals(real))).toBe(true);

    const mutated = ['  const shownProfile = profile;'];
    expect(sanitizedLocals(mutated).has('shownProfile')).toBe(false);
    expect(isDeclared('shownProfile', sanitizedLocals(mutated))).toBe(false);

    // The WRAPPED declaration `vp run format` produces for a ternary
    // initializer -- `lock-contention-message.ts`'s `safeProfile`, four lines
    // wide -- which a three-line window missed.
    const wrapped = [
      '  const safeProfile =',
      '    recovery?.profile === undefined',
      '      ? undefined',
      '      : displaySafe(recovery.profile, { asciiOnly: true });',
    ];
    expect(sanitizedLocals(wrapped).has('safeProfile')).toBe(true);
    // ...and the join STOPS at that statement, so a sanitizer call in the NEXT
    // one cannot prove this one.
    const nextStatement = [
      '  const safeProfile = recovery.profile;',
      '  const other = displaySafe(x);',
    ];
    expect(sanitizedLocals(nextStatement).has('safeProfile')).toBe(false);
    // And a MENTION of the sanitizer in a comment above the declaration must
    // not prove it -- the trailing-comment defect the sibling env fence had.
    const commented = [
      '  // displaySafe is not needed here',
      '  const safeProfile = recovery.profile;',
    ];
    expect(sanitizedLocals(commented).has('safeProfile')).toBe(false);
  });
});
