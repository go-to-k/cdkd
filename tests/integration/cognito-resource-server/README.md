# cognito-resource-server

Regression integ for the Cloud-Control **compound-id `Ref`** bug class on the
Cognito UserPool-child family (found by a `/hunt-bugs` sweep, 2026-06-28).

`AWS::Cognito::UserPoolResourceServer`, `::UserPoolGroup`,
`::UserPoolIdentityProvider`, and `::UserPoolDomain` have no SDK provider, so
they route through Cloud Control. cdkd stores their physical id as the CC
compound `<userPoolId>|<child>`, but CloudFormation's `Ref` returns only the
trailing `<child>` segment. Until these types were added to
`REF_RETURNS_SEGMENT_AFTER_PIPE` in `src/deployment/intrinsic-function-resolver.ts`,
cdkd handed the whole compound id back to AWS.

The fixture wires a `UserPoolClient` whose `AllowedOAuthScopes` references the
resource server via `{Fn::Join: ["", [{Ref: ResourceServer}, "/read"]]}` — the
exact shape CDK synthesizes for `OAuthScope.resourceServer(...)`. With the bug,
the scope resolves to `<userPoolId>|api/read` and Cognito rejects the client
create with `Invalid scope requested`; with the fix it resolves to `api/read`.

## What it asserts

1. The client's `AllowedOAuthScopes` is exactly `["api/read"]` (the load-bearing
   compound-id-Ref assertion — the deploy itself fails at the client without the fix).
2. The resource server `api` exists.
3. The `...-admins` group exists.
4. Destroy removes the UserPool and the cdkd state file.

## Run

```bash
vp run build   # from repo root
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 bash verify.sh
```
