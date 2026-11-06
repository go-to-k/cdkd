import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vite-plus/test';

import {
  CLIENT_CONSTRUCTION,
  clientSiteKind,
  constructionStatement,
  EXTRA_SURFACE_FILES,
  hasAnnotationAbove,
  isAnnotationCommentLine,
  isCommentLine,
  isInSurface,
  stripComments,
  surfaceFiles,
  type ClientSiteKind,
} from './_local-surface-scope.js';

/**
 * Every AWS client the `cdkd local *` surface builds must DECLARE whose
 * identity it runs as (issue [#3130](https://github.com/go-to-k/cdkd/issues/3130)).
 *
 * `--role-arn` publishes its assumed credentials to `awsClientDefaults()`, so
 * from that point every client under `src/**` runs as the role unless it opts
 * out. That is right for cdkd's own calls and WRONG for this surface's
 * workload-facing ones: whatever these resolve — container credentials, a task
 * role assumed for the container, ECS task-secret plaintext — is handed to the
 * user's locally-running code. (The `${AWS::AccountId}` substituted into the
 * emulated environment is an identifier, not a permission: under
 * `--from-state` (and with no state source) it is the DEPLOY account, so those
 * lookups deliberately run as the role, and those sites say so; under
 * `--from-cfn-stack` it is the caller's and the site opts out — issues
 * go-to-k/cdkd#3230, #5001.) A deploy role is normally the more
 * privileged of the two identities in play, so inheriting it there lets local
 * code read what the caller's own principal cannot.
 *
 * Three review rounds each found one more site of exactly that shape, which is
 * why this is a fence rather than a list of fixes: the population is derived
 * from the code, and a site added later fails until someone decides. Neither
 * verdict is the default — a site either opts out or says why it does not.
 *
 * THREE SHAPES REACH `awsClientDefaults`, and counting only the first made this
 * file's headline claim false for the others. `clientSiteKind` in
 * `_local-surface-scope.ts` owns that distinction and why a `new AwsClients`
 * bag and a spread of the credential helper take only the annotation. A FOURTH
 * shape reaches no helper at all: a direct `new STSClient({ region })` builds on
 * the SDK default chain, which under `--role-arn` is the role's env triple
 * (issue #5866). Every direct `new <Name>Client(` is therefore scanned to its
 * closing paren, and one spreading no helper is a `bareClient` site.
 *
 * WHAT THIS FENCE STILL CANNOT SEE, recorded rather than implied away: a
 * constructor bound under another name (`const { STSClient: S } = ...; new
 * S(...)`), and a client CONSTRUCTED ELSEWHERE and injected. `resolveEcsSecrets` accepts
 * `secretsManagerClient` / `ssmClient` for tests, and an injected client's
 * identity was decided at its own construction site — outside this surface, or
 * outside `src/**` entirely. That seam is documented at the option itself as
 * test-only; nothing here can enforce it.
 *
 * The sibling fence for the OTHER channel — the `AWS_*` environment triple
 * `cdkd local *` copies into the container, and the INI credentials file it
 * bind-mounts — is `tests/unit/local/local-surface-env-identity.test.ts`.
 * Neither can see the other's population; `_local-surface-scope.ts` is the
 * SCOPE they share, and the reason that sharing is a module rather than a
 * promise.
 */
const ANNOTATION = 'cdkd-local-role-identity:';

/**
 * `bareClient` is a direct `new <Name>Client(` whose construction spreads none
 * of the helpers (issue #5866): it runs on the SDK default chain, i.e. the
 * role's env triple under `--role-arn`. Like the bag shapes it has no option
 * to pass here, so its verdict is the annotation — or adopting the helper.
 */
type SiteKind = ClientSiteKind | 'bareClient';

interface Site {
  file: string;
  line: number;
  text: string;
  kind: SiteKind;
  optsOut: boolean;
  annotated: boolean;
}

/**
 * Classify a direct client construction: `covered` when its statement spreads
 * a helper (that helper's line is the site), else a `bareClient` site.
 */
function constructionKind(lines: string[], index: number): 'covered' | 'bareClient' | undefined {
  const code = stripComments(lines[index] ?? '');
  if (isCommentLine(lines[index] ?? '') || !CLIENT_CONSTRUCTION.test(code)) return undefined;
  const statement = constructionStatement(lines, index);
  if (statement !== undefined && clientSiteKind(statement) !== undefined) return 'covered';
  return 'bareClient';
}

