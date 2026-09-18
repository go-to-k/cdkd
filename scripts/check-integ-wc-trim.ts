/**
 * Fence for issue #3213: every `wc` invocation in a `tests/integration`
 * shell file must pipe its result straight through a TRIM.
 *
 * WHAT GOES WRONG
 *
 * BSD `wc` (stock macOS) right-aligns its count in a field eight characters
 * wide; GNU coreutils `wc` does not. `$(...)` strips only the trailing newline,
 * so on macOS
 *
 *     N="$(printf 'a\n' | wc -l)"
 *
 * captures `"       1"`, and `[ "${N}" = "1" ]` is false. A fixture written on
 * a GNU host passes review, passes CI and passes its own real-AWS run, then
 * fails unconditionally on a Mac. go-to-k/cdkd#3182 was the second time the
 * class landed; a reviewer caught it only by running the idiom verbatim on
 * macOS, because the author's own run cannot show it.
 *
 * THE CORRECT FORM
 *
 *     N="$(printf 'a\n' | wc -l | tr -d ' ')"
 *
 * `| tr -d '[:space:]'` is accepted too; both are in use in the tree. The trim
 * must be the VERY NEXT pipeline stage after `wc` (a newline or a comment may
 * follow the `|`, as bash allows), its argument must be exactly one of those
 * two (single- or double-quoted), and the `tr` stage must end right after it —
 * `tr -d ' ' -c` keeps the spaces and deletes the digits. Nothing may take the
 * count off the pipe in between: a redirection of `wc`'s stdout
 * (`wc -l >f | tr -d ' '`, which leaves the padded count in `f`) or of `tr`'s
 * stdin (`| tr -d ' ' <f`) makes the site untrimmed.
 *
 * WHY EVERY `wc`, NOT ONLY A STRING COMPARISON
 *
 * The defect itself is narrower: `-eq` / `-ne` / `-gt` read a padded value as a
 * number, so only `=` / `!=` break. This fence is deliberately wider than that,
 * for two measured reasons:
 *
 *  - Where the value ENDS UP cannot be read reliably from the source. Four of
 *    the live sites are the last line of a helper (`count_words() { ... | wc -w
 *    | tr -d ' '; }`) whose output a caller compares somewhere else, and
 *    several captures are compared tens of lines later. The source of the value
 *    is the one place a check can be sound.
 *  - It costs nothing today. At introduction all 39 invocations were ALREADY
 *    trimmed, including the arithmetic-only ones and the one that is only
 *    echoed (`INSTANCES_UP`), so the wider rule forced no edit.
 *
 * HOW IT READS A FILE — AND WHY IT IS A LEXER, NOT A PATTERN LIST
 *
 * The first version matched `wc` with regular expressions over joined
 * statements; review found nine shapes it got wrong in both directions, each a
 * question about bash's QUOTING and NESTING. A first lexer then decided command
 * position character by character, and a second review found the same class
 * one level down (`LC_ALL="C" wc`, `</dev/null wc`, `>wc`, `command wc`, a
 * closing backtick mid-word). So this reads the file once and decides at the
 * level bash decides — the complete WORD:
 *
 *  - a word runs to unquoted whitespace or an operator, and may mix plain text,
 *    quotes, escapes and substitutions; its quote-removed text is what is
 *    compared with `wc`, so `"wc"` is `wc` and `wc"x"` is not;
 *  - quote context: single quotes, `$'...'`, double quotes (inside which a
 *    backslash escapes only `$` `` ` `` `"` `\` and a newline). An UNQUOTED
 *    reserved word is reserved; `'if'` is a command name;
 *  - nesting: `$(...)` (parenthesis-balanced), backticks, `<(...)` / `>(...)`,
 *    `${...}` — including a substitution inside it — and arithmetic `$((...))`
 *    / `((...))`, whose contents are not commands, and a compound assignment's
 *    `arr=( ... )`, whose elements are words but never commands;
 *  - comments, only where a word would start;
 *  - heredocs, opened only by an unquoted `<<` (never `<<<`). A body whose
 *    delimiter is quoted or escaped (`'EOF'`, `"EOF"`, `\EOF`) is data. A body
 *    whose delimiter is not is read like a double-quoted string — its `$(...)`
 *    and backticks run, so a `wc` there counts;
 *  - COMMAND POSITION: after `;` `|` `||` `&&` `&` `(` a newline, at the start
 *    of a substitution, after the reserved words that begin a command (`if`
 *    `then` `do` `!` `{` ...), after a command runner and its options
 *    (`command` `exec` `nohup` `env` `time`, with `exec -a NAME` / `env -u NAME`
 *    taking a value; `command -v` / `-V` only describe the next word), and after
 *    `NAME=value` assignments. A redirection and its target (`</dev/null`,
 *    `2>&1`) do not use it up.
 *
 * A `wc` word also matches as a path (`/usr/bin/wc`), and the operands of
 * `[[ ... ]]` are never commands. The line reported is the PHYSICAL line the
 * `wc` word starts on.
 *
 * WHAT IT DOES NOT CLAIM
 *
 *  - It checks the trim's SPELLING, not its effect.
 *  - It is not a bash parser. Known bounds, each with the direction it errs
 *    in. None occurs in the tree today.
 *     - A `case` pattern's `)` reads as a subshell close, which errs in BOTH
 *       directions: a `wc)` pattern is counted and flagged (fail-closed),
 *       while a `wc` in a `case` arm inside `$(...)` is missed (fail-open,
 *       and the tree invariant reports it).
 *     - A `wc` reached through a variable (`${WC} -l`), an alias, `eval`, or
 *       as an ARGUMENT of another command (`xargs wc`, `find -exec wc`, a
 *       runner option value not listed above) is not seen. Fail-open, but the
 *       unit test's tree invariant reports each such `wc` word.
 *     - A substitution inside arithmetic is not scanned. Fail-open; the tree
 *       invariant reports the `wc` word.
 *     - A parenthesis quoted inside arithmetic (`a["("]`) is counted. Inside
 *       a heredoc body the line-found terminator contains it; outside one it
 *       hides the commands after it. Fail-open; the tree invariant reports
 *       each hidden `wc` word.
 *     - `$'...'` escapes are read as the escaped character, not decoded
 *       (`$'\x77c'` is not seen). Fail-open, and NOT backstopped: the file
 *       never spells `wc`.
 *     - Only a duplication or move of fd 1 onto itself (`>&1`, `1>&1`,
 *       `1<&1`, `>&1-`; a blank may follow the `&`) is read as leaving `wc`'s
 *       stdout on the pipe. Any other redirection of fd 1, and
 *       any duplication target that is not a bare descriptor (`2>&"$X"`), is
 *       refused — including ones that end up on the pipe after all: a quoted
 *       `>&"1"`, a save-and-restore such as `3>&1 >f >&3`, or a line
 *       continuation inside the operator itself (`>\` then `&1`). Fail-closed.
 *     - CRLF line endings are not read (a heredoc terminator followed by `\r`
 *       never matches). Unreachable while `check-source-control-bytes.ts`
 *       rejects CR tree-wide.
 *     - A quoted `<<-` delimiter that itself starts with a tab
 *       (`cat <<-"<TAB>EOF"`): bash ends the body on the raw line, this
 *       compares the tab-stripped line against the raw delimiter and misses
 *       it, and the rest of the file is read as data. Fail-open, and NOT
 *       backstopped: a data body is exempt from the tree invariant.
 *    On COST rather than verdicts: nothing bounds the running time. The unit
 *    test reads large generated inputs of the shapes that were once
 *    super-linear here (a fork PR can add a tracked fixture of any size) and
 *    checks only that each is read correctly, under a hang bound; a
 *    super-linear pass on those or any other shape is not caught.
 *    The tree invariant: every `wc` word in a tracked integ shell file must be
 *    a counted invocation, comment text, or text in a heredoc whose delimiter
 *    is quoted.
 *
 * ESCAPE HATCH
 *
 * `# allow-untrimmed-wc: <reason>` as a real comment — trailing on the `wc`'s
 * own line, or a full-line comment directly above it — with a reason of at
 * least MIN_ALLOW_REASON_LENGTH (10) characters. A comment naming the marker in
 * any other shape is reported as malformed. The unit test pins how many are in
 * use.
 */

