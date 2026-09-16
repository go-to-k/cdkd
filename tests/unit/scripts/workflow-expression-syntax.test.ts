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
 * run. Nothing local caught it, and NOT for want of a workflow reader: plenty
 * of suites under `tests/unit/**` read these files, one of them
 * (`workflow-registration.test.ts`) `readdirSync`ing the whole directory and
 * `yaml`-parsing every file. No count is given, because two successive attempts
 * at one here were both wrong (2, then 7, against a measured 20-odd) and the
 * obvious `grep -rl '\.github/workflows' tests/unit` answers a DIFFERENT
 * question — files MENTIONING the path — over-counting a prose mention and
 * missing a reader that builds the path with `join`. What is load-bearing needs
 * no number: they read STRUCTURE and named literals, and the YAML is
 * WELL-FORMED, so the defect lives one layer further in, inside a scalar every
 * one of them parsed successfully.
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
 * The documented roots of an Actions expression: every context, every built-in
 * function, and the three literals. A bare identifier that is none of these is
 * `Unrecognized named-value` to Actions, which invalidates the file exactly as
 * an empty body does.
 *
 * This is what closes the ONE-WORD hole, and the hole matters more than its
 * size suggests: `${{ expression }}` / `${{ opener }}` / `${{ context }}` is
 * the likeliest wording of a REINTRODUCTION — a future editor writing the very
 * sentence this fence exists because of, with one word between the braces
 * instead of none. The alternation rule cannot reach it, because one token is
 * not a run of adjacent operands.
 *
 * CONTEXTS AND FUNCTIONS ARE SEPARATE SETS, and collapsing them into one left
 * the hole half open. A function name is not a named VALUE: Actions answers
 * `Unrecognized named-value: 'format'` to `${{ format }}` and refuses the file
 * exactly as it does for the empty body. Six of the twelve — `format`, `join`,
 * `contains`, `always`, `success`, `failure` — are ordinary English words, so a
 * single set readmitted the very class this arm exists to close. A function
 * head therefore counts only when a `(` follows it.
 *
 * RESIDUAL: when GitHub adds a context or function, the first workflow to use
 * it reds here. That is an over-refusal on working code — the failure mode this
 * file's header is about — so that case gets its own message naming the remedy
 * (add the root) instead of calling the body prose. The two are told apart by
 * SHAPE rather than by the word: a bare one-word body is prose, while a dotted
 * path, a call, or an identifier that is not the whole body is a plausible new
 * root. Cost measured at zero: every body in the tree leads with `github`,
 * `steps`, `secrets`, `cancelled`, `needs`, `matrix` or `join`, and cases below
 * pin the corpus heads AND every member of both sets, so neither can silently
 * stop matching.
 */
const CONTEXT_HEADS = new Set([
  'github',
  'env',
  'vars',
  'job',
  'jobs',
  'steps',
  'runner',
  'secrets',
  'strategy',
  'matrix',
  'needs',
  'inputs',
]);

const FUNCTION_HEADS = new Set([
  'contains',
  'startsWith',
  'endsWith',
  'format',
  'join',
  'toJSON',
  'fromJSON',
  'hashFiles',
  'success',
  'always',
  'cancelled',
  'failure',
]);

const LITERAL_HEADS = new Set(['true', 'false', 'null']);

/**
 * A refusal that also says WHY, so the two refusals can hand the reader
 * opposite remedies. `unknownRoot` means "this looks like an expression naming
 * something I do not know" — rewrite nothing, add the root; its absence means
 * prose.
 */
type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly unknownRoot?: string; readonly rootAt?: number };

/**
 * Whether `body` could be an Actions expression, and if not, which kind of not.
 *
 * DELIBERATELY PERMISSIVE where it is unsure — it accepts a TRAILING empty
 * argument (`format(github.sha,)`, `(github.sha,)`), which no grammar does. A
 * LEADING one (`format(,github.sha)`, `(,github.sha)`) is refused, at the arm
 * that refuses a body opening with an operator. The asymmetry is measured
 * rather than designed, and the examples are spelled with a real root on
 * purpose: written as `(a,)` / `f(,b)` the sentence became FALSE the moment the
 * root check landed, since `a` and `f` are not roots — which is the third time
 * a bound in this file was stated opposite to the measurement.
 *
 * Permissiveness is the safe direction for a fence: an over-acceptance costs
 * the coverage of a shape nobody writes, while an over-refusal reds CI on
 * working code with a message blaming the author. What it must never do is
 * accept two operands in a row, because that is what prose is.
 */
