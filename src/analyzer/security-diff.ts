import type { CloudFormationTemplate } from '../types/resource.js';
import type { PropertyChange, ResourceChange, ResourceState } from '../types/state.js';
import { safeMsg, terminalSafe } from '../utils/display-safe.js';
import { CdkdError } from '../utils/error-handler.js';

/**
 * The security half of `--fail-on=broadening` / `--require-approval=broadening`
 * (go-to-k/cdkd#4601): does a stack's change broaden IAM permissions or
 * security-group rules?
 *
 * The verdict is the AWS CDK CLI's own: `@aws-cdk/cloudformation-diff`'s
 * `fullDiff(old, new).permissionsBroadened`, the value `cdk diff --fail-on` and
 * `cdk deploy --require-approval` read (IAM statements of policies, roles and
 * resource policies, `AWS::Lambda::Permission`, managed-policy attachments,
 * and security-group ingress / egress, standalone rules included). The package
 * is loaded only when a caller asks, so a run without `broadening` pays nothing.
 *
 * What differs is the input. The CDK CLI diffs the template CloudFormation
 * holds against the synthesized one. cdkd keeps no deployed template; its
 * state holds each resource's RESOLVED properties. So both sides are built
 * from the change list this diff or deploy computed (see
 * {@link securityDiffTemplates}), at one resolution level per property.
 */

/** The verdict for one stack, and the CDK CLI's security table for it. */
export interface SecurityDiff {
  /** The change adds a permission or a security-group rule (`permissionsBroadened`). */
  broadening: boolean;
  /**
   * `formatSecurityChanges`' table, made terminal-safe. Empty when no IAM or
   * security-group change was found.
   */
  rendered: string;
}

/**
 * A property recorded masked (`***`) whose template expression, or an input it
 * reads, changed (`maskedExpressionChanged`, go-to-k/cdkd#4543): both sides are
 * `***`, so what it changed to cannot be compared.
 */
export interface MaskedChange {
  logicalId: string;
  resourceType: string;
  path: string;
}

