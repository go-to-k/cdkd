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
 *     `.yaml` (today: `migrate-from-bare-cfn-codegen-only/template-fixture.json`,
 *     verified secret-free), which these patterns never read. But being written
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
 *     sibling prefix rather than a descendant. No fixture in the swept set has
 *     one today; tracked with issue #2107.
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
    floor: 6,
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
    floor: 6,
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
        sources: ['bin', 'lib']
          .map((sub) => join(dir, sub))
          .filter((d) => existsSync(d) && statSync(d).isDirectory())
          .flatMap((d) => readTsRecursive(d))
          .join('\n'),
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
