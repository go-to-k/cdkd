/**
 * Resource-mapping algorithm for `cdkd migrate --from-cfn-stack`.
 *
 * Closes the load-bearing constraint documented at
 * [docs/design/465-cfn-migrate.md](../../../../docs/design/465-cfn-migrate.md) §6:
 * `cdk migrate` does not emit a sidecar mapping file, so cdkd has to
 * recover the `(sourceLogicalId, synthLogicalId)` mapping itself before
 * the import phase can write state under the synth template's IDs.
 *
 * **2-pass algorithm** (decision from #465 parent-session Q1, refined
 * by PR A's empirical validation in [docs/design/465-cfn-migrate.md](../../../../docs/design/465-cfn-migrate.md) §5.5):
 *
 *   1. **Pass 1 — logical-ID exact match**: walk every `Resources[<srcLogicalId>]`
 *      in the source CFn template, look for a synth-side resource whose
 *      `Metadata['aws:cdk:path']` last `/`-separated segment equals
 *      `srcLogicalId`. Single match → pair. Two-or-more matches → fall
 *      through to Pass 2 (logical-id collision; only Pass 2's Properties
 *      compare can disambiguate).
 *   2. **Pass 2 — Type + Properties deep-equal**: for source resources
 *      not paired in Pass 1, look at synth resources of the SAME `Type`
 *      whose `Properties` deep-equals the source's. Single match → pair.
 *      Zero matches → unmatched (with empty candidates list). Multiple
 *      matches → unmatched (ambiguous; we refuse to guess).
 *
 * **CDK synth injections** that must be skipped on the synth side
 * (per PR A's §5.5 audit): `Resources` of `Type: 'AWS::CDK::Metadata'`
 * (excluded by the index — also matches `src/cli/cdk-path.ts`'s
 * `buildCdkPathIndex`), plus `Conditions.CDKMetadataAvailable` /
 * `Parameters.BootstrapVersion` / `Rules.CheckBootstrapVersion`. This
 * module operates only on `Resources` so the latter three are
 * structurally excluded — they live in sibling top-level keys we never
 * descend into.
 *
 * **Overrides**: user-supplied `{<srcLogicalId>: <synthLogicalId>}`
 * pairs from `--resource-mapping <file.json>` (loaded by the orchestrator
 * via [resource-mapping-file.ts](resource-mapping-file.ts)) win over
 * Pass 1 + Pass 2 results for the same source id. An override referencing
 * a synth id that does NOT exist hard-errors at mapping time — the
 * orchestrator surfaces the resolved candidate list in the error so the
 * user can fix the JSON file in one shot.
 *
 * **Deep-equal semantics**: object key order is NOT significant (the
 * synth template alphabetizes top-level keys while source templates
 * preserve author order); array order IS significant (Tags / IpRanges /
 * EnvironmentVariables / etc. all carry ordering semantics on AWS). The
 * synth-side `AWS::NoValue` placeholder values are stripped before
 * compare so a source template that omits a property compares equal
 * against the synth template that emits the placeholder for the same
 * structural intent.
 *
 * Implementation is pure-functional + synchronous — no AWS calls, no
 * file I/O. The orchestrator wraps this with `buildResourceMapping(...)`
 * → `writeMappingFile(...)` → confirm + import.
 */

/**
 * One resolved `(sourceLogicalId → synthLogicalId, physicalId, resourceType)`
 * tuple for a source resource that matched a synth resource.
 *
 * Surfaced on `ResourceMappingResult.pairs` for the orchestrator's
 * downstream import + confirmation prompt rendering. Carries the full
 * context the import flow needs without forcing callers to re-walk the
 * source / synth templates.
 */
export interface ResourceMappingPair {
  /** Logical ID in the source CFn template (`Resources` key). */
  sourceLogicalId: string;
  /** Logical ID in the synth template (`Resources` key, post-`cdk migrate`). */
  synthLogicalId: string;
  /** AWS physical ID recovered from `DescribeStackResources` against the source CFn stack. */
  physicalId: string;
  /** AWS resource type (e.g. `AWS::S3::Bucket`). Source vs synth agree on this — Pass 2 keys on it. */
  resourceType: string;
}

/**
 * One unmatched source resource — surfaced so the orchestrator can write
 * the partial mapping file with the diagnostic context the user needs
 * to hand-edit it before re-running.
 */
