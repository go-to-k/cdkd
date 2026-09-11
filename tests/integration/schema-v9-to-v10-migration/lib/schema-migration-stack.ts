import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Schema v9 → v10 migration integ fixture (issue
 * [#2944](https://github.com/go-to-k/cdkd/issues/2944)).
 *
 * covers: AWS::SSM::Parameter
 *
 * TWO RESOURCES, because every "the marked one was NOT refreshed" assertion in
 * `verify.sh` has to sit beside "the control one WAS refreshed in the same
 * run" — otherwise the assertion passes equally when the command failed
 * outright, wrote nothing, or never reached AWS.
 *
 *   MarkedProbe   the SUBJECT. Its `Value` is an `Fn::If` on a condition that
 *                 `cdkd import` is STRUCTURALLY unable to evaluate, whose TRUE
 *                 branch is a `{{resolve:secretsmanager:...}}` reference and
 *                 whose FALSE branch is a placeholder literal.
 *   ControlProbe  the CONTROL. A plain literal `Value`, no condition, same
 *                 provider (so `readCurrentState` exists for it too), never
 *                 refused.
 *
 * HOW THE REFUSAL IS DRIVEN FOR REAL, rather than planted. `cdkd import`
 * accepts no parameter VALUES (there is no `--parameters` flag on it), so a
 * template parameter with NO `Default` cannot be bound:
 * `resolveImportedProperties` sees `resolveParameters` throw, retries over the
 * `Default`-carrying parameters alone (issue #2321), and `SecretsEnabled` stays
 * unbound. `evaluateConditions` then catches per condition and records
 * `SecretsOn: false`, so the `Fn::If` selects the FALSE branch: the resolve
 * SUCCEEDS, the persisted `properties.Value` is the placeholder literal, and
 * the `{{resolve:` opener COUNT drops from 1 to 0 — arm 2 of
 * `resolveImportedProperties`' refusal (the discarded TRUE branch is also not
 * provably inert, so arm 3 agrees). `captureObservedForImportedResources` then
 * skips the baseline and, since schema v10, records
 * `observedBaselineRefused: true` on the record.
 *
 * That is exactly the shape `ResourceState.observedBaselineRefused`'s own doc
 * describes: "a downgraded `Fn::If` persisting `dev-placeholder` where AWS
 * holds the secret the deployed branch resolved". `verify.sh` creates the live
 * parameter OUT OF BAND holding the real secret plaintext, so the AWS readback
 * really does carry it and the pre-v10 refill really is a disclosure.
 *
 * THE PHASE KNOB, and why the parameter's `Default` moves with it.
 * `CDKD_TEST_SCHEMA_PHASE` selects one of three templates:
 *
 *   import         `SecretsEnabled` has NO `Default`. This is the ONLY shape
 *                  that downgrades the condition, and therefore the only one
 *                  that produces the refusal.
 *   deploy         `SecretsEnabled` gets `Default: 'false'`. A plain
 *                  `cdkd deploy` REFUSES an unbindable parameter up front
 *                  (`resolveParameters` throws before the resolver is reached),
 *                  so the deploy phases cannot use the import shape. The
 *                  default is `'false'`, so the condition evaluates to the SAME
 *                  verdict the import downgraded to and the resolved
 *                  `properties` are BYTE-IDENTICAL to the imported ones — which
 *                  is what makes the deploy a NO_CHANGE for `MarkedProbe`, the
 *                  precondition for exercising the auto-refresh skip at all.
 *   deploy-update  same, with a DIFFERENT false-branch literal, so the marked
 *                  resource takes a genuine UPDATE and the marker must clear.
 *
 * An unknown phase THROWS rather than defaulting: a silent default would make
 * whichever phase mistyped it assert against the wrong template while still
 * reading as green.
 *
 * Nothing here varies a `Description` by phase (unlike the v8 → v9 fixture,
 * which does exactly that to force a write): a phase-varying description would
 * turn the NO_CHANGE deploy into an UPDATE of BOTH resources and silently
 * retire the arm this fixture exists for.
 *
 * SSM Parameter is the resource for the same reason `import-secret-observed`
 * picked it: `SSMParameterProvider.readCurrentState` really does return
 * `Value`, so a readback that mishandles the secret has something to mishandle.
 * A plain `String` parameter holding a secret is not a production pattern — it
 * is the cheapest resource that reproduces "template says one thing, AWS holds
 * the decrypted other, and the provider reads it back".
 */

/** The SUBJECT parameter — the one `cdkd import` must refuse a baseline for. */
export const MARKED_PARAM_NAME = '/cdkd/schema-v9-to-v10-migration/marked';

/** The CONTROL parameter — ordinary literal, never refused. */
export const CONTROL_PARAM_NAME = '/cdkd/schema-v9-to-v10-migration/control';

/**
 * The Secrets Manager secret the TRUE branch references. Created out of band by
 * `verify.sh` (this fixture never declares it, so nothing here can leak its
 * plaintext into a synthesized template) and never actually resolved by cdkd —
 * the condition is `false` in every phase, and `resolveIf` resolves only the
 * SELECTED branch.
 */
export const SECRET_NAME = 'cdkd/schema-v9-to-v10-migration/secret';

/** The control's templated value. `verify.sh` moves the LIVE value away from it. */
export const CONTROL_TEMPLATE_VALUE = 'control-template-literal';

/** The `Fn::If` FALSE branch — what the downgraded condition persists. */
export const FALSE_BRANCH_LITERAL = 'dev-placeholder';

/** The `deploy-update` phase's false branch, so the marked resource really changes. */
export const FALSE_BRANCH_LITERAL_UPDATED = 'dev-placeholder-updated';

type Phase = 'import' | 'deploy' | 'deploy-update';

function phase(): Phase {
  const raw = process.env['CDKD_TEST_SCHEMA_PHASE'] ?? 'import';
  if (raw !== 'import' && raw !== 'deploy' && raw !== 'deploy-update') {
    throw new Error(
      `Unknown CDKD_TEST_SCHEMA_PHASE '${raw}' — expected one of: import, deploy, deploy-update. ` +
        `Refusing rather than defaulting: a silent default would synthesize a template the ` +
        `calling phase is not asserting against, and the run would still read as green.`
    );
  }
  return raw;
}

export class SchemaV9ToV10MigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const current = phase();

    // The unbindable parameter. `cdkd import` can bind nothing, so in the
    // `import` phase this is what downgrades `SecretsOn` to false. The deploy
    // phases MUST give it a Default — `cdkd deploy` fails up front on a
    // Default-less parameter — and `'false'` keeps the resolved properties
    // identical to the imported ones.
    const secretsEnabled = new cdk.CfnParameter(this, 'SecretsEnabled', {
      type: 'String',
      allowedValues: ['true', 'false'],
      description:
        'Whether the marked parameter takes its value from Secrets Manager. ' +
        'Deliberately has no Default in the import phase so cdkd import cannot bind it.',
      ...(current === 'import' ? {} : { default: 'false' }),
    });

    const secretsOn = new cdk.CfnCondition(this, 'SecretsOn', {
      expression: cdk.Fn.conditionEquals(secretsEnabled.valueAsString, 'true'),
    });

    const falseBranch =
      current === 'deploy-update' ? FALSE_BRANCH_LITERAL_UPDATED : FALSE_BRANCH_LITERAL;

    // THE SUBJECT. `cdkd import` resolves this to `falseBranch`, loses the
    // `{{resolve:` opener the raw bag spells, and refuses the observed
    // baseline — recording `observedBaselineRefused: true` (schema v10+).
    new ssm.CfnParameter(this, 'MarkedProbe', {
      type: 'String',
      name: MARKED_PARAM_NAME,
      value: cdk.Fn.conditionIf(
        secretsOn.logicalId,
        `{{resolve:secretsmanager:${SECRET_NAME}:SecretString}}`,
        falseBranch
      ).toString(),
      description:
        'cdkd schema v9->v10 integ: the REFUSED resource. AWS holds the secret the deployed ' +
        'branch resolved; the recorded properties hold the downgraded false-branch literal.',
    });

    // THE CONTROL. Same type, same provider, no condition and no reference —
    // so every refusal arm is false for it and every refresh must reach it.
    new ssm.CfnParameter(this, 'ControlProbe', {
      type: 'String',
      name: CONTROL_PARAM_NAME,
      value: CONTROL_TEMPLATE_VALUE,
      description:
        'cdkd schema v9->v10 integ: the CONTROL resource. Never refused, so a run in which ' +
        'the marked resource was skipped is distinguishable from one that did nothing at all.',
    });
  }
}
