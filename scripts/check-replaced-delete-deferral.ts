/**
 * CI critic: a replaced resource's OLD copy is deleted only in the deploy's
 * cleanup phase, or at a site on the reviewed exception list (issue #6713).
 *
 * THE CLASS THIS KEEPS CLOSED
 * ---------------------------
 * CloudFormation deletes a replaced resource only after every other change of
 * the stack update succeeded. cdkd does the same through one place: a
 * create-first replacement's delete is queued on `run.deferredReplacedDeletes`
 * (`deferToCleanupPhase` in `deploy-engine/replacement/delete-replaced.ts`)
 * and sent by `retryDeferredReplacedDeletes`
 * (`deploy-engine/replacement/deferred-deletes.ts`) once the DAG finished; a
 * failed deploy never sends it, so its rollback finds the old resource whole.
 * Each time a path deleted the old copy earlier (#6374 a schedule group taking
 * its schedules, #6712 a topic taking its subscriptions), a failed deploy's
 * rollback re-created it from its recorded properties only. A new early delete
 * compiles, passes its tests and reads like the rest of the engine, so this
 * check makes every one of them a reviewed decision.
 *
 * WHAT COUNTS AS DELETING A REPLACED RESOURCE'S OLD COPY DURING A DEPLOY
 * ----------------------------------------------------------------------
 * Five structural shapes (TypeScript AST, offline, O(files)). Each found site
 * must match an {@link EXCEPTIONS} entry by shape + key with the exact count;
 * an entry whose site is gone is stale. Both fail.
 *
 *   - provider-delete-call — a `ResourceProvider.delete` call in the deploy
 *     code: a member call `<x>.delete(a, b, c, ...)` with at least three
 *     arguments (the provider signature is logicalId, physicalId,
 *     resourceType, ...; `Map` / `Set` `.delete` take one), anywhere under
 *     `src/deployment/**` except the rollback replays
 *     (`rollback-executor/**`, `deploy-engine/rollback/**`). Keyed by file +
 *     enclosing named function. A template DELETE of a REMOVED resource is a
 *     site too, listed as `not-a-replacement`, so a new delete in this code
 *     is classified by a reviewer rather than by its file name.
 *   - deferral-exit — every way the deferral gate lets
 *     `deleteReplacedAfterCreate` fall through to its inline delete: each
 *     operand of the `&&` chain guarding the `deferToCleanupPhase(...)` call,
 *     and each `return` of `deferToCleanupPhase` that is not the literal
 *     `true`; also each exit of the recording it relies on
 *     ({@link RECORDABILITY_FUNCTIONS}: a record not written makes its final
 *     `return` answer false, the #6374 shape). Keyed by the operand, or the
 *     guarding `if` condition, one per `||` operand (comments stripped,
 *     whitespace collapsed).
 *   - gate-argument — a gate operand that is a negated PARAMETER of
 *     `deleteReplacedAfterCreate` (`!isRetry`) is decided by its callers, so
 *     every call passing that parameter anything but nothing or the literal
 *     `false` is a site, anywhere under `src/`. Keyed by file + enclosing
 *     function + parameter.
 *   - provider-replace-in-update — an SDK provider whose `update()` replaces
 *     the resource (a site of `scripts/gen-provider-replace-branches.ts`,
 *     #6656: a `wasReplaced` answer or its own create path) for a change the
 *     deploy hands to `update()` rather than replacing through the engine: a
 *     trigger the diff answers `provider-marked`, `exempt` or `gap`, or a
 *     site that walk could not settle. The engine replaces first (and defers
 *     the delete) for a trigger that is a replacement or conditional in the
 *     diff, so those branches run only from a rollback or revert replay.
 *     Keyed by type + file + function, counted over its reached rows.
 *   - provider-own-delete — a `this.delete(...)` under `src/provisioning/**`
 *     outside a `delete` member and outside the function of every replace
 *     branch the shape above counts as reached: a provider deleting its own
 *     resource from another path, or from a branch a deploy is assumed not to
 *     reach (each such one is listed with why) (a
 *     delete-then-recreate that reports neither `wasReplaced` nor its own
 *     create escapes the shape above, and lands here).
 *
 * NOT IN THE CLASS (by definition, not by exception)
 * --------------------------------------------------
 * The rollback replays (they reverse a failed deploy; `early-deleted-old.ts`
 * names what they cannot restore), `cdkd destroy`, and a provider's internal
 * sub-object deletes (tags, rules, attachments) sent as SDK commands: those
 * change a resource that stays, they do not delete one that was replaced.
 *
 * EXCEPTIONS
 * ----------
 * An `early-delete` entry is the reviewed list the issue asks for: each names
 * why the delete cannot wait for the cleanup phase and how a failed deploy's
 * rollback reports the loss (`earlyDeletedOld` in
 * `src/deployment/rollback-executor/early-deleted-old.ts`, #6728: the rollback
 * output and the `cdkd rollback` plan say the re-created resource gets back
 * only its recorded properties), or that nothing is lost. The other kinds
 * classify a site that is not an early delete, with the reason.
 *
 * BOUNDS
 * ------
 * A provider delete reached through an alias (`provider.delete.bind(...)`,
 * a destructured method) or a spread (`provider.delete(...args)`), another
 * provider's `.delete(...)` called from a provider's `update()` (a delegate)
 * outside `src/deployment/**`, or an SDK `Delete*Command` sent for the primary
 * resource from `update()` with no replace signal is out of reach; so is a
 * caller-decided gate parameter handed through a local wrapper (the
 * `send(isRetry)` of `cleanup-old-id.ts` is listed as one site).
 *
 * Usage:
 *   node --experimental-strip-types scripts/check-replaced-delete-deferral.ts
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// `typescript-v6` is an npm alias of typescript@6 (see gen-property-coverage.ts).
import ts from 'typescript-v6';
import { loadReport, type SiteRow } from './gen-provider-replace-branches.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export type Shape =
  | 'provider-delete-call'
  | 'deferral-exit'
  | 'gate-argument'
  | 'provider-replace-in-update'
  | 'provider-own-delete';

export const SHAPES: readonly Shape[] = [
  'provider-delete-call',
  'deferral-exit',
  'gate-argument',
  'provider-replace-in-update',
  'provider-own-delete',
];

export interface Site {
  readonly shape: Shape;
  readonly key: string;
  /** `file:line`, for the failure message. */
  readonly at: string;
}

