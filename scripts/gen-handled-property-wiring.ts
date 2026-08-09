/**
 * Codegen + CI critic: `handledProperties` wiring-evidence matrix.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `gen-property-coverage.ts` verifies that every CFn property of a registered
 * type is ACCOUNTED FOR — declared in the provider's `handledProperties` or in
 * `unhandledByDesign`. It never checks that a `handledProperties` entry is
 * actually WIRED. A declaration is just a string in a `new Set([...])`; nothing
 * ties it to a command builder.
 *
 * `ECRProvider` declared `ImageTagMutabilityExclusionFilters` handled while the
 * property appeared on NO API call at all — absent from `CreateRepository`,
 * absent from update's `PutImageTagMutability`. The property-level pre-flight
 * passed on the strength of the declaration alone, so the silent drop had no
 * mechanical backstop: the exact class the declaration system exists to
 * prevent (issue #1392, fixed in PR #1406; this critic is issue #1404).
 *
 * This is a false-negative mode distinct from the nested-key critic
 * (`gen-nested-key-coverage.ts`, #1373 / #1378), which compares CFn spellings
 * against SDK member spellings INSIDE a blob the provider already forwards.
 * Here the top-level property never reaches a command builder in the first
 * place, so there is no blob to compare.
 *
 * WHAT COUNTS AS EVIDENCE (and why it is TAINT-SCOPED, not file-global)
 * ---------------------------------------------------------------------
 * A file-global literal match is not acceptable: #1393 item 2 records a real
 * case where one cleared a genuine divergence. A CFn property name shows up in
 * plenty of places that prove nothing — a doc comment, a `getDriftUnknownPaths`
 * list, a `readCurrentState` reverse-mapping WRITE (`result['X'] = ...`), the
 * `handledProperties` declaration itself, or a DIFFERENT provider class in the
 * same file (many provider files hold several classes).
 *
 * So evidence is a READ off a binding that actually holds the template's
 * property bag, tracked per class by a small taint walk:
 *
 *   - SEED — every parameter of every member of THIS class whose name is
 *     property-bag-shaped (`properties`, `previousProperties`, `props`, ...;
 *     see {@link PROPERTY_BAG_PARAM_NAMES}), plus `const p = properties`
 *     aliases.
 *   - PROPAGATE — a call passing a tainted identifier WHOLE (`this.buildX(properties)`,
 *     `helper(properties)`, `...this.toSdkFields(properties)`) taints the
 *     callee's matching parameter and the walk continues into it. Both
 *     `this.x()` members and same-FILE free functions resolve; the walk is
 *     cycle-guarded on (callee, tainted-parameter-set). Passing a SUB-read
 *     (`this.toSdk(properties['Filters'])`) does not taint anything — the read
 *     already counted at the call site, which is the point.
 *   - EVIDENCE — `t['Name']` / `t.Name` / `const { Name } = t` where `t` is
 *     tainted. Nothing else counts.
 *   - TABLE-DRIVEN EVIDENCE — a computed read `t[k]` where `k` is the loop
 *     variable of a `for...of` over a literal name list credits every name in
 *     that list. Three real shapes in the tree depend on it: `GlueJobProvider`'s
 *     `for (const k of stringPassThrough) p[k as string]`, `SQSQueueProvider`'s
 *     `for (const [cdkKey] of Object.entries(CDK_TO_SQS_ATTRIBUTES))
 *     properties[cdkKey]`, and `EC2Provider`'s inline
 *     `for (const createOnly of ['VpcId', ...])`. Recognizing the shape is
 *     strictly better than allow-listing those ~30 properties: the names come
 *     from the table, so ADDING a declared property without adding it to the
 *     table still fails.
 *
 * Scoping the walk to one class is what makes a sibling class in the same file
 * unable to vouch for this class's declaration; module-level helpers are walked
 * per CALLING class, so a shared helper only lends evidence to classes that
 * actually call it.
 *
 * INDIRECT CONSUMPTION — BLIND SPOTS ARE RECORDED, NEVER AN EXCUSE
 * ----------------------------------------------------------------
 * Some sites hand the whole bag somewhere this walk cannot follow: a spread
 * (`{ ...properties }`), an unresolvable computed key (`properties[k]` with no
 * literal table behind `k`), or a call to a callee this script cannot resolve
 * (an import, a method on a field). Those are recorded per class as
 * `blindSpots` and rendered in the matrix — but they do NOT excuse a
 * declaration that has no read evidence.
 *
 * That is a deliberate, measured choice. The first draft DID let a blind spot
 * blanket-excuse the class's un-read declarations, and against the real tree it
 * was actively harmful: `ECRProvider` calls `hasCdkAutoDeleteTag(properties)`
 * in `delete()` (an unresolvable import), so the blanket excuse would have
 * silenced the very #1392 property this critic exists to catch. Checking the
 * whole tree, EVERY whole-bag site today is a diff / comparison loop
 * (`Object.keys({ ...properties, ...previousProperties })`,
 * `JSON.stringify(properties[k]) !== ...`), never a delivery, and 1059/1063
 * declared properties have direct read evidence — so the excuse rescued
 * exactly ZERO properties while creating a general-purpose mute button.
 * The sanctioned escape hatch for a genuinely un-followable shape is a
 * rationale'd {@link HANDLED_WIRING_ALLOW_LIST} entry (or, better, teaching the
 * walk the shape, as the table-driven rule above does for ~30 properties).
 *
 * A whole-bag call whose RESULT is only compared or measured is not a forward
 * at all and is not even recorded: `JSON.stringify(properties) ===
 * JSON.stringify(previousProperties)` (a no-op-change check) and
 * `Object.keys(properties).length > 0` (an emptiness check) both appear in
 * `EC2Provider`. See {@link isInertWholeBagUse} — the exemption is by SHAPE
 * (result feeds an equality / relational comparison, possibly through
 * `.length`), not by a callee-name list.
 *
 * OFFLINE-ONLY (NO AWS)
 * ---------------------
 * Reads `src/provisioning/providers/*.ts` via the TypeScript Compiler API.
 * Writes `docs/_generated/handled-property-wiring.{json,md}`.
 *
 * CLASSIFICATION (per provider class declaring `handledProperties`)
 * -----------------------------------------------------------------
 *   - wired        — every declared property has read evidence.
 *   - gap          — a declared property has none. BLOCKS CI (the #1392 class).
 *   - allow-listed — every remaining offender has a rationale'd allow-list
 *                    entry; stays VISIBLE in the matrix, does not block.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-handled-property-wiring.ts          # write the matrix
 *   node --experimental-strip-types scripts/gen-handled-property-wiring.ts --check  # fail on a gap
 *
 * CI runs the writer then `git diff --quiet` on the output AND the `--check`
 * critic, mirroring the sdk-attr / update-wrap / nested-key guards.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// `typescript-v6` is an npm alias of typescript@6 — TS7 no longer ships the
// stable JS compiler API (see the note in gen-property-coverage.ts).
import ts from 'typescript-v6';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');
const OUT_JSON = resolve(repoRoot, 'docs/_generated/handled-property-wiring.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/handled-property-wiring.md');

/**
 * Parameter names that hold the DESIRED-state CFn property bag — the one whose
 * values flow toward AWS. Seeding by NAME (in addition to the call-edge
 * propagation below) keeps the common private-helper shape
 * `private buildInput(props: Record<string, unknown>)` observable even when the
 * call site hands it a bag this walk did not taint.
 */
