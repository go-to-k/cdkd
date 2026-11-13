/**
 * go-to-k/cdkd#6146: `cdkd diff`'s twin of the deploy's NoEcho value MAC
 * comparison. A property whose recorded MACs prove a `NoEcho` parameter value
 * it reads changed since the last deploy is shown changed, as the deploy sends
 * it; every other reader keeps the preview it had (the deploy decides it).
 */
import type { CloudFormationTemplate } from '../../../types/resource.js';
import {
  macWriteOnlyKeys,
  readsOnlyNoEchoParameters,
  type MacWriteOnlyLookups,
} from '../../../deployment/deploy-engine/update/noecho-macs.js';
import type { ResourceChange, ResourceState } from '../../../types/state.js';
import {
  maskedInputProof,
  maskedPropertyFingerprint,
  maskedPropertyFingerprintsOf,
  type MaskedInputSources,
} from '../../../deployment/masked-property-fingerprints.js';
import {
  createNoEchoValueMacs,
  noEchoMacBinding,
  noEchoMacParametersOf,
  noEchoMacVerdict,
  noEchoValueMacsOf,
  type NoEchoMac,
  type NoEchoMacClient,
} from '../../../deployment/noecho-value-macs.js';
import type { NoEchoPositionSources } from '../../../deployment/secret-redaction.js';
import { getCreateOnlyPropertyPaths } from '../../../provisioning/create-only-properties.js';

/**
 * Marks, in `changes`, each top-level property whose MACs prove its value
 * moved, and returns them as `<logicalId>.<property>`. Makes NO KMS call
 * unless some unchanged-or-updated record carries `noEchoValueMacs` (one
 * `GenerateMac` per `NoEcho` parameter then), and none for a nested child,
 * whose diff binds a redacted parameter bag. Never throws: no MACs is no
 * verdict.
 *
 * A property counts only where the deploy's comparison would send it: a
 * schema write-only key (the deploy lets a MAC decide only a key AWS does not
 * report; one a readback merely omits, which the deploy also lets a MAC
 * decide, is under-reported here, since the preview reads nothing back), not
 * unsettled, its template text unchanged since the MACs were
 * written (the go-to-k/cdkd#4451 fingerprint), and not create-only (the
 * deploy never replaces on a `NoEcho` parameter's word, maintainer decision 1
 * on #4043). It must read nothing but NoEcho parameters and literals, or
 * (go-to-k/cdkd#6209) have every other input resolved and hashed
 * (`maskedInputProof` over `inputSources`) with no NoEcho value in what they
 * resolved to: then the deploy's positioned guard holds too.
 */
/**
 * One run's NoEcho value MACs per stack binding (`noEchoMacBinding`): no
 * plaintext, keys or values. Never logged.
 */
export type NoEchoMacCache = Map<string, Promise<ReadonlyMap<string, NoEchoMac> | undefined>>;

function macsFor(args: Parameters<typeof previewNoEchoMacChanges>[0]) {
  return (
    createNoEchoValueMacs({
      template: args.template,
      parameterValues: args.parameterValues!,
      stackName: args.stackName,
      region: args.region,
      stackInstanceId: () => args.stackInstanceId,
      logger: args.logger,
      purpose: 'diff',
      ...(args.client !== undefined && { client: args.client }),
    })?.macs() ?? Promise.resolve(undefined)
  );
}

/**
 * Whether every input of `value` other than the NoEcho `parameters` resolves
 * and hashes, and nothing it resolved to holds the value of a NoEcho
 * parameter of the stack (any length: a short one only makes this answer no,
 * the preview it had). The search reads the form's JSON and also its string
 * leaves (object keys included) run together, so a value an `Fn::Join` with an empty delimiter
 * would build from two resolved operands is found too (one joined around a
 * delimiter or `Fn::Sub` text is not: the diff may then claim a send the
 * deploy's positioned guard declines, warning instead). A NoEcho parameter with no bound value here (one
 * this preview could not read) has no needle to search for: no claim. Never
 * throws.
 */
async function resolvesWithoutEcho(
  value: unknown,
  parameters: readonly string[],
  args: Parameters<typeof previewNoEchoMacChanges>[0]
): Promise<boolean> {
  if (args.inputSources === undefined || args.parameterValues === undefined) return false;
  const proof = await maskedInputProof(value, args.inputSources, new Set(parameters)).catch(
    () => undefined
  );
  if (proof === undefined) return false;
  const leaves: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') leaves.push(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node !== null && typeof node === 'object') {
      // A resolved object's KEYS too: the JSON text holds them escaped only.
      for (const [key, child] of Object.entries(node)) {
        leaves.push(key);
        collect(child);
      }
    }
  };
  collect(proof.form);
  const texts = [JSON.stringify(proof.form) ?? '', leaves.join('')];
  for (const name of args.sources.parameters) {
    if (!Object.hasOwn(args.parameterValues, name) || args.parameterValues[name] === undefined) {
      return false;
    }
    const raw = args.parameterValues[name];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const item of values) {
      const needle = typeof item === 'string' ? item : JSON.stringify(item);
      if (needle === undefined || needle.length === 0) continue;
      // A string leaf is in `leaves` raw, so its JSON-escaped spelling needs
      // no search of its own; the JSON text adds keys and non-string values.
      if (texts.some((text) => text.includes(needle))) return false;
    }
  }
  return true;
}

