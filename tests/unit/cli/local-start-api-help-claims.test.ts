import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiscoveredRoute, ResolvedStage } from 'cdk-local/internal';
import { attachStageContext, buildHttpApiV2Event, buildStageMap } from 'cdk-local/internal';
import { describe, expect, it } from 'vite-plus/test';
import { createLocalStartApiCommand } from '../../../src/cli/commands/local-start-api.js';

/**
 * Two `cdkd local` strings that asserted something the code contradicts.
 * Neither executes, which is exactly why nothing caught them: a wrong sentence
 * in a help string or a log line is read attentively by a user who is already
 * troubleshooting, and points them away from something that works.
 *
 *   - [#2524](https://github.com/go-to-k/cdkd/issues/2524) — `--stage` claimed
 *     that on HTTP API v2 routes `requestContext.stage` is "always `$default`
 *     regardless of this flag (AWS-side limitation)". cdk-local threads the
 *     selected `StageName` into the v2 event exactly as it does for REST v1, so
 *     a user whose handler branches on `requestContext.stage` would have
 *     concluded local emulation could not reproduce that branch.
 *   - [#2536](https://github.com/go-to-k/cdkd/issues/2536) — the ECR-pull
 *     fallback log said `(same-acct/region only)` while `pullEcrImage` builds
 *     its ECR client for the image URI's OWN region, so a cross-region pull
 *     succeeds. Cross-ACCOUNT is the real limit on this command, and only
 *     because it declares no `--ecr-role-arn`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

function stageDescription(): string {
  const cmd = createLocalStartApiCommand();
  const stage = cmd.options.find((option) => option.long === '--stage');
  if (!stage) throw new Error('start-api no longer declares --stage');
  return stage.description;
}

describe('local start-api --stage help matches what cdk-local does with v2 stages (#2524)', () => {
  /**
   * The behavioural half, and the reason this file imports from
   * `cdk-local/internal` rather than only reading cdkd's own string: a help
   * string is only "correct" relative to the dependency's behaviour, and
   * asserting the wording alone would keep passing if cdk-local later made the
   * ORIGINAL claim true.
   */
  function resolveRoute(
    template: Record<string, unknown>,
    stageOverride?: string,
    apiVersion: 'v1' | 'v2' = 'v2'
  ): DiscoveredRoute {
    const route: DiscoveredRoute = {
      method: 'GET',
      pathPattern: '/items',
      lambdaLogicalId: 'Handler',
      source: apiVersion === 'v2' ? 'http-api' : 'rest-v1',
      apiVersion,
      // The discovery-time placeholder every v2 route starts on. Seeding it
      // here is what makes the arms below DIFFER by the stage map alone.
      // For the v1 arm this is deliberately NOT what cdkd's discovery layer
      // would seed (v1 parses the Stage name it finds); a value the v1 path can
      // never produce on its own is what makes `toBe('prod')` prove the map
      // wrote it, rather than the fixture having pre-agreed with the answer.
      stage: '$default',
      apiLogicalId: apiVersion === 'v2' ? 'HttpApi' : 'RestApi',
      declaredAt: 'TestStack',
    };
    const stageMap: Map<string, ResolvedStage> = buildStageMap(
      template as never,
      stageOverride as never
    );
    attachStageContext([route], stageMap);
    return route;
  }

  function stageInV2Event(template: Record<string, unknown>, stageOverride?: string): unknown {
    const route = resolveRoute(template, stageOverride);
    const event = buildHttpApiV2Event(
      {
        method: 'GET',
        rawUrl: '/items',
        headers: { host: ['localhost'] },
        body: Buffer.alloc(0),
      },
      { route, pathParameters: {}, matchedPath: '/items' }
    );
    return (event['requestContext'] as Record<string, unknown>)['stage'];
  }

  const NAMED_V2_STAGE = {
    Resources: {
      HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: {} },
      ProdStage: {
        Type: 'AWS::ApiGatewayV2::Stage',
        Properties: { ApiId: { Ref: 'HttpApi' }, StageName: 'prod' },
      },
    },
  };

  const NO_V2_STAGE = {
    Resources: { HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: {} } },
  };

  it("a named v2 Stage IS surfaced through requestContext.stage — the help's old claim was false", () => {
    expect(stageInV2Event(NAMED_V2_STAGE)).toBe('prod');
  });

  it("$default is what a v2 API with NO templated Stage reports — the counter-case", () => {
    // Both arms are needed: with only the first, an implementation that
    // hard-coded any single value would pass; with only the second, the old
    // "always $default" claim would pass.
    expect(stageInV2Event(NO_V2_STAGE)).toBe('$default');
  });

  it('--stage selects among several named v2 Stages', () => {
    const twoStages = {
      Resources: {
        HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: {} },
        ProdStage: {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: { ApiId: { Ref: 'HttpApi' }, StageName: 'prod' },
        },
        StagingStage: {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: { ApiId: { Ref: 'HttpApi' }, StageName: 'staging' },
        },
      },
    };
    expect(stageInV2Event(twoStages, 'staging')).toBe('staging');
  });

  it('drives event.stageVariables as well as requestContext.stage', () => {
    // The help makes TWO claims; every case above reads only the first. Without
    // this the `stageVariables` half could be false and the suite stay green —
    // and the `$default` counter-case in particular would also pass if
    // `attachStageContext` were a complete no-op, since it reads back the value
    // the fixture seeded.
    const withVars = {
      Resources: {
        HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: {} },
        ProdStage: {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: {
            ApiId: { Ref: 'HttpApi' },
            StageName: 'prod',
            StageVariables: { tableName: 'prod-items' },
          },
        },
      },
    };
    expect(resolveRoute(withVars).stageVariables).toEqual({ tableName: 'prod-items' });
    // ...and null where no Stage resolves, which is the same observable the
    // no-match warn below describes.
    expect(resolveRoute(NO_V2_STAGE).stageVariables).toBeNull();
  });

  it('threads the StageName for REST v1 too — the other half of "v1 and v2 alike"', () => {
    const restTemplate = {
      Resources: {
        RestApi: { Type: 'AWS::ApiGateway::RestApi', Properties: {} },
        ProdStage: {
          Type: 'AWS::ApiGateway::Stage',
          Properties: { RestApiId: { Ref: 'RestApi' }, StageName: 'prod' },
        },
      },
    };
    expect(resolveRoute(restTemplate, undefined, 'v1').stage).toBe('prod');
  });

  it('a --stage name matching no Stage leaves the route with stageVariables: null', () => {
    // The third claim in the rewritten help. `buildStageMap` leaves the API out
    // of the map entirely, which is what start-api's dedup warn keys on.
    const route = resolveRoute(NAMED_V2_STAGE, 'staging');
    expect(route.stageVariables).toBeNull();
    expect(buildStageMap(NAMED_V2_STAGE as never, 'staging' as never).size).toBe(0);
  });

  it('the help string no longer makes the claim the code contradicts', () => {
    const description = stageDescription();
    expect(description).not.toContain('AWS-side limitation');
    expect(description).not.toMatch(/always '\$default'/);
    // ...and positively says what the behaviour above shows, so a rewrite that
    // merely DELETES the wrong sentence leaves the user no better informed.
    expect(description).toContain('requestContext.stage');
    expect(description).toContain('event.stageVariables');
    expect(description).toMatch(/HTTP API v2/);
    expect(description).toMatch(/stageVariables: null/);
  });
});

