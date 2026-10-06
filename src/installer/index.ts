import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAssets } from "./assets.ts";
import { readBytes, sha256 } from "./fsx.ts";
import {
  apply, describe, entryKey, readManifest, revert, toEntry, writeManifest,
  type Engine, type Entry, type Manifest, type Scope,
} from "./ops.ts";
import { confirm, multiSelect, select } from "./prompt.ts";
import { PROVIDERS, type Ctx } from "./providers.ts";

// Self-contained: nothing here imports from outside src/installer/, so a tool made from the
// template can take installer fixes by copying this folder over its own.

export type ToolInfo = { name: string; version: string; assetsDir: string };

export type RunOptions = {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Menus and confirmation. Defaults to "stdin and stdout are a terminal". */
  interactive?: boolean;
  /** Runs an external command such as `claude mcp add-json`; throws on failure. */
  run?: (argv: string[]) => void;
  log?: (line: string) => void;
};

export const INSTALLER_COMMANDS = ["install", "uninstall", "status"];

export const INSTALLER_HELP = `  install     Install or update for Claude Code and/or Codex
  uninstall   Remove everything the install wrote
  status      Show what is installed and whether it is out of date

Options:
  --project          Install into the project (default without a terminal)
  --global           Install for the current user (~/.claude, ~/.codex, ~/.agents)
  --agents <list>    Comma-separated: ${PROVIDERS.map((p) => p.id).join(", ")}
  --dir <path>       Project root (default: current directory)
  -y, --yes          Do not ask for confirmation
  --dry-run          Print the plan, change nothing
  --force            Overwrite or remove files changed since install`;

export async function runInstallerCommand(command: string, argv: string[], tool: ToolInfo, opts: RunOptions = {}): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "boolean" },
      global: { type: "boolean" },
      agents: { type: "string" },
      dir: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
    },
  });
  if (values.project && values.global) throw new Error("use either --project or --global");

  const env = opts.env ?? process.env;
  const home = path.resolve(opts.home ?? os.homedir());
  const cwd = path.resolve(opts.cwd ?? process.cwd(), values.dir ?? ".");
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const log = opts.log ?? ((line: string) => console.log(line));
  const run = opts.run ?? ((a: string[]) => void execFileSync(a[0], a.slice(1), { stdio: "pipe", env }));
  const rootFor = (s: Scope) => (s === "global" ? home : cwd);
  const flagScope: Scope | undefined = values.global ? "global" : values.project ? "project" : undefined;
  const installedScopes = (["project", "global"] as Scope[]).filter((s) => readManifest(rootFor(s), tool.name));
  const agentsFlag = values.agents === undefined ? undefined : parseAgents(values.agents);
  const allIds = PROVIDERS.map((p) => p.id);
  const choices = PROVIDERS.map((p) => ({ label: p.label, value: p.id }));
  const scopeChoices = [
    { label: `Project  ${cwd}`, value: "project" },
    { label: `Global   ${home}`, value: "global" },
  ];

  const warnings: string[] = [];
  const engine = (root: string): Engine => ({
    root, tool: tool.name, force: Boolean(values.force), run, warn: (w) => warnings.push(w),
  });
  const flushWarnings = () => warnings.splice(0).forEach((w) => log(`! ${w}`));

  if (command === "status") {
    const scopes = flagScope ? [flagScope] : installedScopes;
    if (!scopes.some((s) => installedScopes.includes(s))) log(`${tool.name} is not installed.`);
    for (const s of scopes) {
      const m = readManifest(rootFor(s), tool.name);
      if (m) log(statusReport(m, rootFor(s), tool.version));
    }
    return 0;
  }

  if (command === "uninstall") {
    let scope = flagScope ?? installedScopes[0];
    if (!flagScope && installedScopes.length > 1 && interactive) {
      scope = (await select("Uninstall from where?", scopeChoices, "project")) as Scope;
    }
    const root = scope && rootFor(scope);
    const m = root && readManifest(root, tool.name);
    if (!m) {
      log(`${tool.name} is not installed${scope ? ` (${scope})` : ""}.`);
      return 0;
    }
    const remove = agentsFlag ?? m.providers;
    const [gone, kept] = partition(m.entries, (e) => remove.includes(e.provider));
    log(`Uninstall ${tool.name} (${scope}: ${root})`);
    gone.forEach((e) => log(`  ${describe(e, "remove")}`));
    if (values["dry-run"]) return 0;
    if (interactive && !values.yes && !(await confirm("Remove these?"))) return 1;
    const eng = engine(root);
    for (const e of gone) guard(() => revert(e, eng), warnings);
    writeManifest(root, { ...m, providers: m.providers.filter((p) => !remove.includes(p)), entries: kept });
    flushWarnings();
    log("Done.");
    return 0;
  }

  // install / update
  let scope = flagScope;
  if (!scope) {
    scope = interactive
      ? ((await select("Install where?", scopeChoices, installedScopes[0] ?? "project")) as Scope)
      : "project";
  }
  const root = rootFor(scope);
  const old = readManifest(root, tool.name);
  let providers = agentsFlag ?? old?.providers ?? allIds;
  if (!agentsFlag && interactive) providers = await multiSelect("Install for which AI agents?", choices, providers);
  if (providers.length === 0) {
    log("No AI agent selected, nothing to do.");
    return 1;
  }

  const assets = loadAssets(tool.assetsDir);
  const ctx: Ctx = { scope, root, home, env, tool: tool.name, providers };
  const selected = PROVIDERS.filter((p) => providers.includes(p.id));
  const ops = selected.flatMap((p) => p.plan(assets, ctx));
  const fresh = ops.map((op) => toEntry(op, root));
  const freshKeys = new Set(fresh.map(entryKey));
  const stale = (old?.entries ?? []).filter((e) => !freshKeys.has(entryKey(e)));

  log(`${old ? "Update" : "Install"} ${tool.name} ${tool.version} (${scope}: ${root})`);
  fresh.forEach((e) => log(`  ${describe(e, "install")}`));
  stale.forEach((e) => log(`  ${describe(e, "remove")}`));
  if (fresh.some(runsCode)) log("Hooks and MCP servers run commands on this machine.");
  if (values["dry-run"]) return 0;
  if (interactive && !values.yes && !(await confirm("Apply?"))) return 1;

  const eng = engine(root);
  for (const e of stale) guard(() => revert(e, eng), warnings);
  const previous = new Map((old?.entries ?? []).map((e) => [entryKey(e), e]));
  const recorded: Entry[] = [];
  ops.forEach((op, i) => {
    const prev = previous.get(entryKey(fresh[i]));
    const kept = guard(() => apply(op, prev, eng), warnings) ?? prev;
    if (kept) recorded.push(kept);
  });
  writeManifest(root, { tool: tool.name, version: tool.version, scope, providers, entries: recorded });
  flushWarnings();
  selected.flatMap((p) => p.notes(assets, ctx)).forEach((n) => log(`Note: ${n}`));
  log("Done.");
  return 0;
}

