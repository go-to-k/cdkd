/**
 * SDK-provider `UpdateContext` declaration fence (issue #2613, remedy 1).
 *
 * WHAT THIS CHECKS
 * ----------------
 * `ResourceProvider.update`'s `context` parameter is OPTIONAL
 * (`context?: UpdateContext`, `src/types/resource.ts`), so a provider that
 * simply does not declare it compiles fine and the argument the deploy engine
 * passes is dropped on the floor — silently, with no type error and no lint.
 * Issue #2301 item 1 put `expectedRegion` on that context and threaded it from
 * `deploy-engine.ts`, both `rollback-executor.ts` replay arms and
 * `drift --revert`, so the UPDATE path could run the same `assertRegionMatch`
 * guard the DELETE path runs. The caller side landed; most of the receiver side
 * did not, and nothing reds when a NEW provider joins the omitting set.
 *
 * This check records WHICH providers omit the parameter, so the split can only
 * move deliberately, in either direction, and the omitting set is a named
 * worklist rather than an integer.
 *
 * WHAT IT IS NOT
 * --------------
 * Declaring the parameter is NOT the same as running the guard. A provider can
 * take `context?: UpdateContext` and never call `assertRegionMatch`, and this
 * check will call it "declaring" — the parameter is the PRECONDITION for the
 * guard, and issue #2613 remedy 2 (the per-provider guard call, with its
 * placement argued per provider) is what makes the guard actually run. Stated
 * here because a fence that is read as proving more than it proves is worse
 * than no fence.
 *
 * WHY A NAMED ALLOW-LIST AND NOT A COUNT
 * --------------------------------------
 * A bare count ("60 providers omit it") rots on every provider added or
 * removed, and says nothing about WHICH. `OMITS_UPDATE_CONTEXT` below is the
 * exact set, so the three interesting transitions each fail with their own
 * message:
 *
 *   - a NEW provider written without the parameter is not in the set → FAIL
 *     ("add the parameter", the desired remedy, named first);
 *   - a provider that GAINED the parameter is in the set but declares → FAIL
 *     with the good news and the one-line edit (delete its entry); the fence
 *     therefore ratchets tighter and can never be satisfied by re-adding the
 *     parameter to nothing;
 *   - an entry naming a provider that no longer exists (renamed / deleted) →
 *     FAIL, so the list cannot rot into a set of dead names.
 *
 * The DECLARING set is derived (population minus the list) rather than pinned
 * as a second literal: one list is one source of truth, and every direction is
 * already covered above.
 *
 * HOW THE POPULATION IS DERIVED
 * -----------------------------
 * From a relation a provider CANNOT omit, not from an optional language
 * feature. `implements ResourceProvider` is optional (a class assignable to the
 * interface can be registered without it) and `async` is optional (two
 * providers spell `update()` without it — which is exactly why issue #2613's
 * own `grep "async update("` measured 77 files where there are 85 classes).
 * The relation used here is MEMBERSHIP: `ResourceProvider` declares `create`,
 * `update` and `delete` as REQUIRED members, so a provider must carry all
 * three. Member NAMES are read in every spelling the language allows in that
 * position: an identifier, a string literal, a computed name over a string or
 * template literal, and a private identifier (whose `.text` carries the `#`
 * and so never matches). A bare no-substitution-template member name is NOT
 * handled, because it is a syntax error — measured, 3 parse diagnostics. The
 * class itself may be a DECLARATION or an EXPRESSION assigned to a binding, and
 * each member a method or a property initialized with a function expression.
 *
 * **Which classes are CANDIDATES.** Only a candidate can be refused; everything
 * else is ignored. A class is a candidate when it says
 * `implements ResourceProvider`, OR declares at least TWO of the three (a
 * provider missing only `update` still has `create` and `delete`, both equally
 * required), OR names `update` at all — in any spelling, including one this
 * checker cannot read. `update` counts alone because it is the member whose
 * signature this whole check is about.
 *
 * That gate is calibration, and it is measured rather than assumed. An earlier
 * revision gated only two of the five arms, on "declares at least one of the
 * three", and review proved it refused five shapes that could never be
 * providers: a `static create()` factory, a `get create()` accessor, an options
 * bag with `delete = true`, `class LruCache extends Map { delete() }` and
 * `class WidgetFactory extends BaseFactory { create() }` — the last two through
 * an arm that WAS gated, so gating the other three would not have helped.
 * Appending that cache to a real provider file made the shipped binary exit 1.
 * A refusal every reader learns to ignore protects nothing. The price is
 * limit 6 below, stated there.
 *
 * **What a candidate is REFUSED for**, rather than silently dropped: a member
 * named one of the three whose parameter list cannot be read (a `static` one
 * with no instance twin, a property with no initializer or a non-function one,
 * an accessor); declaring two of the three; `implements ResourceProvider`
 * without all three; an unresolvable computed member name; extending a base
 * class while declaring fewer than three itself; and an `update` parameter
 * carrying a default value.
 *
 * Six of these arms were FAIL-OPEN until review proved them so, each returning
 * `rc=0` with the class in neither `classes` nor `refusals`.
 *
 * The unit is the CLASS, not the file: `glue-provider.ts` declares seven
 * providers, all of which issue #2613's file-level grep collapsed into one.
 *
 * WHAT COUNTS AS DECLARING (structural, not "the text mentions UpdateContext")
 * ---------------------------------------------------------------------------
 * The 6th parameter must be a plain identifier binding — not a rest element,
 * which is a SEPARATE test because a rest element's name is an identifier too —
 * whose type annotation is `UpdateContext`, or a union of it with `undefined` /
 * `null`. The name `UpdateContext` must be bound by an import whose specifier,
 * resolved against the importing file and mapped `.js` -> `.ts`, ENDS WITH
 * `/types/resource.ts`. That is a path test, not the compiler's module
 * resolution: it cannot be fooled by a sibling `mytypes/resource.js` (the
 * leading separator is what closed that, in review), and it would accept a
 * hypothetical `<anything>/types/resource.ts` elsewhere in the tree — of which
 * there is exactly one. `context?: unknown` and `context?: DeleteContext` are
 * therefore not declarations. Anything else in that position — a rest or
 * destructured parameter, a missing annotation, an alias, a 7th parameter — is
 * REFUSED, not silently bucketed: the point of failing closed is that an
 * unmodelled spelling stops the check rather than passing through it.
 *
 * WHAT THIS DOES NOT CATCH (measured limits, not a claim of completeness)
 * ----------------------------------------------------------------------
 *  1. A provider that DECLARES the parameter and never reads it. See "what it
 *     is not" above — that is remedy 2, and no signature check can see it.
 *  2. A local `type Ctx = UpdateContext` alias, or `import { UpdateContext as
 *     Ctx }`. These are REFUSED (fail closed), so they surface as a failure
 *     asking for the checker to be extended, not as a silent pass — but they
 *     are not classified either.
 *  3. A provider class defined OUTSIDE `src/provisioning/providers/`.
 *     `CloudControlProvider` is the one such class today; it already consumes
 *     `expectedRegion`, and widening the root is a separate decision.
 *  4. A provider whose `update` is inherited from a base class in another file.
 *     No provider extends anything today. Such a class is refused by the
 *     membership rule above when it is a provider CANDIDATE (see the gate
 *     below), and the RUNTIME half of the fence
 *     (`tests/unit/scripts/provider-update-context.test.ts`, which reads
 *     `update.length` off each object `registerAllProviders` builds) covers
 *     the REGISTERED ones regardless of how their source is written.
 *     Registration is not the same as reachability: `CustomResourceProvider`
 *     is constructed by `ProviderRegistry` itself and is routed to without
 *     ever being registered, so a class shaped like THAT one — extending a
 *     base, declaring none of the three — is seen by neither half. That is
 *     limit 6 below, and it is the reason this paragraph no longer claims the
 *     registered set is everything a deploy can reach.
 *  5. A provider in a SUBDIRECTORY of the providers root. The scan is not
 *     recursive; rather than pass silently, `buildReport` REFUSES any
 *     subdirectory it finds, so the fail-open review measured is now a loud
 *     failure telling you to flatten the file or teach the walk.
 *  6. **A real provider that falls outside the plausibility gate** — it does
 *     not say `implements`, declares fewer than two of `create` / `update` /
 *     `delete` itself, never names `update` in any spelling, and inherits the
 *     rest from a base class. This is the shape the membership rule genuinely
 *     cannot see, and it is named rather than claimed away.
 *
 *     Refusing it is not available, and that is measured rather than assumed:
 *     the gate exists because the ungated arms refused a `static create()`
 *     factory, a `get create()` accessor, an options bag with `delete = true`,
 *     `class LruCache extends Map { delete() }` and
 *     `class WidgetFactory extends BaseFactory { create() }` — none of which
 *     could be a provider, and the cache appended to a real provider file made
 *     the shipped binary exit 1. (`HostedZoneNameNotFoundError` in
 *     `route53-provider.ts` is the in-tree instance; it extends
 *     `ProvisioningError`, not `Error` — no class under `providers/` extends
 *     `Error` directly.)
 *
 *     The RUNTIME half covers such a provider once it is REGISTERED, where it
 *     fails "every registered provider is one the source scan found". What
 *     neither half covers is a provider that is reachable WITHOUT being
 *     registered, the way `ProviderRegistry` constructs
 *     `CustomResourceProvider` in its own constructor. That residual is
 *     bounded by inspection rather than by this checker: the set of such
 *     providers is whatever `provider-registry.ts` instantiates directly, and
 *     the unit suite pins it by name in `UNREGISTERED_PROVIDER_CLASSES`.
 *  7. A provider class that is neither declared nor assigned to a binding — an
 *     immediately-registered `class { … }` expression passed straight to
 *     `registry.register`. It has no name to key an allow-list by; the RUNTIME
 *     half reports it under whatever name the constructor carries, and the
 *     "every registered provider is one the source scan found" case fails.
 *
 * WHAT DEFENDS THIS CHECKER FROM ITSELF
 * -------------------------------------
 *  1. COLLAPSE TOWARD ZERO — a renamed directory, a compiler-API change, a file
 *     that stops parsing. `FLOORS` (files, classes, declaring classes) plus a
 *     hard failure on any parse diagnostic. A file that fails to parse
 *     contributes no classes, which reads exactly like a clean file.
 *  2. COLLAPSE TOWARD GREEN — the classifier degrades so that everything reads
 *     as declaring. No floor can see this: the counts are unchanged. The
 *     SELF-PROBE below is what catches it — fixed sources with known verdicts,
 *     including known-OMITTING and known-REFUSED ones, analyzed on every run
 *     before the real tree is touched.
 *  3. A SECOND INSTRUMENT — the unit test cross-checks the verdict for every
 *     REGISTERED provider (84 of the 85 classes; `CustomResourceProvider` is
 *     built by `ProviderRegistry` itself) against `Function.length` on the
 *     live objects `registerAllProviders` builds. Source text and a constructed object are
 *     independent witnesses; a disagreement fails.
 *
 * USAGE
 *   node scripts/check-provider-update-context.ts
 *   node scripts/check-provider-update-context.ts --json
 *   node scripts/check-provider-update-context.ts --providers-dir=/tmp/copy
 *     (test seam; probes never write to src/)
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript-v6';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

export const DEFAULT_PROVIDERS_DIR = join(REPO_ROOT, 'src/provisioning/providers');

/**
 * The module that owns `UpdateContext`, as a resolved-path suffix. The leading
 * separator is load-bearing: without it the unanchored suffix also accepted a
 * sibling `../../mytypes/resource.js`, which review PROVED classified a
 * provider as declaring against a type this repo does not own.
 */