/**
 * The sites, plus how many direct constructions spread a helper — the
 * construction scan's own floor, since no `bareClient` site exists to count.
 */
function collectSites(): { sites: Site[]; coveredConstructions: number } {
  const sites: Site[] = [];
  let coveredConstructions = 0;
  for (const file of surfaceFiles()) {
    if (!isInSurface(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      // Skip a line that is ENTIRELY prose before stripping. `stripComments`
      // does not touch a JSDoc ` * ` continuation, so a doc paragraph spelling
      // `awsClientDefaults()` classified as a SITE and demanded a verdict — the
      // one place this fence still disagreed with its sibling about "is this
      // line code or prose", which is exactly what `_local-surface-scope.ts`
      // exists to make impossible. No such line exists today; it is a loud
      // failure rather than a silent one, hence a fix and not a blocker.
      if (isCommentLine(text)) return;
      const code = stripComments(text);
      const construction = constructionKind(lines, i);
      if (construction === 'covered') coveredConstructions++;
      // A single-line `new X({ ...awsClientDefaults() })` is BOTH; the helper
      // site carries it, so it is not pushed twice.
      const kind: SiteKind | undefined =
        clientSiteKind(code) ?? (construction === 'bareClient' ? 'bareClient' : undefined);
      if (kind === undefined) return;
      sites.push({
        file,
        line: i + 1,
        text: text.trim(),
        kind,
        // Only a direct `awsClientDefaults(...)` spread can take the option; the
        // other two shapes never accept it, so the text there opts out of nothing.
        optsOut: kind === 'awsClientDefaults' && code.includes('ignoreAssumedRole: true'),
        // Issue #3250 item 6: a fixed 4-line window, which FOUR of the sites
        // below sat exactly on. `hasAnnotationAbove` walks the enclosing
        // statement instead, so a rewrapped word cannot drop a decided site to
        // undecided — see its doc for why that is not simply "a wider window".
        annotated: hasAnnotationAbove(lines, i, ANNOTATION),
      });
    });
  }
  return { sites, coveredConstructions };
}

