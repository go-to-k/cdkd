import { describe, it, expect } from 'vite-plus/test';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A fixture whose CDK app puts SECRET MATERIAL into state must sweep S3 object
 * versions on teardown.
 *
 * The state bucket is versioned, so `aws s3 rm` writes a delete marker and
 * removes nothing: every state.json a fixture ever wrote stays readable via
 * `GetObjectVersion`. For a fixture carrying a real credential that is a
 * disclosure outliving the run. `.claude/rules/testing.md` has stated the rule
 * since issue #2096, and `tests/integration/s3-versions.sh` implements it.
 *
 * WHY THIS IS A LINT AND NOT ANOTHER SENTENCE. The #2096 audit was done by
 * hand, against every fixture's `verify.sh`, and it still missed five. Three
 * were found by a reviewer reading sources, and two more — `appsync` and
 * `apigw-usage-plan-key` — had actually been EXAMINED by that audit and cleared
 * on a bad measurement: a newest-N sample of their surviving state versions.
 * That sampling shape is wrong for this question and the numbers say why. Of
 * `AppSyncStack`'s 557 versions the 12 newest carried no key while 17 of
 * versions 12..45 did; `apigw-usage-plan-key`'s key sits in versions 7 and 8 of
 * 16. The newest versions come from the most recent run, which is the most
 * likely to be already-fixed or to have failed early. **Sample across the
 * range, or grep the whole key.** The same error, in its other form — probing a
 * convention-derived stack name and reading the resulting `0` as clean — cost a
 * separate finding in the same session; read `STACK=` out of `verify.sh`.
 *
 * The three found by reading sources were:
 * `docdb-neptune`, `eventbridge-api-destination` and `cognito-resource-server`
 * — each an exact structural twin of one the audit DID find (a master password,
 * an `unsafePlainText` literal, and a service-generated credential
 * respectively). All three were then measured holding live plaintext in the
 * bucket: 16 of 64 versions, 15 of 18, and 3 of 18 carrying a real
 * `"ClientSecret"`. The audit read `verify.sh`, where the secret is invisible;
 * the secret is declared in `lib/*.ts`. A human sweep found one of each pair
 * and missed the other, which is what a mechanism is for.
 *
 * WHAT THIS CANNOT SEE — stated because a lint that implies completeness is
 * worse than one that names its edges:
 *
 *  1. A secret declared as a RAW CloudFormation property, wherever it lives.
 *     The obvious case is a fixture whose template is a checked-in `.json` /
 *     `.yaml` (today: `raw-cfn-conditions-params/raw-template.json`,
 *     `cross-stack-cfn-fallback/cfn-producer-template.json` and
 *     `stepfunctions-s3-definition/definition.asl.json`, all verified
 *     secret-free — the previously named
 *     `migrate-from-bare-cfn-codegen-only/template-fixture.json` was retired
 *     with `cdkd migrate`, issue #2572), which these patterns never read. But being written
 *     in TypeScript is NOT the same as being covered: every pattern below keys
 *     on an L2 construct prop, so an L1 or an escape hatch slips straight
 *     through -- `new CfnSecret({ secretString: 'x' })` (the pattern requires
 *     the `Value` / `Beta1` suffix), `addPropertyOverride('MasterUserPassword',
 *     ...)`, or a plain literal in a Lambda `environment`. Zero fixtures do this
 *     today, so nothing here is quietly load-bearing -- but do not read "it is
 *     .ts" as "it is scanned".
 *  2. Secrets seeded by the SCRIPT rather than the app. `dynamic-ref-cross-region`
 *     writes a SecureString plaintext straight into a state.json with
 *     `aws s3 cp` to simulate a pre-GHSA record. No token in its `lib/*.ts`
 *     reveals that. It sources the helper anyway, so it is not a violation —
 *     but it would not have been CAUGHT.
 *  3. Service-generated credentials with no marker in the source at all.
 *     `generateSecret: true`, `iam.AccessKey`, `appsync.CfnApiKey` and
 *     `addApiKey` are the shapes known to cache a credential cdkd never saw in
 *     the template; a future provider that caches some other credential
 *     attribute would be invisible here. Cognito's `ClientSecret` was exactly
 *     this class and was found by grepping the BUCKET, not the source.
 *
 *     Note that grepping `src/provisioning/providers/**` is NOT a substitute:
 *     `AWS::ApiGateway::ApiKey` is registered to no provider at all, so it takes
 *     the generic Cloud Control readback, whose resource model includes `Value`
 *     — the live 40-character key, landing in `attributes` with no provider
 *     code ever naming it.
 *
 *  4. Keys OTHER than `state.json` under the same prefix. The helper sweeps the
 *     whole `cdkd/<stack>/<region>/` prefix precisely because
 *     `rollback-journal.json` carries `failedOperations[].attemptedProperties`
 *     — the properties of the failed write, verbatim, including a literal
 *     `MasterUserPassword` in four measured versions. This lint only checks
 *     that a fixture sweeps; the PREFIX form is what makes the sweep sufficient.
 *
 *  5. A NESTED-STACK child, at `cdkd/<Parent>~<Child>/<region>/`, which is a
 *     sibling prefix rather than a descendant, so ONE `s3_stack_prefix` call
 *     does not cover it. This entry used to say "no fixture in the swept set
 *     has one today"; that lapsed without being revisited.
 *     `nested-stack-secret` is in the swept set, builds a real
 *     `cdk.NestedStack`, and already sweeps and asserts BOTH prefixes. What
 *     this lint still cannot see is a fixture that gains a nested stack and
 *     sweeps only the parent's: it checks THAT a fixture sweeps, never that it
 *     enumerated every prefix it owns. Tracked with issue #2107.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. `generateSecretString` looks like it belongs
 * beside `generateSecret: true` in blind spot 3 and does not: issue #2212
 * proposed exactly that, and the premise behind it ("cdkd resolves and persists
 * that value into state.json exactly like a hand-written one") does not survive
 * a trace through the provider. The value is minted LOCALLY from a CSPRNG,
 * handed straight to CreateSecret, and never returned, read back, or written
 * into the properties bag; what state holds is the recipe. The four fixtures
 * that shape would have flagged carry nothing to sweep, and three of them have
 * no `verify.sh` at all, so adding the pattern would have manufactured three
 * real-AWS scripts for a non-problem. It lives in `EXEMPT_SHAPES` at the bottom
 * of this file instead, WITH a fence on each premise -- the difference between
 * an exemption and a rotting comment is whether it fails when its reason stops
 * being true.
 *
 * So the honest backstop is still the per-fixture `s3_assert_versions_swept`
 * plus periodic bucket inspection. This lint closes the class that has actually
 * bitten twice: a declared secret in a fixture that forgot to sweep.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');
const HELPER = 's3-versions.sh';

interface Pattern {
  /** Named in the failure so the fix is obvious without opening this file. */
  readonly what: string;
  readonly re: RegExp;
  /**
   * How many fixtures this must still match. A FLOOR per pattern, not one
   * aggregate: patterns summing to "at least 11" would let a regex that
   * silently stopped matching hide behind the others. Set to today's exact
   * count — raise it when a fixture is added, never lower it to make a red test
   * green.
   *
   * MAY be 0, for a shape no fixture uses yet. A zero floor proves nothing on
   * its own, which is why `sample` below is mandatory rather than optional: the
   * positive control is what keeps a forward-looking pattern honest.
   */
  readonly floor: number;
  /**
   * A snippet this pattern MUST match. Every pattern carries one and the suite
   * checks all of them, so the positive control cannot drift out of step with
   * the pattern list the way a hand-written list of probes does — and a pattern
   * with `floor: 0` is still executed against real input.
   */
  readonly sample: string;
}

const SECRET_MATERIAL: readonly Pattern[] = [
  {
    what: 'SecretValue.unsafePlainText(...) — a literal secret in the template',
    re: /unsafePlainText/,
    floor: 7,
    sample: `secretStringValue: cdk.SecretValue.unsafePlainText('x')`,
  },
  {
    what: 'SecretValue.plainText(...) — the deprecated alias, which /unsafePlainText/ does NOT match',
    re: /SecretValue\.plainText\(/,
    floor: 0,
    sample: `value: cdk.SecretValue.plainText('x')`,
  },
  {
    what: 'a hand-supplied Secret value (secretStringValue / secretObjectValue / secretStringBeta1)',
    re: /secretString(Value|Beta1)|secretObjectValue/,
    floor: 7,
    sample: 'secretObjectValue: { username: x }',
  },
  {
    what: 'a templated database master password (masterPassword / masterUserPassword)',
    // Deliberately NOT `masterUserPassword:\s*'`: deletion-policy-snapshot-heavy
    // passes a VARIABLE (`masterUserPassword: password`), and a randomly
    // generated password lands in state exactly like a quoted one does.
    re: /master(User)?Password/,
    floor: 2,
    sample: 'masterUserPassword: password,',
  },
  {
    what: 'generateSecret: true — Cognito mints a client secret that cdkd caches in state',
    re: /generateSecret:\s*true/,
    floor: 1,
    sample: 'generateSecret: true,',
  },
  {
    what: 'an IAM AccessKey — the provider caches SecretAccessKey in state attributes',
    // Forward-looking: today's only match also trips `secretStringValue`, but a
    // fixture that creates an AccessKey WITHOUT wrapping it in a Secret would
    // still cache the credential, and nothing else here would see it.
    re: /iam\.AccessKey\b|AWS::IAM::AccessKey/,
    floor: 1,
    sample: `new iam.AccessKey(this, 'K', { user })`,
  },
  {
    what: 'an AppSync ApiKey — for AppSync the key ID *is* the credential, and it is the physical id',
    // `AppSyncProvider.createApiKey` persists `response.apiKey.id` as the
    // physical id and repeats it in `attributes.ApiKey` plus an `Arn` built
    // from it (appsync-provider.ts:431-434). Nothing in the fixture's source
    // looks like a secret; the credential is service-generated.
    re: /appsync\.CfnApiKey|AWS::AppSync::ApiKey/,
    floor: 1,
    sample: `new appsync.CfnApiKey(this, 'ApiKey', { apiId })`,
  },
  {
    what: 'an API Gateway ApiKey — no SDK provider handles it, so the Cloud Control readback stores its Value',
    // The sub-class that makes grepping `src/provisioning/providers/**` for a
    // credential insufficient: `AWS::ApiGateway::ApiKey` is not registered to
    // any provider, so it takes the generic Cloud Control path, whose resource
    // model includes `Value` — the live 40-character key, in `attributes`, with
    // no provider code ever naming it.
    re: /addApiKey\(|AWS::ApiGateway::ApiKey/,
    floor: 1,
    sample: `const key = api.addApiKey('Key', { apiKeyName })`,
  },
  {
    what: 'an ElastiCache AuthToken — a literal cache credential in the template',
    re: /[Aa]uthToken/,
    floor: 0,
    sample: 'authToken: cdk.SecretValue.unsafePlainText(pw),',
  },
];

interface Fixture {
  readonly name: string;
  readonly sources: string;
  readonly verify: string | undefined;
}

function readFixtures(): Fixture[] {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(INTEG_ROOT, e.name);
      const verifyPath = join(dir, 'verify.sh');
      return {
        name: e.name,
        // COMMENT-STRIPPED, like the shell predicates below. A `//` line
        // mentioning `secretValueFromJson` -- or a doc block explaining why a
        // fixture does NOT use one -- would otherwise be read as a declaration
        // and make the fixture a violation. That is the false-positive
        // direction, so nothing was failing because of it, which is exactly
        // why it would have gone unnoticed.
        sources: ['bin', 'lib']
          .map((sub) => join(dir, sub))
          .filter((d) => existsSync(d) && statSync(d).isDirectory())
          .flatMap((d) => readTsRecursive(d))
          .join('\n')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/(^|[^:])\/\/.*$/gm, '$1'),
        verify: existsSync(verifyPath) ? readFileSync(verifyPath, 'utf8') : undefined,
      };
    });
}

function readTsRecursive(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return readTsRecursive(full);
    return e.isFile() && e.name.endsWith('.ts') ? [readFileSync(full, 'utf8')] : [];
  });
}

