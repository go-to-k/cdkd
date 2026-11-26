/**
 * The properties `@aws-cdk/aws-service-spec` calls a replacement
 * (`causesReplacement: yes` or `maybe`) while the type's registry schema
 * leaves them mutable (go-to-k/cdkd#7070).
 *
 * cdkd decides replacement from the registry schema's create-only paths plus
 * its hand rules, so a property AWS refuses to update but the schema leaves
 * mutable is sent as an in-place update that fails (a ResolverRule
 * `DomainName`, #7070; an EC2 Volume's `AvailabilityZone`, #1356). The spec
 * reads the CloudFormation reference, which names such properties, but it is
 * NOT an oracle: measured on #7070 and #7038, most of these rows update in
 * place. So each candidate needs a VERDICT before it can matter: a
 * `replace` / `update` row in `REPLACEMENT_EVIDENCE`, or a line in the
 * unmeasured baseline (`evidence-baseline.ts`), which keeps today's in-place
 * update. Only `replace` rows reach the deploy path, through
 * `spec-replacement-properties.generated.ts`.
 *
 * Shared by `gen-spec-replacement-properties.ts` and
 * `tests/unit/analyzer/replacement-evidence.test.ts`, so the table and the
 * audit read ONE population. Offline: the registry side is the committed
 * `tests/fixtures/cfn-registry-create-only-paths.json`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpec, type SpecResource, type SpecTypeDefinition } from './gen-getatt-attributes.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = resolve(repoRoot, 'tests/fixtures/cfn-registry-create-only-paths.json');

/** Struct members deeper than this are not walked (no spec row is this deep). */
const MAX_DEPTH = 6;

/** Why a spec type has no row in the registry snapshot. */
export const SKIP_REASONS = {
  'sam-transform':
    'an AWS::Serverless type: the SAM transform expands it before any deploy, so cdkd never sees it',
  'no-registry-schema':
    'no public registry schema bundle the refresh reads (us-east-1 and its fallback regions) carries it; ' +
    'a retired service, or one the bundles do not publish',
} as const;

/**
 * The spec types the snapshot lacks, so they yield no candidate. Exact: the
 * evidence test fails when the skip set changes, so a type that drops out of
 * the bundles (a truncated snapshot) or gains a schema is noticed.
 */
export const SPEC_TYPES_WITHOUT_REGISTRY_SCHEMA: ReadonlyMap<string, keyof typeof SKIP_REASONS> =
  new Map([
  ['AWS::Serverless::Api', 'sam-transform'],
  ['AWS::Serverless::Application', 'sam-transform'],
  ['AWS::Serverless::Function', 'sam-transform'],
  ['AWS::Serverless::HttpApi', 'sam-transform'],
  ['AWS::Serverless::LayerVersion', 'sam-transform'],
  ['AWS::Serverless::SimpleTable', 'sam-transform'],
  ['AWS::Serverless::StateMachine', 'sam-transform'],
  ['AWS::IoTEvents::AlarmModel', 'no-registry-schema'],
  ['AWS::IoTEvents::DetectorModel', 'no-registry-schema'],
  ['AWS::IoTEvents::Input', 'no-registry-schema'],
  ['AWS::IoTFleetHub::Application', 'no-registry-schema'],
  ['AWS::LookoutMetrics::Alert', 'no-registry-schema'],
  ['AWS::LookoutMetrics::AnomalyDetector', 'no-registry-schema'],
  ['AWS::LookoutVision::Project', 'no-registry-schema'],
  ['AWS::NimbleStudio::LaunchProfile', 'no-registry-schema'],
  ['AWS::NimbleStudio::StreamingImage', 'no-registry-schema'],
  ['AWS::NimbleStudio::StudioComponent', 'no-registry-schema'],
  ['AWS::OpsWorks::App', 'no-registry-schema'],
  ['AWS::OpsWorks::ElasticLoadBalancerAttachment', 'no-registry-schema'],
  ['AWS::OpsWorks::Instance', 'no-registry-schema'],
  ['AWS::OpsWorks::Layer', 'no-registry-schema'],
  ['AWS::OpsWorks::Stack', 'no-registry-schema'],
  ['AWS::OpsWorks::UserProfile', 'no-registry-schema'],
  ['AWS::OpsWorks::Volume', 'no-registry-schema'],
  ['AWS::OpsWorksCM::Server', 'no-registry-schema'],
  ['AWS::SSO::TrustedTokenIssuer', 'no-registry-schema'],
  ]);

