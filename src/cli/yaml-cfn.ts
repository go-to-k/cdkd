/**
 * CloudFormation-aware YAML codec.
 *
 * Parses + serializes CFn templates while preserving every CFn shorthand
 * intrinsic tag (`!Ref`, `!GetAtt`, `!Sub`, `!Join`, ...) — generic YAML
 * libraries silently strip these tags on parse + re-emit, corrupting the
 * template. cdkd uses this codec on both directions of CFn migration:
 * `cdkd export` (cdkd → CFn IMPORT) and
 * `cdkd import --migrate-from-cloudformation` (CFn → cdkd state).
 *
 * Algorithm: each `!Foo` tag is registered as a YAML custom tag whose
 * resolver returns the long-form object shape `{Fn::Foo: <args>}` (or
 * `{Ref: <name>}` for the bare `!Ref`). On stringify, the same objects
 * are detected and emitted back to shorthand tag form. The internal
 * model cdkd carries between parse and stringify is the long-form object
 * shape — same shape JSON produces — so every downstream consumer
 * (`injectRetainPolicies`, `executeImportChangeSet`, etc.) reads one
 * representation.
 *
 * Each tag is registered three times (scalar / sequence / map) per the
 * `yaml` library's API contract — a single registration only matches one
 * collection shape. Nested intrinsics resolve recursively via
 * `node.toJSON()` (the yaml lib resolves child customTags before invoking
 * the parent resolver).
 *
 * Format detection sniffs the first non-whitespace byte: `{` or `[` →
 * JSON; anything else → YAML. Empty input rejected as JSON so the
 * caller's existing JSON-empty-input error path fires.
 *
 * Tag set supported (matches the AWS docs canonical list):
 *   `!Ref`, `!GetAtt`, `!Sub`, `!Join`, `!Select`, `!Split`,
 *   `!If`, `!Equals`, `!And`, `!Or`, `!Not`,
 *   `!FindInMap`, `!Base64`, `!Cidr`, `!GetAZs`, `!ImportValue`,
 *   `!Transform`, `!Condition` (used inside `Conditions:` references).
 *
 * `!GetAtt` accepts BOTH the scalar dot-delimited shape
 * (`!GetAtt LogicalId.Attribute.Path`) and the sequence shape
 * (`!GetAtt [LogicalId, Attribute]`); both round-trip back to the scalar
 * form when the attribute is a single string segment (the AWS-published
 * canonical shape), or to the sequence form when the attribute is itself
 * a sequence.
 */

import {
  Document,
  Pair,
  Scalar,
  YAMLMap,
  YAMLSeq,
  parse as yamlParse,
  stringify as yamlStringify,
} from 'yaml';
import type { CollectionTag, ScalarTag } from 'yaml';

export type CfnTemplate = Record<string, unknown>;
export type TemplateFormat = 'json' | 'yaml';

/**
 * Tags whose long-form key uses the `Fn::` prefix. `!Ref`, `!Condition`,
 * and `!Transform` are special-cased separately because their long-form
 * key shape differs.
 */
const FN_TAGS = [
  'GetAtt',
  'Sub',
  'Join',
  'Select',
  'Split',
  'If',
  'Equals',
  'And',
  'Or',
  'Not',
  'FindInMap',
  'Base64',
  'Cidr',
  'GetAZs',
  'ImportValue',
  'Length',
  'ToJsonString',
  'ForEach',
] as const;

interface YamlNodeLike {
  toJSON(): unknown;
}

function nodeJs(node: unknown): unknown {
  if (node === null || node === undefined) return null;
  if (typeof node === 'object' && node !== null && 'toJSON' in node) {
    return (node as YamlNodeLike).toJSON();
  }
  return node;
}

/**
 * Build the set of custom YAML tags cdkd registers. Each tag may need
 * up to 3 entries (scalar / seq / map) so every shape an AWS-published
 * template carries is accepted; un-templated shapes for a given tag
 * fall through to the lib's default tag resolution (which the lib
 * surfaces as a warning — never an error — by design).
 *
 * `identify: () => false` on every entry: we never want the lib to
 * auto-tag a parsed result on stringify. We build the YAML output via
 * our own `jsToYamlNode` walk that emits the tag explicitly.
 */
