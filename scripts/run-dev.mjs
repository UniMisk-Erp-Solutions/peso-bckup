#!/usr/bin/env node
/** Start Vite after ensuring dev ports are free (Windows-safe). */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function runNode(script) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script], { cwd: root, stdio: "inherit", shell: false });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exit ${code}`))));
  });
}

await runNode("scripts/free-dev-ports.mjs");

const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const vite = spawn(process.execPath, [viteBin], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env },
});

vite.on("exit", (code) => process.exit(code ?? 0));
