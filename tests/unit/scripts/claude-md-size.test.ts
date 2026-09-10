import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A DOWN-ONLY byte ceiling on the context CLAUDE.md injects, and a fence on
 * the one escape hatch that ceiling cannot see.
 *
 * CLAUDE.md is injected into every session, so its size is a per-session token
 * cost paid by every lane whether or not it reads a single rule. Every other
 * agent-instruction surface in this repo is already bounded -- `.claude/rules/**`
 * by `rule-file-payload.test.ts` (per-file cap, payload budgets, corpus floor),
 * `.claude/skills/**` by `skill-file-payload.test.ts`, a changelog entry by
 * `changelog-entry-size.test.ts` -- and CLAUDE.md alone had no budget at all.
 * That gap is not theoretical:
 *
 *   2026-09-04  go-to-k/cdkd#2493 compressed it   82,723 B -> 42,351 B
 *   2026-09-10  six days later                              53,109 B
 *
 * +25% in six days, and the additions were almost entirely one new paragraph
 * per new hook or gate. A file with no ceiling regrows to whatever the last
 * lane needed; the 2026-09-04 pass proved that compressing WITHOUT a ceiling
 * buys about a week.
 *
 * NO CURRENT-SIZE FIGURE IS RECORDED HERE, deliberately, per the convention
 * `rule-file-payload.test.ts` states at its `PAYLOAD_BUDGETS` table: a "now"
 * figure drifts on every edit to the file it describes, and it drifted twice
 * inside go-to-k/cdkd#2878 alone. The dated anchors above are history and
 * cannot rot; the live values come from `wc -c`, and the bands below are the
 * enforcement.
 *
 * WHY DOWN-ONLY: the same shape as `LEGACY_LONG_LINE_BUDGET` in
 * `rule-file-payload.test.ts`. A ceiling a lane may raise to fit its own
 * addition is not a ceiling -- raising it is strictly easier than compressing,
 * so it is what every lane would do. Lower these numbers when a pass wins
 * bytes back; never raise them.
 *
 * WHAT TO DO WHEN THIS REDS -- in this order:
 *   1. Cut RATIONALE, not the directive. Dates, PR/issue numbers used as
 *      evidence, "measured 2026-xx-xx", incident retellings: move them to the
 *      issue or PR that established them, where they stay dated. CLAUDE.md's
 *      `aws-cdk-lib` bullet is the worked example of this split.
 *   2. Check whether a HOOK already delivers the rule at the moment of the
 *      action. `verify-pr-gate.sh`, `ci-green-gate.sh`, `worktree-owner-gate.sh`
 *      and the one-shot foot-gun gates all print an actionable block, so
 *      CLAUDE.md needs the pointer, not the full text.
 *   3. Move PATH-TRIGGERED detail to `.claude/rules/` -- but only if a `paths:`
 *      glob genuinely fires when the rule is needed. It must fire on the file
 *      whose editing needs the rule, NOT on the file that documents it.
 *      Action-triggered rules (commit / merge / wrap) have no such glob and
 *      must stay resident.
 *
 * Do NOT satisfy this by deleting a link: `rule-file-payload.test.ts` walks
 * reachability from CLAUDE.md, and an orphaned satellite reds that suite.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const MAX_CLAUDE_MD_BYTES = 46_980;

/**
 * `## Workflow Rules` is the section that grows: it took 62% of the file at
 * the 53,109 B peak, and every gate added since the 2026-09-04 compression
 * landed in it. Bounding the file alone would let this section grow by
 * shrinking the reference sections, which are the parts a reader needs least
 * often but can least afford to lose.
 */
const MAX_WORKFLOW_RULES_BYTES = 26_480;

