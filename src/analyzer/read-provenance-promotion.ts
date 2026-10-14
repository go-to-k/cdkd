/**
 * The diff's READ-PROVENANCE arm (state schema v12, go-to-k/cdkd#4852): a
 * reader whose recorded `readVersions` are not a subset of what its upstreams
 * record NOW was left on an older generation of a secret-derived value (an
 * interrupted deploy, a nested child, a cross-stack consumer, a producer
 * updated in place in an earlier run). Its template equals its record, so the
 * diff calls it `NO_CHANGE`; this arm promotes it from RECORDS alone, with no
 * AWS call (decision 5), and the deploy engine's skip term then sends it only
 * when the versions it is served moved (`read-provenance-moved.ts`).
 *
 * Rule, per token `t` with `readVersions[t]` on the reader's record: the
 * UPSTREAM DOMAIN is every member the reader's template reads —
 *
 * - a same-stack record (`Ref` / `Fn::GetAtt` / `Fn::Sub`): its `versions[t]`;
 * - a template parameter, in a nested child engine: the inherited snapshot's
 *   `versions[t]`;
 * - a producer output (`Fn::ImportValue` / `Fn::GetStackOutput`):
 *   `outputReferenceProvenance[key][t].versions`.
 *
 * Promote when `readVersions[t]` is not a subset of the union. NO member
 * holding `versions[t]` is no verdict (S2), never the empty set. A record with
 * no field, or no `readVersions`, is never promoted: the v11 diff.
 */
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ReferenceProvenance, ResourceState, StackState } from '../types/state.js';
import {
  recordedProvenanceOf,
  referenceProvenanceOf,
  referenceTokensIn,
} from '../deployment/reference-provenance-record.js';
import { TemplateParser } from './template-parser.js';

/** Where the domain members outside this stack's records come from. */
export interface ReadProvenanceSources {
  /**
   * A nested child engine's: the reference provenance the parent row's
   * resolution recorded (`DeployEngineOptions.inheritedReferenceProvenance`),
   * the upstream of every token reaching a record through a parameter.
   */
  inherited?: ReadonlyMap<string, ReferenceProvenance>;
  /**
   * The validated `outputReferenceProvenance` entry of each producer output
   * `value` reads through `Fn::ImportValue` / `Fn::GetStackOutput`, one bag
   * per read (an unknown one omitted). Called once per reader holding
   * `readVersions` whose template reads across stacks, and never otherwise:
   * it may read the producer's state (go-to-k/cdkd#4852 performance budget).
   */
  crossStackOutputs?: (
    value: unknown
  ) => Promise<ReadonlyArray<Record<string, ReferenceProvenance>>>;
}

