import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  atomicWriteFile, backupOnce, blockContent, blockMarkers, isObject, pruneEmptyDirs, readBytes, readJsonObject, readText,
  removeBlock, sha256, upsertBlock, writeJson, type BlockStyle,
} from "./fsx.ts";

// An Op is one change a provider wants (absolute paths). An Entry is what the manifest remembers
// about an applied Op (paths relative to the scope root), enough to update or undo it later.

export type Scope = "project" | "global";

export type Op = { provider: string } & (
  | { type: "file"; path: string; content: string | Uint8Array }
  | { type: "json"; path: string; keyPath: string[]; mode: "set" | "push"; value: unknown }
  | { type: "block"; path: string; style: BlockStyle; content: string }
  | { type: "exec"; label: string; install: string[]; uninstall: string[] }
);

export type Entry = { provider: string } & (
  | { type: "file"; path: string; sha256: string }
  | { type: "json"; path: string; keyPath: string[]; mode: "set" | "push"; value: unknown }
  | { type: "block"; path: string; style: BlockStyle; sha256?: string } // older manifests lack sha256: update asks once
  | { type: "exec"; label: string; install: string[]; uninstall: string[] }
);

export type Manifest = { tool: string; version: string; scope: Scope; providers: string[]; entries: Entry[] };

export type Engine = {
  root: string;
  tool: string;
  force: boolean;
  run: (argv: string[]) => void;
  warn: (message: string) => void;
};

const posix = (p: string) => p.replace(/\\/g, "/");
const relTo = (root: string, abs: string) => posix(path.relative(root, abs));
/** Line endings do not count: an editor may convert them. */
const blockHash = (content: string) => sha256(content.replace(/\r\n/g, "\n").trim());

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function toEntry(op: Op, root: string): Entry {
  switch (op.type) {
    case "file": return { provider: op.provider, type: "file", path: relTo(root, op.path), sha256: sha256(op.content) };
    case "json": return { ...op, path: relTo(root, op.path) };
    case "block": return { provider: op.provider, type: "block", path: relTo(root, op.path), style: op.style, sha256: blockHash(op.content) };
    case "exec": return op;
  }
}

/** Same key = same slot: a new version replaces it instead of adding a second copy. */
export function entryKey(e: Entry): string {
  switch (e.type) {
    case "file": return `file:${e.path}`;
    case "json": return `json:${e.path}:${e.keyPath.join(".")}${e.mode === "push" ? `:${JSON.stringify(e.value)}` : ""}`;
    case "block": return `block:${e.path}`;
    case "exec": return `exec:${e.label}`;
  }
}

export function describe(e: Entry, action: "install" | "remove"): string {
  const sign = action === "install" ? "+" : "-";
  switch (e.type) {
    case "file": return `${sign} ${e.path}`;
    case "json": return `${sign} ${e.path} → ${e.keyPath.join(".")}${e.mode === "push" ? "[]" : ""}`;
    case "block": return `${sign} ${e.path} (marked block)`;
    case "exec": return `${sign} $ ${(action === "install" ? e.install : e.uninstall).join(" ")}`;
  }
}

