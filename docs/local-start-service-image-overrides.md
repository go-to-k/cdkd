---
title: Image overrides for local ECS services
description: "Build an ECS service's image from a local Dockerfile while cdkd local start-service or start-alb runs it with the deployed stack's configuration."
---

# Image overrides for local ECS services

`--image-override` is a flag of
[`cdkd local start-service`](local-start-service.md) and
[`cdkd local start-alb`](local-start-alb.md). It builds a service's image from
a local Dockerfile, in place of the image the service names.

You need it when the service uses an image that is already in a registry
(`ContainerImage.fromEcrRepository` or `fromRegistry`). cdkd pulls that image,
so edits to your working copy would never reach the container, and `--watch`
has nothing to rebuild for that service.

Combine it with `--from-cfn-stack` or `--from-state` to run your working copy
against the deployed stack's real configuration:

```bash
cdkd local start-service MyStack/Orders --from-cfn-stack \
  --image-override MyStack/Orders=./orders/Dockerfile
```

## The two forms of `--image-override`

The flag takes a Dockerfile for one named service, or a Dockerfile alone:

| Form | Effect |
| --- | --- |
| `--image-override <service>=<dockerfile>` | Uses that Dockerfile for that service. |
| `--image-override <dockerfile>` | Asks which services should use it. |

The second form opens a picker over the services that have no override yet, so
one Dockerfile can serve several services. Naming the same service twice in
the first form is an error.

## Build arguments, secrets and stages

Three flags pass options to the override builds. Each takes a value for every
build or a value for one service, and the value for one service wins.

| Flag | For every build | For one service |
| --- | --- | --- |
| `--image-build-arg` | `KEY=VAL` | `<service>:KEY=VAL` |
| `--image-build-secret` | `id=src` | `<service>:id=src` |
| `--image-target` | `<stage>` | `<service>=<stage>` |

`--image-build-secret` supplies the file that a Dockerfile line such as
`RUN --mount=type=secret,id=<id>` reads, which is how a build reaches a
private registry or uses an npm token. cdkd resolves a relative `src` against
the working directory and expands `~`.

## Services left without an override

At startup, cdkd warns about each service that still uses an image from a
registry. In a terminal it also asks for a Dockerfile for each one. Two flags
change this:

- `--no-interactive-overrides` turns the questions off, for scripts and CI.
- `--strict-overrides` makes cdkd refuse to start while any such service
  remains.

## Related

- [`cdkd local start-service`](local-start-service.md): the command these
  flags belong to
- [`cdkd local start-alb`](local-start-alb.md): accepts the same flags for the
  services behind a load balancer