interface ExceptionBase {
  readonly shape: Shape;
  readonly key: string;
  /** How many sites the key covers; a change either way fails. */
  readonly count: number;
}

/** A site that deletes a replaced resource's old copy before the deploy succeeds. */
export interface EarlyDeleteException extends ExceptionBase {
  readonly kind: 'early-delete';
  /** Why it cannot wait for the cleanup phase. */
  readonly cannotDefer: string;
  /** How a failed deploy's rollback reports the loss, or why nothing is lost. */
  readonly rollbackReports: string;
}

/** A site that is not an early delete, and why. */
export interface ClassifiedSite extends ExceptionBase {
  readonly kind:
    | 'cleanup-phase' // the place: the deferral, or a delete only it reaches
    | 'not-a-replacement' // a removed resource's delete
    | 'outside-a-deploy' // no cleanup phase to wait for
    | 'caller-decided'; // a gate operand its callers decide (gate-argument sites)
  readonly reason: string;
}

export type Exception = EarlyDeleteException | ClassifiedSite;

const ROLLBACK_LOSS_DURING_DEPLOY =
  "the reversal re-creates it, and `earlyDeletedOld` answers 'during-deploy': the rollback output and the `cdkd rollback` plan say it gets back only its recorded properties (#6728)";
const ROLLBACK_LOSS_BEFORE_CREATE =
  "journals `oldDeletedBeforeCreate`, so `earlyDeletedOld` answers 'before-create': the rollback output and the `cdkd rollback` plan say the re-created resource gets back only its recorded properties (#6728)";

const DELETE_REPLACED = 'src/deployment/deploy-engine/replacement/delete-replaced.ts';
const GATE_FUNCTION = 'deleteReplacedAfterCreate';
const DEFERRAL_FUNCTION = 'deferToCleanupPhase';

/**
 * The reviewed list. Rows marked `inventory #N` are the rows of the #6713
 * inventory comment; the others were found by this scan.
 */
