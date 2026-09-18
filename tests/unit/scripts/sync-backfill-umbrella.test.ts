/**
 * `scripts/sync-backfill-umbrella.ts`, the reconciler that makes the backfill
 * campaign's GENERATED CHECKLIST BLOCK equal to `main`'s coverage map.
 *
 * It writes ONE issue body, unattended, on a `main` push. Nothing it does is
 * reviewed before it happens and no local run rehearses it, so the cases below
 * are weighted toward the mutations it must NOT make: destroying the campaign's
 * hand-written half, publishing an empty list because a parser drifted, and
 * writing on a run where nothing changed.
 *
 * The predecessor (go-to-k/cdkd#2949) minted ~44 generated per-type sub-issues
 * instead, and those cases are gone with it — but every refusal that still has a
 * subject survives here, because the trap moved rather than closing: an empty
 * plan wipes a checklist now instead of mass-closing a campaign, and an
 * unreadable marker strands text on a page instead of stranding an issue.
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
import {
  BLOCK_END,
  BLOCK_START,
  KNOWN_CLI_FLAGS,
  LEGACY_CLOSE_COMMENT,
  LEGACY_LIST_LIMIT,
  LEGACY_SUBISSUE_LABEL,
  LEGACY_TYPE_MARKER_PREFIX,
  MAX_BODY_CHARS,
  ReconcileRefusal,
  closeLegacyIssue,
  fetchLegacyIssues,
  fetchUmbrellaBody,
  isGeneratedLegacyIssue,
  planBodyRewrite,
  renderChecklistBlock,
  validatePlan,
  writeUmbrellaBody,
  type Plan,
} from '../../../scripts/sync-backfill-umbrella.ts';
import {
  KNOWN_FLAGS,
  RENDER_ONLY_FLAGS,
  UMBRELLA_EMPTY_SENTINEL,
  VALUELESS_FLAGS,
  renderUmbrellaTypePlan,
} from '../../../scripts/diagnose-schema-refresh.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const planOf = (...entries: Array<[string, string[]]>): Plan => ({
  types: entries.map(([type, properties]) => ({ type, properties })),
});

/** A body with the campaign's human half on both sides of the markers. */
const bodyWith = (block: string, eol = '\n') =>
  [
    '# Backfill silent-drop properties',
    '',
    'Audit provenance a human wrote and nothing here can recompute.',
    '',
    BLOCK_START,
    block,
    BLOCK_END,
    '',
    '## Procedure',
    '',
    'Closed by PR #123 for AWS::Kept::Provenance.',
  ]
    .join('\n')
    .replace(/\n/g, eol);

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

describe('renderChecklistBlock', () => {
  it('renders one row per type, sorted by type', () => {
    // Sorted rather than left in the coverage map's order: a row moving inside
    // the generated file would otherwise reorder a public list, and every
    // reader's diff of the campaign becomes noise.
    const block = renderChecklistBlock(
      planOf(['AWS::SNS::Topic', ['C']], ['AWS::S3::Bucket', ['A', 'B']])
    );
    expect(block.split('\n')).toEqual([
      '- [ ] `AWS::S3::Bucket` — 2 properties: `A`, `B`',
      '- [ ] `AWS::SNS::Topic` — 1 property: `C`',
    ]);
  });

  it('renders every checkbox UNCHECKED, because a tick would be overwritten', () => {
    // The box is a progress ILLUSION: the block is regenerated from the coverage
    // map on every sync, so a hand-tick survives until the next push. What
    // actually closes a row is the property leaving `silentDrop`, at which point
    // the row disappears on its own.
    const block = renderChecklistBlock(planOf(['AWS::S3::Bucket', ['A']]));
    expect(block).not.toContain('- [x]');
    expect(block.startsWith('- [ ] ')).toBe(true);
  });

  it('passes a property name that could not be rendered safely through the refusal', () => {
    // Property names are captured as `[^']+` and are NOT constrained the way
    // type names are, so one carrying a backtick or a newline reaches a PUBLIC
    // page — where it would end the row, or the generated block, early.
    const block = renderChecklistBlock(planOf(['AWS::S3::Bucket', ['Bad`Name']]));
    expect(block).toContain('**[name rejected: unexpected characters]**');
    expect(block.split('\n')).toHaveLength(1);
  });

  it('renders the finished-campaign SENTENCE rather than nothing', () => {
    // An empty block is a blank stretch of page, which reads as a broken job
    // rather than as a finished campaign — the same ambiguity the flat
    // checklist's sentinel exists to resolve, so it is the same sentence.
    expect(renderChecklistBlock({ types: [] })).toBe(UMBRELLA_EMPTY_SENTINEL);
  });
});

