/**
 * Capture every resource type's SECRET-CAPABLE property paths from the public
 * CloudFormation schema bundle into
 * `tests/fixtures/cfn-registry-secret-paths.json` (go-to-k/cdkd#7061, slice (c)).
 *
 * Two kinds, per type:
 * - `writeOnly`: the schema's `writeOnlyProperties` (a value AWS never reads
 *   back: a password, a key, a token);
 * - `secretNamed`: every property path, through `$ref` definitions, objects
 *   and array items, whose NAME says it carries a secret: cdkd's own name
 *   heuristic (`isSensitiveAttributeName`, `src/utils/stringify.ts`) as it is,
 *   or {@link SAMPLING_EXTRA_NAME}.
 *
 * The names only SELECT which paths the invariant samples. State redaction is
 * driven by value and provenance, never by a property's name, and nothing at
 * runtime reads this list.
 *
 * `tests/unit/deployment/schema-redaction-invariant-7061.test.ts` reads the
 * committed snapshot OFFLINE and asserts that a secret placed at each path is
 * redacted on persist and plans no change on an unchanged redeploy. This
 * script is the only part that needs the network; the weekly
 * `cfn-schema-refresh` workflow runs it beside `gen:cfn-registry-create-only-paths`.
 *
 * The download and unzip reuse `refresh-cfn-schemas.mjs` (origin pinned, no
 * redirect, size caps), and a `writeOnlyProperties` pointer is parsed by the
 * live resolver's own pointer parse, so the snapshot cannot spell a path the
 * runtime would not.
 */
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadSchemaBundle, readSchemaBundle } from './refresh-cfn-schemas.mjs';
import { parseCreateOnlyPropertyPointers } from '../src/provisioning/create-only-paths.ts';
import { isSensitiveAttributeName } from '../src/utils/stringify.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_PATH = resolve(repoRoot, 'tests/fixtures/cfn-registry-secret-paths.json');
const bundleUrl = (region: string): string =>
  `https://schema.cloudformation.${region}.amazonaws.com/CloudformationSchema.zip`;
const BUNDLE_URL = bundleUrl('us-east-1');
/** The create-only snapshot's regions, in its order, for a type us-east-1 lacks. */
export const FALLBACK_REGIONS = ['us-west-2', 'eu-west-1', 'eu-central-1', 'ap-northeast-1'] as const;
/** Fewer types than this is a truncated or replaced bundle, never a refresh. */
const MIN_TYPES = 1500;
/** Deeper than any registry schema nests a property; a cyclic `$ref` stops here. */
const MAX_DEPTH = 8;

/**
 * SAMPLING ONLY: names beyond `isSensitiveAttributeName` that also carry
 * secrets (a token, private key or key material, a passphrase, an API key).
 * Widening the runtime heuristic would change the getatt, orphan-rewriter and
 * cross-stack refusals; this list changes no runtime behaviour.
 */
export const SAMPLING_EXTRA_NAME = /token|private[-_]?key|key[-_]?material|passphrase|api[-_]?key/i;

/** Whether a property NAME selects its path for sampling. */
export function isSampledSecretName(key: string): boolean {
  return isSensitiveAttributeName(key) || SAMPLING_EXTRA_NAME.test(key);
}

export interface SecretPaths {
  readonly writeOnly: readonly (readonly string[])[];
  readonly secretNamed: readonly (readonly string[])[];
}

export interface RegistrySecretPathsSnapshot {
  readonly _comment: readonly string[];
  readonly source: string;
  readonly homeRegions: Readonly<Record<string, string>>;
  /** Resource type -> its paths (segments after `/properties/`, `*` for an array item); types with none are left out. */
  readonly types: Readonly<Record<string, SecretPaths>>;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every property path of `schema` whose last segment {@link isSampledSecretName} selects. */
export function secretNamedPaths(schema: Json): string[][] {
  const definitions = isObject(schema['definitions']) ? schema['definitions'] : {};
  const out: string[][] = [];
  const seen = new Set<string>();
  // A `$ref` chain (a definition that is itself a `$ref`) is followed to its end.
  const deref = (node: unknown, refs: ReadonlySet<string>): { node: Json; refs: Set<string> } | undefined => {
    let at: unknown = node;
    let seen = new Set(refs);
    for (;;) {
      if (!isObject(at)) return undefined;
      const ref = at['$ref'];
      if (typeof ref !== 'string') return { node: at, refs: seen };
      const name = ref.startsWith('#/definitions/') ? ref.slice('#/definitions/'.length) : undefined;
      if (name === undefined || seen.has(name) || !isObject(definitions[name])) return undefined;
      seen = new Set([...seen, name]);
      at = definitions[name];
    }
  };
  /** A node and each `oneOf` / `anyOf` / `allOf` branch of it, dereferenced. */
  const branches = (at: { node: Json; refs: Set<string> }): Array<{ node: Json; refs: Set<string> }> => {
    const out = [at];
    for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
      const list = at.node[combinator];
      if (!Array.isArray(list)) continue;
      for (const branch of list) {
        const d = deref(branch, at.refs);
        if (d !== undefined) out.push(d);
      }
    }
    return out;
  };
  const walk = (properties: unknown, prefix: string[], refs: ReadonlySet<string>): void => {
    if (!isObject(properties) || prefix.length >= MAX_DEPTH) return;
    for (const [key, raw] of Object.entries(properties)) {
      const path = [...prefix, key];
      if (isSampledSecretName(key)) {
        const id = JSON.stringify(path);
        if (!seen.has(id)) {
          seen.add(id);
          out.push(path);
        }
      }
      let at = deref(raw, refs);
      let itemPath = path;
      // An array (of arrays): its items, one `*` per level.
      while (at !== undefined && isObject(at.node['items']) && itemPath.length < MAX_DEPTH) {
        itemPath = [...itemPath, '*'];
        at = deref(at.node['items'], at.refs);
      }
      if (at !== undefined) for (const b of branches(at)) walk(b.node['properties'], itemPath, b.refs);
    }
  };
  walk(schema['properties'], [], new Set());
  // A property declared only inside a top-level combinator branch.
  for (const b of branches({ node: schema, refs: new Set() }).slice(1)) walk(b.node['properties'], [], b.refs);
  return out.sort(comparePaths);
}