/** Apply one op. Returns the entry to record, or the previous one when the user's version wins. */
export function apply(op: Op, previous: Entry | undefined, eng: Engine): Entry | undefined {
  const entry = toEntry(op, eng.root);
  const rel = "path" in entry ? entry.path : "";
  switch (op.type) {
    case "file": {
      const current = readBytes(op.path);
      const currentSha = current && sha256(current);
      if (currentSha === (entry as { sha256: string }).sha256) return entry;
      const ours = !current || (previous?.type === "file" && previous.sha256 === currentSha);
      if (!ours && !eng.force) {
        eng.warn(`kept ${rel}: ${previous ? "changed since install" : `not installed by ${eng.tool}`} (--force to overwrite)`);
        return previous;
      }
      atomicWriteFile(op.path, op.content);
      return entry;
    }
    case "json": {
      const obj = readJsonObject(op.path) ?? {};
      const [parent, key] = slot(obj, op.keyPath, true)!;
      if (op.mode === "push") {
        const list = Array.isArray(parent[key]) ? parent[key] : (parent[key] = []);
        if (list.some((x: unknown) => isDeepStrictEqual(x, op.value))) return entry;
        list.push(op.value);
      } else {
        const current = parent[key];
        if (isDeepStrictEqual(current, op.value)) return entry;
        const ours = current === undefined || (previous?.type === "json" && isDeepStrictEqual(current, previous.value));
        if (!ours && !eng.force) {
          eng.warn(`kept ${rel} → ${op.keyPath.join(".")}: already set to something else (--force to overwrite)`);
          return previous;
        }
        parent[key] = op.value;
      }
      backupOnce(op.path);
      writeJson(op.path, obj);
      return entry;
    }
    case "block": {
      const text = readText(op.path) ?? "";
      const markers = blockMarkers(eng.tool, op.style);
      const current = blockContent(text, markers);
      if (current !== undefined && editedBlock(current, previous) && blockHash(current) !== blockHash(op.content) && !eng.force) {
        eng.warn(`kept ${rel} (marked block): changed since install (--force to overwrite)`);
        return previous;
      }
      const next = upsertBlock(text, markers, op.content);
      if (next !== text) {
        if (op.style === "toml") backupOnce(op.path);
        atomicWriteFile(op.path, next);
      }
      return entry;
    }
    case "exec": {
      try { eng.run(op.uninstall); } catch { /* not there yet */ }
      try {
        eng.run(op.install);
        return entry;
      } catch (e) {
        eng.warn(`could not run "${op.install[0]}" (${errorMessage(e).split("\n")[0]}). Run it yourself:\n    ${shellLine(op.install)}`);
        return undefined;
      }
    }
  }
}

/**
 * Undo one recorded entry. Something the user changed since install is kept unless --force.
 * Throws when the undo fails, so the caller keeps the entry for a retry.
 */
export function revert(e: Entry, eng: Engine): void {
  if (e.type === "exec") {
    try { eng.run(e.uninstall); } catch (err) {
      throw new Error(`could not run "${e.uninstall[0]}" (${errorMessage(err).split("\n")[0]}). Run it yourself:\n    ${shellLine(e.uninstall)}`, { cause: err });
    }
    return;
  }
  const abs = path.resolve(eng.root, e.path);
  if (e.type === "file") {
    const current = readBytes(abs);
    if (!current) return;
    if (sha256(current) !== e.sha256 && !eng.force) {
      eng.warn(`kept ${e.path}: changed since install (--force to remove)`);
      return;
    }
    removeFile(abs, eng.root);
    return;
  }
  if (e.type === "block") {
    const text = readText(abs);
    if (text === undefined) return;
    const markers = blockMarkers(eng.tool, e.style);
    const current = blockContent(text, markers);
    if (current === undefined) return;
    if (editedBlock(current, e) && !eng.force) {
      eng.warn(`kept ${e.path} (marked block): changed since install (--force to remove)`);
      return;
    }
    const next = removeBlock(text, markers);
    if (next.trim() === "") removeFile(abs, eng.root);
    else atomicWriteFile(abs, next);
    return;
  }
  const obj = readJsonObject(abs);
  if (!obj) return;
  const target = slot(obj, e.keyPath, false);
  if (!target || !Object.hasOwn(target[0], target[1])) return;
  const [parent, key] = target;
  if (e.mode === "push") {
    if (!Array.isArray(parent[key])) return;
    parent[key] = parent[key].filter((x: unknown) => !isDeepStrictEqual(x, e.value));
  } else if (isDeepStrictEqual(parent[key], e.value) || eng.force) {
    delete parent[key];
  } else {
    eng.warn(`kept ${e.path} → ${e.keyPath.join(".")}: changed since install (--force to remove)`);
    return;
  }
  dropEmpty(obj, e.keyPath);
  if (Object.keys(obj).length === 0) removeFile(abs, eng.root);
  else writeJson(abs, obj);
}

function removeFile(abs: string, root: string): void {
  fs.rmSync(abs, { force: true });
  pruneEmptyDirs(path.dirname(abs), root);
}

/** The block differs from what was installed. Older manifests have no hash: their block counts as unchanged. */
function editedBlock(current: string, e: Entry | undefined): boolean {
  return e?.type === "block" && e.sha256 !== undefined && blockHash(current) !== e.sha256;
}

