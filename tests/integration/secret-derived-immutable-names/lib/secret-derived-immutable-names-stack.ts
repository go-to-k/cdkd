import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';

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
 *   - `SecretPolicy` (AWS::IAM::ManagedPolicy), `Path` and `Description`
 *     from the secret. Both are create-only, and the provider REPLACED the
 *     policy on every update (a create under the same name and path, which
 *     IAM refuses). The policy ARN carries the path; the description takes
 *     the masker arm.
 *   - `SecretApi` (AWS::AppSync::GraphQLApi), `Name` from the secret: the
 *     physical id is the API id, so the provider asks AppSync for the live
 *     name. `SecretDataSource` (AWS::AppSync::DataSource, type NONE), `Name`
 *     from the secret: the `<apiId>|<name>` physical id carries it.
 *   - `SecretQueue` (AWS::SQS::Queue), `QueueName` from the secret
 *     (go-to-k/cdkd#2177): the provider's own update debug lines print the
 *     queue URL, which carries the name, with no per-site masker. Only the
 *     logger's sink mask keeps the name out of the `--verbose` log.
 *   - `SecretFilter` (AWS::Logs::MetricFilter, no SDK provider, so it routes
 *     to Cloud Control), `FilterName` from the secret. `FilterName` is
 *     create-only, and Cloud Control's `update()` built its JSON Patch from
 *     the recorded bag: the recorded reference against the resolved name put
 *     an op on that create-only path in every update's patch.
 *
 * A Scheduler Schedule's secret-derived `GroupName` stays refused on purpose
 * (go-to-k/cdkd#4275: nothing non-secret in the record identifies the group),
 * so it is not deployed here.
 *
 * UPDATE (CDKD_TEST_UPDATE=true) changes only the Stages' `Description`, the
 * Service's `EnableECSManagedTags` (it has no description), the Policy's
 * `PolicyDocument`, the API's `XrayEnabled`, the DataSource's `Description`
 * the Queue's `VisibilityTimeout` and the Filter's `FilterPattern`: ordinary in-place changes, so the update is not a no-op.
 *
 * covers: AWS::ApiGatewayV2::Api
 * covers: AWS::ApiGatewayV2::Stage
 * covers: AWS::ECS::Cluster
 * covers: AWS::ECS::TaskDefinition
 * covers: AWS::ECS::Service
 * covers: AWS::IAM::ManagedPolicy
 * covers: AWS::AppSync::GraphQLApi
 * covers: AWS::AppSync::DataSource
 * covers: AWS::SQS::Queue
 * covers: AWS::Logs::LogGroup
 * covers: AWS::Logs::MetricFilter
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

    new iam.CfnManagedPolicy(this, 'SecretPolicy', {
      path: fromSecret('path'),
      description: fromSecret('policydesc'),
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: update ? ['sts:GetCallerIdentity', 'sts:GetSessionToken'] : 'sts:GetCallerIdentity',
            Resource: '*',
          },
        ],
      },
    });

    const graphqlApi = new appsync.CfnGraphQLApi(this, 'SecretApi', {
      name: fromSecret('api'),
      authenticationType: 'API_KEY',
      xrayEnabled: update,
    });
    new appsync.CfnDataSource(this, 'SecretDataSource', {
      apiId: graphqlApi.attrApiId,
      name: fromSecret('datasource'),
      type: 'NONE',
      description,
    });

    new sqs.CfnQueue(this, 'SecretQueue', {
      queueName: fromSecret('queue'),
      visibilityTimeout: update ? 60 : 30,
    });

    const logGroup = new logs.CfnLogGroup(this, 'FilterLogGroup', { retentionInDays: 1 });
    new logs.CfnMetricFilter(this, 'SecretFilter', {
      filterName: fromSecret('filter'),
      logGroupName: logGroup.ref,
      filterPattern: update ? 'ERROR' : 'WARN',
      metricTransformations: [
        { metricName: 'SdinFilterHits', metricNamespace: 'CdkdIntegSdin', metricValue: '1' },
      ],
    });
  }
}
