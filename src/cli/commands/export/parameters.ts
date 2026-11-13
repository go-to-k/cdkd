import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { displayIdent } from '../../../utils/display-safe.js';
import { type Parameter } from '@aws-sdk/client-cloudformation';
import { CdkdError } from '../../../utils/error-handler.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../deployment/intrinsic-function-resolver.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import { type StackState } from '../../../types/state.js';
import { SECRET_MASK } from '../../../deployment/secret-redaction.js';
import { stateSecretNameNeedles } from '../../../deployment/secret-name-needles.js';
import { type CdkdStateStackTree, quotedOrNotShown, recordValueOrNotShown } from './render.js';
import { flattenCdkdStateTreeRootFirst } from './stack-tree.js';
import { stackIdTailOf } from '../../../state/stack-id-tail.js';

/**
 * Strip the template down to only the resources we intend to import.
 *
 * CloudFormation `ChangeSetType=IMPORT` requires every resource in the
 * template to appear in `ResourcesToImport`; anything extra causes the
 * changeset to fail. Outputs that reference a removed resource are also
 * stripped to avoid Ref-to-nonexistent errors.
 */
/**
 * Parse `--parameter Key=Value` CLI tokens into a `{Key: Value}` map.
 * Exported for unit testing.
 */
export function parseParameterOverrides(tokens: string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!tokens) return map;
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq < 1) {
      throw new Error(
        `Invalid --parameter ${quotedOrNotShown(t)}: expected 'Key=Value' (e.g. --parameter Env=prod)`
      );
    }
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1);
    if (!key) {
      throw new Error(`Invalid --parameter ${quotedOrNotShown(t)}: key is empty`);
    }
    map[key] = value;
  }
  return map;
}

/**
 * Build the `Parameters` array CFn `CreateChangeSetCommand` expects from
 * the synthesized template's `Parameters` section, applying user
 * `--parameter Key=Value` overrides.
 *
 * Resolution order per parameter:
 *   1. User-supplied override (`--parameter Key=Value`)
 *   2. Template `Default`
 *   3. Abort: missing required parameter
 *
 * SSM-typed parameters (`AWS::SSM::Parameter::Value<...>`) are passed
 * through verbatim — CFn resolves the SSM path at changeset execution
 * time, so cdkd does not need to make an extra SSM API call.
 *
 * Exported for unit testing.
 */
export function resolveTemplateParameters(
  template: Record<string, unknown>,
  userOverrides: Record<string, string>
): { parameters: Parameter[]; missing: string[] } {
  const tplParams = template['Parameters'];
  if (!tplParams || typeof tplParams !== 'object' || Array.isArray(tplParams)) {
    // Template has no Parameters section — nothing to forward.
    const stray = Object.keys(userOverrides);
    if (stray.length > 0) {
      throw new Error(
        `--parameter override(s) supplied (${stray.map((n) => quotedOrNotShown(n)).join(', ')}) ` +
          `but template has no Parameters section.`
      );
    }
    return { parameters: [], missing: [] };
  }

  const parameters: Parameter[] = [];
  const missing: string[] = [];
  const known = new Set<string>();

  for (const [name, raw] of Object.entries(tplParams as Record<string, unknown>)) {
    known.add(name);
    const def = (raw ?? {}) as { Default?: unknown };
    const override = userOverrides[name];
    if (override !== undefined) {
      parameters.push({ ParameterKey: name, ParameterValue: override });
      continue;
    }
    if ('Default' in def) {
      // Coerce non-string defaults (numbers, lists) to the string form CFn expects.
      const value = typeof def.Default === 'string' ? def.Default : String(def.Default);
      parameters.push({ ParameterKey: name, ParameterValue: value });
      continue;
    }
    missing.push(name);
  }

  // Catch typos: a --parameter override for a parameter the template does NOT declare.
  for (const name of Object.keys(userOverrides)) {
    if (!known.has(name)) {
      throw new Error(
        `--parameter override ${quotedOrNotShown(name)} does not match any parameter in the ` +
          `synthesized template (template declares: ` +
          `${[...known].map((n) => quotedOrNotShown(n)).join(', ') || '(none)'})`
      );
    }
  }

  return { parameters, missing };
}

