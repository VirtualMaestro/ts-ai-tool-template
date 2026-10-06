import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInstallerCommand, type RunOptions, type ToolInfo } from "../src/installer/index.ts";
import { sha256, walkFiles } from "../src/installer/fsx.ts";

const EXAMPLES = path.resolve(import.meta.dirname, "..", "examples", "assets");

type Sandbox = { project: string; home: string; tool: ToolInfo; logs: string[]; ran: string[][]; opts: RunOptions };

function sandbox(assetsDir = EXAMPLES, extra: Partial<RunOptions> = {}): Sandbox {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-"));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  const logs: string[] = [];
  const ran: string[][] = [];
  const opts: RunOptions = {
    cwd: project, home, env: {}, interactive: false,
    run: (argv) => void ran.push(argv), log: (l) => void logs.push(l), latestVersion: async () => undefined, ...extra,
  };
  return { project, home, tool: { name: "demo-tool", version: "1.0.0", assetsDir }, logs, ran, opts };
}

const install = (s: Sandbox, ...argv: string[]) => runInstallerCommand("install", argv, s.tool, s.opts);
const update = (s: Sandbox, ...argv: string[]) => runInstallerCommand("update", argv, s.tool, s.opts);
const uninstall = (s: Sandbox, ...argv: string[]) => runInstallerCommand("uninstall", argv, s.tool, s.opts);
const read = (...p: string[]) => fs.readFileSync(path.join(...p), "utf8");
const json = (...p: string[]) => JSON.parse(read(...p));
const exists = (...p: string[]) => fs.existsSync(path.join(...p));
const snapshot = (dir: string) => Object.fromEntries(walkFiles(dir).map((f) => [f, read(dir, f)]));

function copyAssets(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-assets-"));
  fs.cpSync(EXAMPLES, dir, { recursive: true });
  return dir;
}