export const analyseExpression = (body: string): Verdict => {
  TOKEN.lastIndex = 0;
  let at = 0;
  let expect: 'operand' | 'operator' = 'operand';
  let depth = 0;
  // Whether the token now due is a PROPERTY rather than a root. The path token
  // swallows `a.b.c` whole, but a `.` after a `)` or `]` arrives on its own —
  // `fromJSON(x).a`, `fromJSON(x).*.name` — and the identifier after it names a
  // member, not a context.
  let afterDot = false;
  let seen = 0;
  while (at < body.length) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(body);
    // No token matches here, so the body carries a character that appears in no
    // expression outside a string — `#`, `$`, `{`, `"`, an em dash, a backtick.
    if (m === null) return { ok: false };
    at = TOKEN.lastIndex;
    const tok = m[0];
    if (/^\s+$/.test(tok)) continue;
    const wasAfterDot = afterDot;
    const isFirst = seen === 0;
    seen++;
    // ONE assignment for the whole loop. Set per-branch it leaked through every
    // arm that `continue`s early (`!`, a unary sign, `*`, `(`), which let
    // `github.x . ( prose )` through — and the single line that cleared it was
    // itself unobservable, since no case distinguished it.
    afterDot = tok === '.';
    if (expect === 'operand') {
      if (tok === '!') continue;
      // Unary sign: `${{ -1 }}`, `${{ x > -1 }}`. Legal Actions (JSON numbers).
      if (tok === '-' || tok === '+') continue;
      // An object filter reached from a call or an index: `fromJSON(x).*.name`.
      // Inside a path the `*` belongs to the path token; after a `)` or `]` it
      // arrives on its own.
      if (tok === '*') {
        expect = 'operator';
        continue;
      }
      if (OPEN.has(tok)) {
        depth++;
        continue;
      }
      // An empty argument list: `always()` reaches `)` still expecting an
      // operand. Only inside a group — a bare `)` is unbalanced.
      if (CLOSE.has(tok)) {
        if (depth === 0) return { ok: false };
        depth--;
        expect = 'operator';
        continue;
      }
      if (INFIX.has(tok)) return { ok: false };
      // An identifier or dotted path in VALUE position. Strings and numbers are
      // exempt — they are literals, not named values — and so is a member name
      // reached through a `.`.
      if (!wasAfterDot && /^[A-Za-z_]/.test(tok)) {
        const root = tok.split('.')[0]!;
        // A function is a name Actions only accepts when CALLED. Bare, it is an
        // unrecognized named-value like any other word, and six of the twelve
        // are ordinary English.
        const called = /^\s*\(/.test(body.slice(at));
        const known =
          CONTEXT_HEADS.has(root) ||
          LITERAL_HEADS.has(tok) ||
          (FUNCTION_HEADS.has(tok) && called);
        if (!known) {
          // A BARE one-word body is prose, full stop — no context is ever used
          // that way, and this is the headline reintroduction wording, where
          // saying "add the root" would permanently re-open the hole. Anything
          // with more shape (a dotted path, a call, a word among others) MIGHT
          // be a root GitHub has newly documented; the caller settles which by
          // substituting a known root and re-reading the body.
          const bareWord =
            isFirst && !tok.includes('.') && !called && body.slice(at).trim() === '';
          return bareWord
            ? { ok: false }
            : { ok: false, unknownRoot: root, rootAt: at - tok.length };
        }
      }
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
      if (depth === 0) return { ok: false };
      depth--;
      continue;
    }
    if (INFIX.has(tok)) {
      expect = 'operand';
      continue;
    }
    // Two operands in a row — the prose shape.
    return { ok: false };
  }
  return expect === 'operator' && depth === 0 ? { ok: true } : { ok: false };
};

