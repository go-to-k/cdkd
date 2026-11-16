import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#2631: a replacement whose delete of the OLD resource fails,
 * followed by a failure later in the same deploy, is rolled back WITHOUT
 * re-creating the old resource while it is still alive.
 *
 * - `Target` is a managed policy whose `ManagedPolicyName` (create-only) is
 *   `cdkd-rdfr-target-${TARGET_SUFFIX ?? 'a'}`, so `TARGET_SUFFIX=b` replaces
 *   it: the new policy is created first, then the old one's delete runs.
 * - `Holder` is a role `Target` is attached to, so the old policy's delete
 *   detaches it before `DeletePolicy` (go-to-k/cdkd#4946).
 * - `BREAK=true` adds `Breaker`, a managed policy that depends on `Target`.
 * - `Target`'s `Description` is the NoEcho parameter `TargetNote`, so its
 *   state record holds a NoEcho value (`noEchoLeaves`). That keeps the old
 *   policy's delete INLINE, right after the new one is created: a replacement
 *   otherwise defers that delete to the deploy's cleanup phase, which a failed
 *   deploy never reaches (go-to-k/cdkd#6374), and there would be no refused
 *   delete for the rollback to meet. A record holding a NoEcho value cannot be
 *   left for a later run, whose delete may need the value only this run holds.
 *
 * verify.sh deploys `TARGET_SUFFIX=b BREAK=true` as a role that may not
 * delete `cdkd-rdfr-target-a` nor create `cdkd-rdfr-breaker`: the old
 * policy's delete is refused, and `Breaker`'s create then fails the deploy
 * before the post-deploy retry of that delete (go-to-k/cdkd#4900). The
 * automatic rollback must find the old policy alive and, since its delete had
 * already detached it from `Holder`, refuse rather than re-adopt that stripped
 * policy (go-to-k/cdkd#4946) or re-create it (which collides on its name).
 *
 * go-to-k/cdkd#4911: `CERT_MODE=dns|email` adds `Cert`, an ACM certificate
 * whose `ValidationMethod` is the mode. That key is not create-only, so
 * changing it reaches the ACM provider's replacement inside its own
 * `update()`; with `BREAK=true` the failing `Breaker` depends on it, so it
 * runs after that replacement. A synthetic `.example.test` domain under
 * `CDKD_NO_WAIT=true`: the certificate stays PENDING_VALIDATION.
 *
 * L1 resources with explicit names, on the SDK route.
 *
 * covers: AWS::IAM::ManagedPolicy, AWS::IAM::Role, AWS::CertificateManager::Certificate
 */
export class ReplacedDeleteFailedRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const document = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: 'logs:CreateLogGroup', Resource: '*' }],
    };

    const holder = new iam.CfnRole(this, 'Holder', {
      roleName: 'cdkd-rdfr-holder',
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
    });

    // A value no name, ARN or id of this run contains, so its mask never
    // hides what verify.sh greps for.
    const note = new cdk.CfnParameter(this, 'TargetNote', {
      type: 'String',
      noEcho: true,
      default: 'RdfrNoEchoTargetNote7c1e',
    });
    note.overrideLogicalId('TargetNote');

    const target = new iam.CfnManagedPolicy(this, 'Target', {
      managedPolicyName: `cdkd-rdfr-target-${process.env.TARGET_SUFFIX ?? 'a'}`,
      description: note.valueAsString,
      policyDocument: document,
      roles: [holder.ref],
    });

    // L1 so the two modes differ in `ValidationMethod` and nothing else (the
    // L2's email validation also emits the create-only DomainValidationOptions).
    const certMode = process.env.CERT_MODE;
    const cert =
      certMode === 'dns' || certMode === 'email'
        ? new acm.CfnCertificate(this, 'Cert', {
            domainName: `cdkd-rdfr-${this.stackName.toLowerCase()}.example.test`,
            validationMethod: certMode === 'dns' ? 'DNS' : 'EMAIL',
            // verify.sh's role may delete and tag only certificates carrying it.
            tags: [{ key: 'cdkd-integ', value: 'rdfr' }],
          })
        : undefined;

    if (process.env.BREAK === 'true') {
      const breaker = new iam.CfnManagedPolicy(this, 'Breaker', {
        managedPolicyName: 'cdkd-rdfr-breaker',
        policyDocument: document,
      });
      breaker.addDependency(target);
      if (cert !== undefined) breaker.addDependency(cert);
    }
  }
}
