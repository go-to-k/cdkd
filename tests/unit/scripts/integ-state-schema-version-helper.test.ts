import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Executable checks for `tests/integration/state-schema-version.sh`, the helper
 * that derives the expected state.json schema version from record shape
 * (go-to-k/cdkd#7178). Sourced under the system bash (3.2 on macOS).
 */

const HELPER = join(import.meta.dirname, '../../../tests/integration/state-schema-version.sh');
const BASH = '/bin/bash';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'state-schema-version-'));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function derive(state: unknown, viaStdin = false): string {
  const path = join(sandbox, 'state.json');
  writeFileSync(path, JSON.stringify(state));
  const arg = viaStdin ? `- < '${path}'` : `'${path}'`;
  const r = spawnSync(BASH, ['-c', `. '${HELPER}'; expected_state_schema_version ${arg}`], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

const plain = { resourceType: 'AWS::SQS::Queue', physicalId: 'q', properties: {} };
const macs = { ...plain, noEchoValueMacs: { Value: 'mac' } };
const sent = { ...plain, referenceProvenance: { Ref: { versionsSent: ['v1'] } } };

describe('expected_state_schema_version', () => {
  it('prints 16 when no record carries a version-raising field', () => {
    expect(derive({ version: 16, resources: { A: plain } })).toBe('16');
    expect(derive({ version: 16 })).toBe('16');
  });

  it('prints 17 when a record carries noEchoValueMacs', () => {
    expect(derive({ resources: { A: plain, B: macs } })).toBe('17');
  });

  it('prints 18 when a record carries referenceProvenance.versionsSent, even beside macs', () => {
    expect(derive({ resources: { A: macs, B: sent } })).toBe('18');
  });

  it('looks inside orphans[].state and supersededResources[].state', () => {
    expect(derive({ resources: {}, orphans: [{ state: macs }] })).toBe('17');
    expect(derive({ resources: {}, supersededResources: [{ state: sent }] })).toBe('18');
  });

  it('ignores a referenceProvenance entry without versionsSent', () => {
    const r = { ...plain, referenceProvenance: { Ref: { other: 1 } } };
    expect(derive({ resources: { A: r } })).toBe('16');
  });

  it('reads stdin when given -', () => {
    expect(derive({ resources: { A: sent } }, true)).toBe('18');
  });
});