/** How the `wc` stage receives its input. */
export type WcInputForm = 'pipe' | 'here-string' | 'redirect' | 'argument';

/** Which accepted trim follows it, or `null` for none. */
export type WcTrim = 'space' | 'posix-space-class' | null;

export interface WcInvocation {
  /** 1-based PHYSICAL line the `wc` word starts on. */
  line: number;
  /** 0-based index in the file where the `wc` word starts. */
  offset: number;
  /** 0-based index just past the `wc` word (`"wc"` and `/usr/bin/wc` included). */
  wordEnd: number;
  /** The `wc ...` stage text, up to (not including) what ended it. */
  stage: string;
  inputForm: WcInputForm;
  trim: WcTrim;
  /**
   * The `wc` sits in a `$(...)` / backtick nested inside a double-quoted string.
   * Descriptive only: no verdict reads it.
   */
  quotedSubstitution: boolean;
  /** Carries a valid `allow-untrimmed-wc` marker. */
  allowed: boolean;
}

export interface WcTrimClassification {
  invocations: WcInvocation[];
  /** Untrimmed and not allowed — the violations. */
  violations: WcInvocation[];
  /** Lines carrying an `allow-untrimmed-wc` comment whose reason is too short. */
  malformedAllowMarkers: number[];
  /** 0-based index of every real comment's `#`, for the unit test's tree invariant. */
  commentOffsets: number[];
  /** `[start, end)` of every heredoc body that is data (quoted or escaped delimiter). */
  dataHeredocBodies: Array<[number, number]>;
}

export const ALLOW_MARKER = 'allow-untrimmed-wc';

/** Longest `stage` text reported for a site; it names the site, nothing reads it. */
const MAX_STAGE_CHARS = 200;

/** Shortest reason accepted after the marker, trimmed. */
export const MIN_ALLOW_REASON_LENGTH = 10;

const ALLOW_RE = new RegExp(`^#\\s*${ALLOW_MARKER}\\s*:\\s*(.*)$`);
/**
 * The marker word anywhere else in a comment — no colon, `## ...`, `# TODO ...` —
 * which is reported as malformed rather than silently ignored.
 */
const ALLOW_WORD_RE = new RegExp(`(^|[^A-Za-z0-9_-])${ALLOW_MARKER}(?![A-Za-z0-9_-])`);

/**
 * Reserved words after which the next word is still a command. Only an
 * UNQUOTED one is reserved: `'if' wc` runs a command named `if`.
 */
const RESERVED_PREFIX_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);

/**
 * Builtins and utilities that run the command named after them, past their own
 * options. `command -v wc` / `command -V wc` only DESCRIBE `wc`, so those two
 * options end the position; the options listed with a value consume the next
 * word as that value.
 */
const COMMAND_RUNNERS = new Set(['command', 'exec', 'nohup', 'env', 'time']);
const RUNNER_OPTION_WITH_VALUE: Record<string, RegExp> = {
  exec: /^-[cl]*a$/,
  env: /^-[i0v]*[uCS]$/,
};

/** `NAME=`, `NAME+=`, `NAME[i]=` at the start of a word's raw text. */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;


/** Separators between `tr`, `-d` and its argument: blanks and line continuations. */
const GAP = String.raw`(?:[ \t]|\\\n)+`;
const TRIM_RE = new RegExp(`^tr${GAP}-d${GAP}('[ ]'|"[ ]"|'\\[:space:\\]'|"\\[:space:\\]")`);

/**
 * The trim check, reading from the character that ended the `wc` stage: it
 * must be a `|`, then `tr -d <exact arg>`, and the `tr` stage must end
 * immediately after the argument. Between the `|` and `tr` bash allows blanks,
 * newlines, a comment, and the body of a heredoc opened on that line — whose
 * extent comes from the lexer itself (`heredocBodies`: start -> end), never from
 * re-reading the stage text. A `||` is refused by the same match: the character
 * after its first `|` is the second, not `tr`. `inBacktick` says the `wc` sits
 * directly in a backtick substitution.
 */
