import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildProgram } from '../../../src/cli/program.js';
import {
  acceptedFlagsFor,
  collectCommandSpecs,
  joinContinuedLines,
  splitShellCommands,
  stripTrailingComment,
} from '../../../scripts/check-integ-cli-flags.js';

/**
 * `plugins/cdkd-skills/skills/cdkd/SKILL.md` is the DISTRIBUTED plugin surface:
 * it tells an agent that never reads this repo which `cdkd` commands and flags
 * to run. Nothing kept its claims in step with the CLI (issue
 * go-to-k/cdkd#2673), and it is the copy most likely to rot, because no reader
 * is ever routed to it from here.
 *
 * Two structural fixes ship with this test and neither is sufficient alone:
 * `plugins/**` joins the `docs` gate's scope (it was in `check` only, added by
 * go-to-k/cdkd#2878 for an issue-reference fence, and `check` asks whether the
 * tree builds rather than whether a sentence is still true), and
 * `/check-docs` names the file as a TARGET — a gate that stales with nothing
 * to read is just a re-run.
 *
 * This test is the mechanical half, and it deliberately checks the ONE claim
 * class that can be settled without judgement: every `--flag` the page
 * advertises must exist on the command it is advertised for, read from the
 * REAL Commander tree via `buildProgram()` — the instrument
 * `integ-cli-flags.test.ts` uses, for the reason recorded there: `--help`
 * omits hidden options and `src/cli/options.ts` is a flat list carrying no
 * command attachment.
 *
 * What it deliberately does NOT do is judge PROSE. Whether "cdkd falls back to
 * CloudFormation" still describes the resolver is a question for a reader, and
 * `/check-docs` is where that now happens.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN_SKILL = join(repoRoot, 'plugins', 'cdkd-skills', 'skills', 'cdkd', 'SKILL.md');

const specs = collectCommandSpecs(buildProgram());


/**
 * Every `cdkd <command...>` invocation the page advertises, with its flags.
 *
 * Four extractor bugs were found by PROBING this rather than by reading it,
 * and each is named where it was fixed, because all four produce a checker
 * that looks right:
 *
 * 1. Scanning whole lines pulled `version` and `does` out of ordinary prose
 *    and reported them as missing COMMANDS. A checker that invents findings
 *    teaches the next reader to ignore it. → code only.
 * 2. `\bcdkd` matched inside the package NAME in
 *    `npm view @go-to-k/cdkd version`. → `(?<![\w@/-])`.
 * 3. Only `(command, flag)` PAIRS were pushed, so a FLAGLESS invocation was
 *    never recorded and the command case was vacuous — `cdkd nosuchcmd
 *    <stack>` passed. → a flagless invocation is recorded too.
 * 4. A two-word claim fell back to the PARENT when the pair was unknown, so
 *    `cdkd state nosuchsub` resolved to `state`, which exists. That silently
 *    covered every subcommand on the page — `local invoke`, `state
 *    refresh-observed`, `events prune` — i.e. exactly the renamed-in-src case
 *    this test promises to catch. → {@link resolveCommand}.
 *
 * Line handling is delegated to `check-integ-cli-flags.ts` rather than
 * re-spelled: `joinContinuedLines` (a `\`-continued command),
 * `stripTrailingComment` (a trailing `# ... --flag` read as a claim) and
 * `splitShellCommands` (`cdkd A && cdkd B --flag`, where a whole-line tail
 * attributed the flag to A and dropped B). A second spelling of any of them is
 * how the two would come to disagree.
 */
