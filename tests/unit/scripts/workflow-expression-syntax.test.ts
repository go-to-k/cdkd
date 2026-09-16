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
 * run. Nothing local caught it, and NOT for want of a workflow reader: seven
 * suites read these files (`cfn-schema-refresh-workflow`,
 * `backfill-umbrella-sync-workflow`, `workflow-registration`, `ci-ok-gate`,
 * `release-pr-staleness`, `release-please-v0`, `node-floor-sync`), and
 * `workflow-registration.test.ts` `readdirSync`s the whole directory and
 * `yaml`-parses every file. They read STRUCTURE and named literals, and the
 * YAML is WELL-FORMED — the defect lives one layer further in, inside a scalar
 * every one of them parsed successfully.
 *
 * What makes it worth a fence rather than a one-line fix is that the SAME PROSE
 * sat twice more in the same file and was HARMLESS both times: two real YAML
 * comments, which never reach the expression parser at all. So the sequence was
 * correct on one line and fatal forty lines later, told apart only by whether
 * the reader had noticed they were inside a block scalar. A rule re-derived
 * from indentation on every edit is one that comes back, so this scans the RAW
 * TEXT and refuses the shape EVERYWHERE, YAML comments included — a deliberate
 * OVER-refusal, and the cheaper half of the trade. The alternative is a
 * comment-aware scanner that has to get right the same distinction a human just
 * got wrong, and the cost of the over-refusal is one reworded sentence.
 *
 * WHAT THE ORACLE IS. The PARSER'S question, not this repo's style preference:
 * a real opener in a `run:` body is legal and two exist on purpose
 * (`github.repository_owner` in the refresh's PR guard, `matrix.node-version`
 * in `ci.yml`'s runtime-compat job), so a blanket "no opener in a shell body"
 * would red on working code.
 *
 * It is a GRAMMAR check and not a character-set one, because a character set is
 * wrong in both directions at once and the review that measured it found both:
 *
 *   * it ACCEPTS punctuation-free prose. `${{ github expressions }}` and
 *     `${{ the same rule }}` — the nearest neighbours of the shipped defect,
 *     the same sentence with one word between the braces instead of none —
 *     carry the identical blast radius and passed a letters-and-spaces class.
 *   * it REJECTS ordinary Actions. `format('{0}-{1}', …)`,
 *     `fromJSON('{"a":1}')` and `steps.x.outputs.y || 'default: none'` all
 *     carry characters no reasonable class admits, so the first workflow to
 *     use one would red a CI-blocking fence with a false diagnosis.
 *
 * The token walk below settles both from one rule — operands and operators must
 * ALTERNATE — because prose is a run of adjacent operands while `{`, `}`, `:`
 * and `@` only ever appear inside a quoted string, which is one token.
 */
import { describe, expect, it } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * One token of an Actions expression, in priority order: whitespace, a
 * single-quoted string (with `''` as the escape), a dotted context path, a
 * number, a two-character operator, then a one-character one.
 *
 * A path segment admits `-` because `ci.yml` writes `matrix.node-version` and
 * Actions accepts it. Nothing is lost if a future reader prefers to call that
 * subtraction: `a.node - version` is operand / operator / operand, which
 * alternates either way.
 */
const TOKEN =
  /\s+|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\*))*|[0-9]+(?:\.[0-9]+)?|==|!=|<=|>=|&&|\|\||[<>!(),.[\]*+/%-]/y;

const OPEN = new Set(['(', '[']);
const CLOSE = new Set([')', ']']);
const INFIX = new Set([
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<',
  '>',
  '*',
  '+',
  '-',
  '/',
  '%',
  ',',
  '.',
]);

/**
 * Whether `body` could be an Actions expression.
 *
 * DELIBERATELY PERMISSIVE where it is unsure — it accepts `(a,)` and `f(,b)`,
 * which no grammar does. That direction is the safe one for a fence: an
 * over-acceptance costs the coverage of a shape nobody writes, while an
 * over-refusal reds CI on working code with a message blaming the author, which
 * is the failure mode this file's header is about. What it must never do is
 * accept two operands in a row, because that is what prose is.
 */
