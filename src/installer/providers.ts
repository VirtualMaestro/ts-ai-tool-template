import path from "node:path";
import type { Agent, Assets, HookGroup, McpServer } from "./assets.ts";
import { readText } from "./fsx.ts";
import type { Op, Scope } from "./ops.ts";
import { tomlBody, tomlTable } from "./toml.ts";

// One record per AI agent CLI. Each turns the shared assets into Ops for one scope.
// Paths follow the vendors' docs (2026-10):
//   https://code.claude.com/docs/en/{skills,sub-agents,hooks,mcp,memory}
//   https://developers.openai.com/codex/{skills,subagents,hooks,mcp,guides/agents-md}

export type Ctx = {
  scope: Scope;
  /** Project root, or the home directory for the global scope. */
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  tool: string;
  /** Every provider selected in this run. */
  providers: string[];
};

export type Provider = {
  id: string;
  label: string;
  plan(assets: Assets, ctx: Ctx): Op[];
  /** What the user must still do by hand after install. */
  notes(assets: Assets, ctx: Ctx): string[];
};

const posix = (p: string) => p.replace(/\\/g, "/");

/** Hook commands reference their scripts as {{HOOKS_DIR}}; the provider decides what that is. */
function hookOps(provider: string, file: string, events: Record<string, HookGroup[]>, hooksDir: string): Op[] {
  const dir = JSON.stringify(hooksDir).slice(1, -1);
  return Object.entries(events).flatMap(([event, groups]) =>
    groups.map((group): Op => ({
      provider, type: "json", path: file, keyPath: ["hooks", event], mode: "push",
      value: JSON.parse(JSON.stringify(group).replaceAll("{{HOOKS_DIR}}", dir)),
    })),
  );
}

function files(provider: string, dir: string, list: { rel: string; content: Uint8Array }[]): Op[] {
  return list.map((f) => ({ provider, type: "file", path: path.join(dir, f.rel), content: f.content }));
}

const claudeCode: Provider = {
  id: "claude-code",
  label: "Claude Code",
  plan(a, ctx) {
    const id = this.id;
    const project = ctx.scope === "project";
    const base = project ? path.join(ctx.root, ".claude") : ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, ".claude");
    const ops: Op[] = [];
    for (const s of a.skills) ops.push(...files(id, path.join(base, "skills", s.name), s.files));
    for (const ag of a.agents) ops.push({ provider: id, type: "file", path: path.join(base, "agents", `${ag.name}.md`), content: ag.source });
    if (a.hooks) {
      const dir = path.join(base, ctx.tool, "hooks");
      ops.push(...files(id, dir, a.hooks.files));
      const ref = project ? `\${CLAUDE_PROJECT_DIR}/.claude/${ctx.tool}/hooks` : posix(dir);
      ops.push(...hookOps(id, path.join(base, "settings.json"), a.hooks.events, ref));
    }
    for (const [name, server] of Object.entries(a.mcpServers ?? {})) {
      if (project) {
        ops.push({ provider: id, type: "json", path: path.join(ctx.root, ".mcp.json"), keyPath: ["mcpServers", name], mode: "set", value: server });
      } else {
        // ~/.claude.json is Claude Code's live state file; its own CLI is the safe writer.
        // ponytail: needs `claude` on PATH, otherwise the user gets the command to run.
        ops.push({
          provider: id, type: "exec", label: `claude-mcp-user:${name}`,
          install: ["claude", "mcp", "add-json", name, JSON.stringify(server), "--scope", "user"],
          uninstall: ["claude", "mcp", "remove", name, "--scope", "user"],
        });
      }
    }
    if (a.instructions) {
      const target = project ? path.join(ctx.root, "CLAUDE.md") : path.join(base, "CLAUDE.md");
      // A CLAUDE.md that imports AGENTS.md already gets the Codex block.
      const viaAgentsMd = project && ctx.providers.includes("codex") && readText(target)?.includes("@AGENTS.md");
      if (!viaAgentsMd) ops.push({ provider: id, type: "block", path: target, style: "md", content: a.instructions });
    }
    return ops;
  },
  notes(a, ctx) {
    return ctx.scope === "project" && a.mcpServers
      ? ["Claude Code: approve the project MCP servers from .mcp.json when it asks on next start."]
      : [];
  },
};

const codex: Provider = {
  id: "codex",
  label: "Codex",
  plan(a, ctx) {
    const id = this.id;
    const project = ctx.scope === "project";
    const codexHome = ctx.env.CODEX_HOME || path.join(ctx.home, ".codex");
    const codexDir = project ? path.join(ctx.root, ".codex") : codexHome;
    // Codex skills live in .agents, not .codex, in both scopes.
    const skillsDir = path.join(project ? ctx.root : ctx.home, ".agents", "skills");
    const ops: Op[] = [];
    for (const s of a.skills) ops.push(...files(id, path.join(skillsDir, s.name), s.files));
    for (const ag of a.agents) ops.push({ provider: id, type: "file", path: path.join(codexDir, "agents", `${ag.name}.toml`), content: agentToml(ag) });
    if (a.hooks) {
      const dir = path.join(codexDir, ctx.tool, "hooks");
      ops.push(...files(id, dir, a.hooks.files));
      const ref = project ? `$(git rev-parse --show-toplevel)/.codex/${ctx.tool}/hooks` : posix(dir);
      ops.push(...hookOps(id, path.join(codexDir, "hooks.json"), a.hooks.events, ref));
    }
    const servers = Object.entries(a.mcpServers ?? {});
    if (servers.length) {
      const content = servers.map(([name, s]) => tomlTable(["mcp_servers", name], codexMcpServer(s))).join("\n");
      ops.push({ provider: id, type: "block", path: path.join(codexDir, "config.toml"), style: "toml", content });
    }
    if (a.instructions) {
      ops.push({ provider: id, type: "block", path: path.join(project ? ctx.root : codexHome, "AGENTS.md"), style: "md", content: a.instructions });
    }
    return ops;
  },
  notes(a, ctx) {
    const notes: string[] = [];
    if (ctx.scope === "project" && (a.agents.length || a.hooks || a.mcpServers)) {
      notes.push("Codex: reads the project .codex/ folder only when you trust the project.");
    }
    if (a.hooks) notes.push("Codex: review and trust the new hooks with /hooks.");
    return notes;
  },
};

export const PROVIDERS: Provider[] = [claudeCode, codex];

/**
 * A Claude Code agent file becomes a Codex agent: name, description, the body as
 * developer_instructions, and every `codex-<key>` frontmatter field as `<key>`.
 * Claude Code ignores unknown frontmatter, so one source file serves both.
 */
export function agentToml(ag: Agent): string {
  const extra = Object.fromEntries(
    Object.entries(ag.meta)
      .filter(([k]) => k.startsWith("codex-"))
      .map(([k, v]) => [k.slice("codex-".length), scalar(v)]),
  );
  const body = ag.body.trim();
  return tomlBody({ name: ag.name, description: ag.meta.description, ...extra, developer_instructions: `${body}\n` });
}

function scalar(v: string): string | number | boolean {
  if (v === "true" || v === "false") return v === "true";
  return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
}

/**
 * .mcp.json server → Codex [mcp_servers.<name>].
 * ponytail: maps stdio and plain HTTP fields only; Claude's ${VAR} expansion is not translated.
 */
export function codexMcpServer(s: McpServer): Record<string, unknown> {
  const { type: _type, headers, ...rest } = s;
  return headers ? { ...rest, http_headers: headers } : rest;
}
