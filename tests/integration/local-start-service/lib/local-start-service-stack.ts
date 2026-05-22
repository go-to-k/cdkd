import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/**
 * Fixture for `cdkd local start-service` Phase 2 emulator.
 *
 * Spins up an `AWS::ECS::Service` with DesiredCount=2 backed by a
 * minimal busybox task definition that loops printing a heartbeat. The
 * service runs indefinitely; the integ harness boots cdkd, asserts the
 * 2 replicas are running via `docker ps`, then sends SIGTERM and
 * asserts every container + network + sidecar is cleaned up.
 *
 * Uses L1 `CfnCluster` + `CfnService` directly (no VPC) so the fixture
 * stays small. `cdkd local start-service` never makes AWS API calls
 * against the cluster — the cluster name is surfaced only to the ECS
 * metadata sidecar; the actual local execution is pure docker.
 *
 * Network mode is bridge — `awsvpc` would exercise the documented
 * bridge-fallback path from #461 and warrants its own variant once
 * regression coverage is needed.
 *
 * `covers: AWS::ECS::Service` (matrix opt-in marker — see
 * docs/integ-coverage.md).
 */
export class LocalStartServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkd-local-start-service-fixture',
    });

    const taskDef = new ecs.CfnTaskDefinition(this, 'WebTask', {
      family: 'cdkd-local-start-service-web',
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'web',
          image: 'public.ecr.aws/docker/library/busybox:1.36',
          essential: true,
          entryPoint: ['/bin/sh', '-c'],
          // Loop forever — services are long-running by definition.
          // Sleep 5s between heartbeats so logs are readable but
          // the container doesn't burn CPU.
          command: [
            'i=0; while true; do echo "heartbeat $i from $(hostname)"; i=$((i+1)); sleep 5; done',
          ],
          memoryReservation: 16,
        },
      ],
    });

    new ecs.CfnService(this, 'WebService', {
      cluster: cluster.ref,
      taskDefinition: taskDef.ref,
      desiredCount: 2,
      launchType: 'EC2',
    });
  }
}