export const PROPERTY_BAG_PARAM_NAMES: ReadonlySet<string> = new Set([
  'properties',
  'props',
  'newProperties',
  'currentProperties',
  'desiredProperties',
  'resourceProperties',
]);

/**
 * PREVIOUS-state bags, deliberately NOT evidence-bearing and deliberately not
 * in {@link PROPERTY_BAG_PARAM_NAMES}.
 *
 * `previousProperties['X']` proves only that X participates in CHANGE
 * DETECTION; it says nothing about X ever reaching AWS, which is the property
 * this critic exists to establish. A provider that diffs a property and then
 * forgets to send it is the #1392 shape wearing a disguise.
 *
 * Measured before tightening: excluding these names moves ZERO of the 1063
 * declared properties out of `wired` (every one that is diffed is also read off
 * the desired bag), so the strictness costs nothing today and closes the
 * disguise for tomorrow.
 */
export const PREVIOUS_PROPERTY_BAG_PARAM_NAMES: ReadonlySet<string> = new Set([
  'previousProperties',
  'previousProps',
  'oldProperties',
]);

export interface AllowListEntry {
  readonly rationale: string;
}

/** Allow-list key: `ClassName#PropertyName`, so an entry cannot hide a NEW gap. */
export const allowKey = (className: string, property: string): string =>
  `${className}#${property}`;

/**
 * Per-(class, property) declarations the critic must not fail on. Two kinds of
 * entry belong here:
 *   - NOT-A-BUG: the property is genuinely consumed in a shape the evidence
 *     walk cannot see (prefer teaching the walk the shape over an entry here).
 *   - KNOWN GAP: a real wiring gap being worked off under a tracking issue —
 *     mirrors how `gen-sdk-attr-coverage.ts` seeded
 *     `AWS::Lambda::EventSourceMapping` so CI could go green on the NEW class
 *     while the pre-existing one stayed VISIBLE and tracked.
 *
 * Keying by PROPERTY (not class) is deliberate: a class allow-listed for
 * property A must still block CI when a NEW un-wired property B appears.
 */
export const HANDLED_WIRING_ALLOW_LIST: ReadonlyMap<string, AllowListEntry> = new Map<
  string,
  AllowListEntry
