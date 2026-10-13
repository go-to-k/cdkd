/**
 * The ONE-TIME migration capture of state schema v12 (go-to-k/cdkd#4847 /
 * go-to-k/cdkd#4852, design section 4).
 *
 * A record a v11 binary wrote holds `{{resolve:...}}` tokens and no
 * `referenceProvenance`. A deploy that WRITES it records the field from its
 * own resolution; one that leaves it `NO_CHANGE` would never learn it. So the
 * first v12 deploy resolves each such record's TEMPLATE `Properties` once, in
 * a throwaway context, and keeps:
 *
 * - `region` for each token the resolution attributes without conflict;
 * - `versions` only where the record's physical id contains the token's
 *   current plaintext (the generation proof of go-to-k/cdkd#4804);
 * - `readVersions` never: an equal reference cannot prove a reader is fresh.
 *
 * It sends nothing and changes no `properties` / `attributes` leaf: only the
 * field is added. OFF THE CRITICAL PATH: kicked off after the diff, it runs
 * beside provisioning and is drained with the observed captures before a
 * save. Failure classes:
 *
 * - success: the entries;
 * - definitive (not found, access denied, a refused region, a conflict,
 *   nothing to attribute): `{}` for each token it could not attribute, and one
 *   warning per record naming the record (never the token). Final: the record
 *   keeps the v11 reading until its next write;
 * - throttling after the lookup's own retries: the field stays ABSENT, so the
 *   next deploy retries that record. The only retry.
 *
 * The context mirrors the masked-input fingerprint pass
 * (`resolver-context.ts`): its own bag, no heal, no `imports` / `outputReads`
 * recorder, the stale-attribute probe phase (a physical-id guess throws
 * rather than warns), a print-only needle bag, and no `perResourceSecrets`
 * entry. `provenanceCapture` suppresses the one warning the deploy's own
 * resolution of the same record already prints.
 */
import type { DeployEngine } from '../deploy-engine.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ReferenceProvenance, ResourceState, StackState } from '../../types/state.js';
import { isThrottlingError } from '../retryable-errors.js';
import { safeMsg } from '../../utils/display-safe.js';
import { MIN_NEEDLE_LENGTH } from '../secret-redaction.js';
import { type RecordedSecretValues, resolvedPlaintextOf } from '../secret-redaction/pairs.js';
import { passProvenanceFor } from '../secret-redaction/reference-provenance.js';
import {
  hasReferenceProvenanceField,
  recordReferenceTokens,
  validateReferenceProvenance,
} from '../reference-provenance-record.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    kickOffProvenanceCapture: OmitThisParameter<typeof kickOffProvenanceCapture>;
    /** @internal */
    drainProvenanceCaptures: OmitThisParameter<typeof drainProvenanceCaptures>;
  }
}

/** What one record's capture produced. `field: undefined` leaves the field absent. */
export interface ProvenanceCaptureOutcome {
  /** The record the capture read. */
  record: ResourceState;
  field: Record<string, ReferenceProvenance> | undefined;
}

/**
 * Start the capture for every `NO_CHANGE` record in `noChange` that holds a
 * token and has no field. The caller has already applied the token-free fast
 * path; this still skips a record with the field (`{}` included) in O(1) and
 * a token-free record in one walk.
 *
 * ONE record at a time, in a single background chain: the resolver's value
 * cache then answers every later record holding a token an earlier one
 * resolved, so the capture costs at most one lookup per distinct token per
 * region, and it never competes with the deploy's own lookups in a burst.
 */
export function kickOffProvenanceCapture(
  this: DeployEngine,
  args: {
    noChange: readonly string[];
    resources: Readonly<Record<string, ResourceState>>;
    template: CloudFormationTemplate;
    parameters: Record<string, unknown> | undefined;
    conditions: Record<string, boolean> | undefined;
    stackName: string;
  }
): void {
  const { noChange, resources, template } = args;
  let chain: Promise<unknown> = Promise.resolve();
  for (const logicalId of noChange) {
    const record = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
    if (record === undefined || hasReferenceProvenanceField(record)) continue;
    const tokens = recordReferenceTokens(record);
    if (tokens.size === 0) continue;
    const definition = Object.hasOwn(template.Resources, logicalId)
      ? template.Resources[logicalId]
      : undefined;
    const properties = definition?.Properties ?? {};
    const task = chain
      .then(() => captureOne(this, logicalId, record, tokens, properties, args))
      // `captureOne` classifies every lookup failure itself (throttling
      // absent, anything else `{}`); this keeps a rejection out of the chain
      // and leaves the field absent, the v11 reading.
      .catch((): ProvenanceCaptureOutcome => ({ record, field: undefined }));
    chain = task;
    this.provenanceCaptureTasks.set(logicalId, task);
  }
}