export interface SpecReplacementCandidate {
  readonly type: string;
  /** Segments after `/properties/`, walked through object (`ref`) members only. */
  readonly path: readonly string[];
  readonly spec: 'yes' | 'maybe';
}

/** `<Type>#<Prop>` for a top-level path, `<Type>#<A>.<B>` for a nested one. */
export function candidateKey(type: string, path: readonly string[]): string {
  return `${type}#${path.join('.')}`;
}

export function readRegistryCreateOnlySnapshot(): ReadonlyMap<string, readonly (readonly string[])[]> {
  const parsed = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as {
    types?: Record<string, string[][]>;
  };
  if (!parsed.types || Object.keys(parsed.types).length === 0) {
    throw new Error(`${SNAPSHOT}: no types`);
  }
  return new Map(Object.entries(parsed.types));
}

interface SpecType {
  type?: unknown;
  reference?: { $ref?: unknown };
  element?: SpecType;
}

interface SpecProperty {
  causesReplacement?: unknown;
  type?: SpecType;
}

/** The struct a property's type names, directly or as an array / map element. */
function memberRef(type: SpecType | undefined): { ref: unknown; through: boolean } {
  if (type?.type === 'ref') return { ref: type.reference?.$ref, through: false };
  if ((type?.type === 'array' || type?.type === 'map') && type.element?.type === 'ref') {
    return { ref: type.element.reference?.$ref, through: true };
  }
  return { ref: undefined, through: false };
}

/**
 * Derive the candidates. A type the snapshot lacks yields none: it is one of
 * {@link SPEC_TYPES_WITHOUT_REGISTRY_SCHEMA}, which the evidence test holds
 * equal to the actual skip set. Members under a path
 * that is itself a candidate `yes`, or create-only, are not walked: the
 * whole property already decides. Array and map members are walked under a
 * `*` segment.
 */
export function deriveCandidates(
  resources: Iterable<SpecResource>,
  typeDefinitions: ReadonlyMap<string, SpecTypeDefinition>,
  createOnly: ReadonlyMap<string, readonly (readonly string[])[]>
): SpecReplacementCandidate[] {
  const out: SpecReplacementCandidate[] = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    const type = resource.cloudFormationType;
    if (typeof type !== 'string' || seen.has(type)) continue;
    seen.add(type);
    const schemaPaths = createOnly.get(type);
    if (schemaPaths === undefined) continue;
    const covered = (path: readonly string[]): boolean =>
      schemaPaths.some(
        (co) => co.length <= path.length && co.every((segment, i) => segment === path[i])
      );
    const walk = (properties: unknown, prefix: readonly string[]): void => {
      if (properties === null || typeof properties !== 'object') return;
      for (const name of Object.keys(properties).sort()) {
        const property = (properties as Record<string, SpecProperty>)[name]!;
        const path = [...prefix, name];
        if (covered(path)) continue;
        const spec = property.causesReplacement;
        if (spec === 'yes' || spec === 'maybe') out.push({ type, path, spec });
        if (spec === 'yes' || path.length >= MAX_DEPTH) continue;
        // An array or map member is walked under a `*` segment, the schema's
        // own spelling, so its rows need a verdict too. Such a row cannot be
        // compared per element, so it may never be `replace`.
        const { ref, through } = memberRef(property.type);
        const definition = typeof ref === 'string' ? typeDefinitions.get(ref) : undefined;
        if (definition) walk(definition.properties, through ? [...path, '*'] : path);
      }
    };
    walk(resource.properties, []);
  }
  return out.sort((a, b) =>
    candidateKey(a.type, a.path) < candidateKey(b.type, b.path) ? -1 : 1
  );
}

/** The candidates of the pinned spec against the committed snapshot. */
export function loadSpecReplacementCandidates(): {
  candidates: SpecReplacementCandidate[];
  specVersion: string;
  /** Spec types the snapshot lacks, so they yield no candidate. */
  typesWithoutSchema: string[];
} {
  const { resources, typeDefinitions, version } = loadSpec();
  const snapshot = readRegistryCreateOnlySnapshot();
  const specTypes = new Set(
    resources.map((r) => r.cloudFormationType).filter((t): t is string => typeof t === 'string')
  );
  return {
    candidates: deriveCandidates(resources, typeDefinitions, snapshot),
    specVersion: version,
    typesWithoutSchema: [...specTypes].filter((t) => !snapshot.has(t)).sort(),
  };
}