function buildCustomTags(): Array<ScalarTag | CollectionTag> {
  const tags: Array<ScalarTag | CollectionTag> = [];

  // !Ref — scalar only. `!Ref MyBucket` → {Ref: 'MyBucket'}.
  tags.push({
    tag: '!Ref',
    resolve(value: string): unknown {
      return { Ref: value };
    },
    identify: () => false,
  } as ScalarTag);

  // !Condition — scalar only, used inside Conditions references.
  tags.push({
    tag: '!Condition',
    resolve(value: string): unknown {
      return { Condition: value };
    },
    identify: () => false,
  } as ScalarTag);

  // !Transform — map-collection only.
  tags.push({
    tag: '!Transform',
    collection: 'map',
    resolve(node: YAMLMap): unknown {
      return { 'Fn::Transform': nodeJs(node) };
    },
    identify: () => false,
  } as CollectionTag);

  // !GetAtt — scalar (dot-delimited) AND sequence shape.
  tags.push({
    tag: '!GetAtt',
    resolve(value: string): unknown {
      // Scalar shape — split on the FIRST dot only. The attribute
      // portion may contain further dots (`Endpoint.Port` on RDS).
      // A dot-less scalar is a template-author bug — silently producing
      // `{Fn::GetAtt: [<id>, '']}` would surface as a confusing AWS-side
      // validation error far from the source, so reject at parse time.
      const dot = value.indexOf('.');
      if (dot < 0) {
        throw new Error(`!GetAtt requires '<LogicalId>.<Attribute>'; got '${value}'`);
      }
      return { 'Fn::GetAtt': [value.slice(0, dot), value.slice(dot + 1)] };
    },
    identify: () => false,
  } as ScalarTag);
  tags.push({
    tag: '!GetAtt',
    collection: 'seq',
    resolve(node: YAMLSeq): unknown {
      return { 'Fn::GetAtt': nodeJs(node) };
    },
    identify: () => false,
  } as CollectionTag);

  // Generic Fn::Foo tags — register scalar AND seq AND map shapes per tag
  // (the AWS-published shapes vary per intrinsic: `!Sub` is most often
  // scalar; `!Join` / `!Select` / `!Split` / `!If` are sequence; `!Cidr` is
  // sequence; `!Base64` is scalar; etc.).
  for (const name of FN_TAGS) {
    if (name === 'GetAtt') continue;
    const longKey = `Fn::${name}`;
    tags.push({
      tag: `!${name}`,
      resolve(value: string | number | null): unknown {
        return { [longKey]: value };
      },
      identify: () => false,
    } as ScalarTag);
    tags.push({
      tag: `!${name}`,
      collection: 'seq',
      resolve(node: YAMLSeq): unknown {
        return { [longKey]: nodeJs(node) };
      },
      identify: () => false,
    } as CollectionTag);
    tags.push({
      tag: `!${name}`,
      collection: 'map',
      resolve(node: YAMLMap): unknown {
        return { [longKey]: nodeJs(node) };
      },
      identify: () => false,
    } as CollectionTag);
  }

  return tags;
}

const CUSTOM_TAGS = buildCustomTags();

/**
 * Parse a CFn template string. JSON or YAML, auto-detected.
 *
 * @throws Error with a clear message when the input is empty, malformed,
 *   or does not produce an object root.
 */
