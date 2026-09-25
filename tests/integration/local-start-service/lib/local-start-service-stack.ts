import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/** Must match `PULL_REPO` in verify.sh. */
export const PULL_REPO_NAME = 'cdkd-local-start-service-pull-fixture';

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

    // ─── Issue #3655: pull through a NON-PLAIN ECR registry host ─────────
    //
    // One single-replica service per host form, each pulling the image
    // verify.sh pushes to PULL_REPO_NAME (deployed by the sibling
    // `LocalStartServicePullRepoStack`). The host is spelled as the template
    // names it; the emulator substitutes `${AWS::AccountId}` /
    // `${AWS::Region}` through STS without `--from-state`, so this stack is
    // still never deployed. The pull goes through cdk-local's own ECR puller,
    // which is what the arms exercise.
    const pullService = (id: string, host: string): void => {
      const td = new ecs.CfnTaskDefinition(this, `${id}Task`, {
        family: `cdkd-local-start-service-${id.toLowerCase()}`,
        networkMode: 'bridge',
        containerDefinitions: [
          {
            name: 'web',
            image: cdk.Fn.sub(`${host}/${PULL_REPO_NAME}:latest`),
            essential: true,
            entryPoint: ['/bin/sh', '-c'],
            command: ['while true; do echo "heartbeat from $(hostname)"; sleep 5; done'],
            memoryReservation: 16,
          },
        ],
      });
      new ecs.CfnService(this, id, {
        cluster: cluster.ref,
        taskDefinition: td.ref,
        desiredCount: 1,
        launchType: 'EC2',
      });
    };
    pullService('PullDualStackService', '${AWS::AccountId}.dkr-ecr.${AWS::Region}.on.aws');
    pullService(
      'PullFipsService',
      '${AWS::AccountId}.dkr.ecr-fips.${AWS::Region}.amazonaws.com'
    );
  }
}

/**
 * The ECR repository the pull arms read from (issue #3655). The only stack in
 * this fixture that verify.sh deploys: the ECS stack above cannot be deployed
 * (an EC2 service with no container instances never stabilizes), and the
 * emulator only needs the image to exist in a real private registry.
 *
 * The name is fixed so the ECS stack can spell it without a cross-stack
 * reference the emulator would need `--from-state` to resolve.
 * `emptyOnDelete` lets `cdkd destroy` remove the repository with the pushed
 * image still in it.
 */
export class LocalStartServicePullRepoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new ecr.Repository(this, 'PullRepo', {
      repositoryName: PULL_REPO_NAME,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
  }
}
