import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { loadAssets } from "./assets.ts";
import { readBytes, sha256 } from "./fsx.ts";
import {
  apply, describe, entryKey, errorMessage, readManifest, revert, toEntry, writeManifest,
  type Engine, type Entry, type Manifest, type Scope,
} from "./ops.ts";
import { confirm, multiSelect, select } from "./prompt.ts";
import { PROVIDERS, type Ctx } from "./providers.ts";

// Self-contained: nothing here imports from outside src/installer/, so a tool made from the
// template can take installer fixes by copying this folder over its own.

/** `packageName` is the npm name, scope included; it defaults to `name`. */
export type ToolInfo = { name: string; version: string; assetsDir: string; packageName?: string };

export type RunOptions = {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Menus and confirmation. Defaults to "stdin and stdout are a terminal". */
  interactive?: boolean;
  /** Runs an external command such as `claude mcp add-json`; throws on failure. */
  run?: (argv: string[]) => void;
  log?: (line: string) => void;
  /** Asks yes/no in the terminal. */
  confirm?: (message: string) => Promise<boolean>;
  /** The latest version on npm, or undefined when it cannot be read. Defaults to the npm registry. */
  latestVersion?: (packageName: string) => Promise<string | undefined>;
};

export const INSTALLER_COMMANDS = ["install", "update", "uninstall", "status"];

