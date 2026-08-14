"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const LEDGER_VERSION = 1;
const REQUIRED_URL_COLUMNS = new Set([
  "id", "url", "title", "visit_count", "typed_count", "last_visit_time", "hidden",
]);
const REQUIRED_VISIT_COLUMNS = new Set([
  "id", "url", "visit_time", "from_visit", "external_referrer_url", "transition",
  "segment_id", "visit_duration", "incremented_omnibox_typed_score", "opener_visit",
  "originator_cache_guid", "originator_visit_id", "originator_from_visit",
  "originator_opener_visit", "is_known_to_sync", "consider_for_ntp_most_visited",
  "visited_link_id", "app_id",
]);

let sqliteModule = null;

function sqlite() {
  if (!sqliteModule) sqliteModule = require("node:sqlite");
  return sqliteModule;
}

function prepareBig(database, sql) {
  const statement = database.prepare(sql);
  if (typeof statement.setReadBigInts === "function") statement.setReadBigInts(true);
  return statement;
}

function asBigInt(value) {
  if (typeof value === "bigint") return value;
  if (value === null || value === undefined || value === "") return 0n;
  return BigInt(value);
}

function normalizePath(file) {
  return path.resolve(file).toLocaleLowerCase();
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function requireColumns(actual, required, label) {
  const missing = [...required].filter((column) => !actual.has(column));
  if (missing.length) throw new Error(`${label} 缺少必要字段：${missing.join(", ")}`);
}

function historyVersion(database) {
  const row = database.prepare("SELECT value FROM meta WHERE key='version'").get();
  if (!row) throw new Error("History 数据库缺少版本信息。");
  return String(row.value);
}

function validateHistoryDatabase(database, label) {
  requireColumns(tableColumns(database, "urls"), REQUIRED_URL_COLUMNS, `${label}.urls`);
  requireColumns(tableColumns(database, "visits"), REQUIRED_VISIT_COLUMNS, `${label}.visits`);
  const quickCheck = database.prepare("PRAGMA quick_check").get();
  const result = quickCheck ? String(Object.values(quickCheck)[0]) : "";
  if (result.toLowerCase() !== "ok") throw new Error(`${label} 完整性检查失败：${result || "unknown"}`);
  return historyVersion(database);
}

function openDatabase(file, readOnly = false) {
  if (!fs.existsSync(file)) throw new Error(`找不到历史数据库：${file}`);
  const database = new (sqlite().DatabaseSync)(file, { readOnly });
  database.exec("PRAGMA busy_timeout=5000");
  return database;
}

const VISIT_SELECT = `
  SELECT
    v.id AS visit_id,
    u.url AS url,
    u.title AS title,
    u.hidden AS hidden,
    v.visit_time AS visit_time,
    v.transition AS transition,
    v.external_referrer_url AS external_referrer_url,
    v.visit_duration AS visit_duration,
    v.incremented_omnibox_typed_score AS incremented_omnibox_typed_score,
    v.originator_cache_guid AS originator_cache_guid,
    v.originator_visit_id AS originator_visit_id,
    v.consider_for_ntp_most_visited AS consider_for_ntp_most_visited,
    v.app_id AS app_id
  FROM visits v
  JOIN urls u ON u.id = v.url`;

function allVisits(database) {
  return prepareBig(database, `${VISIT_SELECT} ORDER BY v.id`).all();
}

function newVisits(database, afterId) {
  return prepareBig(database, `${VISIT_SELECT} WHERE v.id > ? ORDER BY v.id`).all(asBigInt(afterId));
}

function maxVisitId(database) {
  const row = prepareBig(database, "SELECT COALESCE(MAX(id), 0) AS id FROM visits").get();
  return asBigInt(row.id);
}

function eventToken(row) {
  // Titles and visit duration can legitimately change after a page has loaded,
  // so they are deliberately not part of an event's identity.
  const fields = [
    String(row.url || ""),
    asBigInt(row.visit_time).toString(),
    asBigInt(row.transition).toString(),
    String(row.external_referrer_url || ""),
    String(row.app_id || ""),
  ];
  return crypto.createHash("sha256").update(fields.join("\u0000"), "utf8").digest("base64url");
}

function bucketToken(row) {
  return `${String(row.url || "")}\u0000${asBigInt(row.visit_time).toString()}`;
}

function groupByEvent(rows) {
  const result = new Map();
  for (const row of rows) {
    const key = eventToken(row);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
}

function differences(sourceRows, targetRows, sourceBrowser, targetBrowser) {
  const sourceGroups = groupByEvent(sourceRows);
  const targetGroups = groupByEvent(targetRows);
  const additions = [];
  for (const [token, rows] of sourceGroups) {
    const targetCount = (targetGroups.get(token) || []).length;
    for (const row of rows.slice(targetCount)) {
      additions.push({ sourceBrowser, targetBrowser, row });
    }
  }
  return additions;
}

function initialPlan(chromeDatabase, edgeDatabase) {
  const chromeRows = allVisits(chromeDatabase);
  const edgeRows = allVisits(edgeDatabase);
  return {
    chromeRowsScanned: chromeRows.length,
    edgeRowsScanned: edgeRows.length,
    toChrome: differences(edgeRows, chromeRows, "edge", "chrome"),
    toEdge: differences(chromeRows, edgeRows, "chrome", "edge"),
  };
}

function readBuckets(database, bucketKeys) {
  const statement = prepareBig(database, `${VISIT_SELECT} WHERE u.url = ? AND v.visit_time = ? ORDER BY v.id`);
  const result = new Map();
  for (const key of bucketKeys) {
    const split = key.lastIndexOf("\u0000");
    const url = key.slice(0, split);
    const visitTime = BigInt(key.slice(split + 1));
    result.set(key, statement.all(url, visitTime));
  }
  return result;
}

function incrementalPlan(chromeDatabase, edgeDatabase, ledger) {
  const chromeAfter = BigInt(ledger.profiles.chrome.maxVisitId);
  const edgeAfter = BigInt(ledger.profiles.edge.maxVisitId);
  const chromeCurrentMax = maxVisitId(chromeDatabase);
  const edgeCurrentMax = maxVisitId(edgeDatabase);
  if (chromeCurrentMax < chromeAfter || edgeCurrentMax < edgeAfter) {
    throw new Error(
      "历史数据库的访问 ID 小于已保存基线，可能发生过数据库重建。" +
      "请先备份，再使用 --reset-history-baseline 重新建立基线。",
    );
  }

  const chromeNew = newVisits(chromeDatabase, chromeAfter);
  const edgeNew = newVisits(edgeDatabase, edgeAfter);
  const bucketKeys = new Set([...chromeNew, ...edgeNew].map(bucketToken));
  const chromeBuckets = readBuckets(chromeDatabase, bucketKeys);
  const edgeBuckets = readBuckets(edgeDatabase, bucketKeys);
  const toChrome = [];
  const toEdge = [];
  for (const key of bucketKeys) {
    const chromeRows = chromeBuckets.get(key) || [];
    const edgeRows = edgeBuckets.get(key) || [];
    toChrome.push(...differences(edgeRows, chromeRows, "edge", "chrome"));
    toEdge.push(...differences(chromeRows, edgeRows, "chrome", "edge"));
  }
  return {
    chromeRowsScanned: chromeNew.length,
    edgeRowsScanned: edgeNew.length,
    toChrome,
    toEdge,
  };
}

function readLedger(file) {
  if (!fs.existsSync(file)) return null;
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取历史基线 ${file}：${error.message}`);
  }
  if (!ledger || ledger.version !== LEDGER_VERSION || !ledger.profiles?.chrome || !ledger.profiles?.edge) {
    throw new Error(`历史基线格式不受支持：${file}`);
  }
  return ledger;
}

function validateLedger(ledger, definitions, versions) {
  for (const browser of ["chrome", "edge"]) {
    const saved = ledger.profiles[browser];
    if (normalizePath(saved.file) !== normalizePath(definitions[browser].historyFile)) {
      throw new Error(`${browser} 历史文件与已保存基线不一致，请使用 --reset-history-baseline。`);
    }
    if (String(saved.historyVersion) !== String(versions[browser])) {
      throw new Error(`${browser} 历史数据库版本发生变化，请使用 --reset-history-baseline 重新验证。`);
    }
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    throw error;
  }
}

function copyBackup(file, browser, backupDir, timestamp) {
  fs.mkdirSync(backupDir, { recursive: true });
  const destination = path.join(backupDir, `${browser}-History-${timestamp}.sqlite`);
  fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
  return destination;
}

function insertVisits(database, additions) {
  if (!additions.length) return { inserted: 0, affectedUrls: 0 };
  const findUrl = prepareBig(database, "SELECT id, title, visit_count, typed_count, last_visit_time, hidden FROM urls WHERE url=? ORDER BY id LIMIT 1");
  const addUrl = database.prepare(
    "INSERT INTO urls(url,title,visit_count,typed_count,last_visit_time,hidden) VALUES(?,?,0,0,0,?)",
  );
  const lastId = prepareBig(database, "SELECT last_insert_rowid() AS id");
  const addVisit = database.prepare(`
    INSERT INTO visits(
      url, visit_time, from_visit, external_referrer_url, transition, segment_id,
      visit_duration, incremented_omnibox_typed_score, opener_visit,
      originator_cache_guid, originator_visit_id, originator_from_visit,
      originator_opener_visit, is_known_to_sync, consider_for_ntp_most_visited,
      visited_link_id, app_id
    ) VALUES(?, ?, 0, ?, ?, 0, ?, ?, 0, ?, ?, 0, 0, 0, ?, 0, ?)`);
  const updateUrl = database.prepare(
    "UPDATE urls SET title=?, visit_count=?, typed_count=?, last_visit_time=? WHERE id=?",
  );

  const byUrl = new Map();
  for (const addition of additions) {
    const url = String(addition.row.url || "");
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(addition.row);
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    let inserted = 0;
    for (const [url, rows] of byUrl) {
      let targetUrl = findUrl.get(url);
      if (!targetUrl) {
        const newest = rows.reduce((best, row) =>
          !best || asBigInt(row.visit_time) > asBigInt(best.visit_time) ? row : best, null);
        addUrl.run(url, String(newest.title || ""), Number(asBigInt(newest.hidden)));
        targetUrl = {
          id: asBigInt(lastId.get().id),
          title: String(newest.title || ""),
          visit_count: 0n,
          typed_count: 0n,
          last_visit_time: 0n,
          hidden: asBigInt(newest.hidden),
        };
      }

      let title = String(targetUrl.title || "");
      let lastVisit = asBigInt(targetUrl.last_visit_time);
      let visitCount = asBigInt(targetUrl.visit_count);
      let typedCount = asBigInt(targetUrl.typed_count);
      for (const row of rows) {
        const visitTime = asBigInt(row.visit_time);
        const transition = asBigInt(row.transition);
        addVisit.run(
          asBigInt(targetUrl.id),
          visitTime,
          String(row.external_referrer_url || ""),
          transition,
          asBigInt(row.visit_duration),
          Number(asBigInt(row.incremented_omnibox_typed_score)),
          String(row.originator_cache_guid || ""),
          asBigInt(row.originator_visit_id),
          Number(asBigInt(row.consider_for_ntp_most_visited)),
          String(row.app_id || ""),
        );
        inserted += 1;
        visitCount += 1n;
        if ((transition & 0xffn) === 1n) typedCount += 1n;
        if (visitTime > lastVisit) {
          lastVisit = visitTime;
          if (row.title) title = String(row.title);
        }
      }
      updateUrl.run(title, visitCount, typedCount, lastVisit, asBigInt(targetUrl.id));
    }
    database.exec("COMMIT");
    return { inserted, affectedUrls: byUrl.size };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch (_) { /* Preserve original error. */ }
    throw error;
  }
}

function makeLedger(definitions, versions, chromeDatabase, edgeDatabase) {
  return {
    version: LEDGER_VERSION,
    updatedAt: new Date().toISOString(),
    profiles: {
      chrome: {
        file: path.resolve(definitions.chrome.historyFile),
        historyVersion: versions.chrome,
        maxVisitId: maxVisitId(chromeDatabase).toString(),
      },
      edge: {
        file: path.resolve(definitions.edge.historyFile),
        historyVersion: versions.edge,
        maxVisitId: maxVisitId(edgeDatabase).toString(),
      },
    },
  };
}

function planHistorySync(definitions, ledgerFile, resetBaseline = false) {
  const chromeDatabase = openDatabase(definitions.chrome.historyFile, true);
  const edgeDatabase = openDatabase(definitions.edge.historyFile, true);
  try {
    const versions = {
      chrome: validateHistoryDatabase(chromeDatabase, "Chrome History"),
      edge: validateHistoryDatabase(edgeDatabase, "Edge History"),
    };
    if (versions.chrome !== versions.edge) {
      throw new Error(`Chrome/Edge 历史数据库版本不同（${versions.chrome}/${versions.edge}），为避免损坏已停止。`);
    }
    const ledger = resetBaseline ? null : readLedger(ledgerFile);
    if (ledger) validateLedger(ledger, definitions, versions);
    const plan = ledger
      ? incrementalPlan(chromeDatabase, edgeDatabase, ledger)
      : initialPlan(chromeDatabase, edgeDatabase);
    return {
      ...plan,
      firstRun: !ledger,
      versions,
      currentMax: {
        chrome: maxVisitId(chromeDatabase).toString(),
        edge: maxVisitId(edgeDatabase).toString(),
      },
    };
  } finally {
    chromeDatabase.close();
    edgeDatabase.close();
  }
}

function executeHistorySync(definitions, options) {
  const ledgerFile = options.ledgerFile;
  const plan = planHistorySync(definitions, ledgerFile, options.resetBaseline);
  if (options.dryRun) return { plan, backups: null, applied: null };

  const stamp = options.timestamp || new Date().toISOString().replace(/[:.]/g, "-");
  const backups = {
    chrome: copyBackup(definitions.chrome.historyFile, "chrome", options.backupDir, stamp),
    edge: copyBackup(definitions.edge.historyFile, "edge", options.backupDir, stamp),
  };

  let chromeDatabase;
  let edgeDatabase;
  try {
    chromeDatabase = openDatabase(definitions.chrome.historyFile, false);
    edgeDatabase = openDatabase(definitions.edge.historyFile, false);
    validateHistoryDatabase(chromeDatabase, "Chrome History");
    validateHistoryDatabase(edgeDatabase, "Edge History");
    const applied = {
      chrome: insertVisits(chromeDatabase, plan.toChrome),
      edge: insertVisits(edgeDatabase, plan.toEdge),
    };
    validateHistoryDatabase(chromeDatabase, "Chrome History (after)");
    validateHistoryDatabase(edgeDatabase, "Edge History (after)");
    const ledger = makeLedger(definitions, plan.versions, chromeDatabase, edgeDatabase);
    atomicWriteJson(ledgerFile, ledger);
    return { plan, backups, applied, ledger };
  } catch (error) {
    if (chromeDatabase) chromeDatabase.close();
    if (edgeDatabase) edgeDatabase.close();
    chromeDatabase = null;
    edgeDatabase = null;
    try {
      fs.copyFileSync(backups.chrome, definitions.chrome.historyFile);
      fs.copyFileSync(backups.edge, definitions.edge.historyFile);
    } catch (restoreError) {
      throw new Error(`${error.message}\n自动恢复历史备份失败：${restoreError.message}\n备份：${backups.chrome} | ${backups.edge}`);
    }
    throw new Error(`${error.message}\n已从备份恢复两个历史数据库。`);
  } finally {
    if (chromeDatabase) chromeDatabase.close();
    if (edgeDatabase) edgeDatabase.close();
  }
}

module.exports = {
  LEDGER_VERSION,
  eventToken,
  executeHistorySync,
  planHistorySync,
  readLedger,
  validateHistoryDatabase,
};
