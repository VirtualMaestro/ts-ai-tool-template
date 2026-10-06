import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { readText, walkFiles } from "./fsx.ts";

// The assets folder uses the Claude Code plugin layout, so each kind lives where a plugin keeps it:
//   skills/<name>/SKILL.md ...   agents/<name>.md   hooks/hooks.json (+ scripts)   .mcp.json
// plus instructions.md, a block for CLAUDE.md / AGENTS.md. Every kind is optional.

export type AssetFile = { rel: string; content: Buffer };
export type Skill = { name: string; files: AssetFile[] };
export type Agent = { name: string; source: string; meta: Record<string, string>; body: string };
export type HookHandler = Record<string, unknown>;
export type HookGroup = { matcher?: string; hooks: HookHandler[] } & Record<string, unknown>;
export type Hooks = { events: Record<string, HookGroup[]>; files: AssetFile[] };
export type McpServer = Record<string, unknown>;

export type Assets = {
  skills: Skill[];
  agents: Agent[];
  hooks?: Hooks;
  mcpServers?: Record<string, McpServer>;
  instructions?: string;
};

/** File and folder names become paths on the user's disk: keep them plain. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeName(name: string, where: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid name "${name}" in ${where}`);
  return name;
}

function readFiles(dir: string): AssetFile[] {
  return walkFiles(dir).map((rel) => {
    rel.split("/").forEach((part) => safeName(part, dir));
    return { rel, content: fs.readFileSync(path.join(dir, rel)) };
  });
}

function subdirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export function loadAssets(assetsDir: string): Assets {
  const skillsDir = path.join(assetsDir, "skills");
  const skills = subdirs(skillsDir).map((name) => ({
    name: safeName(name, skillsDir),
    files: readFiles(path.join(skillsDir, name)),
  }));

  const agentsDir = path.join(assetsDir, "agents");
  const agents = walkFiles(agentsDir)
    .filter((f) => !f.includes("/") && f.endsWith(".md"))
    .map((file) => {
      const source = fs.readFileSync(path.join(agentsDir, file), "utf8");
      const { meta, body } = parseFrontmatter(source);
      const name = safeName(meta.name ?? file.slice(0, -3), path.join(agentsDir, file));
      if (!meta.description) throw new Error(`agents/${file}: frontmatter needs a description`);
      return { name, source, meta, body };
    });

  const hooksDir = path.join(assetsDir, "hooks");
  const hooksText = readText(path.join(hooksDir, "hooks.json"));
  const hooks = hooksText === undefined ? undefined : {
    events: (JSON.parse(hooksText).hooks ?? {}) as Record<string, HookGroup[]>,
    files: readFiles(hooksDir).filter((f) => f.rel !== "hooks.json"),
  };

  const mcpText = readText(path.join(assetsDir, ".mcp.json"));
  const mcpServers = mcpText === undefined ? undefined : (JSON.parse(mcpText).mcpServers as Record<string, McpServer>);
  for (const name of Object.keys(mcpServers ?? {})) safeName(name, ".mcp.json");

  const instructions = readText(path.join(assetsDir, "instructions.md"))?.trim() || undefined;

  return { skills, agents, hooks, mcpServers, instructions };
}
