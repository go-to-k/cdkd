/**
 * Classifier for the integ-fixture `cdkd state destroy` state-bucket
 * convention (issue #1567).
 *
 * A fixture's `cleanup()` sweeps cdkd state with
 * `node "${LOCAL_DIST}" state destroy "${STACK}" --region ... --yes`. The
 * harness exports the bucket as `STATE_BUCKET`, but the CLI's env fallback is
 * `CDKD_STATE_BUCKET` — a DIFFERENT name — so a `state destroy` that omits
 * `--state-bucket` never reads the harness's bucket at all.
 *
 * What it reads instead depends on the fixture, and BOTH outcomes are wrong
 * (`resolveStateBucketWithSource`, src/cli/config-loader.ts: CLI flag >
 * `CDKD_STATE_BUCKET` > `cdk.json` `context.cdkd.stateBucket` > STS default):
 *
 *  - 109 fixture `cdk.json` files declare `context.cdkd.stateBucket`
 *    (`your-cdkd-state-bucket`, `cdkd-state-test`, ...). `verify.sh` runs the
 *    CLI from the fixture directory, so the sweep resolved THAT name and died
 *    with `StateError: State bucket '...' does not exist` — swallowed by the
 *    call's own `>/dev/null 2>&1`. Those cleanups had been failing on EVERY
 *    run, invisibly. 48 of the fixtures swept here are in this bucket.
 *  - The rest fell through to the STS-derived default
 *    `cdkd-state-{accountId}`, which happens to be the harness bucket on a
 *    default setup — so they worked, but by coincidence rather than by
 *    intent, and break the moment `STATE_BUCKET` points anywhere else (a
 *    per-run isolated bucket, a second-account run, the legacy
 *    region-suffixed bucket). There the sweep silently no-ops: destroys
 *    nothing, reports success, and only the fixture's own tag-based AWS
 *    sweeps clean up. The leaked state record then wedges the NEXT run.
 *
 * The convention is therefore: EVERY `state destroy` invocation passes the
 * bucket explicitly.
 *
 *   node "${LOCAL_DIST}" state destroy "${STACK}" \
 *     --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
 *
 * `"${STATE_BUCKET:-}"` rather than `"${STATE_BUCKET}"` is load-bearing: the
 * trap-installed `cleanup` can run BEFORE the script's own
 * `if [ -z "${STATE_BUCKET:-}" ]` guard has rejected an unset variable, and
 * under `set -u` the unguarded form would abort the teardown mid-sweep. An
 * empty value is safe — `resolveStateBucket()` treats `''` as "not supplied"
 * and falls back exactly as omitting the flag does today, so the guarded form
 * is a strict improvement over the status quo in every case.
 *
 * Why this is a checker and not a one-time sweep: 94 of the 166 fixtures that
 * call `state destroy` had drifted off the convention (96 of 171 call sites)
 * precisely because nothing enforced it, while `deploy` (335 invocations) and
 * `destroy` (228) pass the flag at every single site. Measured 2026-08-11.
 * The asymmetry is what a lint is for.
 *
 * Everything is evaluated on CODE, never on prose: heredoc bodies and comments
 * are stripped and each line is split into command-position segments with a
 * quote-aware walk, so a `state destroy` inside an `echo "..."` remediation
 * hint is not an invocation. The stripper mirrors
 * `scripts/check-integ-cdk-cli-pins.ts`, which established the shape.
 */

/** Commands whose arguments are prose/data rather than nested commands. */
const PROSE_COMMANDS = /^(?:echo|printf|grep|egrep|fgrep|cat|sed|awk|jq|comm|read)\b/;

/**
 * The cdkd CLI as fixtures spell it: `node "${LOCAL_DIST}"`, a bare `${CLI}` /
 * `${CDKD}` variable, or `node "${CDKD}"`. Anchored at the segment's command
 * word so a mention inside an argument cannot match.
 *
 * This list is NOT the safety net — an unrecognized spelling would silently
 * exempt a fixture, which is the #1097 lint's failure mode. `collect*` reports
 * every UNRECOGNIZED `state destroy` segment instead, and the test fails on a
 * non-empty report, so a new binary spelling surfaces loudly rather than as a
 * quiet zero. (`CDKD=` is used by 36 fixtures; none call `state destroy` yet,
 * which is exactly why the whitelist alone could not be trusted.)
 */
const CDKD_CLI = /^(?:node\s+)?["']?\$\{(?:LOCAL_DIST|CLI|CDKD)(?::-[^}]*)?\}["']?\s+/;

export interface StateDestroyInvocation {
  /** The full logical command, continuations joined. */
  command: string;
  /** Passes `--state-bucket` explicitly. */
  passesStateBucket: boolean;
  /**
   * Shape the invocation was parsed from, so coverage floors can be asserted
   * per shape rather than only in aggregate.
   */
  shape: 'plain' | 'guarded' | 'env-prefixed';
}

/** Join backslash continuations so one logical command is one line. */
function joinContinuations(script: string): string {
  return script.replace(/\\\n\s*/g, ' ');
}

/**
 * Drop heredoc bodies. A body is data — a `state destroy` line inside one is
 * documentation, not an invocation.
 *
 * `(?<!<)…(?!<)` excludes the `<<< bareword` herestring, which is NOT a
 * heredoc: treating `grep x <<< bar` as one swallowed the entire rest of the
 * file. BOTH guards are needed — with only the lookahead the engine shifts one
 * character and matches `<<` starting at the second `<` of `<<<`, taking
 * `bar` as the terminator.
 * Run this on comment-stripped text, or a `# ... <<EOF` in prose opens a
 * heredoc that never terminates and hides every invocation below it
 * (`local-invoke-buildkit/verify.sh` has exactly that comment).
 */
function stripHeredocs(script: string): string {
  const out: string[] = [];
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]!);
    const m = lines[i]!.match(/(?<!<)<<-?(?!<)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (!m) continue;
    const endRe = new RegExp(`^\\s*${m[1]!}\\s*$`);
    i += 1;
    while (i < lines.length && !endRe.test(lines[i]!)) i += 1;
    if (i < lines.length) out.push(lines[i]!); // keep the terminator line
  }
  return out.join('\n');
}

