/**
 * Validates every `aws <service> <verb>` invocation in the integ fixtures'
 * `verify.sh` against the AWS CLI's REMOVED-command list.
 *
 * Why this exists (issue #1402): `tests/integration/emr-cluster/verify.sh` and
 * `emr-instance-configs/verify.sh` both had to be rewritten because
 * `aws emr list-instance-groups` did not work from a non-interactive shell.
 * The symptom looked exotic —
 *
 *     Warning: Input is not a terminal (fd=0).
 *     aws: [ERROR]: [Errno 22] Invalid argument
 *
 * — and neither `--no-paginate`, `--no-cli-pager`, nor `</dev/null` helped, so
 * the trap was originally written up as "the command is an AWS-CLI
 * CUSTOMIZATION". **That diagnosis was wrong**, and the correction is what this
 * checker encodes (verified 2026-08-09 against `aws-cli/2.35.13`):
 *
 *   1. `list-instance-groups` is not a customization. It is on the AWS CLI's
 *      REMOVAL list (`awscli/customizations/removals.py`), which DELETES it
 *      from the `aws emr` command table. The operation still exists in the
 *      botocore service model — and therefore in every AWS SDK, in the API
 *      reference, and in anything generated from them — so the verb looks
 *      completely legitimate everywhere except the CLI.
 *   2. `aws emr list-instance-fleets`, which the original write-up also
 *      suspected ("the `list-instance-*` verbs"), is NOT removed and works
 *      fine non-interactively. A per-service denylist would have been wrong;
 *      the unit of the defect is the (service, verb) pair.
 *   3. The `Errno 22` / hang symptom is not intrinsic to the command. It is
 *      what `cli_auto_prompt` (`on-partial` in the maintainer's
 *      `~/.aws/config`) does to ANY invalid-choice error: the CLI tries to open
 *      its interactive prompter, which cannot attach to a non-terminal stdin.
 *      With `AWS_CLI_AUTO_PROMPT=off` the very same call fails fast and legibly
 *      with `Found invalid choice 'list-instance-groups'`.
 *
 * The generalized rule is therefore "a fixture must not call an `aws` verb the
 * CLI does not have", which is the `aws`-side twin of
 * `check-integ-cli-flags.ts` (validate cdkd's own invocations against the real
 * Commander tree). Both exist because a green typecheck says nothing about
 * whether a shell script's command lines are real.
 *
 * The oracle is the captured fixture `tests/fixtures/aws-cli-removed-commands.json`
 * (see `scripts/refresh-aws-cli-removals.ts`), NOT a live `aws` invocation:
 * shelling out would make the check skip on a machine without the AWS CLI, and
 * a checker that silently degrades to "nothing to see" is the vacuous pass
 * `.claude/rules/testing.md` forbids.
 *
 * Escape hatch: a `# allow-unavailable-aws-command: <reason>` comment on the
 * invocation's line or the line above it.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  joinContinuedLines,
  splitShellCommands,
  stripTrailingComment,
} from './check-integ-cli-flags.js';

/** `# allow-unavailable-aws-command: <reason>` — same line, or the line above. */
export const ALLOW_MARKER = 'allow-unavailable-aws-command:';

export interface AwsInvocation {
  /** 1-based line of the invocation's first line. */
  line: number;
  service: string;
  verb: string;
  raw: string;
  /** True when the invocation (or the line above it) carries the escape hatch. */
  allowed: boolean;
}

const NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Token separator: every character that cannot occur inside an `aws` / service
 * / verb token, which also means every character that can GLUE one to its
 * surroundings — `"`, `'`, `` ` ``, `$`, `(`, `)`, `=`, `;`, `|`, `&`.
 *
 * A plain whitespace split is not enough: the capture form
 * `IDS="$(aws emr list-clusters ...)"` yields the single token `IDS="$(aws`,
 * which matches nothing, and capture-form invocations are a large share of the
 * tree.
 *
 * `-` and `.` and `/` stay INSIDE tokens on purpose. Keeping `-` is what makes
 * `--cluster-id` remain flag-shaped and therefore fail {@link NAME} instead of
 * being read as a verb; keeping `/` is what stops `s3://bucket` from splitting
 * into a service-looking `s3`.
 */