function parseAgents(list: string): string[] {
  const ids = list.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !PROVIDERS.some((p) => p.id === id));
  if (unknown.length || ids.length === 0) {
    throw new Error(`unknown agent "${unknown.join(", ")}"; known: ${PROVIDERS.map((p) => p.id).join(", ")}`);
  }
  return ids;
}

function runsCode(e: Entry): boolean {
  return e.type === "exec" || (e.type === "json" && (e.keyPath[0] === "hooks" || e.keyPath[0] === "mcpServers"))
    || (e.type === "block" && e.style === "toml");
}

/** One failed step must not abort the rest: the manifest still has to match the disk. */
function guard<T>(fn: () => T, warnings: string[]): T | undefined {
  try {
    return fn();
  } catch (e) {
    warnings.push((e as Error).message);
    return undefined;
  }
}

function partition<T>(list: T[], pred: (x: T) => boolean): [T[], T[]] {
  return [list.filter(pred), list.filter((x) => !pred(x))];
}

function statusReport(m: Manifest, root: string, packageVersion: string): string {
  const lines = [`${m.scope}: ${m.tool} ${m.version} for ${m.providers.join(", ")} (${root})`];
  if (m.version !== packageVersion) lines.push(`  package is ${packageVersion}: run install to update`);
  for (const e of m.entries) {
    if (e.type !== "file") continue;
    const bytes = readBytes(path.resolve(root, e.path));
    if (!bytes) lines.push(`  missing  ${e.path}`);
    else if (sha256(bytes) !== e.sha256) lines.push(`  changed  ${e.path}`);
  }
  return lines.join("\n");
}
