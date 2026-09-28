import { afterAll, describe, it, expect, vi } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Fences the one settings key that decides whether this repo's file-tool hooks
 * exist at all.
 *
 * Claude Code ships a bash-first experiment behind `CLAUDE_CODE_THRIFTY_SONIC`.
 * When it is on, the session is told to read and WRITE files through
 * `cat` / `sed -i` / heredocs instead of the Read / Edit / Write tools. Three
 * surfaces of this harness are keyed to those tools and go inert without a
 * single error line:
 *
 *   1. `worktree-owner-gate.sh` -- matcher `Edit|Write|NotebookEdit`, so a Bash
 *      heredoc write claims no worktree and is refused by nothing. That is the
 *      multi-session uncommitted-work guard (the 2026-08-09 incident) gone.
 *   2. the PostToolUse `Write|Edit` -> `vp run lint:fix` entry.
 *   3. every `paths:`-scoped file under `.claude/rules/` -- a rule loads when a
 *      matching file enters context THROUGH the file tools, so a `cat`-read
 *      subsystem gets none of its notes.
 *
 * Measured on Claude Code 2.1.263, an explicitly set value short-circuits the
 * server-side cohort assignment, so the pin has to live in the REPO's settings:
 * a maintainer's `~/.claude/settings.json` fixes one machine and leaves every
 * contributor and every parallel agent in whatever cohort the server picked.
 * Dropping the key is therefore not a formatting change -- it silently returns
 * the repo to the state where three guards are decorative.
 *
 * **This file asserts a JSON string, never vendor behavior**, and the flag is
 * vendor-internal: a rename, a default flip, or removal of the short-circuit
 * makes the pin a no-op while every case here stays green. The VERSION case
 * is the alarm for that (go-to-k/cdkd#2737) -- it is a REMINDER to re-run the
 * `claude -p` probe (THE PROBE, below), not a detector, and
 * the distinction is the whole design: only running the probe can observe the
 * vendor's behavior, so what a test can do is refuse to let the measurement go
 * quietly out of date. This file also cannot see `.claude/settings.local.json`,
 * which OUTRANKS the file it reads: the pin is this repo's DEFAULT, not an
 * unescapable one.
 *
 * The second case fences the REASON rather than the pin, and it resolves both
 * entries BY WHAT THEY RUN. Every review round so far found the weaker lookup
 * of the moment satisfiable with the protection gone -- matcher text was
 * cleared by swapping the gate's command for `/bin/true`, by emptying its
 * `hooks` array, and by a decoy entry inserted ahead of the real one; a command
 * SUBSTRING by demoting the path to a trailing `#` comment and by `echo`ing the
 * formatter's task; a hand-split alternatives list by a matcher that compiles
 * to nothing. No count is quoted here, because each round moved it and the
 * changelog entry is where the tally belongs. So: the gate's command must be
 * exactly the project-dir prefix plus a script path, that script must exist on
 * disk, the formatter's task must appear in COMMAND POSITION, and both matchers
 * are read through the binary's own selection rule.
 *
 * THE PROBE, kept here because this file is the only thing that asks for it.
 * Flip the value in `.claude/settings.json` to `"1"` and run `claude -p` with a
 * prompt asking whether `Do your work through the Bash tool` is in context: the
 * `"1"` arm must answer PRESENT, and `"0"` must answer ABSENT (so does an unset
 * baseline, which is why only the `"1"` arm discriminates). Restore `"0"`
 * afterwards.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SETTINGS = join(repoRoot, '.claude', 'settings.json');

/** The prefix every hook command in this repo uses to reach the repo root. */
const PROJECT_DIR_PREFIX = '${CLAUDE_PROJECT_DIR:-.}';
const OWNER_GATE_SCRIPT = '.claude/hooks/worktree-owner-gate.sh';
const LOCAL_SETTINGS = '.claude/settings.local.json';

/**
 * The only value measured against a discriminating twin: at `"0"` a `claude -p`
 * probe reports the bash-first reminder ABSENT while `"1"` reports it PRESENT.
 * Other spellings the vendor's tri-state parser may accept are deliberately NOT
 * accepted here -- a second spelling buys nothing and would be an unverified
 * widening of what this fence certifies.
 */
const PINNED_OFF = '0';

/**
 * The Claude Code build the pin's behavior was MEASURED against, and when. Both
 * move together, and only after re-running BOTH probe arms from
 * THE PROBE in this file's header -- bumping the version to clear a red without
 * re-probing is the one way to make this case worse than useless.
 */
const PROBED_CLAUDE_VERSION = '2.1.263';
const PROBED_ON = '2026-09-07';

/**
 * Compared at MAJOR.MINOR, deliberately not at the patch. Claude Code patches
 * land often enough that an exact pin would red an unrelated commit most weeks,
 * and a red that arrives that often gets discharged by editing the constant
 * rather than by re-probing -- the gate optimizing its own way around itself.
 * A minor bump is where an experiment's default flips or a flag is retired.
 * The BOUND is real and stated rather than argued away: a behavior change
 * shipped inside a patch release passes here silently.
 */
function minorOf(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

/**
 * The installed Claude Code version, `undefined` when the binary is ABSENT, and
 * a THROW when one answered but could not be read.
 *
 * The three are different facts and collapsing them was the round-4 finding: a
 * non-zero exit, a timeout, and a wrapper printing an unrecognized version line
 * all read as "no Claude Code here" and early-returned the case to green --
 * disarming it on exactly the vendor change (a reworked `--version` line) it
 * exists to notice. `CDKD_CLAUDE_BIN` is a test seam so both arms can be
 * probed. WHICH binary answers is `resolveClaudeBin`'s job; `env` is a seam for
 * the resolution cases below.
 */
function installedClaudeVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const resolved = resolveClaudeBin(env);
  return resolved === undefined ? undefined : readClaudeVersion(resolved);
}

/**
 * The `claude` this case must read, chosen HERE rather than by the exec search
 * (go-to-k/cdkd#3830). Claude Code's auto-updater replaces its npm package
 * directory wholesale, and for that window the first `claude` on PATH is a
 * DANGLING symlink. Spawning the bare name then does not stop there: the exec
 * search falls through to the next `claude` on PATH, so the case compared a
 * stale second install's version -- or, with no second install, got `ENOENT`
 * and read "absent", returning green without comparing anything.
 *
 * So this does NOT re-implement the exec search, whose corners (unsearchable
 * directories, `..` folding, symlink loops, overlong segments, shebang
 * interpreters) a copy would each have to get right. It FAILS CLOSED instead:
 * the first PATH entry NAMED `claude` is THE Claude Code, dangling or not,
 * and it is spawned by absolute path, where every spawn error throws. So
 * wherever this differs from the exec search -- a directory, a non-executable
 * file or an unsearchable directory named first, a broken interpreter -- the
 * outcome is a loud failure naming the entry, never a later install's version
 * and never a silent ABSENT. That is the whole contract: read the first
 * `claude`, or say why it could not be read.
 *
 * "Named" means `lstat` finds anything other than ENOENT / ENOTDIR -- those
 * two mean nothing is there, and the walk goes on. An empty segment is the
 * current directory and a relative one is taken from it; the candidate is
 * made absolute by prefixing the cwd, never by `path.resolve`, whose lexical
 * `..` folding could name a directory the filesystem would not reach. An
 * unset PATH throws: the exec search would fall back to a built-in default
 * path, and guessing it is exactly the fall-through this avoids. `undefined`
 * means no entry is named `claude` -- the only ABSENT.
 * `CDKD_CLAUDE_BIN` is the explicit override and keeps its old meaning: the
 * exec search resolves it, and `ENOENT` on it reads as absent, which is how the
 * absent arm is probed.
 */
function resolveClaudeBin(env: NodeJS.ProcessEnv): ResolvedClaude | undefined {
  const override = env['CDKD_CLAUDE_BIN'];
  if (override !== undefined) return { bin: override, override: true };
  const path = env['PATH'];
  if (path === undefined) {
    throw new Error('PATH is unset, so the first `claude` on it cannot be named.');
  }
  for (const segment of path.split(delimiter)) {
    const dir = segment === '' ? '.' : segment;
    const candidate = `${isAbsolute(dir) ? dir : `${process.cwd()}/${dir}`}/claude`;
    try {
      lstatSync(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
    }
    return { bin: candidate, override: false };
  }
  return undefined;
}

interface ResolvedClaude {
  bin: string;
  /** `CDKD_CLAUDE_BIN` named it, so an `ENOENT` still reads as ABSENT. */
  override: boolean;
}

/**
 * `--version` of an already-resolved binary. For a PATH-resolved one EVERY
 * spawn error throws, `ENOENT` included: the entry was named on PATH, so a
 * missing target is an install in flux (or a dangling symlink), never an
 * absent Claude Code -- and that also covers the target vanishing between
 * `resolveClaudeBin` and this spawn.
 */
function readClaudeVersion({ bin, override }: ResolvedClaude): string | undefined {
  const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && override) return undefined;
    throw new Error(
      `\`${bin} --version\` could not be run: ${code ?? res.error.message}` +
        (code === 'ENOENT'
          ? '. It is the first `claude` on PATH, so an install is in progress or broken ' +
            '-- re-run once it settles; a later PATH entry is deliberately not tried.'
          : '')
    );
  }
  if (res.status !== 0) {
    throw new Error(`\`${bin} --version\` exited ${res.status}: ${(res.stderr ?? '').trim()}`);
  }
  const out = (res.stdout ?? '').trim();
  const version = /^(\d+\.\d+\.\d+)/.exec(out)?.[1];
  if (version === undefined) {
    throw new Error(
      `no version could be read from \`${bin} --version\` (${JSON.stringify(out)}). ` +
        'If Claude Code reworked that line, re-run both probe arms (THE PROBE, ' +
        "in this test file's header) before touching this test.",
    );
  }
  return version;
}

