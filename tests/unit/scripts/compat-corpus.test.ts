import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CDK_METADATA_TYPE,
  RUNTIME_UNSUPPORTED_TYPES,
  HANDLED_FN,
  isCustomResource,
  isRuntimeSupported,
  isTrulySupported,
  collectIntrinsics,
  findUnknownIntrinsics,
  extractResourceTypes,
  judgeTemplate,
  parseRegisteredTypes,
  extractTier3,
  rankFrequency,
  measureCorpus,
  parseCliArgs,
  run,
  type CliIO,
} from '../../../scripts/compat-corpus.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '../../..');

const SDK = new Set(['AWS::S3::Bucket', 'AWS::IAM::Role', 'AWS::Lambda::Function']);
const TIER3 = new Set(['AWS::AppMesh::GatewayRoute', 'AWS::AmazonMQ::ConfigurationAssociation']);

describe('isCustomResource', () => {
  it('matches Custom:: prefix and AWS::CloudFormation::CustomResource', () => {
    expect(isCustomResource('Custom::MyThing')).toBe(true);
    expect(isCustomResource('AWS::CloudFormation::CustomResource')).toBe(true);
    expect(isCustomResource('AWS::S3::Bucket')).toBe(false);
  });
});

describe('isRuntimeSupported (replica of ProviderRegistry.hasProvider)', () => {
  // The real registry checks the SDK map first, then isSupportedResourceType,
  // then the custom-resource path — so a CC-blocklisted type that IS
  // SDK-registered still passes pre-flight.
  const sdk = new Set(['AWS::IAM::Role', 'AWS::S3::Bucket', 'AWS::Route53::HostedZone']);

  it('accepts CC-blocklisted types that have an SDK provider (SDK map wins first)', () => {
    expect(isRuntimeSupported('AWS::IAM::Role', sdk)).toBe(true);
    expect(isRuntimeSupported('AWS::Route53::HostedZone', sdk)).toBe(true);
  });
  it('accepts custom resources (custom-resource path)', () => {
    expect(isRuntimeSupported('Custom::Foo', sdk)).toBe(true);
    expect(isRuntimeSupported('AWS::CloudFormation::CustomResource', sdk)).toBe(true);
  });
  it('rejects blocklisted types with no SDK provider', () => {
    // WaitConditionHandle is deliberately NOT used as the example here: the
    // real registry ships an SDK provider for it since issue #1020, so only
    // WaitCondition remains a production-accurate blocklisted-without-provider
    // example for this synthetic SDK set.
    expect(isRuntimeSupported('AWS::CloudFormation::WaitCondition', sdk)).toBe(false);
  });
  it('optimistically accepts any other AWS:: type (the silent-tier3 trap)', () => {
    expect(isRuntimeSupported('AWS::AppMesh::GatewayRoute', sdk)).toBe(true);
    expect(isRuntimeSupported('AWS::S3::Bucket', sdk)).toBe(true);
  });
  it('rejects non-AWS:: types', () => {
    expect(isRuntimeSupported('Foo::Bar::Baz', sdk)).toBe(false);
  });
});

describe('isTrulySupported (provider-coverage oracle)', () => {
  it('accepts SDK-registered types', () => {
    expect(isTrulySupported('AWS::IAM::Role', SDK, TIER3)).toBe(true);
  });
  it('accepts custom resources and the CDK metadata sentinel', () => {
    expect(isTrulySupported('Custom::Foo', SDK, TIER3)).toBe(true);
    expect(isTrulySupported(CDK_METADATA_TYPE, SDK, TIER3)).toBe(true);
  });
  it('rejects tier3 types', () => {
    expect(isTrulySupported('AWS::AppMesh::GatewayRoute', SDK, TIER3)).toBe(false);
  });
  it('accepts tier2 (CC-API fallback) types not in tier3', () => {
    expect(isTrulySupported('AWS::SomeService::SomeType', SDK, TIER3)).toBe(true);
  });
  it('rejects non-AWS:: third-party registry types (cdkd pre-flight rejects them)', () => {
    // hasProvider's final fallthrough is startsWith('AWS::'); a CFN
    // public/private registry type is neither SDK, custom, nor AWS::, so it
    // never deploys — TRUTH must agree with RUNTIME here, not over-accept.
    expect(isTrulySupported('MyOrg::Svc::Type', SDK, TIER3)).toBe(false);
    expect(isTrulySupported('Alexa::ASK::Skill', SDK, TIER3)).toBe(false);
  });
});

describe('collectIntrinsics', () => {
  it('finds Fn::* keys and single-key Ref', () => {
    const found = new Set<string>();
    collectIntrinsics(
      { a: { Ref: 'X' }, b: { 'Fn::Sub': 'hi' }, c: { 'Fn::Join': ['', []] } },
      found
    );
    expect([...found].sort()).toEqual(['Fn::Join', 'Fn::Sub', 'Ref']);
  });
  it('does NOT treat a multi-key object with a Ref property as an intrinsic Ref', () => {
    const found = new Set<string>();
    collectIntrinsics({ Ref: 'X', Other: 1 }, found);
    expect(found.has('Ref')).toBe(false);
  });
  it('recurses arrays', () => {
    const found = new Set<string>();
    collectIntrinsics([{ 'Fn::GetAtt': ['R', 'Arn'] }], found);
    expect([...found]).toEqual(['Fn::GetAtt']);
  });
});