>([
  [
    allowKey('EC2Provider', 'MaxDrainDurationSeconds'),
    {
      // KNOWN GAP (real #1392-class silent drop), found by this critic's FIRST
      // run against the tree. `AWS::EC2::NatGateway.MaxDrainDurationSeconds` is
      // declared handled but the string appears nowhere else in `src/` — not in
      // CreateNatGateway, not in update, not in readCurrentState. Seeded here so
      // CI goes green on the NEW class only, mirroring how
      // `gen-sdk-attr-coverage.ts` seeded `AWS::Lambda::EventSourceMapping`;
      // deliberately NOT fixed in the PR that introduces the critic (that PR
      // must not touch `src/`, and a critic whose introduction also changes
      // provider behavior cannot be reviewed as a critic).
      rationale:
        'KNOWN GAP (issue #1411): AWS::EC2::NatGateway.MaxDrainDurationSeconds is declared handled but read nowhere in src/ — a real silent drop found by this critic on introduction; remove this entry when the provider wires it',
    },
  ],
  [
    allowKey('IAMAccessKeyProvider', 'Serial'),
    {
      // NOT-A-BUG, and the in-code JSDoc on the declaration says so: `Serial`'s
      // whole CFn semantic is "changing it forces a new key", implemented by the
      // diff layer's createOnly classification, so the integer is never sent to
      // IAM. It cannot move to `unhandledByDesign` either — on this
      // NON_PROVISIONABLE / `disableCcApiFallback` type the #614 viability guard
      // turns a silent-drop entry into a pre-flight HARD REJECT of any template
      // using `serial`.
      rationale:
        'NOT-A-BUG: Serial is a createOnly REPLACEMENT TRIGGER with no IAM API counterpart; the diff layer implements it, and moving it to unhandledByDesign would hard-reject templates via the #614 viability guard',
    },
  ],
  [
    allowKey('LogsLogGroupProvider', 'ResourcePolicyDocument'),
    {
      // KNOWN GAP, already documented in-code at the create() site: the property
      // maps to the SEPARATE account-wide `AWS::Logs::ResourcePolicy` resource
      // type, and is declared handled purely to keep the log group off the CC
      // API fallback path. Pre-existing, not introduced by this critic.
      rationale:
        'KNOWN GAP (issue #1412, pre-existing, documented in-code): declared handled only to suppress CC API fallback; the value maps to the separate account-wide AWS::Logs::ResourcePolicy type and is not wired into create/update',
    },
  ],
  [
    allowKey('NestedStackProvider', 'TemplateURL'),
    {
      // NOT-A-BUG: the child template is read from the LOCAL cloud-assembly path
      // (`Metadata['aws:asset:path']`), so the published S3 URL is informational
      // — the property is genuinely handled (the child stack IS deployed), just
      // not by reading this value. Declared handled so the property does not
      // land in the silent-drop set on a `disableCcApiFallback` type.
      rationale:
        "NOT-A-BUG: the child template is read from the local cloud assembly via Metadata['aws:asset:path'], so the published TemplateURL value is informational and never read",
    },
  ],
]);

/** One callable this walk can descend into: a class member or a file-local function. */
export interface Callable {
  readonly name: string;
  readonly params: readonly string[];
  readonly body: ts.Node;
}

const isFunctionLike = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n);

/** Parameter names of a function-like node; non-identifier (destructured) params yield ''. */
function paramNames(params: ts.NodeArray<ts.ParameterDeclaration>): string[] {
  return params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
}

/**
 * Collect the callable members of a provider class: `MethodDeclaration`s plus
 * arrow-function / function-expression class PROPERTIES (an uncollected shape
 * is silently invisible to the walk, which reads as "no evidence").
 */
export function collectClassMembers(cls: ts.ClassDeclaration): Map<string, Callable> {
  const out = new Map<string, Callable>();
  for (const member of cls.members) {
    if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.body) {
      out.set(member.name.text, {
        name: member.name.text,
        params: paramNames(member.parameters),
        body: member.body,
      });
    } else if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
      const init = member.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        out.set(member.name.text, {
          name: member.name.text,
          params: paramNames(init.parameters),
          body: init.body,
        });
      }
    }
  }
  return out;
}

/**
 * Collect file-local free functions (`function f() {}` and `const f = () => {}`)
 * so a class delegating to a module-level builder stays observable. They are
 * walked PER CALLING CLASS, so a helper shared by two classes only lends
 * evidence to the class that actually calls it.
 */
export function collectFileFunctions(sf: ts.SourceFile): Map<string, Callable> {
  const out = new Map<string, Callable>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      out.set(stmt.name.text, {
        name: stmt.name.text,
        params: paramNames(stmt.parameters),
        body: stmt.body,
      });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (
          ts.isIdentifier(decl.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          out.set(decl.name.text, {
            name: decl.name.text,
            params: paramNames(init.parameters),
            body: init.body,
          });
        }
      }
    }
  }
  return out;
}

/** A CFn property name: PascalCase, letters/digits only. */
const isCfnPropertyName = (name: string): boolean => /^[A-Z][A-Za-z0-9]*$/.test(name);

