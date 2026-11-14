import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isAbsoluteAssetPath,
  listNestedTemplateRows,
} from '../../../utils/nested-template-cycle.js';
import {
  describeFileReadFailure,
  displayAssemblyPath,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../../../utils/assembly-path.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import { cdkdRemedy } from '../../../utils/pasteable-command.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { getLogger } from '../../../utils/logger.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { LockManager } from '../../../state/lock-manager.js';
import { carriesDynamicReference } from '../../../deployment/intrinsic-function-resolver.js';
import type { RecordedSecretValues } from '../../../deployment/secret-redaction.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayIdent, displayStackName, safeMsg } from '../../../utils/display-safe.js';
import type { StackState } from '../../../types/state.js';
import { stackInstanceIdCarriedFrom } from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import { hasReadableResources, isReadableBag } from '../../../state/malformed-resources-bag.js';
import { saveScrubbedState } from './save-state.js';
import type { ScrubStackResult } from './stack-result.js';

/** `AWS::CloudFormation::Stack`, the row a nested child is deployed by. */
export const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/**
 * What a nested CHILD's scrub is handed by its parent's (go-to-k/cdkd#2252).
 *
 * The child's template spells a parameter consumption as `{Ref: <Param>}`, so
 * nothing in the child's own resolution can record the `plaintext ->
 * {{resolve:...}}` pair its stored plaintext is redacted back to. The parent's
 * resolution of the child's `Parameters` block is where that pair is visible;
 * this is that resolution's output, in the two shapes
 * `NestedStackProvider.runChildDeploy` hands the child engine.
 */
export interface NestedChildScrubInput {
  /** The child's `Parameters`, resolved by the parent and coerced as the provider does. */
  parameters: Record<string, string>;
  /**
   * The parent's per-resource bag for the child's `AWS::CloudFormation::Stack`
   * row — the child resolver's `inheritedSecrets`. Its KEYS are secret
   * plaintext: passed on, never enumerated or logged.
   */
  inheritedSecrets: RecordedSecretValues;
  /**
   * The child parameters the parent's row fills from a `NoEcho` source
   * (go-to-k/cdkd#4043 Phase C, the deploy's decision 8), which the child's
   * own template does not declare `NoEcho`.
   */
  noEchoParameters?: readonly string[];
  /**
   * The subset of {@link noEchoParameters} the row fills through an `Fn::If`.
   * Positioned like the rest, but a plaintext the child stored there is no
   * migration needle: it may be the OTHER branch's literal, which as a needle
   * would mask unrelated copies of it.
   */
  noEchoConditionalParameters?: readonly string[];
}

/** One nested child a parent's scrub found, for `scrubCommand` to visit next. */
export interface NestedChildScrubTarget {
  /** The child's logical id in the parent's template (and state). */
  logicalId: string;
  /** `<parent>~<logicalId>`, the child's state key segment. */
  stackName: string;
  /** Present when the child can be scrubbed. */
  input?: NestedChildScrubInput;
  /**
   * Why it cannot, when it cannot. Raised as a refusal only if the child HAS a
   * state record: a child that was never deployed has nothing to scrub.
   */
  refusal?: string;
}

/** One entry of `scrubCommand`'s work list — a target stack or a nested child. */
export interface ScrubWorkItem {
  stackName: string;
  region: string;
  /**
   * The `StackInfo` to scrub. Deferred so a child template that cannot be READ
   * is a per-stack failure inside the loop's boundary, not a run abort.
   */
  load: () => { stack: StackInfo; nestedChild?: NestedChildScrubTarget };
  /**
   * For a nested child that was scrubbed with its parent's inputs: the parent
   * and the row, whose `Outputs.<Name>` attributes mirror this child's outputs
   * (go-to-k/cdkd#3961).
   */
  parentRow?: { stackName: string; logicalId: string };
}

/**
 * The child template a nested-stack row names, and ITS nested rows indexed for
 * the next level — the same two reads `NestedStackProvider.readChildTemplate`
 * makes, in the same order (the index is taken from the raw file). The whole
 * tree was already walked by `findNestedTemplateTreeDefect` before the
 * top-level stack was scrubbed; the absolute / escaping-path refusals here are
 * the per-level backstops the provider keeps too.
 */
function readNestedChildTemplate(templatePath: string): {
  template: CloudFormationTemplate;
  nestedTemplates: Record<string, string>;
} {
  let template: CloudFormationTemplate;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf-8')) as CloudFormationTemplate;
  } catch (err) {
    throw new Error(
      `Failed to read nested template at ${displayAssemblyPath(templatePath)}: ${describeFileReadFailure(err, templatePath)}`
    );
  }
  const dir = path.dirname(templatePath);
  const nestedTemplates = nullPrototypeRecord<string>();
  for (const { logicalId, assetPath } of listNestedTemplateRows(template)) {
    if (isAbsoluteAssetPath(assetPath)) {
      throw new Error(
        `Nested stack ${displayIdent(logicalId)} has Metadata['aws:asset:path']=` +
          `${displayAssemblyPath(assetPath)}, which is absolute. CDK emits relative asset ` +
          `paths for nested templates. Refusing to load.`
      );
    }
    const resolved = resolveAssemblyPath(dir, assetPath);
    if (!resolved.contained) {
      throw new Error(
        `Nested stack ${displayIdent(logicalId)} has Metadata['aws:asset:path']=` +
          `${displayAssemblyPath(assetPath)}, which ${renderAssemblyPathEscape(resolved, dir)}`
      );
    }
    nestedTemplates[logicalId] = resolved.path;
  }
  return { template, nestedTemplates };
}

