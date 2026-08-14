"use strict";

const HOST = "com.mesakurax.bookmark_bridge";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const LABELS = {
  "bookmarks-to-chrome": "收藏夹 · Edge → Chrome",
  "bookmarks-to-edge": "收藏夹 · Chrome → Edge",
  "passwords-to-chrome": "密码 · Edge → Chrome",
  "passwords-to-edge": "密码 · Chrome → Edge",
  history: "浏览记录 · 双向合并",
  "all-to-chrome": "全部数据 · 同步到 Chrome",
  "all-to-edge": "全部数据 · 同步到 Edge",
};

const pill = document.querySelector("#status-pill");
const taskCard = document.querySelector("#task-card");
const taskTitle = document.querySelector("#task-title");
const taskMessage = document.querySelector("#task-message");
const taskLog = document.querySelector("#task-log");
const spinner = document.querySelector("#spinner");
const actions = document.querySelector("#task-actions");
const continueButton = document.querySelector("#continue-button");
const cancelButton = document.querySelector("#cancel-button");
const pathBox = document.querySelector("#path-box");
const pathInput = document.querySelector("#path-input");
const commandButtons = [...document.querySelectorAll("[data-command]")];

let activeToken = null;
let activeState = null;
let pollTimer = null;

function nativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || "本地同步组件没有响应。"));
      else resolve(response);
    });
  });
}

function token() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function setButtonsDisabled(disabled) {
  for (const button of commandButtons) button.disabled = disabled;
}

function phaseMessage(state) {
  if (state.status === "completed") return "任务已完成，数据仍保留在本地。";
  if (state.status === "failed") return state.details?.message || "任务执行失败。";
  if (state.status === "cancelled") return "任务已取消。";
  if (state.phase === "password-export") return state.details?.message || "导出密码后继续。";
  if (state.phase === "password-path") return state.details?.message || "输入密码 CSV 路径。";
  if (state.phase === "password-import") {
    return `${state.details?.message || "导入密码后继续。"}\n临时文件：${state.details?.stagingFile || ""}`;
  }
  return "后台正在处理；即使浏览器重启，任务也会继续。";
}

function render(state) {
  activeState = state;
  if (!state) {
    pill.className = "pill idle";
    pill.textContent = "就绪";
    taskCard.classList.add("hidden");
    setButtonsDisabled(false);
    return;
  }
  taskCard.classList.remove("hidden");
  taskTitle.textContent = LABELS[state.command] || "Bookmark Bridge";
  taskMessage.textContent = phaseMessage(state);
  taskLog.textContent = Array.isArray(state.output) && state.output.length ? state.output.join("\n") : "尚无输出";
  pill.className = `pill ${state.status}`;
  const statusText = { starting: "准备中", running: "运行中", waiting: "等待操作", completed: "已完成", failed: "失败", cancelled: "已取消" };
  pill.textContent = statusText[state.status] || state.status;
  const waiting = state.status === "waiting";
  actions.classList.toggle("hidden", !waiting);
  pathBox.classList.toggle("hidden", state.phase !== "password-path");
  continueButton.textContent = state.phase === "password-export" ? "我已导出" : state.phase === "password-import" ? "我已导入" : "继续";
  spinner.classList.toggle("hidden", TERMINAL.has(state.status) || waiting);
  setButtonsDisabled(!TERMINAL.has(state.status));
}

async function poll() {
  if (!activeToken) return;
  try {
    const response = await nativeMessage({ action: "status", token: activeToken });
    render(response.state);
    if (response.state && TERMINAL.has(response.state.status)) {
      await chrome.storage.local.remove("activeToken");
      clearInterval(pollTimer);
      pollTimer = null;
      setButtonsDisabled(false);
    }
  } catch (error) {
    render({ command: activeState?.command, status: "failed", details: { message: error.message }, output: [] });
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, 900);
  poll();
}

for (const button of commandButtons) {
  button.addEventListener("click", async () => {
    const command = button.dataset.command;
    activeToken = token();
    render({ command, status: "starting", phase: "starting", output: [] });
    try {
      await chrome.storage.local.set({ activeToken });
      await nativeMessage({ action: "run", token: activeToken, command });
      startPolling();
    } catch (error) {
      await chrome.storage.local.remove("activeToken");
      render({ command, status: "failed", details: { message: error.message }, output: [] });
      setButtonsDisabled(false);
    }
  });
}

continueButton.addEventListener("click", async () => {
  if (!activeToken || !activeState) return;
  const value = activeState.phase === "password-path" ? pathInput.value.trim() : undefined;
  if (activeState.phase === "password-path" && !value) {
    pathInput.focus();
    return;
  }
  continueButton.disabled = true;
  try {
    await nativeMessage({ action: "continue", token: activeToken, value });
    await poll();
  } finally {
    continueButton.disabled = false;
  }
});

cancelButton.addEventListener("click", async () => {
  if (!activeToken) return;
  cancelButton.disabled = true;
  try {
    await nativeMessage({ action: "cancel", token: activeToken });
    await poll();
  } finally {
    cancelButton.disabled = false;
  }
});

(async () => {
  try {
    const saved = await chrome.storage.local.get("activeToken");
    activeToken = saved.activeToken || null;
    if (!activeToken) {
      const response = await nativeMessage({ action: "active" });
      activeToken = response.state?.token || null;
      if (activeToken) await chrome.storage.local.set({ activeToken });
    }
    if (activeToken) startPolling();
    else render(null);
  } catch (error) {
    render({ status: "failed", details: { message: `无法连接本地组件：${error.message}` }, output: [] });
    setButtonsDisabled(false);
  }
})();
