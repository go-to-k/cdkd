import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/**
 * Fixture for `cdkd local start-service` Service Connect + Cloud Map
 * emulation (Issue #460 — Phase 3 of #262).
 *
 * Two ECS Services sharing one Cloud Map namespace via Service Connect:
 *   - `orders` exposes a busybox netcat HTTP echo on port 80, named
 *     `orders-api` in its port mapping. Service Connect ClientAlias
 *     maps the bare `orders` short-name to that port. `desiredCount: 1`
 *     — producer-side multi-replica needs cdkd source work (per-replica
 *     host port allocation) before it can ship; tracked as a follow-up
 *     to #579. The OrdersTask publishes an explicit `hostPort: 8081`
 *     (see L101-109 comment) and cdkd's docker-runner always passes
 *     `-p host:container`, so a second replica would collide on host
 *     port 8081 today.
 *   - `frontend` is the consumer — it has Service Connect enabled too
 *     (so its own `frontend-api` is published), but the integ asserts
 *     it can reach `orders` via the `--add-host` DNS overlay cdkd
 *     injects from the shared Cloud Map registry. `desiredCount: 1`
 *     — frontend ALSO hits the docker-runner host-port-publish bug
 *     described above (containerPort 8080 → defaulted hostPort 8080
 *     → 2 replicas collide). The full #579 item (1) defer note is in
 *     the OrdersService inline comment.
 *
 * Item (2) of #579 adds an `AWS::ServiceDiscovery::Service` resource
 * (`orders-discovery`) attached to the existing namespace, plus a
 * `ServiceRegistries[]` entry on `OrdersService` that references it.
 * This exercises the SECOND Cloud Map mechanism in
 * `publishReplicaToCloudMap` (the ServiceRegistries[] branch — distinct
 * from the Service Connect alias branch) end-to-end: the integ asserts
 * `orders-discovery.cdkd-sc.local` resolves to an orders container IP
 * in the frontend container's `/etc/hosts`.
 *
 * L1 `CfnService` + `CfnTaskDefinition` directly (no VPC) so the
 * fixture stays small. `cdkd local start-service` never makes AWS API
 * calls against the cluster — the cluster name is surfaced only to the
 * ECS metadata sidecar; the actual local execution is pure docker.
 *
 * Network mode is `bridge` for both — `awsvpc` would exercise the
 * documented bridge-fallback path from #461.
 *
 * `covers: AWS::ECS::Service AWS::ServiceDiscovery::PrivateDnsNamespace AWS::ServiceDiscovery::Service`
 * (matrix opt-in marker — see docs/integ-coverage.md).
 */