/**
 * The work item for one nested child of `parent` (go-to-k/cdkd#2252).
 *
 * The child is scrubbed in the PARENT's region, which is where
 * `NestedStackProvider` deploys it. A row whose template file the synth output
 * does not name becomes a refusal target rather than a failure, so a child
 * that never had a record is not reported.
 */
export function nestedChildWorkItem(
  parent: StackInfo,
  region: string,
  child: NestedChildScrubTarget
): ScrubWorkItem {
  return {
    stackName: child.stackName,
    region,
    ...(child.input && { parentRow: { stackName: parent.stackName, logicalId: child.logicalId } }),
    load: () => {
      const templatePath = parent.nestedTemplates?.[child.logicalId];
      if (child.refusal !== undefined || templatePath === undefined) {
        const nestedChild: NestedChildScrubTarget =
          child.refusal !== undefined
            ? child
            : {
                logicalId: child.logicalId,
                stackName: child.stackName,
                refusal: nestedChildRefusal(
                  child.stackName,
                  'the synth output names no template file for its row ' +
                    "(Metadata['aws:asset:path']), so scrub has no template to learn its " +
                    'secrets from',
                  `Re-synthesize with a CDK version that emits it, then re-run ${cdkdRemedy('cdkd scrub')}.`
                ),
              };
        return {
          stack: {
            stackName: child.stackName,
            displayName: child.stackName,
            artifactId: parent.artifactId,
            template: {} as CloudFormationTemplate,
            dependencyNames: [],
            region,
          },
          nestedChild,
        };
      }
      const { template, nestedTemplates } = readNestedChildTemplate(templatePath);
      return {
        stack: {
          stackName: child.stackName,
          displayName: child.stackName,
          artifactId: parent.artifactId,
          template,
          dependencyNames: [],
          region,
          ...(Object.keys(nestedTemplates).length > 0 && { nestedTemplates }),
        },
        nestedChild: child,
      };
    },
  };
}

/**
 * Rewrite a parent row's `Outputs.<Name>` attributes that hold this child's
 * output plaintext (go-to-k/cdkd#3961). Returns how many it changed (under
 * `dryRun`, would change).
 *
 * NON-FABRICATING by construction: an attribute is rewritten only when the
 * child's scrubbed output under that name, with every expression this run
 * recorded replaced by the plaintext it resolved to, is EXACTLY the stored
 * attribute — so the attribute is that output's plaintext, and it is rewritten
 * to the output itself, the value `buildOutputsAttributes` would copy there on
 * the child's next deploy. No positioning rule is involved, so a key the
 * child's own pass positioned (two stages of one secret) or repaired only by
 * the widened union is recognised alike, and an unrelated value never matches.
 * An attribute that still holds a recorded plaintext but matches no output is
 * returned in `unmatched`, for the caller to report.
 *
 * Under the PARENT's lock, since it rewrites the parent's record (its own
 * scrub released that lock before the child ran). An absent record or row is
 * nothing to do; a record whose resources cannot be read was already reported
 * by the parent's own scrub.
 */
