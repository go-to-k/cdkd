#!/usr/bin/env node
/**
 * scripts/build-scenario-coverage-matrix.ts
 *
 * Builds a `(canonical real-AWS scenario tag) -> (integ fixture)`
 * coverage map by reading per-fixture sidecar `.scenarios.json` files
 * and producing a markdown + json report.
 *
 * Mirrors the structural shape of build-integ-coverage-matrix.ts (the
 * provider-coverage Phase 1 tool). Differences:
 *
 *   - Phase 1 (provider-coverage) covers "did anyone exercise THIS AWS
 *     resource type at all?" — axis is the type registry.
 *   - Phase 2B (this script) covers "did anyone exercise THIS real-AWS
 *     regression pattern?" — axis is a curated taxonomy of patterns
 *     cdkd has historically broken (Lambda ENI release, NAT GW cleanup,
 *     cross-stack ImportValue, etc.).
 *
 * The two are complementary: a fixture can register-cover the AWS::Lambda
 * type without exercising the VPC-Lambda-ENI-release pattern, and a
 * pattern can affect multiple resource types at once.
 *
 * Inputs:
 *   - tests/integration/<fixture>/.scenarios.json (optional):
 *       { "scenarios": ["vpc-lambda-eni-release", "nat-gateway-cleanup"] }
 *     Empty `[]` = "intentionally no canonical scenario applies".
 *     Absent file = "not yet annotated"; surfaced as un-annotated.
 *   - KNOWN_SCENARIOS (this file): the canonical taxonomy. Each entry
 *     has a one-line description. A sidecar tag not in this set is
 *     rejected at parse time as a typo.
 *
 * Outputs:
 *   - docs/_generated/scenario-coverage.json: machine-readable matrix.
 *   - docs/scenario-coverage.md:              markdown report.
 *
 * Run from the repo root:
 *   node --experimental-strip-types scripts/build-scenario-coverage-matrix.ts
 *   (or: vp run scenario-coverage)
 *
 * Why a visibility report and not a commit-time gate:
 *   - Many cdkd fixtures legitimately exercise no canonical scenario
 *     (they're per-service smoke tests). Gating commits on "every new
 *     fixture must tag a scenario" would force false annotations or
 *     add per-fixture allowlist friction.
 *   - The intended consumer is the contributor reviewing "does THIS
 *     real-AWS pattern have a backstop?" — a question that benefits
 *     from a periodic regen + read rather than a fail-the-commit gate.
 *
 * CI auto-regen check (mirrors #399 for integ-coverage / #422 for
 * audit-provider-coverage): `vp run scenario-coverage` + `git diff
 * --quiet docs/_generated/scenario-coverage.json docs/scenario-coverage.md`
 * fails CI if a fixture sidecar was added without regenerating the
 * report. Wired in .github/workflows/ci.yml.
 *
 * Adding a new scenario:
 *   1. Add an entry to KNOWN_SCENARIOS with a one-line description.
 *   2. Tag the existing fixtures that exercise it (sidecar JSON or
 *      a new fixture).
 *   3. `vp run scenario-coverage` to regenerate.
 *
 * Removing a scenario (rare):
 *   - Remove from KNOWN_SCENARIOS. Any sidecar still referencing it
 *     will fail the parse-time validator on the next CI / pre-commit
 *     regen, surfacing the cleanup site list.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const INTEG_DIR = join(REPO_ROOT, 'tests/integration');
const OUTPUT_JSON = join(REPO_ROOT, 'docs/_generated/scenario-coverage.json');
const OUTPUT_MD = join(REPO_ROOT, 'docs/scenario-coverage.md');
const SIDECAR_NAME = '.scenarios.json';

/**
 * Canonical taxonomy of real-AWS regression patterns cdkd has
 * historically broken or that warrant explicit backstops. Each tag
 * names a CONCRETE failure mode, not a service. Adding a tag should
 * answer the question "what bug would surface if the only fixture
 * carrying this tag stopped exercising it?".
 *
 * Tag naming convention:
 *   - lowercase-hyphenated.
 *   - prefix the affected subsystem when the scope is local (`local-`,
 *     `state-`, `multi-stack-`).
 *   - describe the PATTERN, not the resource type (e.g.
 *     `vpc-lambda-eni-release`, not `lambda-vpc-config`).
 */
