"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const EXTENSION_ID = "faaofhehocblpehenggfdmpbpjnifpim";
const MOBILE_FALLBACK_TITLE = "移动收藏夹（Bookmark Bridge）";

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function extensionDirectory() {
  return path.join(__dirname, "extension");
}

function compactNode(node) {
  if (node.type === "url") {
    return { type: "url", name: String(node.name || ""), url: String(node.url || "") };
  }
  return {
    type: "folder",
    name: String(node.name || ""),
    children: (node.children || []).map(compactNode),
  };
}

function makeJob(desiredDocument, targetDocument, mode, requireSyncing) {
  return {
    version: 1,
    mode,
    requireSyncing,
    mobileFallbackTitle: MOBILE_FALLBACK_TITLE,
    roots: {
      bookmark_bar: compactNode(desiredDocument.roots.bookmark_bar),
      other: compactNode(desiredDocument.roots.other),
      synced: compactNode(desiredDocument.roots.synced),
    },
    targetRootIds: {
      bookmark_bar: String(targetDocument.roots.bookmark_bar.id),
      other: String(targetDocument.roots.other.id),
      synced: String(targetDocument.roots.synced.id),
    },
  };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, file);
}

async function createBookmarkApiSession(desiredDocument, targetDocument, options = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  const job = makeJob(desiredDocument, targetDocument, options.mode || "mirror", Boolean(options.requireSyncing));
  const jobsDir = path.join(localAppData(), "BookmarkBridge", "jobs");
  const jobFile = path.join(jobsDir, `${token}.job.json`);
  const resultFile = path.join(jobsDir, `${token}.result.json`);
  atomicWrite(jobFile, job);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/bookmark-bridge" || url.searchParams.get("token") !== token) {
      response.writeHead(404).end();
      return;
    }
    const body = `<!doctype html><meta charset="utf-8"><title>Bookmark Bridge</title>
<style>body{font:16px system-ui;margin:48px;max-width:680px}code{background:#eee;padding:2px 6px;border-radius:5px}</style>
<h1>Bookmark Bridge</h1><p>正在通过浏览器原生书签 API 同步，请保留此页面片刻。</p>
<p>命令完成后该标签页会自动关闭。</p>`;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    try { fs.unlinkSync(jobFile); } catch (_) {}
    throw error;
  }
  const address = server.address();
  const triggerUrl = `http://127.0.0.1:${address.port}/bookmark-bridge?token=${token}`;
  const timeoutMs = options.timeoutMs || 90000;

  let timer;
  let poller;
  const done = new Promise((resolve, reject) => {
    poller = setInterval(() => {
      if (!fs.existsSync(resultFile)) return;
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
        clearInterval(poller);
        clearTimeout(timer);
        if (result.ok) resolve(result);
        else reject(new Error(result.error || "浏览器书签 API 同步失败。"));
      } catch (error) {
        clearInterval(poller);
        clearTimeout(timer);
        reject(error);
      }
    }, 200);
    timer = setTimeout(() => {
      clearInterval(poller);
      reject(new Error(
        `Bookmark Bridge 浏览器扩展在 ${Math.round(timeoutMs / 1000)} 秒内没有响应。` +
        "请先运行 bookmark-bridge setup 完成一次性扩展安装。",
      ));
    }, timeoutMs);
  });

  async function close() {
    clearInterval(poller);
    clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
    for (const file of [jobFile, resultFile]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }

  return { done, triggerUrl, close, token };
}

module.exports = {
  EXTENSION_ID,
  MOBILE_FALLBACK_TITLE,
  compactNode,
  createBookmarkApiSession,
  extensionDirectory,
  makeJob,
};
