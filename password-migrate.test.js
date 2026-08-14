"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { looksLikePasswordCsv, passwordManagerUrl } = require("./password-migrate");

test("只通过 CSV 表头识别密码导出文件", () => {
  const fixture = path.join(__dirname, "testdata", "passwords-synthetic.csv");
  assert.equal(looksLikePasswordCsv(fixture), true);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bookmark-bridge-password-test-"));
  try {
    const ordinary = path.join(directory, "ordinary.csv");
    fs.writeFileSync(ordinary, "name,email\nAlice,alice@example.invalid\n", "utf8");
    assert.equal(looksLikePasswordCsv(ordinary), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("使用各浏览器的原生密码管理页面", () => {
  assert.equal(passwordManagerUrl("chrome"), "chrome://password-manager/settings");
  assert.equal(passwordManagerUrl("edge"), "edge://wallet/passwords");
});