const KNOWN_SCENARIOS: Record<string, string> = {
  // ---- Real-AWS DAG / eventual-consistency patterns ----
  'vpc-lambda-eni-release':
    'Lambda hyperplane ENI cleanup after DeleteFunction (5-30 min eventually consistent).',
  'nat-gateway-cleanup':
    'NAT Gateway destroy + dependent route cleanup (unconditional `waitUntilNatGatewayDeleted` on destroy).',
  'lambda-vpc-subnet-sg-deletion-order':
    'Subnet/SecurityGroup must delete AFTER Lambda::Function to avoid ENI DependencyViolation.',
  'iam-policy-propagation-retry':
    'CREATE retry with exponential backoff after IAM-EC2/Lambda eventual-consistency race.',
  'cdk-defensive-vpc-deps-relax':
    'CDK-defensive route DependsOn relaxation for VPC Lambda parallelization.',

  // ---- Cross-stack reference patterns ----
  'multi-stack-getstackoutput':
    'Cross-stack `Fn::GetStackOutput` weak reference resolution (cdkd-specific, no CFn Export).',
  'multi-stack-importvalue-strong-ref':
    'Cross-stack `Fn::ImportValue` strong-reference + persistent exports index (schema v4 imports[]).',

  // ---- Custom Resource patterns ----
  'custom-resource-async-poll':
    'Custom Resource backed by Lambda + cfn-response via S3 pre-signed URL polling.',
  'vpc-lambda-cr-race':
    'Custom Resource invocation against a VPC Lambda mid-deploy (ENI-attach race window).',

  // ---- Migration patterns ----
  'export-to-cfn-handover':
    'cdkd → CloudFormation migration via 2-phase IMPORT changeset + phase-2 UPDATE.',
  'migrate-from-cfn-handover':
    'CloudFormation → cdkd migration via `--migrate-from-cloudformation` (UpdateStack with Retain + DeleteStack).',

  // ---- Drift / state patterns ----
  'drift-revert-roundtrip':
    'cdkd drift detection + `--revert` round-trip via each provider.update().',
  'remove-protection-bypass':
    '`--remove-protection` flag bypassing AWS-side deletion-protection on supported types.',
  'multi-region-state-key':
    'Same stackName + different regions = independent state files (`version: 2` region-prefixed key layout).',
  'state-bucket-region-resolve':
    'State-bucket S3 client auto-detects bucket region via `GetBucketLocation` regardless of caller-profile region.',
  'state-schema-migration':
    'Legacy v1 / v2 state schema auto-migrates on next write; old binary fails clearly on a newer schema.',
  'legacy-bucket-name-fallback':
    'New region-free `cdkd-state-{account}` vs legacy `cdkd-state-{account}-{region}` bucket fallback resolution.',
  // NOTE: `partial-create-cleanup` (post-`Create*` wiring failure issues
  // best-effort `Delete*` before re-throwing — PRs #374 / #377 / #378 /
  // #379 / #380) is INTENTIONALLY NOT a canonical scenario tag. The
  // behavior is exercised end-to-end at the unit-test level
  // (`tests/unit/provisioning/*-partial-create-cleanup.test.ts`, ~12
  // providers covered), and mid-create-wiring failure injection on real
  // AWS is impractical — there is no AWS-side way to deterministically
  // reject `applyTags` / `PutIntegrationResponse` / `RegisterScalableTarget`
  // mid-flight after the parent `Create*Command` already succeeded. Keeping
  // the tag in the canonical taxonomy would surface as a permanent orphan
  // on every regen, which dilutes the orphan-as-signal value of the
  // matrix. The unit-test coverage IS the structural guarantee here; the
  // matrix is the real-AWS regression layer above it.
  'deletion-policy-retain':
    'DeletionPolicy: Retain skip on destroy (schema v5 recorded value wins over template).',

  // ---- Multi-resource / broad-regression set ----
  'cross-cutting-deploy-destroy':
    'Broad real-AWS regression set (39+ resource VPC+NAT+CF+Lambda+SQS or comparable breadth). Refreshes the integ-broad gate.',

  // ---- Type-family-specific tricky patterns ----
  'globaltable-cross-region-replica':
    'DynamoDB GlobalTable cross-region replica add/remove serialization (AWS rejects multiple ReplicaUpdates per UpdateTable call).',
  'cloudfront-oai-attribute-enrichment':
    'CloudFront OAI `S3CanonicalUserId` attribute enrichment (the attribute is not on `GetCloudFrontOriginAccessIdentity` directly).',
  'rds-aurora-cluster-instance':
    'RDS Aurora cluster + writer instance create/destroy with the 30-min wait budget + DBProxy/DBProxyTargetGroup family.',
  'apigateway-cors-preflight':
    'API Gateway CORS preflight (OPTIONS) handling — CDK auto-generates `Method` with both Integration.IntegrationResponses and MethodResponses arrays.',

  // ---- Local-execution patterns ----
  'local-lambda-rie-zip':
    '`cdkd local invoke` ZIP-runtime Lambda against the AWS Lambda Runtime Interface Emulator (RIE) container.',
  'local-lambda-rie-container':
    '`cdkd local invoke` container-Lambda (Code.ImageUri) against RIE — local-build OR ECR-pull asset resolution.',
  'local-apigateway-server':
    '`cdkd local start-api` HTTP server with route discovery + per-Lambda warm container pool.',
  'local-ecs-task':
    '`cdkd local run-task` ECS TaskDefinition with docker network + AWS-published metadata sidecar.',
  'local-from-state-substitution':
    '`cdkd local invoke|run-task --from-state` substitutes intrinsic-valued env/secret/role references against deployed cdkd state + AWS pseudo parameters.',
};