/** Strip `as T` / `satisfies T` / parentheses so the underlying node is visible. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n)) {
    n = n.expression;
  }
  return n;
}

/**
 * Every `const x = ['A', 'B']` / `const x = { A: ..., B: ... }` in the file,
 * mapped to its literal name set. Used to resolve the table behind a
 * `for (const k of TABLE)` loop.
 *
 * Collected FILE-wide (not per scope), so two same-named locals in different
 * functions pool their names. That looseness only ever ADDS evidence names for
 * a table-driven read the walk already saw, which is a far smaller risk than
 * missing the shape entirely; a shadowed table name is not a pattern in this
 * tree.
 */
export function collectLiteralNameSets(sf: ts.SourceFile): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const names = literalNameSetOf(unwrap(node.initializer), out);
      if (names) out.set(node.name.text, names);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The set of NAMES an expression can yield as an object key: an array literal's
 * string elements, an object literal's property names, `Object.keys(...)` /
 * `Object.entries(...)` of either, or an identifier bound to one of those.
 * Returns null when the expression is not a literal name source.
 */
function literalNameSetOf(
  expr: ts.Expression,
  known: ReadonlyMap<string, Set<string>>
): Set<string> | null {
  const node = unwrap(expr);
  if (ts.isArrayLiteralExpression(node)) {
    const names = new Set<string>();
    for (const el of node.elements) {
      const e = unwrap(el);
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) names.add(e.text);
      else return null; // a non-literal element means the list is not fully known
    }
    return names;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const names = new Set<string>();
    for (const p of node.properties) {
      if (!p.name) return null;
      if (ts.isIdentifier(p.name)) names.add(p.name.text);
      else if (ts.isStringLiteral(p.name)) names.add(p.name.text);
      else return null;
    }
    return names;
  }
  if (ts.isIdentifier(node)) return known.get(node.text) ?? null;
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Object' &&
    (node.expression.name.text === 'keys' || node.expression.name.text === 'entries') &&
    node.arguments.length === 1
  ) {
    return literalNameSetOf(node.arguments[0]!, known);
  }
  return null;
}

/**
 * Is this whole-bag call inert — its result only compared or measured, never
 * forwarded? `JSON.stringify(properties) === JSON.stringify(previousProperties)`
 * and `Object.keys(properties).length > 0` are checks, not deliveries, and
 * treating them as opaque forwards blinds the class to REAL gaps.
 *
 * Shape-based on purpose: a call whose result is an operand of an equality /
 * relational comparison (optionally through a `.length` read) cannot have
 * delivered a property value to AWS.
 */
export function isInertWholeBagUse(call: ts.Node): boolean {
  let node: ts.Node = call;
  let parent = node.parent as ts.Node | undefined;
  // Step through `.length` (and any parenthesization) once.
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      (ts.isPropertyAccessExpression(parent) && parent.name.text === 'length'))
  ) {
    node = parent;
    parent = node.parent as ts.Node | undefined;
  }
  if (!parent || !ts.isBinaryExpression(parent)) return false;
  switch (parent.operatorToken.kind) {
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
      return true;
    default:
      return false;
  }
}

/**
 * How a property earned its evidence. Recorded per property so the matrix (and
 * the unit tests' per-SHAPE real-repo floors) can tell a live recognizer from a
 * dead one — an aggregate "1059 wired" would let a whole shape stop working
 * while the total absorbed the loss.
 *
 * `delegated` is orthogonal to the other four: it rides along when the read
 * happened inside a callable reached through a call edge rather than in the
 * seeded member itself.
 */
export type EvidenceShape =
  | 'element-read'
  | 'property-read'
  | 'destructure'
  | 'table-loop'
  | 'delegated';

export interface EvidenceResult {
  /** Property names read off a tainted property bag, with the shapes that proved it. */
  readonly readNames: Map<string, Set<EvidenceShape>>;
  /**
   * Sites where the whole bag left the walk's sight: `{ ...properties }`, an
   * unresolvable computed key, `someImport(properties)`. Reported as matrix
   * VISIBILITY only — they never excuse a declaration with no read evidence
   * (see the module header for why that excuse was removed).
   */
  readonly blindSpots: Set<string>;
}

/**
 * Walk one provider class collecting the CFn property names it reads off a
 * property bag, plus the sites where a whole bag escapes observation.
 *
 * Exported so unit tests can drive it with synthetic classes.
 */
