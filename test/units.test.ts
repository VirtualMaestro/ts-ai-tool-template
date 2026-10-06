import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadAssets } from "../src/installer/assets.ts";
import { parseFrontmatter } from "../src/installer/frontmatter.ts";
import { atomicWriteFile, blockMarkers, removeBlock, upsertBlock } from "../src/installer/fsx.ts";
import { agentToml, codexMcpServer } from "../src/installer/providers.ts";
import { tomlString, tomlTable } from "../src/installer/toml.ts";

test("tomlString picks a form TOML can hold", () => {
  assert.equal(tomlString("plain"), '"plain"');
  assert.equal(tomlString('say "hi"\\'), '"say \\"hi\\"\\\\"');
  assert.equal(tomlString("a\nb\n"), "'''\na\nb\n'''");
  assert.equal(tomlString("a\r\nb"), "'''\na\nb'''");
  assert.equal(tomlString("has '''\nquotes"), '"has \'\'\'\\nquotes"');
  assert.equal(tomlString("ends with '\n'"), '"ends with \'\\n\'"');
  assert.equal(tomlString("del\x7f"), '"del\\u007F"');
  assert.equal(tomlTable(["mcp_servers", "a.b"], { args: ["x"], env: { K: "v" } }), '[mcp_servers."a.b"]\nargs = ["x"]\nenv = { K = "v" }\n');
});

test("frontmatter is flat key: value with optional quotes", () => {
  const { meta, body } = parseFrontmatter("---\r\nname: a\r\ndescription: \"b: c\"\r\n---\r\nBody\r\n");
  assert.deepEqual(meta, { name: "a", description: "b: c" });
  assert.equal(body, "Body\n");
  assert.deepEqual(parseFrontmatter("no frontmatter").meta, {});
});

test("agentToml maps codex-* keys and keeps typed scalars", () => {
  const toml = agentToml({
    name: "x", source: "", body: "\nDo it.\n",
    meta: { description: "d", tools: "Read", "codex-model": "gpt-5", "codex-web_search": "true", "codex-max_turns": "5" },
  });
  assert.equal(toml, 'name = "x"\ndescription = "d"\nmodel = "gpt-5"\nweb_search = true\nmax_turns = 5\ndeveloper_instructions = \'\'\'\nDo it.\n\'\'\'\n');
});

test("codexMcpServer renames headers and drops type", () => {
  assert.deepEqual(codexMcpServer({ type: "http", url: "https://x", headers: { A: "b" } }), { url: "https://x", http_headers: { A: "b" } });
});

test("marked blocks round-trip without touching the rest", () => {
  const m = blockMarkers("t", "md");
  for (const original of ["", "# Mine\n", "# Mine", "# Mine\n\n## More\n"]) {
    const once = upsertBlock(original, m, "one");
    assert.equal(upsertBlock(once, m, "one"), once);
    const twice = upsertBlock(once, m, "two");
    assert.match(twice, /<!-- t:start -->\ntwo\n<!-- t:end -->/);
    assert.doesNotMatch(twice, /one/);
    assert.equal(removeBlock(twice, m).trim(), original.trim());
  }
});

test("atomicWriteFile keeps the original when the new file cannot take its place", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-atomic-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "original");
  const rename = fs.renameSync;
  let refuse = (_from: string, to: string) => fs.existsSync(to); // Windows, with the file held open
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (refuse(String(from), String(to))) throw Object.assign(new Error("EPERM: rename refused"), { code: "EPERM" });
    rename(from, to);
  });

  atomicWriteFile(file, "new");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);

  refuse = (from) => /\.tmp-\d+-\d+$/.test(from);
  assert.throws(() => atomicWriteFile(file, "newer"), /rename refused/);
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
});

test("loadAssets rejects hooks.json and .mcp.json of the wrong shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-assets-"));
  fs.mkdirSync(path.join(dir, "hooks"));
  fs.writeFileSync(path.join(dir, "hooks/hooks.json"), JSON.stringify({ hooks: { SessionStart: { hooks: [] } } }));
  assert.throws(() => loadAssets(dir), /"hooks" must map each event to an array of hook groups/);
  fs.rmSync(path.join(dir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { x: "npx x" } }));
  assert.throws(() => loadAssets(dir), /"mcpServers" must map each name to a server object/);
  fs.writeFileSync(path.join(dir, ".mcp.json"), "[]");
  assert.throws(() => loadAssets(dir), /"mcpServers" must map/);
});

test("cli: --help and a non-interactive install of the real assets", async () => {
  const exec = promisify(execFile);
  const cli = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
  const run = (args: string[], env?: NodeJS.ProcessEnv) => exec(process.execPath, [cli, ...args], { env, timeout: 30_000 });
  const help = await run(["--help"]);
  assert.match(help.stdout, /install\s+Install or update/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-cli-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-cli-home-"));
  const res = await run(["install", "--dir", dir], { ...process.env, HOME: home, USERPROFILE: home });
  assert.match(res.stdout, /Done\./);
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.ok(fs.existsSync(path.join(dir, ".ai-tools", `${pkg.name}.json`)));

  const bad = await run(["nope"]).catch((e) => e);
  assert.equal(bad.code, 1);
});
