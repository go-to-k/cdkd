export function stringifyValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'undefined':
      return 'undefined';
    case 'function':
      return value.name ? `[Function: ${value.name}]` : '[Function]';
    case 'object':
      if (value === null) return 'null';
      try {
        const json = JSON.stringify(value);
        if (json !== undefined) return json;
      } catch {
        // Fall through to a stable object tag when JSON serialization fails.
      }
      return Object.prototype.toString.call(value);
  }
}
