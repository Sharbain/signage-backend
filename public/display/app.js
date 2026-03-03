// public/display/app.js
(function () {
  const root = document.getElementById("root");

  // Hard safety: never white screen
  try {
    document.documentElement.style.background = "#000";
    document.body.style.background = "#000";
    document.body.style.margin = "0";
  } catch (_) {}

  const state = {
    screenId: "",
    stopped: false,
    refreshTimer: null,
    itemTimer: null,
    retryTimer: null,
    playlist: [],
    index: 0,
    lastError: "",
  };

  function qs() {
    try {
      return new URLSearchParams(location.search || "");
    } catch (_) {
      return { get: () => null, has: () => false };
    }
  }

  const DEBUG = qs().get("debug") === "1";

  function setText(text) {
    if (!root) return;
    root.innerHTML = "";
    root.style.height = "100%";
    root.style.display = "flex";
    root.style.alignItems = "center";
    root.style.justifyContent = "center";
    root.style.color = "#fff";
    root.style.fontFamily = "system-ui, Segoe UI, Roboto, Arial";
    root.style.padding = "24px";
    root.style.textAlign = "center";
    root.textContent = String(text);
  }

  function setError(text) {
    state.lastError = String(text || "");
    setText(state.lastError);
    if (DEBUG) renderDebugOverlay();
  }

  function clearRoot() {
    if (!root) return;
    root.innerHTML = "";
    root.style.background = "#000";
  }

  function getScreenIdFromPath() {
    // supports /display/DEV-xxx or /display/DEV-xxx/
    const parts = (location.pathname || "").split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    return decodeURIComponent(last);
  }

  function getToken() {
    // 1) URL query is best: /display/DEV-123?token=xxxx
    const qToken = qs().get("token");
    if (qToken && qToken.trim()) return qToken.trim();

    // 2) localStorage fallback (support multiple keys)
    const keys = ["screenToken", "deviceToken", "device_token", "accessToken"];
    for (const k of keys) {
      try {
        const v = localStorage.getItem(k);
        if (v && v.trim()) return v.trim();
      } catch (_) {}
    }

    return "";
  }

  function renderDebugOverlay() {
    if (!root) return;

    let box = document.getElementById("__debug_overlay__");
    if (!box) {
      box = document.createElement("div");
      box.id = "__debug_overlay__";
      box.style.position = "fixed";
      box.style.left = "8px";
      box.style.bottom = "8px";
      box.style.right = "8px";
      box.style.maxHeight = "45vh";
      box.style.overflow = "auto";
      box.style.background = "rgba(0,0,0,0.75)";
      box.style.color = "#fff";
      box.style.fontFamily = "monospace";
      box.style.fontSize = "12px";
      box.style.padding = "10px";
      box.style.borderRadius = "10px";
      box.style.zIndex = "999999";
      document.body.appendChild(box);
    }

    const token = getToken();
    const safeToken =
      token && token.length > 10 ? token.slice(0, 6) + "…" + token.slice(-4) : token;

    box.textContent =
      [
        `DEBUG=1`,
        `screenId=${state.screenId || "(missing)"}`,
        `token=${safeToken || "(missing)"}`,
        `playlistLen=${Array.isArray(state.playlist) ? state.playlist.length : 0}`,
        `index=${state.index}`,
        state.lastError ? `lastError=${state.lastError}` : "",
        `url=${location.href}`,
      ]
        .filter(Boolean)
        .join("\n");
  }

  async function fetchPlaylist() {
    const token = getToken();

    // Always include token as query param too (best WebView compatibility)
    const url =
      `/api/screens/${encodeURIComponent(state.screenId)}/playlist` +
      (token ? `?token=${encodeURIComponent(token)}` : "");

    const headers = {};
    if (token) {
      // also try headers
      headers["Authorization"] = `Device ${token}`;
      headers["X-Device-Token"] = token;
    }

    const res = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
    });

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch (_) {}
      const snippet = body ? body.slice(0, 300) : "";
      const msg = `playlist_http_${res.status} url=${url}\n${snippet}`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      throw err;
    }

    return res.json();
  }

  function isVideo(item) {
    const t = String(item?.type || "").toLowerCase();
    const u = String(item?.url || "");
    return t.includes("video") || /\.(mp4|webm|mov|m4v|mkv)$/i.test(u);
  }

  function showItem(item) {
    clearRoot();
    if (!root) return;

    const url = String(item?.url || "");
    const name = String(item?.name || "media");

    if (!url) {
      setError("Item missing url");
      return;
    }

    if (isVideo(item)) {
      const v = document.createElement("video");
      v.src = url;
      v.autoplay = true;
      v.loop = false;
      v.playsInline = true;
      v.preload = "auto";
      v.style.width = "100%";
      v.style.height = "100%";
      v.style.objectFit = "contain";

      const vol = Number(item?.volume);
      if (!Number.isNaN(vol)) {
        const clamped = Math.max(0, Math.min(100, vol));
        v.muted = clamped === 0;
        v.volume = clamped / 100;
      } else {
        v.muted = true;
      }

      v.onerror = () => setError(`Video failed to load\n${url}`);
      root.appendChild(v);
      return;
    }

    const img = document.createElement("img");
    img.src = url;
    img.alt = name;
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.onerror = () => setError(`Image failed to load\n${url}`);
    root.appendChild(img);
  }

  function clearTimers() {
    if (state.itemTimer) clearTimeout(state.itemTimer);
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.itemTimer = null;
    state.refreshTimer = null;
    state.retryTimer = null;
  }

  function scheduleNextItem() {
    if (state.stopped) return;

    const playlist = state.playlist || [];
    if (!playlist.length) {
      setText("No content assigned");
      state.itemTimer = setTimeout(() => start().catch(() => {}), 8000);
      return;
    }

    const item = playlist[state.index % playlist.length];
    state.index = (state.index + 1) % playlist.length;

    showItem(item);

    const seconds = Math.max(3, Number(item?.duration || 10));
    state.itemTimer = setTimeout(scheduleNextItem, seconds * 1000);
  }

  async function start() {
    if (state.stopped) return;

    clearTimers();

    if (!state.screenId) {
      setError("Missing screen id");
      return;
    }

    setText("Loading…");
    if (DEBUG) renderDebugOverlay();

    try {
      const data = await fetchPlaylist();
      const playlist = Array.isArray(data?.playlist) ? data.playlist : [];

      state.playlist = playlist;
      state.index = 0;
      state.lastError = "";

      scheduleNextItem();

      const refreshSec = Math.max(30, Number(data?.refreshInterval || 300));
      state.refreshTimer = setTimeout(() => {
        start().catch(() => {});
      }, refreshSec * 1000);
    } catch (e) {
      console.error("Playlist load failed:", e);
      const msg = e?.message ? String(e.message) : "Failed to load playlist";
      setError(msg);
      state.retryTimer = setTimeout(() => start().catch(() => {}), 5000);
    }
  }

  // Boot
  state.screenId = getScreenIdFromPath();
  start();

  window.__STOP_SIGNAGE__ = function () {
    state.stopped = true;
    clearTimers();
    setText("Stopped");
  };
})();
