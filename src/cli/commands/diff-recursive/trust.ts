import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceChange, StackState } from '../../../types/state.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import type { NodeTrust } from './types.js';

/**
 * Pseudo parameters whose value a deploy of the same stack cannot change
 * (go-to-k/cdkd#4479). Any other pseudo parameter is not trusted.
 */
export const STABLE_PSEUDO_PARAMETERS: ReadonlySet<string> = new Set([
  'AWS::Region',
  'AWS::AccountId',
  'AWS::Partition',
  'AWS::StackName',
  'AWS::URLSuffix',
]);

/**
 * The one DEFAULT-DENY classifier behind a node's trust (go-to-k/cdkd#4479).
 * A value is trusted only when every leaf it reads is
 * - a literal (a string carrying a public `{{resolve:ssm:...}}` excluded: the
 *   diff resolves that live);
 * - a stable pseudo parameter ({@link STABLE_PSEUDO_PARAMETERS}) or
 *   `AWS::NoValue`;
 * - a parameter in `parameters`;
 * - the CHOSEN branch of an `Fn::If`, or a `{Condition: X}`, on a condition in
 *   `conditions`;
 * - a `Ref` / `Fn::GetAtt` / `${X}` / `${X.Attr}` the `resourceLeaf`
 *   callback trusts;
 * combined only through `Fn::Join` / `Fn::Select` / `Fn::Split` / `Fn::Sub`
 * / `Fn::Base64` / `Fn::FindInMap`, and (when `plainObjects`) plain
 * containers. Anything else (an unknown intrinsic, a cross-stack read, a
 * structure this cannot classify) is not trusted.
 */
function makeTrustClassifier(options: {
  parameters: ReadonlySet<string>;
  conditions: ReadonlySet<string>;
  bag: Record<string, boolean> | undefined;
  resourceLeaf: (logicalId: string, attribute: string | undefined) => boolean;
  plainObjects: boolean;
}): (value: unknown) => boolean {
  const { parameters, conditions, bag, resourceLeaf, plainObjects } = options;
  const conditionTrusted = (name: unknown): name is string =>
    typeof name === 'string' &&
    conditions.has(name) &&
    bag !== undefined &&
    Object.hasOwn(bag, name);
  const nameTrusted = (name: string, locals: ReadonlySet<string>): boolean => {
    if (locals.has(name)) return true;
    if (STABLE_PSEUDO_PARAMETERS.has(name) || name === 'AWS::NoValue') return true;
    if (parameters.has(name)) return true;
    const dot = name.indexOf('.');
    if (dot > 0) return resourceLeaf(name.slice(0, dot), name.slice(dot + 1));
    return resourceLeaf(name, undefined);
  };
  const literalTrusted = (text: string): boolean => !text.includes('{{resolve:ssm:');
  const subTrusted = (template: unknown, locals: ReadonlySet<string>): boolean => {
    if (typeof template !== 'string' || !literalTrusted(template)) return false;
    for (const match of template.matchAll(/\$\{([^}]*)\}/g)) {
      const name = match[1]!;
      if (name.startsWith('!')) continue;
      if (!nameTrusted(name.trim(), locals)) return false;
    }
    return true;
  };
  const walk = (node: unknown): boolean => {
    if (typeof node === 'string') return literalTrusted(node);
    if (typeof node === 'number' || typeof node === 'boolean' || node === null) return true;
    if (Array.isArray(node)) return node.every(walk);
    if (typeof node !== 'object') return false;
    const keys = Object.keys(node);
    const key = keys[0];
    const intrinsic =
      keys.length === 1 &&
      key !== undefined &&
      (key === 'Ref' || key === 'Condition' || key.startsWith('Fn::'));
    if (!intrinsic) {
      return plainObjects && Object.values(node as Record<string, unknown>).every(walk);
    }
    const operand = (node as Record<string, unknown>)[key];
    switch (key) {
      case 'Ref':
        return typeof operand === 'string' && nameTrusted(operand, new Set());
      case 'Condition':
        return conditionTrusted(operand);
      case 'Fn::GetAtt': {
        const [logicalId, attribute] = Array.isArray(operand)
          ? operand
          : typeof operand === 'string'
            ? [operand.slice(0, operand.indexOf('.')), operand.slice(operand.indexOf('.') + 1)]
            : [];
        return (
          typeof logicalId === 'string' &&
          typeof attribute === 'string' &&
          logicalId.length > 0 &&
          resourceLeaf(logicalId, attribute)
        );
      }
      case 'Fn::If': {
        if (!Array.isArray(operand) || operand.length !== 3) return false;
        const [condition, whenTrue, whenFalse] = operand as [unknown, unknown, unknown];
        if (!conditionTrusted(condition)) return false;
        return walk(bag![condition] ? whenTrue : whenFalse);
      }
      case 'Fn::Sub': {
        if (typeof operand === 'string') return subTrusted(operand, new Set());
        if (!Array.isArray(operand) || operand.length !== 2) return false;
        const [template, variables] = operand as [unknown, unknown];
        if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return false;
        if (!Object.values(variables).every(walk)) return false;
        return subTrusted(template, new Set(Object.keys(variables)));
      }
      case 'Fn::Join':
      case 'Fn::Select':
      case 'Fn::Split':
      case 'Fn::Base64':
      case 'Fn::FindInMap':
        return walk(operand);
      default:
        return false;
    }
  };
  return walk;
}