export const isReadableExpression = (body: string): boolean => analyseExpression(body).ok;

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
  /**
   * Line starts, computed ONCE. The obvious `source.slice(0, i).split('\n')`
   * is O(offences x bytes): measured 15 s on a 256 KB file of repeated empty
   * openers, which a fork PR could hand to CI. Unreachable on a tree that
   * PASSES — a clean tree has no offences at all — so this is about the run
   * that reports a real defect.
   */
  const lineStarts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1);
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  /**
   * A quoted excerpt, CLAMPED and single-line. The raw slice was both a
   * forgery surface and a size bomb: a body carrying a newline rendered a
   * second line reading as a finding against another file, and 20k openers
   * sharing one trailing `}}` (80 KB in) produced 802 M characters, which made
   * the assertion throw `Invalid string length` INSTEAD of reporting.
   */
  const excerpt = (from: number, to: number): string => {
    const raw = source.slice(from, Math.min(to, from + 120)).replace(/\s+/g, ' ');
    return to > from + 120 ? `${raw}…` : raw;
  };
  /**
   * ONE forward pass. Resuming the opener search at `at + 3` made every opener
   * re-scan to EOF for its `}}` — measured 4.7 s on 1.28 MB, doubling
   * fourfold per doubling, so the quadratic had moved rather than left when
   * `lineOf` was fixed. Resuming after the CLOSER is also the reading Actions
   * takes, and an opener nested inside a swallowed body is still reported,
   * because the body that swallowed it carries a `$` and a `{` and is refused.
   */
  let at = source.indexOf('${{');
  while (at !== -1) {
    const close = source.indexOf('}}', at + 3);
    if (close === -1) {
      // No later opener can find a closer either — `indexOf` is monotonic — so
      // there is nothing after this worth scanning for.
      offences.push({
        file,
        line: lineOf(at),
        reason: 'expression opener is never closed',
        text: excerpt(at, at + 60),
      });
      break;
    }
    const body = source.slice(at + 3, close);
    if (body.trim() === '') {
      offences.push({
        file,
        line: lineOf(at),
        // The MEASURED message, from the run that reported the shipped defect.
        reason:
          'empty expression body — inside a `run:` body Actions answers "An expression was expected" and refuses the whole file',
        text: excerpt(at, close + 2),
      });
      at = source.indexOf('${{', close + 2);
      continue;
    }
    const verdict = analyseExpression(body);
    if (!verdict.ok) {
      // Does the body read as an expression once the unrecognised root is
      // swapped for a known one? If yes it is shaped like a real reference and
      // the root is the only thing missing; if no, the shape is prose and
      // naming the root would send the reader after the wrong thing. Called at
      // most once — a second unknown root lands on the prose arm, which is the
      // safe direction.
      const plausibleRoot =
        verdict.unknownRoot !== undefined &&
        verdict.rootAt !== undefined &&
        analyseExpression(
          `${body.slice(0, verdict.rootAt)}github${body.slice(verdict.rootAt + verdict.unknownRoot.length)}`,
        ).ok;
      // The two refusals want OPPOSITE actions from the reader — rewrite the
      // prose, or add a root GitHub has newly documented — so a single message
      // would be a false diagnosis for one of them. The walker decides which,
      // at the token it actually refused: deriving it from the body's FIRST
      // token instead told the bare one-word case — the headline
      // reintroduction wording — to add `expression` to the root set, which
      // would have permanently re-opened the hole this arm closes.
      offences.push({
        file,
        line: lineOf(at),
        reason: plausibleRoot
          ? `expression body names \`${verdict.unknownRoot}\`, which is no Actions context or function — Actions answers "Unrecognized named-value" and refuses the whole file. If GitHub has added it, add it to CONTEXT_HEADS or FUNCTION_HEADS`
          : 'expression body is prose, not an expression — inside a `run:` body this refuses the whole file the same way an empty one does',
        text: excerpt(at, close + 2),
      });
    }
    at = source.indexOf('${{', close + 2);
  }
  return offences;
};

const workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));