export interface ResourceMappingUnmatched {
  /** Source logical id with no synth-side counterpart. */
  sourceLogicalId: string;
  /** Source resource type — narrows the candidate list to the same Type on the synth side. */
  resourceType: string;
  /**
   * Synth-side logical ids of resources matching `resourceType`. Empty
   * array when no synth resource shares the type (= a source resource
   * `cdk migrate` failed to translate at all). Helps the user populate
   * the hand-edited mapping JSON in one shot.
   */
  candidates: string[];
  /**
   * Why the auto-mapping failed.
   *
   * - `no-match`: Pass 1 found no `aws:cdk:path` last-segment match AND
   *   Pass 2 found zero (or 2+, ambiguous) Properties-deep-equal matches.
   * - `logical-id-collision`: Pass 1 found 2+ synth resources with the
   *   same last-segment, AND Pass 2 also couldn't disambiguate (zero or
   *   2+ deep-equal matches among that subset).
   */
  reason: 'no-match' | 'logical-id-collision';
}

/**
 * Result of {@link buildResourceMapping}.
 *
 * `mapping` is the canonical `{<srcLogicalId>: <synthLogicalId>}` map
 * the orchestrator serializes via {@link writeMappingFile}; `pairs`
 * carries the full per-pair context (physicalId / resourceType) the
 * subsequent import flow needs; `unmatched` lists the source resources
 * the algorithm could not pair so the orchestrator can refuse with a
 * clear actionable error before any state is written.
 */
export interface ResourceMappingResult {
  mapping: Record<string, string>;
  pairs: ResourceMappingPair[];
  unmatched: ResourceMappingUnmatched[];
}

/**
 * Source resource entry that the mapper consumes from
 * `DescribeStackResources`. Mirrors `PrefetchedResource` from
 * [cfn-stack-prefetch.ts](cfn-stack-prefetch.ts) so the orchestrator can
 * pass the prefetch result through verbatim.
 */
export interface MapperSourceResource {
  LogicalResourceId: string;
  PhysicalResourceId: string;
  ResourceType: string;
}

/**
 * Input to {@link buildResourceMapping}.
 *
 * `sourceCfnTemplate` carries the source CFn template's `Resources`
 * tree (parsed via [src/cli/yaml-cfn.ts](../../yaml-cfn.ts) by the
 * prefetch layer so YAML shorthand intrinsics are normalized); the
 * mapper reads `Resources[<id>].Type` and `Properties` for Pass 2.
 *
 * `synthTemplate` is the synth template emitted by the generated CDK
 * app (`<outputDir>/cdk.out/<StackName>.template.json`); the mapper
 * reads `Resources[<id>].Type` / `Properties` / `Metadata['aws:cdk:path']`.
 *
 * `sourceResources` is the `(LogicalResourceId, PhysicalResourceId,
 * ResourceType)` triples from `DescribeStackResources`. Used to
 * populate `pairs[].physicalId` once the algorithm has paired a source
 * logical ID with a synth logical ID — drift / divergence between
 * `sourceResources` and `sourceCfnTemplate.Resources` is rare (CFn
 * mid-update transient states) but possible; the mapper logs a debug
 * note when it occurs without aborting.
 *
 * `overrides` is the user-supplied map from `--resource-mapping
 * <file.json>` (loaded by [resource-mapping-file.ts](resource-mapping-file.ts));
 * keys are source logical IDs, values are synth logical IDs.
 */
export interface ResourceMappingOptions {
  sourceCfnTemplate: unknown;
  synthTemplate: unknown;
  sourceResources: readonly MapperSourceResource[];
  overrides?: Record<string, string>;
}

interface SourceEntry {
  logicalId: string;
  type: string;
  properties: Record<string, unknown>;
}

interface SynthEntry {
  logicalId: string;
  type: string;
  properties: Record<string, unknown>;
  awsCdkPath: string;
}

/**
 * Run the 2-pass mapping algorithm against `(sourceCfnTemplate,
 * synthTemplate, sourceResources)` and return the resolved mapping plus
 * any unmatched entries.
 *
 * Pure-functional: no AWS calls, no I/O, no mutation of inputs. Safe to
 * call repeatedly in tests against shared fixtures.
 *
 * Throws when an override references a synth id that does not exist —
 * this is a user error in the hand-edited mapping JSON and surfacing
 * the available synth ids in the message is the path back to a working
 * config.
 */
