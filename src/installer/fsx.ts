import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function atomicWriteFile(filePath: string, content: string | Uint8Array): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, content, { flag: "wx" });
  try {
    replaceFile(tmp, filePath);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Rename from over to. If that fails, the original is still at to. */
function replaceFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    // Windows refuses to rename over a file another program holds open, but can move that file aside.
    const aside = `${from}.old`;
    try {
      fs.renameSync(to, aside);
    } catch {
      throw e;
    }
    try {
      fs.renameSync(from, to);
    } catch (again) {
      fs.renameSync(aside, to);
      throw again;
    }
    fs.rmSync(aside, { force: true });
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function readText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    throw e;
  }
}

export function readBytes(filePath: string): Buffer | undefined {
  try {
    return fs.readFileSync(filePath);
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    throw e;
  }
}

/** A file we cannot parse is never rewritten: the user's settings matter more than our entry. */
export function readJsonObject(filePath: string): Record<string, any> | undefined {
  const text = readText(filePath);
  if (text === undefined || text.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${filePath} is not valid JSON, refusing to modify it: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`${filePath} is not a JSON object, refusing to modify it`);
  return parsed;
}

export function writeJson(filePath: string, value: unknown): void {
  atomicWriteFile(filePath, JSON.stringify(value, null, 2) + "\n");
}

/** Copy a foreign config file once, before the first time we touch it. */
export function backupOnce(filePath: string): void {
  const bak = `${filePath}.bak`;
  if (fs.existsSync(filePath) && !fs.existsSync(bak)) fs.copyFileSync(filePath, bak);
}

/** All files under dir, as sorted "/"-separated relative paths. */
export function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replace(/\\/g, "/"))
    .sort();
}

/** Remove empty directories from dir upwards, never at or above stopAt. */
export function pruneEmptyDirs(dir: string, stopAt: string): void {
  const stop = path.resolve(stopAt);
  let current = path.resolve(dir);
  while (current.startsWith(stop + path.sep) && current !== stop) {
    try {
      fs.rmdirSync(current);
    } catch {
      return; // not empty or gone
    }
    current = path.dirname(current);
  }
}

export type BlockStyle = "md" | "toml";

export function blockMarkers(tool: string, style: BlockStyle): [string, string] {
  return style === "md"
    ? [`<!-- ${tool}:start -->`, `<!-- ${tool}:end -->`]
    : [`# >>> ${tool} >>>`, `# <<< ${tool} <<<`];
}

/** Replace the marked block in text, or append it. */
export function upsertBlock(text: string, markers: [string, string], content: string): string {
  const block = `${markers[0]}\n${content.trim()}\n${markers[1]}`;
  const range = findBlock(text, markers);
  if (range) return text.slice(0, range[0]) + block + text.slice(range[1]);
  const sep = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${sep}${block}\n`;
}

/** The text between the markers, or undefined when there is no block. */
export function blockContent(text: string, markers: [string, string]): string | undefined {
  const range = findBlock(text, markers);
  return range && text.slice(range[0] + markers[0].length, range[1] - markers[1].length);
}

export function removeBlock(text: string, markers: [string, string]): string {
  const range = findBlock(text, markers);
  if (!range) return text;
  const before = text.slice(0, range[0]).replace(/\n+$/, "");
  const after = text.slice(range[1]).replace(/^\n+/, "");
  if (!before) return after;
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

function findBlock(text: string, [start, end]: [string, string]): [number, number] | undefined {
  const from = text.indexOf(start);
  if (from < 0) return undefined;
  const to = text.indexOf(end, from);
  if (to < 0) throw new Error(`found "${start}" without its closing "${end}"`);
  return [from, to + end.length];
}
