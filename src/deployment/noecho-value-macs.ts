/**
 * go-to-k/cdkd#6146: a keyed MAC of each `NoEcho` parameter value a resource
 * property was last sent, so a write-only property fed by a `NoEcho` parameter
 * is re-sent only when the value changed, as CloudFormation compares the
 * previous parameter values.
 *
 * - The MAC is KMS `GenerateMac` (`HMAC_SHA_256`) under the cdkd-managed HMAC
 *   key `cdkd bootstrap` creates ({@link NOECHO_MAC_KEY_ALIAS}). The key never
 *   leaves KMS, so a reader of the state file cannot test a guess against a
 *   stored MAC without `kms:GenerateMac` on that key: unlike a salted hash
 *   kept in state (rejected by #3729 as a confirm oracle), nothing in state
 *   verifies a value.
 * - The message is domain-separated and bound to the stack and the parameter
 *   ({@link noEchoMacMessage}), so a MAC from another stack or parameter never
 *   matches.
 * - One `GenerateMac` per `NoEcho` parameter per run, memoized, the first one
 *   resolving the key's ARN and the rest in parallel. Nothing runs until a
 *   resource that reads a `NoEcho` parameter asks.
 * - No key, no permission, a throttle, a timeout or an AWS Emulator target is
 *   NO MAC: the comparison answers `'none'` and the deploy behaves as before
 *   (the property is re-sent). A failure logs only the error `name`; neither a
 *   value nor a MAC ever reaches a log line or an error message.
 */
