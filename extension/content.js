"use strict";

const url = new URL(location.href);
const token = url.pathname === "/bookmark-bridge" ? url.searchParams.get("token") : null;

if (/^[a-f0-9]{48}$/.test(token || "")) {
  chrome.runtime.sendMessage({ type: "bookmarkBridgeRun", token }, (response) => {
    const message = chrome.runtime.lastError?.message || response?.error || "";
    document.documentElement.dataset.bookmarkBridge = message ? "error" : "complete";
    document.documentElement.dataset.bookmarkBridgeMessage = message;
  });
}