export function collectEvidence(
  cls: ts.ClassDeclaration,
  fileFunctions: ReadonlyMap<string, Callable> = new Map(),
  literalNameSets: ReadonlyMap<string, Set<string>> = new Map()
): EvidenceResult {
  const members = collectClassMembers(cls);
  const readNames = new Map<string, Set<EvidenceShape>>();
  const blindSpots = new Set<string>();
  const visited = new Set<string>();

  const walkCallable = (
    fn: Callable,
    taintedParams: ReadonlySet<number>,
    owner: string,
    viaDelegation: boolean
  ): void => {
    const key = `${owner}.${fn.name}:${[...taintedParams].sort((a, b) => a - b).join(',')}`;
    if (visited.has(key)) return;
    visited.add(key);

    const record = (name: string, shape: EvidenceShape): void => {
      const shapes = readNames.get(name) ?? new Set<EvidenceShape>();
      shapes.add(shape);
      if (viaDelegation) shapes.add('delegated');
      readNames.set(name, shapes);
    };

    // Seed: desired-state-bag parameter names + the call-edge tainted indices.
    // A PREVIOUS-state bag never taints, even when a call edge hands it in —
    // reading a name off it is change detection, not delivery.
    const tainted = new Set<string>();
    fn.params.forEach((p, i) => {
      if (p === '' || PREVIOUS_PROPERTY_BAG_PARAM_NAMES.has(p)) return;
      if (PROPERTY_BAG_PARAM_NAMES.has(p) || taintedParams.has(i)) tainted.add(p);
    });

    const isTainted = (n: ts.Node): boolean => {
      const u = ts.isExpression(n) ? unwrap(n) : n;
      return ts.isIdentifier(u) && tainted.has(u.text);
    };

    // Loop variables whose value set is a known list of literal names, so a
    // computed read `t[k]` credits every name in the table (see the module
    // header's TABLE-DRIVEN EVIDENCE note).
    const keySets = new Map<string, Set<string>>();

    const walk = (node: ts.Node): void => {
      // `for (const k of TABLE)` / `for (const [k] of Object.entries(TABLE))`
      if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        const names = literalNameSetOf(node.expression, literalNameSets);
        const decl = node.initializer.declarations[0];
        if (names && decl) {
          if (ts.isIdentifier(decl.name)) keySets.set(decl.name.text, names);
          else if (ts.isArrayBindingPattern(decl.name)) {
            const first = decl.name.elements[0];
            if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
              keySets.set(first.name.text, names);
            }
          }
        }
      }

      // `const alias = properties;` — the alias reads the same bag.
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isTainted(node.initializer)
      ) {
        tainted.add(node.name.text);
      }

      // `const { Name, Other: alias } = properties;`
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isTainted(node.initializer)
      ) {
        for (const el of node.name.elements) {
          const src = el.propertyName ?? el.name;
          if (ts.isIdentifier(src) && isCfnPropertyName(src.text)) record(src.text, 'destructure');
          else if (ts.isStringLiteral(src) && isCfnPropertyName(src.text)) {
            record(src.text, 'destructure');
          }
          if (el.dotDotDotToken) blindSpots.add(`rest-destructure in ${fn.name}()`);
        }
      }

      // `properties['Name']` / `properties[k]` where k iterates a literal table
      if (ts.isElementAccessExpression(node) && isTainted(node.expression)) {
        const arg = unwrap(node.argumentExpression);
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          if (isCfnPropertyName(arg.text)) record(arg.text, 'element-read');
        } else if (ts.isIdentifier(arg) && keySets.has(arg.text)) {
          for (const n of keySets.get(arg.text)!) {
            if (isCfnPropertyName(n)) record(n, 'table-loop');
          }
        } else {
          // `properties[someVar]` with no resolvable name table — the read
          // could name any property, so nothing here can be verified.
          blindSpots.add(`computed key in ${fn.name}()`);
        }
      }

      // `properties.Name`
      if (
        ts.isPropertyAccessExpression(node) &&
        isTainted(node.expression) &&
        isCfnPropertyName(node.name.text)
      ) {
        record(node.name.text, 'property-read');
      }

      // `{ ...properties }` — the whole bag forwarded into a builder.
      if (ts.isSpreadAssignment(node) && isTainted(node.expression)) {
        blindSpots.add(`object spread in ${fn.name}()`);
      }

      // A call receiving the WHOLE bag: follow it when resolvable, record a
      // blind spot when not (an import, a method on a field, a global).
      if (ts.isCallExpression(node)) {
        const taintedArgIdx = new Set<number>();
        node.arguments.forEach((a, i) => {
          if (isTainted(a)) taintedArgIdx.add(i);
          else if (ts.isSpreadElement(a) && isTainted(a.expression)) taintedArgIdx.add(i);
        });
        if (taintedArgIdx.size > 0 && !isInertWholeBagUse(node)) {
          const callee = node.expression;
          let target: Callable | undefined;
          let calleeName = 'callee';
          if (
            ts.isPropertyAccessExpression(callee) &&
            callee.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            calleeName = `this.${callee.name.text}`;
            target = members.get(callee.name.text);
          } else if (ts.isIdentifier(callee)) {
            calleeName = callee.text;
            target = fileFunctions.get(callee.text);
          } else if (ts.isPropertyAccessExpression(callee)) {
            calleeName = `${callee.expression.getText()}.${callee.name.text}`;
          }
          if (target) walkCallable(target, taintedArgIdx, owner, true);
          else blindSpots.add(`${calleeName}(...) in ${fn.name}()`);
        }
      }

      ts.forEachChild(node, walk);
    };

    walk(fn.body);
  };

  for (const member of members.values()) walkCallable(member, new Set(), 'this', false);
  return { readNames, blindSpots };
}

