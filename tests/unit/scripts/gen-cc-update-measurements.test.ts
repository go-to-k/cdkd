import { describe, it, expect } from 'vite-plus/test';
import {
  buildReport,
  findProblems,
  parseHelperTypes,
  renderMarkdown,
  type HelperTexts,
} from '../../../scripts/gen-cc-update-measurements.ts';
import type { CcUpdateMeasurement } from '../../../scripts/cc-update-measurements.ts';

const row = (over: Partial<CcUpdateMeasurement>): CcUpdateMeasurement => ({
  type: 'AWS::A::B',
  probe: 'p',
  result: 'clean',
  issue: 1,
  measured: '2026-11-20',
  ...over,
});

const texts: HelperTexts = {
  'cc-read-back-empty-keys':
    "export const CC_READ_BACK_EMPTY_KEYS: Readonly<Record<string, readonly string[]>> = {\n  'AWS::DataSync::Task': ['Schedule'],\n};\n",
  'cc-read-back-default-paths':
    "export const CC_READ_BACK_DEFAULT_PATHS: Readonly<Record<string, readonly X[]>> = {\n  'AWS::OpenSearchService::Domain': [\n    { path: ['AdvancedOptions'], value: { 'AWS::No::Nest': 1 } },\n  ],\n};\n",
  'guardduty-detector-patch': "const DETECTOR_TYPE = 'AWS::GuardDuty::Detector';\n",
  'elbv2-listener-rule-patch': "const LISTENER_RULE_TYPE = 'AWS::ELBv2::ListenerRule';\n",
};
const good: CcUpdateMeasurement[] = [
  row({ type: 'AWS::OpenSearchService::Domain', result: 'refuses', fix: 'cc-read-back-default-paths' }),
  row({ type: 'AWS::DataSync::Task', result: 'refuses', fix: 'cc-read-back-empty-keys' }),
  row({ type: 'AWS::GuardDuty::Detector', result: 'refuses', fix: 'guardduty-detector-patch' }),
  row({ type: 'AWS::ELBv2::ListenerRule', result: 'refuses', fix: 'elbv2-listener-rule-patch' }),
];

describe('gen-cc-update-measurements findProblems', () => {
  it('passes a consistent table', () => {
    expect(findProblems(good, texts)).toEqual([]);
  });

  it('(b) refuses a refuses row with neither fix nor exemption', () => {
    const rows = [...good, row({ type: 'AWS::X::Y', result: 'refuses' })];
    expect(findProblems(rows, texts).join('\n')).toContain('AWS::X::Y: refuses but has neither');
  });

  it('(b) refuses a refuses row with both fix and exemption', () => {
    const rows = [
      row({ type: 'AWS::DataSync::Task', result: 'refuses', fix: 'cc-read-back-empty-keys', exemption: 'x' }),
      ...good.slice(1),
    ];
    expect(findProblems(rows, texts).join('\n')).toContain('AWS::DataSync::Task: refuses with both');
  });

  it('(b) accepts an exemption alone', () => {
    const rows = [...good, row({ type: 'AWS::X::Y', result: 'refuses', exemption: 'why' })];
    expect(findProblems(rows, texts)).toEqual([]);
  });

  it('(c) refuses a fix module that does not name the type', () => {
    const rows = [...good, row({ type: 'AWS::X::Y', result: 'refuses', fix: 'guardduty-detector-patch' })];
    expect(findProblems(rows, texts).join('\n')).toContain('AWS::X::Y: fix module');
  });

  it('(d) refuses a helper-registered type with no refuses row', () => {
    const rows = good.filter((r) => r.type !== 'AWS::DataSync::Task');
    expect(findProblems(rows, texts).join('\n')).toContain('AWS::DataSync::Task: registered in');
    const clean = [row({ type: 'AWS::DataSync::Task' }), ...good.slice(1)];
    expect(findProblems(clean, texts).join('\n')).toContain('AWS::DataSync::Task: registered in');
  });

  it('(e) refuses a duplicate type', () => {
    expect(findProblems([...good, good[0]!], texts).join('\n')).toContain(
      'AWS::OpenSearchService::Domain: duplicate row'
    );
  });

  it('(f) refuses zero rows and a helper with zero parsed types', () => {
    expect(findProblems([], texts).join('\n')).toContain('no measurement rows');
    const empty = { ...texts, 'guardduty-detector-patch': '// nothing' };
    expect(findProblems(good, empty).join('\n')).toContain('guardduty-detector-patch.ts: parsed zero');
  });
});

describe('gen-cc-update-measurements parse and render', () => {
  it('parses the default-paths table keys', () => {
    expect(parseHelperTypes('cc-read-back-default-paths', texts['cc-read-back-default-paths'])).toEqual([
      'AWS::OpenSearchService::Domain',
    ]);
  });

  it('parses only the object keys, not mentions elsewhere', () => {
    const text = "// 'AWS::Doc::Mention'\nexport const CC_READ_BACK_EMPTY_KEYS = {\n  'AWS::A::B': ['K'],\n};\nconst x = 'AWS::C::D';\n";
    expect(parseHelperTypes('cc-read-back-empty-keys', text)).toEqual(['AWS::A::B']);
  });

  it('sorts rows, counts results, and escapes cells', () => {
    const report = buildReport([row({ type: 'AWS::Z::Z', note: 'a|b' }), row({ type: 'AWS::A::A', result: 'not-measured' })]);
    expect(report.rows.map((r) => r.type)).toEqual(['AWS::A::A', 'AWS::Z::Z']);
    expect(report.summary.clean).toBe(1);
    expect(renderMarkdown(report)).toContain('a\\|b');
  });
});
