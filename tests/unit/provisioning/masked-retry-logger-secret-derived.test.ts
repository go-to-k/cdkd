/**
 * Issue #2177 -- `isSecretDerivedValue`, the predicate `withDerivedNameMasks`
 * uses to decide which derived names become needles, shared by the IAM, S3 and
 * Glue providers. A previous value persisted as exactly the redaction mask
 * (`***`, e.g. a NoEcho custom-resource `GetAtt` leaf) counts as secret-derived.
 */
import { describe, it, expect } from 'vite-plus/test';

import {
  BASE_MASKER_SUBSTRING_FLOOR,
  createMaskedLogSinks,
  isSecretDerivedValue,
  withDerivedNameMasks,
} from '../../../src/provisioning/masked-retry-logger.js';
import {
  createSecretMasker,
  MIN_NEEDLE_LENGTH,
  SECRET_MASK,
} from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

const identity = (t: string): string => t;
const silent = { debug: (): void => undefined, warn: (): void => undefined };

describe('isSecretDerivedValue (issue #2177)', () => {
  it('counts a value persisted as exactly *** as secret-derived, and nothing that merely contains it', () => {
    expect(isSecretDerivedValue(SECRET_MASK, identity)).toBe(true);
    expect(isSecretDerivedValue(`x${SECRET_MASK}`, identity)).toBe(false);
  });

  it('counts a {{resolve: reference and a value the masker changes, and nothing else', () => {
    expect(isSecretDerivedValue('{{resolve:secretsmanager:s}}', identity)).toBe(true);
    expect(isSecretDerivedValue('abc', (t) => t.replace('abc', SECRET_MASK))).toBe(true);
    expect(isSecretDerivedValue('plain', identity)).toBe(false);
    expect(isSecretDerivedValue('', identity)).toBe(false);
    expect(isSecretDerivedValue(42, identity)).toBe(false);
  });
});

describe('withDerivedNameMasks with a *** previous value (issue #2177)', () => {
  it('adds the recorded name as a needle', () => {
    const sinks = withDerivedNameMasks(silent, createMaskedLogSinks(silent, undefined), [
      [SECRET_MASK, 'oldplainname'],
    ]);
    expect(sinks.mask('arn:.../oldplainname')).toBe(`arn:.../${SECRET_MASK}`);
  });
});

/** The real bag shape: `Map<plaintext, the {{resolve:...}} it came from>`. */
function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

/** Sinks over the REAL deploy masker for `secrets`, extended by `pairs`. */
function needled(
  secrets: string[],
  pairs: ReadonlyArray<readonly [raw: unknown, derived: string | undefined]>
): ReturnType<typeof withDerivedNameMasks> {
  return withDerivedNameMasks(
    silent,
    createMaskedLogSinks(silent, createSecretMasker(bagOf(...secrets))),
    pairs
  );
}

