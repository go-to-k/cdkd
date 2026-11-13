import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';
import { CDK_ASSET_IMAGE_REPO_RE, extractEcrRepoComponent, extractImageString } from './image.js';
import { sameStackRoleLogicalId } from './role-arn.js';
import type { EcsImageResolutionNeeds } from './types.js';

export function detectEcsImageResolutionNeeds(stack: StackInfo): EcsImageResolutionNeeds {
  const resources = stack.template.Resources ?? {};
  let needsPseudoParameters = false;
  let needsStateResources = false;
  let needsEnvOrSecretSubstitution = false;
  let needsCrossStackResolver = false;
  let needsAssetRepoMarker = false;
  let needsTaskRoleState = false;

  for (const res of Object.values(resources)) {
    if (res.Type !== 'AWS::ECS::TaskDefinition') continue;
    const props = res.Properties ?? {};
    const containers = Array.isArray(props['ContainerDefinitions'])
      ? props['ContainerDefinitions']
      : [];
    for (const c of containers) {
      if (!c || typeof c !== 'object') continue;
      const co = c as Record<string, unknown>;
      const image = co['Image'];
      const need = inspectImageForSubstitutions(image, resources);
      if (need.pseudo) needsPseudoParameters = true;
      if (need.state) needsStateResources = true;
      // Issue #1025: an ECR-hosted image whose repo component is not one
      // of the conventional container-assets shapes may still be a cdkd
      // asset image published to a custom-named repo (`cdkd bootstrap
      // --container-repo`). Only the region's bootstrap marker can tell,
      // so flag it for the CLI's lazy marker read. Known asymmetry: only
      // flat-extractable images are inspected, so a stack whose ONLY
      // candidate images are `Fn::GetAtt` / `Fn::Join` shapes never
      // triggers the marker read even though `classifyResolvedImage`
      // would consume the name — acceptable because those shapes resolve
      // via state-recorded USER repos, not the cdkd asset repo (design
      // 1002 §7.1: synth output stays unrewritten).
      const flat = extractImageString(image);
      if (
        flat !== undefined &&
        extractEcrRepoComponent(flat) !== undefined &&
        !CDK_ASSET_IMAGE_REPO_RE.test(flat)
      ) {
        needsAssetRepoMarker = true;
      }
      if (containerHasIntrinsicEnvOrSecret(co)) needsEnvOrSecretSubstitution = true;
      if (containerHasCrossStackEnvOrSecret(co)) {
        needsEnvOrSecretSubstitution = true;
        needsCrossStackResolver = true;
      }
    }
    // Volumes[].Host.SourcePath as a CFn intrinsic (Gap 6 of #286).
    const rawVolumes = props['Volumes'];
    if (Array.isArray(rawVolumes)) {
      for (const v of rawVolumes) {
        if (volumeHasIntrinsicSourcePath(v)) {
          needsEnvOrSecretSubstitution = true;
          break;
        }
      }
    }
    // A same-stack role's deployed name is only in the state record
    // (go-to-k/cdkd#6189). Its own flag: the CLI loads state for it only on
    // the bare `--assume-task-role` path, the one reader of the task role.
    if (sameStackRoleLogicalId(props['TaskRoleArn'], resources) !== undefined) {
      needsTaskRoleState = true;
    }
    // TaskRoleArn / ExecutionRoleArn as a Fn::Sub / Fn::Join intrinsic
    // (Gap 5 of #286).
    if (
      isFnJoinOrSubIntrinsic(props['TaskRoleArn']) ||
      isFnJoinOrSubIntrinsic(props['ExecutionRoleArn'])
    ) {
      needsEnvOrSecretSubstitution = true;
    }
  }
  return {
    needsPseudoParameters,
    needsStateResources,
    needsEnvOrSecretSubstitution,
    needsCrossStackResolver,
    needsAssetRepoMarker,
    needsTaskRoleState,
  };
}

/**
 * Returns true when any `Environment[].Value` or `Secrets[].ValueFrom`
 * is a top-level `Fn::ImportValue` / `Fn::GetStackOutput` intrinsic.
 * Issue #454 — gates cross-stack resolver construction so literal +
 * same-stack-intrinsic env / secret maps don't pay the extra cost.
 */
function containerHasCrossStackEnvOrSecret(c: Record<string, unknown>): boolean {
  const env = c['Environment'];
  if (Array.isArray(env)) {
    for (const entry of env) {
      if (!entry || typeof entry !== 'object') continue;
      const v = (entry as Record<string, unknown>)['Value'];
      if (isCrossStackIntrinsic(v)) return true;
    }
  }
  const secrets = c['Secrets'];
  if (Array.isArray(secrets)) {
    for (const entry of secrets) {
      if (!entry || typeof entry !== 'object') continue;
      const v = (entry as Record<string, unknown>)['ValueFrom'];
      if (isCrossStackIntrinsic(v)) return true;
    }
  }
  return false;
}

export function isCrossStackIntrinsic(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return 'Fn::ImportValue' in obj || 'Fn::GetStackOutput' in obj;
}

/**
 * Detect whether a Volume entry has an intrinsic-valued `Host.SourcePath`.
 * Used by `detectEcsImageResolutionNeeds` (Gap 6 of #286) to trigger
 * state-load + pseudo-parameter resolution under `--from-state` when the
 * SourcePath is built via `cdk.Fn.sub(...)` / `cdk.Fn.join(...)`.
 */
