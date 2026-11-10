import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceChange, PropertyChange } from '../../types/state.js';
import { splitGetAttStringForm } from '../../deployment/secret-redaction.js';
import type { DiffCalculator } from '../diff-calculator.js';
import {
  type SyntheticCreateOnly,
  IN_PLACE_UPDATE_DERIVED_ATTRS,
  IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES,
  REF_READ,
  markNewValueKnownAfterDeploy,
  siblingsOf,
} from './shared.js';

/**
 * Promote NO_CHANGE dependents of an IN-PLACE update whose referenced ATTRIBUTE
 * either names a changed property (bug-hunt 2026-06-29) OR is a derived
 * read-only attribute the update side-effects (issue #985).
 *
 * Distinct from `promoteReplacementDependents`: a replacement changes the
 * physical id, so any reference is affected. An in-place update changes only
 * specific properties, so a dependent is affected in one of two ways when it
 * reads (via `Fn::GetAtt[Up, Attr]` or `Fn::Sub`'s `${Up.Attr}`) an attribute
 * of an updated `Up`:
 *   1. `Attr` NAMES a property that CHANGED in `Up`'s update (e.g. an SSM
 *      Parameter `Value` embedded in a downstream `Fn::Sub`); or
 *   2. `Attr` is a DERIVED read-only attribute of `Up`'s type that an in-place
 *      update side-effects even though it is not a template property — the
 *      per-type {@link IN_PLACE_UPDATE_DERIVED_ATTRS} allow list (issue #985;
 *      e.g. `AWS::EC2::LaunchTemplate.LatestVersionNumber`, which an
 *      `autoscaling.AutoScalingGroup` reads for its `LaunchTemplate.Version`);
 *      or
 *   3. `Attr` starts with a derived-attribute PREFIX of `Up`'s type — the
 *      {@link IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES} table (issue #3631; a
 *      nested stack's `Outputs.<Key>`); or
 *   4. `Up` is a custom resource, whose attributes are all its handler's
 *      response `Data` (go-to-k/cdkd#3662), and whose `Ref` — the physical
 *      id — its handler may also change on an Update by returning a new
 *      `PhysicalResourceId` (go-to-k/cdkd#3722); or
 *   5. `Up` is a template PARAMETER in `freshParameters`, read by `Ref` or
 *      `${Param}` (go-to-k/cdkd#3717).
 * (Any other `Ref` resolves to a value an in-place update keeps, so
 * Ref-only dependents of other types are left NO_CHANGE — an S3 Tables
 * Table renamed in place among them, whose `Ref` is its unchanged TableARN
 * (go-to-k/cdkd#5316); likewise a GetAtt of a computed attribute NOT in the
 * allow list, e.g. a Lambda `Arn` on a Description edit.)
 *
 * Promotion is safe even when speculative: the deploy engine re-resolves the
 * promoted resource against the in-flight state and skips the provider call
 * when nothing actually changed. Each synthetic change is marked
 * `inPlacePropagated`, and its `requiresReplacement` is a ceiling the engine
 * lowers when the resolved value equals the record, so an unmoved value never
 * replaces a reader that another edit sent to the provider.
 *
 * One pass is single-hop: `changedPropsByUpstream` is frozen at entry, so a
 * chain `A(in-place) -> B(reads A's changed attr) -> C(reads B's now-changed
 * attr)` promotes B but not C. `calculateDiff` re-runs it to a fixpoint, and
 * the pass after B's promotion sees B as an in-place UPDATE.
 *
 * A dependent reading a MASKED attribute (a `NoEcho` custom resource's
 * value, persisted `***`, issue #2274) is promoted like any other
 * (go-to-k/cdkd#3662). The engine takes its no-change skip BEFORE refusing a
 * redacted read, so a guess whose resolved bag equals the record, mask
 * included, sends nothing; a fresh `NoEcho` value never takes that skip, so
 * one the upstream re-minted in this run reaches AWS. What is left is the
 * refusal's own case: a promoted dependent whose OTHER reads moved while the
 * masked value was not re-minted fails loudly, as an update of it with a
 * changed property already did, rather than keeping the stale values.
 *
 * @returns whether any synthetic PropertyChange was added (the caller's
 *          fixpoint signal).
 */