const TOKEN_SEPARATOR = /[^A-Za-z0-9._/:-]+/;

/**
 * AWS CLI global options that CONSUME the following token, so a leading
 * `aws --region us-east-1 emr <verb>` is not read as service `us-east-1`.
 * Boolean globals (`--debug`, `--no-cli-pager`, ...) need no entry — they are
 * skipped by the generic "starts with `-`" rule.
 */
const VALUE_TAKING_GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  '--region',
  '--profile',
  '--endpoint-url',
  '--output',
  '--query',
  '--color',
  '--ca-bundle',
  '--cli-read-timeout',
  '--cli-connect-timeout',
  '--cli-binary-format',
  // Completing the documented set matters: an unrecognised value-taking global
  // is skipped as if it were boolean, so its VALUE lands in the service slot,
  // fails NAME, and the whole invocation vanishes with no diagnostic.
  '--metadata-service-timeout',
  '--metadata-service-num-attempts',
]);

/**
 * Index of the first token at or after `start` that is not an option (nor an
 * option's consumed value). Used at BOTH the service and the verb slot, since
 * the AWS CLI accepts a global option in either position.
 */
function skipOptions(tokens: string[], start: number): number {
  let k = start;
  while (k < tokens.length && tokens[k]!.startsWith('-')) {
    // NOTE `=` is a TOKEN_SEPARATOR, so `--region=us-east-1` already arrived
    // as two tokens and needs no special case here — the value is consumed by
    // the same branch as the space-separated form.
    const flag = tokens[k]!;
    k++;
    if (
      VALUE_TAKING_GLOBAL_OPTIONS.has(flag) &&
      k < tokens.length &&
      !tokens[k]!.startsWith('-')
    ) {
      k++;
    }
  }
  return k;
}

/**
 * Blanks out quoted spans so their contents are not mistaken for commands,
 * while PRESERVING `$( ... )` command substitutions inside them.
 *
 * Both halves are load-bearing. Without blanking, prose and data parse as
 * invocations — confirmed live in this tree: `echo "==> Verifying deploy via
 * aws cli (sanity)"` read as `aws cli sanity`, and `arn:aws:s3:::bucket` read
 * as `aws s3 bucket`. That inflates the coverage floors with non-invocations
 * and, worse, would make a fixture's own `echo "... aws emr
 * list-instance-groups ..."` explanation a CI-blocking violation whose only
 * cure is deleting the explanation — the outcome comment-stripping exists to
 * prevent. And without preserving `$( )`, the capture form
 * `IDS="$(aws emr list-clusters)"` — over a thousand invocations, the single
 * largest shape in the tree — would vanish wholesale.
 *
 * Note `:` is INSIDE {@link TOKEN_SEPARATOR}'s allowed set for the same
 * family of reasons: it keeps `arn:aws:...` and a JMESPath `` `aws:cdk:path` ``
 * as ONE token rather than splitting out a bare `aws`.
 */
export interface ScanState {
  /** Quote character of a span left OPEN at the end of the previous line. */
  openQuote: '"' | "'" | null;
  /** Delimiter of a heredoc whose body we are inside, or null. */
  heredoc: string | null;
}

export function newScanState(): ScanState {
  return { openQuote: null, heredoc: null };
}

/** Blanking filler. See {@link blankQuotedSpans} for why it is not a space. */
const BLANK = '_';

/**
 * Blanks non-code spans of a line — quoted strings and heredoc bodies — so
 * their contents are not mistaken for commands, while PRESERVING `$( ... )`
 * command substitutions inside double quotes.
 *
 * `state` carries quote / heredoc context ACROSS lines and is mutated. That is
 * load-bearing, not tidiness: this repo's fixtures embed multi-line
 * `node --input-type=module -e "` programs (see
 * `tests/integration/emr-instance-configs/verify.sh`), and with per-line state
 * a JS comment inside such a block — `// do not use aws emr
 * list-instance-groups here` — parses as a command and becomes a CI-blocking
 * violation whose only cure is deleting the explanation. That is precisely the
 * outcome this blanking exists to prevent, one layer up. Same for a
 * `cat <<EOF ... EOF` body.
 *
 * The filler is `_`, NOT a space, and that choice is also load-bearing. A
 * blanked span must remain ONE token: `_` is inside {@link TOKEN_SEPARATOR}'s
 * allowed set (and can never start a {@link NAME}), whereas spaces would make
 * the span vanish as a token entirely — and then
 * `aws --region "${REGION}" emr list-clusters` loses its option VALUE, the skip
 * loop consumes `emr` in its place, and the whole invocation disappears with no
 * diagnostic. `"${REGION}"` is the spelling every fixture here uses, so
 * space-filling would have been blind to the form it actually meets.
 *
 * Length is preserved so downstream line/column accounting is unaffected.
 */
