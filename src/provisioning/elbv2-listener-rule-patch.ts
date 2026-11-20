import { isDeepStrictEqual } from 'node:util';
import type { JsonPatchOp } from './json-patch-generator.js';

const LISTENER_RULE_TYPE = 'AWS::ElasticLoadBalancingV2::ListenerRule';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One condition without its legacy top-level `Values` when a `*Config`
 * member holds the same `Values` (the read-back echo). Anything else,
 * including a `Values` that differs from the config's, is returned as is.
 */
function withoutEchoedValues(condition: unknown): unknown {
  if (!isPlainObject(condition) || !Object.prototype.hasOwnProperty.call(condition, 'Values')) {
    return condition;
  }
  const echoed = Object.entries(condition).some(
    ([key, value]) =>
      key.endsWith('Config') &&
      isPlainObject(value) &&
      isDeepStrictEqual(value['Values'], condition['Values'])
  );
  if (!echoed) return condition;
  const { Values: _echo, ...rest } = condition;
  return rest;
}

function conditionsToSend(value: unknown): unknown {
  return Array.isArray(value) ? value.map(withoutEchoedValues) : value;
}

/**
 * Extend a Cloud Control update patch for
 * `AWS::ElasticLoadBalancingV2::ListenerRule` so the conditions reach
 * `ModifyRule` in one spelling (go-to-k/cdkd#6663).
 *
 * Cloud Control applies the patch on top of the model its read handler
 * returns, and that model carries each `path-pattern` / `host-header`
 * condition twice: the legacy `Values` and the `PathPatternConfig` /
 * `HostHeaderConfig` CDK synthesizes. `ModifyRule` refuses both together
 * ("You cannot provide both Values and 'PathPatternConfig'"), so a patch that
 * changes only `Actions` or `Priority` failed although the template did not
 * change the conditions. CloudFormation sends the template's model.
 *
 * A non-empty patch with no op on `/Conditions` gets `add /Conditions` (which
 * replaces the member, RFC 6902) with the desired list; an existing `add` /
 * `replace` there keeps its op. Either value has each condition's top-level
 * `Values` dropped where a `*Config` member holds the same `Values`: a
 * template never declares both (AWS refuses them), and `cdkd drift --revert`'s
 * desired bag is the read-back snapshot, which always does. No AWS call is
 * added.
 *
 * Every other type, an empty patch, or a desired bag without a `Conditions`
 * list returns the same array.
 */
export function withListenerRuleConditionOps(
  resourceType: string,
  patch: JsonPatchOp[],
  desired: Record<string, unknown>
): JsonPatchOp[] {
  if (resourceType !== LISTENER_RULE_TYPE || patch.length === 0) return patch;
  const existing = patch.findIndex((op) => op.path === '/Conditions');
  if (existing !== -1) {
    const op = patch[existing]!;
    if (op.op !== 'add' && op.op !== 'replace') return patch;
    return patch.map((o, i) => (i === existing ? { ...o, value: conditionsToSend(o.value) } : o));
  }
  if (!Array.isArray(desired['Conditions'])) return patch;
  return [
    ...patch,
    { op: 'add', path: '/Conditions', value: conditionsToSend(desired['Conditions']) },
  ];
}