export async function previewNoEchoMacChanges(args: {
  changes: Map<string, ResourceChange>;
  template: CloudFormationTemplate;
  resources: Readonly<Record<string, ResourceState>>;
  parameterValues: Readonly<Record<string, unknown>> | undefined;
  sources: NoEchoPositionSources;
  nestedChild: boolean;
  stackName: string;
  region: string;
  stackInstanceId: string | undefined;
  logger: { debug(message: string): void; info(message: string): void };
  client?: () => NoEchoMacClient;
  cache?: NoEchoMacCache;
  /** One schema write-only lookup per type for the whole run (`cdkd refactor`); else per call. */
  writeOnlyLookups?: MacWriteOnlyLookups;
  /** The input fingerprint's sources (go-to-k/cdkd#4543); absent: only a key reading nothing else. */
  inputSources?: MaskedInputSources;
}): Promise<string[]> {
  if (args.nestedChild || args.parameterValues === undefined) return [];
  if (args.sources.parameters.size === 0) return [];
  const candidates: Array<[string, ResourceChange, ResourceState]> = [];
  for (const [logicalId, change] of args.changes) {
    if (change.changeType !== 'NO_CHANGE' && change.changeType !== 'UPDATE') continue;
    const record = Object.hasOwn(args.resources, logicalId) ? args.resources[logicalId] : undefined;
    if (record === undefined || noEchoValueMacsOf(record).size === 0) continue;
    candidates.push([logicalId, change, record]);
  }
  if (candidates.length === 0) return [];
  // One set of MACs per stack binding per cache: a cache lives for one run of
  // one command, whose parameter values for a stack do not change. Never
  // keyed by a value (no plaintext-keyed bag).
  const cacheKey = noEchoMacBinding(args.stackInstanceId, args.stackName, args.region);
  const cached = args.cache?.get(cacheKey);
  const current = await (cached ?? macsFor(args));
  if (cached === undefined) args.cache?.set(cacheKey, Promise.resolve(current));
  if (current === undefined) return [];
  const moved: string[] = [];
  const writeOnlyLookups: MacWriteOnlyLookups = args.writeOnlyLookups ?? new Map();
  for (const [logicalId, change, record] of candidates) {
    const definition = args.template.Resources?.[logicalId];
    const templateProps = (definition?.Properties ?? {}) as Record<string, unknown>;
    const recorded = noEchoValueMacsOf(record);
    const fingerprints = maskedPropertyFingerprintsOf(record);
    const unsettled = new Set(record.unsettledProperties ?? []);
    // The deploy lets a MAC decide only a key AWS does not report: the
    // schema's write-only keys are the ones this read-only preview can know
    // (unknown is no claim). It reads nothing back, so a key whose type's
    // readback merely omits it (which the deploy also lets a MAC decide) is
    // under-reported here: shown as before, never claimed.
    const writeOnly = await macWriteOnlyKeys(change.resourceType, writeOnlyLookups);
    const keys: string[] = [];
    for (const [key, entry] of recorded) {
      if (!Object.hasOwn(templateProps, key)) continue;
      if (writeOnly?.has(key) !== true || unsettled.has(key)) continue;
      if (fingerprints.get(key) !== maskedPropertyFingerprint(templateProps[key])) continue;
      if ((change.propertyChanges ?? []).some((pc) => pc.path === key)) continue;
      // Only a key every NoEcho leaf of which sits where the template reads a
      // NoEcho parameter (no attribute or other route that could carry the
      // value elsewhere): the deploy's `positioned` guard, decidable here for
      // a key that reads nothing else, or whose every other input resolved to
      // a value holding no NoEcho value.
      const parameters = noEchoMacParametersOf(templateProps[key], args.sources);
      if (noEchoMacVerdict(entry, parameters, current) !== 'changed') continue;
      if (
        readsOnlyNoEchoParameters(templateProps[key], args.sources.parameters) ||
        (await resolvesWithoutEcho(templateProps[key], parameters, args))
      ) {
        keys.push(key);
      }
    }
    if (keys.length === 0) continue;
    const createOnly = await getCreateOnlyPropertyPaths(change.resourceType).catch(
      () => [] as ReadonlyArray<readonly string[]>
    );
    for (const key of keys) {
      if (createOnly.some((path) => path[0] === key)) continue;
      change.propertyChanges = [
        ...(change.propertyChanges ?? []),
        {
          path: key,
          oldValue: change.currentProperties?.[key],
          newValue: change.desiredProperties?.[key],
          requiresReplacement: false,
        },
      ];
      if (change.changeType === 'NO_CHANGE') change.changeType = 'UPDATE';
      moved.push(`${logicalId}.${key}`);
    }
  }
  return moved;
}
