/** Python-compatible helpers. The wire format was defined by the Python app, so serialization,
 * timestamps and truthiness follow Python exactly where a client can see the difference. */

export const isDict = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Python truthiness: None, False, 0, "", [] and {} are falsy. */
export function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/** `a or b` */
export const or = <A, B>(a: A, b: B): A | B => (truthy(a) ? a : b);

/** `obj.get(key)`: throws like Python's AttributeError when obj is not a dict (the app turns that into a 500). */
export function get(obj: unknown, key: string): any {
  if (!isDict(obj)) throw new TypeError(`'${pyType(obj)}' object has no attribute 'get'`);
  return obj[key];
}

/** Map keys must be hashable in Python; dict/list keys raise TypeError there. */
export function hashable<T>(v: T): T {
  if (isDict(v) || Array.isArray(v)) throw new TypeError(`unhashable type: '${pyType(v)}'`);
  return v;
}

function pyType(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  return 'dict';
}

/** str(v) for the JSON value types. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  return pyDumps(v);
}

const ESC: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

/** json.dumps(v) with Python defaults: ensure_ascii=True and ", " / ": " separators. */
export function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    return String(v).replace(/e([+-])(\d)$/, 'e$10$2');
  }
  if (typeof v === 'string') {
    return '"' + v.replace(/["\\]|[^ -~]/g, (c) => ESC[c] ?? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '"';
  }
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']';
  return '{' + Object.entries(v as object).map(([k, x]) => pyDumps(k) + ': ' + pyDumps(x)).join(', ') + '}';
}

/** datetime.now(timezone.utc).isoformat(): microseconds, "+00:00", fraction omitted when zero. */
export function now(): string {
  const d = new Date();
  const base = d.toISOString().slice(0, 19);
  const ms = d.getUTCMilliseconds();
  return base + (ms ? '.' + String(ms * 1000).padStart(6, '0') : '') + '+00:00';
}
