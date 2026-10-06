import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseFrontmatter } from "../src/installer/frontmatter.ts";
import { blockMarkers, removeBlock, upsertBlock } from "../src/installer/fsx.ts";
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

test("cli: --help and a non-interactive install of the real assets", async () => {
  const run = promisify(execFile);
  const cli = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
  const help = await run(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /install\s+Install or update/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-cli-"));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir };
  const res = await run(process.execPath, [cli, "install", "--dir", dir], { env });
  assert.match(res.stdout, /Done\./);
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.ok(fs.existsSync(path.join(dir, ".ai-tools", `${pkg.name}.json`)));

  const bad = await run(process.execPath, [cli, "nope"]).catch((e) => e);
  assert.equal(bad.code, 1);
});
