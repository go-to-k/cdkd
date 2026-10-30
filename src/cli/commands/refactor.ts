import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  stateOptions,
  stackOptions,
  useCdkBootstrapAssetsOption,
  noCfnFallbackOption,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling, CdkdError } from '../../utils/error-handler.js';
import { displayAwsMessage, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../synthesis/synthesizer.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import {
  buildLockContentionMessage,
  type LockRecoveryContext,
} from '../../state/lock-contention-message.js';
import {
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedState,
} from '../../state/malformed-resources-bag.js';
import { applyLogicalIdRenames, type LogicalIdRename } from '../../state/logical-id-rename.js';
import { DiffCalculator } from '../../analyzer/diff-calculator.js';
import {
  mappingPairs,
  parseMappingFile,
  proposeRenames,
  type AmbiguousGroup,
  type MappingEnvironment,
  type ProposedRename,
  type RefactorCreateSide,
  type RefactorDeleteSide,
  type RefusedOverride,
} from '../../analyzer/refactor-pairing.js';
import {
  createAssetRedirectResolver,
  rewriteTemplateAssetReferences,
} from '../../assets/asset-redirect.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import {
  exportInferredRegionForSdk,
  foldRegionOption,
  legacyStateBucketFallbackRegion,
  resolveEffectiveRegion,
  stackRegionResolver,
} from '../region-options.js';
import {
  resolveApp,
  resolveStateBucketWithDefault,
  resolveUseCdkBootstrapAssets,
} from '../config-loader.js';
import {
  matchStacks,
  describeStack,
  partitionTopLevel,
  renderAllLeftOutStageStacks,
  renderAllNoTopLevelStacks,
  renderNoStackMatch,
} from '../stack-matcher.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../provisioning/register-providers.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { makeCanonicalizePropertiesFn } from '../../provisioning/canonicalize-properties.js';
import { getAccountInfo } from '../../deployment/intrinsic-resolver/account-drain.js';
import { producerLookupOver } from '../../deployment/intrinsic-resolver/cdk-cross-account-ref.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceChange, StackState } from '../../types/state.js';
import { confirmOrRefuse } from './confirm-prompt.js';
import { computeStackDiff } from './diff-recursive.js';
import { withDeferredInterrupts } from '../../utils/deferred-interrupts.js';
import {
  applyMoveGroup,
  finishInterruptedMoves,
  planMoves,
  renderMovePlan,
  type AmbiguousMoveGroup,
  type MoveOverride,
} from './refactor-move.js';

interface RefactorOptions {
  app?: string;
  output: string;
  stateBucket?: string;
  statePrefix: string;
  stack?: string;
  all?: boolean;
  dryRun?: boolean;
  overrideFile?: string;
  revert?: boolean;
  force?: boolean;
  yes?: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
  context?: string[];
  useCdkBootstrapAssets?: boolean;
  cfnFallback?: boolean;
}

/**
 * The diff `cdkd refactor` plans against: `computeStackDiff`'s changes for one
 * stack over a given record. Injected so the planner is testable without AWS.
 */
export type RefactorDiffFn = (state: StackState) => Promise<{
  changes: Map<string, ResourceChange>;
  blocking: string[];
}>;

/** A rename the confirming diff rejected, with the properties it would change. */
export interface DifferingRename {
  rename: ProposedRename;
  /** The property paths (or attributes) the next deploy would change. */
  paths: string[];
}

/** A detected rename left out, with the reason. */
export interface SkippedRename {
  rename: ProposedRename;
  reason: string;
}

/** What `cdkd refactor` will do to one stack, and why it leaves the rest. */
export interface StackRefactorPlan {
  stackName: string;
  region: string;
  /** The record's ETag the plan was computed from; the apply refuses any other. */
  etag: string;
  /** Renames the confirming diff showed to be no-change. */
  renames: ProposedRename[];
  /** Detected look-alikes whose properties differ: left for the deploy. */
  differing: DifferingRename[];
  /** Detected renames left out for another reason (a rollback-orphan record). */
  skipped: SkippedRename[];
  ambiguous: AmbiguousGroup[];
  /** User-named pairs refused, including those whose properties differ. */
  refusedOverrides: RefusedOverride[];
  /**
   * Template resources that reference a renamed one and still change after
   * the renames: a warning that a named pair may be the wrong way round.
   */
  stillChanging: string[];
  template: CloudFormationTemplate;
  /**
   * The DELETE and CREATE rows no in-stack rename took, the candidates for a
   * move between stacks (go-to-k/cdkd#5202). A look-alike whose properties
   * differ stays a candidate: its match may be in another stack.
   */
  unpaired: { creates: RefactorCreateSide[]; deletes: RefactorDeleteSide[] };
  /** Records moving out of this stack to another (filled by `planMoves`). */
  movesOut: ProposedMove[];
  /** Records moving into this stack from another (filled by `planMoves`). */
  movesIn: ProposedMove[];
  /** The record the plan read, for the move confirmation; never saved. */
  state: StackState;
  /** The stack's diff, for the move confirmation. */
  diff: RefactorDiffFn;
}