/**
 * CLAUDE.md plus every rule file that loads ONLY with it (see
 * `INJECTED_ONLY_RULES`).
 *
 * SAY WHAT THIS DOES AND NOT MORE. A relocation from CLAUDE.md into
 * `session-report.md` is byte-NEUTRAL for this sum, so the band's verdict is
 * identical before and after: what it buys is that the move gains NOTHING here,
 * not that the move is detected. An earlier revision claimed it "makes the move
 * cost what it saves", and two reviewers independently walked the same
 * counter-example -- add a paragraph, then relocate it, and all three ceilings
 * go green with the text no longer loading. The claim was the defect, in the
 * same shape as the ordering case's first cut: a guard whose comparand does not
 * test the property its comment asserts.
 *
 * What DOES bound the relocation is this band being the TIGHTEST of the three
 * (asserted below against live sizes), so a net addition trips it before the
 * file ceiling and cannot be laundered by moving the bytes sideways. Whether
 * the relocated text still LOADS is a different question, and the
 * injected-only sweep further down is what answers it.
 */
const MAX_INJECTED_CONTEXT_BYTES = 65_180;

/**
 * `## Workflow Rules` must keep at least this many top-level `- **` bullets.
 *
 * Every bound above is a CEILING, and a ceiling is satisfied by DELETION as
 * happily as by compression -- deleting a whole gate entry improves all three
 * and leaves the ordering invariant untouched. The header's first instruction
 * is "cut RATIONALE, not the directive", and nothing enforced it. A count of
 * directives is the right shape for that: compression cannot move it, and
 * deletion cannot avoid it. Only about three of these bullets are pinned
 * elsewhere (by `cross-cutting-list-sync.test.ts` and
 * `changelog-entry-policy-sync.test.ts`), so the rest had no floor at all.
 *
 * Genuinely retiring a rule is legal -- lower this by exactly one, in the
 * commit that retires it, and say which.
 */
const MIN_WORKFLOW_RULE_BULLETS = 29;

/**
 * Paths the harness INJECTS into the system prompt rather than reading through
 * a file tool. A `.claude/rules/` file loads when its `paths:` glob matches a
 * file that enters context THROUGH A FILE TOOL (`.claude/rules/hooks.md`,
 * CLAUDE.md's bash-first bullet, and `rule-file-payload.test.ts`'s own header
 * all state this), so a rule whose ONLY glob is an injected path never
 * auto-loads in an ordinary session -- it loads only in a session that happens
 * to open that file, which for CLAUDE.md means a CLAUDE.md-maintenance session:
 * exactly inverted from when a wrap-report spec is needed.
 */
const INJECTED_NOT_READ: readonly string[] = ['CLAUDE.md'];

/**
 * Compare globs by a normalized form, not by string identity: `./CLAUDE.md` and
 * `**\/CLAUDE.md` both match the same injected file while failing an exact
 * compare, and each would drop a rule out of the sweep SILENTLY -- the
 * looks-covered-but-is-not direction this whole file exists to remove.
 */
const normalizeGlob = (g: string): string =>
  g.replace(/\/{2,}/g, '/').replace(/^(?:\.\/|\*\*\/|\/)+/, '');

const isInjectedGlob = (g: string): boolean => INJECTED_NOT_READ.includes(normalizeGlob(g));

/**
 * The rules that are injected-only, each mapped to the file that MUST tell a
 * reader to open it explicitly. An entry here is not an exemption -- it is a
 * requirement that the compensating instruction exists, checked below. Adding
 * a rule here without wiring its reader is what this table exists to prevent.
 */
const INJECTED_ONLY_RULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'session-report.md',
    // EVERY entry point that requires a wrap report. Listing only one would let
    // the others lose their pointer silently, which is the defect this table is
    // about -- `/work-issues` and `/hunt-bugs` both had exactly that gap when
    // the table was written. The list is not trusted: the case below DERIVES it
    // from the skill corpus and refuses a mismatch in either direction.
    [
      '.claude/skills/verify-pr/SKILL.md',
      '.claude/skills/work-issues/SKILL.md',
      '.claude/skills/hunt-bugs/SKILL.md',
    ],
  ],
];

const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');
const bytes = (relative: string): number => Buffer.byteLength(read(relative), 'utf8');

