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
 *     that list, but ONLY when the loop body actually DELIVERS one of those
 *     reads (see below). Two real shapes in the tree depend on it:
 *     `GlueJobProvider`'s `for (const k of stringPassThrough) r[k] = p[k as string]`
 *     and `SQSQueueProvider`'s `for (const [cdkKey] of
 *     Object.entries(CDK_TO_SQS_ATTRIBUTES)) attributes[sqsKey] =
 *     properties[cdkKey]`. Recognizing the shape is strictly better than
 *     allow-listing those 29 properties: the names come from the table, so
 *     ADDING a declared property without adding it to the table still fails.
 *     49 declared properties across 8 classes carry a `table-loop` tag today;
 *     29 of them would flip straight to `gap` if the recognizer died
 *     (GlueJobProvider 16, SQSQueueProvider 13), which is what makes the
 *     delivery requirement below load-bearing rather than cosmetic. "Would flip
 *     to gap" rather than "has table-loop as its only evidence", because the two
 *     readings differ and review split on them: only 13 have an evidence array
 *     of EXACTLY `['table-loop']` (all SQS), while Glue's 16 read
 *     `['delegated', 'table-loop']`. Both flip, because `delegated` is a tag
 *     added INSIDE `record()` and never stands alone — measured, zero properties
 *     carry it by itself — so losing the only recording shape leaves no
 *     evidence at all. (The totals move whenever a provider
 *     adds or drops a pass-through table — they were 43 across 5 at #1414 and
 *     47 across 7 before #1808 — so treat them as a snapshot, not an invariant;
 *     the enforced floors live in the unit suite.)
 *
 * TABLE LOOPS MUST DELIVER, NOT MERELY COMPARE
 * --------------------------------------------
 * A `for...of` over a literal name list is not automatically a delivery. The
 * third real shape in the tree, `EC2Provider.updateSubnet`, is
 *
 *   for (const createOnly of ['VpcId', 'CidrBlock', 'AvailabilityZone']) {
 *     const next = properties[createOnly];
 *     const prev = previousProperties[createOnly];
 *     if (next !== undefined && prev !== undefined && next !== prev) throw ...;
 *   }
 *
 * — a change GUARD whose body only compares the two bags and throws. Crediting
 * it would smuggle back exactly the disguise the `previousProperties` exclusion
 * below exists to block, one syntactic level up and multiplied by the size of
 * the table. So a table read credits its names only when at least one read of
 * `t[k]` inside that loop body is NOT comparison-only, where "comparison-only"
 * follows the value one `const` hop: `const next = properties[k]` whose every
 * reference is a comparison / `typeof` / truthiness operand is still just a
 * comparison. `Glue`'s `r[k] = p[k]` and `SQS`'s `attributes[sqsKey] =
 * stringifyValue(value)` are assignments into the outgoing request and pass;
 * the EC2 guard does not (its three names keep their independent
 * `element-read` evidence from `createSubnet`, so nothing regressed).
 * A recognized-but-comparison-only loop is not recorded as a blind spot: it is
 * fully understood, just not a delivery — the same treatment
 * {@link isInertWholeBagUse} gives a compared-only whole-bag call.
 *
 * Measured on introduction: the rule withdrew the `table-loop` tag from 46
 * declared properties across 8 classes — every one of them an immutability /
 * change-detection guard (`EC2Provider.updateSubnet`,
 * `AppSyncProvider.updateDataSource`, `EFSProvider.updateFileSystem`,
 * `LambdaFunctionProvider`'s `configFields` scan, `RDSDBProxy*`'s immutable
 * field scan, `FirehoseProvider.detectDestinationKey`) — and NONE of them
 * became a gap, because all 46 are also read individually off the desired bag.
 * `RDSDBProxyProvider` is the clean demonstration that the check discriminates
 * rather than blanket-denies: its immutable-field loop lost the credit while
 * its `mutableFields` loop three lines later, whose body does
 * `input[sdkKey] = properties[key]`, kept it.
 *
 * The delivery requirement is applied to TABLE loops specifically, not to every
 * `element-read`, because a table read converts ONE syntactic site into credit
 * for N properties. The leverage is what makes a false positive there
 * qualitatively worse than a single mis-credited `properties['X']`.
 *
 * Scoping the walk to one class is what makes a sibling class in the same file
 * unable to vouch for this class's declaration; module-level helpers are walked
 * per CALLING class, so a shared helper only lends evidence to classes that
 * actually call it. The literal name table behind a loop is likewise resolved
 * LEXICALLY — from the loop outward through its enclosing blocks, function
 * bodies and finally module scope (see {@link resolveLiteralNameSetAt}). An
 * earlier draft pooled every `const x = [...]` in the FILE into one map, which
 * let a table declared inside one class's method vouch for a different class in
 * the same file, and let two same-named tables (`glue-provider.ts` has `result`
 * x12, `out` x5, `toAdd` x3) silently override each other last-wins.
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
 * `JSON.stringify(properties[k]) !== ...`), never a delivery, and 1136/1138
 * declared properties have direct read evidence — so the excuse rescued
 * exactly ZERO properties while creating a general-purpose mute button.
 * The sanctioned escape hatch for a genuinely un-followable shape is a
 * rationale'd {@link HANDLED_WIRING_ALLOW_LIST} entry (or, better, teaching the
 * walk the shape, as the table-driven rule above does for 49 properties).
 *
 * An UNRESOLVABLE whole-bag call whose RESULT is only compared or measured is
 * not a forward at all and is not even recorded: `JSON.stringify(properties) ===
 * JSON.stringify(previousProperties)` (a no-op-change check) and
 * `Object.keys(properties).length > 0` (an emptiness check) both appear in
 * `EC2Provider`. See {@link isInertWholeBagUse} — the exemption is by SHAPE
 * (result feeds an equality / relational comparison, or its `.length` is taken
 * at all), not by a callee-name list.
 *
 * The exemption applies ONLY to that unresolvable branch. A callee this walk CAN
 * resolve is always descended into, whatever its result feeds: an earlier
 * revision tested inertness first and so skipped the whole branch on
 * `if (this.buildInput(properties) !== undefined)`, dropping every read inside
 * `buildInput` AND recording no blind spot — evidence disappearing with nothing
 * in the matrix to show for it, the one failure mode this section exists to
 * prevent.
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
 * `wired` IS A FLOOR OF ONE — SO EVIDENCE LOSS IS ITS OWN VERDICT
 * ---------------------------------------------------------------
 * The three buckets above only ask whether SOME read survives, and that made
 * the verdict insensitive to degradation (issue #1842). A property can fall
 * from `delegated` + `element-read` proven across four seeding members down to
 * a single weak seed and still print `OK — ... 0 gaps` byte-identically.
 *
 * MEASURED on the real `dynamodb-table-provider.ts`: respelling the ONE
 * delegated read inside `declaresWarmThroughput()` drops `WarmThroughput`'s
 * `delegated` evidence AND its `getDriftUnknownPaths` / `readCurrentState`
 * seeds, while the pre-fix `--check` output stays byte-identical to its
 * clean-tree line. PR #1808 rewrote that very read into the
 * `properties !== undefined && ...` spelling FOR THIS REASON — its own in-code
 * comment records that the `!` form was "INVISIBLE to that critic and silently
 * dropped `WarmThroughput`'s `getDriftUnknownPaths` / `readCurrentState`
 * evidence from the checked-in matrix" — which is this issue in one line, and
 * an independent confirmation of the measurement.
 *
 * Stated PER SITE because the breadth matters: respelling EVERY
 * `WarmThroughput` read instead removes the last evidence and is caught as an
 * ordinary `gap`, which proves nothing about this verdict.
 *
 * The issue's summary also named `table-loop` evidence on
 * `GlobalSecondaryIndexes` / `LocalSecondaryIndexes`. That was NOT true of the
 * tree when this fix was written and IS true now: #1808 introduced the table
 * loop, so both properties carry `element-read` + `table-loop` today. The claim
 * was re-measured rather than inherited in either direction — which is the
 * point, since a rationale that cites a tree state ages with the tree.
 *
 * The loss is visible only as a regenerated file diff that the SAME commit can
 * carry. Green pipeline, weakened matrix.
 *
 * So {@link findEvidenceLosses} compares the fresh analysis against the
 * COMMITTED matrix per (class, property) and fails when the evidence set or the
 * seeding-member set shrank. The direction is deliberate: this critic exists to
 * make a FALSE `handledProperties` claim reachable, so a REAL claim silently
 * becoming unprovable is the dangerous failure, and a strengthening is free.
 *
 * The check is enforced on BOTH paths, which is what keeps it reachable:
 *   - the WRITER refuses to overwrite the matrix with weaker evidence. This is
 *     the half CI actually exercises: the workflow runs the writer FIRST and
 *     then `git diff --quiet`, so by the time `--check` runs, the baseline on
 *     disk is the file the writer just produced and its loss arm can no longer
 *     fire. It is also the half that closes the hole, because regenerating is
 *     what moves the baseline underneath the comparison — exactly how the
 *     #1808 degradation shipped green.
 *   - `--check` fails on any loss for every OTHER caller: a local run, a
 *     reviewer grading a branch, or any pipeline that checks before it writes.
 *
 * A VERDICT REQUIRES A BASELINE THAT COULD HAVE FAILED
 * ----------------------------------------------------
 * Grading against a file invites making the file stop being able to fail.
 * Review found FIVE spellings of that, one per round, each slipping the previous
 * round's guard — DELETED (staged, so `git diff --quiet` stayed green),
 * TRUNCATED (parses, well-formed header), EMPTY (`classes: []`, passing every
 * structural check), SHRUNKEN (cut to one pair, which OVERLAPS so non-vacuity
 * waved it through) and STRIPPED (`evidence` / `seededBy` blanked while every
 * count stays intact). Each landed the same way: both modes report success at
 * exit 0 and the tamper is overwritten without trace. STRIPPED is the worst,
 * because the mitigation then announces `graded 1138/1138` having graded nothing.
 *
 * The pattern behind all five is one bug: rounds 1-4 each constrained something
 * ADJACENT to the comparison — a pair count, then two summary counts — and never
 * the fields the comparison READS. So the rule is not "reject these five
 * shapes"; it is that an integrity check must constrain exactly what the
 * consumer consumes. {@link assessBaseline} states that as three positive
 * conditions (self-consistent over the WHOLE summary, evidence-bearing on every
 * `wired` property, non-vacuous against the tree being graded), and the five
 * spellings fall out of it rather than being enumerated.
 *
 * Partial coverage is handled by visibility rather than by a threshold nobody
 * could defend: EVERY run — writer included — prints `graded N/M pairs`. The
 * residual bound is stated on {@link assessBaseline}: what conditions 1-3 admit
 * is a baseline that agrees with itself AND overlaps this tree — so a
 * self-consistent SUBSET is usable and grades only what it covers.
 *
 * TWO ESCAPE HATCHES, deliberately SEPARATE, both WRITER-ONLY:
 *   - `--accept-evidence-loss` acknowledges a measured reduction, and prints
 *     every lost (class, property) with its shapes and seeds before writing.
 *   - `--accept-missing-baseline` acknowledges having no comparison at all — a
 *     first-ever generation. There is nothing to enumerate, which is exactly why
 *     it is its own flag: while ONE flag covered both, the quietest tamper was
 *     not `git rm` but a single corrupted byte, because the loss waiver then
 *     also waived the absence and suppressed the enumeration.
 * Both are REJECTED under `--check`, so the verdict can never be told to look
 * away. (`--baseline=` is a different thing — a TEST SEAM that selects WHAT is
 * compared. It can only make the loss comparison weaker, never suppress the gap
 * or stale-allow-list verdicts, and CI never passes it.)
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-handled-property-wiring.ts
 *     # write the matrix; refuses on an unacknowledged evidence loss OR an
 *     # unusable baseline
 *   node --experimental-strip-types scripts/gen-handled-property-wiring.ts --check
 *     # fail on a gap, a stale allow-list entry, an evidence loss, or a baseline
 *     # that could not have failed
 *   node --experimental-strip-types scripts/gen-handled-property-wiring.ts --accept-evidence-loss
 *     # write the matrix, acknowledging (and printing) the reduction
 *   node --experimental-strip-types scripts/gen-handled-property-wiring.ts --accept-missing-baseline
 *     # write the matrix with no comparison at all (first-ever generation)
 *
 * CI runs the writer then `git diff --quiet` on the output AND the `--check`
 * critic, mirroring the sdk-attr / update-wrap / nested-key guards. Neither CI
 * invocation passes either waiver flag.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
 * this critic exists to establish.
 *
 * WHAT THIS EXCLUSION DOES AND DOES NOT BUY. It does NOT close the
 * "diffs it, then forgets to send it" disguise, and an earlier revision of this
 * comment wrongly claimed it did. A diff reads BOTH bags, so
 * `if (properties['X'] !== previousProperties['X']) throw` still clears X on
 * the strength of its DESIRED-side read — the exclusion cannot see that the
 * desired read fed a comparison rather than a request. (Denying credit to every
 * compared-only `element-read` is a much larger change than this critic's
 * charter; the TABLE-loop case above IS denied, because one site there credits
 * N properties at once.) What the exclusion actually buys is narrower and still
 * worth having: a helper reached ONLY with the previous bag
 * (`this.diff(previousProperties)`) contributes nothing, and a property read
 * exclusively off the previous bag — never off the desired one — is reported as
 * a gap instead of silently passing.
 *
 * The converse misfire is real and accepted: a delivery driven purely off the
 * previous bag, such as `for (const t of previousProperties['Tags']) untag(t)`
 * in a removal path, would be reported as a gap even though it does reach AWS.
 * No such shape exists in the tree today; if one appears, the fix is an
 * allow-list entry naming it, not re-admitting the previous bag wholesale.
 *
 * Measured: excluding these names moves ZERO of the 1138 declared properties
 * out of `wired`, so the strictness costs nothing today.
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
  // NOTE: `EC2Provider#MaxDrainDurationSeconds` (issue #1411) and
  // `LogsLogGroupProvider#ResourcePolicyDocument` (issue #1412) — the two KNOWN
  // GAP entries this critic's first real-tree run seeded — are GONE: both
  // properties moved out of `handledProperties` into `unhandledByDesign`, so
  // they are no longer a wiring claim at all and the stale-entry check now
  // enforces that they stay out.
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