export const isReadableExpression = (body: string): boolean => {
  TOKEN.lastIndex = 0;
  let at = 0;
  let expect: 'operand' | 'operator' = 'operand';
  let depth = 0;
  while (at < body.length) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(body);
    // No token matches here, so the body carries a character that appears in no
    // expression outside a string — `#`, `$`, `{`, `"`, an em dash, a backtick.
    if (m === null) return false;
    at = TOKEN.lastIndex;
    const tok = m[0];
    if (/^\s+$/.test(tok)) continue;
    if (expect === 'operand') {
      if (tok === '!') continue;
      if (OPEN.has(tok)) {
        depth++;
        continue;
      }
      // An empty argument list: `always()` reaches `)` still expecting an
      // operand. Only inside a group — a bare `)` is unbalanced.
      if (CLOSE.has(tok)) {
        if (depth === 0) return false;
        depth--;
        expect = 'operator';
        continue;
      }
      if (INFIX.has(tok)) return false;
      expect = 'operator';
      continue;
    }
    // A call or an index: `format(` / `github.event['x']`.
    if (OPEN.has(tok)) {
      depth++;
      expect = 'operand';
      continue;
    }
    if (CLOSE.has(tok)) {
      if (depth === 0) return false;
      depth--;
      continue;
    }
    if (INFIX.has(tok)) {
      expect = 'operand';
      continue;
    }
    // Two operands in a row — the prose shape.
    return false;
  }
  return expect === 'operator' && depth === 0;
};

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
        // The MEASURED message, from the run that reported the shipped defect.
        reason:
          'empty expression body — inside a `run:` body Actions answers "An expression was expected" and refuses the whole file',
        text: source.slice(at, close + 2),
      });
      continue;
    }
    if (!isReadableExpression(body)) {
      offences.push({
        file,
        line: lineOf(at),
        reason:
          'expression body is prose, not an expression — inside a `run:` body this refuses the whole file the same way an empty one does',
        text: source.slice(at, close + 2),
      });
    }
  }
  return offences;
};

const workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));

