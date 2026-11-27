import type { RecordedSecretValues } from '../pairs.js';
import { isPlainObject } from '../rules.js';
import { attributionRefusedParameters } from './parameter-tables.js';

/**
 * What the parameters a child template node READS say about attributing its
 * value (go-to-k/cdkd#7050, #7059): `masked` when it reads one the parent
 * masked; `sub-floor` when it reads one holding a sub-floor secret's text;
 * else `undefined`. A read is a `{Ref: <name>}` anywhere in the node, an
 * `Fn::Sub` `${name}` placeholder, or one inside a `${name.Attr}` (whose base
 * name is the parameter's). Over-reading only ever masks more.
 */
export function attributionRefusedReadsOf(
  node: unknown,
  secrets: RecordedSecretValues
): 'masked' | 'sub-floor' | undefined {
  const table = attributionRefusedParameters.get(secrets);
  if (table === undefined || table.size === 0) return undefined;
  let verdict: 'masked' | 'sub-floor' | undefined;
  const note = (name: string): void => {
    const kind = table.get(name);
    if (kind === 'masked') verdict = 'masked';
    else if (kind === 'sub-floor' && verdict === undefined) verdict = 'sub-floor';
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > 64 || verdict === 'masked') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'Ref' && typeof inner === 'string') note(inner);
      if (key === 'Fn::Sub') {
        const text =
          typeof inner === 'string' ? inner : Array.isArray(inner) ? inner[0] : undefined;
        if (typeof text === 'string') {
          for (const match of text.matchAll(/\$\{([^}!][^}]*)\}/g)) note(match[1]!.split('.')[0]!);
        }
      }
      walk(inner, depth + 1);
    }
  };
  walk(node, 0);
  return verdict;
}
