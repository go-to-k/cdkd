import { describe, it, expect } from 'vite-plus/test';
import {
  parseEnrichmentSwitch,
  classifyType,
  buildReport,
  ENRICHMENT_ALLOW_LIST,
  type AllowListEntry,
} from '../../../scripts/gen-enrichment-coverage.js';

describe('parseEnrichmentSwitch', () => {
  const wrap = (switchBody: string): string => `
    class CloudControlProvider {
      private async enrichResourceAttributes(
        resourceType: string,
        physicalId: string,
        attributes: Record<string, unknown>
      ): Promise<Record<string, unknown>> {
        const enriched: Record<string, unknown> = { ...attributes };
        switch (resourceType) {
          ${switchBody}
          default:
            break;
        }
        return enriched;
      }
    }
  `;

  it('extracts a single plain assignment', () => {
    const map = parseEnrichmentSwitch(
      wrap(`
        case 'AWS::S3::Bucket':
          if (!enriched['Arn']) {
            enriched['Arn'] = 'arn:aws:s3:::' + physicalId;
          }
          break;
      `)
    );
    expect(map.get('AWS::S3::Bucket')).toEqual(new Set(['Arn']));
  });

  it('extracts multiple flat-key assignments inside try/catch', () => {
    const map = parseEnrichmentSwitch(
      wrap(`
        case 'AWS::RDS::DBCluster':
          try {
            enriched['Endpoint.Address'] = 'x';
            enriched['Endpoint.Port'] = '3306';
            enriched['Arn'] = 'a';
          } catch (e) {}
          break;
      `)
    );
    expect(map.get('AWS::RDS::DBCluster')).toEqual(
      new Set(['Endpoint.Address', 'Endpoint.Port', 'Arn'])
    );
  });

  it('shares one body across fall-through case labels', () => {
    const map = parseEnrichmentSwitch(
      wrap(`
        case 'AWS::Foo::A':
        case 'AWS::Foo::B':
          enriched['Shared'] = 'x';
          break;
      `)
    );
    expect(map.get('AWS::Foo::A')).toEqual(new Set(['Shared']));
    expect(map.get('AWS::Foo::B')).toEqual(new Set(['Shared']));
  });

  it('records a case with no enriched assignment as an empty set', () => {
    const map = parseEnrichmentSwitch(
      wrap(`
        case 'AWS::Empty::Case':
          break;
      `)
    );
    expect(map.get('AWS::Empty::Case')).toEqual(new Set());
  });

  it('ignores assignments to identifiers other than enriched', () => {
    const map = parseEnrichmentSwitch(
      wrap(`
        case 'AWS::Other::Thing':
          const other: Record<string, unknown> = {};
          other['NotCounted'] = 'x';
          enriched['Counted'] = 'y';
          break;
      `)
    );
    expect(map.get('AWS::Other::Thing')).toEqual(new Set(['Counted']));
  });

  it('returns empty when the method is absent', () => {
    expect(parseEnrichmentSwitch('class X {}').size).toBe(0);
  });
});