/** The two templates the security diff compares. Exported for tests. */
export interface SecurityDiffTemplates {
  oldTemplate: { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
  newTemplate: { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
  /** Left out of both templates; judged by {@link diffSecurity} on their own. */
  maskedChanges: MaskedChange[];
}

/**
 * A synthetic property change the diff added for a value that did not change
 * in the template: a reference to a replaced or updated resource, or a `NoEcho`
 * parameter that may have moved. The CDK CLI's template diff does not see these
 * (its replacement propagation runs after the IAM changes are taken), so they
 * are left out here too.
 */
function isSyntheticChange(pc: PropertyChange): boolean {
  return (
    pc.replacementPropagated === true || pc.inPlacePropagated === true || pc.noEchoPromoted === true
  );
}

function withChanges(
  base: Record<string, unknown> | undefined,
  changes: readonly PropertyChange[],
  side: 'oldValue' | 'newValue'
): Record<string, unknown> {
  const props: Record<string, unknown> = { ...(base ?? {}) };
  for (const pc of changes) {
    const value = pc[side];
    if (value === undefined) delete props[pc.path];
    else props[pc.path] = value;
  }
  return props;
}

/**
 * Build the old and new templates from a stack's changes, resource by resource:
 *
 * - `CREATE`: only on the new side, as the template declares it (unresolved, as
 *   the CDK CLI sees a new resource).
 * - `DELETE`: only on the old side, with its recorded properties.
 * - `UPDATE` of the type: the recorded type and properties on the old side, the
 *   template's on the new.
 * - other `UPDATE`: the recorded properties on both sides, each changed
 *   property set to the diff's old value on one and its new value on the
 *   other. Those are the values the diff compared: the recorded one and the
 *   template's resolved as far as the diff could. So a policy whose `Resource`
 *   reads `Fn::GetAtt` of an unchanged resource compares as equal ARNs, not as
 *   an ARN against an intrinsic. Synthetic changes ({@link isSyntheticChange})
 *   are skipped, and a masked change goes to `maskedChanges` instead; an update
 *   with nothing else is left out.
 * - `NO_CHANGE`: left out; it is equal on both sides.
 *
 * One consequence, on the safe side: a property that reads a parameter or
 * another stack's output differs here when the resolved value moved, which a
 * template diff cannot see.
 */
export function securityDiffTemplates(
  changes: Iterable<ResourceChange>,
  records: Readonly<Record<string, ResourceState>>
): SecurityDiffTemplates {
  const oldResources: SecurityDiffTemplates['oldTemplate']['Resources'] = {};
  const newResources: SecurityDiffTemplates['newTemplate']['Resources'] = {};
  const maskedChanges: MaskedChange[] = [];
  for (const change of changes) {
    const id = change.logicalId;
    const record = Object.hasOwn(records, id) ? records[id] : undefined;
    switch (change.changeType) {
      case 'CREATE':
        newResources[id] = {
          Type: change.resourceType,
          Properties: { ...(change.desiredProperties ?? {}) },
        };
        break;
      case 'DELETE':
        oldResources[id] = {
          Type: record?.resourceType ?? change.resourceType,
          Properties: { ...(change.currentProperties ?? record?.properties ?? {}) },
        };
        break;
      case 'UPDATE': {
        const pcs = change.propertyChanges ?? [];
        const typeChange = pcs.find((pc) => pc.path === 'Type');
        const oldType = record?.resourceType ?? change.resourceType;
        if (typeChange !== undefined || oldType !== change.resourceType) {
          oldResources[id] = {
            Type: typeof typeChange?.oldValue === 'string' ? typeChange.oldValue : oldType,
            Properties: { ...(change.currentProperties ?? record?.properties ?? {}) },
          };
          newResources[id] = {
            Type: change.resourceType,
            Properties: { ...(change.desiredProperties ?? {}) },
          };
          break;
        }
        for (const pc of pcs) {
          if (pc.maskedExpressionChanged === true && !isSyntheticChange(pc)) {
            maskedChanges.push({ logicalId: id, resourceType: change.resourceType, path: pc.path });
          }
        }
        const real = pcs.filter(
          (pc) => !isSyntheticChange(pc) && pc.maskedExpressionChanged !== true
        );
        if (real.length === 0) break;
        const base = change.currentProperties ?? record?.properties;
        oldResources[id] = { Type: oldType, Properties: withChanges(base, real, 'oldValue') };
        newResources[id] = {
          Type: change.resourceType,
          Properties: withChanges(base, real, 'newValue'),
        };
        break;
      }
      default:
        break;
    }
  }
  return {
    oldTemplate: { Resources: oldResources },
    newTemplate: { Resources: newResources },
    maskedChanges,
  };
}

type CfnDiffModule = typeof import('@aws-cdk/cloudformation-diff');
type CfnDiffUtilModule = typeof import('@aws-cdk/cloudformation-diff/lib/diff/util.js');

let cfnDiffModule: Promise<CfnDiffModule> | undefined;

/** The package, loaded once and only on first use. */
function loadCfnDiff(): Promise<CfnDiffModule> {
  cfnDiffModule ??= import('@aws-cdk/cloudformation-diff').then(
    // A CommonJS package: Node exposes its exports as named exports, a bundler may
    // only as `default`.
    (mod) => ((mod as { default?: CfnDiffModule }).default ?? mod) as CfnDiffModule
  );
  return cfnDiffModule;
}

let cfnDiffUtilModule: Promise<CfnDiffUtilModule> | undefined;

/** `loadResourceModel`, from the same package (no `exports` map gates the path). */
function loadCfnDiffUtil(): Promise<CfnDiffUtilModule> {
  cfnDiffUtilModule ??= import('@aws-cdk/cloudformation-diff/lib/diff/util.js').then(
    (mod) => ((mod as { default?: CfnDiffUtilModule }).default ?? mod) as CfnDiffUtilModule
  );
  return cfnDiffUtilModule;
}

/**
 * Is this a property the security diff reads? The same metadata
 * `@aws-cdk/cloudformation-diff` selects its IAM and security-group changes by:
 * a resource scrutinized as a whole (a policy resource, a Lambda permission, a
 * standalone ingress rule), or a scrutinized property (inline policies, managed
 * policies, ingress / egress rules). A resource scrutinized as a whole counts
 * for every property, its name included: asking about a masked name change is
 * the safe side of a gate that cannot tell.
 */
function isScrutinized(util: CfnDiffUtilModule, change: MaskedChange): boolean {
  const model = util.loadResourceModel(change.resourceType) as
    | { scrutinizable?: string; properties?: Record<string, { scrutinizable?: string }> }
    | undefined;
  const scrutinized = (value: string | undefined): boolean =>
    value !== undefined && value !== 'None';
  return (
    scrutinized(model?.scrutinizable) ||
    scrutinized(model?.properties?.[change.path]?.scrutinizable)
  );
}

/**
 * The security diff of one stack's changes. `template` (the new template) only
 * names resources by their `aws:cdk:path` in the table; records do for a
 * resource the template no longer declares.
 *
 * `secretMask` is for changes that may hold secret plaintext (a deploy's
 * resolved values): the verdict reads every value, but the TABLE is rendered
 * from copies in which each key and leaf holding text the mask would hide reads
 * `***` (`withholdSecrets`); a mask that cannot be built or throws hides the
 * whole table. Masking the values before rendering, rather than the printed
 * table, is what keeps a secret the table wraps across two lines from slipping
 * past. `cdkd diff` passes the node's printing mask.
 *
 * A failure to compute it throws: a gate that cannot decide must not pass.
 */
export async function diffSecurity(args: {
  stackName: string;
  changes: Iterable<ResourceChange>;
  records: Readonly<Record<string, ResourceState>>;
  template?: CloudFormationTemplate | undefined;
  secretMask?: (() => (text: string) => string) | undefined;
}): Promise<SecurityDiff> {
  const templates = securityDiffTemplates(args.changes, args.records);
  const { oldTemplate, newTemplate } = templates;
  if (
    Object.keys(oldTemplate.Resources).length === 0 &&
    Object.keys(newTemplate.Resources).length === 0 &&
    templates.maskedChanges.length === 0
  ) {
    return { broadening: false, rendered: '' };
  }
  try {
    const cfnDiff = await loadCfnDiff();
    // A masked security property that changed cannot be judged, so it counts
    // as broadening: a gate that cannot decide must not pass. Only its
    // location is printed, never a value.
    const unjudged =
      templates.maskedChanges.length === 0
        ? []
        : await loadCfnDiffUtil().then((util) =>
            templates.maskedChanges.filter((c) => isScrutinized(util, c))
          );
    // `fullDiff` normalizes both templates IN PLACE; these are our own copies.
    const diff = cfnDiff.fullDiff(structuredClone(oldTemplate), structuredClone(newTemplate));
    const broadening = diff.permissionsBroadened || unjudged.length > 0;
    const unjudgedNote =
      unjudged.length === 0
        ? ''
        : 'These changed values are masked, so whether they broaden permissions could not be evaluated:\n' +
          unjudged.map((c) => `  ${c.logicalId} (${c.resourceType}): ${c.path}\n`).join('');
    if (!diff.permissionsBroadened && !diff.permissionsAnyChanges) {
      return { broadening, rendered: terminalSafe(unjudgedNote) };
    }
    // The table is display only: once the verdict stands, a table that cannot
    // be built or checked for secrets is left out rather than failing the gate
    // or printing unchecked values.
    let table: string;
    try {
      const shown =
        args.secretMask === undefined ? undefined : withholdSecrets(templates, args.secretMask());
      const shownDiff =
        shown === undefined || shown.masked === 0
          ? diff
          : cfnDiff.fullDiff(shown.templates.oldTemplate, shown.templates.newTemplate);
      table = '';
      const stream = {
        write(chunk: unknown): boolean {
          table += String(chunk);
          return true;
        },
      } as unknown as NodeJS.WritableStream;
      cfnDiff.formatSecurityChanges(
        stream,
        shownDiff,
        logicalIdToPath(args.records, args.template)
      );
      if (shown !== undefined && shown.masked > 0) {
        table += '(Values that hold a secret are shown as ***.)\n';
      }
    } catch {
      table = 'The security changes are not shown: they could not be checked for secrets.\n';
    }
    return { broadening, rendered: terminalSafe(table + unjudgedNote) };
  } catch (error) {
    throw new CdkdError(
      safeMsg`Could not compute the security diff of stack ${args.stackName}, so whether its changes broaden permissions is unknown: ${error instanceof Error ? error.message : String(error)}`,
      'SECURITY_DIFF_FAILED'
    );
  }
}

/** Does any key or string leaf of `value` hold text `mask` would hide? */
function holdsSecret(value: unknown, mask: (text: string) => string): boolean {
  if (typeof value === 'string') return mask(value) !== value;
  // A `Number` NoEcho parameter (a port) is a needle in its text form.
  if (typeof value === 'number' || typeof value === 'boolean') {
    return mask(String(value)) !== String(value);
  }
  if (Array.isArray(value)) return value.some((v) => holdsSecret(v, mask));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => mask(k) !== k || holdsSecret(v, mask));
  }
  return false;
}