import { timingSafeEqual } from 'node:crypto';
import { GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';
import { ambientClientDefaults } from '../utils/ambient-client-defaults.js';
import { awsEndpointOverrideActive } from '../utils/aws-client-defaults.js';
import { safeMsg } from '../utils/display-safe.js';
import type { ResourceState } from '../types/state.js';
import {
  isWrittenFromDeployedTemplate,
  maskedPropertyInputFingerprintsOf,
} from './masked-property-fingerprints.js';
import { noEchoParametersReadBy, type NoEchoPositionSources } from './secret-redaction.js';
import { declaresNoEcho } from './noecho-declared.js';

/** The alias of the HMAC key `cdkd bootstrap` creates in each region it bootstraps. */
export const NOECHO_MAC_KEY_ALIAS = 'alias/cdkd-noecho-mac';

/** The prefix of a persisted MAC: `kms-hmac-sha256:<keyArn>:<base64 mac>`. */
const MAC_PREFIX = 'kms-hmac-sha256:';

/** The domain tag of the MAC message, versioned so a future layout never collides. */
const MAC_DOMAIN = 'cdkd-noecho-mac/v1';

/** `GenerateMac` takes at most 4096 bytes of message. */
const MAX_MESSAGE_BYTES = 4096;

/** How long the run's MACs may take before the deploy goes on without them. */
const MAC_TIMEOUT_MS = 10_000;

/** One parameter value's MAC: the key that made it and the 32 MAC bytes. */
export interface NoEchoMac {
  keyArn: string;
  mac: Buffer;
}

/**
 * The bytes `GenerateMac` is asked to MAC for `parameter`'s `value` in the
 * stack `binding` names: `cdkd-noecho-mac/v1 \0 <binding> \0 <parameter> \0
 * <s|j> \0 <value>`: `s` and the string, or `j` and the JSON text of
 * anything else (a list parameter). `undefined` when it exceeds the 4096-byte
 * limit (no MAC: the property keeps the re-send).
 */
export function noEchoMacMessage(
  binding: string,
  parameter: string,
  value: unknown
): Buffer | undefined {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') return undefined;
  // Type-tagged, so a list's JSON text never collides with an equal string.
  const kind = typeof value === 'string' ? 's' : 'j';
  const message = Buffer.from(`${MAC_DOMAIN}\0${binding}\0${parameter}\0${kind}\0${text}`, 'utf8');
  return message.length > MAX_MESSAGE_BYTES ? undefined : message;
}

/** The persisted spelling of `mac`. */
export function formatNoEchoMac(mac: NoEchoMac): string {
  return `${MAC_PREFIX}${mac.keyArn}:${mac.mac.toString('base64')}`;
}

/** A persisted MAC read back, or `undefined` for anything malformed. */
export function parseNoEchoMac(text: unknown): NoEchoMac | undefined {
  if (typeof text !== 'string' || !text.startsWith(MAC_PREFIX)) return undefined;
  const rest = text.slice(MAC_PREFIX.length);
  const cut = rest.lastIndexOf(':');
  if (cut <= 0) return undefined;
  const keyArn = rest.slice(0, cut);
  const encoded = rest.slice(cut + 1);
  if (!keyArn.startsWith('arn:') || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  const mac = Buffer.from(encoded, 'base64');
  return mac.length === 0 ? undefined : { keyArn, mac };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * go-to-k/cdkd#6209: the member of a property's MAC entry that binds it to the
 * input fingerprint (`inputs-sha256:...`) of the deploy that sent the value,
 * stamped only for a property that reads more than `NoEcho` parameters and
 * whose every other input was resolved and hashed then. No parameter name can
 * spell it (CloudFormation parameter names are alphanumeric), and its value is
 * an OBJECT (`{ fingerprint }`): an older cdkd reads only string members of an
 * entry ({@link noEchoValueMacsOf}), so it never counts it, and every entry
 * it rebuilds or keeps drops it; a record it does not write keeps it beside
 * the MACs it describes.
 */
export const NOECHO_MAC_INPUT_BINDING = 'cdkd:inputs';

/** The persisted spelling of a binding member. */
export interface NoEchoMacInputBinding {
  fingerprint: string;
}

/** The input-fingerprint prefix a binding must carry (`INPUT_FINGERPRINT_PREFIX`). */
const BINDING_PREFIX = 'inputs-sha256:';

/**
 * A record's MAC-entry input bindings by property (go-to-k/cdkd#6209), read
 * tolerantly: a malformed member is no binding (the property then settles
 * only as a key reading nothing but `NoEcho` parameters would).
 */
export function noEchoMacInputBindingsOf(record: unknown): Map<string, string> {
  const read = new Map<string, string>();
  if (!isPlainRecord(record)) return read;
  const field = (record as { noEchoValueMacs?: unknown }).noEchoValueMacs;
  if (!isPlainRecord(field)) return read;
  for (const [key, entry] of Object.entries(field)) {
    if (!isPlainRecord(entry) || !Object.hasOwn(entry, NOECHO_MAC_INPUT_BINDING)) continue;
    const member = entry[NOECHO_MAC_INPUT_BINDING];
    const fingerprint = isPlainRecord(member) ? member['fingerprint'] : undefined;
    if (typeof fingerprint === 'string' && fingerprint.startsWith(BINDING_PREFIX)) {
      read.set(key, fingerprint);
    }
  }
  return read;
}

/**
 * A record's `noEchoValueMacs`, read tolerantly: a malformed field, entry or
 * value is absent (no MAC: the property keeps the re-send). Only string
 * members are read: the input binding ({@link NOECHO_MAC_INPUT_BINDING}) is
 * an object, read by {@link noEchoMacInputBindingsOf}; a STRING member of
 * that name is malformed and counts here, so the entry names another
 * parameter set and gives no verdict.
 */
export function noEchoValueMacsOf(record: unknown): Map<string, Map<string, string>> {
  const read = new Map<string, Map<string, string>>();
  if (!isPlainRecord(record)) return read;
  const field = (record as { noEchoValueMacs?: unknown }).noEchoValueMacs;
  if (!isPlainRecord(field)) return read;
  for (const [key, entry] of Object.entries(field)) {
    if (!isPlainRecord(entry)) continue;
    const macs = new Map<string, string>();
    for (const [parameter, mac] of Object.entries(entry)) {
      if (typeof mac === 'string') macs.set(parameter, mac);
    }
    if (macs.size > 0) read.set(key, macs);
  }
  return read;
}

/**
 * What the recorded MACs of one property say about today's values:
 *
 * - `'confirmed'` — every parameter the property reads has a recorded MAC
 *   under the same key, equal (constant time) to today's: the value it was
 *   last sent is the value it would be sent now.
 * - `'changed'` — the same, with at least one MAC different: a value moved.
 * - `'none'` — no verdict (no MAC on either side, another key after a key
 *   change, or a different parameter set): the caller keeps its behaviour
 *   without one.
 */
export type NoEchoMacVerdict = 'confirmed' | 'changed' | 'none';

export function noEchoMacVerdict(
  recorded: ReadonlyMap<string, string> | undefined,
  parameters: readonly string[],
  current: ReadonlyMap<string, NoEchoMac> | undefined
): NoEchoMacVerdict {
  if (recorded === undefined || current === undefined || parameters.length === 0) return 'none';
  if (recorded.size !== new Set(parameters).size) return 'none';
  let differs = false;
  for (const parameter of parameters) {
    const before = parseNoEchoMac(recorded.get(parameter));
    const now = current.get(parameter);
    if (before === undefined || now === undefined || before.keyArn !== now.keyArn) return 'none';
    if (before.mac.length !== now.mac.length || !timingSafeEqual(before.mac, now.mac)) {
      differs = true;
    }
  }
  return differs ? 'changed' : 'confirmed';
}

/** The persisted entry for a property reading `parameters`, or `undefined` unless every one has a MAC. */
export function noEchoValueMacsFor(
  parameters: readonly string[],
  current: ReadonlyMap<string, NoEchoMac> | undefined
): Record<string, string> | undefined {
  if (current === undefined || parameters.length === 0) return undefined;
  const entries: Array<[string, string]> = [];
  for (const parameter of parameters) {
    const mac = current.get(parameter);
    if (mac === undefined) return undefined;
    entries.push([parameter, formatNoEchoMac(mac)]);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** The slice of a KMS client this module calls (a test double implements it). */
export interface NoEchoMacClient {
  send(
    command: GenerateMacCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<{
    Mac?: Uint8Array;
    KeyId?: string;
  }>;
  destroy(): void;
}

/** What {@link NoEchoValueMacs} needs from its caller. */
export interface NoEchoValueMacsOptions {
  /** The stack's region: the key lives where the stack is bootstrapped. */
  region: string;
  /** The stack the MAC is bound to (read when the first MAC is made). */
  binding: () => string;
  /** The bound parameter values, by name. */
  values: Readonly<Record<string, unknown>>;
  /** The `NoEcho` parameter names (a nested child's inherited ones too). */
  parameters: ReadonlySet<string>;
  logger: { debug(message: string): void; info(message: string): void };
  /** Builds the KMS client; a real one in the stack's region by default. */
  client?: () => NoEchoMacClient;
  /** `'diff'`: a failure is logged at debug in the preview's words, not the deploy's. */
  purpose?: 'deploy' | 'diff';
}

/**
 * One deploy's (or diff's) MACs of its `NoEcho` parameter values, made on the
 * first {@link macs} call and memoized for the run.
 */
export class NoEchoValueMacs {
  private pending: Promise<ReadonlyMap<string, NoEchoMac> | undefined> | undefined;
  private result: ReadonlyMap<string, NoEchoMac> | undefined;
  private readonly options: NoEchoValueMacsOptions;

  constructor(options: NoEchoValueMacsOptions) {
    this.options = options;
  }

  /** The run's MACs by parameter name, or `undefined` when there are none. Never rejects. */
  macs(): Promise<ReadonlyMap<string, NoEchoMac> | undefined> {
    this.pending ??= this.compute().then(
      (macs) => {
        this.result = macs;
        return macs;
      },
      () => undefined
    );
    return this.pending;
  }

  /** The MACs once {@link macs} has settled (the save reads them synchronously). */
  settled(): ReadonlyMap<string, NoEchoMac> | undefined {
    return this.result;
  }

  private async compute(): Promise<ReadonlyMap<string, NoEchoMac> | undefined> {
    const { values, parameters, logger, region } = this.options;
    const names = [...parameters]
      .filter((name) => Object.hasOwn(values, name) && values[name] !== undefined)
      .sort();
    if (names.length === 0) return undefined;
    if (awsEndpointOverrideActive()) {
      logger.debug(
        'NoEcho value MACs: not made against an AWS Emulator target; a write-only property a NoEcho parameter feeds is re-sent on every deploy'
      );
      return undefined;
    }
    const binding = this.options.binding();
    const messages: Array<[string, Buffer]> = [];
    for (const name of names) {
      const message = noEchoMacMessage(binding, name, values[name]);
      if (message !== undefined) messages.push([name, message]);
    }
    if (messages.length === 0) return undefined;
    const client =
      this.options.client?.() ??
      (new KMSClient({ ...ambientClientDefaults(), region }) as unknown as NoEchoMacClient);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), MAC_TIMEOUT_MS);
    timer.unref?.();
    const generate = async (keyId: string, message: Buffer): Promise<NoEchoMac | undefined> => {
      const out = await client.send(
        new GenerateMacCommand({ KeyId: keyId, Message: message, MacAlgorithm: 'HMAC_SHA_256' }),
        { abortSignal: abort.signal }
      );
      if (out.Mac === undefined || out.Mac.length === 0 || typeof out.KeyId !== 'string') {
        return undefined;
      }
      return { keyArn: out.KeyId, mac: Buffer.from(out.Mac) };
    };
    try {
      // The first call resolves the alias to the key's ARN; the rest name the
      // ARN, so every MAC of the run comes from the same key.
      const [first, ...rest] = messages;
      const head = await generate(NOECHO_MAC_KEY_ALIAS, first![1]);
      if (head === undefined) return undefined;
      // Settled one by one: a parameter whose call failed (a throttle) has no
      // MAC, and only a property reading it loses its verdict and its entry.
      const tail = await Promise.allSettled(
        rest.map(([, message]) => generate(head.keyArn, message))
      );
      const macs = new Map<string, NoEchoMac>([[first![0], head]]);
      let failure: unknown;
      rest.forEach(([name], i) => {
        const settled = tail[i]!;
        if (settled.status === 'rejected') {
          failure ??= settled.reason;
          return;
        }
        if (settled.value !== undefined && settled.value.keyArn === head.keyArn) {
          macs.set(name, settled.value);
        }
      });
      if (failure !== undefined) {
        const missing = `${rest.length + 1 - macs.size} of ${rest.length + 1}`;
        const name = errorNameOf(failure, abort.signal.aborted);
        if (this.options.purpose === 'diff') {
          logger.debug(
            safeMsg`cdkd diff: ${missing} NoEcho value MACs unavailable (${name} from kms:GenerateMac); the preview cannot compare a property reading one`
          );
        } else {
          logger.info(
            safeMsg`NoEcho value MACs: ${missing} unavailable (${name} from kms:GenerateMac); a write-only property reading one is re-sent.`
          );
        }
      }
      return macs;
    } catch (error) {
      const name = errorNameOf(error, abort.signal.aborted);
      if (this.options.purpose === 'diff') {
        // A read-only diff role often lacks the permission the deploy role
        // has: the preview says so at debug and compares as before.
        logger.debug(
          safeMsg`cdkd diff: NoEcho value MACs unavailable (${name} from kms:GenerateMac on ${NOECHO_MAC_KEY_ALIAS} in ${region}); the preview does not compare them`
        );
      } else if (name === 'NotFoundException') {
        logger.debug(
          safeMsg`NoEcho value MACs: no KMS key ${NOECHO_MAC_KEY_ALIAS} in ${region} (run 'cdkd bootstrap' to create it); a write-only property a NoEcho parameter feeds is re-sent on every deploy`
        );
      } else {
        logger.info(
          safeMsg`NoEcho value MACs unavailable (${name} from kms:GenerateMac on ${NOECHO_MAC_KEY_ALIAS} in ${region}): a write-only property a NoEcho parameter feeds is re-sent on every deploy. Grant the deploying identity kms:GenerateMac on that key to compare the values instead.`
        );
      }
      return undefined;
    } finally {
      clearTimeout(timer);
      client.destroy();
    }
  }
}

/** An error's `name` when it is a plain identifier, never its message. */
function errorNameOf(error: unknown, aborted: boolean): string {
  if (aborted) return 'TimeoutError';
  const raw = (error as { name?: unknown } | null)?.name;
  return typeof raw === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(raw) ? raw : 'Error';
}

/**
 * What the MAC message binds a stack by: its stack instance id when the record
 * has one, else its name and region (a legacy stack, forever). The deploy and
 * `cdkd diff` derive it alike, so a MAC one stamps the other can compare.
 */
export function noEchoMacBinding(
  stackInstanceId: string | undefined,
  stackName: string,
  region: string
): string {
  return stackInstanceId !== undefined
    ? `instance\0${stackInstanceId}`
    : `legacy\0${stackName}\0${region}`;
}

/**
 * The run's {@link NoEchoValueMacs}, or `undefined` when the template declares
 * no `NoEcho` parameter (and no nested-child parameter inherits one): such a
 * stack never builds a KMS client.
 */
export function createNoEchoValueMacs(args: {
  template: { Parameters?: unknown };
  parameterValues: Readonly<Record<string, unknown>>;
  inherited?: ReadonlySet<string>;
  stackName: string;
  region: string;
  stackInstanceId: () => string | undefined;
  logger: { debug(message: string): void; info(message: string): void };
  client?: () => NoEchoMacClient;
  purpose?: 'deploy' | 'diff';
}): NoEchoValueMacs | undefined {
  const declared = args.template.Parameters;
  const parameters = new Set<string>(args.inherited ?? []);
  if (declared !== null && typeof declared === 'object') {
    for (const [name, definition] of Object.entries(declared)) {
      if (declaresNoEcho(definition)) parameters.add(name);
    }
  }
  if (parameters.size === 0) return undefined;
  return new NoEchoValueMacs({
    region: args.region,
    binding: () => noEchoMacBinding(args.stackInstanceId(), args.stackName, args.region),
    values: args.parameterValues,
    parameters,
    logger: args.logger,
    ...(args.client !== undefined && { client: args.client }),
    ...(args.purpose !== undefined && { purpose: args.purpose }),
  });
}

/**
 * The NoEcho parameters `templateValue` reads, sorted, or `[]` with no
 * sources. The ONE answer to "which MACs does this property need", for the
 * save, the deploy's comparison and `cdkd diff`.
 */
export function noEchoMacParametersOf(
  templateValue: unknown,
  sources: NoEchoPositionSources | undefined
): string[] {
  if (sources === undefined || sources.parameters.size === 0) return [];
  return noEchoParametersReadBy(templateValue, sources).sort();
}

/**
 * The save's stamp (go-to-k/cdkd#6146): `persisted` with its `noEchoValueMacs`
 * rebuilt when `writtenBag` (the in-memory record's `properties`) was written
 * by this deploy, one entry per top-level property of `templateProps` that
 * reads a `NoEcho` parameter and has every MAC in `current`. A property in
 * `kept` (the provider left it unsent, go-to-k/cdkd#6140's stop-gap) keeps
 * its previous entry, which still describes what AWS holds, its input
 * binding included. A record this deploy did not write (a skip, a failed
 * update) carries its field as it was.
 *
 * `inputBindings` (go-to-k/cdkd#6209): per property, the input fingerprint
 * THIS deploy resolved it with, present only when every non-`NoEcho` input
 * was resolved and hashed; a rebuilt entry carries it beside its MACs, so the
 * binding is always the one of the deploy whose value the MACs describe. It
 * is stamped only while equal to the input fingerprint `persisted` itself
 * holds for the key (`maskedPropertyInputFingerprints`, stamped by the same
 * save): that stamp refuses a template whose text holds a secret's value, so
 * the binding never hashes one either.
 */
export function withNoEchoValueMacs(
  persisted: ResourceState,
  writtenBag: unknown,
  templateProps: Record<string, unknown> | undefined,
  sources: NoEchoPositionSources | undefined,
  current: ReadonlyMap<string, NoEchoMac> | undefined,
  kept?: ReadonlySet<string>,
  inputBindings?: ReadonlyMap<string, string>
): ResourceState {
  if (!isWrittenFromDeployedTemplate(writtenBag)) return persisted;
  if (templateProps === undefined) {
    // Written, with no template to read: nothing vouches for a carried entry.
    if (persisted.noEchoValueMacs === undefined) return persisted;
    const { noEchoValueMacs: _dropped, ...without } = persisted;
    return without as ResourceState;
  }
  const previous = noEchoValueMacsOf(persisted);
  // Read only when a kept entry or a binding needs them.
  let previousBindings: Map<string, string> | undefined;
  let stamped: ReadonlyMap<string, string> | undefined;
  const entries: Array<[string, Record<string, string | NoEchoMacInputBinding>]> = [];
  const withBinding = (
    entry: Record<string, string>,
    fingerprint: string | undefined
  ): Record<string, string | NoEchoMacInputBinding> =>
    fingerprint === undefined ? entry : { ...entry, [NOECHO_MAC_INPUT_BINDING]: { fingerprint } };
  for (const key of Object.keys(templateProps)) {
    const parameters = noEchoMacParametersOf(templateProps[key], sources);
    if (parameters.length === 0) continue;
    if (kept?.has(key) === true) {
      const before = previous.get(key);
      if (before !== undefined) {
        previousBindings ??= noEchoMacInputBindingsOf(persisted);
        entries.push([key, withBinding(Object.fromEntries(before), previousBindings.get(key))]);
      }
      continue;
    }
    const entry = noEchoValueMacsFor(parameters, current);
    const binding = inputBindings?.get(key);
    if (entry !== undefined && binding !== undefined) {
      stamped ??= maskedPropertyInputFingerprintsOf(persisted);
      entries.push([key, withBinding(entry, binding === stamped.get(key) ? binding : undefined)]);
    } else if (entry !== undefined) {
      entries.push([key, entry]);
    }
  }
  const { noEchoValueMacs: _previous, ...rest } = persisted;
  if (entries.length === 0) return _previous === undefined ? persisted : (rest as ResourceState);
  return { ...rest, noEchoValueMacs: Object.fromEntries(entries) } as ResourceState;
}