export function blankQuotedSpans(line: string, state: ScanState = newScanState()): string {
  // Inside a heredoc body: the whole line is data until the delimiter line.
  if (state.heredoc !== null) {
    if (line.trim() === state.heredoc) state.heredoc = null;
    return BLANK.repeat(line.length);
  }

  let out = '';
  let i = 0;

  // Finish a quoted span left open by the previous line.
  if (state.openQuote !== null) {
    const quote = state.openQuote;
    while (i < line.length && line[i] !== quote) {
      out += BLANK;
      i++;
    }
    if (i < line.length) {
      out += line[i]!;
      i++;
      state.openQuote = null;
    } else {
      return out;
    }
  }

  while (i < line.length) {
    const ch = line[i]!;

    // Heredoc introducer: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`. The body
    // starts on the NEXT line, so record it and keep scanning this one.
    if (ch === '<' && line[i + 1] === '<') {
      const m = /^<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.slice(i));
      if (m) {
        state.heredoc = m[2]!;
        out += line.slice(i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }

    if (ch !== '"' && ch !== "'") {
      out += ch;
      i++;
      continue;
    }

    const quote = ch;
    out += ch;
    i++;
    while (i < line.length && line[i] !== quote) {
      // `\"` inside a double-quoted span is an escaped quote, not the closer.
      if (quote === '"' && line[i] === '\\' && i + 1 < line.length) {
        out += BLANK + BLANK;
        i += 2;
        continue;
      }
      // A command substitution runs a real command — keep it verbatim so the
      // tokenizer sees it. Single quotes suppress expansion, so only the
      // double-quoted case substitutes.
      if (quote === '"' && line[i] === '$' && line[i + 1] === '(') {
        let depth = 0;
        let inner: '"' | "'" | null = null;
        while (i < line.length) {
          const c = line[i]!;
          // Track quotes INSIDE the substitution so a `)` in a quoted argument
          // (`--query "a)b"`) does not close it early and blank the remainder.
          if (inner !== null) {
            if (c === inner) inner = null;
          } else if (c === '"' || c === "'") {
            inner = c;
          } else if (c === '(') {
            depth++;
          } else if (c === ')') {
            depth--;
            if (depth === 0) {
              out += c;
              i++;
              break;
            }
          }
          out += c;
          i++;
        }
        continue;
      }
      out += BLANK;
      i++;
    }
    if (i < line.length) {
      out += line[i]!;
      i++;
    } else {
      // Unterminated on this line — the span continues onto the next.
      state.openQuote = quote;
    }
  }
  return out;
}

/**
 * Pulls each `aws <service> <verb>` out of a verify.sh.
 *
 * Deliberately NOT anchored at a command start. The repo's canonical
 * gone-probe helpers take the probe as ARGUMENTS —
 * `assert_gone "<desc>" aws s3api head-object ...` — so a command-start anchor
 * would skip every destroy assertion in the tree (414 invocations), a large and
 * high-value share. Scanning for the `aws` token anywhere in a segment covers
 * the plain form, the helper-argument form, `$( ... )` substitutions, and
 * `if ! aws ...` conditions with one rule.
 *
 * Comments are stripped BEFORE matching (both trailing and whole-line): two
 * `verify.sh` files discuss `aws emr list-instance-groups` in prose explaining
 * why they avoid it, and flagging those would make the check unusable.
 */
export function extractAwsInvocations(content: string): AwsInvocation[] {
  const joined = joinContinuedLines(content);
  const invocations: AwsInvocation[] = [];
  // ONE state for the whole file: quote / heredoc context spans lines (the
  // multi-line `node -e "..."` blocks these fixtures embed).
  const scan = newScanState();

  for (let i = 0; i < joined.length; i++) {
    const { text, line } = joined[i]!;

    // Inside a multi-line string or heredoc there is no shell comment to
    // strip — `#` is data there — so blank first and skip the comment logic.
    const insideNonCode = scan.openQuote !== null || scan.heredoc !== null;
    const stripped = insideNonCode ? text : stripTrailingComment(text);
    const blanked = blankQuotedSpans(stripped, scan);
    if (insideNonCode) continue;

    // The hatch is read from the part `stripTrailingComment` removed — NOT
    // from the raw line, which would also honor a marker inside a string.
    const ownComment = text.slice(stripped.length);
    const prevText = joined[i - 1]?.text ?? '';
    // On the line above, require a WHOLE-line comment: a marker trailing a
    // previous command is about that command, not this one.
    const prevIsCommentLine = prevText.trimStart().startsWith('#');
    const allowed =
      ownComment.includes(ALLOW_MARKER) ||
      (prevIsCommentLine && prevText.includes(ALLOW_MARKER));

    for (const segment of splitShellCommands(blanked)) {
      const tokens = segment.split(TOKEN_SEPARATOR).filter(Boolean);
      for (let t = 0; t < tokens.length - 2; t++) {
        if (tokens[t] !== 'aws') continue;

        // Step past GLOBAL options, which the AWS CLI accepts BOTH before the
        // service (`aws --region us-east-1 emr list-clusters`) and between the
        // service and the verb (`aws emr --region us-east-1 list-clusters`).
        const serviceIdx = skipOptions(tokens, t + 1);
        const service = tokens[serviceIdx];
        const verb = tokens[skipOptions(tokens, serviceIdx + 1)];

        // A variable or otherwise unclassifiable token means this is not a
        // plain `aws <service> <verb>` we can judge statically — skip rather
        // than guess.
        if (service === undefined || verb === undefined) continue;
        if (!NAME.test(service) || !NAME.test(verb)) continue;
        invocations.push({ line, service, verb, raw: segment.trim(), allowed });
      }
    }
  }

  return invocations;
}

export interface AwsCommandViolation {
  fixture: string;
  line: number;
  service: string;
  verb: string;
  raw: string;
}

export interface RemovedCommands {
  /** service -> removed verbs. */
  removed: Map<string, ReadonlySet<string>>;
  awsCliVersion: string;
}

/** Pure-functional parser for the captured fixture, for filesystem-free tests. */
export function parseRemovedCommandsContent(jsonStr: string): RemovedCommands {
  const removed = new Map<string, ReadonlySet<string>>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { removed, awsCliVersion: 'unknown' };
  }
  if (parsed === null || typeof parsed !== 'object') return { removed, awsCliVersion: 'unknown' };
  const obj = parsed as Record<string, unknown>;
  const table = obj['removed'];
  if (table !== null && typeof table === 'object' && !Array.isArray(table)) {
    for (const [service, verbs] of Object.entries(table as Record<string, unknown>)) {
      if (!Array.isArray(verbs)) continue;
      removed.set(service, new Set(verbs.filter((v): v is string => typeof v === 'string')));
    }
  }
  return {
    removed,
    awsCliVersion: typeof obj['$awsCliVersion'] === 'string' ? obj['$awsCliVersion'] : 'unknown',
  };
}