describe('local start-api ECR fallback log names the real constraint (#2536)', () => {
  /**
   * A repo-wide fence rather than a single-string assertion: the claim was
   * copied across eleven sites in six files (two log lines, three
   * `--ecr-role-arn` help strings, and six comments), and fixing the one the
   * issue named would have left the other ten asserting the opposite.
   *
   * The population is derived from the CODE — every `src/**` file that touches
   * the ECR pull — rather than from the files this change happened to edit, so
   * a twelfth site added later is in scope automatically.
   */
  /**
   * Widened after review: the first cut required the literal
   * `same-acct` / `same-account`, so `"same-region only"`, `"same-region-only"`,
   * `"same account and same region"` and `"same acct/region"` all slipped past
   * it — four spellings a person would plausibly write, none of them the one
   * that was removed. The anchor is now the CLAIM (a `region` qualified as
   * same/only), not the account half that happened to precede it in the
   * sentence being deleted.
   */
  const FORBIDDEN =
    /same[- ](?:acct|account)?[\s/,]*(?:and\s+)?(?:same[- ])?region|same[- ]region[-\s]*only/i;

  function srcFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...srcFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  const ecrFiles = srcFiles(SRC_DIR).filter((file) => {
    const text = readFileSync(file, 'utf8');
    return text.includes('pullEcrImage') || text.includes('ecrRoleArn');
  });

  /**
   * The ECR-context qualifier and the negation guard — and why NEITHER replaces
   * the per-file count pin.
   *
   * Widening the claim regex made it fire on four lines that are not about the
   * ECR pull at all: the cross-stack "same-region filter" in
   * `local-run-task.ts`, "across same-region stacks" in `local-start-api.ts`,
   * and the two `NOT same-region-only` sentences this PR wrote as the FIX. So a
   * line offends only when it makes the claim, sits in ECR context, and is not
   * negating it.
   *
   * A first cut of that qualifier DELETED the count pin it replaced, and round
   * 2 of the review measured the cost: two false claims planted in
   * `ecr-puller.ts` ran fully green. Both escaped through the qualifiers rather
   * than through the claim regex — one carried an incidental `is not` later in
   * the sentence, the other put the word `pull` on the previous WRAPPED line.
   * The two assertions fail on disjoint mutations, so both are kept:
   *
   *   - `offends()` is precise and reports the offending LINE;
   *   - `EXPECTED_RAW_MATCHES` pins how many times the claim regex fires in a
   *     file AT ALL, which no qualifier can talk its way out of.
   *
   * Three fixes to the qualifiers themselves came from the same round: the
   * context token is looked for over a ±1-line WINDOW (the population is
   * wrapped JSDoc, so the sentence and its context routinely straddle a line
   * break), the negation must GOVERN the match rather than appear anywhere on
   * the line, and `NEGATION` gained the `i` flag its siblings already had.
   */
  const ECR_CONTEXT = /\becr\b|pullEcrImage|\bpulls?\b/i;
  const NEGATION = /\b(?:NOT|no longer|neither|never)\b|used to/i;

  /** How far before the match a negation still governs it. */
  const NEGATION_REACH = 24;

  const offendsAt = (linesOfFile: readonly string[], index: number): boolean => {
    const line = linesOfFile[index] ?? '';
    const match = FORBIDDEN.exec(line);
    if (!match) return false;
    // The negation must sit just BEFORE the claim it negates. Scanning the
    // whole line let `... is same-region only; cross-account is not supported`
    // exempt itself on a clause that negates something else entirely.
    const governing = line.slice(Math.max(0, match.index - NEGATION_REACH), match.index);
    if (NEGATION.test(governing)) return false;
    // ...and the ECR context may be on either neighbour, because a wrapped
    // JSDoc sentence routinely puts `pull` on the line above or below.
    const window = [linesOfFile[index - 1] ?? '', line, linesOfFile[index + 1] ?? ''].join('\n');
    return ECR_CONTEXT.test(window);
  };

  /**
   * The one line in the population that makes the claim SHAPE truthfully.
   *
   * `ecr-puller.ts:29` enumerates the pull's three credential paths, and
   * "Same-account, same-region: fast path. No STS hop." is a true description
   * of the first, not a claim that the pull cannot cross a region. It sits two
   * lines under a `**Cross-account / cross-region**` heading, so the ±1-line
   * context window sees `ecr:GetAuthorizationToken` on the next line and would
   * otherwise flag it.
   *
   * Exempted by its exact SENTENCE and its full repo-relative PATH — not by a
   * count (satisfiable by any one match in the file) and not by a basename
   * (inheritable by a second file of that name). Rewording the sentence, or
   * adding a second claim to that file, both fail.
   */
  const TRUE_STATEMENTS: Record<string, readonly string[]> = {
    'src/local/ecr-puller.ts': ['Same-account, same-region: fast path'],
  };

  /** Convenience for the single-line discrimination table below. */
  const offends = (line: string): boolean => offendsAt([line], 0);

  it('finds the ECR-touching files — floor, so an empty population cannot pass', () => {
    expect(ecrFiles.length).toBeGreaterThanOrEqual(6);
  });

  /**
   * Strip the exempted SENTENCES from a line, leaving the rest to be judged.
   *
   * Dropping the whole LINE (the first cut) let a second, false claim ride
   * along on an already-exempted one: appending `The ECR pull is same-region
   * only.` to `ecr-puller.ts:29` — the exact sentence #2536 removed, in the one
   * file the probe below calls the fence's likeliest blind spot — ran fully
   * green. An exemption may excuse the text it names and nothing else.
   */
  const withoutExemptions = (text: string, label: string): string =>
    (TRUE_STATEMENTS[label] ?? []).reduce(
      (rest, sentence) => rest.split(sentence).join(' '),
      text
    );

  /** Every line of `file` that OFFENDS, as `line: text`. */
  const claimLines = (file: string, label: string): string[] => {
    const fileLines = readFileSync(file, 'utf8')
      .split('\n')
      .map((text) => withoutExemptions(text, label));
    return fileLines
      .map((text, index) => [index + 1, text, index] as const)
      .filter(([, , index]) => offendsAt(fileLines, index))
      .map(([line, text]) => `${line}: ${text.trim()}`);
  };

  /**
   * Raw claim-regex MATCHES, qualifiers ignored — the backstop.
   *
   * Matches, not lines: counting lines let a second claim appended to an
   * already-counted line leave the total unchanged, which is half of how the
   * exempted-line evasion above stayed green.
   */
  const RAW_GLOBAL = new RegExp(FORBIDDEN.source, 'gi');
  const rawMatchCount = (file: string): number =>
    [...readFileSync(file, 'utf8').matchAll(RAW_GLOBAL)].length;

  /**
   * Every file in the population that still contains the claim SHAPE, with its
   * exact count, keyed on the repo-relative path (the deleted version keyed on
   * the basename, so a second file of that name anywhere inherited it).
   *
   * These are all TRUE statements or negations of the claim; the pin exists so
   * that swapping one of them for a false claim, or adding a sixth, fails here
   * even if it evades `offends()`.
   */
  const EXPECTED_RAW_MATCHES: Record<string, number> = {
    // `NOT same-region-only: pullEcrImage authenticates ...` — the fix's own wording.
    'src/cli/commands/local-invoke.ts': 1,
    // The cross-stack index scan's `same-region filter` — unrelated to ECR.
    'src/cli/commands/local-run-task.ts': 1,
    // `across same-region stacks` (unrelated) + the fix's `NOT same-region-only`.
    'src/cli/commands/local-start-api.ts': 2,
    // The true fast-path description exempted by TRUE_STATEMENTS.
    'src/local/ecr-puller.ts': 1,
  };

  it.each(ecrFiles.map((f) => [f.slice(REPO_ROOT.length + 1), f] as const))(
    '%s does not claim the ECR pull is same-region-only',
    (label, file) => {
      expect(
        claimLines(file, label),
        `${label} claims a same-account/region limit on the ECR pull, but pullEcrImage builds its ` +
          "ECR client for the image URI's own region (issue #2536)."
      ).toEqual([]);
    }
  );

  it.each(ecrFiles.map((f) => [f.slice(REPO_ROOT.length + 1), f] as const))(
    '%s has exactly the claim-shaped lines it is expected to',
    (label, file) => {
      expect(
        rawMatchCount(file),
        `${label} gained or lost a line matching the same-region claim shape. If you ADDED a ` +
          'true statement or a negation, update EXPECTED_RAW_MATCHES; if you added a false ' +
          'claim, fix it. This backstop exists because the qualifiers around `offends()` are ' +
          'evadable and were measured evading (issue #2536, review round 2).'
      ).toBe(EXPECTED_RAW_MATCHES[label] ?? 0);
    }
  );

  it('the pin names only files that really still carry the shape', () => {
    // Guard-the-guard: an entry left behind after its sentence was reworded
    // would quietly permit a new claim in that file up to the pinned count.
    for (const label of Object.keys(EXPECTED_RAW_MATCHES)) {
      const file = ecrFiles.find((f) => f.slice(REPO_ROOT.length + 1) === label);
      expect(file, `${label} is pinned but is no longer an ECR file`).toBeDefined();
      expect(rawMatchCount(file as string), `${label} is pinned but no longer matches`).toBeGreaterThan(0);
    }
  });

  it('the fence catches BOTH shapes that were measured evading it', () => {
    // Round 2 planted these two in `ecr-puller.ts` and the file ran green. The
    // first evaded via an incidental `is not` later in the sentence; the second
    // via the context token sitting on the previous wrapped line.
    const evasionOne = ' * The ECR pull is same-account/same-region only; a cross-region retry is not useful.';
    expect(offends(evasionOne)).toBe(true);
    const wrapped = [
      ' * Cross-account images are unsupported for the ECR pull:',
      ' * same-account, same-region images only.',
      ' */',
    ];
    expect(offendsAt(wrapped, 1)).toBe(true);
  });

  it('the fence can SEE the file it would most plausibly be blind to', () => {
    // `ecr-puller.ts` carries the sentence closest to the forbidden shape, so
    // if the fence were inert anywhere it would be there: its REAL line must
    // pass, and a planted claim must be caught.
    const puller = ecrFiles.find((f) => f.endsWith('/src/local/ecr-puller.ts'));
    expect(puller, 'ecr-puller.ts left the population — re-anchor this probe').toBeDefined();
    expect(readFileSync(puller as string, 'utf8')).toContain(
      'Same-account, same-region: fast path'
    );
    expect(claimLines(puller as string, 'src/local/ecr-puller.ts')).toEqual([]);
    expect(offends(' * The ECR pull is same-account / same-region only.')).toBe(true);
  });


  it.each([
    // Five spellings a person would plausibly write. The first is the one that
    // was actually removed; the other four all slipped past the first cut of
    // this regex, which required a literal `same-acct` / `same-account`.
    ['falling back to ECR pull (same-acct/region only)', 1],
    [' * the ECR pull is same-region only', 1],
    [' * same-region-only on the ECR path', 1],
    [' * same account and same region ECR pulls need no role', 1],
    [' * same acct/region ECR', 1],
    // The corrected wording must NOT trip it, or the fence would block its own
    // remediation...
    [" * the ECR client is built for the image URI's own region", 0],
    [' * NOT same-region-only: pullEcrImage authenticates against the URI region', 0],
    // ...nor may an unrelated same-region sentence, which is what the ECR
    // qualifier buys and what four live lines in the population depend on.
    [' * 2. it is the same-region filter of the index-miss per-stack scan; and', 0],
    [' * across same-region stacks, but the partition / URL suffix can', 0],
  ])('the offence predicate discriminates (%#)', (line, expected) => {
    expect(offends(line as string) ? 1 : 0).toBe(expected as number);
  });

  it("start-api's fallback log points at the constraint that IS real here", () => {
    // start-api is the one command in the family with no `--ecr-role-arn`, so
    // its message must say so rather than blaming the region.
    const source = readFileSync(
      join(SRC_DIR, 'cli', 'commands', 'local-start-api.ts'),
      'utf8'
    );
    const line = source
      .split('\n')
      .find((l) => l.includes('falling back to ECR pull'));
    expect(line, 'the ECR-fallback log line moved — re-anchor this assertion').toBeDefined();
    expect(line).toContain('--ecr-role-arn');
    expect(createLocalStartApiCommand().options.map((o) => o.long)).not.toContain('--ecr-role-arn');
  });
});