/** A record moving between two stacks of one environment. */
export interface ProposedMove {
  fromStack: string;
  fromRegion: string;
  from: string;
  toStack: string;
  toRegion: string;
  to: string;
  resourceType: string;
  source: 'detected' | 'override';
}

/** The changes a rename's new logical id still shows, as paths. */
function changedPaths(change: ResourceChange | undefined): string[] {
  if (change === undefined) return ['(not in the diff)'];
  const paths = (change.propertyChanges ?? []).map((p) => p.path);
  for (const a of change.attributeChanges ?? []) paths.push(a.attribute);
  return paths.length > 0 ? paths : [`(${change.changeType})`];
}

/**
 * Plan one stack's refactor from its record and template (go-to-k/cdkd#5201).
 *
 * Every proposed rename is applied to an in-memory copy of the record and
 * kept only when the diff over it shows the new logical id unchanged; a
 * look-alike group the proposal could not split is then split by the same
 * diff, pair by pair. Nothing here writes.
 */
export async function planStackRefactor(input: {
  stackName: string;
  region: string;
  state: StackState;
  etag: string;
  template: CloudFormationTemplate;
  overrides: ReadonlyArray<{ from: string; to: string }>;
  diff: RefactorDiffFn;
  recovery?: LockRecoveryContext;
}): Promise<StackRefactorPlan> {
  const { stackName, region, state, etag, template, overrides, diff, recovery } = input;
  // The plan reads the rollback-orphan records and the rename rewrites them,
  // so a container or row no reader can use is refused, never carried.
  refuseMalformedOrphans(state, stackName, region, recovery);
  refuseMalformedOrphanRecords(state, stackName, region, recovery);

  const base = await diff(state);
  if (base.blocking.length > 0) {
    throw new CdkdError(
      safeMsg`cdkd refactor refused stack ${stackName} (${region}): ` +
        `'cdkd diff' reports a condition 'cdkd deploy' refuses to start on. ` +
        `Resolve what 'cdkd diff ${stackName}' reports, then re-run cdkd refactor.`,
      'REFACTOR_REFUSED'
    );
  }

  // A rollback-orphan record (`orphans`) is re-adopted by the next deploy
  // under its own logical id, so its CREATE row is not a free destination.
  const orphanIds = new Set(
    (Array.isArray(state.orphans) ? state.orphans : [])
      .map((o) => (o !== null && typeof o === 'object' ? o.logicalId : undefined))
      .filter((id): id is string => typeof id === 'string')
  );
  const creates: RefactorCreateSide[] = [];
  const deletes: RefactorDeleteSide[] = [];
  for (const change of base.changes.values()) {
    if (change.changeType === 'CREATE' && !orphanIds.has(change.logicalId)) {
      creates.push({
        logicalId: change.logicalId,
        resourceType: change.resourceType,
        properties: change.desiredProperties ?? {},
      });
    } else if (change.changeType === 'DELETE') {
      const record = state.resources[change.logicalId];
      deletes.push({
        logicalId: change.logicalId,
        resourceType: change.resourceType,
        properties:
          record !== undefined &&
          record.properties !== null &&
          typeof record.properties === 'object'
            ? record.properties
            : {},
      });
    }
  }

  const proposal = proposeRenames(creates, deletes, overrides);
  const refusedOverrides = [...proposal.refusedOverrides];
  const differing: DifferingRename[] = [];
  const skipped: SkippedRename[] = [];
  const candidates = proposal.renames.filter((r) => {
    if (!orphanIds.has(r.from)) return true;
    const reason = `a rollback-orphan record also names ${r.from}; run 'cdkd deploy' first to settle it`;
    if (r.source === 'override') refusedOverrides.push({ from: r.from, to: r.to, reason });
    else skipped.push({ rename: r, reason });
    return false;
  });

  // Keep only the renames the diff over the renamed record shows unchanged,
  // re-diffing after each drop: a dropped rename can be what a kept one's
  // reference resolved through.
  const confirm = async (
    proposed: readonly ProposedRename[]
  ): Promise<{ kept: ProposedRename[]; changes: Map<string, ResourceChange> | undefined }> => {
    let kept = [...proposed];
    while (kept.length > 0) {
      const renamed = applyLogicalIdRenames(state, toLogicalIdRenames(kept), template);
      const { changes } = await diff(renamed);
      const failed = kept.filter((r) => changes.get(r.to)?.changeType !== 'NO_CHANGE');
      if (failed.length === 0) return { kept, changes };
      for (const rename of failed) {
        const paths = changedPaths(changes.get(rename.to));
        if (rename.source === 'override') {
          refusedOverrides.push({
            from: rename.from,
            to: rename.to,
            reason:
              `its properties also changed (${paths.join(', ')}); cdkd refactor keeps only an ` +
              `unchanged resource. Revert the property change, run cdkd refactor, then deploy ` +
              `the change`,
          });
        } else {
          differing.push({ rename, paths });
        }
      }
      kept = kept.filter((r) => !failed.includes(r));
    }
    return { kept, changes: undefined };
  };

  let { kept: renames, changes: confirmed } = await confirm(candidates);

  // Split a look-alike group with the diff itself: try each new logical id
  // against each old one, on top of the renames already kept, and pair the
  // ones that match exactly one way. Two resources that differ only in what
  // they reference look alike to the proposal (an unresolved reference
  // matches anything) and are told apart here. Bounded, so a large group
  // costs at most MAX_TRIAL_DIFFS diffs; what the budget does not reach
  // stays ambiguous, which writes nothing.
  let ambiguous = proposal.ambiguous;
  let budget = MAX_TRIAL_DIFFS;
  for (;;) {
    const takenFrom = new Set(renames.map((r) => r.from));
    const takenTo = new Set(renames.map((r) => r.to));
    const accepted: ProposedRename[] = [];
    const remaining: AmbiguousGroup[] = [];
    for (const group of ambiguous) {
      const froms = group.from.filter((id) => !takenFrom.has(id));
      const tos = group.to.filter((id) => !takenTo.has(id));
      if (froms.length === 0 || tos.length === 0) continue;
      if (froms.length * tos.length > budget) {
        remaining.push({ resourceType: group.resourceType, from: froms, to: tos });
        continue;
      }
      const passing = new Map<string, string[]>();
      for (const to of tos) {
        const matches: string[] = [];
        for (const from of froms) {
          budget -= 1;
          const trial = applyLogicalIdRenames(
            state,
            [...toLogicalIdRenames(renames), { from, to }],
            template
          );
          const { changes } = await diff(trial);
          if (changes.get(to)?.changeType === 'NO_CHANGE') matches.push(from);
        }
        passing.set(to, matches);
      }
      const claims = new Map<string, number>();
      for (const matches of passing.values()) {
        for (const from of matches) claims.set(from, (claims.get(from) ?? 0) + 1);
      }
      const leftFrom = new Set<string>();
      const leftTo: string[] = [];
      for (const [to, matches] of passing) {
        if (matches.length === 0) continue;
        if (matches.length === 1 && claims.get(matches[0]!) === 1) {
          accepted.push({
            from: matches[0]!,
            to,
            resourceType: group.resourceType,
            source: 'detected',
          });
          continue;
        }
        leftTo.push(to);
        for (const from of matches) leftFrom.add(from);
      }
      if (leftTo.length > 0) {
        remaining.push({
          resourceType: group.resourceType,
          from: [...leftFrom].sort(),
          to: leftTo.sort(),
        });
      }
    }
    ambiguous = remaining;
    if (accepted.length === 0) break;
    ({ kept: renames, changes: confirmed } = await confirm([...renames, ...accepted]));
  }

  // A resource that references a renamed one and still changes after the
  // renames points at a pair that may be wrong: a mapping file can name two
  // look-alikes the wrong way round, and each still shows no change itself.
  const renamedTo = new Set(renames.map((r) => r.to));
  const stillChanging =
    confirmed === undefined
      ? []
      : [...confirmed.values()]
          .filter(
            (change) =>
              (change.changeType === 'UPDATE' || change.changeType === 'CREATE') &&
              !renamedTo.has(change.logicalId) &&
              [...referencedLogicalIds(template, change.logicalId)].some((id) => renamedTo.has(id))
          )
          .map((change) => change.logicalId)
          .sort();

  const takenTo = new Set([
    ...renames.map((r) => r.to),
    ...skipped.map((x) => x.rename.to),
    ...ambiguous.flatMap((g) => g.to),
    ...overrides.map((o) => o.to),
  ]);
  const takenFrom = new Set([
    ...renames.map((r) => r.from),
    ...skipped.map((x) => x.rename.from),
    ...ambiguous.flatMap((g) => g.from),
    ...overrides.map((o) => o.from),
    ...orphanIds,
  ]);

  return {
    stackName,
    region,
    etag,
    renames,
    differing,
    skipped,
    ambiguous,
    refusedOverrides,
    stillChanging,
    template,
    unpaired: {
      creates: creates.filter((c) => !takenTo.has(c.logicalId)),
      deletes: deletes.filter((d) => !takenFrom.has(d.logicalId)),
    },
    movesOut: [],
    movesIn: [],
    state,
    diff,
  };
}