function comparePaths(a: readonly string[], b: readonly string[]): number {
  return a.join('/').localeCompare(b.join('/'));
}

/** One type's secret-capable paths, or `undefined` when it has none. */
export function extractSecretPaths(schemaJson: string): SecretPaths | undefined {
  const schema = JSON.parse(schemaJson) as Json;
  const writeOnly = parseCreateOnlyPropertyPointers(schema['writeOnlyProperties']).sort(comparePaths);
  const secretNamed = secretNamedPaths(schema);
  return writeOnly.length === 0 && secretNamed.length === 0 ? undefined : { writeOnly, secretNamed };
}

export function buildSnapshot(
  entries: ReadonlyMap<string, string>,
  fallbacks: ReadonlyArray<readonly [region: string, entries: ReadonlyMap<string, string>]> = []
): RegistrySecretPathsSnapshot {
  const types: Record<string, SecretPaths> = {};
  const read = new Set<string>();
  const homeRegions: Record<string, string> = {};
  const readBundle = (bundle: ReadonlyMap<string, string>, region?: string): void => {
    for (const schemaJson of bundle.values()) {
      const typeName = (JSON.parse(schemaJson) as { typeName?: unknown }).typeName;
      if (typeof typeName !== 'string' || read.has(typeName)) continue;
      read.add(typeName);
      const paths = extractSecretPaths(schemaJson);
      if (paths === undefined) continue;
      types[typeName] = paths;
      if (region !== undefined) homeRegions[typeName] = region;
    }
  };
  readBundle(entries);
  if (read.size < MIN_TYPES) {
    throw new Error(
      `the us-east-1 schema bundle carries ${read.size} types (floor ${MIN_TYPES}) — refusing to write a truncated snapshot`
    );
  }
  for (const [region, bundle] of fallbacks) readBundle(bundle, region);
  const sorted: Record<string, SecretPaths> = {};
  for (const type of Object.keys(types).sort()) sorted[type] = types[type]!;
  const sortedHome: Record<string, string> = {};
  for (const type of Object.keys(homeRegions).sort()) sortedHome[type] = homeRegions[type]!;
  return {
    _comment: [
      'Every resource type in the public CloudFormation registry schema bundle (us-east-1, then',
      `${FALLBACK_REGIONS.join(', ')} for a type it lacks) that has a writeOnlyProperties path or a`,
      'property NAMED as a secret, with those paths. Read OFFLINE by',
      'tests/unit/deployment/schema-redaction-invariant-7061.test.ts (go-to-k/cdkd#7061).',
      'Refresh: `vp run gen:cfn-registry-secret-paths` (network).',
    ],
    source: BUNDLE_URL,
    homeRegions: sortedHome,
    types: sorted,
  };
}

/** One type per line, so a refresh diffs per type. */
export function serializeSnapshot(snapshot: RegistrySecretPathsSnapshot): string {
  const lines = [
    '{',
    `  "_comment": ${JSON.stringify(snapshot._comment)},`,
    `  "source": ${JSON.stringify(snapshot.source)},`,
    `  "homeRegions": ${JSON.stringify(snapshot.homeRegions)},`,
    '  "types": {',
  ];
  const entries = Object.entries(snapshot.types);
  entries.forEach(([type, paths], i) => {
    lines.push(`    ${JSON.stringify(type)}: ${JSON.stringify(paths)}${i < entries.length - 1 ? ',' : ''}`);
  });
  lines.push('  }', '}', '');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const entries = readSchemaBundle(await downloadSchemaBundle(BUNDLE_URL));
  const fallbacks: Array<readonly [string, ReadonlyMap<string, string>]> = [];
  for (const region of FALLBACK_REGIONS) {
    fallbacks.push([region, readSchemaBundle(await downloadSchemaBundle(bundleUrl(region)))]);
  }
  const snapshot = buildSnapshot(entries, fallbacks);
  const tmp = `${SNAPSHOT_PATH}.tmp`;
  writeFileSync(tmp, serializeSnapshot(snapshot));
  renameSync(tmp, SNAPSHOT_PATH);
  process.stderr.write(`registry-secret-paths: wrote ${Object.keys(snapshot.types).length} types\n`);
}

if (Boolean(process.argv[1]) && resolve(process.argv[1]!) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`registry-secret-paths: failed — ${(err as Error).message}\n`);
    process.exit(1);
  });
}