/**
 * A resource LEAF: a trusted resource's physical id, or an attribute its
 * record HOLDS. A nested stack's attributes are excluded: its outputs can
 * move with no change to its row.
 */
function trustedResourceLeaf(
  trustedResources: ReadonlySet<string>,
  state: StackState
): (logicalId: string, attribute: string | undefined) => boolean {
  return (logicalId, attribute) => {
    if (!trustedResources.has(logicalId)) return false;
    const record = Object.hasOwn(state.resources, logicalId)
      ? state.resources[logicalId]
      : undefined;
    if (!record) return false;
    if (attribute === undefined) {
      return typeof record.physicalId === 'string' && record.physicalId.length > 0;
    }
    if (record.resourceType === NESTED_STACK_RESOURCE_TYPE) return false;
    return record.attributes !== undefined && Object.hasOwn(record.attributes, attribute);
  };
}

/**
 * The resources of this node the next deploy leaves as they are recorded
 * (go-to-k/cdkd#4479): `NO_CHANGE` here, AND every leaf of the entry that
 * change was computed from (`Properties`, `Condition`, `DeletionPolicy`,
 * `UpdateReplacePolicy`) trusted, a resource leaf only through a resource
 * already in the set. A `NO_CHANGE` computed over a guessed binding is no
 * evidence. A LEAST fixpoint, so a reference cycle is never trusted.
 */
export function trustedResourceNames(
  template: CloudFormationTemplate,
  state: StackState,
  changes: ReadonlyMap<string, ResourceChange>,
  parameters: ReadonlySet<string>,
  conditions: ReadonlySet<string>,
  bag: Record<string, boolean> | undefined
): Set<string> {
  const trusted = new Set<string>();
  const entries = Object.entries((template.Resources ?? {}) as Record<string, unknown>).filter(
    ([logicalId, entry]) =>
      changes.get(logicalId)?.changeType === 'NO_CHANGE' &&
      Object.hasOwn(state.resources, logicalId) &&
      entry !== null &&
      typeof entry === 'object'
  );
  const classify = makeTrustClassifier({
    parameters,
    conditions,
    bag,
    resourceLeaf: trustedResourceLeaf(trusted, state),
    plainObjects: true,
  });
  let grew = true;
  while (grew) {
    grew = false;
    for (const [logicalId, entry] of entries) {
      if (trusted.has(logicalId)) continue;
      const record = entry as Record<string, unknown>;
      const read = [
        record['Condition'] === undefined ? undefined : { Condition: record['Condition'] },
        record['Properties'],
        record['DeletionPolicy'],
        record['UpdateReplacePolicy'],
      ];
      if (read.every((part) => part === undefined || classify(part))) {
        trusted.add(logicalId);
        grew = true;
      }
    }
  }
  return trusted;
}

/**
 * Whether a nested-stack row value is one this diff KNOWS the next deploy
 * passes (go-to-k/cdkd#4479): {@link makeTrustClassifier} over the parent
 * node's trust, a resource leaf only through `trust.resources`. A row value is
 * a scalar or an intrinsic, so a plain object is not trusted. The child's
 * recorded-verdict fingerprint never reads an untrusted key; the comparison
 * binding is unaffected.
 */
export function rowValueTrusted(
  value: unknown,
  parentState: StackState,
  parentConditions: Record<string, boolean> | undefined,
  trust: NodeTrust
): boolean {
  return makeTrustClassifier({
    parameters: trust.parameters,
    conditions: trust.conditions,
    bag: parentConditions,
    resourceLeaf: trustedResourceLeaf(trust.resources, parentState),
    plainObjects: false,
  })(value);
}
