/**
 * Issue [#2949](https://github.com/go-to-k/cdkd/issues/2949) —
 * `scripts/sync-backfill-subissues.ts`, the reconciler that makes the backfill
 * campaign's per-resource-type GitHub sub-issues equal to `main`'s coverage map.
 *
 * This is the first thing in the repository that CREATES, EDITS and CLOSES
 * public issues unattended, ~44 of them per run, on a `main` push. Nothing it
 * does is reviewed before it happens and no local run rehearses it, so the cases
 * below are weighted toward the mutations it must NOT make: minting a duplicate
 * set, closing a live campaign, and writing on a run where nothing changed.
 *
 * The decision half is pure, so it is driven directly. The `gh` half is driven
 * through the injected {@link Runner}, which records argv — asserting the
 * ARGUMENTS rather than a rendered command string, because the argv path is the
 * reason a multi-line issue body never reaches a shell.
 */
import { describe, it, expect } from 'vite-plus/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  MARKER_PREFIX,
  MARKER_SUFFIX,
  MAX_SUB_ISSUES,
  ReconcileRefusal,
  SUBISSUE_LABEL,
  applyAction,
  fetchExisting,
  linkSubIssue,
  planReconciliation,
  readMarkerType,
  renderIndex,
  type Action,
  type ExistingIssue,
  type Plan,
} from '../../../scripts/sync-backfill-subissues.ts';
import {
  KNOWN_FLAGS,
  RENDER_ONLY_FLAGS,
  UMBRELLA_EMPTY_SENTINEL,
  VALUELESS_FLAGS,
  renderSubIssueBody,
  renderSubIssuePlan,
  subIssueEffort,
  subIssueTypeMarker,
} from '../../../scripts/diagnose-schema-refresh.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A plan entry, with the body the real renderer would produce. */
const entry = (type: string, properties: string[]) => ({
  type,
  count: properties.length,
  title: `Backfill silent-drop properties: ${type}`,
  body: renderSubIssueBody({ type, properties }),
});

const planOf = (...entries: ReturnType<typeof entry>[]): Plan => ({ types: entries });

const existing = (
  number: number,
  type: string,
  properties: string[],
  state: 'OPEN' | 'CLOSED' = 'OPEN'
): ExistingIssue => ({
  number,
  state,
  title: `Backfill silent-drop properties: ${type}`,
  body: renderSubIssueBody({ type, properties }),
});

/** A runner that records argv and replays canned stdout, in order. */
function recorder(replies: string[] = []) {
  const calls: string[][] = [];
  let i = 0;
  const run = (args: string[]) => {
    calls.push(args);
    return replies[i++] ?? '';
  };
  return { run, calls };
}

describe('readMarkerType', () => {
  it('reads the type a generated body declares', () => {
    expect(readMarkerType(renderSubIssueBody({ type: 'AWS::S3::Bucket', properties: ['A'] }))).toBe(
      'AWS::S3::Bucket'
    );
  });

  it('survives the CRLF a web-UI edit stores', () => {
    // A body edited in the GitHub web UI comes back with CRLF, so the marker
    // line ends `-->\r` and a suffix test fails. That reads as "this issue has
    // no marker", which through the all-unmarked refusal either stops the run
    // or — with other issues matching — mints a duplicate for this one type.
    // Measured on this repository: 3 of the 100 most recent issue comments
    // carry CR. The parent splice's own `tr -d '\r'` exists for the same reason.
    const body = renderSubIssueBody({ type: 'AWS::S3::Bucket', properties: ['A'] }).replace(
      /\n/g,
      '\r\n'
    );
    expect(readMarkerType(body)).toBe('AWS::S3::Bucket');
  });

  it('ignores a marker QUOTED inside prose rather than starting a line', () => {
    // This repository's own documentation quotes the marker while explaining the
    // mechanism, and a review can quote a body back into a comment. Matching
    // mid-line would bind an issue to a type it merely mentions.
    //
    // The BEHAVIOUR is what is asserted; which clause rejects it is recorded in
    // `readMarkerType`'s own comment, because measuring it changed the answer:
    // relaxing `startsWith` to `includes` leaves this green (an equivalent
    // mutation — the fixed-offset slice shifts and fails the type class), so an
    // assertion claiming to fence the anchor would be claiming a fence it does
    // not have. The case below is the one that discriminates, and the
    // type-class case that follows is where the probe goes red.
    expect(readMarkerType(`see the ${subIssueTypeMarker('AWS::S3::Bucket')} marker`)).toBeUndefined();
    expect(readMarkerType(`  ${subIssueTypeMarker('AWS::S3::Bucket')}`)).toBeUndefined();
  });

  it('refuses a name outside the coverage map\'s own type class', () => {
    // The boundary pattern that produces these names admits letters, digits,
    // `_` and `:` only. Anything else is text shaped like a marker, and
    // accepting it would key a live issue to a string no plan can ever match —
    // so the issue never updates and never closes.
    expect(readMarkerType(`${MARKER_PREFIX}not a type!${MARKER_SUFFIX}`)).toBeUndefined();
    expect(readMarkerType(`${MARKER_PREFIX}lowercase::start${MARKER_SUFFIX}`)).toBeUndefined();
  });

  it('returns undefined for a body with no marker at all', () => {
    expect(readMarkerType('## Just an issue\n\nNothing here.')).toBeUndefined();
  });
});