export function parseCfnTemplate(text: string): CfnTemplate {
  const format = detectTemplateFormat(text);
  // Strip leading UTF-8 BOM if present — JSON.parse rejects BOM and YAML
  // would treat it as a literal char. Sniffing is BOM-aware (above), so
  // by this point the format choice already reflects post-BOM content.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  if (format === 'json') {
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new Error(
        `Template is not valid JSON. ` +
          `Cause: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    try {
      parsed = yamlParse(body, { customTags: CUSTOM_TAGS });
    } catch (err) {
      throw new Error(
        `Template is not valid YAML. ` +
          `Cause: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Template root is not an object.`);
  }
  return parsed as CfnTemplate;
}

/**
 * Serialize a CFn template back to JSON or YAML. The `format` parameter
 * controls the output shape; callers should pass the result of the
 * original `detectTemplateFormat` (or remembered from `parseCfnTemplate`)
 * so a YAML-authored template stays YAML on round-trip.
 *
 * YAML output emits CFn intrinsics back to shorthand tags (`!Ref`,
 * `!GetAtt`, etc.) by walking the JS object tree before passing it to
 * `yaml.stringify`. Long-form `{Fn::Foo: <args>}` objects are converted
 * to `Document` nodes carrying the appropriate `!Foo` tag.
 *
 * JSON output is two-space-indented to match cdkd's existing canonical
 * shape.
 */
export function stringifyCfnTemplate(template: CfnTemplate, format: TemplateFormat): string {
  if (format === 'json') {
    return JSON.stringify(template, null, 2);
  }
  const doc = new Document();
  doc.contents = jsToYamlNode(template, doc) as YAMLMap;
  // `aliasDuplicateObjects: false` keeps `&anchor` / `*alias` out of the
  // output — CFn does not understand YAML anchors.
  // `lineWidth: 0` disables long-string folding so CFn ARNs / sub
  // templates stay on one line.
  return yamlStringify(doc, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  });
}

/**
 * Convert a plain JS value into a YAML node, detecting CFn intrinsics and
 * emitting them with their shorthand tag. Recursive — every sub-tree is
 * inspected.
 */
function jsToYamlNode(value: unknown, doc: Document): unknown {
  if (value === null || value === undefined) {
    return new Scalar(null);
  }
  if (typeof value !== 'object') {
    return doc.createNode(value);
  }
  if (Array.isArray(value)) {
    const seq = new YAMLSeq();
    for (const item of value) {
      seq.items.push(jsToYamlNode(item, doc));
    }
    return seq;
  }
  // Object — check if it's an intrinsic.
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 1) {
    const k = keys[0]!;
    const v = (value as Record<string, unknown>)[k];
    const tag = intrinsicShorthandFor(k);
    if (tag) {
      return makeIntrinsicNode(tag, v, doc);
    }
  }
  // Plain map.
  const map = new YAMLMap();
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    map.items.push(new Pair(doc.createNode(k), jsToYamlNode(v, doc)));
  }
  return map;
}

/**
 * Map a long-form intrinsic key (`Ref` / `Fn::Foo` / `Condition`) to its
 * shorthand tag (`!Ref` / `!Foo` / `!Condition`). Returns null when the
 * key is not a recognized intrinsic.
 */
function intrinsicShorthandFor(key: string): string | null {
  if (key === 'Ref') return '!Ref';
  if (key === 'Condition') return '!Condition';
  if (!key.startsWith('Fn::')) return null;
  const name = key.slice('Fn::'.length);
  if (name === 'Transform') return '!Transform';
  if (name === 'GetAtt') return '!GetAtt';
  if ((FN_TAGS as readonly string[]).includes(name)) return `!${name}`;
  return null;
}

/**
 * Build a YAML node carrying a CFn shorthand tag. Tag-specific shapes:
 *   - `!Ref` / `!Condition` → scalar (the referenced name).
 *   - `!GetAtt` → scalar `LogicalId.Attribute` when the long-form arg
 *     is `[LogicalId, Attribute]` of strings; sequence form otherwise.
 *   - Everything else → whatever shape the long-form arg has
 *     (scalar / sequence / map).
 */
function makeIntrinsicNode(tag: string, value: unknown, doc: Document): unknown {
  if (tag === '!Ref' || tag === '!Condition') {
    const s = new Scalar(typeof value === 'string' ? value : String(value));
    s.tag = tag;
    return s;
  }
  if (tag === '!GetAtt') {
    // Prefer the scalar dot-delimited shape when possible — it's the
    // most common AWS-published form. Fall back to the sequence shape
    // when the attribute is itself an array.
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string'
    ) {
      const s = new Scalar(`${value[0]}.${value[1]}`);
      s.tag = tag;
      return s;
    }
    const node = jsToYamlNode(value, doc) as YAMLSeq;
    node.tag = tag;
    return node;
  }
  const node = jsToYamlNode(value, doc) as { tag?: string };
  node.tag = tag;
  return node;
}

/**
 * Sniff the input text and decide whether to parse it as JSON or YAML.
 *
 * Rule (matches AWS docs / CDK CLI): if the first non-whitespace byte is
 * `{` or `[`, parse as JSON; otherwise YAML. Empty input is treated as
 * JSON so the caller's existing JSON-empty-input error path fires.
 *
 * UTF-8 BOM (`﻿`) is stripped before the sniff — some editors /
 * scripts emit BOM-prefixed files, and the BOM is NOT whitespace under
 * `trimStart()`, so a BOM-prefixed JSON file would otherwise route to
 * the YAML parser and fail.
 */
export function detectTemplateFormat(text: string): TemplateFormat {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const trimmed = stripped.trimStart();
  if (trimmed.length === 0) return 'json';
  const first = trimmed.charCodeAt(0);
  // 0x7B = '{', 0x5B = '['
  if (first === 0x7b || first === 0x5b) return 'json';
  return 'yaml';
}

/**
 * Parse a CFn template + return both the parsed object AND the source
 * format, so the caller can later re-emit in the same shape. Convenience
 * wrapper around `parseCfnTemplate` + `detectTemplateFormat`.
 */
export function parseCfnTemplateWithFormat(text: string): {
  template: CfnTemplate;
  format: TemplateFormat;
} {
  const format = detectTemplateFormat(text);
  const template = parseCfnTemplate(text);
  return { template, format };
}

/**
 * Detect the source format of a file path by extension. Used as a hint
 * when the user passes `--template <path>` to `cdkd export` and we want
 * a format guess before reading the file. Content sniffing
 * (`detectTemplateFormat`) wins when the two disagree; extension is the
 * tiebreaker for ambiguous empty content.
 */
export function detectTemplateFormatByPath(path: string): TemplateFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  return null;
}
