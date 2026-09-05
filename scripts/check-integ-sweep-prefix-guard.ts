/**
 * Classifier for the integ-fixture "destructive prefix sweep" convention
 * (issue #2621).
 *
 * A fixture teardown often sweeps its own leftovers by LISTING them under a
 * prefix and DELETING every name the listing returns:
 *
 *   for name in $(aws logs describe-log-groups \
 *       --log-group-name-prefix "${LG_PREFIX}" \
 *       --query 'logGroups[].logGroupName' --output text); do
 *     aws logs delete-log-group --log-group-name "${name}"
 *   done
 *
 * The hazard is what an EMPTY or UNSET variable does to the filter. When the
 * filter's value is nothing but interpolations -- `"${LG_PREFIX}"`,
 * `starts_with(RoleName, '${STACK}')`, `contains(RoleName, '${STACK}')` -- an
 * empty value collapses it to the empty string, which every name matches. The
 * loop then deletes every log group / role / queue / function in the ACCOUNT.
 * Teardown is exactly where that goes unnoticed: it runs under `set +eu`, which
 * disables the one thing that would have caught the unset variable.
 *
 * A filter that keeps a LITERAL anchor after the interpolations are removed
 * (`--log-group-name-prefix "/aws/lambda/${STACK}"`) cannot collapse that far,
 * so this classifier only flags filters that degenerate to "match everything".
 *
 * THE DEFAULT IS TO FLAG. Deciding whether a listing's output reaches a delete
 * is a dataflow question a line scanner cannot answer in general, and the first
 * revision answered "no" for every shape it did not model -- a silent pass that
 * hid a pipe-to-`while read`, an `xargs`, and a capture whose loop sat more than
 * a few lines below. So an unmodelled consumption widens to the ENCLOSING
 * FUNCTION: if a destructive call appears anywhere in it, the filter must be
 * guarded. An indirection that genuinely cannot be read takes the escape hatch
 * `# allow-unguarded-sweep: <reason>` (reason mandatory), which is visible and
 * re-auditable, rather than passing silently.
 *
 * THE FLOW CROSSES FUNCTIONS, in both directions, because the archetype the
 * convention cites needs it. `tests/integration/s3-versions.sh` lists in
 * `_s3v_rows`, returns the rows by writing them to STDOUT, and deletes them in
 * `_s3v_delete_rows`, joined by a pipe in a third function -- so an
 * enclosing-function window sees a listing with no delete and a delete with no
 * listing, and the whole file reported ZERO sweeps while its `_s3v_check_prefix`
 * guard could be deleted with this fence still green. A captured value emitted
 * to stdout is therefore followed to the callers (`returnValueWindow`), and a
 * scope arriving as a POSITIONAL PARAMETER is resolved back to the argument
 * each caller passes, where the guard actually lives (`scopeSites`). When a
 * scope comes from a parameter, EVERY call site must be guarded.
 *
 * WHAT IS STILL NOT MODELLED, stated rather than claimed away:
 *
 *   - A filter that keeps a literal anchor but can still widen inside a
 *     namespace -- `--log-group-name-prefix "/aws/lambda/${STACK}"` with an
 *     empty STACK reaches every Lambda log group in the REGION. Not a
 *     `findUnguardedSweeps` failure, but NOT silent either:
 *     `findNamespaceAnchoredSweeps` enumerates them and the unit suite pins the
 *     tally, so a new one fails the build. Guarding them is issue #2682.
 *   - A scope that is a PATH SEGMENT rather than a flag value:
 *     `aws s3 rm "s3://${BUCKET}/${PREFIX}/" --recursive`. 47 occurrences; it
 *     reaches no branch here. Also #2682.
 *   - An inverted delegated guard (a helper that refuses the SAFE scope), and
 *     one whose refusing `return` is unreachable by anything other than a
 *     leading unconditional `return 0`. No static check can tell those from a
 *     correct one.
 *   - A stdout RETURN CHAIN deeper than three hops. The follow stops there; a
 *     delete beyond it is not seen. Measured: nothing in the tree relays a
 *     listing more than two hops, and the fail-closed widening cannot recover
 *     this case because the function it widens to is the one the chain began
 *     in.
 *   - `$*` / `$@` as a scope. They are seen (the filter is flagged) but no
 *     guard can bind to them by name, so such a sweep always reads unguarded.
 *
 * THE GUARD MUST DOMINATE THE SWEEP. "A `case` on the same variable appears
 * somewhere above" is not the property -- moving a sweep below the `esac`
 * satisfied it while the sweep ran for every value (measured). Only two
 * positions count, and only for a `case` whose accepting patterns cannot match
 * the empty string:
 *
 *   WRAPPING   the sweep sits inside a non-catch-all arm
 *   REFUSING   the sweep sits after `esac`, and every arm that CAN match the
 *              empty string exits or returns
 *
 * The `case` form is the only one accepted, deliberately: `[ -z "${V}" ]`,
 * `[ -n "${V}" ]` and `${V:?}` were accepted by an earlier revision and each
 * had an inverted spelling that read as a guard while doing the opposite. One
 * form with a dominance check beats four forms without one. A guard delegated
 * to a helper is recognized separately (see `hasDelegatedGuard`), because
 * `tests/integration/s3-versions.sh` -- the archetype the convention cites --
 * validates through `_s3v_check_prefix` rather than inline.
 *
 * The remedy, spelled out with both refusal verbs, is in
 * `docs/integ-fixture-conventions.md`. It is not inlined here because the real
 * log-group pattern ends in the two characters that would close this comment.
 *
 * This module is separate from its test so the classifier can be table-tested
 * against synthetic script shapes rather than only against today's tree.
 */

/** An `aws` invocation flattened onto one logical line. */
interface LogicalCommand {
  /** 0-based index of the line the command starts on. */
  start: number;
  /** 0-based index of the last line the command spans. */
  end: number;
  text: string;
}

export interface SweepFinding {
  /** 1-based line of the listing carrying the collapsible filter. */
  line: number;
  /** The offending filter, as written. */
  filter: string;
  /** Shell variables interpolated into that filter. */
  variables: string[];
}

/**
 * Destructive AWS verbs. `delete-*` covers most service spellings, but not all
 * of them: ECS retires a task definition with `deregister-task-definition`, and
 * a sweep built on one is exactly as unbounded as a sweep built on `delete-`.
 * `s3 rm` / `s3 rb` are the S3 CLI's spellings, which carry no verb prefix.
 * The set is asserted by name in the test, so widening it is a visible edit.
 */
export const DESTRUCTIVE_VERBS = [
  'delete',
  'remove',
  'deregister',
  'terminate',
  'purge',
  'revoke',
  'detach',
  'disassociate',
  'disable',
] as const;

