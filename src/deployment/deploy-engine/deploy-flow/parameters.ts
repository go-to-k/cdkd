import { freshNoEchoParameters } from '../masking.js';
import { poisonRenderedSpellingsCollidingIn } from '../../intrinsic-resolver/parameter-secrets.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { parameterInputsFor } from '../../masked-property-fingerprints.js';
import { childTemplateLoader } from '../../nested-output-templates.js';
import { noEchoParameterValueSeed } from '../../outputs-export-alias.js';
import { getCurrentNestedStackContext } from '../../../provisioning/nested-stack-context.js';
import { hasMaskableValues } from '../../secret-redaction.js';
import type { DeployEngine } from '../../deploy-engine.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';

/**
 * Step 2.5 of a deploy: the parameter values, and the per-run secret state
 * derived from them (moved from `deploy-flow.ts`).
 */
export async function resolveDeployParameters(
  engine: DeployEngine,
  template: CloudFormationTemplate
): Promise<{
  parameterValues: Record<string, unknown>;
  backfillNoEchoValues: ReturnType<typeof noEchoParameterValueSeed>;
}> {
  // 2.5. Resolve parameters from template and user input
  // The inherited bag travels into `resolveParameters` as well as into the
  // per-resource contexts below (issue #1903 review round 2). This is the
  // seam where the PARENT's already-decrypted values first enter the child
  // engine, so it is where both the `--verbose` parameter lines are masked
  // and where a declared `Type` that would coerce the value out of cdkd's
  // string-keyed redaction model is refused.
  const parameterValues = await engine.resolver.resolveParameters(
    template,
    engine.options.parameters,
    {
      // `hasMaskableValues` (go-to-k/cdkd#1998): only the `--verbose`
      // lines read a bag holding log-only needles alone here; the
      // coercion refusal asks `size` itself.
      ...(engine.options.inheritedSecrets &&
        hasMaskableValues(engine.options.inheritedSecrets) && {
          inheritedSecrets: engine.options.inheritedSecrets,
        }),
    }
  );
  engine.logger.debug(
    safeMsg`Resolved ${Object.keys(parameterValues).length} parameters: ${Object.keys(parameterValues).join(', ')}`
  );
  // Issue #4731: before the diff binding and any resource resolution, so
  // both read one answer per parameter whatever order resources resolve in.
  poisonRenderedSpellingsCollidingIn(template, parameterValues, engine.options.inheritedSecrets);
  // go-to-k/cdkd#4043 (review round 9): a nested child positions each
  // parameter carrying its parent's `NoEcho` value as a `NoEcho` one, from
  // here on (every save, the journal, the outputs pass).
  engine.noEchoRun.inheritedNoEchoParameters = new Set([
    ...(freshNoEchoParameters(engine.maskingDeps(), parameterValues) ?? []),
    ...(engine.options.passedNoEchoParameters ?? []),
  ]);
  // go-to-k/cdkd#4451: a masked property with no fingerprint (every one an
  // older cdkd recorded) takes today's template's, which is what this
  // deploy's unchanged comparison concludes AWS holds anyway, so the deploy
  // sends what it sent before and the next edit is seen. Saved by the
  // no-change path too. After the parameters, so a template literal equal to
  // a `NoEcho` parameter's value is refused a hash here rather than
  // persisted; before the diff and the orphan adoption, which read it.
  const backfillNoEchoValues = noEchoParameterValueSeed(
    template.Parameters,
    parameterValues,
    engine.options.inheritedSecrets,
    engine.options.parameters
  );
  // The save reads the same corpus for a record it stamps or carries.
  engine.secretsRun.fingerprintNoEchoValues = backfillNoEchoValues;
  // go-to-k/cdkd#4543: how each parameter enters a masked property's INPUT
  // fingerprint, decided once from the REAL values so the diff pass (which
  // binds a nested child's redacted bag) and the provisioning arms agree.
  engine.secretsRun.fingerprintParameters = parameterInputsFor({
    template,
    values: parameterValues,
    nestedChild: engine.options.parentStackInfo !== undefined,
    supplied: engine.options.parameters,
    passedClasses: engine.options.passedParameterClasses,
  });
  // go-to-k/cdkd#4565: the nested-stack templates one level below this
  // stack, from the assembly the surrounding nested-stack context carries
  // (the top-level run's `StackInfo.nestedTemplates`, or the provider's
  // index for a child). The loader is built once here, never from inside a
  // fingerprint walk; each file is read on first use and cached for the
  // rest of this deploy.
  engine.secretsRun.fingerprintChildTemplates = childTemplateLoader(
    getCurrentNestedStackContext()?.nestedTemplates
  );
  return { parameterValues, backfillNoEchoValues };
}