interface ScenarioCoverageReport {
  knownScenarios: { tag: string; description: string }[];
  fixtures: {
    name: string;
    /** true when a sidecar file exists, even if scenarios is []. */
    annotated: boolean;
    scenarios: string[];
  }[];
  perScenarioCoverage: {
    scenario: string;
    description: string;
    fixtures: string[];
  }[];
  orphanScenarios: string[];
  unannotatedFixtures: string[];
  invalidTagSites: { fixture: string; tag: string }[];
}

/**
 * Read a single fixture's sidecar. Returns:
 *   - {kind: 'absent'} when the file does not exist (un-annotated).
 *   - {kind: 'present', scenarios: string[]} when the file parses.
 *   - {kind: 'malformed', reason: string} when the file exists but
 *     fails JSON / shape validation. Triggers a hard error in main()
 *     because a malformed sidecar is a contributor error worth
 *     surfacing loudly.
 *
 * The sidecar shape is `{ "scenarios": ["tag1", "tag2"] }`. Empty
 * `[]` is legal and means "intentionally no canonical scenario
 * applies to this fixture".
 */
export type SidecarResult =
  | { kind: 'absent' }
  | { kind: 'present'; scenarios: string[] }
  | { kind: 'malformed'; reason: string };

export function readFixtureSidecar(fixtureDir: string): SidecarResult {
  const sidecarPath = join(fixtureDir, SIDECAR_NAME);
  if (!existsSync(sidecarPath)) return { kind: 'absent' };
  return parseSidecarContent(readFileSync(sidecarPath, 'utf8'));
}