describe('withDerivedNameMasks runs the base masker before its needles (issue #4193)', () => {
  it('does not split a longer recorded secret that contains the needle', () => {
    // The issue's direct repro. Needles first cut `prod-db owner hunter2x` at
    // `prod-db`, so the base no longer found it and ` owner hunter2x` printed.
    const sinks = needled(['prod-db', 'prod-db owner hunter2x'], [['prod-db', 'prod-db']]);
    expect(sinks.mask("Description 'prod-db owner hunter2x' is invalid.")).toBe(
      "Description '***' is invalid."
    );
  });

  it('does not split it with a needle shorter than the base floor, which it still applies', () => {
    const sinks = needled(['pdb', 'pdb owner hunter2x'], [['pdb', 'pdb']]);
    expect(sinks.mask("Description 'pdb owner hunter2x' is invalid.")).toBe(
      "Description '***' is invalid."
    );
    // Below the floor the base leaves a substring alone; the needle does not.
    expect(sinks.mask("Name 'pdb' is taken.")).toBe("Name '***' is taken.");
  });

  it('does not split a longer secret EMBEDDING the derived name', () => {
    const sinks = needled(
      ['hunter2', 'app-hunter2-db owner'],
      [['app-hunter2-db', 'app-hunter2-db']]
    );
    // The name occurs only INSIDE the longer secret, so the line is withheld.
    const embedded = sinks.mask("Description 'app-hunter2-db owner' is invalid.");
    expect(embedded).toBe('***');
    expect(embedded).not.toContain('owner');
    // The bare name still masks whole, not as `app-***-db`.
    expect(sinks.mask("Name 'app-hunter2-db' is taken.")).toBe("Name '***' is taken.");
  });

  it('still masks a derived name whose INSIDE the base rewrites', () => {
    // The IAM shape: `alice@example.com` rewritten to `stack-alice-example-com`,
    // with `alice` recorded too. The base turns the name into
    // `stack-***-example-com` first, so the raw needle would no longer occur.
    const sinks = needled(
      ['alice@example.com', 'alice'],
      [['alice@example.com', 'stack-alice-example-com']]
    );
    expect(sinks.mask('Role stack-alice-example-com already exists.')).toBe(
      'Role *** already exists.'
    );
    expect(sinks.mask('arn:aws:iam::123456789012:role/stack-alice-example-com')).toBe(
      'arn:aws:iam::123456789012:role/***'
    );
  });

  it('withholds a line where a recorded secret STRADDLES either edge of the derived name', () => {
    // The base rewrites the straddled occurrence differently than the name
    // alone, so no rendered needle matches it; without the check the part of
    // the name outside the straddling secret would print.
    const sinks = needled(
      ['alice@example.com', 'com-hunter22', 'hunter22-stack'],
      [['alice@example.com', 'stack-alice-example-com']]
    );
    // Premise: the base alone prints part of the name at each edge.
    const base = createSecretMasker(bagOf('alice@example.com', 'com-hunter22', 'hunter22-stack'));
    expect(base('x stack-alice-example-com-hunter22 y')).toBe('x stack-alice-example-*** y');
    expect(base('x hunter22-stack-alice-example-com y')).toBe('x ***-alice-example-com y');
    expect(sinks.mask('x stack-alice-example-com-hunter22 y')).toBe('***');
    expect(sinks.mask('x hunter22-stack-alice-example-com y')).toBe('***');
    // An ADJACENT secret is not a straddle: the name still matches whole.
    expect(sinks.mask('x stack-alice-example-com hunter22-stackx y')).toBe('x *** ***x y');
  });

  it('withholds a line where only ONE of two occurrences is straddled', () => {
    // One occurrence still matches the rendered needle, so a presence check
    // would pass; the check compares COUNTS.
    const sinks = needled(
      ['alice@example.com', 'com-hunter22'],
      [['alice@example.com', 'stack-alice-example-com']]
    );
    expect(sinks.mask('a stack-alice-example-com b stack-alice-example-com-hunter22 c')).toBe(
      '***'
    );
  });

  it('does not withhold a line for a name below the floor contained in a longer secret', () => {
    // The 3-character case above: the base hides the longer secret whole, and
    // the line keeps its wording.
    const sinks = needled(['pdb', 'pdb owner hunter2x'], [['pdb', 'pdb']]);
    expect(sinks.mask("Description 'pdb owner hunter2x' and 'pdb'.")).toBe(
      "Description '***' and '***'."
    );
  });

  it('renders like the base alone when every needle is one the base hides whole', () => {
    const base = createMaskedLogSinks(silent, createSecretMasker(bagOf('prod-db')));
    const sinks = withDerivedNameMasks(silent, base, [['prod-db', 'prod-db']]);
    for (const text of ["Name 'prod-db' is taken.", 'a***b', 'prod-dbprod-db']) {
      expect(sinks.mask(text)).toBe(base.mask(text));
    }
    // No secret-derived pair at all: the input sinks come back unchanged.
    expect(withDerivedNameMasks(silent, base, [['plain', 'plain']])).toBe(base);
  });

  it('renders each needle against the bag as it is at MASK time, not at build time', () => {
    // The base reads a bag that can grow after the sinks are built (the
    // rollback records secrets as it resolves them). A needle rendered once,
    // up front, would stay `stack-alice-example-com` while the base now
    // rewrites the text to `stack-***-example-com`, and the rest would print.
    const bag = bagOf('alice@example.com');
    const sinks = withDerivedNameMasks(silent, createMaskedLogSinks(silent, createSecretMasker(bag)), [
      ['alice@example.com', 'stack-alice-example-com'],
    ]);
    expect(sinks.mask('Role stack-alice-example-com failed.')).toBe('Role *** failed.');
    bag.set('alice', '{{resolve:secretsmanager:alice}}');
    expect(sinks.mask('Role stack-alice-example-com failed.')).toBe('Role *** failed.');
  });

  it('keeps its substring floor equal to MIN_NEEDLE_LENGTH', () => {
    // A leaf module spells the floor locally; this keeps the spellings together.
    expect(BASE_MASKER_SUBSTRING_FLOOR).toBe(MIN_NEEDLE_LENGTH);
  });
});
