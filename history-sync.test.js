"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { executeHistorySync, planHistorySync } = require("./history-sync");

function createHistory(file, visits) {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    INSERT INTO meta VALUES('version', '70');
    INSERT INTO meta VALUES('last_compatible_version', '16');
    CREATE TABLE urls(
      id INTEGER PRIMARY KEY,
      url LONGVARCHAR,
      title LONGVARCHAR,
      visit_count INTEGER DEFAULT 0 NOT NULL,
      typed_count INTEGER DEFAULT 0 NOT NULL,
      last_visit_time INTEGER NOT NULL,
      hidden INTEGER DEFAULT 0 NOT NULL
    );
    CREATE UNIQUE INDEX urls_url_index ON urls(url);
    CREATE TABLE visits(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url INTEGER NOT NULL,
      visit_time INTEGER NOT NULL,
      from_visit INTEGER,
      external_referrer_url TEXT,
      transition INTEGER DEFAULT 0 NOT NULL,
      segment_id INTEGER,
      visit_duration INTEGER DEFAULT 0 NOT NULL,
      incremented_omnibox_typed_score BOOLEAN DEFAULT FALSE NOT NULL,
      opener_visit INTEGER,
      originator_cache_guid TEXT,
      originator_visit_id INTEGER,
      originator_from_visit INTEGER,
      originator_opener_visit INTEGER,
      is_known_to_sync BOOLEAN DEFAULT FALSE NOT NULL,
      consider_for_ntp_most_visited BOOLEAN DEFAULT FALSE NOT NULL,
      visited_link_id INTEGER DEFAULT 0 NOT NULL,
      app_id TEXT
    );
    CREATE INDEX visits_url_index ON visits(url);
    CREATE INDEX visits_time_index ON visits(visit_time);
  `);
  for (const visit of visits) addVisit(database, visit);
  database.close();
}

function addVisit(database, visit) {
  let urlRow = database.prepare("SELECT id, visit_count, typed_count, last_visit_time FROM urls WHERE url=?").get(visit.url);
  if (!urlRow) {
    database.prepare(
      "INSERT INTO urls(url,title,visit_count,typed_count,last_visit_time,hidden) VALUES(?,?,0,0,0,0)",
    ).run(visit.url, visit.title || visit.url);
    urlRow = database.prepare("SELECT id, visit_count, typed_count, last_visit_time FROM urls WHERE url=?").get(visit.url);
  }
  const transition = visit.transition ?? 0;
  database.prepare(`
    INSERT INTO visits(
      url,visit_time,from_visit,external_referrer_url,transition,segment_id,
      visit_duration,incremented_omnibox_typed_score,opener_visit,
      originator_cache_guid,originator_visit_id,originator_from_visit,
      originator_opener_visit,is_known_to_sync,consider_for_ntp_most_visited,
      visited_link_id,app_id
    ) VALUES(?,?,0,?,?,0,0,0,0,'',0,0,0,0,1,0,'')
  `).run(BigInt(urlRow.id), visit.time, visit.referrer || "", transition);
  database.prepare(
    "UPDATE urls SET visit_count=visit_count+1, typed_count=typed_count+?, last_visit_time=MAX(last_visit_time, ?) WHERE id=?",
  ).run((BigInt(transition) & 0xffn) === 1n ? 1 : 0, visit.time, BigInt(urlRow.id));
}

function readVisits(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  const statement = database.prepare(`
    SELECT u.url, v.visit_time, v.transition
    FROM visits v JOIN urls u ON u.id=v.url
    ORDER BY v.visit_time, u.url`);
  statement.setReadBigInts(true);
  const rows = statement.all();
  database.close();
  return rows.map((row) => ({
    url: row.url,
    time: row.visit_time.toString(),
    transition: row.transition.toString(),
  }));
}

function definitions(directory) {
  return {
    chrome: { historyFile: path.join(directory, "Chrome-History") },
    edge: { historyFile: path.join(directory, "Edge-History") },
  };
}

test("first sync creates a deduplicated union and later runs are idempotent", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bookmark-bridge-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const defs = definitions(directory);
  const base = 13_380_000_000_000_000n;
  createHistory(defs.chrome.historyFile, [
    { url: "https://a.test/", time: base + 1n },
    { url: "https://shared.test/", time: base + 2n, transition: 1 },
  ]);
  createHistory(defs.edge.historyFile, [
    { url: "https://shared.test/", time: base + 2n, transition: 1 },
    { url: "https://c.test/", time: base + 3n },
  ]);
  const ledgerFile = path.join(directory, "history-baseline.json");
  const backupDir = path.join(directory, "backups");

  const first = executeHistorySync(defs, { ledgerFile, backupDir });
  assert.equal(first.plan.firstRun, true);
  assert.equal(first.applied.chrome.inserted, 1);
  assert.equal(first.applied.edge.inserted, 1);
  assert.deepEqual(readVisits(defs.chrome.historyFile), readVisits(defs.edge.historyFile));
  assert.equal(readVisits(defs.chrome.historyFile).length, 3);

  const secondPlan = planHistorySync(defs, ledgerFile);
  assert.equal(secondPlan.firstRun, false);
  assert.equal(secondPlan.chromeRowsScanned, 0);
  assert.equal(secondPlan.edgeRowsScanned, 0);
  assert.equal(secondPlan.toChrome.length, 0);
  assert.equal(secondPlan.toEdge.length, 0);
});

test("incremental sync copies only new visits and does not propagate deletion", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bookmark-bridge-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const defs = definitions(directory);
  const base = 13_380_000_000_000_000n;
  createHistory(defs.chrome.historyFile, [
    { url: "https://old.test/", time: base + 1n },
  ]);
  createHistory(defs.edge.historyFile, [
    { url: "https://old.test/", time: base + 1n },
  ]);
  const ledgerFile = path.join(directory, "history-baseline.json");
  const backupDir = path.join(directory, "backups");
  executeHistorySync(defs, { ledgerFile, backupDir, timestamp: "first" });

  const chrome = new DatabaseSync(defs.chrome.historyFile);
  addVisit(chrome, { url: "https://chrome-new.test/", time: base + 10n });
  chrome.close();
  const edge = new DatabaseSync(defs.edge.historyFile);
  addVisit(edge, { url: "https://edge-new.test/", time: base + 11n });
  edge.close();

  const incremental = executeHistorySync(defs, { ledgerFile, backupDir, timestamp: "second" });
  assert.equal(incremental.plan.chromeRowsScanned, 1);
  assert.equal(incremental.plan.edgeRowsScanned, 1);
  assert.equal(incremental.applied.chrome.inserted, 1);
  assert.equal(incremental.applied.edge.inserted, 1);

  const edgeAfter = new DatabaseSync(defs.edge.historyFile);
  edgeAfter.exec("DELETE FROM visits WHERE id=(SELECT MIN(id) FROM visits)");
  edgeAfter.close();
  executeHistorySync(defs, { ledgerFile, backupDir, timestamp: "third" });
  assert.equal(readVisits(defs.edge.historyFile).length, 2);
  assert.equal(readVisits(defs.chrome.historyFile).length, 3);
});

test("same URL at different times remains two distinct visits", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bookmark-bridge-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const defs = definitions(directory);
  const base = 13_380_000_000_000_000n;
  createHistory(defs.chrome.historyFile, [
    { url: "https://repeat.test/", time: base + 1n },
  ]);
  createHistory(defs.edge.historyFile, [
    { url: "https://repeat.test/", time: base + 2n },
  ]);
  const result = executeHistorySync(defs, {
    ledgerFile: path.join(directory, "history-baseline.json"),
    backupDir: path.join(directory, "backups"),
  });
  assert.equal(result.applied.chrome.inserted, 1);
  assert.equal(result.applied.edge.inserted, 1);
  assert.equal(readVisits(defs.chrome.historyFile).length, 2);
  assert.deepEqual(readVisits(defs.chrome.historyFile), readVisits(defs.edge.historyFile));
});
