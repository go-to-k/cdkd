import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as eventschemas from 'aws-cdk-lib/aws-eventschemas';
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
 * HOW THE CC LAYER IS REACHED — and why not through an SDK-unwired property.
 * This fixture used to put `AWS::Kinesis::Stream` (`DesiredShardLevelMetrics`)
 * and `AWS::Lambda::Function` (`RuntimeManagementConfig`) on Cloud Control by
 * setting a property their SDK Provider did not handle (the #614 auto-route).
 * That is a moving premise: both properties were later wired into the SDK
 * Providers, both resources silently landed on `'sdk'`, and the run failed at
 * its baseline before reaching anything it tests. Neither mechanism below
 * depends on a property-coverage table:
 *
 *   1. `Discoverer` (`AWS::EventSchemas::Discoverer`) is a type with NO SDK
 *      Provider, so it is pure Cloud Control fallback on a plain fresh deploy.
 *      Only a newly added SDK Provider for it can change that, and verify.sh's
 *      baseline FAIL line says so. (The fixture used `AWS::Events::Archive`
 *      until go-to-k/cdkd#6578 gave that type an SDK Provider.) A replacement
 *      must be cheap, absent from `register-providers.ts`, not
 *      NON_PROVISIONABLE, take an ARN (the bus's), and expose a read-only
 *      `Fn::GetAtt` attribute other than what `Ref` returns.
 *   2. `CcLambda` (`AWS::Lambda::Function`) is an SDK-registered type moved to
 *      Cloud Control with the explicit `--recreate-via-cc-api CcLambda` flag
 *      in the `seed` phase. It keeps the original scenario's harder case — an
 *      SDK-registered type living on the CC layer, whose destroy BYPASSES the
 *      SDK Provider's `delete()`.
 *
 * Phase env `CDKD_INTEG_PHASE`, set by verify.sh:
 *
 *   - `base` (default): plain deploy. `Discoverer` -> `'cc-api'`, everything
 *     else (incl. `CcLambda`) -> `'sdk'`. `FnArnParam` does not exist yet.
 *   - `seed`: `CcLambda` gains `RuntimeManagementConfig` and is deployed with
 *     `--recreate-via-cc-api CcLambda` -> `'cc-api'`. `FnArnParam` is ADDED,
 *     so its create resolves `Fn::GetAtt(CcLambda, 'Arn')` against the record
 *     the Cloud Control create just wrote.
 *
 * `RuntimeManagementConfig` toggles with the phase as the AWS-side witness of
 * the recreate. It was also the property delta a recreate flag needed before
 * go-to-k/cdkd#2651 was fixed, when a flagged resource whose diff was
 * NO_CHANGE was never provisioned. Both layers handle the property; it is NOT
 * a routing trigger.
 *
 * Cross-references (consumer -> producer):
 *   (A) SDK -> CC GetAtt: `DiscovererIdParam.Value = Fn::GetAtt(Discoverer,
 *       'DiscovererId')`. `DiscovererId` is a read-only attribute, so it exists
 *       in state only through the Cloud Control read-back.
 *   (B) SDK -> CC Ref:    `DiscovererArnParam.Value = Ref(Discoverer)` (the
 *       discoverer ARN, its primary identifier).
 *   (C) CC -> SDK GetAtt: `Discoverer.SourceArn = Fn::GetAtt(Bus, 'Arn')`.
 *   (D) CC -> SDK Ref:    `Discoverer.Description` embeds `Ref(Bus)`.
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

    // --- SDK: EventBridge event bus (the producer the CC discoverer reads) ---
    const bus = new events.CfnEventBus(this, 'Bus', {
      name: 'cdkd-crossref-bus',
    });

    // --- CC (no SDK Provider for the type): EventBridge schema discoverer.
    //     Cross-ref (C): SourceArn = GetAtt(Bus, Arn).
    //     Cross-ref (D): Description embeds Ref(Bus). ---
    const discoverer = new eventschemas.CfnDiscoverer(this, 'Discoverer', {
      sourceArn: bus.attrArn,
      description: cdk.Fn.join('', ['discoverer of ', bus.ref]),
    });

    // --- SDK: cross-ref (A) GetAtt + (B) Ref of the CC-provisioned discoverer ---
    new ssm.CfnParameter(this, 'DiscovererIdParam', {
      name: '/cdkd/crossref/discoverer-id',
      type: 'String',
      value: discoverer.attrDiscovererId,
    });
    new ssm.CfnParameter(this, 'DiscovererArnParam', {
      name: '/cdkd/crossref/discoverer-arn',
      type: 'String',
      value: discoverer.ref,
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