export const EXCEPTIONS: readonly Exception[] = [
  // --- provider-delete-call ------------------------------------------------
  {
    shape: 'provider-delete-call',
    key: `${DELETE_REPLACED}:${GATE_FUNCTION}`,
    count: 1,
    kind: 'cleanup-phase',
    reason:
      'the delete the deferral sends; reached inline only through the deferral-exit rows below',
  },
  {
    shape: 'provider-delete-call',
    key: 'src/deployment/superseded-resources.ts:deleteSupersededEntry',
    count: 1,
    kind: 'cleanup-phase',
    reason:
      "an earlier deploy's recorded superseded resource, retried at this deploy's cleanup (superseded-retry.ts) or by `cdkd destroy`",
  },
  {
    shape: 'provider-delete-call',
    key: 'src/deployment/deploy-engine/delete.ts:provisionDelete',
    count: 1,
    kind: 'not-a-replacement',
    reason: 'the template DELETE of a resource the template no longer declares',
  },
  {
    // inventory #5
    shape: 'provider-delete-call',
    key: 'src/deployment/deploy-engine/replacement/delete-first.ts:replaceDeleteFirstAndRecreate',
    count: 1,
    kind: 'early-delete',
    cannotDefer:
      "opt-in `--replace`: a custom-named resource whose create-first collided on its name, or whose name-idempotent create handed back the old copy; only the old copy can release the name, and the user asked for delete-first. Also every replacement of a `replacesDeleteFirst` type (a gateway attachment, a subnet route table association, #6958): AWS refuses the new link while the old one holds it, and CloudFormation deletes it first too",
    rollbackReports: ROLLBACK_LOSS_BEFORE_CREATE,
  },
  {
    // inventory #5 (a child stored inside the re-created parent goes with it, #4411)
    shape: 'provider-delete-call',
    key: 'src/deployment/deploy-engine/update-replace/recreate.ts:recreateDestroyThenCreate',
    count: 1,
    kind: 'early-delete',
    cannotDefer:
      'opt-in `--recreate-via-cc-api` / `--recreate-via-sdk-provider`: the user asked to destroy the resource and create it again',
    rollbackReports: ROLLBACK_LOSS_BEFORE_CREATE,
  },
  {
    // inventory #4
    shape: 'provider-delete-call',
    key: 'src/deployment/deploy-engine/update-in-place/replace-fallback.ts:replaceFallbackFor',
    count: 1,
    kind: 'early-delete',
    cannotDefer:
      'AWS or Cloud Control refused an UPDATE as unsupported on a type whose name cannot change: only the old copy can hold the name, so it goes first (a `STATEFUL_TYPES` type also needs `--force-stateful-recreation`)',
    rollbackReports: ROLLBACK_LOSS_BEFORE_CREATE,
  },
  // --- deferral-exit -------------------------------------------------------
  {
    shape: 'deferral-exit',
    key: `${DELETE_REPLACED}:${GATE_FUNCTION}: !isRetry`,
    count: 1,
    kind: 'caller-decided',
    reason: 'the cleanup pass re-entering the delete it deferred (gate-argument rows)',
  },
  {
    // inventory #2
    shape: 'deferral-exit',
    key: `${DELETE_REPLACED}:${GATE_FUNCTION}: !newHoldsOldIdAndType`,
    count: 1,
    kind: 'caller-decided',
    reason: 'a new resource holding the old id and type (gate-argument rows)',
  },
  {
    shape: 'deferral-exit',
    key: `${DELETE_REPLACED}:${DEFERRAL_FUNCTION}: run.deferredReplacedDeletes === undefined`,
    count: 1,
    kind: 'outside-a-deploy',
    reason:
      "the map exists only while `executeDeployment` runs the DAG (execute.ts) and is cleared as the cleanup phase starts: a call without it has no cleanup phase to wait for",
  },
  {
    shape: 'deferral-exit',
    key:
      `${DELETE_REPLACED}:${DEFERRAL_FUNCTION}: updateReplacePolicy === 'Snapshot' && ` +
      'deps.options.skipFinalSnapshot !== true && ' +
      '!ATOMIC_FINAL_SNAPSHOT_TYPES.has(oldResource.resourceType) && ' +
      '!owesPreDeleteSnapshot(oldResource.resourceType, context.finalSnapshotIdentifier)',
    count: 1,
    kind: 'early-delete',
    cannotDefer:
      '`UpdateReplacePolicy: Snapshot` whose final snapshot a caller already took (no owed mark): a later delete would let writes reach the old copy after its snapshot. No deploy caller reaches it today (both create-first callers hand over the owed mark, `prepareCreateFirstFinalSnapshot`); listed so a caller that does is reviewed',
    rollbackReports: `${ROLLBACK_LOSS_DURING_DEPLOY}; the data is in the final snapshot`,
  },
  {
    // inventory #1
    shape: 'deferral-exit',
    key: `${DELETE_REPLACED}:${DEFERRAL_FUNCTION}: isInlinePolicyType(oldResource.resourceType)`,
    count: 1,
    kind: 'early-delete',
    cannotDefer:
      'an IAM inline policy (#6445, maintainer decision): both policies attached until the cleanup phase would grant the union of their permissions',
    rollbackReports:
      'nothing lost: the journal re-creates the policy document whole, so `earlyDeletedOld` exempts the type',
  },
  {
    shape: 'deferral-exit',
    key: `${DELETE_REPLACED}:${DEFERRAL_FUNCTION}: return deleteNeedsThisRunsNoEchoValues(oldResource, context.noEchoDeleteValues)`,
    count: 1,
    kind: 'outside-a-deploy',
    reason:
      'false only when the old record was not recorded as superseded and its delete reads no NoEcho value: with the map set, `supersededHost` is set too (execute.ts), an inline policy returned above and a held id returned true, so only a caller without a deploy reaches it',
  },
  // The recording `deferToCleanupPhase` relies on: when it records nothing,
  // that function's final `return` answers false and the delete runs inline.
  {
    shape: 'deferral-exit',
    key: `${DELETE_REPLACED}:recordSupersededForDeferral: host === undefined`,
    count: 1,
    kind: 'outside-a-deploy',
    reason: '`executeDeployment` sets `supersededHost` together with the deferral map (execute.ts)',
  },
  {
    shape: 'deferral-exit',
    key:
      `${DELETE_REPLACED}:recordSupersededForDeferral: !canRecordSuperseded(oldResource, { ` +
      'noEchoDeleteValues: context.noEchoDeleteValues, inlinePolicyClaimed: context.inlinePolicyClaimed, ' +
      'persistedRecord: true, })',
    count: 1,
    kind: 'caller-decided',
    reason: 'decided by the `canRecordSuperseded` exits listed below',
  },
  {
    shape: 'deferral-exit',
    key: `${DELETE_REPLACED}:recordSupersededForDeferral: oldIdHeldByAnotherRecord(deps, logicalId, oldResource)`,
    count: 1,
    kind: 'cleanup-phase',
    reason:
      '`deferToCleanupPhase` already returned true for a held id (#6712): the delete waits in memory only',
  },
  {
    shape: 'deferral-exit',
    key: 'src/deployment/superseded-resources.ts:canRecordSuperseded: deleteNeedsThisRunsNoEchoValues(record, deleteContext.noEchoDeleteValues)',
    count: 1,
    kind: 'cleanup-phase',
    reason:
      "`deferToCleanupPhase`'s final return answers true for the same predicate: the delete waits in memory only (#6445)",
  },
  {
    shape: 'deferral-exit',
    key:
      'src/deployment/superseded-resources.ts:canRecordSuperseded: deleteContext.persistedRecord !== true && ' +
      'Array.isArray(record.noEchoLeaves) && record.noEchoLeaves.length > 0',
    count: 1,
    kind: 'outside-a-deploy',
    reason: "the deferral's recording passes `persistedRecord: true` (recordSupersededForDeferral)",
  },
  {
    shape: 'deferral-exit',
    key: 'src/deployment/superseded-resources.ts:canRecordSuperseded: deleteContext.inlinePolicyClaimed !== undefined',
    count: 1,
    kind: 'cleanup-phase',
    reason:
      "only the failed-first-attempt recording passes a claim (`deferToCleanupPhase` passes undefined): that delete was already sent and failed, and its entry is queued for the cleanup-phase retry",
  },
  {
    shape: 'deferral-exit',
    key: 'src/deployment/superseded-resources.ts:canRecordSuperseded: return !INLINE_POLICY_TYPES.has(record.resourceType)',
    count: 1,
    kind: 'caller-decided',
    reason:
      "false only for an IAM inline policy, which `deferToCleanupPhase` deletes inline before recording (its `isInlinePolicyType` row)",
  },
  // --- gate-argument -------------------------------------------------------
  {
    shape: 'gate-argument',
    key: `${DELETE_REPLACED}:${GATE_FUNCTION}:isRetry`,
    count: 2,
    kind: 'cleanup-phase',
    reason:
      "the `retry` closures of the two deferred entries (cleanup phase and failed-first-attempt), which only `retryDeferredReplacedDeletes` runs",
  },
  {
    shape: 'gate-argument',
    key: 'src/deployment/deploy-engine/replacement/cleanup-old-id.ts:deleteOldIdAfterDeploy:isRetry',
    count: 1,
    kind: 'cleanup-phase',
    reason:
      "`send(true)` only from the deferred entry's `retry`; `send(false)` only when no deferral map exists",
  },
  {
    // inventory #2
    shape: 'gate-argument',
    key: 'src/deployment/deploy-engine/replacement/create-first.ts:createFirstThenDeleteOld:newHoldsOldIdAndType',
    count: 1,
    kind: 'early-delete',
    cannotDefer:
      "the new resource has the old one's physical id AND type (a Glue table moved to another database keeps its id): a deferred delete, or the rollback's survivor read, would address the new resource",
    rollbackReports: ROLLBACK_LOSS_DURING_DEPLOY,
  },
  {
    // inventory #2
    shape: 'gate-argument',
    key: 'src/deployment/deploy-engine/update-replace/create-first.ts:replaceCreateFirst:newHoldsOldIdAndType',
    count: 1,
    kind: 'early-delete',
    cannotDefer:
      "the new resource has the old one's physical id AND type: a deferred delete, or the rollback's survivor read, would address the new resource",
    rollbackReports: ROLLBACK_LOSS_DURING_DEPLOY,
  },
  // --- provider-replace-in-update -----------------------------------------
  {
    // inventory #3
    shape: 'provider-replace-in-update',
    key: 'AWS::SNS::Subscription src/provisioning/providers/sns-subscription-provider.ts:replace',
    count: 2,
    kind: 'early-delete',
    cannotDefer:
      'SNS keys a subscription on (topic, protocol, endpoint) and `Subscribe` on a live one returns the existing ARN, so a create-first would hand back the old subscription',
    rollbackReports: `${ROLLBACK_LOSS_DURING_DEPLOY}; messages published between the delete and the create are not delivered`,
  },
  {
    shape: 'provider-replace-in-update',
    key: 'AWS::Route53::RecordSet src/provisioning/providers/route53/record-set.ts:updateRecordSet',
    count: 1,
    kind: 'early-delete',
    cannotDefer:
      'Route 53 keys a record on its name, type and set identifier: the provider swaps the old record for the new one in ONE atomic change batch, so the two never coexist and the name never stops resolving',
    rollbackReports:
      "nothing lost: a record set holds nothing beyond its recorded properties. A Name or Type change gets a new id, so the reversal re-creates it and `earlyDeletedOld` answers 'during-deploy' (#6728); a SetIdentifier-only change keeps the id and is reverted in place",
  },
  {
    shape: 'provider-replace-in-update',
    key: 'AWS::EC2::SecurityGroupIngress src/provisioning/providers/ec2/sg-ingress-update.ts:updateSecurityGroupIngress',
    count: 2,
    kind: 'early-delete',
    cannotDefer:
      'a `Description` change revokes and re-authorizes the rule only when AWS no longer has it or the recorded description is redacted (#6514); EC2 keys a rule on its whole tuple, so the new one cannot be added while the old is present',
    rollbackReports:
      'nothing lost: the rule keeps its composite id (group|protocol|ports), so the rollback reverts it in place to its recorded properties, and a rule holds nothing beyond them',
  },
  // --- provider-own-delete -------------------------------------------------
  ...(
    [
      ['acm-certificate/update.ts', 'AWS::CertificateManager::Certificate'],
      ['iam-managed-policy/update.ts', 'AWS::IAM::ManagedPolicy'],
      ['iam-role/update.ts', 'AWS::IAM::Role'],
    ] as const
  ).map(
    ([path, type]): Exception => ({
      shape: 'provider-own-delete',
      key: `src/provisioning/providers/${path}:update`,
      count: 1,
      kind: 'outside-a-deploy',
      reason: `the ${type} replace branch runs only for a change the diff answers as a replacement (provider-replace-branches), which the engine carries out create-first with the delete deferred; only a rollback or revert replay reaches it`,
    })
  ),
  {
    shape: 'provider-delete-call',
    key: 'src/deployment/deploy-engine/update-replace/create-first.ts:retireCreatedAnother',
    count: 1,
    kind: 'not-a-replacement',
    reason:
      'deletes what a refused create-first attempt just made, proven new by its AWS-minted id (go-to-k/cdkd#7084), not a replaced old copy',
  },
  {
    shape: 'provider-own-delete',
    key: 'src/provisioning/cloud-control/create.ts:cleanupFailedCreateRemnant',
    count: 1,
    kind: 'not-a-replacement',
    reason: 'deletes the resource a failed create just made, not a replaced one',
  },
  {
    shape: 'provider-own-delete',
    key: 'src/provisioning/providers/lambda-web-function-revision-provider.ts:create',
    count: 1,
    kind: 'not-a-replacement',
    reason: 'deletes the revision a failed create just made (#4945), not a replaced one',
  },
];

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

