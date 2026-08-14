#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { executeHistorySync } = require("./history-sync");
const { migratePasswords } = require("./password-migrate");

const APP_NAME = "Bookmark Bridge";
const VERSION = "2.1.0";
const MANAGED_ROOTS = ["bookmark_bar", "other", "synced"];
const COMMANDS = new Map([
  ["bookmarks-to-chrome", { action: "bookmarks", sourceBrowser: "edge", targetBrowser: "chrome" }],
  ["bookmarks-to-edge", { action: "bookmarks", sourceBrowser: "chrome", targetBrowser: "edge" }],
  ["passwords-to-chrome", { action: "passwords", sourceBrowser: "edge", targetBrowser: "chrome" }],
  ["passwords-to-edge", { action: "passwords", sourceBrowser: "chrome", targetBrowser: "edge" }],
  ["history", { action: "history", sourceBrowser: null, targetBrowser: null }],
  ["all-to-chrome", { action: "all", sourceBrowser: "edge", targetBrowser: "chrome" }],
  ["all-to-edge", { action: "all", sourceBrowser: "chrome", targetBrowser: "edge" }],
]);

function fail(message, exitCode = 1) {
  console.error(`错误：${message}`);
  process.exit(exitCode);
}

function info(message) {
  console.log(message);
}

function usage() {
  console.log(`${APP_NAME} ${VERSION}

在 Windows 上手动桥接 Chrome 与 Edge 的收藏夹、密码和浏览记录。
不常驻后台，也不修改两款浏览器原有的云同步设置。

用法：
  bookmark-bridge <命令> [选项]

7 个主要命令：
  bookmarks-to-chrome 收藏夹 Edge -> Chrome
  bookmarks-to-edge   收藏夹 Chrome -> Edge
  passwords-to-chrome 密码 Edge -> Chrome
  passwords-to-edge   密码 Chrome -> Edge
  history             历史记录双向合并，双方都变成 A+B
  all-to-chrome       收藏夹/密码 Edge -> Chrome，历史记录双向合并
  all-to-edge         收藏夹/密码 Chrome -> Edge，历史记录双向合并

辅助命令：
  status              查看数据文件、项目数量、运行状态和历史基线

选项：
  -h, --help          显示中文帮助。
  -v, --version       显示版本号。
  --dry-run           只预览收藏夹/历史记录，不修改数据。密码只显示流程。
  --mode merge        安全合并：新增/更新源端项目，保留目标端独有项目。
                      这是收藏夹的默认模式。
  --mode mirror       精确镜像：让目标端标准收藏夹完全跟随源端，会删除
                      目标端独有项目。实际执行时必须同时使用 --yes。
  --yes               确认执行 mirror 模式的删除操作。
  --reset-history-baseline
                      忽略已有历史基线，重新做一次全量比较；不会清空历史。
  --chrome-profile X  指定 Chrome 配置目录，例如 "Default" 或 "Profile 1"。
  --edge-profile X    指定 Edge 配置目录，例如 "Default" 或 "Profile 1"。
  --chrome-store X    指定 Chrome 存储文件：Bookmarks 或 AccountBookmarks。
  --edge-store X      指定 Edge 存储文件：Bookmarks 或 AccountBookmarks。
  --backup-dir PATH   指定备份目录。默认是：
                      %LOCALAPPDATA%\\BookmarkBridge\\backups

常用示例：
  bookmark-bridge status
      查看当前状态。

  bookmark-bridge bookmarks-to-chrome --dry-run
      预览收藏夹 Edge -> Chrome。

  bookmark-bridge passwords-to-edge
      把 Chrome 密码迁移到 Edge；安全确认由你点击。

  bookmark-bridge history
      自动重启两款浏览器，双向合并新增历史。

  bookmark-bridge all-to-chrome
      收藏夹和密码 Edge -> Chrome，历史记录两边合并。

  bookmark-bridge all-to-edge
      收藏夹和密码 Chrome -> Edge，历史记录两边合并。

安全规则：
  1. 需要退出浏览器时，工具会自动关闭，并重开原本有窗口的浏览器。
     浏览器未打开时不会额外打开；未提交的网页表单文字可能丢失。
  2. 收藏夹只写目标端；默认 merge 不删除目标端独有项目。
  3. 历史记录同时写两边，因此同步期间会自动退出两款浏览器。
  4. 历史基线避免下一次重新处理旧记录；删除历史不会传播到另一边。
  5. 密码明文只存在于浏览器导出的临时 CSV；工具不打印其内容，
     流程结束会删除中转文件。密码迁移不是无人值守操作。
  6. 收藏夹和历史记录每次写入前都会创建带时间戳的原始备份。
`);
}

