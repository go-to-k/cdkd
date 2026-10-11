---
title: cdkd local start-alb
description: "Run an Application Load Balancer from your CDK app locally: its listeners and routing rules in front of the ECS services and Lambda functions they target."
---

# cdkd local start-alb

`cdkd local start-alb [targets...]` runs an Application Load Balancer on your
machine. It boots the ECS services and Lambda functions the listeners point
at, opens one local server per listener port, and applies the listener rules
to each request. Use it to check a routing rule, a weighted split or an
authentication action without deploying.

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

serve it, binding listener port 80 on host port 8080:

```bash
cdkd local start-alb MyStack/MyAlb --lb-port 80=8080
```

cdkd boots the service's replicas, then prints an `ALB front-door:` line with
the address. From another terminal:

```bash
curl http://127.0.0.1:8080/
curl -H 'Host: api.example.com' http://127.0.0.1:8080/orders   # exercise a host-header rule
```

More invocations:

```bash
cdkd local start-alb                                           # pick load balancers from a list
cdkd local start-alb MyStack/PublicAlb MyStack/InternalAlb     # two load balancers, one shared network
cdkd local start-alb MyStack/MyAlb --tls --bearer-token "$JWT" # HTTPS locally, with a default token
cdkd local start-alb MyStack/MyAlb --from-state --watch        # deployed values, reload on source edits
```