const printer = ts.createPrinter({ removeComments: true });

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** An expression's text with comments stripped and whitespace collapsed. */
export function normalized(node: ts.Node, source: ts.SourceFile): string {
  return printer
    .printNode(ts.EmitHint.Unspecified, node, source)
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim();
}

function nameOf(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node)) &&
    node.name !== undefined
  ) {
    return node.name.getText();
  }
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.name.getText();
  }
  return undefined;
}

/**
 * The nearest NAMED function holding `node`: a function or method
 * declaration, or a module-level `const x = () => ...`. A local arrow (a
 * `sendDelete` closure) is part of the function it sits in.
 */
export function enclosingFunction(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    const name = nameOf(at);
    if (name !== undefined) return name;
    if (
      (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
      ts.isVariableDeclaration(at.parent) &&
      ts.isIdentifier(at.parent.name) &&
      ts.isVariableDeclarationList(at.parent.parent) &&
      ts.isVariableStatement(at.parent.parent.parent) &&
      ts.isSourceFile(at.parent.parent.parent.parent)
    ) {
      return at.parent.name.text;
    }
  }
  return '<module>';
}

function lineOf(node: ts.Node, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function findFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  walk(source, (n) => {
    if (found === undefined && ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
  });
  return found;
}

function unwrapParens(node: ts.Expression): ts.Expression {
  let at = node;
  while (ts.isParenthesizedExpression(at)) at = at.expression;
  return at;
}

function andOperands(node: ts.Expression): ts.Expression[] {
  const at = unwrapParens(node);
  if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...andOperands(at.left), ...andOperands(at.right)];
  }
  return [at];
}

