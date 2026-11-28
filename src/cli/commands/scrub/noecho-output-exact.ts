import {
  SECRET_MASK,
  maskWholeValue,
  readsNoEchoSource,
  type NoEchoPositionSources,
} from '../../../deployment/secret-redaction.js';
import { isPlainObject } from '../../../deployment/secret-redaction/rules.js';

/** More holes than this, or a longer stored value, and the output is masked whole. */
const MAX_HOLES = 4;
const MAX_STORED_LENGTH = 4096;

type Segment = { literal: string } | { hole: 'secret' };

/**
 * The parts of an output's template `Value` in order: its literal text, and a
 * hole per other intrinsic. A pseudo parameter in `pseudo` is its literal value.
 * Only an `Fn::Join` with a literal delimiter, or an `Fn::Sub` string, is
 * taken apart; `undefined` for any other shape.
 */
function segmentsOf(
  value: unknown,
  sources: NoEchoPositionSources,
  pseudo: ReadonlyMap<string, string>
): Segment[] | undefined {
  if (!isPlainObject(value) || Object.keys(value).length !== 1) return undefined;
  // Only a pseudo parameter whose value is known (the region, the stack name)
  // is kept, as its literal text: any other part may carry a secret no needle
  // covers (a short dynamic reference's plaintext), which masking the output
  // whole used to hide too, and matching a known value exactly cannot hand a
  // secret's text to it.
  const hole = (node: unknown): Segment => {
    if (
      !readsNoEchoSource(node, sources) &&
      isPlainObject(node) &&
      Object.keys(node).length === 1 &&
      typeof node['Ref'] === 'string' &&
      pseudo.has(node['Ref'])
    ) {
      return { literal: pseudo.get(node['Ref'])! };
    }
    return { hole: 'secret' };
  };
  if (Object.hasOwn(value, 'Fn::Join')) {
    const args = value['Fn::Join'];
    if (!Array.isArray(args) || typeof args[0] !== 'string' || !Array.isArray(args[1])) {
      return undefined;
    }
    const segments: Segment[] = [];
    args[1].forEach((part: unknown, i: number) => {
      if (i > 0 && args[0] !== '') segments.push({ literal: args[0] as string });
      segments.push(typeof part === 'string' ? { literal: part } : hole(part));
    });
    return segments;
  }
  if (Object.hasOwn(value, 'Fn::Sub')) {
    const args = value['Fn::Sub'];
    const text = Array.isArray(args) ? args[0] : args;
    const variables = Array.isArray(args) && isPlainObject(args[1]) ? args[1] : {};
    if (typeof text !== 'string') return undefined;
    const segments: Segment[] = [];
    let last = 0;
    for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
      segments.push({ literal: text.slice(last, match.index) });
      const name = match[1] ?? '';
      if (name.startsWith('!')) segments.push({ literal: `\${${name.slice(1)}}` });
      else if (Object.hasOwn(variables, name)) segments.push(hole(variables[name]));
      else if (name.includes('.')) {
        const dot = name.indexOf('.');
        segments.push(hole({ 'Fn::GetAtt': [name.slice(0, dot), name.slice(dot + 1)] }));
      } else segments.push(hole({ Ref: name }));
      last = match.index + match[0].length;
    }
    segments.push({ literal: text.slice(last) });
    return segments;
  }
  return undefined;
}

/**
 * The persisted form of a stored output that reads a `NoEcho` source
 * (go-to-k/cdkd#7190): the template's own literal text kept and each part
 * reading a `NoEcho` source replaced by the mask, as a deploy's value scan
 * writes an embedding output (`token=***;`). Every part other than a known
 * pseudo parameter is masked, whatever it reads. Any shape this cannot match
 * EXACTLY is masked whole, the safe side. Only template text (and the known
 * pseudo values) is ever kept, so no stored text survives outside a mask; two
 * holes with no literal between them mask whole.
 */
export function exactNoEchoOutputMask(
  stored: unknown,
  templateValue: unknown,
  sources: NoEchoPositionSources,
  pseudo: ReadonlyMap<string, string>
): unknown {
  const whole = maskWholeValue(stored);
  if (typeof stored !== 'string' || stored.length > MAX_STORED_LENGTH) return whole;
  const segments = segmentsOf(templateValue, sources, pseudo)?.filter(
    (segment) => !('literal' in segment) || segment.literal !== ''
  );
  if (segments === undefined) return whole;
  const holes = segments.filter((segment) => 'hole' in segment);
  if (holes.length === 0 || holes.length > MAX_HOLES) return whole;
  for (let i = 1; i < segments.length; i++) {
    if ('hole' in segments[i]! && 'hole' in segments[i - 1]!) return whole;
  }
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = segments
    .map((segment) => ('literal' in segment ? escape(segment.literal) : '[\\s\\S]*'))
    .join('');
  if (!new RegExp(`^${pattern}$`).test(stored)) return whole;
  return segments.map((segment) => ('literal' in segment ? segment.literal : SECRET_MASK)).join('');
}