const UPDATE_CONTEXT_MODULE_SUFFIX = '/types/resource.ts';

/** The interface member names a `ResourceProvider` cannot omit. */
const REQUIRED_MEMBERS = ['create', 'update', 'delete'] as const;

/**
 * Provider classes that do NOT declare `update`'s `UpdateContext` parameter, so
 * `assertRegionMatch` cannot run on their update path (issue #2613 remedy 2 is
 * the backfill; this list is its worklist). Sorted; keep it that way.
 *
 * REMOVE a name when its provider gains the parameter — the check fails until
 * you do, which is the ratchet.
 */
export const OMITS_UPDATE_CONTEXT: readonly string[] = [
  'ACMCertificateProvider',
  'AgentCoreBrowserProvider',
  'AgentCoreCodeInterpreterProvider',
  'AgentCoreEvaluatorProvider',
  'AgentCoreRuntimeProvider',
  'ApiGatewayProvider',
  'CloudFrontDistributionProvider',
  'CloudFrontOACProvider',
  'CloudFrontOAIProvider',
  'CloudTrailProvider',
  'CloudWatchAlarmProvider',
  'CodeBuildProvider',
  'CodeCommitRepositoryProvider',
  'DLMLifecyclePolicyProvider',
  'DocDBProvider',
  'ECRProvider',
  'ECSProvider',
  'EFSProvider',
  'EMRClusterProvider',
  'EMRInstanceFleetConfigProvider',
  'EMRInstanceGroupConfigProvider',
  'ElastiCacheProvider',
  'EventBridgeBusProvider',
  'EventBridgeRuleProvider',
  'FSxFileSystemProvider',
  'FirehoseProvider',
  'GlueConnectionProvider',
  'GlueCrawlerProvider',
  'GlueJobProvider',
  'GlueProvider',
  'GlueSecurityConfigurationProvider',
  'GlueTriggerProvider',
  'GlueWorkflowProvider',
  'IAMAccessKeyProvider',
  'IAMInstanceProfileProvider',
  'IAMManagedPolicyProvider',
  'IAMPolicyProvider',
  'IAMRoleProvider',
  'IAMUserGroupProvider',
  'KMSProvider',
  'KinesisStreamConsumerProvider',
  'LambdaEventInvokeConfigProvider',
  'LambdaEventSourceMappingProvider',
  'LambdaLayerVersionProvider',
  'LambdaMicrovmImageProvider',
  'LambdaPermissionProvider',
  'LambdaUrlProvider',
  'LogsLogGroupProvider',
  'NeptuneProvider',
  'NestedStackProvider',
  'RDSDBProxyEndpointProvider',
  'RDSDBProxyProvider',
  'RDSDBProxyTargetGroupProvider',
  'RDSProvider',
  'S3BucketPolicyProvider',
  'S3DirectoryBucketProvider',
  'S3TablesProvider',
  'S3VectorsProvider',
  'SNSSubscriptionProvider',
  'SNSTopicPolicyProvider',
  'SQSQueuePolicyProvider',
  'SQSQueueProvider',
  'SchedulerScheduleProvider',
  'SecretsManagerSecretProvider',
  'StepFunctionsProvider',
  'WAFv2WebACLProvider',
  'WaitConditionHandleProvider',
];