describe('validatePlan', () => {
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

  it('accepts what the renderer actually emits', () => {
    // The producer and the consumer live in different files with nothing joining
    // them but this call, so the fixture is the REAL render rather than a
    // hand-written document that agrees with the reader by construction.
    const plan = validatePlan(JSON.parse(renderUmbrellaTypePlan(SOURCE)));
    expect(plan.types).toEqual([
      { type: 'AWS::S3::Bucket', properties: ['ObjectLockConfiguration', 'Tags'] },
    ]);
    expect(renderChecklistBlock(plan)).toBe(
      '- [ ] `AWS::S3::Bucket` — 2 properties: `ObjectLockConfiguration`, `Tags`'
    );
  });

  it('refuses a document with no types array', () => {
    // A bare array's empty case and a failed parse both render as `[]`; the
    // wrapper is what makes "the key is present and empty" a different state
    // from "this is not the document we asked for".
    expect(() => validatePlan({ notTypes: [] })).toThrow(/not a rendered plan/);
    expect(() => validatePlan([])).toThrow(ReconcileRefusal);
  });

  it('refuses a plan naming one type twice, HERE and not only at the write', () => {
    // The duplicate check lives in `validatePlan` precisely so the modes that
    // reach no body get it: `--render-block` prints straight into a paste, and
    // printing two rows for one type publishes a list nothing can reconcile.
    // Asserted at this entry point because the sibling case drives
    // `planBodyRewrite`, and review measured that deleting the call here left
    // the whole file green.
    expect(() =>
      validatePlan({
        types: [
          { type: 'AWS::S3::Bucket', properties: ['A'] },
          { type: 'AWS::S3::Bucket', properties: ['B'] },
        ],
      })
    ).toThrow(/names AWS::S3::Bucket twice/);
  });

  it('refuses an entry whose properties are missing or not strings', () => {
    // Valid JSON with the wrong shape is what a drifted renderer emits, and
    // every field here reaches a public page: a missing array would publish
    // `undefined` as the campaign's remaining work.
    expect(() => validatePlan({ types: [{ type: 'AWS::S3::Bucket' }] })).toThrow(ReconcileRefusal);
    expect(() => validatePlan({ types: [{ type: 'AWS::S3::Bucket', properties: [1] }] })).toThrow(
      ReconcileRefusal
    );
    expect(() => validatePlan({ types: [{ properties: ['A'] }] })).toThrow(ReconcileRefusal);
  });
});