/** The object that holds the last key of keyPath, and that key. */
function slot(obj: Record<string, any>, keyPath: string[], create: boolean): [Record<string, any>, string] | undefined {
  const key = keyPath.at(-1);
  if (key === undefined || keyPath.includes("__proto__")) throw new Error(`unsafe JSON key path "${keyPath.join(".")}"`);
  const parent = walk(obj, keyPath.slice(0, -1), create);
  return parent && [parent, key];
}

function walk(obj: Record<string, any>, keys: string[], create: boolean): Record<string, any> | undefined {
  let node = obj;
  for (const k of keys) {
    if (!node[k] || typeof node[k] !== "object" || Array.isArray(node[k])) {
      if (!create) return undefined;
      node[k] = {};
    }
    node = node[k];
  }
  return node;
}

/** Remove containers along keyPath that our removal left empty, deepest first. */
function dropEmpty(obj: Record<string, any>, keyPath: string[]): void {
  for (let depth = keyPath.length; depth > 0; depth--) {
    const parent = walk(obj, keyPath.slice(0, depth - 1), false);
    const key = keyPath[depth - 1];
    const v = parent?.[key];
    if (!parent) return;
    if (v === undefined) continue; // the key we just deleted
    const empty = Array.isArray(v) ? v.length === 0 : v && typeof v === "object" && Object.keys(v).length === 0;
    if (!empty) return;
    delete parent[key];
  }
}

function shellLine(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

export function manifestPath(root: string, tool: string): string {
  return path.join(root, ".ai-tools", `${tool}.json`);
}

export function readManifest(root: string, tool: string, scope: Scope): Manifest | undefined {
  const file = manifestPath(root, tool);
  const text = readText(file);
  if (text === undefined) return undefined;
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON, refusing to use it`, { cause: e });
  }
  // The other scope's manifest: the project is the home folder.
  if (isObject(m) && (m.scope === "project" || m.scope === "global") && m.scope !== scope) return undefined;
  const problem = manifestProblem(m, root, tool, scope);
  if (problem) throw new Error(`${file} is not a valid ${tool} manifest (${problem}), refusing to use it`);
  return m as Manifest;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function manifestProblem(m: unknown, root: string, tool: string, scope: Scope): string | undefined {
  if (!isObject(m)) return "not a JSON object";
  if (m.tool !== tool || m.scope !== scope) return `made for ${String(m.tool)} ${String(m.scope)}`;
  if (typeof m.version !== "string" || !isStrings(m.providers) || !Array.isArray(m.entries)) return "no version, providers or entries";
  for (const e of m.entries) {
    const problem = entryProblem(e, root, scope);
    if (problem) return `${problem}: ${JSON.stringify(e)}`;
  }
  return undefined;
}

// A project manifest can come with a cloned repository: it may name only paths inside the project,
// and no commands. The global one is in the user's home, and CLAUDE_CONFIG_DIR may point anywhere.
function entryProblem(e: unknown, root: string, scope: Scope): string | undefined {
  if (!isObject(e) || typeof e.provider !== "string") return "not an entry";
  if (e.type === "exec") {
    if (scope === "project") return "a command in a project manifest";
    const isCommand = (v: unknown) => isStrings(v) && v.length > 0;
    return typeof e.label === "string" && isCommand(e.install) && isCommand(e.uninstall) ? undefined : "bad command entry";
  }
  if (typeof e.path !== "string" || (scope === "project" && !isInside(root, e.path))) return "path outside the project";
  switch (e.type) {
    case "file": return typeof e.sha256 === "string" ? undefined : "bad file entry";
    case "block": return (e.style === "md" || e.style === "toml") && (e.sha256 === undefined || typeof e.sha256 === "string") ? undefined : "bad block entry";
    case "json": return isStrings(e.keyPath) && e.keyPath.length > 0 && !e.keyPath.includes("__proto__") && (e.mode === "set" || e.mode === "push") ? undefined : "bad JSON entry";
    default: return "unknown entry type";
  }
}

function isInside(root: string, rel: string): boolean {
  const r = path.relative(root, path.resolve(root, rel));
  return r !== "" && !path.isAbsolute(r) && r.split(path.sep)[0] !== "..";
}

export function writeManifest(root: string, m: Manifest): void {
  const file = manifestPath(root, m.tool);
  if (m.entries.length === 0) {
    fs.rmSync(file, { force: true });
    pruneEmptyDirs(path.dirname(file), root);
  } else {
    writeJson(file, m);
  }
}
