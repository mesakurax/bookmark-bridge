"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");

const TOKEN_PATTERN = /^[a-f0-9]{48}$/;

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function runsDirectory(override) {
  const dataDirectory = process.env.BOOKMARK_BRIDGE_DATA_DIR || path.join(localAppData(), "BookmarkBridge");
  return override || path.join(dataDirectory, "runs");
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM"]).has(error.code)) throw error;
    fs.rmSync(file, { force: true });
    fs.renameSync(temporary, file);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class UiJob {
  constructor(token, options = {}) {
    if (!TOKEN_PATTERN.test(token || "")) throw new Error("无效的扩展任务令牌。");
    this.token = token;
    this.directory = runsDirectory(options.directory);
    this.stateFile = path.join(this.directory, `${token}.state.json`);
    this.signalFile = path.join(this.directory, `${token}.signal.json`);
    this.activeFile = path.join(this.directory, "active.json");
  }

  read() {
    if (!fs.existsSync(this.stateFile)) return null;
    return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
  }

  update(patch) {
    const current = this.read() || {
      token: this.token,
      status: "starting",
      phase: "starting",
      output: [],
      createdAt: new Date().toISOString(),
    };
    const next = {
      ...current,
      ...patch,
      token: this.token,
      updatedAt: new Date().toISOString(),
    };
    if (Array.isArray(next.output) && next.output.length > 80) next.output = next.output.slice(-80);
    atomicJson(this.stateFile, next);
    return next;
  }

  start(command) {
    fs.mkdirSync(this.directory, { recursive: true });
    this.update({
      command,
      status: "running",
      phase: "starting",
      pid: process.pid,
      details: null,
      output: [],
    });
    atomicJson(this.activeFile, { token: this.token, command, pid: process.pid });
  }

  appendOutput(level, values) {
    const line = util.format(...values).replace(/[\r\n]+$/g, "");
    if (!line) return;
    const current = this.read() || {};
    const output = Array.isArray(current.output) ? [...current.output] : [];
    output.push(level === "error" ? `错误：${line.replace(/^错误：/, "")}` : line);
    this.update({ output });
  }

  captureConsole() {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...values) => this.appendOutput("info", values);
    console.error = (...values) => this.appendOutput("error", values);
    return () => {
      console.log = originalLog;
      console.error = originalError;
    };
  }

  setPhase(phase, details = null, status = "running") {
    return this.update({ phase, details, status });
  }

  async waitForSignal(phase, details = null) {
    this.setPhase(phase, details, "waiting");
    for (;;) {
      if (fs.existsSync(this.signalFile)) {
        let signal;
        try {
          signal = JSON.parse(fs.readFileSync(this.signalFile, "utf8"));
        } finally {
          fs.rmSync(this.signalFile, { force: true });
        }
        if (signal?.action === "cancel") {
          const error = new Error("任务已由用户取消。");
          error.cancelled = true;
          throw error;
        }
        if (signal?.action === "continue") {
          this.setPhase("resuming", null, "running");
          return signal;
        }
      }
      await delay(250);
    }
  }

  clearActive() {
    if (!fs.existsSync(this.activeFile)) return;
    try {
      const active = JSON.parse(fs.readFileSync(this.activeFile, "utf8"));
      if (active?.token === this.token) fs.rmSync(this.activeFile, { force: true });
    } catch (_) {
      // A later run owns a malformed or concurrently replaced active marker.
    }
  }

  complete() {
    this.update({ status: "completed", phase: "complete", details: null, exitCode: 0 });
    this.clearActive();
  }

  fail(error) {
    const cancelled = Boolean(error?.cancelled);
    this.update({
      status: cancelled ? "cancelled" : "failed",
      phase: cancelled ? "cancelled" : "failed",
      details: { message: error?.message || String(error) },
      exitCode: cancelled ? 130 : Number(error?.exitCode || 1),
    });
    this.clearActive();
  }
}

module.exports = {
  TOKEN_PATTERN,
  UiJob,
  atomicJson,
  runsDirectory,
};