describe('findUnknownIntrinsics', () => {
  it('returns empty when every Fn:: is handled', () => {
    const tmpl = { Resources: { R: { Type: 'AWS::S3::Bucket', Properties: { N: { 'Fn::Sub': 'x' } } } } };
    expect(findUnknownIntrinsics(tmpl)).toEqual([]);
  });
  it('flags an unknown Fn:: intrinsic', () => {
    const tmpl = { Resources: { R: { Type: 'AWS::S3::Bucket', Properties: { N: { 'Fn::Length': [] } } } } };
    expect(findUnknownIntrinsics(tmpl)).toEqual(['Fn::Length']);
  });
  it('never flags Fn::Transform (macro, handled upstream)', () => {
    const tmpl = { Resources: { R: { Type: 'AWS::S3::Bucket', Properties: { 'Fn::Transform': {} } } } };
    expect(findUnknownIntrinsics(tmpl)).toEqual([]);
  });
  it('scans Outputs and Conditions too', () => {
    const tmpl = {
      Resources: { R: { Type: 'AWS::S3::Bucket' } },
      Outputs: { O: { Value: { 'Fn::Length': [] } } },
      Conditions: { C: { 'Fn::Contains': [] } },
    };
    expect(findUnknownIntrinsics(tmpl).sort()).toEqual(['Fn::Contains', 'Fn::Length']);
  });
});

describe('extractResourceTypes', () => {
  it('dedupes and excludes AWS::CDK::Metadata', () => {
    const tmpl = {
      Resources: {
        A: { Type: 'AWS::S3::Bucket' },
        B: { Type: 'AWS::S3::Bucket' },
        M: { Type: CDK_METADATA_TYPE },
        N: { Type: 'AWS::IAM::Role' },
      },
    };
    expect(extractResourceTypes(tmpl).sort()).toEqual(['AWS::IAM::Role', 'AWS::S3::Bucket']);
  });
  it('skips resources without a string Type', () => {
    const tmpl = { Resources: { A: { Type: 123 as unknown as string }, B: null } };
    expect(extractResourceTypes(tmpl)).toEqual([]);
  });
  it('returns empty for missing Resources', () => {
    expect(extractResourceTypes({})).toEqual([]);
  });
});

describe('judgeTemplate', () => {
  it('passes both verdicts for a template of non-blocklisted, non-tier3 types', () => {
    // AWS::S3::Bucket is SDK-registered and not runtime-blocklisted;
    // AWS::SomeService::SomeType stands in for a tier2 CC-API type (passes
    // optimistic pre-flight AND is not tier3).
    const tmpl = {
      Resources: { A: { Type: 'AWS::S3::Bucket' }, B: { Type: 'AWS::SomeService::SomeType' } },
    };
    const v = judgeTemplate(tmpl, SDK, TIER3);
    expect(v.runtimePass).toBe(true);
    expect(v.truthPass).toBe(true);
    expect(v.silentTier3).toEqual([]);
  });

  it('surfaces a silent tier-3 type: passes runtime, fails truth', () => {
    const tmpl = {
      Resources: { A: { Type: 'AWS::S3::Bucket' }, G: { Type: 'AWS::AppMesh::GatewayRoute' } },
    };
    const v = judgeTemplate(tmpl, SDK, TIER3);
    expect(v.runtimePass).toBe(true); // optimistic pre-flight lets it through
    expect(v.truthPass).toBe(false); // tier3 => will fail mid-deploy
    expect(v.silentTier3).toEqual(['AWS::AppMesh::GatewayRoute']);
    expect(v.truthBad).toEqual(['AWS::AppMesh::GatewayRoute']);
  });

  it('a CC-blocklisted-but-SDK-registered type (IAM::Role) passes both verdicts', () => {
    // IAM::Role is in the CC blocklist, but the real registry's SDK map is
    // checked first, so pre-flight passes — and it deploys via the SDK
    // provider. Both verdicts must agree (no false silent-tier3).
    const tmpl = { Resources: { R: { Type: 'AWS::IAM::Role' } } };
    const v = judgeTemplate(tmpl, SDK, TIER3);
    expect(v.runtimePass).toBe(true);
    expect(v.truthPass).toBe(true);
    expect(v.silentTier3).toEqual([]);
    expect(v.runtimeBad).toEqual([]);
  });

  it('an unknown intrinsic fails both verdicts', () => {
    const tmpl = {
      Resources: { A: { Type: 'AWS::S3::Bucket', Properties: { N: { 'Fn::Length': [] } } } },
    };
    const v = judgeTemplate(tmpl, SDK, TIER3);
    expect(v.runtimePass).toBe(false);
    expect(v.truthPass).toBe(false);
    expect(v.unknownIntrinsics).toEqual(['Fn::Length']);
  });
});