/**
 * Destructive verbs that are not a bare `<verb>-<noun>`: ECR spells its bulk
 * delete `batch-delete-image`, KMS `schedule-key-deletion`, EC2
 * `release-address`. The general pattern below allows an optional
 * `<word>-` prefix, which covers `batch-delete-image`; these two need naming.
 */
export const DESTRUCTIVE_LITERALS = ['schedule-key-deletion', 'release-address'] as const;

// `(?:[a-z0-9-]+\s+)*` required WHITESPACE before the verb, so a compound verb
// (`batch-delete-image`) never anchored and eight live sites read as harmless.
// The `[a-z0-9-]*-` prefix is what admits them.
const DESTRUCTIVE = new RegExp(
  `\\baws\\s+(?:[a-z0-9-]+\\s+)*[a-z0-9-]*(?:${DESTRUCTIVE_VERBS.join('|')})-[a-z0-9-]+\\b` +
    `|\\baws\\s+(?:[a-z0-9-]+\\s+)*(?:${DESTRUCTIVE_LITERALS.join('|')})\\b` +
    `|\\baws\\s+s3\\s+(?:rm|rb)\\b`,
);

/** The escape hatch, with a mandatory reason of real length. */
const ALLOW_MARKER = /#\s*allow-unguarded-sweep:\s*\S.{9,}/;

/** Blanks `#` comments, leaving quoted content and line count intact. */
function stripComments(lines: string[]): string[] {
  return lines.map((line) => {
    let out = '';
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        out += ch;
        if (ch === quote && line[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
        out += ' '.repeat(line.length - i);
        break;
      }
      out += ch;
    }
    return out;
  });
}

/** The quote / command-substitution blanker, applied to already-stripped text. */
function blankQuotes(lines: string[]): string[] {
  return lines.map((line) => {
    let out = '';
    // 'dq' / 'sq' blank their contents. 'sub' (`$( )`) and 'btick' (a backtick
    // substitution) are CODE and stay readable -- `names="$(aws ... )"` is the
    // tree's commonest listing idiom, and blanking through it hid every one of
    // them; the backtick spelling is the same command in older syntax.
    const stack: ('dq' | 'sq' | 'btick' | 'sub')[] = [];
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      const top = stack[stack.length - 1];

      if (top === 'sq') {
        out += ch === "'" ? ch : ' ';
        if (ch === "'") stack.pop();
        continue;
      }
      if (top === 'dq') {
        // A backslash escapes the next character, so it cannot be the closing
        // quote. Without this, `x="a\\"` never closed and the rest of the line
        // was blanked.
        if (ch === '\\') {
          out += '  ';
          i++;
          continue;
        }
        if (ch === '$' && line[i + 1] === '(') {
          stack.push('sub');
          out += '$(';
          i++;
          continue;
        }
        out += ch === '"' ? ch : ' ';
        if (ch === '"') stack.pop();
        continue;
      }
      if (top === 'btick') {
        out += ch;
        if (ch === '`' && line[i - 1] !== '\\') stack.pop();
        continue;
      }

      if (ch === '$' && line[i + 1] === '(') {
        stack.push('sub');
        out += '$(';
        i++;
        continue;
      }
      if (top === 'sub' && ch === ')') {
        stack.pop();
        out += ch;
        continue;
      }
      if (ch === '"') {
        stack.push('dq');
        out += ch;
        continue;
      }
      if (ch === "'") {
        stack.push('sq');
        out += ch;
        continue;
      }
      if (ch === '`') {
        stack.push('btick');
        out += ch;
        continue;
      }
      if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
        out += ' '.repeat(line.length - i);
        break;
      }
      out += ch;
    }
    return out;
  });
}


/**
 * Blanks heredoc BODIES, keeping the `<<EOF` line and the line count. A
 * remediation template printed with `cat <<'EOF'` is data: parsed as code, a
 * `case ... esac` inside one fabricated a guard for the sweep below it.
 *
 * OPENERS ARE DETECTED ON COMMENT-STRIPPED, QUOTE-BLANKED TEXT, and that is not
 * a detail. Matching the RAW line let a heredoc merely MENTIONED in a comment
 * open a fake one: `local-invoke-buildkit/verify.sh`'s "4. Heredocs (`RUN
 * <<EOF`)" blanked 127 of its 153 non-empty lines, and
 * `dynamodb-globaltable/verify.sh` lost 470 lines to a comment naming
 * `` `<<'PY'` ``. Any sweep in those regions was invisible while the walk still
 * claimed to cover the file. `logicalCommands` already reads blanked text for
 * exactly this reason.
 */
export function blankHeredocs(lines: string[]): string[] {
  const stripped = stripComments(lines);
  const quoteless = blankQuotes(stripped);
  const out = [...lines];
  for (let i = 0; i < out.length; i++) {
    // `<<<` is a herestring, not a heredoc. The DELIMITER is read from
    // comment-stripped text, because the commonest spelling quotes it
    // (`<<'EOF'`) and the quote pass blanks what is inside; the `<<` ITSELF
    // must still be visible in the quote-blanked text, which is what keeps an
    // `echo "... <<EOF ..."` from opening one.
    const m = /<<-?(?!<)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(stripped[i]!);
    if (!m) continue;
    if (!/<</.test(quoteless[i]!.slice(m.index, m.index + 3))) continue;
    const delim = m[2]!;
    let j = i + 1;
    for (; j < out.length && out[j]!.trim() !== delim; j++) out[j] = ' '.repeat(out[j]!.length);
    if (j < out.length) out[j] = ' '.repeat(out[j]!.length);
    i = j;
  }
  return out;
}

/**
 * Comments and heredoc bodies blanked, quotes intact. Two levels are needed and
 * conflating them was a real defect: `structuralLines` blanks the inside of
 * quotes, so `case "${STACK}" in` becomes `case "      " in` and the variable a
 * guard is keyed on disappears. Anything that must READ a value uses this; only
 * the loop-depth scan, whose hazard is the word `done` inside a message, uses
 * the fully blanked form.
 */
export function uncommented(rawLines: string[]): string[] {
  return blankHeredocs(stripComments(rawLines));
}

export function structuralLines(rawLines: string[]): string[] {
  return blankQuotes(uncommented(rawLines));
}

