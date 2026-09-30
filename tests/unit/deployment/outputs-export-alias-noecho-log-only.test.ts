import { describe, it, expect } from 'vite-plus/test';
import {
  exportAliasCollisionScrubWarning,
  exportAliasCollisionWarning,
  exportNameSecretExposure,
  secretBearingExportNameWarning,
  secretSafeKeyDisplay,
} from '../../../src/deployment/outputs-export-alias.js';
import {
  SECRET_MASK,
  printingCorpusOf,
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// go-to-k/cdkd#4049: the export-alias WARNINGS mask a `NoEcho` parameter's
// value (a LOG-ONLY needle of the pass bag). Of the verdicts, only the
// `Export.Name` refusal reads it (go-to-k/cdkd#4043); the state-key scan keeps
// reading the map alone.
const NOECHO = 'hunter2NoEchoName';

function logOnlyBag(...needles: string[]): RecordedSecretValues {
  const bag: RecordedSecretValues = new Map();
  for (const needle of needles) recordLogOnlyValue(bag, needle);
  return bag;
}

describe('export-alias warnings mask a log-only needle (go-to-k/cdkd#4049)', () => {
  it('masks a colliding Export.Name and output key built from a NoEcho value', () => {
    const message = exportAliasCollisionWarning(
      `Owner${NOECHO}`,
      `Exp${NOECHO}`,
      logOnlyBag(NOECHO)
    );
    expect(message).toContain(`exports as "Exp${SECRET_MASK}"`);
    expect(message).toContain(`Output Owner${SECRET_MASK} exports`);
    expect(message).not.toContain(NOECHO);
  });

  it('masks a whole Export.Name equal to a short log-only needle', () => {
    const message = exportAliasCollisionWarning('Owner', 'Ab1', logOnlyBag('Ab1'));
    expect(message).toContain(`exports as "${SECRET_MASK}"`);
    expect(message).not.toContain('Ab1');
  });

  it('masks a log-only needle beside a recorded secret in the refusal warning', () => {
    const secrets: RecordedSecretValues = new Map([['dynref-plain', '{{resolve:ssm-secure:/x}}']]);
    recordLogOnlyValue(secrets, NOECHO);
    const exportName = `dynref-plain-${NOECHO}`;
    const exposure = exportNameSecretExposure(exportName, new Map(), secrets)!;
    const message = secretBearingExportNameWarning('Owner', exportName, exposure, secrets);
    expect(message).toContain(`(masked: "${SECRET_MASK}-${SECRET_MASK}")`);
    expect(message).not.toContain(NOECHO);
    expect(message).not.toContain('dynref-plain');
  });

  it("masks the scrub collision warning's names", () => {
    const message = exportAliasCollisionScrubWarning(
      `Owner${NOECHO}`,
      `Exp${NOECHO}`,
      logOnlyBag(NOECHO)
    );
    expect(message).toContain(`exports as "Exp${SECRET_MASK}"`);
    expect(message).not.toContain(NOECHO);
  });

  it('prints a name no needle touches unchanged (negative control)', () => {
    const message = exportAliasCollisionWarning('Owner', 'PlainExport', logOnlyBag(NOECHO));
    expect(message).toContain('Output Owner exports as "PlainExport"');
  });
});

describe('which verdicts read a log-only needle (go-to-k/cdkd#4043)', () => {
  it('refuses an Export.Name carrying only a log-only needle', () => {
    const bag = logOnlyBag(NOECHO);
    expect([...(exportNameSecretExposure(`Exp${NOECHO}`, bag, bag)?.keys() ?? [])]).toEqual([
      NOECHO,
    ]);
  });

  it("does not report a state key carrying only a log-only needle (scrub's --fail scan)", () => {
    expect(secretSafeKeyDisplay(`Exp${NOECHO}`, logOnlyBag(NOECHO))).toEqual({
      kind: 'safe',
      text: `Exp${NOECHO}`,
    });
  });
});

describe('printingCorpusOf (go-to-k/cdkd#4049)', () => {
  it('returns the bag itself when it holds no log-only needle', () => {
    const secrets: RecordedSecretValues = new Map([['plain', '{{resolve:x}}']]);
    expect(printingCorpusOf(secrets)).toBe(secrets);
  });

  it('adds each log-only needle as a mask entry to a NEW map, leaving the bag untouched', () => {
    const secrets: RecordedSecretValues = new Map([['plain', '{{resolve:x}}']]);
    recordLogOnlyValue(secrets, NOECHO);
    recordLogOnlyValue(secrets, 'plain');
    const corpus = printingCorpusOf(secrets);
    expect(corpus).not.toBe(secrets);
    expect([...corpus]).toEqual([
      ['plain', '{{resolve:x}}'],
      [NOECHO, SECRET_MASK],
    ]);
    expect([...secrets]).toEqual([['plain', '{{resolve:x}}']]);
  });
});