/** One property of a promoted reader, with the same-stack resources it reads. */
export interface ReadProvenancePromotion {
  logicalId: string;
  /** The top-level template keys to mark, each with the same-stack resource ids it reads. */
  keys: Array<{ key: string; upstreams: string[] }>;
  /** The tokens whose recorded read versions the domain no longer holds (for the log). */
  tokens: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Does `value` hold a `Fn::ImportValue` / `Fn::GetStackOutput` at any depth? */
export function readsAcrossStacks(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(readsAcrossStacks);
  if (!isPlainObject(value)) return false;
  if (Object.hasOwn(value, 'Fn::ImportValue') || Object.hasOwn(value, 'Fn::GetStackOutput')) {
    return true;
  }
  return Object.values(value).some(readsAcrossStacks);
}

/** The tokens of `record` that carry a non-empty `readVersions`, with that set. */
function recordedReadVersions(record: unknown): Map<string, readonly string[]> | undefined {
  if (!isPlainObject(record) || !Object.hasOwn(record, 'referenceProvenance')) return undefined;
  const field = referenceProvenanceOf(record);
  if (field === undefined) return undefined;
  let out: Map<string, readonly string[]> | undefined;
  for (const [token, entry] of Object.entries(field)) {
    if (entry.readVersions !== undefined && entry.readVersions.length > 0) {
      (out ??= new Map()).set(token, entry.readVersions);
    }
  }
  return out;
}

/** What one reader's template reads, per top-level key. */
interface KeyReads {
  key: string;
  value: unknown;
  /** Same-stack resource ids. */
  resources: string[];
  /** Template parameters. */
  parameters: boolean;
  /** `Fn::ImportValue` / `Fn::GetStackOutput`. */
  crossStack: boolean;
}

/**
 * The read-provenance promotions of `changes`: every `NO_CHANGE` or `UPDATE`
 * row whose record holds `readVersions` the upstream domain no longer holds.
 * O(1) per record without the field; a cross-stack lookup only for a reader
 * holding `readVersions` whose template reads another stack.
 */
export async function readProvenancePromotions(args: {
  rows: Iterable<{ logicalId: string; changeType: string }>;
  currentState: StackState;
  desiredTemplate: CloudFormationTemplate;
  sources: ReadProvenanceSources | undefined;
  parser?: TemplateParser;
}): Promise<ReadProvenancePromotion[]> {
  const { currentState, desiredTemplate, sources } = args;
  const parser = args.parser ?? new TemplateParser();
  const records = currentState.resources;
  const parameters = isPlainObject(desiredTemplate.Parameters)
    ? desiredTemplate.Parameters
    : undefined;
  const out: ReadProvenancePromotion[] = [];
  for (const { logicalId, changeType } of args.rows) {
    if (changeType !== 'NO_CHANGE' && changeType !== 'UPDATE') continue;
    const record: ResourceState | undefined = Object.hasOwn(records, logicalId)
      ? records[logicalId]
      : undefined;
    const readVersions = recordedReadVersions(record);
    if (readVersions === undefined) continue;
    const resource = Object.hasOwn(desiredTemplate.Resources, logicalId)
      ? desiredTemplate.Resources[logicalId]
      : undefined;
    const properties = isPlainObject(resource?.Properties) ? resource.Properties : {};

    const reads: KeyReads[] = [];
    for (const [key, value] of Object.entries(properties)) {
      const referenced = [...parser.extractReferences(value)].filter((id) => id !== logicalId);
      const resourceIds = referenced.filter((id) => Object.hasOwn(desiredTemplate.Resources, id));
      const readsParameter =
        parameters !== undefined && referenced.some((id) => Object.hasOwn(parameters, id));
      const crossStack = readsAcrossStacks(value);
      if (resourceIds.length === 0 && !readsParameter && !crossStack) continue;
      reads.push({ key, value, resources: resourceIds, parameters: readsParameter, crossStack });
    }
    if (reads.length === 0) continue;

    // The cross-stack members: read once per reader, and only here.
    let crossStackBags: ReadonlyArray<Record<string, ReferenceProvenance>> = [];
    if (sources?.crossStackOutputs !== undefined) {
      const crossValues = reads.filter((r) => r.crossStack).map((r) => r.value);
      if (crossValues.length > 0) crossStackBags = await sources.crossStackOutputs(crossValues);
    }
    const upstreamIds = new Set(reads.flatMap((r) => r.resources));
    const readsAnyParameter = reads.some((r) => r.parameters);

    const moved: string[] = [];
    for (const [token, recorded] of readVersions) {
      const domain = new Set<string>();
      let member = false;
      const join = (versions: readonly string[] | undefined): void => {
        if (versions === undefined || versions.length === 0) return;
        member = true;
        for (const version of versions) domain.add(version);
      };
      for (const id of upstreamIds) {
        const upstream = Object.hasOwn(records, id) ? records[id] : undefined;
        join(recordedProvenanceOf(upstream, token)?.versions);
      }
      if (readsAnyParameter && sources?.inherited !== undefined) {
        join(sources.inherited.get(token)?.versions);
      }
      for (const bag of crossStackBags) {
        if (Object.hasOwn(bag, token)) join(bag[token]?.versions);
      }
      // S2: no member holding the token's versions is NO verdict.
      if (!member) continue;
      if (recorded.some((version) => !domain.has(version))) moved.push(token);
    }
    if (moved.length === 0) continue;

    // The keys whose RECORDED value holds a moved token and whose template
    // reads something: the read-derived leaves a send would rewrite.
    const recordProperties = isPlainObject(record?.properties) ? record.properties : {};
    const keys: ReadProvenancePromotion['keys'] = [];
    for (const r of reads) {
      if (!Object.hasOwn(recordProperties, r.key)) continue;
      const held = referenceTokensIn(recordProperties[r.key]);
      if (!moved.some((token) => held.has(token))) continue;
      keys.push({ key: r.key, upstreams: r.resources });
    }
    if (keys.length === 0) continue;
    out.push({ logicalId, keys, tokens: moved });
  }
  return out;
}
