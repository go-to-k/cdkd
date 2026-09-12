import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import {
  clearRecordedSecretExpressions,
  markSameGenerationBag,
  recordResolvedPair,
  recordSecretExpression,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

/**
 * Issue #2745, first site: a bag leaf whose `Fn::Join` / `Fn::Sub` source
 * EMBEDS one `{{resolve:...}}` token inside literal text (`port:` + token).
 * The skeleton arm positions only a WHOLE-token leaf and the literal span arm
 * needs a source STRING, so this shape fell to the value scan: a 4+ character
 * middle took the map's survivor (a same-plaintext sibling's spelling) and a
 * 1-3 character middle, below the scan's needle floor, stayed in plaintext.
 *
 * `positionByIntrinsicFrame` renders the intrinsic's literal parts, finds the
 * one token, and writes the ONE candidate expression matching the token's
 * pattern — provided THIS pass resolved it to the middle and the write stays
 * within the value scan's class of answer, or, below the floor, the bag
 * carries the engine's same-generation mark (the literal arm's two claims,
 * through the one shared helper).
 *
 * The SHAPES come from a synth probe of aws-cdk-lib 2.268.0, not from the
 * issue's paraphrase: `'port:' + secret.secretValueFromJson('pin')` emits the
 * prefix FUSED into the token's opening part with the ARN `Ref` INSIDE the
 * token (`L2_JOIN`), a placeholder-free `cdk.Fn.sub` stays an `Fn::Sub`
 * object (`SUB`), and an all-literal `cdk.Fn.join` FOLDS to a plain string —
 * so `LITERAL_JOIN` is the hand-written CloudFormation shape the issue names,
 * not one CDK emits.
 *
 * Every refusal is asserted as EQUALITY with the value scan's own answer for
 * the leaf, so "fell through" is what is pinned rather than "did something
 * else".
 */
const ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:prod/db-AbCdEf';
/** What the resolver assembles — and records — for the L2 join. */
const TOKEN_L2 = `{{resolve:secretsmanager:${ARN}:SecretString:pin::}}`;
/** The name-form spelling of the same JSON key, as a literal part carries it. */
const TOKEN_NAME = '{{resolve:secretsmanager:prod/db:SecretString:pin}}';
/** A whole-value sibling on the version-staged spelling: the map's survivor. */
const TOKEN_STAGED = '{{resolve:secretsmanager:prod/db:SecretString:pin:AWSCURRENT}}';
const PIN = 'q7';

const L2_JOIN = {
  'Fn::Join': ['', ['port:{{resolve:secretsmanager:', { Ref: 'Secret' }, ':SecretString:pin::}}']],
};
const LITERAL_JOIN = { 'Fn::Join': ['', ['port:', TOKEN_NAME]] };
const SUB = { 'Fn::Sub': `port:${TOKEN_NAME}` };
const SUB_2ARG = {
  'Fn::Sub': ['port:{{resolve:secretsmanager:${Arn}:SecretString:pin::}}', { Arn: { Ref: 'Secret' } }],
};
/** The nonliteral-frame shape with the `Ref` BEFORE the token. */
const REGION_BEFORE = {
  'Fn::Join': [
    '',
    [
      { Ref: 'AWS::Region' },
      ':port:{{resolve:secretsmanager:',
      { Ref: 'Secret' },
      ':SecretString:pin::}}',
    ],
  ],
};
/** The nonliteral-frame shape: a region `Ref` OUTSIDE the token. Deferred. */
const REGION_OUTSIDE = {
  'Fn::Join': [
    '',
    [
      'port:{{resolve:secretsmanager:',
      { Ref: 'Secret' },
      ':SecretString:pin::}}@',
      { Ref: 'AWS::Region' },
    ],
  ],
};

const SHAPES = [
  ['the L2 Fn::Join (prefix fused into the opening part, ARN Ref inside the token)', L2_JOIN, TOKEN_L2],
  ['a hand-written Fn::Join of two literal parts', LITERAL_JOIN, TOKEN_NAME],
  ['a placeholder-free Fn::Sub', SUB, TOKEN_NAME],
  ['a 2-arg Fn::Sub with the ARN variable inside the token', SUB_2ARG, TOKEN_L2],
] as const;

/** The pass's map after ONE reference resolved: the pair beside the entry. */
function resolvedAlone(token: string, plaintext: string): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map([[plaintext, token]]);
  recordResolvedPair(secrets, token, plaintext);
  return secrets;
}

