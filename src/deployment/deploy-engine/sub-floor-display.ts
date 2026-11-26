import { attributionRefusedParameters } from '../secret-redaction/nested-stack/parameter-tables.js';
import { literalTextHoldsSubFloorSecret } from '../secret-redaction/positions.js';
import {
  calculatorMaskingPassedSecretLines,
  taintedNamesOf,
} from '../../cli/commands/diff-recursive/passed-secret-display.js';
import type { DiffCalculator } from '../../analyzer/diff-calculator.js';
import type { RecordedSecretValues } from '../secret-redaction.js';
import type { CloudFormationTemplate } from '../../types/resource.js';

/** Does any string leaf under `value` hold a sub-floor secret's text outside its spans? */
function holdsSubFloorText(value: unknown, secrets: RecordedSecretValues): boolean {
  if (typeof value === 'string') return literalTextHoldsSubFloorSecret(value, secrets);
  if (Array.isArray(value)) return value.some((item) => holdsSubFloorText(item, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((item) => holdsSubFloorText(item, secrets));
  }
  return false;
}

/**
 * go-to-k/cdkd#7050: the names a nested child's deploy must DISPLAY as `***`.
 * A parameter the parent marked `sub-floor` with no certified spelling is
 * persisted as `***`, but its diff binding keeps the value scan's answer
 * (`xq7:{{resolve:...}}`), whose text still holds a secret under the scan's
 * floor: masking it there plans a phantom change. So the comparison keeps it,
 * and every line that prints a value read from it (the `--verbose`
 * replacement line, the `broadening` security table) is masked by
 * PROVENANCE, as `cdkd diff` masks it (`passed-secret-display.ts`): those
 * parameters, and each resource reading one, to a fixed point. Empty when
 * nothing qualifies, so every other deploy prints as before.
 */
export function subFloorDisplayTainted(
  template: CloudFormationTemplate,
  diffParameters: Record<string, unknown>,
  inheritedSecrets: RecordedSecretValues | undefined
): Set<string> {
  if (inheritedSecrets === undefined) return new Set();
  const marks = attributionRefusedParameters.get(inheritedSecrets);
  if (marks === undefined) return new Set();
  const passed = new Set<string>();
  for (const [name, value] of Object.entries(diffParameters)) {
    if (marks.get(name) === 'sub-floor' && holdsSubFloorText(value, inheritedSecrets))
      passed.add(name);
  }
  return passed.size === 0 ? passed : taintedNamesOf(template, passed);
}

/**
 * `calculator` with its `--verbose` replacement line masked for `tainted`
 * (`calculatorMaskingPassedSecretLines`), as the deploy's diff runs it. Every
 * write the calculator makes lands on `calculator` itself, so an instance
 * the caller holds sees what its run recorded. `calculator` itself when
 * nothing is tainted.
 */
export function deployCalculatorMaskingSubFloorLines(
  calculator: DiffCalculator,
  template: CloudFormationTemplate,
  tainted: ReadonlySet<string>
): DiffCalculator {
  const masked = calculatorMaskingPassedSecretLines(calculator, template, tainted);
  if (masked === calculator) return calculator;
  return new Proxy(calculator, {
    get: (target, property, receiver) =>
      property === 'logger' ? masked.logger : Reflect.get(target, property, receiver),
    set: (target, property, value) => Reflect.set(target, property, value),
  });
}