describe('planBodyRewrite', () => {
  it('rewrites ONLY the region between the markers', () => {
    // The campaign's human half — audit provenance, procedure, which pull
    // request closed which slice — cannot be recomputed. Asserted as the
    // untouched PREFIX and SUFFIX rather than as "the result contains the
    // heading": a rewrite that reflowed the page would still contain it.
    const before = bodyWith('- [ ] `AWS::Old::Type` — 1 property: `Gone`');
    const { body, changed } = planBodyRewrite(before, planOf(['AWS::S3::Bucket', ['A']]));
    expect(changed).toBe(true);
    expect(body.slice(0, body.indexOf(BLOCK_START))).toBe(
      before.slice(0, before.indexOf(BLOCK_START))
    );
    expect(body.slice(body.indexOf(BLOCK_END))).toBe(before.slice(before.indexOf(BLOCK_END)));
    expect(body).toContain('- [ ] `AWS::S3::Bucket` — 1 property: `A`');
    expect(body, 'the retired row survived the rewrite').not.toContain('AWS::Old::Type');
  });

  it('is a NO-OP when the block already says what the plan says', () => {
    // The property that keeps this job from being noise. It fires on every
    // coverage-map push, and most pushes move one type — so a run that rewrote
    // the body regardless would bury the campaign's timeline under edits that
    // changed nothing.
    const plan = planOf(['AWS::S3::Bucket', ['A']]);
    const first = planBodyRewrite(bodyWith('anything'), plan);
    const second = planBodyRewrite(first.body, plan);
    expect(second.changed).toBe(false);
    expect(second.body).toBe(first.body);
  });

  it('is still a no-op on the second run when the stored body carries CRLF', () => {
    // A body opened in the GitHub WEB UI comes back with CRLF. A rewrite that
    // normalised the whole page would report a diff on every line, and the human
    // half would be silently reformatted — so only the region between the
    // markers is authored here and both outside halves are copied as stored.
    const plan = planOf(['AWS::S3::Bucket', ['A']]);
    const crlf = bodyWith('- [ ] stale', '\r\n');
    const first = planBodyRewrite(crlf, plan);
    expect(first.changed).toBe(true);
    expect(first.body, 'the human half lost its CRLF').toContain(
      '# Backfill silent-drop properties\r\n'
    );
    expect(first.body).toContain('Closed by PR #123');
    const second = planBodyRewrite(first.body, plan);
    expect(second.changed, 'a CRLF body reports as changed on every run, forever').toBe(false);
  });

  it('does not rewrite a block that differs only by a stray CR', () => {
    // The generated region this script writes is CR-FREE by construction, so a
    // CR inside it can only have come from somewhere else — and under a
    // byte-exact comparison that page would be rewritten on EVERY push, forever,
    // for content that already agrees with `main`. Compared after a CR strip,
    // while the body written stays the raw splice.
    //
    // The sibling no-op case cannot see this: its second run is byte-identical,
    // so it passes with or without the strip (measured in review).
    const plan = planOf(['AWS::S3::Bucket', ['A']]);
    const current = planBodyRewrite(bodyWith('x'), plan).body;
    const withCr = current.replace('1 property:', '1 property:\r');
    expect(withCr, 'the CR did not land — this case measures nothing').not.toBe(current);
    expect(planBodyRewrite(withCr, plan).changed).toBe(false);
  });

  it('drops a type whose list has emptied and adds one that gained work', () => {
    const before = planBodyRewrite(
      bodyWith('x'),
      planOf(['AWS::S3::Bucket', ['A']], ['AWS::SQS::Queue', ['B']])
    ).body;
    const after = planBodyRewrite(before, planOf(['AWS::S3::Bucket', ['A', 'NewProp']])).body;
    expect(after).toContain('- [ ] `AWS::S3::Bucket` — 2 properties: `A`, `NewProp`');
    expect(after, 'the finished type keeps a row').not.toContain('AWS::SQS::Queue');
  });

  describe('refusals — each guards a MUTATION, so none of them warns', () => {
    it('refuses an empty plan while the checklist still holds rows', () => {
      // "The campaign is finished" and "the parser stopped recognising
      // silentDrop" render identically as `types: []`, and
      // `parseSilentDropByType` throws only on zero type BOUNDARIES — a drifted
      // inner regex parses 44 types into 0 groups without erroring. Reading that
      // as finished wipes the whole published checklist on a green run.
      const body = planBodyRewrite(bodyWith('x'), planOf(['AWS::S3::Bucket', ['A']])).body;
      expect(() => planBodyRewrite(body, { types: [] })).toThrow(ReconcileRefusal);
      expect(() => planBodyRewrite(body, { types: [] })).toThrow(/--allow-empty-plan/);
    });

    it('accepts an empty plan once the operator confirms it', () => {
      // The genuine end of the campaign happens once, ever. It must be
      // REPRESENTABLE — a refusal with no way through is how a finished campaign
      // keeps a stale list on its page permanently.
      const body = planBodyRewrite(bodyWith('x'), planOf(['AWS::S3::Bucket', ['A']])).body;
      const done = planBodyRewrite(body, { types: [] }, true);
      expect(done.changed).toBe(true);
      expect(done.body).toContain(UMBRELLA_EMPTY_SENTINEL);
      expect(done.body, 'the human half was taken with the rows').toContain('## Procedure');
    });

    it('counts a HAND-TICKED row, which is the state this design expects to meet', () => {
      // Every row is rendered unchecked and the design says a tick would be
      // overwritten — so a reader ticking rows off is anticipated, and a guard
      // matching `- [ ] ` alone is blind to exactly that state: the empty plan
      // this refusal exists to stop would wipe a checklist somebody had just
      // worked through. Found in review, by probing the ticked body.
      const live = planBodyRewrite(bodyWith('x'), planOf(['AWS::S3::Bucket', ['A']])).body;
      const ticked = live.replace('- [ ] `AWS::S3::Bucket`', '- [x] `AWS::S3::Bucket`');
      expect(ticked, 'the tick did not land — this case measures nothing').toContain('- [x] ');
      expect(() => planBodyRewrite(ticked, { types: [] })).toThrow(/--allow-empty-plan/);
    });

    it('accepts an empty plan against a block with no rows, without the flag', () => {
      // Nothing to destroy, so there is nothing to confirm. Without this arm the
      // steady state AFTER a completed campaign would fail on every run.
      const finished = planBodyRewrite(bodyWith('x'), { types: [] }, true).body;
      expect(planBodyRewrite(finished, { types: [] }).changed).toBe(false);
    });

    it('refuses a body carrying neither marker, rather than appending a block', () => {
      // Appending publishes a SECOND list beside whatever the page already says,
      // and guessing a region overwrites human text. Both are worse than a red
      // run naming the missing marker.
      const naked = '# Backfill\n\nProvenance only.\n';
      expect(() => planBodyRewrite(naked, planOf(['AWS::S3::Bucket', ['A']]))).toThrow(
        /carries no '<!-- backfill-types:start -->' marker/
      );
      expect(() =>
        planBodyRewrite(`${BLOCK_START}\nrows\n`, planOf(['AWS::S3::Bucket', ['A']]))
      ).toThrow(/carries no '<!-- backfill-types:end -->' marker/);
    });

    it('refuses a body carrying EITHER marker twice', () => {
      // Two starts make the region ambiguous, and splicing the first pair
      // strands whatever the second pair holds — a second generated list on the
      // page that no later run can find. Asserted for both halves: a guard
      // written for the start alone passes the end-marker case, which is equally
      // unrecoverable and just as easy to produce with a copy-paste.
      const twoStarts = `${BLOCK_START}\na\n${BLOCK_START}\nb\n${BLOCK_END}\n`;
      expect(() => planBodyRewrite(twoStarts, planOf(['AWS::S3::Bucket', ['A']]))).toThrow(
        /'<!-- backfill-types:start -->' 2 times/
      );
      const twoEnds = `${BLOCK_START}\na\n${BLOCK_END}\nb\n${BLOCK_END}\n`;
      expect(() => planBodyRewrite(twoEnds, planOf(['AWS::S3::Bucket', ['A']]))).toThrow(
        /'<!-- backfill-types:end -->' 2 times/
      );
    });

    it('refuses markers in the wrong ORDER', () => {
      // Each appears exactly once, so the count guards pass; the region between
      // them is human text that a splice would delete.
      const inverted = `${BLOCK_END}\nhuman text\n${BLOCK_START}\n`;
      expect(() => planBodyRewrite(inverted, planOf(['AWS::S3::Bucket', ['A']]))).toThrow(
        /BEFORE/
      );
    });

    it('refuses a plan naming one type twice', () => {
      expect(() =>
        planBodyRewrite(bodyWith('x'), planOf(['AWS::S3::Bucket', ['A']], ['AWS::S3::Bucket', ['B']]))
      ).toThrow(/names AWS::S3::Bucket twice/);
    });

    it('refuses a body GitHub would reject outright', () => {
      // The successor to #2949's sub-issues-per-parent cap, and the same kind of
      // limit: a documented product maximum. Past it the PATCH fails and the
      // campaign keeps whatever half-truth it last published, so this refuses
      // rather than truncating — a list that stops partway reads as finished.
      const huge = planOf([
        'AWS::Fake::Type',
        Array.from({ length: 6000 }, (_, i) => `Property${i}`),
      ]);
      expect(() => planBodyRewrite(bodyWith('x'), huge)).toThrow(
        new RegExp(`past GitHub's limit of ${MAX_BODY_CHARS}`)
      );
    });

    it('stays UNDER that limit on the live campaign, so the refusal is not the live arm', () => {
      // The control. A refusal that fired in production would mean the campaign
      // has outgrown this shape, and every case above would be describing a
      // state nobody can reach.
      const live = validatePlan(
        JSON.parse(
          renderUmbrellaTypePlan(
            readFileSync(join(REPO_ROOT, 'src/provisioning/property-coverage.generated.ts'), 'utf8')
          )
        )
      );
      expect(live.types.length, 'the live coverage map rendered no types').toBeGreaterThan(0);
      const { body } = planBodyRewrite(bodyWith('x'), live);
      expect(body.length).toBeLessThan(MAX_BODY_CHARS);
    });
  });
});

