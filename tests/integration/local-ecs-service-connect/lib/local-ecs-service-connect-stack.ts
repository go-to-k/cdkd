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
 *     maps the bare `orders` short-name to that port.
 *   - `frontend` is the consumer — it has Service Connect enabled too
 *     (so its own `frontend-api` is published), but the integ asserts
 *     it can reach `orders` via the `--add-host` DNS overlay cdkd
 *     injects from the shared Cloud Map registry.
 *
 * L1 `CfnService` + `CfnTaskDefinition` directly (no VPC) so the
 * fixture stays small. `cdkd local start-service` never makes AWS API
 * calls against the cluster — the cluster name is surfaced only to the
 * ECS metadata sidecar; the actual local execution is pure docker.
 *
 * Network mode is `bridge` for both — `awsvpc` would exercise the
 * documented bridge-fallback path from #461.
 *
 * `covers: AWS::ECS::Service AWS::ServiceDiscovery::PrivateDnsNamespace`
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
    new cdk.aws_servicediscovery.CfnPrivateDnsNamespace(this, 'Ns', {
      name: 'cdkd-sc.local',
      // CfnPrivateDnsNamespace requires `Vpc` in real AWS, but cdkd
      // never sends this — local emulation skips the field on every
      // SDK call. CFn property-required validation is bypassed because
      // CDK only emits the field when assigned.
      vpc: 'vpc-localfixture',
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
