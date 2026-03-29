# Cognito Example

UserPool deployment example for cdkd with email sign-in and password policy.

## Resources Created

- **UserPool** - Cognito User Pool with email sign-in, auto-verification, and custom password policy

## Demonstrates

- Cognito SDK Provider
- UserPool creation with sign-in aliases (email)
- Password policy configuration (min length, character requirements)
- Account recovery settings (email only)
- `Fn::GetAtt` for outputs (UserPoolId, UserPoolArn)

## Deploy

```bash
cdkd deploy CognitoStack
```

## Destroy

```bash
cdkd destroy CognitoStack
```