/**
 * The root template's Parameter values as `--parameter` / `Default` give them,
 * for the IAM::Policy template check (go-to-k/cdkd#3910). An override the
 * template does not declare throws later, where the export resolves the
 * changeset's parameters; here it simply yields nothing to resolve with.
 */
export function rootParameterValues(
  template: Record<string, unknown>,
  parameterFlags: string[] | undefined
): Record<string, string> {
  try {
    const { parameters } = resolveTemplateParameters(
      template,
      parseParameterOverrides(parameterFlags)
    );
    return parameterValuesOf(parameters);
  } catch {
    return {};
  }
}

export function parameterValuesOf(parameters: readonly Parameter[]): Record<string, string> {
  const out = nullPrototypeRecord<string>();
  for (const p of parameters) {
    if (typeof p.ParameterKey === 'string' && typeof p.ParameterValue === 'string') {
      out[p.ParameterKey] = p.ParameterValue;
    }
  }
  return out;
}

/** `AWS::SSM::Parameter::Value<...>`: the parameter's value is an SSM NAME CloudFormation resolves. */
export function isSsmParameterType(type: unknown): boolean {
  return typeof type === 'string' && type.startsWith('AWS::SSM::Parameter::Value<');
}

/** `AWS::SSM::Parameter::Value<List<...>>` / `<CommaDelimitedList>`: the stored value is a list. */
function isSsmListParameterType(type: unknown): boolean {
  if (!isSsmParameterType(type)) return false;
  const inner = (type as string).slice('AWS::SSM::Parameter::Value<'.length);
  return inner.startsWith('List<') || inner.startsWith('CommaDelimitedList>');
}

/**
 * Extract a child-IMPORT Parameter map from the parent template's
 * `Resources[<childLogicalId>].Properties.Parameters` block.
 *
 * CDK nested stacks pass parent → child Parameter values via the parent's
 * `AWS::CloudFormation::Stack.Properties.Parameters` map. For the LEAF
 * child IMPORT (which submits the child as a fresh standalone CFn stack),
 * cdkd must forward those values — otherwise the child template's
 * `Parameters` block goes unresolved and CFn rejects the changeset.
 *
 * This helper only classifies literal-string / number / boolean values
 * (forwarded directly) vs. intrinsic values (`{Ref: ...}` /
 * `{Fn::GetAtt: ...}` referencing the parent's own resources), which it
 * reports in `intrinsicSkipped`. Intrinsic resolution itself is layered on
 * top by {@link resolveChildImportParameters}, which runs the deploy
 * engine's `IntrinsicFunctionResolver` against the parent's state and only
 * falls back to "skip" (the original behavior) when the resolver cannot
 * handle a value. Callers that want resolved Parameters should use
 * {@link resolveChildImportParameters}; this sync helper stays for the
 * literal-classification step and its existing unit tests.
 *
 * Exported for unit testing.
 */
export function extractChildImportParameters(
  parentTemplate: Record<string, unknown>,
  childLogicalId: string
): { params: Parameter[]; intrinsicSkipped: string[] } {
  const resources = parentTemplate['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return { params: [], intrinsicSkipped: [] };
  }
  const row = (resources as Record<string, unknown>)[childLogicalId];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { params: [], intrinsicSkipped: [] };
  }
  const props = (row as { Properties?: unknown }).Properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    return { params: [], intrinsicSkipped: [] };
  }
  const rawParams = (props as { Parameters?: unknown }).Parameters;
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return { params: [], intrinsicSkipped: [] };
  }
  const out: Parameter[] = [];
  const intrinsicSkipped: string[] = [];
  for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out.push({ ParameterKey: k, ParameterValue: v });
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out.push({ ParameterKey: k, ParameterValue: String(v) });
    } else {
      intrinsicSkipped.push(k);
    }
  }
  return { params: out, intrinsicSkipped };
}