Docker is required. See [Local Execution](local-emulation.md#requirements).

## Options

### Front door

| Flag | Default | Description |
| --- | --- | --- |
| `[targets...]` | picker | The load balancers to serve. Omit in an interactive terminal to choose from a list. |
| `--lb-port <listenerPort=hostPort...>` | host port = listener port | Bind one listener on another host port. Repeatable. |
| `--tls` | off | Serve HTTPS listeners over real HTTPS. See [TLS termination](#tls-termination). |
| `--tls-cert <path>` | — | PEM server certificate. Implies `--tls`. Requires `--tls-key`. |
| `--tls-key <path>` | — | PEM private key. Implies `--tls`. Requires `--tls-cert`. |
| `--bearer-token <jwt>` | — | Token added as `Authorization` to a request that has none. See [Authentication actions](#authentication-actions). |
| `--no-verify-auth` | off | Treat every request as authenticated. |

### Backing services

The ECS services behind the load balancer are run as
[`cdkd local start-service`](local-start-service.md) runs them, and these
flags mean what they mean there:

| Flag | Default | Description |
| --- | --- | --- |
| `--max-tasks <n>` | `3` | Most replicas per service, applied over `DesiredCount`. At most `83`. |
| `--restart-policy <policy>` | `on-failure` | `on-failure`, `always` or `none`. |
| `--watch` | off | Re-synthesize and reload the services when the source changes. |
| `--shadow-ready-timeout <ms>` | `60000` | How long a `--watch` rebuild waits for a new replica. Also set by `CDKD_SHADOW_READY_TIMEOUT_MS`; the flag wins. |
| `--no-logs` | off | Do not stream container output. |
| `--cluster <name>` | `cdkd-local` | Cluster name the metadata endpoint reports, and the Docker network prefix. |
| `--assume-role [arn]` | off | Give the containers the task role's credentials. `--assume-task-role` is a deprecated alias. |
| `--platform <platform>` | from the task's `RuntimePlatform` | Force `linux/amd64` or `linux/arm64`. |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--no-build` | off | Reuse the previously built image for a CDK asset. Errors when it is missing. |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating to ECR. |
| `--image-override <service=dockerfile or dockerfile...>` | — | Build a service's image locally. See [Image overrides](local-start-service.md#image-overrides). |
| `--image-build-arg <KEY=VAL...>` | — | `docker build --build-arg` for override builds. |
| `--image-build-secret <id=src...>` | — | `docker build --secret` for override builds. |
| `--image-target <stage or svc=stage...>` | — | `docker build --target` for override builds. |
| `--no-interactive-overrides` | off | Do not prompt for Dockerfiles at boot. |
| `--strict-overrides` | off | Fail at boot when a service still uses a deployed-registry image. |

It also accepts every [common flag](local-emulation.md#common-flags).
`--env-vars` is keyed by container name, and `--container-host` is the IP that
both the container ports and the front-door ports bind to.

> [!WARNING]
> Do not pass `--role-arn` here without the `--profile` flag. The role's
> credentials reach the Lambda target containers, and the ECS task secrets are
> fetched with it. An exported `AWS_PROFILE` covers only the secrets. cdkd
> warns at startup when this applies. See the `--role-arn` section of the
> [CLI Reference](cli-reference.md).

## Target resolution

Each target names an `AWS::ElasticLoadBalancingV2::LoadBalancer`, as a CDK
display path (`MyStack/MyAlb`) or a stack-qualified logical ID
(`MyStack:MyAlb`). A single-stack app may omit the stack. See
[Naming the target](local-emulation.md#naming-the-target).

Naming a listener or a target group is an error, and the message lists the
load balancers in the stack.

Several load balancers in one run share one Docker network and one Cloud Map
registry, so services behind different load balancers can still discover each
other.

## Listener and action support

Anything outside this table is skipped with a warning at boot, and the rest of
the load balancer is still served.

| Part | Served |
| --- | --- |
| Listener protocols | `HTTP` and `HTTPS`. `TCP`, `UDP` and `TLS` listeners are skipped. |
| Rule conditions | `path-pattern`, `host-header`, `http-header`, `http-request-method`, `query-string`, `source-ip`. |
| Actions | `forward` to one target group or weighted across several, `redirect`, `fixed-response`. |
| Auth actions | `authenticate-cognito` and `authenticate-oidc`, as a Bearer-JWT check. |
| Target groups | ECS services, and Lambda functions. |

| Behaviour | Detail |
| --- | --- |
| Forwarding headers | The client IP is appended to `X-Forwarded-For`, and `X-Forwarded-Proto` and `X-Forwarded-Port` are set for the listener. |
| No rule matches and no default action can be served | 404 naming the request fields that were evaluated. |
| WebSocket upgrade to an ECS target | Bridged to the chosen replica, after the same rule matching and auth checks. |
| WebSocket upgrade to a `redirect` or `fixed-response` action | Answered on the upgrade socket. |
| WebSocket upgrade to a Lambda target group | `502`. Lambda target groups do not carry WebSocket traffic. |

### TLS termination

An HTTPS listener is served over plain HTTP by default, with
`X-Forwarded-Proto: https` set so the application still sees the deployed
protocol. This avoids certificate warnings in `curl` and browsers.

| Flags | Front door |
| --- | --- |
| None | Plain HTTP, `X-Forwarded-Proto: https`. |
| `--tls` | HTTPS with a self-signed certificate, generated on first use and cached under `$XDG_CACHE_HOME/cdk-local/alb-https/` (`~/.cache/cdk-local/alb-https/` by default). Requires `openssl` on `PATH`. |
| `--tls-cert` and `--tls-key` | HTTPS with your own certificate. |

Use `--tls` when cookies need `Secure` or `SameSite=None`, or when the
application inspects TLS metadata.

The generated certificate is valid for `localhost` and `127.0.0.1` only. With
a non-loopback `--container-host`, supply `--tls-cert` and `--tls-key` with a
matching name.

A listener's ACM certificates are never used. Their private keys cannot be
retrieved.

### Authentication actions

For an `authenticate-cognito` or `authenticate-oidc` action, the front door
verifies a Bearer JWT against the same JWKS or OIDC discovery URL the deployed
load balancer uses: signature, issuer, audience and expiry. A request carrying
an `AWSELBAuthSessionCookie-*` cookie also passes.

```bash
curl -H "Authorization: Bearer $JWT" http://127.0.0.1:8080/   # verified on this token
```

| Flag | Effect |
| --- | --- |
| `--bearer-token <jwt>` | Used for a request with no `Authorization` header. A request with its own token is verified on that token. |
| `--no-verify-auth` | Turns the check off. |

An authenticate action with nothing servable behind it is skipped with a
warning.

## State sources

`--from-state` covers only part of a load balancer:

| Target kind | `--from-state` | `--from-cfn-stack` |
| --- | --- | --- |
| ECS service (`TargetType: ip` / `instance`) | Resolves images, environment, secrets, role ARNs and volumes | Resolves the same |
| Lambda (`TargetType: lambda`) | Not resolved | Resolves the function's `Environment.Variables` |

### Lambda target groups and the state source

Under `--from-state`, a Lambda target's intrinsic-valued environment
variables (`Ref`, `Fn::GetAtt`, `Fn::Sub`, `Fn::ImportValue`) are dropped, one
warning each, and a warning at boot names the affected functions. The ECS
services behind the same load balancer are resolved normally.

To resolve both kinds, use `--from-cfn-stack` for a stack deployed through
CloudFormation, or supply the Lambda's variables with `--env-vars`.

Under `--from-cfn-stack`, an `Fn::GetAtt` in an ECS container's
`Environment[].Value` is dropped with a warning.

## `--watch`: hot reload without dropping connections

`--watch` reloads the backing ECS services as
[`start-service --watch`](local-start-service.md#watch-hot-reload-on-source-changes)
does: one replica at a time, by copying source into the container for an
interpreted-language edit and by rebuilding the image otherwise. Requests sent
to a listener during a reload are not refused.

| During a reload | Result |
| --- | --- |
| Front-door servers, TLS, the JWKS cache | Stay up. |
| Lambda target containers | Not reloaded. They keep the image they booted with. |
| Synthesis fails | The existing replicas keep serving, with a warning. |
| `DesiredCount` or `--max-tasks` changed | The count does not change. Restart to apply it. |

## Stopping

{kbd:ctrl+c} or `SIGTERM` closes the front-door servers, then removes every
replica, the sidecar and the shared network. A second signal exits at once
without cleanup; see [Stopping a server](local-emulation.md#stopping-a-server).

## Exit codes

| Code | Meaning |
| --- | --- |
| `1` | An error: bad target, synthesis failure, a Docker or AWS failure, a boot refused by `--strict-overrides`, or a cancelled picker. |
| `130` | Stopped by {kbd:ctrl+c} or `SIGTERM`. |

There is no exit `0`: the command runs until it is signalled. The full
cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

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