export function promoteInPlaceAttributeDependents(
  this: DiffCalculator,
  changes: Map<string, ResourceChange>,
  desiredTemplate: CloudFormationTemplate,
  rawGetAttRefs: Map<string, Map<string, Map<string, Set<string>>>>,
  syntheticCreateOnlyPaths: ReadonlyMap<string, SyntheticCreateOnly>,
  freshParameters?: ReadonlySet<string>
): boolean {
  // Per upstream UPDATE: the set of top-level property names that changed.
  const changedPropsByUpstream = new Map<string, Set<string>>();
  // Per upstream in-place UPDATE: its resource type, used to look up the
  // derived-attribute allow list (issue #985). Populated for every UPDATE
  // that is NOT a replacement — a replaced upstream is already handled by
  // promoteReplacementDependents, and its dependents must not be double-promoted.
  const inPlaceUpdateTypeByUpstream = new Map<string, string>();
  for (const [logicalId, change] of changes) {
    if (change.changeType !== 'UPDATE') continue;
    const propertyChanges = change.propertyChanges ?? [];
    const isReplacement = propertyChanges.some((pc) => pc.requiresReplacement);
    if (!isReplacement) inPlaceUpdateTypeByUpstream.set(logicalId, change.resourceType);
    const props = propertyChanges
      .map((pc) => pc.path)
      .filter((p): p is string => typeof p === 'string');
    if (props.length > 0) changedPropsByUpstream.set(logicalId, new Set(props));
  }
  const anyFreshParameter = freshParameters !== undefined && freshParameters.size > 0;
  if (
    changedPropsByUpstream.size === 0 &&
    inPlaceUpdateTypeByUpstream.size === 0 &&
    !anyFreshParameter
  ) {
    return false;
  }
  let added = false;

  for (const [dependentId, perProp] of rawGetAttRefs) {
    const resource = desiredTemplate.Resources[dependentId];
    if (!resource || resource.Type === 'AWS::CDK::Metadata') continue;
    const change = changes.get(dependentId);
    if (!change) continue;
    // CREATE resolves fresh at provision time; DELETE is going away.
    if (change.changeType !== 'NO_CHANGE' && change.changeType !== 'UPDATE') continue;

    const existingPaths = new Set((change.propertyChanges ?? []).map((pc) => pc.path));
    const syntheticChanges: PropertyChange[] = [];

    for (const [propKey, getAttRefs] of perProp) {
      // Already diffed on its own: matched below only to mark its `newValue`
      // as resolved against a value that may move (go-to-k/cdkd#6078).
      const ownChange = existingPaths.has(propKey);
      // Which upstreams + attributes does this property read via GetAtt / Sub?
      let matched = false;
      // Set when ONLY arm 5 (a `NoEcho` parameter) promoted the reader.
      let matchedNoEcho = false;
      for (const [upstreamId, attrs] of getAttRefs) {
        if (upstreamId === dependentId) continue; // self-reference defense
        // Arm 1: the referenced attribute names a property that changed.
        const changedProps = changedPropsByUpstream.get(upstreamId);
        if (changedProps && [...attrs].some((attr) => changedProps.has(attr))) {
          matched = true;
          break;
        }
        // Arm 2 (issue #985): the referenced attribute is a derived read-only
        // attribute of the upstream's type that an in-place UPDATE side-effects
        // (e.g. LaunchTemplate LatestVersionNumber) — regardless of WHICH
        // property changed, since any in-place edit can bump it.
        //
        // `Object.hasOwn` on both tables: the type is template text, and a
        // bare lookup of `constructor` answers with `Object`'s own function.
        const upstreamType = inPlaceUpdateTypeByUpstream.get(upstreamId);
        const derivedAttrs =
          upstreamType !== undefined && Object.hasOwn(IN_PLACE_UPDATE_DERIVED_ATTRS, upstreamType)
            ? IN_PLACE_UPDATE_DERIVED_ATTRS[upstreamType]
            : undefined;
        if (derivedAttrs && [...attrs].some((attr) => derivedAttrs.has(attr))) {
          matched = true;
          break;
        }
        // Arm 3 (issue #3631): a derived attribute FAMILY, matched by prefix —
        // a nested stack's `Outputs.<Key>`, which a child-only change moves.
        // Always speculative: which outputs move is the child deploy's to
        // decide. A reader of a `NoEcho` output (persisted `***`, issue #2274)
        // is promoted too; the method doc says what the engine then does with
        // it (go-to-k/cdkd#3662). A promoted reader also re-runs everything
        // the engine does before its no-change skip, e.g. fetching its
        // `{{resolve:...}}` references again.
        const derivedPrefixes =
          upstreamType !== undefined &&
          Object.hasOwn(IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES, upstreamType)
            ? IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES[upstreamType]
            : undefined;
        if (
          derivedPrefixes &&
          [...attrs].some((attr) => derivedPrefixes.some((prefix) => attr.startsWith(prefix)))
        ) {
          matched = true;
          break;
        }
        // Arm 4 (go-to-k/cdkd#3662): EVERY attribute of a custom resource. Its
        // attributes are the handler's response `Data`, which an in-place
        // update re-runs, and none of them is a template property, so arms 1-3
        // never see one. Speculative like arm 3: the engine re-resolves the
        // reader against what the handler returned and skips it when nothing
        // moved, except for a `NoEcho` value, whose `***` compares equal to
        // any other.
        //
        // The same holds for its `Ref` (go-to-k/cdkd#3722): the handler may
        // answer an Update with a new `PhysicalResourceId`.
        if (
          upstreamType !== undefined &&
          (upstreamType.startsWith('Custom::') ||
            upstreamType === 'AWS::CloudFormation::CustomResource')
        ) {
          matched = true;
          break;
        }
        // Arm 5 (go-to-k/cdkd#3717): a `Ref` to a PARAMETER carrying a
        // `NoEcho` value supplied in this deploy. Its diff side is `***`
        // against a recorded `***`, so only this promotion reaches the
        // engine, which re-resolves the reader and compares for itself.
        // go-to-k/cdkd#4043: noted, not matched yet, so a LATER upstream
        // matching another arm still marks the reader an ordinary propagation.
        if (
          anyFreshParameter &&
          freshParameters.has(upstreamId) &&
          attrs.has(REF_READ) &&
          !Object.hasOwn(desiredTemplate.Resources, upstreamId)
        ) {
          matchedNoEcho = true;
        }
      }
      const noEchoPromoted = !matched && matchedNoEcho;
      if (ownChange) {
        // A `NoEcho`-only match has `***` on both sides already; nothing to mark.
        if (matched) markNewValueKnownAfterDeploy(change, propKey);
        continue;
      }
      if (noEchoPromoted) matched = true;
      if (!matched) continue;

      syntheticChanges.push({
        path: propKey,
        oldValue: change.currentProperties?.[propKey],
        newValue: change.desiredProperties?.[propKey],
        // Re-evaluate the dependent's own replacement rules: if the referencing
        // property is immutable for its type, the dependent is replaced too.
        // A CEILING (go-to-k/cdkd#3662): the engine drops it when the
        // resolved value turns out equal to the record, which for arms 3 and
        // 4 is the common case (the output or the handler's `Data` did not
        // move) and which a same-deploy edit elsewhere on the reader must not
        // turn into a destroy + recreate. A type the registry does not
        // classify falls back to the CFn schema (go-to-k/cdkd#3803).
        requiresReplacement: this.syntheticRequiresReplacement(
          change.resourceType,
          propKey,
          syntheticCreateOnlyPaths,
          false,
          siblingsOf(change)
        ),
        inPlacePropagated: true,
        // go-to-k/cdkd#4043: only a `NoEcho` parameter's value may have
        // moved, which the engine settles by a readback and never replaces
        // on (maintainer decision 1); approval and the destructive report
        // do not count it.
        ...(noEchoPromoted && { noEchoPromoted: true as const }),
      });
    }

    if (syntheticChanges.length === 0) continue;
    added = true;

    if (change.changeType === 'NO_CHANGE') {
      change.changeType = 'UPDATE';
      change.propertyChanges = syntheticChanges;
      this.logger.debug(
        `UPDATE (in-place attr propagated): ${dependentId} reads a value that may move in this deploy`
      );
    } else {
      change.propertyChanges = [...(change.propertyChanges ?? []), ...syntheticChanges];
    }
  }
  return added;
}