/** The patterns a fixture's CDK sources trip, if any. */
function secretShapes(f: Fixture): string[] {
  return SECRET_MATERIAL.filter((p) => p.re.test(f.sources)).map((p) => p.what);
}

/**
 * `verify.sh` with comments stripped.
 *
 * A plain `includes('s3-versions.sh')` passes on the COMMENT that explains why
 * the helper is sourced — which is exactly what every one of these fixtures has
 * directly above the source line. Deleting the source line and leaving the
 * comment then reads as compliant. Found by the break-test for this very lint:
 * removing the `.` line from `docdb-neptune` left the suite GREEN.
 */
function codeOf(script: string): string {
  return script
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

/** `. ../s3-versions.sh` or `source "${REPO_ROOT}/tests/integration/s3-versions.sh"`. */
const SOURCES_HELPER = /^[ \t]*(\.|source)[ \t]+.*s3-versions\.sh/m;
/** The assertion, as a CALL rather than a mention. */
const CALLS_ASSERTION = /^[^\n]*\bs3_assert_versions_swept[ \t]+\S/m;

describe('a secret-seeding integ fixture must sweep S3 object versions', () => {
  const fixtures = readFixtures();
  const seeding = fixtures.filter((f) => secretShapes(f).length > 0);

  it('finds the files it claims to lint', () => {
    // Without this the provider fence could pass by reading an empty string.
    expect(existsSync(PROVIDER_SRC), `${PROVIDER_SRC} is gone`).toBe(true);
    expect(readFileSync(PROVIDER_SRC, 'utf8').length).toBeGreaterThan(1000);
    expect(existsSync(join(INTEG_ROOT, HELPER)), `${HELPER} is gone`).toBe(true);
  });

  it('finds the fixture tree', () => {
    // Guards the whole suite from passing by scanning nothing.
    expect(fixtures.length).toBeGreaterThan(250);
    expect(fixtures.filter((f) => f.sources.length > 0).length).toBeGreaterThan(200);
  });

  it('each pattern still matches the fixtures it was calibrated against (per-shape floors)', () => {
    // "found nothing" must not be able to pass as "everything complies".
    const counts = SECRET_MATERIAL.map((p) => ({
      what: p.what,
      floor: p.floor,
      matched: fixtures.filter((f) => p.re.test(f.sources)).length,
    }));
    const starved = counts.filter((c) => c.matched < c.floor);
    expect(
      starved.map((c) => `${c.what}: matched ${c.matched}, floor ${c.floor}`),
      'a pattern stopped matching — it was probably narrowed, not obsoleted'
    ).toEqual([]);
  });

  it('every pattern matches its own sample, and none fires on an ordinary stack', () => {
    // Derived from the list rather than hand-listed, so a pattern added later
    // cannot arrive without a control — the failure mode of the previous
    // hand-written version. This is also the ONLY thing standing behind a
    // `floor: 0` pattern.
    const dead = SECRET_MATERIAL.filter((p) => !p.re.test(p.sample)).map((p) => p.what);
    expect(dead, 'pattern does not match its own sample').toEqual([]);
    const benign = `
      const b = new s3.Bucket(this, 'B', { versioned: true });
      new lambda.Function(this, 'F', { environment: { TABLE: t.tableName } });
      new sqs.Queue(this, 'Q', { fifo: true });
    `;
    const falsePositives = SECRET_MATERIAL.filter((p) => p.re.test(benign)).map((p) => p.what);
    expect(falsePositives, 'pattern fires on an ordinary stack').toEqual([]);
    // ...and the composite the fixtures actually use trips exactly two.
    expect(
      secretShapes({
        name: 'p',
        sources: `secretStringValue: cdk.SecretValue.unsafePlainText('x')`,
        verify: '',
      })
    ).toHaveLength(2);
  });

  it('the source / assertion predicates read CODE, not comments (positive control)', () => {
    // The break-test that produced this: deleting the `.` line from a fixture
    // left the explanatory comment behind, and a substring check stayed green.
    expect(SOURCES_HELPER.test(codeOf('. ../s3-versions.sh'))).toBe(true);
    expect(SOURCES_HELPER.test(codeOf('  source "${REPO_ROOT}/tests/integration/s3-versions.sh"'))).toBe(
      true
    );
    expect(SOURCES_HELPER.test(codeOf('# Shared helpers live in ../s3-versions.sh (issue #2096).'))).toBe(
      false
    );
    expect(SOURCES_HELPER.test(codeOf('echo "see ../s3-versions.sh"'))).toBe(false);
    expect(CALLS_ASSERTION.test(codeOf('s3_assert_versions_swept "$B" "$P" "x"'))).toBe(true);
    expect(CALLS_ASSERTION.test(codeOf('# then s3_assert_versions_swept runs'))).toBe(false);
  });

  it('the calibrated seeding set is the one that was audited by hand', () => {
    // Pinned by NAME, not by count. A count would go on passing if one fixture
    // dropped out while another appeared, and the whole point of #2096's
    // follow-up was that a hand audit produced the wrong SET.
    expect(seeding.map((f) => f.name).sort()).toEqual([
      'apigw-usage-plan-key',
      'appsync',
      'cognito-resource-server',
      'cross-stack-secret-import',
      'deletion-policy-snapshot-heavy',
      'docdb-neptune',
      'eventbridge-api-destination',
      'iam-access-key',
      'lambda-esm-self-managed-kafka',
      'local-run-task-from-state',
      'secrets-array-nested',
      'secrets-dynamic-ref',
      'secretsmanager-update-value-source',
    ]);
  });

  it('every secret-seeding fixture has a verify.sh that sources the sweep helper', () => {
    const violations = seeding.flatMap((f) => {
      if (f.verify === undefined) {
        return [
          `${f.name}: declares secret material (${secretShapes(f).join('; ')}) but has NO verify.sh, ` +
            `so nothing can sweep its state versions — add one, or move the secret out of the fixture`,
        ];
      }
      if (!SOURCES_HELPER.test(codeOf(f.verify))) {
        return [
          `${f.name}/verify.sh: declares secret material (${secretShapes(f).join('; ')}) but never sources ` +
            `${HELPER}. The state bucket is VERSIONED: 'aws s3 rm' only writes a delete marker, so that ` +
            `secret stays readable via GetObjectVersion after a green run. See ".claude/rules/testing.md" ` +
            `-> "verify.sh must sweep S3 OBJECT VERSIONS"`,
        ];
      }
      return [];
    });
    expect(violations.sort()).toEqual([]);
  });

  it('and actually calls the assertion, not just the purge', () => {
    // Sourcing the helper and purging without asserting is the exact shape that
    // regressed silently before #2096: a sweep nothing checks.
    const violations = seeding
      .filter((f) => f.verify !== undefined && !CALLS_ASSERTION.test(codeOf(f.verify)))
      .map(
        (f) =>
          `${f.name}/verify.sh: sources ${HELPER} but never calls s3_assert_versions_swept — ` +
          `an unverified sweep is indistinguishable from no sweep`
      );
    expect(violations.sort()).toEqual([]);
  });
});

/**
 * Shapes that LOOK like a seeding fixture and are NOT, each with the
 * measurement that says so.
 *
 * This list exists because the obvious next pattern was wrong. Issue #2212
 * proposed adding `generateSecretString` to `SECRET_MATERIAL` on the premise
 * that "cdkd resolves and persists that value into state.json exactly like a
 * hand-written one", which would have made four fixtures violations --
 * `composite-stack`, `event-driven`, `full-stack-demo` and
 * `secrets-rotation-schedule` -- and forced three of them to grow a `verify.sh`
 * they do not otherwise need. Traced against the tree, the premise does not
 * hold, and the four carry nothing to sweep.
 *
 * An exemption that is only a comment rots, so each entry is FENCED against the
 * premise it rests on: `the exemption premises still hold` below reads the
 * provider source and fails the moment any of the conditions stops being true.
 */
interface Exemption {
  readonly what: string;
  readonly re: RegExp;
  readonly floor: number;
  readonly sample: string;
  /** Why this shape does not reach state, in a form the fence can check. */
  readonly why: string;
}

const EXEMPT_SHAPES: readonly Exemption[] = [
  {
    what: 'generateSecretString — the value is minted locally and never persisted or read back',
    re: /generateSecretString/,
    // composite-stack, event-driven, full-stack-demo, secrets-rotation-schedule,
    // secretsmanager-update-value-source and local-run-task-from-state (the
    // last two are in the seeding set anyway, through `unsafePlainText`).
    // Measured at 7 before fixture sources were
    // comment-stripped: `secrets-dynamic-ref` and `secrets-array-nested` each
    // carry a COMMENT saying generateSecretString is deliberately NOT used, and
    // the floor was counting those. A floor derived from comments is a floor on
    // prose.
    floor: 6,
    sample: 'generateSecretString: { generateStringKey: "password" },',
    why:
      'SecretsManagerSecretProvider.generateSecretString() mints the value with crypto.getRandomValues into a ' +
      'LOCAL, hands it to CreateSecret/UpdateSecret as SecretString, and returns attributes {Id} only. ' +
      'readCurrentState deliberately never calls GetSecretValue, and getDriftUnknownPaths() excludes both ' +
      'SecretString and GenerateSecretString. What state holds is the RECIPE (template, length, exclude rules) ' +
      'and not the value; the recipe does not enable prediction because the source is a CSPRNG.',
  },
];

/**
 * A fixture consuming a secret's VALUE into a template property -- the shape
 * that DOES put plaintext on the wire, via `{{resolve:secretsmanager:...}}`
 * and `intrinsic-function-resolver.ts`'s GetSecretValue.
 *
 * Not a violation TODAY: the GHSA-p5qg-v9gv-hc7w fix redacts the resolved value
 * back to its `{{resolve:...}}` expression before state is persisted, and
 * `deploy-engine.ts` applies the same `redactSecretsForState` to the rollback
 * journal's `attemptedProperties`. It is tracked here because it is the axis
 * along which the `generateSecretString` exemption would STOP being true: a
 * fixture that generates a secret AND then pipes its value into a template
 * property is one redaction bug away from seeding state, and would need to
 * sweep.
 */
const VALUE_CONSUMED_INTO_TEMPLATE: readonly Pattern[] = [
  {
    what: 'secretValueFromJson(...) — resolves one JSON key of a secret into a template property',
    re: /secretValueFromJson\(/,
    // ZERO in code, and that is the measurement rather than an oversight: all
    // four occurrences in the tree are COMMENTS, two of them explaining that
    // the fixture deliberately does NOT use it (it renders an `Fn::Join`,
    // which those fixtures are avoiding). The floor was 2 and was counting
    // them. Kept as a forward-looking pattern, held honest by `sample`.
    floor: 0,
    sample: `SECRET: secret.secretValueFromJson('password').toString()`,
  },
  {
    what: 'SecretValue.secretsManager(...) — a whole-secret dynamic reference',
    re: /SecretValue\.secretsManager\(/,
    floor: 1,
    sample: `cdk.SecretValue.secretsManager('my-secret')`,
  },
  {
    what: 'a literal {{resolve:...}} dynamic reference written into the template',
    re: /\{\{resolve:/,
    // dynamic-ref-cross-region, nested-stack-secret, rollback-cross-region-secret,
    // secrets-array-nested, secrets-dynamic-ref.
    floor: 5,
    sample: '{{resolve:secretsmanager:arn:SecretString:password}}',
  },
  {
    what: 'unsafeUnwrap() — forces a SecretValue to a plain string at synth time',
    re: /unsafeUnwrap\(/,
    floor: 1,
    sample: 'secret.secretValue.unsafeUnwrap()',
  },
  {
    // `secret.secretValue.toString()` renders a `{{resolve:secretsmanager:...}}`
    // just as surely as the four above, and matched NONE of them: the
    // `unsafeUnwrap` pattern catches only the unwrap spelling, and
    // `secretValueFromJson` requires the FromJson form. No fixture writes it
    // today (floor 0), which is precisely when a pattern is cheapest to add.
    // `\b` after `secretValue` is what keeps this from also matching
    // `secretValueFromJson`.
    what: '.secretValue — the whole-secret token, which toString()s to a {{resolve:...}}',
    re: /\.secretValue\b/,
    floor: 0,
    sample: 'PW: secret.secretValue.toString(),',
  },
];

const PROVIDER_SRC = join(
  import.meta.dirname,
  '../../../src/provisioning/providers/secretsmanager-secret-provider.ts'
);

describe('shapes deliberately NOT treated as seeding, and the premises behind that', () => {
  const fixtures = readFixtures();

  it('every exemption still matches the fixtures it was measured against (per-shape floor)', () => {
    // The same floor discipline as SECRET_MATERIAL, and for the same reason: an
    // exemption whose pattern silently stopped matching would read as "no
    // fixture uses this shape" rather than as a broken regex, and the fence
    // below would then be guarding nothing.
    const starved = EXEMPT_SHAPES.map((p) => ({
      what: p.what,
      floor: p.floor,
      matched: fixtures.filter((f) => p.re.test(f.sources)).length,
    })).filter((c) => c.matched < c.floor);
    expect(starved.map((c) => `${c.what}: matched ${c.matched}, floor ${c.floor}`)).toEqual([]);
  });

  it('every exemption matches its own sample and not an ordinary stack', () => {
    expect(EXEMPT_SHAPES.filter((p) => !p.re.test(p.sample)).map((p) => p.what)).toEqual([]);
    const benign = `new s3.Bucket(this, 'B', { versioned: true });`;
    expect(EXEMPT_SHAPES.filter((p) => p.re.test(benign)).map((p) => p.what)).toEqual([]);
  });

  /**
   * The bodies of `async create(...)` / `async update(...)`, by brace matching.
   *
   * Scoped to those two methods rather than the whole file: they are the only
   * ones that can hand a freshly minted value back to the engine.
   */
  function methodBody(src: string, name: string): string {
    const m = new RegExp(`async ${name}\\(`).exec(src);
    expect(m, `${name}() not found in the provider — this fence reads a shape that has changed`).not.toBeNull();
    let i = src.indexOf('{', m!.index);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(i, j + 1);
      }
    }
    throw new Error(`unbalanced braces in ${name}()`);
  }

  /** Every `return { ... }` object literal in a method body, brace-matched. */
  function returnedObjects(body: string): string[] {
    const out: string[] = [];
    const re = /return\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const open = body.indexOf('{', m.index);
      let depth = 0;
      for (let j = open; j < body.length; j++) {
        if (body[j] === '{') depth += 1;
        else if (body[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            out.push(body.slice(open, j + 1));
            break;
          }
        }
      }
    }
    return out;
  }

  /** Top-level keys of a brace-matched object literal. */
  function topLevelKeys(obj: string): string[] {
    const inner = obj.slice(1, -1);
    const keys: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of inner) {
      if ('{[('.includes(ch)) depth += 1;
      if ('}])'.includes(ch)) depth -= 1;
      if (ch === ',' && depth === 0) {
        keys.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    keys.push(cur);
    return keys
      .map((k) => k.split(':')[0]!.trim())
      .map((k) => k.replace(/^\.\.\./, '...'))
      .filter((k) => k !== '');
  }

  it('the generateSecretString exemption premises still hold in the provider', () => {
    // A FENCE ON THE PREMISE, not on the conclusion. Each assertion below is
    // one of the reasons the four fixtures were cleared; if any stops being
    // true, the generated value can reach state and those fixtures need to
    // sweep after all. Failing here means: re-open issue #2212, do not relax
    // this test.
    //
    // These assert the RETURN SHAPE, not an assignment spelling. The earlier
    // cut watched for `properties['SecretString'] =` and was measured GREEN
    // against `effectiveProperties: { ...properties, SecretString: secretString }`
    // added to create's return -- a different spelling of the same write, using
    // a field seven other providers already populate, which the engine records
    // VERBATIM in place of the desired bag. A fence on one spelling of a write
    // is not a fence on the write.
    const src = readFileSync(PROVIDER_SRC, 'utf8');
    // Comment-stripped, so the two JSDoc mentions of GetSecretValue (both
    // saying it is never called) do not have to be spelled around.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

    // 1. The value is never read back. GetSecretValue is the ONLY API that
    //    returns it, so the provider must not REACH it -- by any construction.
    //    `/new\s+GetSecretValueCommand/` pinned ONE spelling and missed the
    //    aggregated-client call `sm.getSecretValue({...})` and the
    //    parenthesised `new (GetSecretValueCommand)(...)`. With comments gone,
    //    a bare mention is strictly stronger and costs nothing.
    expect(
      /GetSecretValue/i.test(code),
      'the secret provider now reaches GetSecretValue — the value can reach state; re-open #2212'
    ).toBe(false);

    // 2. WHAT create()/update() RETURN is limited to fields that cannot carry a
    //    secret. Anything else -- `effectiveProperties`, `properties`, a new
    //    field invented later -- is persisted by the engine and must fail here
    //    rather than be enumerated as a denylist.
    const ALLOWED_RETURN_KEYS = new Set(['physicalId', 'attributes', 'wasReplaced']);
    for (const method of ['create', 'update']) {
      const body = methodBody(src, method);
      const objs = returnedObjects(body);
      expect(objs.length, `${method}() returns no object literal — shape changed`).toBeGreaterThanOrEqual(1);
      for (const obj of objs) {
        for (const key of topLevelKeys(obj)) {
          expect(
            ALLOWED_RETURN_KEYS.has(key),
            `${method}() now returns \`${key}\`, which the engine persists. If it can carry the ` +
              `generated secret, the #2212 exemption is void — re-open it rather than widening this set.`
          ).toBe(true);
        }
      }
      // 3. ...and the `attributes` it returns carries only `Id`. FLOORED ON
      //    NON-EMPTY blocks and required per-method: the old floor of ">= 2
      //    attributes blocks" was satisfied by the two EMPTY `attributes: {}`
      //    in resolvePhysicalId, which cannot carry a value at all, so
      //    `attributes: attrs` with a hoisted object was green.
      const nonEmpty = objs
        .map((o) => /attributes:\s*(\{[\s\S]*?\}|[A-Za-z_][A-Za-z0-9_]*)/.exec(o))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[1]!);
      expect(
        nonEmpty.length,
        `${method}() returns no attributes — this fence reads a shape that has changed`
      ).toBeGreaterThanOrEqual(1);
      for (const attrs of nonEmpty) {
        expect(
          attrs.startsWith('{'),
          `${method}() returns attributes via the identifier \`${attrs}\`, so this fence cannot see what ` +
            `is in it. Inline the object literal, or extend the fence to follow the binding.`
        ).toBe(true);
        expect(topLevelKeys(attrs), `${method}() returns attributes beyond Id: ${attrs}`).toEqual(['Id']);
        // ...and `Id` must be BOUND TO THE PHYSICAL ID, not merely named `Id`.
        // Pinning the key name alone let `attributes: { Id: generated }` --
        // where `const generated = secretString` -- pass all five premises: the
        // shape was right and the value was the minted secret. An allow-list of
        // value expressions is the property; the key name is only its label.
        const idValue = /Id:\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*,?\s*$/m.exec(attrs)?.[1];
        expect(
          idValue !== undefined && ['secretArn', 'physicalId'].includes(idValue),
          `${method}() binds attributes.Id to \`${idValue ?? attrs}\`, which is not the physical id. ` +
            `If that expression can carry the generated secret, the #2212 exemption is void.`
        ).toBe(true);
      }
    }

    // 4. The drift comparator is still told to skip both keys, which is the
    //    codified statement that neither is readable from AWS.
    expect(code).toMatch(/getDriftUnknownPaths\(\)[\s\S]{0,200}return \['SecretString', 'GenerateSecretString'\]/);

    // 5. The generated value reaches the API call and nothing else: the
    //    `secretString` local must never appear inside a returned object.
    expect(code).toMatch(/secretString = this\.generateSecretString\(generateConfig\)/);
    for (const method of ['create', 'update']) {
      for (const obj of returnedObjects(methodBody(src, method))) {
        expect(
          /\bsecretString\b/.test(obj),
          `${method}() now returns the minted value: ${obj.slice(0, 120)}`
        ).toBe(false);
      }
    }
  });

  /**
   * Extracted so a SYNTHETIC fixture can be fed to it. As an inline closure
   * over the real tree, the violation-building branch was never executed by any
   * test -- the message could have referenced an undefined variable and nothing
   * would have said so.
   */
  function exemptionRevoked(fs: Fixture[]): string[] {
    return fs
      .filter((f) => EXEMPT_SHAPES.some((p) => p.re.test(f.sources)))
      .flatMap((f) => {
        const consumed = VALUE_CONSUMED_INTO_TEMPLATE.filter((p) => p.re.test(f.sources)).map((p) => p.what);
        if (consumed.length === 0) return [];
        if (
          f.verify !== undefined &&
          SOURCES_HELPER.test(codeOf(f.verify)) &&
          CALLS_ASSERTION.test(codeOf(f.verify))
        ) {
          return [];
        }
        return [
          `${f.name}: generates a secret AND consumes its VALUE into a template property ` +
            `(${consumed.join('; ')}), so the generateSecretString exemption does not apply — it must source ` +
            `${HELPER} and call s3_assert_versions_swept`,
        ];
      });
  }

  it('no exempt fixture ALSO consumes the secret value into a template property', () => {
    // This is the condition under which the exemption stops applying. A fixture
    // that generates a secret AND resolves its value into a template property
    // puts that plaintext on the deploy path, where only the GHSA redaction
    // keeps it out of state -- so it must sweep rather than be exempt.
    expect(exemptionRevoked(fixtures).sort()).toEqual([]);
  });

  it('the revocation branch actually BUILDS its message (it is otherwise dead code)', () => {
    const synthetic: Fixture = {
      name: 'synthetic-generates-and-consumes',
      sources: `
        const secret = new secretsmanager.Secret(this, 'S', {
          generateSecretString: { generateStringKey: 'password' },
        });
        new ssm.CfnParameter(this, 'P', { value: secret.secretValue.toString() });
      `,
      verify: '#!/usr/bin/env bash\necho hi\n',
    };
    const v = exemptionRevoked([synthetic]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('synthetic-generates-and-consumes');
    expect(v[0]).toContain('the generateSecretString exemption does not apply');
    expect(v[0]).toContain('.secretValue');
    // ...and it is CLEARED by sweeping, which is the remedy the message names.
    expect(
      exemptionRevoked([
        {
          ...synthetic,
          verify: '. ../s3-versions.sh\ns3_assert_versions_swept "$B" "$P" "x"\n',
        },
      ])
    ).toEqual([]);
  });

  it('the exemption is CONDITIONAL, not blanket (positive control)', () => {
    // Deriving the check from the real tree alone would leave it untested,
    // because no fixture combines the two shapes today. Feed it the case it
    // exists to reject, in the spelling a person would write.
    const combined = `
      const secret = new secretsmanager.Secret(this, 'S', {
        generateSecretString: { generateStringKey: 'password' },
      });
      new lambda.Function(this, 'F', {
        environment: { PW: secret.secretValueFromJson('password').toString() },
      });
    `;
    expect(EXEMPT_SHAPES.some((p) => p.re.test(combined))).toBe(true);
    expect(VALUE_CONSUMED_INTO_TEMPLATE.filter((p) => p.re.test(combined)).map((p) => p.what)).toEqual([
      'secretValueFromJson(...) — resolves one JSON key of a secret into a template property',
    ]);
    // ...and the four real exempt fixtures consume the ARN only, which is why
    // they are clear. Named individually: a count would still pass if one
    // dropped out while another appeared.
    for (const name of ['composite-stack', 'event-driven', 'full-stack-demo', 'secrets-rotation-schedule']) {
      const f = fixtures.find((x) => x.name === name);
      expect(f, `${name} vanished from the fixture tree`).toBeDefined();
      expect(EXEMPT_SHAPES.some((p) => p.re.test(f!.sources)), `${name} no longer generates a secret`).toBe(true);
      expect(
        VALUE_CONSUMED_INTO_TEMPLATE.filter((p) => p.re.test(f!.sources)).map((p) => p.what),
        `${name} started consuming the secret VALUE — it now needs a sweep`
      ).toEqual([]);
      expect(f!.sources, `${name} should reference the secret by ARN`).toMatch(/secretArn/);
    }
  });

  it('the value-consuming patterns still match the fixtures they were measured against', () => {
    // A floor on the patterns that decide the exemption's edge. Without it, a
    // regex that stopped matching would make every fixture look exempt.
    const starved = VALUE_CONSUMED_INTO_TEMPLATE.map((p) => ({
      what: p.what,
      floor: p.floor,
      matched: fixtures.filter((f) => p.re.test(f.sources)).length,
    })).filter((c) => c.matched < c.floor);
    expect(starved.map((c) => `${c.what}: matched ${c.matched}, floor ${c.floor}`)).toEqual([]);
    expect(VALUE_CONSUMED_INTO_TEMPLATE.filter((p) => !p.re.test(p.sample)).map((p) => p.what)).toEqual([]);
  });
});

describe('a fixture that resolves a secret DYNAMIC REFERENCE must sweep too', () => {
  const fixtures = readFixtures();
  const consuming = fixtures.filter((f) => VALUE_CONSUMED_INTO_TEMPLATE.some((p) => p.re.test(f.sources)));

  /**
   * WHY THIS IS A VIOLATION AND NOT A NOTE.
   *
   * `{{resolve:secretsmanager:...}}` / `{{resolve:ssm:...}}` against a
   * SecureString is the shape that genuinely puts plaintext on the deploy path:
   * `intrinsic-function-resolver.ts` issues the real `GetSecretValue`. On
   * today's code the plaintext does NOT reach state -- the GHSA-p5qg-v9gv-hc7w
   * fix rewrites each resolved value back to its `{{resolve:...}}` expression
   * before persisting, and `deploy-engine.ts` applies the same
   * `redactSecretsForState` to the rollback journal's `attemptedProperties`.
   *
   * That is a reason to sweep, not a reason to skip. The redaction is a
   * src-side invariant one bug away from failing, and S3 object versions are
   * FOREVER: a run under a broken redaction leaves plaintext that no later fix
   * removes. Five of the six fixtures in this class already sweep for exactly
   * that reason; the sixth being outside the convention is the divergence
   * rather than the exception, which is the state this lint exists to prevent.
   */
  it('finds the dynamic-reference population', () => {
    // A FLOOR naming PERIPHERAL members, not just the one that prompted the
    // rule: a population that shrank to a single fixture would let the rule
    // pass while covering nothing.
    expect(consuming.length).toBeGreaterThanOrEqual(6);
    const names = consuming.map((f) => f.name).sort();
    for (const required of [
      'cross-stack-secret-import',
      'dynamic-ref-cross-region',
      'nested-stack-secret',
      'rollback-cross-region-secret',
      'secrets-array-nested',
      'secrets-dynamic-ref',
    ]) {
      expect(names, `${required} stopped resolving a secret dynamic reference`).toContain(required);
    }
  });

  it('every one of them sources the sweep helper and calls the assertion', () => {
    const violations = consuming.flatMap((f) => {
      const shapes = VALUE_CONSUMED_INTO_TEMPLATE.filter((p) => p.re.test(f.sources))
        .map((p) => p.what)
        .join('; ');
      if (f.verify === undefined) {
        return [
          `${f.name}: resolves a secret dynamic reference (${shapes}) but has NO verify.sh, so nothing ` +
            `can sweep its state versions`,
        ];
      }
      const code = codeOf(f.verify);
      if (!SOURCES_HELPER.test(code)) {
        return [
          `${f.name}/verify.sh: resolves a secret dynamic reference (${shapes}) but never sources ${HELPER}. ` +
            `cdkd issues a real GetSecretValue for that reference, and only the GHSA redaction keeps the ` +
            `plaintext out of state — a versioned bucket keeps whatever a broken redaction wrote, forever. ` +
            `Its five siblings sweep for this reason`,
        ];
      }
      if (!CALLS_ASSERTION.test(code)) {
        return [
          `${f.name}/verify.sh: sources ${HELPER} but never calls s3_assert_versions_swept — an unverified ` +
            `sweep is indistinguishable from no sweep`,
        ];
      }
      return [];
    });
    expect(violations.sort()).toEqual([]);
  });

  it('the rule reads CODE and rejects the near-misses (shape probes)', () => {
    // Written in the spellings a person would actually use, not the one
    // easiest to inject. Each must be RECOGNISED as consuming a value.
    for (const spelling of [
      `const pw = secret.secretValueFromJson('password').toString();`,
      `const pw = secret.secretValueFromJson('password').unsafeUnwrap();`,
      `value: cdk.SecretValue.secretsManager('my-secret').toString(),`,
      `value: cdk.SecretValue.secretsManager('my-secret', { jsonField: 'pw' }).unsafeUnwrap(),`,
      `const pw = secret.secretValue.unsafeUnwrap();`,
      `stringValue: '{{resolve:secretsmanager:arn:SecretString:password}}',`,
      `stringValue: \`{{resolve:ssm:\${PARAM}}}\`,`,
    ]) {
      expect(
        VALUE_CONSUMED_INTO_TEMPLATE.some((p) => p.re.test(spelling)),
        `not recognised as consuming a secret value: ${spelling}`
      ).toBe(true);
    }
    // ...and an ARN-only reference is NOT one of them, which is the whole
    // basis of the generateSecretString exemption above. If this started
    // matching, all four exempt fixtures would flip to violations.
    for (const benign of [
      `new cdk.CfnOutput(this, 'SecretArn', { value: secret.secretArn });`,
      `fn.addEnvironment('SECRET_ARN', secret.secretArn);`,
      `secret.grantRead(fn);`,
      `const name = secret.secretName;`,
    ]) {
      expect(
        VALUE_CONSUMED_INTO_TEMPLATE.filter((p) => p.re.test(benign)).map((p) => p.what),
        `ARN-only usage must not count as consuming a value: ${benign}`
      ).toEqual([]);
    }
  });
});
