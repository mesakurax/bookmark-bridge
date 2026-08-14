"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { UiJob, atomicJson } = require("./ui-job");

test("扩展异步任务保存进度、恢复日志并接收继续信号", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bookmark-bridge-ui-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const token = "e".repeat(48);
  const job = new UiJob(token, { directory });
  job.start("passwords-to-chrome");

  const restore = job.captureConsole();
  console.log("正在等待密码导出");
  restore();
  const waiting = job.waitForSignal("password-export", { browser: "Edge" });
  setTimeout(() => atomicJson(job.signalFile, { action: "continue" }), 20);
  const signal = await waiting;
  assert.equal(signal.action, "continue");

  job.complete();
  const state = job.read();
  assert.equal(state.status, "completed");
  assert.ok(state.output.includes("正在等待密码导出"));
  assert.equal(fs.existsSync(job.activeFile), false);
});

test("扩展弹窗只暴露 7 个主要操作", () => {
  const html = fs.readFileSync(path.join(__dirname, "extension", "popup.html"), "utf8");
  const commands = [...html.matchAll(/data-command="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(commands, [
    "bookmarks-to-chrome",
    "bookmarks-to-edge",
    "passwords-to-chrome",
    "passwords-to-edge",
    "history",
    "all-to-chrome",
    "all-to-edge",
  ]);
});
