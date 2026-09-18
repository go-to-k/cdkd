import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  ALLOW_MARKER,
  MIN_ALLOW_REASON_LENGTH,
  classifyWcTrim,
} from '../../../scripts/check-integ-wc-trim.js';
import { uncountedWcWords } from '../../uncounted-wc-words.js';

/**
 * Regression guard for issue #3213: a `wc` result in a `tests/integration`
 * shell file must pipe straight through `tr -d ' '` / `tr -d '[:space:]'`,
 * because BSD `wc` pads its count to width 8 and `$(...)` strips only the
 * newline. `scripts/check-integ-wc-trim.ts` holds the mechanism, why the rule
 * covers every `wc` rather than only a string comparison, and why it is a
 * lexer rather than a list of patterns.
 *
 * Four layers, each of which the others cannot replace:
 *  1. table tests on the classifier, every shape in BOTH polarities, including
 *     each quoting / nesting / comment / heredoc case a review round found the
 *     earlier pattern-based version getting wrong;
 *  2. tree-wide: zero violations, plus a floor per SHAPE matching the counts
 *     taken BY HAND, so a lexer that silently stops seeing one shape cannot pass;
 *  3. real-code probes: removing a trim from a REAL fixture site is flagged at
 *     that site's line;
 *  4. bash, through a BSD-padding `wc` shim: the untrimmed `=` comparison
 *     really fails and both trims really fix it, for each input form — so the
 *     CONVENTION is proven on a GNU host too, where the real `wc` never shows it.
 *
 * How the classifier's running time GROWS is guarded separately, in
 * `integ-verify-wc-trim-growth.test.ts`: timings taken in this file would be
 * taken in the heap its other cases leave behind.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');
const INTEG_ROOT = join(REPO_ROOT, 'tests/integration');

/**
 * Every TRACKED shell file under tests/integration, from git rather than a
 * directory walk: a fixture's own `node_modules` can hold third-party `.sh`
 * files, and a walk would make this suite's verdict depend on which fixtures
 * happen to be installed on the machine running it.
 */