export class LocalEcsServiceConnectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkd-local-ecs-sc-fixture',
    });

    // Cloud Map private DNS namespace. cdkd uses the `Name` literal as
    // the namespace string in the `--add-host name.namespace:ip`
    // overlay.
    const namespace = new cdk.aws_servicediscovery.CfnPrivateDnsNamespace(this, 'Ns', {
      name: 'cdkd-sc.local',
      // CfnPrivateDnsNamespace requires `Vpc` in real AWS, but cdkd
      // never sends this — local emulation skips the field on every
      // SDK call. CFn property-required validation is bypassed because
      // CDK only emits the field when assigned.
      vpc: 'vpc-localfixture',
    });

    // Item (2) of #579: a dedicated `AWS::ServiceDiscovery::Service`
    // attached to the same namespace, referenced from `OrdersService`'s
    // `ServiceRegistries[]` below. Distinct discovery name
    // (`orders-discovery`) so it does NOT collide with the Service
    // Connect ClientAlias `orders` published by the same service —
    // `cloud-map-resolver.ts` indexes by `(namespace, serviceName)`, so
    // a collision would silently shadow per first-wins semantics.
    // `publishReplicaToCloudMap` resolves this via the synth-time
    // `cloudMapIndexByStack` entry and registers `{ip, port}` against
    // `<discoveryName>.<namespaceName>` = `orders-discovery.cdkd-sc.local`.
    const ordersDiscovery = new cdk.aws_servicediscovery.CfnService(this, 'OrdersDiscovery', {
      name: 'orders-discovery',
      // `Fn::GetAtt: [<NsLogicalId>, 'Id']` is the canonical CDK 2.x
      // synth shape `cloud-map-resolver.ts` expects (verified in the
      // resolver's `resolveNamespaceIdRef` comment).
      namespaceId: namespace.attrId,
      // DnsConfig isn't read by cdkd local — the in-process registry
      // doesn't enforce DNS record types — but real AWS requires it
      // for any `CreateService` call, so we set a minimal A-record
      // config to keep `cdk synth` (and future real-AWS deploys via
      // `cdkd deploy`) consistent with what AWS would accept.
      dnsConfig: {
        namespaceId: namespace.attrId,
        dnsRecords: [{ type: 'A', ttl: 60 }],
        routingPolicy: 'MULTIVALUE',
      },
    });

    // ---------- service A: orders (producer + Service Connect server) ----------
    const ordersTask = new ecs.CfnTaskDefinition(this, 'OrdersTask', {
      family: 'cdkd-local-ecs-sc-orders',
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'orders',
          image: 'public.ecr.aws/docker/library/busybox:1.36',
          essential: true,
          // PortMappings.Name is the linchpin — Service Connect
          // references it via `Services[].PortName`. `hostPort: 8081`
          // is set explicitly because cdkd's `docker run -p` would
          // otherwise bind host port 80 (= containerPort by default),
          // which fails to start on Docker Desktop 20.x (the container
          // sits in `Created` state instead of erroring out). Peer
          // discovery between containers goes through the per-task
          // docker network on `containerPort: 80`, so the host-side
          // mapping is irrelevant to what this integ asserts.
          portMappings: [
            { name: 'orders-api', containerPort: 80, hostPort: 8081, protocol: 'tcp' },
          ],
          entryPoint: ['/bin/sh', '-c'],
          // Tiny TCP echo over port 80 using busybox's nc. Reads one
          // request, responds with a fixed HTTP echo, then exits so
          // the outer `while true` loop can spin up a fresh listener
          // for the next request. (busybox `nc` does NOT support
          // GNU netcat's `-q` flag — the original command tried `-q 1`
          // and tripped `nc: invalid option -- 'q'` on every restart,
          // leaving port 80 silently unlistened. busybox's stock nc
          // exits on EOF on its stdin, so piping a single response
          // into it is sufficient.)
          command: [
            "while true; do { echo -e 'HTTP/1.1 200 OK\\r\\nContent-Length: 13\\r\\nConnection: close\\r\\n\\r\\nHELLO_ORDERS\\n'; } | nc -l -p 80; done",
          ],
          memoryReservation: 32,
        },
      ],
    });

    new ecs.CfnService(this, 'OrdersService', {
      cluster: cluster.ref,
      taskDefinition: ordersTask.ref,
      // OrdersService stays at desiredCount: 1 — its TaskDefinition
      // publishes an explicit `hostPort: 8081` (see L101-109 comment on
      // OrdersTask) and cdkd's docker-runner currently always passes
      // `-p host:container`, so two replicas would collide on host port
      // 8081 ("Bind for 127.0.0.1:8081 failed: port is already
      // allocated"). Producer-side multi-replica needs per-replica host
      // port allocation in cdkd source — deferred to a follow-up issue
      // for #579 (see PR body). FrontendService below DOES go
      // desiredCount: 2 (no hostPort published, no collision), which
      // exercises the per-replica subnet octet allocator + alias
      // first-wins on the consumer side.
      desiredCount: 1,
      launchType: 'EC2',
      serviceConnectConfiguration: {
        enabled: true,
        namespace: 'cdkd-sc.local',
        services: [
          {
            portName: 'orders-api',
            // ClientAliases publishes the bare-name `orders` for
            // consumer-side `wget http://orders/` calls.
            clientAliases: [{ dnsName: 'orders', port: 80 }],
          },
        ],
      },
      // #579 item (2): bind to the `orders-discovery` Cloud Map service
      // via `Fn::GetAtt: [<CloudMapServiceLogicalId>, 'Arn']` — the
      // canonical CDK 2.x synth shape `ecs-service-resolver.ts`
      // expects (see `extractServiceRegistries`). This drives
      // `publishReplicaToCloudMap`'s ServiceRegistries[] branch, which
      // is distinct from the Service Connect alias branch above —
      // BOTH get registered against the same replica IP, so the
      // frontend container's `/etc/hosts` will carry both
      // `orders.cdkd-sc.local` (Service Connect) AND
      // `orders-discovery.cdkd-sc.local` (Cloud Map) entries.
      serviceRegistries: [
        {
          registryArn: ordersDiscovery.attrArn,
          containerName: 'orders',
          containerPort: 80,
        },
      ],
    });

    // ---------- service B: frontend (consumer) ----------
    const frontendTask = new ecs.CfnTaskDefinition(this, 'FrontendTask', {
      family: 'cdkd-local-ecs-sc-frontend',
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'frontend',
          image: 'public.ecr.aws/docker/library/busybox:1.36',
          essential: true,
          portMappings: [
            { name: 'frontend-api', containerPort: 8080, protocol: 'tcp' },
          ],
          entryPoint: ['/bin/sh', '-c'],
          // Print a heartbeat every 5s so the container stays alive
          // for the integ to docker-exec into it.
          command: [
            'i=0; while true; do echo "frontend heartbeat $i $(hostname)"; i=$((i+1)); sleep 5; done',
          ],
          memoryReservation: 16,
        },
      ],
    });

    new ecs.CfnService(this, 'FrontendService', {
      cluster: cluster.ref,
      taskDefinition: frontendTask.ref,
      // FrontendService stays at desiredCount: 1 — same reason as
      // OrdersService above. FrontendTask's portMappings omits
      // `hostPort`, but cdkd's docker-runner defaults `hostPort` to
      // `containerPort` (=8080) when omitted and always passes
      // `-p host:container`, so two frontend replicas would collide
      // on host port 8080 ("Bind for 127.0.0.1:8080 failed: port is
      // already allocated"). #579 item (1) (desiredCount: 2 on EITHER
      // service) requires cdkd source work — per-replica host port
      // allocation OR an opt-out for the host-port publish — deferred
      // to a follow-up issue. This integ fixture currently exercises
      // only #579 item (2) (ServiceRegistries[] / Cloud Map service
      // registration), which works fine at desiredCount: 1.
      desiredCount: 1,
      launchType: 'EC2',
      serviceConnectConfiguration: {
        enabled: true,
        namespace: 'cdkd-sc.local',
        services: [
          {
            portName: 'frontend-api',
            // No ClientAlias — `discoveryName` defaults to `frontend-api`.
          },
        ],
      },
    });
  }
}
