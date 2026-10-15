---
title: cdkd local start-alb
description: "Run an Application Load Balancer from your CDK app locally: its listeners and routing rules in front of the ECS services and Lambda functions they target."
---

# cdkd local start-alb

`cdkd local start-alb [targets...]` runs an Application Load Balancer on your
machine. It starts the ECS services and Lambda functions that the load
balancer's listeners point at, opens one local server for each listener port,
and applies the listener rules to every request. Use it to check a routing
rule, a weighted split or an authentication action without deploying.

For API Gateway, use [`cdkd local start-api`](local-start-api.md).

## Serve a load balancer

Given a load balancer in `MyStack` that forwards port 80 to an ECS service:

```ts
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

const alb = new elbv2.ApplicationLoadBalancer(this, 'MyAlb', {
  vpc,
  internetFacing: true,
});
const listener = alb.addListener('Http', { port: 80 });
listener.addTargets('Orders', { port: 8080, targets: [ordersService] });
```

serve it, with listener port 80 bound to port 8080 on your machine:

```bash
cdkd local start-alb MyStack/MyAlb --lb-port 80=8080
```

cdkd starts the service's replicas, then prints an `ALB front-door:` line with
the address. From another terminal:

```bash
curl http://127.0.0.1:8080/

# exercise a host-header rule
curl -H 'Host: api.example.com' http://127.0.0.1:8080/orders
```

This page calls the local servers that stand in for the load balancer the
**front door**, after that line.

More invocations:

```bash
# pick load balancers from a list
cdkd local start-alb

# two load balancers, one shared network
cdkd local start-alb MyStack/PublicAlb MyStack/InternalAlb

# HTTPS locally, with a default token
cdkd local start-alb MyStack/MyAlb --tls --bearer-token "$JWT"

# deployed values, reload on source edits
cdkd local start-alb MyStack/MyAlb --from-state --watch
```

Docker is required. [Local Execution](local-emulation.md) lists the
requirements.

## Options

### Front door

| Flag | Default | Description |
| --- | --- | --- |
| `[targets...]` | picker | The load balancers to serve. |
| `--lb-port <listenerPort=hostPort...>` | same port | Bind one listener on another host port. Repeatable. |
| `--tls` | off | Serve HTTPS listeners over HTTPS. |
| `--tls-cert <path>` | — | PEM server certificate. Requires `--tls-key`. |
| `--tls-key <path>` | — | PEM private key. Requires `--tls-cert`. |
| `--bearer-token <jwt>` | — | Token added to a request that has no `Authorization` header. |
| `--no-verify-auth` | off | Treat every request as authenticated. |