/**
 * Parse ONE class's `handledProperties` declaration:
 *
 *   handledProperties = new Map<string, ReadonlySet<string>>([
 *     ['AWS::ECR::Repository', new Set(['RepositoryName', ...])],
 *   ]);
 */
export function parseHandledProperties(cls: ts.ClassDeclaration): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const member of cls.members) {
    if (
      !ts.isPropertyDeclaration(member) ||
      !ts.isIdentifier(member.name) ||
      member.name.text !== 'handledProperties' ||
      !member.initializer
    ) {
      continue;
    }
    const init = member.initializer;
    if (!ts.isNewExpression(init) || init.arguments === undefined) continue;
    const arrayArg = init.arguments[0];
    if (!arrayArg || !ts.isArrayLiteralExpression(arrayArg)) continue;
    for (const el of arrayArg.elements) {
      if (!ts.isArrayLiteralExpression(el) || el.elements.length < 2) continue;
      const [typeNode, setNode] = el.elements;
      if (!typeNode || !ts.isStringLiteral(typeNode)) continue;
      if (!setNode || !ts.isNewExpression(setNode) || setNode.arguments === undefined) continue;
      const setArg = setNode.arguments[0];
      if (!setArg || !ts.isArrayLiteralExpression(setArg)) continue;
      const props = new Set<string>();
      for (const p of setArg.elements) {
        if (ts.isStringLiteral(p) || ts.isNoSubstitutionTemplateLiteral(p)) props.add(p.text);
      }
      out.set(typeNode.text, props);
    }
  }
  return out;
}

export type Bucket = 'wired' | 'gap' | 'allow-listed';

export type PropertyStatus = 'wired' | 'allow-listed' | 'gap';

export interface PropertyClassification {
  readonly name: string;
  readonly status: PropertyStatus;
  /** Resource types whose declaration includes this property. */
  readonly types: readonly string[];
  /** Which evidence shape(s) proved the read. Empty for non-`wired` statuses. */
  readonly evidence: readonly EvidenceShape[];
  readonly rationale?: string;
}

export interface ClassClassification {
  readonly file: string;
  readonly className: string;
  readonly bucket: Bucket;
  readonly declaredCount: number;
  readonly properties: readonly PropertyClassification[];
  /** Declared properties with no read evidence (blocking, unless allow-listed). */
  readonly gaps: readonly string[];
  /** Sites where a whole property bag escaped the evidence walk. */
  readonly blindSpots: readonly string[];
}

