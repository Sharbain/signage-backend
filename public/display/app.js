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
    backoffMs: 2000,
    lastMode: "online", // online | cached
  };

  function setText(text) {
    if (!root) return;
    root.innerHTML = "";
    root.textContent = String(text);
  }

  function setHtml(html) {
    if (!root) return;
    root.innerHTML = String(html);
  }

  function clearRoot() {
    if (!root) return;
    root.innerHTML = "";
  }

  function getScreenIdFromPath() {
    const parts = (location.pathname || "").split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    return decodeURIComponent(last);
  }

  function getToken() {
    const qs = new URLSearchParams(location.search || "");
    const qToken = qs.get("token");
    if (qToken && qToken.trim()) return qToken.trim();

    const keys = ["screenToken", "deviceToken", "device_token", "accessToken"];
    for (const k of keys) {
      try {
        const v = localStorage.getItem(k);
        if (v && v.trim()) return v.trim();
      } catch (_) {}
    }
    return "";
  }

  function lkgKey(screenId) {
    return `lkg_playlist_${screenId}`;
  }
  function lkgMetaKey(screenId) {
    return `lkg_playlist_meta_${screenId}`;
  }

  function savePlaylistToCache(screenId, payload) {
    try {
      localStorage.setItem(lkgKey(screenId), JSON.stringify(payload));
      localStorage.setItem(
        lkgMetaKey(screenId),
        JSON.stringify({ savedAt: Date.now() })
      );
    } catch (_) {}
  }

  function loadPlaylistFromCache(screenId) {
    try {
      const raw = localStorage.getItem(lkgKey(screenId));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async function fetchPlaylist() {
    const token = getToken();
    const headers = {};
    if (token) {
      headers["Authorization"] = `Device ${token}`;
      headers["X-Device-Token"] = token; // compatibility
    }

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

  function scheduleNextItemSoon(ms) {
    if (state.stopped) return;
    clearTimeout(state.itemTimer);
    state.itemTimer = setTimeout(scheduleNextItem, Math.max(500, ms || 1500));
  }

  function showItem(item) {
    clearRoot();
    if (!root) return;

    const url = String(item?.url || "");
    const name = String(item?.name || "media");

    // Small overlay so you can tell if you're running cached content
    const badge = document.createElement("div");
    badge.textContent = state.lastMode === "cached" ? "OFFLINE (cached)" : "";
    badge.style.position = "fixed";
    badge.style.top = "10px";
    badge.style.left = "10px";
    badge.style.padding = "6px 10px";
    badge.style.borderRadius = "10px";
    badge.style.background = "rgba(0,0,0,.45)";
    badge.style.color = "#fff";
    badge.style.fontFamily = "system-ui,Segoe UI,Roboto,Arial";
    badge.style.fontSize = "12px";
    badge.style.zIndex = "9999";
    badge.style.pointerEvents = "none";

    if (badge.textContent) root.appendChild(badge);

    if (!url) {
      setText("Invalid media URL");
      scheduleNextItemSoon(1500);
      return;
    }

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

      const vol = Number(item?.volume);
      if (!Number.isNaN(vol)) {
        const clamped = Math.max(0, Math.min(100, vol));
        v.muted = clamped === 0;
        v.volume = clamped / 100;
      } else {
        v.muted = true;
      }

      v.onerror = () => {
        console.error("Video failed to load:", url);
        setText("Video failed to load");
        scheduleNextItemSoon(1500);
      };

      // If it ends before the duration timer, skip forward
      v.onended = () => {
        scheduleNextItemSoon(250);
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
      console.error("Image failed to load:", url);
      setText("Image failed to load");
      scheduleNextItemSoon(1500);
    };

    root.appendChild(img);
  }

  function scheduleNextItem() {
    if (state.stopped) return;

    const playlist = state.playlist || [];
    if (!playlist.length) {
      setHtml(`
        <div style="font-family:system-ui,Segoe UI,Roboto,Arial;color:#fff;text-align:center;padding:24px">
          <h2>No content assigned</h2>
          <div style="opacity:.75">Retrying…</div>
        </div>
      `);
      state.itemTimer = setTimeout(() => start(), 10000);
      return;
    }

    const item = playlist[state.index % playlist.length];
    state.index = (state.index + 1) % playlist.length;

    showItem(item);

    const seconds = Math.max(3, Number(item?.duration || 10));
    state.itemTimer = setTimeout(scheduleNextItem, seconds * 1000);
  }

  function scheduleRetry() {
    if (state.stopped) return;

    const ms = Math.min(60_000, Math.max(2_000, state.backoffMs));
    state.backoffMs = Math.min(60_000, Math.round(state.backoffMs * 1.7));

    state.retryTimer = setTimeout(() => start().catch(() => {}), ms);
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

      // Reset backoff on success
      state.backoffMs = 2000;
      state.lastMode = "online";

      // Cache last known good payload
      savePlaylistToCache(state.screenId, data);

      state.playlist = playlist;
      state.index = 0;

      scheduleNextItem();

      const refreshSec = Math.max(30, Number(data?.refreshInterval || 300));
      state.refreshTimer = setTimeout(() => {
        start().catch(() => {});
      }, refreshSec * 1000);
    } catch (e) {
      console.error("Playlist load failed:", e);

      const status = e && typeof e === "object" ? e.status : null;

      // Try cached playlist before giving up
      const cached = loadPlaylistFromCache(state.screenId);
      if (cached && Array.isArray(cached?.playlist)) {
        state.lastMode = "cached";
        state.playlist = cached.playlist;
        state.index = 0;

        setHtml(`
          <div style="font-family:system-ui,Segoe UI,Roboto,Arial;color:#fff;text-align:center;padding:24px">
            <h2>Offline</h2>
            <div style="opacity:.75">Playing cached content</div>
          </div>
        `);

        // Start cached playback
        scheduleNextItem();

        // Keep trying to recover online in background
        scheduleRetry();
        return;
      }

      if (status === 401) {
        setText("Unauthorized (401) — missing/invalid screen token");
      } else {
        setText("Failed to load playlist");
      }

      scheduleRetry();
    }
  }

  state.screenId = getScreenIdFromPath();
  start();

  window.__STOP_SIGNAGE__ = function () {
    state.stopped = true;
    clearTimers();
    setText("Stopped");
  };
})();
