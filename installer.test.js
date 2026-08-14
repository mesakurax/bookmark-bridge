"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function source(name) {
  return fs.readFileSync(path.join(__dirname, name), "utf8");
}

test("远程安装优先使用固定 Release 资源并显示阶段进度", () => {
  const remote = source("install-remote.ps1");
  assert.match(remote, /releases\/latest\/download\/bookmark-bridge-windows\.zip/);
  assert.match(remote, /\[1\/3\].*下载/);
  assert.match(remote, /\[2\/3\].*解压/);
  assert.match(remote, /\[3\/3\].*安装/);
  assert.ok(
    remote.indexOf("$stableDownloadUrl") < remote.indexOf("api.github.com"),
    "固定资源必须是主路径，GitHub API 只能作为兼容回退",
  );
});

test("Release 同时生成固定资源并预编译 Native Host", () => {
  const workflow = source(path.join(".github", "workflows", "release.yml"));
  assert.match(workflow, /bookmark-bridge-windows\.zip/);
  assert.match(workflow, /bookmark-bridge-host\.exe/);
  assert.match(workflow, /Packaged installer smoke test/);
});

test("安装器优先复制预编译 Native Host，并保留源码编译回退", () => {
  const installer = source("install.ps1");
  assert.match(installer, /\$prebuiltHost/);
  assert.match(installer, /Copy-Item -LiteralPath \$prebuiltHost/);
  assert.match(installer, /if \(-not \(Test-Path -LiteralPath \$prebuiltHost\)\)/);
  assert.match(installer, /csc\.exe/);
  assert.doesNotMatch(
    installer.match(/\$files = @\(([\s\S]*?)\n\)/)?.[1] || "",
    /native-host\.cs/,
    "编译源码不应作为运行时文件安装",
  );
});

test("主程序、扩展和包版本保持一致", () => {
  const packageVersion = JSON.parse(source("package.json")).version;
  const manifestVersion = JSON.parse(source(path.join("extension", "manifest.json"))).version;
  const mainVersion = source("bookmark-bridge.js").match(/const VERSION = "([^"]+)";/)?.[1];
  assert.equal(manifestVersion, packageVersion);
  assert.equal(mainVersion, packageVersion);
});
