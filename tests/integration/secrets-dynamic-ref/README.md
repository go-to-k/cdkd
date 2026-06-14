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

**Security:** secret-derived values are never printed; assertions mask them
(`xx***(len=N)`). Only PASS/FAIL plus a masked snippet appears in the log.

## Run

```bash
vp run build              # from repo root — verify.sh runs node dist/cli.js
/run-integ secrets-dynamic-ref
```

`verify.sh` requires `STATE_BUCKET` (e.g. `cdkd-state-{accountId}`) and honors
`AWS_REGION` (defaults to `us-east-1`).