interface HookSpec {
  type?: string;
  command?: string;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookSpec[];
}
interface Settings {
  env?: Record<string, string>;
  hooks?: Record<string, HookEntry[]>;
}

const settings = JSON.parse(readFileSync(SETTINGS, 'utf8')) as Settings;

/**
 * `vp run lint:fix` in COMMAND POSITION, not anywhere in the text. A plain
 * substring is cleared by `echo vp run lint:fix`, `true # vp run lint:fix`, and
 * -- measured -- `vp run lint:fix-nope`, which a trailing `\b` still admits
 * because `x`/`-` IS a word boundary. That is the round-2 `echo lint:fix` class
 * re-entering through a longer needle, which is why lengthening one is never
 * the fix. There is no script to resolve here (the entry is an inline
 * pipeline), so command position is the strongest anchor available.
 *
 * Its BOUNDS, measured rather than assumed: QUOTING is invisible to it, so an
 * inert `echo "; vp run lint:fix"` still matches; and a wrapper PREFIX
 * (`timeout 60 vp run lint:fix`, `CI=1 vp run lint:fix`) is a legitimate
 * spelling it would false-RED. The first is a hole and the second is noise, and
 * both are loud rather than silent -- a shell-aware parse is the real answer if
 * either bites. No `m` flag: the command is one line, and anchoring `^` per LINE
 * would only widen the accept set (a heredoc body's first token would match).
 */
