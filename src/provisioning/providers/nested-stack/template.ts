import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NestedStackProvider } from '../nested-stack-provider.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { NestedStackProviderContext } from '../../nested-stack-context.js';
import {
  rewriteTemplateAssetReferences,
  type AssetRedirectMap,
} from '../../../assets/asset-redirect.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { displayIdent } from '../../../utils/display-safe.js';
import {
  describeFileReadFailure,
  displayAssemblyPath,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../../../utils/assembly-path.js';
import {
  findNestedTemplateTreeDefect,
  isAbsoluteAssetPath,
  listNestedTemplateRows,
  renderNestedTemplateTreeDefect,
} from '../../../utils/nested-template-cycle.js';

/**
 * Returns `true` when `p` is absolute on the current platform OR begins
 * with a forward slash. The `startsWith('/')` arm covers the cross-platform
 * leak where `path.isAbsolute('/abs/foo')` returns `true` on POSIX but
 * `false` on Windows (Windows absolute paths require a drive letter or
 * UNC root) — a POSIX-style absolute path embedded in a synth template
 * generated on Linux and consumed on a Windows host would slip past
 * `path.isAbsolute()` alone. Exported for unit testing.
 */
export function isAbsoluteCrossPlatform(p: string): boolean {
  // One spelling, shared with the pre-deploy tree validation, so the per-level
  // backstop below and the up-front walk cannot disagree about "absolute".
  return isAbsoluteAssetPath(p);
}

/**
 * Validate the WHOLE nested-template subtree under this row before the first
 * child engine is built (issue go-to-k/cdkd#3247).
 *
 * Up front rather than as an ancestor chain threaded through the recursion,
 * because here a level is not a read, it is a DEPLOY: refusing at the first
 * repeat would leave every level above it provisioned, with a state record
 * each, for the rollback to unwind. Every file the recursion would follow is
 * already on disk, so the top-most row's call sees the entire cycle and
 * nothing below it ever starts. Deeper levels re-run the same walk over
 * their own (already proven) subtree; it is a few file reads next to a
 * deploy, and it keeps the guard independent of who built the context.
 *
 * This is the earliest point THIS FILE owns. The parent stack's other
 * resources may already be in flight when its nested-stack row is
 * dispatched; they are unwound by the parent's ordinary rollback. No level of
 * the cyclic tree is deployed.
 *
 * It also reports an absolute `aws:asset:path` at ANY depth, for the same
 * reason: `indexGrandchildTemplates` refuses one too, but only on reaching
 * that level, after the levels above it deployed. That check stays as the
 * per-level backstop.
 *
 * `markNonRetryable`: the verdict is computed from files no retry changes,
 * while the message carries template-controlled text (logical ids, paths)
 * that the SUBSTRING-matching retry classifier would otherwise read. Latent
 * while `disableOuterRetry` is set, and declared anyway, like the sibling
 * marks in this file.
 */
export function refuseMalformedNestedTemplateTree(
  this: NestedStackProvider,
  ctx: NestedStackProviderContext,
  logicalId: string,
  childTemplatePath: string
): void {
  const defect = findNestedTemplateTreeDefect({ [logicalId]: childTemplatePath });
  if (!defect) return;
  throw markNonRetryable(
    new Error(
      `NestedStackProvider: ${renderNestedTemplateTreeDefect(
        defect,
        ctx.parentStackName,
        'deploy any level of it'
      )}`
    )
  );
}

export function extractParameters(
  this: NestedStackProvider,
  properties: Record<string, unknown>
): Record<string, string> {
  const params = properties['Parameters'];
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    // Intrinsics in Parameter values were already resolved by the
    // parent's IntrinsicFunctionResolver before reaching the provider,
    // so the value here is a scalar literal — cast number / boolean to
    // string (matches CFn's own coercion of NumberParameter to string
    // at boundary). Refuse non-scalars: if an unresolved intrinsic
    // object leaks through the resolver, `String(obj)` would silently
    // produce `[object Object]` and the child engine would deploy
    // with a meaningless parameter value. Loud failure is the right
    // signal for the upstream resolver bug.
    //
    // An ARRAY is the one non-scalar that is NOT a resolver bug (issue
    // #2347). A `Ref` to a list-typed parent parameter -- any `List<...>`
    // type or `CommaDelimitedList` -- resolves to a JS array by design, and
    // `Parameters` is a string-valued map on the wire, so it is joined back
    // with `,` exactly as CloudFormation carries a list-typed Parameter
    // value. The child's own resolver re-splits it against the child's
    // declared `Type`, so for a NON-EMPTY array whose elements carry no
    // comma the round-trip returns the same LIST. It is not byte-lossless:
    // the re-split trims each member, so `[' a ']` comes back as `['a']`.
    // CloudFormation trims identically, so the padding was never data.
    //
    // THE EMPTY ARRAY IS THE ONE ASYMMETRY, and it is deliberate: `[]` joins
    // to `''`, which the child re-splits to `['']` -- one empty string, not
    // an empty list. `''` is nonetheless the correct wire value, because a
    // CloudFormation Parameter is a string and there is no spelling of "no
    // elements" in it; CFn's own `CommaDelimitedList` has the same hole.
    // Recorded rather than fixed, so the next reader does not mistake it for
    // an oversight.
    //
    // The SHAPE is copied from `resolveChildImportParameters` in
    // `src/cli/commands/export.ts` (its `Array.isArray` arm), which already
    // had to answer this question for `cdkd export`. Deliberately the same
    // down to `String()`-ing each element first, so a mixed array (a
    // `List<Number>` resolves to numbers) survives instead of throwing here
    // and the two paths cannot disagree about what a list-typed Parameter
    // looks like on the wire. Before #2347 only `CommaDelimitedList` and
    // `List<Number>` could reach this arm; widening the coercion made the
    // whole `List<...>` family reach it, which is what turned a working
    // deploy into the throw below.
    //
    // IT IS **NOT** COPIED IN ONE RESPECT, and that divergence is the point:
    // each ELEMENT is checked here. `export.ts` calls `String(e)` on an
    // unchecked element, so a nested unresolved intrinsic there becomes
    // `[object Object]` -- the very shape the refusal below exists to
    // prevent, arriving one level down. That hole is silent on ITS path too
    // -- `stillSkipped` is reached only for null/undefined, a non-array
    // object, or a resolver throw, never for a bad ELEMENT -- so this is a
    // deliberate divergence rather than a difference in what the two paths
    // tolerate. It is fixed HERE because this path promises loudness and
    // ships the value into a child deploy. Do not "restore parity" by
    // deleting the element check.
    if (typeof v === 'string') {
      result[k] = v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      result[k] = String(v);
    } else if (Array.isArray(v)) {
      const badIndex = v.findIndex(
        (e) => typeof e !== 'string' && typeof e !== 'number' && typeof e !== 'boolean'
      );
      if (badIndex !== -1) this.refuseNonScalarParameter(k, v[badIndex], ` element [${badIndex}]`);
      result[k] = v.map((e) => String(e)).join(',');
    } else {
      this.refuseNonScalarParameter(k, v, '');
    }
  }
  return result;
}

