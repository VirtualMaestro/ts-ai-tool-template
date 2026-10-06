# ts-ai-tool-template

Template for terminal AI tools written in TypeScript. It comes with a tested installer for
Claude Code and Codex: project or global scope, every agent asset kind, update, uninstall, status.
It has no runtime dependencies.

Create a repository from this template, then follow [AGENTS.md](AGENTS.md).

## Install a tool built from this template

```sh
npx <tool> install                     # menus: where, which AI agents, confirm
npx <tool> install --global --agents claude-code,codex --yes
npx <tool> install --dry-run           # print the plan only
npx <tool> status                      # installed version, changed or missing files
npx <tool> uninstall
```

When run without a terminal (CI, an AI agent, Git Bash under MinTTY), it never prompts. Flags decide.
Without flags it uses the previous install's choice, or the project scope with every agent.

| Option | Meaning |
|---|---|
| `--project` / `--global` | Install into the project directory, or for the current user |
| `--agents <list>` | `claude-code`, `codex` |
| `--dir <path>` | Project root (default: current directory) |
| `-y`, `--yes` | Skip the confirmation |
| `--dry-run` | Show the plan, change nothing |
| `--force` | Overwrite or remove files changed since install |

## What the installer guarantees

- **Manifest.** It records everything it writes in `.ai-tools/<tool>.json`, in the project root or in the home directory.
- **Update.** Running `install` again updates the tool and removes files the new version no longer ships.
- **Changed files.** A file you changed after install, or one the tool did not create, is kept. Only `--force` overwrites or removes it.
- **Shared config files.** In `settings.json`, `hooks.json`, `.mcp.json` and `config.toml` it adds only its own entries. `uninstall` takes exactly those out again.
  - Before it first changes one of these files, it saves a `.bak` copy.
  - A file it cannot parse is left alone.
- **`CLAUDE.md` / `AGENTS.md`.** Its text goes between `<!-- <tool>:start -->` and `<!-- <tool>:end -->` markers.
- **Code that runs.** It flags hooks and MCP servers in the plan, because they run commands on your machine.

After a project install, Codex reads `.codex/` only once you trust the project. Codex also asks you to review new hooks with `/hooks`.

## Develop

```sh
npm install
npm test          # typecheck + node --test
npm run dev -- install --dry-run
npm run build     # dist/ for publishing
```