function parseArgs(argv) {
  let requestedCommand = argv[0] || "help";
  if (requestedCommand === "--version" || requestedCommand === "-v") requestedCommand = "version";
  const definition = COMMANDS.get(requestedCommand) || null;

  const result = {
    command: definition?.action || requestedCommand,
    requestedCommand,
    sourceBrowser: definition?.sourceBrowser || null,
    targetBrowser: definition?.targetBrowser || null,
    mode: "merge",
    dryRun: false,
    yes: false,
    chromeProfile: "Default",
    edgeProfile: "Default",
    chromeStore: null,
    edgeStore: null,
    backupDir: null,
    resetHistoryBaseline: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--yes") result.yes = true;
    else if (arg === "--reset-history-baseline") result.resetHistoryBaseline = true;
    else if (arg === "--help" || arg === "-h") result.command = "help";
    else if (arg === "--mode") result.mode = requiredValue(argv, ++index, arg);
    else if (arg === "--chrome-profile") result.chromeProfile = requiredValue(argv, ++index, arg);
    else if (arg === "--edge-profile") result.edgeProfile = requiredValue(argv, ++index, arg);
    else if (arg === "--chrome-store") result.chromeStore = requiredValue(argv, ++index, arg);
    else if (arg === "--edge-store") result.edgeStore = requiredValue(argv, ++index, arg);
    else if (arg === "--backup-dir") result.backupDir = requiredValue(argv, ++index, arg);
    else fail(`未知选项：${arg}。使用 bookmark-bridge -h 查看帮助。`);
  }

  if (!new Set(["merge", "mirror"]).has(result.mode)) {
    fail(`不支持模式 "${result.mode}"，请使用 merge 或 mirror。`);
  }
  for (const [label, value] of [["Chrome", result.chromeStore], ["Edge", result.edgeStore]]) {
    if (value && !new Set(["Bookmarks", "AccountBookmarks"]).has(value)) {
      fail(`${label} 存储文件必须是 Bookmarks 或 AccountBookmarks。`);
    }
  }
  return result;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) fail(`${option} 后面需要提供一个值。`);
  return value;
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function browserProfileDefinition(browser, profile) {
  const base = browser === "chrome"
    ? path.join(localAppData(), "Google", "Chrome", "User Data")
    : path.join(localAppData(), "Microsoft", "Edge", "User Data");
  const profileDir = path.join(base, profile);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`找不到 ${capitalize(browser)} 配置目录：${profileDir}`);
  }
  return {
    browser,
    profile,
    profileDir,
    historyFile: path.join(profileDir, "History"),
  };
}

