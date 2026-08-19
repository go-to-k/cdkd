# Cognito Example

UserPool deployment example for cdkd with email sign-in and password policy.

## Resources Created

- **UserPool** - Cognito User Pool with email sign-in, auto-verification, and custom password policy
- **BackfillUserPool** - L1 `CfnUserPool` exercising the issue #609 backfill properties (`UserPoolTier` / `EnabledMfas` / `WebAuthn*`) with an explicit `MfaConfiguration: ON` (ON, not OPTIONAL, so the assertion can tell a threaded explicit value from a fired default)
- **PasskeyOnlyUserPool** - L1 `CfnUserPool` with WebAuthn and NO `MfaConfiguration` (issue #1920) -> must land as `OFF`; the absence is the input under test, so do not add one
- **FactorDefaultUserPool** - L1 `CfnUserPool` with an MFA factor and NO `MfaConfiguration` (issue #1920) -> must land as `OPTIONAL`; the inverse regression sends the declared factor under `MfaConfiguration: OFF`, which AWS REJECTS outright (measured 2026-08-19, issue #1968), so it surfaces as a FAILED deploy rather than as a silently MFA-disabled pool

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
