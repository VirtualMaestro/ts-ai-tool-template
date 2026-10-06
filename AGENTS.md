# Agent guide

This repository is a template for terminal AI tools written in TypeScript. The installer is done
and tested. Work on the tool, not on the installer.

## Layout

| Path | What it is | Edit? |
|---|---|---|
| `src/installer/` | Generic installer: install, update, uninstall, status for Claude Code and Codex, project or global | No. Fix bugs in the template repo and copy the folder over |
| `src/tool.ts` | Tool name and version (read from package.json), the tool's own subcommands | Yes |
| `src/cli.ts` | Entry point: dispatches installer commands and tool commands | Rarely |
| `assets/` | What the installer puts on the user's machine | Yes |
| `examples/assets/` | One example of every asset kind; the tests install it | Copy from it, do not ship it |
| `test/` | `node --test` suites; `installer.test.ts` covers the installer end to end | Add tool tests |

## After creating a repository from the template

1. In `package.json`, set `name`, `description`, `repository`, and the key under `bin`. The tool name everywhere else comes from `name`.
2. Rename `assets/skills/ts-ai-tool-template/` to the skill's name and rewrite its `SKILL.md`.
3. Add the other asset kinds the tool needs, copied from `examples/assets/`.
4. Add the tool's subcommands to `COMMANDS` in `src/tool.ts`.
5. Replace README.md with the tool's own.

## Asset kinds

Every kind is optional. The installer skips any kind that has no files in `assets/`.

| Source in `assets/` | Claude Code gets | Codex gets |
|---|---|---|
| `skills/<name>/**` | `.claude/skills/<name>/` | `.agents/skills/<name>/` |
| `agents/<name>.md` | the file as is in `.claude/agents/` | `.codex/agents/<name>.toml`: name, description, body as `developer_instructions`, and each `codex-<key>` frontmatter field as `<key>` |
| `hooks/hooks.json` + scripts | hook groups merged into `.claude/settings.json`, scripts in `.claude/<tool>/hooks/` | hook groups merged into `.codex/hooks.json`, scripts in `.codex/<tool>/hooks/` |
| `.mcp.json` (`mcpServers`) | merged into `.mcp.json`; global: `claude mcp add-json --scope user` | `[mcp_servers.<name>]` block in `.codex/config.toml` |
| `instructions.md` | marked block in `CLAUDE.md` | marked block in `AGENTS.md` |

These are the project paths. Global installs use `~/.claude`, `~/.agents/skills` and `~/.codex`,
moved by `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.

Rules for assets:

- **Hooks:** reference scripts as `"{{HOOKS_DIR}}/script.mjs"`, in quotes, and run them with `node`. Do not use bash, so the hooks work on Windows.
- **Agents:** frontmatter is flat `key: value`. Nested YAML is not parsed.
- **Names:** file and folder names may contain only `A-Z a-z 0-9 . _ -`.

## Rules

- No runtime dependencies. Use only Node built-ins (Node 24).
- `src/installer/` imports nothing from outside its folder.
- Adding a provider means adding one record to `PROVIDERS` in `src/installer/providers.ts`, plus tests.
- Run `npm test` before finishing. It runs typecheck and every test.
