/**
 * Codegen: the `Fn::GetAtt` attribute names that are ALSO writable properties,
 * per resource type (issue #3735).
 *
 * `CloudControlProvider.import()` masks every Cloud Control model key it cannot
 * certify as an attribute. The registry schema `DescribeType` returns certifies
 * only `readOnlyProperties`, but CloudFormation validates `Fn::GetAtt` against
 * the resource specification's `Attributes`, which also names some WRITABLE
 * properties (`AWS::EC2::Subnet` `VpcId`, `AWS::SQS::Queue` `QueueName`, ...).
 * The registry schema does not carry those, so this table supplies them.
 *
 * SOURCE: `@aws-cdk/aws-service-spec` (a pinned devDependency; the same
 * database CDK's L1 `attr*` getters are generated from). For each resource
 * type, an attribute is kept when its WHOLE name is also one of the type's
 * properties AND the two have the same value shape (see
 * `deriveWritableGetAttAttributes`). An attribute that is not a property is a
 * read-only one, which `DescribeType` already certifies, so leaving it out
 * keeps the table small.
 *
 * A DOTTED attribute (`AuthParameters.ConnectivityParameters...`) never
 * certifies its top-level container here. Certifying a key persists its whole
 * subtree in the clear, and such a container can hold credentials beside the
 * one leaf `Fn::GetAtt` reads (`AWS::Events::Connection` `AuthParameters`).
 * Those leaves are read-only pointers in the registry schema, which
 * `read-only-properties.ts` already reduces to their container, so the table
 * adds nothing for them (every one measured against us-east-1 at 0.1.182).
 *
 * {@link EXCLUDED} removes names whose value can hold a secret, and a kept name
 * that READS like one fails the run until {@link SECRET_NAME_ALLOWED} says why
 * it is not.
 *
 * The output is a generated `.ts` module under `src/` (not a runtime JSON read
 * of the spec): the spec stays a devDependency and the lookup is a property
 * access on a literal.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-getatt-attributes.ts          # write the module
 *   node --experimental-strip-types scripts/gen-getatt-attributes.ts --check  # fail if it is stale
 *
 * CI runs the writer through `gen:all-matrices` and fails on a non-empty
 * `git diff`, so a spec bump without a regeneration fails the build.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
export const OUT_FILE = resolve(repoRoot, 'src/provisioning/getatt-attributes.generated.ts');
const SPEC_PACKAGE = '@aws-cdk/aws-service-spec';
const PRINT_WIDTH = 100;

/**
 * Writable attributes deliberately NOT certified, keyed `Type.Name`, with the
 * reason. Certifying persists the value in the clear, so a name whose value
 * can be a secret stays masked and an `Fn::GetAtt` of it is refused by name.
 * An entry that no longer names a writable attribute in the spec FAILS the
 * generator, so the list cannot go stale silently.
 */
export const EXCLUDED: ReadonlyMap<string, string> = new Map([
  [
    'AWS::SSM::Parameter.Value',
    'GetParameter returns the plaintext a dynamic reference or NoEcho Ref deployed; ' +
      'ssm-parameter-provider.ts records Value only for a plain literal, and the ' +
      'Cloud Control route has no such guard',
  ],
]);

/**
 * A kept name — or any member name inside its value's struct / array / map
 * shape, since certifying a key persists its whole subtree — matching this
 * reads like it may hold a secret. The generator
 * THROWS on one unless {@link SECRET_NAME_ALLOWED} carries it with a reason,
 * so a spec bump cannot certify a credential without a human deciding.
 */
export const SECRET_NAME_PATTERN = /pass|secret|token|key|cred|value|private|auth|cert/i;

/** One reviewed allow-list entry: exactly what was reviewed, and why. */
export interface SecretNameReview {
  /**
   * The PATH of every name in the value whose last segment matches
   * {@link SECRET_NAME_PATTERN} (the attribute itself and its members, see
   * {@link ValueShape}), plus `<map>@path` / `<json>@path` for each free-form
   * spot, sorted. The generator passes the entry only while the spec yields
   * EXACTLY this set: a member added, removed or moved by a spec bump fails
   * the run even though the table row itself does not change.
   */
  matched: readonly string[];
  reason: string;
}

