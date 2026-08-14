"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { parseArgs } = require("./bookmark-sync");

test("解析三个分类命令", () => {
  assert.deepEqual(
    pick(parseArgs(["bookmarks", "edge", "chrome", "--dry-run"])),
    { command: "bookmarks", sourceBrowser: "edge", targetBrowser: "chrome", dryRun: true },
  );
  assert.deepEqual(
    pick(parseArgs(["passwords", "chrome", "edge"])),
    { command: "passwords", sourceBrowser: "chrome", targetBrowser: "edge", dryRun: false },
  );
  assert.equal(parseArgs(["history", "--reset-history-baseline"]).resetHistoryBaseline, true);
});

test("解析两个完整同步方向", () => {
  const edgeToChrome = parseArgs(["all", "edge", "chrome", "--restart-browsers"]);
  const chromeToEdge = parseArgs(["all", "chrome", "edge", "--restart-browsers"]);
  assert.deepEqual([edgeToChrome.sourceBrowser, edgeToChrome.targetBrowser], ["edge", "chrome"]);
  assert.deepEqual([chromeToEdge.sourceBrowser, chromeToEdge.targetBrowser], ["chrome", "edge"]);
  assert.equal(edgeToChrome.restartBrowsers, true);
});

test("旧收藏夹命令保持兼容", () => {
  assert.deepEqual(
    pick(parseArgs(["edge-to-chrome", "--dry-run"])),
    { command: "bookmarks", sourceBrowser: "edge", targetBrowser: "chrome", dryRun: true },
  );
});

test("解析版本命令", () => {
  assert.equal(parseArgs(["--version"]).command, "version");
  assert.equal(parseArgs(["-v"]).command, "version");
});

function pick(options) {
  return {
    command: options.command,
    sourceBrowser: options.sourceBrowser,
    targetBrowser: options.targetBrowser,
    dryRun: options.dryRun,
  };
}