function trimAfter(
  src: string,
  end: number,
  terminator: string,
  inBacktick: boolean,
  heredocBodies: ReadonlyMap<number, number>,
): WcTrim {
  if (terminator !== '|') return null;
  let i = end + 1;
  // `|&` pipes stderr too; the count still reaches the next stage.
  if (src[i] === '&') i++;
  for (;;) {
    // A heredoc body the lexer found starting here (`wc -l <<EOF |`,
    // `cat <<EOF | wc -l |`) lies between the `|` and the next stage.
    const bodyEnd = heredocBodies.get(i);
    if (bodyEnd !== undefined) i = bodyEnd;
    else if (src[i] === ' ' || src[i] === '\t' || src[i] === '\n') i++;
    else if (src[i] === '\\' && src[i + 1] === '\n') i += 2;
    // Every position reached here starts a word (after `|`, `|&`, a blank, a
    // newline, a continuation or a heredoc body), so a `#` opens a comment.
    else if (src[i] === '#') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) return null;
      i = nl;
    } else break;
  }
  const m = TRIM_RE.exec(src.slice(i));
  if (!m) return null;
  i += m[0].length;
  /**
   * Skips blanks and line continuations. Says whether a real SPACE or TAB was
   * among them: bash removes a backslash-newline before splitting words, so
   * `tr -d ' '\<newline>{fd}<&0` is the single word `tr -d ' {fd}'`.
   */
  const skipBlanks = () => {
    let blank = false;
    for (;;) {
      if (src[i] === ' ' || src[i] === '\t') {
        blank = true;
        i++;
      } else if (src[i] === '\\' && src[i + 1] === '\n') i += 2;
      else return blank;
    }
  };
  let separated = skipBlanks();
  // Redirections after the argument are not arguments of `tr`; step over each
  // with its target before the end check. An OUTPUT redirection (`> count.txt`,
  // `2>/dev/null`) leaves the pipe intact. One that replaces `tr`'s stdin (fd 0:
  // `<file`, `<<EOF`, `<<<x`, `<>f`, `0<&3`, `<&-`) cuts the count off from the
  // trim, so the site is untrimmed. What keeps stdin: a duplication of fd 0 onto
  // itself (`<&0`, `<&00`, `<& 0`, `<&0-`, `0>&0`) and `{name}<&0`, which opens a
  // new descriptor instead.
  for (;;) {
    const r =
      /^(?:(\{[A-Za-z_][A-Za-z0-9_]*\})|(\d*))(?:(<<-|<<<|<<|<>|>>|>\||>|<)|(&>>|&>))(&[ \t]*(?:\d+-?|-))?/.exec(
        src.slice(i),
      );
    if (!r) break;
    const prefixed = r[1] !== undefined || r[2] !== '';
    // A descriptor written with no blank after the argument is part of THAT word
    // (`tr -d ' '2>x` deletes " 2"), so the trim is not the accepted spelling.
    // Only the operator characters end a word on their own (`tr -d ' '>x`).
    if (!separated && prefixed) return null;
    // `&>` is an operator only at the start of a word: `2&>R` hands `tr` the
    // argument `2` and trims nothing.
    if (r[4] !== undefined && prefixed) return null;
    const op = r[3] ?? r[4]!;
    const dup = r[5];
    // `{name}<&0` opens a NEW descriptor, so fd 0 is untouched — but `{name}<&-`
    // CLOSES the descriptor the variable holds, which may be fd 0.
    const closesNamed = r[1] !== undefined && dup !== undefined && /^&[ \t]*-$/.test(dup);
    const fd = r[1] ? (closesNamed ? 0 : -1) : r[2] ? Number(r[2]) : op.startsWith('<') ? 0 : 1;
    // `<&0`, `<&00`, `<& 0`, `<&0-`, `0>&0` duplicate fd 0 onto itself; the count
    // still arrives. (`&-` closes it: `Number('-')` is NaN, so it is not one.)
    // `&-` alone closes the descriptor and is not a duplication of anything, and
    // a trailing `-` MOVES fd 0 (closing it) unless the target is fd 0 itself.
    const dupFd = dup === undefined ? null : /^&[ \t]*(\d+)(-?)$/.exec(dup);
    const fromStdin = dupFd !== null && Number(dupFd[1]) === 0;
    // A trailing `-` MOVES stdin to another descriptor, closing fd 0 behind it.
    const movesStdin = fromStdin && dupFd![2] === '-' && fd !== 0;
    if ((fd === 0 && !fromStdin) || movesStdin) return null;
    i += r[0].length;
    if (!dup) {
      skipBlanks();
      // Bash splits words on space, tab and newline only: a no-break space is
      // text. A backslash escapes the next character — a newline included, which
      // continues the word onto the next line rather than ending the stage. A
      // `#` opens a comment only at the start of a word; inside one it is text.
      const target =
        /^(?:'[^']*'|"(?:\\.|[^"\\])*"|\\[\s\S]|[^ \t\n;&|()<>`#'"\\])(?:'[^']*'|"(?:\\.|[^"\\])*"|\\[\s\S]|[^ \t\n;&|()<>`'"\\])*/.exec(
          src.slice(i),
        );
      if (!target) return null;
      i += target[0].length;
    }
    skipBlanks();
    // A redirection's operator ends the word, so what follows one is separated
    // from the trim's argument however it is spelled.
    separated = true;
  }
  const next = src[i];
  // A backtick ends the stage only when it closes the substitution the `wc`
  // sits in; anywhere else it opens another argument.
  const endsStage =
    next === undefined ||
    /[|;)\n]/.test(next) ||
    (next === '&' && src[i + 1] !== '>') ||
    (next === '`' && inBacktick) ||
    (next === '#' && /[ \t]/.test(src[i - 1]!));
  if (!endsStage) return null;
  return m[1]!.includes('space:') ? 'posix-space-class' : 'space';
}

interface CommentInfo {
  text: string;
  fullLine: boolean;
}

interface Word {
  start: number;
  line: number;
  /** Quote-removed text, or null once any expansion made it non-literal. */
  literal: string | null;
  /** Some part of it was quoted or escaped. */
  quoted: boolean;
  commandPosition: boolean;
  afterPipe: boolean;
  /** The target of a redirection, which never uses command position. */
  redirectTarget: boolean;
}

/** A context in which bash reads commands. */
interface CodeFrame {
  /** `arr` is a compound assignment's `( ... )`: its words are never commands. */
  kind: 'code' | 'sub' | 'bt' | 'arr';
  parens: number;
  commandPosition: boolean;
  afterPipe: boolean;
  pendingRedirect: boolean;
  /** An input redirection written BEFORE the command word (`</dev/null wc`). */
  leadInput: 'redirect' | 'here-string' | null;
  /**
   * A redirection of stdout written BEFORE the command word (`>f wc`). Cleared
   * at `;`, `&`, `|` and a newline, the separators that can come before a later
   * command word (`>f (` and `>f )` are not valid bash, so `(` and `)` need not).
   */
  leadStdout: boolean;
  /** The command runner (`env`, `exec` ...) whose options are being read. */
  runner: string | null;
  /** The next word is the value of a runner option (`exec -a NAME`). */
  runnerValue: boolean;
  /** Inside `[[ ... ]]`: its words are operands, never commands. */
  cond: boolean;
  /** The next word is the name after `function`, not a command. */
  functionName: boolean;
  /** The next word follows `coproc`: a name when a `{` comes after it. */
  coproc: boolean;
  /** The `wc` invocation whose stage this frame is still reading, if any. */
  open: { index: number; start: number } | null;
  word: Word | null;
}

type Frame =
  | CodeFrame
  | { kind: 'dq' }
  | { kind: 'param'; inDq: boolean }
  | { kind: 'hd'; termStart: number; bodyEnd: number };

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  quoted: boolean;
  /**
   * The code frame the `<<` was written in. Its body starts after the next
   * newline IN THAT FRAME: a newline inside a `$( ... )` or backtick argument
   * of the same command is not the end of the command's line.
   */
  frame: object;
}

const isCode = (f: Frame): f is CodeFrame =>
  f.kind === 'code' || f.kind === 'sub' || f.kind === 'bt' || f.kind === 'arr';

/**
 * The target of a `>&` / `<&` starting at `from` (just past the `&`), when it
 * is a bare descriptor (`1`, `1-`) or `-` that ends the word, with the index
 * just past it; `null` for any other word. Bash removes a line continuation anywhere in a word before
 * reading it, so continuations may sit before, inside or after the target and
 * are dropped from the result. The word must END there: `>&1file`,
 * `>&1$(...)` and `>&1>(...)` name a FILE; a backtick is not an end, since it
 * may open a substitution; and bash splits words on space, tab and newline
 * only. One forward pass — a backtracking pattern here was quadratic in a run
 * of continuations.
 */
function readDupTarget(src: string, from: number): { text: string; end: number } | null {
  let k = from;
  const skipContinuations = () => {
    while (src[k] === '\\' && src[k + 1] === '\n') k += 2;
  };
  while (src[k] === ' ' || src[k] === '\t' || (src[k] === '\\' && src[k + 1] === '\n')) k += src[k] === '\\' ? 2 : 1;
  let text = '';
  if (src[k] === '-') {
    text = '-';
    k++;
  } else {
    for (;;) {
      skipContinuations();
      const c = src[k];
      if (c === undefined || c < '0' || c > '9') break;
      text += c;
      k++;
    }
    if (text === '') return null;
    if (src[k] === '-') {
      text += '-';
      k++;
    }
  }
  skipContinuations();
  const c = src[k];
  const endsWord =
    c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '|' || c === ';' || c === '&' || c === ')' ||
    ((c === '<' || c === '>') && src[k + 1] !== '(');
  return endsWord ? { text, end: k } : null;
}

/** Index just past the `)` closing a `((` / `$((` that starts at `open` (the first `(`). */
function skipArithmetic(src: string, open: number): number {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '(') depth++;
    else if (src[k] === ')' && --depth === 0) return k + 1;
  }
  return src.length;
}

/**
 * Parses a heredoc delimiter word starting at `from`: the delimiter is its
 * quote-removed text, and the body is data when any part was quoted or escaped.
 */
function readHeredocDelimiter(
  src: string,
  from: number,
  inBacktick: boolean,
): { delimiter: string; quoted: boolean; end: number } {
  let k = from;
  let delimiter = '';
  let quoted = false;
  // Inside a backtick substitution a backtick ends the word too
  // (`` `cat <<'EOF'` `` closes it); elsewhere it is part of the delimiter
  // (``cat <<E`OF` ``).
  // Bash splits words on space, tab and newline only: a no-break space is text.
  while (k < src.length && !/[ \t\n;&|()<>]/.test(src[k]!) && !(inBacktick && src[k] === '`')) {
    let c = src[k]!;
    if (c === '$' && (src[k + 1] === "'" || src[k + 1] === '"')) {
      k++;
      c = src[k]!;
    }
    if (c === "'" || c === '"') {
      const close = src.indexOf(c, k + 1);
      const stop = close === -1 ? src.length : close;
      delimiter += src.slice(k + 1, stop);
      quoted = true;
      k = stop + 1;
    } else if (c === '\\') {
      delimiter += src[k + 1] ?? '';
      quoted = true;
      k += 2;
    } else {
      delimiter += c;
      k++;
    }
  }
  return { delimiter, quoted, end: k };
}

export function classifyWcTrim(content: string): WcTrimClassification {
  const src = content;
  const invocations: Array<Omit<WcInvocation, 'allowed'>> = [];
  const comments = new Map<number, CommentInfo>();
  const commentOffsets: number[] = [];
  const dataHeredocBodies: Array<[number, number]> = [];
  /** Every heredoc body, data or not: start -> end. */
  const heredocBodies = new Map<number, number>();
  // Only a non-empty extent is recorded, so a lookup always moves forward.
  const recordBody = (start: number, end: number) => {
    if (end > start) heredocBodies.set(start, end);
  };
  const deferredTrims: Array<{ index: number; stageEnd: number; terminator: string; inBacktick: boolean }> = [];
  /**
   * Invocations whose OWN stdout is redirected (`wc -l >f | tr`, `>&2`, `&>f`):
   * the count goes to the file and `tr` reads nothing, so no trim applies.
   */
  const stdoutAway = new Set<number>();

  const newCode = (kind: CodeFrame['kind']): CodeFrame => ({
    kind,
    parens: 0,
    commandPosition: true,
    afterPipe: false,
    pendingRedirect: false,
    leadInput: null,
    leadStdout: false,
    runner: null,
    runnerValue: false,
    cond: false,
    functionName: false,
    coproc: false,
    open: null,
    word: null,
  });
  const stack: Frame[] = [newCode('code')];
  /** The code frames on `stack`, in order — so the innermost is O(1) to find. */
  const codeFrames: CodeFrame[] = [stack[0] as CodeFrame];
  const pending: PendingHeredoc[] = [];
  let line = 1;
  let lineStart = 0;

  const top = () => stack[stack.length - 1]!;
  /**
   * The code frame whose word a quote or `${...}` at the top of the stack is
   * part of. A heredoc body pushes neither, so none sits above one.
   */
  const wordOwner = (): CodeFrame | null => codeFrames[codeFrames.length - 1] ?? null;
  /** How many double-quote frames are open — kept as a count, not a stack scan. */
  let dqDepth = 0;
  const dqAncestor = () => dqDepth > 0;

  /** Starts a word in `f` at `i` if none is in progress, and returns it. */
  const wordAt = (f: CodeFrame, i: number): Word => {
    if (!f.word) {
      f.word = {
        start: i,
        line,
        literal: '',
        quoted: false,
        commandPosition: f.pendingRedirect ? false : f.commandPosition,
        afterPipe: f.afterPipe,
        redirectTarget: f.pendingRedirect,
      };
      if (!f.pendingRedirect) f.commandPosition = false;
      f.pendingRedirect = false;
    }
    return f.word;
  };
  const appendLiteral = (f: CodeFrame, i: number, text: string) => {
    const w = wordAt(f, i);
    if (w.literal !== null) w.literal += text;
  };
  const markExpansion = (f: CodeFrame, i: number) => {
    wordAt(f, i).literal = null;
  };
  const appendQuoted = (f: CodeFrame, i: number, text: string) => {
    appendLiteral(f, i, text);
    wordAt(f, i).quoted = true;
  };

  /** Ends the word in progress in `f`, whose text ends before `end`. */
  const endWord = (f: CodeFrame, end: number) => {
    const w = f.word;
    if (!w) return;
    f.word = null;
    if (f.cond) {
      if (w.literal === ']]' && !w.quoted) f.cond = false;
      return;
    }
    if (w.redirectTarget || !w.commandPosition) return;
    if (f.functionName) {
      // `function NAME { ... }`: the body's first word is a command.
      f.functionName = false;
      f.commandPosition = true;
      return;
    }
    if (f.coproc) {
      f.coproc = false;
      let j = end;
      while (src[j] === ' ' || src[j] === '\t') j++;
      if (src[j] === '{') {
        // `coproc NAME { ... }`: NAME is not a command.
        f.commandPosition = true;
        return;
      }
    }
    const raw = src.slice(w.start, end);
    const runner = f.runner;
    f.runner = null;
    if (f.runnerValue) {
      // The value of a runner option: the command is still to come.
      f.runnerValue = false;
      f.runner = runner;
      f.commandPosition = true;
      return;
    }
    // `env -` (an empty environment) is an option too.
    if (runner !== null && w.literal !== null && w.literal.startsWith('-')) {
      if (runner === 'command' && /[vV]/.test(w.literal)) {
        f.afterPipe = false;
        f.leadInput = null;
        return;
      }
      f.runner = runner;
      f.runnerValue = RUNNER_OPTION_WITH_VALUE[runner]?.test(w.literal) ?? false;
      f.commandPosition = true;
      return;
    }
    if (w.literal === 'coproc' && !w.quoted) {
      f.coproc = true;
      f.commandPosition = true;
      return;
    }
    if (w.literal === 'function' && !w.quoted) {
      f.functionName = true;
      f.commandPosition = true;
      return;
    }
    if (w.literal === '[[' && !w.quoted) {
      f.cond = true;
      f.afterPipe = false;
      f.leadInput = null;
      return;
    }
    // `wc`, or a path to it (`/usr/bin/wc`).
    if (w.literal !== null && (w.literal === 'wc' || w.literal.endsWith('/wc'))) {
      let j = end;
      while (src[j] === ' ' || src[j] === '\t') j++;
      if (src[j] === '(') {
        // `wc() { ... }` defines a function; it runs nothing.
        f.afterPipe = false;
        return;
      }
      // The stage is read INCREMENTALLY by this frame from here: its input form
      // from the redirections it meets, its end from the separator it meets.
      // Re-walking each stage from the `wc` word would be quadratic on nested
      // `wc $(wc $(...))`.
      f.open = { index: invocations.length, start: w.start };
      invocations.push({
        line: w.line,
        offset: w.start,
        wordEnd: end,
        stage: '',
        inputForm: f.leadInput ?? (w.afterPipe ? 'pipe' : 'argument'),
        // Filled in after the whole file is lexed, once every heredoc body's
        // extent is known.
        trim: null,
        quotedSubstitution: dqAncestor(),
      });
      if (f.leadStdout) stdoutAway.add(f.open.index);
      f.afterPipe = false;
      f.leadInput = null;
    } else if (ASSIGNMENT_RE.test(raw) || (w.literal !== null && !w.quoted && RESERVED_PREFIX_WORDS.has(w.literal))) {
      f.commandPosition = true;
    } else if (w.literal !== null && COMMAND_RUNNERS.has(w.literal)) {
      f.runner = w.literal;
      f.commandPosition = true;
    } else {
      f.afterPipe = false;
      f.leadInput = null;
    }
  };

  /** `nextSolid[k]`: the first index at or after `k` that is not whitespace. */
  const nextSolid = new Int32Array(src.length + 1);
  nextSolid[src.length] = src.length;
  for (let k = src.length - 1; k >= 0; k--) nextSolid[k] = /\s/.test(src[k]!) ? nextSolid[k + 1]! : k;

  /**
   * A redirection of stdout in `f`: it belongs to the `wc` stage the frame is
   * reading, or to the command to come. (One after another command's word is
   * cleared with that command before any later `wc` could read it.)
   */
  const markStdoutAway = (f: CodeFrame) => {
    if (f.open) stdoutAway.add(f.open.index);
    else f.leadStdout = true;
  };

  /**
   * Ends the `wc` stage this frame is reading at `end`, the separator that ended
   * it. The reported stage text is capped, since it only names the site.
   */
  const closeStage = (f: CodeFrame, end: number, terminator: string) => {
    const open = f.open;
    if (!open) return;
    f.open = null;
    // Slice only what is reported: stages nest, so slicing each whole stage
    // would be quadratic on `wc $(wc $(...))`. The text is cut only when
    // something other than trailing whitespace lies past the cap.
    const cut = open.start + MAX_STAGE_CHARS;
    const capped = cut < src.length && nextSolid[cut]! < end;
    // Never between the halves of a surrogate pair.
    const keep = capped && /[\uD800-\uDBFF]/.test(src[cut - 1]!) ? cut - 1 : cut;
    const text = src.slice(open.start, Math.min(end, keep)).trim();
    invocations[open.index]!.stage = capped ? `${text}...` : text;
    deferredTrims.push({ index: open.index, stageEnd: end, terminator, inBacktick: f.kind === 'bt' });
  };

  // Physical line of an offset, by binary search over precomputed line starts.
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  /** A line ending in an unescaped backslash, which an unquoted body joins to the next. */
  const CONTINUED = /(^|[^\\])(\\\\)*\\$/;
  interface TerminatorLine {
    /** Start of the logical line (its first physical line), where the body ends. */
    start: number;
    /** Index just past its last physical line. */
    bodyEnd: number;
  }
  const terminatorIndexes = new Map<string, Map<string, TerminatorLine[]>>();
  /**
   * Every line of the file, keyed by the text a delimiter is compared with, in
   * file order: built once per variant, so finding N terminators costs
   * N binary searches instead of N scans to the end of the file. `joined`
   * merges each unescaped backslash-newline (an UNQUOTED body); `stripTabs`
   * drops leading tabs (`<<-`). A line with no newline after it still ends.
   */
  const terminatorIndex = (joined: boolean, stripTabs: boolean): Map<string, TerminatorLine[]> => {
    const key = `${joined ? 'j' : 'p'}${stripTabs ? 't' : 'n'}`;
    const cached = terminatorIndexes.get(key);
    if (cached) return cached;
    const index = new Map<string, TerminatorLine[]>();
    let at = 0;
    let logical: string | null = null;
    let start = 0;
    // `at` always advances by a whole line, so the walk ends at the end of file.
    while (at < src.length) {
      const nl = src.indexOf('\n', at);
      const next = nl === -1 ? src.length : nl + 1;
      const raw = src.slice(at, nl === -1 ? src.length : nl);
      if (logical === null) start = at;
      if (joined && CONTINUED.test(raw) && nl !== -1) {
        logical = (logical ?? '') + raw.slice(0, -1);
        at = next;
        continue;
      }
      const text0 = (logical ?? '') + raw;
      logical = null;
      const text = stripTabs ? text0.replace(/^\t+/, '') : text0;
      const entry = { start, bodyEnd: next };
      const list = index.get(text);
      if (list) list.push(entry);
      else index.set(text, [entry]);
      at = next;
    }
    terminatorIndexes.set(key, index);
    return index;
  };

  /**
   * Finds a body's terminator by LINE, before anything in the body is read —
   * as bash does — so nothing inside the body (an unbalanced substitution, an
   * arithmetic desync) can move where it ends.
   */
  const findTerminator = (pos: number, h: PendingHeredoc): { termStart: number; bodyEnd: number } => {
    const joined = !h.quoted;
    // The index joins continuations from the start of the FILE. When the line
    // just before the body ends in a backslash bash did not treat as one (a
    // comment, a quoted string), the index glued that line onto the body's first
    // logical line. That glued entry starts before `pos`, so the search below
    // skips it by itself; only whether the body's own first logical line is the
    // terminator must be decided here. The walk stops as soon as the joined
    // text outgrows the delimiter, so it never scans far.
    if (joined && pos > 0) {
      const prevStart = src.lastIndexOf('\n', pos - 2) + 1;
      if (CONTINUED.test(src.slice(prevStart, pos - 1))) {
        let at = pos;
        let compared = '';
        // `<<-` strips the leading tabs ONCE, while the text is still all tabs;
        // stripping the accumulator every round would be quadratic in its length.
        let leadingTabs = h.stripTabs;
        for (;;) {
          const nl = src.indexOf('\n', at);
          const next = nl === -1 ? src.length : nl + 1;
          const raw = src.slice(at, nl === -1 ? src.length : nl);
          const continued = CONTINUED.test(raw) && nl !== -1;
          let segment = continued ? raw.slice(0, -1) : raw;
          if (leadingTabs) {
            segment = segment.replace(/^\t+/, '');
            if (segment !== '') leadingTabs = false;
          }
          compared += segment;
          if (!continued) {
            if (compared === h.delimiter) return { termStart: pos, bodyEnd: next };
            break;
          }
          // `compared` is already tab-stripped, so outgrowing the delimiter is final.
          if (compared.length > h.delimiter.length) break;
          at = next;
        }
      }
    }
    const starts = terminatorIndex(joined, h.stripTabs).get(h.delimiter);
    if (starts !== undefined) {
      // First indexed logical line starting at or after the body.
      let lo = 0;
      let hi = starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid]!.start < pos) lo = mid + 1;
        else hi = mid;
      }
      const hit = starts[lo];
      if (hit !== undefined) return { termStart: hit.start, bodyEnd: hit.bodyEnd };
    }
    return { termStart: src.length, bodyEnd: src.length };
  };

  /** Starts the bodies of the heredocs this frame opened on the line that just ended. */
  const startHeredocs = (pos: number, owner: object): number => {
    // Only this frame's openers start here, in the order they were written; an
    // outer command's pending opener waits for its own line to end.
    for (;;) {
      const index = pending.findIndex((p) => p.frame === owner);
      if (index === -1) break;
      const h = pending.splice(index, 1)[0]!;
      const { termStart, bodyEnd } = findTerminator(pos, h);
      recordBody(pos, bodyEnd);
      if (!h.quoted) {
        const hd = { kind: 'hd' as const, termStart, bodyEnd };
        stack.push(hd);
        openBodies.push(hd);
        return pos;
      }
      // A quoted delimiter: the body is data, skipped whole.
      dataHeredocBodies.push([pos, bodyEnd]);
      pos = bodyEnd;
      line = lineAt(pos);
      lineStart = pos;
    }
    return pos;
  };

  /** Unquoted heredoc bodies being lexed, innermost last (kept so the loop head is O(1)). */
  const openBodies: Array<{ kind: 'hd'; termStart: number; bodyEnd: number }> = [];

  /**
   * A frame closed before the line its `<<` was written on ended
   * (`x=$(cat <<'EOF')`): its pending openers now wait for the enclosing
   * frame's newline, which is where bash reads their bodies.
   */
  const closeFrame = (closed: object) => {
    // The enclosing CODE frame — through any quote or `${...}` around the
    // substitution — since only a code frame's newline starts bodies.
    const outer = wordOwner() ?? stack[0]!;
    for (const p of pending) if (p.frame === closed) p.frame = outer;
  };

  const pushCode = (f: CodeFrame) => {
    stack.push(f);
    codeFrames.push(f);
  };
  const pushSub = (kind: 'sub' | 'bt') => pushCode(newCode(kind));
  /** Pops the code frame on top of the stack, closing its open `wc` stage. */
  const popCode = (f: CodeFrame, at: number, terminator: string) => {
    closeStage(f, at, terminator);
    stack.pop();
    codeFrames.pop();
    closeFrame(f);
  };

  /** Skips arithmetic from its first `(`, keeping the physical line count. */
  const skipArith = (open: number): number => {
    const end = skipArithmetic(src, open);
    for (let k = open; k < end; k++) {
      if (src[k] === '\n') {
        line++;
        lineStart = k + 1;
      }
    }
    return end;
  };

  // Something inside a body can consume to the end of the file (an unbalanced
  // `$((`, an unterminated quote), and the body must still close at its
  // terminator so the lines after it are read — hence no loop bound here.
  for (let i = 0; ; i++) {
    // A handler that jumped to the end of the file (an unterminated quote) can
    // step past it; settle there so an open body still closes.
    if (i > src.length) i = src.length;
    // The innermost open heredoc body ends at its terminator line, whatever
    // frames its contents left open.
    const hd = openBodies[openBodies.length - 1];
    if (hd !== undefined && i >= hd.termStart) {
      openBodies.pop();
      // Frames the body left open are closed with it (the index once: a
      // per-iteration search would be quadratic in the nesting depth).
      const hdIndex = stack.lastIndexOf(hd);
      let codeFramesLeft = codeFrames.length;
      for (let s = stack.length - 1; s > hdIndex; s--) {
        const f = stack[s]!;
        if (isCode(f)) {
          closeStage(f, hd.termStart, '\n');
          codeFramesLeft--;
        } else if (f.kind === 'dq') dqDepth--;
      }
      stack.length = hdIndex;
      codeFrames.length = codeFramesLeft;
      line = lineAt(hd.bodyEnd);
      lineStart = hd.bodyEnd;
      // The frame below the finished body is the one that opened it.
      i = startHeredocs(hd.bodyEnd, top()) - 1;
      continue;
    }
    if (i >= src.length) break;
    const c = src[i]!;
    const frame = top();

    if (frame.kind === 'hd') {
      // An unquoted body reads like a double-quoted string without the quotes.
      if (c === '\\') {
        if (src[i + 1] === '\n') {
          line++;
          lineStart = i + 2;
        }
        i++;
      } else if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') {
        i = skipArith(i + 1) - 1;
      } else if (c === '$' && src[i + 1] === '(') {
        pushSub('sub');
        i++;
      } else if (c === '`') {
        pushSub('bt');
      } else if (c === '\n') {
        line++;
        lineStart = i + 1;
      }
      continue;
    }

    if (frame.kind === 'param') {
      if (c === '\\') {
        if (src[i + 1] === '\n') {
          line++;
          lineStart = i + 2;
        }
        i++;
      } else if (c === '$' && src[i + 1] === '{') {
        // Nested `${A:-${B:-x}}`: its `}` closes the inner expansion only.
        stack.push({ kind: 'param', inDq: frame.inDq });
        i++;
      } else if (c === '}') {
        stack.pop();
      } else if (c === '"') {
        // Quotes nest inside `${...}` (`${CONFIG:-"{}"}`), so a quoted `}` is text.
        const owner = wordOwner();
        if (owner) wordAt(owner, i).quoted = true;
        stack.push({ kind: 'dq' });
        dqDepth++;
      } else if (c === "'" && !frame.inDq) {
        // Outside double quotes a `'` inside `${...}` quotes its text.
        const close = src.indexOf("'", i + 1);
        const stop = close === -1 ? src.length : close;
        for (let k = i + 1; k < stop; k++) {
          if (src[k] === '\n') {
            line++;
            lineStart = k + 1;
          }
        }
        i = stop;
      } else if (c === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
        pushSub('sub');
        i++;
      } else if (c === '`') {
        pushSub('bt');
      } else if (c === '\n') {
        line++;
        lineStart = i + 1;
      }
      continue;
    }

    if (frame.kind === 'dq') {
      const owner = wordOwner();
      const appendText = (text: string) => owner && appendQuoted(owner, i, text);
      const expansion = () => owner && markExpansion(owner, i);
      if (c === '"') {
        stack.pop();
        dqDepth--;
      } else if (c === '\\') {
        if (src[i + 1] === '\n') {
          line++;
          lineStart = i + 2;
        } else if (/[$`"\\]/.test(src[i + 1] ?? '')) {
          appendText(src[i + 1]!);
        } else {
          // Inside double quotes a backslash before anything else stays.
          appendText(`\\${src[i + 1] ?? ''}`);
        }
        i++;
      } else if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') {
        expansion();
        i = skipArith(i + 1) - 1;
      } else if (c === '$' && src[i + 1] === '(') {
        expansion();
        pushSub('sub');
        i++;
      } else if (c === '$' && src[i + 1] === '{') {
        expansion();
        stack.push({ kind: 'param', inDq: true });
        i++;
      } else if (c === '$') {
        expansion();
      } else if (c === '`') {
        expansion();
        pushSub('bt');
      } else {
        if (c === '\n') {
          line++;
          lineStart = i + 1;
        }
        appendText(c);
      }
      continue;
    }

    // ---- a code frame: 'code' | 'sub' | 'bt' ----
    const f = frame as CodeFrame;

    if (c === '\\') {
      if (src[i + 1] === '\n') {
        // A line continuation joins words; it is not a separator.
        line++;
        lineStart = i + 2;
      } else {
        appendQuoted(f, i, src[i + 1] ?? '');
      }
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord(f, i);
      continue;
    }
    if (c === '\n') {
      endWord(f, i);
      closeStage(f, i, '\n');
      line++;
      lineStart = i + 1;
      // After a `|` a newline keeps the pipe; after a finished command it ends it.
      f.afterPipe = f.afterPipe && f.commandPosition;
      f.commandPosition = f.kind !== 'arr';
      f.pendingRedirect = false;
      f.leadInput = null;
      f.leadStdout = false;
      f.runner = null;
      f.runnerValue = false;
      i = startHeredocs(i + 1, f) - 1;
      continue;
    }
    if (c === '#' && !f.word) {
      closeStage(f, i, '#');
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      comments.set(line, { text: src.slice(i, end), fullLine: src.slice(lineStart, i).trim() === '' });
      commentOffsets.push(i);
      i = end - 1;
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const stop = close === -1 ? src.length : close;
      appendQuoted(f, i, src.slice(i + 1, stop));
      for (let k = i + 1; k < stop; k++) {
        if (src[k] === '\n') {
          line++;
          lineStart = k + 1;
        }
      }
      i = stop;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      // ANSI-C quoting. Escapes are kept as the escaped character, which is
      // exact for every letter of `wc`.
      let text = '';
      let k = i + 2;
      while (k < src.length && src[k] !== "'") {
        if (src[k] === '\\') k++;
        if (src[k] === '\n') {
          line++;
          lineStart = k + 1;
        }
        text += src[k] ?? '';
        k++;
      }
      appendQuoted(f, i, text);
      i = k;
      continue;
    }
    if (c === '"') {
      // Even an empty `""` quotes the word: `""if` is a command named `if`.
      wordAt(f, i).quoted = true;
      stack.push({ kind: 'dq' });
      dqDepth++;
      continue;
    }
    if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') {
      markExpansion(f, i);
      i = skipArith(i + 1) - 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      markExpansion(f, i);
      pushSub('sub');
      i++;
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      markExpansion(f, i);
      stack.push({ kind: 'param', inDq: false });
      i++;
      continue;
    }
    if (c === '$') {
      markExpansion(f, i);
      continue;
    }
    if (c === '`') {
      if (f.kind === 'bt') {
        endWord(f, i);
        popCode(f, i, '`');
      } else {
        markExpansion(f, i);
        pushSub('bt');
      }
      continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      // Process substitution: a word whose contents are commands.
      markExpansion(f, i);
      pushSub('sub');
      i++;
      continue;
    }
    if (c === '(') {
      if (f.word && /=$/.test(src.slice(f.word.start, i))) {
        // `arr=(a b)`: a compound assignment. Its elements are words — quoted,
        // expanded, substituted — but never commands.
        markExpansion(f, i);
        pushCode({ ...newCode('arr'), commandPosition: false });
        continue;
      }
      endWord(f, i);
      if (f.commandPosition && src[i + 1] === '(') {
        // `(( ... ))` arithmetic: its words are not commands.
        i = skipArith(i) - 1;
        f.commandPosition = false;
        continue;
      }
      if (f.kind === 'sub') f.parens++;
      f.commandPosition = true;
      f.afterPipe = false;
      f.leadInput = null;
      continue;
    }
    if (c === ')') {
      endWord(f, i);
      if (f.kind === 'arr') {
        popCode(f, i, ')');
        continue;
      }
      if (f.kind === 'sub') {
        if (f.parens > 0) f.parens--;
        else {
          popCode(f, i, ')');
          continue;
        }
      }
      closeStage(f, i, ')');
      // A `case` pattern's `)`, or a subshell close: the next word starts a
      // command in the pattern case and is an operator after a subshell.
      f.commandPosition = true;
      f.afterPipe = false;
      f.leadInput = null;
      continue;
    }
    if (c === '|') {
      endWord(f, i);
      const double = src[i + 1] === '|';
      closeStage(f, i, double ? '||' : '|');
      if (double || src[i + 1] === '&') i++;
      f.afterPipe = !double;
      f.commandPosition = true;
      f.leadInput = null;
      f.leadStdout = false;
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '>') {
        // `&>file` / `&>>file` send stdout (and stderr) to the file.
        endWord(f, i);
        markStdoutAway(f);
        i++;
        if (src[i + 1] === '>') i++;
        f.pendingRedirect = true;
        continue;
      }
      endWord(f, i);
      closeStage(f, i, '&');
      if (src[i + 1] === '&') i++;
      f.commandPosition = true;
      f.afterPipe = false;
      f.leadInput = null;
      f.leadStdout = false;
      continue;
    }
    if (c === ';') {
      endWord(f, i);
      closeStage(f, i, ';');
      if (src[i + 1] === ';') i++;
      f.commandPosition = true;
      f.afterPipe = false;
      f.leadInput = null;
      f.leadStdout = false;
      continue;
    }
    if (c === '<' || c === '>') {
      const w = f.word;
      // A word attached to the operator with no blank is its descriptor when it
      // is digits (`3<f`) or `{name}`; any other attached word (`wc<f`) is a
      // plain word before a stdin redirection. Only an operator with no
      // descriptor, or descriptor `0`, reads on stdin — the input `wc` counts.
      const descriptor =
        w !== null && !w.redirectTarget && !w.quoted && w.literal !== null && /^(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(w.literal)
          ? w.literal
          : null;
      const onStdin = c === '<' && (descriptor === null || Number(descriptor) === 0);
      const namedFd = descriptor !== null && descriptor.startsWith('{');
      // The descriptor redirected: 0 or 1 by default, a number when written,
      // and NaN — equal to none — for `{name}`, which opens a new one.
      const fd = descriptor === null ? (c === '<' ? 0 : 1) : Number(descriptor);
      if (w && descriptor !== null) {
        // `2>&1`, `{fd}>f`: the digits or name are the redirection's file
        // descriptor, not a word — so they use up no command position.
        f.word = null;
        f.commandPosition = w.commandPosition;
        f.afterPipe = w.afterPipe;
      } else {
        endWord(f, i);
      }
      if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
        // Heredoc opener — only reachable in a code frame, so a quoted "<<EOF"
        // is never one.
        let k = i + 2;
        let stripTabs = false;
        if (src[k] === '-') {
          stripTabs = true;
          k++;
        }
        while (src[k] === ' ' || src[k] === '\t') k++;
        if (fd === 1) markStdoutAway(f);
        const d = readHeredocDelimiter(src, k, f.kind === 'bt');
        if (d.end > k) {
          pending.push({ delimiter: d.delimiter, stripTabs, quoted: d.quoted, frame: f });
          i = d.end - 1;
        } else {
          i++;
        }
        continue;
      }
      // Any other redirection operator; its target word follows.
      if (onStdin && f.commandPosition && src[i + 1] !== '>') {
        f.leadInput = src.startsWith('<<<', i) ? 'here-string' : 'redirect';
      }
      if (onStdin && f.open) {
        // The open `wc` stage's input. Bash applies redirections left to right,
        // so the LAST one on stdin is the one `wc` reads from.
        invocations[f.open.index]!.inputForm = src.startsWith('<<<', i) ? 'here-string' : 'redirect';
      }
      let k = i + 1;
      while (src[k] === '<' || src[k] === '>' || src[k] === '|') k++;
      // Stdout redirected away from the pipe: anything on fd 1 except a
      // duplication or move of fd 1 onto itself (`>&1`, `>&1-`); a MOVE of fd 1
      // onto another descriptor (`3>&1-`), which closes fd 1 behind it; and
      // `{name}>&-`, which closes the descriptor the variable holds — possibly
      // fd 1. A duplication target that is not a bare descriptor (`3>&'1-'`,
      // `2>&"$X"`, `>&1file`) may be any of those once expanded, so it counts
      // as one.
      const isDup = src[k] === '&';
      const dupRead = isDup ? readDupTarget(src, k + 1) : null;
      const dupTarget = dupRead?.text ?? null;
      const fromFd = dupTarget !== null && dupTarget !== '-' ? Number.parseInt(dupTarget, 10) : null;
      const movesFromStdout = fromFd === 1 && dupTarget!.endsWith('-') && fd !== 1;
      const unreadTarget = isDup && dupTarget === null;
      if ((fd === 1 && fromFd !== 1) || movesFromStdout || (namedFd && dupTarget === '-') || unreadTarget) {
        markStdoutAway(f);
      }
      if (isDup) {
        // Step over exactly the descriptor read above; any other word (`1file`,
        // `'1-'`) is the redirection's target, never a command word of its own.
        if (dupRead) {
          // Line continuations inside it still move the physical line.
          for (let n = k + 1; n < dupRead.end; n++) {
            if (src[n] === '\n') {
              line++;
              lineStart = n + 1;
            }
          }
          i = dupRead.end - 1;
        } else {
          i = k;
          f.pendingRedirect = true;
        }
        continue;
      }
      i = k - 1;
      f.pendingRedirect = true;
      continue;
    }

    appendLiteral(f, i, c);
  }
  // A file that ends inside a word (no trailing newline) still ends that word,
  // and the stage it was reading.
  for (let s = stack.length - 1; s >= 0; s--) {
    const f = stack[s]!;
    if (isCode(f)) {
      endWord(f, src.length);
      closeStage(f, src.length, '');
    }
  }
  for (const d of deferredTrims) {
    invocations[d.index]!.trim = stdoutAway.has(d.index)
      ? null
      : trimAfter(src, d.stageEnd, d.terminator, d.inBacktick, heredocBodies);
  }

  // Allow markers: a real comment trailing the wc's own line, or a FULL-LINE
  // comment directly above it.
  const markerState = (info: CommentInfo | undefined): 'valid' | 'malformed' | 'absent' => {
    if (!info) return 'absent';
    const m = ALLOW_RE.exec(info.text);
    if (!m) return ALLOW_WORD_RE.test(info.text) ? 'malformed' : 'absent';
    return m[1]!.trim().length >= MIN_ALLOW_REASON_LENGTH ? 'valid' : 'malformed';
  };
  const malformedAllowMarkers = [...comments.entries()]
    .filter(([, info]) => markerState(info) === 'malformed')
    .map(([l]) => l)
    .sort((a, b) => a - b);

  const withAllowed: WcInvocation[] = invocations.map((inv) => {
    if (inv.trim !== null) return { ...inv, allowed: false };
    const same = comments.get(inv.line);
    const above = comments.get(inv.line - 1);
    const allowed =
      markerState(same) === 'valid' || (above?.fullLine === true && markerState(above) === 'valid');
    return { ...inv, allowed };
  });

  return {
    invocations: withAllowed,
    violations: withAllowed.filter((i) => i.trim === null && !i.allowed),
    malformedAllowMarkers,
    commentOffsets,
    dataHeredocBodies,
  };
}
