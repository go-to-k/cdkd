# Issue #461 — `awsvpc` network mode decision

## TL;DR

**Outcome (C) — Document the bridge-mode fallback gap; do not emulate `awsvpc` semantics locally.**

Issue [#461](https://github.com/go-to-k/cdkd/issues/461) asked whether `cdkd local run-task` (and the upcoming `cdkd local start-service`) should attempt to emulate ECS `awsvpc` network mode against real docker. The conclusion after the spike outlined below: the engineering cost of partial emulation outranks the realistic user benefit. cdkd keeps the existing **bridge-mode fallback with a startup warn**, and documents the gap loudly in CLI help text + README + this design doc.

## Spike findings

### 1. Per-task IP isolation is mechanically possible but expensive

Docker supports per-network `--subnet` and per-container `--ip` flags, so each task COULD be assigned a `10.0.<task-index>.0/24` subnet with a unique per-container IP. The friction is:

- **Subnet allocation accounting** — `cdkd local start-service` runs N replicas. Each replica needs a non-overlapping subnet, and the allocator must survive partial failure / restart (otherwise a stale subnet record collides on the next run). This is ~150-300 LOC of allocator + persistence code that adds zero value on the dev machine because the host kernel routes every packet through the same loopback interface regardless of the docker bridge's CIDR.
- **No semantic win for the canonical use case** — the user-visible benefit users actually ask for is "code that hardcodes `task.privateIp` works locally". Verified empirically (2026-05-22): the ECS metadata sidecar (`amazon/amazon-ecs-local-container-endpoints:latest-amd64`) already exposes the per-container IP via `ECS_CONTAINER_METADATA_URI_V4` regardless of the docker network's CIDR. The user's "task private IP" code already works on the existing bridge fallback — the IP is just from docker's default subnet, not the VPC's. For local dev that distinction is invisible.

### 2. Security group emulation is impractical

The issue's Outcome (A) sketches translating `SecurityGroupIngress` / `SecurityGroupEgress` rules into docker `--sysctl` / iptables. This is where the cost / benefit gap is widest:

- **Reference-based rules** (`SourceSecurityGroupId: <Ref>`) require cross-task SG-to-IP linkage. cdkd would have to materialize every SG in the template, allocate it a stable IP range, and emit per-rule iptables entries against that range. The shape doesn't map cleanly onto docker's network model — docker treats each network as a flat layer-2 segment, while ECS treats SGs as orthogonal to subnet membership.
- **Protocol + port matching** is tractable but only useful if reference-based rules also work. Without reference rule support, SG emulation is "a subset of what a real VPC enforces", which is worse than no emulation: developers may write code that relies on the local SG behavior, ship it, and have the deployed AWS-side SG diverge silently.
- **`feedback_aws_default_over_opinionated.md` applies** — the safer default is "match what AWS actually enforces locally to the degree we can; fail loudly when we can't" rather than "approximate AWS semantics with subtle divergences".

### 3. The bridge fallback works for the realistic use cases

What developers actually do locally with `awsvpc` tasks:

- **Run the task to verify the container starts** — the bridge fallback handles this.
- **Hit the task on a published port** — `--container-host 127.0.0.1` + `docker run -p` handles this.
- **AWS SDK calls from the task** — the metadata sidecar + `--assume-task-role` handle credentials; the dev's host network handles egress.
- **Container-to-container traffic in the same task** — `--network-alias <CFn Name>` on a shared per-task user network handles this.

What developers do NOT do locally (that real `awsvpc` would enable):

- Test SG enforcement (this is a deploy-side concern; local SG bypass is expected).
- Test per-task IP routing (the dev machine has no VPC).
- Test ENI-attach failure modes (those are AWS-side timing issues that don't reproduce locally regardless of network mode).

### 4. Sibling precedent: `cdkd local start-api` VPC simulation

PR 8b of #224 closed the same shape for Lambda `VpcConfig` (issue #234): VPC-config Lambdas run locally without ENI emulation; cdkd emits a one-line warn at startup naming each affected Lambda. The pattern was accepted by users (no follow-up issue filed). Applying the same shape to `cdkd local run-task` keeps the cdkd-local family's behavior consistent: **local execution surfaces a loud warn for AWS-network-isolation features; the runtime works through the bridge fallback**.

## What ships in cdkd

### Already shipped (pre-#461)

- `src/local/ecs-task-resolver.ts:582-585` emits the existing warn: `NetworkMode 'awsvpc' on '<X>' is mapped to docker bridge locally — docker cannot emulate ENI-per-task. Containers reach each other via --network-alias on a per-task user network; security groups are NOT enforced.`
- `src/local/ecs-network.ts:89` pins `'bridge'` as the docker network driver.

### Net new in this PR

1. **README clarification**: `cdkd local run-task` and `cdkd local start-service` "Known limitations" sections call out the `awsvpc` gap explicitly so users find the answer without reading source. ("Security groups are NOT enforced locally. Per-task IP isolation is provided by docker's network driver, not by ENI emulation. Code that depends on AWS-side SG enforcement should be tested via a real deploy.")
2. **CLI help text**: every command that surfaces an `awsvpc` task adds the same one-line caveat under `--help`.
3. **This design doc**: captures the decision so future contributors don't redo the spike.

No code-path changes are required — the existing warn path is correct.

## Workarounds for users who need real host-network access

Developers occasionally need a local task to reach a service bound to the host's loopback (e.g. a development database on `localhost:5432`). The bridge fallback puts each task on its own user network so `localhost` inside the container resolves to the container itself, not the host. Two workarounds:

### `host.docker.internal` (Docker Desktop default)

On Docker Desktop (macOS / Windows) the special hostname `host.docker.internal` resolves to the host's loopback gateway from inside any container, regardless of network driver. Tasks running under cdkd's bridge fallback can connect to a host service with `host.docker.internal:5432` (or whichever port). This is the recommended workaround — no flag change required, works against the existing bridge fallback.

### `--network host` per-task escape hatch (future enhancement)

Linux hosts that don't expose `host.docker.internal` (or workflows that want the task to bind directly to a host port) can use Docker's `host` network mode, which shares the host's network namespace with the container. **This is not currently exposed as a cdkd flag** — `cdkd local run-task` and `cdkd local start-service` always create a per-task user network so the metadata sidecar can serve task credentials on `169.254.170.2`. Threading a `--network-mode host` flag through would require either skipping the sidecar (and losing `--assume-task-role` credentials) or running the sidecar on the host network at a fixed port (which collides on `169.254.170.0/16` since the host loopback doesn't route the link-local range to the sidecar).

If you have a concrete use case where neither `host.docker.internal` nor publishing a port on the bridge network (`docker run -p`) suffices, file a follow-up issue describing it; the design tradeoff above is reconsidered per-request, not added as a generic opt-in.

### Why not auto-detect

cdkd does not auto-detect Linux vs. Docker Desktop and switch network modes. The reasoning matches `feedback_aws_default_over_opinionated.md`: a per-host-OS behavioral split is invisible to users reading the same CDK app and would surface as "works on my Mac, breaks on the Linux CI runner" without an obvious cause.

## When to revisit

Reopen #461 if any of the following happen:

- A user files a concrete bug where the bridge fallback produces a DIFFERENT behavior than the deployed `awsvpc` task in a way that breaks local dev (the canonical example would be "my local container connects to a sibling container the deployed task's SG would reject" — and that's a feature request for SG emulation, not awsvpc proper).
- AWS publishes a docker feature that natively supports ENI-per-container (e.g. via `amazon-ecs-local-container-endpoints` exposing per-task interfaces). cdkd could then opt in cheaply.
- A new use case lands where reference-based SG rules MUST be honored locally (e.g. a security-sensitive integration test that won't run against real AWS). cdkd could then add an opt-in `--emulate-security-groups` flag.

Until one of these triggers, this is category 2 in `feedback_deferred_three_categories.md`: doable in theory, but the engineering cost exceeds the realistic user benefit.

## Related

- Sibling: [#234](https://github.com/go-to-k/cdkd/issues/234) — `cdkd local start-api` VPC simulation (closed with the same shape).
- Sibling: [#460](https://github.com/go-to-k/cdkd/issues/460) — Service Connect / Cloud Map for ECS Services (separate scope; deferred to Phase 3 of #262).
- Parent: [#262](https://github.com/go-to-k/cdkd/issues/262) — Phase 1 (run-task) + Phase 2 (start-service); this design doc applies to both phases.
