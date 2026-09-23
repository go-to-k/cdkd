# Cognito Example

UserPool deployment example for cdkd with email sign-in and password policy.

## Resources Created

- **UserPool** - Cognito User Pool with email sign-in, auto-verification, and custom password policy
- **BackfillUserPool** - L1 `CfnUserPool` exercising the issue #609 backfill properties (`UserPoolTier` / `EnabledMfas` / `WebAuthn*`) with an explicit `MfaConfiguration: ON` (ON, not OPTIONAL, so the assertion can tell a threaded explicit value from a fired default)
- **PasskeyOnlyUserPool** - L1 `CfnUserPool` with WebAuthn and NO `MfaConfiguration` (issue #1920) -> must land as `OFF`; the absence is the input under test, so do not add one
- **FactorDefaultUserPool** - L1 `CfnUserPool` with an MFA factor and NO `MfaConfiguration` (issue #1920) -> must land as `OPTIONAL`; the inverse regression sends the declared factor under `MfaConfiguration: OFF`, which AWS REJECTS outright (measured 2026-08-19, issue #1968), so it surfaces as a FAILED deploy rather than as a silently MFA-disabled pool

### `CognitoPreflightStack` (issues #1975 / #1977 / #2064 / #2051 / #3562)

A second stack, deployed and destroyed by the same `verify.sh`. It proves the MFA **pre-flight refusal** fires BEFORE the first AWS call on the UPDATE path — the path where sending the request leaves a partial apply behind (`UpdateUserPool` lands, `SetUserPoolMfaConfig` is rejected, nothing unwinds). It is a separate stack because its update deploys must FAIL, while `CognitoStack`'s update deploy must succeed.

- **PreflightOffPool** — arm A (#1977). Base: `MfaConfiguration: OPTIONAL` + `EnabledMfas: [SOFTWARE_TOKEN_MFA]`. Under `CDKD_TEST_PREFLIGHT_ARM=A` the update pins `MfaConfiguration: OFF` beside the still-declared factor **and** adds `AutoVerifiedAttributes: [email]` as a CANARY. The load-bearing assertion is that the canary is still absent afterwards — that is what proves `UpdateUserPool` never went out
- **PreflightSignInPool** — arm B (#1975). Base: `MfaConfiguration: ON` + `AllowedFirstAuthFactors: [PASSWORD]`. Under `CDKD_TEST_PREFLIGHT_ARM=B` the update adds `EMAIL_OTP`. Here the canary IS the payload: the pool must still report `[PASSWORD]`. Its BASE arm doubles as negative control **C1** — the shape where the #1975 rule evaluates (`ON` + a `SignInPolicy`) and must not fire
- **PreflightOptionalEmailOtpPool** — negative control **C2**. A deny-listed member (`EMAIL_OTP`) beside `MfaConfiguration: OPTIONAL`, which AWS ACCEPTS. Fences the rule's `=== 'ON'` narrowing: widening it to `!== 'OFF'` fails this pool's create
- **PreflightWebAuthnPool** — negative control **C3**. `WEB_AUTHN` in the sign-in policy alongside a real MFA factor, at `MfaConfiguration: OPTIONAL` with the default `SINGLE_FACTOR`, which AWS accepts. Fences rule 3's `=== 'ON'` narrowing (#2064)
- **PreflightWebAuthnOnPool** — negative control **C4** (#2064). `WEB_AUTHN` + `MfaConfiguration: ON` + `WebAuthnFactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION`, the one shape AWS accepts there. Must deploy cleanly, on the SDK route (`provisionedBy` `sdk`)
- **PreflightWebAuthnSinglePool** — arms **D** and **F** (#2064). Base: `OPTIONAL` + `[PASSWORD]`. Under `CDKD_TEST_PREFLIGHT_ARM=D` the update adds `WEB_AUTHN` and sets `ON` without `WebAuthnFactorConfiguration`: it must be refused, and the pool must still report `[PASSWORD]` / `OPTIONAL` (pre-fix `UpdateUserPool` landed the sign-in policy, then `SetUserPoolMfaConfig(ON)` was rejected). Under `=F` the same edit plus `MULTI_FACTOR_WITH_USER_VERIFICATION` must SUCCEED
- **Arm G** (#3562), on PreflightSignInPool after arm B: add `WEB_AUTHN` + `WebAuthnFactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION` to a pool already at `ON`. Must SUCCEED — it deploys only because `SetUserPoolMfaConfig` now goes before `UpdateUserPool`
- **Arm H** (#3562 parity), on PreflightWebAuthnOnPool: lower `MfaConfiguration` to `OPTIONAL` while adding `EMAIL_OTP`. Must still FAIL on AWS's own `UpdateUserPool` rejection with the pool untouched — CloudFormation rolls the same edit back
- **PreflightLivePolicyPool** — arm **E** (#2051). Base: `OPTIONAL` + `[PASSWORD, EMAIL_OTP]`. Under `CDKD_TEST_PREFLIGHT_ARM=E` the update DELETES `Policies`, sets `ON`, and adds an `AutoVerifiedAttributes` canary. The live list survives the omission, so only the provider's live read can see the conflict; the canary must still be absent afterwards

## Demonstrates

- Cognito SDK Provider
- UserPool creation with sign-in aliases (email)
- Password policy configuration (min length, character requirements)
- Account recovery settings (email only)
- `Fn::GetAtt` for outputs (UserPoolId, UserPoolArn)
- Post-create `SetUserPoolMfaConfig` wiring, including both arms of the `MfaConfiguration` default: `OPTIONAL` when the call enables an MFA factor, `OFF` (CloudFormation's default) when it enables none

## Deploy

```bash
cdkd deploy CognitoStack
```

## Destroy

```bash
cdkd destroy CognitoStack
```
