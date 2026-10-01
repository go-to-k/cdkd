# secrets-dynamic-ref

Failure-seeking integration test for CloudFormation **dynamic references** in
resource properties:

- `{{resolve:secretsmanager:...}}`
- `{{resolve:ssm:...}}`

cdkd resolves these itself in `resolveDynamicReferences`
([src/deployment/intrinsic-function-resolver.ts](../../../src/deployment/intrinsic-function-resolver.ts))
BEFORE the property is handed to the provider — CloudFormation never sees the
literal `{{resolve:...}}` token. This test surfaces bugs where a dynamic
reference resolves to the **wrong value** or **stays literal** in the deployed
resource.

## Stack

`CdkdSecretsDynamicRefExample` (cheap, no VPC):

- A SecretsManager secret with a **known JSON value**
  (`{"username":"cdkd-user","password":"cdkd-known-pw-123","pin":"q7"}` — `pin` is the
  two-character secret of issue [#2516](https://github.com/go-to-k/cdkd/issues/2516)).
- An SSM `String` parameter with a **known value** (`cdkd-known-ssm-value`).
- A consumer `AWS::Lambda::Function` (inline code, asset-free) whose
  **environment variables** are literal `{{resolve:...}}` dynamic-reference
  strings. The handler is never invoked; `verify.sh` reads
  `GetFunctionConfiguration` and asserts each env var carries the resolved
  value.

The env-var values are authored as literal `{{resolve:...}}` strings (CDK
emits them as `Fn::Join` arrays interpolating `AWS::AccountId`), NOT via CDK's
`secretValueFromJson` token — so the test pins the exact dynamic-reference
grammar regardless of the CDK version's token shape.

## Dynamic-reference forms exercised

| Form | Example | cdkd support |
| --- | --- | --- |
| secretsmanager JSON-key | `{{resolve:secretsmanager:NAME:SecretString:password}}` | SUPPORTED |
| secretsmanager whole-secret | `{{resolve:secretsmanager:NAME:SecretString}}` | SUPPORTED |
| secretsmanager version-stage | `{{resolve:secretsmanager:NAME:SecretString:password:AWSCURRENT}}` | SUPPORTED |
| ssm plaintext param | `{{resolve:ssm:NAME}}` | SUPPORTED |
| ssm-secure SecureString | `{{resolve:ssm-secure:NAME}}` | SUPPORTED since issue #2482 — covered by `tests/integration/ssm-secure-dynamic-ref` (see below) |

`ssm-secure` is exercised by its **own** fixture, `ssm-secure-dynamic-ref`:
the SecureString parameter has to be seeded out of band (CloudFormation cannot
create one), and that fixture asserts the whole, embedded and versioned forms
against a destination that reads back. Before issue #2482 the spelling hit the
resolver's unsupported-service `else` branch (warn + leave literal) and was
skipped here. A secret **version-ID** form
(`...:SecretString:key::<uuid>`) is also not exercised because the version id
is not knowable ahead of deploy; the version-**stage** slot (`AWSCURRENT`)
covers the optional-trailing-field grammar.

## What verify.sh asserts

1. Deploy the stack with the local cdkd binary.
   - Phase 1b (issue [#2728](https://github.com/go-to-k/cdkd/issues/2728)):
     one more deploy under `CDKD_TEST_OUTPUT_LEAK=true`, which declares an
     `OutputFailureLeak` output whose `Fn::Sub` variable resolves the secret's
     `password` and whose body uses that value as the JSON key of a second
     reference, which is refused before its lookup (issue
     [#4266](https://github.com/go-to-k/cdkd/issues/4266)). Guard 1b pins the
     synthesized shape (premise), that the deploy warned
     `Failed to resolve output OutputFailureLeak: Refusing to resolve
     {{resolve:secretsmanager:<name>:SecretString:***}}: ...` (the sentinel
     that the arm ran), that the warn carries `***` and not the password, that
     the whole `--verbose` log is password-free, and that the log has the `Pw`
     lookup's `Resolving dynamic reference:` echo but none for the assembled
     reference. The output is gated so the
     unchanged-stack `diff --fail` guard later never sees it.
   - Phases 1b3 / 1b4 (issue [#2743](https://github.com/go-to-k/cdkd/issues/2743)):
     two more probe deploys under `CDKD_TEST_SERVICE_SPAN`, whose `Fn::Sub`
     body `{{resolve:${Pw}}}` puts the resolved password in a reference's
     SERVICE position. `output` declares it as an output: the deploy exits 0,
     warns `Failed to resolve output ServiceSpanLeak: Refusing to resolve
     {{resolve:***}}`, and neither the log (its `Outputs:` summary included)
     nor `state.json` carries the password or a `ServiceSpanLeak` key.
     `resource` declares it as an `AWS::IAM::Role` `Description`. The phase
     first proves, with a throwaway role, that IAM accepts and returns a
     `{{resolve:...}}` Description, so an absent role means cdkd refused: the deploy
     exits non-zero with the same refusal, and the role does NOT exist on AWS
     afterwards (probed gone before and after) and has no state record; the
     rollback journal (when present) and every `deployments/` object are
     scanned for the password too. State is checked by the SET OF PATHS
     holding the password, because the fixture's own Secret keeps it in
     `properties.SecretString` by design.
   - Phase 1b3b (issue [#4166](https://github.com/go-to-k/cdkd/issues/4166)):
     a probe deploy under `CDKD_TEST_SECRET_NAMED_REF=output`, whose `Fn::Sub`
     body `{{resolve:ssm:<prefix>${Pw}}}` puts the resolved password in the
     NAME of an `ssm` reference. The script creates a SecureString under that
     name out of band first, so the lookup succeeds. The deploy exits 0, warns
     `Failed to resolve output SecretNamedRef: Refusing to resolve
     {{resolve:ssm:<prefix>***}}: the reference was assembled from a secret
     value and resolves to a secret`. The log carries no password,
     `state.json` holds it only where the Secret keeps it, and state has no
     `SecretNamedRef` output key. The same probe declares `SecretNamedSecureRef`,
     the same name through `ssm-secure` (issue
     [#4266](https://github.com/go-to-k/cdkd/issues/4266)): it is refused with
     the same masked warning, and its `--verbose` log has no `ssm-secure` lookup
     line, while the `ssm` arm's lookup line is there as the sentinel. The
     password-named parameter is deleted and proven gone at teardown.
   - Phase 1b5 (issue [#2743](https://github.com/go-to-k/cdkd/issues/2743)):
     seeds `outputs.ServiceSpanLegacy = {{resolve:<password>}}` into
     `state.json` (what a release before the refusal persisted), runs a real
     `cdkd scrub`, and asserts the password is gone and the key now reads
     `{{resolve:{{resolve:secretsmanager:...}}}}`. The key is dropped again
     afterwards.
   - Phase 1b6 (issue [#2889](https://github.com/go-to-k/cdkd/issues/2889)):
     `CDKD_TEST_MARK_SPLIT_EXPORT=true` declares an output whose `Export.Name`
     (an `Fn::Sub` over literals; CDK refuses a literal non-ASCII name) resolves
     to the password with a zero-width nonspacing mark
     (`U+09BC`) inside it. Asserts the deploy refuses the alias with a warn
     that prints neither the name nor the password, and that neither
     `state.outputs` nor the exports index carries the name as a key. The
     output is dropped from state afterwards.
   - Phase 1b7 (issue [#4001](https://github.com/go-to-k/cdkd/issues/4001)):
     `CDKD_TEST_FULLWIDTH_EXPORT=true`, the same probe with the password's
     tail spelled in full-width characters (`U+FF0D U+FF11 U+FF12 U+FF13`),
     which fold to ASCII under NFKC. Same assertions as Phase 1b6.
2. Read the consumer Lambda's env vars via `GetFunctionConfiguration`.
3. For each env var: it is **not** still a literal `{{resolve:...}}` token, AND
   it equals the known expected value. A wrong-or-literal value FAILS with
   specifics.
4. Destroy, then assert the Lambda, secret, SSM parameter, and state file are
   all gone.

Phases 1d-1g additionally pin the STATE-REDACTION contract, which is where the
GHSA-p5qg-v9gv-hc7w follow-ups land. What decides each answer is the POSITION
SOURCE — the record's own `properties` leaf the readback is aligned against —
so the table is indexed by what that leaf holds, not by which command ran:

| leaf | what `properties` holds | what state ends up with |
| --- | --- | --- |
| `SSM_SECURE_VALUE` (SecureString, whole token) | the expression | expression |
| `SSM_VALUE` (public `String`, whole token) | the resolved value | resolved |
| `DB_URL` (SecureString inside text) | the expression | expression |
| `DB_PORT_LITERAL` (a TWO-character secret inside literal text, issue [#2516](https://github.com/go-to-k/cdkd/issues/2516)) | the expression — written only on a bag the engine marked as this pass's own, since the value scan makes no claim below its four-character needle floor | expression, in `properties`, in the readback AND in the `PortLiteral` output |
| `PUBLIC_URL` (public `String` inside text) | the resolved value (issue [#1901](https://github.com/go-to-k/cdkd/issues/1901)) | resolved — the mixed-leaf arm is never consulted |
| `PUBLIC_URL`, with the expression STAMPED into `properties` (Phase 1f3) | the expression | expression (the OPEN over-redaction, issue [#2036](https://github.com/go-to-k/cdkd/issues/2036)) |

The last two rows are the same leaf, and the pair is the correction this fixture
had to make: a public ssm `String` is persisted RESOLVED by construction, so on
every path reachable from a template-declared leaf the source carries no
reference at all and there is nothing to refuse. An earlier revision asserted
the residual on Phase 1f and on Phase 1g's CONTROL 3, and neither could hold —
the first failed on fixed code AND on `main`, the second passed identically on
`main` (zero discrimination). Reaching the residual needs a source that CARRIES
the expression, which in the wild only `cdkd import`'s warn path produces, so
**Phase 1f3** stamps that shape deliberately and asserts it there.

**Which arm of Phase 1f3 actually discriminates**, stated because the arms it
replaced did not: the residual assertion is a PIN — `main` refuses that leaf too,
and so does this branch, since issue
[#2036](https://github.com/go-to-k/cdkd/issues/2036) is still OPEN. What earns
the phase its runtime is the BLAST-RADIUS assertion beside it: on `main`
`SSM_VALUE` stays `cdkd-known-ssm-value`, and only a tree that derives needles
rewrites it onto its own parameter's expression.

`#2036` is NOT closed here. A store of PROVEN-public verdicts would admit the
resolved value at that leaf, and PR #2415 drafted one and withdrew it: keyed on
the bare expression and living for the whole process, it un-redacts a same-named
`SecureString` in another region on a `cdkd deploy --all`. A revival has to key
the verdict by SCOPE (region + account) at the read side; the end-to-end arm for
it is tracked as issue
[#2425](https://github.com/go-to-k/cdkd/issues/2425).

Phase 1f2 covers issue [#2012](https://github.com/go-to-k/cdkd/issues/2012)'s
last residual row: it deletes `SSM_SECURE_COPY` from the record's persisted
`properties` (leaving AWS still reporting it), stamps the decrypted value into
the observed bag, and refreshes. The key now has no position source at all, so
only a needle DERIVED from the certified sibling can redact it; the phase
restores `properties` afterwards so the later phases start where Phase 1f left
them. Phase 1f3 keeps its own record for the same reason in reverse: once
`PUBLIC_URL`'s source carries a reference, the needle learned from it also
rewrites `SSM_VALUE` (the same parameter, same resolved value), which would
destroy Phase 1f2's "not dragged along" control.

**Security:** secret-derived values are never printed; assertions mask them
(`xx***(len=N)`). Only PASS/FAIL plus a masked snippet appears in the log.

## Run

```bash
vp run build              # from repo root — verify.sh runs node dist/cli.js
/run-integ secrets-dynamic-ref
```

`verify.sh` requires `STATE_BUCKET` (e.g. `cdkd-state-{accountId}`) and honors
`AWS_REGION` (defaults to `us-east-1`).