function warnUnattributed(engine: DeployEngine, logicalId: string): void {
  engine.logger.warn(
    safeMsg`Could not record where the secret reference(s) in ${logicalId} were resolved (state schema v12 migration). cdkd keeps its previous handling of them; update ${logicalId} to record it.`
  );
}

async function captureOne(
  engine: DeployEngine,
  logicalId: string,
  record: ResourceState,
  tokens: ReadonlySet<string>,
  properties: Record<string, unknown>,
  args: {
    resources: Readonly<Record<string, ResourceState>>;
    template: CloudFormationTemplate;
    parameters: Record<string, unknown> | undefined;
    conditions: Record<string, boolean> | undefined;
    stackName: string;
  }
): Promise<ProvenanceCaptureOutcome> {
  const bag: RecordedSecretValues = new Map();
  const { attributeHealer: _healer, ...base } = engine.buildResolverContext(
    {
      template: args.template,
      resources: { ...args.resources },
      ...(args.parameters && { parameters: args.parameters }),
      ...(args.conditions && { conditions: args.conditions }),
    },
    args.stackName
  );
  const { producerSecrets: _producer, ...withoutRecorders } = base;
  const context = {
    ...withoutRecorders,
    recordedSecretValues: bag,
    recordedImports: [],
    recordedOutputReads: [],
    staleAttributeHeal: { phase: 'probe' as const },
    printingSecrets: new Map<string, string>(),
    provenanceCapture: true as const,
  };
  // One top-level property at a time, and only one whose stored value holds a
  // token: a property that cannot resolve leaves ITS tokens unattributed and
  // the rest are still captured, and a token-free one costs nothing.
  const stored = record.properties ?? {};
  for (const [key, value] of Object.entries(properties)) {
    if (
      !Object.hasOwn(stored, key) ||
      recordReferenceTokens({ properties: stored[key] }).size === 0
    ) {
      continue;
    }
    try {
      await engine.resolver.resolve(structuredClone(value), context);
    } catch (error) {
      if (isThrottlingError(error)) return { record, field: undefined };
    }
  }
  const physicalId = typeof record.physicalId === 'string' ? record.physicalId.toLowerCase() : '';
  const field: Record<string, ReferenceProvenance> = {};
  let unattributed = false;
  for (const token of [...tokens].sort()) {
    const pass = passProvenanceFor(bag, token);
    const plaintext = resolvedPlaintextOf(bag, token);
    const named =
      plaintext !== undefined &&
      plaintext.length >= MIN_NEEDLE_LENGTH &&
      physicalId.includes(plaintext.toLowerCase());
    const entry =
      validateReferenceProvenance(token, {
        ...(pass?.region !== undefined && { region: pass.region }),
        ...(named && pass?.versions !== undefined && { versions: pass.versions }),
      }) ?? {};
    if (entry.region === undefined && entry.versions === undefined) unattributed = true;
    field[token] = entry;
  }
  if (unattributed) warnUnattributed(engine, logicalId);
  return { record, field };
}

/**
 * Install every finished capture onto its record when that record still names
 * the same resource. Returns how many it installed, so the no-change path
 * saves only when one landed. Nothing gives a record the field between the
 * kick-off (which skipped every record holding one) and here, and a record
 * this deploy WROTE needs no exclusion: the persist writer replaces the field
 * of every written record with this pass's answer.
 */
export async function drainProvenanceCaptures(
  this: DeployEngine,
  stateResources: Record<string, ResourceState>
): Promise<number> {
  if (this.provenanceCaptureTasks.size === 0) return 0;
  const entries = [...this.provenanceCaptureTasks.entries()];
  this.provenanceCaptureTasks.clear();
  const outcomes = await Promise.all(entries.map(([, task]) => task));
  let installed = 0;
  for (let i = 0; i < entries.length; i++) {
    const logicalId = entries[i]![0];
    const { record, field } = outcomes[i]!;
    if (field === undefined) continue;
    const target = Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId] : undefined;
    if (
      target === undefined ||
      target.physicalId !== record.physicalId ||
      target.resourceType !== record.resourceType
    ) {
      continue;
    }
    stateResources[logicalId] = { ...target, referenceProvenance: field };
    installed++;
  }
  return installed;
}

/**
 * The loaded record's outputs bag and its `outputReferenceProvenance`, for a
 * save that carries that bag forward (`DeployEngine.provenanceBaseline`), and
 * whether the record was read off the token-free fast path.
 */
export function provenanceBaselineOf(
  state: Pick<StackState, 'outputs' | 'outputReferenceProvenance'>,
  tokenFree: boolean
): NonNullable<DeployEngine['provenanceBaseline']> {
  return {
    outputs: state.outputs,
    ...(state.outputReferenceProvenance !== undefined && {
      outputReferenceProvenance: state.outputReferenceProvenance,
    }),
    tokenFree,
  };
}
