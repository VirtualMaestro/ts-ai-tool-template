export type Frontmatter = { meta: Record<string, string>; body: string };

/**
 * Flat YAML frontmatter: one `key: value` per line, optional quotes.
 * ponytail: no nested maps or lists; if an agent needs them, swap in a YAML parser here.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: src.slice(m[0].length) };
}