function browserDefinition(browser, profile, explicitStore) {
  const profileDefinition = browserProfileDefinition(browser, profile);
  const { profileDir } = profileDefinition;
  const preferred = browser === "chrome"
    ? ["AccountBookmarks", "Bookmarks"]
    : ["Bookmarks", "AccountBookmarks"];
  const candidates = explicitStore ? [explicitStore] : preferred;
  const existing = candidates.filter((name) => fs.existsSync(path.join(profileDir, name)));

  if (existing.length === 0) {
    throw new Error(`在 ${capitalize(browser)} 配置 "${profile}" 中找不到收藏夹文件。`);
  }

  return {
    ...profileDefinition,
    browser,
    profile,
    store: existing[0],
    file: path.join(profileDir, existing[0]),
  };
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function readDocument(definition) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(definition.file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${definition.file}: ${error.message}`);
  }
  validateDocument(document, definition.file, true);
  return document;
}

function validateDocument(document, label, verifyChecksum = false) {
  if (!document || typeof document !== "object" || !document.roots) {
    throw new Error(`${label} is not a Chromium bookmark document.`);
  }
  for (const root of MANAGED_ROOTS) {
    if (!document.roots[root] || document.roots[root].type !== "folder") {
      throw new Error(`${label} is missing the ${root} root folder.`);
    }
  }

  const ids = new Set();
  const guids = new Set();
  walkAllRoots(document, (node) => {
    if (!node.id || ids.has(String(node.id))) {
      throw new Error(`${label} contains a missing or duplicate bookmark ID.`);
    }
    ids.add(String(node.id));
    if (node.guid) {
      const guid = String(node.guid).toLowerCase();
      if (guids.has(guid)) throw new Error(`${label} contains a duplicate bookmark GUID.`);
      guids.add(guid);
    }
  });

  if (verifyChecksum && document.checksum) {
    const expected = computeChecksum(document, "md5");
    if (String(document.checksum).toLowerCase() !== expected) {
      throw new Error(`${label} failed its Chromium checksum validation.`);
    }
  }
}

function walkAllRoots(document, callback) {
  for (const root of Object.values(document.roots)) walkNode(root, callback);
}

function walkNode(node, callback) {
  if (!node || typeof node !== "object") return;
  callback(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkNode(child, callback);
  }
}

function checksumChunks(document) {
  const chunks = [];
  walkAllRoots(document, (node) => {
    if (node.type !== "folder" && node.type !== "url") return;
    chunks.push(Buffer.from(String(node.id || ""), "utf8"));
    chunks.push(Buffer.from(String(node.name || ""), "utf16le"));
    chunks.push(Buffer.from(node.type, "utf8"));
    if (node.type === "url") chunks.push(Buffer.from(String(node.url || ""), "utf8"));
  });
  return chunks;
}

function computeChecksum(document, algorithm) {
  const hash = crypto.createHash(algorithm);
  for (const chunk of checksumChunks(document)) hash.update(chunk);
  return hash.digest("hex");
}

function refreshChecksums(document) {
  document.checksum = computeChecksum(document, "md5");
  if (Object.prototype.hasOwnProperty.call(document, "checksum_sha256")) {
    document.checksum_sha256 = computeChecksum(document, "sha256");
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildTargetIndexes(target) {
  const byGuid = new Map();
  const byUrl = new Map();
  const foldersByName = new Map();
  for (const rootName of MANAGED_ROOTS) {
    walkNode(target.roots[rootName], (node) => {
      if (node.guid) {
        const guid = String(node.guid).toLowerCase();
        if (!byGuid.has(guid)) byGuid.set(guid, []);
        byGuid.get(guid).push(node);
      }
      if (node.type === "url") {
        const url = String(node.url || "");
        if (!byUrl.has(url)) byUrl.set(url, []);
        byUrl.get(url).push(node);
      }
      if (node.type === "folder") {
        const name = String(node.name || "").trim().toLocaleLowerCase();
        if (!foldersByName.has(name)) foldersByName.set(name, []);
        foldersByName.get(name).push(node);
      }
    });
  }
  return { byGuid, byUrl, foldersByName };
}

function syncDocuments(source, target, mode) {
  const output = deepClone(target);
  const indexes = buildTargetIndexes(output);
  const plannedTargets = new Map();
  const reservedTargetNodes = new Set();

  function reserve(sourceNode, candidates, preferred) {
    if (!candidates || candidates.length === 0) return false;
    const available = candidates.filter((candidate) =>
      candidate.type === sourceNode.type && !reservedTargetNodes.has(candidate));
    if (available.length === 0) return false;
    const match = preferred?.(available) || available[0];
    plannedTargets.set(sourceNode, match);
    reservedTargetNodes.add(match);
    return true;
  }

  // GUID is the strongest identity and is preserved by Bookmark Bridge after
  // the first sync in either direction.
  for (const rootName of MANAGED_ROOTS) {
    walkNode(source.roots[rootName], (sourceNode) => {
      if (!sourceNode.guid) return;
      const candidates = indexes.byGuid.get(String(sourceNode.guid).toLowerCase()) || [];
      reserve(sourceNode, candidates);
    });
  }

  // Native one-way import also changes folder GUIDs. Reuse a folder only when
  // its normalized name is unique on both sides; otherwise creating a new
  // folder is safer than merging two unrelated folders with the same name.
  const sourceFolderNameCounts = new Map();
  for (const rootName of MANAGED_ROOTS) {
    walkNode(source.roots[rootName], (sourceNode) => {
      if (sourceNode.type !== "folder") return;
      const name = String(sourceNode.name || "").trim().toLocaleLowerCase();
      sourceFolderNameCounts.set(name, (sourceFolderNameCounts.get(name) || 0) + 1);
    });
  }
  for (const rootName of MANAGED_ROOTS) {
    walkNode(source.roots[rootName], (sourceNode) => {
      if (plannedTargets.has(sourceNode) || sourceNode.type !== "folder") return;
      const name = String(sourceNode.name || "").trim().toLocaleLowerCase();
      const available = (indexes.foldersByName.get(name) || []).filter(
        (candidate) => !reservedTargetNodes.has(candidate));
      if (sourceFolderNameCounts.get(name) === 1 && available.length === 1) {
        reserve(sourceNode, available);
      }
    });
  }

  // Edge's native Chrome importer commonly assigns new GUIDs. Match remaining
  // URL nodes globally by URL so an imported bookmark is moved/updated instead
  // of duplicated. Prefer an equal title if the same URL is bookmarked twice.
  for (const rootName of MANAGED_ROOTS) {
    walkNode(source.roots[rootName], (sourceNode) => {
      if (plannedTargets.has(sourceNode) || sourceNode.type !== "url") return;
      const candidates = indexes.byUrl.get(String(sourceNode.url || "")) || [];
      reserve(sourceNode, candidates, (available) =>
        available.find((candidate) => candidate.name === sourceNode.name) || available[0]);
    });
  }

  let maxId = 0n;
  const occupiedIds = new Set();
  const occupiedGuids = new Set();
  walkAllRoots(output, (node) => {
    const id = BigInt(String(node.id));
    if (id > maxId) maxId = id;
    occupiedIds.add(String(node.id));
    if (node.guid) occupiedGuids.add(String(node.guid).toLowerCase());
  });

  const metrics = { added: 0, updated: 0, movedOrMatched: 0, keptTargetOnly: 0 };

  function nextId() {
    do maxId += 1n; while (occupiedIds.has(maxId.toString()));
    const result = maxId.toString();
    occupiedIds.add(result);
    return result;
  }

  function chooseGuid(sourceGuid) {
    const normalized = sourceGuid ? String(sourceGuid).toLowerCase() : "";
    if (normalized && !occupiedGuids.has(normalized)) {
      occupiedGuids.add(normalized);
      return normalized;
    }
    let generated;
    do generated = crypto.randomUUID(); while (occupiedGuids.has(generated));
    occupiedGuids.add(generated);
    return generated;
  }

  function cloneNew(sourceNode) {
    const result = deepClone(sourceNode);
    result.id = nextId();
    result.guid = chooseGuid(sourceNode.guid);
    if (result.type === "folder") {
      result.children = (sourceNode.children || []).map((child) => importNode(child));
    }
    metrics.added += 1;
    return result;
  }

  function updateFromSource(sourceNode, targetNode) {
    const result = deepClone(targetNode);
    const preservedId = result.id;
    const preservedGuid = result.guid;
    const preservedTargetFields = new Set(["source", "visit_count", "show_icon"]);

    for (const [key, value] of Object.entries(sourceNode)) {
      if (key === "id" || key === "guid" || key === "children" || preservedTargetFields.has(key)) continue;
      result[key] = deepClone(value);
    }
    result.id = preservedId;
    result.guid = preservedGuid || chooseGuid(sourceNode.guid);
    if (sourceNode.type === "folder") result.children = mergeChildren(sourceNode, targetNode);
    if (JSON.stringify(result) !== JSON.stringify(targetNode)) metrics.updated += 1;
    return result;
  }

  function importNode(sourceNode) {
    const targetNode = plannedTargets.get(sourceNode) || null;
    if (!targetNode) return cloneNew(sourceNode);
    metrics.movedOrMatched += 1;
    return updateFromSource(sourceNode, targetNode);
  }

  function preserveTargetOnly(targetNode) {
    if (reservedTargetNodes.has(targetNode)) return null;
    const result = deepClone(targetNode);
    if (result.type === "folder") {
      const originalChildren = targetNode.children || [];
      result.children = originalChildren
        .map(preserveTargetOnly)
        .filter(Boolean);
      // A wrapper folder whose entire content was matched and moved into the
      // source structure is not target-only and should not survive as an empty
      // duplicate. Genuinely empty target folders are retained.
      if (originalChildren.length > 0 && result.children.length === 0) return null;
    }
    metrics.keptTargetOnly += 1;
    return result;
  }

  function mergeChildren(sourceFolder, targetFolder) {
    const imported = (sourceFolder.children || []).map((child) => importNode(child));
    if (mode === "mirror") return imported;

    for (const child of targetFolder.children || []) {
      const preserved = preserveTargetOnly(child);
      if (preserved) imported.push(preserved);
    }
    return imported;
  }

  for (const rootName of MANAGED_ROOTS) {
    const sourceRoot = source.roots[rootName];
    const targetRoot = output.roots[rootName];
    targetRoot.children = mergeChildren(sourceRoot, targetRoot);
    if (sourceRoot.date_modified) targetRoot.date_modified = sourceRoot.date_modified;
  }

  refreshChecksums(output);
  validateDocument(output, "generated bookmark document", true);
  return { output, metrics };
}

function countDocument(document) {
  const result = { urls: 0, folders: 0 };
  for (const rootName of MANAGED_ROOTS) {
    walkNode(document.roots[rootName], (node) => {
      if (node.type === "url") result.urls += 1;
      else if (node.type === "folder") result.folders += 1;
    });
  }
  // Do not include the three semantic root folders in user-facing counts.
  result.folders -= MANAGED_ROOTS.length;
  return result;
}

function runningBrowsers() {
  if (process.platform !== "win32") return [];
  let output = "";
  try {
    output = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  } catch (error) {
    fail(`Could not check running browser processes: ${error.message}`);
  }
  const lower = output.toLowerCase();
  return ["chrome.exe", "msedge.exe"].filter((name) => lower.includes(`"${name}"`));
}

function browserProcessState(browser) {
  if (process.platform !== "win32") return { processes: [], visible: [] };
  const processName = browser === "chrome" ? "chrome" : "msedge";
  const script = [
    `$items = @(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object {`,
    `  [PSCustomObject]@{ Id = $_.Id; Visible = ($_.MainWindowHandle -ne 0); Title = $_.MainWindowTitle; Path = $_.Path }`,
    `})`,
    `$items | ConvertTo-Json -Compress`,
  ].join("\n");
  let output = "";
  try {
    output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch (error) {
    throw new Error(`Could not inspect ${capitalize(browser)} processes: ${error.message}`);
  }
  if (!output) return { processes: [], visible: [] };
  const parsed = JSON.parse(output);
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  return { processes, visible: processes.filter((item) => item.Visible) };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function stopBrowser(browser, state) {
  if (state.processes.length === 0) return;

  const imageName = browser === "chrome" ? "chrome.exe" : "msedge.exe";
  if (state.visible.length === 0) {
    info(`Stopping background-only ${capitalize(browser)} processes...`);
  } else {
    info(`Closing target browser ${capitalize(browser)}...`);
  }

  // First request a normal close so the browser can flush its profile. If any
  // startup-boost/background processes remain, stop only those after waiting.
  try {
    execFileSync("taskkill.exe", ["/IM", imageName, "/T"], { stdio: "ignore", windowsHide: true });
  } catch (_) {
    // taskkill may report failure for sandboxed child processes even when the
    // main browser accepted the close request; the state check below decides.
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (browserProcessState(browser).processes.length === 0) return;
    sleep(250);
  }
  try {
    execFileSync("taskkill.exe", ["/IM", imageName, "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch (_) {
    // Verify below and return a useful error if processes remain.
  }
  sleep(500);
  const remaining = browserProcessState(browser).processes;
  if (remaining.length > 0) {
    const error = new Error(
      `Could not stop all ${capitalize(browser)} processes. Remaining PIDs: ${remaining.map((item) => item.Id).join(", ")}`);
    error.exitCode = 3;
    throw error;
  }
}

function browserExecutable(browser, priorState) {
  const fromState = priorState.processes.map((item) => item.Path).find((candidate) => candidate && fs.existsSync(candidate));
  if (fromState) return fromState;
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

function reopenBrowser(browser, executable) {
  if (!executable) {
    info(`Warning: sync succeeded, but ${capitalize(browser)} could not be reopened because its executable was not found.`);
    return;
  }
  const child = spawn(executable, ["--restore-last-session"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  info(`Reopened ${capitalize(browser)}.`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupTarget(definition, backupDirOverride) {
  const backupDir = backupDirOverride || path.join(localAppData(), "BookmarkBridge", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const name = `${definition.browser}-${definition.profile.replace(/[^a-z0-9_-]+/gi, "_")}-${definition.store}-${timestamp()}.json`;
  const destination = path.join(backupDir, name);
  fs.copyFileSync(definition.file, destination, fs.constants.COPYFILE_EXCL);
  return destination;
}

function writeAtomically(file, document) {
  const directory = path.dirname(file);
  const tempFile = path.join(directory, `.${path.basename(file)}.bookmark-bridge-${process.pid}.tmp`);
  const oldFile = path.join(directory, `.${path.basename(file)}.bookmark-bridge-${process.pid}.old`);
  const text = `${JSON.stringify(document, null, 3)}\n`;

  fs.writeFileSync(tempFile, text, { encoding: "utf8", flag: "wx" });
  const reread = JSON.parse(fs.readFileSync(tempFile, "utf8"));
  validateDocument(reread, tempFile, true);

  try {
    fs.renameSync(file, oldFile);
    fs.renameSync(tempFile, file);
    fs.unlinkSync(oldFile);
  } catch (error) {
    try {
      if (!fs.existsSync(file) && fs.existsSync(oldFile)) fs.renameSync(oldFile, file);
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (_) {
      // Preserve the original error; the timestamped backup is still available.
    }
    throw error;
  }
}

function showDefinition(definition, document) {
  const counts = countDocument(document);
  info(`${capitalize(definition.browser)} [${definition.profile}]`);
  info(`  Store: ${definition.store}`);
  info(`  File:  ${definition.file}`);
  info(`  Items: ${counts.urls} URLs, ${counts.folders} folders`);
}

function status(options) {
  const chrome = browserDefinition("chrome", options.chromeProfile, options.chromeStore);
  const edge = browserDefinition("edge", options.edgeProfile, options.edgeStore);
  showDefinition(chrome, readDocument(chrome));
  showDefinition(edge, readDocument(edge));
  const running = runningBrowsers();
  info(`正在运行：${running.length ? running.join(", ") : "无"}`);
  const ledgerFile = historyLedgerFile(options);
  info(`历史基线：${fs.existsSync(ledgerFile) ? ledgerFile : "尚未建立（首次 history 会全量比较）"}`);
}

function synchronize(options) {
  const sourceBrowser = options.sourceBrowser;
  const targetBrowser = options.targetBrowser;
  const sourceProfile = sourceBrowser === "chrome" ? options.chromeProfile : options.edgeProfile;
  const targetProfile = targetBrowser === "chrome" ? options.chromeProfile : options.edgeProfile;
  const sourceStore = sourceBrowser === "chrome" ? options.chromeStore : options.edgeStore;
  const targetStore = targetBrowser === "chrome" ? options.chromeStore : options.edgeStore;
  const sourceDef = browserDefinition(sourceBrowser, sourceProfile, sourceStore);
  const targetDef = browserDefinition(targetBrowser, targetProfile, targetStore);
  let source = readDocument(sourceDef);
  let target = readDocument(targetDef);
  let before = countDocument(target);
  let sourceCounts = countDocument(source);
  let result = syncDocuments(source, target, options.mode);
  let after = countDocument(result.output);

  info(`${capitalize(sourceBrowser)} -> ${capitalize(targetBrowser)}（收藏夹，${options.mode}）`);
  info(`  Source: ${sourceCounts.urls} URLs, ${sourceCounts.folders} folders (${sourceDef.store})`);
  info(`  Target before: ${before.urls} URLs, ${before.folders} folders (${targetDef.store})`);
  info(`  Target after:  ${after.urls} URLs, ${after.folders} folders`);
  info(`  Added nodes: ${result.metrics.added}; updated nodes: ${result.metrics.updated}; target-only nodes kept: ${result.metrics.keptTargetOnly}`);

  if (options.dryRun) {
    info("预览完成：没有修改任何文件。");
    return;
  }
  if (options.mode === "mirror" && !options.yes) {
    fail("mirror 会删除目标端独有收藏夹。请先使用 --dry-run 预览，再加 --yes 执行。", 2);
  }
  const targetState = browserProcessState(targetBrowser);
  const shouldReopen = targetState.visible.length > 0;
  const executable = shouldReopen ? browserExecutable(targetBrowser, targetState) : null;
  stopBrowser(targetBrowser, targetState);

  try {
    // Closing the target may flush last-second bookmark changes. Re-read both
    // files and calculate the final result only after the target has stopped.
    source = readDocument(sourceDef);
    target = readDocument(targetDef);
    before = countDocument(target);
    sourceCounts = countDocument(source);
    result = syncDocuments(source, target, options.mode);
    after = countDocument(result.output);

    if (JSON.stringify(result.output) === JSON.stringify(target)) {
      info("Already synchronized: no write was needed.");
      return;
    }

    const backup = backupTarget(targetDef, options.backupDir);
    try {
      writeAtomically(targetDef.file, result.output);
    } catch (error) {
      throw new Error(`Write failed: ${error.message}\nBackup: ${backup}`);
    }
    info(`Backup: ${backup}`);
    info("Sync completed.");
  } finally {
    if (shouldReopen) reopenBrowser(targetBrowser, executable);
  }
}

function safeSegment(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, "_");
}

function historyDefinitions(options) {
  const chrome = browserProfileDefinition("chrome", options.chromeProfile);
  const edge = browserProfileDefinition("edge", options.edgeProfile);
  for (const definition of [chrome, edge]) {
    if (!fs.existsSync(definition.historyFile)) {
      throw new Error(`找不到 ${capitalize(definition.browser)} 历史数据库：${definition.historyFile}`);
    }
  }
  return { chrome, edge };
}

function historyLedgerFile(options) {
  const name = `history-${safeSegment(options.chromeProfile)}-${safeSegment(options.edgeProfile)}.json`;
  return path.join(localAppData(), "BookmarkBridge", "state", name);
}

function historyBackupDir(options) {
  return options.backupDir || path.join(localAppData(), "BookmarkBridge", "backups");
}

function withBrowsersStopped(options, callback) {
  const states = {
    chrome: browserProcessState("chrome"),
    edge: browserProcessState("edge"),
  };
  const reopen = {};
  for (const browser of ["chrome", "edge"]) {
    reopen[browser] = states[browser].visible.length > 0
      ? browserExecutable(browser, states[browser])
      : null;
  }

  try {
    stopBrowser("chrome", states.chrome);
    stopBrowser("edge", states.edge);
    return callback();
  } finally {
    for (const browser of ["chrome", "edge"]) {
      if (reopen[browser]) reopenBrowser(browser, reopen[browser]);
    }
  }
}

function reportHistoryResult(result) {
  const { plan } = result;
  info(`Chrome <-> Edge（历史记录，${plan.firstRun ? "首次全量" : "增量基线"}）`);
  info(`  扫描：Chrome ${plan.chromeRowsScanned} 条；Edge ${plan.edgeRowsScanned} 条`);
  info(`  将写入 Chrome：${plan.toChrome.length} 条`);
  info(`  将写入 Edge：  ${plan.toEdge.length} 条`);
  if (result.applied) {
    info(`  实际写入 Chrome：${result.applied.chrome.inserted} 条访问，涉及 ${result.applied.chrome.affectedUrls} 个网址`);
    info(`  实际写入 Edge：  ${result.applied.edge.inserted} 条访问，涉及 ${result.applied.edge.affectedUrls} 个网址`);
    info(`  备份：${result.backups.chrome}`);
    info(`        ${result.backups.edge}`);
    info("历史记录合并完成；删除记录不会传播到另一款浏览器。");
  } else {
    info("预览完成：没有修改历史数据库，也没有推进基线。");
  }
}

function synchronizeHistory(options) {
  const definitions = historyDefinitions(options);
  const run = () => executeHistorySync(definitions, {
    ledgerFile: historyLedgerFile(options),
    backupDir: historyBackupDir(options),
    resetBaseline: options.resetHistoryBaseline,
    dryRun: options.dryRun,
  });

  // History is frequently locked even for read-only access while Chromium is
  // open, so both browsers are automatically restarted even for a preview.
  const anyRunning = runningBrowsers().length > 0;
  const result = anyRunning || !options.dryRun ? withBrowsersStopped(options, run) : run();
  reportHistoryResult(result);
  return result;
}

async function synchronizeAll(options) {
  info(`完整同步：${capitalize(options.sourceBrowser)} -> ${capitalize(options.targetBrowser)}`);
  info("  收藏夹/密码按箭头方向；历史记录始终双向合并。\n");
  synchronize(options);
  await migratePasswords(options);
  // History runs last so that no database or bookmark write races with the
  // browsers that are asynchronously reopened after the final merge.
  synchronizeHistory(options);
  info("完整同步流程结束。");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "version") {
    console.log(`${APP_NAME} ${VERSION}`);
    return;
  }
  if (options.command === "help" || options.command === "--help" || options.command === "-h") {
    usage();
    return;
  }
  try {
    if (options.command === "status") status(options);
    else if (options.command === "bookmarks") synchronize(options);
    else if (options.command === "passwords") await migratePasswords(options);
    else if (options.command === "history") synchronizeHistory(options);
    else if (options.command === "all") await synchronizeAll(options);
    else {
      usage();
      fail(`未知命令：${options.command}。使用 bookmark-bridge -h 查看帮助。`);
    }
  } catch (error) {
    fail(error.message || String(error), error.exitCode || 1);
  }
}

if (require.main === module) {
  main().catch((error) => fail(error.message || String(error), error.exitCode || 1));
}

module.exports = {
  browserProfileDefinition,
  computeChecksum,
  countDocument,
  historyLedgerFile,
  parseArgs,
  refreshChecksums,
  syncDocuments,
  synchronizeHistory,
  validateDocument,
  writeAtomically,
};
