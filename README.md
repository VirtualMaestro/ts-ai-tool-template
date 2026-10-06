# ts-ai-tool-template

Template for terminal AI tools written in TypeScript. It comes with a tested installer for
Claude Code and Codex: project or global scope, every agent asset kind, update, uninstall, status.
It has no runtime dependencies.

Create a repository from this template, then follow [AGENTS.md](AGENTS.md).

## Install a tool built from this template

```sh
npx <tool>@latest install              # menus: where, which AI agents, confirm
npx <tool>@latest install --global --agents claude-code,codex --yes
npx <tool>@latest install --dry-run    # print the plan only
npx <tool>@latest update               # every install, same scope and agents, no questions
npx <tool>@latest status               # installed version, newer one on npm, changed or missing files
npx <tool>@latest uninstall
```

Keep `@latest`: without it `npx` may run a copy it cached earlier, and that copy installs its own,
older version.

When run without a terminal (CI, an AI agent, Git Bash under MinTTY), it never prompts. Flags decide.
Without flags `install` uses the project scope and the previous install's agents, or every agent;
`update` uses the scope and agents each install recorded (change agents with `install --agents`).
It refuses to replace an install with an older version unless `--force` is given.

| Option | Meaning |
|---|---|
| `--project` / `--global` | Install into the project directory, or for the current user |
| `--agents <list>` | `claude-code`, `codex` |
| `--dir <path>` | Project root (default: current directory) |
| `-y`, `--yes` | Skip the confirmation |
| `--dry-run` | Show the plan, change nothing |
| `--force` | Overwrite or remove files changed since install; let `update` downgrade |

## What the installer guarantees

- **Manifest.** It records everything it writes in `.ai-tools/<tool>.json`, in the project root or in the home directory.
- **Update.** `update`, or `install` again, brings an install to the running version and removes files the new version no longer ships.
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
