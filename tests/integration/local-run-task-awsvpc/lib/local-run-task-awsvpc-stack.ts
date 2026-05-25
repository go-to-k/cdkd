import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/**
 * Fixture stack for the `cdkd local run-task` awsvpc-mode integ test
 * (issue #594, deferred item (3) of #579 — unblocked by #461).
 *
 * A single TaskDefinition with `networkMode: awsvpc` and one busybox
 * container running a tiny netcat HTTP echo on port 18080. The point of
 * this fixture is the NETWORK MODE: before #461 cdkd hard-rejected
 * `awsvpc` at resolver time with `EcsTaskResolutionError`; after #461 it
 * ACCEPTS the task and maps `awsvpc` to a docker bridge network with a
 * startup warn (docker cannot emulate ENI-per-task — see
 * docs/design/461-awsvpc-decision.md). This fixture's verify.sh asserts
 * that acceptance + the warn + that the container actually boots and
 * serves on the bridge fallback.
 *
 * A non-privileged port (18080) is used so the host-port publish (cdkd
 * publishes container ports for `run-task`) does not need to bind the
 * privileged port 80. `awsvpc` requires `hostPort == containerPort` (or
 * omitted), so `hostPort` is left implicit and cdkd defaults it to
 * `containerPort`.
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only (pure Docker).
 *
 * `covers: AWS::ECS::TaskDefinition`
 */
export class LocalRunTaskAwsvpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const taskDef = new ecs.TaskDefinition(this, 'AwsvpcTask', {
      compatibility: ecs.Compatibility.EC2,
      // Explicit family so the local container name is predictable
      // (`cdkd-local-cdkd-local-run-task-awsvpc-web-<rand>`) and
      // verify.sh can filter `docker ps` on it.
      family: 'cdkd-local-run-task-awsvpc',
      // The whole point of the fixture: NetworkMode awsvpc, which cdkd
      // maps to a docker bridge network locally with a warn (#461).
      networkMode: ecs.NetworkMode.AWS_VPC,
    });

    taskDef.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:1.36'),
      essential: true,
      entryPoint: ['/bin/sh', '-c'],
      // Tiny TCP echo over port 18080 using busybox nc. Reads one
      // request, responds with a fixed HTTP echo, then loops to spin up
      // a fresh listener for the next request (busybox nc exits on EOF;
      // it does NOT support GNU netcat's `-q` flag).
      command: [
        "while true; do { echo -e 'HTTP/1.1 200 OK\\r\\nContent-Length: 13\\r\\nConnection: close\\r\\n\\r\\nHELLO_AWSVPC\\n'; } | nc -l -p 18080; done",
      ],
      // awsvpc requires hostPort == containerPort (or omitted); leave
      // hostPort implicit so cdkd defaults it to the containerPort.
      portMappings: [{ containerPort: 18080, protocol: ecs.Protocol.TCP }],
      memoryReservationMiB: 32,
    });
  }
}