/**
 * Async wrapper around {@link extractChildImportParameters} that resolves
 * intrinsic-valued (`{Ref: ...}` / `{Fn::GetAtt: ...}` / `Fn::Sub` etc.)
 * Parameters via the deploy engine's {@link IntrinsicFunctionResolver}
 * before falling back to the warn+skip path. This is the closing-loop
 * for the per-stack IMPORT design: CFn's atomic nested-stack create
 * implicitly resolved these against the parent's own scope, but cdkd's
 * leaf-first per-stack IMPORT loop submits each child as a standalone
 * stack — so AWS has no parent context to resolve against, and cdkd must
 * do the resolution itself.
 *
 * Behavior (Option 1 — CDK-compatible graceful degradation):
 *   - For each entry that {@link extractChildImportParameters} reported as
 *     `intrinsicSkipped`, look up the original intrinsic value in the
 *     parent template and call `resolver.resolve(value, parentContext)`.
 *   - On success: coerce the resolved scalar (string / number / boolean /
 *     array-of-strings) to a CFn Parameter string and append to `params`.
 *   - On throw OR on unsupported result shape (object / null / undefined):
 *     keep the key in `intrinsicSkipped` — the orchestrator's existing
 *     warn-then-fall-back-to-child-Default path takes over (matches the
 *     pre-resolver behavior for unresolvable cases, so adding the resolver
 *     never makes a working scenario regress).
 *
 * The `parentContext` must be built from the PARENT's data — its template,
 * its cdkd state's `resources` (for `Ref` to parent resources and
 * `Fn::GetAtt` to parent resource attributes), and its already-resolved
 * Parameter values (for `Ref` to parent Parameters). For nested grandparent
 * chains, the parent's resolved Parameters themselves come from the
 * top-down pre-pass in {@link buildResolvedParametersPerStack} — that's
 * why parameter resolution must happen ROOT-FIRST (parent before child),
 * even though the IMPORT loop itself is leaf-first.
 *
 * Exported for unit testing.
 */
