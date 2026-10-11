import { explicitNamePropertyFor, generateResourceName } from '../../provisioning/resource-name.js';
import { displayIdent } from '../../utils/display-safe.js';
import {
  NOT_NAME_KEYED_TYPES,
  type NameKey,
  ownEntry,
  REVERSE_REPLACEMENT_NAME_KEYS,
  flat,
} from './name-keys.js';
import { nameValue, physicalIdNames } from './deploy-name.js';

/**
 * Groups of DIFFERENT types that share one name space, so across a `Type`
 * change the new resource can hold the old one's name. The RDS, DocumentDB
 * and Neptune management APIs are one API over one set of identifiers per
 * account and region: Neptune's `DescribeDBClusters` "can also return
 * information for Amazon RDS clusters and Amazon DocDB clusters", so a
 * cluster, an instance or a subnet group of one engine collides with the
 * same identifier of another. Any other pair is UNKNOWN, never "different".
 */
export const SHARED_NAME_SPACES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable']),
  new Set(['AWS::RDS::DBCluster', 'AWS::DocDB::DBCluster', 'AWS::Neptune::DBCluster']),
  new Set(['AWS::RDS::DBInstance', 'AWS::DocDB::DBInstance', 'AWS::Neptune::DBInstance']),
  new Set(['AWS::RDS::DBSubnetGroup', 'AWS::DocDB::DBSubnetGroup', 'AWS::Neptune::DBSubnetGroup']),
];

export const RECORD_SET = 'AWS::Route53::RecordSet';

/** How {@link reverseReplacementNewHoldsName} reads a type's name. */
export function reverseReplacementNameKeyKind(
  resourceType: string
): 'keyed' | 'record-set' | 'not-name-keyed' | 'unknown' {
  if (resourceType === RECORD_SET) return 'record-set';
  if (NOT_NAME_KEYED_TYPES.has(resourceType)) return 'not-name-keyed';
  if (nameKeyFor(resourceType) !== undefined) return 'keyed';
  return 'unknown';
}

export function nameKeyFor(resourceType: string): NameKey | undefined {
  if (NOT_NAME_KEYED_TYPES.has(resourceType)) return undefined;
  const own = ownEntry(REVERSE_REPLACEMENT_NAME_KEYS, resourceType);
  if (own !== undefined) return own;
  const property = explicitNamePropertyFor(resourceType);
  // That table is read by plain indexing: an inherited member is no name.
  return typeof property === 'string' ? flat(property) : undefined;
}