function callsNamed(node: ts.Node, name: string): boolean {
  let hit = false;
  walk(node, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) hit = true;
  });
  return hit;
}

// ---------------------------------------------------------------------------
// The engine shapes
// ---------------------------------------------------------------------------

/** `src/deployment/**` paths outside the population: the rollback replays. */
export function isEngineScanned(file: string): boolean {
  return (
    file.startsWith('src/deployment/') &&
    !file.startsWith('src/deployment/rollback-executor/') &&
    !file.startsWith('src/deployment/deploy-engine/rollback/')
  );
}

/** provider-delete-call sites of one file. */
export function scanProviderDeleteCalls(file: string, text: string): Site[] {
  const source = parse(file, text);
  const sites: Site[] = [];
  walk(source, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'delete' &&
      n.arguments.length >= 3
    ) {
      sites.push({
        shape: 'provider-delete-call',
        key: `${file}:${enclosingFunction(n)}`,
        at: `${file}:${lineOf(n, source)}`,
      });
    }
  });
  return sites;
}

export interface GateScan {
  readonly sites: Site[];
  /** The gate's caller-decided parameters, by argument index. */
  readonly callerParams: ReadonlyMap<string, number>;
}

/**
 * deferral-exit sites of the gate file. Throws when the gate or the deferral
 * function cannot be found: the check would otherwise pass having read
 * nothing.
 */