function resolveCommand(words: string[]): string {
  const first = words[0] as string;
  if (words.length < 2) return first;
  const pair = words.join(' ');
  if (specs.has(pair)) return pair;
  // Unknown pair: report it AS the pair when the parent really takes
  // subcommands. Falling back to the parent here is bug 4 — it made every
  // subcommand claim on the page vacuous.
  //
  // There is NO second predicate on `words[1]`, and an earlier revision's was
  // worse than redundant: it tested `/^[a-z][a-z-]*$/`, which the invocation
  // regex has already guaranteed, so it rejected nothing while its comment
  // claimed it screened out `<placeholder>` operands. Measured: `cdkd events
  // <stack> --all` yields group 1 `events` — a `<placeholder>` can never
  // BE `words[1]`.
  //
  // The residual that predicate did not cover either, stated rather than
  // implied: a command taking BOTH an operand and subcommands (`events` takes
  // `<stack>` and has the child `prune`) would report `cdkd events prod` as a
  // missing command. Safe on this page only because it spells operands as
  // `<stack>` throughout — a convention, not a guarantee. If that breaks, the
  // fix is to teach the extractor the page's operand spelling, not to
  // re-add a predicate that screens nothing.
  const parent = specs.get(first);
  if (parent && parent.children.size > 0) return pair;
  return first;
}

interface Claim {
  command: string;
  flag: string | undefined;
  line: number;
  /** Which arm saw it — fenced block, or an inline `code` span. */
  arm: 'fence' | 'inline';
}

