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
]);

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
export function blankQuotedSpans(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
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
        out += '  ';
        i += 2;
        continue;
      }
      // A command substitution runs a real command — keep it verbatim and let
      // the tokenizer see it. Single quotes suppress expansion, so only the
      // double-quoted case substitutes.
      if (quote === '"' && line[i] === '$' && line[i + 1] === '(') {
        let depth = 0;
        while (i < line.length) {
          if (line[i] === '(') depth++;
          else if (line[i] === ')') {
            depth--;
            if (depth === 0) {
              out += line[i]!;
              i++;
              break;
            }
          }
          out += line[i]!;
          i++;
        }
        continue;
      }
      out += ' ';
      i++;
    }
    if (i < line.length) {
      out += line[i]!;
      i++;
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
 * would skip every destroy assertion in the tree, which is a large and
 * high-value share of the `aws` calls. Scanning for the `aws` token anywhere in
 * a segment covers the plain form, the helper-argument form, `$( ... )`
 * substitutions, and `if ! aws ...` conditions with one rule.
 *
 * Comments are stripped BEFORE matching (both trailing and whole-line): three
 * `verify.sh` files discuss `aws emr list-instance-groups` in prose explaining
 * why they avoid it, and flagging those would make the check unusable.
 */
export function extractAwsInvocations(content: string): AwsInvocation[] {
  const joined = joinContinuedLines(content);
  const invocations: AwsInvocation[] = [];

  for (let i = 0; i < joined.length; i++) {
    const { text, line } = joined[i]!;
    // The hatch lives in a COMMENT, so it is read from the part
    // `stripTrailingComment` removes — NOT from the raw line, which would also
    // honor the marker when it merely appears inside a string literal.
    const stripped = stripTrailingComment(text);
    const ownComment = text.slice(stripped.length);
    const prevText = joined[i - 1]?.text ?? '';
    // On the line above, require a WHOLE-line comment: a marker trailing a
    // previous command is about that command, not this one.
    const prevIsCommentLine = prevText.trimStart().startsWith('#');
    const allowed =
      ownComment.includes(ALLOW_MARKER) ||
      (prevIsCommentLine && prevText.includes(ALLOW_MARKER));

    for (const segment of splitShellCommands(blankQuotedSpans(stripped))) {
      const tokens = segment.split(TOKEN_SEPARATOR).filter(Boolean);
      for (let t = 0; t < tokens.length - 2; t++) {
        if (tokens[t] !== 'aws') continue;

        // Step past any leading GLOBAL options — `aws --region us-east-1 emr
        // list-clusters` must resolve to (emr, list-clusters), not
        // (us-east-1, emr). Without this the invocation silently vanishes:
        // `NAME` rejects `--region` and the whole call goes unchecked.
        let k = t + 1;
        while (k < tokens.length && tokens[k]!.startsWith('-')) {
          const flag = tokens[k]!.split('=')[0]!;
          k++;
          // `--flag=value` already carries its value; a bare value-taking flag
          // consumes the next token.
          if (
            VALUE_TAKING_GLOBAL_OPTIONS.has(flag) &&
            !tokens[k - 1]!.includes('=') &&
            k < tokens.length &&
            !tokens[k]!.startsWith('-')
          ) {
            k++;
          }
        }

        const service = tokens[k];
        const verb = tokens[k + 1];
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

export function lintFixtureTreeAwsCommands(
  integRoot: string,
  table: RemovedCommands
): AwsCommandViolation[] {
  return readdirSync(integRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(integRoot, e.name, 'verify.sh')))
    .flatMap((e) =>
      lintScriptAwsCommands(
        e.name,
        readFileSync(join(integRoot, e.name, 'verify.sh'), 'utf8'),
        table
      )
    );
}

export function formatAwsCommandViolation(v: AwsCommandViolation): string {
  return [
    `tests/integration/${v.fixture}/verify.sh:${v.line}`,
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