/**
 * One callable this walk can descend into: a class member or a file-local
 * function. `scope` disambiguates the two namespaces — a class member and a
 * file-local free function may share a name (`build()` / `this.build()`), and a
 * cycle-guard key that dropped the namespace made the first one walked shadow
 * the second, silently losing the second one's reads.
 */
export interface Callable {
  readonly name: string;
  readonly scope: 'member' | 'file';
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
        scope: 'member',
        params: paramNames(member.parameters),
        body: member.body,
      });
    } else if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
      const init = member.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        out.set(member.name.text, {
          name: member.name.text,
          scope: 'member',
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
        scope: 'file',
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
            scope: 'file',
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

/**
 * Wrappers that hand their operand through UNCHANGED at runtime, so a read
 * spelled through one is the same read. Each erases to nothing (four are
 * type-only syntax; parentheses are grouping), which is the ONLY admission
 * criterion — a node that can change the value, short-circuit, or defer it
 * (`await`, `x ?? y`, a tagged template) must never be listed here, because
 * peeling it would credit a read the runtime may never perform. Optional
 * chaining is NOT in that group and is deliberately not excluded:
 * `properties?.['X']` parses as an element access whose own `.expression` is the
 * bag, so the walk credits it — correctly, because when the bag exists the read
 * happens. (An earlier revision listed `?.` here as "excluded and pinned by a
 * test"; neither half was true, and the behavior it described would have been
 * wrong. The real behavior is pinned below instead.) The
 * list is not claimed exhaustive over erase-to-nothing syntax —
 * `ExpressionWithTypeArguments` (an instantiation expression) qualifies and is
 * absent; omitting one only fails CLOSED (a read goes unseen), which is the
 * safe direction, while admitting a non-transparent one fails OPEN.
 *
 * {@link unwrap} peels these DOWNWARD from a wrapper to its operand;
 * {@link climb} walks the same set UPWARD from an operand to its outermost
 * wrapper. The two must agree: `NonNullExpression` was in `climb` but missing
 * from `unwrap`, so `properties!['X']` — the `!`-asserted spelling of a read
 * this walk otherwise recognizes — contributed NO evidence while the
 * runtime-identical `properties['X']` contributed the full set (issue #1842).
 */
const isTransparentWrapper = (
  n: ts.Node
): n is
  | ts.AsExpression
  | ts.ParenthesizedExpression
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.TypeAssertion =>
  ts.isAsExpression(n) ||
  ts.isParenthesizedExpression(n) ||
  ts.isSatisfiesExpression(n) ||
  ts.isNonNullExpression(n) ||
  ts.isTypeAssertionExpression(n);

/** Strip `as T` / `satisfies T` / `<T>x` / `x!` / parentheses so the underlying node is visible. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (isTransparentWrapper(n)) {
    n = n.expression;
  }
  return n;
}

/** The statement list a node introduces as a lexical scope, if it introduces one. */
function scopeStatements(node: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) return node.statements;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return undefined;
}

/**
 * Resolve `const NAME = ['A', 'B']` / `const NAME = { A: ... }` by walking
 * LEXICALLY outward from `at` — the enclosing block, then the enclosing
 * function body, then module scope — and return NAME's literal name set.
 *
 * Lexical resolution is the safety property this critic is sold on. A FILE-wide
 * map (the earlier draft) let a table declared inside `ClassA.create()`'s body
 * resolve a loop in `ClassB.create()`, so one class's pass-through table
 * vouched for a sibling class's declarations, and two same-named tables in one
 * file silently overrode each other last-wins. Walking `parent` from the use
 * site makes both impossible: a binding that does not enclose the loop is
 * simply not found.
 */
export function resolveLiteralNameSetAt(
  name: string,
  at: ts.Node,
  seen: Set<string> = new Set()
): Set<string> | null {
  if (seen.has(name)) return null; // `const a = b; const b = a;`
  seen.add(name);
  for (let scope: ts.Node | undefined = at; scope; scope = scope.parent) {
    const statements = scopeStatements(scope);
    if (!statements) continue;
    for (const stmt of statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          return literalNameSetOf(decl.initializer, seen);
        }
      }
    }
  }
  return null;
}