/**
 * Collapse-toward-zero floors. Deliberately loose — their job is to fail a
 * walker that stopped seeing the tree, not to police ordinary additions and
 * removals. Measured 2026-09-06: 82 files, 85 provider classes, 18 declaring.
 */
export const FLOORS = {
  files: 70,
  providerClasses: 75,
  declaring: 12,
} as const;

export type Verdict = 'declares' | 'omits';

export interface ProviderClass {
  /** Class name — the key the allow-list uses. */
  readonly name: string;
  /** File name relative to the scanned root. */
  readonly file: string;
  readonly verdict: Verdict;
  /** Number of parameters declared on `update`. */
  readonly updateParams: number;
}

export interface Refusal {
  readonly file: string;
  readonly name: string;
  readonly reason: string;
}

export interface Report {
  readonly providersDir: string;
  readonly files: readonly string[];
  readonly classes: readonly ProviderClass[];
  readonly declaring: readonly string[];
  readonly omitting: readonly string[];
  readonly refusals: readonly Refusal[];
}

/** A `create` / `update` / `delete` member, however it is spelled. */
interface Member {
  readonly parameters: readonly ts.ParameterDeclaration[];
}

/**
 * The member's name, when it can be resolved statically. Handles the four
 * spellings a class member's name can take, not just the identifier one:
 * review PROVED that returning `undefined` for the other three made the class
 * fall out of the population in SILENCE, with `rc=0` and neither a class nor a
 * refusal to show for it.
 *
 * Returns `undefined` only when the name genuinely cannot be known at parse
 * time (a computed name over a non-literal expression), which the caller
 * treats as a reason to REFUSE rather than to ignore.
 */
function memberName(node: ts.ClassElement): string | undefined {
  const nameNode = 'name' in node ? (node.name as ts.Node | undefined) : undefined;
  if (!nameNode) return undefined;
  // A private identifier's `.text` carries the leading `#`, so `#update` can
  // never match a required member name — reading it is what keeps such a class
  // from looking like it has an unnameable member.
  if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) return nameNode.text;
  // String literal only. A BARE no-substitution template in a member-name
  // position is a syntax error (measured: 3 parse diagnostics), so a branch for
  // it would be dead code; the COMPUTED form below is legal and is handled.
  if (ts.isStringLiteral(nameNode)) return nameNode.text;
  if (ts.isComputedPropertyName(nameNode)) {
    const expr = nameNode.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    return undefined;
  }
  return undefined;
}

function isStatic(node: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
  );
}

/**
 * Classify ONE class member.
 *
 * `kind` is the load-bearing part. `'signature'` is a member whose parameter
 * list this checker can read; `'unmodelled'` is a member NAMED `create` /
 * `update` / `delete` whose shape it cannot read — a `static` one, a property
 * with no initializer or a non-function initializer, an accessor. Both are
 * returned; only the first is classifiable, and the second must REFUSE rather
 * than vanish. Before the review that added `'unmodelled'`, every shape in it
 * returned `undefined` here and the class was dropped with `rc=0`.
 */