`--tls-cert` and `--tls-key` each imply `--tls`. The TLS flags are explained
under [TLS termination](#tls-termination) and the last two under
[Authentication actions](#authentication-actions).

### Backing services

cdkd runs the ECS services behind the load balancer the way
[`cdkd local start-service`](local-start-service.md) runs them. These flags
mean what they mean on that command, and that page explains them:

| Flag | Default | Description |
| --- | --- | --- |
| `--max-tasks <n>` | `3` | Most replicas per service. At most `83`. |
| `--restart-policy <policy>` | `on-failure` | `on-failure`, `always` or `none`. |
| `--watch` | off | Reload the services when the source changes. |
| `--shadow-ready-timeout <ms>` | `60000` | How long a `--watch` rebuild waits for a new replica. |
| `--no-logs` | off | Do not stream container output. |
| `--cluster <name>` | `cdkd-local` | Cluster name the replicas report, and the Docker network prefix. |
| `--assume-role [arn]` | off | Give the containers the task role's credentials. |
| `--platform <platform>` | from the task definition | Force `linux/amd64` or `linux/arm64`. |
| `--no-pull` | off | Skip `docker pull` for every image. |
| `--no-build` | off | Reuse the image built last time for a CDK asset. |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating to ECR. |
| `--image-override <service=dockerfile or dockerfile...>` | — | Build a service's image from a local Dockerfile. |
| `--image-build-arg <KEY=VAL...>` | — | `docker build --build-arg` for override builds. |
| `--image-build-secret <id=src...>` | — | `docker build --secret` for override builds. |
| `--image-target <stage or svc=stage...>` | — | `docker build --target` for override builds. |
| `--no-interactive-overrides` | off | Do not prompt for Dockerfiles at startup. |
| `--strict-overrides` | off | Refuse to start while a service still runs a deployed image. |

`--shadow-ready-timeout` can also be set with the
`CDKD_SHADOW_READY_TIMEOUT_MS` environment variable, and the flag wins when
both are set. `--assume-task-role` is a deprecated alias of `--assume-role`.
The override flags are explained in
[Image overrides for local ECS services](local-start-service-image-overrides.md).

### Flags shared with other commands

The command also accepts every common flag listed in
[Local Execution](local-emulation.md). Two of them behave in a way specific to
this command: the `--env-vars` file is keyed by container name, and
`--container-host` sets the IP that both the container ports and the
front-door ports bind to.

> [!WARNING]
> Do not pass `--role-arn` here without the `--profile` flag. `--role-arn` is
> the role cdkd assumes for its own AWS calls. On this command the role's
> credentials also reach the Lambda target containers, and cdkd fetches the
> ECS task secrets with it. An exported `AWS_PROFILE` covers only the secrets.
> cdkd warns at startup when this applies. See the `--role-arn` section of
> the [CLI Reference](cli-reference.md).

## Target resolution

A target names one `AWS::ElasticLoadBalancingV2::LoadBalancer`. You can write
it as a CDK display path (`MyStack/MyAlb`) or as a stack-qualified logical ID
(`MyStack:MyAlb`), and an app with one stack may omit the stack.
[Local Execution](local-emulation.md) describes the forms in full.

Name the load balancer itself. Naming one of its listeners or target groups is
an error, and the message lists the load balancers in the stack.

You can name several load balancers in one run. They share one Docker network
and one set of service-discovery names, so a service behind one load balancer
can still call a service behind another.

## Listener and action support

cdkd serves the HTTP and HTTPS listeners of a load balancer, with the rule
conditions and actions most applications use. When it meets something it
cannot serve, it skips that part with a warning at startup and serves the rest
of the load balancer.

| Part | Served |
| --- | --- |
| Listener protocols | `HTTP`, `HTTPS` |
| Rule conditions | `path-pattern`, `host-header`, `http-header`, `http-request-method`, `query-string`, `source-ip` |
| Actions | `forward`, `redirect`, `fixed-response` |
| Authentication actions | `authenticate-cognito`, `authenticate-oidc` |
| Target groups | ECS services, Lambda functions |

A `forward` action can send to one target group or split requests across
several by weight. `TCP`, `UDP` and `TLS` listeners belong to Network Load
Balancers and are skipped.

Before the front door passes a request to a target, it sets the headers a
deployed load balancer sets. It appends the client's IP to `X-Forwarded-For`,
and it sets `X-Forwarded-Proto` and `X-Forwarded-Port` to the listener's
protocol and port.

A request that matches no rule, on a listener whose default action cannot be
served, gets a `404`. The response names the request fields that the rules
were evaluated against, so you can see why nothing matched.

### WebSocket upgrades

A WebSocket upgrade goes through the same rule matching and authentication as
any other request. What happens next depends on the action it reaches:

- **An ECS target.** The connection is bridged to the replica that was chosen.
- **A `redirect` or `fixed-response` action.** The response is sent on the
  upgrade socket.
- **A Lambda target group.** The front door answers `502`, because Lambda
  target groups do not carry WebSocket traffic.

### TLS termination

By default the front door serves an HTTPS listener over plain HTTP. It still
sets `X-Forwarded-Proto: https`, so the application sees the protocol it would
see when deployed. Plain HTTP avoids certificate warnings in `curl` and in
browsers.

Pass `--tls` when you need real HTTPS locally, which is the case when cookies
need `Secure` or `SameSite=None`, or when the application inspects TLS
metadata. For a load balancer with an HTTPS listener on port 443:

```bash
cdkd local start-alb MyStack/MyAlb --tls --lb-port 443=8443
curl -k https://127.0.0.1:8443/
```

With `--tls` alone, cdkd generates a self-signed certificate on first use and
keeps it for later runs. Generating it requires `openssl` on `PATH`. To use
your own certificate instead, pass `--tls-cert` and `--tls-key`.

Three limits apply:

- The generated certificate is valid for `localhost` and `127.0.0.1` only. If
  you set `--container-host` to another address, supply `--tls-cert` and
  `--tls-key` for a certificate with a matching name.
- The generated certificate is cached under
  `$XDG_CACHE_HOME/cdk-local/alb-https/`, which is
  `~/.cache/cdk-local/alb-https/` by default.
- The ACM certificates on a listener are never used, because their private
  keys cannot be retrieved from AWS.

### Authentication actions

An `authenticate-cognito` or `authenticate-oidc` action is served as a check
on a Bearer JWT. Send the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer $JWT" http://127.0.0.1:8080/
```

The front door verifies the token's signature, issuer, audience and expiry,
against the same JWKS or OIDC discovery URL that the deployed load balancer
uses. A request that carries an `AWSELBAuthSessionCookie-*` cookie, the
session cookie a deployed load balancer sets after sign-in, also passes.

Two flags save you from sending a token on every request:

- `--bearer-token <jwt>` supplies a default. The front door adds it to a
  request that has no `Authorization` header. A request with its own token is
  verified on that token.
- `--no-verify-auth` turns the check off, so every request passes.

When the action that follows an authentication action cannot be served, the
authentication action is skipped as well, with a warning.

## State sources

`--from-state` and `--from-cfn-stack` replace references in the template, such
as a table name written as a `Ref`, with the values of the deployed stack.
[Local Execution](local-emulation.md) explains both flags. For an ECS
service, either flag resolves its images, environment variables, secrets,
role ARNs and volumes. For a Lambda target, either flag resolves the
function's `Environment.Variables`.

### Edge cases

- **`Fn::GetAtt` under `--from-cfn-stack`.** An `Fn::GetAtt` in the value of
  an ECS container's environment variable is dropped with a warning.

## `--watch`: hot reload without dropping connections

`--watch` reloads the ECS services behind the load balancer when your source
changes, while the front door keeps accepting requests. A request sent to a
listener during a reload is not refused.

```bash
cdkd local start-alb MyStack/MyAlb --lb-port 80=8080 --watch
```

The services are reloaded exactly as
[`start-service --watch`](local-start-service.md#watch-hot-reload-on-source-changes)
reloads them: one replica at a time, by copying source into the container for
an edit to interpreted-language source, and by rebuilding the image otherwise.
The front-door servers, their TLS setup and the cached signing keys stay up
throughout.

### What a reload does not change

- **Lambda target containers.** They are not reloaded and keep the image they
  started with. Restart the command to pick up a change to a Lambda target.
- **The number of replicas.** A change to `DesiredCount` or `--max-tasks` is
  not applied until you restart.
- **Anything, when synthesis fails.** cdkd prints a warning and the existing
  replicas keep serving.

## Stopping

{kbd:ctrl+c} or `SIGTERM` closes the front-door servers, then removes every
replica, the sidecar and the shared network.

A second signal exits at once and skips the cleanup, so containers can be left
behind. [Local Execution](local-emulation.md) shows how to find and remove
them.

## Exit codes

| Code | Meaning |
| --- | --- |
| `1` | An error, or a cancelled picker. |
| `130` | Stopped by {kbd:ctrl+c} or `SIGTERM`. |

There is no exit `0`, because the command runs until it receives a signal. An
error here is a target that does not resolve, a synthesis failure, a Docker or
AWS failure, or a start refused by `--strict-overrides`.

The [CLI Reference](cli-reference.md) has the exit-code table for every
command.

## Related

- [`cdkd local start-service`](local-start-service.md): how the backing ECS
  services are run, including replicas, image overrides and `--watch`
- [`cdkd local run-task`](local-run-task.md): the image, secret, volume and
  ordering rules every container follows
- [`cdkd local start-api`](local-start-api.md): the API Gateway counterpart
- [`cdkd local invoke`](local-invoke.md): how a Lambda target's container is
  run
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