/**
 * Kept names whose value matched {@link SECRET_NAME_PATTERN} (or holds a
 * free-form map / json) but were checked to hold no secret, keyed
 * `Type.Name`. An entry no longer in the table, or whose matched set changed,
 * FAILS the generator.
 */
export const SECRET_NAME_ALLOWED: ReadonlyMap<string, SecretNameReview> = new Map([
  [
    'AWS::CodeArtifact::Domain.EncryptionKey',
    { matched: ['EncryptionKey'], reason: 'the KMS key ARN, not key material' },
  ],
  [
    'AWS::Events::EventBus.Policy',
    { matched: ['<json>@Policy'], reason: 'the bus resource policy document; no credential' },
  ],
  [
    'AWS::MediaLive::Input.Sources',
    {
      matched: ['Sources[].PasswordParam'],
      reason: 'the NAME of the SSM parameter holding the password, not the password',
    },
  ],
  [
    'AWS::RedshiftServerless::Workgroup.Workgroup',
    {
      matched: [
        'Workgroup.ConfigParameters[].ParameterKey',
        'Workgroup.ConfigParameters[].ParameterValue',
        'Workgroup.Endpoint.VpcEndpoints[].NetworkInterfaces[].PrivateIpAddress',
      ],
      reason:
        'ParameterKey / ParameterValue are session settings and PrivateIpAddress an ENI ' +
        'address; no credential',
    },
  ],
]);

/** The slice of one spec database resource entity this generator reads. */
export interface SpecResource {
  cloudFormationType?: unknown;
  attributes?: unknown;
  properties?: unknown;
}

/** A spec `typeDefinition` entity: a named struct a `ref` type points at. */
export interface SpecTypeDefinition {
  $id?: unknown;
  properties?: unknown;
}

export interface DeriveOptions {
  excluded?: ReadonlyMap<string, string>;
  secretNameAllowed?: ReadonlyMap<string, SecretNameReview>;
  /**
   * Struct definitions by `$id`, for the member-name walk. Required: an empty
   * map is a deliberate "no structs" (synthetic tests), never a default.
   */
  typeDefinitions: ReadonlyMap<string, SpecTypeDefinition>;
}