type MemberScan =
  | { readonly name: string; readonly kind: 'signature'; readonly member: Member }
  | { readonly name: string; readonly kind: 'unmodelled'; readonly why: string }
  | undefined;

function memberSignature(node: ts.ClassElement): MemberScan {
  const name = memberName(node);
  if (name === undefined) return undefined;
  if (!REQUIRED_MEMBERS.includes(name as (typeof REQUIRED_MEMBERS)[number])) return undefined;

  if (isStatic(node)) {
    return { name, kind: 'unmodelled', why: `\`static ${name}\` is not the instance member` };
  }
  if (ts.isMethodDeclaration(node)) {
    return { name, kind: 'signature', member: { parameters: [...node.parameters] } };
  }
  if (ts.isPropertyDeclaration(node)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      return { name, kind: 'signature', member: { parameters: [...init.parameters] } };
    }
    return {
      name,
      kind: 'unmodelled',
      why: `\`${name}\` is a property whose initializer is not a function expression, so its parameter list cannot be read`,
    };
  }
  return {
    name,
    kind: 'unmodelled',
    why: `\`${name}\` is declared in a shape whose parameter list cannot be read (accessor, index signature or overload)`,
  };
}

/**
 * A readable name for a class, whether it is DECLARED or an EXPRESSION assigned
 * to a binding (`export const P = class { … }`). The expression form is not a
 * `ClassDeclaration`, so scanning only for declarations dropped such a provider
 * out of the population in silence (found in review).
 */
function className(node: ts.ClassDeclaration | ts.ClassExpression): string {
  if (node.name) return node.name.text;
  const parent = node.parent as ts.Node | undefined;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return '<anonymous class>';
}

function declaresResourceProvider(
  node: ts.ClassDeclaration | ts.ClassExpression,
  sf: ts.SourceFile
): boolean {
  return (
    node.heritageClauses?.some(
      (clause) =>
        clause.token === ts.SyntaxKind.ImplementsKeyword &&
        clause.types.some((t) => t.expression.getText(sf) === 'ResourceProvider')
    ) ?? false
  );
}

/**
 * Local names bound to `UpdateContext` by an import whose specifier resolves to
 * the module that owns the type. An ALIASED import (`as Ctx`) is deliberately
 * not collected — the classifier refuses the alias rather than modelling it.
 */