export async function repairParentOutputAttributes(
  parentRow: { stackName: string; logicalId: string },
  region: string,
  stateBackend: S3StateBackend,
  lockManager: LockManager,
  child: Pick<
    ScrubStackResult,
    'outputs' | 'resolveRecordedExpressions' | 'holdsRecordedPlaintext'
  >,
  dryRun: boolean,
  logger: ReturnType<typeof getLogger>
): Promise<{ changed: number; unmatched: string[] }> {
  const none = { changed: 0, unmatched: [] as string[] };
  const childOutputs = child.outputs;
  if (childOutputs === undefined || !isReadableBag(childOutputs)) return none;
  // The rewrite this record needs, and the attributes holding a recorded
  // plaintext that no child output accounts for EXACTLY.
  const plan = async (): Promise<
    | {
        state: StackState;
        etag: string;
        migrationPending?: boolean | undefined;
        attributes: Record<string, unknown>;
        changed: number;
        unmatched: string[];
      }
    | undefined
  > => {
    const loaded = await stateBackend.getState(parentRow.stackName, region);
    if (!loaded || !hasReadableResources(loaded.state)) return undefined;
    const row = loaded.state.resources[parentRow.logicalId];
    const rowAttributes = row?.attributes;
    if (!row || row.resourceType !== NESTED_STACK_TYPE || !isReadableBag(rowAttributes)) {
      return undefined;
    }
    const attributes: Record<string, unknown> = { ...rowAttributes };
    let changed = 0;
    const unmatched: string[] = [];
    for (const [attributeName, stored] of Object.entries(
      rowAttributes as Record<string, unknown>
    )) {
      if (!attributeName.startsWith('Outputs.')) continue;
      const outputKey = attributeName.slice('Outputs.'.length);
      const expected = Object.hasOwn(childOutputs, outputKey) ? childOutputs[outputKey] : undefined;
      // Already the child's value: nothing to rewrite and nothing to report.
      // Load-bearing, not tidiness: where this run recorded no pair for the
      // expression (an unreadable secret, a collapsed stage on a clean record),
      // resolving it returns it unchanged, and the test below would then
      // "repair" a clean attribute onto itself — a write and a false claim.
      if (expected !== undefined && JSON.stringify(stored) === JSON.stringify(expected)) continue;
      // EXACTLY what the child's output expression resolves to in this run —
      // then the attribute is that output's plaintext, and the child's next
      // deploy would copy `expected` over it.
      if (carriesDynamicReference(expected)) {
        const resolved = child.resolveRecordedExpressions(expected);
        if (JSON.stringify(resolved) === JSON.stringify(stored)) {
          attributes[attributeName] = expected;
          changed++;
          continue;
        }
      }
      // Not rewritable, but not clean either: it still holds a plaintext this
      // run recorded. Reported, so the run is not called clean over it.
      if (child.holdsRecordedPlaintext(stored)) unmatched.push(attributeName);
    }
    return changed > 0 || unmatched.length > 0
      ? {
          state: loaded.state,
          etag: loaded.etag,
          migrationPending: loaded.migrationPending,
          attributes,
          changed,
          unmatched,
        }
      : undefined;
  };
  // Decided WITHOUT the lock first: the common case has nothing to rewrite,
  // and locking the parent again for that would be a write for nothing.
  const preview = await plan();
  if (!preview) return none;
  if (dryRun || preview.changed === 0) {
    return { changed: preview.changed, unmatched: preview.unmatched };
  }
  await lockManager.acquireLockWithRetry(parentRow.stackName, region, undefined, 'scrub');
  try {
    // Re-planned under the lock, so the write is against what the lock guards.
    const locked = await plan();
    if (!locked) return none;
    if (locked.changed > 0) {
      const row = locked.state.resources[parentRow.logicalId]!;
      await saveScrubbedState(
        stateBackend,
        parentRow.stackName,
        region,
        {
          ...locked.state,
          ...stackInstanceIdCarriedFrom(locked.state),
          resources: {
            ...locked.state.resources,
            [parentRow.logicalId]: { ...row, attributes: locked.attributes },
          },
          lastModified: Date.now(),
        },
        locked
      );
    }
    return { changed: locked.changed, unmatched: locked.unmatched };
  } finally {
    await lockManager.releaseLock(parentRow.stackName, region).catch((err: unknown) => {
      // Warned like `scrubStack`'s own release: a lock left behind blocks the
      // next deploy of the parent, and a silent one gives no hint why.
      logger.warn(
        safeMsg`Failed to release lock for ${displayStackName(parentRow.stackName)}: ${describeAwsFailure(err).detail}`
      );
    });
  }
}

/**
 * The line that points a pattern spelled like a nested child's state name
 * (`<parent>~<Child>`) at the parent to name instead (go-to-k/cdkd#2252).
 */