test("project install writes every kind for both providers", async () => {
  const s = sandbox();
  assert.equal(await install(s, "--project"), 0);
  const p = s.project;

  assert.ok(exists(p, ".claude/skills/example-skill/SKILL.md"));
  assert.ok(exists(p, ".claude/skills/example-skill/references/notes.md"));
  assert.ok(exists(p, ".agents/skills/example-skill/SKILL.md"));

  assert.equal(read(p, ".claude/agents/example-agent.md"), read(EXAMPLES, "agents/example-agent.md"));
  const toml = read(p, ".codex/agents/example-agent.toml");
  assert.match(toml, /^name = "example-agent"$/m);
  assert.match(toml, /^model_reasoning_effort = "medium"$/m);
  assert.match(toml, /^developer_instructions = '''\nYou are an example subagent/m);
  assert.doesNotMatch(toml, /codex-|tools =/);

  assert.ok(exists(p, ".claude/demo-tool/hooks/session-start.mjs"));
  assert.ok(exists(p, ".codex/demo-tool/hooks/session-start.mjs"));
  assert.equal(
    json(p, ".claude/settings.json").hooks.SessionStart[0].hooks[0].command,
    'node "${CLAUDE_PROJECT_DIR}/.claude/demo-tool/hooks/session-start.mjs"',
  );
  assert.equal(
    json(p, ".codex/hooks.json").hooks.SessionStart[0].hooks[0].command,
    'node "$(git rev-parse --show-toplevel)/.codex/demo-tool/hooks/session-start.mjs"',
  );

  assert.deepEqual(json(p, ".mcp.json").mcpServers["example-server"].args, ["-y", "example-mcp-server"]);
  const config = read(p, ".codex/config.toml");
  assert.match(config, /^\[mcp_servers\.example-server\]\ncommand = "npx"\nargs = \["-y", "example-mcp-server"\]\nenv = \{ EXAMPLE_MODE = "demo" \}$/m);

  assert.match(read(p, "CLAUDE.md"), /<!-- demo-tool:start -->\n## example tool/);
  assert.match(read(p, "AGENTS.md"), /<!-- demo-tool:start -->\n## example tool/);

  const manifest = json(p, ".ai-tools/demo-tool.json");
  assert.deepEqual(manifest.providers, ["claude-code", "codex"]);
  assert.equal(manifest.scope, "project");
  assert.ok(s.logs.some((l) => l.includes("Codex: reads the project .codex/")));
  assert.deepEqual(s.ran, []);
});

test("install twice changes nothing", async () => {
  const s = sandbox();
  await install(s);
  const first = snapshot(s.project);
  await install(s);
  assert.deepEqual(snapshot(s.project), first);
});

test("uninstall restores the user's own files exactly", async () => {
  const s = sandbox();
  const p = s.project;
  const settings = { permissions: { allow: ["Bash(ls)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "mine" }] }] } };
  fs.mkdirSync(path.join(p, ".claude"));
  fs.writeFileSync(path.join(p, ".claude/settings.json"), JSON.stringify(settings, null, 2) + "\n");
  fs.mkdirSync(path.join(p, ".codex"));
  fs.writeFileSync(path.join(p, ".codex/config.toml"), 'model = "x"\n');
  fs.writeFileSync(path.join(p, "CLAUDE.md"), "# Mine\n\nKeep this.\n");

  await install(s);
  assert.equal(json(p, ".claude/settings.json").hooks.SessionStart.length, 2);
  assert.ok(exists(p, ".claude/settings.json.bak"));
  assert.ok(exists(p, ".codex/config.toml.bak"));

  assert.equal(await uninstall(s), 0);
  assert.deepEqual(json(p, ".claude/settings.json"), settings);
  assert.equal(read(p, ".codex/config.toml"), 'model = "x"\n');
  assert.equal(read(p, "CLAUDE.md"), "# Mine\n\nKeep this.\n");
  for (const gone of [".claude/skills", ".claude/agents", ".claude/demo-tool", ".agents", ".codex/agents", ".codex/hooks.json", ".mcp.json", "AGENTS.md", ".ai-tools"]) {
    assert.ok(!exists(p, gone), `${gone} should be removed`);
  }
});

test("a file the user changed survives update and uninstall unless --force", async () => {
  const s = sandbox();
  const skill = path.join(s.project, ".claude/skills/example-skill/SKILL.md");
  await install(s);
  fs.writeFileSync(skill, "my edit\n");

  await install(s);
  assert.equal(fs.readFileSync(skill, "utf8"), "my edit\n");
  assert.ok(s.logs.some((l) => l.startsWith("! kept .claude/skills/example-skill/SKILL.md: changed since install")));

  await uninstall(s);
  assert.equal(fs.readFileSync(skill, "utf8"), "my edit\n");

  await install(s, "--force");
  assert.equal(fs.readFileSync(skill, "utf8"), read(EXAMPLES, "skills/example-skill/SKILL.md"));
});

test("a marked block the user edited survives update and uninstall unless --force", async () => {
  const assets = copyAssets();
  const s = sandbox(assets);
  const config = path.join(s.project, ".codex/config.toml");
  const claudeMd = path.join(s.project, "CLAUDE.md");
  const mcpFile = path.join(assets, ".mcp.json");
  await install(s);
  fs.writeFileSync(config, read(config).replace('EXAMPLE_MODE = "demo"', 'EXAMPLE_MODE = "mine"'));
  fs.writeFileSync(claudeMd, read(claudeMd).replace(/\n/g, "\r\n")); // an editor's line endings are no edit
  fs.writeFileSync(mcpFile, read(mcpFile).replace('"demo"', '"new"'));

  s.logs.length = 0;
  assert.equal(await install(s), 0);
  assert.match(read(config), /EXAMPLE_MODE = "mine"/);
  assert.ok(s.logs.some((l) => l.startsWith("! kept .codex/config.toml (marked block): changed since install")));
  assert.ok(!s.logs.some((l) => l.includes("kept CLAUDE.md")));

  await install(s, "--force");
  assert.match(read(config), /EXAMPLE_MODE = "new"/);

  fs.writeFileSync(config, read(config).replace('"new"', '"mine"'));
  fs.writeFileSync(claudeMd, read(claudeMd).replace(/\n/g, "\r\n"));
  assert.equal(await uninstall(s), 0);
  assert.match(read(config), /# >>> demo-tool >>>\n\[mcp_servers\.example-server\][^]*EXAMPLE_MODE = "mine"/);
  assert.ok(!exists(s.project, "CLAUDE.md"));
});

test("a project manifest that reaches outside the project or runs commands is refused", async () => {
  const s = sandbox();
  await install(s);
  const file = path.join(s.project, ".ai-tools/demo-tool.json");
  const good = json(file);
  const secret = path.join(s.home, "secret.txt");
  fs.writeFileSync(secret, "secret");
  const bad = [
    { provider: "codex", type: "file", path: "../home/secret.txt", sha256: sha256("secret") },
    { provider: "codex", type: "file", path: secret.replace(/\\/g, "/"), sha256: sha256("secret") },
    { provider: "codex", type: "exec", label: "x", install: ["node", "-v"], uninstall: ["node", "-v"] },
    { provider: "codex", type: "json", path: ".mcp.json", keyPath: ["__proto__", "x"], mode: "push", value: 1 },
    { provider: "codex", type: "json", path: ".mcp.json", keyPath: [], mode: "set", value: 1 },
  ];
  for (const entry of bad) {
    fs.writeFileSync(file, JSON.stringify({ ...good, entries: [...good.entries, entry] }));
    await assert.rejects(uninstall(s, "--force"), /not a valid demo-tool manifest/);
    await assert.rejects(runInstallerCommand("status", [], s.tool, s.opts), /not a valid demo-tool manifest/);
  }
  fs.writeFileSync(file, JSON.stringify({ ...good, tool: "../../escape" }));
  await assert.rejects(uninstall(s), /not a valid demo-tool manifest/);
  assert.equal(read(secret), "secret");
  assert.ok(exists(s.project, ".claude/skills/example-skill/SKILL.md"));

  // A "global" manifest inside a project is not this project's install: its commands never run.
  fs.writeFileSync(file, JSON.stringify({ ...good, scope: "global", entries: [bad[2]] }));
  assert.equal(await install(s), 0);
  assert.deepEqual(s.ran, []);
  assert.equal(json(file).scope, "project");
});

test("a change that cannot be undone stays in the manifest for a retry", async () => {
  const assets = copyAssets();
  let failing = true;
  const s = sandbox(assets, {
    run: (argv) => {
      if (failing && argv[2] === "remove") throw new Error("claude: server not found");
    },
  });
  const manifest = path.join(s.home, ".ai-tools/demo-tool.json");
  const execs = () => (exists(manifest) ? json(manifest).entries.filter((e: { type: string }) => e.type === "exec").length : 0);
  await install(s, "--global", "--agents", "claude-code");

  fs.rmSync(path.join(assets, ".mcp.json"));
  s.logs.length = 0;
  assert.equal(await update(s), 1);
  assert.equal(execs(), 1);
  assert.ok(s.logs.some((l) => l.includes('! could not run "claude" (claude: server not found). Run it yourself:\n    claude mcp remove')));
  assert.match(s.logs.at(-1)!, /Could not undo 1 change\(s\); the manifest keeps them/);

  assert.equal(await uninstall(s, "--global"), 1);
  assert.equal(execs(), 1);
  assert.ok(!exists(s.home, ".claude/skills"), "everything else is gone");
  assert.equal(await uninstall(s, "--global", "--force"), 0);
  assert.ok(!exists(manifest), "--force forgets it");

  fs.copyFileSync(path.join(EXAMPLES, ".mcp.json"), path.join(assets, ".mcp.json"));
  await install(s, "--global", "--agents", "claude-code");
  assert.equal(await uninstall(s, "--global"), 1);
  failing = false;
  assert.equal(await uninstall(s, "--global"), 0);
  assert.ok(!exists(manifest), "the retry succeeds");
});

test("a file that was not installed by the tool is never overwritten without --force", async () => {
  const s = sandbox();
  const agent = path.join(s.project, ".claude/agents/example-agent.md");
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, "someone else's agent\n");
  await install(s);
  assert.equal(fs.readFileSync(agent, "utf8"), "someone else's agent\n");
  assert.ok(s.logs.some((l) => l.includes("not installed by demo-tool")));
  await uninstall(s);
  assert.equal(fs.readFileSync(agent, "utf8"), "someone else's agent\n");
});

test("update removes what the new version no longer ships", async () => {
  const assets = copyAssets();
  const s = sandbox(assets);
  await install(s);
  fs.rmSync(path.join(assets, "skills/example-skill/references"), { recursive: true });
  fs.rmSync(path.join(assets, "hooks"), { recursive: true });
  await install(s);
  assert.ok(!exists(s.project, ".claude/skills/example-skill/references"));
  assert.ok(exists(s.project, ".claude/skills/example-skill/SKILL.md"));
  assert.ok(!exists(s.project, ".claude/settings.json"));
  assert.ok(!exists(s.project, ".codex/hooks.json"));
  assert.ok(!exists(s.project, ".claude/demo-tool"));
});

test("deselecting a provider removes its files", async () => {
  const s = sandbox();
  await install(s);
  await install(s, "--agents", "claude-code");
  assert.ok(exists(s.project, ".claude/skills/example-skill/SKILL.md"));
  assert.ok(!exists(s.project, ".agents"));
  assert.ok(!exists(s.project, ".codex"));
  assert.ok(!exists(s.project, "AGENTS.md"));
  assert.deepEqual(json(s.project, ".ai-tools/demo-tool.json").providers, ["claude-code"]);
});

test("CLAUDE.md that imports AGENTS.md gets no second block", async () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.project, "CLAUDE.md"), "@AGENTS.md\n");
  await install(s);
  assert.equal(read(s.project, "CLAUDE.md"), "@AGENTS.md\n");
  assert.match(read(s.project, "AGENTS.md"), /demo-tool:start/);
});

test("global install uses the user directories and the claude CLI for MCP", async () => {
  const s = sandbox();
  const h = s.home;
  assert.equal(await install(s, "--global"), 0);
  assert.ok(exists(h, ".claude/skills/example-skill/SKILL.md"));
  assert.ok(exists(h, ".agents/skills/example-skill/SKILL.md"));
  assert.ok(exists(h, ".claude/agents/example-agent.md"));
  assert.ok(exists(h, ".codex/agents/example-agent.toml"));
  assert.ok(exists(h, ".codex/config.toml"));
  assert.match(read(h, ".claude/CLAUDE.md"), /demo-tool:start/);
  assert.match(read(h, ".codex/AGENTS.md"), /demo-tool:start/);
  const hooksDir = path.join(h, ".claude/demo-tool/hooks").replace(/\\/g, "/");
  assert.equal(json(h, ".claude/settings.json").hooks.SessionStart[0].hooks[0].command, `node "${hooksDir}/session-start.mjs"`);
  assert.ok(!exists(s.project, ".claude"));
  assert.deepEqual(s.ran.at(-1), ["claude", "mcp", "add-json", "example-server", JSON.stringify(json(EXAMPLES, ".mcp.json").mcpServers["example-server"]), "--scope", "user"]);

  s.ran.length = 0;
  await uninstall(s, "--global");
  assert.deepEqual(s.ran, [["claude", "mcp", "remove", "example-server", "--scope", "user"]]);
  assert.deepEqual(walkFiles(h), []);
});

test("CODEX_HOME and CLAUDE_CONFIG_DIR move the global targets", async () => {
  const s = sandbox();
  const codexHome = path.join(s.home, "codex-home");
  const claudeDir = path.join(s.home, "claude-dir");
  s.opts.env = { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeDir };
  await install(s, "--global");
  assert.ok(fs.existsSync(path.join(codexHome, "agents/example-agent.toml")));
  assert.ok(fs.existsSync(path.join(codexHome, "AGENTS.md")));
  assert.ok(fs.existsSync(path.join(claudeDir, "skills/example-skill/SKILL.md")));
  assert.ok(exists(s.home, ".agents/skills/example-skill/SKILL.md"));
});

test("a failing claude CLI prints the command to run by hand", async () => {
  const s = sandbox(EXAMPLES, { run: () => { throw new Error("spawn claude ENOENT"); } });
  assert.equal(await install(s, "--global", "--agents", "claude-code"), 0);
  assert.ok(s.logs.some((l) => l.includes("Run it yourself:\n    claude mcp add-json example-server")));
  assert.ok(!json(s.home, ".ai-tools/demo-tool.json").entries.some((e: { type: string }) => e.type === "exec"));
});

test("--dry-run changes nothing", async () => {
  const s = sandbox();
  assert.equal(await install(s, "--dry-run"), 0);
  assert.deepEqual(walkFiles(s.project), []);
  assert.ok(s.logs.some((l) => l.includes("+ .claude/skills/example-skill/SKILL.md")));
});

test("unknown agent and conflicting scopes fail before writing", async () => {
  const s = sandbox();
  await assert.rejects(install(s, "--agents", "gemini"), /unknown agent "gemini"/);
  await assert.rejects(install(s, "--global", "--project"), /either --project or --global/);
  assert.deepEqual(walkFiles(s.project), []);
});

test("a project install in the home folder is refused, a global one works there", async () => {
  const s = sandbox();
  s.opts.cwd = s.home;
  await assert.rejects(install(s), /is the home folder; install there with --global/);
  assert.deepEqual(walkFiles(s.home), []);
  assert.equal(await install(s, "--global"), 0);
  assert.equal(await update(s), 0);
  assert.equal(await uninstall(s), 0);
  assert.deepEqual(walkFiles(s.home), []);
});

test("status reports version drift and changed files", async () => {
  const s = sandbox();
  await install(s);
  fs.writeFileSync(path.join(s.project, ".claude/agents/example-agent.md"), "x");
  s.tool.version = "2.0.0";
  s.logs.length = 0;
  await runInstallerCommand("status", [], s.tool, s.opts);
  const out = s.logs.join("\n");
  assert.match(out, /project: demo-tool 1\.0\.0 for claude-code, codex/);
  assert.match(out, /package is 2\.0\.0: run update/);
  assert.match(out, /changed {2}\.claude\/agents\/example-agent\.md/);
});

test("update keeps each install's scope and agents, without a terminal", async () => {
  const assets = copyAssets();
  const s = sandbox(assets);
  await install(s, "--global", "--agents", "codex");
  fs.rmSync(path.join(assets, "skills/example-skill/references"), { recursive: true });
  s.tool.version = "1.1.0";
  assert.equal(await update(s), 0);
  assert.ok(!exists(s.home, ".agents/skills/example-skill/references"));
  assert.ok(exists(s.home, ".agents/skills/example-skill/SKILL.md"));
  assert.ok(!exists(s.home, ".claude"));
  assert.deepEqual(walkFiles(s.project), []);
  const m = json(s.home, ".ai-tools/demo-tool.json");
  assert.equal(m.version, "1.1.0");
  assert.deepEqual(m.providers, ["codex"]);
});

test("update refuses to downgrade unless --force", async () => {
  const s = sandbox();
  s.tool.version = "2.0.0";
  await install(s);
  s.tool.version = "1.9.0";
  s.logs.length = 0;
  assert.equal(await update(s), 1);
  assert.equal(json(s.project, ".ai-tools/demo-tool.json").version, "2.0.0");
  assert.match(s.logs.join("\n"), /installed 2\.0\.0 is newer than this copy \(1\.9\.0\)/);
  assert.equal(await update(s, "--force"), 0);
  assert.equal(json(s.project, ".ai-tools/demo-tool.json").version, "1.9.0");
});

test("update asks only when hooks or MCP servers are new or changed", async () => {
  const assets = copyAssets();
  const asked: string[] = [];
  let answer = false;
  const s = sandbox(assets, { interactive: true, confirm: async (m) => (asked.push(m), answer) });
  await install(s, "--project", "--agents", "claude-code,codex", "--yes");

  assert.equal(await update(s), 0);
  assert.deepEqual(asked, [], "nothing changed: no question");

  const hooksFile = path.join(assets, "hooks/hooks.json");
  fs.writeFileSync(hooksFile, read(hooksFile).replace('"timeout": 10', '"timeout": 20'));
  s.logs.length = 0;
  assert.equal(await update(s), 1, "declined");
  assert.equal(asked.length, 1);
  assert.match(s.logs.join("\n"), /New or changed hooks[^\n]*\n {2}\+ \.claude\/settings\.json → hooks\.SessionStart\[\]/);
  assert.equal(json(s.project, ".claude/settings.json").hooks.SessionStart[0].hooks[0].timeout, 10);

  answer = true;
  assert.equal(await update(s), 0);
  assert.equal(json(s.project, ".claude/settings.json").hooks.SessionStart[0].hooks[0].timeout, 20);
  asked.length = 0;
  assert.equal(await update(s), 0);
  assert.deepEqual(asked, [], "accepted change is not asked again");

  // A changed MCP server must be noticed in Codex's TOML block too, not only in .mcp.json.
  const mcpFile = path.join(assets, ".mcp.json");
  fs.writeFileSync(mcpFile, read(mcpFile).replace('"demo"', '"live"'));
  await install(s, "--project", "--agents", "codex", "--yes");
  asked.length = 0;
  fs.writeFileSync(mcpFile, read(mcpFile).replace('"live"', '"other"'));
  assert.equal(await update(s, "--yes"), 0);
  assert.deepEqual(asked, [], "--yes skips the question");
  fs.writeFileSync(mcpFile, read(mcpFile).replace('"other"', '"again"'));
  assert.equal(await update(s), 0);
  assert.equal(asked.length, 1);
  assert.match(read(s.project, ".codex/config.toml"), /EXAMPLE_MODE = "again"/);
});

test("update rejects --agents", async () => {
  const s = sandbox();
  await install(s);
  await assert.rejects(update(s, "--agents", "codex"), /use install --agents/);
  assert.deepEqual(json(s.project, ".ai-tools/demo-tool.json").providers, ["claude-code", "codex"]);
});

test("update with nothing installed fails and writes nothing", async () => {
  const s = sandbox();
  assert.equal(await update(s), 1);
  assert.deepEqual(walkFiles(s.project), []);
  assert.deepEqual(walkFiles(s.home), []);
});

test("status names a newer npm version, and says nothing when npm is unreachable", async () => {
  const s = sandbox(EXAMPLES, { latestVersion: async () => "1.2.0" });
  s.tool.packageName = "@me/demo-tool";
  await install(s);
  s.logs.length = 0;
  await runInstallerCommand("status", [], s.tool, s.opts);
  assert.match(s.logs.join("\n"), /npm has 1\.2\.0: run npx @me\/demo-tool@latest update/);

  s.opts.latestVersion = async () => undefined;
  s.logs.length = 0;
  await runInstallerCommand("status", [], s.tool, s.opts);
  assert.doesNotMatch(s.logs.join("\n"), /npm has|run update/);
});
