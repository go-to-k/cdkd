import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkd local start-service --watch` bind-mount source
 * fast path (Phase 4 of cdk-local#214; landed in cdk-local 0.69.0 and
 * inherited by cdkd via the `addStartServiceSpecificOptions` helper).
 *
 * One `AWS::ECS::Service` with `DesiredCount=1` (the Phase 1 single-
 * replica gate is still in force; the fast path is path-independent
 * of the replica count). The container is a Node 22 image built from
 * the local `webapp/` asset. The handler is `server.cjs`:
 *
 *   - **Source-only edit** (rewrite of `server.cjs`): the classifier
 *     returns `'soft-reload'`. The runner `docker cp`s the new
 *     `server.cjs` into the running container's WORKDIR and `docker
 *     restart`s it — no `docker build`, no shadow boot, no Cloud
 *     Map / front-door pool swap. Verify by the
 *     `verdict=soft-reload` log line and the v1 -> v2 transition on
 *     `curl /`.
 *
 *   - **Dockerfile edit** (rewrite of `webapp/Dockerfile`): the
 *     classifier returns `'rebuild'`. The runner falls through to
 *     the Phase 1-3 rolling primitive (`docker build` + shadow boot
 *     + atomic swap). Verify by the `verdict=rebuild` log line and
 *     the v1 -> v3 transition.
 *
 * `covers: AWS::ECS::Service` (start-service --watch Phase 4 fast path).
 */
export class LocalStartServiceWatchFastStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkd-local-start-service-watch-fast',
    });

    // Asset image built from the local `webapp/` directory. Editing
    // `webapp/server.cjs` flips the asset hash, triggering the watcher
    // reload. The Dockerfile sets `WORKDIR /app` and `COPY server.cjs
    // /app/server.cjs` so `docker cp <new-asset-dir>/. <container>:/app/`
    // lands the edited source where the running Node process can
    // `require` it after `docker restart`.
    const image = ecs.ContainerImage.fromAsset(path.join(__dirname, '../webapp'));

    const taskDef = new ecs.TaskDefinition(this, 'WebTask', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.BRIDGE,
    });
    taskDef.addContainer('web', {
      image,
      memoryReservationMiB: 64,
      portMappings: [{ containerPort: 8080 }],
    });

    new ecs.CfnService(this, 'WebService', {
      cluster: cluster.ref,
      taskDefinition: (taskDef.node.defaultChild as ecs.CfnTaskDefinition).ref,
      desiredCount: 1,
      launchType: 'EC2',
    });
  }
}
