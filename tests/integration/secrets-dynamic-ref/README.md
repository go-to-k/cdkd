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
  (`{"username":"cdkd-user","password":"cdkd-known-pw-123"}`).
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
| ssm-secure SecureString | `{{resolve:ssm-secure:NAME}}` | **NOT** resolved by cdkd — out of scope (see below) |

`ssm-secure` is intentionally **not** exercised: cdkd's
`resolveDynamicReferences` routes only `secretsmanager` and `ssm`; an
`ssm-secure:` reference hits the `else` branch (warn + leave literal), so it
would deploy a broken value. A secret **version-ID** form
(`...:SecretString:key::<uuid>`) is also not exercised because the version id
is not knowable ahead of deploy; the version-**stage** slot (`AWSCURRENT`)
covers the optional-trailing-field grammar.

## What verify.sh asserts

1. Deploy the stack with the local cdkd binary.
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
