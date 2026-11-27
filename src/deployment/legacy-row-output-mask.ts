import type { CloudFormationTemplate } from '../types/resource.js';
import type { StackState } from '../types/state.js';
import { displayIdent, displayStackName } from '../utils/display-safe.js';
import { cdkdRemedy, proseQuoted } from '../utils/pasteable-command.js';
import { SECRET_MASK } from './secret-redaction.js';
import { carriesSecretMask } from './secret-redaction/mask-only.js';
import { readsNoEchoSource } from './secret-redaction/noecho-leaves.js';
import { markNonRetryable } from './retryable-errors.js';
import { NESTED_STACK_RESOURCE_TYPE } from './rollback-executor/types.js';
import type { ChildTemplateLoader } from './masked-property-fingerprints/input-walk.js';
import { childTemplateLoader } from './nested-output-templates.js';
import { getCurrentNestedStackContext } from '../provisioning/nested-stack-context.js';
import {
  mixesDynamicReference,
  taintedNamesOf,
} from '../cli/commands/diff-recursive/passed-secret-display.js';

const OUTPUT_PREFIX = 'Outputs.';

/**
 * go-to-k/cdkd#7097: a nested-stack row record written before cdkd masked a
 * secret-derived child output holds that output's PLAINTEXT in
 * `attributes['Outputs.<K>']`, where a current record holds `***`. Served as
 * it is, a root output reading it (and its export) persisted the plaintext,
 * and every importing stack's deploy plan printed it.
 *
 * This makes such a record behave exactly as a current one, before anything
 * reads it: each `Outputs.<K>` the CHILD template's output `K` derives from a
 * parameter the row passes MIXED with a dynamic reference (#7068's shape) is
 * read as `***`. From there the existing semantics apply unchanged: a root
 * output and its export persist `***`, and a property reading it is refused.
 *
 * Precise by construction: an output of the same row that reads no such
 * parameter keeps its value (masking the whole row would change what
 * consumers import). When the child template cannot be read, so the answer
 * is unknown, the deploy is REFUSED rather than guessed either way.
 */
export function maskLegacyTaintedRowOutputs(
  state: StackState,
  template: CloudFormationTemplate,
  stackName: string,
  childTemplate: ChildTemplateLoader | undefined = childTemplateLoader(
    getCurrentNestedStackContext()?.nestedTemplates
  )
): void {
  const rows = (template.Resources ?? {}) as Record<string, unknown>;
  for (const [logicalId, rawRow] of Object.entries(rows)) {
    const row = rawRow as { Type?: unknown; Properties?: Record<string, unknown> } | null;
    if (row?.Type !== NESTED_STACK_RESOURCE_TYPE) continue;
    const record = Object.hasOwn(state.resources ?? {}, logicalId)
      ? state.resources[logicalId]
      : undefined;
    const attributes = record?.attributes;
    if (attributes === undefined) continue;
    const plainOutputs = Object.keys(attributes).filter(
      (key) =>
        key.startsWith(OUTPUT_PREFIX) &&
        typeof attributes[key] === 'string' &&
        !carriesSecretMask(attributes[key])
    );
    if (plainOutputs.length === 0) continue;
    const mixedKeys = recordedSecretKeys(record?.properties);
    if (mixedKeys.size === 0) continue;
    const child = childTemplate?.(logicalId);
    if (child === undefined) {
      throw refusal(
        stackName,
        logicalId,
        plainOutputs.map((key) => key.slice(OUTPUT_PREFIX.length))
      );
    }
    const childTainted = taintedNamesOf(child.template, mixedKeys);
    const outputs = (child.template.Outputs ?? {}) as Record<string, { Value?: unknown } | null>;
    for (const key of plainOutputs) {
      const name = key.slice(OUTPUT_PREFIX.length);
      if (!Object.hasOwn(outputs, name)) continue;
      const reads = readsNoEchoSource(outputs[name]?.Value, {
        parameters: childTainted,
        attributeIsNoEcho: (id) => childTainted.has(id),
      });
      if (reads) attributes[key] = SECRET_MASK;
    }
  }
}

/**
 * The row's RECORDED `Parameters` keys the deploy that wrote the record
 * treated as secret: a value it persisted as a `{{resolve:...}}` expression
 * beside other text (a secret reference it kept rather than resolved), or as
 * the mask. Decided from the record, never from the template: a PUBLIC
 * `{{resolve:ssm:...}}` reference is resolved and persisted as its value,
 * so its row is no secret's and keeps every output (review: masking it would
 * change what consumers import). A grandchild row reading an inherited mixed
 * parameter is recorded the same way, so a child deploy decides it too.
 */
function recordedSecretKeys(properties: Record<string, unknown> | undefined): Set<string> {
  const keys = new Set<string>();
  const parameters = properties?.['Parameters'];
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return keys;
  }
  for (const [key, value] of Object.entries(parameters as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (mixesDynamicReference(value) || carriesSecretMask(value)) keys.add(key);
  }
  return keys;
}

/** The fallback: the record predates the redaction and nothing can tell which outputs it covers. */
function refusal(stackName: string, rowId: string, outputs: readonly string[]): Error {
  return markNonRetryable(
    new Error(
      `Refusing to deploy ${displayStackName(stackName)}: the record of nested stack ${displayIdent(rowId)} ` +
        `holds output(s) ${outputs.map((output) => displayIdent(output)).join(', ')} as recorded before cdkd masked a ` +
        `secret-derived nested output, and the row passes a parameter mixing a secret ` +
        `reference with other text, but the child template cannot be read to tell which ` +
        `outputs derive from it. Redeploy that nested stack (change a property of the row, or run ` +
        `${proseQuoted(cdkdRemedy('cdkd deploy', '--replace-resource', rowId))} where a replacement is acceptable) ` +
        `so its outputs are recorded again.`
    )
  );
}
