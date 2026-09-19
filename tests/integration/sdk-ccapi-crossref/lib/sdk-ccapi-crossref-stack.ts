import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * SDK-provider <-> Cloud Control API cross-reference boundary integ fixture.
 *
 * cdkd provisions a resource either through a hand-written SDK Provider
 * (`provisionedBy: 'sdk'`) or through the generic Cloud Control API
 * (`provisionedBy: 'cc-api'`). On the CC path no SDK Provider `create()` runs:
 * the physical id is whatever Cloud Control returns and `Fn::GetAtt` values
 * come from a Cloud Control read-back instead of a typed attribute write.
 * `Ref` / `Fn::GetAtt` references that CROSS that boundary are a fragile seam.
 * This stack forces a heterogeneous routing mix in ONE stack and crosses the
 * boundary in BOTH directions, against TWO kinds of CC-provisioned resource.
 *
 * HOW THE CC LAYER IS REACHED — and why not through a silent-drop property.
 * This fixture used to put `AWS::Kinesis::Stream` (`DesiredShardLevelMetrics`)
 * and `AWS::Lambda::Function` (`RuntimeManagementConfig`) on Cloud Control by
 * setting a property their SDK Provider did not handle (the #614 auto-route).
 * That is a moving premise: both properties were later wired into the SDK
 * Providers, both resources silently landed on `'sdk'`, and the run failed at
 * its baseline before reaching anything it tests. Neither mechanism below
 * depends on a property-coverage table:
 *
 *   1. `Archive` (`AWS::Events::Archive`) is a type with NO SDK Provider, so
 *      it is pure Cloud Control fallback on a plain fresh deploy. Only a newly
 *      added `AWS::Events::Archive` SDK Provider can change that, and
 *      verify.sh's baseline FAIL line says so.
 *   2. `CcLambda` (`AWS::Lambda::Function`) is an SDK-registered type moved to
 *      Cloud Control with the explicit `--recreate-via-cc-api CcLambda` flag
 *      in the `seed` phase. It keeps the original scenario's harder case — an
 *      SDK-registered type living on the CC layer, whose destroy BYPASSES the
 *      SDK Provider's `delete()`.
 *
 * Phase env `CDKD_INTEG_PHASE`, set by verify.sh:
 *
 *   - `base` (default): plain deploy. `Archive` -> `'cc-api'`, everything
 *     else (incl. `CcLambda`) -> `'sdk'`. `FnArnParam` does not exist yet.
 *   - `seed`: `CcLambda` gains `RuntimeManagementConfig` and is deployed with
 *     `--recreate-via-cc-api CcLambda` -> `'cc-api'`. `FnArnParam` is ADDED,
 *     so its create resolves `Fn::GetAtt(CcLambda, 'Arn')` against the record
 *     the Cloud Control create just wrote.
 *
 * `RuntimeManagementConfig` toggles with the phase because routing is decided
 * while PROVISIONING: a deploy the differ classifies NO_CHANGE never reaches
 * the provider, so a recreate flag on an unchanged resource does nothing
 * (go-to-k/cdkd#2651). Both layers handle the property; it is the property
 * delta and an AWS-side witness, NOT a routing trigger.
 *
 * Cross-references (consumer -> producer):
 *   (A) SDK -> CC GetAtt: `ArchiveArnParam.Value = Fn::GetAtt(Archive, 'Arn')`.
 *       `Arn` is a read-only attribute, so it exists in state only through the
 *       Cloud Control read-back.
 *   (B) SDK -> CC Ref:    `ArchiveNameParam.Value = Ref(Archive)`.
 *   (C) CC -> SDK GetAtt: `Archive.SourceArn = Fn::GetAtt(Bus, 'Arn')`.
 *   (D) CC -> SDK Ref:    `Archive.Description` embeds `Ref(Bus)`.
 *   (E) CC -> SDK GetAtt, SDK-registered type on CC:
 *       `CcLambda.Role = Fn::GetAtt(ExecRole, 'Arn')` (seed phase).
 *   (F) SDK -> CC GetAtt, SDK-registered type on CC:
 *       `FnArnParam.Value = Fn::GetAtt(CcLambda, 'Arn')` (seed phase).
 *
 * No VPC / NAT — every resource is cheap and creates in seconds.
 */
export class SdkCcApiCrossrefStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const rawPhase = process.env['CDKD_INTEG_PHASE'] ?? 'base';
    if (!['base', 'seed'].includes(rawPhase)) {
      throw new Error(`Unknown CDKD_INTEG_PHASE '${rawPhase}' (expected base | seed)`);
    }
    const seed = rawPhase === 'seed';

    // --- SDK: IAM Role ---
    const execRole = new iam.CfnRole(this, 'ExecRole', {
      roleName: 'cdkd-crossref-exec-role',
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
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      ],
    });

    // --- SDK: EventBridge event bus (the producer the CC archive reads) ---
    const bus = new events.CfnEventBus(this, 'Bus', {
      name: 'cdkd-crossref-bus',
    });

    // --- CC (no SDK Provider for the type): EventBridge archive.
    //     Cross-ref (C): SourceArn = GetAtt(Bus, Arn).
    //     Cross-ref (D): Description embeds Ref(Bus). ---
    const archive = new events.CfnArchive(this, 'Archive', {
      archiveName: 'cdkd-crossref-archive',
      sourceArn: bus.attrArn,
      description: cdk.Fn.join('', ['archive of ', bus.ref]),
      retentionDays: 1,
    });

    // --- SDK: cross-ref (A) GetAtt + (B) Ref of the CC-provisioned archive ---
    new ssm.CfnParameter(this, 'ArchiveArnParam', {
      name: '/cdkd/crossref/archive-arn',
      type: 'String',
      value: archive.attrArn,
    });
    new ssm.CfnParameter(this, 'ArchiveNameParam', {
      name: '/cdkd/crossref/archive-name',
      type: 'String',
      value: archive.ref,
    });

    // --- Lambda: SDK in `base`, moved to CC in `seed` by
    //     `--recreate-via-cc-api CcLambda`.
    //     Cross-ref (E): Role = GetAtt(ExecRole, Arn). ---
    const fn = new lambda.CfnFunction(this, 'CcLambda', {
      functionName: 'cdkd-crossref-fn',
      runtime: 'python3.12',
      handler: 'index.handler',
      role: execRole.attrArn,
      code: {
        zipFile: [
          'def handler(event, context):',
          '    return {"statusCode": 200, "body": "cdkd crossref probe"}',
        ].join('\n'),
      },
      // The property delta the recreate flag needs (see the class comment).
      ...(seed && { runtimeManagementConfig: { updateRuntimeOn: 'FunctionUpdate' } }),
    });

    // The Lambda's role must exist before CreateFunction validates it.
    fn.addDependency(execRole);

    // --- SDK: cross-ref (F), created only once the Lambda is on CC ---
    if (seed) {
      new ssm.CfnParameter(this, 'FnArnParam', {
        name: '/cdkd/crossref/fn-arn',
        type: 'String',
        value: fn.attrArn,
      });
    }
  }
}
