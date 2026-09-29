// Shared fixtures for go-to-k/cdkd#3994's Tags reader and the providers wired to it.

export const TAG_FIXTURE = {
  NEEDLE: 'issue3994-tag-needle',
  SECRET_REF: '{{resolve:secretsmanager:issue3994/tags:SecretString:k::}}',
} as const;

const { NEEDLE } = TAG_FIXTURE;

/** Every shape that is not a list of `{ Key: non-empty string, Value: scalar }`. */
export const MALFORMED_TAGS: Array<[string, unknown]> = [
  ['a bare string', NEEDLE],
  ['an empty string', ''],
  ['a number', 7],
  ['false', false],
  ['an object', { Key: NEEDLE, Value: 'v' }],
  ['an entry that is a string', [NEEDLE]],
  ['an entry with no Key', [{ Value: NEEDLE }]],
  ['an entry with an empty Key', [{ Key: '', Value: NEEDLE }]],
  ['an entry with a numeric Key', [{ Key: 1, Value: NEEDLE }]],
  ['an entry with no Value', [{ Key: NEEDLE }]],
  ['an entry with a null Value', [{ Key: NEEDLE, Value: null }]],
  ['an entry with an object Value', [{ Key: NEEDLE, Value: { v: 1 } }]],
  ['an entry with a list Value', [{ Key: NEEDLE, Value: ['v'] }]],
  ['a null entry', [null]],
  ['a nested list entry', [[{ Key: NEEDLE, Value: 'v' }]]],
  ['a good entry beside a bad one', [{ Key: 'env', Value: 'dev' }, { Key: NEEDLE }]],
];

/**
 * The per-provider sample: a bare string (walked by character before the fix),
 * an entry missing Value (dropped silently before the fix), and a
 * secret-derived Key (refused only on the desired side).
 */
export const PROVIDER_MALFORMED_DESIRED: Array<[string, unknown]> = [
  ['a bare string', NEEDLE],
  ['an entry with no Value', [{ Key: 'env' }]],
  ['a secret-derived Key', [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }]],
];

/** Recorded shapes that are unreadable (the secret-derived Key is readable there). */
export const PROVIDER_MALFORMED_RECORDED: Array<[string, unknown]> = [
  ['a bare string', NEEDLE],
  ['an entry with no Value', [{ Key: 'env' }]],
];