export async function resolveChildImportParameters(
  parentTemplate: Record<string, unknown>,
  parentResolverContext: ResolverContext,
  childLogicalId: string,
  resolver: IntrinsicFunctionResolver
): Promise<{ params: Parameter[]; intrinsicSkipped: string[] }> {
  const base = extractChildImportParameters(parentTemplate, childLogicalId);
  if (base.intrinsicSkipped.length === 0) {
    return base;
  }
  // Re-walk the parent template to recover the original intrinsic values
  // for each `intrinsicSkipped` key (the base helper threw away the values
  // when classifying as non-literal — that helper stays unchanged for
  // back-compat with its existing sync unit tests).
  const resources = parentTemplate['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return base;
  }
  const row = (resources as Record<string, unknown>)[childLogicalId];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return base;
  }
  const props = (row as { Properties?: unknown }).Properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    return base;
  }
  const rawParams = (props as { Parameters?: unknown }).Parameters;
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return base;
  }

  const resolvedParams: Parameter[] = [...base.params];
  const stillSkipped: string[] = [];
  for (const key of base.intrinsicSkipped) {
    const intrinsicValue = (rawParams as Record<string, unknown>)[key];
    let result: unknown;
    try {
      result = await resolver.resolve(intrinsicValue, parentResolverContext);
    } catch {
      // Resolver threw (most commonly: `Ref` to a Parameter not present in
      // context, `Fn::GetAtt` to a resource attr cdkd state didn't capture,
      // or an unsupported intrinsic shape). Fall back to the pre-resolver
      // behavior — keep in skipped, the orchestrator's existing warn path
      // tells the user to verify the child template's Defaults cover it.
      stillSkipped.push(key);
      continue;
    }
    // go-to-k/cdkd#4043 Phase C: a value the parent's state holds only as the
    // redaction mask (a declared-`NoEcho` attribute, a `NoEcho` position)
    // resolves to `***`, whole or embedded. It is REFUSED, never passed to
    // CloudFormation and never replaced by the child's `Default`: either
    // would declare a value the live child was not deployed with.
    if (JSON.stringify(result ?? null).includes(SECRET_MASK)) {
      throw new CdkdError(
        `Cannot export the nested stack row ${quotedOrNotShown(childLogicalId)}: its parameter ` +
          `${quotedOrNotShown(key)} resolves from a value cdkd stores only as the redaction mask ` +
          `(***), a NoEcho value, so the export has no value to pass to the child. ` +
          `Export the stack without that nested stack and adopt it into CloudFormation by hand, ` +
          `passing the parameter value yourself.`,
        'EXPORT_MASKED_CHILD_PARAMETER'
      );
    }
    if (result === undefined || result === null) {
      stillSkipped.push(key);
      continue;
    }
    if (typeof result === 'string') {
      resolvedParams.push({ ParameterKey: key, ParameterValue: result });
    } else if (typeof result === 'number' || typeof result === 'boolean') {
      resolvedParams.push({ ParameterKey: key, ParameterValue: String(result) });
    } else if (Array.isArray(result)) {
      // CFn Parameter `Type: CommaDelimitedList` accepts comma-joined
      // strings — match CFn's wire shape for an array-typed Parameter.
      // Each element is coerced to string first to tolerate mixed shapes.
      resolvedParams.push({
        ParameterKey: key,
        ParameterValue: (result as unknown[]).map((e) => String(e)).join(','),
      });
    } else {
      // Resolved to an object (e.g. a nested intrinsic that didn't fully
      // collapse, or a structured shape CFn Parameters cannot carry).
      // Treat as unresolvable — keep in skipped so the warn+fallback path
      // surfaces it.
      stillSkipped.push(key);
    }
  }
  return { params: resolvedParams, intrinsicSkipped: stillSkipped };
}

/**
 * Reads one SSM parameter for {@link buildResolvedParametersPerStack}
 * (go-to-k/cdkd#3915). Returns the stored value and the parameter's `Type`;
 * throws the SDK error as is.
 */
export type SsmParameterReader = (name: string) => Promise<{ value: string; type?: string }>;

/**
 * An {@link SsmParameterReader} over `ssm:GetParameter`. `WithDecryption` is
 * never set: a `SecureString` is refused by the caller (CloudFormation does
 * not accept one for an SSM-typed Parameter), so no decrypted value is read.
 */
export function ssmParameterReader(client: AwsClients['ssm']): SsmParameterReader {
  return async (name) => {
    const resp = await client.send(new GetParameterCommand({ Name: name, WithDecryption: false }));
    const value = resp.Parameter?.Value;
    if (typeof value !== 'string') {
      throw Object.assign(new Error('GetParameter returned no value'), { name: 'NoValue' });
    }
    return { value, ...(resp.Parameter?.Type !== undefined && { type: resp.Parameter.Type }) };
  };
}

/**
 * Does the parent's `Properties.Parameters` block of `childLogicalId` mention
 * `name` — a string leaf equal to it (`{Ref: name}`) or one holding `${name}`
 * / `${name.` (`Fn::Sub`)? An over-approximation on purpose: a parameter it
 * wrongly includes costs one SSM read, one it missed would reach the child as
 * the SSM parameter's NAME. A false positive fails CLOSED: if that extra read
 * is refused (no permission, not found, a SecureString), the export refuses
 * although the child never needed the value.
 */
