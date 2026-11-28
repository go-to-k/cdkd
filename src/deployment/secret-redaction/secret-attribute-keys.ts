import { MIN_NEEDLE_LENGTH, isPlainObject } from './rules.js';
import type { RecordedSecretValues } from './pairs.js';
import { mentionsMask } from './recorded-secrecy.js';
import { splitGetAttStringForm } from './cross-stack.js';

/**
 * A custom resource's attribute KEY holding a secret (go-to-k/cdkd#7153).
 *
 * The state redaction reads values, never keys, and every other bag's keys
 * are template text or AWS-chosen names. A custom resource's `attributes` are
 * its handler's `Data` object verbatim, keys included, so a handler that names
 * an attribute after a secret it was given (or a `NoEcho` value it returned)
 * had that key persisted in plaintext.
 *
 * Such an attribute is DROPPED from the persisted record, unless a
 * `Fn::GetAtt` in the template spells the key: then the key is template text,
 * which the template already discloses, and a dependent reading it keeps
 * working. The record names nothing about a dropped key (any name would be
 * the secret), so a later `Fn::GetAtt` of one finds no attribute and fails as
 * a missing attribute does. A template whose `Fn::GetAtt` of this resource
 * names the attribute through an expression could read any key, so nothing is
 * dropped. Rewriting the key instead would make two keys collide, and a key
 * holding a needle only by coincidence would no longer answer the `Fn::GetAtt`
 * spelling it; the template exemption covers that coincidence.
 */

/** The resource types CloudFormation treats as custom resources. */
function isCustomResourceType(resourceType: unknown): boolean {
  return (
    typeof resourceType === 'string' &&
    (resourceType === 'AWS::CloudFormation::CustomResource' || resourceType.startsWith('Custom::'))
  );
}

/** Per template object, every resource's {@link templateGetAttNamesOf} answer, from one walk. */
const readsByTemplate = new WeakMap<object, Map<string, Set<string> | 'any'>>();

/**
 * The attribute names a template reads of `logicalId` through `Fn::GetAtt`
 * (array or string form) or a `${X.Attr}` in `Fn::Sub`, or `'any'` when one
 * of those names is not a literal string. Walked once per template object.
 */
export function templateGetAttNamesOf(template: object, logicalId: string): Set<string> | 'any' {
  let reads = readsByTemplate.get(template);
  if (reads === undefined) {
    reads = templateGetAttReadsOf(template);
    readsByTemplate.set(template, reads);
  }
  return reads.get(logicalId) ?? new Set();
}

function templateGetAttReadsOf(template: unknown): Map<string, Set<string> | 'any'> {
  const reads = new Map<string, Set<string> | 'any'>();
  const seen = new Set<object>();
  const add = (id: string, attribute: unknown): void => {
    const current = reads.get(id);
    if (current === 'any') return;
    if (typeof attribute !== 'string') {
      reads.set(id, 'any');
      return;
    }
    if (current === undefined) reads.set(id, new Set([attribute]));
    else current.add(attribute);
  };
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, inner] of Object.entries(node)) {
      if (key === 'Fn::GetAtt') {
        if (Array.isArray(inner) && typeof inner[0] === 'string') add(inner[0], inner[1]);
        else if (typeof inner === 'string') {
          const split = splitGetAttStringForm(inner);
          if (split) add(split.logicalId, split.attributeName);
        }
      } else if (key === 'Fn::Sub') {
        const text = Array.isArray(inner) ? inner[0] : inner;
        if (typeof text === 'string') {
          for (const match of text.matchAll(/\$\{([^}!][^}]*)\}/g)) {
            const split = splitGetAttStringForm(match[1] ?? '');
            if (split) add(split.logicalId, split.attributeName);
          }
        }
      }
      walk(inner);
    }
  };
  walk(template);
  return reads;
}

/**
 * `record` with every attribute dropped whose KEY contains a secret this
 * resource's pass knows (a key of `secrets`, or the in-memory value of an
 * attribute it declares `NoEcho`, from `raw`), unless `getAttNames` spells the
 * key. Only a custom resource's attributes, only with a template to read the
 * names from. A value under the needle floor, equal to a public token, or
 * contained in the physical id is no needle. Returns `record` by identity when
 * nothing is dropped.
 */
export function withSecretAttributeKeysDropped<
  R extends {
    resourceType?: unknown;
    physicalId?: unknown;
    attributes?: Record<string, unknown>;
    noEchoAttributeNames?: unknown;
  },
>(
  record: R,
  raw: { attributes?: Record<string, unknown> },
  secrets: RecordedSecretValues | undefined,
  getAttNames: Set<string> | 'any' | undefined,
  publicTokens?: ReadonlySet<string>
): R {
  const attributes = record.attributes;
  if (!isCustomResourceType(record.resourceType) || !isPlainObject(attributes)) return record;
  if (getAttNames === undefined || getAttNames === 'any') return record;
  const physicalId = typeof record.physicalId === 'string' ? record.physicalId : '';
  const needles = new Set<string>();
  const learn = (value: unknown): void => {
    if (typeof value !== 'string' || value.length < MIN_NEEDLE_LENGTH || mentionsMask(value)) {
      return;
    }
    if (publicTokens?.has(value) === true || physicalId.includes(value)) return;
    needles.add(value);
  };
  for (const plaintext of secrets?.keys() ?? []) learn(plaintext);
  const declared = record.noEchoAttributeNames;
  if (Array.isArray(declared) && isPlainObject(raw.attributes)) {
    for (const name of declared) {
      if (typeof name === 'string' && Object.hasOwn(raw.attributes, name)) {
        learn(raw.attributes[name]);
      }
    }
  }
  if (needles.size === 0) return record;
  const dropped = Object.keys(attributes).filter(
    (key) => !getAttNames.has(key) && [...needles].some((needle) => key.includes(needle))
  );
  if (dropped.length === 0) return record;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!dropped.includes(key)) {
      Object.defineProperty(kept, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  const next = { ...record, attributes: kept };
  // The declaration names keys too: a dropped key leaves it, or the name
  // would persist what the drop removed.
  if (Array.isArray(declared)) {
    const names = declared.filter((name) => !dropped.includes(name as string));
    if (names.length > 0) next.noEchoAttributeNames = names;
    else delete next.noEchoAttributeNames;
  }
  return next;
}