describe('an Fn::Join / Fn::Sub leaf embedding one token is positioned by its literal frame (issue #2745)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  describe('writes a 1-3 character middle as its token on a bag the engine marked', () => {
    for (const [label, source, token] of SHAPES) {
      it(`through ${label}`, () => {
        const secrets = resolvedAlone(token, PIN);
        const leaf = `port:${PIN}`;
        // Premise: the scan itself leaves the leaf alone below its floor.
        expect(redactSecretsForState(leaf, secrets)).toBe(leaf);

        const bag = markSameGenerationBag({ Dsn: leaf });

        expect(redactSecretsForState(bag, secrets, { Dsn: source })).toEqual({
          Dsn: `port:${token}`,
        });
      });
    }

    // The INVARIANT across the sub-floor range, not one length: for every
    // middle below MIN_NEEDLE_LENGTH the scan is silent, an unmarked bag keeps
    // the plaintext, and the mark is what writes the token. A floor lowered to
    // 3 makes the scan write the survivor for `abc` and reds the premise here,
    // where a two-character-only premise stays green (maintainer-proxy pass).
    for (const middle of ['a', 'q7', 'abc'] as const) {
      it(`for a ${middle.length}-character middle: scan silent, unmarked kept, marked written`, () => {
        const secrets = resolvedAlone(TOKEN_L2, middle);
        const leaf = `port:${middle}`;
        expect(redactSecretsForState(leaf, secrets)).toBe(leaf);
        expect(redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: L2_JOIN })).toEqual({ Dsn: leaf });

        const bag = markSameGenerationBag({ Dsn: leaf });

        expect(redactSecretsForState(bag, secrets, { Dsn: L2_JOIN })).toEqual({
          Dsn: `port:${TOKEN_L2}`,
        });
      });
    }

    it('through a token carrying exactly the cap of unknowable parts (three), which pins that only the token\'s OWN parts are counted', () => {
      // Three `${}` variables inside the token: at the cap, so the pattern is
      // built and the leaf positioned. A mutant that renders a wildcard ahead
      // of the first literal (the `i === 0` arm) makes it four, over the cap,
      // and refuses — inert for a one-wildcard shape, visible here.
      const source = {
        'Fn::Sub': [
          'port:{{resolve:secretsmanager:arn:aws:secretsmanager:${Region}:${Account}:secret:${Name}:SecretString:pin::}}',
          { Region: { Ref: 'AWS::Region' }, Account: { Ref: 'AWS::AccountId' }, Name: { Ref: 'Secret' } },
        ],
      };
      const bag = markSameGenerationBag({ Dsn: `port:${PIN}` });

      expect(redactSecretsForState(bag, resolvedAlone(TOKEN_L2, PIN), { Dsn: source })).toEqual({
        Dsn: `port:${TOKEN_L2}`,
      });
    });

    it('past a matching candidate this pass recorded under a DIFFERENT plaintext, which is skipped rather than counted', () => {
      // A second ARN-form token matches the wildcarded pattern but resolved
      // to another value: the poisoning rule skips it, so the leaf's own
      // token is the ONE match. Counted instead, the two-match refusal would
      // leave the plaintext — which is what a mutant dropping the skip does.
      const other = `{{resolve:secretsmanager:${ARN.replace('AbCdEf', 'GhIjKl')}:SecretString:pin::}}`;
      const secrets: RecordedSecretValues = new Map([
        [PIN, TOKEN_L2],
        ['zz', other],
      ]);
      recordResolvedPair(secrets, TOKEN_L2, PIN);
      recordResolvedPair(secrets, other, 'zz');
      const bag = markSameGenerationBag({ Dsn: `port:${PIN}` });

      expect(redactSecretsForState(bag, secrets, { Dsn: SUB_2ARG })).toEqual({
        Dsn: `port:${TOKEN_L2}`,
      });
    });

    it('beside a whole-value sibling sharing the plaintext, from its OWN token rather than the survivor', () => {
      // The staged sibling recorded LAST, so it holds the map slot for `q7`;
      // the join leaf's own expression is the collapsed LOSER. A mutant
      // writing `prefix + survivor + suffix` fails here.
      const secrets: RecordedSecretValues = new Map([[PIN, TOKEN_STAGED]]);
      recordResolvedPair(secrets, TOKEN_L2, PIN);
      recordResolvedPair(secrets, TOKEN_STAGED, PIN);
      const bag = markSameGenerationBag({ Dsn: `port:${PIN}`, Whole: PIN });

      expect(redactSecretsForState(bag, secrets, { Dsn: L2_JOIN, Whole: TOKEN_STAGED })).toEqual({
        Dsn: `port:${TOKEN_L2}`,
        Whole: TOKEN_STAGED,
      });
    });

    it('is read for the object handed in and threaded down the walk — a sub-bag walked on its own is not marked', () => {
      const secrets = resolvedAlone(TOKEN_L2, PIN);
      const source = { Environment: { Variables: { Dsn: L2_JOIN } } };
      const bag = markSameGenerationBag({ Environment: { Variables: { Dsn: `port:${PIN}` } } });

      expect(redactSecretsForState(bag, secrets, source)).toEqual({
        Environment: { Variables: { Dsn: `port:${TOKEN_L2}` } },
      });
      expect(
        redactSecretsForState(bag.Environment, secrets, source.Environment)
      ).toEqual({ Variables: { Dsn: `port:${PIN}` } });
    });

    it('for an ssm token this pass resolved but never PINNED, which also lost the map slot', () => {
      // An `ssm` reference whose `Type` came back unclassifiable is recorded
      // as a pass-local pair but kept out of the process-wide expression set
      // (#1901), and here a secretsmanager sibling holds the map slot. Neither
      // of the skeleton arm's two candidate stores names it; only the pair
      // table does. A mutant dropping `resolvedExpressionsOf` from the
      // candidates refuses this leaf and leaves the plaintext.
      const SSM = '{{resolve:ssm:/prod/db/pin}}';
      const secrets: RecordedSecretValues = new Map([[PIN, TOKEN_STAGED]]);
      recordResolvedPair(secrets, SSM, PIN);
      recordResolvedPair(secrets, TOKEN_STAGED, PIN);
      const bag = markSameGenerationBag({ Dsn: `port:${PIN}`, Whole: PIN });

      expect(
        redactSecretsForState(bag, secrets, { Dsn: { 'Fn::Sub': `port:${SSM}` }, Whole: TOKEN_STAGED })
      ).toEqual({ Dsn: `port:${SSM}`, Whole: TOKEN_STAGED });
    });
  });

  describe('leaves a 1-3 character middle to the value scan on a bag NOBODY marked', () => {
    for (const [label, source, token] of SHAPES) {
      it(`through ${label}`, () => {
        const secrets = resolvedAlone(token, PIN);
        const leaf = `port:${PIN}`;

        const persisted = redactSecretsForState({ Dsn: leaf }, secrets, { Dsn: source });

        expect(persisted).toEqual({ Dsn: redactSecretsForState(leaf, secrets) });
        expect(persisted).toEqual({ Dsn: leaf });
      });
    }
  });

  describe('above the needle floor, positions the leaf with or without the mark', () => {
    const LONG = 'q7-long-enough-pin';

    it('writes the join leaf its OWN token where the scan wrote the survivor', () => {
      const secrets: RecordedSecretValues = new Map([[LONG, TOKEN_STAGED]]);
      recordResolvedPair(secrets, TOKEN_L2, LONG);
      recordResolvedPair(secrets, TOKEN_STAGED, LONG);
      const leaf = `port:${LONG}`;
      // Premise: this is the pre-#2745 answer — the sibling's spelling.
      expect(redactSecretsForState(leaf, secrets)).toBe(`port:${TOKEN_STAGED}`);

      const persisted = redactSecretsForState(
        { Dsn: leaf, Whole: LONG },
        secrets,
        { Dsn: L2_JOIN, Whole: TOKEN_STAGED }
      );

      expect(persisted).toEqual({ Dsn: `port:${TOKEN_L2}`, Whole: TOKEN_STAGED });
    });

    it('keeps the scan answer where another 4+ character needle interferes with the frame', () => {
      // The prefix itself is a recorded plaintext: the scan rewrites it, so
      // the leaf is no longer `prefix + survivor + suffix` and the shared
      // bound refuses — with or without the mark.
      const secrets: RecordedSecretValues = new Map([
        [LONG, TOKEN_L2],
        ['port', '{{resolve:secretsmanager:other:SecretString:word}}'],
      ]);
      recordResolvedPair(secrets, TOKEN_L2, LONG);
      const leaf = `port:${LONG}`;
      const bag = markSameGenerationBag({ Dsn: leaf });

      const persisted = redactSecretsForState(bag, secrets, { Dsn: L2_JOIN });

      expect(persisted).toEqual({ Dsn: redactSecretsForState(leaf, secrets) });
      expect(persisted).not.toEqual({ Dsn: `port:${TOKEN_L2}` });
    });
  });

  describe('refuses, and the leaf keeps the value scan answer', () => {
    const refusals: Array<[string, () => { bag: Record<string, string>; source: Record<string, unknown>; secrets: RecordedSecretValues }]> = [
      [
        'two candidate expressions match the token pattern',
        () => {
          // Two ARN-form references resolving to the same plaintext, both
          // matching the wildcarded 2-arg Fn::Sub. The pattern cannot tell
          // them apart, and guessing is the collapse this arm exists to remove.
          const other = `{{resolve:secretsmanager:${ARN.replace('AbCdEf', 'GhIjKl')}:SecretString:pin::}}`;
          const secrets: RecordedSecretValues = new Map([[PIN, other]]);
          recordResolvedPair(secrets, TOKEN_L2, PIN);
          recordResolvedPair(secrets, other, PIN);
          return { bag: { Dsn: `port:${PIN}` }, source: { Dsn: SUB_2ARG }, secrets };
        },
      ],
      [
        'the bag does not carry the frame the source states',
        () => ({
          bag: { Dsn: `host:${PIN}` },
          source: { Dsn: SUB },
          secrets: resolvedAlone(TOKEN_NAME, PIN),
        }),
      ],
      [
        'a non-literal part sits OUTSIDE the token (a region Ref after it) — the deferred nonliteral-frame shape, refused by the frame check since no bag character equals the rendered placeholder',
        () => ({
          bag: { Dsn: `port:${PIN}@us-east-1` },
          source: { Dsn: REGION_OUTSIDE },
          secrets: resolvedAlone(TOKEN_L2, PIN),
        }),
      ],
      [
        'a non-literal part sits OUTSIDE the token and the bag happens to carry the placeholder character there — the explicit frame refusal, where the frame check alone would accept',
        () => ({
          bag: { Dsn: `port:${PIN}@\u0000` },
          source: { Dsn: REGION_OUTSIDE },
          secrets: resolvedAlone(TOKEN_L2, PIN),
        }),
      ],
      [
        'a non-literal part sits BEFORE the token and the bag happens to carry the placeholder character there — the prefix arm of the same refusal',
        () => ({
          bag: { Dsn: `\u0000:port:${PIN}` },
          source: { Dsn: REGION_BEFORE },
          secrets: resolvedAlone(TOKEN_L2, PIN),
        }),
      ],
      [
        'a matching candidate this pass recorded against two plaintexts is named by the pair table alone, beside a valid one — counted, so the match is not unique',
        () => {
          // The conflicting token lost the map slot, so only the pair table
          // knows it; it still matches the wildcarded pattern, and counting
          // it is what refuses. A mutant filtering conflicting keys out of
          // `resolvedExpressionsOf` sees one match and positions the leaf.
          const other = `{{resolve:secretsmanager:${ARN.replace('AbCdEf', 'GhIjKl')}:SecretString:pin::}}`;
          const secrets = resolvedAlone(TOKEN_L2, PIN);
          recordResolvedPair(secrets, other, 'aa');
          recordResolvedPair(secrets, other, 'bb');
          return { bag: { Dsn: `port:${PIN}` }, source: { Dsn: SUB_2ARG }, secrets };
        },
      ],
      [
        'a matching competitor is known only to the process-wide expression set, beside a valid pass-local candidate — counted, so the match is not unique',
        () => {
          // Pinned by another resource or pass, never resolved here: the
          // pattern cannot tell it from the leaf's own token, and guessing
          // is the collapse this arm exists to remove. A mutant dropping
          // the set from the candidates sees one match and positions.
          const other = `{{resolve:secretsmanager:${ARN.replace('AbCdEf', 'GhIjKl')}:SecretString:pin::}}`;
          recordSecretExpression(other);
          return { bag: { Dsn: `port:${PIN}` }, source: { Dsn: SUB_2ARG }, secrets: resolvedAlone(TOKEN_L2, PIN) };
        },
      ],
      [
        'a matching competitor is known only through the map\'s survivor slot (no pair, not pinned), beside a valid pass-local candidate — counted, so the match is not unique',
        () => {
          // The survivor for `q7` was written without a pair (a seeded or
          // derived map), so only the map's VALUES know it; it still matches
          // the wildcarded pattern and its plaintext IS the middle, so the
          // poisoning rule does not skip it. Counting it is what refuses: a
          // mutant dropping the map's values from the candidates sees one
          // match (the pair-table token) and positions the leaf.
          const other = `{{resolve:secretsmanager:${ARN.replace('AbCdEf', 'GhIjKl')}:SecretString:pin::}}`;
          const secrets: RecordedSecretValues = new Map([[PIN, other]]);
          recordResolvedPair(secrets, TOKEN_L2, PIN);
          return { bag: { Dsn: `port:${PIN}` }, source: { Dsn: SUB_2ARG }, secrets };
        },
      ],
      [
        'the matched candidate has a valid pair for a DIFFERENT middle (a collapsed loser of another value) while the map holds a survivor for this one',
        () => {
          // The join's own token resolved to `zz` and lost that slot; `q7`
          // has a survivor of its own. The pair says the candidate is not
          // this leaf's, and refusing is what keeps the bound from writing
          // it — a mutant testing the pair for mere PRESENCE writes
          // `port:` + a token that resolved to another value.
          const survivorOfZz = `{{resolve:secretsmanager:${ARN.replace('AbCdEf', 'GhIjKl')}:SecretString:pw::}}`;
          const secrets: RecordedSecretValues = new Map([
            [PIN, TOKEN_STAGED],
            ['zz', survivorOfZz],
          ]);
          recordResolvedPair(secrets, TOKEN_STAGED, PIN);
          recordResolvedPair(secrets, survivorOfZz, 'zz');
          recordResolvedPair(secrets, TOKEN_L2, 'zz');
          return { bag: { Dsn: `port:${PIN}` }, source: { Dsn: L2_JOIN }, secrets };
        },
      ],
      [
        'a literal part carries a regex metacharacter that a candidate differs at (the literal is matched verbatim, not as a pattern)',
        () => {
          const spelled = '{{resolve:secretsmanager:prod.db:SecretString:pin}}';
          const candidate = '{{resolve:secretsmanager:prodXdb:SecretString:pin}}';
          return {
            bag: { Dsn: `port:${PIN}` },
            source: { Dsn: { 'Fn::Sub': `port:${spelled}` } },
            secrets: resolvedAlone(candidate, PIN),
          };
        },
      ],
      [
        'this pass recorded no pair for the matched candidate (a map copied without its evidence)',
        () => ({
          bag: { Dsn: `port:${PIN}` },
          source: { Dsn: L2_JOIN },
          secrets: new Map(resolvedAlone(TOKEN_L2, PIN)),
        }),
      ],
      [
        'this pass recorded the matched candidate against TWO plaintexts (a conflicting pair)',
        () => {
          const secrets: RecordedSecretValues = new Map([[PIN, TOKEN_L2]]);
          recordResolvedPair(secrets, TOKEN_L2, PIN);
          recordResolvedPair(secrets, TOKEN_L2, 'zz');
          return { bag: { Dsn: `port:${PIN}` }, source: { Dsn: L2_JOIN }, secrets };
        },
      ],
      [
        'the source spells two tokens (the shared frame helper refuses it, as it does for the literal arm)',
        () => ({
          bag: { Dsn: `port:${PIN}:${PIN}` },
          source: { Dsn: { 'Fn::Sub': `port:${TOKEN_NAME}:${TOKEN_NAME}` } },
          secrets: resolvedAlone(TOKEN_NAME, PIN),
        }),
      ],
      [
        'the token carries more unknowable parts than the skeleton cap allows',
        () => ({
          bag: { Dsn: `port:${PIN}` },
          source: {
            Dsn: {
              'Fn::Sub':
                'port:{{resolve:secretsmanager:${A}-${B}-${C}-${D}:SecretString:pin::}}',
            },
          },
          secrets: resolvedAlone(TOKEN_L2, PIN),
        }),
      ],
      [
        'a candidate exceeds the skeleton length bound (the whole pass is refused, not the candidate skipped)',
        () => {
          const secrets = resolvedAlone(TOKEN_L2, PIN);
          secrets.set('other-plaintext', `{{resolve:secretsmanager:${'x'.repeat(600)}:SecretString:pw}}`);
          return { bag: { Dsn: `port:${PIN}` }, source: { Dsn: L2_JOIN }, secrets };
        },
      ],
      [
        'a literal part carries the rendering placeholder itself, which would otherwise widen the token pattern',
        () => {
          // A NUL inside the literal token text would render as an unknowable
          // part and match a candidate the template never spelled at this leaf.
          const spelled = '{{resolve:secretsmanager:prod\u0000db:SecretString:pin}}';
          const candidate = '{{resolve:secretsmanager:prod-db:SecretString:pin}}';
          return {
            bag: { Dsn: `port:${PIN}` },
            source: { Dsn: { 'Fn::Sub': `port:${spelled}` } },
            secrets: resolvedAlone(candidate, PIN),
          };
        },
      ],
      [
        // What this pins is that the parser's `undefined` is a REFUSAL rather
        // than a throw (the mutant that dereferences it crashes). It cannot tell
        // that refusal from the frame helper's on an empty rendering: both keep
        // the scan's answer, and no bag can distinguish them.
        'the source cannot be parsed into segments (an Fn::Join whose delimiter is itself an intrinsic), so the marked bag keeps the scan answer rather than throwing',
        () => ({
          bag: { Dsn: `port:${PIN}` },
          source: { Dsn: { 'Fn::Join': [{ Ref: 'Delimiter' }, ['port:', TOKEN_NAME]] } },
          secrets: resolvedAlone(TOKEN_NAME, PIN),
        }),
      ],
    ];

    for (const [label, build] of refusals) {
      it(`when ${label}`, () => {
        const { bag, source, secrets } = build();
        const leaf = bag['Dsn']!;

        const persisted = redactSecretsForState(markSameGenerationBag(bag), secrets, source);

        expect(persisted).toEqual({ Dsn: redactSecretsForState(leaf, secrets) });
        expect(persisted).toEqual({ Dsn: leaf });
      });
    }
  });

  describe('a WHOLE-token intrinsic leaf (an empty frame)', () => {
    it('keeps the skeleton arm answer where that arm answered, on evidence the frame arm lacks', () => {
      // The token is PINNED (the process-wide set) but this map holds no
      // pair for it and the survivor is the staged sibling: the skeleton arm
      // positions it from the set, the frame arm could not (no pair), and
      // the scan would write the survivor. So the leaf's own token here
      // proves the skeleton arm still answers a whole-token leaf on its own
      // stores — its availability, not its order relative to the frame arm,
      // which refuses this leaf either way.
      recordSecretExpression(TOKEN_L2);
      const secrets: RecordedSecretValues = new Map([[PIN, TOKEN_STAGED]]);
      const source = { 'Fn::Join': ['', ['{{resolve:secretsmanager:', { Ref: 'Secret' }, ':SecretString:pin::}}']] };

      expect(redactSecretsForState({ Whole: PIN }, secrets, { Whole: source })).toEqual({
        Whole: TOKEN_L2,
      });
    });

    it('is written back as ITSELF where the skeleton arm refused it: an unpinned ssm token that lost the map slot', () => {
      // The skeleton's stores hold the secretsmanager survivor only, so its
      // pattern for the ssm join matches nothing and it refuses; the value
      // scan then wrote the SURVIVOR — another leaf's expression, the #1910
      // class. The pair table names the ssm token this pass resolved, so the
      // frame arm writes the leaf's own expression, exactly as the literal
      // arm does for its whole-token failed-gate shape. Not a sub-floor case
      // on purpose: the bag is unmarked, and the bound accepts because the
      // scan's answer is `'' + survivor + ''`.
      const SSM = '{{resolve:ssm:/prod/db/pin}}';
      const secrets: RecordedSecretValues = new Map([[PIN, TOKEN_STAGED]]);
      recordResolvedPair(secrets, SSM, PIN);
      recordResolvedPair(secrets, TOKEN_STAGED, PIN);
      const source = { 'Fn::Join': ['', ['{{resolve:ssm:', '/prod/db/pin}}']] };
      // Premise: the scan alone writes the survivor for this leaf.
      expect(redactSecretsForState(PIN, secrets)).toBe(TOKEN_STAGED);

      expect(
        redactSecretsForState({ Whole: PIN, Staged: PIN }, secrets, { Whole: source, Staged: TOKEN_STAGED })
      ).toEqual({ Whole: SSM, Staged: TOKEN_STAGED });
    });
  });

  describe('residual, stated on the docstring rather than closed', () => {
    it('takes a same-service SECRET sibling\'s expression for a leaf whose own reference resolved PUBLIC and whose value coincides with the middle', () => {
      // Check 2 proves the candidate resolved to the middle in this pass, not
      // that it is THIS leaf's token. The leaf's `ssm` parameter came back a
      // public `String` — nothing records a public resolution — and a secure
      // sibling of the same service resolved to the same two characters, so
      // the sibling is the ONE candidate matching the token pattern, its pair
      // equals the middle, and the marked bag takes its expression: a wrong
      // REFERENCE (the whole-value scan's own class for a whole-leaf
      // coincidence), never a plaintext in the STORED artifact — the live
      // consequences (`resolveReplayProps` on rollback, `drift --revert`) are
      // on the arm's docstring. Pinned so a change that closes it is noticed,
      // and so the docstring's residual stays a measured one.
      const SECURE = '{{resolve:ssm:/secure/x}}';
      const secrets = resolvedAlone(SECURE, PIN);
      const source = { 'Fn::Join': ['', ['port:{{resolve:ssm:', { Ref: 'PublicParam' }, '}}']] };
      // Premise: the source-free scan leaves this bag alone (the middle sits
      // below the needle floor), so what is pinned is the ARM's addition —
      // a lowered floor would make the scan write the sibling by itself.
      expect(redactSecretsForState(`port:${PIN}`, secrets)).toBe(`port:${PIN}`);

      const persisted = redactSecretsForState(markSameGenerationBag({ Dsn: `port:${PIN}` }), secrets, {
        Dsn: source,
      });

      expect(persisted).toEqual({ Dsn: `port:${SECURE}` });
    });
  });
});
