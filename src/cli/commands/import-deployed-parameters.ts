/**
 * UNVERIFIABLE INPUTS for `cdkd import`'s observed-baseline refusal (issue
 * [#2854](https://github.com/go-to-k/cdkd/issues/2854)).
 *
 * `cdkd import` accepts no parameter values, so every template parameter is
 * bound to its `Default`. When the resources were deployed by a CloudFormation
 * stack, the value CloudFormation actually used can differ — and the ordinary
 * secret-carrying shape is a placeholder `Default` (`CHANGEME`) over a DEPLOYED
 * value of `{{resolve:secretsmanager:...}}`. The persisted `properties` then
 * spell no reference anywhere, the position-based redaction of the observed
 * capture has no evidence, and the decrypted readback would be persisted.
 *
 * The remedy here is deliberately PREMISE-INDEPENDENT. It never looks for a
 * `{{resolve:` opener in what `DescribeStacks` returns (AWS documents
 * `ParameterValue` as "the input value", which says the reference comes back
 * literally, but nothing in this module relies on it). It asks one question —
 * "is the deployed value PROVABLY the value this import bound?" — and treats
 * every other answer as divergent: a literal reference, the `****` a `NoEcho`
 * parameter is masked to, a value AWS resolved, a parameter missing from the
 * response, a `DescribeStacks` that failed. All of those differ from the bound
 * placeholder, so all of them refuse.
 *
 * THE DEPLOYED VALUES ARE COMPARISON-ONLY. They are never bound into the
 * resolve, never logged, never put in an error message, and never persisted:
 * binding them is the one design that would leak if AWS ever returned a
 * resolved value. {@link DeployedParameters} holds them in a `#private` field so
 * that a stray `JSON.stringify` / `util.inspect` / template literal of the
 * object renders nothing, and an SDK failure is reported by its error NAME
 * alone, because an SDK message can echo request input.
 *
 * THE DEPENDENCE WALK ITSELF lives in `src/analyzer/parameter-dependence.ts`
 * (`cdkd deploy` reads it too, issue #3468); this module keeps the half that
 * touches AWS and the deployed values.
 *
 * TAINT THROUGH ANOTHER RESOURCE'S ATTRIBUTES IS FOLLOWED within one stack: the
 * walk records the target of every `Fn::GetAtt` / `${A.Attr}`, and the caller
 * closes the refused set over those targets, so a resource reading an attribute
 * of a refused resource (`{Fn::GetAtt: [SsmParam, Value]}` into a Lambda
 * environment — what CDK's `param.stringValue` emits) is refused with it. A
 * plain `Ref` of a resource is NOT followed: it yields the physical id, and a
 * secret used as a resource NAME is already disclosed by the identifier itself.
 *
 * KNOWN RESIDUAL, not followed: taint ACROSS the nested-stack boundary. A
 * parent property reading `Fn::GetAtt: [Child, Outputs.X]`, where the child's
 * output derives from a divergent CHILD parameter, is judged on the parent's
 * own parameters only — the root is resolved before any child is read.
 */

import { DescribeStacksCommand, type CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { coerceParameterTypedValue } from '../../deployment/intrinsic-function-resolver.js';
import { ssmResolvedValueType } from '../../utils/parameter-types.js';
import type { CloudFormationTemplate } from '../../types/resource.js';

/** Minimal logger surface this module needs. */
interface WarnLogger {
  warn(message: string): void;
}

interface DeployedParameterEntry {
  readonly value: string | undefined;
  readonly resolvedValue: string | undefined;
}

/**
 * What CloudFormation reports a stack was deployed with. Opaque on purpose:
 * the only question it answers is {@link DeployedParameters.provablyEquals}.
 */
export class DeployedParameters {
  readonly #entries: ReadonlyMap<string, DeployedParameterEntry> | undefined;

  private constructor(entries: ReadonlyMap<string, DeployedParameterEntry> | undefined) {
    this.#entries = entries;
  }

  /** `DescribeStacks` answered; `entries` is its `Parameters` list. */
  static fromDescribeStacks(
    parameters: readonly {
      ParameterKey?: string | undefined;
      ParameterValue?: string | undefined;
      ResolvedValue?: string | undefined;
    }[]
  ): DeployedParameters {
    const entries = new Map<string, DeployedParameterEntry>();
    for (const parameter of parameters) {
      if (typeof parameter.ParameterKey !== 'string') continue;
      entries.set(parameter.ParameterKey, {
        value: parameter.ParameterValue,
        resolvedValue: parameter.ResolvedValue,
      });
    }
    return new DeployedParameters(entries);
  }

  /** The deployed values could not be read: NOTHING is provable. */
  static unavailable(): DeployedParameters {
    return new DeployedParameters(undefined);
  }

  /**
   * Whether the deployed value of `name` is provably the value the import
   * BOUND. The deployed string goes through the SAME coercion the resolver
   * applied to the bound one (`Number`, `CommaDelimitedList`, `List<...>`), so
   * `'1'` equals a bound `1` and `'a, b'` equals a bound `['a', 'b']`. For an
   * SSM-typed parameter the resolver binds the RESOLVED value, so that is the
   * side compared — `ParameterValue` is only the key there.
   */
  provablyEquals(name: string, type: unknown, bound: unknown): boolean {
    const entry = this.#entries?.get(name);
    if (entry === undefined || typeof type !== 'string') return false;
    const ssmType = type.startsWith('AWS::SSM::Parameter::Value');
    const deployed = ssmType ? entry.resolvedValue : entry.value;
    if (typeof deployed !== 'string') return false;
    const comparedType = ssmType ? ssmResolvedValueType(type) : type;
    const coerced =
      comparedType === undefined ? deployed : coerceParameterTypedValue(deployed, comparedType);
    return stableEquals(coerced, bound);
  }
}

/** Structural equality for the scalar / scalar-array values a parameter binds to. */
function stableEquals(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((element, index) => stableEquals(element, b[index]));
  }
  if (typeof a === 'string' && typeof b === 'number') {
    return Number.isFinite(b) && a === String(b);
  }
  if (typeof a === 'number' || typeof b === 'number') {
    // `NaN` never proves anything: `Number('****')` is `NaN` on both sides of a
    // masked `Number` parameter whose `Default` is also unparseable.
    return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && a === b;
  }
  // A non-string scalar `Default` on a string-typed parameter (`Default: 42`
  // from YAML) is bound as-is by the resolver, while CloudFormation reports the
  // deployed value as its string form.
  if (typeof a === 'string' && typeof b === 'boolean') return a === String(b);
  return typeof a === 'string' && typeof b === 'string' && a === b;
}