export function parseSidecarContent(raw: string): SidecarResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'malformed', reason: `invalid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', reason: 'top-level value must be an object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (!('scenarios' in obj)) {
    return { kind: 'malformed', reason: 'missing required key "scenarios"' };
  }
  const scenarios = obj.scenarios;
  if (!Array.isArray(scenarios)) {
    return { kind: 'malformed', reason: '"scenarios" must be an array' };
  }
  const seen = new Set<string>();
  for (let i = 0; i < scenarios.length; i++) {
    const tag = scenarios[i];
    if (typeof tag !== 'string' || tag.trim() === '') {
      return {
        kind: 'malformed',
        reason: `"scenarios[${i}]" must be a non-empty string`,
      };
    }
    if (seen.has(tag)) {
      return {
        kind: 'malformed',
        reason: `"scenarios[${i}]" duplicates an earlier entry "${tag}"`,
      };
    }
    seen.add(tag);
  }
  return { kind: 'present', scenarios: scenarios as string[] };
}

export function listFixtures(integDir: string = INTEG_DIR): string[] {
  if (!existsSync(integDir)) return [];
  return readdirSync(integDir)
    .filter((name) => {
      // Ignore hidden directories (e.g. `.scratch/`, IDE folders); the
      // matrix is scoped to real integ fixtures only.
      if (name.startsWith('.')) return false;
      const full = join(integDir, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export function buildReport(integDir: string = INTEG_DIR): ScenarioCoverageReport {
  const knownScenarios = Object.keys(KNOWN_SCENARIOS).sort();
  const fixtureDirs = listFixtures(integDir);
  const invalidTagSites: { fixture: string; tag: string }[] = [];
  const malformed: { fixture: string; reason: string }[] = [];

  const fixtures: ScenarioCoverageReport['fixtures'] = [];
  for (const name of fixtureDirs) {
    const result = readFixtureSidecar(join(integDir, name));
    if (result.kind === 'absent') {
      fixtures.push({ name, annotated: false, scenarios: [] });
      continue;
    }
    if (result.kind === 'malformed') {
      malformed.push({ fixture: name, reason: result.reason });
      continue;
    }
    const validated: string[] = [];
    for (const tag of result.scenarios) {
      if (!(tag in KNOWN_SCENARIOS)) {
        invalidTagSites.push({ fixture: name, tag });
      } else {
        validated.push(tag);
      }
    }
    fixtures.push({ name, annotated: true, scenarios: validated.sort() });
  }

  if (malformed.length > 0) {
    const lines = malformed.map((m) => `  - ${m.fixture}/.scenarios.json: ${m.reason}`);
    throw new Error(
      `scenario-coverage: ${malformed.length} malformed sidecar file(s):\n${lines.join('\n')}`
    );
  }

  // Per-scenario coverage map.
  const perScenario = new Map<string, string[]>();
  for (const tag of knownScenarios) perScenario.set(tag, []);
  for (const f of fixtures) {
    for (const tag of f.scenarios) {
      perScenario.get(tag)!.push(f.name);
    }
  }

  const perScenarioCoverage = knownScenarios.map((tag) => ({
    scenario: tag,
    description: KNOWN_SCENARIOS[tag],
    fixtures: (perScenario.get(tag) ?? []).sort(),
  }));

  const orphanScenarios = perScenarioCoverage.filter((e) => e.fixtures.length === 0).map((e) => e.scenario);
  const unannotatedFixtures = fixtures.filter((f) => !f.annotated).map((f) => f.name);

  return {
    knownScenarios: knownScenarios.map((tag) => ({ tag, description: KNOWN_SCENARIOS[tag] })),
    fixtures,
    perScenarioCoverage,
    orphanScenarios,
    unannotatedFixtures,
    invalidTagSites,
  };
}

export function renderMarkdown(report: ScenarioCoverageReport): string {
  const lines: string[] = [];
  lines.push('# Scenario Coverage Matrix');
  lines.push('');
  lines.push('<!-- AUTO-GENERATED by scripts/build-scenario-coverage-matrix.ts. Do not hand-edit. -->');
  lines.push('');
  lines.push('Run `vp run scenario-coverage` to regenerate.');
  lines.push('');
  const totalScenarios = report.knownScenarios.length;
  const covered = totalScenarios - report.orphanScenarios.length;
  const annotated = report.fixtures.length - report.unannotatedFixtures.length;
  const total = report.fixtures.length;
  lines.push(
    `**${covered} / ${totalScenarios} canonical scenarios** have at least one integ fixture exercising them. **${annotated} / ${total} integ fixtures** carry a \`.scenarios.json\` sidecar (with 0+ tags); the rest are un-annotated and contributor-reviewed below.`
  );
  lines.push('');
  lines.push('## How this is computed');
  lines.push('');
  lines.push(
    'Each `tests/integration/<fixture>/.scenarios.json` sidecar declares which canonical real-AWS regression patterns the fixture exercises. The canonical taxonomy lives in [scripts/build-scenario-coverage-matrix.ts](../scripts/build-scenario-coverage-matrix.ts) as `KNOWN_SCENARIOS` — sidecar tags outside the taxonomy are rejected at parse time so typos surface immediately.'
  );
  lines.push('');
  lines.push('**Sidecar shape**:');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "scenarios": ["vpc-lambda-eni-release", "nat-gateway-cleanup"]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('Empty `[]` means "intentionally no canonical scenario applies to this fixture" (per-service smoke tests). Absent file means "not yet annotated" — surfaced in the un-annotated section below.');
  lines.push('');
  lines.push('This report is a visibility tool, not a commit-time gate. Many cdkd fixtures legitimately exercise no canonical scenario, and forcing per-commit annotation would add friction without proportional value. Contrast with the provider-coverage matrix ([docs/integ-coverage.md](integ-coverage.md)) which IS gated because the "is every registered SDK Provider exercised?" question has a structural answer.');
  lines.push('');

  // --- Orphan scenarios ---
  if (report.orphanScenarios.length > 0) {
    lines.push(`## Orphan scenarios (${report.orphanScenarios.length})`);
    lines.push('');
    lines.push(
      'These canonical scenarios have NO integ fixture tagged with them. Each is a real-AWS verification gap — a regression against the named pattern would only surface in production. Either tag an existing fixture (when it already exercises the pattern) or write a new fixture.'
    );
    lines.push('');
    lines.push('| Scenario | Description |');
    lines.push('|---|---|');
    for (const tag of report.orphanScenarios) {
      const desc = KNOWN_SCENARIOS[tag];
      lines.push(`| \`${tag}\` | ${desc} |`);
    }
    lines.push('');
  } else {
    lines.push('## Orphan scenarios');
    lines.push('');
    lines.push('_None._ Every canonical scenario has at least one integ fixture tagged with it.');
    lines.push('');
  }

  // --- Per-scenario coverage table ---
  lines.push(`## Per-scenario coverage (${report.knownScenarios.length} scenarios)`);
  lines.push('');
  lines.push('| Scenario | Description | Integ Fixture(s) |');
  lines.push('|---|---|---|');
  for (const entry of report.perScenarioCoverage) {
    const fixtures = entry.fixtures.length === 0
      ? '_(orphan)_'
      : entry.fixtures.map((f) => `[\`${f}\`](../tests/integration/${f}/)`).join('<br>');
    lines.push(`| \`${entry.scenario}\` | ${entry.description} | ${fixtures} |`);
  }
  lines.push('');

  // --- Un-annotated fixtures ---
  if (report.unannotatedFixtures.length > 0) {
    lines.push(`## Un-annotated fixtures (${report.unannotatedFixtures.length})`);
    lines.push('');
    lines.push(
      'These integ fixtures have no `.scenarios.json` sidecar. They may or may not exercise a canonical scenario — contributor review needed. To opt out (per-service smoke tests with no canonical pattern), add a sidecar with `{ "scenarios": [] }`.'
    );
    lines.push('');
    for (const name of report.unannotatedFixtures) {
      lines.push(`- [\`${name}\`](../tests/integration/${name}/)`);
    }
    lines.push('');
  } else {
    lines.push('## Un-annotated fixtures');
    lines.push('');
    lines.push('_None._ Every integ fixture has a `.scenarios.json` sidecar (with 0+ tags).');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * True when the file is executed directly (`node scripts/build-...ts`),
 * false when imported by a test or another script. Mirrors the pattern
 * in scripts/build-integ-coverage-matrix.ts so importing the module
 * surface for unit tests does NOT trigger the matrix regeneration.
 */
const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === __filename;
};