/** The most trial diffs one stack's look-alike groups may cost. */
const MAX_TRIAL_DIFFS = 64;

/**
 * The logical ids one template resource references: `Ref`, `Fn::GetAtt` (both
 * forms), `Fn::Sub` placeholders and `DependsOn`. Exported for its unit tests.
 */
export function referencedLogicalIds(
  template: CloudFormationTemplate,
  logicalId: string
): Set<string> {
  const out = new Set<string>();
  const resources = template.Resources ?? {};
  if (!Object.hasOwn(resources, logicalId)) return out;
  const resource = resources[logicalId] as { Properties?: unknown; DependsOn?: unknown };
  const dependsOn = resource.DependsOn;
  for (const id of Array.isArray(dependsOn) ? dependsOn : [dependsOn]) {
    if (typeof id === 'string') out.add(id);
  }
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, arg] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'Ref' && typeof arg === 'string') out.add(arg);
      else if (key === 'Fn::GetAtt') {
        if (Array.isArray(arg) && typeof arg[0] === 'string') out.add(arg[0]);
        else if (typeof arg === 'string') out.add(arg.split('.')[0]!);
      } else if (key === 'Fn::Sub') {
        const text = typeof arg === 'string' ? arg : Array.isArray(arg) ? arg[0] : undefined;
        if (typeof text === 'string') {
          for (const match of text.matchAll(/\$\{([^}!][^}.]*)/g)) out.add(match[1]!);
        }
      }
      walk(arg);
    }
  };
  walk(resource.Properties);
  return out;
}

