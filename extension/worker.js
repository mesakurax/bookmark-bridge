"use strict";

const HOST = "com.mesakurax.bookmark_bridge";
const running = new Set();

function normalize(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function flatten(nodes, output = []) {
  for (const node of nodes || []) {
    output.push(node);
    flatten(node.children, output);
  }
  return output;
}

function isFolder(node) {
  return !node.url;
}

function nativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || "本机通信失败。"));
      else resolve(response);
    });
  });
}

async function getChildren(parentId) {
  return await chrome.bookmarks.getChildren(String(parentId));
}

async function findManagedRoots(job) {
  const tree = await chrome.bookmarks.getTree();
  const all = flatten(tree);
  const typeByKey = {
    bookmark_bar: "bookmarks-bar",
    other: "other",
    synced: "mobile",
  };
  const result = {};

  for (const [key, folderType] of Object.entries(typeByKey)) {
    const candidates = all.filter((node) => node.folderType === folderType);
    const bySavedId = all.find((node) => String(node.id) === String(job.targetRootIds[key]));
    const syncing = candidates.find((node) => node.syncing === true);
    if (job.requireSyncing) {
      result[key] = syncing || (bySavedId && bySavedId.syncing !== false ? bySavedId : null);
      if (!result[key] && key !== "synced") {
        throw new Error("找不到账户同步根目录：" + key + "。请确认浏览器已登录并启用收藏夹同步。");
      }
    } else {
      result[key] = bySavedId || syncing || candidates[0] || null;
      if (!result[key]) throw new Error("找不到收藏夹根目录：" + key);
    }
  }
  // Chromium explicitly allows the special mobile root to be absent. Its
  // children still need a synced destination, so fall back to Other Bookmarks.
  // Unlike creating a regular folder, this keeps every imported node inside a
  // browser-owned account root without inventing an unsupported permanent root.
  if (!result.synced) result.synced = result.other;
  return result;
}

async function merge(job) {
  const roots = await findManagedRoots(job);
  const allowedIds = new Set();
  for (const root of Object.values(roots)) {
    const subtree = await chrome.bookmarks.getSubTree(root.id);
    for (const node of flatten(subtree)) allowedIds.add(String(node.id));
  }

  const used = new Set();
  const desired = new Set();
  const expected = [];
  const metrics = { added: 0, updated: 0, moved: 0, removed: 0 };

  async function updateNode(node, changes) {
    const actual = {};
    if (changes.title !== undefined && String(node.title || "") !== String(changes.title)) actual.title = changes.title;
    if (changes.url !== undefined && String(node.url || "") !== String(changes.url)) actual.url = changes.url;
    if (Object.keys(actual).length === 0) return node;
    metrics.updated += 1;
    return await chrome.bookmarks.update(node.id, actual);
  }

  async function place(sourceNode, parentId, index) {
    const children = await getChildren(parentId);
    let target = null;

    if (sourceNode.type === "folder") {
      const candidates = children.filter((node) =>
        isFolder(node) && !node.folderType && !used.has(String(node.id)) && normalize(node.title) === normalize(sourceNode.name));
      if (candidates.length === 1) target = candidates[0];
      if (!target) {
        target = await chrome.bookmarks.create({ parentId, index, title: sourceNode.name });
        allowedIds.add(String(target.id));
        metrics.added += 1;
      } else {
        target = await updateNode(target, { title: sourceNode.name });
      }
    } else {
      target = children.find((node) =>
        !isFolder(node) && !used.has(String(node.id)) && String(node.url || "") === sourceNode.url) || null;
      if (!target) {
        const globalMatches = await chrome.bookmarks.search({ url: sourceNode.url });
        target = globalMatches.find((node) =>
          !isFolder(node) && allowedIds.has(String(node.id)) && !used.has(String(node.id))) || null;
      }
      if (!target) {
        target = await chrome.bookmarks.create({ parentId, index, title: sourceNode.name, url: sourceNode.url });
        allowedIds.add(String(target.id));
        metrics.added += 1;
      } else {
        if (String(target.parentId) !== String(parentId)) {
          target = await chrome.bookmarks.move(target.id, { parentId, index });
          metrics.moved += 1;
        }
        target = await updateNode(target, { title: sourceNode.name, url: sourceNode.url });
      }
    }

    used.add(String(target.id));
    desired.add(String(target.id));
    expected.push({
      id: String(target.id),
      parentId: String(parentId),
      title: String(sourceNode.name || ""),
      url: sourceNode.type === "url" ? sourceNode.url : null,
    });
    if (sourceNode.type === "folder") {
      let childIndex = 0;
      for (const child of sourceNode.children || []) await place(child, String(target.id), childIndex++);
    }
  }

  const nextIndex = new Map();
  for (const key of ["bookmark_bar", "other", "synced"]) {
    const rootId = String(roots[key].id);
    let index = nextIndex.get(rootId) || 0;
    for (const child of job.roots[key].children || []) await place(child, rootId, index++);
    nextIndex.set(rootId, index);
  }

  if (job.mode === "mirror") {
    async function prune(parentId) {
      const children = await getChildren(parentId);
      for (const child of children) {
        if (desired.has(String(child.id))) {
          if (isFolder(child)) await prune(String(child.id));
        } else {
          if (isFolder(child)) await chrome.bookmarks.removeTree(child.id);
          else await chrome.bookmarks.remove(child.id);
          metrics.removed += 1;
        }
      }
    }
    for (const rootId of new Set(Object.values(roots).map((root) => String(root.id)))) await prune(rootId);
  }

  for (const item of expected) {
    const values = await chrome.bookmarks.get(item.id);
    const node = values[0];
    if (!node || String(node.parentId) !== item.parentId || String(node.title || "") !== item.title) {
      throw new Error("浏览器 API 写入后验证失败：" + item.title);
    }
    if (item.url !== null && String(node.url || "") !== item.url) {
      throw new Error("浏览器 API 写入后 URL 验证失败：" + item.title);
    }
  }
  return metrics;
}

async function runJob(token, tabId) {
  if (running.has(token)) return;
  running.add(token);
  try {
    const response = await nativeMessage({ action: "get", token });
    const metrics = await merge(response.job);
    await nativeMessage({ action: "complete", token, result: { ok: true, metrics } });
    if (tabId !== undefined) setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 500);
    return { ok: true, metrics };
  } catch (error) {
    const message = error?.message || String(error);
    try { await nativeMessage({ action: "complete", token, result: { ok: false, error: message } }); } catch (_) {}
    throw new Error(message);
  } finally {
    running.delete(token);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "bookmarkBridgeRun" || !/^[a-f0-9]{48}$/.test(message.token || "")) return false;
  runJob(message.token, sender.tab?.id)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