export function loadRemovedCommands(
  fixturePath = join(import.meta.dirname, '../tests/fixtures/aws-cli-removed-commands.json')
): RemovedCommands {
  return parseRemovedCommandsContent(readFileSync(fixturePath, 'utf8'));
}

export function lintScriptAwsCommands(
  fixture: string,
  content: string,
  table: RemovedCommands
): AwsCommandViolation[] {
  const violations: AwsCommandViolation[] = [];
  for (const inv of extractAwsInvocations(content)) {
    if (inv.allowed) continue;
    if (!table.removed.get(inv.service)?.has(inv.verb)) continue;
    violations.push({
      fixture,
      line: inv.line,
      service: inv.service,
      verb: inv.verb,
      raw: inv.raw,
    });
  }
  return violations;
}

/**
 * Every fixture that has a `verify.sh`, as `{ fixture, content }`.
 *
 * Exported so the coverage floors measure the SAME enumeration the lint walks.
 * When the test re-implemented this walk, breaking the filter here left the
 * suite fully green: `lintFixtureTreeAwsCommands` would yield zero violations
 * (vacuously satisfying the "no fixture calls a removed verb" assertion) while
 * the floors kept passing against their private copy of the walk. That is the
 * "0 violations and parsed nothing at all look identical" failure mode
 * `.claude/rules/testing.md` exists to prevent, reintroduced one level up.
 */