function toLogicalIdRenames(renames: readonly ProposedRename[]): LogicalIdRename[] {
  return renames.map(({ from, to }) => ({ from, to }));
}

/**
 * Apply a plan under the stack's lock (go-to-k/cdkd#5201). The record is
 * re-read under the lock and must carry the ETag the plan was computed from:
 * a deploy that ran in between changed what the plan describes, so the
 * apply refuses rather than renaming against a record it did not check. The
 * save is conditional on that same ETag.
 */
export async function applyStackRefactor(input: {
  plan: StackRefactorPlan;
  stateBackend: Pick<
    S3StateBackend,
    'getState' | 'saveState' | 'rotateCreateTokenNonce' | 'loadRollbackJournal'
  >;
  lockManager: Pick<LockManager, 'acquireLock' | 'releaseLock'>;
  recovery: LockRecoveryContext;
  contentionMessage: () => Promise<string>;
}): Promise<void> {
  const { plan, stateBackend, lockManager, contentionMessage } = input;
  const logger = getLogger();
  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
  const acquired = await lockManager.acquireLock(plan.stackName, plan.region, owner, 'refactor');
  if (!acquired) throw new Error(await contentionMessage());
  try {
    const stateData = await stateBackend.getState(plan.stackName, plan.region);
    if (!stateData || stateData.etag !== plan.etag) {
      throw new CdkdError(
        safeMsg`The state of stack ${plan.stackName} (${plan.region}) changed after cdkd ` +
          `refactor planned it, so nothing was written for this stack. Re-run cdkd refactor.`,
        'REFACTOR_STATE_CHANGED'
      );
    }
    refuseMalformedState(stateData.state, plan.stackName, plan.region, input.recovery);
    refuseMalformedOrphans(stateData.state, plan.stackName, plan.region, input.recovery);
    refuseMalformedOrphanRecords(stateData.state, plan.stackName, plan.region, input.recovery);
    // Re-checked under the lock: a deploy that failed before its first state
    // save leaves a journal without moving the ETag.
    if ((await stateBackend.loadRollbackJournal(plan.stackName, plan.region)) !== null) {
      throw rollbackJournalRefusal(plan.stackName, plan.region);
    }
    const renamed = applyLogicalIdRenames(
      stateData.state,
      toLogicalIdRenames(plan.renames),
      plan.template
    );
    // The renamed resources still hold the create tokens their OLD logical
    // ids sent (EFS, FSx, CloudFront OAI), so a later create of an old id must
    // send new ones -- as `cdkd orphan` does for the ids that leave a stack.
    await stateBackend.rotateCreateTokenNonce(
      plan.stackName,
      plan.region,
      plan.renames.map((r) => r.from)
    );
    await stateBackend.saveState(plan.stackName, plan.region, renamed, {
      expectedEtag: plan.etag,
      ...(stateData.migrationPending && { migrateLegacy: true }),
    });
  } finally {
    await lockManager.releaseLock(plan.stackName, plan.region).catch((err: unknown) => {
      logger.warn(
        safeMsg`Failed to release lock: ${displayAwsMessage(describeAwsFailure(err).detail)}`
      );
    });
  }
}

/** The refusal for a stack an earlier deploy left a rollback journal on. */
function rollbackJournalRefusal(stackName: string, region: string): CdkdError {
  return new CdkdError(
    safeMsg`cdkd refactor refused stack ${stackName} (${region}): an earlier deploy left a ` +
      safeMsg`rollback journal, so nothing was written for this stack. Run 'cdkd rollback ${stackName}' ` +
      `or a successful 'cdkd deploy' first.`,
    'REFACTOR_REFUSED'
  );
}

