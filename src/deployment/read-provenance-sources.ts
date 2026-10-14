/**
 * The domain members of the diff's read-provenance arm that live OUTSIDE the
 * stack's own records (state schema v12, go-to-k/cdkd#4852), shared by
 * `cdkd deploy` and `cdkd diff` so the two reach the same verdict:
 *
 * - a producer output a cross-stack read resolved in the diff pass
 *   (`ResolverContext.crossStackReads`), its `outputReferenceProvenance`
 *   read through the per-run producer-state cache the consumer's provisioning
 *   reuses (one `GetObject` per producer per run, and none when the read
 *   already held the state);
 * - the provenance a nested-stack row hands its child
 *   ({@link inheritedProvenanceForChildDiff}, `cdkd diff --recursive`'s
 *   derivation of the snapshot the deploy builds).
 */
import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import type { ReferenceProvenance, ResourceState } from '../types/state.js';
import { TemplateParser } from '../analyzer/template-parser.js';
import type { CrossStackRead, ResolverContext } from './intrinsic-resolver/context.js';
import { readProducerStateOnce } from './intrinsic-resolver/cross-stack.js';
import {
  outputReferenceProvenanceOf,
  recordedProvenanceOf,
  referenceProvenanceOf,
  referenceTokensIn,
} from './reference-provenance-record.js';
import { crossStackSourceKey } from './secret-redaction.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every `Fn::ImportValue` / `Fn::GetStackOutput` node of `value`. */
function crossStackNodes(
  value: unknown,
  into: Record<string, unknown>[] = []
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) crossStackNodes(item, into);
    return into;
  }
  if (!isPlainObject(value)) return into;
  const keys = Object.keys(value);
  if (keys.length === 1 && (keys[0] === 'Fn::ImportValue' || keys[0] === 'Fn::GetStackOutput')) {
    into.push(value);
  }
  for (const item of Object.values(value)) crossStackNodes(item, into);
  return into;
}

/**
 * `DiffCalculator`'s `crossStackOutputs` source: the validated output
 * provenance of each producer output `value` read in the diff pass. A read the
 * pass did not record (a non-literal export name, a cross-account read) or a
 * producer that cannot be read contributes nothing (no verdict).
 */
export function crossStackOutputProvenanceSource(
  reads: ReadonlyMap<string, CrossStackRead>,
  scope: object,
  stateBackend: Pick<NonNullable<ResolverContext['stateBackend']>, 'getState'> | undefined
): (value: unknown) => Promise<ReadonlyArray<Record<string, ReferenceProvenance>>> {
  return async (value) => {
    const out: Array<Record<string, ReferenceProvenance>> = [];
    for (const node of crossStackNodes(value)) {
      const key = crossStackSourceKey(node);
      if (key === undefined) continue;
      const read = reads.get(key);
      // A read whose value carried no token holds no provenance: no state read.
      if (read === undefined || !read.carriesToken) continue;
      const state = await readProducerStateOnce(
        scope,
        stateBackend,
        read.stackName,
        read.region,
        () => undefined,
        read.state
      );
      const bag = outputReferenceProvenanceOf(state, read.outputKey);
      if (bag !== undefined) out.push(bag);
    }
    return out;
  };
}

/**
 * The provenance snapshot a nested-stack row would hand its child, derived
 * from the PARENT's records for `cdkd diff --recursive` (go-to-k/cdkd#4852),
 * which resolves no secret (decision 5). The deploy's snapshot is the row's
 * resolution: a token the row READS takes the versions its upstream records
 * hold (the read route's source, design §2.2), and one it spells takes the
 * version it resolves. Here, per token the row's recorded `Parameters` hold:
 * the union of the same-stack upstreams' `versions`, else the row's own
 * recorded entry (a spelled token: the version it was last resolved at).
 *
 * `undefined` for a row the deploy does not provision (the child engine then
 * never runs, so nothing promotes it), or one with no record or no tokens.
 */
export function inheritedProvenanceForChildDiff(args: {
  row: TemplateResource;
  rowRecord: ResourceState | undefined;
  rowProvisioned: boolean;
  parentRecords: Readonly<Record<string, ResourceState>>;
  parentTemplate: CloudFormationTemplate;
}): ReadonlyMap<string, ReferenceProvenance> | undefined {
  const { row, rowRecord, parentRecords, parentTemplate } = args;
  if (!args.rowProvisioned || rowRecord === undefined) return undefined;
  const recordedParameters = isPlainObject(rowRecord.properties)
    ? rowRecord.properties['Parameters']
    : undefined;
  const tokens = referenceTokensIn(recordedParameters);
  if (tokens.size === 0) return undefined;
  const own = referenceProvenanceOf(rowRecord);
  const parser = new TemplateParser();
  const upstreams = [
    ...parser.extractReferences(
      isPlainObject(row.Properties) ? row.Properties['Parameters'] : undefined
    ),
  ].filter((id) => Object.hasOwn(parentTemplate.Resources, id) && Object.hasOwn(parentRecords, id));
  const out = new Map<string, ReferenceProvenance>();
  for (const token of tokens) {
    const versions = new Set<string>();
    let region: string | undefined;
    for (const id of upstreams) {
      const entry = recordedProvenanceOf(parentRecords[id], token);
      for (const version of entry?.versions ?? []) versions.add(version);
      region ??= entry?.region;
    }
    if (versions.size > 0) {
      out.set(token, { ...(region !== undefined && { region }), versions: [...versions].sort() });
      continue;
    }
    const recorded = own !== undefined && Object.hasOwn(own, token) ? own[token] : undefined;
    if (recorded !== undefined) out.set(token, recorded);
  }
  return out.size === 0 ? undefined : out;
}