export function readFixtureScripts(integRoot: string): { fixture: string; content: string }[] {
  const entries = readdirSync(integRoot, { withFileTypes: true });
  const fixtures = entries
    .filter((e) => e.isDirectory() && existsSync(join(integRoot, e.name, 'verify.sh')))
    .map((e) => ({
      fixture: e.name,
      content: readFileSync(join(integRoot, e.name, 'verify.sh'), 'utf8'),
    }));
  // ...plus the SHARED helpers sitting directly in tests/integration/, which
  // issue `aws` verbs on behalf of every fixture that sources them
  // (`s3-versions.sh` runs `s3api list-object-versions` / `delete-objects` /
  // `delete-object` in ten of them, issue #2096). Scoping this walk to
  // directories would leave the most widely executed aws calls in the tree as
  // the only ones this lint cannot see -- and a removed verb there breaks
  // ten fixtures at once rather than one.
  const shared = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sh'))
    .map((e) => ({
      fixture: e.name,
      content: readFileSync(join(integRoot, e.name), 'utf8'),
    }));
  return [...fixtures, ...shared];
}

export function lintFixtureTreeAwsCommands(
  integRoot: string,
  table: RemovedCommands
): AwsCommandViolation[] {
  return readFixtureScripts(integRoot).flatMap(({ fixture, content }) =>
    lintScriptAwsCommands(fixture, content, table)
  );
}

/**
 * `<fixture>/verify.sh` for a fixture, or the bare filename for a SHARED helper
 * that lives directly in `tests/integration/`. `readFixtureScripts` returns
 * both shapes, so a hardcoded `${fixture}/verify.sh` would report the
 * nonexistent path `tests/integration/s3-versions.sh/verify.sh` for exactly the
 * file the walk was widened to reach -- i.e. it would be wrong the first time
 * it was ever needed.
 */
function violationPath(fixture: string): string {
  return fixture.endsWith('.sh')
    ? `tests/integration/${fixture}`
    : `tests/integration/${fixture}/verify.sh`;
}

export function formatAwsCommandViolation(v: AwsCommandViolation): string {
  return [
    `${violationPath(v.fixture)}:${v.line}`,
    `  \`aws ${v.service} ${v.verb}\` is NOT an AWS CLI command — it is on the CLI's removal list`,
    `  (awscli/customizations/removals.py), even though the ${v.service} API operation exists and`,
    `  every AWS SDK exposes it. The CLI answers "Found invalid choice"; on a machine with`,
    `  cli_auto_prompt enabled it instead prints "Warning: Input is not a terminal (fd=0)" and dies`,
    `  with "[Errno 22] Invalid argument" — or hangs.`,
    // Deliberately does NOT name a package: the CLI service name is not always
    // the SDK package suffix (`s3api` -> @aws-sdk/client-s3), and a confidently
    // wrong `npm i` hint is worse than none.
    `  Fix: call the operation through the matching @aws-sdk/client-* package from a`,
    `  \`node --input-type=module -e\` one-liner run from REPO_ROOT (the repo already depends on the`,
    `  clients cdkd uses, so no install is needed). See list_instance_groups_json in`,
    `  tests/integration/emr-instance-configs/verify.sh for the reference shape, including the`,
    `  \`|| return 1\` and the Marker pagination loop.`,
    `  Escape hatch (only if you have PROVEN the call works): # ${ALLOW_MARKER} <reason>`,
    `    ${v.raw}`,
  ].join('\n');
}
