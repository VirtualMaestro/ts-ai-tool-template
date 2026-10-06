import fs from "node:fs";
import path from "node:path";
import type { ToolInfo } from "./installer/index.ts";

// The tool-specific side of the CLI. The installer reads its name and version from
// package.json and installs whatever is in assets/; the tool's own commands go below.

const packageRoot = path.resolve(import.meta.dirname, ".."); // src/ in dev, dist/ when published
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

export const TOOL: ToolInfo = {
  name: pkg.name.replace(/^@[^/]+\//, ""),
  packageName: pkg.name,
  version: pkg.version,
  assetsDir: path.join(packageRoot, "assets"),
};

export const DESCRIPTION: string = pkg.description;

export type Command = { summary: string; run(argv: string[]): Promise<number> | number };

/** The tool's own subcommands, e.g. `check: { summary: "Check the project", run: check }`. */
export const COMMANDS: Record<string, Command> = {};