/**
 * The set of NAMES an expression can yield as an object key: an array literal's
 * string elements, an object literal's property names, `Object.keys(...)` /
 * `Object.entries(...)` of either, or an identifier lexically bound to one of
 * those. Returns null when the expression is not a literal name source.
 */
function literalNameSetOf(expr: ts.Expression, seen: Set<string> = new Set()): Set<string> | null {
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
  if (ts.isIdentifier(node)) return resolveLiteralNameSetAt(node.text, node, seen);
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Object' &&
    (node.expression.name.text === 'keys' || node.expression.name.text === 'entries') &&
    node.arguments.length === 1
  ) {
    return literalNameSetOf(node.arguments[0]!, seen);
  }
  return null;
}

/**
 * The `for...of` statement that lexically binds `id` as its (first) loop
 * variable, together with the literal name set its iterable yields. Resolved
 * from the USE site outward, so the binding is necessarily the one in scope —
 * an earlier draft kept a method-scoped `keySets` map, which credited a read
 * outside the loop that bound the key, and pooled two loops that reused the
 * same variable name.
 */
export interface LoopKeyBinding {
  readonly names: Set<string>;
  readonly loop: ts.ForOfStatement;
}

export function resolveLoopKey(id: ts.Identifier): LoopKeyBinding | null {
  for (let n: ts.Node | undefined = id; n; n = n.parent) {
    if (!ts.isForOfStatement(n) || !ts.isVariableDeclarationList(n.initializer)) continue;
    const decl = n.initializer.declarations[0];
    if (!decl) continue;
    let binds = false;
    if (ts.isIdentifier(decl.name)) {
      binds = decl.name.text === id.text;
    } else if (ts.isArrayBindingPattern(decl.name)) {
      // `for (const [cdkKey, sqsKey] of Object.entries(TABLE))` — the KEY is
      // the first element; the value binding names nothing.
      const first = decl.name.elements[0];
      binds =
        !!first &&
        ts.isBindingElement(first) &&
        ts.isIdentifier(first.name) &&
        first.name.text === id.text;
    }
    if (!binds) continue;
    const names = literalNameSetOf(n.expression);
    return names ? { names, loop: n } : null;
  }
  return null;
}

const COMPARISON_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
]);

/**
 * Climb the wrappers that pass a value through unchanged — the UPWARD twin of
 * {@link unwrap}, over the same {@link isTransparentWrapper} set so the two
 * cannot drift apart again (issue #1842).
 */
function climb(node: ts.Node): ts.Node {
  let n = node;
  while (n.parent && isTransparentWrapper(n.parent)) {
    n = n.parent;
  }
  return n;
}

/**
 * Is this whole-bag call inert — its result only compared or measured, never
 * forwarded? `JSON.stringify(properties) === JSON.stringify(previousProperties)`
 * and `Object.keys(properties).length > 0` are checks, not deliveries, and
 * treating them as opaque forwards blinds the class to REAL gaps.
 *
 * Shape-based on purpose. Two inert shapes: the result is an operand of an
 * equality / relational comparison, or the result's `.length` is read at all —
 * once a caller has taken `.length`, no property VALUE can have left the
 * process, whichever way the number is then consumed
 * (`!Object.keys(properties).length`, `if (Object.keys(properties).length)`).
 * Bare truthiness of the call itself is deliberately NOT inert here: the
 * `ECRProvider` blind spot this critic protects (`hasCdkAutoDeleteTag(properties)`)
 * wears exactly that shape.
 */
export function isInertWholeBagUse(call: ts.Node): boolean {
  let node = climb(call);
  let measured = false;
  while (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'length') {
    node = climb(node.parent);
    measured = true;
  }
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isBinaryExpression(parent) && COMPARISON_OPERATORS.has(parent.operatorToken.kind)) {
    return true;
  }
  return measured;
}

/**
 * Callees that only INSPECT or SERIALIZE their argument. Passing a value to one
 * does not decide whether the value was delivered — what the RESULT feeds does.
 * `JSON.stringify(next) !== JSON.stringify(prev)` (the `EFSProvider` immutable
 * guard) is a comparison; `body: JSON.stringify(properties)` is a delivery, and
 * the recursion in {@link feedsOnlyComparison} tells them apart by looking at
 * the call's own parent.
 */
const isPureInspectionCallee = (callee: ts.Expression): boolean => {
  if (ts.isIdentifier(callee)) return ['String', 'Number', 'Boolean'].includes(callee.text);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const target = `${callee.expression.text}.${callee.name.text}`;
  return ['JSON.stringify', 'Object.keys', 'Object.entries', 'Object.values', 'Array.isArray'].includes(
    target
  );
};

/**
 * Does this value flow ONLY into a comparison / measurement — never into a
 * request, a variable that escapes, or a call argument?
 *
 * Stricter than {@link isInertWholeBagUse} on purpose: this one gates whether a
 * table read counts as DELIVERY, where the fail-closed direction is "not a
 * delivery", so bare truthiness (`if (properties[k])`), `!`, `typeof` and
 * `.length` all count as inert.
 */
function feedsOnlyComparison(value: ts.Node): boolean {
  const top = climb(value);
  const parent = top.parent;
  if (!parent) return false;
  if (ts.isTypeOfExpression(parent)) return feedsOnlyComparison(parent);
  if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'length') {
    return feedsOnlyComparison(parent);
  }
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
    return true;
  }
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.some((a) => a === top) &&
    isPureInspectionCallee(parent.expression)
  ) {
    return feedsOnlyComparison(parent);
  }
  if (ts.isBinaryExpression(parent)) {
    return COMPARISON_OPERATORS.has(parent.operatorToken.kind);
  }
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) {
    return parent.expression === top;
  }
  if (ts.isConditionalExpression(parent)) return parent.condition === top;
  return false;
}

/** The nearest enclosing function body / source file — the scope to search for references. */
function enclosingBody(node: ts.Node): ts.Node {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (isFunctionLike(n) || ts.isSourceFile(n)) return n;
  }
  return node;
}

/** Is this identifier a DECLARATION site / member name rather than a value reference? */
function isNonReferenceIdentifier(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isPropertyAssignment(p) && p.name === id) return true;
  if (ts.isVariableDeclaration(p) && p.name === id) return true;
  if (ts.isParameter(p) && p.name === id) return true;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return true;
  return false;
}

/**
 * Every reference to `name` within `scope` feeds only a comparison. Used for
 * the one `const` hop the delivery check follows: `const next = properties[k]`
 * is still just a comparison when every use of `next` is one.
 *
 * A binding with no references at all counts as inert — a dead read delivers
 * nothing.
 */
function allReferencesInert(name: string, scope: ts.Node, declName: ts.Node): boolean {
  let inert = true;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name && n !== declName && !isNonReferenceIdentifier(n)) {
      if (!feedsOnlyComparison(n)) inert = false;
    }
    if (inert) ts.forEachChild(n, visit);
  };
  visit(scope);
  return inert;
}

/**
 * Is this READ of the property bag comparison-only? Follows one `const` hop so
 * the `EC2Provider.updateSubnet` guard shape
 * (`const next = properties[k]; ... next !== prev`) is seen for what it is.
 */
function isComparisonOnlyRead(read: ts.Node): boolean {
  if (feedsOnlyComparison(read)) return true;
  const top = climb(read);
  const parent = top.parent;
  if (
    parent &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === top &&
    ts.isIdentifier(parent.name)
  ) {
    return allReferencesInert(parent.name.text, enclosingBody(parent), parent.name);
  }
  return false;
}

/**
 * Does the body of a table-driven loop actually DELIVER one of its reads, or
 * does it only compare them? See the module header's "TABLE LOOPS MUST DELIVER"
 * section: crediting a comparison-only loop re-admits the diff-is-not-delivery
 * disguise, multiplied by the size of the table.
 */
