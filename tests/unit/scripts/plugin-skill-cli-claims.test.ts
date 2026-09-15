import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildProgram } from '../../../src/cli/program.js';
import { collectCommandSpecs } from '../../../scripts/check-integ-cli-flags.ts';

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
 * Flags the page names that are NOT cdkd's own, with the reason each is
 * exempt. Listed rather than pattern-matched so a new foreign flag has to be
 * justified here instead of slipping through a regex.
 */
const NOT_CDKD_FLAGS = new Map<string, string>([
  // `cdk` (upstream) is named on the page for contrast with `cdkd`.
  ['--profile', 'upstream `cdk` / AWS CLI flag, named for contrast'],
]);

/**
 * Every `cdkd <command...> --flag` occurrence the page advertises, read from
 * CODE ONLY — fenced blocks and inline spans.
 *
 * Scoping to code is load-bearing, not tidiness: the first cut scanned whole
 * lines and pulled `version` and `does` out of ordinary prose ("cdkd does not
 * ...", "cdkd version"), which the command check then reported as missing
 * commands. A checker whose own extractor invents findings is worse than none
 * — the next reader learns to ignore it.
 */
function advertisedFlags(
  text: string
): Array<{ command: string; flag: string | undefined; line: number }> {
  const out: Array<{ command: string; flag: string | undefined; line: number }> = [];
  const lines = text.split('\n');
  let inFence = false;

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    // Inside a fence the whole line is code; outside, only inline spans are.
    const codeChunks = inFence
      ? [line]
      : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);

    for (const chunk of codeChunks) {
      // `(?<![\w@/-])` so the package NAME does not match: `npm view
      // @go-to-k/cdkd version engines` contains the literal `cdkd version`,
      // and the first cut reported `version` as a missing cdkd command. A
      // checker that invents findings teaches the next reader to ignore it.
      const invocation = /(?<![\w@/-])cdkd\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)\b([^\n]*)/g;
      let m: RegExpExecArray | null;
      while ((m = invocation.exec(chunk)) !== null) {
        const words = (m[1] as string).split(/\s+/);
        const tail = m[2] as string;
        // Resolve the deepest path the tree knows: `state orphan` is two
        // words, `deploy` is one.
        const two = words.join(' ');
        const command = specs.has(two) ? two : (words[0] as string);
        // The command is recorded even with NO flags. The first cut pushed
        // only (command, flag) pairs, so a flagless invocation of a
        // nonexistent command was invisible and the command case was vacuous
        // — probed: `cdkd nosuchcmd <stack>` passed.
        const flags = [...tail.matchAll(/(?:^|[\s`'"(])(--[a-z][a-z0-9-]*)/g)].map(
          (f) => f[1] as string
        );
        if (flags.length === 0) {
          out.push({ command, flag: undefined, line: i + 1 });
        }
        for (const flag of flags) out.push({ command, flag, line: i + 1 });
      }
    }
  });
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

    // And the tree itself must be non-trivial, or every lookup below would
    // resolve against an empty map and the flag check would be vacuous.
    expect(specs.size, 'buildProgram() produced no command specs').toBeGreaterThanOrEqual(10);
  });

  it('every advertised flag exists on the command it is advertised for', () => {
    const unknown = claims.filter(({ command, flag }) => {
      if (flag === undefined) return false; // a flagless invocation: the command case judges it
      if (NOT_CDKD_FLAGS.has(flag)) return false;
      const spec = specs.get(command);
      if (!spec) return false; // command coverage is the next case's job
      // A flag counts when the command OR the root declares it, matching
      // Commander's own lookup for program-level options.
      return !spec.longFlags.has(flag) && !specs.get('')?.longFlags.has(flag);
    });

    expect(
      unknown.map((u) => `${PLUGIN_SKILL.slice(repoRoot.length + 1)}:${u.line} cdkd ${u.command} ${u.flag}`),
      'the distributed plugin skill advertises flags the CLI does not accept on those commands. ' +
        'An agent following the page hits `unknown option` (go-to-k/cdkd#2673). Fix the page, or ' +
        'add the flag to NOT_CDKD_FLAGS with the reason it is not cdkd\'s.'
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