describe('classifyType', () => {
  it('classifies no-computed-attr when readOnly is empty', () => {
    const c = classifyType('AWS::X::Y', [], new Set(), true);
    expect(c.bucket).toBe('no-computed-attr');
    expect(c.gaps).toEqual([]);
  });

  it('classifies enriched when every readOnly prop is assigned', () => {
    const c = classifyType('AWS::X::Y', ['Arn', 'Url'], new Set(['Arn', 'Url']), false);
    expect(c.bucket).toBe('enriched');
    expect(c.attributes.every((a) => a.status === 'enriched')).toBe(true);
  });

  it('matches a flat-key enrichment against the nested readOnly prop', () => {
    // The case writes 'Endpoint.Address'; the readOnly prop is 'Endpoint'.
    const c = classifyType(
      'AWS::Redshift::Cluster',
      ['Endpoint'],
      new Set(['Endpoint.Address', 'Endpoint.Port']),
      false
    );
    expect(c.bucket).toBe('enriched');
  });

  it('flags a pure-CC unenriched computed attr as the blocking bug class', () => {
    const c = classifyType('AWS::PureCc::Thing', ['EndpointUrl'], new Set(), false);
    expect(c.bucket).toBe('unenriched-computed');
    expect(c.gaps).toEqual(['EndpointUrl']);
  });

  it('demotes a gap on an SDK-backed type to sdk-fallback-gap', () => {
    const c = classifyType('AWS::Sdk::Thing', ['EndpointUrl'], new Set(), true);
    expect(c.bucket).toBe('sdk-fallback-gap');
    expect(c.gaps).toEqual(['EndpointUrl']);
  });

  it('auto-allow-lists a readOnly prop that is the primaryIdentifier', () => {
    const c = classifyType('AWS::Pid::Thing', ['Arn'], new Set(), false, ['Arn']);
    expect(c.bucket).toBe('enriched'); // no gaps remain
    const arn = c.attributes.find((a) => a.name === 'Arn');
    expect(arn?.status).toBe('allow-listed');
    expect(arn?.rationale).toMatch(/primaryIdentifier/);
    expect(c.gaps).toEqual([]);
  });

  it('honors a hand-written allow-list entry with its rationale', () => {
    const allow: ReadonlyMap<string, AllowListEntry> = new Map([
      ['AWS::Msk::Cluster', { attributes: ['Arn'], rationale: 'msk reason' }],
    ]);
    const c = classifyType('AWS::Msk::Cluster', ['Arn'], new Set(), false, [], allow);
    expect(c.bucket).toBe('enriched');
    expect(c.attributes[0]?.rationale).toBe('msk reason');
  });

  it('enrichment takes precedence over primaryIdentifier and allow-list', () => {
    const c = classifyType('AWS::X::Y', ['Arn'], new Set(['Arn']), false, ['Arn']);
    expect(c.attributes[0]?.status).toBe('enriched');
  });

  it('partial coverage leaves only the uncovered prop as a gap', () => {
    const c = classifyType(
      'AWS::S3::Bucket',
      ['Arn', 'DomainName', 'WebsiteURL'],
      new Set(['Arn']),
      true // SDK-backed
    );
    expect(c.bucket).toBe('sdk-fallback-gap');
    expect(c.gaps).toEqual(['DomainName', 'WebsiteURL']);
  });
});

describe('buildReport', () => {
  const fixtures = [
    {
      resourceType: 'AWS::Sdk::Enriched',
      generatedAt: '2026-01-01',
      properties: ['Arn'],
      readOnlyProperties: ['Arn'],
    },
    {
      resourceType: 'AWS::Sdk::FallbackGap',
      generatedAt: '2026-01-01',
      properties: ['Endpoint'],
      readOnlyProperties: ['Endpoint'],
    },
    {
      resourceType: 'AWS::PureCc::Gap',
      generatedAt: '2026-01-01',
      properties: ['Endpoint'],
      readOnlyProperties: ['Endpoint'],
    },
    {
      resourceType: 'AWS::Sdk::NoComputed',
      generatedAt: '2026-01-01',
      properties: ['Name'],
      readOnlyProperties: [],
    },
  ];

  const enrichment = new Map<string, Set<string>>([
    ['AWS::Sdk::Enriched', new Set(['Arn'])],
    // a switch case for a type with no cached fixture
    ['AWS::Orphan::NoFixture', new Set(['Whatever'])],
  ]);

  const sdkBacked = new Set([
    'AWS::Sdk::Enriched',
    'AWS::Sdk::FallbackGap',
    'AWS::Sdk::NoComputed',
  ]);

  it('buckets each type and computes the summary', () => {
    const report = buildReport(fixtures, enrichment, sdkBacked);
    expect(report.summary.classifiedCount).toBe(4);
    expect(report.summary.enriched).toBe(1);
    expect(report.summary.noComputedAttr).toBe(1);
    expect(report.summary.sdkFallbackGap).toBe(1);
    expect(report.summary.unenrichedGap).toBe(1); // pure-CC, blocks CI
  });

  it('reports enrichment cases that lack a cached schema', () => {
    const report = buildReport(fixtures, enrichment, sdkBacked);
    expect(report.enrichedWithoutCachedSchema).toEqual(['AWS::Orphan::NoFixture']);
  });

  it('only the pure-CC gap is in the unenriched-computed bucket', () => {
    const report = buildReport(fixtures, enrichment, sdkBacked);
    const blocking = report.types.filter((t) => t.bucket === 'unenriched-computed');
    expect(blocking.map((t) => t.resourceType)).toEqual(['AWS::PureCc::Gap']);
  });
});

describe('ENRICHMENT_ALLOW_LIST seed', () => {
  it('carves out MSK::Cluster Arn (primaryIdentifier not-a-bug)', () => {
    expect(ENRICHMENT_ALLOW_LIST.get('AWS::MSK::Cluster')?.attributes).toContain('Arn');
  });

  it('carves out Elasticsearch::Domain (Tier-3 non-provisionable)', () => {
    const entry = ENRICHMENT_ALLOW_LIST.get('AWS::Elasticsearch::Domain');
    expect(entry).toBeDefined();
    expect(entry?.rationale).toMatch(/non-provisionable/i);
  });
});
