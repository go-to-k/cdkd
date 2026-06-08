/**
 * Shim: re-exports cdk-local's Docker host-gateway version probe for
 * `cdkd local start-api` — gates the `--add-host=...:host-gateway` mapping
 * WebSocket Lambda containers need to reach the host server on Linux native
 * dockerd. The implementation lives in cdk-local and cdkd consumes it
 * verbatim instead of carrying a byte-identical copy. See cdk-local's
 * `src/local/docker-version.ts`.
 *
 * `resolveHostGatewayExtraHosts` / `HOST_DOCKER_INTERNAL_GATEWAY` (cdk-local
 * #483, exposed from `cdk-local/internal`) are the memoized, never-throwing
 * resolver + the `host.docker.internal:host-gateway` mapping that lets a
 * launched container reach a server bound on the host loopback (an
 * `AWS_ENDPOINT_URL_*` local endpoint / a tunneled VPC resource). cdkd adopts
 * them in its OWN container-run paths — `cdkd local invoke` (via the
 * `runDetached` `extraHosts` option) and `cdkd local run-task` (threaded into
 * the ECS task runner's `--add-host` flag list) — to close the same
 * Linux-native-dockerd reachability gap cdk-local's own `invoke` / `run-task`
 * commands got from #483; `start-service` / `start-alb` inherit it
 * automatically via cdk-local's bundled ECS service emulator engine. The
 * mapping is added only when the daemon supports the `host-gateway` alias
 * (>= 20.10, or an unparseable podman / finch version), and silently degrades
 * to no mapping otherwise (Docker Desktop resolves the name natively). cdk-local's
 * test-only `resetHostGatewayExtraHostsCache` is intentionally NOT re-exported
 * (cdkd's unit tests `vi.mock` this shim rather than reset cdk-local's memo).
 */
export {
  HOST_GATEWAY_MIN_VERSION,
  probeHostGatewaySupport,
  resolveHostGatewayExtraHosts,
  HOST_DOCKER_INTERNAL_GATEWAY,
} from 'cdk-local/internal';