describe('every AWS client on the `cdkd local` surface declares whose identity it uses', () => {
  const { sites, coveredConstructions } = collectSites();

  it('sees the population it claims to guard', () => {
    // The construction scan (issue #5866) finds no `bareClient` today, so its
    // liveness is this count: every direct `new <Name>Client(` that spreads a
    // helper. Measured 2026-11-07: 22. A scan that stopped matching or stopped
    // balancing parens would drop it, not pass silently.
    expect(coveredConstructions, 'direct client constructions spreading a helper').toBeGreaterThanOrEqual(
      18
    );
    // Floors, so a broken walk or a renamed helper reports a failure rather
    // than a vacuous pass. The floors sit below the measured population so
    // ordinary deletions do not trip them, and each SHAPE carries its own:
    // an aggregate floor stays green while one shape stops being matched at
    // all, which is how the `new AwsClients(` shape went unseen.
    expect(sites.length).toBeGreaterThanOrEqual(18);
    expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThanOrEqual(5);
    expect(sites.filter((s) => s.kind === 'awsClientDefaults').length).toBeGreaterThanOrEqual(15);
    expect(sites.filter((s) => s.kind === 'AwsClients').length).toBeGreaterThanOrEqual(3);
    // The credential helper's spreads (go-to-k/cdkd#3588): `ecr-puller.ts`'s
    // caller-identity client, its ECR client and its AssumeRole hop. Without
    // this shape they left the population silently.
    expect(sites.filter((s) => s.kind === 'ambientClientDefaults').length).toBeGreaterThanOrEqual(
      3
    );
  });

  it('has every site either opting out or saying why it keeps the role', () => {
    const undecided = sites
      .filter((s) => !s.optsOut && !s.annotated)
      .map((s) => `${s.file}:${s.line}  ${s.text}`);

    expect(
      undecided,
      'A client here inherits a `--role-arn` assumed for cdkd\'s own calls unless it says ' +
        'otherwise. If what it resolves reaches the user\'s emulated code — credentials, a ' +
        'role it assumes for the container, secret values — pass ' +
        '`awsClientDefaults({ ignoreAssumedRole: true })`. An account id substituted into ' +
        'the emulated environment follows where the stack was read (issue #5001): under ' +
        '`--from-cfn-stack` it opts out, under `--from-state` / no source it is the DEPLOY ' +
        'account, runs as the role and takes the comment. If it is genuinely cdkd calling AWS as itself, write a ' +
        '`cdkd-local-role-identity: <reason>` comment above it. A `new AwsClients({...})` ' +
        'bag has no opt-out to pass and therefore takes the comment. A `new <Name>Client(...)` ' +
        'spreading no helper runs on the SDK default chain — the role, under `--role-arn` — so ' +
        'spread `awsClientDefaults({ ignoreAssumedRole: true })` into it or write the comment.'
    ).toEqual([]);
  });

  it('carries BOTH verdicts, each with its own floor, so neither arm is vacuous', () => {
    // A population that had drifted to all-one-kind would make the fence above
    // unfalsifiable in one direction. `some()` alone is far too weak for that:
    // all but one site could flip to the other verdict with `some()` still true
    // on both. The sibling fence carries a floor per VERDICT for exactly this
    // reason and says so in its own header. Each floor sits below the current
    // population: deleting a client site (go-to-k/cdkd#2277 removed six opt-outs
    // with `httpv2-service-integration.ts`) lowers it deliberately.
    expect(sites.filter((s) => s.optsOut).length, 'sites opting out').toBeGreaterThanOrEqual(10);
    expect(
      sites.filter((s) => s.annotated && !s.optsOut).length,
      'sites carrying an annotation instead'
    ).toBeGreaterThanOrEqual(6);
  });

  it('classifies each spelling of each site shape, and none inside a comment', () => {
    // Per SPELLING, not per shape: the population floor for the helper shape is
    // met by `clientDefaultsFor(` alone, so a dropped `ambientClientDefaults(`
    // arm would stay green on the floor.
    expect(clientSiteKind('  ...awsClientDefaults({ ignoreAssumedRole: true }),')).toBe(
      'awsClientDefaults'
    );
    expect(clientSiteKind('  const c = new AwsClients({ region });')).toBe('AwsClients');
    expect(clientSiteKind('  ...ambientClientDefaults(),')).toBe('ambientClientDefaults');
    expect(clientSiteKind('  ...clientDefaultsFor(credentialConfig),')).toBe(
      'ambientClientDefaults'
    );
    expect(clientSiteKind(stripComments('  x(); // ...ambientClientDefaults(),'))).toBeUndefined();
  });

  it('classifies a direct client construction by whether it spreads a helper (#5866)', () => {
    const at = (lines: string[]) => constructionKind(lines, 0);
    expect(at(['  const sts = new STSClient({ region });'])).toBe('bareClient');
    expect(at(['  const sts = new STSClient();'])).toBe('bareClient');
    expect(at(['  const ecr = new ECRClient({', '    region,', '  });'])).toBe('bareClient');
    // Each helper, across lines, with a comment in between.
    expect(
      at([
        '  const sts = new STSClient({',
        '    // a comment naming nothing',
        '    ...awsClientDefaults({ ignoreAssumedRole: true }),',
        '  });',
      ])
    ).toBe('covered');
    expect(at(['  new ECRClient({ ...clientDefaultsFor(c), region })'])).toBe('covered');
    expect(at(['  new ECRClient({ ...ambientClientDefaults() })'])).toBe('covered');
    // The helper must be INSIDE this construction, not in the next statement.
    expect(
      at(['  const sts = new STSClient({ region });', '  const x = awsClientDefaults();'])
    ).toBe('bareClient');
    // A helper only named in a trailing comment is not spread.
    expect(at(['  new STSClient({ region }); // ...awsClientDefaults()'])).toBe('bareClient');
    // Unbalanced within the cap: fails closed to a site.
    expect(at(['  new STSClient({', ...Array.from({ length: 70 }, () => '    a,')])).toBe(
      'bareClient'
    );
    // Not a construction: the bag, a type position, a comment.
    expect(at(['  const c = new AwsClients({ region });'])).toBeUndefined();
    expect(at(['  let sts: InstanceType<typeof STSClient>;'])).toBeUndefined();
    expect(at(['  // new STSClient({ region })'])).toBeUndefined();
  });

  it('refuses a trailing comment as a verdict, and an empty reason as an annotation', () => {
    // Guard-the-guard: both classifiers were substring tests over the whole
    // line, so a site could be marked decided by prose ABOUT the rule. These
    // are the exact shapes that used to pass.
    expect(stripComments('...awsClientDefaults(), // ignoreAssumedRole: true not needed')).not.toContain(
      'ignoreAssumedRole: true'
    );
    expect(stripComments('...awsClientDefaults({ ignoreAssumedRole: true }),')).toContain(
      'ignoreAssumedRole: true'
    );
    expect(isAnnotationCommentLine('  // cdkd-local-role-identity:', ANNOTATION)).toBe(false);
    expect(
      isAnnotationCommentLine("  const tag = 'cdkd-local-role-identity: x';", ANNOTATION)
    ).toBe(false);
    expect(
      isAnnotationCommentLine(
        '  // cdkd-local-role-identity: cdkd calls AWS as itself here',
        ANNOTATION
      )
    ).toBe(true);
  });

  it('accepts an annotation the old 4-line window would have dropped, and stops at a statement', () => {
    // Issue #3250 item 6. FOUR real sites sat EXACTLY on the old window's
    // boundary (`local-state-loader.ts:554` and all three `ecr-puller.ts`
    // clients), so one rewrapped word in any of their annotations would have
    // reported a fence failure that was really a formatting change.
    const decidedAcrossALongAnnotation = [
      '  // cdkd-local-role-identity: cdkd calls AWS as itself here, for its own',
      '  // bookkeeping, and nothing it resolves becomes an identity the emulated',
      '  // workload can act as. The reason runs long on purpose.',
      '  //',
      '  // A second paragraph, further from the site than any fixed window ran.',
      '  const clients = new AwsClients({',
    ];
    expect(
      hasAnnotationAbove(decidedAcrossALongAnnotation, 5, ANNOTATION),
      'an annotation five lines up must still govern its site'
    ).toBe(true);

    // The other direction, which is what keeps the walk from being "a wider
    // window": an intervening STATEMENT ends it, so a site cannot inherit the
    // reason written for the one above it.
    const separatedByAStatement = [
      '  // cdkd-local-role-identity: this reason belongs to the client below it',
      '  const first = new AwsClients({ region });',
      '  const second = new AwsClients({ region });',
    ];
    expect(
      hasAnnotationAbove(separatedByAStatement, 2, ANNOTATION),
      "a second client must not inherit the first's reason"
    ).toBe(false);
  });

  it('keeps a nested `src/cli/commands/local/**` file and the emulator shim in scope', () => {
    // The previous pattern rejected `/` outright, so a file moved into a
    // subdirectory would have left the population silently — and the ECS
    // service emulator shim is workload-facing with no `local-` prefix.
    expect(isInSurface('src/cli/commands/local/foo.ts')).toBe(true);
    // A split command's directory: `local start-api`'s handler lives there.
    expect(isInSurface('src/cli/commands/local-start-api/command.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/local-start-api/nested/deep.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/local-invoke.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/ecs-service-emulator.ts')).toBe(true);
    expect(isInSurface('src/local/nested/deep/thing.ts')).toBe(true);
    expect(isInSurface('src\\local\\nested\\thing.ts')).toBe(true);
    // Still NOT the whole command tree.
    expect(isInSurface('src/cli/commands/deploy.ts')).toBe(false);
    expect(isInSurface('src/cli/commands/localish.ts')).toBe(false);
    expect(isInSurface('src/local/notes.md')).toBe(false);
  });

  it('presents an EXTRA_SURFACE_FILES entry to the predicate even from outside a ROOT', () => {
    // `isInSurface` accepting a path buys nothing if the walk never offers it.
    // Both fences go through `surfaceFiles()` for that reason; this pins the
    // seeding, which is invisible while every extra entry happens to live under
    // a ROOT -- as today's single entry does.
    expect(surfaceFiles()).toContain('src/cli/commands/ecs-service-emulator.ts');
    for (const extra of EXTRA_SURFACE_FILES) {
      expect(isInSurface(extra), `${extra} must be in surface`).toBe(true);
    }
  });
});