/**
 * ONE refusal for a parameter value the child engine must never receive,
 * shared by the TOP-LEVEL arm and the per-ELEMENT check inside an array
 * (issue #2347). Two spellings would be two chances for the element arm to
 * drift into permissiveness, which is exactly the hole the array arm opened
 * when it was first written without a check.
 *
 * `where` names the position when the offender is an element, so the message
 * points at `[2]` rather than at the whole parameter.
 */
export function refuseNonScalarParameter(
  this: NestedStackProvider,
  k: string,
  offender: unknown,
  where: string
): never {
  throw markNonRetryable(
    new Error(
      `NestedStackProvider: child Parameter ${displayIdent(k)}${where} resolved to a non-scalar value ` +
        `(type=${offender === null ? 'null' : typeof offender}). Parameters must be scalars ` +
        `(string / number / boolean), or an ARRAY of them from a list-typed parameter, by ` +
        `the time they reach the provider — an unresolved intrinsic here means ` +
        `IntrinsicFunctionResolver upstream did not handle the value, which ` +
        `is a bug. Surface the unresolved input rather than silently coercing to ` +
        `'[object Object]'.`
    )
  );
}

/**
 * The child template as the child engine deploys it, plus the grandchild
 * template paths indexed from it.
 *
 * The index is taken BEFORE the asset-reference rewrite, and returning both
 * from here is what keeps that order from being undone by a caller. The
 * rewrite walks every string in the template, `Metadata['aws:asset:path']`
 * included, and a path segment that spells a bootstrap bucket name is
 * rewritten like any other occurrence. `aws:asset:path` is a LOCAL file
 * path, never an asset-storage reference; indexing after the rewrite made
 * the deploy follow a different file than the one
 * `refuseMalformedNestedTemplateTree` had validated from the raw file, which
 * is a way around that guard (issue go-to-k/cdkd#3247).
 */
