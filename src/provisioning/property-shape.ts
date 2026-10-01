/**
 * Pre-flight rule: a template property must have the JSON kind its type's
 * schema requires — a list where the schema wants a list, an object where it
 * wants an object (issue [#4357](https://github.com/go-to-k/cdkd/issues/4357)).
 *
 * CloudFormation validates every resource's properties against the type schema
 * before any handler runs (`Properties validation failed ... expected type:
 * JSONArray, found: JSONObject`). cdkd forwarded the value, and a wrong kind
 * failed inside an SDK call with an unrelated-looking error, or was silently
 * dropped. The per-provider `requireConfigArray` / `requireConfigObject`
 * guards (`config-shape.ts`) stay: they also guard the state-side twin
 * (#3211). Same layer and same reasons as `nested-required.ts`.
 *
 * ## Refuse only what CloudFormation refuses
 *
 * - Only array-versus-object is refused. A scalar where an object or list is
 *   wanted (or the reverse) is not refused here: a legacy `Json` property
 *   takes a string, so the check is kept to array-versus-object.
 * - The table lists a path only where the schema admits EXACTLY one of the two
 *   kinds (`scripts/refresh-cfn-schemas.mjs`'s `extractPropertyShapes` holds the
 *   rules), so a type list, a combinator whose arms disagree, a legacy type
 *   (a schema with no `handlers`, which CloudFormation does not validate
 *   against), or an unknown type or path passes.
 * - Pre-flight runs BEFORE intrinsic resolution: an intrinsic (`Ref`, any
 *   `Fn::*`) stands in for any kind — `Fn::If` arms, `Fn::Split`, `Fn::GetAZs`
 *   and `Fn::Cidr` all yield lists — so its subtree is skipped. A
 *   `{{resolve:...}}` reference is a string, which is never refused.
 *
 * ## Cost
 *
 * The table is a static generated module. A type's rows are turned into a tree
 * on first use and cached, and the walk visits only template keys the tree
 * names, so a resource costs O(its properties) and a type outside the table one
 * Map lookup. No AWS call.
 */
import { displayIdent } from '../utils/display-safe.js';
import { PROPERTY_SHAPES } from './property-shape.generated.js';

/** The kind a path requires, and what the schema says sits below it. */
export interface ShapeNode {
  kind?: 'array' | 'object';
  readonly props: Map<string, ShapeNode>;
  items?: ShapeNode;
}

/** One value whose kind contradicts the schema. */
export interface PropertyShapeViolation {
  readonly resourceType: string;
  /** Where the value sits, array elements indexed: `Tags[0]`. */
  readonly path: string;
  readonly expected: 'array' | 'object';
  readonly found: 'array' | 'object';
}

const treeCache = new Map<string, ShapeNode>();

/** Build the tree for one type's `path -> kind` rows. Exported for tests. */
export function buildShapeTree(rows: Readonly<Record<string, 'array' | 'object'>>): ShapeNode {
  const root: ShapeNode = { props: new Map() };
  for (const [path, kind] of Object.entries(rows)) {
    let node = root;
    for (const segment of path.split('.')) {
      const name = segment.replace(/(\[\])+$/, '');
      let child = node.props.get(name);
      if (!child) {
        child = { props: new Map() };
        node.props.set(name, child);
      }
      node = child;
      for (let depth = (segment.length - name.length) / 2; depth > 0; depth--) {
        node.items ??= { props: new Map() };
        node = node.items;
      }
    }
    node.kind = kind;
  }
  return root;
}

function treeFor(resourceType: string): ShapeNode | undefined {
  const cached = treeCache.get(resourceType);
  if (cached) return cached;
  const rows = PROPERTY_SHAPES.get(resourceType);
  if (!rows) return undefined;
  const tree = buildShapeTree(rows);
  treeCache.set(resourceType, tree);
  return tree;
}

/** A single-key object whose key is `Ref` or `Fn::*`: its value is unknown. */
function isIntrinsic(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'));
}

/**
 * Find every value in this resource's properties whose kind contradicts its
 * schema. `tree` defaults to the generated table's; tests pass their own.
 */
export function findPropertyShapeViolations(
  resourceType: string,
  templateProperties: Record<string, unknown> | undefined,
  tree: ShapeNode | undefined = treeFor(resourceType)
): PropertyShapeViolation[] {
  if (!tree) return [];
  if (typeof templateProperties !== 'object' || templateProperties === null) return [];
  if (Array.isArray(templateProperties)) return [];
  const violations: PropertyShapeViolation[] = [];
  const visit = (value: unknown, node: ShapeNode, path: string): void => {
    if (typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      if (node.kind === 'object') {
        violations.push({ resourceType, path, expected: 'object', found: 'array' });
        return;
      }
      const items = node.items;
      if (items) value.forEach((element, i) => visit(element, items, `${path}[${i}]`));
      return;
    }
    const record = value as Record<string, unknown>;
    if (isIntrinsic(record)) return;
    if (node.kind === 'array') {
      violations.push({ resourceType, path, expected: 'array', found: 'object' });
      return;
    }
    walkMembers(record, node, path);
  };
  const walkMembers = (record: Record<string, unknown>, node: ShapeNode, path: string): void => {
    if (node.props.size === 0) return;
    for (const key of Object.keys(record)) {
      const child = node.props.get(key);
      if (child) visit(record[key], child, path ? `${path}.${key}` : key);
    }
  };
  walkMembers(templateProperties as Record<string, unknown>, tree, '');
  return violations;
}

const KIND_NAME = { array: 'JSONArray', object: 'JSONObject' } as const;

/** Render one violation as a per-resource error line, in CloudFormation's words. */
export function buildPropertyShapeMessage(
  logicalId: string,
  violation: PropertyShapeViolation
): string {
  return (
    `  - ${displayIdent(logicalId)} (${violation.resourceType}): #/${violation.path}: ` +
    `expected type: ${KIND_NAME[violation.expected]}, found: ${KIND_NAME[violation.found]}`
  );
}

/**
 * Refuse every resource holding a property of the wrong kind, in ONE error, as
 * `validateNestedRequiredProperties` does, and with no `--allow-*` escape
 * hatch for the same reason: CloudFormation rejects the template too.
 */
export function validatePropertyShapes(
  resources: Iterable<{
    logicalId: string;
    resourceType: string;
    properties: Record<string, unknown> | undefined;
  }>
): void {
  const lines: string[] = [];
  for (const { logicalId, resourceType, properties } of resources) {
    for (const violation of findPropertyShapeViolations(resourceType, properties)) {
      lines.push(buildPropertyShapeMessage(logicalId, violation));
    }
  }
  if (lines.length === 0) return;

  throw new Error(
    `Properties validation failed: the following resources declare a property ` +
      `whose kind contradicts the resource type's schema:\n` +
      lines.join('\n') +
      `\n\nCloudFormation rejects these templates too. Give each property a list ` +
      `where its schema expects a list and an object where it expects an object.`
  );
}
