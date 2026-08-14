"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { bookmarkApiReconciliation, parseArgs } = require("./bookmark-bridge");

const expectedCommands = [
  ["bookmarks-to-chrome", "bookmarks", "edge", "chrome"],
  ["bookmarks-to-edge", "bookmarks", "chrome", "edge"],
  ["passwords-to-chrome", "passwords", "edge", "chrome"],
  ["passwords-to-edge", "passwords", "chrome", "edge"],
  ["history", "history", null, null],
  ["all-to-chrome", "all", "edge", "chrome"],
  ["all-to-edge", "all", "chrome", "edge"],
];

test("7 个固定命令映射到正确的数据类型和方向", () => {
  for (const [requested, action, source, target] of expectedCommands) {
    const options = parseArgs([requested]);
    assert.equal(options.requestedCommand, requested);
    assert.equal(options.command, action);
    assert.equal(options.sourceBrowser, source);
    assert.equal(options.targetBrowser, target);
  }
});

test("主要选项仍可附加在固定命令后", () => {
  const options = parseArgs([
    "all-to-chrome",
    "--dry-run",
    "--chrome-profile", "Profile 1",
    "--edge-profile", "Profile 2",
  ]);
  assert.equal(options.dryRun, true);
  assert.equal(options.chromeProfile, "Profile 1");
  assert.equal(options.edgeProfile, "Profile 2");
});

test("解析版本命令", () => {
  assert.equal(parseArgs(["--version"]).command, "version");
  assert.equal(parseArgs(["-v"]).command, "version");
});

test("扩展后台只接受 48 位任务令牌", () => {
  const token = "a".repeat(48);
  assert.equal(parseArgs(["history", "--ui-job", token]).uiJob, token);
  const invalid = spawnSync(process.execPath, [
    path.join(__dirname, "bookmark-bridge.js"),
    "history",
    "--ui-job",
    "short",
  ], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /无效的扩展任务令牌/);
});

test("旧命令和重启参数不再兼容", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "bookmark-sync.cmd")), false);
  assert.equal(fs.existsSync(path.join(__dirname, "bookmark-sync.js")), false);

  const oldCommand = spawnSync(process.execPath, [path.join(__dirname, "bookmark-bridge.js"), "edge-to-chrome"], {
    encoding: "utf8",
  });
  assert.notEqual(oldCommand.status, 0);
  assert.match(oldCommand.stderr, /未知命令/);

  const oldFlag = spawnSync(process.execPath, [
    path.join(__dirname, "bookmark-bridge.js"),
    "bookmarks-to-chrome",
    "--restart-target",
  ], { encoding: "utf8" });
  assert.notEqual(oldFlag.status, 0);
  assert.match(oldFlag.stderr, /未知选项/);
});

test("浏览器 API 精确落地已计算的合并结果", () => {
  const rawSource = { roots: { marker: "raw source" } };
  const calculatedOutput = { roots: { marker: "calculated merge result" } };
  const reconciliation = bookmarkApiReconciliation({ output: calculatedOutput, rawSource });
  assert.equal(reconciliation.desiredDocument, calculatedOutput);
  assert.notEqual(reconciliation.desiredDocument, rawSource);
  assert.equal(reconciliation.mode, "mirror");
});