/**
 * The lines of `text` that are NOT inside a fenced code block, CommonMark-style.
 *
 * A toggle-on-any-marker scan is not enough, and the delta that introduced one
 * is where this came from: a marker of the OTHER type inside a block is
 * CONTENT, so ```` ```text ``` ```` wrapping a `~~~` made the scan think the
 * block had closed, and a directive-shaped line after it counted. Measured: one
 * real directive deleted plus such a block at the bottom of the section left
 * the count at the floor. The same shape hides behind a longer opener
 * (` ```` ` closed by ` ``` `) and a closing marker carrying an info string.
 *
 * So: a fence opens on 3+ backticks or tildes indented at most 3 spaces, and
 * closes ONLY on the same character, at least as long, with nothing after it.
 * An opening BACKTICK fence may not carry a backtick in its info string.
 */
function unfencedIndices(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  let open: { char: string; len: number } | null = null;
  lines.forEach((line, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      if (m !== null && !(m[1].startsWith('`') && m[2].includes('`'))) {
        open = { char: m[1][0], len: m[1].length };
        return;
      }
      out.add(i);
      return;
    }
    // Only SPACES and TABS may follow a closing fence. `trim()` would also
    // accept NBSP and form feed, closing a block CommonMark keeps open — the
    // loosening direction, which is the one that hides a bullet.
    if (m !== null && m[1][0] === open.char && m[1].length >= open.len && /^[ \t]*$/.test(m[2])) {
      open = null;
    }
  });
  return out;
}

/**
 * The `## Workflow Rules` heading up to the NEXT `## ` heading, or EOF, as RAW
 * text -- the ceilings measure bytes, so a fenced block's bytes must count.
 * Only the HEADINGS are located fence-awarely: a `## ` line inside a fence
 * would otherwise truncate the slice and silently shrink every byte reading.
 */
function workflowRulesSection(text: string): string {
  const lines = text.split('\n');
  const unfenced = unfencedIndices(lines);
  const start = lines.findIndex((l, i) => unfenced.has(i) && l.startsWith('## Workflow Rules'));
  expect(
    start,
    'CLAUDE.md: no `## Workflow Rules` heading. The section was renamed or removed — ' +
      'this budget names it explicitly, so re-point the constant rather than deleting the case.',
  ).toBeGreaterThanOrEqual(0);
  // Bounded at the next heading rather than sliced to EOF: Workflow Rules is
  // last today, and if a section is ever appended after it those bytes would
  // otherwise be blamed on this ceiling, whose message names a cause they would
  // not have.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (unfenced.has(i) && lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  // `split('\n')` on a file ending in a newline leaves a trailing '' element.
  // In the EOF branch that element is INSIDE the slice, so `join` already ends
  // in a newline and appending one adds a phantom byte -- which would make this
  // refactor silently NOT byte-neutral, and would show up as the section
  // shrinking by one the day a heading is appended after Workflow Rules and the
  // other branch takes over. Measured: 28,074 vs 28,073 before the pop.
  // ...and ONLY in that branch. In the next-heading branch the last element is
  // a genuine blank line before the heading -- the shape a formatter produces --
  // and `slice.at(-1) === ''` cannot tell the two apart, so an unconditional pop
  // does not remove the off-by-one, it MOVES it onto the branch that takes over
  // the day a section is appended after Workflow Rules.
  const slice = lines.slice(start, end);
  if (end === lines.length && slice.at(-1) === '') slice.pop();
  return `${slice.join('\n')}\n`;
}

/** The section's top-level directives — `- **` lines outside any fenced block. */
function workflowRuleBullets(text: string): number {
  const lines = workflowRulesSection(text).split('\n');
  const unfenced = unfencedIndices(lines);
  return lines.filter((l, i) => unfenced.has(i) && l.startsWith('- **')).length;
}

