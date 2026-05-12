import * as cdk from 'aws-cdk-lib';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * Fixture stack for `cdkd local run-task --from-state` Tier 2 ECR
 * Repository resolution integ test.
 *
 * One same-stack `AWS::ECR::Repository` + one `AWS::ECS::TaskDefinition`
 * whose container `Image` is shaped as a single-arg `Fn::Sub` that
 * references the deployed repository's CloudFormation logical id
 * directly:
 *
 *   { "Fn::Sub": "${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${MyRepo}:latest" }
 *
 * This is the **exact** shape that `cdkd local run-task --from-state`'s
 * Tier 2 resolver (introduced in PR #267, closes #264) is designed to
 * substitute: `${AWS::AccountId}` / `${AWS::Region}` come from pseudo
 * parameters (Tier 1) and `${MyRepo}` is looked up in cdkd state for
 * the deployed Repository's physical id (Tier 2).
 *
 * Key design decisions:
 *
 * 1. **Logical id is pinned via `overrideLogicalId('MyRepo')`**. cdkd's
 *    Tier 2 resolver matches the `${MyRepo}` placeholder against the
 *    template's resource logical ids; without the override, CDK appends
 *    an 8-char hash suffix (e.g. `MyRepoF4F48043`) and the placeholder
 *    in the L1 TaskDefinition would have to track that suffix.
 *
 * 2. **L1 `CfnTaskDefinition` is used directly** (not CDK's L2
 *    `ContainerImage.fromEcrRepository(repo)`). The L2 form synthesizes
 *    a `Fn::Join` shape with nested `Fn::Select` / `Fn::Split` /
 *    `Fn::GetAtt`, which the Tier 2 resolver does **not** yet handle —
 *    tracked separately as a follow-up (issue #271). The L1 path here
 *    pins the synthesized template to the actually-supported `Fn::Sub`
 *    shape so the integ exercises real Tier 2 behavior end-to-end.
 *
 * 3. **Single-arg `Fn::Sub`** (template string only — no variable map).
 *    cdkd's resolver scans the flat template string for `${...}`
 *    placeholders and treats each non-AWS-pseudo name as a logical id
 *    lookup. A 2-arg `Fn::Sub` with a variable map would route the
 *    placeholder name through the map, which cdkd doesn't unwind.
 *
 * Repository carries `removalPolicy: DESTROY` so `cdkd destroy` can
 * reclaim it; `autoDeleteImages` is intentionally **not** set — pushed
 * images are deleted by `verify.sh`'s cleanup trap via the AWS CLI
 * before destroy runs, so the deletion path stays AWS-native and the
 * fixture has zero dependencies on CDK custom-resource handlers.
 */
export class LocalRunTaskFromStateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repo = new ecr.Repository(this, 'MyRepo', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // Pin the logical id so the Fn::Sub placeholder matches verbatim.
    (repo.node.defaultChild as ecr.CfnRepository).overrideLogicalId('MyRepo');

    // ─── Issue #291 fixtures ──────────────────────────────────────────────
    //
    // Add a DynamoDB Table (Ref synthesizes the deployed table name) and a
    // SecretsManager Secret (Ref synthesizes the deployed secret ARN —
    // which is exactly what ECS Agent expects in Secrets[].ValueFrom).
    // The integ task definition below references both via the CFn
    // intrinsics CDK synthesizes — `Ref` / `Fn::GetAtt` / `Fn::Sub` —
    // covering every shape the issue calls out as silently-dropped today.
    const table = new ddb.Table(this, 'MyTable', {
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (table.node.defaultChild as ddb.CfnTable).overrideLogicalId('MyTable');

    const secret = new sm.Secret(this, 'MySecret', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        // Generate a short JSON-shaped value so we can later assert the
        // resolved Secret value reaches the container — verify.sh fetches
        // it via SecretsManager during the assertion phase.
        secretStringTemplate: JSON.stringify({ user: 'cdkd' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 16,
      },
    });
    (secret.node.defaultChild as sm.CfnSecret).overrideLogicalId('MySecret');

    // L1 TaskDefinition so we control the exact synthesized shape.
    // Single-arg Fn::Sub: cdkd's Tier 2 resolver walks the flat template
    // string for `${...}` placeholders and substitutes pseudo-parameters
    // (Tier 1) + same-stack `AWS::ECR::Repository` logical ids (Tier 2).
    const taskDef = new ecs.CfnTaskDefinition(this, 'NginxTaskDef', {
      family: 'cdkd-local-run-task-from-state-fixture',
      requiresCompatibilities: ['EC2'],
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'web',
          image: cdk.Fn.sub(
            '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${MyRepo}:latest'
          ),
          essential: true,
          memory: 256,
          portMappings: [
            {
              containerPort: 80,
              hostPort: 18082,
              protocol: 'tcp',
            },
          ],
        },
      ],
    });
    // Pin task-def logical id for verify.sh discoverability.
    taskDef.overrideLogicalId('NginxTaskDef');

    // ─── L2 form: ContainerImage.fromEcrRepository synthesizes Fn::Join ───
    //
    // CDK 2.x's L2 API for ECR-backed images emits a `Fn::Join` (not
    // `Fn::Sub`) containing nested `Fn::Select` / `Fn::Split` over the
    // Repository's `Arn` GetAtt plus a `Ref` to the same Repository and
    // `Ref: AWS::URLSuffix`. cdkd's Tier 2 resolver was extended in PR
    // for #271 to recognize this shape; this second TaskDefinition
    // exercises that path end-to-end so the Fn::Sub fixture above
    // (NginxTaskDef) and this Fn::Join fixture (NginxTaskDefL2) share
    // the same deployed ECR repository — one deploy / one image push
    // covers both resolver paths.
    //
    // Port 18083 is distinct from NginxTaskDef's 18082 so both can run
    // concurrently if desired (verify.sh starts them serially with a
    // --detach + curl + cleanup cycle per TaskDef).
    const taskDefL2 = new ecs.TaskDefinition(this, 'NginxTaskDefL2', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.BRIDGE,
    });
    taskDefL2.addContainer('web', {
      image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
      essential: true,
      memoryLimitMiB: 256,
      portMappings: [{ containerPort: 80, hostPort: 18083, protocol: ecs.Protocol.TCP }],
    });
    (taskDefL2.node.defaultChild as ecs.CfnTaskDefinition).overrideLogicalId('NginxTaskDefL2');

    // ─── Issue #291: env vars + secrets via state substitution ────────────
    //
    // A short-lived busybox task whose container `Environment` references
    // the DynamoDB Table via every intrinsic shape CDK synthesizes —
    // `Ref` for `table.tableName`, `Fn::GetAtt` for `table.tableArn`,
    // `Fn::Sub` interpolation — and whose `Secrets[].ValueFrom` is a
    // bare `Ref` against `MySecret` (which CDK 2.x synthesizes as
    // `Ref: MySecret` because `Ref` on `AWS::SecretsManager::Secret`
    // returns the secret ARN — exactly what ECS Agent + cdkd's secret
    // resolver expect).
    //
    // The container `command` simply echoes every env var to stdout so
    // verify.sh can capture the values via `docker logs <id>` and assert
    // each placeholder was substituted with the deployed physical id /
    // ARN. The container exits with code 0 after one print so the local
    // run-task wait completes naturally without --keep-running.
    // ExecutionRole is required by AWS whenever a TaskDef carries
    // `secrets` (otherwise RegisterTaskDefinition fails with
    // "When you are specifying container secrets, you must also
    // specify a value for 'executionRoleArn'"). NginxTaskDefL2 (L2)
    // gets one auto-generated by CDK; this L1 fixture needs an
    // explicit Role with `secretsmanager:GetSecretValue` on the
    // fixture's secret.
    const envExecRole = new iam.Role(this, 'EnvTaskDefExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    });
    secret.grantRead(envExecRole);
    (envExecRole.node.defaultChild as iam.CfnRole).overrideLogicalId('EnvTaskDefExecRole');

    const envTaskDef = new ecs.CfnTaskDefinition(this, 'EnvTaskDef', {
      family: 'cdkd-local-run-task-from-state-env-fixture',
      requiresCompatibilities: ['EC2'],
      networkMode: 'bridge',
      executionRoleArn: envExecRole.roleArn,
      containerDefinitions: [
        {
          name: 'printer',
          // Public, tiny, always-cached: avoids requiring an extra
          // image push, distinct from the ECR-pull surface above.
          image: 'public.ecr.aws/docker/library/busybox:1.36',
          essential: true,
          memory: 64,
          command: [
            'sh',
            '-c',
            // Single-line echo of the 4 env values + secret. Each on a
            // separate line so verify.sh greps unambiguously.
            // shellcheck disable=SC2016
            // eslint-disable-next-line no-template-curly-in-string
            'echo "TABLE_NAME=$TABLE_NAME"; echo "TABLE_ARN=$TABLE_ARN"; echo "ENDPOINT=$ENDPOINT"; echo "JOINED=$JOINED"; echo "DB_SECRET_LEN=${#DB_SECRET}"',
          ],
          environment: [
            // `Ref: MyTable` → table name (DDB Ref returns the name).
            { name: 'TABLE_NAME', value: table.tableName },
            // `Fn::GetAtt: [MyTable, Arn]`.
            { name: 'TABLE_ARN', value: table.tableArn },
            // `Fn::Sub` with `${AWS::Region}` + `${MyTable}` placeholders.
            { name: 'ENDPOINT', value: cdk.Fn.sub('local-${AWS::Region}-${MyTable}') },
            // `Fn::Join` over a literal + `Ref: MyTable`. Validates
            // PR #291 Fn::Join env support (Gap 1 of #286).
            { name: 'JOINED', value: cdk.Fn.join('|', [table.tableName, 'literal']) },
          ],
          // `Ref: MySecret` synthesizes to `{ Ref: 'MySecret' }`, which
          // (on AWS::SecretsManager::Secret) is the deployed secret ARN.
          // cdkd's secret resolver consumes the ARN, calls
          // GetSecretValue, and injects the resolved JSON blob as
          // DB_SECRET. We only assert the length in the container output
          // (so the integ-test logs don't leak the generated secret).
          secrets: [{ name: 'DB_SECRET', valueFrom: secret.secretArn }],
        },
      ],
    });
    envTaskDef.overrideLogicalId('EnvTaskDef');
  }
}