describe('workflow expression syntax', () => {
  /**
   * CAPACITY, from two directions because either alone goes quiet. A floor
   * catches a read that came back empty; it does NOT catch a read that came
   * back SHORT, and a floor set to today's count would red on the next
   * legitimate deletion — the ratchet this repo has been bitten by. So the SET
   * is compared against what git tracks, which cannot drift, and the floor is
   * left loose to cover the case where BOTH reads collapse together.
   */
  it('reads every workflow file the repository tracks', () => {
    expect(workflowFiles.length).toBeGreaterThanOrEqual(8);
    const tracked = execFileSync('git', ['ls-files', '--', '.github/workflows'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((p) => /\.ya?ml$/.test(p))
      .map((p) => p.slice(p.lastIndexOf('/') + 1));
    expect([...workflowFiles].sort()).toEqual([...tracked].sort());
  });

  it.each(workflowFiles)('%s carries no unreadable expression', (name) => {
    const source = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
    const offences = findExpressionOffences(name, source);
    expect(
      offences.map((o) => `${o.file}:${o.line}: ${o.reason} — ${o.text}`),
      'an expression Actions cannot read invalidates the ENTIRE workflow file, so the job simply stops being scheduled. A real YAML comment is refused too, deliberately: write "expression" in words there — the header says why',
    ).toEqual([]);
  });

  /**
   * The grammar's ACCEPT side, measured against the corpus rather than against
   * examples chosen to suit it. Without this a validator that refused
   * everything would still pass every case above on a clean tree, since a clean
   * tree's offence list is empty either way — only real bodies discriminate.
   */
  describe('accepts every expression the repository actually writes', () => {
    const bodies = workflowFiles.flatMap((name) => {
      const source = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
      const found: string[] = [];
      for (let at = source.indexOf('${{'); at !== -1; at = source.indexOf('${{', at + 3)) {
        const close = source.indexOf('}}', at + 3);
        if (close !== -1) found.push(source.slice(at + 3, close));
      }
      return found;
    });

    it('found a corpus worth checking', () => {
      // Measured 2026-09-16 at 86. Floored well under, since the number moves
      // with ordinary workflow edits; its job is to catch a collapse to zero,
      // which would make every case below vacuous.
      expect(bodies.length).toBeGreaterThanOrEqual(40);
    });

    it('every one of them is readable', () => {
      expect(bodies.filter((b) => !isReadableExpression(b))).toEqual([]);
    });
  });

  /**
   * The shapes the corpus does not contain, so the grammar is not calibrated
   * only against what happens to be in the tree today. The rejects are the half
   * that matters: they are what a permissive validator gets wrong.
   */
  describe('grammar, on shapes outside the corpus', () => {
    it.each([
      "format('{0}-{1}', github.repository, github.sha)",
      'fromJSON(\'{"a":1}\').a',
      "steps.x.outputs.y || 'default: none'",
      "contains(github.event.pull_request.labels.*.name, 'skip')",
      '!cancelled() && needs.build.result == \'success\'',
      "github.event.issue.user.login == 'dependabot[bot]'",
      'matrix.node-version',
      "toJSON(fromJSON(steps.x.outputs.y)['a'])",
    ])('accepts %s', (body) => {
      expect(isReadableExpression(` ${body} `)).toBe(true);
    });

    it.each([
      ['empty', ''],
      ['blank', '   '],
      // The nearest neighbours of the shipped defect: the same sentence with a
      // word between the braces instead of nothing. A character-set oracle
      // passed all four.
      ['prose, two words', ' github expressions '],
      ['prose, three words', ' the same rule '],
      ['prose, a quoted mention', ' NOT interpolated here '],
      ['a shell variable', ' ${GH_TOKEN} '],
      ['an unbalanced group', ' format(github.sha '],
      ['a trailing operator', " github.ref == "],
    ])('rejects %s', (_label, body) => {
      expect(isReadableExpression(body)).toBe(false);
    });
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

    const mutate = (line: string): string => {
      expect(REAL).toContain(ANCHOR);
      const mutated = REAL.replace(ANCHOR, `${line}\n${ANCHOR}`);
      expect(mutated).not.toEqual(REAL);
      return mutated;
    };

    it('reports the shell comment that broke the daily job', () => {
      const mutated = mutate('          # output, and NOT interpolated with `${{ }}` — the same rule the');
      const offences = findExpressionOffences('cfn-schema-refresh.yml', mutated);
      expect(offences).toHaveLength(1);
      expect(offences[0]?.reason).toContain('empty expression body');
      // The line the scanner names is the one a reader has to edit.
      expect(mutated.split('\n')[offences[0]!.line - 1]).toContain('NOT interpolated with');
    });

    it('reports the SAME comment with a word inside the braces', () => {
      // Distinct from the case above on purpose: the empty-body branch catches
      // that one whatever the grammar does, so without this case a validator
      // that accepted everything would still look green here.
      const mutated = mutate('          # output, and NOT interpolated with `${{ the same rule }}` — so');
      const offences = findExpressionOffences('cfn-schema-refresh.yml', mutated);
      expect(offences).toHaveLength(1);
      expect(offences[0]?.reason).toContain('prose, not an expression');
    });

    it('does NOT report the same comment once it names a real context', () => {
      // The discriminator for the case above: an over-refusing grammar reds
      // here, and a fence that reds on working code gets deleted.
      const mutated = mutate('          # output — see `${{ steps.publish.outputs.pr_number }}` above');
      expect(findExpressionOffences('cfn-schema-refresh.yml', mutated)).toEqual([]);
    });

    it('leaves the unmutated file clean, so the cases above are not reporting everything', () => {
      expect(findExpressionOffences('cfn-schema-refresh.yml', REAL)).toEqual([]);
    });

    it('reports a stray opener mid-file, whichever way it pairs up', () => {
      // An unterminated opener does not stay unterminated in a real file: the
      // scan pairs it with some LATER step's `}}`, and the prose it swallows on
      // the way is what gets reported. Either reason is a report, so the case
      // pins the LINE — the thing a reader has to act on — not the wording.
      const mutated = mutate('          # a stray ${{ opener');
      const offences = findExpressionOffences('cfn-schema-refresh.yml', mutated);
      expect(offences).toHaveLength(1);
      expect(mutated.split('\n')[offences[0]!.line - 1]).toContain('a stray');
    });

    it('reports an opener with nothing after it to close against', () => {
      const offences = findExpressionOffences(
        'cfn-schema-refresh.yml',
        `${REAL}\n# ${'${{'} dangling`,
      );
      expect(offences).toHaveLength(1);
      expect(offences[0]?.reason).toContain('never closed');
    });

    it('accepts the legitimate opener the refresh already carries in a run body', () => {
      expect(REAL).toContain('${{ github.repository_owner }}');
      expect(findExpressionOffences('cfn-schema-refresh.yml', REAL)).toEqual([]);
    });
  });
});
