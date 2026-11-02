import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * Issue #5670: after a resource's delete fails, `cdkd destroy` must not delete
 * the resources it depends on (CloudFormation's DELETE_FAILED keeps them),
 * while it still deletes the resources unrelated to the failure.
 *
 * `FailingBucket` -> `DepParam` -> `DeeperParam` is the chain the failure must
 * keep (DependsOn edges; `DeeperParam` is reached only transitively).
 * `UnrelatedTwo` -> `UnrelatedOne` is independent; `UnrelatedOne` sits on the
 * LAST deletion level, after the failing one, so it must still be deleted.
 * verify.sh makes the bucket's delete fail by putting an object in it: the
 * bucket has no `autoDeleteObjects`, so cdkd refuses to delete it non-empty.
 *
 * covers: AWS::S3::Bucket
 * covers: AWS::SSM::Parameter
 */
export class DestroyFailedDeleteKeepsDependenciesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const prefix = `/cdkd-integ/${id}`;
    const param = (logicalId: string, name: string): ssm.StringParameter => {
      const p = new ssm.StringParameter(this, logicalId, {
        parameterName: `${prefix}/${name}`,
        stringValue: name,
      });
      (p.node.defaultChild as cdk.CfnResource).overrideLogicalId(logicalId);
      return p;
    };

    const deeper = param('DeeperParam', 'deeper');
    const dep = param('DepParam', 'dep');
    dep.node.addDependency(deeper);

    const bucket = new s3.Bucket(this, 'FailingBucket', {
      bucketName: `cdkd-5670-failing-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (bucket.node.defaultChild as cdk.CfnResource).overrideLogicalId('FailingBucket');
    bucket.node.addDependency(dep);

    const unrelatedOne = param('UnrelatedOne', 'unrelated-one');
    const unrelatedTwo = param('UnrelatedTwo', 'unrelated-two');
    unrelatedTwo.node.addDependency(unrelatedOne);
  }
}