export function scanDeferralGate(file: string, text: string): GateScan {
  const source = parse(file, text);
  const gate = findFunction(source, GATE_FUNCTION);
  if (gate?.body === undefined) {
    throw new Error(`${file}: no function ${GATE_FUNCTION}: the deferral gate moved; update this check`);
  }
  const deferral = findFunction(source, DEFERRAL_FUNCTION);
  if (deferral?.body === undefined) {
    throw new Error(`${file}: no function ${DEFERRAL_FUNCTION}: the deferral moved; update this check`);
  }
  const sites: Site[] = [];
  const callerParams = new Map<string, number>();
  const params = gate.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
  let gates = 0;
  walk(gate.body, (n) => {
    if (!ts.isIfStatement(n) || !callsNamed(n.expression, DEFERRAL_FUNCTION)) return;
    gates++;
    for (const operand of andOperands(n.expression)) {
      if (ts.isCallExpression(operand) && ts.isIdentifier(operand.expression) && operand.expression.text === DEFERRAL_FUNCTION) {
        continue;
      }
      if (
        ts.isPrefixUnaryExpression(operand) &&
        operand.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isIdentifier(operand.operand) &&
        params.includes(operand.operand.text)
      ) {
        callerParams.set(operand.operand.text, params.indexOf(operand.operand.text));
      }
      sites.push({
        shape: 'deferral-exit',
        key: `${file}:${GATE_FUNCTION}: ${normalized(operand, source)}`,
        at: `${file}:${lineOf(operand, source)}`,
      });
    }
  });
  if (gates !== 1) {
    throw new Error(
      `${file}: ${GATE_FUNCTION} has ${gates} \`if\` guarding ${DEFERRAL_FUNCTION}(...), expected 1: update this check`
    );
  }
  sites.push(...exitsOf(file, source, deferral, DEFERRAL_FUNCTION));
  return { sites, callerParams };
}

/**
 * The `deferral-exit` sites of one function: every `return` that is not the
 * literal `true`. A `return false` / bare `return` that is the then-arm of an
 * `if` is keyed by its condition, one site per `||` operand; any other return
 * by its expression.
 */
function exitsOf(file: string, source: ts.SourceFile, fn: ts.FunctionDeclaration, name: string): Site[] {
  const sites: Site[] = [];
  const push = (label: string, node: ts.Node): void => {
    sites.push({ shape: 'deferral-exit', key: `${file}:${name}: ${label}`, at: `${file}:${lineOf(node, source)}` });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return; // a nested function's returns are its own
    if (ts.isReturnStatement(n)) {
      const value = n.expression;
      if (value === undefined || value.kind !== ts.SyntaxKind.TrueKeyword) {
        const guard =
          value === undefined || value.kind === ts.SyntaxKind.FalseKeyword ? enclosingIfCondition(n) : undefined;
        if (guard !== undefined) {
          for (const operand of orOperands(guard)) push(normalized(operand, source), operand);
        } else {
          push(`return ${value === undefined ? '' : normalized(value, source)}`.trim(), n);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body !== undefined) ts.forEachChild(fn.body, visit);
  return sites;
}

function orOperands(node: ts.Expression): ts.Expression[] {
  const at = unwrapParens(node);
  if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [...orOperands(at.left), ...orOperands(at.right)];
  }
  return [at];
}

/**
 * The functions whose exits decide whether `deferToCleanupPhase` records the
 * old resource (and so defers it) or falls through to its final `return`,
 * which deletes inline when it answers false. Each exit is a `deferral-exit`.
 */
export const RECORDABILITY_FUNCTIONS: readonly { file: string; name: string }[] = [
  { file: DELETE_REPLACED, name: 'recordSupersededForDeferral' },
  { file: 'src/deployment/superseded-resources.ts', name: 'canRecordSuperseded' },
];

/**
 * The inline-policy exception covers exactly these types (#6445). A type
 * added to `INLINE_POLICY_TYPES` would delete inline through that listed
 * exit, so the set is pinned here.
 */
export const INLINE_POLICY_TYPES_REVIEWED: readonly string[] = [
  'AWS::IAM::GroupPolicy',
  'AWS::IAM::Policy',
  'AWS::IAM::RolePolicy',
  'AWS::IAM::UserPolicy',
];

/** The string literals of `const INLINE_POLICY_TYPES = new Set([...])`, sorted. */
export function inlinePolicyTypesOf(text: string): string[] | undefined {
  const source = parse('superseded-resources.ts', text);
  let found: string[] | undefined;
  walk(source, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== 'INLINE_POLICY_TYPES') return;
    const types: string[] = [];
    walk(n, (m) => {
      if (ts.isStringLiteral(m)) types.push(m.text);
    });
    found = types.sort();
  });
  return found;
}

/** `deferral-exit` sites of one recordability function; throws when it moved. */
export function scanRecordability(file: string, text: string, name: string): Site[] {
  const source = parse(file, text);
  const fn = findFunction(source, name);
  if (fn?.body === undefined) {
    throw new Error(`${file}: no function ${name}: the deferral's recording moved; update this check`);
  }
  return exitsOf(file, source, fn, name);
}