/** The plan as the lines `cdkd refactor` prints. Exported for its unit tests. */
export function renderRefactorPlan(plan: StackRefactorPlan): string[] {
  const lines: string[] = [safeMsg`Stack ${plan.stackName} (${plan.region})`];
  if (plan.renames.length === 0) lines.push('  No resource to refactor.');
  for (const r of plan.renames) {
    lines.push(
      safeMsg`  ${r.from} -> ${r.to}  (${r.resourceType}${r.source === 'override' ? ', from the mapping file' : ''})`
    );
  }
  for (const { rename, paths } of plan.differing) {
    lines.push(
      safeMsg`  Not refactored: ${rename.from} -> ${rename.to} (${rename.resourceType}) also changes ` +
        safeMsg`${paths.join(', ')}. cdkd refactor keeps only an unchanged resource: revert the ` +
        'property change, run cdkd refactor, then deploy the change.'
    );
  }
  for (const { rename, reason } of plan.skipped) {
    lines.push(
      safeMsg`  Not refactored: ${rename.from} -> ${rename.to} (${rename.resourceType}): ${reason}.`
    );
  }
  for (const group of plan.ambiguous) {
    lines.push(
      safeMsg`  Ambiguous (${group.resourceType}): ${group.from.join(', ')} could each be ` +
        safeMsg`${group.to.join(', ')}. Name the pairs with --override-file.`
    );
  }
  for (const refused of plan.refusedOverrides) {
    lines.push(safeMsg`  Refused: ${refused.from} -> ${refused.to}: ${refused.reason}.`);
  }
  if (plan.stillChanging.length > 0) {
    lines.push(
      safeMsg`  Warning: ${plan.stillChanging.join(', ')} reference a renamed resource and still ` +
        'change on the next deploy. Check that each pair above names the resource you meant; ' +
        "'cdkd diff' after the refactor shows the change."
    );
  }
  return lines;
}

/**
 * A sample mapping file for the ambiguous groups of `plans`, one environment
 * per stack (its own account and region). Exported for its unit tests.
 */
