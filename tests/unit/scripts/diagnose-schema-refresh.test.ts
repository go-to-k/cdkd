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
  parseNestedKeyDivergences,
  renderDiagnosis,
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
  it('picks out the checker’s own finding lines and keeps them verbatim', () => {
    const out = parseNestedKeyDivergences(
      [
        'nested-key-coverage: FAILED',
        '  AWS::Glue::Connection: OAuth2Credentials [definition-member-missing] (SDK interface `OAuth2Properties` has no member)',
        '  AWS::ECS::Service: someKey [case-divergence] (SDK models `SomeKey`)',
        'some unrelated trailing line',
      ].join('\n')
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.resourceType).toBe('AWS::Glue::Connection');
    expect(out[0]!.bucket).toBe('definition-member-missing');
    // Verbatim: the checker's wording is the authority, not a paraphrase.
    expect(out[0]!.line).toContain('has no member');
    expect(out[1]!.bucket).toBe('case-divergence');
  });

  it('returns nothing for output with no findings', () => {
    expect(parseNestedKeyDivergences('nested-key-coverage: OK — 0 divergences')).toEqual([]);
  });

  it('REFUSES to report nothing from output that says it FAILED', () => {
    // The finding-line format lives in another file and nothing fences the two.
    // A wording change there would silently make this return [] and render
    // "nothing needs a decision" over a red check.
    expect(() =>
      parseNestedKeyDivergences('nested-key-coverage: FAIL — nested CFn->SDK key divergence\n')
    ).toThrow(/output format changed/);
  });
});

describe('parseDeclaredProperties', () => {
  const REAL_GENERATED = join(REPO_ROOT, 'src/provisioning/property-coverage.generated.ts');

  it('reads the REAL generated module, including its `new Set<string>([` shape', () => {
    // Anchored on the real module: a synthetic sample would be written to match
    // whatever the parser expects, which is exactly how the `<string>` type
    // argument was missed.
    const declared = parseDeclaredProperties(readFileSync(REAL_GENERATED, 'utf8'));
    expect(declared.size).toBeGreaterThan(100);
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
    const hits = findDeclarationCandidates(
      'GeoProximityLocation',
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
    const scoped = findDeclarationCandidates(
      'Tags',
      'src/provisioning/providers/glue-provider.ts',
      'AWS::Glue::Connection',
      REPO_ROOT
    );
    const unscoped = findDeclarationCandidates(
      'Tags',
      'src/provisioning/providers/glue-provider.ts',
      undefined,
      REPO_ROOT
    );
    expect(unscoped.length).toBeGreaterThan(5);
    expect(scoped.length).toBeLessThan(unscoped.length);
  });
});

describe('sdkModelsMember', () => {
  it('consults the client the OWNING provider imports', () => {
    const evidence = sdkModelsMember(
      'GeoProximityLocation',
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
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).toContain('Likely a RENAME');
    expect(md).toContain('RepositoryId');
  });

  it('does NOT call a READ-ONLY addition a rename', () => {
    // A declaration cannot target a read-only property, so "point the
    // declaration at the new name" would just produce the next bogus entry.
    // The pairing is fed from writable additions only.
    const md = renderDiagnosis({
      removed: [{ ...removedEntry, renameCandidates: { GeoProximityLocation: [] } }],
      writableAdded: [],
      readOnlyAddedCount: 1,
      divergences: [],
      skipped: [],
    });
    expect(md).not.toContain('Likely a RENAME');
  });

  it('does NOT claim a rename when the refresh added nothing to that type', () => {
    const md = renderDiagnosis({
      removed: [{ ...removedEntry, renameCandidates: { GeoProximityLocation: [] } }],
      writableAdded: [],
      divergences: [],
      skipped: [],
    });
    expect(md).not.toContain('Likely a RENAME');
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
        {
          resourceType: 'AWS::Glue::Connection',
          bucket: 'definition-member-missing',
          line: 'AWS::Glue::Connection: X [definition-member-missing] (…)',
        },
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
        { resourceType: 'AWS::Glue::Connection', bucket: 'no-sdk-member', line: 'x [no-sdk-member]' },
      ],
      skipped: [],
      sdkLag: { client: '@aws-sdk/client-glue', installed: '3.9.0', latest: '3.9.0', behind: false },
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
        { resourceType: 'AWS::Glue::Connection', bucket: 'no-sdk-member', line: 'x [no-sdk-member]' },
      ],
      skipped: [],
      sdkLag: { client: '@aws-sdk/client-glue', installed: '3.1018.0', latest: '3.1127.0', behind: true },
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
        { resourceType: 'AWS::ECS::Service', bucket: 'case-divergence', line: 'AWS::ECS::Service: x [case-divergence]' },
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

  it('lists divergences verbatim and names both options', () => {
    const md = renderDiagnosis({
      removed: [],
      writableAdded: [],
      divergences: [
        {
          resourceType: 'AWS::Glue::Connection',
          bucket: 'definition-member-missing',
          line: 'AWS::Glue::Connection: OAuth2Credentials [definition-member-missing] (…)',
        },
      ],
      skipped: [],
    });
    expect(md).toContain('OAuth2Credentials');
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
