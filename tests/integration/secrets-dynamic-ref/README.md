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
GHSA-p5qg-v9gv-hc7w follow-ups land. The interesting property is that the same
leaf gets different answers on different paths, and the fixture states which:

| leaf | `cdkd state refresh-observed` (Phase 1f) | plain `cdkd deploy` (Phase 1g) |
| --- | --- | --- |
| `SSM_SECURE_VALUE` (SecureString, whole token) | expression | expression |
| `SSM_VALUE` (public `String`, whole token) | resolved | resolved |
| `DB_URL` (SecureString inside text) | expression | expression |
| `PUBLIC_URL` (public `String` inside text) | expression (residual, issue [#2036](https://github.com/go-to-k/cdkd/issues/2036)) | **resolved** |

`PUBLIC_URL` is the only row that differs, and the difference is the point:
the deploy's own comparison pass performs a `GetParameter` and RECORDS the
parameter's public type, while `refresh-observed` resolves nothing and has no
verdict to consult — so it keeps refusing, which over-redacts but discloses
nothing.

Phase 1f2 covers issue [#2012](https://github.com/go-to-k/cdkd/issues/2012)'s
last residual row: it deletes `SSM_SECURE_COPY` from the record's persisted
`properties` (leaving AWS still reporting it), stamps the decrypted value into
the observed bag, and refreshes. The key now has no position source at all, so
only a needle DERIVED from the certified sibling can redact it; the phase
restores `properties` afterwards so the later phases start where Phase 1f left
them.

**Security:** secret-derived values are never printed; assertions mask them
(`xx***(len=N)`). Only PASS/FAIL plus a masked snippet appears in the log.

## Run

```bash
vp run build              # from repo root — verify.sh runs node dist/cli.js
/run-integ secrets-dynamic-ref
```

`verify.sh` requires `STATE_BUCKET` (e.g. `cdkd-state-{accountId}`) and honors
`AWS_REGION` (defaults to `us-east-1`).
