// Just enough TOML to write Codex agents and [mcp_servers.*] tables. Writing only, never parsing.

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : tomlString(key);
}

export function tomlString(s: string): string {
  // Multi-line literal strings keep long instructions readable; anything they cannot hold goes basic.
  if (s.includes("\n") && !s.includes("'''") && !s.endsWith("'") &&!/[\x00-\x08\x0b-\x1f\x7f]/.test(s.replace(/\r\n/g, "\n"))) {
    return `'''\n${s.replace(/\r\n/g, "\n")}'''`;
  }
  // JSON string escapes are valid TOML basic-string escapes; TOML also forbids a raw DEL.
  return JSON.stringify(s).replace(/\x7f/g, "\\u007F");
}

export function tomlValue(v: unknown): string {
  if (typeof v === "string") return tomlString(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v && typeof v === "object") {
    const pairs = Object.entries(v).filter(([, x]) => x !== undefined && x !== null);
    return `{ ${pairs.map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(", ")} }`;
  }
  throw new Error(`cannot write ${String(v)} as TOML`);
}

/** Top-level key = value lines. Nested objects become inline tables. */
export function tomlBody(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}\n`)
    .join("");
}

export function tomlTable(header: string[], obj: Record<string, unknown>): string {
  return `[${header.map(tomlKey).join(".")}]\n${tomlBody(obj)}`;
}