function objectKeys(value: unknown): string[] {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

function fieldType(entries: unknown, name: string): unknown {
  const entry = (entries as Record<string, { type?: unknown } | undefined>)[name];
  return entry?.type;
}

/**
 * The spec type reduced to what decides the VALUE's shape: `type`, an array or
 * map `element`, a `reference`, and a union's member list. Validation-only
 * keys (`allowedValues`, ...) are dropped, so a string with allowed values
 * equals a plain string.
 */
export function normalizeSpecType(type: unknown): unknown {
  if (type === null || typeof type !== 'object') return type;
  const t = type as { type?: unknown; element?: unknown; reference?: unknown; types?: unknown };
  const out: Record<string, unknown> = { type: t.type };
  if (t.element !== undefined) out['element'] = normalizeSpecType(t.element);
  if (t.reference !== undefined) out['reference'] = t.reference;
  if (Array.isArray(t.types)) out['types'] = t.types.map(normalizeSpecType);
  return out;
}

/** What {@link describeValueShape} found inside one value type. */
export interface ValueShape {
  /**
   * Every member reachable through structs, as a PATH from the attribute
   * (`Workgroup.ConfigParameters[].ParameterKey`): `[]` steps into an array
   * element, `{}` into a map value. A struct reached at two places is listed
   * at both.
   */
  members: string[];
  /** `<map>@path` / `<json>@path`: free-form keys the name check cannot see. */
  opaque: string[];
  /** `$ref` ids with no type definition: a walk that saw nothing. */
  unresolved: string[];
}

/**
 * Walk a value type: struct properties (through `ref`), recursively through
 * array / map elements and union members. `ancestors` stops a cycle without
 * hiding a struct that is merely reached twice.
 */
export function describeValueShape(
  type: unknown,
  typeDefinitions: ReadonlyMap<string, SpecTypeDefinition>,
  path: string,
  shape: ValueShape = { members: [], opaque: [], unresolved: [] },
  ancestors: Set<string> = new Set()
): ValueShape {
  if (type === null || typeof type !== 'object') return shape;
  const t = type as {
    type?: unknown;
    element?: unknown;
    reference?: { $ref?: unknown };
    types?: unknown;
  };
  if (t.type === 'map' || t.type === 'json') shape.opaque.push(`<${String(t.type)}>@${path}`);
  if (t.element !== undefined) {
    const step = t.type === 'map' ? '{}' : '[]';
    describeValueShape(t.element, typeDefinitions, `${path}${step}`, shape, ancestors);
  }
  if (Array.isArray(t.types)) {
    for (const member of t.types) {
      describeValueShape(member, typeDefinitions, path, shape, ancestors);
    }
  }
  const ref = t.reference?.$ref;
  if (typeof ref === 'string' && !ancestors.has(ref)) {
    const definition = typeDefinitions.get(ref);
    if (!definition) {
      if (!shape.unresolved.includes(ref)) shape.unresolved.push(ref);
      return shape;
    }
    ancestors.add(ref);
    for (const name of objectKeys(definition.properties)) {
      const memberPath = `${path}.${name}`;
      shape.members.push(memberPath);
      describeValueShape(
        fieldType(definition.properties, name),
        typeDefinitions,
        memberPath,
        shape,
        ancestors
      );
    }
    ancestors.delete(ref);
  }
  return shape;
}

/**
 * Derive `type -> sorted writable GetAtt names` from the spec's resource
 * entities. Types with no such name are omitted.
 *
 * A name is kept only when the attribute's normalized type EQUALS the
 * property's: the import records the Cloud Control model value, which has the
 * PROPERTY's shape, while `Fn::GetAtt` returns the ATTRIBUTE's. Where they
 * differ (`AWS::MediaLive::Input` `Sources`: structs vs strings; `Port` as an
 * integer vs a string; a json-or-string `Policy` vs a string) certifying would
 * resolve the read to a value CloudFormation never returns, silently, where
 * the mask refuses it by name.
 *
 * Throws on a kept name matching {@link SECRET_NAME_PATTERN} without an
 * allow-list reason, and on an `excluded` / `secretNameAllowed` entry the spec
 * no longer exercises.
 */
export function deriveWritableGetAttAttributes(
  resources: Iterable<SpecResource>,
  options: DeriveOptions
): Map<string, string[]> {
  return deriveGetAttTables(resources, options).certified;
}

/** Both tables {@link deriveGetAttTables} derives. */
export interface GetAttTables {
  /** Writable attributes whose value has the property's shape (import and deploy). */
  certified: Map<string, string[]>;
  /**
   * Writable attributes whose attribute and property shapes DIFFER. The
   * import masks them (it cannot vouch that the model value is what
   * `Fn::GetAtt` returns); the deploy keeps them, as it always has, since a
   * template CloudFormation accepts reads them (`AWS::DocDB::DBCluster`
   * `Port`, which CDK's `allowDefaultPortFrom` emits). Issue #2925.
   */
  shapeMismatched: Map<string, string[]>;
}

/**
 * {@link deriveWritableGetAttAttributes}, plus the shape-mismatched names.
 * The secret-name guard covers BOTH tables: either one puts a value in
 * `state.json` in the clear.
 */
export function deriveGetAttTables(
  resources: Iterable<SpecResource>,
  options: DeriveOptions
): GetAttTables {
  const excluded = options.excluded ?? EXCLUDED;
  const secretNameAllowed = options.secretNameAllowed ?? SECRET_NAME_ALLOWED;
  const typeDefinitions = options.typeDefinitions;
  const usedExcluded = new Set<string>();
  const usedAllowed = new Set<string>();
  const unreviewed: string[] = [];
  const unresolved: string[] = [];
  const changedReviews: string[] = [];
  const table = new Map<string, Set<string>>();
  const mismatched = new Map<string, Set<string>>();
  for (const resource of resources) {
    const type = resource.cloudFormationType;
    if (typeof type !== 'string') continue;
    const properties = new Set(objectKeys(resource.properties));
    for (const attribute of objectKeys(resource.attributes)) {
      if (!properties.has(attribute)) continue;
      const key = `${type}.${attribute}`;
      if (excluded.has(key)) {
        usedExcluded.add(key);
        continue;
      }
      const attributeType = JSON.stringify(
        normalizeSpecType(fieldType(resource.attributes, attribute))
      );
      const propertyType = JSON.stringify(
        normalizeSpecType(fieldType(resource.properties, attribute))
      );
      const shape = describeValueShape(
        fieldType(resource.properties, attribute),
        typeDefinitions,
        attribute
      );
      for (const ref of shape.unresolved) unresolved.push(`${key} ($ref ${ref})`);
      // A free-form map / json value has keys no name check can see, so it
      // needs the same human decision as a secret-looking name.
      const matched = [
        ...new Set([
          ...[attribute, ...shape.members].filter((path) =>
            SECRET_NAME_PATTERN.test(path.slice(path.lastIndexOf('.') + 1))
          ),
          ...shape.opaque,
        ]),
      ].sort();
      if (matched.length > 0) {
        const review = secretNameAllowed.get(key);
        if (!review) {
          unreviewed.push(`${key} [${matched.join(', ')}]`);
        } else {
          usedAllowed.add(key);
          const reviewed = [...new Set(review.matched)].sort();
          if (reviewed.join('\n') !== matched.join('\n')) {
            changedReviews.push(
              `SECRET_NAME_ALLOWED entry ${key} was reviewed for [${reviewed.join(', ')}] ` +
                `but the spec now yields [${matched.join(', ')}]: review the difference`
            );
          }
        }
      }
      const target = attributeType === propertyType ? table : mismatched;
      let names = target.get(type);
      if (!names) {
        names = new Set();
        target.set(type, names);
      }
      names.add(attribute);
    }
  }
  const problems: string[] = [];
  for (const key of unreviewed.sort()) {
    problems.push(
      `${key} (or a member of its value) reads like a secret, or holds a free-form map / json: ` +
        'add it to EXCLUDED, or to SECRET_NAME_ALLOWED with the matched set and what the value is'
    );
  }
  problems.push(...changedReviews.sort());
  for (const entry of unresolved.sort()) {
    problems.push(`${entry} has no type definition, so its members were not checked`);
  }
  for (const key of [...excluded.keys()].filter((k) => !usedExcluded.has(k)).sort()) {
    problems.push(`EXCLUDED entry ${key} no longer names a writable attribute in the spec`);
  }
  for (const key of [...secretNameAllowed.keys()].filter((k) => !usedAllowed.has(k)).sort()) {
    problems.push(`SECRET_NAME_ALLOWED entry ${key} is no longer in the table`);
  }
  if (problems.length > 0) {
    throw new Error(`gen-getatt-attributes:\n  ${problems.join('\n  ')}`);
  }
  const sort = (from: Map<string, Set<string>>): Map<string, string[]> => {
    const sorted = new Map<string, string[]>();
    for (const type of [...from.keys()].sort()) sorted.set(type, [...from.get(type)!].sort());
    return sorted;
  };
  return { certified: sort(table), shapeMismatched: sort(mismatched) };
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Render the module. Each entry is emitted the way the repo formatter lays it
 * out (one line when it fits the print width, one name per line otherwise), so
 * `vp fmt` leaves the file unchanged and `--check` can compare bytes.
 */
export function renderGetAttAttributesModule(
  table: ReadonlyMap<string, readonly string[]>,
  specVersion: string,
  shapeMismatched: ReadonlyMap<string, readonly string[]> = new Map()
): string {
  const lines: string[] = [
    `// GENERATED by scripts/gen-getatt-attributes.ts from ${SPEC_PACKAGE} ${specVersion}. Do not edit.`,
    '// Regenerate with `vp run gen:getatt-attributes`.',
    '',
    '/**',
    ' * Per resource type, the undotted `Fn::GetAtt` attribute names that',
    ' * are ALSO writable properties, so the registry schema (`readOnlyProperties`)',
    ' * does not certify them. See `getTopLevelAttributeNames` in',
    ' * `read-only-properties.ts` for the reader and issue #3735 for why.',
    ' */',
    'export const WRITABLE_GETATT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {',
  ];
  const entries = (from: ReadonlyMap<string, readonly string[]>): void => {
    for (const [type, names] of from) {
      const single = `  ${quote(type)}: [${names.map(quote).join(', ')}],`;
      if (single.length <= PRINT_WIDTH) {
        lines.push(single);
      } else {
        lines.push(`  ${quote(type)}: [`);
        for (const name of names) lines.push(`    ${quote(name)},`);
        lines.push('  ],');
      }
    }
  };
  entries(table);
  lines.push('};', '');
  // Emitted even when EMPTY: the runtime imports it, so a spec version with no
  // mismatch must not delete the export.
  {
    lines.push(
      '/**',
      ' * Writable `Fn::GetAtt` attributes whose attribute and property value shapes',
      ' * differ. The import masks them; a Cloud Control DEPLOY records them, since a',
      ' * template CloudFormation accepts reads them. See issue #2925.',
      ' */',
      'export const SHAPE_MISMATCHED_GETATT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {'
    );
    entries(shapeMismatched);
    lines.push('};', '');
  }
  return lines.join('\n');
}

export function loadSpec(): {
  resources: SpecResource[];
  typeDefinitions: Map<string, SpecTypeDefinition>;
  version: string;
} {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve(`${SPEC_PACKAGE}/package.json`);
  const version = (JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version: string }).version;
  const db = JSON.parse(
    gunzipSync(readFileSync(resolve(dirname(pkgJsonPath), 'db.json.gz'))).toString('utf8')
  ) as {
    schema?: {
      resource?: { entities?: Record<string, SpecResource> };
      typeDefinition?: { entities?: Record<string, SpecTypeDefinition> };
    };
  };
  const entities = db.schema?.resource?.entities;
  if (!entities || typeof entities !== 'object') {
    throw new Error(`${SPEC_PACKAGE} ${version}: db.json.gz has no schema.resource.entities`);
  }
  const resources = Object.values(entities);
  // Fail closed on a database shape this generator does not model: an empty
  // derivation would silently ship an empty table and re-open the defect.
  if (resources.length === 0) {
    throw new Error(`${SPEC_PACKAGE} ${version}: no resource entities`);
  }
  // The member-name walk resolves `ref` types here; without them the secret
  // guard would see only top-level names, so a missing table fails closed too.
  const definitionEntities = db.schema?.typeDefinition?.entities;
  if (!definitionEntities || typeof definitionEntities !== 'object') {
    throw new Error(`${SPEC_PACKAGE} ${version}: db.json.gz has no schema.typeDefinition.entities`);
  }
  const typeDefinitions = new Map<string, SpecTypeDefinition>();
  for (const definition of Object.values(definitionEntities)) {
    if (typeof definition.$id === 'string') typeDefinitions.set(definition.$id, definition);
  }
  return { resources, typeDefinitions, version };
}

function main(): void {
  const { resources, typeDefinitions, version } = loadSpec();
  const { certified: table, shapeMismatched } = deriveGetAttTables(resources, { typeDefinitions });
  if (table.size === 0) {
    throw new Error(`${SPEC_PACKAGE} ${version}: derived an empty table`);
  }
  const rendered = renderGetAttAttributesModule(table, version, shapeMismatched);
  if (process.argv.includes('--check')) {
    let committed = '';
    try {
      committed = readFileSync(OUT_FILE, 'utf8');
    } catch (error) {
      // A missing file is stale; anything else (permissions, EISDIR) is not
      // a staleness verdict and must surface as itself.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (committed !== rendered) {
      process.stderr.write(
        `${OUT_FILE} is stale against ${SPEC_PACKAGE} ${version}. ` +
          'Run `vp run gen:getatt-attributes` and commit the result.\n'
      );
      process.exit(1);
    }
    process.stdout.write(`getatt-attributes: up to date (${table.size} types)\n`);
    return;
  }
  const tmp = `${OUT_FILE}.tmp`;
  writeFileSync(tmp, rendered);
  renameSync(tmp, OUT_FILE);
  process.stdout.write(`getatt-attributes: wrote ${table.size} types to ${OUT_FILE}\n`);
}

if (Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename) {
  main();
}