/** Classify every provider class in one source file. Pure + exported for tests. */
export function classifySource(
  source: string,
  fileName = 'provider.ts',
  allowList: ReadonlyMap<string, AllowListEntry> = HANDLED_WIRING_ALLOW_LIST
): ClassClassification[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const fileFunctions = collectFileFunctions(sf);
  const literalNameSets = collectLiteralNameSets(sf);
  const out: ClassClassification[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const handled = parseHandledProperties(node);
      if (handled.size > 0) {
        const className = node.name.text;
        const { readNames, blindSpots } = collectEvidence(
          node,
          fileFunctions,
          literalNameSets
        );

        // Pool the declared properties across the types this class serves;
        // evidence is class-scoped, so per-type scoping would be false
        // precision (see the KNOWN false negative in the module header).
        const typesByProp = new Map<string, string[]>();
        for (const [type, props] of handled) {
          for (const p of props) {
            const list = typesByProp.get(p) ?? [];
            list.push(type);
            typesByProp.set(p, list);
          }
        }

        const properties: PropertyClassification[] = [];
        const gaps: string[] = [];
        let allowListedHits = 0;
        for (const name of [...typesByProp.keys()].sort((a, b) => a.localeCompare(b))) {
          const types = (typesByProp.get(name) ?? []).sort((a, b) => a.localeCompare(b));
          const shapes = readNames.get(name);
          if (shapes) {
            properties.push({
              name,
              status: 'wired',
              types,
              evidence: [...shapes].sort((a, b) => a.localeCompare(b)),
            });
            continue;
          }
          const allow = allowList.get(allowKey(className, name));
          if (allow) {
            allowListedHits += 1;
            properties.push({
              name,
              status: 'allow-listed',
              types,
              evidence: [],
              rationale: allow.rationale,
            });
          } else {
            properties.push({ name, status: 'gap', types, evidence: [] });
            gaps.push(name);
          }
        }

        // Un-allow-listed gaps always win, so an allow-listed class with a NEW
        // gap still blocks CI.
        const bucket: Bucket =
          gaps.length > 0 ? 'gap' : allowListedHits > 0 ? 'allow-listed' : 'wired';

        out.push({
          file: fileName,
          className,
          bucket,
          declaredCount: properties.length,
          properties,
          gaps,
          blindSpots: [...blindSpots].sort((a, b) => a.localeCompare(b)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface HandledPropertyWiringReport {
  readonly schemaVersion: 1;
  readonly summary: {
    readonly classifiedCount: number;
    readonly declaredProperties: number;
    readonly wiredProperties: number;
    readonly wired: number;
    readonly gap: number;
    readonly allowListed: number;
    /** Classes with at least one site where the whole bag left the walk's sight. */
    readonly classesWithBlindSpots: number;
  };
  readonly classes: readonly ClassClassification[];
}

export function buildReport(
  classes: readonly ClassClassification[]
): HandledPropertyWiringReport {
  const sorted = [...classes].sort(
    (a, b) => a.file.localeCompare(b.file) || a.className.localeCompare(b.className)
  );
  const allProps = sorted.flatMap((c) => c.properties);
  return {
    schemaVersion: 1,
    summary: {
      classifiedCount: sorted.length,
      declaredProperties: allProps.length,
      wiredProperties: allProps.filter((p) => p.status === 'wired').length,
      wired: sorted.filter((c) => c.bucket === 'wired').length,
      gap: sorted.filter((c) => c.bucket === 'gap').length,
      allowListed: sorted.filter((c) => c.bucket === 'allow-listed').length,
      classesWithBlindSpots: sorted.filter((c) => c.blindSpots.length > 0).length,
    },
    classes: sorted,
  };
}

/** The `--check` gate: the classes the critic hard-fails on. */
export function findGaps(
  report: HandledPropertyWiringReport
): readonly ClassClassification[] {
  return report.classes.filter((c) => c.bucket === 'gap');
}

/**
 * Allow-list entries that no longer match a real un-wired declaration — the
 * property is now wired, renamed, or removed. Stale entries must fail in BOTH
 * modes so a fix forces the entry's removal (which is what makes the critic
 * VERIFY the fix instead of permanently excusing it).
 */
export function findStaleAllowListEntries(
  report: HandledPropertyWiringReport,
  allowList: ReadonlyMap<string, AllowListEntry> = HANDLED_WIRING_ALLOW_LIST
): readonly string[] {
  const live = new Set<string>();
  for (const c of report.classes) {
    for (const p of c.properties) {
      if (p.status === 'allow-listed') live.add(allowKey(c.className, p.name));
    }
  }
  return [...allowList.keys()].filter((k) => !live.has(k)).sort((a, b) => a.localeCompare(b));
}

function renderMarkdown(report: HandledPropertyWiringReport): string {
  const lines: string[] = [];
  lines.push('# `handledProperties` wiring-evidence matrix');
  lines.push('');
  lines.push(
    '<!-- AUTO-GENERATED by scripts/gen-handled-property-wiring.ts — DO NOT EDIT BY HAND. -->'
  );
  lines.push('<!-- Regenerate: `vp run gen:handled-property-wiring`. -->');
  lines.push('');
  lines.push(
    'For every SDK provider class declaring `handledProperties`, checks that each ' +
      'declared property is actually CONSUMED — a read off the template property bag ' +
      '(`properties[\'X\']` / `properties.X` / a destructure), tracked per class through ' +
      '`this.helper(properties)` delegation. A declaration with no such evidence is ' +
      'either a wiring gap or a mis-declared property (the #1392 `ECRProvider` class), ' +
      'and `gen-property-coverage.ts` cannot see it: that pre-flight passes on the ' +
      'strength of the declaration alone.'
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Provider classes classified: **${report.summary.classifiedCount}**`);
  lines.push(
    `- Declared properties: **${report.summary.declaredProperties}** ` +
      `(**${report.summary.wiredProperties}** with read evidence)`
  );
  lines.push(`- Fully wired classes: **${report.summary.wired}**`);
  lines.push(`- Allow-listed classes (visible, non-blocking): **${report.summary.allowListed}**`);
  lines.push(
    `- Classes with a whole-bag blind spot (recorded, never an excuse): ` +
      `**${report.summary.classesWithBlindSpots}**`
  );
  lines.push(`- **Wiring gaps (blocks CI): ${report.summary.gap}**`);
  lines.push('');

  const gapClasses = report.classes.filter((c) => c.bucket === 'gap');
  if (gapClasses.length > 0) {
    lines.push('## Wiring gaps (declared handled, never read) — BLOCKS CI');
    lines.push('');
    lines.push(
      'Wire the property into the create/update command builder, move it to ' +
        '`unhandledByDesign` with a rationale, or add a `HANDLED_WIRING_ALLOW_LIST` entry.'
    );
    lines.push('');
    lines.push('| Provider class | Un-wired declared properties |');
    lines.push('| --- | --- |');
    for (const c of gapClasses) {
      lines.push(`| \`${c.className}\` (${c.file}) | ${c.gaps.map((g) => `\`${g}\``).join(', ')} |`);
    }
    lines.push('');
  } else {
    lines.push('## Wiring gaps');
    lines.push('');
    lines.push(
      'None. Every declared `handledProperties` entry has read evidence or a rationale\'d allow-list entry.'
    );
    lines.push('');
  }

  const allowed = report.classes.flatMap((c) =>
    c.properties.filter((p) => p.status === 'allow-listed').map((p) => ({ c, p }))
  );
  if (allowed.length > 0) {
    lines.push('## Allow-listed declarations — VISIBLE, non-blocking');
    lines.push('');
    lines.push(
      'Declared handled with no read evidence, deliberately not failing CI. A `KNOWN ' +
        'GAP` rationale is a real un-wired property awaiting a fix (removing the entry ' +
        'is what makes this critic verify that fix); a `NOT-A-BUG` rationale is a ' +
        'declaration that is correct without a read.'
    );
    lines.push('');
    lines.push('| Provider class | Property | Type(s) | Rationale |');
    lines.push('| --- | --- | --- | --- |');
    for (const { c, p } of allowed) {
      lines.push(
        `| \`${c.className}\` | \`${p.name}\` | ${p.types.map((t) => `\`${t}\``).join(', ')} | ${p.rationale ?? ''} |`
      );
    }
    lines.push('');
  }

  const blind = report.classes.filter((c) => c.blindSpots.length > 0);
  if (blind.length > 0) {
    lines.push('## Whole-bag blind spots — visibility only, NOT an excuse');
    lines.push('');
    lines.push(
      'Sites where a whole property bag left the evidence walk (a spread, an ' +
        'unresolvable computed key, a call this script cannot resolve). Every class ' +
        'below still had to earn read evidence for each declared property; the list ' +
        'exists so a reviewer can see where the analysis is blind. Calls whose result ' +
        'only feeds a comparison (`JSON.stringify(properties) === ...`) are not blind ' +
        'spots and are not listed.'
    );
    lines.push('');
    lines.push('| Provider class | Blind spot(s) |');
    lines.push('| --- | --- |');
    for (const c of blind) {
      lines.push(
        `| \`${c.className}\` (${c.file}) | ${c.blindSpots.map((f) => `\`${f}\``).join(', ')} |`
      );
    }
    lines.push('');
  }

  lines.push('## Full classification');
  lines.push('');
  lines.push('| Provider class | File | Bucket | Declared | Wired |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of report.classes) {
    const wired = c.properties.filter((p) => p.status === 'wired').length;
    lines.push(
      `| \`${c.className}\` | ${c.file} | ${c.bucket} | ${c.declaredCount} | ${wired} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const isMainModule = (): boolean =>
  Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename;

export function loadReport(providersDir: string = PROVIDERS_DIR): HandledPropertyWiringReport {
  const classes: ClassClassification[] = [];
  for (const file of readdirSync(providersDir).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    classes.push(...classifySource(readFileSync(join(providersDir, file), 'utf8'), file));
  }
  return buildReport(classes);
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  const report = loadReport();
  const stale = findStaleAllowListEntries(report);

  if (checkMode) {
    const gaps = findGaps(report);
    if (gaps.length > 0) {
      process.stderr.write(
        'handled-property-wiring: FAIL — declared-but-unwired handledProperties entries.\n' +
          'Each property below is declared handled by its provider class but is never READ\n' +
          "off the template property bag (`properties['X']` / `properties.X` / a\n" +
          'destructure, followed through this.helper(properties) delegation), so cdkd would\n' +
          'silently DROP it on write while the property-coverage pre-flight waves the\n' +
          'template through (the #1392 ECRProvider class). Wire it into the create/update\n' +
          'command builder, move it to `unhandledByDesign` with a rationale, OR add a\n' +
          'HANDLED_WIRING_ALLOW_LIST entry with a rationale in\n' +
          'scripts/gen-handled-property-wiring.ts.\n\n'
      );
      for (const c of gaps) {
        for (const g of c.gaps) process.stderr.write(`  ${c.className}#${g} (${c.file})\n`);
      }
      process.exit(1);
    }
    if (stale.length > 0) {
      process.stderr.write(
        'handled-property-wiring: FAIL — stale HANDLED_WIRING_ALLOW_LIST entries.\n' +
          'These no longer match an un-wired declaration (the property is now wired,\n' +
          'renamed, or removed). Delete them so the critic verifies the fix:\n\n'
      );
      for (const k of stale) process.stderr.write(`  ${k}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `handled-property-wiring: OK — ${report.summary.classifiedCount} provider classes, ` +
        `${report.summary.wiredProperties}/${report.summary.declaredProperties} declared ` +
        `properties with read evidence, 0 gaps (${report.summary.wired} wired, ` +
        `${report.summary.allowListed} allow-listed, ` +
        `${report.summary.classesWithBlindSpots} with a recorded blind spot).\n`
    );
    return;
  }

  if (stale.length > 0) {
    process.stderr.write(
      `handled-property-wiring: stale allow-list entr(ies): ${stale.join(', ')}\n`
    );
    process.exit(1);
  }

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(OUT_MD, renderMarkdown(report) + '\n');
  process.stderr.write(
    `handled-property-wiring: wrote handled-property-wiring.{json,md} — ` +
      `${report.summary.classifiedCount} classes, ${report.summary.declaredProperties} declared ` +
      `properties, ${report.summary.wiredProperties} wired, ${report.summary.gap} gap class(es), ` +
      `${report.summary.classesWithBlindSpots} class(es) with a recorded blind spot.\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`handled-property-wiring: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