let tracked: string[] | undefined;
function trackedShellFiles(): string[] {
  if (tracked) return tracked;
  const r = spawnSync('git', ['ls-files', '-z', '--', 'tests/integration/*.sh'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.error?.message ?? r.stderr}`);
  tracked = r.stdout.split('\0').filter(Boolean);
  return tracked;
}

const TAB = '\t';

describe('classifyWcTrim', () => {
  describe('flags an untrimmed wc', () => {
    it.each([
      ['a piped capture (the go-to-k/cdkd#3182 shape)', 'N="$(printf \'%s\\n\' "$X" | wc -w)"', 'pipe'],
      ['a piped capture, unquoted substitution', 'N=$(docker ps -q | wc -l)', 'pipe'],
      ['an inline here-string comparison', 'if [[ "$(wc -l <<<"${X}")" -ne 1 ]]; then :; fi', 'here-string'],
      ['a file redirect inside an echo', 'echo "lines: $(wc -l <"${F}")"', 'redirect'],
      ['a helper whose output is the count', 'count_words() { printf \'%s\\n\' "$1" | wc -w; }', 'pipe'],
      ['an inline string comparison', 'if [ "$(printf \'%s\' "${rows}" | wc -w)" != "1" ]; then :; fi', 'pipe'],
      ['a direct file argument', 'N="$(wc -l "${F}")"', 'argument'],
      // Command positions the pattern-based first version could not see.
      ['after `if`', 'if wc -l <file; then :; fi', 'redirect'],
      ['as the first command of a function body', 'f() { wc -l <file; }', 'redirect'],
      ['behind an environment assignment', 'LC_ALL=C wc -l <file', 'redirect'],
      ['with no space before its redirect', 'N=$(wc<file)', 'redirect'],
      ['after `!`', '! wc -l <file', 'redirect'],
    ])('%s', (_label, stmt, form) => {
      const c = classifyWcTrim(`set -euo pipefail\n${stmt}\n`);
      expect(c.violations.map((v) => [v.line, v.inputForm])).toEqual([[2, form]]);
    });

    it.each([
      ['a quoted assignment prefix', 'LC_ALL="C" wc -l </dev/null', 'redirect'],
      ['an input redirection written before the command', '</dev/null wc -l', 'redirect'],
      ['behind `command`', 'command wc -l </dev/null', 'redirect'],
      ['a quoted command name', '"wc" -l </dev/null', 'redirect'],
      ['an escaped command name', 'w\\c -l </dev/null', 'redirect'],
      ['after a stderr redirection before the command', '2>/dev/null wc -l <file', 'redirect'],
      ['an ANSI-C quoted command name', "$'wc' -l </dev/null", 'redirect'],
      ['by absolute path', '/usr/bin/wc -l </dev/null', 'redirect'],
      ['behind `coproc`', 'coproc wc -l </dev/null', 'redirect'],
      // After arithmetic holding quotes whose parentheses BALANCE: these fence a
      // future quote-aware rewrite of the counter; the quoted-parenthesis bound
      // itself is pinned in the tree-invariant controls.
      ['after arithmetic holding an ANSI-C quoted escaped quote (balanced; fences a rewrite)', "declare -A a; (( a[$'\\''] = 1 )); wc -l </dev/null", 'redirect'],
      ['after arithmetic holding a quote inside a substitution (balanced; fences a rewrite)', "declare -A a; (( a[\"$(printf '\"')\"] = 1 )); wc -l </dev/null", 'redirect'],
      ['behind `env -`, an empty environment', 'env - wc -l </dev/null', 'redirect'],
      ['behind a quoted `env`, which still runs its command', "'env' wc -l </dev/null", 'redirect'],
      ['reading a duplicated descriptor', 'wc -l <&3', 'redirect'],
      ['with an escaped quote in an argument before its redirect', 'wc -l "a\\"b" <f', 'redirect'],
      ['after ||, which is not a pipe', 'false || wc -l x', 'argument'],
      ['after a pipe and a descriptor redirection written first', 'ls | 2>/dev/null wc -l', 'pipe'],
      ['behind a here-string written before the command', '<<<"x" wc -l', 'here-string'],
      // Redirections apply left to right: the last one written is the input.
      ['behind a here-string, with a file redirect after the command', '<<<"x" wc -l </dev/null', 'redirect'],
      ['with a here-string after a file redirect', 'wc -l </dev/null <<<"x"', 'here-string'],
      // A redirection on another descriptor leaves stdin, and the input form, alone.
      ['with a here-string and then a redirect on fd 3', 'wc -l <<<"x" 3</dev/null', 'here-string'],
      ['with a here-string and then a new descriptor opened from stdin', 'wc -l <<<"x" {fd}<&0', 'here-string'],
      ['with a redirect on fd 3 before the command, fed by a pipe', 'ls | 3</dev/null wc -l', 'pipe'],
      ['behind `env -C DIR`, whose option takes a value', 'env -C /tmp wc -l </dev/null', 'redirect'],
      ['behind `env -iu NAME`, clustered options ending in one that takes a value', 'env -iu HOME wc -l </dev/null', 'redirect'],
      ['behind an appending assignment', 'N+=x wc -l </dev/null', 'redirect'],
      ['behind an indexed assignment', 'A[1]=x wc -l </dev/null', 'redirect'],
      ['behind `nohup`', 'nohup wc -l </dev/null', 'redirect'],
      ['behind `time`', 'time wc -l </dev/null', 'redirect'],
      ['behind `env -S STRING`', 'env -S x wc -l </dev/null', 'redirect'],
      ['behind `env -0vu NAME`', 'env -0vu HOME wc -l </dev/null', 'redirect'],
      ['behind `exec -cla NAME`', 'exec -cla name wc -l </dev/null', 'redirect'],
      ['with an output process substitution holding a <', 'wc -l >(cat <list)', 'argument'],
      ['in a substitution held in single quotes inside a quoted parameter default', 'echo "${X:-\'$(wc -l </dev/null)\'}"', 'redirect'],
      ['behind a redirection whose target is digits', '>2<file wc -l', 'redirect'],
      // Fail-OPEN guards: without them the invocation vanishes entirely.
      ['behind a descriptor duplication written first', '2>&1 wc -l </dev/null', 'redirect'],
      ['behind a duplicated input descriptor written first', '<&3 wc -l', 'redirect'],
      ['with a backtick argument holding a <', 'wc -l `cat <list`', 'argument'],
      ['with a parameter default holding a <', 'wc -l ${X:-<file}', 'argument'],
      ['as the first command of a named `coproc NAME {` body', 'coproc COUNTER { wc -l </dev/null; }', 'redirect'],
      ['as the first command of a `function NAME {` body', 'function count { wc -l </dev/null; }', 'redirect'],
      ['as the first command of a `function NAME() {` body', 'function count() { wc -l </dev/null; }', 'redirect'],
      ['as a command after a [[ ]] test', '[[ -n "$X" ]] && wc -l </dev/null', 'redirect'],
      ['behind `command -p`', 'command -p wc -l </dev/null', 'redirect'],
      ['behind `env -i`', 'env -i wc -l </dev/null', 'redirect'],
      ['behind `exec -a NAME`, whose option takes a value', 'exec -a name wc -l </dev/null', 'redirect'],
    ])('%s', (_label, stmt, form) => {
      const c = classifyWcTrim(`${stmt}\n`);
      expect(c.violations.map((v) => [v.line, v.inputForm])).toEqual([[1, form]]);
    });

    it.each([
      ['a substitution in a parameter default', 'echo "${N:-$(wc -l </dev/null)}"', 1],
      ['a substitution inside a compound array assignment', 'ARR=($(wc -l </dev/null))', 1],
      ['a command after an array holding a quoted parenthesis', "ARR=('(')\nwc -l </dev/null", 2],
      ['a command after a parameter default holding a quoted brace', 'CONFIG=${CONFIG:-"{}"}\nwc -l </dev/null', 2],
      ['a command after a quoted parameter default holding a quoted brace', 'CONFIG="${CONFIG:-"{}"}"\nwc -l </dev/null', 2],
      ['a command after a heredoc body holding a quoted parameter default', 'cat <<EOF\n${X:-"text"}\nEOF\nwc -l </dev/null', 4],
      ['a substitution in an UNQUOTED heredoc body, which bash runs', 'cat <<EOF\nN=$(ls | wc -l)\nEOF', 2],
      ['a backtick in an unquoted heredoc body', 'cat <<EOF\nN=`ls | wc -l`\nEOF', 2],
    ])('%s', (_label, body, line) => {
      expect(classifyWcTrim(`${body}\n`).violations.map((v) => v.line)).toEqual([line]);
    });

    it.each([
      ['escaped', 'cat <<\\EOF\nhello\nEOF\nwc -l </dev/null\n'],
      ['ANSI-C quoted', "cat <<$'EOF'\nhello\nEOF\nwc -l </dev/null\n"],
    ])('keeps scanning after an %s heredoc delimiter ends its body', (_label, body) => {
      // Searching for the delimiter's SPELLING (`\EOF`, `$EOF`) as the
      // terminator swallowed every later line.
      expect(classifyWcTrim(body).violations.map((v) => v.line)).toEqual([4]);
    });

    it('as the last word of a file with no trailing newline', () => {
      // Nothing after the word ends it; only the end-of-file flush does.
      expect(classifyWcTrim('wc').violations.map((v) => [v.line, v.inputForm])).toEqual([[1, 'argument']]);
    });

    it('after a pipe and a newline, still reading the pipe', () => {
      const c = classifyWcTrim('ls |\nwc -l\n');
      expect(c.violations.map((v) => [v.line, v.inputForm])).toEqual([[2, 'pipe']]);
    });

    it('on a line of its own inside an open $( (a newline there separates commands)', () => {
      // A joiner that folds the newline into a space reads `wc` as an argument
      // of the `printf` above it and loses the invocation.
      const c = classifyWcTrim("N=$(printf 'a\\n'\nwc -l)\n");
      expect(c.violations.map((v) => v.line)).toEqual([2]);
    });

    it('after a quoted "<<EOF" that is NOT a heredoc opener', () => {
      // Taking the quoted text for an opener blanked every line up to the next
      // `EOF`, hiding this real invocation.
      const c = classifyWcTrim('echo "<<EOF"\nwc -l <file\nEOF\n');
      expect(c.violations.map((v) => v.line)).toEqual([2]);
    });
  });

  describe('accepts a real trim, and records which', () => {
    it.each([
      ["tr -d ' '", "N=$(docker ps -q | wc -l | tr -d ' ')", 'space'],
      ["tr -d '[:space:]'", "N=$(printf '%s' \"${rows}\" | wc -w | tr -d '[:space:]')", 'posix-space-class'],
      ['tr -d " " (double-quoted)', 'N=$(docker ps -q | wc -l | tr -d " ")', 'space'],
      ['tr -d "[:space:]" (double-quoted)', 'N=$(docker ps -q | wc -l | tr -d "[:space:]")', 'posix-space-class'],
      ['the inline here-string, trimmed', "if [[ \"$(wc -l <<<\"${X}\" | tr -d ' ')\" -ne 1 ]]; then :; fi", 'space'],
      ['the redirect in an echo, trimmed', "echo \"lines: $(wc -l <\"${F}\" | tr -d ' ')\"", 'space'],
      ['a trim followed by more stages', "N=$(ls | wc -l | tr -d ' ' | head -1)", 'space'],
      // Valid trims the pattern-based first version rejected.
      ['a redirect target built by a nested substitution', "N=$(wc -l < $(printf '%s' file) | tr -d ' ')", 'space'],
      ['stderr merged into the count', "N=$(wc -l <file 2>&1 | tr -d ' ')", 'space'],
      ['a clobbering >| redirection before the trim', "wc -l </dev/null 2>|/dev/null | tr -d ' '", 'space'],
      ['a redirect target built by backticks', "N=$(wc -l <`cat f` | tr -d ' ')", 'space'],
      ['a here-string whose quoted text spans lines', "N=$(wc -l <<< 'a\nb' | tr -d ' ')", 'space'],
      ['a trim on the line after the pipe', "N=$(wc -l </dev/null |\n  tr -d ' ')", 'space'],
      ['a blank line between the pipe and the trim', "N=$(wc -l </dev/null |\n\n  tr -d ' ')", 'space'],
      ['a line continuation between the pipe and the trim', "N=$(wc -l </dev/null | \\\n  tr -d ' ')", 'space'],
      ['a line continuation after the trim argument', "N=$(wc -l </dev/null | tr -d ' ' \\\n  | head -1)", 'space'],
      // Argument shapes the lexer must read through to find the real `|`.
      ['a quoted ) inside a substitution argument', "N=$(wc -l $(printf '%s' ')') | tr -d ' ')", 'space'],
      ['a double-quoted ) inside a substitution argument', 'N=$(wc -l $(printf "%s" ")") | tr -d \' \')', 'space'],
      ['a substitution nested in a substitution argument', "N=$(wc -l $(echo $(echo x) ) | tr -d ' ')", 'space'],
      ['a ) inside a parameter default in a substitution argument', "N=$(wc -l $(echo ${X:-)}) | tr -d ' ')", 'space'],
      ['a subshell inside a substitution argument', "N=$(wc -l $( (echo x) ) | tr -d ' ')", 'space'],
      ['a pipe inside a quoted substitution argument', 'N=$(wc -l "$(echo "a|b")" | tr -d \' \')', 'space'],
      ['a pipe inside a quoted backtick argument', 'N=$(wc -l "`echo "a|b"`" | tr -d \' \')', 'space'],
      ['a } inside a substitution in a parameter default argument', "N=$(wc -l ${X:-$(echo })} | tr -d ' ')", 'space'],
      ['a quoted <<EOF before a line-broken trim', "wc -l \"<<EOF\" |\ntr -d ' '", 'space'],
      ['an escaped quote then <<EOF, all quoted, before a line-broken trim', "wc -l \"\\\"<<EOF\" |\ntr -d ' '", 'space'],
      ['a here-string <<<EOF before a line-broken trim', "wc -l <<<EOF |\ntr -d ' '", 'space'],
      ["a literal $' inside double quotes in the arguments", "wc -l \"$'\" | tr -d ' '", 'space'],
      ["a literal $' inside a quoted parameter default in the arguments", "wc -l \"${X:-$'}\" | tr -d ' '", 'space'],
      ["an ANSI-C quoted } inside an unquoted parameter default in the arguments", "wc -l ${X:-$'}'} | tr -d ' '", 'space'],
      ['a trimmed pipeline sent to the background', "ls | wc -l | tr -d ' ' &", 'space'],
      ['a comment between the pipe and the trim', "N=$(wc -l </dev/null | # trim BSD padding\n  tr -d ' ')", 'space'],
      ['a trim continued across a backslash-newline', "N=$(wc -l </dev/null | tr \\\n  -d ' ')", 'space'],
      ['an ANSI-C quoted here-string holding an escaped quote', "N=$(wc -l <<< $'\\'' | tr -d ' ')", 'space'],
      ['a trimmed wc inside backticks', "N=`wc -l </dev/null | tr -d ' '`", 'space'],
      ['a quoted brace inside an unquoted parameter default', "wc -l <<< ${N:-'}'} | tr -d ' '", 'space'],
      ['a heredoc body between the pipe and the trim', "wc -l <<EOF |\na\nEOF\ntr -d ' '", 'space'],
      ['a heredoc body and a blank line between the pipe and the trim', "wc -l <<EOF |\na\nEOF\n\ntr -d ' '", 'space'],
      ['a comment ending in a backslash after the pipe, then the trim', "wc -l </dev/null | # \\\ntr -d ' '", 'space'],
      ['a comment after the trim', "ls | wc -l | tr -d ' ' # count", 'space'],
      ['a file redirect after the trim', "ls | wc -l | tr -d ' ' > count.txt", 'space'],
      ['a redirect operator joined to the trim argument, which still ends the word', "ls | wc -l | tr -d ' '>count.txt", 'space'],
      ['a second redirection right after a first, separated only by the operator', "ls | wc -l | tr -d ' '>a 2>b", 'space'],
      ['a stderr redirect after the trim', "ls | wc -l | tr -d ' ' 2>/dev/null", 'space'],
      ['a descriptor duplication after the trim', "N=$(ls | wc -l | tr -d ' ' 2>&1)", 'space'],
      ['an appending redirect after the trim', "ls | wc -l | tr -d ' ' >> out.txt", 'space'],
      // Redirections that leave tr's stdin (the pipe carrying the count) alone.
      ['an input redirect on another descriptor after the trim', "ls | wc -l | tr -d ' ' 3</dev/null", 'space'],
      ['stdin duplicated onto itself after the trim', "ls | wc -l | tr -d ' ' <&0", 'space'],
      ['stdin duplicated onto itself, with an explicit 0, after the trim', "ls | wc -l | tr -d ' ' 0<&0", 'space'],
      ['stdin duplicated onto itself with a zero-padded descriptor', "ls | wc -l | tr -d ' ' <&00", 'space'],
      ['fd 0 duplicated onto itself with an output operator', "ls | wc -l | tr -d ' ' 0>&0", 'space'],
      ['stdin duplicated onto itself and marked to close the source', "ls | wc -l | tr -d ' ' <&0-", 'space'],
      ['stdin duplicated onto itself with a blank after the &', "ls | wc -l | tr -d ' ' <& 0", 'space'],
      ['a NEW descriptor opened from stdin, leaving fd 0 alone', "ls | wc -l | tr -d ' ' {fd}<&0", 'space'],
      ['the same, separated from the argument by a tab (which bash splits on)', "ls | wc -l | tr -d ' '\t{fd}<&0", 'space'],
      ['a heredoc on another descriptor after the trim', "ls | wc -l | tr -d ' ' 3<<'A'\nx\nA", 'space'],
      ['an appending &>> redirect after the trim', "ls | wc -l | tr -d ' ' &>> out.txt", 'space'],
      ['a quoted redirect target after the trim', "ls | wc -l | tr -d ' ' > \"count file.txt\"", 'space'],
      // A no-break space is text to bash, so the target is one word.
      ['a redirect target holding a no-break space after the trim', "wc -l </dev/null | tr -d ' ' >a\u00a0b", 'space'],
      ['a redirect target starting with a no-break space', "wc -l </dev/null | tr -d ' ' >\u00a0f", 'space'],
      ['a redirect target starting with an escaped space', "wc -l </dev/null | tr -d ' ' >\\ f", 'space'],
      // Inside a word a `#` is text, including after a line continuation.
      ['a redirect target holding a # after the trim', "wc -l </dev/null | tr -d ' ' 2>count#log", 'space'],
      ['a redirect target continued onto a line starting with #', "wc -l </dev/null | tr -d ' ' 2>count\\\n#log", 'space'],
      // Redirections on the wc stage that leave its STDOUT on the pipe.
      ['stdout duplicated onto itself on the wc stage', "wc -l </dev/null >&1 | tr -d ' '", 'space'],
      ['stdout duplicated onto itself, with a blank after the &', "wc -l </dev/null >& 1 | tr -d ' '", 'space'],
      ['stdout duplicated onto itself, then a line continuation before the pipe', "wc -l </dev/null >&1\\\n | tr -d ' '", 'space'],
      ['stdout duplicated onto itself, then two line continuations', "wc -l </dev/null >&1\\\n\\\n | tr -d ' '", 'space'],
      ['stdout duplicated onto itself, a line continuation before the descriptor', "wc -l </dev/null >&\\\n1 | tr -d ' '", 'space'],
      ['stdout moved onto itself, a line continuation inside the target', "wc -l </dev/null >&1\\\n- | tr -d ' '", 'space'],
      // Moving a descriptor onto itself leaves it open (bash keeps the pipe).
      ['stdout moved onto itself on the wc stage', "wc -l </dev/null >&1- | tr -d ' '", 'space'],
      ['an output redirect on another descriptor on the wc stage', "wc -l </dev/null 3>/dev/null | tr -d ' '", 'space'],
      ['a new named descriptor opened on the wc stage', "wc -l </dev/null {fd}>/dev/null | tr -d ' '", 'space'],
      ['<&3 before the pipe into the trim', "wc -l <&3 | tr -d ' '", 'space'],
      ['a comment right after the pipe, then the trim', "wc -l </dev/null |# c\ntr -d ' '", 'space'],
      ['a comment right after |&, then the trim', "wc -l </dev/null |&# c\ntr -d ' '", 'space'],
      // A stdout redirection on an EARLIER command does not carry over to wc.
      ['a bare redirection, then ; and a trimmed wc', ">f; wc -l </dev/null | tr -d ' '", 'space'],
      ['a bare redirection, then a newline and a trimmed wc', ">f\nwc -l </dev/null | tr -d ' '", 'space'],
      ['a bare redirection, then & and a trimmed wc', ">f & wc -l </dev/null | tr -d ' '", 'space'],
      ['a bare redirection piped into a trimmed wc', ">f | wc -l </dev/null | tr -d ' '", 'space'],
      ['a stdout redirection on another command before the wc', "echo x >f; wc -l </dev/null | tr -d ' '", 'space'],
      ['|& into the trim', "wc -l </dev/null |& tr -d ' '", 'space'],
      ['a shift in the arguments before a line-broken trim', "wc -l $((1<<2)) </dev/null |\ntr -d ' '", 'space'],
      // A `<<` inside a substitution, backticks or `${...}` in wc's arguments
      // belongs to that group, not to the wc stage.
      ['a heredoc inside a $( ) argument before a line-broken trim', "wc -l $(cat <<b\nx\nb\n) |\ntr -d ' '", 'space'],
      ['a heredoc inside a backtick argument before a line-broken trim', "wc -l `cat <<b\nx\nb\n` |\ntr -d ' '", 'space'],
      ['a << in a parameter default before a line-broken trim', "wc -l ${X:-a<<b} |\ntr -d ' '", 'space'],
      ['an opener in a quoted substitution closed on the pipe line, its body before the trim', "x=\"$(cat <<'EOF')\" | wc -l |\nEOF\ntr -d ' '", 'space'],
      ['a <<- heredoc body with a tab-indented terminator between the pipe and the trim', `wc -l <<-EOF |\na\n${TAB}EOF\ntr -d ' '`, 'space'],
      ['the body of a heredoc opened earlier in the pipeline', "cat <<EOF | wc -l |\nx\nEOF\ntr -d ' '", 'space'],
      ['that heredoc shape inside a double-quoted substitution', "N=\"$(wc -l <<EOF |\na\nEOF\ntr -d ' ')\"", 'space'],
      ['a comment naming <<EOF between the pipe and the trim', "wc -l </dev/null | # <<EOF is just a comment\ntr -d ' '", 'space'],
      ['a quoted brace in a double-quoted parameter default', "wc -l <<< \"${CONFIG:-\"{}\"}\" | tr -d ' '", 'space'],
      ['a process substitution as the input', "N=$(wc -l <(printf x) | tr -d ' ')", 'space'],
      ['a commented parenthesis inside a substitution argument', "N=$(wc -l $(printf x # )\n) | tr -d ' ')", 'space'],
    ])('%s', (_label, stmt, trim) => {
      const c = classifyWcTrim(`${stmt}\n`);
      expect(c.violations).toEqual([]);
      expect(classifyWcTrim(stmt).invocations.map((i) => i.trim), 'the same input with no trailing newline').toEqual([trim]);
      expect(c.invocations.map((i) => i.trim)).toEqual([trim]);
    });
  });

  describe('refuses what only looks like a trim', () => {
    it.each([
      ['a trim that is not the NEXT stage', "N=$(docker ps -q | wc -l | sort | tr -d ' ')"],
      ['a fallback instead of a trim', 'N=$(docker ps -q | wc -l || echo 0)'],
      // `tr` there runs only when `wc` FAILS, so a successful count keeps its
      // padding. The `|| echo 0` case above cannot see this: it never reaches a
      // `tr` at all, so a check that accepted `||` would still refuse it.
      ['a `|| tr` that only runs when wc fails', "N=$(docker ps -q | wc -l || tr -d ' ')"],
      ['a backslash-t, which tr reads as a tab', "N=$(docker ps -q | wc -l | tr -d '\\t')"],
      ['a literal TAB between the quotes', `N=$(docker ps -q | wc -l | tr -d '${TAB}')`],
      ['a trim followed by -c, which keeps the spaces and deletes the digits', "N=$(ls | wc -l | tr -d ' ' -c)"],
      ['a trim followed by a QUOTED -c', 'N=$(ls | wc -l | tr -d \' \' "-c")'],
      ['a trim followed by a backtick-substituted argument', "wc -l </dev/null | tr -d ' ' `printf %s -c`"],
      ['a trim followed by a redirection and then another argument', "wc -l </dev/null | tr -d ' ' &>/dev/null -c"],
      ['a trim followed by a file redirect and then another argument', "ls | wc -l | tr -d ' ' > out -c"],
      // Redirections that REPLACE or CLOSE tr's stdin, so the count never
      // reaches the trim (bash 5.3: tr reads the redirected input instead, or
      // fails on a closed descriptor).
      ['a file as the trim\'s stdin', "N=$(ls | wc -l | tr -d ' ' <f.txt)"],
      ['a heredoc as the trim\'s stdin', "N=$(ls | wc -l | tr -d ' ' <<'A'\n   7\nA\n)"],
      ['a tab-stripping heredoc as the trim\'s stdin', "ls | wc -l | tr -d ' ' <<- EOF\nx\nEOF"],
      ['a here-string as the trim\'s stdin', "N=$(ls | wc -l | tr -d ' ' <<<'  9 ')"],
      ['a read-write file as the trim\'s stdin', "ls | wc -l | tr -d ' ' <>f.txt"],
      ['an explicit fd 0 file as the trim\'s stdin', "ls | wc -l | tr -d ' ' 0<f.txt"],
      ['another descriptor duplicated onto the trim\'s stdin', "ls | wc -l | tr -d ' ' <&3"],
      ['another descriptor duplicated onto an explicit fd 0', "ls | wc -l | tr -d ' ' 0<&3"],
      ['the trim\'s stdin closed', "ls | wc -l | tr -d ' ' <&-"],
      ['an output redirection onto fd 0', "ls | wc -l | tr -d ' ' 0>f.txt"],
      // A trailing `-` MOVES stdin onto another descriptor, closing fd 0.
      ['stdin moved onto another descriptor', "ls | wc -l | tr -d ' ' 3<&0-"],
      ['stdin moved onto a new named descriptor', "ls | wc -l | tr -d ' ' {fd}<&0-"],
      ['a quoted move of the trim\'s stdin', "ls | wc -l | tr -d ' ' 3<&'0-'"],
      // A backslash-newline inside a redirection target continues the COMMAND:
      // the next line's redirection is still the trim's. Read as a text
      // backslash ending the target, the newline would end the stage and pass.
      ['a redirection continued onto a line that replaces the trim\'s stdin', "wc -l </dev/null | tr -d ' ' 2>/dev/null\\\n 0</dev/null"],
      // `{name}<&-` closes the descriptor the variable holds, which may be fd 0.
      ['a named descriptor closed on input', "ls | wc -l | tr -d ' ' {fd}<&-"],
      ['a named descriptor closed on output', "ls | wc -l | tr -d ' ' {fd}>&-"],
      // `&>` is an operator only at the start of a word: a descriptor before it
      // is an argument to tr, and nothing is trimmed.
      ['a digit before &> (an argument, not a descriptor)', "ls | wc -l | tr -d ' ' 2&>R"],
      ['a digit before &>> (an argument, not a descriptor)', "ls | wc -l | tr -d ' ' 3&>>R"],
      ['a named descriptor before &> (an argument, not a descriptor)', "ls | wc -l | tr -d ' ' {n}&>R"],
      // A name that is not a valid variable name is an argument, not a descriptor;
      // a blank between `&` and `-` still closes.
      ['a malformed descriptor name before <&0', "ls | wc -l | tr -d ' ' {1fd}<&0"],
      ['a named descriptor closed with a blank before the -', "ls | wc -l | tr -d ' ' {fd}<& -"],
      // With no blank, the descriptor joins the ARGUMENT: `' '{fd1}` and `' '2`
      // are the text tr deletes, so the trim is not the accepted spelling.
      ['a named descriptor joined to the trim argument', "ls | wc -l | tr -d ' '{fd1}<&0"],
      ['a numeric descriptor joined to the trim argument', "ls | wc -l | tr -d ' '2>/dev/null"],
      ['a descriptor joined to the trim argument across a line continuation', "ls | wc -l | tr -d ' '\\\n{fd1}<&0"],
      // An opener in a substitution inside an array: its body (holding the
      // trim-looking line) starts after the command's line; `cat` is next.
      ['an opener inside an array substitution, its body holding trim-looking text', "a=($(cat <<'EOF')) | wc -l |\ntr -d ' '\nEOF\ncat"],
      ['a trim followed by a redirection with no target, which bash rejects', "ls | wc -l | tr -d ' ' >"],
      // A `#` that STARTS the target word opens a comment: the redirection has
      // no target, which bash rejects.
      ['a redirection whose target would start with #', "ls | wc -l | tr -d ' ' >#x"],
      // The trim must START the next stage: a later `tr -d ' '` elsewhere in the
      // file cannot stand in for it.
      ['a nine-character stage, with a tr -d on a later line', "N=$(ls | wc -l | abcdefghi)\nX=$(echo | tr -d ' ')"],
      // A `<<` inside `$(( ))` is not a heredoc opener, so no body skip lands the
      // trim check on a later `tr`.
      ['a shift in the arguments, a line equal to its operand, then tr', "wc -l $((1<<2)) </dev/null |\n2\ntr -d ' '"],
      // A quoted `(` inside a substitution must not hide the stage's real heredoc,
      // whose body holds the trim-looking text; the next stage is `cat`.
      ['a quoted ( in a substitution before a real heredoc', "wc -l $(printf '(' >/dev/null) <<EOF |\ntr -d ' '\nEOF\ncat"],
      ['an escaped ( in a substitution before a real heredoc', "wc -l $(printf \\( >/dev/null) <<EOF |\ntr -d ' '\nEOF\ncat"],
      ['an escaped quote then ( in a substitution before a real heredoc', "wc -l $(printf \"\\\"(\" >/dev/null) <<EOF |\ntr -d ' '\nEOF\ncat"],
      ['a commented ( in a substitution before a real heredoc', "wc -l $(printf x >/dev/null # (\n) <<EOF |\ntr -d ' '\nEOF\ncat"],
      ['a ( in a parameter default in a substitution before a real heredoc', "wc -l $(printf %s ${X:-(} >/dev/null) <<EOF |\ntr -d ' '\nEOF\ncat"],
      ['a quoted heredoc on the pipe line whose body is not followed by tr', "wc -l <<'EOF' |\ntr -d ' '\nEOF\ncat"],
      ['an unterminated heredoc body after the pipe, where no stage follows', "wc -l <<EOF |\ntr -d ' '"],
      ['an unterminated QUOTED heredoc body after the pipe', "wc -l <<'EOF' |\ntr -d ' '"],
      // Leading tabs are stripped only for `<<-`: a tab-indented EOF under `<<`
      // is body text, so the body ends at the later EOF and `cat` is next.
      ['a tab-indented EOF under << (not <<-), before trim-looking text', "wc -l <<EOF |\n\tEOF\ntr -d ' '\nEOF\ncat"],
      ['a heredoc opened on the last line, with nothing after it', 'wc -l <<EOF |'],
      ['a trim argument joined to a # (the same word, not a comment)', "wc -l </dev/null | tr -d ' '#x"],
      ['a trim that is text inside a nested parameter default', "wc -l <<< ${A:-${B:-x}| tr -d ' ';}"],
      ['a trim argument with trailing text', "N=$(ls | wc -l | tr -d ' 'x)"],
      ['sed instead of the accepted tr spellings', "N=$(docker ps -q | wc -l | sed 's/ //g')"],
      ['the trim hidden in a trailing comment', "wc -l <file # | tr -d ' '"],
      ['a trim inside the redirect target, not after the count', "N=$(wc -l < $(printf '%s' file | tr -d ' '))"],
      // Only a pipe feeds the count into `tr`; after `;` or a newline, `tr` is
      // a separate command reading its own stdin.
      ['a tr after `;`, a separate command', "N=$(wc -l <file; tr -d ' ')"],
      // The next stage must START with `tr`: here `cat` reads files named tr,
      // -d and a space.
      ['the trim words handed to a different command', 'N=$(ls | wc -l | cat tr -d " ")'],
      ['a tr on the next line, a separate command', "N=$(wc -l <file\ntr -d ' ')"],
      // A separator ends the wc's pipeline, so a `| tr` on a LATER pipeline is
      // not its trim. The two cases above cannot show that: their `)` ends the
      // stage wherever the separator is read.
      ['a trim on the next pipeline, after a newline', "wc -l </dev/null\necho x | tr -d ' '"],
      ['a trim on the next pipeline, after ;', "wc -l </dev/null; echo x | tr -d ' '"],
      ['a trim on the next pipeline, after &', "wc -l </dev/null & echo x | tr -d ' '"],
      ['a trim on the next pipeline, after &&', "wc -l </dev/null && echo x | tr -d ' '"],
      ['a trim on the next pipeline, after a subshell closes', "(wc -l </dev/null) ; echo x | tr -d ' '"],
      // Fail-closed: a `)` ends the wc's stage, so a trim after the subshell is
      // read as the subshell's next stage, not wc's (bash would trim it).
      ['a trim after the subshell holding the wc (fail-closed)', "(wc -l </dev/null) | tr -d ' '"],
      // A heredoc body inside a substitution in wc's OWN arguments belongs to
      // that substitution: its `)` and trim-looking text do not end the stage.
      ['a quoted heredoc in an argument whose body closes the substitution early', "wc -l $(cat <<'EOF'\n) | tr -d ' '\nEOF\n)"],
      ['an unquoted heredoc in an argument whose body closes the substitution early', "wc -l $(cat <<EOF\n) | tr -d ' '\nEOF\n)"],
      ['the same, inside a capture', "N=$(wc -l $(cat <<'EOF'\n) | tr -d ' '\nEOF\n))"],
      // Redirecting wc's OWN stdout sends the padded count to the file and gives
      // `tr` nothing: a trim after it trims nothing (the bash case below shows it).
      ['wc\'s stdout sent to a file before the pipe', "N=$(printf 'a\\nb\\n' | wc -l >count.txt | tr -d ' ')"],
      ['wc\'s stdout appended to a file', "ls | wc -l >>count.txt | tr -d ' '"],
      ['wc\'s stdout clobbering a file', "ls | wc -l >|count.txt | tr -d ' '"],
      ['wc\'s stdout sent to stderr', "ls | wc -l >&2 | tr -d ' '"],
      ['wc\'s stdout sent to stderr, descriptor written', "ls | wc -l 1>&2 | tr -d ' '"],
      ['wc\'s stdout and stderr sent to a file', "wc -l &>/dev/null | tr -d ' '"],
      ['wc\'s stdout and stderr appended to a file', "ls | wc -l &>>count.txt | tr -d ' '"],
      ['wc\'s stdout sent to a file after stderr joins it', "ls | wc -l 2>&1 >count.txt | tr -d ' '"],
      ['wc\'s stdout opened read-write on a file', "ls | wc -l 1<>count.txt | tr -d ' '"],
      ['wc\'s stdout closed', "ls | wc -l >&- | tr -d ' '"],
      // A MOVE of stdout onto another descriptor closes fd 1 behind it
      // (bash: `wc: write error: Bad file descriptor`).
      ['wc\'s stdout moved onto another descriptor', "ls | wc -l 3>&1- | tr -d ' '"],
      ['wc\'s stdout moved onto a new named descriptor', "ls | wc -l {fd}>&1- | tr -d ' '"],
      // Quote removal and expansion happen before the redirection: a target
      // that is not a bare descriptor may be a move of stdout.
      ['a single-quoted move of wc\'s stdout', "ls | wc -l 3>&'1-' | tr -d ' '"],
      ['a double-quoted move of wc\'s stdout', "ls | wc -l 3>&\"1-\" | tr -d ' '"],
      ['a duplication target read from a variable', "ls | wc -l 2>&\"$X\" | tr -d ' '"],
      ['a quoted move of stdout through an input duplication', "ls | wc -l 3<&'1-' | tr -d ' '"],
      // `>&WORD` with a word that is not a descriptor names a FILE for stdout and stderr.
      ['wc\'s stdout sent to a file whose name starts with a digit', "ls | wc -l >&1file | tr -d ' '"],
      ['the same file name finished by a backtick substitution', "ls | wc -l >&1`printf file` | tr -d ' '"],
      ['the same file name finished by a $( ) substitution', "ls | wc -l >&1$(printf file) | tr -d ' '"],
      // A no-break space is part of the word to bash, not a separator.
      ['the same file name continued past a no-break space', "ls | wc -l >&1\u00a0file | tr -d ' '"],
      ['the same file name continued by a process substitution', "ls | wc -l >&1>(:) | tr -d ' '"],
      ['the same file name continued across a line continuation', "ls | wc -l >&1\\\nfile | tr -d ' '"],
      ['a move of stdout split by a line continuation', "ls | wc -l 3>&1\\\n- | tr -d ' '"],
      ['a line continuation inside the operator (a fail-closed bound)', "ls | wc -l >\\\n&1 | tr -d ' '"],
      // Fail-closed bounds: these do end on the pipe, and are refused anyway.
      ['a quoted self-duplication of wc\'s stdout (a fail-closed bound)', "ls | wc -l >&\"1\" | tr -d ' '"],
      ['wc\'s stdout saved and restored (a fail-closed bound)', "ls | wc -l 3>&1 >/dev/null >&3 | tr -d ' '"],
      ['a named descriptor closed on the wc stage (it may hold stdout)', "ls | wc -l {fd}>&- | tr -d ' '"],
      ['wc\'s stdout redirected BEFORE the wc word', "ls | >count.txt wc -l | tr -d ' '"],
      ['wc\'s stdout replaced by a heredoc', "ls | wc -l 1<<EOF | tr -d ' '\nx\nEOF"],
      // A `{name}` descriptor written first is a redirection, not the command word.
      ['an untrimmed wc after a named-descriptor redirection written first', "N=$(ls | {fd}>f wc -l)"],
      // The duplication target is one word: its `-`, or the rest of a file name,
      // is never read as the command.
      ['an untrimmed wc after a descriptor move written first', "N=$(ls | 3>&1- wc -l)"],
      ['an untrimmed wc after a file-named duplication written first', "N=$(ls | >&1file wc -l)"],
      ['a move of stdout written before the wc word', "ls | 3>&1- wc -l | tr -d ' '"],
      ['wc\'s stdout redirected before the wc word, descriptor written', "ls | 1>count.txt wc -l | tr -d ' '"],
      ['wc\'s stdout and stderr redirected before the wc word', "ls | &>count.txt wc -l | tr -d ' '"],
    ])('%s', (_label, stmt) => {
      expect(classifyWcTrim(`${stmt}\n`).violations).toHaveLength(1);
    });
  });

  describe('sees no invocation in', () => {
    it.each([
      ['wc named in a comment line', '# count with wc -l and trim it'],
      ['a trailing comment naming a pipe into wc', 'echo ok # example: | wc -l'],
      ['the untrimmed shape inside a quoted heredoc body', "cat <<'EOF'\nN=$(ls | wc -l)\nEOF"],
      ['a heredoc body whose delimiter is escaped', 'cat <<\\EOF\nN=$(ls | wc -l)\nEOF'],
      ['wc as the TARGET of a redirection', '>wc printf x'],
      ['wc joined to more text by a quote', 'wc"x" -l <file'],
      ['wc as an argument after a backtick substitution', "printf '%s' `printf x` wc -l"],
      ['a function named wc being defined', 'wc() { :; }'],
      ['wc as a name inside arithmetic', '(( wc = 1 ))'],
      ['wc as a name inside an arithmetic expansion', 'echo $(( wc + 1 ))'],
      // `||` would restore command position if arithmetic were scanned as code.
      ['wc after || inside arithmetic', '(( 0 || wc ))'],
      ['wc after || inside an arithmetic expansion', 'echo $(( 0 || wc ))'],
      ['wc as the value of `env -u`', 'env -u wc printf x'],
      ['a function named wc defined with a space before ()', 'wc () { :; }'],
      ['wc as the target of >&', '>&wc printf x'],
      ['wc as a name inside a quoted arithmetic expansion', 'echo "$(( wc + 1 ))"'],
      ['wc as a name inside arithmetic in an unquoted heredoc body', 'cat <<EOF\n$(( wc + 1 ))\nEOF'],
      ['wc named after `command -V`, which only describes it', 'command -V wc'],
      ['wc after a quoted coproc, which is a command name', "'coproc' wc -l </dev/null"],
      ['wc after a quoted function, which is a command name', "'function' wc -l </dev/null"],
      ['wc after a quoted [[, which is a command name', "'[[' wc -l </dev/null"],
      ['wc as an operand after a quoted ]] inside [[ ]]', "[[ x == ']]' && wc == x ]]"],
      ['a pipeline written inside a nested parameter default', 'echo ${A:-${B:-x}; wc -l}'],
      ['a command written inside a quoted nested-quote parameter default', 'echo "${X:-"; wc -l </dev/null; "}"'],
      ['a command written inside a quoted string in a quoted backtick', 'echo "`echo "; wc -l </dev/null; "`"'],
      ['wc on its own line inside an array', 'ARR=(\nwc -l\n)'],
      ['wc as an argument after a process substitution', 'cat <(ls) wc -l'],
      ['wc as an argument after &>', 'cat file &>/dev/null wc -l'],
      ['wc as an argument after 2>&1', 'echo x 2>&1 wc -l'],
      ['wc as an argument of a command named by quoted digits', '"2">/dev/null wc -l </dev/null'],
      ['wc inside a compound array assignment', 'ARR=(wc -l)'],
      ['wc after a QUOTED reserved word, which is a command name', "'if' wc -l </dev/null"],
      ['wc after an empty-quoted reserved word, which is a command name', '""if wc -l </dev/null'],
      ['wc as an operand inside [[ ]]', '[[ -n "$X" && wc == "$TOOL" ]]'],
      ['a quoted double-quoted name with a backslash bash keeps', '"w\\c" -l </dev/null'],
      ['a single-quoted substitution in an unquoted parameter default', "echo ${N:-'$(wc -l </dev/null)'}"],
      ['a heredoc whose quoted delimiter contains a hyphen', "cat <<'END-TEXT'\nwc -l\nEND-TEXT"],
      ['a <<- heredoc whose terminator is tab-indented', `cat <<-EOF\nwc -l\n${TAB}EOF`],
      ['the word wc as prose in an echo', 'echo "==> the wc column is padded on macOS"'],
      ['a pipe into wc as prose inside double quotes', 'echo "a | wc -l"'],
      ['a pipe into wc inside single quotes', "echo 'a | wc -l'"],
      ['wc as an argument, not a command', 'command -v wc >/dev/null'],
      ['a longer word containing wc', 'awcount=1; wcx=2; wc-helper -l'],
      ['a parameter expansion carrying #', 'N=${#ARR[@]}'],
    ])('%s', (_label, body) => {
      expect(classifyWcTrim(`${body}\n`).invocations).toEqual([]);
    });

    it('does not take a `#` inside a word (`$#`) for a comment that hides the rest of the line', () => {
      const c = classifyWcTrim('if [ $# -eq 0 ]; then wc -l </dev/null; fi\n');
      expect(c.violations.map((v) => v.line)).toEqual([1]);
      expect(c.commentOffsets).toEqual([]);
    });

    it.each([
      ['a quoted $( ... ) argument', 'cat <<\'A\' "$(\nprintf \'x\\n\' | wc -l\n)"\nA', 2],
      ['an unquoted $( ... ) argument', "cat <<'A' $(\nprintf 'x\\n' | wc -l\n)\nA", 2],
      ['a backtick argument', "cat <<'A' `\nprintf 'x\\n' | wc -l\n`\nA", 2],
    ])('runs a wc in %s spanning lines after a heredoc opener on the same command', (_label, body, line) => {
      // Bash reads the body after the COMMAND's line ends, not after the first
      // newline inside its argument; the substitution runs.
      const c = classifyWcTrim(`${body}\n`);
      expect(c.violations.map((v) => v.line)).toEqual([line]);
      // Exactly one data body: from the `A` line (after the command's line) to
      // the end of the input.
      expect(c.dataHeredocBodies).toEqual([[body.indexOf('\nA') + 1, body.length + 1]]);
    });

    it('starts an inner command\'s heredoc while an outer one is still pending', () => {
      // Line 2 is the inner quoted heredoc's data, not an executed wc.
      const c = classifyWcTrim("cat <<'A' $(cat <<'B' >/dev/null\nwc -l </dev/null\nB\n)\nA\nwc -l </dev/null\n");
      // Line 2 is data; the wc after both bodies (line 6) is a command.
      expect(c.violations.map((v) => v.line)).toEqual([6]);
    });

    it.each([
      [
        'a quoted ( in arithmetic stretching past the terminator onto an unrelated tr',
        "declare -A a\nwc -l <<: |\n$(( a[\"(\"] ))\n:\ncat\nprintf ')'\ntr -d ' ' </dev/null",
        2,
      ],
      ['an unbalanced $(( that runs to the end of the file', 'cat <<EOF\n$(( 1\nEOF\nwc -l </dev/null', 4],
      ['an unterminated quote in a substitution that runs to the end of the file', "cat <<EOF\n$(echo '\nEOF\nwc -l </dev/null", 4],
      [
        'a line continued by a backslash onto a line that reads like the terminator',
        "cat <<EOF\n$(printf '%s' 'x\\\nEOF\n'\nwc -l </dev/null\n)\nEOF",
        5,
      ],
    ])('ends a heredoc body at its terminator line despite %s', (_label, body, line) => {
      // Bash finds the terminator by line before expanding the body, so nothing
      // inside can move it; the lines after it are commands.
      expect(classifyWcTrim(`${body}\n`).violations.map((v) => v.line)).toEqual([line]);
    });

    it('ends an unquoted heredoc at the line after a lone backslash-newline', () => {
      // `\` + newline + `EOF` is the logical line `EOF`, which terminates.
      const c = classifyWcTrim('cat <<EOF\n\\\nEOF\nwc -l </dev/null\n');
      expect(c.violations.map((v) => v.line)).toEqual([4]);
    });

    it('ends a QUOTED heredoc at a terminator even after a backslash line (no continuation in data)', () => {
      const c = classifyWcTrim("cat <<'EOF'\nx\\\nEOF\nwc -l </dev/null\n");
      expect(c.violations.map((v) => v.line)).toEqual([4]);
    });

    it('ends an unquoted heredoc after an ESCAPED trailing backslash, which does not continue', () => {
      const c = classifyWcTrim('cat <<EOF\nx\\\\\nEOF\nwc -l </dev/null\n');
      expect(c.violations.map((v) => v.line)).toEqual([4]);
    });

    it.each([
      ['the second heredoc of an inner command, after an outer one is pending', "cat <<'A' $(cat <<'B' >/dev/null\ndata\nB\nwc -l </dev/null\n)\nA\n", [4]],
      ['a wc in a substitution inside an unquoted body nested in another', 'cat <<A\n$(cat <<B\nx\nB\nwc -l </dev/null\n)\nA\n', [5]],
      ['a terminator spelled across two continuations', 'cat <<EOF\nE\\\nO\\\nF\nwc -l </dev/null\n', [5]],
      ['a continued line that is not the terminator', 'cat <<EOF\nx\\\ny\nEOF\nwc -l </dev/null\n', [5]],
      ['an opener whose substitution closed on its own line (bash reads the next lines as its body)', "x=$(cat <<'EOF')\nwc -l </dev/null\nEOF\nwc -l </dev/null\n", [4]],
      ['the same with a process substitution', "cat <(cat <<'EOF')\nwc -l </dev/null\nEOF\nwc -l </dev/null\n", [4]],
      ['the same with backticks', "cat `cat <<'EOF'`\nwc -l </dev/null\nEOF\nwc -l </dev/null\n", [4]],
      ['a delimiter with a backtick inside it outside any substitution', 'cat <<E`OF`\nx\nE`OF`\nwc -l </dev/null\n', [4]],
    ])('reports the right lines for %s', (_label, body, lines) => {
      expect(classifyWcTrim(body).violations.map((v) => v.line)).toEqual(lines);
    });

    it.each([
      ['a quoted body', "cat <<'EOF'\nx\nEOF\n"],
      ['an unquoted body', 'cat <<EOF\nx\nEOF\n'],
    ])('honours a full-line allow marker on the line right after %s', (_label, head) => {
      const c = classifyWcTrim(`${head}# ${ALLOW_MARKER}: intentional count comparison\nN=$(ls | wc -l)\n`);
      expect(c.violations).toEqual([]);
    });

    it.each([
      ['a <<- terminator indented by more than one tab', 'cat <<-EOF\ndata\n\t\tEOF\nwc -l </dev/null', [4]],
      // A backslash ending a COMMENT on the opener's line does not continue it,
      // so the first body line can itself be the terminator.
      ['a terminator right after an opener whose comment ends in a backslash', 'cat <<EOF # \\\nEOF\nwc -l </dev/null', [3]],
      ['a continued terminator right after an opener whose comment ends in a backslash', 'cat <<EOF # \\\nE\\\nOF\nwc -l </dev/null', [4]],
      // `<<-` strips the leading tabs of the first logical line in that prelude,
      // however many, and stops stripping once the text has a non-tab character.
      ['a multi-tab <<- terminator right after such an opener', 'cat <<-EOF # \\\n\t\tEOF\nwc -l </dev/null', [3]],
      // Under plain `<<` a tab-indented line is body text, not the terminator.
      ['a tab-indented line under << right after such an opener (body text)', 'cat <<EOF # \\\n\tEOF\nwc -l </dev/null', []],
      ['a continued <<- terminator whose second line is tab-indented', 'cat <<-EOF # \\\nE\\\n\tOF\nwc -l </dev/null\nEOF', []],
      ['a non-terminator right after such an opener, then the real terminator', 'cat <<EOF # \\\nx\nEOF\nwc -l </dev/null', [4]],
      // A continuation inside a duplication target still moves the line.
      ['a wc after a duplication target continued onto its line', '3>&1\\\n wc -l', [2]],
      ['a wc after a duplication target continued twice', 'x=1 3>&\\\n1\\\n- wc -l', [3]],
      // A no-break space is part of the delimiter word, so the terminator line
      // must carry it too; the file after it is code again.
      ['a delimiter holding a no-break space', "cat <<'EOF'\u00a0x\ndata\nEOF\u00a0x\nwc -l </dev/null", [4]],
      [
        'two heredoc bodies on one line, the first quoted, in the order written',
        "cmd <<'A' <<'B'\n$(ls | wc -l)\nA\n$(ls | wc -l)\nB\nwc -l </dev/null",
        [6],
      ],
      [
        'an opener re-owned through two nested substitutions',
        "y=$(\n  x=$(cat <<'EOF')\n  wc -l </dev/null\nEOF\n)\nwc -l </dev/null",
        [6],
      ],
    ])('reads %s', (_label, body, lines) => {
      expect(classifyWcTrim(`${body}\n`).violations.map((v) => v.line)).toEqual(lines);
    });

    it('terminates on an unquoted body ending in a backslash with no newline after it', () => {
      // A continuation at the very end of the file has no next line to join;
      // the lookup must still end rather than loop.
      expect(classifyWcTrim('cat <<EOF\nx\\').invocations).toEqual([]);
    });

    it('ends an unquoted heredoc only at an unindented terminator', () => {
      // `  EOF` is body text; the wc on the line after it is text too.
      const c = classifyWcTrim('cat <<EOF\n  EOF\nwc -l </dev/null\nEOF\n');
      expect(c.invocations).toEqual([]);
    });

    it.each([
      ['unterminated openers packed bytes apart', (n: number) => '$(<<Z\n'.repeat(n)],
      ['nested unterminated openers inside a terminated outer body', (n: number) => `cat <<E\n${'$(cat <<Z\n'.repeat(n)}E\n`],
      ['openers whose comments end in a backslash', (n: number) => '$(<<Z # \\\n'.repeat(n)],
    ])('reads %s without finding an invocation', (_label, make) => {
      expect(classifyWcTrim(make(32_000)).invocations).toEqual([]);
    }, 60_000);

    it('sees every wc stage when many carry a shift in their arguments', () => {
      const body = Array.from({ length: 32_000 }, () => "wc -l $((1<<2)) </dev/null |\ntr -d ' '").join('\n');
      const c = classifyWcTrim(`${body}\n`);
      expect(c.violations).toEqual([]);
      expect(c.invocations).toHaveLength(32_000);
    }, 60_000);

    it.each([
      // The index's two defining properties: the FIRST match at or after the
      // body, and one index per (joined, tab-stripped) variant.
      [
        'a delimiter occurring twice after the body start',
        "cat <<'EOF'\na\nEOF\nwc -l </dev/null\ncat <<'EOF'\nb\nEOF\n",
        [4],
      ],
      ['a quoted << body followed by a <<- body', "cat <<'A'\na\nA\ncat <<-'B'\n\tb\n\tB\nwc -l </dev/null\n", [7]],
      [
        'a physical-line index for a quoted body beside a joined one for an unquoted body',
        "cat <<B\nb\nB\ncat <<'A'\nx\\\nA\nwc -l </dev/null\n",
        [7],
      ],
      ['a delimiter occurring only BEFORE the body start', 'EOF\ncat <<EOF\nwc -l </dev/null\n', []],
    ])('indexes %s', (_label, body, lines) => {
      expect(classifyWcTrim(body).violations.map((v) => v.line)).toEqual(lines);
    });

    it('ends a heredoc delimiter at a redirection written against it', () => {
      // `<<EOF>out`: the delimiter is `EOF`; read as `EOF>out` the body never ends.
      const c = classifyWcTrim('cat <<EOF>out\nx\nEOF\nwc -l </dev/null\n');
      expect(c.violations.map((v) => v.line)).toEqual([4]);
    });

    it('keeps scanning after the heredoc body ends', () => {
      const c = classifyWcTrim("cat <<'END-TEXT'\nwc -l\nEND-TEXT\nN=$(ls | wc -l)\n");
      expect(c.violations.map((v) => v.line)).toEqual([4]);
    });

    it('ends a <<- body at its tab-indented terminator and keeps scanning', () => {
      // Without the tab strip the terminator never matches, the body runs to
      // the end of the file, and this real invocation disappears with it.
      // A bare command after the terminator: inside an unterminated UNQUOTED
      // body a `$(...)` would still run and hide the mutant.
      const c = classifyWcTrim(`cat <<-EOF\nwc -l\n${TAB}EOF\nwc -l </dev/null\n`);
      expect(c.violations.map((v) => v.line)).toEqual([4]);
    });

    it('ends a QUOTED <<- body at its tab-indented terminator and keeps scanning', () => {
      const c = classifyWcTrim(`cat <<-'EOF'\nwc -l\n${TAB}EOF\nwc -l </dev/null\n`);
      expect(c.violations.map((v) => v.line)).toEqual([4]);
    });

    it('consumes two heredoc bodies opened on one line', () => {
      // Both delimiters unquoted, so this is order-blind; the ordering itself is
      // pinned by the quoted-first case above.
      const c = classifyWcTrim('cmd <<A <<B\nwc -l\nA\nwc -w\nB\nN=$(ls | wc -l)\n');
      expect(c.violations.map((v) => v.line)).toEqual([6]);
    });
  });

  it('reports the PHYSICAL line the wc sits on, not its statement\'s first line', () => {
    // The two go-to-k/cdkd#3182 sites are backslash-wrapped, so `wc` sits two
    // physical lines below the assignment — the line a reader has to edit.
    const body = [
      'set -euo pipefail',
      'INSTANCES_LEFT="$(aws ec2 describe-instances --region "${REGION}" \\',
      '  --filters "Name=vpc-id,Values=${VPC_ID}" \\',
      "  --query 'Reservations[].Instances[].InstanceId' --output text | wc -w)\"",
      '[ "${INSTANCES_LEFT}" = "0" ]',
      '',
    ].join('\n');
    const c = classifyWcTrim(body);
    expect(c.violations.map((v) => [v.line, v.quotedSubstitution])).toEqual([[4, true]]);
  });

  it('reports the wc stage exactly, ending at the substitution it sits in', () => {
    // `stage` is what the tree-wide failure message prints, so it is output a
    // reader acts on: a stage that ran past its `)` would quote the rest of the
    // echo as if it were part of the `wc` command.
    const c = classifyWcTrim('echo "lines: $(wc -l <"${F}") done"\n');
    expect(c.violations.map((v) => v.stage)).toEqual(['wc -l <"${F}"']);
  });

  it('reports a stage cut at the separator or comment that ends it', () => {
    const c = classifyWcTrim('wc -l </dev/null # note | tr\nwc -l </dev/null; ls\n');
    expect(c.violations.map((v) => v.stage)).toEqual(['wc -l </dev/null', 'wc -l </dev/null']);
  });

  it('caps a long stage, marking the cut only when text was cut', () => {
    const cap = 200;
    const long = `wc -l ${'a'.repeat(cap)}`;
    expect(classifyWcTrim(`${long}\n`).violations[0]!.stage).toBe(`${long.slice(0, cap)}...`);
    // Whitespace past the cap is not text: nothing was cut.
    const short = `wc -l ${'a'.repeat(cap - 16)}`;
    expect(classifyWcTrim(`${short}${' '.repeat(40)}\n`).violations[0]!.stage).toBe(short);
    expect(classifyWcTrim(`${short}${'\t'.repeat(40)}\n`).violations[0]!.stage).toBe(short);
    // The cut never splits a surrogate pair.
    const astral = `wc -l ${'a'.repeat(cap - 7)}\u{1F600}rest`;
    const stage = classifyWcTrim(`${astral}\n`).violations[0]!.stage;
    expect(stage).toBe(`${astral.slice(0, cap - 1)}...`);
    // No lone surrogate anywhere in the reported text.
    expect(stage).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('ends a stage at the backtick that closes its substitution', () => {
    const c = classifyWcTrim('N=`wc -l </dev/null`; ls\n');
    expect(c.violations.map((v) => v.stage)).toEqual(['wc -l </dev/null']);
  });

  it('reads a process substitution as a file argument, not a redirect', () => {
    const c = classifyWcTrim('wc -l <(cat <file)\n');
    expect(c.invocations.map((i) => i.inputForm)).toEqual(['argument']);
  });

  it('keeps a subshell inside a quoted substitution from closing it early', () => {
    // A `)` that closed the substitution would leave `; wc ...` as quoted text.
    const c = classifyWcTrim('X="$( (echo) ; wc -l </dev/null )"\n');
    expect(c.violations.map((v) => [v.line, v.quotedSubstitution])).toEqual([[1, true]]);
  });

  it('does not read a < inside a substitution in wc\'s arguments as its input', () => {
    // The redirect belongs to `cat`, not to `wc`, so the form comes from the
    // pipe before `wc` (whether `cat` then hands `wc` file names is runtime).
    const c = classifyWcTrim("N=$(printf 'a\\n' | wc -l $(cat <list) | tr -d ' ')\n");
    expect(c.invocations.map((i) => i.inputForm)).toEqual(['pipe']);
  });

  it('keeps a quoted pipe inside the wc stage from ending it early', () => {
    const c = classifyWcTrim("N=$(wc -l <<<\"a|b\" | tr -d ' ')\n");
    expect(c.invocations.map((i) => [i.inputForm, i.trim])).toEqual([['here-string', 'space']]);
  });

  it('sees every wc in one statement, not only the first', () => {
    const body = "echo \"out $(wc -l <\"${A}\" | tr -d ' ') err $(wc -l <\"${B}\")\"\n";
    const c = classifyWcTrim(body);
    expect(c.invocations.map((i) => i.trim)).toEqual(['space', null]);
    expect(c.violations).toHaveLength(1);
  });

  it('records whether a wc sits in a substitution nested in double quotes', () => {
    const c = classifyWcTrim("A=\"$(ls | wc -l | tr -d ' ')\"\nB=$(ls | wc -l | tr -d ' ')\n");
    expect(c.invocations.map((i) => i.quotedSubstitution)).toEqual([true, false]);
  });

  describe(`# ${ALLOW_MARKER}: <reason>`, () => {
    const reason = 'x'.repeat(MIN_ALLOW_REASON_LENGTH);

    it.each([
      ['as a full-line comment directly above', `# ${ALLOW_MARKER}: ${reason}\nN=$(ls | wc -l)\n`],
      ['trailing on the same line', `N=$(ls | wc -l) # ${ALLOW_MARKER}: ${reason}\n`],
      ['trailing on the wc line of a continued statement', `N="$(printf x \\\n  | wc -l)" # ${ALLOW_MARKER}: ${reason}\n`],
    ])('allows an untrimmed site with a real reason %s', (_label, body) => {
      const c = classifyWcTrim(body);
      expect(c.violations).toEqual([]);
      expect(c.invocations.map((i) => i.allowed)).toEqual([true]);
    });

    it('requires a reason of at least 10 characters, measured after trimming', () => {
      // The header and the docs state 10; every other case derives its reason
      // from the constant, so this is the one place the number is asserted.
      expect(MIN_ALLOW_REASON_LENGTH).toBe(10);
      const at = (why: string) => classifyWcTrim(`N=$(ls | wc -l) # ${ALLOW_MARKER}: ${why}\n`);
      expect(at('abcdefghi').malformedAllowMarkers).toEqual([1]);
      expect(at('abcdefghij').violations).toEqual([]);
      // Trailing blanks do not count toward the length.
      expect(at('abcde      ').malformedAllowMarkers).toEqual([1]);
      expect(at('abcde      ').violations).toHaveLength(1);
    });

    it('refuses a marker whose reason is too short, and reports it as malformed', () => {
      const short = 'x'.repeat(MIN_ALLOW_REASON_LENGTH - 1);
      const c = classifyWcTrim(`# ${ALLOW_MARKER}: ${short}\nN=$(ls | wc -l)\n`);
      expect(c.violations).toHaveLength(1);
      expect(c.malformedAllowMarkers).toEqual([1]);
    });

    it.each([
      ['two lines above', `# ${ALLOW_MARKER}: ${reason}\n\nN=$(ls | wc -l)\n`],
      ['inside a quoted string on the line above, where it is not a comment', `echo '# ${ALLOW_MARKER}: ${reason}'\nN=$(ls | wc -l)\n`],
      ['trailing a DIFFERENT command on the line above', `true # ${ALLOW_MARKER}: ${reason}\nN=$(ls | wc -l)\n`],
    ])('does not let a marker %s exempt the site', (_label, body) => {
      expect(classifyWcTrim(body).violations).toHaveLength(1);
    });

    it.each([
      ['a double-quoted string', 'echo "a\nb"; wc -l </dev/null'],
      ["an ANSI-C quoted string", "echo $'a\nb'; wc -l </dev/null"],
      ['a quoted default inside ${...}', 'echo ${X:-"a\nb"}; wc -l </dev/null'],
    ])('keeps physical lines through a newline inside %s', (_label, body) => {
      expect(classifyWcTrim(`${body}\n`).violations.map((v) => v.line)).toEqual([2]);
    });

    it('refuses a marker with no colon before its reason, and reports it as malformed', () => {
      const c = classifyWcTrim(`# ${ALLOW_MARKER} ${reason}\nN=$(ls | wc -l)\n`);
      expect(c.violations).toHaveLength(1);
      expect(c.malformedAllowMarkers).toEqual([1]);
    });

    it.each([
      ['a doubled #', `## ${ALLOW_MARKER}: ${reason}`],
      ['a word before the marker', `# TODO ${ALLOW_MARKER}: ${reason}`],
    ])('reports %s as malformed rather than ignoring it', (_label, marker) => {
      const c = classifyWcTrim(`${marker}\nN=$(ls | wc -l)\n`);
      expect(c.violations).toHaveLength(1);
      expect(c.malformedAllowMarkers).toEqual([1]);
    });

    it('does not read a longer word ENDING with the marker as a marker', () => {
      const c = classifyWcTrim(`# dis${ALLOW_MARKER}: ${reason}\nN=$(ls | wc -l)\n`);
      expect(c.malformedAllowMarkers).toEqual([]);
    });

    it('does not read a longer word starting with the marker as a marker', () => {
      const c = classifyWcTrim(`# ${ALLOW_MARKER}s ${reason}\nN=$(ls | wc -l)\n`);
      expect(c.malformedAllowMarkers).toEqual([]);
    });

    it('does not let a marker above a backslash-wrapped statement exempt the wc two lines below', () => {
      // The marker belongs on the wc's own line or directly above it; the
      // #3182 sites are wrapped, so the rule is pinned rather than incidental.
      const c = classifyWcTrim(`# ${ALLOW_MARKER}: ${reason}\nN="$(printf x \\\n  | wc -l)"\n`);
      expect(c.violations.map((v) => v.line)).toEqual([3]);
    });

    it('keeps physical lines through an escaped newline in a parameter expansion', () => {
      const c = classifyWcTrim(`# ${ALLOW_MARKER}: ${reason}\necho "\${N:-\\\nx}"; wc -l </dev/null\n`);
      expect(c.violations.map((v) => v.line)).toEqual([3]);
    });

    it('keeps physical lines through multi-line arithmetic, so a marker cannot exempt a later line', () => {
      const c = classifyWcTrim(`# ${ALLOW_MARKER}: ${reason}\n((\n  n = 1\n)); wc -l </dev/null\n`);
      expect(c.violations.map((v) => v.line)).toEqual([4]);
    });

    it('does not mark a TRIMMED site as allowed (the marker is only an escape for a violation)', () => {
      const c = classifyWcTrim(`# ${ALLOW_MARKER}: ${reason}\nN=$(ls | wc -l | tr -d ' ')\n`);
      expect(c.invocations.map((i) => i.allowed)).toEqual([false]);
    });
  });
});

describe('tree-wide (issue #3213)', () => {
  const files = trackedShellFiles().map((rel) => {
    const content = readFileSync(join(REPO_ROOT, rel), 'utf8');
    return { rel, content, ...classifyWcTrim(content) };
  });
  const all = files.flatMap((f) => f.invocations.map((i) => ({ ...i, rel: f.rel })));
  const count = (pred: (i: (typeof all)[number]) => boolean) => all.filter(pred).length;

  it('sees the corpus', () => {
    // 263 tracked shell files at introduction: 260 fixture verify.sh files,
    // the shared s3-versions.sh helper, and two fixture-local scripts.
    expect(files.length).toBeGreaterThanOrEqual(255);
    expect(files.filter((f) => f.rel.endsWith('/verify.sh')).length).toBeGreaterThanOrEqual(250);
  });

  it('carries no untrimmed wc', () => {
    const violations = files.flatMap((f) => f.violations.map((v) => `${f.rel}:${v.line}: ${v.stage}`));
    expect(
      violations,
      "BSD wc (macOS) pads its count to width 8, so an untrimmed `$(... | wc -l)` never equals \"1\" there. Pipe it straight through `| tr -d ' '` (or `| tr -d '[:space:]'`). A site that genuinely must stay untrimmed takes `# allow-untrimmed-wc: <reason>`, trailing on its line or as a full-line comment directly above.",
    ).toEqual([]);
  });

  it('uses no escape hatch, and carries no malformed one', () => {
    // Zero at introduction. A new one is a deliberate decision this pin forces
    // into the diff rather than into a quiet comment.
    expect(count((i) => i.allowed)).toBe(0);
    expect(
      files.flatMap((f) => f.malformedAllowMarkers.map((l) => `${f.rel}:${l}`)),
      `an allow marker must read exactly \`# ${ALLOW_MARKER}: <reason>\`, with a reason of at least ${MIN_ALLOW_REASON_LENGTH} characters`,
    ).toEqual([]);
  });

  it('sees every shape it claims to handle, at no fewer than the counts taken by hand', () => {
    // Counted by hand from the fixtures before this classifier existed, then
    // cross-checked by an independent grep. The go-to-k/cdkd#3182
    // review produced two different totals by hand, which is why the floor is
    // per SHAPE rather than one aggregate: a lexer that stopped seeing the
    // here-string form would lose 2 of 39 and still clear any total floor with
    // slack.
    //
    // These are floors, not pins, so a fixture ADDING a trimmed `wc` stays
    // green. A fixture REMOVING one reds here, and the fix is to lower the
    // literal in the same change after confirming the removal was the intent.
    expect(all.length).toBeGreaterThanOrEqual(39);
    expect(count((i) => i.inputForm === 'pipe')).toBeGreaterThanOrEqual(33);
    expect(count((i) => i.inputForm === 'here-string')).toBeGreaterThanOrEqual(2);
    expect(count((i) => i.inputForm === 'redirect')).toBeGreaterThanOrEqual(4);
    expect(count((i) => i.trim === 'space')).toBeGreaterThanOrEqual(36);
    expect(count((i) => i.trim === 'posix-space-class')).toBeGreaterThanOrEqual(3);
    // Inside a `$(...)` nested in double quotes: the two
    // lambda-capacity-provider-default-name captures, the four in local-invoke's
    // echoes, one in loggroup-never-expire-guard and three in
    // local-ecs-service-connect. What proves the quote / substitution stack.
    expect(count((i) => i.quotedSubstitution)).toBeGreaterThanOrEqual(10);
    expect(new Set(all.map((i) => i.rel)).size).toBeGreaterThanOrEqual(18);
  });
});

describe('the tree stays inside what the classifier reads (issue #3213)', () => {
  it('finds a wc the classifier does not read, in each spelling that reaches one', () => {
    // Controls: without them an empty tree-wide result could mean the helper
    // matches nothing at all.
    for (const body of [
      'COUNTER=wc\n${COUNTER} -l </dev/null',
      'ls | xargs wc -l',
      'ls | xargs \\\n  wc -l',
      'eval "wc -l </dev/null"',
      "alias count='wc -l'",
      'find . -exec /usr/bin/wc -l {} +',
    ]) {
      expect(uncountedWcWords(`${body}\n`), body).not.toEqual([]);
    }
    expect(uncountedWcWords("N=$(ls | wc -l | tr -d ' ') # a wc in a comment\n")).toEqual([]);
    // Per occurrence, not per line: a counted `wc` does not cover a second one.
    expect(uncountedWcWords("wc -l </dev/null | tr -d ' '; eval 'wc -l </dev/null'\n")).toEqual([1]);
    // The documented valid spellings are not uncounted: a quoted command name,
    // an ANSI-C quoted one, and the text of a heredoc body whose delimiter is quoted.
    expect(uncountedWcWords("\"wc\" -l </dev/null | tr -d ' '\n")).toEqual([]);
    expect(uncountedWcWords("$'wc' -l </dev/null | tr -d ' '\n")).toEqual([]);
    expect(uncountedWcWords("cat <<'EOF'\nrun wc -l here\nEOF\n")).toEqual([]);
    // A quoted `#` is not a comment.
    expect(uncountedWcWords('printf \'%s\' " # "; eval \'wc -l </dev/null\'\n')).toEqual([1]);
    // Each exemption stops at its boundary: an uncounted wc BEFORE a counted
    // one, a second wc word inside a counted stage, one after a data heredoc's
    // terminator.
    expect(uncountedWcWords("eval 'wc -l'; wc -l </dev/null | tr -d ' '\n")).toEqual([1]);
    expect(uncountedWcWords("wc -l wc | tr -d ' '\n")).toEqual([1]);
    expect(uncountedWcWords("cat <<'EOF'\nx\nEOF\neval 'wc -l'\n")).toEqual([4]);
    // A data heredoc's range starts at its body, not at the start of the file.
    expect(uncountedWcWords("eval 'wc -l'\ncat <<'EOF'\nbody\nEOF\n")).toEqual([1]);
    // A data heredoc that never terminates is data to the end of the file.
    expect(uncountedWcWords("cat <<'EOF'\nrun wc -l here")).toEqual([]);
    // A comment exempts only text AFTER its `#`, not an earlier word on the line.
    expect(uncountedWcWords("eval 'wc -l' # ordinary comment\n")).toEqual([1]);
    // Counted ranges with no `wc` letters matched inside them (split quoting)
    // must still be stepped past, so a later uncounted word is found.
    expect(uncountedWcWords('"w""c" -l | tr -d \' \'; "w""c" -l | tr -d \' \'; eval \'wc -l\'\n')).toEqual([1]);
    // Outside a heredoc, a quoted parenthesis in arithmetic hides the next
    // command from the classifier (a named bound); the invariant still reports it.
    expect(uncountedWcWords('declare -A a; (( a["("] = 1 )); wc -l </dev/null\n')).toEqual([1]);
    // A longer word ending in wc is not the word wc.
    expect(uncountedWcWords('echo awc\n')).toEqual([]);
  });

  it('reads long fixtures correctly: many lines, a long line, many counted ranges', () => {
    // The same four shapes are measured for GROWTH in
    // integ-verify-wc-trim-growth.test.ts; this case pins the answers on them.
    const lines = Array.from({ length: 20_000 }, (_, k) => `# line ${k}: count with wc -l and trim it`).join('\n');
    expect(uncountedWcWords(`${lines}\n`)).toEqual([]);
    expect(uncountedWcWords(`echo ${'=a/'.repeat(32_000)}\n`)).toEqual([]);
    // Many counted invocations and many data heredoc bodies: the range lookups
    // must not rescan from the start for each match.
    const invocations = Array.from({ length: 60_000 }, () => "wc -l </dev/null | tr -d ' '").join('\n');
    expect(uncountedWcWords(`${invocations}\n`)).toEqual([]);
    const bodies = Array.from({ length: 30_000 }, () => "cat <<'EOF'\nrun wc -l here\nEOF").join('\n');
    expect(uncountedWcWords(`${bodies}\n`)).toEqual([]);
    // The path form is still recognised on a long line.
    expect(uncountedWcWords(`echo ${'a/'.repeat(1_000)}wc\n`)).toEqual([1]);
    // A bound on a hang, not on speed: growth is the other file's job.
  }, 60_000);

  it('every wc word in the tree is a counted invocation, comment text, or data heredoc text', () => {
    const hits = trackedShellFiles().flatMap((rel) =>
      uncountedWcWords(readFileSync(join(REPO_ROOT, rel), 'utf8')).map((line) => `${rel}:${line}`),
    );
    expect(
      hits,
      'the classifier did not count these as invocations, so its zero-violation verdict does not cover them. ' +
        'Call wc directly as a command (and trim it); if the word is only text (an error message, a quoted string), ' +
        'reword it — the word wc may appear only in a comment or a heredoc whose delimiter is quoted; or extend scripts/check-integ-wc-trim.ts to read the new shape.',
    ).toEqual([]);
    // Reads every tracked shell file: a bound on a hang, not on speed.
  }, 60_000);
});

describe('real-code probes (issue #3213)', () => {
  const read = (fixture: string) => readFileSync(join(INTEG_ROOT, fixture, 'verify.sh'), 'utf8');
  const lineOf = (content: string, index: number) => content.slice(0, index).split('\n').length;

  it('removing the trim from the go-to-k/cdkd#3182 multi-line capture is flagged at the wc line', () => {
    const real = read('lambda-capacity-provider-default-name');
    const trimmed = "--output text | wc -w | tr -d ' ')\"\n[ \"${INSTANCES_LEFT}\" = \"0\" ]";
    expect(real.split(trimmed), 'the fixture no longer carries the #3182 site this probe needs').toHaveLength(2);
    const broken = real.replace(trimmed, trimmed.replace(" | tr -d ' '", ''));
    const expectedLine = lineOf(broken, broken.indexOf("--output text | wc -w)\"\n[ \"${INSTANCES_LEFT}\""));
    expect(classifyWcTrim(broken).violations.map((v) => v.line)).toEqual([expectedLine]);
    expect(classifyWcTrim(real).violations).toEqual([]);
  });

  it('removing the trim from the inline here-string comparison is flagged at that line', () => {
    const real = read('local-ecs-service-connect');
    const trimmed = "if [[ \"$(wc -l <<<\"${UNIQ_ORDERS_IPS}\" | tr -d ' ')\" -ne 1 ]]; then";
    expect(real.split(trimmed), 'the fixture no longer carries the here-string site this probe needs').toHaveLength(2);
    const broken = real.replace(trimmed, trimmed.replace(" | tr -d ' '", ''));
    const c = classifyWcTrim(broken);
    expect(c.violations.map((v) => [v.line, v.inputForm])).toEqual([
      [lineOf(broken, broken.indexOf('UNIQ_ORDERS_IPS}")')), 'here-string'],
    ]);
  });

  it('removing a trim from the file redirect inside an echo is flagged, and only that one of the line\'s two', () => {
    const real = read('local-invoke');
    const trimmed = "($(wc -l <\"${SYNTH_ERR}\" | tr -d ' ') lines)";
    expect(real.split(trimmed), 'the fixture no longer carries the redirect site this probe needs').toHaveLength(2);
    const broken = real.replace(trimmed, trimmed.replace(" | tr -d ' '", ''));
    const c = classifyWcTrim(broken);
    expect(c.violations.map((v) => [v.line, v.inputForm])).toEqual([
      [lineOf(broken, broken.indexOf('wc -l <"${SYNTH_ERR}") lines)')), 'redirect'],
    ]);
    expect(c.violations[0]!.stage).toContain('SYNTH_ERR');
  });

  it('removing the posix-class trim from a helper tail is flagged', () => {
    const real = read('loggroup-class-guard');
    const trimmed = "printf '%s' \"${rows}\" | wc -w | tr -d '[:space:]'";
    expect(real.split(trimmed), 'the fixture no longer carries the helper-tail site this probe needs').toHaveLength(2);
    const broken = real.replace(trimmed, "printf '%s' \"${rows}\" | wc -w");
    expect(classifyWcTrim(broken).violations.map((v) => [v.line, v.inputForm])).toEqual([
      [lineOf(broken, broken.indexOf("printf '%s' \"${rows}\" | wc -w")), 'pipe'],
    ]);
  });
});

describe('bash behavior (the convention itself, through a BSD-padding wc)', () => {
  /**
   * Runs `body` with a `wc` shim first on PATH that prints its count the way
   * BSD `wc` does — right-aligned in a field eight wide. With the real `wc` on
   * a GNU host the untrimmed cases would pass, so the host could never show the
   * defect — which is exactly why it ships. The CONTROL case proves the padding.
   */
  /** The host's own `wc`, resolved from PATH before the shim shadows it (not a fixed /usr/bin path). */
  const HOST_WC = (spawnSync('sh', ['-c', 'command -v wc'], { encoding: 'utf8', timeout: 30_000 }).stdout ?? '').trim();

  function runWithBsdWc(body: string) {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3213-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'wc'),
        '#!/bin/sh\n' +
          '# Count with the host wc, then re-emit the number BSD-style.\n' +
          `n="$('${HOST_WC}' "$@" | awk '{print $1}')"\n` +
          'printf "%8d\\n" "$n"\n',
        { mode: 0o755 },
      );
      writeFileSync(join(dir, 'lines.txt'), 'a\n');
      const script = join(dir, 'probe.sh');
      writeFileSync(script, `set -euo pipefail\ncd "${dir}"\n${body}`);
      return spawnSync('bash', [script], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('PREMISE: the host has an absolute-path wc the shim can call', () => {
    expect(HOST_WC, 'no wc on PATH (or a relative PATH entry): the shim cannot re-emit a count').toMatch(/^\/[^']*$/);
  });

  it('CONTROL: the shim really pads, so the cases below are not vacuous', () => {
    const r = runWithBsdWc('printf \'a\\n\' | wc -l\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('       1\n');
  }, 60_000);

  const FORMS: Array<[string, string]> = [
    ['piped', "printf 'a\\n' | wc -l"],
    ['here-string', 'wc -l <<<"a"'],
    ['file redirect', 'wc -l <lines.txt'],
    ['backslash-continued pipe', "printf 'a\\n' \\\n  | wc -l"],
  ];

  it.each(FORMS)('%s: an untrimmed count fails a string comparison', (_label, form) => {
    const r = runWithBsdWc(`N="$(${form})"\n[ "\${N}" = "1" ] && echo EQUAL || echo NOT-EQUAL\n`);
    expect(r.stdout).toContain('NOT-EQUAL');
  }, 60_000);

  it.each(
    FORMS.flatMap(([label, form]) => [
      [label, form, "tr -d ' '"],
      [label, form, "tr -d '[:space:]'"],
    ]),
  )('%s: %s -> %s makes the comparison pass', (_label, form, trim) => {
    const r = runWithBsdWc(`N="$(${form} | ${trim})"\n[ "\${N}" = "1" ] && echo EQUAL || echo NOT-EQUAL\n`);
    expect(r.stdout).toContain('EQUAL');
    expect(r.stdout).not.toContain('NOT-EQUAL');
  }, 60_000);

  it('a redirect of wc\'s own stdout leaves the PADDED count in the file, whatever follows the pipe', () => {
    const r = runWithBsdWc(
      "N=\"$(printf 'a\\n' | wc -l >count.txt | tr -d ' ')\"\n" +
        'printf "captured=[%s] file=[%s]\\n" "${N}" "$(cat count.txt)"\n',
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('captured=[] file=[       1]\n');
  }, 60_000);

  it('an ARITHMETIC comparison accepts the padded value (why the fence is wider than the defect, and says so)', () => {
    const r = runWithBsdWc('N="$(printf \'a\\n\' | wc -l)"\n[ "${N}" -eq 1 ] && echo EQUAL || echo NOT-EQUAL\n');
    expect(r.stdout).toContain('EQUAL');
    expect(r.stdout).not.toContain('NOT-EQUAL');
  }, 60_000);
});
