import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
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
  }
}