/** Strips `${VAR}`, `${VAR:-x}`, bare `$VAR`, quotes and escapes. */
function literalPart(value: string): string {
  return value
    .replace(/\\/g, '')
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '')
    // Positional parameters. Leaving them in made `--log-group-name-prefix "$1"`
    // read as LITERALLY ANCHORED, so a helper sweeping its own first argument
    // was invisible -- the fence failing open on the very idiom the convention
    // tells fixtures to use.
    .replace(/\$[0-9@*]/g, '')
    .replace(/["'`]/g, '');
}

/** Escapes a value for literal use inside a RegExp. */
function reEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Variable names interpolated into a filter value. */
function interpolatedVariables(value: string): string[] {
  const names = [
    ...[...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!),
    ...[...value.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!),
    // `$1` / `${1}` / `$@` / `$*` name a value exactly as much as `${STACK}`
    // does, and a filter built from one collapses the same way.
    // The braced form mirrors the NAMED regex above and anchors no closing
    // brace: requiring one made `${10}` and `${1:-}` yield zero variables, so
    // `collapsibleFilters` dropped the filter and the sweep went unrecognized.
    ...[...value.matchAll(/\$\{([0-9]+|[@*])/g)].map((m) => m[1]!),
    ...[...value.matchAll(/\$([0-9]|[@*])/g)].map((m) => m[1]!),
  ];
  return [...new Set(names)];
}

/**
 * JMESPath predicates that are TRUE of every string when their needle is empty.
 * `contains` is the widest of the three and was the one the first revision
 * missed, on a live account-wide IAM role sweep.
 */
const EMPTY_MATCHING_PREDICATES = ['starts_with', 'ends_with', 'contains'] as const;

/**
 * Filters that collapse to "match everything" when their variables are empty.
 * Two spellings reach the same place: a dedicated `--*-prefix` flag, and an
 * empty-matching JMESPath predicate inside `--query`.
 */
export function collapsibleFilters(command: string): { filter: string; variables: string[] }[] {
  const found: { filter: string; variables: string[] }[] = [];
  // A `--query` that is itself a double-quoted shell word writes its inner
  // quotes escaped (`starts_with(Name, \"${STACK}\")`), and JMESPath backtick
  // literals arrive as `\`${STACK}\``. Unescaping first keeps the matchers
  // below strict -- loosening their delimiters to tolerate the backslash made
  // them match across quote boundaries -- a looser delimiter matched from one
  // quoted argument into the next, inventing filters no line contains.
  const text = command.replace(/\\(["'`])/g, '$1');

  for (const m of text.matchAll(
    /--([a-z0-9-]*(?:prefix|pattern))[\s=]+(?:"([^"]*)"|'([^']*)'|([^\s\\]+))/g,
  )) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (literalPart(value).trim() !== '') continue;
    if (interpolatedVariables(value).length === 0) continue;
    found.push({ filter: `--${m[1]} ${value}`, variables: interpolatedVariables(value) });
  }

  for (const predicate of EMPTY_MATCHING_PREDICATES) {
    const re = new RegExp(
      `${predicate}\\(\\s*[A-Za-z0-9_.\\[\\]]+\\s*,\\s*['"\`]([^'"\`]*)['"\`]\\s*\\)`,
      'g',
    );
    for (const m of text.matchAll(re)) {
      const value = m[1]!;
      if (literalPart(value).trim() !== '') continue;
      if (interpolatedVariables(value).length === 0) continue;
      found.push({
        filter: `${predicate}('${value}')`,
        variables: interpolatedVariables(value),
      });
    }
  }

  return found;
}

/**
 * Flattens each `aws` invocation onto one logical line. Fixtures wrap these
 * across four or five lines with trailing backslashes, and the filter and the
 * `--query` that reveals what it feeds routinely sit on different ones.
 */
function logicalCommands(lines: string[], structural: string[]): LogicalCommand[] {
  const out: LogicalCommand[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Structure decides WHERE a command is -- on the fully blanked line, so
    // neither a comment nor an `echo "aws ... --prefix ${KEY}"` opens one (the
    // tree has four such echoes printing a remediation hint). The RAW line
    // supplies the text, because the filter value this classifier reads lives
    // inside the quotes `structuralLines` blanks.
    if (!/\baws\s+[a-z0-9-]+[\s\\]/.test(structural[i]!)) continue;
    let text = lines[i]!;
    let end = i;
    while (
      end + 1 < lines.length &&
      // A TERMINATION bound, not a correctness one: widening it can only let
      // the scan see more, so no test can red on a wider cap (measured --
      // 100000 changes nothing, 0 reds two cases). It exists so a malformed
      // file cannot make the join run to EOF.
      end - i < 20 &&
      (/\\\s*$/.test(structural[end]!) ||
        (structural[end]!.split('(').length - structural[end]!.split(')').length > 0 &&
          /\$\(/.test(structural[end]!)))
    ) {
      end++;
      text += ` ${lines[end]!}`;
    }
    out.push({ start: i, end, text });
  }
  return out;
}

interface Range {
  start: number;
  end: number;
}

/**
 * Top-level shell functions, as line ranges. Both spellings are recognized --
 * `name() {` and `function name {` -- because missing one silently widens a
 * sweep's guard-search region to the whole file.
 */
export function functionRanges(structural: string[]): Range[] {
  const OPENER =
    /^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{|^function\s+[A-Za-z_][A-Za-z0-9_]*\s*(\(\))?\s*\{/;
  // A close is a column-0 `}` OR `) }` -- the latter is how a subshell-bodied
  // function ends (`name() { ( ... ) }`), and missing it ran the range on into
  // the NEXT function, so a guard in one credited a sweep in another. Six files
  // in the tree have that shape. The clamp at the following opener is the
  // belt-and-braces half: an unrecognized terminator can no longer leak past
  // the next declaration.
  const CLOSE = /^\}|^\)\s*\}/;
  const openers: number[] = [];
  for (let i = 0; i < structural.length; i++) if (OPENER.test(structural[i]!)) openers.push(i);

  return openers.map((start, k) => {
    const nextOpener = openers[k + 1] ?? structural.length;
    let end = nextOpener - 1;
    for (let j = start + 1; j < nextOpener; j++) {
      if (CLOSE.test(structural[j]!)) {
        end = j;
        break;
      }
    }
    return { start, end };
  });
}

/** The function containing `line`, or the whole file when there is none. */
function enclosingRange(structural: string[], line: number): Range {
  for (const r of functionRanges(structural)) {
    if (line >= r.start && line <= r.end) return r;
  }
  return { start: 0, end: structural.length - 1 };
}

/**
 * A guard only counts when it stands in the SAME scope as the sweep. Without
 * this, a sweep at FILE scope took the whole-file fallback range and credited
 * a `case` sitting inside some earlier function's body — which never runs at
 * that point.
 *
 * The converse (a file-scope guard, a sweep inside a function) is refused too,
 * even though such a guard would in practice run before the call. Nothing in
 * the tree writes one, and flagging is the fail-closed direction.
 */
function sameScope(structural: string[], a: number, b: number): boolean {
  const ra = enclosingRange(structural, a);
  const rb = enclosingRange(structural, b);
  return ra.start === rb.start && ra.end === rb.end;
}

/** Index of the `done` closing a loop opened at or before `from`. */
function loopBodyEnd(structural: string[], from: number): number {
  let depth = 0;
  for (let i = from; i < structural.length; i++) {
    if (/(^|\s|;)(for|while|until)\s/.test(structural[i]!)) depth++;
    if (/(^|\s|;)done\b/.test(structural[i]!)) {
      depth--;
      if (depth <= 0) return i;
    }
  }
  return structural.length - 1;
}

/**
 * The lines a listing's OUTPUT reaches. Two loop shapes are modelled precisely;
 * ANYTHING ELSE widens to the enclosing function rather than returning "not a
 * sweep" -- the fail-closed direction, since the alternative is a silent pass
 * for every shape nobody thought to model.
 */
function consumptionWindow(code: string[], structural: string[], cmd: LogicalCommand): string {
  const range = enclosingRange(code, cmd.start);

  // (a) The listing IS the loop's word source.
  if (/^\s*(?:for|while|until)\s/.test(code[cmd.start]!)) {
    return code.slice(cmd.start, loopBodyEnd(structural, cmd.start) + 1).join('\n');
  }

  const spanned = code.slice(cmd.start, cmd.end + 1).join('\n');

  // (b) The listing is PIPED onward -- `| while read`, `| xargs`. The pipeline
  // itself plus any loop it opens is the window.
  if (/\|\s*(?:while|xargs|read|tr\b|grep\b|awk\b|sed\b)/.test(spanned) || /\|\s*$/.test(code[cmd.end]!)) {
    return code.slice(cmd.start, loopBodyEnd(structural, cmd.start) + 1).join('\n');
  }

  // (c) The listing is CAPTURED. The window is every later line in the same
  // function that reads the captured name, plus the body of any loop such a
  // line opens. Unbounded distance on purpose: an earlier revision looked only
  // 12 lines ahead, which is a silent pass for a capture whose loop sits
  // further down.
  const assign = /^\s*(?:local\s+)?(?:declare\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(code[cmd.start]!);
  if (assign) {
    const flow = captureFlow(code, structural, cmd.end + 1, assign[1]!, range);
    if (DESTRUCTIVE.test(flow.window)) return flow.window;

    // The value is this function's RETURN value: follow it to the callers.
    if (flow.emitsToStdout) {
      const fn = rangeName(code, range);
      const beyond = fn === undefined ? '' : returnValueWindow(code, structural, fn, 0);
      if (DESTRUCTIVE.test(beyond)) return beyond;
      if (fn !== undefined) return flow.window + beyond;
    }

    // A capture whose every use is accounted for, and none destructive, is a
    // genuine read-only listing. Only an UNTRACKED use -- or none at all --
    // falls through to the fail-closed widening below.
    if (flow.useCount > 0 && !flow.escapes) return flow.window;
  }

  // (d) Nothing above applies, so the output goes somewhere this scanner cannot
  // follow. Widen to the enclosing function -- the FAIL-CLOSED direction. The
  // first revision answered "not a sweep" here, a silent pass for every shape
  // nobody modelled.
  return code.slice(range.start, range.end + 1).join('\n');
}


/** Name of the function a range declares. */
function rangeName(code: string[], r: Range): string | undefined {
  return /^(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(code[r.start]!)?.[1];
}

/** Lines that CALL `fn` (its own declaration excluded). */
function callSites(code: string[], fn: string): number[] {
  const re = new RegExp(`(?:^|[\\s;(|&$])${fn}\\b`);
  const decl = new RegExp(`^(?:function\\s+)?${fn}\\s*(?:\\(\\)|\\{)`);
  const out: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (decl.test(code[i]!)) continue;
    if (re.test(code[i]!)) out.push(i);
  }
  return out;
}

/** Shell-ish argument split of the text following `fn` on `line`. */
function callArguments(line: string, fn: string): string[] {
  const at = line.search(new RegExp(`(?:^|[\\s;(|&$])${fn}\\b`));
  if (at === -1) return [];
  const rest = line.slice(line.indexOf(fn, at) + fn.length);
  return rest.match(/"[^"]*"|'[^']*'|[^\s|;)&]+/g) ?? [];
}

/** Bodies of every same-file function NAMED anywhere on `line`. */
function calleeBodies(code: string[], line: string): string {
  let out = '';
  for (const r of functionRanges(code)) {
    const name = rangeName(code, r);
    if (name === undefined) continue;
    if (!new RegExp(`(?:^|[\\s;(|&$])${name}\\b`).test(line)) continue;
    out += `${code.slice(r.start, r.end + 1).join('\n')}\n`;
  }
  return out;
}

/**
 * Leading constructs that CONSUME a value without moving it anywhere this scan
 * loses sight of. Anything else -- a command not defined in this file, an
 * indirect `"${CMD}" "${names}"`, a `bash -c` -- is an escape, because a
 * sourced helper doing the delete is this repo's own convention and the
 * classifier cannot read it. Fail-closed by construction rather than by an
 * enumeration of hazards.
 */
const RESOLVED_CONSUMERS = new Set([
  'if', 'elif', 'else', 'then', 'fi', 'while', 'until', 'for', 'do', 'done',
  'case', 'esac', 'return', 'exit', 'break', 'continue', 'local', 'export',
  'readonly', 'declare', 'unset', 'shift', 'echo', 'printf', 'cat', 'test',
  'awk', 'grep', 'sed', 'tr', 'wc', 'sort', 'uniq', 'head', 'tail', 'xargs',
  'aws', 'node', 'true', 'false',
]);

interface CaptureFlow {
  window: string;
  useCount: number;
  /** The value left this scan's sight (file, pipe, `set --`, `eval`, a callee). */
  escapes: boolean;
  /** The value was written to STDOUT, i.e. it is this function's RETURN value. */
  emitsToStdout: boolean;
}

/** True when this line's leading construct is one the scan can follow. */
function consumerIsResolved(line: string, functions: ReadonlySet<string>): boolean {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return true;
  // A test, a group close, an assignment, or a CONTINUATION line of the command
  // above (`--auto-scaling-group-names "${ASG_NAME}" \`) -- a flag is not a new
  // consumer, and reading one as unresolvable flagged a read-only capture.
  if (/^[[({}]|^\)|^-|^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(trimmed)) return true;
  const first = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed)?.[1];
  if (first === undefined) return false;
  return RESOLVED_CONSUMERS.has(first) || functions.has(first);
}

/**
 * Follows a captured value forward inside one scope.
 *
 * `emitsToStdout` is the case the first three revisions all missed and that
 * hollowed out the archetype: `tests/integration/s3-versions.sh` does its
 * collapsible listing in `_s3v_rows`, ends with `printf '%s\n' "${rows}"`, and
 * the DELETE lives in a different function joined by a pipe in a third. A
 * `printf` of the captured name read as an ordinary non-destructive use, so the
 * whole file reported zero sweeps and the guard could be deleted with the fence
 * still green.
 */
function captureFlow(
  code: string[],
  structural: string[],
  from: number,
  variable: string,
  range: Range,
): CaptureFlow {
  const uses = new RegExp(`\\$\\{?${reEscape(variable)}\\b`);
  const functions = new Set(
    functionRanges(code).flatMap((r) => {
      const n = rangeName(code, r);
      return n === undefined ? [] : [n];
    }),
  );
  const flow: CaptureFlow = { window: '', useCount: 0, escapes: false, emitsToStdout: false };

  for (let i = from; i <= range.end && i < code.length; i++) {
    const line = code[i]!;
    if (!uses.test(line)) continue;
    flow.useCount++;
    const first = /^\s*([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line)?.[1];
    const redirectsToFile = /(?:^|[^>&0-9])>>?\s*(?!&)(?!\/dev\/null)\S/.test(line);
    if (
      redirectsToFile ||
      // A real pipe, not the `||` operator.
      /(?:^|[^|])\|(?!\|)/.test(line) ||
      first === 'set' ||
      first === 'eval' ||
      // A consumer this scan cannot resolve. Leaving `escapes` false here
      // returned a non-destructive window for `delete_them "${NAMES}"` -- a
      // sourced helper -- and `findSweeps` reported ZERO even with an
      // `aws logs delete-log-group` on a later line of the SAME function.
      !consumerIsResolved(line, functions)
    ) {
      flow.escapes = true;
    }
    // Emitted to stdout, unguarded by a redirect: that IS the function's return
    // value, so the flow continues in whatever captured the call.
    if (!redirectsToFile && first !== undefined && /^(?:printf|echo|cat)$/.test(first)) {
      flow.emitsToStdout = true;
    }
    const bodies = calleeBodies(code, line);
    if (bodies !== '') {
      flow.escapes = true;
      flow.window += bodies;
    }
    flow.window += /^\s*(?:for|while|until)\s/.test(line)
      ? `${code.slice(i, loopBodyEnd(structural, i) + 1).join('\n')}\n`
      : `${line}\n`;
  }
  return flow;
}

/**
 * Everything the RETURN VALUE of `fn` reaches, one call level up. Bounded by
 * `depth` so a recursive helper cannot loop.
 */
function returnValueWindow(
  code: string[],
  structural: string[],
  fn: string,
  depth: number,
): string {
  // Out of hops. See the header's NOT MODELLED list: a chain deeper than this
  // is a stated limit, not something the widening below can recover -- when the
  // follow truncates, the enclosing function it falls back to is the one the
  // chain STARTED in, which is exactly where nothing was found.
  if (depth > 2) return '';
  let out = '';
  for (const site of callSites(code, fn)) {
    const line = code[site]!;
    out += `${line}\n`;
    out += calleeBodies(code, line);
    const assign = /^\s*(?:local\s+)?(?:declare\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    const siteRange = enclosingRange(code, site);
    if (assign) {
      const flow = captureFlow(code, structural, site + 1, assign[1]!, siteRange);
      out += flow.window;
      if (!DESTRUCTIVE.test(flow.window) && flow.emitsToStdout) {
        const outerName = rangeName(code, siteRange);
        if (outerName !== undefined) out += returnValueWindow(code, structural, outerName, depth + 1);
      }
    } else {
      out += code.slice(site, loopBodyEnd(structural, site) + 1).join('\n');
    }
  }
  return out;
}

/** A `case` statement's parsed arms. */
interface CaseArm {
  pattern: string;
  /** First and last line of the arm's body, inclusive of the pattern line. */
  start: number;
  end: number;
  /** The arm's body exits or returns, so control does not reach past `esac`. */
  escapes: boolean;
}

/** A shell glob that the EMPTY string matches -- `*`, `""`, `''`, `*|x`. */
export function matchesEmptyString(pattern: string): boolean {
  return pattern
    .split('|')
    .some((alt) => alt.trim().replace(/["']/g, '').replace(/\*/g, '') === '');
}

/** An arm pattern usable as a guard: literal, and never true of the empty string. */
function isGuardingPattern(pattern: string): boolean {
  const p = pattern.trim();
  if (p === '') return false;
  // An expansion cannot be read statically, so it cannot be trusted to exclude
  // the empty string.
  if (p.includes('$')) return false;
  return !matchesEmptyString(p);
}

const ARM = /^\s*\(?([^\s()|]+(?:\s*\|\s*[^\s()|]+)*)\)/;

/**
 * Blanks a complete `case ... esac` written inside one line, so its arms are
 * not collected into the ENCLOSING statement's arm list.
 *
 * IT IS LOAD-BEARING, and an earlier label here said otherwise. That label came
 * from a probe that searched only the false-NEGATIVE direction; the inputs that
 * distinguish this pass are false-POSITIVE ones -- a one-line nested `case`
 * inside a GUARDING arm (whose inner `;;` would otherwise end the outer arm
 * before the sweep), and one inside an empty-matching arm that then `exit`s
 * (whose `exit` would otherwise fall outside the arm's body). Both are pinned
 * by tests.
 */
function maskNestedCases(text: string): string {
  let out = text;
  for (;;) {
    const m = /\bcase\b.*?\bin\b/.exec(out);
    if (!m) return out;
    const end = out.indexOf('esac', m.index + m[0].length);
    if (end === -1) return out;
    out = out.slice(0, m.index) + ' '.repeat(end + 4 - m.index) + out.slice(end + 4);
  }
}

/**
 * True when the arm's LAST statement is `exit` / `return`, which is what makes
 * control skip everything after `esac`. Testing for the WORD anywhere in the
 * arm accepted `*) if [ "${FORCE:-}" = "1" ]; then exit 0; fi ;;`, where
 * control reaches the sweep whenever FORCE is unset.
 */
function armEscapes(body: string): boolean {
  const tokens = body
    // `;` and newline ONLY. Splitting on `&&` / `||` re-opened the conditional
    // escape this function exists to close: `[ -n "${FORCE:-}" ] && exit 0`
    // ends in `exit 0` as a SPLIT PIECE while its statement is conditional.
    .split(/[;\n]/)
    .map((t) => t.trim())
    // A brace group's close is not a statement; `{ echo bad; exit 0; }` does
    // leave the function.
    .filter((t) => t !== '' && t !== '}' && t !== ';;');
  const last = tokens[tokens.length - 1];
  if (last === undefined) return false;
  if (!/^(?:exit|return)\b/.test(last)) return false;
  // `( echo bad; return 1 )` -- a `return` inside a SUBSHELL leaves the
  // subshell, not the enclosing function, so control still reaches the sweep.
  if (/\)\s*$/.test(last)) return false;
  return true;
}

/** Parses one `case` beginning at `open`; null when it never closes. */
function parseCase(
  code: string[],
  structural: string[],
  open: number,
  limit: number,
): { esac: number; arms: CaseArm[] } | null {
  const opener = /\bin\b(.*)$/.exec(code[open]!);
  if (!opener) return null;
  const sOpener = /\bin\b(.*)$/.exec(structural[open]!);

  // Segments carry BOTH spellings: the arm pattern is read from `code` (a
  // guard's pattern is ordinary text), while `exit` / `return` are looked for
  // in `structural`, where quotes are blanked. Testing the escape on `code`
  // credited an arm whose only body was `echo "will return the caller's
  // status"`, turning a fall-through catch-all into an accepted guard.
  const segments: { line: number; text: string; stext: string }[] = [
    { line: open, text: opener[1]!, stext: sOpener ? sOpener[1]! : '' },
  ];

  // `esac` matching counts NESTING. Taking the first one let an inner `case`'s
  // arms satisfy the outer statement, so a fall-through outer catch-all read as
  // refusing.
  let esac = -1;
  let depth = 0;
  const events = (line: string) => {
    const out: { idx: number; open: boolean }[] = [];
    // Non-greedy up to the first `in`: on a structural line the subject is
    // blanked (`case "      " in`), so it cannot be matched as one token.
    for (const m of line.matchAll(/\bcase\b.*?\bin\b/g)) out.push({ idx: m.index!, open: true });
    for (const m of line.matchAll(/\besac\b/g)) out.push({ idx: m.index!, open: false });
    return out.sort((a, b) => a.idx - b.idx);
  };
  // Scan only what FOLLOWS `in` on the opener line, so the statement's own
  // header is not counted as a nested one.
  for (const e of events(sOpener ? sOpener[1]! : '')) {
    if (e.open) depth++;
    else if (depth === 0) esac = open;
    else depth--;
    if (esac !== -1) break;
  }
  if (esac === -1) {
    for (let i = open + 1; i <= limit && i < structural.length; i++) {
      // Depth BEFORE this line's own events decides whether the line belongs to
      // THIS statement. A nested multi-line `case` inside an arm was
      // contributing its arms to the outer list, so an inner guarding arm
      // covered a sweep in the outer catch-all.
      const outer = depth === 0;
      let closed = false;
      for (const e of events(structural[i]!)) {
        if (e.open) depth++;
        else if (depth === 0) {
          esac = i;
          closed = true;
          break;
        } else depth--;
      }
      if (closed) break;
      if (outer) segments.push({ line: i, text: code[i]!, stext: structural[i]! });
    }
  }
  if (esac === -1) return null;

  // `;&` and `;;&` fall THROUGH into the next arm, so "the sweep is inside a
  // guarding arm" stops implying the scope matched that arm's pattern:
  // `case "$S" in *) echo warn ;& Cdkd?*) <sweep> ;; esac` runs the sweep for
  // an empty `S`. Rather than model fall-through, refuse to read the statement
  // as a guard at all -- the fail-closed answer for a construct nothing in the
  // tree uses.
  if (segments.some((seg) => /;;?&/.test(seg.stext))) return null;

  const arms: CaseArm[] = [];
  let current: CaseArm | null = null;
  // Accumulates the CURRENT arm's structural body, so `escapes` can be decided
  // from its last statement rather than from the word `exit` appearing anywhere.
  let body = '';

  const close = (line: number) => {
    if (!current) return;
    current.end = line;
    current.escapes = armEscapes(body);
    arms.push(current);
    current = null;
    body = '';
  };

  for (const seg of segments) {
    const masked = maskNestedCases(seg.text);
    const smasked = maskNestedCases(seg.stext);
    // Piece boundaries come from the STRUCTURAL text only, and both strings are
    // sliced at the same offsets. `structuralLines` preserves column positions,
    // so this is exact -- and it removes the possibility of the two splitting
    // differently (a `;;` inside a quoted message splits the raw text and not
    // the blanked one). The mismatch used to be handled by a fallback branch
    // that no input could be found to discriminate; making the mismatch
    // impossible is better than labelling a branch nothing can test.
    const bounds: number[] = [];
    for (let at = smasked.indexOf(';;'); at !== -1; at = smasked.indexOf(';;', at + 2)) {
      bounds.push(at);
    }
    const pieces: string[] = [];
    const spieces: string[] = [];
    let from = 0;
    for (const at of [...bounds, smasked.length]) {
      pieces.push(masked.slice(from, at));
      spieces.push(smasked.slice(from, at));
      from = at + 2;
    }
    for (let k = 0; k < pieces.length; k++) {
      const piece = pieces[k]!;
      const spiece = spieces[k]!;
      const m = ARM.exec(piece);
      if (m) {
        // A new arm STARTS here, so any arm still open ends now.
        close(seg.line);
        current = { pattern: m[1]!, start: seg.line, end: seg.line, escapes: false };
        body = spiece.slice(m[0].length);
      } else if (current) {
        current.end = seg.line;
        body += `\n${spiece}`;
      }
      // A `;;` terminates the arm it closes: everything after it belongs to the
      // NEXT arm, not this one. Letting `end` run to the following ARM line let
      // a guarding arm cover a sweep that sits after its `;;`.
      if (k < pieces.length - 1) close(seg.line);
    }
  }
  close(esac);

  return { esac, arms };
}

/**
 * Whether a `case` guard on `variable` DOMINATES the sweep at `sweepLine`.
 * See the module header for the two accepted positions.
 */
export function hasScopeGuard(lines: string[], sweepLine: number, variable: string): boolean {
  const structural = structuralLines(lines);
  const code = uncommented(lines);
  const range = enclosingRange(code, sweepLine);
  const v = reEscape(variable);
  const ref = `\\$\\{${v}(?::[-?][^}]*)?\\}|\\$${v}\\b`;
  const opener = new RegExp(`^\\s*case\\s+"?(?:${ref})"?\\s+in\\b`);

  // `<=`, not `<`: a one-line `case "$V" in ok) <sweep> ;; *) ;; esac` opens on
  // the sweep's OWN line, and excluding it flagged correct code.
  for (let i = range.start; i <= sweepLine; i++) {
    if (!opener.test(code[i]!)) continue;
    if (!sameScope(code, i, sweepLine)) continue;
    const parsed = parseCase(code, structural, i, range.end);
    if (!parsed) continue;

    // WRAPPING: the sweep sits inside a non-catch-all arm.
    for (const arm of parsed.arms) {
      if (!isGuardingPattern(arm.pattern)) continue;
      if (sweepLine >= arm.start && sweepLine <= arm.end) return true;
    }

    // REFUSING: the sweep is past `esac`, and every arm that can match the
    // empty string leaves via `exit` / `return`.
    if (sweepLine > parsed.esac) {
      const empties = parsed.arms.filter((a) => matchesEmptyString(a.pattern));
      const guarding = parsed.arms.filter((a) => isGuardingPattern(a.pattern));
      if (empties.length > 0 && guarding.length > 0 && empties.every((a) => a.escapes)) return true;
    }
  }
  return false;
}

/**
 * A guard delegated to a helper: `_s3v_check_prefix "${prefix}" || return 1`,
 * or the `if ! helper "${prefix}"` spelling. The callee must be defined in the
 * same file, must READ its first parameter, must branch on it (a `case` or a
 * `[ -z ]` / `[ -n ]` test), and must be able to refuse (`return <1-9>`).
 * Requiring the branch is what stops `note "${P}" || return 1` -- a helper that
 * only echoes and happens to return non-zero somewhere -- from reading as a
 * guard.
 *
 * KNOWN LIMIT, stated rather than claimed away: an INVERTED helper (one that
 * refuses the SAFE scope) satisfies every check here, and so does one whose
 * refusing `return` is made unreachable by anything other than a leading
 * unconditional `return 0`. Nothing static can tell those apart; the executable
 * half is what would catch them.
 */
export function hasDelegatedGuard(lines: string[], sweepLine: number, variable: string): boolean {
  const code = uncommented(lines);
  const range = enclosingRange(code, sweepLine);
  const v = reEscape(variable);
  const ref = `\\$\\{${v}(?::[-?][^}]*)?\\}|\\$${v}\\b`;
  const call = new RegExp(
    `^\\s*(?:if\\s+!\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s+[^\\n]*(?:${ref})`,
  );

  for (let i = range.start; i < sweepLine; i++) {
    const line = code[i]!;
    const m = call.exec(line);
    if (!m) continue;
    if (!sameScope(code, i, sweepLine)) continue;
    if (!/\|\|\s*(?:return|exit)\b/.test(line) && !/^\s*if\s+!\s/.test(line)) continue;
    const callee = m[1]!;
    if (callee === 'if' || callee === 'aws') continue;
    const defined = new RegExp(
      `^${callee}\\s*\\(\\)\\s*\\{|^function\\s+${callee}\\b`,
      'm',
    ).test(code.join('\n'));
    if (!defined) continue;
    for (const r of functionRanges(code)) {
      const head = code[r.start]!;
      if (!new RegExp(`^${callee}\\s*\\(\\)|^function\\s+${callee}\\b`).test(head)) continue;
      const body = code.slice(r.start, r.end + 1).join('\n');
      if (!/\breturn\s+[1-9]/.test(body)) continue;
      if (!/\$\{?1\b/.test(body)) continue;
      // An UNCONDITIONAL early return before the first branch neuters the
      // helper while leaving its `case` and its `return 1` in place -- measured
      // by prepending `return 0` to `_s3v_check_prefix`, which left this fence
      // green. Only the leading-statement form is detected; a return made
      // unreachable further in is the residual limit stated above.
      const bodyLines = code.slice(r.start + 1, r.end);
      const firstStatement = bodyLines.find((l) => l.trim() !== '' && !/^\s*local\b/.test(l));
      if (firstStatement !== undefined && /^\s*(?:return|exit)\s+0\b/.test(firstStatement)) continue;
      const branches =
        /^\s*case\s+"?\$\{?[A-Za-z0-9_]+\}?"?\s+in\b/m.test(body) ||
        /\[\s+-[zn]\s+"?\$\{?[A-Za-z0-9_]+\}?"?\s+\]/.test(body);
      if (branches) return true;
    }
  }
  return false;
}



/**
 * An emptiness guard, with the same DOMINANCE requirement the `case` forms
 * carry. Round 2 withdrew `[ -z ]` / `[ -n ]` because the naive check accepted
 * an INVERTED spelling; the fix is the dominance test, not the withdrawal --
 * `tests/integration/s3-versions.sh` guards its key-scoped entry points with
 * exactly this shape and nothing else.
 *
 *   [ -n "${V}" ] || return 1          <- refusing, sweep after it
 *   [ -z "${V}" ] && return 1          <- refusing, sweep after it
 *   if [ -z "${V}" ]; then ...return... fi   <- refusing, sweep after `fi`
 *   if [ -n "${V}" ]; then <sweep> fi        <- wrapping, sweep INSIDE
 *
 * The inverted `if [ -z "${V}" ]; then <sweep> fi` matches none of them.
 */
export function hasEmptinessGuard(lines: string[], sweepLine: number, variable: string): boolean {
  const code = uncommented(lines);
  const structural = structuralLines(lines);
  const range = enclosingRange(code, sweepLine);
  const v = reEscape(variable);
  const ref = `"?\\$\\{${v}(?::[-?][^}]*)?\\}"?|"?\\$${v}\\b"?`;
  const isEmptyTest = (text: string) => new RegExp(`\\[\\s+-z\\s+(?:${ref})\\s+\\]`).test(text);
  // `[ ! -z "$V" ]` is `-n` spelled the long way.
  const isNonEmptyTest = (text: string) =>
    new RegExp(`\\[\\s+-n\\s+(?:${ref})\\s+\\]`).test(text) ||
    new RegExp(`\\[\\s+!\\s+-z\\s+(?:${ref})\\s+\\]`).test(text);

  for (let i = range.start; i <= sweepLine && i < code.length; i++) {
    const line = code[i]!;

    // One-line refusing forms.
    if (
      i < sweepLine &&
      ((isNonEmptyTest(line) && /\|\|\s*(?:return|exit)\b/.test(line)) ||
        (isEmptyTest(line) && /&&\s*(?:return|exit)\b/.test(line)))
    ) {
      return true;
    }

    const opener = /^\s*if\s+(.*)$/.exec(line);
    if (!opener) continue;

    // Find `fi`, and the first `else` / `elif` at this statement's own depth.
    let fi = -1;
    let branchEnd = -1;
    let depth = 0;
    for (let k = i; k <= range.end && k < structural.length; k++) {
      if (/(^|\s|;)if\s/.test(structural[k]!)) depth++;
      if (depth === 1 && branchEnd === -1 && /(^|\s|;)(?:else|elif)\b/.test(structural[k]!)) {
        branchEnd = k;
      }
      if (/(^|\s|;)fi\b/.test(structural[k]!)) {
        depth--;
        if (depth <= 0) {
          fi = k;
          break;
        }
      }
    }
    if (fi === -1) continue;
    if (branchEnd === -1) branchEnd = fi;

    const thenBody = structural
      .slice(i, branchEnd + 1)
      .join('\n')
      .replace(/^[\s\S]*?\bthen\b/, '')
      // Exactly ONE trailing `fi` -- the one closing the `if` this branch
      // belongs to, which is already accounted for. A SECOND `fi` belongs to a
      // nested `if`, and leaving it is what makes a conditional escape read as
      // unconditional.
      .replace(/\s*;?\s*\bfi\b\s*;?\s*$/, '');

    // REFUSING: `if [ -z "$V" ] ... return/exit ... fi`, sweep AFTER `fi`. The
    // escape has to be the branch's LAST statement, exactly as for a `case`
    // arm: `if [ -z "$V" ]; then if [ "${FORCE:-}" = 1 ]; then return 1; fi; fi`
    // reads as refusing to a naive word search while control reaches the sweep
    // whenever FORCE is unset.
    if (isEmptyTest(opener[1]!) && sweepLine > fi && armEscapes(thenBody)) return true;

    // WRAPPING: `if [ -n "$V" ]; then <sweep> fi`. Bounded to the THEN branch:
    // with an `else`, a sweep in the ELSE branch runs exactly when the scope IS
    // empty -- the inverted-acceptance class, one spelling over.
    if (isNonEmptyTest(opener[1]!) && sweepLine > i && sweepLine < branchEnd) return true;
  }
  return false;
}

/**
 * Where a scope value can be guarded. A sweep whose filter reads `"$2"`, or a
 * local bound from `"$2"`, cannot be guarded in its own function — the value
 * arrives from the caller, and so does the guard. `tests/integration/s3-versions.sh`
 * is exactly that shape: `_s3v_rows` sweeps `scope="$2"`, and
 * `s3_purge_prefix_versions` validates the argument it passes with
 * `_s3v_check_prefix`.
 *
 * Returns the (line, variable) pairs a guard may legitimately sit at. When the
 * value comes from a parameter, EVERY call site has to be guarded — one
 * unguarded caller is an unguarded sweep.
 */
export function scopeSites(
  code: string[],
  sweepLine: number,
  variable: string,
  depth = 0,
): { direct: { line: number; variable: string }; viaParameter: { line: number; variable: string }[][] } {
  const direct = { line: sweepLine, variable };
  if (depth > 2) return { direct, viaParameter: [] };

  const range = enclosingRange(code, sweepLine);
  const fn = rangeName(code, range);
  if (fn === undefined) return { direct, viaParameter: [] };

  // Which positional parameter feeds this scope, if any.
  let position: number | undefined;
  if (/^[0-9]$/.test(variable)) position = Number(variable);
  else {
    for (let i = range.start; i <= range.end && i < code.length; i++) {
      // `${1:-}` is as much a parameter binding as `$1`; missing it lost the
      // position lookup and flagged a legitimately guarded caller.
      const m = new RegExp(
        `\\b${reEscape(variable)}="?\\$\\{?([0-9]+)(?::[-?][^}]*)?\\}?"?`,
      ).exec(code[i]!);
      if (m) {
        position = Number(m[1]);
        break;
      }
    }
  }
  if (position === undefined || position < 1) return { direct, viaParameter: [] };

  const viaParameter: { line: number; variable: string }[][] = [];
  for (const site of callSites(code, fn)) {
    const args = callArguments(code[site]!, fn);
    const arg = args[position - 1];
    if (arg === undefined) {
      // A call site that does not pass the argument cannot be shown guarded.
      viaParameter.push([]);
      continue;
    }
    const vars = interpolatedVariables(arg);
    if (vars.length === 0 && literalPart(arg).trim() !== '') {
      // A literal argument cannot collapse; this call site is safe.
      viaParameter.push([{ line: site, variable: '' }]);
      continue;
    }
    viaParameter.push(vars.map((v) => ({ line: site, variable: v })));
  }
  return { direct, viaParameter };
}

/**
 * Sweeps whose filter keeps a literal anchor inside an AWS-OWNED namespace
 * (`/aws/lambda/${STACK}`). An empty scope does NOT widen these to the whole
 * account -- it widens them to the whole NAMESPACE, which for
 * `--log-group-name-prefix "/aws/lambda/"` is every Lambda log group in the
 * region, cdkd's and everyone else's.
 *
 * They are deliberately NOT part of `findUnguardedSweeps`: guarding them means
 * touching a teardown in nearly every Lambda-using fixture, which is issue
 * #2682's job. But a checker that simply reports them CLEAN while the prose
 * calls it a known gap is the worse failure, so they are counted here and the
 * count is pinned by a test: a new one fails the build and has to be either
 * guarded or consciously added to the tally.
 */
export function findNamespaceAnchoredSweeps(content: string): SweepFinding[] {
  const lines = content.split('\n');
  const structural = structuralLines(lines);
  const code = uncommented(lines);
  const out: SweepFinding[] = [];

  for (const cmd of logicalCommands(lines, structural)) {
    for (const m of cmd.text.matchAll(
      /--([a-z0-9-]*(?:prefix|pattern))[\s=]+(?:"([^"]*)"|'([^']*)')/g,
    )) {
      const value = m[2] ?? m[3] ?? '';
      const literal = literalPart(value).trim();
      // A fully collapsible filter is `findSweeps`' business, not this one.
      if (literal === '' || interpolatedVariables(value).length === 0) continue;
      if (!/^\/aws\//.test(literal)) continue;
      if (!DESTRUCTIVE.test(consumptionWindow(code, structural, cmd))) continue;
      out.push({
        line: cmd.start + 1,
        filter: `--${m[1]} ${value}`,
        variables: interpolatedVariables(value),
      });
    }
  }
  return out;
}

/** Every destructive prefix sweep in a shell script, guarded or not. */
export function findSweeps(content: string): SweepFinding[] {
  const lines = content.split('\n');
  const structural = structuralLines(lines);
  const code = uncommented(lines);
  const findings: SweepFinding[] = [];

  for (const cmd of logicalCommands(lines, structural)) {
    const filters = collapsibleFilters(cmd.text);
    if (filters.length === 0) continue;
    if (!DESTRUCTIVE.test(consumptionWindow(code, structural, cmd))) continue;
    for (const f of filters) {
      findings.push({ line: cmd.start + 1, filter: f.filter, variables: f.variables });
    }
  }

  return findings;
}

/** Destructive prefix sweeps whose scope variable is not guarded. */
export function findUnguardedSweeps(content: string): SweepFinding[] {
  const lines = content.split('\n');
  const code = uncommented(lines);

  const guardedAt = (line: number, variable: string) =>
    variable === '' ||
    hasScopeGuard(lines, line, variable) ||
    hasEmptinessGuard(lines, line, variable) ||
    hasDelegatedGuard(lines, line, variable);

  const guarded = (sweepLine: number, variable: string, depth = 0): boolean => {
    if (guardedAt(sweepLine, variable)) return true;
    if (depth > 2) return false;
    const sites = scopeSites(code, sweepLine, variable, depth);
    if (sites.viaParameter.length === 0) return false;
    // EVERY call site, and every variable it interpolates, must be guarded --
    // one unguarded caller is an unguarded sweep.
    return sites.viaParameter.every(
      (candidates) =>
        candidates.length > 0 && candidates.every((c) => guarded(c.line, c.variable, depth + 1)),
    );
  };

  return findSweeps(content).filter((f) => {
    const near = [lines[f.line - 1] ?? '', lines[f.line - 2] ?? ''].join('\n');
    if (ALLOW_MARKER.test(near)) return false;
    return f.variables.some((v) => !guarded(f.line - 1, v));
  });
}