export function nestedStackPatternHint(patterns: readonly string[]): string {
  const parents = patterns
    .map((p) => p.slice(0, p.indexOf('~')))
    .filter((parent) => parent.length > 0)
    .map((parent) => displayStackName(parent));
  return (
    `A nested stack is scrubbed with its parent: name ` +
    `${parents.length > 0 ? parents.join(', ') : 'its parent stack'} instead, which also ` +
    `scrubs every stack nested under it.`
  );
}

/**
 * The `<stack>~...` records in `region` that none of `reached` covers
 * (go-to-k/cdkd#2252), as refusal targets.
 *
 * A record whose FIRST segment after `<stack>~` is a reached child is left to
 * that child's own pass, which runs this check one level down. Of every other
 * record, the TOPMOST are returned: the scrub of each refuses it, and its
 * failure arm runs this check again under it, so a deeper record is named
 * exactly once even when a record between it and `stackName` is missing.
 */
export function unreachedNestedRecords(
  refs: ReadonlyArray<{ stackName: string; region?: string }>,
  stackName: string,
  region: string,
  reached: readonly NestedChildScrubTarget[],
  /** Why nothing reaches them — the caller knows which case applies. */
  cause: string,
  /** What to do about it, which differs by cause as much as the cause does. */
  remedy: string
): NestedChildScrubTarget[] {
  const prefix = `${stackName}~`;
  const reachedIds = new Set(reached.map((child) => child.logicalId));
  const out: NestedChildScrubTarget[] = [];
  for (const ref of refs) {
    if (ref.region !== region || !ref.stackName.startsWith(prefix)) continue;
    const rest = ref.stackName.slice(prefix.length);
    const firstId = rest.split('~')[0] ?? '';
    if (reachedIds.has(firstId)) continue;
    out.push({
      logicalId: rest,
      stackName: ref.stackName,
      refusal: nestedChildRefusal(ref.stackName, cause, remedy),
    });
  }
  // The TOPMOST records only: one whose own ancestor record is also listed is
  // named by that ancestor's pass (a refused record's failure arm lists what
  // is under it), so returning both would visit it twice.
  const names = new Set(out.map((t) => t.stackName));
  return out
    .filter((t) => {
      const segments = t.stackName.split('~');
      for (let n = segments.length - 1; n > stackName.split('~').length; n--) {
        if (names.has(segments.slice(0, n).join('~'))) return false;
      }
      return true;
    })
    .sort((a, b) => a.stackName.localeCompare(b.stackName));
}

/**
 * The refusal a nested child's record earns when scrub cannot derive its
 * needles (go-to-k/cdkd#2252). ONE frame for every cause, so each names the
 * record, says it was NOT examined, and gives a remedy — never a clean verdict
 * over a record scrub did not read. The remedy is per CAUSE: a parent deploy
 * re-runs a child only when the child's row changes, so "redeploy the parent"
 * is offered only where the deploy genuinely creates or removes the row.
 */
export function nestedChildRefusal(childStackName: string, cause: string, remedy: string): string {
  return (
    `Nested stack ${displayStackName(childStackName)} has a state record, but ${cause}. ` +
    `Its record was NOT examined and may still hold plaintext. ${remedy}`
  );
}

/**
 * The child's `Parameters` as the provider would hand them to the child
 * engine, or `undefined` when a value is not one the provider accepts.
 *
 * The coercion is `NestedStackProvider.extractParameters`'s, down to a
 * non-object bag reading as none: a string as is, a
 * number or boolean through `String`, an array of those joined with `,`; any
 * other value — an unresolved intrinsic left in place by a failed resolution
 * among them — has no wire form, so scrub cannot reproduce what the child was
 * deployed with and the caller refuses.
 */
export function nestedChildParameters(resolved: unknown): Record<string, string> | undefined {
  // Absent, `null` or an array: the provider reads each as NO parameters, so
  // scrub does too rather than refusing a child a deploy handled.
  if (resolved === undefined || resolved === null || Array.isArray(resolved)) return {};
  if (typeof resolved !== 'object') return {};
  const scalar = (v: unknown): v is string | number | boolean =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  const out = nullPrototypeRecord<string>();
  for (const [name, value] of Object.entries(resolved as Record<string, unknown>)) {
    if (scalar(value)) out[name] = String(value);
    else if (Array.isArray(value) && value.every(scalar)) out[name] = value.map(String).join(',');
    else return undefined;
  }
  return out;
}
