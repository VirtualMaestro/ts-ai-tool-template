#!/usr/bin/env node
import { INSTALLER_COMMANDS, INSTALLER_HELP, runInstallerCommand } from "./installer/index.ts";
import { COMMANDS, DESCRIPTION, TOOL } from "./tool.ts";

const HELP = `${TOOL.name} ${TOOL.version}: ${DESCRIPTION}

Usage: ${TOOL.name} <command> [options]
Update: npx ${TOOL.packageName}@latest update

Commands:
${INSTALLER_HELP}${Object.entries(COMMANDS).map(([name, c]) => `\n  ${name.padEnd(11)} ${c.summary}`).join("")}`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(HELP);
    return command ? 0 : 1;
  }
  if (command === "-v" || command === "--version") {
    console.log(TOOL.version);
    return 0;
  }
  if (INSTALLER_COMMANDS.includes(command)) return runInstallerCommand(command, rest, TOOL);
  if (Object.hasOwn(COMMANDS, command)) return COMMANDS[command].run(rest);
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: Error) => {
    console.error(`${TOOL.name}: ${e.message}`);
    process.exitCode = 1;
  },
);