/**
 * Extract `Fn::GetAtt` / `Fn::Sub`-`${X.Attr}` references from a property value
 * as a map of `referencedLogicalId -> set of referenced attribute names`.
 * A plain `Ref` (and a dot-less `${X}`) is recorded under the
 * {@link REF_READ} name, which only the custom-resource and fresh-parameter
 * arms of the in-place pass read (go-to-k/cdkd#3717 / #3722). Recurses into arrays / objects so
 * intrinsics nested inside `Fn::Sub`'s variable map / `Fn::Join` etc. are seen.
 */
export function extractGetAttRefs(value: unknown): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const add = (id: string, attr: string): void => {
    if (id.startsWith('AWS::')) return; // pseudo parameter
    let set = refs.get(id);
    if (!set) {
      set = new Set();
      refs.set(id, set);
    }
    set.add(attr);
  };
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    const obj = v as Record<string, unknown>;
    if ('Fn::GetAtt' in obj) {
      const ga = obj['Fn::GetAtt'];
      if (Array.isArray(ga) && typeof ga[0] === 'string' && typeof ga[1] === 'string') {
        add(ga[0], ga[1]);
      } else if (typeof ga === 'string') {
        // The STRING spelling (`!GetAtt A.B`), split by the resolver's own
        // rule, so `Child.Outputs.Foo` reads as `Child` / `Outputs.Foo`.
        const split = splitGetAttStringForm(ga);
        if (split) add(split.logicalId, split.attributeName);
      }
      return;
    }
    if ('Fn::Sub' in obj) {
      const sub = obj['Fn::Sub'];
      let body: string | undefined;
      let mapKeys: Set<string> | undefined;
      if (typeof sub === 'string') {
        body = sub;
      } else if (Array.isArray(sub) && typeof sub[0] === 'string') {
        body = sub[0];
        const vars = sub[1];
        if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
          mapKeys = new Set(Object.keys(vars as Record<string, unknown>));
          Object.values(vars as Record<string, unknown>).forEach(walk);
        }
      }
      if (body !== undefined) {
        for (const m of body.matchAll(/\$\{(!)?([^}]+)\}/g)) {
          if (m[1] === '!') continue; // literal escape
          const placeholder = m[2];
          if (!placeholder) continue;
          const dot = placeholder.indexOf('.');
          if (dot < 0) {
            // `${X}` is a Ref.
            if (!mapKeys?.has(placeholder)) add(placeholder, REF_READ);
            continue;
          }
          const id = placeholder.slice(0, dot);
          const attr = placeholder.slice(dot + 1);
          if (!id || mapKeys?.has(id)) continue;
          add(id, attr);
        }
      }
      return;
    }
    if ('Ref' in obj && Object.keys(obj).length === 1) {
      if (typeof obj['Ref'] === 'string') add(obj['Ref'], REF_READ);
      return;
    }
    Object.values(obj).forEach(walk);
  };
  walk(value);
  return refs;
}
