"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

function nativeCall(executable, message, env) {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  const child = spawnSync(executable, { input: frame, env, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr?.toString() || "native host failed");
  const length = child.stdout.readUInt32LE(0);
  return JSON.parse(child.stdout.subarray(4, 4 + length));
}

test("Windows 本地组件能脱离扩展进程执行后台任务", { skip: process.platform !== "win32" }, async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bookmark-bridge-host-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const framework = process.arch === "x64"
    ? "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319"
    : "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319";
  const executable = path.join(directory, "bookmark-bridge-host.exe");
  const compile = spawnSync(path.join(framework, "csc.exe"), [
    "/nologo",
    "/target:exe",
    `/out:${executable}`,
    `/reference:${path.join(framework, "System.Web.Extensions.dll")}`,
    path.join(__dirname, "native-host.cs"),
  ], { encoding: "utf8" });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);

  const fakeRunner = `
    const fs = require("node:fs");
    const path = require("node:path");
    const token = process.argv[process.argv.indexOf("--ui-job") + 1];
    const runs = path.join(process.env.BOOKMARK_BRIDGE_DATA_DIR, "runs");
    const stateFile = path.join(runs, token + ".state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.status = "completed"; state.phase = "complete"; state.pid = process.pid;
    state.output = ["detached runner completed"];
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const active = path.join(runs, "active.json");
    if (fs.existsSync(active)) fs.rmSync(active, { force: true });
  `;
  fs.writeFileSync(path.join(directory, "bookmark-bridge.js"), fakeRunner, "utf8");
  const dataDirectory = path.join(directory, "data");
  const env = { ...process.env, BOOKMARK_BRIDGE_DATA_DIR: dataDirectory };
  const token = crypto.randomBytes(24).toString("hex");
  const started = nativeCall(executable, { action: "run", token, command: "history" }, env);
  assert.equal(started.ok, true);

  let state = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = nativeCall(executable, { action: "status", token }, env).state;
    if (state?.status === "completed") break;
  }
  assert.equal(state?.status, "completed");
  assert.deepEqual(state.output, ["detached runner completed"]);
});