describe('planReconciliation', () => {
  it('creates one issue per type on a first run', () => {
    const plan = planOf(entry('AWS::S3::Bucket', ['A', 'B']), entry('AWS::SNS::Topic', ['C']));
    expect(planReconciliation(plan, [])).toEqual([
      { kind: 'create', type: 'AWS::S3::Bucket', title: plan.types[0]!.title, body: plan.types[0]!.body },
      { kind: 'create', type: 'AWS::SNS::Topic', title: plan.types[1]!.title, body: plan.types[1]!.body },
    ]);
  });

  it('is a NO-OP when the issues already say what the plan says', () => {
    // The property that keeps this job from being noise. It fires on every
    // coverage-map push, and most pushes move one type — so a run that rewrote
    // all 44 bodies would bury the `updated_at` ordering every triage query
    // relies on under edits that changed nothing.
    const plan = planOf(entry('AWS::S3::Bucket', ['A']));
    expect(planReconciliation(plan, [existing(10, 'AWS::S3::Bucket', ['A'])])).toEqual([]);
  });

  it('is still a no-op when the stored body came back with CRLF', () => {
    // Otherwise an issue somebody once opened in the web UI reports as changed
    // on EVERY run, forever — a rewrite per push, per type touched.
    const plan = planOf(entry('AWS::S3::Bucket', ['A']));
    const issue = existing(10, 'AWS::S3::Bucket', ['A']);
    expect(planReconciliation(plan, [{ ...issue, body: issue.body.replace(/\n/g, '\r\n') }])).toEqual(
      []
    );
  });

  it('updates the body when the type gained or lost a property', () => {
    const plan = planOf(entry('AWS::S3::Bucket', ['A', 'B']));
    expect(planReconciliation(plan, [existing(10, 'AWS::S3::Bucket', ['A'])])).toEqual([
      {
        kind: 'update',
        number: 10,
        type: 'AWS::S3::Bucket',
        title: plan.types[0]!.title,
        body: plan.types[0]!.body,
      },
    ]);
  });

  it('REOPENS a closed type that regained a property, and refreshes it', () => {
    // The case the append model could not express at all, and the reason the
    // existing issues are fetched with `--state all`. Both actions, not just the
    // reopen: an issue reopened with its stale empty body says the opposite of
    // why it was reopened.
    const plan = planOf(entry('AWS::S3::Bucket', ['NewProp']));
    const actions = planReconciliation(plan, [existing(10, 'AWS::S3::Bucket', ['Old'], 'CLOSED')]);
    expect(actions.map((a) => a.kind)).toEqual(['reopen', 'update']);
  });

  it('closes an open type the plan no longer carries', () => {
    expect(planReconciliation(planOf(), [existing(10, 'AWS::S3::Bucket', ['A'])], true)).toEqual([
      { kind: 'close', number: 10, type: 'AWS::S3::Bucket' },
    ]);
  });

  it('leaves an ALREADY closed type alone', () => {
    // Re-closing is an API call that fails, and on the tolerant reading it is a
    // timeline entry per finished type per run, forever.
    expect(planReconciliation(planOf(), [existing(10, 'AWS::S3::Bucket', ['A'], 'CLOSED')], true))
      .toEqual([]);
  });

  it('orders every close LAST', () => {
    // A run that dies partway has then created and updated the types that gained
    // work before removing any that lost it. The other order can close a type's
    // issue and die before its replacement exists, which loses the only record
    // that the work was ever tracked.
    const plan = planOf(entry('AWS::SNS::Topic', ['C']));
    const actions = planReconciliation(
      plan,
      [existing(10, 'AWS::S3::Bucket', ['A']), existing(11, 'AWS::SQS::Queue', ['B'])],
      true
    );
    const kinds = actions.map((a) => a.kind);
    expect(kinds.filter((k) => k === 'close')).toHaveLength(2);
    expect(kinds.indexOf('create')).toBeLessThan(kinds.indexOf('close'));
  });

  describe('refusals — each guards a MUTATION, so none of them warns', () => {
    it('refuses an empty plan while sub-issues are open', () => {
      // "The campaign is finished" and "the parser stopped recognising
      // silentDrop" render identically as `types: []`, and
      // `parseSilentDropByType` throws only on zero type BOUNDARIES — a drifted
      // inner regex parses 44 types into 0 groups without erroring. Reading that
      // as finished mass-closes the whole campaign on a green run.
      expect(() => planReconciliation(planOf(), [existing(10, 'AWS::S3::Bucket', ['A'])])).toThrow(
        ReconcileRefusal
      );
      expect(() => planReconciliation(planOf(), [existing(10, 'AWS::S3::Bucket', ['A'])])).toThrow(
        /--allow-empty-plan/
      );
    });

    it('accepts an empty plan once the operator confirms it', () => {
      // The genuine end of the campaign happens once, ever. It must be
      // REPRESENTABLE — a refusal with no way through is how a finished campaign
      // would keep 44 issues open permanently.
      expect(planReconciliation(planOf(), [existing(10, 'AWS::S3::Bucket', ['A'])], true)).toEqual([
        { kind: 'close', number: 10, type: 'AWS::S3::Bucket' },
      ]);
    });

    it('accepts an empty plan with nothing open, without the flag', () => {
      // Nothing to mass-close, so there is nothing to confirm. Without this arm
      // the steady state AFTER a completed campaign would fail on every run.
      expect(
        planReconciliation(planOf(), [existing(10, 'AWS::S3::Bucket', ['A'], 'CLOSED')])
      ).toEqual([]);
    });

    it('refuses when labelled issues exist and NONE carries a readable marker', () => {
      // The duplicate-minting case. If the marker spelling drifts, every type
      // looks new: the run creates a second full set of ~44 issues and leaves
      // the originals open, which no later run can undo.
      const unmarked: ExistingIssue = {
        number: 10,
        state: 'OPEN',
        title: 'Backfill silent-drop properties: AWS::S3::Bucket',
        body: 'a body whose marker the reader no longer understands',
      };
      expect(() => planReconciliation(planOf(entry('AWS::S3::Bucket', ['A'])), [unmarked])).toThrow(
        /Creating one issue per type from here would duplicate/
      );
    });

    it('does NOT refuse on a first run, where there is nothing to duplicate', () => {
      // Zero existing issues is the first run and the ONLY state that looks like
      // the one above without being it. Conflating them makes the campaign
      // impossible to start.
      expect(planReconciliation(planOf(entry('AWS::S3::Bucket', ['A'])), [])).toHaveLength(1);
    });

    it('refuses when two issues claim the same type', () => {
      expect(() =>
        planReconciliation(planOf(entry('AWS::S3::Bucket', ['A'])), [
          existing(10, 'AWS::S3::Bucket', ['A']),
          existing(11, 'AWS::S3::Bucket', ['A']),
        ])
      ).toThrow(/#10 and #11 both carry the marker/);
    });

    it('refuses a plan larger than GitHub will link under one parent', () => {
      const many = planOf(
        ...Array.from({ length: MAX_SUB_ISSUES + 1 }, (_, i) => entry(`AWS::Fake::T${i}`, ['A']))
      );
      expect(() => planReconciliation(many, [])).toThrow(/past GitHub's limit/);
    });

    it('accepts a plan exactly AT the limit', () => {
      // The boundary, in the direction an off-by-one would break: refusing at
      // the limit would stop the campaign one type before GitHub does.
      const atCap = planOf(
        ...Array.from({ length: MAX_SUB_ISSUES }, (_, i) => entry(`AWS::Fake::T${i}`, ['A']))
      );
      expect(planReconciliation(atCap, [])).toHaveLength(MAX_SUB_ISSUES);
    });
  });
});

describe('the gh calls', () => {
  it('reads existing issues in BOTH states', () => {
    // `--state all` is load-bearing: a finished type's issue is CLOSED, and
    // without it a type that regains a property looks new — so a SECOND issue is
    // minted beside the closed original and the campaign shows the type twice.
    const { run, calls } = recorder(['[]']);
    fetchExisting(run);
    expect(calls[0]).toContain('--state');
    expect(calls[0]![calls[0]!.indexOf('--state') + 1]).toBe('all');
    expect(calls[0]).toContain(SUBISSUE_LABEL);
    // Body included, or every issue reads as unmarked and the run refuses.
    expect(calls[0]).toContain('number,state,title,body');
  });

  it('refuses a listing that is not an array rather than treating it as empty', () => {
    // An empty result and a malformed one both reach the caller as "no existing
    // issues", which is the first-run state — and the first-run state creates
    // everything.
    const { run } = recorder(['{"message":"Not Found"}']);
    expect(() => fetchExisting(run)).toThrow(ReconcileRefusal);
  });

  it('passes an issue body by FILE, never as an argument', () => {
    // A body is multi-line generated text. The argv path keeps it out of any
    // shell and out of the process listing, and `--body-file` keeps it out of
    // argv as well.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-subissue-'));
    try {
      const { run, calls } = recorder(['https://github.com/go-to-k/cdkd/issues/900']);
      const action: Action = {
        kind: 'create',
        type: 'AWS::S3::Bucket',
        title: 'T',
        body: 'line one\nline two\n',
      };
      expect(applyAction(run, action, dir)).toBe(900);
      expect(calls[0]).toContain('--body-file');
      expect(calls[0]!.some((a) => a.includes('line two'))).toBe(false);
      const file = calls[0]![calls[0]!.indexOf('--body-file') + 1]!;
      expect(readFileSync(file, 'utf8')).toBe('line one\nline two\n');
      expect(calls[0]).toContain(SUBISSUE_LABEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a create whose output carries no issue number', () => {
    // The number is what the link step and the parent index both consume.
    // Reading `NaN` out of an unexpected output and carrying on would link
    // nothing and index `#NaN`.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-subissue-'));
    try {
      const { run } = recorder(['some unexpected gh output']);
      expect(() =>
        applyAction(run, { kind: 'create', type: 'T', title: 'T', body: 'b' }, dir)
      ).toThrow(/carries no issue number/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes with a reason and says why, rather than silently', () => {
    const { run, calls } = recorder(['']);
    applyAction(run, { kind: 'close', number: 10, type: 'AWS::S3::Bucket' }, '/unused');
    expect(calls[0]!.slice(0, 3)).toEqual(['issue', 'close', '10']);
    expect(calls[0]).toContain('--comment');
  });

  it('refuses to POST a sub-issue link with something that is not an id', () => {
    // The endpoint takes the database id, not the number. A lookup that returned
    // an error document would otherwise be posted as the `sub_issue_id`.
    const { run } = recorder(['not-an-id']);
    expect(() => linkSubIssue(run, 'go-to-k/cdkd', 2762, 900)).toThrow(/refusing to POST/);
  });

  it('links by database id, under the parent', () => {
    const { run, calls } = recorder(['123456', '']);
    linkSubIssue(run, 'go-to-k/cdkd', 2762, 900);
    expect(calls[1]).toContain('repos/go-to-k/cdkd/issues/2762/sub_issues');
    expect(calls[1]).toContain('sub_issue_id=123456');
    expect(calls[1]).toContain('POST');
  });
});

describe('renderIndex', () => {
  it('renders one row per TYPE, not one per property', () => {
    // The whole point of the restructure: the parent carried 288 property rows
    // and now carries 44 type rows, each linking to where the properties live.
    const index = renderIndex(
      planOf(entry('AWS::S3::Bucket', ['A', 'B']), entry('AWS::SNS::Topic', ['C'])),
      new Map([
        ['AWS::S3::Bucket', 900],
        ['AWS::SNS::Topic', 901],
      ])
    );
    expect(index).toContain('- [ ] #900 — `AWS::S3::Bucket` (2 remaining)');
    expect(index).toContain('- [ ] #901 — `AWS::SNS::Topic` (1 remaining)');
    expect(index).toContain('3 properties across 2 resource types');
    expect(index.split('\n').filter((l) => l.startsWith('- [ ]'))).toHaveLength(2);
  });

  it('keeps the `- [ ] ` shape the workflow\'s render fence greps for', () => {
    // The splice step accepts rows or the sentinel and nothing else. A row shape
    // that stopped matching would kill the step under `set -e` with no
    // annotation — the failure that once left the umbrella's stale rows
    // standing permanently.
    const workflow = readFileSync(
      join(REPO_ROOT, '.github/workflows/backfill-umbrella-sync.yml'),
      'utf8'
    );
    expect(workflow).toContain('/tmp/index.md');
    const index = renderIndex(planOf(entry('AWS::S3::Bucket', ['A'])), new Map());
    expect(index).toMatch(/^- \[ \] /m);
  });

  it('says so when the campaign is finished, in the SAME words the checklist uses', () => {
    expect(renderIndex(planOf(), new Map())).toBe(UMBRELLA_EMPTY_SENTINEL);
  });
});

describe('the rendered sub-issue body', () => {
  it('carries the marker the reconciler keys on', () => {
    const body = renderSubIssueBody({ type: 'AWS::S3::Bucket', properties: ['A'] });
    expect(body.startsWith(subIssueTypeMarker('AWS::S3::Bucket'))).toBe(true);
    expect(readMarkerType(body)).toBe('AWS::S3::Bucket');
  });

  it('carries a Dup-check line, or CI comments on all forty-odd of them', () => {
    // `.github/workflows/issue-conventions.yml` runs `check-issue-dup-check.ts`
    // on every `issues: opened` event and — unlike the English check beside it —
    // has NO bot exclusion. A body without the line earns a failing check and a
    // posted comment on each issue this mints.
    const body = renderSubIssueBody({ type: 'AWS::S3::Bucket', properties: ['A'] });
    expect(body).toMatch(/^Dup-check: /m);
    // The four classification fields CLAUDE.md requires, one per line. Severity
    // and Effort are also mirrored onto labels by CI, which is what makes the
    // generated set filterable at all.
    expect(body).toMatch(/^Session-fit: /m);
    expect(body).toMatch(/^Severity: low /m);
    expect(body).toMatch(/^Effort: (small \(S\)|medium \(M\)|large \(L\)) /m);
    expect(body).toMatch(/^Estimate: /m);
  });

  it('renders every checkbox UNCHECKED, because a tick would be overwritten', () => {
    const body = renderSubIssueBody({ type: 'AWS::S3::Bucket', properties: ['A', 'B'] });
    expect(body).not.toContain('- [x]');
    expect(body.split('\n').filter((l) => l.startsWith('- [ ] '))).toHaveLength(2);
  });

  it('bands Effort by the remaining count', () => {
    // 25 of the 44 live types hold 1-3 properties and three hold 24, 40 and 62.
    // One band across that range makes the `effort:*` label useless for the
    // filtering it exists for.
    expect(subIssueEffort(1)).toBe('small (S)');
    expect(subIssueEffort(3)).toBe('small (S)');
    expect(subIssueEffort(4)).toBe('medium (M)');
    expect(subIssueEffort(12)).toBe('medium (M)');
    expect(subIssueEffort(13)).toBe('large (L)');
    expect(subIssueEffort(62)).toBe('large (L)');
  });

  it('passes a property name that could not be rendered safely through the refusal', () => {
    // Property names are captured as `[^']+` and are NOT constrained the way
    // type names are, so one carrying a backtick or a newline reaches the page.
    // `renderName` replaces it rather than emitting it.
    const body = renderSubIssueBody({ type: 'AWS::S3::Bucket', properties: ['Bad`Name'] });
    expect(body).toContain('**[name rejected: unexpected characters]**');
  });
});

describe('renderSubIssuePlan', () => {
  const SOURCE = `
export const PROPERTY_COVERAGE = new Map([
  ['AWS::S3::Bucket', {
    handled: new Set(['BucketName']),
    silentDrop: new Map<string, string>([['ObjectLockConfiguration', 'x'], ['Tags', 'y']]),
  }],
  ['AWS::SNS::Topic', {
    handled: new Set(['TopicName']),
    silentDrop: new Map<string, string>([]),
  }],
]);
`;

  it('groups by type and omits a type with nothing left', () => {
    // A group with zero properties would mint a sub-issue for a finished type,
    // which the very same run would then close.
    const plan = JSON.parse(renderSubIssuePlan(SOURCE)) as Plan;
    expect(plan.types.map((t) => t.type)).toEqual(['AWS::S3::Bucket']);
    expect(plan.types[0]!.count).toBe(2);
  });

  it('wraps the entries in an object, so an empty campaign is representable', () => {
    // A bare array renders "empty campaign" and "not the document we asked for"
    // identically — the ambiguity `UMBRELLA_EMPTY_SENTINEL` exists to resolve on
    // the checklist side.
    const finished = renderSubIssuePlan(`
export const PROPERTY_COVERAGE = new Map([
  ['AWS::S3::Bucket', { handled: new Set([]), silentDrop: new Map<string, string>([]) }],
]);
`);
    expect(JSON.parse(finished)).toEqual({ types: [] });
  });

  it('still throws when the module parses to zero TYPES', () => {
    expect(() => renderSubIssuePlan('export const nothing = 1;')).toThrow(/parsed to zero types/);
  });
});

describe('cross-file fences', () => {
  it('agrees with the workflow about the sub-issue label', () => {
    // Three spellings of one name: this constant, the workflow env the label is
    // CREATED with, and the `/work-issues` exclusion. A drift in the first two
    // makes the reconciler blind to the issues it created last run — the
    // duplicate-minting case, reached from the other side.
    const workflow = readFileSync(
      join(REPO_ROOT, '.github/workflows/backfill-umbrella-sync.yml'),
      'utf8'
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = parseYaml(workflow);
    const step = parsed.jobs.sync.steps.find(
      (s: { env?: Record<string, string> }) => s.env?.['SUBISSUE_LABEL'] !== undefined
    );
    expect(step, 'no step defines SUBISSUE_LABEL').toBeDefined();
    expect(step.env['SUBISSUE_LABEL']).toBe(SUBISSUE_LABEL);
    // And it is NOT the umbrella's own label: the parent lookup demands exactly
    // one issue carrying that one, so a shared label makes every run refuse.
    expect(step.env['BACKFILL_UMBRELLA_LABEL']).not.toBe(SUBISSUE_LABEL);
  });

  it('agrees with /work-issues about which label the backlog excludes', () => {
    // Without the exclusion, §1 lists every open non-pull-request issue and the
    // ~44 generated ones land in the shortlist of every future session. The
    // exclusion is also what reconciles this design with
    // `check-issue-dup-check.ts`'s "N sites of one root cause is ONE issue"
    // rationale — these are bot-filed and bot-closed, and never triaged.
    const triage = readFileSync(
      join(REPO_ROOT, '.claude/skills/work-issues/references/triage.md'),
      'utf8'
    );
    expect(triage, 'the backlog listing no longer excludes the generated issues').toContain(
      SUBISSUE_LABEL
    );
  });

  it('keys on ONE marker spelling, aliased rather than re-typed', () => {
    expect(MARKER_PREFIX + 'X' + MARKER_SUFFIX).toBe(subIssueTypeMarker('X'));
    const src = readFileSync(join(REPO_ROOT, 'scripts/sync-backfill-subissues.ts'), 'utf8');
    expect(src, 'the marker text was copied instead of imported').not.toContain(
      "'<!-- backfill-type: '"
    );
  });

  it('keeps RENDER_ONLY_FLAGS inside both sets it depends on', () => {
    // Membership is only meaningful if every member is also a KNOWN flag (or the
    // invocation is refused before the mode runs) and takes no value (the
    // workflows pass them bare). Asserted as containment rather than as a third
    // literal list, which is the drift this set was introduced to end.
    expect(RENDER_ONLY_FLAGS.size, 'a one-member set cannot demonstrate the property').toBeGreaterThan(1);
    for (const flag of RENDER_ONLY_FLAGS) {
      expect(KNOWN_FLAGS, `${flag} is not a known flag`).toContain(flag);
      expect(VALUELESS_FLAGS.has(flag), `${flag} is not declared valueless`).toBe(true);
    }
  });
});
