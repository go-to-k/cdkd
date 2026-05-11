import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/**
 * Sidecar-pattern multi-container fixture for `cdkd local run-task`.
 *
 * Two containers sharing a host-anonymous volume mounted at /shared:
 *   - `app` (essential) writes "hello from app" to /shared/out.txt then exits.
 *   - `tail-shim` (non-essential) waits for `app` to START, then prints
 *     /shared/out.txt to stdout and exits.
 *
 * Exercises:
 *   - Multi-container DAG with `dependsOn { condition: 'START' }`
 *   - Shared volume + MountPoints with bind-mount semantics
 *   - Container exit propagation (essential = 'app', exit code 0)
 *
 * No AWS deploy required.
 */
export class LocalRunTaskMultiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const taskDef = new ecs.TaskDefinition(this, 'AppTask', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.BRIDGE,
      volumes: [{ name: 'shared', host: {} }],
    });

    const app = taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:1.36'),
      essential: true,
      entryPoint: ['/bin/sh', '-c'],
      command: ['echo "hello from app" > /shared/out.txt && cat /shared/out.txt'],
      memoryReservationMiB: 16,
    });
    app.addMountPoints({
      sourceVolume: 'shared',
      containerPath: '/shared',
      readOnly: false,
    });

    const tail = taskDef.addContainer('tail-shim', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:1.36'),
      essential: false,
      entryPoint: ['/bin/sh', '-c'],
      command: ['sleep 2 && (cat /shared/out.txt || echo "no shared file")'],
      memoryReservationMiB: 16,
    });
    tail.addMountPoints({
      sourceVolume: 'shared',
      containerPath: '/shared',
      readOnly: true,
    });
    tail.addContainerDependencies({
      container: app,
      condition: ecs.ContainerDependencyCondition.START,
    });
  }
}
