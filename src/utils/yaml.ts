/**
 * Simple JSON to YAML converter (CDK CLI compatible output)
 *
 * Used by `synth` (CloudFormation template) and `list` (long output) for
 * human-friendly YAML rendering. Matches the quoting style of CDK CLI:
 * single-quote JSON-like / multi-line strings, double-quote strings whose
 * literal content collides with YAML scalar keywords.
 */
export function toYaml(obj: unknown, indent = 0): string {
  const prefix = '  '.repeat(indent);

  if (obj === null || obj === undefined) return 'null\n';
  if (typeof obj === 'boolean') return `${obj}\n`;
  if (typeof obj === 'number') return `"${obj}"\n`;
  if (typeof obj === 'string') {
    // Strings that need quoting
    if (obj.includes('\n')) {
      // Multi-line: use single quotes with escaped content
      return `'${obj.replace(/'/g, "''")}'\n`;
    }
    if (obj.startsWith('{') || obj.startsWith('[') || obj.startsWith('"')) {
      // JSON-like strings: use single quotes (like CDK CLI)
      return `'${obj.replace(/'/g, "''")}'\n`;
    }
    if (obj.includes('#') || obj === '' || obj === 'true' || obj === 'false' || obj === 'null') {
      return `"${obj}"\n`;
    }
    // Plain string (no quoting needed for colons in values like AWS::S3::Bucket)
    return `${obj}\n`;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]\n';
    let result = '\n';
    for (const item of obj) {
      const value = toYaml(item, indent + 1).trimStart();
      result += `${prefix}- ${value}`;
    }
    return result;
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}\n';
    let result = '\n';
    for (const [key, value] of entries) {
      // Keys with special chars need quoting, but AWS:: style keys don't
      const safeKey = key.includes(' ') ? `"${key}"` : key;
      // Non-empty arrays / objects render their contents on subsequent lines,
      // so the colon is followed directly by the leading newline returned by
      // the recursive toYaml call. Empty containers (`[]` / `{}`) and scalar
      // values render inline, so they need a space after the colon to match
      // standard YAML formatting (e.g. `dependencies: []`, not `dependencies:[]`).
      const isContainer = typeof value === 'object' && value !== null;
      const isEmptyContainer =
        isContainer &&
        (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0);
      if (isContainer && !isEmptyContainer) {
        result += `${prefix}${safeKey}:${toYaml(value, indent + 1)}`;
      } else {
        result += `${prefix}${safeKey}: ${toYaml(value, indent + 1).trimStart()}`;
      }
    }
    return result;
  }

  return `${String(obj)}\n`;
}
