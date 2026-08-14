"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawn } = require("node:child_process");

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function browserExecutable(browser) {
  const candidates = browser === "chrome"
    ? [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData(), "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : [
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function passwordManagerUrl(browser) {
  return browser === "chrome"
    ? "chrome://password-manager/settings"
    : "edge://wallet/passwords";
}

function openPasswordManager(browser, profile) {
  const executable = browserExecutable(browser);
  if (!executable) throw new Error(`找不到 ${browser === "chrome" ? "Chrome" : "Edge"} 可执行文件。`);
  const child = spawn(executable, [`--profile-directory=${profile}`, passwordManagerUrl(browser)], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

function csvCandidates(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return { file, stat: fs.statSync(file) };
    });
}

function looksLikePasswordCsv(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytes).toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
    const columns = new Set(firstLine.split(",").map((value) => value.trim().replace(/^"|"$/g, "").toLowerCase()));
    return columns.has("url") && columns.has("username") && columns.has("password");
  } finally {
    fs.closeSync(descriptor);
  }
}

function findNewPasswordCsv(startedAt, before) {
  const directories = [
    path.join(os.homedir(), "Downloads"),
    path.join(os.homedir(), "Desktop"),
  ];
  const candidates = directories
    .flatMap(csvCandidates)
    .filter(({ file, stat }) => stat.mtimeMs >= startedAt - 2000 || !before.has(path.resolve(file).toLowerCase()))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  return candidates.find(({ file }) => {
    try {
      return looksLikePasswordCsv(file);
    } catch (_) {
      return false;
    }
  })?.file || null;
}

function snapshotCsvFiles() {
  const files = [
    ...csvCandidates(path.join(os.homedir(), "Downloads")),
    ...csvCandidates(path.join(os.homedir(), "Desktop")),
  ];
  return new Set(files.map(({ file }) => path.resolve(file).toLowerCase()));
}

function stageCsv(sourceFile, stagingFile) {
  if (!fs.existsSync(sourceFile)) throw new Error(`找不到密码 CSV：${sourceFile}`);
  if (!looksLikePasswordCsv(sourceFile)) {
    throw new Error("所选 CSV 缺少 url、username、password 表头；为避免误传文件，流程已停止。");
  }
  fs.mkdirSync(path.dirname(stagingFile), { recursive: true });
  if (path.resolve(sourceFile).toLowerCase() !== path.resolve(stagingFile).toLowerCase()) {
    try {
      fs.renameSync(sourceFile, stagingFile);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      fs.copyFileSync(sourceFile, stagingFile, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(sourceFile);
    }
  }
  try {
    fs.chmodSync(stagingFile, 0o600);
  } catch (_) {
    // Windows ACL is inherited from the current user's LocalAppData folder.
  }
}

function cleanupStaleCsv(directory, keepFile = null) {
  if (!fs.existsSync(directory)) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const { file, stat } of csvCandidates(directory)) {
    if (keepFile && path.resolve(file).toLowerCase() === path.resolve(keepFile).toLowerCase()) continue;
    if (stat.mtimeMs < cutoff) fs.unlinkSync(file);
  }
}

async function migratePasswords(options) {
  const sourceLabel = options.sourceBrowser === "chrome" ? "Chrome" : "Edge";
  const targetLabel = options.targetBrowser === "chrome" ? "Chrome" : "Edge";
  const sourceProfile = options.sourceBrowser === "chrome" ? options.chromeProfile : options.edgeProfile;
  const targetProfile = options.targetBrowser === "chrome" ? options.chromeProfile : options.edgeProfile;
  const stagingDir = path.join(localAppData(), "BookmarkBridge", "password-transfer");
  const stagingFile = path.join(stagingDir, `passwords-${Date.now()}-${process.pid}.csv`);

  console.log(`${sourceLabel} -> ${targetLabel}（密码）`);
  console.log("  方式：浏览器原生 CSV 导出/导入；不会直接读取或解密密码数据库。");
  console.log("  重复项：由目标浏览器显示冲突并让你选择跳过或替换。");

  if (options.dryRun) {
    console.log(`  将打开：${passwordManagerUrl(options.sourceBrowser)}`);
    console.log(`  然后打开：${passwordManagerUrl(options.targetBrowser)}`);
    console.log("预览完成：没有打开页面，也没有创建临时文件。");
    return { dryRun: true };
  }

  fs.mkdirSync(stagingDir, { recursive: true });
  cleanupStaleCsv(stagingDir);
  const before = snapshotCsvFiles();
  const startedAt = Date.now();
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let staged = false;

  const cleanup = () => {
    if (staged && fs.existsSync(stagingFile)) fs.unlinkSync(stagingFile);
  };
  const onInterrupt = () => {
    try { cleanup(); } finally { process.exit(130); }
  };
  process.once("SIGINT", onInterrupt);

  try {
    openPasswordManager(options.sourceBrowser, sourceProfile);
    console.log(`\n1. 已打开 ${sourceLabel} 密码管理页。`);
    console.log("   请点击“导出密码”，完成 Windows Hello，并在保存窗口保留默认 CSV 文件名。\n");
    await terminal.question("导出完成后按 Enter 继续……");

    let exportedFile = findNewPasswordCsv(startedAt, before);
    if (!exportedFile) {
      const pasted = (await terminal.question("没有在下载/桌面目录自动找到新密码 CSV，请粘贴完整路径：")).trim();
      exportedFile = pasted.replace(/^['\"]|['\"]$/g, "");
    }
    stageCsv(exportedFile, stagingFile);
    staged = true;

    openPasswordManager(options.targetBrowser, targetProfile);
    console.log(`\n2. 已打开 ${targetLabel} 密码管理页。`);
    console.log("   请点击“导入密码”，在文件窗口选择下面这个临时文件：");
    console.log(`   ${stagingFile}`);
    console.log("   若出现重复项：以本次源浏览器为准时选择“替换”，否则选择“跳过”。\n");
    await terminal.question("确认目标浏览器已完成导入后按 Enter；随后将删除临时明文 CSV……");
    console.log("密码迁移流程完成。");
    return { dryRun: false, sourceBrowser: options.sourceBrowser, targetBrowser: options.targetBrowser };
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    terminal.close();
    cleanup();
  }
}

module.exports = {
  looksLikePasswordCsv,
  migratePasswords,
  passwordManagerUrl,
};
