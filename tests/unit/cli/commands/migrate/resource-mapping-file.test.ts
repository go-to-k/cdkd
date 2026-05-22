import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  readMappingFile,
  writeMappingFile,
  RESOURCE_MAPPING_FILENAME,
} from '../../../../../src/cli/commands/migrate/resource-mapping-file.js';
import type { ResourceMappingResult } from '../../../../../src/cli/commands/migrate/resource-mapper.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cdkd-mapping-file-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function fixtureResult(): ResourceMappingResult {
  return {
    mapping: { Source1: 'Synth1', Source2: 'Synth2' },
    pairs: [
      {
        sourceLogicalId: 'Source1',
        synthLogicalId: 'Synth1',
        physicalId: 'phys-1',
        resourceType: 'AWS::S3::Bucket',
      },
      {
        sourceLogicalId: 'Source2',
        synthLogicalId: 'Synth2',
        physicalId: 'phys-2',
        resourceType: 'AWS::SNS::Topic',
      },
    ],
    unmatched: [],
  };
}

describe('writeMappingFile + readMappingFile (round-trip)', () => {
  it('writes a file with the canonical mapping shape and reads it back', () => {
    const path = writeMappingFile(workDir, {
      sourceStack: 'MyCfnStack',
      outputStack: 'MyCfnStack',
      result: fixtureResult(),
    });
    expect(path.endsWith(RESOURCE_MAPPING_FILENAME)).toBe(true);
    const read = readMappingFile(path);
    expect(read.version).toBe(1);
    expect(read.sourceStack).toBe('MyCfnStack');
    expect(read.outputStack).toBe('MyCfnStack');
    expect(read.mapping).toEqual({ Source1: 'Synth1', Source2: 'Synth2' });
    expect(typeof read.generatedAt).toBe('string');
    expect(read.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601 prefix
  });

  it('includes _unmatched when result has unmatched entries', () => {
    const result: ResourceMappingResult = {
      ...fixtureResult(),
      unmatched: [
        {
          sourceLogicalId: 'OrphanedTopic',
          resourceType: 'AWS::SNS::Topic',
          candidates: ['SynthCandA', 'SynthCandB'],
          reason: 'no-match',
        },
      ],
    };
    const path = writeMappingFile(workDir, {
      sourceStack: 'S',
      outputStack: 'S',
      result,
    });
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw._unmatched).toHaveLength(1);
    expect(raw._unmatched[0]).toEqual({
      sourceLogicalId: 'OrphanedTopic',
      resourceType: 'AWS::SNS::Topic',
      candidates: ['SynthCandA', 'SynthCandB'],
      reason: 'no-match',
    });
  });

  it('omits _unmatched when there are no unmatched entries', () => {
    const path = writeMappingFile(workDir, {
      sourceStack: 'S',
      outputStack: 'S',
      result: fixtureResult(),
    });
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(raw._unmatched).toBeUndefined();
  });

  it('preserves _unmatched across a write → read round-trip when present', () => {
    const result: ResourceMappingResult = {
      ...fixtureResult(),
      unmatched: [
        {
          sourceLogicalId: 'Foo',
          resourceType: 'AWS::Lambda::Function',
          candidates: [],
          reason: 'logical-id-collision',
        },
      ],
    };
    const path = writeMappingFile(workDir, {
      sourceStack: 'S',
      outputStack: 'S',
      result,
    });
    const read = readMappingFile(path);
    expect(read._unmatched).toHaveLength(1);
    expect(read._unmatched?.[0]?.reason).toBe('logical-id-collision');
  });
});

describe('readMappingFile — validation', () => {
  it('throws when the file does not exist', () => {
    expect(() => readMappingFile(join(workDir, 'nope.json'))).toThrow(/not found/);
  });

  it('throws on malformed JSON', () => {
    const path = join(workDir, 'bad.json');
    writeFileSync(path, '{ not json', 'utf-8');
    expect(() => readMappingFile(path)).toThrow(/not valid JSON/);
  });

  it('throws when version is missing or wrong', () => {
    const path = join(workDir, 'v2.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        generatedAt: '2026-01-01T00:00:00Z',
        sourceStack: 'a',
        outputStack: 'a',
        mapping: {},
      }),
      'utf-8'
    );
    expect(() => readMappingFile(path)).toThrow(/unsupported version/);
  });

  it('throws when mapping is missing', () => {
    const path = join(workDir, 'no-mapping.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: '2026-01-01T00:00:00Z',
        sourceStack: 'a',
        outputStack: 'a',
      }),
      'utf-8'
    );
    expect(() => readMappingFile(path)).toThrow(/missing the required 'mapping'/);
  });

  it('throws when mapping has a non-string value', () => {
    const path = join(workDir, 'bad-mapping.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: '2026-01-01T00:00:00Z',
        sourceStack: 'a',
        outputStack: 'a',
        mapping: { Source: 42 },
      }),
      'utf-8'
    );
    expect(() => readMappingFile(path)).toThrow(/non-string value/);
  });

  it('throws when top-level JSON is an array (not an object)', () => {
    const path = join(workDir, 'array.json');
    writeFileSync(path, JSON.stringify([1, 2, 3]), 'utf-8');
    expect(() => readMappingFile(path)).toThrow(/JSON object at the top level/);
  });

  it('throws when sourceStack is missing or empty', () => {
    const path = join(workDir, 'no-source.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: '2026-01-01T00:00:00Z',
        sourceStack: '',
        outputStack: 'a',
        mapping: {},
      }),
      'utf-8'
    );
    expect(() => readMappingFile(path)).toThrow(/required 'sourceStack'/);
  });

  it('silently filters out malformed _unmatched entries on read', () => {
    const path = join(workDir, 'bad-unmatched.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: '2026-01-01T00:00:00Z',
        sourceStack: 's',
        outputStack: 's',
        mapping: {},
        _unmatched: [
          { sourceLogicalId: 'ok', resourceType: 'AWS::S3::Bucket', candidates: [], reason: 'no-match' },
          { junk: true },
          { sourceLogicalId: 'no-reason', resourceType: 'AWS::S3::Bucket', candidates: [] },
        ],
      }),
      'utf-8'
    );
    const read = readMappingFile(path);
    expect(read._unmatched).toHaveLength(1);
    expect(read._unmatched?.[0]?.sourceLogicalId).toBe('ok');
  });

  it('writes into a nested output directory the caller created', () => {
    const nested = join(workDir, 'nested', 'output');
    mkdirSync(nested, { recursive: true });
    const path = writeMappingFile(nested, {
      sourceStack: 'S',
      outputStack: 'S',
      result: fixtureResult(),
    });
    expect(path).toBe(join(nested, RESOURCE_MAPPING_FILENAME));
    expect(readMappingFile(path).mapping).toEqual({ Source1: 'Synth1', Source2: 'Synth2' });
  });
});
