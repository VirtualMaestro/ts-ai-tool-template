import readline from "node:readline";
import process from "node:process";

// Terminal menus from node:readline only: a prompt library would become a dependency of every
// project that installs the tool. Callers resolve choices without a TTY and never reach these.

export type Choice = { label: string; value: string };

function menu(message: string, choices: Choice[], cursor0: number, checked: Set<number> | undefined): Promise<number[]> {
  let cursor = cursor0;
  const render = (first: boolean) => {
    if (!first) process.stdout.write(`\x1b[${choices.length + 1}A`);
    process.stdout.write(`\x1b[2K${message}\n`);
    choices.forEach((c, i) => {
      const mark = checked ? (checked.has(i) ? "[x] " : "[ ] ") : "";
      process.stdout.write(`\x1b[2K${i === cursor ? ">" : " "} ${mark}${c.label}\n`);
    });
  };
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  render(true);
  return new Promise((resolve) => {
    const done = (out: number[]) => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(out);
    };
    const onKey = (_s: string, key: { name?: string; ctrl?: boolean }) => {
      if (!key) return;
      if (key.name === "up" || key.name === "down") {
        cursor = (cursor + (key.name === "up" ? -1 : 1) + choices.length) % choices.length;
        render(false);
      } else if (key.name === "space" && checked) {
        if (checked.has(cursor)) checked.delete(cursor);
        else checked.add(cursor);
        render(false);
      } else if (key.name === "return") {
        done(checked ? [...checked].sort((a, b) => a - b) : [cursor]);
      } else if (key.ctrl && key.name === "c") {
        done([]);
        process.exit(130);
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

export async function multiSelect(message: string, choices: Choice[], preChecked: string[]): Promise<string[]> {
  const checked = new Set(choices.flatMap((c, i) => (preChecked.includes(c.value) ? [i] : [])));
  const picked = await menu(`${message} (space to toggle, enter to confirm)`, choices, 0, checked);
  return picked.map((i) => choices[i].value);
}

export async function select(message: string, choices: Choice[], initial: string): Promise<string> {
  const start = Math.max(0, choices.findIndex((c) => c.value === initial));
  const [picked] = await menu(message, choices, start, undefined);
  return choices[picked].value;
}

export async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${message} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
