---
title: Authorizers in cdkd local start-api
description: "How cdkd local start-api runs Lambda, Cognito and JWT authorizers, what it does when a JWKS endpoint is unreachable, and what its AWS_IAM signature check returns."
---

# Authorizers in cdkd local start-api

[`cdkd local start-api`](local-start-api.md) runs the authorizer attached to a
route before it invokes the route's Lambda. A Lambda authorizer runs in a
local container like any other function. A Cognito or JWT authorizer is
checked against the real signing keys of the user pool or the issuer. An
`AWS_IAM` route has its SigV4 signature checked.

You need no extra flag. Call the route with the header the authorizer reads:

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/items
```

cdkd supports the four authorizer kinds below, and `AWS_IAM`. Any other
authorizer type stops the server at boot with an error naming the route.

## Lambda TOKEN authorizer (REST v1)

Declared as an `AWS::ApiGateway::Authorizer` with `Type: 'TOKEN'`.

cdkd reads the header named by `IdentitySource`, which is `Authorization` by
default, and passes it to the authorizer Lambda as
`event.authorizationToken`. When the header is missing, the request gets 401
and the authorizer is not invoked. An `IdentityValidationExpression` is
applied as the deployed API applies it: a header value that does not match
the whole pattern gets 401 without invoking the authorizer.

The authorizer must return a `policyDocument` with at least one
`{ Effect: 'Allow', Resource: <methodArn> }` statement. cdkd matches
`Resource` against the request's method ARN, either literally or with `*` and
`?` wildcards.

- **Allowed:** the authorizer's context is passed to the handler under
  `event.requestContext.authorizer`.
- **Denied by the policy:** 403.

## Lambda REQUEST authorizer (REST v1 and HTTP API)

Declared with `Type: 'REQUEST'` on a REST v1 API or
`AuthorizerType: 'REQUEST'` on an HTTP API.

The authorizer Lambda receives the whole request: headers, query string and
path parameters. When it allows the request, its context is passed to the
handler under `event.requestContext.authorizer`.

On an HTTP API the authorizer may return either a `policyDocument` or the
simple format:

```json
{ "isAuthorized": true, "context": { "tenant": "acme" } }
```

The two API kinds differ when the request carries no identity. A REST v1 API
returns 401 without invoking the Lambda. An HTTP API falls through.

## Cognito User Pool authorizer (REST v1)

Declared with `Type: 'COGNITO_USER_POOLS'`.

cdkd reads the token from the `Authorization` header (the `Bearer ` prefix is
optional, as on the deployed API) and verifies its signature against the user
pool's JWKS, the public keys the pool publishes. It checks the token type and
the method's `AuthorizationScopes` as the deployed API does:

| Method | Accepted token |
| --- | --- |
| Without `AuthorizationScopes` | An ID token |
| With `AuthorizationScopes` | An access token whose `scope` claim carries at least one of them |

An `IdentityValidationExpression` must match the token's whole `aud` claim.
An access token has no `aud`, so it never matches.

- **Allowed:** the token's claims are passed to the handler under
  `event.requestContext.authorizer.claims`.
- **Denied:** the status the deployed API returns:

| Token | Response |
| --- | --- |
| Signature does not verify | 403 `{"Message":"Access Denied"}` |
| Expired | 401 `{"message":"The incoming token has expired"}` |
| Missing, malformed, unsigned, another pool's, wrong type, missing scope | 401 `{"message":"Unauthorized"}` |

A `CognitoUserPoolsAuthorizer` names its user pool by reference
(`Fn::GetAtt <Pool>.Arn`), so the template holds no pool id. cdkd reads it
from the deployed stack:

| How you run it | What the authorizer checks |
| --- | --- |
| `--from-state` or `--from-cfn-stack` | The deployed pool's JWKS: an invalid token is denied |
| No state source | Nothing: cdkd warns once per route at startup and accepts every token |

## JWT authorizer (HTTP API)

Declared with `AuthorizerType: 'JWT'`.

cdkd reads the token from the `Authorization` header (the `Bearer ` prefix is
optional) and verifies its signature against the issuer's JWKS. It also checks
the token's `aud` or `client_id` claim against `JwtConfiguration.Audience`.

- **Allowed:** the token's claims are passed to the handler under
  `event.requestContext.authorizer.jwt.claims`.
- **Denied:** 401.
- **A route's `AuthorizationScopes`:** the token's `scope` (or `scp`) claim
  must carry at least one of them, else 403 `{"message":"Forbidden"}`.

An `HttpUserPoolAuthorizer` builds its issuer and audience from the user pool
and app client it names, so the template holds references rather than
values. cdkd reads them from the deployed stack:

| How you run it | What the authorizer checks |
| --- | --- |
| `--from-state` or `--from-cfn-stack` | The deployed pool's issuer and JWKS, and the app client ids as the audience |
| No state source | Nothing: cdkd warns at startup and accepts every token, as when the JWKS is unreachable |

If the issuer resolves but an audience entry does not, cdkd warns and checks
the signature, issuer and expiry without the audience.

`AuthorizationScopes` and an `IdentityValidationExpression` written as
references (CDK's `OAuthScope.resourceServer` emits a `Fn::Join`) resolve from
`--from-state` or `--from-cfn-stack` the same way. The scope and token-type
checks are skipped for a token accepted because the JWKS was unreachable
(below), since nothing about it was verified.

## Settings cdkd does not enforce

cdkd still serves a route that carries one of these settings, but it does
not check it. It warns once per route at startup, naming the route and the
setting, so nothing is dropped silently:

| Setting | When it is not enforced |
| --- | --- |
| `ApiKeyRequired` | Always, on a REST v1 method or a WebSocket route: API keys live in the deployed API |
| `AuthorizationScopes` | On an authorizer other than REST v1 Cognito or HTTP API JWT, or when it stays an unresolved reference |
| `IdentityValidationExpression` | When it stays an unresolved reference, or is not a pattern cdkd can evaluate |
| `Policy` | Always, on a REST v1 `AWS::ApiGateway::RestApi` (resource policy) |

cdkd evaluates `IdentityValidationExpression` as a JavaScript Unicode-mode
pattern. Java syntax with no exact JavaScript equivalent (`\p{Alnum}`, `\A`,
`\z`, an escaped `\_`) is warned and not applied, rather than applied with a
different meaning. Java's ASCII-only `\p{Alpha}` / `\p{Lower}` / `\p{Upper}`
are read as Unicode properties, so locally they also match a non-ASCII
character the deployed API would reject.

## Result caching

cdkd caches an authorizer's verdict, so the authorizer does not run on every
request:

| Authorizer | Cached for |
| --- | --- |
| REST v1 | `AuthorizerResultTtlInSeconds`: default 300s, maximum 3600s |
| HTTP API Lambda | Not cached by default |
| JWT | The token's remaining lifetime, at most 300s |

A cached verdict from a TOKEN authorizer is checked again against the method
ARN of each new request. An Allow for one route therefore does not carry over
to another route.

## When the JWKS endpoint is unreachable

Verifying a Cognito or JWT token requires fetching the JWKS over the network.

> [!WARNING]
> If cdkd cannot fetch the JWKS, it accepts every Bearer token, forged ones
> included. Do not expose the server to anyone else while this warning is
> showing.

```text
[warn] [cognito-jwt] JWKS unreachable at https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xyz/.well-known/jwks.json: ...
        JWT validation will allow all tokens — local dev fallback. Configure
        network access to the JWKS URL to enable real signature verification.
