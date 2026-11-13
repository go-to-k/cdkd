/**
 * go-to-k/cdkd#6146: the UPDATE arm's reading of the record's `NoEcho` value
 * MACs, for the keys AWS gave no word on (a write-only property, a type with
 * no readback, or a key not read back because something else moved).
 */
import type { ResourceState } from '../../../types/state.js';
import type { FreshNoEchoLeaf, NoEchoPositionSources } from '../../secret-redaction.js';
import { maskedPropertyFingerprintsOf } from '../../masked-property-fingerprints.js';
import { subPlaceholders } from '../../masked-property-fingerprints/input-walk.js';
import { tryGetTopLevelWriteOnlyProperties } from '../../../provisioning/write-only-properties.js';
import {
  noEchoMacInputBindingsOf,
  noEchoMacParametersOf,
  noEchoMacVerdict,
  noEchoValueMacsOf,
  type NoEchoMac,
} from '../../noecho-value-macs.js';

type Coordinate = readonly (string | number)[];

/** Whether `coordinate` (key first) is `leafPath` under `key`, or a prefix of it. */
function covers(coordinate: Coordinate, key: string, leafPath: readonly (string | number)[]) {
  if (coordinate[0] !== key) return false;
  const rest = coordinate.slice(1);
  return rest.length <= leafPath.length && rest.every((segment, i) => segment === leafPath[i]);
}

/** A run's schema write-only lookups by resource type (see {@link macWriteOnlyKeys}). */
export type MacWriteOnlyLookups = Map<string, Promise<ReadonlySet<string> | undefined>>;

/**
 * A type's schema write-only top-level keys for the NoEcho value MAC paths
 * (deploy and diff), or `undefined` when the lookup failed. One lookup per
 * type per run (`lookups`, held by the run: the deploy's `NoEchoRunState`, a
 * diff's own call), shared while in flight, its failure remembered for that
 * run only: in an account that denies `DescribeType`, twenty records of one
 * type make one call, and the next run asks again.
 */
export function macWriteOnlyKeys(
  resourceType: string,
  lookups: MacWriteOnlyLookups
): Promise<ReadonlySet<string> | undefined> {
  let lookup = lookups.get(resourceType);
  if (lookup === undefined) {
    // Never rejects: a failed lookup answers `undefined`.
    lookup = tryGetTopLevelWriteOnlyProperties(resourceType);
    lookups.set(resourceType, lookup);
  }
  return lookup;
}

/** The intrinsics whose result is a pure function of their (checked) arguments. */
const PURE_INTRINSICS = new Set([
  'Fn::Join',
  'Fn::Select',
  'Fn::Split',
  'Fn::Base64',
  'Fn::ToJsonString',
  'Fn::Length',
]);

/** The pseudo parameters that never change for one stack. */
const STACK_CONSTANT_PSEUDO_PARAMETERS = new Set([
  'AWS::AccountId',
  'AWS::Region',
  'AWS::Partition',
  'AWS::URLSuffix',
  'AWS::StackName',
  'AWS::StackId',
  'AWS::NoValue',
]);

/**
 * Whether `value` is a pure function of its own text, the `NoEcho`
 * parameters (whose MACs cover them) and the stack's constant pseudo
 * parameters. Anything else (a `Fn::GetAtt`, a resource or plain-parameter
 * `Ref`, a cross-stack read, a condition, a mapping) may move without moving
 * the template text or the NoEcho values, and an input fingerprint keeps some
 * of them as written or re-baselines an unbound one to today's (code review
 * of go-to-k/cdkd#6146), so such a key gets a MAC match only through the
 * input binding its entry carries (go-to-k/cdkd#6209).
 */
export function readsOnlyNoEchoParameters(value: unknown, noEcho: ReadonlySet<string>): boolean {
  const named = (name: string, locals?: ReadonlySet<string>): boolean =>
    noEcho.has(name) || STACK_CONSTANT_PSEUDO_PARAMETERS.has(name) || locals?.has(name) === true;
  // A `{{resolve:` token standing alone in a leaf is compared as its token, as
  // CloudFormation compares it. Joined into a leaf by an intrinsic it shares
  // that leaf with the NoEcho value, which masks the whole leaf, so a newer
  // version of it would hide behind an equal MAC (final review of #6146).
  const token = (text: string): boolean => text.includes('{{resolve:');
  const walk = (node: unknown, joined: boolean): boolean => {
    if (typeof node === 'string') return !(joined && token(node));
    if (node === null || typeof node !== 'object') return true;
    if (Array.isArray(node)) return node.every((item) => walk(item, joined));
    const record = node as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1) {
      const key = keys[0]!;
      const operand = record[key];
      if (key === 'Ref') return typeof operand === 'string' && named(operand);
      if (key === 'Fn::Sub') {
        const [text, map] = Array.isArray(operand) ? operand : [operand, undefined];
        if (typeof text !== 'string' || token(text)) return false;
        const locals =
          map !== null && typeof map === 'object' && !Array.isArray(map)
            ? new Set(Object.keys(map as object))
            : undefined;
        if (map !== undefined && locals === undefined) return false;
        if (locals !== undefined && !Object.values(map as object).every((v) => walk(v, true))) {
          return false;
        }
        return subPlaceholders(text).every((name) => named(name, locals));
      }
      if (PURE_INTRINSICS.has(key)) return walk(operand, true);
      if (key.startsWith('Fn::') || key === 'Condition') return false;
    }
    // A multi-key object holding an intrinsic key is one the resolver may
    // still resolve: not plain data.
    if (keys.some((key) => key === 'Ref' || key === 'Condition' || key.startsWith('Fn::'))) {
      return false;
    }
    return Object.values(record).every((child) => walk(child, joined));
  };
  return walk(value, false);
}