export function buildResourceMapping(opts: ResourceMappingOptions): ResourceMappingResult {
  const sourceEntries = extractSourceResources(opts.sourceCfnTemplate);
  const synthEntries = extractSynthResources(opts.synthTemplate);
  const physicalIdByLogicalId = new Map<string, string>();
  for (const r of opts.sourceResources) {
    physicalIdByLogicalId.set(r.LogicalResourceId, r.PhysicalResourceId);
  }

  const overrides = opts.overrides ?? {};
  // Validate overrides up front — a typo in the hand-edited JSON is the
  // most common cause of a failed re-run, and surfacing every offender
  // in one shot beats forcing the user into a hunt-and-fix loop.
  const synthLogicalIds = new Set(synthEntries.map((s) => s.logicalId));
  for (const [srcId, synthId] of Object.entries(overrides)) {
    if (!synthLogicalIds.has(synthId)) {
      throw new Error(
        `Resource-mapping override targets synth logical id '${synthId}' (for source ` +
          `id '${srcId}'), but that id is not in the synthesized template. ` +
          `Available synth ids: ${[...synthLogicalIds].sort().join(', ')}`
      );
    }
  }

  // M1: Refuse to build a mapping when DescribeStackResources did not
  // return a physical id for a source-template resource. This typically
  // means the source CFn stack is mid-operation (REVIEW_IN_PROGRESS, a
  // resource not yet provisioned) or a stack policy excluded it. Pre-fix
  // we silently fell back to `''` and the downstream import call hit a
  // confusing AWS-side rejection. Failing here, BEFORE writing state or
  // the mapping file, gives the user an actionable next step.
  const missingPhysicalIds: string[] = [];
  for (const src of sourceEntries) {
    if (!physicalIdByLogicalId.has(src.logicalId)) {
      missingPhysicalIds.push(`  - ${src.logicalId} (${src.type})`);
    }
  }
  if (missingPhysicalIds.length > 0) {
    throw new Error(
      `Source CFn resource(s) not returned by DescribeStackResources — cannot migrate:\n` +
        `${missingPhysicalIds.join('\n')}\n\n` +
        `The stack may have been mid-operation; wait for it to settle ` +
        `(CREATE_COMPLETE / UPDATE_COMPLETE / etc.) and retry.`
    );
  }

  const synthByLastPathSegment = indexSynthByLastPathSegment(synthEntries);
  const synthByLogicalId = new Map(synthEntries.map((s) => [s.logicalId, s] as const));

  // Track which synth ids have already been paired so a single synth
  // resource cannot match two source resources. Both passes consult and
  // update this set so Pass 2 cannot poach a synth id Pass 1 already
  // claimed (or vice versa via the unmatched-fallthrough path).
  const claimedSynthIds = new Set<string>();

  const pairs: ResourceMappingPair[] = [];
  const unmatched: ResourceMappingUnmatched[] = [];

  // ---- Apply overrides first ----
  // Overrides bypass Pass 1 + Pass 2 entirely; they're the user's
  // explicit decision and we honor them unconditionally (modulo the
  // up-front validity check above).
  const sourcesHandledByOverride = new Set<string>();
  for (const [srcId, synthId] of Object.entries(overrides)) {
    const src = sourceEntries.find((e) => e.logicalId === srcId);
    if (!src) {
      // Override targets a source id not in the template. Treat as a
      // user error too — same shape as the typo'd synth id, so the
      // operator can fix both kinds in one pass through the JSON.
      const availableSrc = sourceEntries.map((e) => e.logicalId).sort();
      throw new Error(
        `Resource-mapping override references source logical id '${srcId}', but no ` +
          `resource with that id exists in the source CloudFormation template. ` +
          `Available source ids: ${availableSrc.join(', ')}`
      );
    }
    const synth = synthByLogicalId.get(synthId);
    // synth presence is already validated; the Map lookup is just a
    // formality to recover the synth entry's `type` (which we surface
    // on `pairs[].resourceType`).
    if (!synth) continue; // unreachable, defensive
    // physicalId presence is guaranteed by the M1 check above.
    const physicalId = physicalIdByLogicalId.get(src.logicalId)!;
    pairs.push({
      sourceLogicalId: src.logicalId,
      synthLogicalId: synth.logicalId,
      physicalId,
      resourceType: src.type,
    });
    claimedSynthIds.add(synth.logicalId);
    sourcesHandledByOverride.add(src.logicalId);
  }

  // ---- Pass 1: logical-ID exact match via aws:cdk:path last segment ----
  const passOnePending: SourceEntry[] = [];
  for (const src of sourceEntries) {
    if (sourcesHandledByOverride.has(src.logicalId)) continue;
    const candidatesForLastSegment = synthByLastPathSegment.get(src.logicalId) ?? [];
    // m1: Compute the collision check against the RAW last-segment
    // count, NOT against the already-filtered `availableCandidates`.
    // A source resource with 2+ raw candidates MUST defer to Pass 2
    // regardless of sibling iteration order — pre-fix, when two source
    // resources both had last-segment `MyBucket` and two synth resources
    // matched, the first source iteration deferred (raw=2, available=2)
    // but the second iteration silently paired (raw=2, available=1)
    // because a sibling Pass-1 claim had drained one candidate. That
    // shape is structural: BOTH sources should defer to Pass 2's
    // Properties compare so the picks are based on real shape, not on
    // iteration order.
    const rawCandidateCount = candidatesForLastSegment.length;
    const availableCandidates = candidatesForLastSegment.filter(
      (c) => !claimedSynthIds.has(c.logicalId)
    );
    if (rawCandidateCount === 1 && availableCandidates.length === 1) {
      // Single raw candidate AND it's still available → safe Pass 1
      // pair (no collision was ever possible).
      const synth = availableCandidates[0]!;
      pairs.push({
        sourceLogicalId: src.logicalId,
        synthLogicalId: synth.logicalId,
        physicalId: physicalIdByLogicalId.get(src.logicalId)!,
        resourceType: src.type,
      });
      claimedSynthIds.add(synth.logicalId);
    } else {
      // Either:
      //   - 0 raw matches → defer to Pass 2 (Properties-based search)
      //   - 2+ raw matches → defer to Pass 2 (structural collision —
      //     Pass 2's Properties compare is the only safe disambiguator,
      //     regardless of how many candidates remain after sibling Pass-1
      //     claims).
      passOnePending.push(src);
    }
  }

  // ---- Pass 2: Type + Properties deep-equal ----
  for (const src of passOnePending) {
    const candidatesSameType = synthEntries.filter(
      (s) => s.type === src.type && !claimedSynthIds.has(s.logicalId)
    );
    const propertyMatches = candidatesSameType.filter((s) =>
      deepEqualIgnoreNoValue(src.properties, s.properties)
    );
    if (propertyMatches.length === 1) {
      const synth = propertyMatches[0]!;
      pairs.push({
        sourceLogicalId: src.logicalId,
        synthLogicalId: synth.logicalId,
        physicalId: physicalIdByLogicalId.get(src.logicalId)!,
        resourceType: src.type,
      });
      claimedSynthIds.add(synth.logicalId);
    } else {
      // Surface every same-type synth id as a candidate so the user
      // can hand-edit the mapping JSON without re-reading the synth
      // template. The reason is `'logical-id-collision'` when Pass 1
      // found 2+ matches by name (= we know there are multiple synth
      // resources sharing the source's logical id), else `'no-match'`.
      const lastSegmentCandidates = synthByLastPathSegment.get(src.logicalId) ?? [];
      const isCollision = lastSegmentCandidates.length >= 2;
      unmatched.push({
        sourceLogicalId: src.logicalId,
        resourceType: src.type,
        candidates: candidatesSameType.map((c) => c.logicalId).sort(),
        reason: isCollision ? 'logical-id-collision' : 'no-match',
      });
    }
  }

  // Build the canonical `{src: synth}` map from the resolved pairs.
  // Iteration order matches `pairs` insertion order (overrides first,
  // then Pass 1, then Pass 2) which is stable for snapshot tests.
  const mapping: Record<string, string> = {};
  for (const p of pairs) {
    mapping[p.sourceLogicalId] = p.synthLogicalId;
  }

  return { mapping, pairs, unmatched };
}