/** The condition of the `if` whose then-arm is (or is a block holding only) `stmt`. */
function enclosingIfCondition(stmt: ts.Statement): ts.Expression | undefined {
  let at: ts.Node = stmt;
  if (ts.isBlock(at.parent) && at.parent.statements.length === 1) at = at.parent;
  return ts.isIfStatement(at.parent) && at.parent.thenStatement === at ? at.parent.expression : undefined;
}

/** gate-argument sites of one file. */
export function scanGateArguments(
  file: string,
  text: string,
  callerParams: ReadonlyMap<string, number>
): Site[] {
  if (!text.includes(GATE_FUNCTION)) return [];
  const source = parse(file, text);
  const sites: Site[] = [];
  walk(source, (n) => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== GATE_FUNCTION) {
      return;
    }
    for (const [param, index] of callerParams) {
      const arg = n.arguments[index];
      if (arg === undefined || arg.kind === ts.SyntaxKind.FalseKeyword) continue;
      sites.push({
        shape: 'gate-argument',
        key: `${file}:${enclosingFunction(n)}:${param}`,
        at: `${file}:${lineOf(arg, source)}`,
      });
    }
  });
  return sites;
}

// ---------------------------------------------------------------------------
// The provider shapes
// ---------------------------------------------------------------------------

/** Whether the deploy hands this replace branch a change through `update()`. */
export function deployReaches(row: SiteRow): boolean {
  if (row.status !== 'ok') return true;
  return row.triggers.some(
    (t) => t.verdict === 'provider-marked' || t.verdict === 'exempt' || t.verdict === 'gap'
  );
}

export function scanProviderReplaceSites(rows: readonly SiteRow[]): Site[] {
  return rows.filter(deployReaches).map((row) => ({
    shape: 'provider-replace-in-update' as const,
    key: `${row.resourceType} ${row.file}:${row.function}`,
    at: `${row.file} (${row.key})`,
  }));
}

/**
 * provider-own-delete sites of one file. `replaceFunctions` holds every
 * replace-branch site's `file:function`, which the shape above covers.
 */