/** `value` with every leaf (and key) that holds a secret replaced by `***`. */
function maskLeaves(value: unknown, mask: (text: string) => string, keys = true): unknown {
  if (Array.isArray(value)) return value.map((v) => maskLeaves(v, mask, keys));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]): [string, unknown] => [
      keys && mask(k) !== k ? '***' : k,
      maskLeaves(v, mask, keys),
    ]);
    // Two keys masked to one would silently drop an entry: mask it whole.
    if (new Set(entries.map(([k]) => k)).size < entries.length) return '***';
    return Object.fromEntries(entries);
  }
  return holdsSecret(value, mask) ? '***' : value;
}

/**
 * Copies of the templates in which every key and leaf that holds a secret
 * reads `***`, so the table still shows the change around it (a policy's
 * statements beside a secret-derived role name). A property whose NEW side
 * holds one and that changed has EVERY leaf of its old side masked: the old
 * value may be an earlier secret the mask no longer knows. `masked` counts the properties
 * touched (any one means the masked copies are what is rendered).
 */
function withholdSecrets(
  templates: SecurityDiffTemplates,
  mask: (text: string) => string
): { templates: SecurityDiffTemplates; masked: number } {
  const copy = structuredClone(templates);
  let masked = 0;
  const ids = new Set([
    ...Object.keys(copy.oldTemplate.Resources),
    ...Object.keys(copy.newTemplate.Resources),
  ]);
  for (const id of ids) {
    const oldProps = copy.oldTemplate.Resources[id]?.Properties;
    const newProps = copy.newTemplate.Resources[id]?.Properties;
    const keys = new Set([...Object.keys(oldProps ?? {}), ...Object.keys(newProps ?? {})]);
    for (const key of keys) {
      const oldValue = oldProps?.[key];
      const newValue = newProps?.[key];
      const newHolds = holdsSecret(newValue, mask);
      if (!newHolds && !holdsSecret(oldValue, mask)) continue;
      masked++;
      if (newProps !== undefined && newValue !== undefined) {
        newProps[key] = maskLeaves(newValue, mask);
      }
      if (oldProps === undefined || oldValue === undefined) continue;
      if (newHolds && JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        oldProps[key] = maskLeaves(oldValue, () => '***', false);
      } else {
        oldProps[key] = maskLeaves(oldValue, mask);
      }
    }
  }
  return { templates: copy, masked };
}

function logicalIdToPath(
  records: Readonly<Record<string, ResourceState>>,
  template: CloudFormationTemplate | undefined
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [id, record] of Object.entries(records)) {
    if (typeof record?.constructPath === 'string') map[id] = record.constructPath;
  }
  for (const [id, resource] of Object.entries(template?.Resources ?? {})) {
    const path = (resource?.Metadata as Record<string, unknown> | undefined)?.['aws:cdk:path'];
    if (typeof path === 'string') map[id] = path;
  }
  return map;
}
