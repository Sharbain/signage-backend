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
    showingFallback: false,
  };

  // Where the logo lives (served by backend static /display)
  const FALLBACK_URL = "/display/fallback-logo.svg";

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

  function isProbablyAssetId(id) {
    // If someone accidentally navigates to /display/fallback-logo.svg
    // do not treat this as a screenId and do not fetch playlist.
    return /\.(svg|png|jpg|jpeg|webp|gif)$/i.test(String(id || ""));
  }

  function getToken() {
    // 1) URL query is best:
    // /display/DEV-123?token=xxxx OR /display/DEV-123?t=xxxx
    const qs = new URLSearchParams(location.search || "");
    const qToken = qs.get("token") || qs.get("t");
    if (qToken && qToken.trim()) return qToken.trim();

    // 2) localStorage fallback (support multiple keys)
    // NOTE: accessToken is a CMS/admin token; usually NOT needed for player.
    const keys = ["screenToken", "deviceToken", "device_token"];
    for (const k of keys) {
      try {
        const v = localStorage.getItem(k);
        if (v && v.trim()) return v.trim();
      } catch (_) {}
    }

    return "";
  }

  function showFallbackLogo(reason) {
    clearRoot();
    state.showingFallback = true;

    if (!root) return;

    const img = document.createElement("img");
    img.src = FALLBACK_URL;
    img.alt = "Fallback";
    img.style.maxWidth = "100%";
    img.style.maxHeight = "100%";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";

    img.onerror = () => {
      // If logo missing, show readable message
      setText("Waiting for content…");
    };

    root.appendChild(img);

    // Optional tiny debug hint in console only
    if (reason) console.warn("[PLAYER] Fallback mode:", reason);
  }

  async function fetchPlaylist() {
    const token = getToken();

    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    // Uses backend route:
    // GET /api/screens/:screenId/playlist
    const url = `/api/screens/${encodeURIComponent(state.screenId)}/playlist`;

    const res = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
    });

    // Treat "no playlist yet" as non-fatal if backend returns 404 or 204 or empty
    if (res.status === 204) return { playlist: [], refreshInterval: 15 };

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

    // Sometimes backend accidentally returns text. Guard parse.
    const json = await res.json().catch(() => null);
    return json || { playlist: [], refreshInterval: 15 };
  }

  function isVideo(item) {
    const t = String(item?.type || "").toLowerCase();
    const u = String(item?.url || "");
    return t.includes("video") || /\.(mp4|webm|mov|m4v|mkv)$/i.test(u);
  }

  function showItem(item) {
    clearRoot();
    state.showingFallback = false;

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

      v.onerror = () => {
        showFallbackLogo("video_failed");
      };

      // If video ends early, move on immediately
      v.onended = () => {
        scheduleNextItem(true);
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
      showFallbackLogo("image_failed");
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

  function scheduleNextItem(immediate = false) {
    if (state.stopped) return;

    const playlist = state.playlist || [];

    // ✅ Enterprise default behavior:
    // If there is no playlist, show logo (NOT "No content assigned")
    if (!playlist.length) {
      showFallbackLogo("no_playlist");
      // Keep polling for content
      state.itemTimer = setTimeout(() => start().catch(() => {}), 5000);
      return;
    }

    const item = playlist[state.index % playlist.length];
    state.index = (state.index + 1) % playlist.length;

    showItem(item);

    const seconds = Math.max(3, Number(item?.duration || 10));
    state.itemTimer = setTimeout(scheduleNextItem, immediate ? 0 : seconds * 1000);
  }

  function computeBackoffMs(status) {
    // Smart backoff: avoid hammering backend on 500/502
    if (status === 500 || status === 502 || status === 503) return 15000;
    return 5000;
  }

  async function start() {
    if (state.stopped) return;

    clearTimers();

    if (!state.screenId) {
      showFallbackLogo("missing_screen_id");
      return;
    }

    // If someone navigated to /display/fallback-logo.svg accidentally
    if (isProbablyAssetId(state.screenId)) {
      showFallbackLogo("asset_path");
      return;
    }

    // Never get stuck on "Loading..."
    showFallbackLogo("boot");

    try {
      const data = await fetchPlaylist();
      const playlist = Array.isArray(data?.playlist) ? data.playlist : [];

      state.playlist = playlist;
      state.index = 0;

      // Start playback immediately (or fallback logo if empty)
      scheduleNextItem(true);

      // Refresh playlist periodically (server suggests refreshInterval seconds)
      const refreshSec = Math.max(10, Number(data?.refreshInterval || 15));
      state.refreshTimer = setTimeout(() => {
        start().catch(() => {});
      }, refreshSec * 1000);
    } catch (e) {
      console.error("Playlist load failed:", e);

      const status = e && typeof e === "object" ? e.status : null;

      // ✅ For ANY error, show the logo and keep retrying.
      // This matches your requirement: no playlist required on first connect.
      showFallbackLogo(`playlist_error_${status || "unknown"}`);

      state.retryTimer = setTimeout(
        () => start().catch(() => {}),
        computeBackoffMs(status),
      );
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
})();// public/display/app.js
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
    // 1) URL query is best:
    // /display/DEV-123?token=xxxx OR /display/DEV-123?t=xxxx
    const qs = new URLSearchParams(location.search || "");
    const qToken = qs.get("token") || qs.get("t");
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

      const status = e && typeof e === "object" ? e.status : null;
      const body = e && typeof e === "object" ? e.body : "";

      if (status === 401) {
        setText(
          `Unauthorized (401) — missing/invalid screen token${body ? " | " + body : ""}`,
        );
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
