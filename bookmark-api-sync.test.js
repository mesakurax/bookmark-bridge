"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { EXTENSION_ID, makeJob } = require("./bookmark-api-sync");

function folder(id, name, children = []) {
  return { id, name, type: "folder", children };
}

function documents() {
  return {
    source: {
      roots: {
        bookmark_bar: folder("1", "收藏夹栏", [
          folder("10", "杂项", [
            { id: "11", name: "Synthetic", type: "url", url: "https://bookmark-bridge.invalid/synthetic" },
          ]),
        ]),
        other: folder("2", "其他收藏夹"),
        synced: folder("3", "移动收藏夹"),
      },
    },
    target: {
      roots: {
        bookmark_bar: folder("502", "书签栏"),
        other: folder("503", "其他书签"),
        synced: folder("504", "移动设备书签"),
      },
    },
  };
}

function mockChrome(job, options = {}) {
  let nextId = 1000;
  let listener;
  let completion;
  const nodes = new Map();

  function add(node, parent = null) {
    const stored = { ...node, children: node.children || [] };
    if (parent) stored.parentId = String(parent.id);
    nodes.set(String(stored.id), stored);
    for (const child of stored.children) add(child, stored);
    return stored;
  }

  const permanentRoots = [
    { id: "502", title: "书签栏", folderType: "bookmarks-bar", syncing: true, children: [] },
    { id: "503", title: "其他书签", folderType: "other", syncing: true, children: [] },
  ];
  if (!options.omitMobileRoot) {
    permanentRoots.push({ id: "504", title: "移动设备书签", folderType: "mobile", syncing: true, children: [] });
  }
  const root = add({ id: "0", title: "", children: permanentRoots });

  function cloneNode(node) {
    return {
      ...node,
      children: (node.children || []).map((child) => cloneNode(nodes.get(String(child.id)) || child)),
    };
  }

  function detach(node) {
    if (!node.parentId) return;
    const parent = nodes.get(String(node.parentId));
    parent.children = parent.children.filter((child) => String(child.id) !== String(node.id));
  }

  function insert(parent, node, index) {
    node.parentId = String(parent.id);
    const at = Number.isInteger(index) ? Math.min(index, parent.children.length) : parent.children.length;
    parent.children.splice(at, 0, node);
  }

  function removeRecursive(id) {
    const node = nodes.get(String(id));
    if (!node) return;
    for (const child of [...(node.children || [])]) removeRecursive(child.id);
    detach(node);
    nodes.delete(String(id));
  }

  const chrome = {
    bookmarks: {
      async getTree() { return [cloneNode(root)]; },
      async getSubTree(id) { return [cloneNode(nodes.get(String(id)))]; },
      async getChildren(id) {
        return (nodes.get(String(id)).children || []).map((child) => ({ ...nodes.get(String(child.id)) }));
      },
      async create(details) {
        const parent = nodes.get(String(details.parentId));
        const node = {
          id: String(nextId++),
          title: String(details.title || ""),
          url: details.url,
          syncing: parent.syncing,
          children: [],
        };
        nodes.set(node.id, node);
        insert(parent, node, details.index);
        return { ...node };
      },
      async search(query) {
        return [...nodes.values()].filter((node) => node.url === query.url).map((node) => ({ ...node }));
      },
      async move(id, details) {
        const node = nodes.get(String(id));
        detach(node);
        insert(nodes.get(String(details.parentId)), node, details.index);
        return { ...node };
      },
      async update(id, details) {
        const node = nodes.get(String(id));
        Object.assign(node, details);
        return { ...node };
      },
      async get(id) {
        const node = nodes.get(String(id));
        return node ? [{ ...node }] : [];
      },
      async remove(id) { removeRecursive(id); },
      async removeTree(id) { removeRecursive(id); },
    },
    runtime: {
      lastError: null,
      onMessage: { addListener(value) { listener = value; } },
      sendNativeMessage(_host, message, callback) {
        queueMicrotask(() => {
          if (message.action === "get") callback({ ok: true, job });
          else {
            completion = message.result;
            callback({ ok: true });
          }
        });
      },
    },
    tabs: { async remove() {} },
  };

  return {
    chrome,
    nodes,
    async run(token) {
      return await new Promise((resolve) => {
        listener({ type: "bookmarkBridgeRun", token }, { tab: { id: 9 } }, resolve);
      });
    },
    completion() { return completion; },
  };
}

test("固定扩展 ID 与清单 key 对应", () => {
  assert.equal(EXTENSION_ID, "faaofhehocblpehenggfdmpbpjnifpim");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "extension", "manifest.json"), "utf8"));
  assert.equal(manifest.name, "Bookmark Bridge");
  assert.ok(manifest.permissions.includes("bookmarks"));
  assert.ok(manifest.permissions.includes("nativeMessaging"));
});

test("扩展通过同步根目录写入杂项，并保持幂等", async () => {
  const { source, target } = documents();
  const job = makeJob(source, target, "merge", true);
  const mock = mockChrome(job);
  const worker = fs.readFileSync(path.join(__dirname, "extension", "worker.js"), "utf8");
  vm.runInNewContext(worker, {
    chrome: mock.chrome,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  });

  const token = "a".repeat(48);
  const first = await mock.run(token);
  assert.equal(first.ok, true);
  assert.equal(first.metrics.added, 2);
  const second = await mock.run("b".repeat(48));
  assert.equal(second.ok, true);
  assert.equal(second.metrics.added, 0);

  const bar = mock.nodes.get("502");
  const misc = bar.children.filter((node) => node.title === "杂项");
  assert.equal(misc.length, 1);
  const urls = misc[0].children.filter((node) => node.url === "https://bookmark-bridge.invalid/synthetic");
  assert.equal(urls.length, 1);
  assert.equal(mock.completion().ok, true);
});

test("缺少移动根目录时将其内容写入同步的其他书签", async () => {
  const { source, target } = documents();
  source.roots.synced.children.push({
    id: "12",
    name: "Mobile synthetic",
    type: "url",
    url: "https://bookmark-bridge.invalid/mobile",
  });
  const job = makeJob(source, target, "merge", true);
  const mock = mockChrome(job, { omitMobileRoot: true });
  const worker = fs.readFileSync(path.join(__dirname, "extension", "worker.js"), "utf8");
  vm.runInNewContext(worker, {
    chrome: mock.chrome,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  });

  const first = await mock.run("c".repeat(48));
  assert.equal(first.ok, true);
  assert.equal(first.metrics.added, 3);
  const other = mock.nodes.get("503");
  assert.equal(other.children.filter((node) => node.url === "https://bookmark-bridge.invalid/mobile").length, 1);

  const second = await mock.run("d".repeat(48));
  assert.equal(second.ok, true);
  assert.equal(second.metrics.added, 0);
});