const LINT_FIX_IN_COMMAND_POSITION = /(?:^|[;&|(]\s*)vp run lint:fix(?![\w:.-])/;

/**
 * Whether a matcher SELECTS `tool`, transcribed from the 2.1.263 binary's own
 * decision (`Mmr` / `Tms`), measured rather than guessed:
 *
 *   - an empty matcher or `*` selects EVERY tool;
 *   - a matcher matching `/^[a-zA-Z0-9_|, -]+$/` is an exact NAME LIST, split
 *     on `/[|,]/` and trimmed (space is padding, never a separator);
 *   - anything else is compiled as a RegExp against the tool name, and an
 *     UNCOMPILABLE one selects nothing at all.
 *
 * Both halves of the assertion pair go through this. Reading the presence half
 * off a hand-split alternatives list was the round-4 finding: `alternatives()`
 * split `Edit|Write|NotebookEdit|[` on `|` and reported the three tools
 * present, so a matcher that compiles to NOTHING -- the guard wholly inert --
 * left the case green. Hand-splitting also ignored the `,` separator the class
 * admits, so `...|MultiEdit,Bash` read as not selecting Bash.
 */
function selectsTool(matcher: string | undefined, tool: string): boolean {
  const m = matcher ?? '';
  if (m === '' || m === '*') return true;
  if (/^[a-zA-Z0-9_|, -]+$/.test(m)) {
    return m
      .split(/[|,]/)
      .map((a) => a.trim())
      .filter(Boolean)
      .includes(tool);
  }
  try {
    return new RegExp(m).test(tool);
  } catch {
    return false;
  }
}

/**
 * The repo-relative script a command runs, or `undefined` when the command is
 * anything else. The whole command must be the prefix plus one `.sh` path --
 * a trailing comment, a `&&` tail, or a wrapper all fall through, since each
 * would let an inert command answer for the gate it names.
 */
function registeredScript(hook: HookSpec | undefined): string | undefined {
  // A hook whose `type` is anything but `command` is not a command hook at all,
  // so a dropped or misspelled `type` must not answer for the gate either.
  if (hook?.type !== 'command') return undefined;
  const command = hook.command;
  if (!command?.startsWith(PROJECT_DIR_PREFIX)) return undefined;
  const rest = command.slice(PROJECT_DIR_PREFIX.length);
  return /^\/[\w./-]+\.sh$/.test(rest) ? rest.slice(1) : undefined;
}

/** Every entry of `event` whose command runs exactly `script`. */
function entriesRunningScript(event: string, script: string): HookEntry[] {
  return (settings.hooks?.[event] ?? []).filter((e) =>
    (e.hooks ?? []).some((h) => registeredScript(h) === script),
  );
}

describe('.claude/settings.json bash-first opt-out', () => {
  it('pins CLAUDE_CODE_THRIFTY_SONIC off', () => {
    const value = settings.env?.CLAUDE_CODE_THRIFTY_SONIC;
    expect(
      value,
      'env.CLAUDE_CODE_THRIFTY_SONIC is missing from .claude/settings.json; ' +
        'without it a contributor in the bash-first cohort silently loses ' +
        'worktree-owner-gate, the lint:fix PostToolUse entry, and every ' +
        'paths:-scoped rule file',
    ).toBeDefined();
    // Compared against the STRING, never `String(value)`: Claude Code's `env`
    // map expects strings, and a JSON number `0` must red rather than coerce.
    expect(value).toBe(PINNED_OFF);
  });

  it('still has the file-tool-only surfaces the pin protects', () => {
    const ownerGate = entriesRunningScript('PreToolUse', OWNER_GATE_SCRIPT);
    expect(ownerGate.length, `expected exactly one entry running ${OWNER_GATE_SCRIPT}`).toBe(1);
    // The script must also EXIST: a registration is not an installed hook, and
    // deleting the file while leaving the entry in place is the one shape the
    // count above cannot see. (Repointing the command is caught by that count,
    // not here -- the filter admits only the exact path, so this join can never
    // disagree with it.)
    expect(existsSync(join(repoRoot, OWNER_GATE_SCRIPT))).toBe(true);
    // ...and be EXECUTABLE. A dropped exec bit makes the command exit 126,
    // which PreToolUse treats as non-blocking, so the guard goes inert with
    // every case here green -- existence alone does not prove it can run.
    expect(() =>
      accessSync(join(repoRoot, OWNER_GATE_SCRIPT), constants.X_OK),
    ).not.toThrow();
    // ...and the INDEX must carry the bit too. `accessSync` reads the LOCAL
    // mode, so a file committed 100644 and `chmod +x`'d on this machine stays
    // green here while every other checkout exits 126.
    const staged = spawnSync('git', ['-C', repoRoot, 'ls-files', '--stage', '--', OWNER_GATE_SCRIPT], {
      encoding: 'utf8',
    });
    expect(staged.status).toBe(0);
    expect(
      (staged.stdout ?? '').split(/\s/)[0],
      `${OWNER_GATE_SCRIPT} is not mode 100755 in the index; a fresh clone would ` +
        'get a non-executable hook, which exits 126 and does not block',
    ).toBe('100755');

    // The invariant is that the guard still selects the three file tools and
    // still does NOT select Bash -- both read through the binary's own rule, so
    // a matcher that compiles to nothing cannot satisfy the presence half. A
    // strictly STRONGER matcher stays green: adding `MultiEdit` widens the
    // guard, and `Edit|Write|NotebookEdit` reordered is the same list.
    const ownerMatcher = ownerGate[0]?.matcher;
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(selectsTool(ownerMatcher, tool), `guard no longer selects ${tool}`).toBe(true);
    }
    expect(selectsTool(ownerMatcher, 'Bash')).toBe(false);

    // No script to resolve here -- it is an inline pipeline -- so the anchor is
    // the task it must actually run. `echo lint:fix` clears a substring test.
    const lintFix = (settings.hooks?.PostToolUse ?? []).filter((e) =>
      (e.hooks ?? []).some((h) => LINT_FIX_IN_COMMAND_POSITION.test(h.command ?? '')),
    );
    expect(lintFix.length, 'expected exactly one entry running `vp run lint:fix`').toBe(1);
    const lintMatcher = lintFix[0]?.matcher;
    for (const tool of ['Edit', 'Write']) {
      expect(selectsTool(lintMatcher, tool), `formatter no longer selects ${tool}`).toBe(true);
    }
    expect(selectsTool(lintMatcher, 'Bash')).toBe(false);

    // The THIRD surface -- every `paths:`-scoped rule file -- is deliberately
    // NOT asserted here. The rules corpus already requires a
    // non-empty `paths:` per FILE with an empty allow-list, which reds on the
    // first stripped one; a count floor here tolerated nine (measured) while
    // reading as coverage.
  });

  it('keeps the local override out of the repo', () => {
    // `.claude/settings.local.json` OUTRANKS the pinned file, so a COMMITTED one
    // carrying `"1"` beats the pin for everyone while every case above stays
    // green. The `.gitignore` line added with the pin is what stops that, and
    // nothing else watches it.
    // `-v` rather than `-q`, and the SOURCE is asserted: measured, deleting the
    // line from this repo's `.gitignore` still exits 0 here, because a
    // developer's `~/.config/git/ignore` covers the same path. A fence whose
    // verdict depends on what sits outside the checkout says nothing about
    // what a contributor cloning it gets.
    const ignored = spawnSync('git', ['-C', repoRoot, 'check-ignore', '-v', LOCAL_SETTINGS], {
      encoding: 'utf8',
    });
    expect(
      ignored.status,
      `${LOCAL_SETTINGS} is not ignored by git; a committed one would outrank ` +
        '.claude/settings.json and silently beat the bash-first pin',
    ).toBe(0);
    expect(
      (ignored.stdout ?? '').trim(),
      `${LOCAL_SETTINGS} is ignored, but not by this repo's own .gitignore -- a ` +
        "global or per-user ignore file covers it on THIS machine and nobody else's",
    ).toMatch(/^\.gitignore:/);

    const tracked = spawnSync('git', ['-C', repoRoot, 'ls-files', '--', LOCAL_SETTINGS], {
      encoding: 'utf8',
    });
    expect(tracked.status).toBe(0);
    expect(
      (tracked.stdout ?? '').trim(),
      `${LOCAL_SETTINGS} is TRACKED; being gitignored does not untrack a file ` +
        'that was already added',
    ).toBe('');
  });

  it(
    'still runs on the Claude Code line the pin was measured against',
    () => {
      // The recorded measurement must be well-formed whether or not a binary
      // answers -- otherwise the absent-binary arm below would pass on a
      // receipt nobody could read.
      expect(PROBED_CLAUDE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
      expect(PROBED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const installed = installedClaudeVersion();
      if (installed === undefined) {
        // ABSENT, not merely unreadable -- anything else throws above. There is
        // no Claude Code here to disagree with, so the receipt is the whole of
        // what this environment can assert.
        return;
      }

      expect(
        minorOf(installed),
        `the bash-first pin was measured against Claude Code ${PROBED_CLAUDE_VERSION} ` +
          `on ${PROBED_ON}; ${installed} is a different line. Re-run BOTH probe arms ` +
          "(THE PROBE, in this test file's header: value flipped to \"1\" must answer PRESENT, \"0\" " +
          'must answer ABSENT), then update PROBED_CLAUDE_VERSION and PROBED_ON ' +
          'together. Do not bump them without re-probing.',
      ).toBe(minorOf(PROBED_CLAUDE_VERSION));
    },
    60_000,
  );
});

describe('which `claude` the version case reads (go-to-k/cdkd#3830)', () => {
  // Real files and symlinks in a scratch dir, and a PATH passed as `env` --
  // the process's own PATH and CDKD_CLAUDE_BIN are never consulted here.
  const scratch = mkdtempSync(join(tmpdir(), 'cdkd-claude-bin-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  let n = 0;
  const dir = (): string => {
    const d = join(scratch, `d${n++}`);
    mkdirSync(d);
    return d;
  };
  /** A directory holding an executable `claude` that prints `version`. */
  const script = (version: string): string => {
    const d = dir();
    writeFileSync(join(d, 'claude'), `#!/bin/sh\necho "${version} (Claude Code)"\n`);
    chmodSync(join(d, 'claude'), 0o755);
    return d;
  };
  /** A directory whose `claude` symlinks to `target` (which need not exist). */
  const link = (target: string): string => {
    const d = dir();
    symlinkSync(target, join(d, 'claude'));
    return d;
  };
  const pathOf = (...dirs: string[]): NodeJS.ProcessEnv => ({ PATH: dirs.join(delimiter) });

  it('a DANGLING first entry throws instead of reading a later, older install', () => {
    const dangling = link(join(scratch, 'mid-update-target'));
    const read = (): unknown => installedClaudeVersion(pathOf(dangling, script('1.0.3')));
    expect(read).toThrow(/first `claude` on PATH, so an install is in progress or broken/);
    expect(read, 'the message must name the dangling entry').toThrow(join(dangling, 'claude'));
  });

  it('a DANGLING first entry with nothing after it throws instead of reading ABSENT', () => {
    const dangling = link(join(scratch, 'mid-update-target-2'));
    expect(() => installedClaudeVersion(pathOf(dangling))).toThrow(/ENOENT/);
  });

  it('the first `claude` on PATH wins over a later one', () => {
    expect(installedClaudeVersion(pathOf(script('2.1.263'), script('1.0.3')))).toBe('2.1.263');
  });

  it('no `claude` anywhere on PATH is the only ABSENT', () => {
    expect(installedClaudeVersion(pathOf(dir(), dir()))).toBeUndefined();
  });

  it('a PATH segment that is a FILE names nothing, so the walk goes on (ENOTDIR)', () => {
    const asFile = join(dir(), 'not-a-dir');
    writeFileSync(asFile, '');
    expect(installedClaudeVersion(pathOf(asFile, script('2.1.263')))).toBe('2.1.263');
  });

  it('an UNSET PATH throws rather than guessing a default search path', () => {
    expect(() => installedClaudeVersion({})).toThrow(/PATH is unset/);
  });

  it('a target removed between resolution and spawn throws instead of reading ABSENT', () => {
    const target = join(script('2.1.263'), 'claude');
    const linked = link(target);
    const resolved = resolveClaudeBin(pathOf(linked));
    expect(resolved, 'the live symlink must resolve').toEqual({
      bin: join(linked, 'claude'),
      override: false,
    });
    expect(readClaudeVersion(resolved!), 'the premise: it answers while live').toBe('2.1.263');
    rmSync(target);
    expect(() => readClaudeVersion(resolved!)).toThrow(/ENOENT/);
  });

  it('a DIRECTORY or NON-EXECUTABLE first `claude` throws rather than reading a later one', () => {
    // Fail closed: the exec search would pass these over for the later entry.
    const asDir = dir();
    mkdirSync(join(asDir, 'claude'));
    const notExec = dir();
    writeFileSync(join(notExec, 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
    chmodSync(join(notExec, 'claude'), 0o644);
    expect(() => installedClaudeVersion(pathOf(asDir, script('2.1.263')))).toThrow(/EACCES/);
    expect(() => installedClaudeVersion(pathOf(notExec, script('2.1.263')))).toThrow(/EACCES/);
  });

  it('resolves a RELATIVE segment to an absolute path, so the spawn cannot re-search PATH', () => {
    const dangling = link(join(scratch, 'mid-update-target-3'));
    const segment = relative(process.cwd(), dangling);
    expect(segment.startsWith('/'), 'the premise: the segment is relative').toBe(false);
    const resolved = resolveClaudeBin(pathOf(segment, script('1.0.3')));
    expect(resolved?.override).toBe(false);
    expect(isAbsolute(resolved!.bin), 'the spawn must not re-search PATH').toBe(true);
    expect(resolve(resolved!.bin)).toBe(join(dangling, 'claude'));
  });

  it('does not fold `..` lexically: a segment through a MISSING directory reaches nothing', () => {
    const real = script('2.1.263');
    const tail = `/../${relative(scratch, real)}`;
    // Both branches: an ABSOLUTE segment, and a RELATIVE one prefixed with the cwd.
    for (const throughMissing of [
      `${join(scratch, 'no-such-dir')}${tail}`,
      `${relative(process.cwd(), join(scratch, 'no-such-dir'))}${tail}`,
    ]) {
      expect(
        resolve(throughMissing, 'claude'),
        `the premise: folding WOULD reach it from ${throughMissing}`
      ).toBe(join(real, 'claude'));
      expect(installedClaudeVersion({ PATH: throughMissing })).toBeUndefined();
    }
  });

  // Root searches a mode-000 directory anyway, so the refusal cannot be staged.
  it.skipIf(process.getuid?.() === 0)(
    'a first PATH directory it may not SEARCH throws, not reads ABSENT or a later one',
    () => {
      const locked = script('2.1.263');
      chmodSync(locked, 0o000);
      try {
        let premise: string | undefined;
        try {
          lstatSync(join(locked, 'claude'));
        } catch (err) {
          premise = (err as NodeJS.ErrnoException).code;
        }
        expect(premise, 'the premise: the directory refuses the lookup').toBe('EACCES');
        expect(() => installedClaudeVersion(pathOf(dir(), locked))).toThrow(/EACCES/);
        expect(() => installedClaudeVersion(pathOf(locked, script('2.1.263')))).toThrow(/EACCES/);
        // A symlink INTO it is named, so it is the one read -- and it fails.
        expect(() =>
          installedClaudeVersion(pathOf(link(join(locked, 'claude')), script('2.1.263')))
        ).toThrow(/EACCES/);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it('a symlink LOOP named first throws rather than reading a later one', () => {
    const looped = dir();
    symlinkSync(join(looped, 'claude'), join(looped, 'claude'));
    expect(() => installedClaudeVersion(pathOf(looped, script('2.1.263')))).toThrow(/ELOOP/);
  });

  it('reads an EMPTY segment as the current directory, as the exec search does', () => {
    const here = script('2.1.263');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(here);
    try {
      expect(installedClaudeVersion({ PATH: `${delimiter}${script('1.0.3')}` })).toBe('2.1.263');
    } finally {
      cwd.mockRestore();
    }
  });

  it('CDKD_CLAUDE_BIN keeps its meaning: a missing override still reads ABSENT', () => {
    expect(
      installedClaudeVersion({ CDKD_CLAUDE_BIN: join(scratch, 'no-such-claude') })
    ).toBeUndefined();
  });

  it('CDKD_CLAUDE_BIN, when it answers, is read ahead of PATH', () => {
    expect(
      installedClaudeVersion({
        CDKD_CLAUDE_BIN: join(script('2.1.263'), 'claude'),
        PATH: script('1.0.3'),
      })
    ).toBe('2.1.263');
  });
});