/** Every expression body the repository actually writes. */
const bodies = workflowFiles.flatMap((name) => {
  const source = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
  const found: string[] = [];
  for (let at = source.indexOf('${{'); at !== -1; at = source.indexOf('${{', at + 3)) {
    const close = source.indexOf('}}', at + 3);
    if (close !== -1) found.push(source.slice(at + 3, close));
  }
  return found;
});

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
      // A PARENTHESISED SUB-EXPRESSION. No body in the corpus opens a group in
      // operand position, so without this case the arm that handles one had no
      // coverage at all — deleting its `depth++` made the grammar REJECT every
      // grouped condition while all 37 cases stayed green. That is exactly the
      // over-refusal the header says this design exists to avoid.
      "(github.event_name == 'push') && github.actor != 'dependabot[bot]'",
      "!(github.ref == 'refs/heads/main')",
      // Unary sign and a filter off a call result: legal Actions. `-` and `+`
      // need one case EACH — dropping only the `+` half redded nothing, since
      // every other case exercises `-`.
      'github.run_attempt > -1',
      'github.run_attempt > +1',
      // The standalone `*` arm. NOT the `contains(...labels.*.name, ...)` case
      // above, where `.*` is swallowed whole by the path token and this arm is
      // never entered.
      'fromJSON(steps.x.outputs.y).*.name',
      // A trailing empty argument — the permissiveness the docstring claims.
      // Spelled with a real root: `f(a,)` would be refused by the root check,
      // which is what made the earlier wording of that claim false.
      'format(github.sha,)',
      '(github.sha,)',
    ])('accepts %s', (body) => {
      expect(isReadableExpression(` ${body} `)).toBe(true);
    });

    /**
     * Every member of both root sets, so a root that stops being recognised is
     * caught BY NAME. Sixteen of the twenty-seven redded nothing when removed,
     * and removal causes OVER-refusal — the direction this file's header calls
     * the dangerous one.
     *
     * The expectations are LITERAL lists, not `[...CONTEXT_HEADS]`: a case
     * derived from the set it guards disappears with the member it was meant to
     * catch, which is a fence built out of its own remedy. The equality case
     * below is what makes the literals non-stale in the other direction — a
     * root ADDED to a set with no case reds there.
     *
     * The two sets are exercised DIFFERENTLY on purpose, which is the whole
     * distinction the blocker was about: a context is a value, a function is
     * only a name when called.
     */
    const EXPECTED_CONTEXTS = [
      'github',
      'env',
      'vars',
      'job',
      'jobs',
      'steps',
      'runner',
      'secrets',
      'strategy',
      'matrix',
      'needs',
      'inputs',
    ];
    const EXPECTED_FUNCTIONS = [
      'contains',
      'startsWith',
      'endsWith',
      'format',
      'join',
      'toJSON',
      'fromJSON',
      'hashFiles',
      'success',
      'always',
      'cancelled',
      'failure',
    ];
    const EXPECTED_LITERALS = ['true', 'false', 'null'];

    it('pins both root sets by name', () => {
      expect([...CONTEXT_HEADS].sort()).toEqual([...EXPECTED_CONTEXTS].sort());
      expect([...FUNCTION_HEADS].sort()).toEqual([...EXPECTED_FUNCTIONS].sort());
      expect([...LITERAL_HEADS].sort()).toEqual([...EXPECTED_LITERALS].sort());
    });

    it.each(EXPECTED_CONTEXTS)('accepts the `%s` context', (root) => {
      expect(isReadableExpression(` ${root}.some_property `)).toBe(true);
      expect(isReadableExpression(` ${root} `)).toBe(true);
    });

    it.each(EXPECTED_FUNCTIONS)('accepts `%s` called and refuses it bare', (fn) => {
      expect(isReadableExpression(` ${fn}(github.sha) `)).toBe(true);
      // The blocker: bare, a function name is `Unrecognized named-value` and
      // invalidates the file. Six of the twelve are ordinary English words, so
      // one set for both readmitted the prose class this arm exists to close.
      expect(isReadableExpression(` ${fn} `)).toBe(false);
    });

    it.each(EXPECTED_LITERALS)('accepts the `%s` literal', (literal) => {
      expect(isReadableExpression(` github.ref == ${literal} `)).toBe(true);
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
      // ONE word. The alternation rule cannot see this one — it is not a run of
      // adjacent operands — and it is the likeliest reintroduction wording, so
      // it is the root check that has to catch it.
      ['one word', ' expression '],
      ['one word that reads like a context', ' opener '],
      ['a dotted path under an unknown root', ' expression.body '],
      ['a shell variable', ' ${GH_TOKEN} '],
      ['an unbalanced group', ' format(github.sha '],
      ['a trailing operator', ' github.ref == '],
      // The two `depth === 0` guards, one each. The unbalanced-group case above
      // only reaches the FINAL check.
      ['a close before any open', ' ) ( github.sha '],
      ['a close after an operand', ' github.sha ) ( github.ref '],
      // A body that opens with an operator. This one is the leading-INFIX arm's
      // SOLE killer. The two below are DOUBLY covered — refused at that arm,
      // with the two-operands arm as a backstop — so neither reds under either
      // single deletion, and neither pins an arm on its own. Stated because two
      // successive attempts at attributing them in prose were wrong, the second
      // exactly inverted.
      ['a leading comma', ' , '],
      ['a doubled operator', " github.ref && == 'main' "],
      ['a leading empty argument', ' format(,github.sha) '],
      // The `afterDot` flag, which was set per-branch and leaked through every
      // arm that continues early. Reaching operand position through an INDEX
      // after a member access is what distinguishes it — a simple body resets
      // the flag on its way through an infix and cannot discriminate.
      ['a member access reopened by an index', ' fromJSON(steps.x.outputs.y).a[expression] '],
      ['a group opened after a member access', ' github.event . ( expression ) '],
    ])('rejects %s', (_label, body) => {
      expect(isReadableExpression(body)).toBe(false);
    });

    /**
     * The two REFUSAL MESSAGES, which are the only user-facing strings this
     * fence emits and had zero coverage: forcing the unknown-root branch off
     * redded none of the cases, because every grammar case calls the predicate
     * directly and never reaches a message.
     *
     * They must not be swapped, and the headline case is the trap — telling the
     * author of `${{ expression }}` to add `expression` to the root set would
     * permanently re-open the hole the root check closes.
     */
    describe('refusal messages', () => {
      const reasonFor = (body: string): string => {
        const found = findExpressionOffences('x.yml', `on: push\njobs: \${{${body}}}\n`);
        expect(found).toHaveLength(1);
        return found[0]!.reason;
      };

      it.each([' expression ', ' opener ', ' context ', ' format ', ' the same rule '])(
        'calls %s prose, not a missing root',
        (body) => {
          expect(reasonFor(body)).toContain('prose, not an expression');
        },
      );

      it.each([' newcontext.foo ', ' newfn(github.sha) ', " github.ref == 'x' && newcontext.foo "])(
        'calls %s a missing root, not prose',
        (body) => {
          const reason = reasonFor(body);
          expect(reason).toContain('Unrecognized named-value');
          expect(reason).toContain('CONTEXT_HEADS');
        },
      );

      it('names the token it actually refused, not the first one', () => {
        expect(reasonFor(" github.ref == 'x' && newcontext.foo ")).toContain('`newcontext`');
      });

      /**
       * The binary search's boundary. Every probe body in this file is
       * INDENTED, so no opener has ever started a line and `lineStarts[mid] <=
       * index` could be weakened to `<` with all cases green — reporting line 1
       * for a defect on line 2, which is the one field a reader acts on.
       */
      it.each([
        [1, '${{ prose here }}\nb: 2\n'],
        [2, 'a: 1\n${{ prose here }}\nb: 2\n'],
        [3, 'a: 1\nb: 2\n${{ prose here }}'],
      ])('reports line %i for an opener at the start of it', (line, source) => {
        const found = findExpressionOffences('x.yml', source);
        expect(found).toHaveLength(1);
        expect(found[0]!.line).toBe(line);
      });

      it('clamps and flattens the quoted excerpt', () => {
        // Raw, the excerpt was both a forgery surface (a newline in the body
        // renders a second line that reads as a finding against another file)
        // and a size bomb.
        const [offence] = findExpressionOffences(
          'x.yml',
          `jobs: \${{ prose here\nci.yml:1: forged ${'x'.repeat(500)} }}\n`,
        );
        expect(offence!.text).not.toContain('\n');
        expect(offence!.text.length).toBeLessThanOrEqual(121);
      });
    });

    /**
     * The root list is the one part of the grammar that can go stale on
     * GitHub's schedule rather than on this repo's, so it is pinned against
     * what the tree writes. A root that leaves the corpus is harmless; one that
     * ENTERS it without being listed reds the per-file arms with a message
     * naming the remedy, and this case says which root and why.
     */
    it('knows every root the corpus actually leads with', () => {
      const heads = new Set(
        bodies
          .map((b) => /^\s*!?\s*\(?\s*([A-Za-z_][A-Za-z0-9_-]*)/.exec(b)?.[1])
          .filter((h): h is string => h !== undefined),
      );
      expect(heads.size).toBeGreaterThanOrEqual(5);
      expect(
        [...heads].filter(
          (h) => !CONTEXT_HEADS.has(h) && !FUNCTION_HEADS.has(h) && !LITERAL_HEADS.has(h),
        ),
      ).toEqual([]);
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
      // A FUNCTION replacer, so a probe line carrying `$&` / `` $` `` / `$'` /
      // `$1` is inserted verbatim instead of being expanded by `String.replace`
      // — measured: `` $` `` expands to the whole pre-match text, which would
      // silently probe something other than the line the case names.
      const mutated = REAL.replace(ANCHOR, () => `${line}\n${ANCHOR}`);
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
