/**
 * Dev-all — one command for the live rig: Vite on :5173 plus the ripstream
 * sidecar on 127.0.0.1:5174. Vite proxies /rip to the sidecar, so a phone on
 * the LAN hits http://<lan-ip>:5173 and never talks to the sidecar directly.
 *
 * Run: node scripts/dev-all.mjs   (or npm run dev:live)
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const children = [];
let shuttingDown = false;

function start(label, script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
  children.push({ label, child });
  child.on("exit", (code, signal) => {
    console.log(`[dev-all] ${label} exited (code ${code ?? "null"}, signal ${signal ?? "none"})`);
    if (!shuttingDown) stopAll(Number(code ?? 1));
  });
  child.on("error", (err) => {
    console.log(`[dev-all] ${label} failed to start: ${err?.message ?? err}`);
  });
  return child;
}

/** Windows-safe stop: plain kill first, taskkill /T /F when the tree resists. */
function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    /* fall through to taskkill */
  }
  const pid = child.pid;
  if (!pid) return;
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
    } catch {
      /* nothing else to try */
    }
  }, 1200).unref();
}

function stopAll(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { label, child } of children) {
    console.log(`[dev-all] stopping ${label} (pid ${child.pid})`);
    stop(child);
  }
  setTimeout(() => process.exit(code), 1800).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopAll(0));
}
process.on("exit", () => {
  for (const { child } of children) stop(child);
});

start("vite", path.join(root, "node_modules", "vite", "bin", "vite.js"), ["--host"]);
start("sidecar", path.join(root, "scripts", "ripstream", "server.mjs"), []);

console.log("[dev-all] vite on :5173 + sidecar on 127.0.0.1:5174");