function updateContextLocalNames(sf: ts.SourceFile, filePath: string): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    const resolved = resolve(filePath, '..', spec.text.replace(/\.js$/, '.ts'));
    if (!resolved.endsWith(UPDATE_CONTEXT_MODULE_SUFFIX)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      // `import { UpdateContext }` binds the name; `import { UpdateContext as
      // Ctx }` has a propertyName and is left uncollected on purpose.
      if (!element.propertyName && element.name.text === 'UpdateContext') {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function isUpdateContextType(type: ts.TypeNode | undefined, names: ReadonlySet<string>): boolean {
  if (!type) return false;
  if (ts.isTypeReferenceNode(type)) {
    return ts.isIdentifier(type.typeName) && names.has(type.typeName.text);
  }
  if (ts.isUnionTypeNode(type)) {
    let sawContext = false;
    for (const member of type.types) {
      if (isUpdateContextType(member, names)) {
        sawContext = true;
        continue;
      }
      if (
        member.kind === ts.SyntaxKind.UndefinedKeyword ||
        member.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword)
      ) {
        continue;
      }
      return false;
    }
    return sawContext;
  }
  return false;
}

/**
 * Classify every class in one source. `filePath` is used for import resolution
 * only, so a synthetic path works and no filesystem access is needed.
 */
export function analyzeSource(
  filePath: string,
  text: string,
  fileLabel: string
): { readonly classes: ProviderClass[]; readonly refusals: Refusal[] } {
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const contextNames = updateContextLocalNames(sf, filePath);
  const classes: ProviderClass[] = [];
  const refusals: Refusal[] = [];

  const refuse = (name: string, reason: string): void => {
    refusals.push({ file: fileLabel, name, reason });
  };

  // A file that fails to parse contributes zero classes, which is
  // indistinguishable from a clean file — so say so loudly. `createSourceFile`
  // records only SYNTACTIC diagnostics, which is exactly the question here.
  const diagnostics =
    (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    refuse('<file>', `${diagnostics.length} parse diagnostic(s); it contributes no classes`);
  }

  const walk = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = className(node);
      const members = new Map<string, Member>();
      const unmodelled: { readonly name: string; readonly why: string }[] = [];
      let unnameableMember = false;
      for (const element of node.members) {
        const found = memberSignature(element);
        if (!found) {
          // A computed name over a non-literal expression could BE `update`.
          if (memberName(element) === undefined && !ts.isSemicolonClassElement(element)) {
            unnameableMember = true;
          }
          continue;
        }
        if (found.kind === 'signature') members.set(found.name, found.member);
        else unmodelled.push({ name: found.name, why: found.why });
      }
      const present = REQUIRED_MEMBERS.filter((m) => members.has(m));
      const implementsInterface = declaresResourceProvider(node, sf);
      // A base class can supply any of the three, and this checker does not
      // follow heritage — so a subclass short of the triple is unknowable, not
      // absent. (`extends` alone is not enough to refuse: a complete class that
      // happens to extend something is fully readable here.)
      const extendsSomething =
        node.heritageClauses?.some((c) => c.token === ts.SyntaxKind.ExtendsKeyword) ?? false;

      // Every arm below refuses rather than returning, so a class hitting two
      // of them is reported once per reason instead of only the first.
      // ONE plausibility gate, applied to EVERY refusal arm below.
      //
      // Review measured the previous split — two arms gated on `present > 0`,
      // three ungated — refusing five shapes that could never be providers:
      // a `static create()` factory, a `get create()` accessor, an options bag
      // with `delete = true`, and (through the GATED arm, so gating the other
      // three would not have helped) `class LruCache extends Map { delete() }`
      // and `class WidgetFactory extends BaseFactory { create() }`. Appending
      // that cache to a real provider file made the shipped binary exit 1 and
      // tell the author to extend this checker.
      //
      // The predicate is what those cases have in common: they touch ONE of
      // the three names, incidentally. A class is treated as a provider
      // candidate only when it says `implements`, or declares TWO of the three
      // (a provider missing just `update` still has `create` and `delete`,
      // both equally required), or names `update` at all — the member whose
      // signature this whole check is about, in any spelling including an
      // unreadable one. `delete` on a cache and `create` on a factory are
      // single incidental hits and fall outside it.
      const namesUpdate = members.has('update') || unmodelled.some((u) => u.name === 'update');
      const plausibleProvider = implementsInterface || present.length >= 2 || namesUpdate;

      const shapeRefusals: string[] = [];
      for (const u of unmodelled) {
        // A `static update` beside an instance `update` is ordinary; only an
        // unmodelled member with NO readable twin hides a signature.
        if (plausibleProvider && !members.has(u.name)) shapeRefusals.push(u.why);
      }
      if (unnameableMember && plausibleProvider && present.length !== REQUIRED_MEMBERS.length) {
        shapeRefusals.push(
          'a member has a computed name this checker cannot resolve, so it may be one of create/update/delete'
        );
      }
      if (extendsSomething && plausibleProvider && present.length !== REQUIRED_MEMBERS.length) {
        shapeRefusals.push(
          `it extends a base class and declares only ${present.length} of create/update/delete itself, so the rest may be inherited`
        );
      }
      if (shapeRefusals.length > 0) {
        for (const why of shapeRefusals) refuse(name, why);
      } else if (present.length === REQUIRED_MEMBERS.length) {
        const update = members.get('update');
        /* c8 ignore next -- unreachable: present.length implies the member */
        if (!update) return;
        const params = update.parameters;
        const defaulted = params.find((param) => param.initializer !== undefined);
        if (defaulted) {
          // `Function.length` counts parameters BEFORE the first defaulted one,
          // so a default anywhere in `update` silently breaks the equivalence
          // the unit suite's runtime witness asserts. Refusing here is what
          // makes that equivalence a fact rather than an unenforced premise
          // (found in review; no provider carries one today).
          refuse(
            name,
            `update()'s \`${defaulted.name.getText(sf)}\` parameter has a default value, which lowers \`update.length\` below its declared arity and breaks the source-vs-runtime equivalence`
          );
        } else if (params.length < 5) {
          refuse(
            name,
            `update() declares ${params.length} parameters; ResourceProvider.update takes 5 plus an optional context`
          );
        } else if (params.length === 5) {
          classes.push({ name, file: fileLabel, verdict: 'omits', updateParams: params.length });
        } else if (params.length === 6) {
          const context = params[5];
          // `dotDotDotToken` is checked SEPARATELY from the binding shape: a
          // rest element's name IS an identifier, so the `isIdentifier` test
          // alone let `...context: UpdateContext` through as a declaration
          // while `update.length` saw 5 (found in review).
          if (!ts.isIdentifier(context.name) || context.dotDotDotToken) {
            refuse(name, "update()'s 6th parameter is destructured or a rest element");
          } else if (!context.type) {
            refuse(name, "update()'s 6th parameter has no type annotation");
          } else if (isUpdateContextType(context.type, contextNames)) {
            classes.push({ name, file: fileLabel, verdict: 'declares', updateParams: params.length });
          } else {
            refuse(
              name,
              `update()'s 6th parameter is typed \`${context.type.getText(sf)}\`, which is not \`UpdateContext\` imported from ${UPDATE_CONTEXT_MODULE_SUFFIX}`
            );
          }
        } else {
          refuse(name, `update() declares ${params.length} parameters; at most 6 are modelled`);
        }
      } else if (implementsInterface || present.length >= 2 || members.has('update')) {
        // `members.has('update')` is the arm review added: a class declaring
        // ONLY `update` (create / delete inherited, no `implements`) satisfied
        // neither the classification nor the old `>= 2` refusal, so it left the
        // population in SILENCE — the exact fail-open this file exists to
        // refuse. It is the load-bearing member: a class carrying an `update`
        // method is the shape whose signature this check is about.
        refuse(
          name,
          `declares ${present.length} of create/update/delete (${present.join(', ') || 'none'})${
            implementsInterface ? ' while implementing ResourceProvider' : ''
          } — an inherited or otherwise unmodelled member`
        );
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return { classes, refusals };
}

export function buildReport(providersDir: string): Report {
  const entries = readdirSync(providersDir, { withFileTypes: true });
  // `.mts` / `.cts` too: a `.ts`-only filter SKIPPED such a file outright, so a
  // provider written in one was invisible with `rc=0` (found in review). None
  // exists today, which is exactly why nothing would have noticed the first.
  const files = entries
    .filter((e) => e.isFile() && /\.(?:ts|mts|cts)$/.test(e.name) && !e.name.endsWith('.d.ts'))
    .map((e) => e.name)
    .sort();
  const classes: ProviderClass[] = [];
  const refusals: Refusal[] = [];
  // The scan is deliberately NOT recursive, so a provider added under a
  // subdirectory would be invisible and the run would exit 0 (found in review).
  // Refusing the subdirectory makes that fail CLOSED: either flatten the file
  // back, or teach this checker to walk.
  for (const entry of entries.filter((e) => e.isDirectory())) {
    refusals.push({
      file: `${entry.name}/`,
      name: '<directory>',
      reason:
        'the provider scan is not recursive, so every provider under this subdirectory would be invisible',
    });
  }
  for (const file of files) {
    const filePath = join(providersDir, file);
    const text = readFileSync(filePath, 'utf8');
    const parsed = analyzeSource(filePath, text, file);
    classes.push(...parsed.classes);
    refusals.push(...parsed.refusals);
  }
  classes.sort((a, b) => a.name.localeCompare(b.name));
  return {
    providersDir,
    files,
    classes,
    declaring: classes.filter((c) => c.verdict === 'declares').map((c) => c.name),
    omitting: classes.filter((c) => c.verdict === 'omits').map((c) => c.name),
    refusals,
  };
}

export interface Finding {
  readonly kind:
    | 'new-omitting'
    | 'newly-declaring'
    | 'stale-entry'
    | 'duplicate-name'
    | 'refusal'
    | 'floor';
  readonly message: string;
}

export function findViolations(report: Report, allowList: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const allowed = new Set(allowList);

  const seen = new Set<string>();
  for (const cls of report.classes) {
    if (seen.has(cls.name)) {
      findings.push({
        kind: 'duplicate-name',
        message: `provider class name \`${cls.name}\` is declared more than once (last in ${cls.file}); the allow-list is keyed by class name and cannot address either one`,
      });
    }
    seen.add(cls.name);
  }

  for (const refusal of report.refusals) {
    findings.push({
      kind: 'refusal',
      message: `${refusal.file}: \`${refusal.name}\` — ${refusal.reason}. This shape is not modelled; extend scripts/check-provider-update-context.ts rather than working around it.`,
    });
  }

  const newOmitting = report.omitting.filter((n) => !allowed.has(n));
  if (newOmitting.length > 0) {
    findings.push({
      kind: 'new-omitting',
      message: `${newOmitting.length} provider(s) drop \`update()\`'s \`context?: UpdateContext\` parameter and are not recorded as known: ${newOmitting.join(', ')}. Declare the parameter (and call assertRegionMatch ahead of every mutating step — issue #2613 remedy 2); only add the name to OMITS_UPDATE_CONTEXT in scripts/check-provider-update-context.ts if you deliberately cannot.`,
    });
  }

  const newlyDeclaring = report.declaring.filter((n) => allowed.has(n));
  if (newlyDeclaring.length > 0) {
    findings.push({
      kind: 'newly-declaring',
      message: `good news — ${newlyDeclaring.length} provider(s) now declare \`context?: UpdateContext\`: ${newlyDeclaring.join(', ')}. Delete them from OMITS_UPDATE_CONTEXT in scripts/check-provider-update-context.ts so the list keeps ratcheting.`,
    });
  }

  // Refused providers count as KNOWN. Measured in review: a provider refused
  // for an unmodelled 6th parameter also produced `[stale-entry] … no longer
  // exist … Remove or rename the entries`, and following that instruction
  // deletes a live worklist entry for a provider that is still right there.
  const known = new Set([
    ...report.classes.map((c) => c.name),
    ...report.refusals.map((r) => r.name),
  ]);
  const stale = allowList.filter((n) => !known.has(n));
  if (stale.length > 0) {
    findings.push({
      kind: 'stale-entry',
      message: `OMITS_UPDATE_CONTEXT names ${stale.length} provider(s) that no longer exist under ${report.providersDir}: ${stale.join(', ')}. Remove or rename the entries.`,
    });
  }

  if (report.files.length < FLOORS.files) {
    findings.push({
      kind: 'floor',
      message: `scanned ${report.files.length} files, floor is ${FLOORS.files} — the walker is not seeing the provider tree`,
    });
  }
  if (report.classes.length < FLOORS.providerClasses) {
    findings.push({
      kind: 'floor',
      message: `found ${report.classes.length} provider classes, floor is ${FLOORS.providerClasses} — the class detector is not seeing the providers`,
    });
  }
  if (report.declaring.length < FLOORS.declaring) {
    findings.push({
      kind: 'floor',
      message: `only ${report.declaring.length} providers classify as declaring, floor is ${FLOORS.declaring} — the parameter classifier has collapsed`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Self-probe: fixed sources with known verdicts, run BEFORE the real tree.
// A classifier that degrades toward "everything declares" leaves every count
// and every floor untouched; only these catch it.
// ---------------------------------------------------------------------------

const IMPORT_LINE = "import type { UpdateContext } from '../../types/resource.js';\n";

interface ProbeCase {
  readonly label: string;
  readonly source: string;
  /** Expected verdict, or `refused` when the shape must stop the check. */
  readonly expect: Verdict | 'refused' | 'ignored';
  /**
   * A substring the refusal REASON must carry. Without it every refusal arm is
   * indistinguishable to the corpus, so one arm degrading into another's
   * wording would leave the probe green (found in review). Required on every
   * `refused` case, asserted by the unit suite.
   */
  readonly expectReason?: string;
}

export const SELF_PROBE_CASES: readonly ProbeCase[] = [
  {
    label: 'five-parameter update — the defect this fence exists for',
    expect: 'omits',
    source: `export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'six-parameter update with UpdateContext',
    expect: 'declares',
    source: `${IMPORT_LINE}export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context?: UpdateContext): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'NON-async update declaring the context still counts',
    expect: 'declares',
    source: `${IMPORT_LINE}export class P implements ResourceProvider {
      create(a: string): Promise<void> {}
      update(a: string, b: string, c: string, d: object, e: object, context?: UpdateContext): Promise<void> {}
      delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'no `implements` clause — membership decides, not the keyword',
    expect: 'omits',
    source: `export class P {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'context typed `unknown` is not a declaration',
    expect: 'refused',
    expectReason: 'typed `unknown`',
    source: `export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context?: unknown): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'context typed with a DIFFERENT context type is not a declaration',
    expect: 'refused',
    expectReason: 'typed `DeleteContext`',
    source: `import type { DeleteContext } from '../../types/resource.js';
    export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context?: DeleteContext): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'UpdateContext imported from somewhere else is not the shared type',
    expect: 'refused',
    expectReason: 'is not `UpdateContext` imported from',
    source: `import type { UpdateContext } from './local-shim.js';
    export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context?: UpdateContext): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'an ALIASED import is refused rather than modelled',
    expect: 'refused',
    expectReason: 'typed `Ctx`',
    source: `import type { UpdateContext as Ctx } from '../../types/resource.js';
    export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context?: Ctx): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'a destructured 6th parameter is refused',
    expect: 'refused',
    expectReason: 'destructured or a rest element',
    source: `${IMPORT_LINE}export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, { expectedRegion }: UpdateContext): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'a 7th parameter is refused',
    expect: 'refused',
    expectReason: 'at most 6 are modelled',
    source: `${IMPORT_LINE}export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context: UpdateContext, extra: string): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'a class missing `update` while implementing the interface is refused',
    expect: 'refused',
    expectReason: 'while implementing ResourceProvider',
    source: `export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'a helper class with none of the three members is ignored',
    expect: 'ignored',
    source: `export class Helper {
      toKey(a: string): string { return a; }
    }`,
  },
  {
    // Review PROVED this one: a rest element's NAME is an identifier, so the
    // binding-shape test alone let it through as a declaration while the
    // runtime `update.length` saw five.
    label: 'a REST 6th parameter is refused, not read as a declaration',
    expect: 'refused',
    expectReason: 'destructured or a rest element',
    source: `${IMPORT_LINE}export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, ...context: UpdateContext[]): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    // Review PROVED this one: `ts.isClassDeclaration` is false for a class
    // EXPRESSION, so such a provider left the population in silence.
    label: 'a class EXPRESSION assigned to a binding is classified, not skipped',
    expect: 'omits',
    source: `export const SneakyProvider = class {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object): Promise<void> {}
      async delete(a: string): Promise<void> {}
    };`,
  },
  {
    // Review PROVED this one: the old refusal needed two of the three members,
    // so a class declaring ONLY `update` was neither classified nor refused.
    label: 'a class declaring ONLY update is refused, not silently dropped',
    expect: 'refused',
    expectReason: 'declares 1 of create/update/delete',
    source: `export class P {
      async update(a: string, b: string, c: string, d: object, e: object): Promise<void> {}
    }`,
  },
  {
    // Review PROVED this one: an unanchored suffix accepted a sibling module.
    label: 'UpdateContext from a `mytypes/resource.js` sibling is not the shared type',
    expect: 'refused',
    expectReason: 'is not `UpdateContext` imported from',
    source: `import type { UpdateContext } from '../../mytypes/resource.js';
    export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context?: UpdateContext): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'an update() with fewer than five parameters is refused',
    expect: 'refused',
    expectReason: 'ResourceProvider.update takes 5',
    source: `export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'a 6th parameter with NO type annotation is refused',
    expect: 'refused',
    expectReason: 'no type annotation',
    source: `export class P implements ResourceProvider {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'update as a function-EXPRESSION property is classified too',
    expect: 'omits',
    source: `export class P {
      create = async function (a: string): Promise<void> {};
      update = async function (a: string, b: string, c: string, d: object, e: object): Promise<void> {};
      delete = async function (a: string): Promise<void> {};
    }`,
  },
  {
    // Review PROVED this one: `memberSignature` returned `undefined` for a
    // property whose initializer is not a function, so the class was neither
    // classified nor refused and the run exited 0.
    label: 'update as a NON-function property is refused, not dropped',
    expect: 'refused',
    expectReason: 'initializer is not a function expression',
    source: `export class P {
      async create(a: string): Promise<void> {}
      update = makeUpdate();
      delete = makeDelete();
    }`,
  },
  {
    // Review PROVED this one: string-literal member names read as `undefined`,
    // dropping the class. They are now RESOLVED, so this classifies.
    label: 'STRING-LITERAL member names are resolved, not dropped',
    expect: 'omits',
    source: `export class P {
      async 'create'(a: string): Promise<void> {}
      async 'update'(a: string, b: string, c: string, d: object, e: object): Promise<void> {}
      async 'delete'(a: string): Promise<void> {}
    }`,
  },
  {
    // Same, for a computed name over a string literal.
    label: 'a COMPUTED member name over a string literal is resolved',
    expect: 'omits',
    source: `export class P {
      async create(a: string): Promise<void> {}
      async ['update'](a: string, b: string, c: string, d: object, e: object): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    // ...but an UNRESOLVABLE computed name on a plausible provider refuses.
    label: 'an unresolvable COMPUTED member name refuses a plausible provider',
    expect: 'refused',
    expectReason: 'computed name this checker cannot resolve',
    source: `const KEY = 'update';
    export class P {
      async create(a: string): Promise<void> {}
      async [KEY](a: string, b: string, c: string, d: object, e: object): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    // Review PROVED this one: a `static update` was credited as the INSTANCE
    // verdict, because modifiers were ignored.
    label: 'a STATIC update is not credited as the instance member',
    expect: 'refused',
    expectReason: 'is not the instance member',
    source: `${IMPORT_LINE}export class P {
      async create(a: string): Promise<void> {}
      static async update(a: string, b: string, c: string, d: object, e: object, context?: UpdateContext): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    // ...and a static one BESIDE a readable instance member is ordinary.
    label: 'a STATIC helper beside a real instance update is not refused',
    expect: 'omits',
    source: `export class P {
      async create(a: string): Promise<void> {}
      static async update(x: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    // TWO of the three, so the missing one is `update` itself — a provider
    // shape, not a coincidence. (One of the three plus `extends` is the
    // LruCache/WidgetFactory shape, controlled for below.)
    label: 'a SUBCLASS short of the triple is refused, since a base may supply it',
    expect: 'refused',
    expectReason: 'extends a base class',
    source: `export class P extends Base {
      async create(a: string): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  // --- Controls for the plausibility gate. Every one of these was REFUSED by
  // --- the previous split gate; each could never be a provider, and one of
  // --- them (the cache) made the shipped binary exit 1 on a real tree.
  {
    label: 'CONTROL: a static factory `create` on a helper class is ignored',
    expect: 'ignored',
    source: `export class Config { static create(raw: string): Config { return new Config(); } }`,
  },
  {
    label: 'CONTROL: a `get create()` accessor on a helper class is ignored',
    expect: 'ignored',
    source: `export class Shape {
      get create(): string { return 'x'; }
      set delete(v: boolean) {}
    }`,
  },
  {
    label: 'CONTROL: an options bag with `delete = true` is ignored',
    expect: 'ignored',
    source: `export class Opts { delete = true; create = { retries: 3 }; }`,
  },
  {
    label: 'CONTROL: `class LruCache extends Map` with a `delete` method is ignored',
    expect: 'ignored',
    source: `export class LruCache extends Map<string, string> {
      delete(k: string): boolean { return super.delete(k); }
    }`,
  },
  {
    label: 'CONTROL: a factory subclass declaring only `create` is ignored',
    expect: 'ignored',
    source: `export class WidgetFactory extends BaseFactory {
      create(a: string): void {}
    }`,
  },
  {
    // ...but the SAME incidental-looking shape becomes a candidate the moment
    // it names `update`, which is the member this check is about.
    label: 'a subclass naming `update` in an unreadable shape IS refused',
    expect: 'refused',
    expectReason: 'initializer is not a function expression',
    source: `export class P extends Base {
      update = makeUpdate();
    }`,
  },
  {
    // The calibration case: refusing this would refuse every error subclass.
    label: 'a subclass declaring NONE of the three is ignored, not refused',
    expect: 'ignored',
    source: `export class HostedZoneNameNotFoundError extends Error {
      constructor(message: string) { super(message); }
    }`,
  },
  {
    // Review PROVED this one: a default lowers `update.length` below the
    // declared arity, breaking the two-instrument equivalence.
    label: 'a DEFAULTED update parameter is refused',
    expect: 'refused',
    expectReason: 'has a default value',
    source: `${IMPORT_LINE}export class P {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context: UpdateContext = {} as UpdateContext): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'a union with null still declares',
    expect: 'declares',
    source: `${IMPORT_LINE}export class P {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context: UpdateContext | null): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
  {
    label: 'update as an arrow-function PROPERTY is classified, not skipped',
    expect: 'omits',
    source: `export class P {
      create = async (a: string): Promise<void> => {};
      update = async (a: string, b: string, c: string, d: object, e: object): Promise<void> => {};
      delete = async (a: string): Promise<void> => {};
    }`,
  },
  {
    // Deliberately carries NO class, so the only thing that can make this
    // `refused` rather than `ignored` is the parse-diagnostic arm itself.
    label: 'a file that does not PARSE is refused, not silently classless',
    expect: 'refused',
    expectReason: 'parse diagnostic(s)',
    source: 'export const broken = ((( ;',
  },
  {
    label: 'a union with undefined still declares',
    expect: 'declares',
    source: `${IMPORT_LINE}export class P {
      async create(a: string): Promise<void> {}
      async update(a: string, b: string, c: string, d: object, e: object, context?: UpdateContext | undefined): Promise<void> {}
      async delete(a: string): Promise<void> {}
    }`,
  },
];

export interface SelfProbeFailure {
  readonly label: string;
  readonly expected: string;
  readonly actual: string;
}

export function runSelfProbes(providersDir: string): SelfProbeFailure[] {
  const failures: SelfProbeFailure[] = [];
  // Test seam. The unit suite calls `runSelfProbes` directly, so `main()`
  // silently dropping the call would be unobservable from outside; this makes
  // the SPAWNED binary prove it still consults the probe.
  if (process.env.CDKD_SELF_PROBE_FORCE_FAIL === '1') {
    failures.push({ label: 'forced by CDKD_SELF_PROBE_FORCE_FAIL', expected: 'n/a', actual: 'n/a' });
  }
  for (const probe of SELF_PROBE_CASES) {
    const parsed = analyzeSource(join(providersDir, '__self-probe.ts'), probe.source, '__probe');
    let actual: string;
    if (parsed.refusals.length > 0) actual = 'refused';
    else if (parsed.classes.length === 0) actual = 'ignored';
    else actual = parsed.classes[0].verdict;
    if (actual !== probe.expect) {
      failures.push({ label: probe.label, expected: probe.expect, actual });
      continue;
    }
    // A verdict of `refused` alone cannot tell the refusal ARMS apart, so one
    // arm degrading into another's wording would leave every probe green
    // (found in review). Each refusal case names a substring of ITS arm.
    if (probe.expectReason !== undefined) {
      const reasons = parsed.refusals.map((r) => r.reason).join(' | ');
      if (!reasons.includes(probe.expectReason)) {
        failures.push({
          label: probe.label,
          expected: `refused with a reason containing "${probe.expectReason}"`,
          actual: `refused with: ${reasons}`,
        });
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): { providersDir: string; json: boolean } {
  let providersDir = DEFAULT_PROVIDERS_DIR;
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--providers-dir=')) {
      const value = arg.slice('--providers-dir='.length);
      if (value === '') throw new Error('--providers-dir= requires a value');
      providersDir = resolve(value);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { providersDir, json };
}

function main(argv: readonly string[]): number {
  const { providersDir, json } = parseArgs(argv);

  const probeFailures = runSelfProbes(providersDir);
  if (probeFailures.length > 0) {
    for (const f of probeFailures) {
      process.stderr.write(
        `self-probe FAILED: ${f.label} — expected ${f.expected}, got ${f.actual}\n`
      );
    }
    process.stderr.write('the classifier is broken; the real-tree result below is meaningless\n');
    return 1;
  }

  const report = buildReport(providersDir);
  const findings = findViolations(report, OMITS_UPDATE_CONTEXT);

  if (json) {
    process.stdout.write(`${JSON.stringify({ report, findings }, undefined, 2)}\n`);
  } else {
    process.stdout.write(
      `${report.files.length} files, ${report.classes.length} provider classes: ` +
        `${report.declaring.length} declare update()'s UpdateContext parameter, ` +
        `${report.omitting.length} do not.\n`
    );
    if (report.omitting.length > 0) {
      process.stdout.write(`\nWithout the parameter (issue #2613 remedy 2 worklist):\n`);
      for (const name of report.omitting) process.stdout.write(`  ${name}\n`);
    }
  }

  for (const finding of findings) {
    process.stderr.write(`[${finding.kind}] ${finding.message}\n`);
  }
  return findings.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    // Covers a bad argument AND anything `buildReport` throws (an unreadable
    // providers root, a permissions error). Both are usage-or-environment
    // failures rather than findings, which is why they exit 2 rather than 1 —
    // and exiting non-zero is what matters most: neither may read as a pass.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