function childRowMentionsParameter(
  parentTemplate: Record<string, unknown>,
  childLogicalId: string,
  name: string
): boolean {
  const resources = parentTemplate['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return false;
  if (!Object.hasOwn(resources, childLogicalId)) return false;
  const row = (resources as Record<string, unknown>)[childLogicalId];
  const props =
    row && typeof row === 'object' ? (row as { Properties?: unknown }).Properties : undefined;
  const rawParams =
    props && typeof props === 'object' ? (props as { Parameters?: unknown }).Parameters : undefined;
  // The `Fn::Sub` reference prefix, built by concatenation: a template
  // literal here would read as an interpolated name.
  const subRef = '$' + '{' + name;
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string')
      return v === name || v.includes(subRef + '}') || v.includes(subRef + '.');
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(walk);
    return false;
  };
  return walk(rawParams);
}

/**
 * {@link resolveSsmParameterForChild}'s refusal. Its own class so a `--dry-run`
 * can warn and plan without the nested stacks' values, as it does for the
 * pre-pass's structural refusals, while a real run refuses.
 */
export class SsmChildParameterRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsmChildParameterRefusalError';
  }
}

/**
 * The value a parent's SSM-typed Parameter (`AWS::SSM::Parameter::Value<...>`)
 * hands a nested child (go-to-k/cdkd#3915). The parent's own changeset submits
 * the SSM parameter's NAME, which CloudFormation resolves; a nested stack is
 * handed the RESOLVED value, and after the export the child is a standalone
 * stack, so cdkd reads it here. Refuses when the parameter cannot be read, and
 * for a `SecureString`, which CloudFormation does not accept for an SSM-typed
 * Parameter, so only a `String` / `StringList` value (public configuration)
 * is ever read, and no refusal renders it.
 */
async function resolveSsmParameterForChild(args: {
  parentStackName: string;
  /** The parent is the root, whose Parameters `--parameter` binds. */
  parentIsRoot: boolean;
  childStackName: string;
  parameterKey: string;
  ssmName: string;
  read: SsmParameterReader | undefined;
  cache: Map<string, Promise<{ value: string; type?: string }>>;
}): Promise<string> {
  const { parentStackName, childStackName, parameterKey, ssmName } = args;
  const context =
    `Stack ${quotedOrNotShown(parentStackName)} passes its SSM-typed Parameter ` +
    // `recordValueOrNotShown`, not `showRecordValue`: the refusal ends on a
    // `--parameter` remedy, and `ssmName` is the parent template's value
    // (the review of go-to-k/cdkd#4245, per go-to-k/cdkd#4229's decision).
    `${quotedOrNotShown(parameterKey)} (SSM parameter ${recordValueOrNotShown(ssmName)}) to nested stack ` +
    `${quotedOrNotShown(childStackName)}. CloudFormation hands a nested stack the parameter's VALUE, ` +
    `and after the export that stack is a standalone CloudFormation stack, so cdkd export reads ` +
    `the value with ssm:GetParameter before migrating anything.`;
  if (args.read === undefined) {
    throw new SsmChildParameterRefusalError(`${context} No SSM client was available to read it.`);
  }
  const read = args.read;
  let got: { value: string; type?: string };
  try {
    let pending = args.cache.get(ssmName);
    if (pending === undefined) {
      // Inside the `try`: a reader that throws synchronously is refused the same way.
      pending = read(ssmName);
      args.cache.set(ssmName, pending);
    }
    got = await pending;
  } catch (err) {
    // The error's NAME only: its message can quote the parameter name back.
    const errName = err instanceof Error ? displayIdent(err.name) : 'an unknown error';
    // `--parameter` binds only the ROOT template's Parameters.
    const remedy = args.parentIsRoot
      ? `Grant ssm:GetParameter on that parameter, or pass a readable one for ` +
        `${quotedOrNotShown(parameterKey)} with '--parameter <Key>=<Name>', and re-run.`
      : `Grant ssm:GetParameter on that parameter, or change the name the parent row passes to ` +
        `${quotedOrNotShown(parameterKey)}, and re-run.`;
    throw new SsmChildParameterRefusalError(`${context} The read failed (${errName}). ${remedy}`);
  }
  // Fails CLOSED: only the two types CloudFormation accepts for an SSM-typed
  // Parameter are handed on. A SecureString arrives undecrypted and is refused.
  if (got.type !== 'String' && got.type !== 'StringList') {
    const what =
      got.type === 'SecureString'
        ? 'It is a SecureString, which CloudFormation does not accept for an SSM-typed Parameter'
        : `Its type is ${got.type === undefined ? 'not reported' : displayIdent(got.type)}, not String or StringList`;
    throw new SsmChildParameterRefusalError(
      `${context} ${what}; pass a String or StringList parameter instead.`
    );
  }
  return got.value;
}

