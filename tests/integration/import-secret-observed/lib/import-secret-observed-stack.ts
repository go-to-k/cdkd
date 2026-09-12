import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * The plaintext the secret holds, and the needle `verify.sh` greps `state.json`
 * for. Fixed rather than generated so the assertion has something to look for:
 * a generated value would have to be read back out of Secrets Manager, and a
 * failed read would then look like a passing leak check.
 *
 * Distinctive enough that it cannot collide with an ARN, a physical id, or any
 * other literal the state file legitimately holds — a needle that occurs
 * naturally would make the leak assertion fire on a clean run.
 */
export const SECRET_PLAINTEXT = 'cdkd-integ-2828-DECRYPTED-NEEDLE';

/** The JSON key inside the secret; also the key the dynamic reference names. */
export const SECRET_JSON_KEY = 'pw';

/**
 * A SECOND key holding a TWO-character value (issue #2745, third site): below
 * the redaction value scan's four-character needle floor, where the scan makes
 * no claim, so only the span arms on a bag whose provenance is proven can
 * persist a leaf EMBEDDING it as its token. Letters rather than digits so it
 * cannot coincide with a numeric field of a readback; the framed form
 * `port:q7` is what `verify.sh` refuses anywhere in `state.json`.
 */
export const SUB_FLOOR_JSON_KEY = 'pin';
export const SUB_FLOOR_PLAINTEXT = 'q7';

/**
 * Integ probe for issue #2828: `cdkd import`'s `observedProperties` capture.
 *
 * covers: AWS::SecretsManager::Secret
 * covers: AWS::SSM::Parameter
 *
 * WHAT THE UNIT TESTS CANNOT DO, and therefore what this fixture is for. The
 * suite around `captureObservedForImportedResources` mocks the provider, so it
 * pins what `import.ts` DOES with a readback — not what a real provider's
 * `readCurrentState` RETURNS. The value that reaches the redaction on this path
 * in production is a live AWS bag whose shape the mocks assert nothing about.
 *
 * The shape, and why each half is what it is:
 *
 *   - `AWS::SSM::Parameter` is the resource because its provider's
 *     `readCurrentState` really does return `Value`. A resource whose readback
 *     omits the secret-bearing property would make this fixture pass while
 *     exercising nothing — the capture would have no plaintext to mishandle.
 *   - `stringValue` is a `{{resolve:secretsmanager:...}}` dynamic reference
 *     rendered by `secretValueFromJson(...).unsafeUnwrap()`. CloudFormation
 *     resolves it AT DEPLOY, so AWS stores the DECRYPTED value while the
 *     template keeps the token. That divergence is the whole test: `properties`
 *     must hold the token and `observedProperties` must hold the token, while
 *     the live parameter holds the plaintext.
 *   - the parameter has NO explicit name, so `cdkd import` resolves its
 *     physical id through the CloudFormation lookup, which is the ordinary
 *     adoption path rather than an `--resource` short-circuit.
 *
 * The parameter is a plain `String` holding a secret, which is not a pattern to
 * copy in production — it is the cheapest resource type that reproduces
 * "template says token, AWS says plaintext, provider reads it back".
 *
 * `RemovalPolicy.DESTROY` on both, and the secret takes
 * `removalPolicy: DESTROY` WITH no recovery window so teardown leaves nothing
 * in a recovery state for the orphan sweep to find.
 */
export class ImportSecretObservedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const secret = new secretsmanager.Secret(this, 'Secret', {
      description: 'cdkd integ 2828: the secret whose decrypted value must never reach state.json',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({
          [SECRET_JSON_KEY]: SECRET_PLAINTEXT,
          [SUB_FLOOR_JSON_KEY]: SUB_FLOOR_PLAINTEXT,
        })
      ),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // `unsafeUnwrap()` is what renders the reference as a literal
    // `{{resolve:secretsmanager:...}}` token in the template rather than
    // refusing at synth. That token IS the subject of this fixture.
    const param = new ssm.StringParameter(this, 'SecretBearingParam', {
      stringValue: secret.secretValueFromJson(SECRET_JSON_KEY).unsafeUnwrap(),
      description: 'cdkd integ 2828: Value is a dynamic reference, resolved by CFn at deploy',
    });
    param.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Issue #2745, third site: a leaf EMBEDDING the two-character reference in
    // the dominant CDK shape -- `secretValueFromJson` renders the ARN as a
    // `Ref`, so this synthesizes as an `Fn::Join` with the prefix fused into
    // the token's opening part (`["port:{{resolve:secretsmanager:", {Ref},
    // ":SecretString:pin::}}"]`). CloudFormation resolves it to `port:q7` at
    // deploy; `cdkd import` re-resolves the template itself and must persist
    // `port:{{resolve:secretsmanager:<ARN>:SecretString:pin::}}`. Before the
    // fix its own resolution bag was never marked, so below the needle floor
    // the plaintext `port:q7` was persisted.
    const subFloorParam = new ssm.StringParameter(this, 'SubFloorParam', {
      stringValue: `port:${secret.secretValueFromJson(SUB_FLOOR_JSON_KEY).unsafeUnwrap()}`,
      description: 'cdkd integ 2745: Value embeds a two-character dynamic reference',
    });
    subFloorParam.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'ParameterName', { value: param.parameterName });
    new cdk.CfnOutput(this, 'SubFloorParameterName', { value: subFloorParam.parameterName });
    new cdk.CfnOutput(this, 'SecretArn', { value: secret.secretArn });
  }
}
