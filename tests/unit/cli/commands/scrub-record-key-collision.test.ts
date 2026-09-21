/**
 * go-to-k/cdkd#3323 — the two composite keys `cdkd scrub` builds to identify a
 * producer must be INJECTIVE, and these are the BEHAVIOURAL cases for that.
 *
 * `tests/unit/state/malformed-resources-bag.test.ts` proves the helper is
 * injective and that every site calls it. Neither answers the question these
 * cases do: does the SITE still serve one record's answer for another's query?
 * A source-text fence goes green on a call that passes the wrong arguments.
 *
 * The pair planted throughout is the one a NUL SEPARATOR merges — the same
 * string with the split falling in two different places:
 *
 *     ("Evil<NUL>us-east-1", "ap-northeast-1")
 *     ("Evil",               "us-east-1<NUL>ap-northeast-1")
 *
 * The NUL reaches these sites through a state record's body and through the
 * exports index, both of which are JSON and neither of which validates a
 * string. It cannot reach them through an S3 KEY — the probe on that issue
 * measured that S3 refuses to store a NUL-bearing key — which is why the
 * sibling case in `tests/unit/state/s3-state-backend.test.ts` is deliberately
 * about removing a dependence on that refusal rather than about a live hole.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  memoizeCrossStackStateReads,
  producerPublishesSecretExpression,
} from '../../../../src/cli/commands/scrub.js';
import type { S3StateBackend } from '../../../../src/state/s3-state-backend.js';

const NUL = String.fromCharCode(0);

/** The two halves, straddling the separator in opposite places. */
const A = { stack: `Evil${NUL}us-east-1`, region: 'ap-northeast-1' } as const;
const B = { stack: 'Evil', region: `us-east-1${NUL}ap-northeast-1` } as const;

describe('memoizeCrossStackStateReads keys records injectively', () => {
  it('the planted pair is one a SEPARATOR merges', () => {
    // Guard-the-guard. Every case below asserts two things stay APART, which
    // any two distinct inputs satisfy — so each is meaningful only if the pair
    // is one the old key collided. Assert that directly rather than trusting
    // the comment above.
    const naive = (s: string, r: string): string => `${s}${NUL}${r}`;
    expect(naive(A.stack, A.region)).toBe(naive(B.stack, B.region));
  });

  it('two straddling queries do NOT share a promise', async () => {
    const getState = vi.fn(async (stackName: string, region: string) => ({
      state: { stackName, region },
    }));
    const backend = { getState, listStacks: vi.fn() } as unknown as S3StateBackend;

    const view = memoizeCrossStackStateReads(backend);
    const first = view.getState(A.stack, A.region);
    const second = view.getState(B.stack, B.region);

    // The PROMISE identity is the memoization, so this is the direct
    // observation. Under the separator the second query returned the FIRST
    // query's promise, which is how a query about B is answered with A's
    // record — the wrong-answer half of the issue.
    expect(second).not.toBe(first);
    expect(getState).toHaveBeenCalledTimes(2);

    // And the values actually differ, so a future change that made the view
    // return two distinct promises over one underlying read still fails.
    const [resolvedA, resolvedB] = await Promise.all([first, second]);
    expect(resolvedA).not.toEqual(resolvedB);
    expect(resolvedA).toMatchObject({ state: { stackName: A.stack, region: A.region } });
    expect(resolvedB).toMatchObject({ state: { stackName: B.stack, region: B.region } });
  });

  it('an identical repeat DOES share a promise, so the memo still memoizes', () => {
    // The inverse regression: making every key unique would also pass the case
    // above while costing one AWS read per reference, which is the whole reason
    // this view exists.
    const getState = vi.fn(async () => ({ state: {} }));
    const backend = { getState, listStacks: vi.fn() } as unknown as S3StateBackend;

    const view = memoizeCrossStackStateReads(backend);
    expect(view.getState(A.stack, A.region)).toBe(view.getState(A.stack, A.region));
    expect(getState).toHaveBeenCalledTimes(1);
  });
});

describe("the re-export chain walk's visited set keys coordinates injectively", () => {
  /**
   * A producer template declaring one Output under `name`, exporting it, whose
   * value re-exports `reExportOf` from `fromStack` when given.
   */
  const templateWith = (
    name: string,
    value: unknown
  ): { Outputs: Record<string, unknown> } => ({
    Outputs: { [name]: { Value: value, Export: { Name: name } } },
  });

  it('a hop is NOT skipped because another coordinate straddles the separator', () => {
    // Two coordinates that the old `stack<NUL>key` visited-set key merged:
    //   ("Evil<NUL>Export", "Two")  and  ("Evil", "Export<NUL>Two")
    // Seeding the walk at the first used to mark the second visited, so the
    // walk never followed the hop that reaches the secret expression and
    // returned "no secret expression" over a producer that publishes one.
    const seedStack = `Evil${NUL}Export`;
    const hopStack = 'Evil';
    const hopKey = `Export${NUL}Two`;

    const templates = new Map<string, unknown>([
      // The seed coordinate re-exports the hop coordinate.
      [seedStack, templateWith('Two', { 'Fn::ImportValue': hopKey })],
      // The hop coordinate publishes the secret expression the walk is for.
      [hopStack, templateWith(hopKey, '{{resolve:secretsmanager:db:SecretString:password}}')],
    ]);
    const exportOwners = new Map<string, readonly string[]>([[hopKey, [hopStack]]]);

    const verdict = producerPublishesSecretExpression(
      templates as never,
      exportOwners,
      seedStack,
      'Two'
    );

    // `no` is the verdict that lets scrub proceed over an unscrubbed producer,
    // so the assertion is that the walk reached SOMETHING, not which flavour.
    expect(verdict.kind).not.toBe('no');
  });

  it('the two coordinates really did collide under the old separator', () => {
    // Guard-the-guard for the case above: it is only about a skipped hop if
    // the seed and the hop share a key under the separator.
    const naive = (s: string, k: string): string => `${s}${NUL}${k}`;
    expect(naive(`Evil${NUL}Export`, 'Two')).toBe(naive('Evil', `Export${NUL}Two`));
  });
});