/**
 * Read the parameters a CloudFormation stack was deployed with. NEVER throws:
 * a failure returns {@link DeployedParameters.unavailable}, which makes every
 * declared parameter divergent, and warns ONCE with the error's NAME only.
 */
export async function readDeployedParameters(
  cfnStackName: string,
  cfnClient: CloudFormationClient,
  logger: WarnLogger,
  displayName: string
): Promise<DeployedParameters>;
/**
 * `absentStackIsNoSource`: the caller does not KNOW a CloudFormation stack of
 * that name exists (a plain `cdkd import`, any mode). CloudFormation's
 * "does not exist" answer then means there are no deployed values at all —
 * `undefined`, silently — rather than an unreadable stack.
 */
export async function readDeployedParameters(
  cfnStackName: string,
  cfnClient: CloudFormationClient,
  logger: WarnLogger,
  displayName: string,
  options: { absentStackIsNoSource: true }
): Promise<DeployedParameters | undefined>;
export async function readDeployedParameters(
  cfnStackName: string,
  cfnClient: CloudFormationClient,
  logger: WarnLogger,
  displayName: string,
  options?: { absentStackIsNoSource: true }
): Promise<DeployedParameters | undefined> {
  try {
    const response = await cfnClient.send(new DescribeStacksCommand({ StackName: cfnStackName }));
    const stack = response.Stacks?.[0];
    if (!stack) {
      logger.warn(unavailableWarning(displayName, 'the stack was not returned'));
      return DeployedParameters.unavailable();
    }
    return DeployedParameters.fromDescribeStacks(stack.Parameters ?? []);
  } catch (err) {
    // The message is READ here to classify, never rendered. `DescribeStacks`
    // reports a missing stack as `ValidationError: Stack with id <name> does
    // not exist`; any other `ValidationError` stays a failure.
    if (
      options?.absentStackIsNoSource === true &&
      err instanceof Error &&
      err.name === 'ValidationError' &&
      /does not exist/i.test(err.message)
    ) {
      return undefined;
    }
    // NAME ONLY. An SDK message can echo request input, and this module's
    // contract is that nothing read from — or sent to — DescribeStacks reaches
    // a log line.
    const name =
      err instanceof Error && /^[A-Za-z0-9_.]{1,80}$/.test(err.name) ? err.name : 'error';
    logger.warn(unavailableWarning(displayName, name));
    return DeployedParameters.unavailable();
  }
}

function unavailableWarning(displayName: string, reason: string): string {
  return (
    `Could not read the deployed parameter values of CloudFormation stack '${displayName}' ` +
    `(${reason}). 'cdkd import' needs the cloudformation:DescribeStacks permission to prove that ` +
    `a template parameter was deployed with its 'Default'; without it every resource that ` +
    `depends on a template parameter is imported WITHOUT an observed drift baseline. Review ` +
    `'cdkd diff' before the next 'cdkd deploy'.`
  );
}

/**
 * The declared parameters whose deployed value is NOT provably the bound one.
 * A parameter the import could not bind at all (no `Default`, an unreferenced
 * or failed SSM default, the empty fallback bag) is divergent by definition.
 */
export function divergentParameterNames(
  template: CloudFormationTemplate,
  bound: Record<string, unknown>,
  deployed: DeployedParameters
): Set<string> {
  const divergent = new Set<string>();
  const declared = template.Parameters;
  if (declared === undefined || declared === null || typeof declared !== 'object') {
    return divergent;
  }
  for (const [name, definition] of Object.entries(declared as Record<string, unknown>)) {
    const record =
      definition !== null && typeof definition === 'object'
        ? (definition as Record<string, unknown>)
        : undefined;
    const type = record?.['Type'];
    // A `NoEcho` parameter is NEVER provable: `DescribeStacks` answers `****`
    // whatever was deployed, so a `Default` that is literally `****` would
    // otherwise compare equal. The mask is the unverifiable-input signal itself.
    const noEcho = record?.['NoEcho'];
    if (noEcho === true || (typeof noEcho === 'string' && noEcho.toLowerCase() === 'true')) {
      divergent.add(name);
      continue;
    }
    // The `hasOwn` clause states the rule rather than carrying it: an unbound
    // name reads `undefined`, which `provablyEquals` never proves equal either.
    if (!Object.hasOwn(bound, name) || !deployed.provablyEquals(name, type, bound[name])) {
      divergent.add(name);
    }
  }
  return divergent;
}