export function valueAt(
  bag: Record<string, unknown> | undefined,
  path: readonly string[]
): string | undefined {
  let node: unknown = bag;
  for (const segment of path.slice(0, -1)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = Object.prototype.hasOwnProperty.call(node, segment)
      ? (node as Record<string, unknown>)[segment]
      : undefined;
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const last = path[path.length - 1]!;
  if (!Object.prototype.hasOwnProperty.call(node, last)) return undefined;
  return nameValue(node as Record<string, unknown>, last);
}

/** Is `bag` carrying a secret mask, a reference or a non-string at `path`? */
export function unreadableAt(
  bag: Record<string, unknown> | undefined,
  path: readonly string[]
): boolean {
  let node: unknown = bag;
  for (const segment of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return node !== undefined && node !== null && valueAt(bag, path) === undefined;
}

/**
 * The NEW resource's value at `path`: recorded, else observed. `unreadable`
 * when the side that would answer holds something that is not a name — an
 * observed value is never allowed to stand behind a recorded mask, nor a
 * scope default behind an observed one.
 */
export function heldAt(
  recorded: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
  path: readonly string[]
): { value: string | undefined; unreadable: boolean } {
  if (unreadableAt(recorded, path)) return { value: undefined, unreadable: true };
  const value = valueAt(recorded, path) ?? valueAt(observed, path);
  return { value, unreadable: value === undefined && unreadableAt(observed, path) };
}

export const isArn = (value: string): boolean => value.startsWith('arn:');

/**
 * Does `physicalId` name `name`? The deploy side's rule
 * ({@link physicalIdNames}), plus the ELBv2 ARN, whose name segment is
 * followed by a generated id (`...:targetgroup/<name>/<id>`,
 * `...:loadbalancer/<app|net|gwy>/<name>/<id>`) — the one id a same-name
 * replacement CHANGES. Both arguments are already in the comparison's case.
 */
export function holderIdNames(physicalId: string, name: string): boolean {
  if (physicalIdNames(physicalId, name)) return true;
  const elbv2 =
    /^arn:[^:]+:elasticloadbalancing:[^:]*:[^:]*:(?:targetgroup|loadbalancer\/(?:app|net|gwy))\/([^/]+)\/[^/]+$/.exec(
      physicalId
    );
  return elbv2 !== null && elbv2[1] === name;
}

/** A Route 53 name or zone name: DNS ignores case, and the trailing dot is optional. */
export const dnsFold = (value: string): string => value.toLowerCase().replace(/\.$/, '');

/** A hosted zone id, with or without its `/hostedzone/` prefix. */
export const zoneIdFold = (value: string): string => value.replace(/^\/hostedzone\//i, '');

/**
 * The verdict of {@link reverseReplacementNewHoldsName}. `holds: false`
 * carries a DISPLAY-SAFE `diagnosis` clause naming the colliding name when it
 * is known, and `known`: `true` when the records show the new resource holds a
 * DIFFERENT name (so another resource holds the colliding one), `false` when
 * they cannot decide.
 */
export type ReverseReplacementHolderVerdict =
  | { readonly holds: true }
  | { readonly holds: false; readonly known: boolean; readonly diagnosis: string };

export const HOLDS: ReverseReplacementHolderVerdict = { holds: true };

/** The records show the new resource does not hold the name. */
export function elsewhere(diagnosis: string): ReverseReplacementHolderVerdict {
  return { holds: false, known: true, diagnosis };
}

/** The records cannot show whether the new resource holds the name. */
export function unproven(diagnosis: string): ReverseReplacementHolderVerdict {
  return { holds: false, known: false, diagnosis };
}

/**
 * How the diagnosis shows a value: masked FIRST, while the value still has the
 * spelling the masker matches (the replay bag is PLAINTEXT, and `displayIdent`
 * escapes, strips and cuts), then `displayIdent`, which quotes any value that
 * is not plain, since the refusal ends on a pasteable `--orphan` line a forged
 * value must not imitate.
 */
export interface Renderer {
  shown(value: string): string;
  quoted(value: string): string;
}

export function renderer(mask: (value: string) => string): Renderer {
  const shown = (value: string): string => displayIdent(mask(value));
  return {
    shown,
    quoted(value) {
      const masked = mask(value);
      const rendered = displayIdent(masked);
      return rendered === masked ? `"${masked}"` : rendered;
    },
  };
}

/**
 * Who the diagnosis talks about. The two directions ask one question — does
 * the HOLDER hold the name the CREATE sent? — about different resources: the
 * rollback re-creates the OLD resource and asks about the NEW one, a deploy
 * `--replace` creates the NEW resource and asks about the OLD one.
 */
export interface Voice {
  /** The create whose name collided, e.g. `the re-create`. */
  readonly create: string;
  /** The record that create was built from, for the record-set rule. */
  readonly createdRecord: string;
  /** The resource that must hold the name, before its physical id. */
  readonly holder: string;
  /** The same, for a Route 53 record. */
  readonly holderRecord: string;
  /** Whether a type with no name key may be proven by {@link sentIdentifierIs}. */
  readonly identityFallback: boolean;
  /** Whether `DERIVED_GENERATED_NAMES` may name what a nameless SDK create sent. */
  readonly derivedNames: boolean;
}

export const ROLLBACK_VOICE: Voice = {
  create: 'the re-create',
  createdRecord: 'the re-created record',
  holder: 'the new resource',
  holderRecord: 'the new record',
  identityFallback: false,
  derivedNames: false,
};

export const DEPLOY_VOICE: Voice = {
  create: 'the create',
  createdRecord: 'the replacement record',
  holder: 'the resource being replaced',
  holderRecord: 'the record being replaced',
  // The deploy's delete is the user's `--replace` opt-in, and without this
  // every Cloud Control type cdkd has no name key for would lose it.
  identityFallback: true,
  // Deploy only, like the identity rule: the rollback keeps refusing a
  // nameless re-create of these types.
  derivedNames: true,
};

/**
 * For a type cdkd has NO name key for (in practice a Cloud Control type with
 * no schema fixture), created and held through Cloud Control: did the create
 * SEND the holder's own physical id as a top-level name-shaped (`...Name` /
 * `...Identifier`) property, exactly, while EVERY name-shaped property it sent
 * equals the holder's recorded (then observed) value of it? A Cloud Control
 * physical id is the primary identifier, so a create sending it asked for the
 * holder's own identifier; the second half keeps a renamed resource whose
 * OTHER name-shaped property still spells the old id (a `RoleName` pointing
 * elsewhere) from passing as unchanged. Exact and case-sensitive: an id that
 * merely ENDS with the value (a composite `<parent>|<name>`) stays unproven.
 */
export function sentIdentifierIs(
  requested: Record<string, unknown>,
  recorded: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
  physicalId: string
): boolean {
  const isNameKey = (key: string): boolean => /(Name|Identifier)$/.test(key);
  // `valueAt` never yields `''`, so an empty id matches nothing.
  if (
    !Object.keys(requested).some(
      (key) => isNameKey(key) && valueAt(requested, [key]) === physicalId
    )
  ) {
    return false;
  }
  // The union with the keys the holder's TEMPLATE declared (its record): a
  // name-shaped property the template DROPPED is a change too, not an
  // absence to skip. Not the observed bag's keys — a read-back can report a
  // name AWS defaulted that no template declared, which is no change.
  const nameKeys = new Set(
    [...Object.keys(requested), ...Object.keys(recorded ?? {})].filter(isNameKey)
  );
  return [...nameKeys].every((key) => {
    const sent = valueAt(requested, [key]);
    return sent !== undefined && heldAt(recorded, observed, [key]).value === sent;
  });
}

/**
 * Types whose SDK provider mints a nameless create's name with its OWN call to
 * `generateResourceName` — a wrap or options `applyDefaultNameForFallback` does
 * not reproduce, so they stay out of `GENERATED_NAME_VERBATIM`. The name is
 * derived here from the logical id in the create's async scope (stack name),
 * exactly as the provider does; `source` is the provider's expression, which
 * the test pins against the provider file. Only the holder's physical id
 * naming the derived name proves it.
 */
export const DERIVED_GENERATED_NAMES: Readonly<
  Record<
    string,
    { readonly file: string; readonly source: string; derive(logicalId: string): string }
  >
> = {
  'AWS::AutoScaling::AutoScalingGroup': {
    file: 'asg-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 255 })',
    derive: (id) => generateResourceName(id, { maxLength: 255 }),
  },
  'AWS::CodeCommit::Repository': {
    file: 'codecommit-repository-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 100 })',
    derive: (id) => generateResourceName(id, { maxLength: 100 }),
  },
  'AWS::DynamoDB::GlobalTable': {
    file: 'dynamodb-globaltable-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 255 })',
    derive: (id) => generateResourceName(id, { maxLength: 255 }),
  },
  'AWS::Logs::LogGroup': {
    file: 'logs-loggroup-provider.ts',
    source:
      '`/cdkd/${generateResourceName(logicalId, { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`',
    derive: (id) =>
      `/cdkd/${generateResourceName(id, { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`,
  },
  'AWS::RDS::DBProxy': {
    file: 'rds-dbproxy-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 64 })',
    derive: (id) => generateResourceName(id, { maxLength: 64 }),
  },
  'AWS::RDS::DBProxyEndpoint': {
    file: 'rds-dbproxy-endpoint-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 64 })',
    derive: (id) => generateResourceName(id, { maxLength: 64 }),
  },
  'AWS::S3::Bucket': {
    file: 's3-bucket-provider.ts',
    source:
      'generateResourceName(logicalId, {\n      maxLength: 63,\n      lowercase: true,\n      allowedPattern: /[^a-z0-9.-]/g,\n    })',
    derive: (id) =>
      generateResourceName(id, { maxLength: 63, lowercase: true, allowedPattern: /[^a-z0-9.-]/g }),
  },
  'AWS::Scheduler::Schedule': {
    file: 'scheduler-schedule-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 64 })',
    derive: (id) => generateResourceName(id, { maxLength: 64 }),
  },
  'AWS::SSM::Parameter': {
    file: 'ssm-parameter-provider.ts',
    source:
      '`/${generateResourceName(logicalId, { maxLength: 1023, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`',
    derive: (id) =>
      `/${generateResourceName(id, { maxLength: 1023, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`,
  },
};

/** The derived-generation table, for the test that pins it to the providers. */
export function replacementDerivedGeneratedNames(): Readonly<
  Record<
    string,
    { readonly file: string; readonly source: string; derive(logicalId: string): string }
  >
> {
  return DERIVED_GENERATED_NAMES;
}
