/**
 * Issue [#3195](https://github.com/go-to-k/cdkd/issues/3195) — every `${{ … }}`
 * in `.github/workflows/**` must carry something the Actions expression parser
 * can read.
 *
 * WHY A FENCE AND NOT A REVIEW NOTE. go-to-k/cdkd#3173 added a step whose
 * `run:` body contained the SHELL COMMENT
 * `# … NOT interpolated with \`${{ }}\` — the same rule …`. Actions scans the
 * whole `run:` string for expression openers and does not care that one sits
 * behind a `#`, so the empty body is a parse error:
 *
 *     Invalid workflow file: .github/workflows/cfn-schema-refresh.yml#L1
 *     (Line: 588, Col: 14): An expression was expected
 *
 * One parse error invalidates the WHOLE file, so the daily schema-drift job
 * stopped being scheduled — the silent watch failure its own header says it
 * exists to prevent — and every push to every branch minted a zero-job failing
 * run. Nothing local caught it: the YAML is well-formed (`yaml` parses it
 * cleanly), `vp run lint` does not read workflows, and the repo's two workflow
 * suites read STRUCTURE and named literals rather than expression syntax.
 *
 * What makes it worth a fence rather than a one-line fix is that the SAME PROSE
 * sat twice more in the same file, and was HARMLESS both times: two real YAML
 * comments, which never reach the expression parser at all. So the sequence was
 * correct on one line and fatal forty lines later, told apart only by whether
 * the reader had noticed they were inside a block scalar. A rule re-derived
 * from indentation on every edit is one that comes back, so this scans the RAW
 * TEXT and refuses the shape everywhere — and the two innocent comments were
 * reworded to say "expression" in words rather than carry the opener. The cost
 * is a sentence; the alternative is a comment-aware scanner that has to get the
 * same distinction right that a human just got wrong.
 *
 * Within that, the oracle is the PARSER'S question rather than this repo's
 * style preference: a real opener in a `run:` body is legal and two exist on
 * purpose (`github.repository_owner` in the refresh's PR guard,
 * `matrix.node-version` in `ci.yml`'s runtime-compat job), so a blanket "no
 * opener in a shell body" fence would red on working code.
 */
import { describe, expect, it } from 'vite-plus/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * Every character GitHub's expression grammar can contain: identifiers and
 * property paths, literals, index and call syntax, and the operator set. A body
 * built only of these is not necessarily a VALID expression — this is not a
 * grammar — but anything outside the set is prose, and prose is what the defect
 * class looks like.
 */
const EXPRESSION_CHARS = /^[A-Za-z0-9_.\-[\]()'"!=<>&|*,+/%\s]+$/;

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly text: string;
}

/**
 * Scans RAW TEXT rather than the parsed document, because the two places the
 * sequence can appear — a YAML comment and a block scalar — are
 * indistinguishable after parsing in the direction that matters: the comment is
 * simply gone. Reading the text is what lets a case say WHERE it is, which is
 * the whole difficulty of the class.
 */
export const findExpressionOffences = (file: string, source: string): Offence[] => {
  const offences: Offence[] = [];
  const lineOf = (index: number): number => source.slice(0, index).split('\n').length;
  for (let at = source.indexOf('${{'); at !== -1; at = source.indexOf('${{', at + 3)) {
    const close = source.indexOf('}}', at + 3);
    if (close === -1) {
      offences.push({
        file,
        line: lineOf(at),
        reason: 'expression opener is never closed',
        text: source.slice(at, at + 60),
      });
      continue;
    }
    const body = source.slice(at + 3, close);
    if (body.trim() === '') {
      offences.push({
        file,
        line: lineOf(at),
        reason:
          'empty expression body — Actions reports "An expression was expected" and refuses the whole file',
        text: source.slice(at, close + 2),
      });
      continue;
    }
    if (!EXPRESSION_CHARS.test(body)) {
      offences.push({
        file,
        line: lineOf(at),
        reason: 'expression body contains characters no expression can contain',
        text: source.slice(at, close + 2),
      });
    }
  }
  return offences;
};

const workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));

describe('workflow expression syntax', () => {
  /**
   * CAPACITY. A directory read that came back empty — a rename, a move, a
   * relocated repo root — would leave every case below iterating nothing and
   * passing, which is the same green as a repo with no defect.
   */
  it('reads a workflow directory that is actually populated', () => {
    expect(workflowFiles.length).toBeGreaterThanOrEqual(8);
    expect(workflowFiles).toContain('cfn-schema-refresh.yml');
  });

  it.each(workflowFiles)('%s carries no unreadable expression', (name) => {
    const source = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
    const offences = findExpressionOffences(name, source);
    expect(
      offences.map((o) => `${o.file}:${o.line}: ${o.reason} — ${o.text}`),
      'an expression Actions cannot read invalidates the ENTIRE workflow file, so the job simply stops being scheduled',
    ).toEqual([]);
  });

  /**
   * The scanner is probed against REAL code, not a synthetic string: a fixture
   * written to suit the checker shares the checker's blind spot. The mutation
   * is the historical defect, put back in the exact shape go-to-k/cdkd#3173
   * shipped it — inside the `run:` body of the fragment step, behind a `#`.
   */
  describe('probed by restoring the defect to the file it shipped in', () => {
    const REAL = readFileSync(join(WORKFLOW_DIR, 'cfn-schema-refresh.yml'), 'utf8');
    const ANCHOR = '          # Publish left this working tree on the branch it pushed, both on the';

    it('reports the shell comment that broke the daily job', () => {
      expect(REAL).toContain(ANCHOR);
      const mutated = REAL.replace(
        ANCHOR,
        '          # output, and NOT interpolated with `${{ }}` — the same rule the\n' + ANCHOR,
      );
      expect(mutated).not.toEqual(REAL);
      const offences = findExpressionOffences('cfn-schema-refresh.yml', mutated);
      expect(offences).toHaveLength(1);
      expect(offences[0]?.reason).toContain('empty expression body');
      // The line the scanner names is the one a reader has to edit.
      expect(mutated.split('\n')[offences[0]!.line - 1]).toContain('NOT interpolated with');
    });

    it('leaves the unmutated file clean, so the case above is not reporting everything', () => {
      expect(findExpressionOffences('cfn-schema-refresh.yml', REAL)).toEqual([]);
    });

    it('reports a stray opener mid-file, whichever way it pairs up', () => {
      // An unterminated opener does not stay unterminated in a real file: the
      // scan pairs it with some LATER step's `}}`, and the prose it swallows on
      // the way is what gets reported. Either reason is a report, so the case
      // pins the LINE — the thing a reader has to act on — not the wording.
      const mutated = REAL.replace(ANCHOR, '          # a stray ${{ opener\n' + ANCHOR);
      const offences = findExpressionOffences('cfn-schema-refresh.yml', mutated);
      expect(offences).toHaveLength(1);
      expect(mutated.split('\n')[offences[0]!.line - 1]).toContain('a stray');
    });

    it('reports an opener with nothing after it to close against', () => {
      const offences = findExpressionOffences('cfn-schema-refresh.yml', `${REAL}\n# ${'${{'} dangling`);
      expect(offences).toHaveLength(1);
      expect(offences[0]?.reason).toContain('never closed');
    });

    it('accepts the two legitimate openers a run body already carries', () => {
      expect(REAL).toContain('${{ github.repository_owner }}');
      expect(findExpressionOffences('cfn-schema-refresh.yml', REAL)).toEqual([]);
    });
  });
});
