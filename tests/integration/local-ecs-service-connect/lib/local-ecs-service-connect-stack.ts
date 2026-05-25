import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/**
 * Fixture for `cdkd local start-service` Service Connect + Cloud Map
 * emulation (Issue #460 — Phase 3 of #262).
 *
 * Two ECS Services sharing one Cloud Map namespace via Service Connect,
 * each at `desiredCount: 2` (#579 item (1), unblocked by the #585
 * multi-replica host-port fix):
 *   - `orders` exposes a busybox netcat HTTP echo on port 80, named
 *     `orders-api` in its port mapping. Service Connect ClientAlias
 *     maps the bare `orders` short-name to that port. `desiredCount: 2`
 *     exercises the producer side of the #585 fix: the OrdersTask
 *     publishes an EXPLICIT `hostPort: 8081`, so this service proves
 *     cdkd skips the `-p` host-port publish for a multi-replica service
 *     even when the TaskDefinition declares an explicit host port (the
 *     2nd replica would otherwise collide on host port 8081).
 *   - `frontend` is the consumer — it has Service Connect enabled too
 *     (so its own `frontend-api` is published), but the integ asserts
 *     BOTH replicas can reach `orders` via the `--add-host` DNS overlay
 *     cdkd injects from the shared Cloud Map registry. `desiredCount: 2`
 *     exercises the OMITTED-hostPort side of the #585 fix (frontend's
 *     port mapping has no `hostPort`, which cdkd would otherwise default
 *     to `containerPort` 8080 and collide on the 2nd replica) AND the
 *     first-replica-wins alias resolution: both frontend replicas
 *     inherit the same shared Cloud Map registry snapshot, so they must
 *     resolve `orders` / `orders.cdkd-sc.local` to the SAME (first
 *     registered) orders replica IP.
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
          // is set explicitly so this multi-replica fixture exercises
          // the EXPLICIT-hostPort branch of the #585 host-port-skip fix:
          // with `desiredCount: 2`, cdkd skips the `-p` publish entirely
          // for every replica, so neither the explicit 8081 nor a
          // defaulted 80 is bound to the host (the 2nd replica would
          // otherwise collide on host port 8081). Peer discovery between
          // containers goes through the shared docker network on
          // `containerPort: 80`, so dropping the host-side mapping does
          // not affect what this integ asserts.
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
      // OrdersService runs desiredCount: 2 (#579 item (1)). Its
      // TaskDefinition publishes an EXPLICIT `hostPort: 8081`, so this
      // service proves the #585 fix skips the `-p` host-port publish for
      // a multi-replica service even with an explicit host port — the
      // 2nd replica would otherwise fail with "Bind for 127.0.0.1:8081
      // failed: port is already allocated". The shared docker network
      // carries peer discovery on containerPort 80 regardless.
      desiredCount: 2,
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
      // FrontendService runs desiredCount: 2 (#579 item (1)).
      // FrontendTask's portMappings OMITS `hostPort`, which cdkd would
      // otherwise default to `containerPort` (=8080); the #585 fix skips
      // the `-p` publish for this multi-replica service so the 2nd
      // replica does not collide on host port 8080. Two frontend
      // replicas also exercise first-replica-wins alias resolution:
      // both consumers inherit the same shared Cloud Map registry
      // snapshot, so both resolve `orders` to the SAME orders replica IP
      // (asserted in verify.sh).
      desiredCount: 2,
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
