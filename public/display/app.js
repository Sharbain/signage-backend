// public/display/app.js
(function () {
  const root = document.getElementById("root");

  const state = {
    screenId: "",
    stopped: false,
    refreshTimer: null,
    itemTimer: null,
    retryTimer: null,
    playlist: [],
    index: 0,
  };

  function setText(text) {
    if (!root) return;
    root.innerHTML = "";
    root.textContent = String(text);
  }

  function clearRoot() {
    if (!root) return;
    root.innerHTML = "";
  }

  function getScreenIdFromPath() {
    // supports /display/DEV-xxx or /display/DEV-xxx/
    const parts = (location.pathname || "").split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    return decodeURIComponent(last);
  }

  function getToken() {
    // 1) URL query is best: /display/DEV-123?token=xxxx
    const qs = new URLSearchParams(location.search || "");
    const qToken = qs.get("token");
    if (qToken && qToken.trim()) return qToken.trim();

    // 2) localStorage fallback (support multiple keys)
    const keys = ["screenToken", "deviceToken", "device_token", "accessToken"];
    for (const k of keys) {
      try {
        const v = localStorage.getItem(k);
        if (v && v.trim()) return v.trim();
      } catch (_) {
        // ignore
      }
    }

    return "";
  }

  async function fetchPlaylist() {
    const token = getToken();

    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    // Uses backend route:
    // GET /api/screens/:deviceId/playlist
    const url = `/api/screens/${encodeURIComponent(state.screenId)}/playlist`;

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
      const err = new Error(`playlist_http_${res.status}`);
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

    if (isVideo(item)) {
      const v = document.createElement("video");
      v.src = url;
      v.autoplay = true;
      v.loop = false;
      v.playsInline = true;
      v.preload = "auto";
      v.style.maxWidth = "100%";
      v.style.maxHeight = "100%";
      v.style.width = "100%";
      v.style.height = "100%";
      v.style.objectFit = "contain";

      // Volume handling (0-100)
      const vol = Number(item?.volume);
      if (!Number.isNaN(vol)) {
        const clamped = Math.max(0, Math.min(100, vol));
        v.muted = clamped === 0;
        v.volume = clamped / 100;
      } else {
        // safe default for signage: muted to prevent surprises
        v.muted = true;
      }

      // If video fails, show error but keep loop running
      v.onerror = () => {
        setText("Video failed to load");
      };

      root.appendChild(v);
      return;
    }

    const img = document.createElement("img");
    img.src = url;
    img.alt = name;
    img.style.maxWidth = "100%";
    img.style.maxHeight = "100%";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";

    img.onerror = () => {
      setText("Image failed to load");
    };

    root.appendChild(img);
  }

  function clearTimers() {
    if (state.itemTimer) {
      clearTimeout(state.itemTimer);
      state.itemTimer = null;
    }
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
  }

  function scheduleNextItem() {
    if (state.stopped) return;

    const playlist = state.playlist || [];
    if (!playlist.length) {
      setText("No content assigned");
      state.itemTimer = setTimeout(() => start(), 10000);
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
      setText("Missing screen id");
      return;
    }

    setText("Loading…");

    try {
      const data = await fetchPlaylist();
      const playlist = Array.isArray(data?.playlist) ? data.playlist : [];

      state.playlist = playlist;
      state.index = 0;

      // Start slideshow immediately
      scheduleNextItem();

      // Refresh playlist periodically (server suggests refreshInterval seconds)
      const refreshSec = Math.max(30, Number(data?.refreshInterval || 300));
      state.refreshTimer = setTimeout(() => {
        start().catch(() => {});
      }, refreshSec * 1000);
    } catch (e) {
      console.error("Playlist load failed:", e);

      // Better message for auth failures
      const status = e && typeof e === "object" ? e.status : null;
      if (status === 401) {
        setText("Unauthorized (401) — missing/invalid screen token");
      } else {
        setText("Failed to load playlist");
      }

      // Retry with backoff
      state.retryTimer = setTimeout(() => start().catch(() => {}), 5000);
    }
  }

  // Boot
  state.screenId = getScreenIdFromPath();
  start();

  // Optional: allow stopping if needed later
  window.__STOP_SIGNAGE__ = function () {
    state.stopped = true;
    clearTimers();
    setText("Stopped");
  };
})();
