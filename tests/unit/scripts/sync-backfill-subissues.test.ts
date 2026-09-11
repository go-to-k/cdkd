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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';
import {
  MARKER_PREFIX,
  MARKER_SUFFIX,
  MAX_SUB_ISSUES,
  ReconcileRefusal,
  SUBISSUE_LABEL,
  applyAction,
  fetchExisting,
  fetchLinked,
  linkSubIssue,
  planReconciliation,
  readMarkerType,
  type Action,
  type ExistingIssue,
  type Plan,
} from '../../../scripts/sync-backfill-subissues.ts';
import {
  KNOWN_FLAGS,
  RENDER_ONLY_FLAGS,
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
    // carry CR.
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
    // Relaxing `startsWith` to `includes` leaves this green — an EQUIVALENT
    // mutation, because the fixed-offset slice shifts and fails the type class.
    // So this case fences the behaviour, not the anchor, and the two cases
    // below fence the two clauses that are NOT equivalent.
    expect(readMarkerType(`see the ${subIssueTypeMarker('AWS::S3::Bucket')} marker`)).toBeUndefined();
    expect(readMarkerType(`  ${subIssueTypeMarker('AWS::S3::Bucket')}`)).toBeUndefined();
  });

  it('needs the line anchor for a line with NO marker that still slices clean', () => {
    // DELETING `startsWith` is a different mutation from relaxing it to
    // `includes`, and this one is NOT equivalent — but the discriminating input
    // is not what it first looks like. Prose followed by a real marker does not
    // work: that shifts the fixed-offset slice INTO `<!-- backfill-type: `,
    // which the type class rejects anyway, so such a case survives the mutation
    // and proves nothing (measured — the first version of this case did exactly
    // that).
    //
    // What discriminates is a line carrying NO marker at all, whose bytes just
    // happen to line up: any text ending in ` -->` with a class-valid substring
    // starting at offset `MARKER_PREFIX.length`. Without the anchor, such a line
    // binds a live issue to a type it never mentioned.
    const decoy = 'Mentioned in review AWS::S3::Bucket -->';
    expect(decoy).not.toContain(MARKER_PREFIX);
    expect(
      decoy.slice(MARKER_PREFIX.length, decoy.length - MARKER_SUFFIX.length),
      'the decoy does not slice to a class-valid type, so this case proves nothing'
    ).toBe('AWS::S3::Bucket');
    expect(readMarkerType(decoy)).toBeUndefined();
  });

  it('needs the suffix test, whose absence TRUNCATES rather than rejects', () => {
    // The worst of the three to lose, because it fails silently instead of
    // loudly. The slice ends at `length - MARKER_SUFFIX.length` unconditionally,
    // so a reader without `endsWith` returns the mangled line's type-plus-tail
    // with its last four characters removed — here eating into the type itself
    // and yielding a truncated but perfectly CLASS-VALID string that no plan can
    // ever match. That issue is then never updated and never closed, and the
    // real type looks new and gets a duplicate: the outcome refusal 2 exists to
    // prevent, reached PAST refusal 2, which only sees types it could not read.
    //
    // The TAIL LENGTH is chosen, not incidental. A tail of exactly four
    // characters chops to the CORRECT type, so it exhibits nothing — an earlier
    // revision of this case and of the JSDoc both used one.
    const mangled = `${MARKER_PREFIX}AWS::S3::BucketX`;
    expect(readMarkerType(mangled)).toBeUndefined();
    const truncated = mangled.slice(MARKER_PREFIX.length, mangled.length - MARKER_SUFFIX.length);
    expect(truncated, 'the tail length makes this chop to the true type, exhibiting nothing').toBe(
      'AWS::S3::Buc'
    );
    expect(truncated, 'the truncation is not class-valid, so this case proves nothing').toMatch(
      /^[A-Z][\w:]+$/
    );
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

    const unmarked = (number: number, state: 'OPEN' | 'CLOSED' = 'OPEN'): ExistingIssue => ({
      number,
      state,
      title: 'Backfill silent-drop properties: AWS::S3::Bucket',
      body: 'a body whose marker the reader no longer understands',
    });

    it('refuses when an open labelled issue carries no readable marker', () => {
      // The duplicate-minting case. If a marker goes missing, that type looks
      // new: the run creates a second issue for it and leaves the original
      // open, which no later run can undo — the rewrite that would heal the
      // body cannot find the issue it needs to rewrite.
      expect(() => planReconciliation(planOf(entry('AWS::S3::Bucket', ['A'])), [unmarked(10)])).toThrow(
        /no\s+readable/
      );
    });

    it('refuses a PARTIALLY stripped set, where some markers still read', () => {
      // The likelier shape and the one an all-or-nothing condition passes: one
      // body hand-edited, not a spelling change across the set. With
      // `byType.size === 0` as the test, a set of [marked S3, unmarked Lambda]
      // sails through, Lambda gets a duplicate, and the unmarked issue stays
      // open forever — invisible to every later run. Found in review; the
      // all-unmarked case above cannot exhibit it.
      expect(() =>
        planReconciliation(
          planOf(entry('AWS::S3::Bucket', ['A']), entry('AWS::Lambda::Function', ['B'])),
          [existing(10, 'AWS::S3::Bucket', ['A']), unmarked(11)]
        )
      ).toThrow(/#11/);
    });

    it('ignores a CLOSED unmarked issue, which is inert', () => {
      // Nothing reads it and nothing would act on it, so refusing would block
      // the campaign over a finished issue somebody once hand-edited.
      expect(
        planReconciliation(planOf(entry('AWS::S3::Bucket', ['A'])), [
          existing(10, 'AWS::S3::Bucket', ['A']),
          unmarked(11, 'CLOSED'),
        ])
      ).toEqual([]);
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
    fetchExisting(run, 'go-to-k/cdkd');
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
    expect(() => fetchExisting(run, 'go-to-k/cdkd')).toThrow(ReconcileRefusal);
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
      expect(applyAction(run, 'go-to-k/cdkd', action, dir)).toBe(900);
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
    // The number is what the link step consumes. Reading `NaN` out of an
    // unexpected output and carrying on would link nothing.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-subissue-'));
    try {
      const { run } = recorder(['some unexpected gh output']);
      expect(() =>
        applyAction(run, 'go-to-k/cdkd', { kind: 'create', type: 'T', title: 'T', body: 'b' }, dir)
      ).toThrow(/carries no issue number/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes with a reason and says why, rather than silently', () => {
    const { run, calls } = recorder(['']);
    applyAction(run, 'go-to-k/cdkd', { kind: 'close', number: 10, type: 'AWS::S3::Bucket' }, '/unused');
    expect(calls[0]!.slice(0, 3)).toEqual(['issue', 'close', '10']);
    expect(calls[0]).toContain('--comment');
  });

  it('refuses to POST a sub-issue link with something that is not an id', () => {
    // The endpoint takes the database id, not the number. A lookup that returned
    // an error document would otherwise be posted as the `sub_issue_id`.
    const { run } = recorder(['not-an-id']);
    expect(() => linkSubIssue(run, 'go-to-k/cdkd', 2762, 900)).toThrow(/refusing to POST/);
  });

  it('refuses a listing that came back at exactly the limit', () => {
    // `gh` returns newest-first, so a truncated page drops the OLDEST issues —
    // which then look new and get duplicated, the unrecoverable outcome refusal
    // 2 guards from the other side. A full page and a truncated one are
    // indistinguishable, so the boundary is the only signal there is.
    const full = JSON.stringify(
      Array.from({ length: MAX_SUB_ISSUES * 2 }, (_, i) => ({
        number: i + 1,
        state: 'OPEN',
        title: 't',
        body: 'b',
      }))
    );
    const { run } = recorder([full]);
    expect(() => fetchExisting(run, 'go-to-k/cdkd')).toThrow(/may be\s+truncated/);
  });

  it('targets ONE repository from every call, read half and write half alike', () => {
    // Two resolution rules is how the halves come to disagree about which
    // repository they are reconciling: the read half could infer from the git
    // remote while the write half used $REPO. Asserted per ACTION KIND rather
    // than once — `create` carried `--repo` while `edit` / `reopen` / `close`
    // did not, and a single-kind case cannot see that.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-subissue-'));
    try {
      const kinds: Action[] = [
        { kind: 'create', type: 'T', title: 'T', body: 'b' },
        { kind: 'update', number: 10, type: 'T', title: 'T', body: 'b' },
        { kind: 'reopen', number: 10, type: 'T' },
        { kind: 'close', number: 10, type: 'T' },
      ];
      for (const action of kinds) {
        const { run, calls } = recorder(['https://github.com/go-to-k/cdkd/issues/900']);
        applyAction(run, 'go-to-k/cdkd', action, dir);
        const argv = calls[0]!;
        expect(argv, `${action.kind} does not name the repository`).toContain('--repo');
        expect(argv[argv.indexOf('--repo') + 1]).toBe('go-to-k/cdkd');
      }
      // And the read half, which is the one that could have inferred it.
      const { run, calls } = recorder(['[]']);
      fetchExisting(run, 'go-to-k/cdkd');
      expect(calls[0]).toContain('--repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes an UPDATED body by file too, not only a created one', () => {
    // The `update` arm rewrites a ~44-line body on every type whose properties
    // moved. Asserted separately because the `--body-file` invariant was pinned
    // for `create` alone, so an update arm switching to `--body` would ship the
    // whole body through argv with the suite green.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-subissue-'));
    try {
      const { run, calls } = recorder(['']);
      applyAction(
        run,
        'go-to-k/cdkd',
        { kind: 'update', number: 10, type: 'T', title: 'T', body: 'line one\nline two\n' },
        dir
      );
      expect(calls[0]).toContain('--body-file');
      expect(calls[0]!.some((a) => a.includes('line two'))).toBe(false);
      expect(calls[0]!.slice(0, 3)).toEqual(['issue', 'edit', '10']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the parent\'s already-linked children, paginated', () => {
    // Without this the link loop re-POSTs every child on every run. `--paginate`
    // is the load-bearing flag: a parent at 44 children spans more than one page
    // of the default size, so an unpaginated read reports the tail as unlinked.
    const { run, calls } = recorder(['900\n901\n\n902\n']);
    expect(fetchLinked(run, 'go-to-k/cdkd', 2762)).toEqual(new Set([900, 901, 902]));
    expect(calls[0]).toContain('--paginate');
    expect(calls[0]).toContain('repos/go-to-k/cdkd/issues/2762/sub_issues');
  });

  it('links by database id, under the parent', () => {
    const { run, calls } = recorder(['123456', '']);
    linkSubIssue(run, 'go-to-k/cdkd', 2762, 900);
    expect(calls[1]).toContain('repos/go-to-k/cdkd/issues/2762/sub_issues');
    expect(calls[1]).toContain('sub_issue_id=123456');
    expect(calls[1]).toContain('POST');
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

  it('describes the ROUTING the registry actually performs, not a silent drop', () => {
    // The body shipped to 44 public issues saying these properties were "still
    // dropped silently by its SDK provider", and contradicted itself two
    // screens down where its own `Severity` line described a Cloud Control
    // route. The campaign is a fast-path restoration, not a data-loss fix, and
    // a body claiming otherwise misstates the severity of every type in it.
    const body = renderSubIssueBody({ type: 'AWS::S3::Bucket', properties: ['A'] });
    expect(body, 'the body claims a silent drop again').not.toMatch(
      /dropped silently|silently dropped/
    );
    expect(body).toContain('auto-routes the whole resource through Cloud Control');

    // Backed by DRIVING the registry, not by grepping it. The first version of
    // this fence matched `provider-registry.ts` source text, and review
    // measured it satisfied by COMMENTS alone: replacing the auto-route return
    // with a `throw` left all four assertions green, so the message "the
    // registry no longer auto-routes" could not fire for the failure it named.
    // That is the source-text-fence-is-satisfiable-by-a-comment shape, and a
    // prose claim about another module's mechanism is exactly where it bites.
    const registry = new ProviderRegistry();
    const [resourceType, coverage] = [...PROPERTY_COVERAGE_BY_TYPE].find(
      ([, c]) => c.silentDrop.size > 0
    )!;
    const property = [...coverage.silentDrop.keys()][0]!;
    registry.register(resourceType, {
      create: async () => ({ physicalId: 'x' }),
      update: async () => ({ physicalId: 'x', wasReplaced: false }),
      delete: async () => {},
      getAttribute: async () => undefined,
    });

    const decision = registry.getProviderFor({
      resourceType,
      properties: { [property]: 'x' },
      provisionedBy: 'sdk',
    });
    expect(
      decision.provisionedBy,
      'the registry no longer auto-routes on a silent drop — the generated bodies now misdescribe it'
    ).toBe('cc-api');
    // The reason list, not merely the layer: the body tells a reader the whole
    // RESOURCE moves because of this property, and an empty list would leave
    // that half unbacked.
    expect(decision.ccRouteReason?.properties).toEqual([property]);
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

  it('excludes the label from EVERY backlog listing in /work-issues, not just the first', () => {
    // Without the exclusion the ~44 generated issues land in the shortlist of
    // every future session. It is also what reconciles this design with
    // `check-issue-dup-check.ts`'s "N sites of one root cause is ONE issue"
    // rationale — these are bot-filed and bot-closed, and never triaged.
    //
    // DERIVED, not spot-checked, because the first cut of this fence was a bare
    // `toContain(SUBISSUE_LABEL)` over the whole file and passed while THREE of
    // the four listings had no filter — including §3-0's, which is the one that
    // actually produces the eligible set, and which is labelled in the file as
    // "§1's listing with the gate applied". `filing.md` asserted the exclusion
    // was universal, so the corpus carried a false statement about its own
    // mechanism with a green test beside it. A listing added later must fail
    // here rather than be remembered.
    // The population is BOTH files that list open issues, not `triage.md`
    // alone: `retro.md` counts issues whose body gained a `- [ ] ` row, and a
    // sync rewrites every generated sub-issue with a body that is nothing but
    // such rows — so a run touching none of them would report up to 44 findings
    // folded. Found in review, after a first cut scoped to triage.md.
    const sources = ['triage.md', 'retro.md'].map((f) =>
      readFileSync(join(REPO_ROOT, '.claude/skills/work-issues/references', f), 'utf8')
    );
    // Per COMMAND, not per fenced block: §3-a carries TWO listings in one
    // block, so a block-granular scan found 3 where there are 4 and would have
    // passed with one of them unfiltered. Commands are separated by blank lines
    // inside a block.
    const listings = sources
      .flatMap((src) => src.split('```').filter((_, i) => i % 2 === 1))
      .flatMap((b) => b.split(/\n\s*\n/))
      .filter(
        (c) =>
          c.includes('repos/{owner}/{repo}/issues?state=open') ||
          c.includes('gh issue list --state open')
      );
    expect(
      listings.length,
      'the backlog-listing scan found a different number than the 5 this fence was calibrated ' +
        'against — a listing was added, removed, or reshaped past what the split recognises'
    ).toBe(5);
    for (const listing of listings) {
      const first =
        listing.trim().split('\n').find((l) => l.trim().startsWith('gh')) ?? listing.slice(0, 60);
      // NEGATED, not merely mentioned. Dropping `| not` inverts every shortlist
      // to the bot issues and would otherwise pass — the filter naming the label
      // is the half that is easy to assert and the wrong half.
      //
      // Built FROM the constant. Hard-coding the label here while the failure
      // message interpolated `SUBISSUE_LABEL` let a rename of the constant pass
      // with the documents left stale — the two spellings have to be one.
      // ESCAPED on the way in: `backfill-type` is regex-inert today, but a value
      // carrying `.` or `+` would silently LOOSEN the fence rather than break
      // it, which is the direction that goes unnoticed.
      const label = SUBISSUE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const negated = new RegExp(`index\\((\\\\)?"${label}(\\\\)?"\\)\\s*\\|\\s*not`);
      expect(
        negated.test(listing),
        `this backlog listing does not EXCLUDE '${SUBISSUE_LABEL}': ${first}`
      ).toBe(true);
    }
    // And `filing.md`'s claim ABOUT that exclusion, which is the sentence a
    // future session reads before deciding whether to consolidate the set back.
    // Asserted as the ENUMERATION, because the claim this replaced was the false
    // universal "§3's backlog listing EXCLUDES the label" — which contains the
    // substring a `toContain('EXCLUDES the label')` would have matched, so
    // reverting to the false sentence kept that assertion green.
    const filing = readFileSync(
      join(REPO_ROOT, '.claude/skills/work-issues/references/filing.md'),
      'utf8'
    );
    // ONE regex spanning head -> VERB, plus the anchors. The first attempt at
    // de-vacuating this dropped the verb: `toMatch(/Every backlog listing in
    // .triage\.md./)` with separate §-anchor assertions survives flipping
    // EXCLUDES to INCLUDES, which is precisely the mutation the crude
    // `toContain('EXCLUDES the label')` it replaced DID catch. Naming what a
    // replacement can no longer see is the rule; here the answer was "the only
    // thing that mattered", so both halves are asserted together.
    // The span is bounded to ONE PARAGRAPH, and what that buys is narrower than
    // it looks — measured, after the comment here first claimed more. The
    // claim's bullet list is CONTIGUOUS (no blank line between bullets), so
    // `(?!\n\n)` bounds the span to the whole list rather than to one bullet:
    // moving the `EXCLUDES the label` clause into a later bullet keeps this
    // GREEN. What the bound does catch is a detach across a blank line, and a
    // second occurrence added later to rescue an inverted first one — again
    // only once a blank line separates them.
    //
    // The residual both halves share, and which no regex over prose closes:
    // APPENDING a contradiction inside the same paragraph. Polarity in English
    // is not something a matcher can fence; this pins the head to its verb and
    // stops there, deliberately.
    const para = '(?:(?!\\n\\n)[\\s\\S])*?';
    expect(filing, 'the claim lost its verb, so it can be inverted and stay green').toMatch(
      new RegExp(`Every backlog listing in \`triage\\.md\`${para}EXCLUDES the label`)
    );
    expect(filing).toContain('§3-0');
    expect(filing).toContain('§3-a');
    // And round 2's own correction — the retro.md half. Asserting the FILENAME
    // alone reds on deleting the clause but not on inverting it, which is the
    // same defect one level down: round 3 fixed the triage half by spanning to
    // its verb and left this one naming a string.
    //
    // Note what carries the polarity here, because it is not the span: "and so
    // does" is INSIDE the matched head literal, so an in-place inversion reds on
    // the head by itself and the `${para}matters` tail adds nothing but a little
    // more pinned text. Do not read this as the verb-span the triage half has.
    expect(filing, 'the retro.md half of the claim is unasserted or invertible').toMatch(
      new RegExp(`and so does §10's folded-finding count in \`retro\\.md\`${para}matters`)
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

/**
 * The CLI half, SPAWNED.
 *
 * Everything above drives exported functions; `main()` and `isMain()` were
 * reached by nothing, and the live workflow case stubs `node` away entirely —
 * so the argv parsing, the `REPO` / `PARENT` contract, the
 * usage exit, the not-a-plan refusal, the exit-1-vs-2 split the file's header
 * argues at length, and both operator recovery flags the runbook documents
 * (`--dry-run`, `--allow-empty-plan`) were untested. That is the half that
 * writes ~44 public issues.
 *
 * A stub `gh` on PATH keeps every case offline AND is the assertion for the
 * most important one: a dry run must issue no writing verb. The stub fails
 * CLOSED on anything it does not model, so a case cannot pass by reaching a
 * command nobody thought about.
 */
describe('the CLI, spawned', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts/sync-backfill-subissues.ts');

  function sandbox(listing: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-subissue-cli-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(dir, 'listing.json'), JSON.stringify(listing));
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/bash
echo "gh $*" >> "$GH_LOG"
case "$1 $2" in
  "issue list") cat "$GH_LISTING" ;;
  *) echo "stub gh: unmodelled subcommand: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 }
    );
    return { dir, bin, log: join(dir, 'gh.log') };
  }

  const spawnCli = (
    box: ReturnType<typeof sandbox>,
    args: string[],
    env: Record<string, string>
  ) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${box.bin}:${process.env['PATH'] ?? ''}`,
        HOME: box.dir,
        GH_LOG: box.log,
        GH_LISTING: join(box.dir, 'listing.json'),
        ...env,
      },
    });

  const planFile = (dir: string, plan: unknown) => {
    const p = join(dir, 'plan.json');
    writeFileSync(p, JSON.stringify(plan));
    return p;
  };

  it('a --dry-run plans everything and writes NOTHING', () => {
    // The runbook's "see what a run WOULD do" recipe. Asserted by what the stub
    // `gh` was asked for, not by the exit code: a dry run that silently created
    // issues would exit 0 too.
    const box = sandbox([]);
    try {
      const plan = planFile(box.dir, { types: [entry('AWS::S3::Bucket', ['A'])] });
      const res = spawnCli(box, [plan, '--dry-run'], { REPO: 'go-to-k/cdkd', PARENT: '2762' });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain('create AWS::S3::Bucket');
      expect(res.stdout).toContain('1 action(s) planned; nothing written.');
      const calls = readFileSync(box.log, 'utf8');
      expect(calls).toContain('gh issue list');
      for (const verb of ['issue create', 'issue edit', 'issue close', 'issue reopen', 'api']) {
        expect(calls, `a dry run reached '${verb}'`).not.toContain(verb);
      }
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a document that is not a plan with exit 2, not 1', () => {
    // The split the header argues: 1 is a REFUSAL a human acts on from the
    // runbook, 2 is "could not evaluate". Collapsing them makes the runbook's
    // per-refusal recovery unreachable.
    const box = sandbox([]);
    try {
      const plan = planFile(box.dir, { notTypes: [] });
      const res = spawnCli(box, [plan, '--dry-run'], { REPO: 'go-to-k/cdkd', PARENT: '2762' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("has no 'types' array");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses an empty plan while a sub-issue is open, and --allow-empty-plan clears it', () => {
    // Both halves, because a refusal with no way through would leave a genuinely
    // finished campaign with 44 issues open forever — and the flag is the
    // runbook's documented recovery.
    const open = {
      number: 10,
      state: 'OPEN',
      title: 't',
      body: renderSubIssueBody({ type: 'AWS::S3::Bucket', properties: ['A'] }),
    };
    const box = sandbox([open]);
    try {
      const plan = planFile(box.dir, { types: [] });
      const env = { REPO: 'go-to-k/cdkd', PARENT: '2762' };
      const refused = spawnCli(box, [plan, '--dry-run'], env);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('--allow-empty-plan');

      const allowed = spawnCli(box, [plan, '--dry-run', '--allow-empty-plan'], env);
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout).toContain('close AWS::S3::Bucket');
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('needs REPO and PARENT, and says so with exit 2', () => {
    // `REPO` is the one the live workflow case cannot see — its spawn env omits
    // it — so a step that stopped exporting it would fail only at runtime.
    const box = sandbox([]);
    try {
      const plan = planFile(box.dir, { types: [] });
      const partial: Record<string, string>[] = [
        { PARENT: '2762' },
        { REPO: 'go-to-k/cdkd' },
        {},
      ];
      for (const env of partial) {
        const res = spawnCli(box, [plan], env);
        expect(res.status, `missing env was accepted: ${JSON.stringify(env)}`).toBe(2);
        expect(res.stderr).toContain('usage:');
      }
      // And a PARENT that is not a positive integer is not a parent.
      const bad = spawnCli(box, [plan], { REPO: 'go-to-k/cdkd', PARENT: 'not-a-number' });
      expect(bad.status).toBe(2);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('honours no INDEX_OUT on a REAL run — the index write is gone, not skipped', () => {
    // The first version of this case asserted the absence on a DRY run and was
    // decorative: `main()` returns at the dry-run branch before the old
    // `if (indexOut) writeFileSync(...)` ever ran, so review measured
    // `origin/main`'s script — the version that fully honours `INDEX_OUT` —
    // passing every assertion, message included. Only a REAL run discriminates.
    const box = sandbox([]);
    try {
      const plan = planFile(box.dir, { types: [entry('AWS::S3::Bucket', ['A'])] });
      const stray = join(box.dir, 'index.md');
      // The stub answers a create and the link calls, so the run reaches the
      // point where the index would have been written.
      writeFileSync(
        join(box.bin, 'gh'),
        `#!/bin/bash
echo "gh $*" >> "$GH_LOG"
case "$1 $2" in
  "issue list") cat "$GH_LISTING" ;;
  "issue create") echo "https://github.com/go-to-k/cdkd/issues/900" ;;
  "api --paginate") ;;
  "api --method") ;;
  "api repos/go-to-k/cdkd/issues/900") echo "123456" ;;
  *) echo "stub gh: unmodelled subcommand: $*" >&2; exit 1 ;;
esac
`,
        { mode: 0o755 }
      );
      const res = spawnCli(box, [plan], {
        REPO: 'go-to-k/cdkd',
        PARENT: '2762',
        INDEX_OUT: stray,
      });
      expect(res.status, `the real run did not succeed: ${res.stderr}`).toBe(0);
      expect(existsSync(stray), 'INDEX_OUT is honoured again — the index write is back').toBe(false);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);
});