/** Minimal per-stack shape {@link buildResolvedParametersPerStack} reads. */
export interface ResolvedParamsStackNode {
  cdkdName: string;
  template: Record<string, unknown>;
  state: StackState;
}

/**
 * Top-down (root-first) pre-pass that resolves each cdkd stack's
 * child-IMPORT Parameters BEFORE the leaf-first IMPORT loop runs (issue
 * #464 follow-up — intrinsic Parameter resolution at leaf-IMPORT time).
 *
 * Why a separate pre-pass instead of resolving inline in the leaf-first
 * loop: a child's intrinsic-valued Parameter (`{Ref: ParentParam}`) resolves
 * against its PARENT's resolved Parameter values, and for a 3-level tree the
 * middle stack's Parameters are themselves resolved from the root's. So the
 * resolution dependency runs root → leaf, the opposite direction from the
 * IMPORT submission order (leaf → root). Resolving everything up front in
 * root-first order means each child always sees its parent's
 * already-resolved Parameters in `paramsByCdkdName`.
 *
 * Returns:
 *   - `paramsByCdkdName`: cdkdName → the CFn Parameters to submit for that
 *     stack's IMPORT. The root maps to `rootParameters` verbatim (CLI
 *     overrides + template defaults, resolved by the caller already); each
 *     non-root maps to its parent-extracted + intrinsic-resolved values.
 *   - `intrinsicSkippedByCdkdName`: cdkdName → the Parameter names that
 *     STILL could not be resolved (resolver threw / unsupported shape), for
 *     the orchestrator's per-stack warn + aggregate summary.
 *
 * Exported for unit testing.
 */