export function readChildTemplate(
  this: NestedStackProvider,
  templatePath: string,
  assetRedirect?: AssetRedirectMap
): { template: CloudFormationTemplate; grandchildTemplates: Record<string, string> } {
  let raw: string;
  try {
    raw = fs.readFileSync(templatePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read nested template at ${displayAssemblyPath(templatePath)}: ${describeFileReadFailure(err, templatePath)}`
    );
  }
  let template: CloudFormationTemplate;
  try {
    template = JSON.parse(raw) as CloudFormationTemplate;
  } catch (err) {
    throw markNonRetryable(
      new Error(
        `Failed to parse nested template at ${displayAssemblyPath(templatePath)}: ${describeFileReadFailure(err, templatePath)}`
      )
    );
  }
  const grandchildTemplates = this.indexGrandchildTemplates(template, templatePath);
  // Issue #1002 PR 2 — nested child templates are a separate parse path
  // that bypasses the top-level analyzer entry, so the §7 asset-reference
  // rewrite must be applied here too (design §7). No-op in legacy mode
  // (assetRedirect undefined).
  if (assetRedirect) {
    const n = rewriteTemplateAssetReferences(template, assetRedirect);
    if (n > 0) {
      this.logger.debug(
        `Rewrote ${n} asset reference(s) to cdkd asset storage in nested template ${displayAssemblyPath(templatePath)}`
      );
    }
  }
  return { template, grandchildTemplates };
}

export function indexGrandchildTemplates(
  this: NestedStackProvider,
  childTemplate: CloudFormationTemplate,
  childTemplatePath: string
): Record<string, string> {
  const dir = path.dirname(childTemplatePath);
  // Null-prototype: a logical id is a template key, and on a plain object a
  // row named `__proto__` is silently dropped by the assignment below and
  // then answered with `Object.prototype` by the lookup in create()/update().
  const result = Object.create(null) as Record<string, string>;
  // `listNestedTemplateRows` is shared with the pre-deploy tree validation
  // ON PURPOSE: that walk is only a guard while it follows exactly the rows
  // this loop follows, and a second hand-written copy is how the two came to
  // disagree about an array-valued `Resources`.
  for (const { logicalId: grandLogicalId, assetPath } of listNestedTemplateRows(childTemplate)) {
    // CDK emits relative asset paths for nested templates (they're
    // siblings of the parent template in the same cdk.out directory).
    // An absolute path indicates the synth output was hand-modified or
    // generated by a non-CDK toolchain — `path.join(dir, '/abs/foo')`
    // produces `/abs/foo` (POSIX) which silently bypasses our `dir`
    // resolution and points outside cdk.out. Refuse loudly rather than
    // accept a path we cannot trust.
    if (isAbsoluteCrossPlatform(assetPath)) {
      // Normally unreachable: `refuseMalformedNestedTemplateTree` reports
      // this for the whole subtree before any level deploys. Kept as the
      // per-level backstop, sanitized and marked like that refusal.
      throw markNonRetryable(
        new Error(
          `NestedStackProvider: nested-stack ${displayIdent(grandLogicalId)} has ` +
            `Metadata['aws:asset:path']=${displayAssemblyPath(assetPath)} which is absolute. ` +
            `CDK emits relative asset paths for nested templates; an absolute path ` +
            `indicates the synth output was hand-modified or generated by a non-CDK ` +
            `toolchain. Refusing to load.`
        )
      );
    }
    // The containment check the tripwire above is NOT (issue
    // go-to-k/cdkd#3489): `path.join` folds `..`, so `../../etc/passwd`
    // resolved out of `dir` and the child engine deployed whatever parsed.
    // Normally unreachable for the same reason the absolute arm is —
    // `refuseMalformedNestedTemplateTree` reports the whole subtree first —
    // and kept as the per-level backstop, marked and sanitized alike.
    const resolved = resolveAssemblyPath(dir, assetPath);
    if (!resolved.contained) {
      throw markNonRetryable(
        new Error(
          `NestedStackProvider: nested-stack ${displayIdent(grandLogicalId)} has ` +
            `Metadata['aws:asset:path']=${displayAssemblyPath(assetPath)} which ` +
            `${renderAssemblyPathEscape(resolved, dir)}`
        )
      );
    }
    result[grandLogicalId] = resolved.path;
  }
  return result;
}
