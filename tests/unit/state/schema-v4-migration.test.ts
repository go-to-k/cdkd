import { describe, it, expect } from 'vite-plus/test';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type StackState,
  type StateImportEntry,
} from '../../../src/types/state.js';

describe('State schema v4 — Fn::ImportValue strong-reference field', () => {
  it('current schema version is 4', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBe(4);
  });

  it('readers accept every prior version + the new one', () => {
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(1);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(2);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(3);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(4);
  });

  it('StackState.imports is optional — v3 state without imports parses fine', () => {
    const v3State: StackState = {
      version: 3,
      stackName: 'Legacy',
      region: 'us-east-1',
      resources: {},
      outputs: { Foo: 'bar' },
      lastModified: 1,
    };
    // No type error, no runtime error — imports is just `undefined`.
    expect(v3State.imports).toBeUndefined();
  });

  it('v4 state round-trips through JSON without losing imports[]', () => {
    const entry: StateImportEntry = {
      sourceStack: 'Producer',
      sourceRegion: 'us-east-1',
      exportName: 'BucketArn',
    };
    const v4State: StackState = {
      version: 4,
      stackName: 'Consumer',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      imports: [entry],
      lastModified: 1,
    };

    const round = JSON.parse(JSON.stringify(v4State)) as StackState;
    expect(round.version).toBe(4);
    expect(round.imports).toHaveLength(1);
    expect(round.imports![0]).toEqual(entry);
  });

  it('v4 reader on v3 state defaults imports[] to undefined (empty effective)', () => {
    // Simulates: v4 cdkd reads a state file written by v3 cdkd.
    const v3Json = JSON.stringify({
      version: 3,
      stackName: 'OldStack',
      region: 'us-east-1',
      resources: {},
      outputs: { X: 'v' },
      lastModified: 1,
    });
    const parsed = JSON.parse(v3Json) as StackState;
    expect(parsed.version).toBe(3);
    expect(parsed.imports).toBeUndefined();
    // Strong-ref check at destroy treats this consumer as "no recorded
    // imports" — matches the gradual-activation migration story.
  });
});
