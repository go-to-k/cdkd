import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Structural fence for issue #2440.
 *
 * The DEFECT the issue reported is not "one message was wrong" — it is that
 * one channel redacted the `docker` argv and a sibling channel eleven lines
 * away did not. A behavioural test per fixed site cannot see the NEXT such
 * divergence.
 *
 * ## Read this before trusting it
 *
 * **The guarantee is NOT this file.** It is that every docker failure text is
 * produced by `describeDockerFailure` / `describeDockerExecFailure` /
 * `describeDockerCapturedOutput` in `src/utils/docker-cmd.ts`, each of which
 * takes a REQUIRED `args` and redacts internally — a call site cannot obtain
 * the text without handing over the argv. That is type-checked. This file is a
 * backstop for the regression where someone stops calling one.
 *
 * It is a backstop because four review rounds broke four versions of it:
 *
 * - v1 required a redactor inside the `${…}` holding the read → missed an
 *   intermediate variable (one such site was LIVE and unwrapped), an inline
 *   cast, a destructure and a concat.
 * - v2 required it in the enclosing statement → a self-probe walked past with
 *   a raw read plus a redactor call on a *different* expression.
 * - v3 required the read inside the redactor's argument list → evaded by a
 *   destructure, a computed member and `JSON.stringify`.
 * - v4 banned hand reads of the captured streams, on the premise that "reading
 *   the field is what every evasion had to do". **That premise was false.**
 *   Measured on a real `execFile` rejection: the error carries an own `cmd`
 *   property holding the whole command line, so `${err}`, `String(err)`,
 *   `JSON.stringify(err)`, `util.inspect(err)` and `{...err}` all leak the
 *   argv while reading no field at all.
 *
 * So the rules below are anchored on the CATCH BLOCK, not on an expression
 * shape. A catch whose `try` ran docker must compose, and must not render the
 * caught value whole. Blocks that never ran docker are outside the rules by
 * construction rather than by exemption — no list to go stale.
 *
 * `src/utils/docker-cmd.ts` is deliberately unfenced: it DEFINES the
 * redaction, so requiring its composers to redact before touching the value
 * they redact is circular. Their behaviour is pinned by
 * `tests/unit/utils/docker-cmd.test.ts`.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Calls that produce an already-redacted failure text. */
const COMPOSERS = [
  'describeDockerFailure(',
  'describeDockerExecFailure(',
  'describeDockerCapturedOutput(',
];

/** Any call that performs redaction, for the per-file floor. */
const REDACTING_CALLS = [...COMPOSERS, 'redactDockerArgvInText(', 'redactDockerArgvValues('];

/** Spawning a docker child. A `catch` guarding one of these is in scope. */
const DOCKER_EXEC_CALLS = [
  'execFileAsync(',
  'runDockerStreaming(',
  'runDockerForeground(',
  'spawnStreaming(',
];

/**
 * Directories swept for docker-spawning modules.
 *
 * `src/assets` joined in issue
 * [#2623](https://github.com/go-to-k/cdkd/issues/2623). The population was
 * rooted at `src/local` alone, which is not a statement about where docker is
 * spawned — it is where issue #2440 happened to look. `src/assets/docker-build.ts`
 * builds the `docker build` argv for BOTH the deploy-time ECR publish and
 * `cdkd local run-task`, and it was invisible here.
 */
const SWEPT_DIRS = ['src/local', 'src/assets'];

/**
 * The modules under test are DERIVED, not listed: every file under
 * {@link SWEPT_DIRS} that spawns a docker-compatible child.
 *
 * The PREDICATE also widened in #2623. It used to require
 * `promisify(execFile)` AND `getDockerCmd` — both incidental. cdkd's docker
 * calls go through the shared streaming helpers in `src/utils/docker-cmd.ts`
 * (which resolve the binary themselves, so a caller never names
 * `getDockerCmd`), and requiring the promisified `execFile` selected on an
 * implementation detail of four modules rather than on "does this spawn
 * docker". Widening to the shared helpers is what pulled in
 * `src/assets/docker-build.ts`, `src/assets/docker-asset-publisher.ts` and
 * `src/local/ecr-puller.ts` — three modules whose docker catches were
 * hand-composing their failure text, exactly the shape this fence exists for.
 *
 * An early version hand-listed paths while claiming there was no allowlist —
 * a hand-list is how a further module joins silently.
 */