/** The `paths:` globs a rule file declares, in declaration order. */
function pathsGlobs(ruleText: string): string[] {
  const fm = /^---\n([\s\S]*?)\n---/.exec(ruleText);
  if (fm === null) return [];
  const lines = fm[1].split('\n');
  const start = lines.findIndex((l) => /^paths:\s*$/.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A comment or a blank line inside the block is SKIPPED, not a terminator.
    // Breaking on it truncates the list, and a truncated list is a SUBSET --
    // which is the dangerous direction here, because `every(isInjected)` over a
    // subset can be true when it is false over the whole. Two real files hit
    // this: `hooks-main-tree-edit.md` and `layout-deployment-secrets.md`.
    if (/^\s*(#|$)/.test(line)) continue;
    // Only a line at column 0 ends the block -- that is the next mapping key.
    if (/^\S/.test(line)) break;
    // Strip an UNQUOTED trailing comment before matching. Without this,
    // `  - 'CLAUDE.md'  # injected` fails the item regex and is dropped -- and
    // the drop is invisible, because the file still yields its OTHER globs, so
    // the "every rule file parses" case below stays green while the sweep sees
    // a SUBSET. Same class as the comment-line bug, one level in.
    // The comment must be preceded by WHITESPACE to count as one -- YAML keeps
    // `a#b.md` and `a.md#` whole, and stripping there would silently shorten a
    // real path.
    const uncommented =
      /^(\s+-\s*(?:'[^']*'|"[^"]*"|[^'"#]*?))(?:\s+#.*)?\s*$/.exec(line)?.[1] ?? line;
    const item = /^\s+-\s*['"]?([^'"]+?)['"]?\s*$/.exec(uncommented);
    if (item === null) continue;
    const value = item[1];
    // Refuse anything that is not a path VALUE. A block scalar indicator
    // (`>-`, `|`, `>`) and a whitespace-only remainder (`  - `, `  -   # c`)
    // both parse to a NON-EMPTY array, so the parse guard below cannot see
    // them, and neither is in INJECTED_NOT_READ -- which silently classifies
    // the rule as NOT injected-only. That is the dangerous direction.
    if (value.trim() === '' || /^[>|]/.test(value)) continue;
    out.push(value);
  }
  return out;
}

describe('CLAUDE.md size budget', () => {
  it('stays under the down-only whole-file ceiling', () => {
    const size = bytes('CLAUDE.md');
    expect(
      size,
      `CLAUDE.md is ${size} B, over the down-only ceiling of ${MAX_CLAUDE_MD_BYTES} B. ` +
        'It is injected into EVERY session, so this is a token cost every lane pays. ' +
        'Do not raise the constant — cut rationale (dates, issue numbers, incident retellings) ' +
        'to the issue that established it, point at the hook that already delivers the rule at ' +
        'the moment of the action, or move PATH-TRIGGERED detail to a `.claude/rules/` file whose ' +
        '`paths:` glob genuinely fires when the rule is needed. See this file’s header.',
    ).toBeLessThanOrEqual(MAX_CLAUDE_MD_BYTES);
  });

  it('keeps `## Workflow Rules` under its own down-only ceiling', () => {
    const size = Buffer.byteLength(workflowRulesSection(read('CLAUDE.md')), 'utf8');
    expect(
      size,
      `CLAUDE.md’s \`## Workflow Rules\` section is ${size} B, over the down-only ceiling of ` +
        `${MAX_WORKFLOW_RULES_BYTES} B. This is the section that regrows — one paragraph per new ` +
        'hook or gate. A new gate entry earns its bytes by compressing the entries beside it, ' +
        'not by widening the section.',
    ).toBeLessThanOrEqual(MAX_WORKFLOW_RULES_BYTES);
  });

  it('gives the section ceiling LESS headroom than the file ceiling, so it can fire alone', () => {
    // The two ceilings are not independent -- the section is part of the file --
    // so whichever has less headroom fires first. If that is the FILE ceiling,
    // growth in the section this budget exists to bound reports the generic
    // message and the specific one can never speak.
    //
    // Comparing the CONSTANTS is not this property and cannot fail: the section
    // constant is necessarily the smaller number. It must be measured against
    // the live sizes. A first cut compared the constants, and review showed it
    // passed for the exact mis-calibration the probe had caught (45 B of file
    // headroom against 60 B of section headroom).
    const text = read('CLAUDE.md');
    const fileHeadroom = MAX_CLAUDE_MD_BYTES - Buffer.byteLength(text, 'utf8');
    const sectionHeadroom =
      MAX_WORKFLOW_RULES_BYTES - Buffer.byteLength(workflowRulesSection(text), 'utf8');
    expect(
      sectionHeadroom,
      `the \`## Workflow Rules\` ceiling has ${sectionHeadroom} B of headroom and the whole-file ` +
        `ceiling has ${fileHeadroom} B. The section ceiling must be the tighter of the two, or ` +
        'growth inside Workflow Rules trips the whole-file case first and reports a cause it ' +
        'does not have. Only ONE edit can reach this: growth OUTSIDE the section, which eats ' +
        'file headroom while leaving section headroom alone. (Growth INSIDE the section moves ' +
        'both by the same amount, so it cannot change their difference — it reds the section ' +
        'case instead.) So the remedy is to compress the text you added outside Workflow Rules. ' +
        'Tightening `MAX_WORKFLOW_RULES_BYTES` would restore the ordering without removing a ' +
        'byte, and raising the file ceiling is never the answer.',
    ).toBeLessThan(fileHeadroom);
  });

  it('bounds CLAUDE.md together with the rules that load only with it', () => {
    const names = INJECTED_ONLY_RULES.map(([name]) => name);
    const total =
      bytes('CLAUDE.md') + names.reduce((a, n) => a + bytes(join('.claude', 'rules', n)), 0);
    expect(
      total,
      `CLAUDE.md plus its injected-only rules (${names.join(', ')}) is ${total} B, over the ` +
        `down-only ceiling of ${MAX_INJECTED_CONTEXT_BYTES} B. Relocating text between the two ` +
        'does not move this number — that is the point: the move buys nothing here, so the ' +
        'bytes have to actually go. This band is tighter than the whole-file ceiling, so that ' +
        'one may never speak — the remedy list is the same one in this file’s header: cut ' +
        'rationale to the issue that ' +
        'established it, point at the hook that already delivers the rule, or move ' +
        'PATH-TRIGGERED detail to a `.claude/rules/` file whose glob genuinely fires.',
    ).toBeLessThanOrEqual(MAX_INJECTED_CONTEXT_BYTES);
  });

  it('keeps the combined band tighter than the whole-file ceiling', () => {
    // CALIBRATION, and there is exactly ONE inequality here even though it has
    // two readings. `combinedHeadroom < fileHeadroom` and
    // `MAX_INJECTED_CONTEXT_BYTES < MAX_CLAUDE_MD_BYTES + ruleBytes` are the
    // same statement -- `bytes('CLAUDE.md')` cancels -- so they red and green
    // together on every tree. An earlier revision shipped BOTH as separate
    // cases, which is a duplicate wearing two names, not two guards.
    //
    // What it buys, in the two readings:
    //  - the band is the tighter bound, so an addition that fits under the file
    //    ceiling cannot be laundered by relocating it into an injected-only
    //    rule (the round-3 blocker: at 505 B of band headroom against 362 B of
    //    file headroom, add-then-move went green on every case);
    //  - the band stays REACHABLE. Dropping a rule from INJECTED_ONLY_RULES is
    //    the correct remedy once it gains a real glob, and it removes that
    //    rule's bytes from the sum -- which would otherwise leave a ceiling
    //    nothing can trip.
    //
    // NOTE what cannot red it: growth in CLAUDE.md, for the same cancellation.
    // That is the plain combined CEILING's job, above.
    const names = INJECTED_ONLY_RULES.map(([name]) => name);
    const ruleBytes = names.reduce((a, n) => a + bytes(join('.claude', 'rules', n)), 0);
    expect(
      MAX_INJECTED_CONTEXT_BYTES,
      `the combined band (${MAX_INJECTED_CONTEXT_BYTES} B) must stay under the whole-file ` +
        `ceiling plus the injected-only rules (${MAX_CLAUDE_MD_BYTES} + ${ruleBytes} = ` +
        `${MAX_CLAUDE_MD_BYTES + ruleBytes} B), or it is both the looser bound and an ` +
        'unreachable one. Growth in CLAUDE.md cannot cause this. FOUR things can: a rule ' +
        'leaving INJECTED_ONLY_RULES; an injected-only rule being COMPRESSED; ' +
        '`MAX_CLAUDE_MD_BYTES` being ratcheted DOWN, which this file tells you to do after a ' +
        'compression pass; and this constant being RAISED — which down-only forbids, and which ' +
        'is the likeliest way to arrive here, because it is what a lane reaching for room does ' +
        'after the combined ceiling reds. Lower `MAX_INJECTED_CONTEXT_BYTES` to at most that ' +
        'sum minus one.',
    ).toBeLessThan(MAX_CLAUDE_MD_BYTES + ruleBytes);
  });

  it('keeps at least the recorded number of Workflow Rules directives', () => {
    // Fence-aware: a `- **` line inside a fenced block is an EXAMPLE, and
    // counting it would let a lane satisfy the floor without adding a rule.
    const bullets = workflowRuleBullets(read('CLAUDE.md'));
    expect(
      bullets,
      `\`## Workflow Rules\` has ${bullets} top-level directives, under the floor of ` +
        `${MIN_WORKFLOW_RULE_BULLETS}. Every other bound here is a ceiling, and a ceiling is met ` +
        'by DELETION as easily as by compression — this is the one that is not. Cut rationale, ' +
        'not directives. If a rule is genuinely being retired, lower the floor by exactly one ' +
        'in that same commit and say which rule went. A count far below the floor (0, say) is ' +
        'more likely an UNCLOSED or mismatched code fence in the section than a mass deletion: ' +
        'the counter toggles on ``` and ~~~, so an unbalanced one hides every directive after it.',
    ).toBeGreaterThanOrEqual(MIN_WORKFLOW_RULE_BULLETS);
  });
});

describe('rules that can only load with an injected file', () => {
  const ruleFiles = readdirSync(join(repoRoot, '.claude', 'rules')).filter((f) =>
    f.endsWith('.md'),
  );

  it('finds the rule corpus (guards against a vacuous sweep)', () => {
    expect(
      ruleFiles.length,
      '.claude/rules/ has no .md files — the sweep below proves nothing',
    ).toBeGreaterThan(20);
  });

  it('parses a `paths:` glob out of EVERY rule file', () => {
    // Without this, the sweep below reads a parse failure as "not injected-only"
    // and skips the file silently -- so re-spelling a glob in YAML flow style
    // (`paths: ['CLAUDE.md']`, same meaning) removes a rule from the sweep
    // rather than failing it. The count guard above cannot see that: it counts
    // FILES, not parses.
    const unparsed = ruleFiles.filter(
      (f) => pathsGlobs(read(join('.claude', 'rules', f))).length === 0,
    );
    expect(
      unparsed,
      'these rule files yielded no `paths:` glob. Either they declare none (every rule file ' +
        'must, or it never loads), or `pathsGlobs()` cannot read the spelling they use — and a ' +
        'file it cannot read is one the injected-only sweep below silently skips.',
    ).toEqual([]);
  });

  it('lists every injected-only rule in INJECTED_ONLY_RULES', () => {
    const declared = new Set(INJECTED_ONLY_RULES.map(([name]) => name));
    const injectedOnly = ruleFiles.filter((f) => {
      const globs = pathsGlobs(read(join('.claude', 'rules', f)));
      return globs.length > 0 && globs.every(isInjectedGlob);
    });
    expect(
      injectedOnly.filter((f) => !declared.has(f)),
      `these rule files declare no \`paths:\` glob other than ${INJECTED_NOT_READ.join(', ')}, ` +
        'which the harness INJECTS rather than reading through a file tool — so they never ' +
        'auto-load in an ordinary session. Either give the file a glob that fires when its ' +
        'content is needed, or add it to INJECTED_ONLY_RULES naming the skill that tells a ' +
        'reader to open it.',
    ).toEqual([]);
    // Staleness, the other direction: an entry whose file gained a real glob is
    // no longer injected-only, and leaving it listed would keep a compensating
    // instruction alive for a problem that is gone.
    expect(
      INJECTED_ONLY_RULES.map(([name]) => name).filter((n) => !injectedOnly.includes(n)),
      'these INJECTED_ONLY_RULES entries are stale — the file is gone, or it now declares a ' +
        'glob that fires on its own. Drop the entry.',
    ).toEqual([]);
  });

  it('derives the wrap-report reader set rather than trusting the table', () => {
    // The table above CLAIMS to list every entry point. A claim in a comment is
    // the shape this whole file exists to replace, so it is derived instead:
    // every orchestrator that demands a wrap report is a reader, and the two
    // sets must agree in BOTH directions -- a new skill demanding one, or a
    // skill that stopped, each reds here.
    const skillsDir = join(repoRoot, '.claude', 'skills');
    const demanders = readdirSync(skillsDir)
      .map((name) => join('.claude', 'skills', name, 'SKILL.md'))
      .filter((rel) => {
        let text: string;
        try {
          text = read(rel);
        } catch {
          return false;
        }
        return /Session close|wrap[- ]report|Remaining work|four TODO fields/i.test(text);
      });
    expect(
      demanders.length,
      'no SKILL.md demands a wrap report — the derivation stopped matching, so the comparison ' +
        'below would pass vacuously',
    ).toBeGreaterThan(0);
    const declared = INJECTED_ONLY_RULES.find(([n]) => n === 'session-report.md')?.[1] ?? [];
    expect(
      [...demanders].sort(),
      'the skills that demand a wrap report and the readers declared for `session-report.md` ' +
        'must be the same set. A skill in the DERIVED list only has no pointer to the rule that ' +
        'defines the fields — add one. A skill in the DECLARED list only means the derivation ' +
        'stopped matching it: check whether that skill genuinely stopped demanding a wrap ' +
        'report before dropping the entry, because the match is on wording ("Session close", ' +
        '"wrap report", "Remaining work", "four TODO fields") and a REWORD looks identical here ' +
        'to a retirement. Dropping the entry on a reword deletes the only pointer delivering an ' +
        '18 KB rule.',
    ).toEqual([...declared].sort());
  });

  it('requires each injected-only rule to be named by every file that must open it', () => {
    for (const [name, readers] of INJECTED_ONLY_RULES) {
      expect(readers.length, `INJECTED_ONLY_RULES: ${name} lists no reader`).toBeGreaterThan(0);
      for (const reader of readers) {
        let text: string;
        try {
          text = read(reader);
        } catch {
          // A raw ENOENT here loses the guiding message and reads as a broken
          // test rather than a broken table.
          throw new Error(
            `INJECTED_ONLY_RULES names \`${reader}\` as a reader of \`${name}\`, but that file ` +
              'does not exist. It was renamed or removed — re-point the entry, or drop it if ' +
              'nothing demands the rule any more.',
          );
        }
        expect(
          text,
          `${reader} must name \`.claude/rules/${name}\` explicitly — that rule's own \`paths:\` ` +
            'glob cannot fire when it is needed, so an explicit Read is the only thing that ' +
            'delivers it.',
        ).toContain(`.claude/rules/${name}`);
      }
    }
  });
});

/**
 * The two helpers above decide every byte and every count this file asserts,
 * and on the LIVE tree they exercise almost none of their own branches: the
 * section has no fenced block, and it is the last heading in the file. Six
 * review rounds each found a defect in one of them, and NONE was caught by a
 * case -- reverting any of those fixes left the whole suite green, because the
 * inputs that discriminate do not exist in CLAUDE.md yet. These cases supply
 * them, so the next edit to a helper is answered by a test rather than by a
 * reviewer.
 */
describe('the section and fence helpers', () => {
  const section = (body: string): string => workflowRulesSection(body);

  it('measures the EOF branch without a phantom byte', () => {
    // `split('\n')` leaves a terminator element; joining it back adds a newline
    // the file never had.
    expect(section('# T\n\n## Workflow Rules\n- **a**: x\n')).toBe('## Workflow Rules\n- **a**: x\n');
  });

  it('keeps a genuine blank line before the NEXT heading', () => {
    // The shape a formatter produces, and the one an unconditional pop breaks:
    // that blank line is section content, not a terminator.
    expect(section('## Workflow Rules\n- **a**: x\n\n## Next\nz\n')).toBe(
      '## Workflow Rules\n- **a**: x\n\n',
    );
  });

  it('does not let a heading inside a fence truncate the section', () => {
    // A fence-unaware end-scan truncates THIS input at the opening fence — 26 B
    // of 58. CLAUDE.md has no heading after Workflow Rules yet, so the live
    // file cannot exhibit it, which is exactly why the case is synthetic.
    const body = '## Workflow Rules\n```text\n## Not a heading\n```\n- **a**: x\n';
    expect(section(body)).toBe(body);
  });

  it('treats a marker of the OTHER type inside a block as content', () => {
    // CommonMark: only the same character closes. A ```-or-~~~ toggle read the
    // inner `~~~` as a close and counted the bullet after it.
    const lines = '```text\n~~~\n- **fake**: x\n```\n- **real**: y\n'.split('\n');
    const unfenced = unfencedIndices(lines);
    expect(lines.filter((l, i) => unfenced.has(i) && l.startsWith('- **'))).toEqual([
      '- **real**: y',
    ]);
  });

  it('requires the closing fence to be at least as long as the opener', () => {
    const lines = '````text\n```\n- **fake**: x\n````\n- **real**: y\n'.split('\n');
    const unfenced = unfencedIndices(lines);
    expect(lines.filter((l, i) => unfenced.has(i) && l.startsWith('- **'))).toEqual([
      '- **real**: y',
    ]);
  });

  it('does not accept an info string, NBSP or form feed as a closing fence', () => {
    // `trim()` strips NBSP and form feed, which would close a block CommonMark
    // keeps open -- the loosening direction, the one that hides a bullet.
    for (const closer of ['``` text', '```\u00a0', '```\f']) {
      const lines = `\`\`\`text\nx\n${closer}\n- **fake**: y\n`.split('\n');
      const unfenced = unfencedIndices(lines);
      expect(
        lines.filter((l, i) => unfenced.has(i) && l.startsWith('- **')),
        `${JSON.stringify(closer)} must NOT close the block`,
      ).toEqual([]);
    }
    // ...while spaces and tabs, which CommonMark does allow, still close it.
    for (const closer of ['```', '``` ', '```\t']) {
      const lines = `\`\`\`text\nx\n${closer}\n- **real**: y\n`.split('\n');
      const unfenced = unfencedIndices(lines);
      expect(
        lines.filter((l, i) => unfenced.has(i) && l.startsWith('- **')),
        `${JSON.stringify(closer)} must close the block`,
      ).toEqual(['- **real**: y']);
    }
  });

  it('refuses a backtick opener whose info string carries a backtick', () => {
    // CommonMark forbids it, so the line is ordinary text and the bullet after
    // it is a real one.
    const lines = '```a`b\n- **real**: x\n'.split('\n');
    const unfenced = unfencedIndices(lines);
    expect(lines.filter((l, i) => unfenced.has(i) && l.startsWith('- **'))).toEqual([
      '- **real**: x',
    ]);
  });
});