export function sampleMappingFile(
  plans: ReadonlyArray<{ plan: StackRefactorPlan; account: string }>,
  moveGroups: ReadonlyArray<{ group: AmbiguousMoveGroup; account: string }> = []
): string {
  const moveEnvironments = moveGroups.map(({ group, account }) => {
    const resources: Record<string, string> = {};
    group.from.forEach((from, i) => {
      Object.defineProperty(resources, from, {
        value: group.to[i] ?? group.to[0]!,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
    return { account, region: group.plan.region, resources };
  });
  const stackEnvironments = plans
    .filter(({ plan }) => plan.ambiguous.length > 0)
    .map(({ plan, account }) => {
      const resources: Record<string, string> = {};
      for (const group of plan.ambiguous) {
        group.from.forEach((from, i) => {
          const to = group.to[i] ?? group.to[0]!;
          Object.defineProperty(resources, `${plan.stackName}.${from}`, {
            value: `${plan.stackName}.${to}`,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        });
      }
      return { account, region: plan.region, resources };
    });
  return JSON.stringify({ environments: [...stackEnvironments, ...moveEnvironments] }, null, 2);
}

/**
 * The user-named pairs WITHIN one stack: the mapping environment whose
 * account and region are the stack's. A pair between two stacks is a move,
 * collected by {@link moveOverridesOf} instead.
 */
export function overridesForStack(
  environments: readonly MappingEnvironment[],
  stackName: string,
  account: string,
  region: string,
  revert: boolean
): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const env of environments) {
    if (env.account !== account || env.region !== region) continue;
    for (const pair of mappingPairs(env.resources, revert)) {
      if (pair.fromStack !== stackName || pair.toStack !== stackName) continue;
      out.push({ from: pair.from, to: pair.to });
    }
  }
  return out;
}

/**
 * The user-named moves between two stacks, for every environment whose
 * account is one of `accounts` (go-to-k/cdkd#5202). Exported for its unit
 * tests.
 */
export function moveOverridesOf(
  environments: readonly MappingEnvironment[],
  accounts: ReadonlySet<string>,
  revert: boolean
): MoveOverride[] {
  const out: MoveOverride[] = [];
  for (const env of environments) {
    if (!accounts.has(env.account)) continue;
    for (const pair of mappingPairs(env.resources, revert)) {
      if (pair.fromStack === pair.toStack) continue;
      out.push({ region: env.region, env: envKey(env.account, env.region), ...pair });
    }
  }
  return out;
}

/** One environment's key: an account and a region. */
export function envKey(account: string | undefined, region: string): string {
  return JSON.stringify([account, region]);
}

async function refactorCommand(stacks: string[], options: RefactorOptions): Promise<void> {
  const providerClasses = await loadProviderClasses();
  const logger = getLogger();
  const holdNotice = (signal: NodeJS.Signals): void => {
    logger.warn(
      safeMsg`${signal} received: finishing the cdkd state writes already started (a few S3 ` +
        'writes), then stopping.'
    );
  };
  if (options.verbose) logger.setLevel('debug');
  if (options.revert === true && options.overrideFile === undefined) {
    throw new CdkdError('--revert requires --override-file', 'INCOMPATIBLE_OPTIONS');
  }

  warnIfDeprecatedRegion(options);
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }

  // Read before any AWS call, so a malformed file costs nothing.
  let environments: MappingEnvironment[] = [];
  if (options.overrideFile !== undefined) {
    let text: string;
    try {
      text = readFileSync(options.overrideFile, 'utf-8');
    } catch {
      throw new CdkdError(
        safeMsg`Cannot read the mapping file ${options.overrideFile}`,
        'REFACTOR_MAPPING_FILE'
      );
    }
    try {
      environments = parseMappingFile(text);
    } catch (error) {
      throw new CdkdError(
        safeMsg`Invalid mapping file ${options.overrideFile}: ${(error as Error).message}`,
        'REFACTOR_MAPPING_FILE'
      );
    }
  }

  const effectiveRegion = await resolveEffectiveRegion(options);
  exportInferredRegionForSdk(effectiveRegion);
  const region = effectiveRegion.region;
  const stateBucket = await resolveStateBucketWithDefault(
    options.stateBucket,
    region,
    legacyStateBucketFallbackRegion(effectiveRegion)
  );

  const awsClients = new AwsClients({
    region: effectiveRegion.region,
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    logger.info(synthesisStatusMessage(app, 'Synthesizing CDK app...'));
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const synthOptions: SynthesisOptions = {
      app,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
      stateBucket,
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
      deferMacroExpansion: true,
    };
    const { stacks: allStacks } = await synthesizer.synthesize(synthOptions);
    const targetStacks = selectStacks(allStacks, stacks, options);
    await synthesizer.expandMacrosForStacks(targetStacks, synthOptions);

    const stateConfig = { bucket: stateBucket, prefix: options.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      region,
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    const recovery: LockRecoveryContext = {
      profile: options.profile,
      stateBucket,
      statePrefix: options.statePrefix,
    };
    const regionForStack = stackRegionResolver({
      effective: effectiveRegion,
      probe: stateBackend,
      logger,
      siblings: allStacks.filter((s) => !s.region).map((s) => s.stackName),
    });
    const diffCalculator = new DiffCalculator();
    const registry = new ProviderRegistry();
    registerAllProviders(registry, providerClasses);
    const canonicalizeProperties = makeCanonicalizePropertiesFn(registry);
    const producerLookup = producerLookupOver(allStacks);
    const resolveAssetRedirect = createAssetRedirectResolver({
      stateBackend,
      stsRegion: region,
      ...(options.profile && { profile: options.profile }),
      useCdkBootstrapAssets: resolveUseCdkBootstrapAssets(options.useCdkBootstrapAssets),
      suppressLegacyNotice: true,
    });
    let callerAccount: string | undefined;
    const accountOf = async (stackInfo: StackInfo): Promise<string> => {
      if (stackInfo.account) return stackInfo.account;
      callerAccount ??= (await getAccountInfo()).accountId;
      return callerAccount;
    };

    // An earlier `cdkd refactor` interrupted mid-move (go-to-k/cdkd#5212):
    // finish every one involving a selected stack before ANY stack is
    // planned, since finishing one writes its destination's record too.
    const selectedStacks: Array<{ stackName: string; region: string }> = [];
    for (const stackInfo of targetStacks) {
      selectedStacks.push({
        stackName: stackInfo.stackName,
        region: await regionForStack(stackInfo.stackName, stackInfo.region),
      });
    }
    const templateOf = (stackName: string, region: string): CloudFormationTemplate | undefined =>
      allStacks.find(
        (s) => s.stackName === stackName && (s.region === undefined || s.region === region)
      )?.template;
    const { finished: finishedMoves, pending: pendingMoves } = await withDeferredInterrupts(
      () =>
        finishInterruptedMoves({
          selected: selectedStacks,
          templateOf,
          dryRun: options.dryRun === true,
          stateBackend,
          lockManager,
          recovery,
          contentionMessage: (st) =>
            buildLockContentionMessage({
              lockManager,
              stackName: st.stackName,
              region: st.region,
              recovery,
            }),
        }),
      holdNotice
    );
    for (const f of finishedMoves) {
      logger.info(
        safeMsg`Finished an interrupted move: ${f.fromStack}.${f.from} -> ${f.toStack}.${f.to}`
      );
    }
    if (pendingMoves.length > 0) {
      for (const f of pendingMoves) {
        logger.info(
          safeMsg`An interrupted move would be finished: ${f.fromStack}.${f.from} -> ${f.toStack}.${f.to}`
        );
      }
      logger.info(
        '\n--dry-run: state was NOT written. Re-run without --dry-run to finish these moves; the ' +
          'refactor plan is computed after them.'
      );
      return;
    }

    const plans: StackRefactorPlan[] = [];
    const planStacks = new Map<StackRefactorPlan, StackInfo>();
    for (const stackInfo of targetStacks) {
      const stackRegion = await regionForStack(stackInfo.stackName, stackInfo.region);
      const stateData = await stateBackend.getState(stackInfo.stackName, stackRegion);
      if (!stateData) {
        logger.info(
          safeMsg`Stack ${stackInfo.stackName} (${stackRegion}) has no cdkd state: nothing to refactor.`
        );
        continue;
      }
      refuseMalformedState(stateData.state, stackInfo.stackName, stackRegion, recovery);
      if ((await stateBackend.loadRollbackJournal(stackInfo.stackName, stackRegion)) !== null) {
        throw rollbackJournalRefusal(stackInfo.stackName, stackRegion);
      }
      const assetRedirect = await resolveAssetRedirect(stackInfo.assetManifestPath, stackRegion);
      if (assetRedirect) rewriteTemplateAssetReferences(stackInfo.template, assetRedirect);

      const overrides =
        environments.length === 0
          ? []
          : overridesForStack(
              environments,
              stackInfo.stackName,
              await accountOf(stackInfo),
              stackRegion,
              options.revert === true
            );
      const diff: RefactorDiffFn = async (state) => {
        const result = await computeStackDiff(
          state,
          stackInfo.template,
          stackRegion,
          stackInfo.stackName,
          stateBackend,
          diffCalculator,
          {
            canonicalizeProperties,
            ...(options.cfnFallback === false && { cfnFallback: false }),
            producerLookup,
            ...(stackInfo.account && { consumerAccount: stackInfo.account }),
            refusalRecovery: recovery,
            inheritSecretBearingTemplate: false,
            previewMaskedInputs: true,
            ...(stackInfo.nestedTemplates && { nestedTemplates: stackInfo.nestedTemplates }),
          }
        );
        return { changes: result.changes, blocking: result.blocking };
      };
      const plan = await planStackRefactor({
        stackName: stackInfo.stackName,
        region: stackRegion,
        state: stateData.state,
        etag: stateData.etag,
        template: stackInfo.template,
        overrides,
        diff,
        recovery,
      });
      plans.push(plan);
      planStacks.set(plan, stackInfo);
    }

    // Moves between stacks (go-to-k/cdkd#5202), over the rows no in-stack
    // rename took. Only a run that selected two or more stacks can move.
    const accountByPlan = new Map<StackRefactorPlan, string>();
    if (plans.length > 1) {
      for (const plan of plans) accountByPlan.set(plan, await accountOf(planStacks.get(plan)!));
    }
    const movePlan =
      plans.length > 1
        ? await planMoves(
            plans,
            (plan) => envKey(accountByPlan.get(plan), plan.region),
            moveOverridesOf(environments, new Set(accountByPlan.values()), options.revert === true)
          )
        : { moves: [], differing: [], refused: [], ambiguous: [] as AmbiguousMoveGroup[] };
    if (plans.length <= 1 && environments.length > 0) {
      // A named move with fewer than two stacks selected can never apply.
      const lone = moveOverridesOf(
        environments,
        new Set(plans.length === 1 ? [await accountOf(planStacks.get(plans[0]!)!)] : []),
        options.revert === true
      );
      for (const o of lone) {
        movePlan.refused.push({
          fromStack: o.fromStack,
          from: o.from,
          toStack: o.toStack,
          to: o.to,
          reason: 'a move needs both stacks selected; name both, or pass --all',
        });
      }
    }

    for (const plan of plans) for (const line of renderRefactorPlan(plan)) logger.info(line);
    for (const line of renderMovePlan(movePlan)) logger.info(line);

    if (plans.some((p) => p.ambiguous.length > 0) || movePlan.ambiguous.length > 0) {
      const withAccounts = [];
      for (const plan of plans) {
        if (plan.ambiguous.length === 0) continue;
        withAccounts.push({ plan, account: await accountOf(planStacks.get(plan)!) });
      }
      const moveGroups = [];
      for (const group of movePlan.ambiguous) {
        moveGroups.push({ group, account: await accountOf(planStacks.get(group.plan)!) });
      }
      logger.info(
        '\nA mapping file naming each ambiguous pair (edit the pairs, then pass it with ' +
          '--override-file):'
      );
      for (const line of sampleMappingFile(withAccounts, moveGroups).split('\n')) {
        logger.info(displaySafe(line));
      }
      throw new CdkdError(
        'cdkd refactor found resources it cannot pair on its own; nothing was written. ' +
          'Name each ambiguous pair in a mapping file and re-run with --override-file.',
        'REFACTOR_AMBIGUOUS'
      );
    }
    const refused = [...plans.flatMap((p) => p.refusedOverrides), ...movePlan.refused];
    if (refused.length > 0) {
      throw new CdkdError(
        `cdkd refactor refused ${refused.length} pair(s) the mapping file names; nothing was ` +
          'written. Fix or remove each refused pair in the mapping file (the reasons are ' +
          'above), then re-run cdkd refactor.',
        'REFACTOR_REFUSED'
      );
    }
    const toApply = plans.filter(
      (p) => p.renames.length > 0 || p.movesOut.length > 0 || p.movesIn.length > 0
    );
    if (toApply.length === 0) {
      logger.info('\nNothing to refactor.');
      return;
    }
    if (options.dryRun) {
      logger.info('\n--dry-run: state was NOT written. Re-run without --dry-run to apply.');
      return;
    }
    const count = toApply.reduce((n, p) => n + p.renames.length, 0) + movePlan.moves.length;
    if (!options.yes && !options.force) {
      const ok = await confirmOrRefuse(
        `\nRename or move ${count} resource(s) in cdkd state as listed above? AWS resources ` +
          'are not touched.',
        {
          refusal:
            'The cdkd refactor confirmation prompt cannot run in a non-interactive ' +
            'environment. Pass -y / --yes (or -f / --force) to confirm, or run the command ' +
            'from a real terminal.',
        }
      );
      if (!ok) {
        logger.info('Refactor cancelled.');
        return;
      }
    }
    if (movePlan.moves.length > 0) {
      // Every stack of the run as one unit: a move writes two records.
      await withDeferredInterrupts(
        () =>
          applyMoveGroup({
            plans: toApply,
            stateBackend,
            lockManager,
            recovery,
            contentionMessage: (plan) =>
              buildLockContentionMessage({
                lockManager,
                stackName: plan.stackName,
                region: plan.region,
                recovery,
              }),
          }),
        holdNotice
      );
      logger.info(
        safeMsg`Refactored ${count} resource(s) across ${toApply.length} stack(s): ` +
          safeMsg`${toApply.map((p) => `${p.stackName} (${p.region})`).join(', ')}.`
      );
      logger.info(
        "\nAWS resources were not touched. Run 'cdkd diff' to confirm the refactored resources " +
          'show no change, and deploy the destination stacks before the stacks that import from them.'
      );
      return;
    }
    const done: string[] = [];
    for (const plan of toApply) {
      try {
        await withDeferredInterrupts(
          () =>
            applyStackRefactor({
              plan,
              stateBackend,
              lockManager,
              recovery,
              contentionMessage: () =>
                buildLockContentionMessage({
                  lockManager,
                  stackName: plan.stackName,
                  region: plan.region,
                  recovery,
                }),
            }),
          holdNotice
        );
      } catch (error) {
        if (done.length > 0) {
          logger.error(
            safeMsg`Already refactored before this failure, and kept: ${done.join(', ')}.`
          );
        }
        throw error;
      }
      done.push(`${plan.stackName} (${plan.region})`);
      logger.info(
        safeMsg`Refactored ${plan.renames.length} resource(s) in stack ${plan.stackName} (${plan.region}).`
      );
    }
    logger.info(
      "\nAWS resources were not touched. Run 'cdkd diff' to confirm the renamed resources show no change."
    );
  } finally {
    awsClients.destroy();
  }
}

/** Stack selection, as `cdkd diff` selects. */
function selectStacks(
  allStacks: StackInfo[],
  stacks: string[],
  options: Pick<RefactorOptions, 'all' | 'stack'>
): StackInfo[] {
  const logger = getLogger();
  const stackPatterns = stacks.length > 0 ? stacks : options.stack ? [options.stack] : [];
  if (allStacks.length === 0) throw new Error(renderNoStackMatch(stackPatterns, allStacks));
  let targetStacks: StackInfo[];
  if (options.all) {
    const { topLevel, inStages } = partitionTopLevel(allStacks);
    if (topLevel.length === 0) throw new Error(renderAllNoTopLevelStacks(inStages));
    if (inStages.length > 0) logger.info(renderAllLeftOutStageStacks(inStages));
    targetStacks = topLevel;
  } else if (stackPatterns.length > 0) {
    targetStacks = matchStacks(allStacks, stackPatterns, { dedupe: 'identity' });
  } else if (allStacks.length === 1) {
    targetStacks = allStacks;
  } else {
    throw new Error(
      `Multiple stacks found: ${allStacks.map(describeStack).join(', ')}. ` +
        `Specify stack name(s) or use --all (top-level stacks; '**' for every stack)`
    );
  }
  if (targetStacks.length === 0) throw new Error(renderNoStackMatch(stackPatterns, allStacks));
  return targetStacks;
}

/** Create the `cdkd refactor` command. */
export function createRefactorCommand(): Command {
  const cmd = new Command('refactor')
    .description(
      "Keep resources whose logical IDs a construct rename changed, instead of replacing them (mirrors 'cdk refactor'). Rewrites cdkd state only; AWS resources are not touched."
    )
    .argument(
      '[stacks...]',
      "Stack name(s) to refactor. Accepts CDK display paths (e.g. 'MyStage/Api') with wildcards, or exact physical CloudFormation names."
    )
    .option('--all', "Refactor every top-level stack (Stage stacks: '**')", false)
    .option('--dry-run', 'Print the refactor plan without writing state', false)
    .option(
      '--override-file <path>',
      'A JSON mapping file naming pairs the detection finds ambiguous, in the cdk refactor format: {"environments":[{"account","region","resources":{"Stack.OldId":"Stack.NewId"}}]}'
    )
    .option('--revert', 'Apply the mapping file in reverse (requires --override-file)', false)
    .option('-f, --force', 'Skip the confirmation prompt', false)
    .addOption(useCdkBootstrapAssetsOption)
    .addOption(noCfnFallbackOption)
    .action(withErrorHandling(refactorCommand));

  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions, ...contextOptions].forEach(
    (opt) => cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);
  return cmd;
}