/**
 * Walk a parsed CFn template's `Resources` and return one entry per
 * resource. `Type` defaults to `''` and `Properties` to `{}` when the
 * template omits them (CFn allows resources with only `DeletionPolicy`
 * + `Type`); the mapper's downstream deep-equal handles `{}` cleanly.
 *
 * Top-level keys other than `Resources` (Conditions / Parameters /
 * Rules / Outputs / Mappings / Metadata) are NOT walked — the mapping
 * is resource-to-resource only, and §5.5 of the design doc spells out
 * the four CDK-synth injections that live in those sibling keys.
 */
function extractSourceResources(template: unknown): SourceEntry[] {
  if (!template || typeof template !== 'object') return [];
  const resources = (template as Record<string, unknown>)['Resources'];
  if (!resources || typeof resources !== 'object') return [];
  const out: SourceEntry[] = [];
  for (const [logicalId, raw] of Object.entries(resources as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const type = typeof r['Type'] === 'string' ? (r['Type'] as string) : '';
    const props =
      r['Properties'] && typeof r['Properties'] === 'object'
        ? (r['Properties'] as Record<string, unknown>)
        : {};
    out.push({ logicalId, type, properties: props });
  }
  return out;
}

/**
 * Walk the synth template's `Resources` and return one entry per
 * resource, EXCLUDING `AWS::CDK::Metadata` (synth-only sentinel that has
 * no source counterpart). Captures `Metadata['aws:cdk:path']` so Pass 1
 * can match against the last `/`-separated segment.
 *
 * The four other CDK-synth injections (CDKMetadataAvailable Condition,
 * BootstrapVersion Parameter, CheckBootstrapVersion Rule) live outside
 * `Resources` and are structurally excluded by this function.
 */
function extractSynthResources(template: unknown): SynthEntry[] {
  if (!template || typeof template !== 'object') return [];
  const resources = (template as Record<string, unknown>)['Resources'];
  if (!resources || typeof resources !== 'object') return [];
  const out: SynthEntry[] = [];
  for (const [logicalId, raw] of Object.entries(resources as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const type = typeof r['Type'] === 'string' ? (r['Type'] as string) : '';
    if (type === 'AWS::CDK::Metadata') continue;
    const props =
      r['Properties'] && typeof r['Properties'] === 'object'
        ? (r['Properties'] as Record<string, unknown>)
        : {};
    const meta =
      r['Metadata'] && typeof r['Metadata'] === 'object'
        ? (r['Metadata'] as Record<string, unknown>)
        : {};
    const path = typeof meta['aws:cdk:path'] === 'string' ? (meta['aws:cdk:path'] as string) : '';
    out.push({ logicalId, type, properties: props, awsCdkPath: path });
  }
  return out;
}

/**
 * Group synth entries by the LAST `/`-separated segment of their
 * `aws:cdk:path` metadata so Pass 1 can look up the source logical id
 * directly. Per [docs/design/465-cfn-migrate.md](../../../../docs/design/465-cfn-migrate.md) §5.5:
 * `cdk migrate` emits `<StackName>/<LogicalId>` as the metadata value,
 * so the last segment IS the source logical id in the typical case.
 *
 * Entries without an `aws:cdk:path` are silently skipped — they cannot
 * be addressed by source logical id and will only be reachable via
 * Pass 2's Properties match.
 */
function indexSynthByLastPathSegment(entries: readonly SynthEntry[]): Map<string, SynthEntry[]> {
  const out = new Map<string, SynthEntry[]>();
  for (const e of entries) {
    if (!e.awsCdkPath) continue;
    const lastSegment = e.awsCdkPath.split('/').pop() ?? '';
    if (!lastSegment) continue;
    const bucket = out.get(lastSegment);
    if (bucket) {
      bucket.push(e);
    } else {
      out.set(lastSegment, [e]);
    }
  }
  return out;
}

/**
 * Recursive deep equality between two values, with two CFn-specific
 * accommodations:
 *
 *  1. Object key order is NOT significant — `JSON.stringify` would
 *     diverge on the canonical-source-vs-synth-alphabetized case
 *     (verified by PR A's empirical run, §5.5 point 3) so we walk the
 *     keys explicitly.
 *  2. `AWS::NoValue` placeholder values are stripped before compare —
 *     `cdk migrate`'s codegen sometimes emits the placeholder for a
 *     property the source template simply omitted, and the structural
 *     intent matches. Source side never has the placeholder; synth side
 *     can on either side of a nested object.
 *
 * Arrays are compared positionally (order IS significant — Tags arrays
 * and similar carry ordering semantics).
 */
export function deepEqualIgnoreNoValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // AWS::NoValue placeholder check — strip on either side.
  if (isAwsNoValue(a) !== isAwsNoValue(b)) return false;
  if (isAwsNoValue(a) && isAwsNoValue(b)) return true;

  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualIgnoreNoValue(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  // Strip undefined / AWS::NoValue keys on both sides before key compare
  // so a property that's structurally absent on one side and AWS::NoValue
  // on the other compares equal.
  const aKeys = Object.keys(aObj).filter((k) => !isAwsNoValue(aObj[k]) && aObj[k] !== undefined);
  const bKeys = Object.keys(bObj).filter((k) => !isAwsNoValue(bObj[k]) && bObj[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  const aKeySet = new Set(aKeys);
  for (const k of bKeys) {
    if (!aKeySet.has(k)) return false;
    if (!deepEqualIgnoreNoValue(aObj[k], bObj[k])) return false;
  }
  return true;
}

/**
 * True when the value is the CFn `AWS::NoValue` placeholder
 * (`{Ref: 'AWS::NoValue'}`). `cdk migrate`'s codegen emits this for
 * conditional properties the source template omitted; the structural
 * intent matches and deep-equal must treat them as absent.
 */
function isAwsNoValue(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  return keys.length === 1 && keys[0] === 'Ref' && obj['Ref'] === 'AWS::NoValue';
}