```

While the fallback is active, a real JWT still has its claims passed to the
handler. A malformed token gets the principal `unknown` and no claims.

cdkd retries the fetch about a minute later and prints the warning again each
time the fetch fails.

## AWS_IAM verification outcomes

A route with `AuthorizationType: 'AWS_IAM'` (REST v1) or `AuthType: 'AWS_IAM'`
(Function URL) has the SigV4 signature of each request checked against your
local AWS credentials.
[AWS_IAM authorization](local-start-api.md#aws-iam-authorization) shows how to
sign a request and states the limit: IAM policies are not evaluated.

The response depends on the request and on the kind of route.

### A valid signature made with your credentials

The request reaches the handler.

- On a REST v1 route, your access key ID is in
  `event.requestContext.authorizer.principalId`.
- On a Function URL, `requestContext.authorizer` is `null`.

A deployed Function URL puts the caller's identity under
`event.requestContext.authorizer.iam`. Locally that block is absent, so a
handler that reads `.iam` sees no identity.

### A request that is rejected

| Request | REST v1 | Function URL |
| --- | --- | --- |
| Missing or malformed `Authorization` header | 403 `{"message":"Missing Authentication Token"}` | 403 `{"Message":"Forbidden"}` |
| Signature does not match | 403 `{"message":"Forbidden"}` | 403 `{"Message":"Forbidden"}` |

The bodies match the deployed services, including the capital `M` on Function
URLs.

### A signature made with an access key you do not hold

cdkd cannot verify a signature made with a key it does not hold. By default
it lets the request through and prints a warning, once per key per run.

### Edge case: session tokens

cdkd does not validate a session token. It accepts whatever token the request
was signed with.

## `--strict-sigv4`

`--strict-sigv4` denies a request whose signature cdkd cannot verify, with
the 403 the deployed API would return.

```bash
cdkd local start-api --port 3000 --strict-sigv4
```

Without the flag, a request signed with an access key you do not hold passes
with a warning. With the flag it is denied. The flag also denies every signed
request when you have no local AWS credentials at all.

## Related

- [`cdkd local start-api`](local-start-api.md): the worked example and the
  options
- [Mutual TLS](local-start-api-mtls.md): require a client certificate before
  any authorizer runs
- [WebSocket APIs](local-start-api-websocket.md): WebSocket authorizers are
  not emulated