describe('parseRegisteredTypes', () => {
  it('extracts registry.register("AWS::X::Y") calls', () => {
    const src = `
      registry.register('AWS::IAM::Role', new R());
      registry.register("AWS::S3::Bucket", new B());
    `;
    expect([...parseRegisteredTypes(src)].sort()).toEqual(['AWS::IAM::Role', 'AWS::S3::Bucket']);
  });
});

describe('extractTier3', () => {
  it('reads a plain-string tier3 list', () => {
    expect([...extractTier3({ tier3: ['AWS::A::B', 'AWS::C::D'] })].sort()).toEqual([
      'AWS::A::B',
      'AWS::C::D',
    ]);
  });
  it('reads object-shaped entries (type / typeName / name)', () => {
    const out = extractTier3({
      tier3: [{ type: 'AWS::A::B' }, { typeName: 'AWS::C::D' }, { name: 'AWS::E::F' }],
    });
    expect([...out].sort()).toEqual(['AWS::A::B', 'AWS::C::D', 'AWS::E::F']);
  });
  it('tolerates a missing tier3 field', () => {
    expect(extractTier3({}).size).toBe(0);
  });
});

describe('rankFrequency', () => {
  it('sorts by count desc, then name asc', () => {
    const m = new Map([
      ['b', 1],
      ['a', 2],
      ['c', 2],
    ]);
    expect(rankFrequency(m)).toEqual([
      ['a', 2],
      ['c', 2],
      ['b', 1],
    ]);
  });
});

describe('parseCliArgs', () => {
  it('parses --json and dirs', () => {
    expect(parseCliArgs(['--json', 'a', 'b'])).toEqual({ json: true, help: false, dirs: ['a', 'b'] });
  });
  it('parses --help / -h', () => {
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['--help']).help).toBe(true);
  });
});

describe('measureCorpus (filesystem walk)', () => {
  it('reports a missing dir without throwing', () => {
    const report = measureCorpus(['/nonexistent/dir/xyz'], SDK, TIER3);
    expect(report.missingDirs).toEqual(['/nonexistent/dir/xyz']);
    expect(report.total).toBe(0);
  });
});

describe('RUNTIME_UNSUPPORTED_TYPES drift guard', () => {
  it('matches the unsupportedTypes set in cloud-control-provider.ts', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'src/provisioning/cloud-control-provider.ts'),
      'utf8'
    );
    // Extract the body of the `unsupportedTypes = new Set([ ... ])` literal
    // and pull every quoted type token out of it.
    const blockMatch = src.match(/unsupportedTypes\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(blockMatch).not.toBeNull();
    const body = blockMatch![1];
    const types = new Set<string>();
    const re = /['"]([A-Za-z0-9:]+::[A-Za-z0-9:]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) types.add(m[1]);
    expect(types.size).toBeGreaterThan(0);
    expect([...types].sort()).toEqual([...RUNTIME_UNSUPPORTED_TYPES].sort());
  });
});

describe('HANDLED_FN drift guard', () => {
  it('has exactly the 16 Fn::* the architecture rule documents', () => {
    // Sanity: Ref is handled separately, so HANDLED_FN holds the 16 Fn::*.
    expect(HANDLED_FN.size).toBe(16);
    expect(HANDLED_FN.has('Fn::Cidr')).toBe(true);
    expect(HANDLED_FN.has('Fn::GetStackOutput')).toBe(true);
  });
});

describe('run (end-to-end CLI dispatch)', () => {
  function makeIO(): { io: CliIO; out: string[]; err: string[]; exit: number | undefined } {
    const out: string[] = [];
    const err: string[] = [];
    const state = { exit: undefined as number | undefined };
    const io: CliIO = {
      log: (m) => out.push(m),
      error: (m) => err.push(m),
      setExitCode: (c) => {
        state.exit = c;
      },
    };
    return { io, out, err, get exit() { return state.exit; } };
  }

  it('prints help with --help and does not set a non-zero exit', () => {
    const h = makeIO();
    run(['--help'], h.io);
    expect(h.out.join('\n')).toContain('Usage: node scripts/compat-corpus.ts');
    expect(h.exit).toBeUndefined();
  });

  it('errors (exit 1) with no input dirs', () => {
    const h = makeIO();
    run([], h.io);
    expect(h.exit).toBe(1);
    expect(h.err.join('\n')).toContain('no input directory supplied');
  });

  it('errors (exit 1) when no valid templates are found', () => {
    const h = makeIO();
    run(['/nonexistent/dir/xyz'], h.io);
    expect(h.exit).toBe(1);
    expect(h.err.join('\n')).toContain('no valid CloudFormation templates found');
  });
});