/** Whether a recorded input binding exists and equals today's (both fully resolved). */
function boundAndEqual(recorded: string | undefined, today: string | undefined): boolean {
  return recorded !== undefined && today !== undefined && recorded === today;
}

/**
 * Splits `candidates` into the keys whose MACs CONFIRM the value they were
 * last sent and those whose MACs prove it CHANGED. A key gets a verdict only
 * when everything the mask could hide is accounted for:
 *
 * - its template expression did not move (`movedAsWritten`, which includes
 *   the go-to-k/cdkd#4451 template fingerprint), and the record holds a text
 *   fingerprint for it, so an edit inside a masked leaf cannot hide behind an
 *   equal MAC;
 * - it is not unsettled by an earlier failed update (go-to-k/cdkd#5380);
 * - for a MATCH only: it is a pure function of its text, the `NoEcho`
 *   parameters and the stack's constant pseudo parameters
 *   ({@link readsOnlyNoEchoParameters}), or (go-to-k/cdkd#6209) its entry
 *   carries an input binding equal to `inputBindings`' (today's input
 *   fingerprint, present only when every non-`NoEcho` input it reads was
 *   resolved and hashed). The binding is written with the MACs, by the deploy
 *   that sent the value, and never re-baselined, so an equal one proves the
 *   resolved inputs are the ones that value was sent with;
 * - every fresh `NoEcho` leaf of it lies at a position where the template
 *   reads a `NoEcho` PARAMETER (no value-arm leaf another source echoes, no
 *   stale coordinate), so the MACs of the parameters it reads cover them all;
 * - the record's MAC entry names exactly those parameters, under the key of
 *   today's MACs.
 *
 * Anything else, or no MACs this run, is no verdict: the caller keeps its
 * behaviour without one.
 */
export function noEchoMacVerdicts(args: {
  candidates: ReadonlySet<string>;
  record: ResourceState;
  templateProperties: Record<string, unknown>;
  sources: NoEchoPositionSources | undefined;
  pendingParameterLeaves: ReadonlyMap<string, readonly FreshNoEchoLeaf[]>;
  parameterCoordinates: readonly Coordinate[];
  staleCoordinates: readonly Coordinate[];
  movedAsWritten: (key: string) => boolean;
  unsettledNames: ReadonlySet<string>;
  current: ReadonlyMap<string, NoEchoMac> | undefined;
  /** Today's fully resolved input fingerprints by key (`noEchoMacInputBindingsFor`). */
  inputBindings?: ReadonlyMap<string, string> | undefined;
}): { confirmed: Set<string>; changed: Set<string>; readsOther: Set<string> } {
  const confirmed = new Set<string>();
  const changed = new Set<string>();
  // Keys whose MACs matched but which read more than NoEcho parameters.
  const readsOther = new Set<string>();
  const none = { confirmed, changed, readsOther };
  if (args.current === undefined || args.candidates.size === 0) return none;
  const recorded = noEchoValueMacsOf(args.record);
  if (recorded.size === 0) return none;
  const fingerprinted = maskedPropertyFingerprintsOf(args.record);
  const bound = noEchoMacInputBindingsOf(args.record);
  for (const key of args.candidates) {
    if (!recorded.has(key) || !fingerprinted.has(key)) continue;
    if (args.movedAsWritten(key) || args.unsettledNames.has(key)) continue;
    if (!Object.hasOwn(args.templateProperties, key)) continue;
    if (args.staleCoordinates.some((coordinate) => coordinate[0] === key)) continue;
    const leaves = args.pendingParameterLeaves.get(key) ?? [];
    if (leaves.length === 0) continue;
    const positioned = leaves.every((leaf) =>
      args.parameterCoordinates.some((coordinate) => covers(coordinate, key, leaf.path))
    );
    if (!positioned) continue;
    const parameters = noEchoMacParametersOf(args.templateProperties[key], args.sources);
    const verdict = noEchoMacVerdict(recorded.get(key), parameters, args.current);
    // A match vouches only for the NoEcho values: it settles the key only when
    // nothing else the key reads can have moved unseen. A difference is a
    // proven change whatever else holds.
    if (verdict === 'confirmed') {
      const noEcho = args.sources?.parameters ?? new Set<string>();
      if (readsOnlyNoEchoParameters(args.templateProperties[key], noEcho)) confirmed.add(key);
      else if (boundAndEqual(bound.get(key), args.inputBindings?.get(key))) confirmed.add(key);
      else readsOther.add(key);
    } else if (verdict === 'changed') changed.add(key);
  }
  return none;
}