function main(): void {
  const report = buildReport();
  if (report.invalidTagSites.length > 0) {
    const lines = report.invalidTagSites.map(
      (s) => `  - ${s.fixture}/.scenarios.json: unknown tag "${s.tag}"`
    );
    const known = Object.keys(KNOWN_SCENARIOS).sort().map((t) => `  - ${t}`).join('\n');
    throw new Error(
      `scenario-coverage: ${report.invalidTagSites.length} invalid tag(s) — tags must be one of KNOWN_SCENARIOS in scripts/build-scenario-coverage-matrix.ts:\n${lines.join('\n')}\nKnown scenarios:\n${known}`
    );
  }
  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  // Strip `invalidTagSites` from the on-disk JSON: `main()` throws above
  // on any non-empty value, so the committed snapshot would only ever
  // carry `invalidTagSites: []` (dead field). The report shape keeps it
  // for unit tests that exercise the validator surface directly.
  const { invalidTagSites: _, ...persistable } = report;
  writeFileSync(OUTPUT_JSON, JSON.stringify(persistable, null, 2) + '\n', 'utf8');
  writeFileSync(OUTPUT_MD, renderMarkdown(report), 'utf8');
  const annotated = report.fixtures.length - report.unannotatedFixtures.length;
  const total = report.fixtures.length;
  const orphan = report.orphanScenarios.length;
  const totalScenarios = report.knownScenarios.length;
  process.stderr.write(
    `scenario-coverage: wrote ${basename(OUTPUT_MD)} and ${basename(OUTPUT_JSON)} — ${annotated}/${total} fixtures annotated, ${totalScenarios - orphan}/${totalScenarios} scenarios covered (${orphan} orphan)\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`scenario-coverage: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// Internal exports for unit tests.
export { KNOWN_SCENARIOS };