export function scanProviderOwnDeletes(
  file: string,
  text: string,
  replaceFunctions: ReadonlySet<string>
): { sites: Site[]; calls: number } {
  if (!text.includes('this.delete(')) return { sites: [], calls: 0 };
  const source = parse(file, text);
  const sites: Site[] = [];
  let calls = 0;
  walk(source, (n) => {
    if (
      !ts.isCallExpression(n) ||
      !ts.isPropertyAccessExpression(n.expression) ||
      n.expression.expression.kind !== ts.SyntaxKind.ThisKeyword ||
      n.expression.name.text !== 'delete'
    ) {
      return;
    }
    calls++;
    const fn = enclosingFunction(n);
    if (fn === 'delete' || replaceFunctions.has(`${file}:${fn}`)) return;
    sites.push({ shape: 'provider-own-delete', key: `${file}:${fn}`, at: `${file}:${lineOf(n, source)}` });
  });
  return { sites, calls };
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/** Every failure: an unlisted site, a count that moved, a stale entry, an incomplete entry. */
export function audit(sites: readonly Site[], exceptions: readonly Exception[] = EXCEPTIONS): string[] {
  const failures: string[] = [];
  const found = new Map<string, Site[]>();
  for (const site of sites) {
    const id = `${site.shape} ${site.key}`;
    found.set(id, [...(found.get(id) ?? []), site]);
  }
  const listed = new Set<string>();
  for (const entry of exceptions) {
    const id = `${entry.shape} ${entry.key}`;
    if (listed.has(id)) failures.push(`duplicate exception: ${id}`);
    listed.add(id);
    if (entry.kind === 'early-delete') {
      if (entry.cannotDefer.trim() === '' || entry.rollbackReports.trim() === '') {
        failures.push(`exception ${id} must name why it cannot defer AND how the rollback reports the loss`);
      }
    } else if (entry.reason.trim() === '') {
      failures.push(`exception ${id} must give its reason`);
    }
    const at = found.get(id);
    if (at === undefined) {
      failures.push(`stale exception (no such site any more; remove or re-key it): ${id}`);
    } else if (at.length !== entry.count) {
      failures.push(
        `${id}: ${at.length} site(s), the exception lists ${entry.count} — a new one is unreviewed (${at.map((s) => s.at).join(', ')})`
      );
    }
  }
  for (const [id, at] of found) {
    if (listed.has(id)) continue;
    failures.push(
      `unreviewed early delete of a replaced resource's old copy: ${id} at ${at.map((s) => s.at).join(', ')}. ` +
        'Queue it on the cleanup-phase deferral (`deferToCleanupPhase`), or add a reviewed EXCEPTIONS entry ' +
        'naming why it cannot defer and how the rollback reports the loss'
    );
  }
  return failures;
}

/**
 * Minimum sites per shape on the real tree; one shape the parser stops seeing
 * would otherwise read as a clean tree. Each sits at its current measurement.
 */
export const FLOORS: Readonly<Record<Shape, number>> = {
  'provider-delete-call': 6,
  'deferral-exit': 13,
  'gate-argument': 5,
  'provider-replace-in-update': 5,
  'provider-own-delete': 5,
};

/** Floor on replace-branch rows read and on `this.delete(` calls seen. */
export const INPUT_FLOORS = { replaceRows: 15, ownDeleteCalls: 6 } as const;

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listTs(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

export interface TreeScan {
  readonly sites: Site[];
  readonly replaceRows: number;
  readonly ownDeleteCalls: number;
}

/** The scan of the real tree under `root`. */
export function scanTree(root: string = REPO_ROOT, rows?: readonly SiteRow[]): TreeScan {
  const rel = (path: string): string => relative(root, path).split(sep).join('/');
  const files = listTs(join(root, 'src')).map((path) => ({ file: rel(path), text: readFileSync(path, 'utf8') }));
  const sites: Site[] = [];
  const gateFile = files.find((f) => f.file === DELETE_REPLACED);
  if (gateFile === undefined) throw new Error(`${DELETE_REPLACED} is missing: update this check`);
  const gate = scanDeferralGate(gateFile.file, gateFile.text);
  sites.push(...gate.sites);
  for (const { file, name } of RECORDABILITY_FUNCTIONS) {
    const at = files.find((f) => f.file === file);
    if (at === undefined) throw new Error(`${file} is missing: update this check`);
    sites.push(...scanRecordability(file, at.text, name));
  }
  const supersededFile = files.find((f) => f.file === 'src/deployment/superseded-resources.ts');
  const inlineTypes = supersededFile && inlinePolicyTypesOf(supersededFile.text);
  if (JSON.stringify(inlineTypes) !== JSON.stringify(INLINE_POLICY_TYPES_REVIEWED)) {
    throw new Error(
      `INLINE_POLICY_TYPES in superseded-resources.ts is ${JSON.stringify(inlineTypes)}, the reviewed inline-policy exception covers ${JSON.stringify(INLINE_POLICY_TYPES_REVIEWED)}: a type added there deletes its replaced copy inline (#6445)`
    );
  }
  let replaceRows = rows;
  if (replaceRows === undefined) {
    const loaded = loadReport();
    // A provider the walk could not resolve would drop out of the shape silently.
    if (loaded.unresolved.length > 0) {
      throw new Error(`the replace-branch walk could not resolve: ${loaded.unresolved.join(', ')}`);
    }
    replaceRows = loaded.report.sites;
  }
  sites.push(...scanProviderReplaceSites(replaceRows));
  // Only the functions of REACHED rows are covered by that shape: a delete in
  // a branch the deploy never reaches, or beside it, is an own-delete site.
  const replaceFunctions = new Set(
    replaceRows.filter(deployReaches).map((r) => `${r.file}:${r.function}`)
  );
  let ownDeleteCalls = 0;
  for (const { file, text } of files) {
    if (isEngineScanned(file)) sites.push(...scanProviderDeleteCalls(file, text));
    sites.push(...scanGateArguments(file, text, gate.callerParams));
    if (file.startsWith('src/provisioning/')) {
      const own = scanProviderOwnDeletes(file, text, replaceFunctions);
      sites.push(...own.sites);
      ownDeleteCalls += own.calls;
    }
  }
  return { sites, replaceRows: replaceRows.length, ownDeleteCalls };
}

export function floorFailures(scan: TreeScan): string[] {
  const failures: string[] = [];
  for (const shape of SHAPES) {
    const n = scan.sites.filter((s) => s.shape === shape).length;
    if (n < FLOORS[shape]) failures.push(`floor: ${n} ${shape} site(s), expected >= ${FLOORS[shape]}: the scan stopped seeing them`);
  }
  if (scan.replaceRows < INPUT_FLOORS.replaceRows) {
    failures.push(`floor: ${scan.replaceRows} replace-branch rows read, expected >= ${INPUT_FLOORS.replaceRows}`);
  }
  if (scan.ownDeleteCalls < INPUT_FLOORS.ownDeleteCalls) {
    failures.push(`floor: ${scan.ownDeleteCalls} this.delete( calls seen, expected >= ${INPUT_FLOORS.ownDeleteCalls}`);
  }
  return failures;
}

function main(): number {
  let scan: TreeScan;
  try {
    scan = scanTree();
  } catch (error) {
    process.stderr.write(`replaced-delete-deferral check FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const failures = [...floorFailures(scan), ...audit(scan.sites)];
  if (failures.length > 0) {
    process.stderr.write(`replaced-delete-deferral check FAILED (${failures.length}):\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    return 1;
  }
  const counts = SHAPES.map((s) => `${scan.sites.filter((x) => x.shape === s).length} ${s}`).join(', ');
  const early = EXCEPTIONS.filter((e) => e.kind === 'early-delete').length;
  process.stdout.write(
    `replaced-delete-deferral check passed: ${counts}; ${early} reviewed early-delete exception(s)\n`
  );
  return 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = main();