/**
 * Comments first (per PHYSICAL line), then heredocs, then continuations.
 *
 * The order is load-bearing in both places. Bash does NOT continue a comment
 * across a trailing backslash, so joining first lets a `# ... \` comment glue
 * the following REAL invocation into itself and strip it — a silent false
 * negative, and `local-start-alb-from-state/verify.sh` carries that comment
 * shape. And heredoc openers must be looked for on comment-stripped text (see
 * `stripHeredocs`).
 */
function normalizeScript(script: string): string {
  const commentStripped = script.split('\n').map(stripComment).join('\n');
  return joinContinuations(stripHeredocs(commentStripped));
}

/** Remove a `#` comment, honoring quote state (so `"a # b"` survives). */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '\\' && inDouble) {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1]!)) return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Split a line into segments that start in COMMAND position, honoring quote
 * state so a separator inside a quoted argument does not open a new segment.
 */
function commandSegments(line: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '\\' && inDouble) {
      current += ch + (line[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === '$' && line[i + 1] === '(') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && /[;&|()`]/.test(ch)) {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Strip leading tokens that keep the rest of the segment in command position,
 * reporting which shape was peeled so the caller can assert per-shape floors.
 */
function stripToCommandWord(segment: string): { command: string; shape: StateDestroyInvocation['shape'] } {
  let s = segment;
  let shape: StateDestroyInvocation['shape'] = 'plain';
  let prev;
  do {
    prev = s;
    s = s.replace(/^\{\s+/, '');
    // `[ -x "${LOCAL_DIST}" ] &&` / `if`-guarded invocations. The `&&` itself
    // already opened a new segment, so only a bare keyword remains here.
    const guard = s.replace(/^(?:!|if|then|else|elif|do|while|until|time)\s+/, '');
    if (guard !== s) {
      shape = 'guarded';
      s = guard;
    }
    s = s.replace(/^timeout\s+(?:-\S+\s+)*\d+\S*\s+/, '');
    // `env -u VAR` / `env -i` wrappers (a real tree shape — see
    // agentcore-tools/verify.sh) as well as bare `VAR=value` prefixes.
    const env = s
      .replace(/^env\s+(?:-[iu]\s+[A-Za-z_][A-Za-z0-9_]*\s+|-[iu]\s+)+/, '')
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
    if (env !== s) {
      shape = 'env-prefixed';
      s = env;
    }
  } while (s !== prev);
  return { command: s, shape };
}

/**
 * Every `cdkd state destroy` invocation the script actually runs, in source
 * order. Prose mentions (comments, heredocs, `echo` arguments) are excluded.
 */
export function collectStateDestroyInvocations(script: string): StateDestroyScan {
  const found: StateDestroyInvocation[] = [];
  const unrecognized: string[] = [];

  for (const line of normalizeScript(script).split('\n')) {
    if (!line.includes('state destroy')) continue;

    for (const segment of commandSegments(line)) {
      if (!segment.includes('state destroy')) continue;
      const { command, shape } = stripToCommandWord(segment);
      // Prose: `echo "... state destroy ..."` is a printed hint, not a run.
      if (PROSE_COMMANDS.test(command)) continue;
      // `state destroy` must be the SUBCOMMAND, i.e. right after the binary.
      const isSubcommand = /^\S+\s+(?:\S+\s+)?state\s+destroy\b/.test(command);
      if (!CDKD_CLI.test(command) || !isSubcommand) {
        // Do NOT silently skip: an unknown binary spelling would exempt the
        // fixture. Report it so the test fails loudly instead.
        if (isSubcommand || /(?:^|\s)state\s+destroy\b/.test(command)) {
          unrecognized.push(command);
        }
        continue;
      }
      found.push({
        command,
        passesStateBucket: /(?:^|\s)--state-bucket(?:=|\s)/.test(command),
        shape,
      });
    }
  }

  return { invocations: found, unrecognized };
}

export interface StateDestroyScan {
  invocations: StateDestroyInvocation[];
  /**
   * Segments that run a `state destroy` through a binary spelling this
   * classifier does not recognize. Always expected to be empty; a non-empty
   * report means the whitelist needs the new spelling, NOT that the fixture is
   * exempt.
   */
  unrecognized: string[];
}

export interface FixtureVerdict extends StateDestroyScan {
  /** Invocations that omit `--state-bucket` — the CI-blocking verdict. */
  offenders: StateDestroyInvocation[];
}

export function checkFixture(script: string): FixtureVerdict {
  const scan = collectStateDestroyInvocations(script);
  return { ...scan, offenders: scan.invocations.filter((i) => !i.passesStateBucket) };
}
