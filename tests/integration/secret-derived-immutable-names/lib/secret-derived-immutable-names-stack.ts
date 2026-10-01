import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ecs from 'aws-cdk-lib/aws-ecs';

/**
 * Immutable NAMES taken from a Secrets Manager secret, updated in place
 * (go-to-k/cdkd#4264, go-to-k/cdkd#4275).
 *
 * cdkd records a secret-derived value as its `{{resolve:secretsmanager:...}}`
 * expression, while a provider's `update()` receives the resolved value. Each
 * provider's immutable-name guard compared the two, saw a rename that never
 * happened, and refused every in-place update of the resource.
 *
 * `verify.sh` seeds the secret `SDIN_SECRET_NAME` with `{"stage": ...,
 * "service": ...}`, so both names reach cdkd only through the secret.
 *
 * Deploys:
 *   - `SecretStage` (AWS::ApiGatewayV2::Stage), `StageName` from the secret.
 *     The physical id IS the stage name, so the provider compares the
 *     resolved name with it.
 *   - `PlainStage`, a literal `StageName`: the positive control, updated the
 *     same way; it passes with or without the fix.
 *   - `SecretService` (AWS::ECS::Service), `ServiceName` from the secret
 *     (go-to-k/cdkd#4263): EC2 launch type with `DesiredCount: 0`, so it needs
 *     no VPC, no capacity and runs nothing. The physical id is the service
 *     ARN, which ends with the name.
 *
 * A Scheduler Schedule's secret-derived `GroupName` stays refused on purpose
 * (go-to-k/cdkd#4275: nothing non-secret in the record identifies the group),
 * so it is not deployed here.
 *
 * UPDATE (CDKD_TEST_UPDATE=true) changes only the Stages' `Description` and
 * the Service's `EnableECSManagedTags` (it has no description): an ordinary
 * in-place change, so the update is not a no-op.
 *
 * covers: AWS::ApiGatewayV2::Api
 * covers: AWS::ApiGatewayV2::Stage
 * covers: AWS::ECS::Cluster
 * covers: AWS::ECS::TaskDefinition
 * covers: AWS::ECS::Service
 */
export class SecretDerivedImmutableNamesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';
    const description = update ? 'cdkd integ: updated' : 'cdkd integ: initial';
    // A placeholder keeps `cdk synth` working without the script; a deploy
    // against it fails at resolve time, which is the loud outcome.
    const secretName = process.env.SDIN_SECRET_NAME ?? 'cdkd-integ-sdin-unset';
    const fromSecret = (jsonField: string): string =>
      cdk.SecretValue.secretsManager(secretName, { jsonField }).unsafeUnwrap();

    const api = new apigwv2.CfnApi(this, 'Api', {
      name: 'CdkdSecretDerivedImmutableNamesApi',
      protocolType: 'HTTP',
    });
    new apigwv2.CfnStage(this, 'SecretStage', {
      apiId: api.ref,
      stageName: fromSecret('stage'),
      description,
    });
    new apigwv2.CfnStage(this, 'PlainStage', {
      apiId: api.ref,
      stageName: 'plain',
      description,
    });

    const cluster = new ecs.CfnCluster(this, 'Cluster');
    const taskDefinition = new ecs.CfnTaskDefinition(this, 'TaskDef', {
      requiresCompatibilities: ['EC2'],
      networkMode: 'bridge',
      containerDefinitions: [
        { name: 'app', image: 'public.ecr.aws/docker/library/busybox:latest', memory: 32 },
      ],
    });
    new ecs.CfnService(this, 'SecretService', {
      cluster: cluster.ref,
      serviceName: fromSecret('service'),
      taskDefinition: taskDefinition.ref,
      launchType: 'EC2',
      desiredCount: 0,
      enableEcsManagedTags: update,
    });
  }
}
