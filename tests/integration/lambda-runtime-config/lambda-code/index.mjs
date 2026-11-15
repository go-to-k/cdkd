// Runs only after the removal phase switches Runtime to nodejs22.x; under the
// customer-managed runtime the image's bootstrap answers instead. An .mjs
// file, because tests/integration/.gitignore ignores *.js.
export const handler = async () => ({ ok: 'nodejs' });