function advertisedFlags(text: string): Claim[] {
  const out: Claim[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (const { text: raw, line } of joinContinuedLines(text)) {
    // Both fence spellings, with or without a language tag or indentation. A
    // fence closes only on its OWN marker, so a ``` inside a ~~~ block does
    // not end it.
    const fence = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      const marker = fence[1] as string;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
        // CommonMark: a fence closes only on its OWN character, at the same
        // length or longer. Collapsing to three characters let a ``` inside a
        // ```` block close it early and INVERT the in/out state for the rest
        // of the file.
        inFence = false;
      }
      continue;
    }

    const chunks = inFence ? [raw] : [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);

    for (const chunk of chunks) {
      for (const segment of splitShellCommands(stripTrailingComment(chunk))) {
        const invocation = /(?<![\w@/-])cdkd\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)\b([^\n]*)/g;
        let m: RegExpExecArray | null;
        while ((m = invocation.exec(segment)) !== null) {
          const command = resolveCommand((m[1] as string).split(/\s+/));
          const flags = [...(m[2] as string).matchAll(/(?:^|[\s`'"(])(--[a-z][a-z0-9-]*)/g)].map(
            (f) => f[1] as string
          );
          const arm = inFence ? 'fence' : 'inline';
          if (flags.length === 0) out.push({ command, flag: undefined, line, arm });
          for (const flag of flags) out.push({ command, flag, line, arm });
        }
      }
    }
  }
  return out;
}

describe('the distributed plugin skill advertises only flags the CLI has', () => {
  const text = readFileSync(PLUGIN_SKILL, 'utf8');
  const claims = advertisedFlags(text);

  it('sees its input — the page really does advertise commands and flags', () => {
    // A checker must prove it parsed something: "0 violations" and "parsed
    // nothing" are the same green otherwise. Floors per SHAPE, not one total.
    expect(
      claims.filter((c) => c.flag !== undefined).length,
      'no `cdkd <command> --flag` invocations parsed out of the plugin skill; this test is ' +
        'asserting nothing. Either the page stopped documenting commands, or the extractor ' +
        'stopped matching.'
    ).toBeGreaterThanOrEqual(8);

    const commands = new Set(claims.map((c) => c.command));
    expect(
      commands.size,
      `only ${commands.size} distinct command(s) parsed (${[...commands].join(', ')}); the page ` +
        'documents several, so the extractor is seeing a fraction of its input.'
    ).toBeGreaterThanOrEqual(3);

    // PER ARM, and per SHAPE within each arm. Measured today: fence 38 claims
    // / 18 flags, inline 36 claims / 6 flags. A claims-only floor is the trap
    // the aggregate one already was — inline yields 30 FLAGLESS claims, so its
    // flag extraction could die entirely and both the arm floor and the 8-flag
    // aggregate (covered by fence's 18 alone) would still pass.
    // Measured today: fence 38 claims / 18 flags, inline 36 / 6. The inline
    // FLAG floor is 2 rather than a proportional 4 because 4 of those 6 sit in
    // ONE bullet block — rewriting that section would red the arm with a
    // "flag extraction died" message that is not what happened.
    for (const [arm, minClaims, minFlags] of [
      ['fence', 12, 8],
      ['inline', 12, 2],
    ] as const) {
      const fromArm = claims.filter((c) => c.arm === arm);
      expect(
        fromArm.length,
        `the ${arm} arm parsed ${fromArm.length} claim(s). Each arm reads a different shape ` +
          '(fenced blocks vs inline `code` spans) and an aggregate floor is satisfied by the ' +
          'other one alone, so a dead arm is invisible without this.'
      ).toBeGreaterThanOrEqual(minClaims);
      expect(
        fromArm.filter((c) => c.flag !== undefined).length,
        `the ${arm} arm parsed no FLAGS (it did parse ${fromArm.length} claims). A flagless ` +
          'claim still clears a claims-only floor, so flag extraction can die on one arm while ' +
          'every other floor passes.'
      ).toBeGreaterThanOrEqual(minFlags);
    }

    // And the tree itself must be non-trivial, or every lookup below would
    // resolve against an empty map and the flag check would be vacuous.
    expect(specs.size, 'buildProgram() produced no command specs').toBeGreaterThanOrEqual(10);
  });

  it('every advertised flag exists on the command it is advertised for', () => {
    const unknown = claims.filter(({ command, flag }) => {
      if (flag === undefined) return false; // a flagless invocation: the command case judges it
      if (!specs.has(command)) return false; // command coverage is the next case's job
      // `acceptedFlagsFor` walks EVERY ancestor, not just own + root. That
      // distinction is not hypothetical: the module added it because own+root
      // "produced false positives on all five `events prune` call sites" --
      // `--state-bucket` is declared on the `events` parent.
      return !acceptedFlagsFor(command, specs).has(flag);
    });

    expect(
      unknown.map((u) => `${PLUGIN_SKILL.slice(repoRoot.length + 1)}:${u.line} cdkd ${u.command} ${u.flag}`),
      'the distributed plugin skill advertises flags the CLI does not accept on those commands. ' +
        'An agent following the page hits `unknown option` (go-to-k/cdkd#2673). Fix the page: ' +
        'drop the flag, or attach it to a command that declares it.'
    ).toEqual([]);
  });

  it('every flag it names ANYWHERE exists somewhere in the CLI', () => {
    // The attached-to-a-command set is the smaller half: 19 flags appear in
    // inline spans against 13 distinct attached ones, and 10 are bare-ONLY. A
    // flag removed from the CLI leaves those reading as current.
    //
    // This deliberately asks the WEAKER question — does any command declare
    // it — because prose does not say which command a flag belongs to; the
    // attached case above is what pins that.
    //
    // Scanning INSIDE a span, not requiring the flag to fill one: the first
    // cut used /`(--flag)`/ and so missed `--older-than 30d`, `--dry-run
    // --fail`, `--all` and `--json`, leaving `--older-than` the single flag on
    // the page NO check covered. The backtick requirement itself is
    // load-bearing and stays — it is what keeps `npm install --global` out,
    // since that lives in a FENCE rather than a span.
    const everyFlag = new Set(
      [...text.matchAll(/`[^`\n]*?(--[a-z][a-z0-9-]*)/g)].map((m) => m[1] as string)
    );
    expect(
      everyFlag.size,
      `only ${everyFlag.size} inline flag span(s) parsed; 23 are measured, so the extractor is ` +
        'seeing a fraction of its input.'
    ).toBeGreaterThanOrEqual(18);

    const everyKnownFlag = new Set<string>();
    for (const spec of specs.values()) for (const f of spec.longFlags) everyKnownFlag.add(f);
    const unknown = [...everyFlag].filter((f) => !everyKnownFlag.has(f));
    expect(
      unknown,
      `the plugin skill names flag(s) no cdkd command declares: ${unknown.join(', ')}. A flag ` +
        'removed or renamed in src leaves the page advertising it.'
    ).toEqual([]);
  });

  it('every command it names exists in the CLI', () => {
    const missing = [
      ...new Set(
        claims.filter(({ command }) => !specs.has(command)).map(({ command }) => command)
      ),
    ];
    expect(
      missing,
      `the plugin skill names cdkd command(s) that do not exist: ${missing.join(', ')}. A command ` +
        'removed or renamed in src leaves this page telling an agent to run it.'
    ).toEqual([]);
  });
});