function deriveDockerExecModules(): string[] {
  return SWEPT_DIRS.flatMap((relDir) =>
    readdirSync(join(REPO_ROOT, relDir))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `${relDir}/${f}`)
      .filter((rel) => {
        const src = readFileSync(join(REPO_ROOT, rel), 'utf-8');
        const promisifiedDockerExec =
          /promisify\([\w$.]*execFile/.test(src) && src.includes('getDockerCmd');
        const sharedSpawnHelper = /\b(runDockerStreaming|runDockerForeground|spawnStreaming)\(/.test(
          src
        );
        return promisifiedDockerExec || sharedSpawnHelper;
      })
  ).sort();
}

const FENCED_MODULES = deriveDockerExecModules();

/** Per-file FLOOR on redaction sites, as literals from a source the fence does not read. */
const MIN_REDACTION_SITES: Record<string, number> = {
  'src/assets/docker-asset-publisher.ts': 3,
  'src/assets/docker-build.ts': 4,
  'src/local/docker-runner.ts': 7,
  'src/local/ecr-puller.ts': 2,
  'src/local/ecs-network.ts': 3,
  'src/local/ecs-task-runner.ts': 9,
  'src/local/invoke-agentcore-watch-loop.ts': 3,
};

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

/**
 * Blank comment bodies and quoted-string CONTENTS in one pass, so neither can
 * satisfy nor hide a rule. Written as a state machine rather than a pair of
 * regexes because the two are mutually recursive — a `//` inside a string
 * literal made the previous regex version eat the rest of a real line of code.
 *
 * Template literals keep their `${…}` expressions (the code under test lives
 * there) and lose only their literal text. Offsets are preserved so reported
 * line numbers stay true.
 */
function neutralize(source: string): string {
  const out = source.split('');
  const blank = (i: number): void => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  // Each CODE frame carries its own brace depth, so a `}` closing an object
  // literal inside `${…}` does not pop back to template state early (which
  // blanked real code until the closing backtick).
  const stack: { kind: string; depth: number }[] = [{ kind: 'code', depth: 0 }];
  const top = (): { kind: string; depth: number } => stack[stack.length - 1]!;
  // A `/` starts a REGEX only where a value may begin. Without this, `/it's/`
  // opened a string state that ran to the next quote ANYWHERE in the file and
  // blanked whole functions — a silent fail-open, since a blanked leak is an
  // invisible leak.
  let prevSignificant = '';
  let prevTwo = '';
  let prevWord = '';
  for (let i = 0; i < source.length; i++) {
    const frame = top();
    // Captured BEFORE the frame can change: a character consumed inside a
    // comment or a string must not become `prevSignificant`. The `*` of a
    // closing `*\/` did, so a `/` right after a block comment opened a regex
    // state and blanked to the next slash.
    const inCode = frame.kind === 'code';
    const ch = source[i]!;
    const next = source[i + 1];
    if (frame.kind === 'line') {
      if (ch === '\n') stack.pop();
      else blank(i);
    } else if (frame.kind === 'block') {
      if (ch === '*' && next === '/') {
        blank(i);
        blank(i + 1);
        i++;
        stack.pop();
      } else blank(i);
    } else if (frame.kind === "'" || frame.kind === '"') {
      if (ch === '\\') {
        blank(i);
        blank(i + 1);
        i++;
      } else if (ch === frame.kind) stack.pop();
      else blank(i);
    } else if (frame.kind === 'regex') {
      if (ch === '\\') {
        blank(i);
        blank(i + 1);
        i++;
      } else if (ch === '[') frame.depth = 1;
      else if (ch === ']') frame.depth = 0;
      else if (ch === '/' && frame.depth === 0) stack.pop();
      else blank(i);
    } else if (frame.kind === 'tpl') {
      if (ch === '\\') {
        blank(i);
        blank(i + 1);
        i++;
      } else if (ch === '`') stack.pop();
      else if (ch === '$' && next === '{') {
        stack.push({ kind: 'code', depth: 0 });
        i++;
        // A template hole opens an EXPRESSION position, so a `/` right after
        // it is a regex. The `$` itself is consumed in template state and no
        // longer tracked, so the position is recorded explicitly.
        prevSignificant = '$';
        prevTwo = '${';
        prevWord = '';
      } else blank(i);
    } else {
      // code
      if (ch === '/' && next === '/') stack.push({ kind: 'line', depth: 0 });
      else if (ch === '/' && next === '*') stack.push({ kind: 'block', depth: 0 });
      else if (
        ch === '/' &&
        // `x++ / 2` is division: the `+` would otherwise read as an operator.
        prevTwo !== '++' &&
        prevTwo !== '--' &&
        (REGEX_MAY_START_AFTER_CHAR.test(prevSignificant) ||
          REGEX_MAY_START_AFTER_WORD.test(prevWord))
      ) {
        stack.push({ kind: 'regex', depth: 0 });
      } else if (ch === "'" || ch === '"') stack.push({ kind: ch, depth: 0 });
      else if (ch === '`') stack.push({ kind: 'tpl', depth: 0 });
      else if (ch === '{') frame.depth++;
      else if (ch === '}') {
        if (frame.depth > 0) frame.depth--;
        else if (stack.length > 1) stack.pop();
      }
    }
    if (inCode && !/\s/.test(ch)) {
      prevTwo = (prevSignificant + ch).slice(-2);
      prevSignificant = ch;
    }
    if (inCode) {
      // Whitespace does NOT clear the word: `return /re/` puts a space between
      // the keyword and the slash, and clearing on it made every keyword case
      // invisible (measured — four positive controls went red).
      if (/[\w$]/.test(ch)) prevWord += ch;
      // A keyword reached through a PROPERTY is an identifier: `a.in / 2` is
      // division, not a regex. Seeding with a WORD character is what makes
      // that work — `REGEX_MAY_START_AFTER_WORD` anchors on `\b`, and a
      // whitespace seed still leaves a word boundary before `in`.
      else if (ch === '.') prevWord = PROPERTY_ACCESS_SEED;
      else if (!/\s/.test(ch)) prevWord = '';
    }
  }
  return out.join('');
}

/**
 * Where a `/` begins a REGEX literal rather than a division.
 *
 * Two signals, because one is not enough and the first version's own comment
 * said the opposite of what its code did. A `/` starts a regex after an
 * operator / punctuator, after `$` (i.e. at the head of a template hole), or
 * at the start of input — and also after a KEYWORD (`return /re/`, `typeof
 * /re/`, `case /re/`), which a single-character lookback cannot see because
 * those all end in a letter.
 *
 * The failure directions are NOT symmetric, so this errs deliberately. Missing
 * a regex lexes `/it's/` as division, opens a STRING state on the apostrophe,
 * and blanks the rest of the file — and a blanked leak is an invisible leak,
 * the worst outcome available. Spuriously opening a regex state blanks only up
 * to the next `/`. So the predicate is generous, and the floors on the
 * in-scope catch count are what notice if it ever swallows a block.
 */
const REGEX_MAY_START_AFTER_CHAR = /^$|[(,=:[!&|?{};+\-*%<>~^$]/;
/** Word-character seed that makes a following keyword fail `\b`-anchored matching. */
const PROPERTY_ACCESS_SEED = 'x';
const REGEX_MAY_START_AFTER_WORD =
  /\b(return|typeof|case|in|of|yield|void|await|do|else|instanceof|new|delete|throw)$/;

/** Index just past the `}` matching the `{` at `open`. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i + 1;
  }
  return src.length;
}

interface TryCatch {
  readonly binding: string;
  readonly tryBody: string;
  readonly catchBody: string;
  readonly line: number;
}

/** Every `try { … } catch (x) { … }` in a neutralized source. */
function scanTryCatch(src: string): TryCatch[] {
  const found: TryCatch[] = [];
  const tryRe = /\btry\s*\{/g;
  for (const m of src.matchAll(tryRe)) {
    const tryOpen = src.indexOf('{', m.index);
    const tryEnd = matchBrace(src, tryOpen);
    const after = src.slice(tryEnd, tryEnd + 40);
    const catchMatch = /^\s*catch\s*\(\s*([\w$]+)\s*(?::[^)]*)?\)\s*\{/.exec(after);
    if (!catchMatch) continue;
    const catchOpen = src.indexOf('{', tryEnd + catchMatch[0].length - 1);
    found.push({
      binding: catchMatch[1]!,
      tryBody: src.slice(tryOpen, tryEnd),
      catchBody: src.slice(catchOpen, matchBrace(src, catchOpen)),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return found;
}

const isDockerExec = (block: TryCatch): boolean =>
  DOCKER_EXEC_CALLS.some((c) => block.tryBody.includes(c));
const composes = (body: string): boolean => COMPOSERS.some((c) => body.includes(c));

/**
 * Ways a catch can put the ARGV in front of a user without going through a
 * composer. Every one was measured against a real `execFile` rejection: the
 * error carries an own `cmd` property holding the whole command line, and
 * `message` embeds it too, so all of these leak.
 *
 * This is deliberately NOT gated on whether the block also composes. The
 * ORIGINAL defect was a block that redacted on one channel and not on
 * another — `logger.debug(\`${err.cmd}\`)` beside a composed `throw` is
 * issue #2440 exactly, one field over.
 */
function argvBearingRenderings(rawBody: string, binding: string): string[] {
  const b = binding.replace(/[$]/g, '\\$&');
  // Collapse the INLINE CAST spelling first. `(err as { cmd?: string }).cmd`
  // puts a `)` where every pattern below expects the identifier, and that
  // exact evasion has now recurred in three different rules — so it is
  // normalised once, here, instead of being re-modelled per pattern.
  // `(?:[^()]|\\([^()]*\\))*` allows ONE level of nesting, so a type carrying
  // parens — `(err as Record<string, (a: string) => void>)` — normalises
  // instead of shredding into `err => void>)`, which hid a bracket read.
  const body = rawBody.replace(
    new RegExp(`\\(\\s*${b}\\s+as\\s(?:[^()]|\\([^()]*\\))*\\)`, 'g'),
    binding
  );
  const patterns: [string, RegExp][] = [
    // `(?:\\s+as\\s+[^}]*)?` also catches the paren-free cast chain
    // `${err as unknown as string}`, which the cast normalisation above
    // cannot collapse because there is nothing to unwrap.
    ['bare interpolation', new RegExp(`\\$\\{\\s*${b}(?:\\s+as\\s+[^}]*?)?\\s*\\}`)],
    ['String()', new RegExp(`\\bString\\(\\s*${b}\\s*\\)`)],
    ['JSON.stringify()', new RegExp(`\\bJSON\\.stringify\\(\\s*${b}\\s*[,)]`)],
    ['inspect()', new RegExp(`\\binspect\\(\\s*${b}\\s*[,)]`)],
    ['spread', new RegExp(`\\.\\.\\.\\s*${b}\\b`)],
    // `cmd` IS the command line — reading it is the most direct leak of all.
    // NOT anchored on the binding: `cmd` is the command line, and nothing
    // else in a docker-exec catch has such a property, so any read of it is
    // the leak regardless of how the receiver is spelled.
    ['.cmd', /\.\s*cmd\b/],
    // ANY computed access, because `neutralize` blanks string CONTENTS — so
    // `err['cmd']` arrives here as `err['   ']` and no key-specific pattern
    // can see it. Nothing in these modules indexes a caught error, so
    // refusing the whole construct costs nothing and fails closed.
    ['bracket read', new RegExp(`\\b${b}\\s*\\[`)],
    // `const { cmd } = err` reaches the command line without a `.cmd` in
    // sight. Keyed on the FIELD, like the `.cmd` rule, so the right-hand side
    // may be spelled any way at all.
    ['cmd destructure', new RegExp(`\\{[^}]*\\bcmd\\b[^}]*\\}\\s*=[^;\\n]*\\b${b}\\b`)],
    ['Object copy', new RegExp(`\\bObject\\.(assign|values|entries)\\([^)]*\\b${b}\\b`)],
    ['structuredClone()', new RegExp(`\\bstructuredClone\\(\\s*${b}\\s*[,)]`)],
  ];
  const found = patterns.filter(([, re]) => re.test(body)).map(([name]) => name);
  // An UNGUARDED rethrow hands the raw error to a caller that will render it.
  // A rethrow guarded by `instanceof` is re-raising a cdkd error the block
  // deliberately did not handle (e.g. `EcsTaskRunnerError`), not the docker
  // rejection, so it is left alone.
  for (const line of body.split('\n')) {
    if (new RegExp(`^\\s*throw\\s+${b}\\s*;`).test(line) && !line.includes('instanceof')) {
      found.push('bare rethrow');
    }
  }
  return found;
}

/**
 * FLOOR on in-scope catch blocks per module, as literals. Every rule below
 * asserts an EMPTY offender list, so a `scanTryCatch` regression that shrinks
 * the population leaves them all green over a shrunken set — and this file's
 * whole history is "the scan quietly stopped matching".
 */
const MIN_DOCKER_EXEC_CATCHES: Record<string, number> = {
  'src/assets/docker-asset-publisher.ts': 3,
  'src/assets/docker-build.ts': 2,
  'src/local/docker-runner.ts': 5,
  'src/local/ecr-puller.ts': 2,
  'src/local/ecs-network.ts': 3,
  'src/local/ecs-task-runner.ts': 6,
  'src/local/invoke-agentcore-watch-loop.ts': 3,
};

describe('docker argv redaction fence (issue #2440)', () => {
  it('no module spawns docker from OUTSIDE the swept directories', () => {
    // The class issue #2623 was filed about, one level up: the population is
    // derived WITHIN `SWEPT_DIRS`, so a docker-spawning module in a third
    // directory is invisible exactly the way `src/assets/**` was. This walks
    // ALL of `src/` and requires every caller of a shared spawn helper to live
    // somewhere the derivation can reach.
    //
    // `src/utils/docker-cmd.ts` is the one exemption and it is structural, not
    // a list entry: it DEFINES those helpers, so it names them by declaring
    // them.
    const offenders: string[] = [];
    const walk = (relDir: string): void => {
      for (const entry of readdirSync(join(REPO_ROOT, relDir), { withFileTypes: true })) {
        const rel = `${relDir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (rel === 'src/utils/docker-cmd.ts') continue;
        if (SWEPT_DIRS.some((dir) => rel.startsWith(`${dir}/`))) continue;
        // Comments and string contents are blanked first, so a module merely
        // MENTIONING a helper in prose is not an offender.
        const src = neutralize(readFileSync(join(REPO_ROOT, rel), 'utf-8'));
        if (/\b(runDockerStreaming|runDockerForeground|spawnStreaming)\(/.test(src)) {
          offenders.push(rel);
        }
      }
    };
    walk('src');
    expect(
      offenders,
      'This module spawns docker but sits outside SWEPT_DIRS, so the fence below cannot see it. Add its directory to SWEPT_DIRS (and the module to both floor tables).'
    ).toEqual([]);
  });

  it('derives its module set from the code, and the set is neither empty nor drifted', () => {
    // A derivation that silently stopped matching makes every case below
    // vacuous. The expected set is a LITERAL, read off the repo by hand.
    expect(FENCED_MODULES).toEqual([
      'src/assets/docker-asset-publisher.ts',
      'src/assets/docker-build.ts',
      'src/local/docker-runner.ts',
      'src/local/ecr-puller.ts',
      'src/local/ecs-network.ts',
      'src/local/ecs-task-runner.ts',
      'src/local/invoke-agentcore-watch-loop.ts',
    ]);
    // Both directories are actually represented. Asserting only the sorted
    // list would stay green if `SWEPT_DIRS` lost `src/assets` and the literal
    // were "fixed" to match — the regression #2623 was filed about.
    for (const dir of SWEPT_DIRS) {
      expect(FENCED_MODULES.some((m) => m.startsWith(`${dir}/`))).toBe(true);
    }
    expect(FENCED_MODULES).toEqual(Object.keys(MIN_REDACTION_SITES).sort());
    expect(FENCED_MODULES).toEqual(Object.keys(MIN_DOCKER_EXEC_CATCHES).sort());
  });

  it.each(FENCED_MODULES)('%s: every docker-exec catch composes its failure text', (relPath) => {
    const blocks = scanTryCatch(neutralize(read(relPath))).filter(isDockerExec);
    expect(blocks.length).toBeGreaterThanOrEqual(MIN_DOCKER_EXEC_CATCHES[relPath]!);
    const offenders = blocks
      .filter((b) => !composes(b.catchBody))
      .map((b) => `${relPath}: try at line ${b.line} runs docker, catch (${b.binding}) composes nothing`);
    expect(
      offenders,
      'Build the text with describeDockerFailure(error, args) from src/utils/docker-cmd.ts.'
    ).toEqual([]);
  });

  it.each(FENCED_MODULES)('%s: no docker-exec catch puts the argv in front of a user by hand', (relPath) => {
    // `err.cmd` is an OWN property holding the full command line (measured on
    // a real execFile rejection), so a whole-value rendering leaks the argv
    // while touching no field — the hole that sank the previous version.
    const blocks = scanTryCatch(neutralize(read(relPath))).filter(isDockerExec);
    expect(blocks.length).toBeGreaterThanOrEqual(MIN_DOCKER_EXEC_CATCHES[relPath]!);
    const offenders = blocks.flatMap((b) =>
      argvBearingRenderings(b.catchBody, b.binding).map(
        (how) => `${relPath}: catch (${b.binding}) at line ${b.line} leaks the argv via ${how}`
      )
    );
    expect(offenders).toEqual([]);
  });

  it.each(FENCED_MODULES)('%s: keeps at least its floor of redaction sites', (relPath) => {
    const source = neutralize(read(relPath));
    const calls = REDACTING_CALLS.reduce((n, call) => n + source.split(call).length - 1, 0);
    expect(calls).toBeGreaterThanOrEqual(MIN_REDACTION_SITES[relPath]!);
  });

  it('ARGV_VALUE_BEARING_FLAGS holds exactly one SHORT flag (issue #2623 round 4)', () => {
    // `maskAttachedShortFlag` picks the LEFTMOST flag letter across all short
    // flags, which is pflag's own rule for a shorthand cluster. With ONE short
    // flag that choice is unobservable: first-hit-wins and leftmost-wins agree
    // on every input, so no behavioural test can kill a mutation between them
    // (measured -- the probe came back green, and the reviewer who found the
    // latency said the same).
    //
    // This is the pointer that arrives with the second short flag rather than
    // after it: adding one makes the rule observable AND makes this red, at
    // which point the missing case is `['-lKEY=va=e=b']`, where first-hit-wins
    // slices at the stray `e` and prints the head of the value.
    const src = read('src/utils/docker-cmd.ts');
    const decl = /const ARGV_VALUE_BEARING_FLAGS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/.exec(
      src
    );
    expect(decl, 'ARGV_VALUE_BEARING_FLAGS is not declared in the shape this reads').not.toBeNull();
    const flags = [...decl![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    // The parse itself must not silently stop matching -- a zero-length list
    // would satisfy the count assertion below by collapsing, not by holding.
    expect(flags).toContain('--build-arg');
    expect(flags.filter((f) => f.length === 2 && f.startsWith('-'))).toEqual(['-e']);
  });

  it('every composer keeps its argv REQUIRED — that is the guarantee, not this file', () => {
    const src = read('src/utils/docker-cmd.ts');
    for (const fn of COMPOSERS.map((c) => c.slice(0, -1))) {
      const decl = new RegExp(`export function ${fn}\\(([\\s\\S]{0,200}?)\\)\\s*:\\s*string`);
      const match = decl.exec(src);
      expect(match, `${fn} is not exported from docker-cmd.ts`).not.toBeNull();
      expect(match![1]).toContain('args: readonly string[]');
      expect(match![1]).not.toContain('args?:');
    }
  });

  // ==================================================================
  // POSITIVE CONTROLS — every rule above asserts an EMPTY list, so a
  // predicate that quietly stopped matching would make all of them pass.
  // Four versions of this file were wrong; three of those would have gone
  // green here. Each control feeds the real predicates a synthetic module.
  // ==================================================================
  describe('positive controls', () => {
    const leaks = (body: string) =>
      `async function f() {\n  try {\n    await execFileAsync(getDockerCmd(), args);\n  } catch (err) {\n    ${body}\n  }\n}\n`;

    it.each([
      ['bare interpolation', 'throw new Error(`boom: ${err}`);', 'bare interpolation'],
      ['String()', 'throw new Error("boom: " + String(err));', 'String()'],
      ['JSON.stringify()', 'throw new Error(JSON.stringify(err));', 'JSON.stringify()'],
      ['spread', 'const c = { ...err }; throw new Error(c.message);', 'spread'],
    ])('detects a whole-error rendering: %s', (_name, body, how) => {
      const [block] = scanTryCatch(neutralize(leaks(body))).filter(isDockerExec);
      expect(block).toBeDefined();
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toContain(how);
    });

    it.each([
      ['.cmd read', 'log(`${err.cmd}`);', '.cmd'],
      ['.cmd bracket read', "log(err['cmd']);", 'bracket read'],
      ['Object.assign copy', 'const c = Object.assign({}, err); log(c.cmd);', 'Object copy'],
      ['structuredClone', 'log(structuredClone(err).message);', 'structuredClone()'],
      ['bare rethrow', 'throw err;', 'bare rethrow'],
      ['.cmd behind an inline cast', 'log(`${(err as { cmd?: string }).cmd}`);', '.cmd'],
      ['bracket read behind a cast', "log((err as Record<string, string>)['cmd']);", 'bracket read'],
      ['whole render behind a cast', 'log(`${err as unknown as string}`);', 'bare interpolation'],
    ])('detects an argv-bearing read that is NOT a whole rendering: %s', (_n, body, how) => {
      const [block] = scanTryCatch(neutralize(leaks(body))).filter(isDockerExec);
      expect(block).toBeDefined();
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toContain(how);
    });

    it('flags a leak even when the SAME catch also composes — the #2440 shape itself', () => {
      // One channel redacted, a sibling channel one line over did not. Gating
      // this rule on "does the block compose" would have let the original
      // defect through wearing its own fix.
      const body =
        'log(`${err.cmd}`);\n    throw new Error(`boom: ${describeDockerFailure(err, args)}`);';
      const [block] = scanTryCatch(neutralize(leaks(body))).filter(isDockerExec);
      expect(composes(block!.catchBody)).toBe(true);
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toContain('.cmd');
    });

    it('leaves a rethrow GUARDED by instanceof alone — it re-raises a cdkd error', () => {
      const body = 'if (err instanceof Error) throw err;\n    log(describeDockerFailure(err, args));';
      const [block] = scanTryCatch(neutralize(leaks(body))).filter(isDockerExec);
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toEqual([]);
    });

    it('reads a catch binding that carries a type annotation', () => {
      const src =
        'try {\n  await execFileAsync(getDockerCmd(), a);\n} catch (err: unknown) {\n  log(`${err}`);\n}\n';
      const [block] = scanTryCatch(neutralize(src)).filter(isDockerExec);
      expect(block).toBeDefined();
      expect(block!.binding).toBe('err');
    });

    it.each([
      ["regex with an apostrophe", "const re = /it's/;"],
      ['regex with a slash', 'const re = /https:\\/\\//;'],
      ['regex with a quote class', 'const re = /["\']/;'],
    ])('neutralize() survives a regex literal: %s', (_n, prelude) => {
      // Lexing a regex as code opened a string / comment state that ran on and
      // blanked whole functions — and a blanked leak is an INVISIBLE leak.
      const src = `${prelude}\n` + leaks('throw new Error(`boom: ${err}`);');
      const [block] = scanTryCatch(neutralize(src)).filter(isDockerExec);
      expect(block).toBeDefined();
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toContain(
        'bare interpolation'
      );
    });

    it.each([
      ['after return', "return /it's/.test(x);"],
      ['after typeof', "if (typeof /it's/ === 'object') x();"],
      ['after case', "switch (v) { case /it's/.source: break; }"],
      ['at a template hole head', "const t = `${/it's/.test('a')}`;"],
      ['after a division', 'const n = i++ / 2;'],
      ['after a property named like a keyword', 'const n = a.in / 2;'],
      ['after a block comment', '/* note */ const n = z / 2;'],
    ])('neutralize() lexes a regex correctly: %s', (_n, prelude) => {
      // Mis-lexing `/it's/` as division opens a STRING state on the
      // apostrophe that runs to the next quote ANYWHERE in the file, blanking
      // whole functions — and a blanked leak is an invisible leak.
      const src = `${prelude}\n` + leaks('throw new Error(`boom: ${err}`);');
      const [block] = scanTryCatch(neutralize(src)).filter(isDockerExec);
      expect(block, 'the try/catch was blanked away').toBeDefined();
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toContain(
        'bare interpolation'
      );
    });

    it.each([
      ['cast whose type carries parens', 'log((err as Record<string, (a: string) => void>)["cmd"]);', 'bracket read'],
      ['destructured cmd', 'const { cmd } = err as { cmd: string }; log(cmd);', 'cmd destructure'],
    ])('detects a leak behind %s', (_n, body, how) => {
      const [block] = scanTryCatch(neutralize(leaks(body))).filter(isDockerExec);
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toContain(how);
    });

    it('does NOT flag a cmd destructure of something unrelated to the caught value', () => {
      // Keyed to the binding, so an unrelated `{ cmd }` in the same block is
      // not a false red — the fence must also leave alone what it must.
      const body = 'const { cmd } = buildPlan; log(`${describeDockerFailure(err, args)} ${cmd}`);';
      const [block] = scanTryCatch(neutralize(leaks(body))).filter(isDockerExec);
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toEqual([]);
    });

    it('neutralize() keeps code after an object literal inside a template hole', () => {
      // A `}` closing the object used to pop back to template state, blanking
      // everything to the next `${` — including a leak.
      const body = 'log(`${JSON.stringify({ a: 1 })} then ${err.cmd}`);';
      const [block] = scanTryCatch(neutralize(leaks(body))).filter(isDockerExec);
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toContain('.cmd');
    });

    it('detects a docker-exec catch that composes nothing', () => {
      const [block] = scanTryCatch(neutralize(leaks('throw new Error("boom");'))).filter(
        isDockerExec
      );
      expect(block).toBeDefined();
      expect(composes(block!.catchBody)).toBe(false);
    });

    it('accepts the composed form — the fence is not simply always-red', () => {
      const ok = leaks('throw new Error(`boom: ${describeDockerFailure(err, args)}`);');
      const [block] = scanTryCatch(neutralize(ok)).filter(isDockerExec);
      expect(composes(block!.catchBody)).toBe(true);
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toEqual([]);
    });

    it('leaves a catch whose try never ran docker alone', () => {
      const src = 'try {\n  stop();\n} catch (err) {\n  log(`${err}`);\n}\n';
      expect(scanTryCatch(neutralize(src)).filter(isDockerExec)).toEqual([]);
    });

    it('neutralize() blanks a comment and a string body, and keeps template expressions', () => {
      // The `//`-inside-a-string case that the previous regex version ate.
      const src = 'const a = "http://x"; foo(bar); // baz(qux)\nconst b = `v=${zap(1)}`;';
      const n = neutralize(src);
      expect(n).toContain('foo(bar)');
      expect(n).toContain('zap(1)');
      expect(n).not.toContain('baz(qux)');
      expect(n).not.toContain('http');
      expect(n.length).toBe(src.length);
    });

    it('scanTryCatch survives a multi-line destructure and nested braces', () => {
      const src =
        'try {\n  const {\n    stdout,\n  } = await execFileAsync(getDockerCmd(), a);\n} catch (e) {\n  if (x) { y(); }\n  throw new Error(`${e}`);\n}\n';
      const [block] = scanTryCatch(neutralize(src)).filter(isDockerExec);
      expect(block).toBeDefined();
      expect(block!.binding).toBe('e');
      expect(argvBearingRenderings(block!.catchBody, block!.binding)).toContain('bare interpolation');
    });
  });
});