export async function buildResolvedParametersPerStack(args: {
  rootStackName: string;
  rootParameters: Parameter[];
  perStackNodes: ResolvedParamsStackNode[];
  tree: CdkdStateStackTree;
  resolver: IntrinsicFunctionResolver;
  stateBackend?: S3StateBackend;
  /** Reads a parent's SSM-typed Parameter for a child row (go-to-k/cdkd#3915). */
  readSsmParameter?: SsmParameterReader;
}): Promise<{
  paramsByCdkdName: Map<string, Parameter[]>;
  intrinsicSkippedByCdkdName: Map<string, string[]>;
}> {
  const ssmCache = new Map<string, Promise<{ value: string; type?: string }>>();
  const paramsByCdkdName = new Map<string, Parameter[]>();
  const intrinsicSkippedByCdkdName = new Map<string, string[]>();
  // Root submits the caller-resolved Parameters (CLI overrides / defaults).
  paramsByCdkdName.set(args.rootStackName, args.rootParameters);

  const nodeByName = new Map(args.perStackNodes.map((n) => [n.cdkdName, n]));
  for (const ref of flattenCdkdStateTreeRootFirst(args.tree)) {
    if (ref.stackName === args.rootStackName) continue;
    const node = nodeByName.get(ref.stackName);
    if (!node) {
      throw new Error(
        `buildResolvedParametersPerStack: tree node ${quotedOrNotShown(ref.stackName)} has no per-stack ` +
          `template/state entry. This is a cdkd bug.`
      );
    }
    const parentLogicalId = node.state.parentLogicalId;
    const parentStackName = node.state.parentStack;
    if (!parentLogicalId || !parentStackName) {
      throw new Error(
        `buildResolvedParametersPerStack: child ${quotedOrNotShown(node.cdkdName)} state is missing ` +
          `parentLogicalId / parentStack (v6 fields). Re-deploy or re-import the parent stack.`
      );
    }
    const parentNode = nodeByName.get(parentStackName);
    if (!parentNode) {
      throw new Error(
        `buildResolvedParametersPerStack: child ${quotedOrNotShown(node.cdkdName)} references parent ` +
          `${quotedOrNotShown(parentStackName)} which is not in the per-stack node list — tree shape is inconsistent.`
      );
    }
    // The parent's resolved Parameter VALUES are the lookup table for any
    // `Ref: <ParentParam>` in the child's Parameters block. Root-first order
    // guarantees the parent was already processed.
    // Null prototype: a parameter key is template text, and on a `{}` an
    // assignment to `__proto__` would set the prototype, not an own key.
    const parentParamValues = Object.create(null) as Record<string, unknown>;
    const declaredParentParameters = parentNode.template['Parameters'];
    for (const p of paramsByCdkdName.get(parentStackName) ?? []) {
      if (p.ParameterKey === undefined) continue;
      const type =
        declaredParentParameters &&
        typeof declaredParentParameters === 'object' &&
        Object.hasOwn(declaredParentParameters, p.ParameterKey)
          ? (declaredParentParameters as Record<string, { Type?: unknown } | undefined>)[
              p.ParameterKey
            ]?.Type
          : undefined;
      // An SSM-typed Parameter holds an SSM parameter NAME; the child is handed
      // the value stored under it, as CloudFormation does (go-to-k/cdkd#3915).
      // Only one this child's row mentions is read.
      if (
        !isSsmParameterType(type) ||
        typeof p.ParameterValue !== 'string' ||
        !childRowMentionsParameter(parentNode.template, parentLogicalId, p.ParameterKey)
      ) {
        parentParamValues[p.ParameterKey] = p.ParameterValue;
        continue;
      }
      const stored = await resolveSsmParameterForChild({
        parentStackName,
        parentIsRoot: parentStackName === args.rootStackName,
        childStackName: node.cdkdName,
        parameterKey: p.ParameterKey,
        ssmName: p.ParameterValue,
        read: args.readSsmParameter,
        cache: ssmCache,
      });
      // A list-typed SSM Parameter is a LIST to a `Ref`, as CloudFormation
      // gives it, so `Fn::Join` / `Fn::Select` over it resolve; a bare `Ref`
      // is joined back with commas on the way to the child.
      parentParamValues[p.ParameterKey] = isSsmListParameterType(type)
        ? stored.split(',').map((v) => v.trim())
        : stored;
    }
    const parentResolverContext: ResolverContext = {
      // The runtime value is always a real CFn template (it has Resources);
      // TS can't narrow `Record<string, unknown>` to CloudFormationTemplate.
      template: parentNode.template as unknown as ResolverContext['template'],
      resources: parentNode.state.resources,
      // go-to-k/cdkd#3869: a parent row passing a resource NAMED from a secret
      // masks it on the resolver's lines, through a print-only sink.
      secretNameNeedles: stateSecretNameNeedles(parentNode.state.resources),
      secretNameSink: new Map<string, string>(),
      parameters: parentParamValues,
      stackName: parentNode.cdkdName,
      // go-to-k/cdkd#6170: the tail the deploy resolved the parent's row with.
      stackIdTail: () => stackIdTailOf(parentNode.state, parentNode.cdkdName),
      ...(args.stateBackend && { stateBackend: args.stateBackend }),
    };
    const { params, intrinsicSkipped } = await resolveChildImportParameters(
      parentNode.template,
      parentResolverContext,
      parentLogicalId,
      args.resolver
    );
    paramsByCdkdName.set(node.cdkdName, params);
    if (intrinsicSkipped.length > 0) {
      intrinsicSkippedByCdkdName.set(node.cdkdName, intrinsicSkipped);
    }
  }
  return { paramsByCdkdName, intrinsicSkippedByCdkdName };
}