export function loopDeliversKeyedReads(
  loop: ts.ForOfStatement,
  keyName: string,
  isTainted: (node: ts.Node) => boolean
): boolean {
  let delivers = false;
  const visit = (n: ts.Node): void => {
    if (delivers) return;
    if (ts.isElementAccessExpression(n) && isTainted(n.expression)) {
      const arg = unwrap(n.argumentExpression);
      if (ts.isIdentifier(arg) && arg.text === keyName && !isComparisonOnlyRead(n)) {
        delivers = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(loop.statement);
  return delivers;
}

/**
 * How a property earned its evidence. Recorded per property so the matrix (and
 * the unit tests' per-SHAPE real-repo floors) can tell a live recognizer from a
 * dead one — an aggregate "1136 wired" would let a whole shape stop working
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

export interface PropertyEvidence {
  /** Which shape(s) proved the read. */
  readonly shapes: Set<EvidenceShape>;
  /**
   * The class MEMBER(s) whose walk produced the evidence — the seed the walk
   * started from, not the (possibly delegated) callable holding the read.
   *
   * Recorded because the module header claims evidence comes from a DELIVERY
   * path, while the walk seeds EVERY member: a read inside `readCurrentState()`
   * would classify the property wired and contradict the header. There are zero
   * such cases today (see the unit suite's real-tree fence), but without the
   * seed in the JSON a future one would be invisible.
   */
  readonly seeds: Set<string>;
}

export interface EvidenceResult {
  /** Property names read off a tainted property bag, with the evidence that proved it. */
  readonly readNames: Map<string, PropertyEvidence>;
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
  fileFunctions: ReadonlyMap<string, Callable> = new Map()
): EvidenceResult {
  const members = collectClassMembers(cls);
  const readNames = new Map<string, PropertyEvidence>();
  const blindSpots = new Set<string>();
  const visited = new Set<string>();

  const walkCallable = (
    fn: Callable,
    taintedParams: ReadonlySet<number>,
    seedMember: string,
    viaDelegation: boolean
  ): void => {
    // The namespace prefix is load-bearing: a class member and a file-local free
    // function can share a name, and a bare `name:params` key made the first one
    // walked shadow the other, dropping its reads.
    const key = `${seedMember}/${fn.scope}:${fn.name}:${[...taintedParams].sort((a, b) => a - b).join(',')}`;
    if (visited.has(key)) return;
    visited.add(key);

    const record = (name: string, shape: EvidenceShape): void => {
      const evidence = readNames.get(name) ?? { shapes: new Set<EvidenceShape>(), seeds: new Set<string>() };
      evidence.shapes.add(shape);
      if (viaDelegation) evidence.shapes.add('delegated');
      evidence.seeds.add(seedMember);
      readNames.set(name, evidence);
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

    const walk = (node: ts.Node): void => {
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
        } else if (ts.isIdentifier(arg)) {
          // The table is resolved LEXICALLY from this read outward, so only a
          // binding that actually encloses the loop can vouch for it.
          const binding = resolveLoopKey(arg);
          if (!binding) {
            // `properties[someVar]` with no resolvable name table — the read
            // could name any property, so nothing here can be verified.
            blindSpots.add(`computed key in ${fn.name}()`);
          } else if (loopDeliversKeyedReads(binding.loop, arg.text, isTainted)) {
            for (const n of binding.names) {
              if (isCfnPropertyName(n)) record(n, 'table-loop');
            }
          }
          // else: a fully-understood comparison-only loop (the EC2 createOnly
          // guard shape). No credit, and no blind spot either — nothing is
          // hidden from the walk, the loop simply does not deliver.
        } else {
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
        if (taintedArgIdx.size > 0) {
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
          // A RESOLVABLE callee is always walked, even when the call's result is
          // only compared (`if (this.buildInput(properties) !== undefined)`):
          // the reads inside it are real, and the earlier order — skipping the
          // whole branch on `isInertWholeBagUse` — dropped them AND recorded no
          // blind spot, so the evidence vanished invisibly. The inert exemption
          // belongs only to the un-resolvable branch, where all it does is keep
          // a comparison from being reported as a place the walk cannot see.
          if (target) walkCallable(target, taintedArgIdx, seedMember, true);
          else if (!isInertWholeBagUse(node)) {
            blindSpots.add(`${calleeName}(...) in ${fn.name}()`);
          }
        }
      }

      ts.forEachChild(node, walk);
    };

    walk(fn.body);
  };

  for (const member of members.values()) {
    walkCallable(member, new Set(), member.name, false);
  }
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

/** The verdict vocabulary, shared by a class's bucket and a single property's status. */
export type Bucket = 'wired' | 'gap' | 'allow-listed';

/** The runtime twin of {@link Bucket}, for validating a baseline's labels. */
export const BUCKETS: ReadonlySet<string> = new Set<Bucket>(['wired', 'gap', 'allow-listed']);

export interface PropertyClassification {
  readonly name: string;
  readonly status: Bucket;
  /** Resource types whose declaration includes this property. */
  readonly types: readonly string[];
  /** Which evidence shape(s) proved the read. Empty for non-`wired` statuses. */
  readonly evidence: readonly EvidenceShape[];
  /**
   * The class member(s) whose walk produced the evidence. Empty for non-`wired`
   * statuses. See {@link PropertyEvidence.seeds} for why this is recorded.
   */
  readonly seededBy: readonly string[];
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
  const out: ClassClassification[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const handled = parseHandledProperties(node);
      if (handled.size > 0) {
        const className = node.name.text;
        const { readNames, blindSpots } = collectEvidence(node, fileFunctions);

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
          const evidence = readNames.get(name);
          if (evidence) {
            properties.push({
              name,
              status: 'wired',
              types,
              evidence: [...evidence.shapes].sort((a, b) => a.localeCompare(b)),
              seededBy: [...evidence.seeds].sort((a, b) => a.localeCompare(b)),
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
              seededBy: [],
              rationale: allow.rationale,
            });
          } else {
            properties.push({ name, status: 'gap', types, evidence: [], seededBy: [] });
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

/**
 * One declared property whose PROVEN evidence is weaker than the committed
 * matrix records. Reported per (class, property) with the exact shapes and
 * seeding members that disappeared, because "wired" is a floor the aggregate
 * counters cannot see through: a property can fall from
 * `delegated` + `element-read` across three seeds down to a single weak seed
 * and still be `wired`, keeping `0 gaps` byte-identical.
 */
export interface EvidenceLoss {
  readonly className: string;
  readonly property: string;
  /** Evidence shapes the baseline proved and this run no longer does. */
  readonly lostShapes: readonly EvidenceShape[];
  /** Seeding members the baseline recorded and this run no longer reaches. */
  readonly lostSeeds: readonly string[];
}

/** Render one loss as the single line both failure paths print. */
const formatEvidenceLoss = (l: EvidenceLoss): string => {
  const parts: string[] = [];
  if (l.lostShapes.length > 0) parts.push(`evidence [${l.lostShapes.join(', ')}]`);
  if (l.lostSeeds.length > 0) parts.push(`seeded-by [${l.lostSeeds.join(', ')}]`);
  return `  ${l.className}#${l.property} — lost ${parts.join(' and ')}`;
};

/**
 * Declared properties whose evidence SET shrank relative to the committed
 * matrix (issue #1842).
 *
 * WHY A SET COMPARISON AND NOT A COUNT. The `--check` verdict before this was
 * `gap`-only, and `gap` is a floor of ONE surviving read, so a property that
 * still has one read is indistinguishable from one that has four. MEASURED on
 * the real `dynamodb-table-provider.ts`: respelling the single delegated read
 * inside `declaresWarmThroughput()` as `properties!['WarmThroughput']` dropped
 * `WarmThroughput`'s `delegated` evidence and its `getDriftUnknownPaths` /
 * `readCurrentState` seeds, and respelling all seven
 * `properties['GlobalSecondaryIndexes']` reads dropped that property's `update`
 * seed — while `--check` printed its clean-tree `OK — ... 0 gaps` line
 * BYTE-IDENTICALLY in both cases. The loss was visible only as a
 * regenerated-file diff, which the same commit can carry. The direction that
 * matters is exactly this one: the critic exists to make a FALSE
 * `handledProperties` claim reachable, so a REAL claim quietly becoming
 * unprovable — while still reporting zero gaps — is the dangerous failure, not
 * the loud one.
 *
 * WHAT IS AND IS NOT COMPARED. Only (class, property) pairs present on BOTH
 * sides. A property missing from this run is no longer a wiring CLAIM at all
 * (moved to `unhandledByDesign`, deleted, or its class renamed), and
 * `gen-property-coverage.ts` owns that transition — treating it as a loss here
 * would make every legitimate removal a false failure. A renamed CLASS
 * therefore drops out of the comparison wholesale; that is a knowingly accepted
 * hole, and a visible one, since the rename is in the same diff.
 *
 * Seeds are compared alongside shapes because they are half of what a
 * degradation costs: `WarmThroughput` losing its `getDriftUnknownPaths` and
 * `readCurrentState` seeds is the same event as it losing `delegated`. A
 * deliberate method rename does trip this, and that is intended — the escape
 * hatch below is one command.
 *
 * A null baseline yields no losses HERE — this function grades a change against
 * a recorded state and cannot invent one — but that is not a permission to
 * proceed. Whether a baseline may be graded against at all is
 * {@link assessBaseline}'s question, and {@link main} refuses an unusable one in
 * BOTH modes before ever calling this. See {@link shouldRefuseUnusableBaseline}
 * for why `--check` is not exempt, and {@link unusableBaselineFailure} before
 * trusting any claim about what `git diff --quiet` does or does not catch.
 */
export function findEvidenceLosses(
  baseline: HandledPropertyWiringReport | null,
  current: HandledPropertyWiringReport
): readonly EvidenceLoss[] {
  if (!baseline) return [];
  // Keyed by CLASS NAME, not by file+class, matching {@link allowKey} and the
  // allow-list. Measured: all 84 classified class names are distinct today, so
  // nothing collides; and the class name survives a file RENAME, which the
  // file-qualified key would silently turn into "both sides absent" (no
  // comparison at all). A future same-name-in-two-files pair would mis-pair
  // here, but it would equally break the allow-list and the stale-entry check,
  // so the fix belongs to the shared key rather than to this function.
  const previous = new Map<string, PropertyClassification>();
  for (const c of baseline.classes) {
    for (const p of c.properties) previous.set(allowKey(c.className, p.name), p);
  }

  const losses: EvidenceLoss[] = [];
  for (const c of current.classes) {
    for (const p of c.properties) {
      const before = previous.get(allowKey(c.className, p.name));
      if (!before) continue;
      const shapes = new Set<string>(p.evidence);
      const seeds = new Set<string>(p.seededBy);
      const lostShapes = before.evidence.filter((s) => !shapes.has(s));
      const lostSeeds = before.seededBy.filter((s) => !seeds.has(s));
      if (lostShapes.length > 0 || lostSeeds.length > 0) {
        losses.push({
          className: c.className,
          property: p.name,
          lostShapes: lostShapes.sort((a, b) => a.localeCompare(b)),
          lostSeeds: lostSeeds.sort((a, b) => a.localeCompare(b)),
        });
      }
    }
  }
  return losses.sort(
    (a, b) => a.className.localeCompare(b.className) || a.property.localeCompare(b.property)
  );
}

/**
 * Parse the committed matrix. STRUCTURAL validity only — whether it is USABLE as
 * a baseline is {@link assessBaseline}'s question, because that depends on the
 * report being graded and this function has not seen it.
 *
 * Returns null rather than throwing so an unreadable file is a verdict, not a
 * crash.
 */
export function loadBaseline(path: string = OUT_JSON): HandledPropertyWiringReport | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HandledPropertyWiringReport>;
    // `!Array.isArray(parsed.classes)` has the same defence-in-depth character as
    // the `properties` clause below — the walks past it would throw and the outer
    // catch would convert that to null, so the shipped command's stderr is
    // byte-identical with and without it. Both are kept for the same reason:
    // they stop being redundant the moment that catch is narrowed.
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.classes)) return null;
    // Defence in depth, and honestly labelled as such: the element walk below
    // would also throw on a non-array and the outer catch would convert that to
    // null, so no test can tell this clause from its absence. It is kept because
    // a future refactor removing that catch would otherwise turn this into a
    // crash, not because it changes today's verdict.
    if (parsed.classes.some((c) => !Array.isArray(c?.properties))) return null;
    // Element shape too, not just the array: `properties: [null]` cleared the
    // `Array.isArray` check and then died in the comparison walk with a bare
    // `Cannot read properties of null (reading 'name')`. It failed CLOSED, so it
    // was never a bypass — but it skipped the structured refusal, and a verdict
    // this critic can only deliver as a stack trace is a verdict nobody reads.
    // Constrain exactly the fields the comparison CONSUMES —
    // `className` / `name` / `evidence` / `seededBy`. An unconstrained one does
    // not fail safe: `"evidence": "element-read"` (a string, not an array) died
    // in the walk as `(before.evidence ?? []).filter is not a function`, the
    // raw-TypeError shape a structured refusal exists to replace.
    // Class-level shape too: {@link assessBaseline} recomputes the summary via
    // `buildReport`, which reads `gaps` / `blindSpots` / `bucket` / `file` — so
    // those are CONSUMED and must be constrained. Leaving them unchecked crashed
    // on `{"classes":[{"className":"P","properties":[]}]}` with a bare
    // `Cannot read properties of undefined (reading 'length')`.
    if (
      parsed.classes.some(
        (c) =>
          typeof c?.className !== 'string' ||
          typeof c.file !== 'string' ||
          !BUCKETS.has(c.bucket) ||
          !Array.isArray(c.gaps) ||
          !Array.isArray(c.blindSpots) ||
          c.properties.some(
            (x: PropertyClassification | null) =>
              typeof x?.name !== 'string' ||
              // `status` is a LABEL the usability rules key on, so an
              // unconstrained one disarms them: a single property relabelled
              // `"totally-bogus-status"` — a value not even in the union — took
              // it out of the evidence requirement and hid the very loss being
              // committed.
              !BUCKETS.has(x.status) ||
              !Array.isArray(x.evidence) ||
              !Array.isArray(x.seededBy)
          )
      )
    ) {
      return null;
    }
    return parsed as HandledPropertyWiringReport;
  } catch {
    return null;
  }
}

/** Why a baseline is not usable, when it is not. */
export type BaselineDefect = 'absent' | 'self-inconsistent' | 'evidence-stripped' | 'no-overlap';

/** What a baseline can actually prove about the report it is grading. */
export interface BaselineAssessment {
  /** May this run proceed on the strength of this baseline? */
  readonly usable: boolean;
  /** (class, property) pairs the comparison actually covers. */
  readonly gradedPairs: number;
  /** (class, property) pairs the current report declares. */
  readonly currentPairs: number;
  /**
   * Total evidence ENTRIES (`evidence` + `seededBy` items) the baseline holds
   * for the pairs it grades. Pair counting is binary per pair and so cannot see
   * a record being thinned; this can.
   */
  readonly gradedDepth: number;
  /** DISTINCT `Class#Property` keys the baseline holds. */
  readonly baselinePairs: number;
  /** What the baseline's own `summary` claims it holds. */
  readonly baselineClaimedPairs: number | null;
  readonly defect?: BaselineDefect;
  /** Human-readable specifics for {@link unusableBaselineFailure}. */
  readonly detail?: string;
}

/**
 * Is this baseline usable — stated POSITIVELY, which is the whole point.
 *
 * THREE conditions, and the ORDER OF DISCOVERY is the lesson worth keeping:
 *
 *  1. SELF-CONSISTENT — its ENTIRE `summary` must equal the summary recomputed
 *     from its own `classes`. Not two hand-picked count fields: the whole
 *     record, so a field added later is constrained automatically.
 *  2. EVIDENCE-BEARING — every `wired` property must actually carry `evidence`
 *     and `seededBy`. These are the fields {@link findEvidenceLosses} CONSUMES.
 *  3. NON-VACUOUS — the comparison must cover at least one (class, property)
 *     pair of the report being graded, i.e. it must be able to FAIL at all.
 *
 * WHY THE LIST GREW, AND WHY IT SHOULD NOW STOP. Five review rounds closed five
 * spellings of one tamper, each slipping the previous round's guard:
 *   - MISSING (deleted; staged, so `git diff --quiet` stayed green),
 *   - TRUNCATED (parses, well-formed header),
 *   - EMPTY (`classes: []`, passing every structural check),
 *   - SHRUNKEN (cut to one pair — it OVERLAPS, so non-vacuity waved it through),
 *   - STRIPPED (`evidence` / `seededBy` blanked on every property while every
 *     count stays intact — strictly the worst, because the mitigation then
 *     announces `graded 1138/1138` while grading nothing).
 *
 * Rounds 1-4 each constrained something ADJACENT to the comparison — a pair
 * count, then summary counts — and never the fields the comparison reads. That
 * is the actual bug behind all five: an integrity check must constrain exactly
 * what the consumer CONSUMES. Condition 2 is that, stated directly, and it is
 * free — all 1136 wired properties in the committed matrix carry both fields.
 * Condition 1 is likewise widened from two fields to the whole summary so the
 * next field cannot be the sixth spelling.
 *
 * WHY NOT A COVERAGE RATIO. Any threshold is a magic constant needing its own
 * defence, and legitimate drift (a PR adding a provider class) must not trip it.
 *
 * THE RESIDUAL BOUND, stated as exactly what conditions 1-3 ADMIT rather than as
 * a claim about intent. They admit a baseline that (1) agrees with its own
 * summary, (2) whose labels match its evidence, and (3) that overlaps this tree
 * — nothing weaker. So NOT "whatever tree it describes": a disjoint one is
 * refused by 3, and a blanked one by 2. What IS admitted, and is the bound:
 *   - a self-consistent SUBSET — the committed matrix minus one pair with
 *     `declaredProperties` decremented is accepted, and announces one pair below
 *     the 1136/1138 ceiling (1136 rather than 1138 because the two allow-listed
 *     properties carry no evidence to grade);
 *   - an OLDER committed matrix restored by a merge or checkout, which is
 *     self-consistent by construction. Accepting that is CORRECT: it is a real
 *     baseline describing a real tree and it reports real losses;
 *   - a property relabelled to a DIFFERENT VALID status with its evidence
 *     blanked and the summary recomputed — a deliberate, hand-made edit that
 *     hides exactly one loss.
 * A FOURTH, and the minimal one: any baseline entry may be weakened to a
 * non-empty SUBSET of what the current tree proves — trimming one `seededBy`
 * hides a real loss and moves no pair count at all. That is why the announced
 * metric carries DEPTH (`evidence` + `seededBy` entries) as well as pairs: the
 * pair count is binary per pair and cannot see a record being thinned, while
 * the depth falls by EXACTLY THE NUMBER OF ENTRIES REMOVED. Stated as that
 * formula rather than as a constant, because three correct measurements
 * disagree until the probe is named: from the 5384 baseline, dropping two of
 * `ApiGatewayProvider#CloudWatchRoleArn`'s four seeds gives 5382; trimming
 * `ACMCertificateProvider#CertificateAuthorityArn`'s two seeds to one gives
 * 5383; hiding `DynamoDBTableProvider#WarmThroughput` entirely gives 5378.
 * None of the four shapes is REFUSED — they are self-consistent baselines
 * describing real trees — but each costs a visible number on every exit-0 path.
 *
 * THE BOUND ON THAT GUARANTEE, since depth is a global SUM and therefore
 * COMPENSABLE: a tree that loses one seed while genuinely gaining another,
 * with the baseline hand-edited at BOTH sites (adding only entries the current
 * tree proves, so no false loss is reported), produces stderr byte-identical to
 * a clean run. Closing that needs a per-PAIR comparison of depth, which is a
 * different critic — this one defends against the ACCIDENTAL shapes, and a
 * two-site compensating hand-edit is not one. Documented, deliberately not
 * chased.
 */
export function assessBaseline(
  baseline: HandledPropertyWiringReport | null,
  current: HandledPropertyWiringReport
): BaselineAssessment {
  const currentPairs = current.classes.reduce((n, c) => n + c.properties.length, 0);
  if (!baseline) {
    return {
      usable: false,
      gradedPairs: 0,
      currentPairs,
      gradedDepth: 0,
      baselinePairs: 0,
      baselineClaimedPairs: null,
      defect: 'absent',
    };
  }

  // DISTINCT keys: a baseline that replicates one property to preserve `length`
  // satisfies a naive count while holding a single real pair.
  const known = new Set<string>();
  // ...and separately, the keys that can actually FAIL. A baseline entry with no
  // evidence and no seeds cannot lose any, so counting it as "graded" made the
  // announced number a claim about key presence rather than about provable
  // content: a wholesale blanking still printed `graded 1138/1138`.
  const provable = new Map<string, number>();
  for (const c of baseline.classes) {
    for (const p of c.properties) {
      const key = allowKey(c.className, p.name);
      known.add(key);
      // `||`, not `&&`: a ONE-SIDED entry can still produce a loss, so narrowing
      // would undercount the pairs this baseline can fail on.
      //
      // An earlier revision said this was unfenceable "because no input can
      // distinguish them downstream of condition 2". That was FALSE twice over,
      // and is the shape `absence_rationale_goes_stale_silently` warns about —
      // nobody re-tests a claim that says testing is impossible. `provable` is
      // computed UPSTREAM of condition 2, and `base` (carrying these counts) is
      // returned on every failure path, so a stripped baseline reaches the
      // caller and PRINTS them; `--accept-missing-baseline` even writes on it.
      // Measured with the existing one-sided fixture: 1136 pairs under `||`,
      // 1135 under `&&`. Fenced.
      if (p.evidence.length > 0 || p.seededBy.length > 0) {
        provable.set(key, p.evidence.length + p.seededBy.length);
      }
    }
  }
  const baselinePairs = known.size;
  const claimedPairs =
    typeof baseline.summary?.declaredProperties === 'number'
      ? baseline.summary.declaredProperties
      : null;

  let gradedPairs = 0;
  let gradedDepth = 0;
  for (const c of current.classes) {
    for (const p of c.properties) {
      const depth = provable.get(allowKey(c.className, p.name));
      if (depth !== undefined) {
        gradedPairs += 1;
        gradedDepth += depth;
      }
    }
  }
  const base = {
    gradedPairs,
    currentPairs,
    gradedDepth,
    baselinePairs,
    baselineClaimedPairs: claimedPairs,
  };

  // 1. The WHOLE summary, recomputed from the baseline's own classes. The
  //    generator writes them in agreement by construction, so any disagreement
  //    means the file was edited or partially written afterwards.
  const recomputed = buildReport(baseline.classes).summary;
  const mismatched = (Object.keys(recomputed) as Array<keyof typeof recomputed>).filter(
    (k) => baseline.summary?.[k] !== recomputed[k]
  );
  if (!baseline.summary || mismatched.length > 0) {
    return {
      ...base,
      usable: false,
      defect: 'self-inconsistent',
      detail: !baseline.summary
        ? 'it carries no summary at all'
        : mismatched
            .map((k) => `${k}: claims ${String(baseline.summary[k])}, holds ${String(recomputed[k])}`)
            .join('; '),
    };
  }

  // 2. The labels must be TRUTHFUL about the content — a BICONDITIONAL, not a
  //    one-way check. `status === 'wired'` must mean the entry carries evidence,
  //    AND carrying evidence must mean it is labelled wired. A one-way check
  //    keyed on `status` is disarmed by editing `status`, which is exactly what
  //    happened: the recomputed `wiredProperties` then agrees with the new
  //    labels, so condition 1 is satisfied BY CONSTRUCTION. "Self-consistent"
  //    means the summary agrees with the LABELS, never that the labels describe
  //    real output.
  //
  //    Each direction is reported separately because each is independently live
  //    (see the per-half fixtures): a fixture tripping both at once fences
  //    neither, which is the defect this very condition was added to fix, one
  //    level up.
  const wiredWithoutEvidence: string[] = [];
  const wiredWithoutSeeds: string[] = [];
  const unwiredWithEvidence: string[] = [];
  for (const c of baseline.classes) {
    for (const p of c.properties) {
      const key = allowKey(c.className, p.name);
      if (p.status === 'wired') {
        if (p.evidence.length === 0) wiredWithoutEvidence.push(key);
        if (p.seededBy.length === 0) wiredWithoutSeeds.push(key);
      } else if (p.evidence.length > 0 || p.seededBy.length > 0) {
        unwiredWithEvidence.push(key);
      }
    }
  }
  const labelDefects = [
    ['wired with no evidence', wiredWithoutEvidence],
    ['wired with no seeding member', wiredWithoutSeeds],
    ['not wired yet carrying evidence', unwiredWithEvidence],
  ] as const;
  const brokenLabels = labelDefects.filter(([, keys]) => keys.length > 0);
  if (brokenLabels.length > 0) {
    return {
      ...base,
      usable: false,
      defect: 'evidence-stripped',
      detail: brokenLabels
        .map(([why, keys]) => `${keys.length} ${why} (e.g. ${keys.slice(0, 2).join(', ')})`)
        .join('; '),
    };
  }

  // 3. Can this comparison fail at all?
  if (gradedPairs === 0) return { ...base, usable: false, defect: 'no-overlap' };
  return { ...base, usable: true };
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
  lines.push(
    'A computed read `properties[k]` also counts when `k` iterates a literal name ' +
      'table (`table-loop`), but only when the loop body DELIVERS one of those reads. ' +
      'A body that merely compares them — an immutability guard or a change-detection ' +
      'scan — earns nothing, since crediting it would let one syntactic site vouch for ' +
      'every name in the table on the strength of a diff. The table itself is resolved ' +
      'LEXICALLY from the loop outward, so a table declared inside another class\'s ' +
      'method cannot vouch for this one. Reads off `previousProperties` are never ' +
      'evidence.'
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
        'exists so a reviewer can see where the analysis is blind. Two fully-understood ' +
        'non-deliveries are deliberately NOT listed: a call whose result only feeds a ' +
        'comparison or a `.length` measurement (`JSON.stringify(properties) === ...`), ' +
        'and a comparison-only table loop. Nothing is hidden from the walk in either ' +
        'case — the site simply does not deliver.'
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

const STALE_FAILURE =
  'handled-property-wiring: FAIL — stale HANDLED_WIRING_ALLOW_LIST entries.\n' +
  'These no longer match an un-wired declaration (the property is now wired,\n' +
  'renamed, or removed). Delete them so the critic verifies the fix:\n\n';

/** The escape hatch, spelled out wherever an evidence loss is reported. */
export const ACCEPT_LOSS_FLAG = '--accept-evidence-loss';

/**
 * The SECOND waiver, deliberately separate from {@link ACCEPT_LOSS_FLAG}.
 *
 * They waive different things and the difference is the audit artifact. An
 * evidence LOSS is measured and ENUMERATED — every lost (class, property) with
 * its shapes and seeds is printed before the write. A missing baseline has
 * nothing to enumerate, because the run compared against nothing at all.
 *
 * One flag for both meant the quietest tamper was not `git rm` but a single
 * corrupted byte: `loadBaseline` answers null for an unparseable file exactly as
 * for an absent one, so truncating the matrix and re-running with the loss
 * waiver wrote an UNGRADED matrix at exit 0 — and the regeneration overwrote the
 * corruption, leaving no trace. The widened waiver suppressed precisely the
 * enumeration that would have shown the reduction.
 */
export const ACCEPT_MISSING_BASELINE_FLAG = '--accept-missing-baseline';

const LOSS_PREAMBLE =
  'handled-property-wiring: FAIL — declared properties LOST wiring evidence.\n' +
  'Each property below is still counted `wired`, so the gap verdict stays silent,\n' +
  'but this run can prove strictly LESS about it than the committed matrix records\n' +
  '(issue #1842). The usual cause is a source edit that moved a read out of the\n' +
  "walk's sight — a `properties!['X']`-style spelling, a delegation replaced by an\n" +
  'unresolvable call, a delivery loop turned into a comparison — leaving a real\n' +
  'claim quietly unprovable while `0 gaps` stays byte-identical.\n\n';

const LOSS_ESCAPE_HATCH =
  '\nIf the reduction is INTENDED (the property genuinely lost that seam), accept it\n' +
  `deliberately by regenerating with the loss acknowledged:\n\n` +
  `  node --experimental-strip-types scripts/gen-handled-property-wiring.ts ${ACCEPT_LOSS_FLAG}\n` +
  '  (or: vp run gen:handled-property-wiring:accept-loss)\n\n' +
  'That rewrites the baseline, so the reduced evidence is what the matrix then\n' +
  'records — state WHY in the PR body, because the JSON diff is the only trace.\n';

/**
 * The refusal — in BOTH modes — when there is no readable baseline to grade
 * against.
 *
 * Deleting the matrix is the obvious way to defeat a check that grades against
 * it: `loadBaseline` answers null, {@link findEvidenceLosses} reads that as
 * "nothing to compare", so the writer would rewrite the file with whatever the
 * current tree can prove and `--check` would report `0 evidence losses` — both
 * silently, both exit 0.
 *
 * An earlier revision of this file asserted that CI's `git diff --quiet` step
 * caught that anyway. MEASURED, and it depends entirely on whether the deletion
 * is STAGED, which is why the claim was wrong as stated:
 *   - a bare `rm` leaves the path tracked in the index, so the re-created file
 *     reads as ` M <path>` and `git diff --quiet -- <path>` exits 1 -> CI red;
 *   - a STAGED deletion (`git rm` / `git rm --cached`) drops the index entry, so
 *     the re-created file is UNTRACKED, and `git diff --quiet -- <path>` exits
 *     0 -> CI green, with no trace of the reduction anywhere.
 * So the diff guard covers one spelling of the bypass and not the other, and
 * relying on it left a one-command hole. This refusal closes both spellings at
 * the point where they would take effect, without the script needing to shell
 * out to git.
 *
 * Applies to EVERY path — both modes, redirected or not. Earlier drafts scoped
 * it to the default output path and to the writer; both scopings were wrong, and
 * in the same direction. See {@link shouldRefuseUnusableBaseline}.
 */
const BASELINE_DEFECT_LINE: Record<BaselineDefect, (a: BaselineAssessment) => string> = {
  absent: () => 'It is absent, or not a readable v1 matrix, so there is nothing to compare against.',
  'self-inconsistent': (a) =>
    `Its own summary disagrees with the classes it holds (${a.detail ?? 'mismatch'}), so it was ` +
    'edited or partially written after generation and cannot be trusted to describe the tree it ' +
    'was generated from.',
  'evidence-stripped': (a) =>
    `Its counts are intact but the fields the comparison READS are not: ${a.detail ?? 'blank'}. ` +
    'A baseline recording no evidence cannot report a loss, however complete it looks.',
  'no-overlap': (a) =>
    `It grades ${a.gradedPairs} of this tree's ${a.currentPairs} declared (class, property) ` +
    'pairs, so no regression in this tree could make it fail.',
};

const unusableBaselineFailure = (path: string, a: BaselineAssessment): string =>
  `handled-property-wiring: FAIL — unusable baseline at ${path}\n` +
  `${BASELINE_DEFECT_LINE[a.defect ?? 'absent'](a)}\n` +
  `Graded ${a.gradedPairs}/${a.currentPairs} pairs (${a.gradedDepth} evidence entries).\n\n` +
  'The evidence-loss check (issue #1842) grades this run against that matrix, so reporting a\n' +
  'green verdict here, or rewriting the file from here, would install whatever the current\n' +
  'tree happens to support as the new baseline, unreviewed.\n\n' +
  `Restore it and re-run:\n\n  git checkout -- ${path}\n\n` +
  'If the matrix genuinely does not exist yet (a first-ever generation), pass\n' +
  `${ACCEPT_MISSING_BASELINE_FLAG} to write it without a comparison.\n`;

export function shouldRefuseUnusableBaseline(opts: {
  readonly usable: boolean;
  readonly acceptMissingBaseline: boolean;
}): boolean {
  return !opts.usable && !opts.acceptMissingBaseline;
}

const USAGE =
  'Usage: node scripts/gen-handled-property-wiring.ts [--check] [--accept-evidence-loss]\n' +
  '                                                   [--accept-missing-baseline]\n' +
  '                                                   [--providers-dir=<p>] [--baseline=<p>] [--out-dir=<p>]\n' +
  '  --check                     fail on a gap, a stale allow-list entry, an evidence loss,\n' +
  '                              or a baseline that could not have failed\n' +
  '  --accept-evidence-loss      WRITER only: acknowledge (and print) a reduction in the\n' +
  '                              per-property evidence set, then write the weaker matrix\n' +
  '  --accept-missing-baseline   WRITER only: proceed with NO comparison at all (a\n' +
  '                              first-ever generation). Separate from the flag above\n' +
  '                              because there is nothing to enumerate\n' +
  '  --providers-dir=<p>         TEST SEAM: walk a scratch copy of the providers tree\n' +
  '                              (writer mode additionally requires --out-dir=)\n' +
  '  --baseline=<p>              TEST SEAM: grade against a scratch matrix\n' +
  '  --out-dir=<p>               TEST SEAM: write the matrix somewhere other than docs/_generated\n';

const KNOWN_VALUE_FLAGS = ['--providers-dir=', '--baseline=', '--out-dir='];

function main(argv: readonly string[] = process.argv.slice(2)): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  // An unrecognized flag must NOT fall through to the WRITER path: `--chekc`
  // would rewrite the committed matrix and exit 0, and the SPACE form
  // `--providers-dir /tmp` would slip past the `=`-prefix tests below. Same
  // guard shape (and same reason) as gen-nested-key-coverage.ts.
  const unknown = argv.filter(
    (a) =>
      a.startsWith('-') &&
      a !== '--check' &&
      a !== ACCEPT_LOSS_FLAG &&
      a !== ACCEPT_MISSING_BASELINE_FLAG &&
      !KNOWN_VALUE_FLAGS.some((f) => a.startsWith(f))
  );
  if (unknown.length > 0) {
    process.stderr.write(`Unknown flag(s): ${unknown.join(', ')}\n${USAGE}`);
    process.exit(1);
  }
  const stray = argv.filter((a) => !a.startsWith('-'));
  if (stray.length > 0) {
    process.stderr.write(`Unexpected argument(s): ${stray.join(', ')}\n${USAGE}`);
    process.exit(1);
  }

  const checkMode = argv.includes('--check');
  const acceptLoss = argv.includes(ACCEPT_LOSS_FLAG);
  const acceptMissingBaseline = argv.includes(ACCEPT_MISSING_BASELINE_FLAG);

  // Both waivers belong to the WRITER only. `--check` is a verdict and must not
  // be silenceable by a flag on its own command line: the sanctioned way past a
  // loss is to regenerate the baseline (a visible file diff), never to tell the
  // checker to look away. Decided HERE, with the other argv guards, rather than
  // after `loadReport()` — the answer does not depend on the report, and running
  // an 84-file AST walk before refusing is work done to no purpose.
  //
  // `--baseline=` is deliberately NOT in this list, and the asymmetry is real
  // rather than an oversight: it is a TEST SEAM selecting WHAT to compare, so
  // `--check --baseline=<a weaker matrix>` legitimately reports no loss — there
  // is none relative to that baseline. It cannot manufacture a false PASS of the
  // gap or stale-allow-list verdicts, an unusable baseline is refused outright,
  // and CI never passes it.
  const waiverOnCheck = [ACCEPT_LOSS_FLAG, ACCEPT_MISSING_BASELINE_FLAG].find(
    (f) => checkMode && argv.includes(f)
  );
  if (waiverOnCheck !== undefined) {
    process.stderr.write(
      `handled-property-wiring: FAIL — ${waiverOnCheck} is a WRITER escape hatch and has no\n` +
        'meaning with --check. Regenerate the matrix with it instead, then re-run --check.\n'
    );
    process.exit(1);
  }

  // Test seam: point the walk at a scratch copy of the providers tree so the
  // shipped `--check` exit path can be exercised against a REAL provider file
  // carrying an injected gap, without ever mutating `src/` on disk.
  const dirFlag = argv.find((a) => a.startsWith('--providers-dir='));
  // Test seam: grade against a scratch baseline instead of the committed matrix.
  const baselineFlag = argv.find((a) => a.startsWith('--baseline='));
  // Test seam: write the matrix somewhere other than docs/_generated, so the
  // WRITER's refusal path can be exercised end-to-end without a broken refusal
  // being able to overwrite the committed matrix with the probe's degradation.
  const outDirFlag = argv.find((a) => a.startsWith('--out-dir='));

  // A value flag given TWICE would silently take the first and ignore the rest,
  // so `--baseline=<real> --baseline=/nope` would read as the real one while the
  // author believed the opposite (or vice versa). Any seam that decides what the
  // loss check grades against must not have a silent precedence rule.
  for (const flag of KNOWN_VALUE_FLAGS) {
    const given = argv.filter((a) => a.startsWith(flag));
    if (given.length > 1) {
      process.stderr.write(
        `handled-property-wiring: FAIL — ${flag} given ${given.length} times ` +
          `(${given.join(' ')}).\nPass it at most once.\n${USAGE}`
      );
      process.exit(1);
    }
    // An EMPTY value is not "unset", it is a path: `resolve('')` is the cwd, so
    // `--out-dir=` dropped the matrix at the repo root as two untracked files
    // (measured). Every one of these flags names a path; none has a meaningful
    // empty value.
    if (given[0] !== undefined && given[0].slice(flag.length).trim() === '') {
      process.stderr.write(
        `handled-property-wiring: FAIL — ${flag} needs a path; got an empty value.\n${USAGE}`
      );
      process.exit(1);
    }
  }

  // `--out-dir=` only means anything to the WRITER. Accepting-and-ignoring it on
  // the check path invites "I redirected the output, so this run was harmless".
  if (checkMode && outDirFlag !== undefined) {
    process.stderr.write(
      'handled-property-wiring: FAIL — --out-dir= is a WRITER flag; --check writes nothing.\n' +
        `Drop it, or drop --check.\n${USAGE}`
    );
    process.exit(1);
  }

  const defaultOutDir = dirname(OUT_JSON);
  const outDir = outDirFlag ? resolve(outDirFlag.slice('--out-dir='.length)) : defaultOutDir;
  // The redirect must be a REAL redirect, decided by directory IDENTITY rather
  // than by string equality.
  //
  // Two rounds of this guard were bypassable. First it checked only that
  // `--out-dir=` was PRESENT, so `--out-dir=docs/_generated` satisfied it.
  // Comparing `resolve()` output fixed the pure-path spellings (`./x/.`,
  // `../_generated`, the absolute form) but NOT the two that do not differ as
  // paths at all: on a case-insensitive filesystem `docs/_GENERATED` is the same
  // directory under a different string, and a SYMLINK to `docs/_generated` is
  // the same directory under a different path entirely. Both were measured
  // writing the committed matrix from a degraded tree at exit 0.
  //
  // `realpathSync` alone does not settle it either — it resolves the symlink but
  // returns the case spelling it was given. `dev`+`ino` is the filesystem's own
  // answer to "same directory?", so it is immune to both. It needs the directory
  // to EXIST, which a legitimate fresh `--out-dir=` may not; that case falls
  // back to the path compare, and is safe because a directory that does not yet
  // exist cannot be the committed one (which does).
  const sameDir = (a: string, b: string): boolean => {
    try {
      const x = statSync(a);
      const y = statSync(b);
      return x.dev === y.dev && x.ino === y.ino;
    } catch {
      return resolve(a) === resolve(b);
    }
  };
  const redirected = outDirFlag !== undefined && !sameDir(outDir, defaultOutDir);

  // BOTH grading seams are refused on the WRITER path unless the output is
  // redirected too. `--providers-dir=` would render the COMMITTED matrix from a
  // tree that is not `src/`; `--baseline=` is subtler and strictly worse —
  // pointing it anywhere unreadable makes `loadBaseline` answer null, which the
  // loss check reads as "nothing to compare", so the writer would overwrite
  // docs/_generated with WEAKER evidence, exit 0, and print nothing. That is the
  // silent default this whole verdict exists to remove, reachable by one flag.
  // Allowed together with a real `--out-dir=`, which is what the probes do.
  for (const [flag, present] of [
    ['--providers-dir=', dirFlag !== undefined],
    ['--baseline=', baselineFlag !== undefined],
  ] as const) {
    if (present && !checkMode && !redirected) {
      process.stderr.write(
        `handled-property-wiring: FAIL — ${flag} may only accompany a WRITE when --out-dir= also\n` +
          'redirects the output SOMEWHERE ELSE. Refusing to render docs/_generated from a tree\n' +
          `or a baseline that is not the committed one.\n${USAGE}`
      );
      process.exit(1);
    }
  }

  const outJson = join(outDir, 'handled-property-wiring.json');
  const outMd = join(outDir, 'handled-property-wiring.md');
  const report = loadReport(dirFlag ? resolve(dirFlag.slice('--providers-dir='.length)) : undefined);
  const stale = findStaleAllowListEntries(report);
  const baselinePath = baselineFlag
    ? resolve(baselineFlag.slice('--baseline='.length))
    : OUT_JSON;
  const baseline = loadBaseline(baselinePath);
  const assessment = assessBaseline(baseline, report);

  // Defeating a check that grades against a file is a matter of making the file
  // stop being able to fail — by deleting it, truncating it, emptying it, or
  // writing it for other classes. One predicate covers all of them (see
  // {@link assessBaseline}), in BOTH modes and redirected or not: a `--check`
  // reporting `0 evidence losses` after comparing against nothing is an unearned
  // green, the verdict this critic exists to abolish. See
  // {@link unusableBaselineFailure} for why CI's `git diff --quiet` step does not
  // cover this on its own, and why CI's step ORDERING must not be what makes the
  // checker honest.
  if (shouldRefuseUnusableBaseline({ usable: assessment.usable, acceptMissingBaseline })) {
    process.stderr.write(unusableBaselineFailure(baselinePath, assessment));
    process.exit(1);
  }

  const losses = findEvidenceLosses(baseline, report);

  if (checkMode) {
    // BOTH verdicts are reported before exiting: an earlier revision returned
    // after the gap block, so a stale entry stayed invisible until the unrelated
    // gap was fixed (and vice versa in the writer path). Stale first, mirroring
    // gen-nested-key-coverage.ts.
    const gaps = findGaps(report);
    if (stale.length > 0) {
      process.stderr.write(STALE_FAILURE);
      for (const k of stale) process.stderr.write(`  ${k}\n`);
      if (gaps.length > 0) process.stderr.write('\n');
    }
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
      if (losses.length > 0) process.stderr.write('\n');
    }
    if (losses.length > 0) {
      process.stderr.write(LOSS_PREAMBLE);
      for (const l of losses) process.stderr.write(`${formatEvidenceLoss(l)}\n`);
      process.stderr.write(LOSS_ESCAPE_HATCH);
    }
    if (stale.length > 0 || gaps.length > 0 || losses.length > 0) process.exit(1);
    process.stderr.write(
      `handled-property-wiring: OK — ${report.summary.classifiedCount} provider classes, ` +
        `${report.summary.wiredProperties}/${report.summary.declaredProperties} declared ` +
        `properties with read evidence, 0 gaps, 0 evidence losses ` +
        `(graded ${assessment.gradedPairs}/${assessment.currentPairs} pairs, ` +
        `${assessment.gradedDepth} evidence entries, against the baseline; ` +
        `${report.summary.wired} wired, ` +
        `${report.summary.allowListed} allow-listed, ` +
        `${report.summary.classesWithBlindSpots} with a recorded blind spot).\n`
    );
    return;
  }

  if (stale.length > 0) {
    process.stderr.write(STALE_FAILURE);
    for (const k of stale) process.stderr.write(`  ${k}\n`);
    process.exit(1);
  }

  // The WRITER refuses to overwrite the baseline with weaker evidence unless the
  // loss is acknowledged. This is the half that makes the verdict reachable at
  // all: `--check` alone still passes for the author who edits the source AND
  // regenerates in the same commit, because regenerating moves the baseline
  // underneath the comparison. Refusing here turns that silent default into a
  // message naming exactly what was lost, which the author must then dismiss on
  // purpose.
  if (losses.length > 0 && !acceptLoss) {
    process.stderr.write(LOSS_PREAMBLE);
    for (const l of losses) process.stderr.write(`${formatEvidenceLoss(l)}\n`);
    process.stderr.write(LOSS_ESCAPE_HATCH);
    process.exit(1);
  }
  if (losses.length > 0) {
    process.stderr.write(
      `handled-property-wiring: ACCEPTED EVIDENCE LOSS (${ACCEPT_LOSS_FLAG}) — the matrix below\n` +
        'records STRICTLY WEAKER evidence than before for:\n'
    );
    for (const l of losses) process.stderr.write(`${formatEvidenceLoss(l)}\n`);
  }
  // Independent `if`, not an `else if` chained to the loss notice: with BOTH
  // waivers on an unusable baseline the run printed only the loss acceptance and
  // never said it had graded against nothing — contradicting this notice's own
  // claim to be the ONLY output the missing-baseline waiver produces.
  if (!assessment.usable) {
    // Say it, or the run looks like an ordinary write while it is in fact
    // installing an UNGRADED matrix. This is the ONLY output the missing-baseline
    // waiver produces — there is no per-property enumeration to print, which is
    // exactly why it is a separate flag from the loss waiver.
    process.stderr.write(
      `handled-property-wiring: ACCEPTED MISSING BASELINE (${ACCEPT_MISSING_BASELINE_FLAG}) — the\n` +
        `baseline at ${baselinePath} was REFUSED as unusable and the waiver overrode that, so\n` +
        'this run was not graded against a trustworthy baseline and the file below becomes the\n' +
        `new baseline unreviewed. What it did reach: ${assessment.gradedPairs}/${assessment.currentPairs} pairs\n` +
        `(${assessment.gradedDepth} evidence entries). Legitimate only for a first-ever generation.\n`
    );
  }

  mkdirSync(outDir, { recursive: true });
  atomicWrite(outJson, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(outMd, renderMarkdown(report) + '\n');
  process.stderr.write(
    `handled-property-wiring: graded ${assessment.gradedPairs}/${assessment.currentPairs} pairs ` +
      `(${assessment.gradedDepth} evidence entries) against the baseline at ${baselinePath}.\n`
  );
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