function volumeHasIntrinsicSourcePath(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const host = (v as Record<string, unknown>)['Host'];
  if (!host || typeof host !== 'object') return false;
  const sp = (host as Record<string, unknown>)['SourcePath'];
  if (sp === undefined || sp === null) return false;
  if (typeof sp === 'string') return false;
  return typeof sp === 'object';
}

/**
 * Detect whether a value is an `Fn::Sub` / `Fn::Join` intrinsic. Used by
 * `detectEcsImageResolutionNeeds` to flag role-ARN intrinsic shapes
 * (Gap 5 of #286) that need `--from-state` + pseudo-parameter
 * substitution. `Ref` / `Fn::GetAtt` shapes are `needsTaskRoleState`'s
 * (go-to-k/cdkd#6189) and are intentionally excluded here.
 */
function isFnJoinOrSubIntrinsic(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return 'Fn::Join' in obj || 'Fn::Sub' in obj;
}

/**
 * Returns true when any `Environment[].Value` or `Secrets[].ValueFrom`
 * is an intrinsic (non-literal). Used to gate `--from-state` state
 * loading at the CLI layer — issue #291.
 */
function containerHasIntrinsicEnvOrSecret(c: Record<string, unknown>): boolean {
  const env = c['Environment'];
  if (Array.isArray(env)) {
    for (const entry of env) {
      if (!entry || typeof entry !== 'object') continue;
      const v = (entry as Record<string, unknown>)['Value'];
      if (
        v !== undefined &&
        typeof v !== 'string' &&
        typeof v !== 'number' &&
        typeof v !== 'boolean'
      ) {
        return true;
      }
    }
  }
  const secrets = c['Secrets'];
  if (Array.isArray(secrets)) {
    for (const entry of secrets) {
      if (!entry || typeof entry !== 'object') continue;
      const v = (entry as Record<string, unknown>)['ValueFrom'];
      if (v !== undefined && typeof v !== 'string') return true;
    }
  }
  return false;
}

function inspectImageForSubstitutions(
  image: unknown,
  resources: Record<string, TemplateResource>
): { pseudo: boolean; state: boolean } {
  if (!image || typeof image !== 'object') return { pseudo: false, state: false };
  const obj = image as Record<string, unknown>;

  // Fn::GetAtt direct shape against an ECR::Repository — Tier 2 only.
  const getAtt = obj['Fn::GetAtt'];
  if (getAtt !== undefined) {
    let lid: string | undefined;
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') lid = getAtt[0];
    else if (typeof getAtt === 'string') lid = getAtt.split('.')[0];
    if (lid && resources[lid]?.Type === 'AWS::ECR::Repository') {
      return { pseudo: false, state: true };
    }
  }

  // Fn::Join body: recursively walk every element for references that
  // would trigger Tier 1 (pseudo) / Tier 2 (state) needs. CDK 2.x
  // synthesizes `ContainerImage.fromEcrRepository(repo)` as a Fn::Join
  // containing nested Fn::Select / Fn::Split over the repo's Arn GetAtt
  // plus a Ref to the repo and `Ref: AWS::URLSuffix`.
  const join = obj['Fn::Join'];
  if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
    const scan: { pseudo: boolean; state: boolean } = { pseudo: false, state: false };
    inspectIntrinsicNeeds(join[1], resources, scan);
    if (scan.pseudo || scan.state) return scan;
  }

  // Fn::Sub body: scan every `${...}` placeholder.
  let sub: string | undefined;
  const subRaw = obj['Fn::Sub'];
  if (typeof subRaw === 'string') sub = subRaw;
  else if (Array.isArray(subRaw) && typeof subRaw[0] === 'string') sub = subRaw[0];
  if (!sub) return { pseudo: false, state: false };

  let pseudo = false;
  let state = false;
  const placeholderRegex = /\$\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = placeholderRegex.exec(sub)) !== null) {
    const key = m[1]!;
    if (key.startsWith('AWS::')) {
      pseudo = true;
      continue;
    }
    const dot = key.indexOf('.');
    const lid = dot === -1 ? key : key.slice(0, dot);
    if (resources[lid]?.Type === 'AWS::ECR::Repository') state = true;
  }
  return { pseudo, state };
}

/**
 * Recursive needs probe used by `inspectImageForSubstitutions` for the
 * `Fn::Join` shape: walk every nested intrinsic and flag whether a
 * `Ref: AWS::*` pseudo parameter is reachable (Tier 1 needed) or a
 * `Ref` / `Fn::GetAtt` against an `AWS::ECR::Repository` is reachable
 * (Tier 2 needed).
 */
function inspectIntrinsicNeeds(
  node: unknown,
  resources: Record<string, TemplateResource>,
  scan: { pseudo: boolean; state: boolean }
): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const item of node) inspectIntrinsicNeeds(item, resources, scan);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if (typeof obj['Ref'] === 'string') {
    const target = obj['Ref'];
    if (target.startsWith('AWS::')) scan.pseudo = true;
    else if (resources[target]?.Type === 'AWS::ECR::Repository') scan.state = true;
    return;
  }

  const getAtt = obj['Fn::GetAtt'];
  if (getAtt !== undefined) {
    let lid: string | undefined;
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') lid = getAtt[0];
    else if (typeof getAtt === 'string') lid = getAtt.split('.')[0];
    if (lid && resources[lid]?.Type === 'AWS::ECR::Repository') scan.state = true;
    return;
  }

  // For every other intrinsic shape, descend into its arguments so a
  // `Fn::Select` / `Fn::Split` / `Fn::Join` / `Fn::Sub` wrapper does
  // not hide a reference deeper in the tree.
  for (const value of Object.values(obj)) {
    inspectIntrinsicNeeds(value, resources, scan);
  }
}