export const INSTALLER_HELP = `  install     Install or update for Claude Code and/or Codex
  update      Update every install to this version, keeping its scope and agents
  uninstall   Remove everything the install wrote
  status      Show what is installed and whether it is out of date

Options:
  --project          Install into the project (default without a terminal)
  --global           Install for the current user (~/.claude, ~/.codex, ~/.agents)
  --agents <list>    Comma-separated: ${PROVIDERS.map((p) => p.id).join(", ")}
  --dir <path>       Project root (default: current directory)
  -y, --yes          Do not ask for confirmation
  --dry-run          Print the plan, change nothing
  --force            Overwrite or remove files changed since install; let update downgrade;
                     forget what could not be removed`;

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
  const installedScopes = (["project", "global"] as Scope[]).filter((s) => readManifest(rootFor(s), tool.name, s));
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
  const packageName = tool.packageName ?? tool.name;

  /** Undo entries. Returns the ones that failed: the manifest keeps them for the next run, unless --force. */
  const revertAll = (entries: Entry[], eng: Engine): Entry[] =>
    entries.filter((e) => {
      try {
        revert(e, eng);
        return false;
      } catch (err) {
        warnings.push(errorMessage(err));
        return !values.force;
      }
    });
  const done = (leftover: Entry[]): number => {
    if (leftover.length === 0) {
      log("Done.");
      return 0;
    }
    log(`Could not undo ${leftover.length} change(s); the manifest keeps them. Run again to retry, or with --force to forget them.`);
    return 1;
  };

  const ask = opts.confirm ?? confirm;

  /** "always": confirm every change (install). "new-code": only new or changed hooks and MCP servers (update). */
  const installInto = async (scope: Scope, providers: string[], confirmWhen: "always" | "new-code"): Promise<number> => {
    const root = rootFor(scope);
    const old = readManifest(root, tool.name, scope);
    const assets = loadAssets(tool.assetsDir);
    const ctx: Ctx = { scope, root, home, env, tool: tool.name, providers };
    const selected = PROVIDERS.filter((p) => providers.includes(p.id));
    const ops = selected.flatMap((p) => p.plan(assets, ctx));
    const fresh = ops.map((op) => toEntry(op, root));
    const freshKeys = new Set(fresh.map(entryKey));
    const stale = (old?.entries ?? []).filter((e) => !freshKeys.has(entryKey(e)));
    const previous = new Map((old?.entries ?? []).map((e) => [entryKey(e), e]));
    const newCode = fresh.filter((e) => runsCode(e) && !isDeepStrictEqual(previous.get(entryKey(e)), e));

    log(`${old ? "Update" : "Install"} ${tool.name} ${tool.version} (${scope}: ${root})`);
    fresh.forEach((e) => log(`  ${describe(e, "install")}`));
    stale.forEach((e) => log(`  ${describe(e, "remove")}`));
    if (confirmWhen === "always" && fresh.some(runsCode)) log("Hooks and MCP servers run commands on this machine.");
    if (confirmWhen === "new-code" && newCode.length) {
      log("New or changed hooks and MCP servers, they run commands on this machine:");
      newCode.forEach((e) => log(`  ${describe(e, "install")}`));
    }
    if (values["dry-run"]) return 0;
    const confirmNeeded = confirmWhen === "always" || newCode.length > 0;
    if (interactive && !values.yes && confirmNeeded && !(await ask("Apply?"))) return 1;

    const eng = engine(root);
    const leftover = revertAll(stale, eng);
    const recorded: Entry[] = [];
    ops.forEach((op, i) => {
      const prev = previous.get(entryKey(fresh[i]));
      const kept = guard(() => apply(op, prev, eng), warnings) ?? prev;
      if (kept) recorded.push(kept);
    });
    writeManifest(root, { tool: tool.name, version: tool.version, scope, providers, entries: [...recorded, ...leftover] });
    flushWarnings();
    selected.flatMap((p) => p.notes(assets, ctx)).forEach((n) => log(`Note: ${n}`));
    return done(leftover);
  };

  if (command === "status") {
    const scopes = flagScope ? [flagScope] : installedScopes;
    const found = scopes.filter((s) => installedScopes.includes(s));
    if (found.length === 0) {
      log(`${tool.name} is not installed.`);
      return 0;
    }
    const latest = await (opts.latestVersion ?? npmLatest)(packageName);
    for (const s of found) log(statusReport(readManifest(rootFor(s), tool.name, s)!, rootFor(s), tool.version, latest, packageName));
    return 0;
  }

  if (command === "update") {
    if (agentsFlag) throw new Error("update keeps each install's agents; use install --agents to change them");
    const found = (flagScope ? [flagScope] : installedScopes).filter((s) => installedScopes.includes(s));
    if (found.length === 0) {
      log(`${tool.name} is not installed${flagScope ? ` (${flagScope})` : ""}: run install first.`);
      return 1;
    }
    // A cached `npx <tool>` can be older than what is installed; updating from it would downgrade.
    const newer = found.map((s) => readManifest(rootFor(s), tool.name, s)!).filter((m) => isNewer(m.version, tool.version));
    if (newer.length && !values.force) {
      newer.forEach((m) => log(`${m.scope}: installed ${m.version} is newer than this copy (${tool.version}).`));
      log(`Run npx ${packageName}@latest update, or --force to downgrade.`);
      return 1;
    }
    for (const s of found) {
      const code = await installInto(s, readManifest(rootFor(s), tool.name, s)!.providers, "new-code");
      if (code !== 0) return code;
    }
    return 0;
  }

  if (command === "uninstall") {
    let scope = flagScope ?? installedScopes[0];
    if (!flagScope && installedScopes.length > 1 && interactive) {
      scope = (await select("Uninstall from where?", scopeChoices, "project")) as Scope;
    }
    const root = scope && rootFor(scope);
    const m = root && readManifest(root, tool.name, scope);
    if (!m) {
      log(`${tool.name} is not installed${scope ? ` (${scope})` : ""}.`);
      return 0;
    }
    const remove = agentsFlag ?? m.providers;
    // Without --agents everything goes, also what an earlier run could not undo.
    const [gone, kept] = partition(m.entries, (e) => !agentsFlag || remove.includes(e.provider));
    log(`Uninstall ${tool.name} (${scope}: ${root})`);
    gone.forEach((e) => log(`  ${describe(e, "remove")}`));
    if (values["dry-run"]) return 0;
    if (interactive && !values.yes && !(await ask("Remove these?"))) return 1;
    const leftover = revertAll(gone, engine(root));
    writeManifest(root, { ...m, providers: m.providers.filter((p) => !remove.includes(p)), entries: [...kept, ...leftover] });
    flushWarnings();
    return done(leftover);
  }

  // install / update
  let scope = flagScope;
  if (!scope) {
    scope = interactive
      ? ((await select("Install where?", scopeChoices, installedScopes[0] ?? "project")) as Scope)
      : "project";
  }
  // Both scopes would share one manifest, and the project paths are mostly the global ones.
  if (scope === "project" && cwd === home) throw new Error(`${cwd} is the home folder; install there with --global`);
  const old = readManifest(rootFor(scope), tool.name, scope);
  // An uninstall that could not undo everything leaves a manifest without providers.
  let providers = agentsFlag ?? (old?.providers.length ? old.providers : allIds);
  if (!agentsFlag && interactive) providers = await multiSelect("Install for which AI agents?", choices, providers);
  if (providers.length === 0) {
    log("No AI agent selected, nothing to do.");
    return 1;
  }
  return installInto(scope, providers, "always");
}

/** Asks the npm registry; offline, private or unpublished reads as "unknown", never as an error. */
async function npmLatest(packageName: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return undefined;
    const { version } = (await res.json()) as { version?: unknown };
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Numeric x.y.z comparison; a pre-release tag is ignored. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
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
    warnings.push(errorMessage(e));
    return undefined;
  }
}

function partition<T>(list: T[], pred: (x: T) => boolean): [T[], T[]] {
  return [list.filter(pred), list.filter((x) => !pred(x))];
}

function statusReport(m: Manifest, root: string, packageVersion: string, latest: string | undefined, packageName: string): string {
  const lines = [`${m.scope}: ${m.tool} ${m.version} for ${m.providers.join(", ")} (${root})`];
  if (latest && isNewer(latest, m.version)) lines.push(`  npm has ${latest}: run npx ${packageName}@latest update`);
  else if (m.version !== packageVersion) lines.push(`  package is ${packageVersion}: run update`);
  for (const e of m.entries) {
    if (e.type !== "file") continue;
    const bytes = readBytes(path.resolve(root, e.path));
    if (!bytes) lines.push(`  missing  ${e.path}`);
    else if (sha256(bytes) !== e.sha256) lines.push(`  changed  ${e.path}`);
  }
  return lines.join("\n");
}