describe('the gh calls', () => {
  it('reads the umbrella body by number, naming the repository', () => {
    // Two resolution rules is how the read half and the write half come to
    // disagree about which repository they are rewriting: `gh` would infer one
    // from the git remote while the write half used $REPO.
    const { run, calls } = recorder(['a body\n']);
    expect(fetchUmbrellaBody(run, 'go-to-k/cdkd', 2762)).toBe('a body');
    expect(calls[0]!.slice(0, 3)).toEqual(['issue', 'view', '2762']);
    expect(calls[0]).toContain('--repo');
    expect(calls[0]![calls[0]!.indexOf('--repo') + 1]).toBe('go-to-k/cdkd');
    expect(calls[0]).toContain('body');
  });

  it('strips exactly ONE trailing newline, the one gh adds', () => {
    // `gh --jq` terminates its output with a newline that is not part of the
    // field. Left on, it would sit inside the body on every write — appending a
    // blank line per run, forever, and reporting a change each time.
    const { run } = recorder(['line\n\n']);
    expect(fetchUmbrellaBody(run, 'go-to-k/cdkd', 2762)).toBe('line\n');
  });

  it('refuses an EMPTY body rather than rewriting the page from one', () => {
    // A failed read and a genuinely empty issue are the same string here, and
    // rewriting from either publishes a page with nothing on it but the
    // generated block.
    //
    // BOTH shapes. `"\n"` is what the real command emits for an empty body —
    // `gh --jq` always terminates its output — so a refusal tested against `""`
    // alone sat on a shape production never produces, and the run failed one
    // step later complaining about a missing marker (found in review, probed
    // against the real output).
    for (const raw of ['\n', '']) {
      const { run } = recorder([raw]);
      expect(
        () => fetchUmbrellaBody(run, 'go-to-k/cdkd', 2762),
        `an empty body arriving as ${JSON.stringify(raw)} was accepted`
      ).toThrow(/EMPTY body/);
    }
  });

  it('passes the rewritten body by FILE, never as an argument', () => {
    // A body is multi-line text wrapped around human prose. The argv path keeps
    // it out of any shell and out of the process listing, and `--body-file`
    // keeps it out of argv as well.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-umbrella-'));
    try {
      const { run, calls } = recorder(['']);
      writeUmbrellaBody(run, 'go-to-k/cdkd', 2762, 'line one\nline two\n', dir);
      expect(calls[0]!.slice(0, 3)).toEqual(['issue', 'edit', '2762']);
      expect(calls[0]).toContain('--body-file');
      expect(calls[0]!.some((a) => a.includes('line two'))).toBe(false);
      const file = calls[0]![calls[0]!.indexOf('--body-file') + 1]!;
      expect(readFileSync(file, 'utf8')).toBe('line one\nline two\n');
      expect(calls[0]).toContain('--repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists the LEGACY per-type issues by label, open only', () => {
    // `--state open`, unlike the per-type reconciler's `--state all`: this pass
    // closes what is open and has no reason to see — or to touch — an issue
    // somebody already closed.
    const { run, calls } = recorder(['[{"number":10,"title":"t","body":"b"}]']);
    expect(fetchLegacyIssues(run, 'go-to-k/cdkd')).toEqual([{ number: 10, title: 't', body: 'b' }]);
    expect(calls[0]).toContain(LEGACY_SUBISSUE_LABEL);
    expect(calls[0]![calls[0]!.indexOf('--state') + 1]).toBe('open');
    expect(calls[0]![calls[0]!.indexOf('--limit') + 1]).toBe(String(LEGACY_LIST_LIMIT));
    // The BODY is fetched, or nothing can tell a generated slice from an issue
    // a human labelled — and this pass closes what it is handed.
    expect(calls[0]).toContain('number,title,body');
  });

  it('refuses a listing that is not an array rather than reading it as empty', () => {
    const { run } = recorder(['{"message":"Not Found"}']);
    expect(() => fetchLegacyIssues(run, 'go-to-k/cdkd')).toThrow(ReconcileRefusal);
  });

  it('refuses an ENTRY it cannot read, rather than closing the ones before it', () => {
    // An unvalidated cast reaches `gh issue close undefined`, which fails — but
    // only after every entry ahead of the bad one has already been closed.
    for (const bad of ['[{"title":"t","body":"b"}]', '[{"number":0,"title":"t","body":"b"}]', '[{"number":10,"title":"t"}]']) {
      const { run } = recorder([bad]);
      expect(() => fetchLegacyIssues(run, 'go-to-k/cdkd'), `${bad} was accepted`).toThrow(
        ReconcileRefusal
      );
    }
  });

  it('tells a GENERATED slice from an issue somebody merely labelled', () => {
    // The retired design keyed each issue to its type by this marker, and it is
    // the only thing distinguishing a bot-filed slice from a hand-labelled
    // issue. Closing the latter `not planned`, with a comment about a campaign
    // it is not part of, is the wrong-issue write this migration must not make.
    // The first line is COPIED from a live generated issue (go-to-k/cdkd#2956,
    // read 2026-09-19), not composed from the constant — the renderer that wrote
    // those 45 bodies was deleted by this change, so nothing else pins the
    // spelling against what is actually on GitHub. A drift makes the migration a
    // green no-op: "0 closed, 45 skipped".
    const LIVE_FIRST_LINE = '<!-- backfill-type: AWS::AutoScaling::AutoScalingGroup -->';
    expect(
      LIVE_FIRST_LINE.startsWith(LEGACY_TYPE_MARKER_PREFIX),
      'the marker constant no longer matches the bodies the retired renderer published'
    ).toBe(true);
    expect(
      isGeneratedLegacyIssue({ number: 9, title: 'live shape', body: `${LIVE_FIRST_LINE}\n\nbody` })
    ).toBe(true);

    const generated = {
      number: 10,
      title: 'Backfill silent-drop properties: AWS::S3::Bucket',
      body: `${LEGACY_TYPE_MARKER_PREFIX}AWS::S3::Bucket -->\n\nGenerated.`,
    };
    expect(isGeneratedLegacyIssue(generated)).toBe(true);
    // CRLF still matches, and what carries that is the LINE-START anchor: the
    // `\r` sits at the line END, where this test never looks. Stated because the
    // obvious repair — matching the whole marker line, or its suffix — would
    // break on exactly this input while every other case here stayed green.
    expect(isGeneratedLegacyIssue({ ...generated, body: generated.body.replace(/\n/g, '\r\n') })).toBe(
      true
    );
    expect(isGeneratedLegacyIssue({ number: 11, title: 'my own issue', body: 'no marker' })).toBe(
      false
    );
    // Not mid-line: this repository's own documentation quotes the marker while
    // explaining the mechanism, and a review can quote a body back.
    expect(
      isGeneratedLegacyIssue({
        number: 12,
        title: 'about the campaign',
        body: `see the ${LEGACY_TYPE_MARKER_PREFIX}AWS::S3::Bucket --> marker`,
      })
    ).toBe(false);
  });

  it('closes a legacy issue as NOT PLANNED, saying where its content went', () => {
    // `not planned` rather than `completed`: the type's properties are still
    // unwired. What ended is the ISSUE, and a `completed` close tells every
    // later reader — and every "what did we finish" query — the opposite.
    const { run, calls } = recorder(['']);
    closeLegacyIssue(run, 'go-to-k/cdkd', 10);
    expect(calls[0]!.slice(0, 3)).toEqual(['issue', 'close', '10']);
    expect(calls[0]![calls[0]!.indexOf('--reason') + 1]).toBe('not planned');
    expect(calls[0]![calls[0]!.indexOf('--comment') + 1]).toBe(LEGACY_CLOSE_COMMENT);
    expect(LEGACY_CLOSE_COMMENT, 'the comment does not say where the content went').toContain(
      'backfill-umbrella'
    );
  });
});

describe('cross-file fences', () => {
  it('leaves the workflow with no per-type label to create', () => {
    // The generated per-type label was CREATED by the workflow because
    // `gh issue create --label` fails on an unknown one. Nothing creates issues
    // any more, so a `SUBISSUE_LABEL` env or a `gh label create` left behind is
    // a live remnant of the retired design rather than dead text: it would
    // re-create the label this migration is retiring.
    const workflow = readFileSync(
      join(REPO_ROOT, '.github/workflows/backfill-umbrella-sync.yml'),
      'utf8'
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = parseYaml(workflow);
    const steps: Array<{ env?: Record<string, string> }> = parsed.jobs.sync.steps;
    for (const step of steps) {
      expect(step.env?.['SUBISSUE_LABEL'], 'the per-type label env is back').toBeUndefined();
    }
    expect(workflow, 'the workflow still creates the per-type label').not.toContain(
      'gh label create'
    );
    // And the umbrella's own label is still the lookup key — the one label this
    // design has left.
    const reconcile = steps.find((s) => s.env?.['BACKFILL_UMBRELLA_LABEL'] !== undefined);
    expect(reconcile, 'no step defines BACKFILL_UMBRELLA_LABEL').toBeDefined();
    expect(reconcile!.env!['BACKFILL_UMBRELLA_LABEL']).not.toBe(LEGACY_SUBISSUE_LABEL);
  });

  it('documents both markers in the runbook, in the spelling the script uses', () => {
    // The markers are a CONTRACT with a human: a body that lost them is refused,
    // and the recovery is "put these two lines back". A runbook quoting a
    // different spelling sends the operator to write a marker this script will
    // not find, which is the one recovery that must not go stale. Built FROM the
    // constants, so a rename fails here rather than leaving the page wrong.
    const runbook = readFileSync(join(REPO_ROOT, 'docs/schema-refresh-runbook.md'), 'utf8');
    expect(runbook).toContain(BLOCK_START);
    expect(runbook).toContain(BLOCK_END);
    // And the two recipes a reader needs when it refuses, by the spellings the
    // CLI answers to. A bare `toContain('legacy')` stood here and tested
    // nothing: the word appears in a 500-line file for any number of reasons,
    // while the failure message claimed it fenced the per-type set's retirement
    // (found in review).
    expect(runbook, 'the runbook does not name the mode that prints the block').toContain(
      '--render-block'
    );
    expect(runbook, 'the runbook does not name the one-shot migration').toContain('--close-legacy');
    expect(
      runbook,
      'the runbook no longer says the `backfill-type` label is legacy'
    ).toMatch(/`backfill-type`[^.]*\*\*legacy\*\*/);
  });

  it('excludes the label from EVERY backlog listing in /work-issues, not just the first', () => {
    // The generated set is closed, but the label outlives it and a reopened
    // legacy issue is still not backlog: nothing triages one, and its
    // `created_at` is whenever the coverage map last moved.
    //
    // DERIVED, not spot-checked, because the first cut of this fence was a bare
    // `toContain(LABEL)` over the whole file and passed while THREE of the four
    // listings had no filter — including §3-0's, which is the one that actually
    // produces the eligible set. A listing added later must fail here rather
    // than be remembered.
    // The population is BOTH files that list open issues, not `triage.md`
    // alone: `retro.md` counts issues whose body gained a `- [ ] ` row.
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
      // message interpolated it let a rename of the constant pass with the
      // documents left stale. ESCAPED on the way in: `backfill-type` is
      // regex-inert today, but a value carrying `.` or `+` would silently LOOSEN
      // the fence rather than break it, which is the direction that goes
      // unnoticed.
      const label = LEGACY_SUBISSUE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const negated = new RegExp(`index\\((\\\\)?"${label}(\\\\)?"\\)\\s*\\|\\s*not`);
      expect(
        negated.test(listing),
        `this backlog listing does not EXCLUDE '${LEGACY_SUBISSUE_LABEL}': ${first}`
      ).toBe(true);
    }
    // And the UMBRELLA's own label, in the one listing where the fold-back made
    // it matter: §10 counts issues whose body gained a `- [ ] ` row, and every
    // row of the campaign now lives in the umbrella's body — so one sync makes a
    // run that folded nothing report up to 44 findings folded. This is the
    // per-type set's hazard, inherited by the issue that absorbed it.
    const retro = sources[1]!;
    expect(
      /index\("backfill-umbrella"\)\s*\|\s*not/.test(retro),
      "retro.md's folded-finding count does not exclude the umbrella, whose body is now all rows"
    ).toBe(true);
    // And `filing.md`'s claim ABOUT that exclusion, which is the sentence a
    // future session reads before deciding whether to re-fan the campaign into
    // per-type issues. Asserted as the ENUMERATION, because the claim this
    // replaced was the false universal "§3's backlog listing EXCLUDES the
    // label" — which contains the substring a `toContain('EXCLUDES the label')`
    // would have matched, so reverting to the false sentence kept that
    // assertion green.
    const filing = readFileSync(
      join(REPO_ROOT, '.claude/skills/work-issues/references/filing.md'),
      'utf8'
    );
    // ONE regex spanning head -> VERB, plus the anchors. Dropping the verb —
    // `toMatch(/Every backlog listing in .triage\.md./)` with separate §-anchor
    // assertions — survives flipping EXCLUDES to INCLUDES, which is precisely
    // the mutation a cruder `toContain('EXCLUDES the label')` DID catch.
    // The span is bounded to ONE PARAGRAPH, and what that buys is narrower than
    // it looks: the claim's bullet list is CONTIGUOUS, so `(?!\n\n)` bounds the
    // span to the whole list rather than to one bullet. What the bound does
    // catch is a detach across a blank line, and a second occurrence added later
    // to rescue an inverted first one.
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
    // And the retro.md half. Asserting the FILENAME alone reds on deleting the
    // clause but not on inverting it. Note what carries the polarity here: "and
    // so does" is INSIDE the matched head literal, so an in-place inversion reds
    // on the head by itself.
    expect(filing, 'the retro.md half of the claim is unasserted or invertible').toMatch(
      new RegExp(`and so does §10's folded-finding count in \`retro\\.md\`${para}matters`)
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
 * Everything above drives exported functions; `main()` and `isMain()` are
 * reached by nothing else, and the live workflow case stubs `node` away entirely
 * — so the argv parsing, the `REPO` / `PARENT` contract, the usage exit, the
 * not-a-plan refusal, the exit-1-vs-2 split the file's header argues at length,
 * and every operator mode the runbook documents (`--render-block`, `--dry-run`,
 * `--allow-empty-plan`, `--close-legacy`) would otherwise be untested. That is
 * the half that writes a public page.
 *
 * A stub `gh` on PATH keeps every case offline AND is the assertion for the most
 * important ones: a dry run must issue no writing verb, and `--render-block`
 * must not reach `gh` at all. The stub fails CLOSED on anything it does not
 * model, so a case cannot pass by reaching a command nobody thought about.
 */
describe('the CLI, spawned', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts/sync-backfill-umbrella.ts');

  function sandbox(body: string, listing: unknown[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-umbrella-cli-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    // `gh --jq` terminates the field with a newline, which the reader strips.
    writeFileSync(join(dir, 'body.md'), `${body}\n`);
    writeFileSync(join(dir, 'listing.json'), JSON.stringify(listing));
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/bash
echo "gh $*" >> "$GH_LOG"
case "$1 $2" in
  "issue view") cat "$GH_BODY" ;;
  "issue list") cat "$GH_LISTING" ;;
  "issue edit") cp "\${@: -1}" "$GH_WRITTEN" ;;
  "issue close") ;;
  *) echo "stub gh: unmodelled subcommand: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 }
    );
    return { dir, bin, log: join(dir, 'gh.log'), written: join(dir, 'written.md') };
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
        GH_BODY: join(box.dir, 'body.md'),
        GH_LISTING: join(box.dir, 'listing.json'),
        GH_WRITTEN: box.written,
        ...env,
      },
    });

  const planFile = (dir: string, plan: unknown) => {
    const p = join(dir, 'plan.json');
    writeFileSync(p, JSON.stringify(plan));
    return p;
  };

  const LIVE_PLAN = { types: [{ type: 'AWS::S3::Bucket', properties: ['A', 'B'] }] };

  it('--render-block prints the block and never reaches gh', () => {
    // How the two markers get their first content: a body that has never been
    // synced is REFUSED, so the operator pastes this in once. It takes no token
    // and no repository, which is what makes it safe to run anywhere — asserted
    // by the absence of a `gh` log rather than by the exit code.
    const box = sandbox(bodyWith('x'));
    try {
      const plan = planFile(box.dir, LIVE_PLAN);
      const res = spawnCli(box, [plan, '--render-block'], {});
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain(BLOCK_START);
      expect(res.stdout).toContain('- [ ] `AWS::S3::Bucket` — 2 properties: `A`, `B`');
      expect(res.stdout).toContain(BLOCK_END);
      expect(existsSync(box.log), '--render-block called gh').toBe(false);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('a --dry-run reads the body, prints the block and writes NOTHING', () => {
    // The runbook's "see what a run WOULD do" recipe. Asserted by what the stub
    // `gh` was asked for, not by the exit code: a dry run that silently rewrote
    // the issue would exit 0 too.
    const box = sandbox(bodyWith('- [ ] stale'));
    try {
      const plan = planFile(box.dir, LIVE_PLAN);
      const res = spawnCli(box, [plan, '--dry-run'], { REPO: 'go-to-k/cdkd', PARENT: '2762' });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain('CHANGES');
      expect(res.stdout).toContain('- [ ] `AWS::S3::Bucket` — 2 properties: `A`, `B`');
      const calls = readFileSync(box.log, 'utf8');
      expect(calls).toContain('gh issue view');
      for (const verb of ['issue edit', 'issue close', 'issue create', 'api']) {
        expect(calls, `a dry run reached '${verb}'`).not.toContain(verb);
      }
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('a REAL run rewrites the block and leaves the human half alone', () => {
    const box = sandbox(bodyWith('- [ ] stale'));
    try {
      const plan = planFile(box.dir, LIVE_PLAN);
      const res = spawnCli(box, [plan], { REPO: 'go-to-k/cdkd', PARENT: '2762' });
      expect(res.status, res.stderr).toBe(0);
      const written = readFileSync(box.written, 'utf8');
      expect(written).toContain('- [ ] `AWS::S3::Bucket` — 2 properties: `A`, `B`');
      expect(written, 'the rewrite dropped the human half').toContain('Closed by PR #123');
      expect(written).not.toContain('- [ ] stale');
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('makes NO write when the block already says what the plan says', () => {
    // End to end, because the no-op is the property that keeps a push-triggered
    // job from being noise, and the pure case above cannot see a `main()` that
    // writes regardless of what it computed.
    const current = bodyWith('- [ ] `AWS::S3::Bucket` — 2 properties: `A`, `B`');
    const box = sandbox(current);
    try {
      const plan = planFile(box.dir, LIVE_PLAN);
      const res = spawnCli(box, [plan], { REPO: 'go-to-k/cdkd', PARENT: '2762' });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain('no write');
      expect(readFileSync(box.log, 'utf8'), 'an unchanged run still edited the issue').not.toContain(
        'issue edit'
      );
      expect(existsSync(box.written)).toBe(false);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a document that is not a plan, naming the file', () => {
    // Exit 1 is a REFUSAL a human acts on from the runbook; 2 is "could not
    // evaluate". Collapsing them makes the runbook's per-refusal recovery
    // unreachable.
    const box = sandbox(bodyWith('x'));
    try {
      const plan = planFile(box.dir, { notTypes: [] });
      const res = spawnCli(box, [plan, '--dry-run'], { REPO: 'go-to-k/cdkd', PARENT: '2762' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('not a rendered plan');
      expect(res.stderr, 'the refusal does not say WHICH document').toContain('plan.json');
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses an empty plan against a live checklist, and --allow-empty-plan clears it', () => {
    // Both halves, because a refusal with no way through would leave a genuinely
    // finished campaign publishing a stale list forever — and the flag is the
    // runbook's documented recovery.
    const box = sandbox(bodyWith('- [ ] `AWS::S3::Bucket` — 1 property: `A`'));
    try {
      const plan = planFile(box.dir, { types: [] });
      const env = { REPO: 'go-to-k/cdkd', PARENT: '2762' };
      const refused = spawnCli(box, [plan, '--dry-run'], env);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('--allow-empty-plan');

      const allowed = spawnCli(box, [plan, '--dry-run', '--allow-empty-plan'], env);
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stdout).toContain(UMBRELLA_EMPTY_SENTINEL);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('needs REPO and PARENT, and says so with exit 2', () => {
    // `REPO` is the one the live workflow case cannot see — its spawn env omits
    // it — so a step that stopped exporting it would fail only at runtime.
    const box = sandbox(bodyWith('x'));
    try {
      const plan = planFile(box.dir, { types: [] });
      const partial: Record<string, string>[] = [{ PARENT: '2762' }, { REPO: 'go-to-k/cdkd' }, {}];
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

  it('--close-legacy closes each open per-type issue, and a dry run closes none', () => {
    // The one-shot migration, run by hand after the fold-back merges. Both arms:
    // the dry run is what an operator uses to see the blast radius first, and a
    // dry run that closed anything would be discovered on ~44 public issues.
    const generated = (number: number, type: string) => ({
      number,
      title: `Backfill silent-drop properties: ${type}`,
      body: `${LEGACY_TYPE_MARKER_PREFIX}${type} -->\n\nGenerated.`,
    });
    const box = sandbox(bodyWith('x'), [
      generated(10, 'AWS::S3::Bucket'),
      generated(11, 'AWS::SQS::Queue'),
      // A human's issue that merely wears the label. It must survive the pass.
      { number: 12, title: 'my own note about the campaign', body: 'no marker here' },
    ]);
    try {
      const dry = spawnCli(box, ['--close-legacy', '--dry-run'], { REPO: 'go-to-k/cdkd' });
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toContain('[dry-run] close #10');
      expect(readFileSync(box.log, 'utf8')).not.toContain('issue close');

      const res = spawnCli(box, ['--close-legacy'], { REPO: 'go-to-k/cdkd' });
      expect(res.status, res.stderr).toBe(0);
      const calls = readFileSync(box.log, 'utf8');
      expect(calls).toContain('gh issue close 10');
      expect(calls).toContain('gh issue close 11');
      expect(calls).toContain('--reason not planned');
      expect(calls).toContain(LEGACY_CLOSE_COMMENT);
      // The hand-labelled issue is SKIPPED and NAMED, not closed with a comment
      // about a campaign it is not part of.
      expect(calls, 'a hand-labelled issue was closed').not.toContain('gh issue close 12');
      expect(res.stdout).toContain('SKIPPED #12');
      // It never touches the umbrella on this path: the migration closes issues
      // and nothing else.
      expect(calls, 'the migration rewrote a body').not.toContain('issue edit');
      expect(res.stdout).toContain('2 legacy issue(s) closed, 1 skipped.');
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses an unrecognized flag instead of ignoring it', () => {
    // `--close-legacy --dry-runn` is the case: a dropped typo turns the
    // operator's rehearsal into the real pass across ~44 public issues. Both
    // halves asserted — the refusal, and that the stub `gh` was never reached,
    // since an exit code alone cannot say whether anything was closed first.
    const box = sandbox(bodyWith('x'), [
      { number: 10, title: 't', body: `${LEGACY_TYPE_MARKER_PREFIX}AWS::S3::Bucket -->` },
    ]);
    try {
      const res = spawnCli(box, ['--close-legacy', '--dry-runn'], { REPO: 'go-to-k/cdkd' });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('unrecognized flag(s): --dry-runn');
      expect(existsSync(box.log), 'the typo run still reached gh').toBe(false);
      // And the two MODES are exclusive, rather than resolved by reading order.
      const both = spawnCli(box, ['--render-block', '--close-legacy'], { REPO: 'go-to-k/cdkd' });
      expect(both.status).toBe(2);
      expect(both.stderr).toContain('different jobs');
      // Every flag the usage line advertises is in the known set, or the refusal
      // above rejects the documented invocation.
      for (const flag of ['--dry-run', '--allow-empty-plan', '--render-block', '--close-legacy']) {
        expect(KNOWN_CLI_FLAGS.has(flag), `${flag} is documented but not known`).toBe(true);
      }
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 60_000);
});
