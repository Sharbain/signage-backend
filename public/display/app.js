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
    watchdogTimer: null,
    playlist: [],
    index: 0,
    lastError: "",
    // Backoff control
    backoffMs: 5000,
    // Health
    lastRenderAt: Date.now(),
    lastPlaylistOkAt: 0,
    // Mark when we are playing cached content
    mode: "online", // online | cached

    // Preload
    preloaded: null, // { type, url, el }
    preloadUrl: "",
    // Transition
    inTransition: false,
  };

  function qs() {
    try {
      return new URLSearchParams(location.search || "");
    } catch (_) {
      return { get: () => null, has: () => false };
    }
  }

  const DEBUG = qs().get("debug") === "1";

  // ---- Cache (Last Known Good) ----
  const CACHE_KEY = () => `lumina_lkg_playlist:${state.screenId || "unknown"}`;
  const CACHE_META_KEY = () => `lumina_lkg_meta:${state.screenId || "unknown"}`;
  const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

  function cacheSave(payload) {
    try {
      localStorage.setItem(CACHE_KEY(), JSON.stringify(payload));
      localStorage.setItem(CACHE_META_KEY(), JSON.stringify({ savedAt: Date.now() }));
    } catch (_) {}
  }

  function cacheLoad() {
    try {
      const raw = localStorage.getItem(CACHE_KEY());
      if (!raw) return null;
      const payload = JSON.parse(raw);

      const metaRaw = localStorage.getItem(CACHE_META_KEY());
      const meta = metaRaw ? JSON.parse(metaRaw) : null;
      const savedAt = meta?.savedAt ? Number(meta.savedAt) : 0;

      if (savedAt && Date.now() - savedAt > CACHE_MAX_AGE_MS) return null;
      return payload;
    } catch (_) {
      return null;
    }
  }

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
    state.lastRenderAt = Date.now();
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
    const parts = (location.pathname || "").split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    return decodeURIComponent(last);
  }

  function getToken() {
    const qToken = qs().get("token");
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
        `mode=${state.mode}`,
        `screenId=${state.screenId || "(missing)"}`,
        `token=${safeToken || "(missing)"}`,
        `playlistLen=${Array.isArray(state.playlist) ? state.playlist.length : 0}`,
        `index=${state.index}`,
        `backoffMs=${state.backoffMs}`,
        `preloadUrl=${state.preloadUrl || ""}`,
        state.lastError ? `lastError=${state.lastError}` : "",
        `lastRenderAgoMs=${Date.now() - state.lastRenderAt}`,
        `url=${location.href}`,
      ]
        .filter(Boolean)
        .join("\n");
  }

  async function fetchPlaylist() {
    const token = getToken();
    const url =
      `/api/screens/${encodeURIComponent(state.screenId)}/playlist` +
      (token ? `?token=${encodeURIComponent(token)}` : "");

    const headers = {};
    if (token) {
      headers["Authorization"] = `Device ${token}`;
      headers["X-Device-Token"] = token;
    }

    const res = await fetch(url, { method: "GET", headers, cache: "no-store" });

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

  function scheduleNextSoon(ms) {
    if (state.stopped) return;
    if (state.itemTimer) clearTimeout(state.itemTimer);
    state.itemTimer = setTimeout(scheduleNextItem, Math.max(250, ms || 1500));
  }

  function showModeBadge() {
    if (!root) return;
    if (state.mode !== "cached") return;

    const badge = document.createElement("div");
    badge.textContent = "OFFLINE (cached)";
    badge.style.position = "fixed";
    badge.style.top = "10px";
    badge.style.left = "10px";
    badge.style.padding = "6px 10px";
    badge.style.borderRadius = "10px";
    badge.style.background = "rgba(0,0,0,.45)";
    badge.style.color = "#fff";
    badge.style.fontFamily = "system-ui, Segoe UI, Roboto, Arial";
    badge.style.fontSize = "12px";
    badge.style.zIndex = "999999";
    badge.style.pointerEvents = "none";
    document.body.appendChild(badge);
    setTimeout(() => {
      try {
        badge.remove();
      } catch (_) {}
    }, 3000);
  }

  function styleMedia(el) {
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.objectFit = "contain";
    el.style.display = "block";
    // fade
    el.style.opacity = "0";
    el.style.transition = "opacity 250ms linear";
    return el;
  }

  function fadeIn(el) {
    requestAnimationFrame(() => {
      try {
        el.style.opacity = "1";
      } catch (_) {}
    });
  }

  function fadeSwap(newEl) {
    if (!root) return;
    state.inTransition = true;

    const old = root.firstElementChild;

    // Add new element hidden
    root.appendChild(newEl);

    // Fade in new
    fadeIn(newEl);

    // Fade out old, then remove
    if (old && old !== newEl) {
      try {
        old.style.transition = "opacity 250ms linear";
        old.style.opacity = "0";
      } catch (_) {}
      setTimeout(() => {
        try {
          if (old && old.parentNode === root) old.remove();
        } catch (_) {}
        state.inTransition = false;
      }, 280);
    } else {
      state.inTransition = false;
    }
  }

  function nextIndexPreview() {
    const playlist = state.playlist || [];
    if (!playlist.length) return null;
    const nextIdx = state.index % playlist.length;
    return { idx: nextIdx, item: playlist[nextIdx] };
  }

  function startPreloadForNext() {
    const preview = nextIndexPreview();
    if (!preview) return;

    const item = preview.item;
    const url = String(item?.url || "");
    if (!url) return;

    // Avoid re-preloading the same URL
    if (state.preloadUrl === url && state.preloaded) return;

    // Reset
    state.preloaded = null;
    state.preloadUrl = url;

    const isVid = isVideo(item);

    if (isVid) {
      // Video preload: create element and set preload=auto, but don't autoplay
      const v = document.createElement("video");
      v.src = url;
      v.preload = "auto";
      v.playsInline = true;
      v.muted = true; // safe for autoplay policies even though we won't autoplay
      styleMedia(v);

      const onReady = () => {
        cleanup();
        state.preloaded = { type: "video", url, el: v };
        if (DEBUG) renderDebugOverlay();
      };
      const onErr = () => {
        cleanup();
        // Don't block playback; we just won't have a preload
        state.preloaded = null;
      };
      const cleanup = () => {
        v.removeEventListener("canplaythrough", onReady);
        v.removeEventListener("loadeddata", onReady);
        v.removeEventListener("error", onErr);
      };

      v.addEventListener("canplaythrough", onReady, { once: true });
      v.addEventListener("loadeddata", onReady, { once: true });
      v.addEventListener("error", onErr, { once: true });

      // Touch it so browser begins loading
      try { v.load(); } catch (_) {}
      return;
    }

    // Image preload
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.onload = () => {
      state.preloaded = { type: "image", url, el: img };
      if (DEBUG) renderDebugOverlay();
    };
    img.onerror = () => {
      state.preloaded = null;
    };
    img.src = url;
  }

  function showItem(item) {
    if (!root) return;

    state.lastRenderAt = Date.now();
    if (DEBUG) renderDebugOverlay();

    showModeBadge();

    const url = String(item?.url || "");
    if (!url) {
      setError("Item missing url");
      scheduleNextSoon(1500);
      return;
    }

    // If we preloaded this exact URL, use it
    if (state.preloaded && state.preloaded.url === url && state.preloaded.el) {
      const p = state.preloaded;
      state.preloaded = null;
      state.preloadUrl = "";

      if (p.type === "image") {
        // convert preloaded Image() to DOM img
        const domImg = document.createElement("img");
        domImg.src = url;
        domImg.alt = String(item?.name || "media");
        styleMedia(domImg);
        domImg.onerror = () => {
          setError(`Image failed to load\n${url}`);
          scheduleNextSoon(1500);
        };

        // swap with fade
        clearRoot();
        fadeSwap(domImg);
      } else {
        const v = p.el;
        // Ensure playback settings
        v.autoplay = true;
        v.loop = false;
        v.playsInline = true;

        const vol = Number(item?.volume);
        if (!Number.isNaN(vol)) {
          const clamped = Math.max(0, Math.min(100, vol));
          v.muted = clamped === 0;
          v.volume = clamped / 100;
        } else {
          v.muted = true;
        }

        v.onerror = () => {
          setError(`Video failed to load\n${url}`);
          scheduleNextSoon(1500);
        };
        v.onended = () => scheduleNextSoon(250);

        clearRoot();
        fadeSwap(v);
        return;
      }

      // Start preloading the next item now
      startPreloadForNext();
      return;
    }

    // Fallback: normal render (still with fade + skip-on-error)
    if (isVideo(item)) {
      const v = document.createElement("video");
      v.src = url;
      v.autoplay = true;
      v.loop = false;
      v.playsInline = true;
      v.preload = "auto";
      styleMedia(v);

      const vol = Number(item?.volume);
      if (!Number.isNaN(vol)) {
        const clamped = Math.max(0, Math.min(100, vol));
        v.muted = clamped === 0;
        v.volume = clamped / 100;
      } else {
        v.muted = true;
      }

      v.onerror = () => {
        setError(`Video failed to load\n${url}`);
        scheduleNextSoon(1500);
      };
      v.onended = () => scheduleNextSoon(250);

      clearRoot();
      fadeSwap(v);
      startPreloadForNext();
      return;
    }

    const img = document.createElement("img");
    img.src = url;
    img.alt = String(item?.name || "media");
    styleMedia(img);
    img.onerror = () => {
      setError(`Image failed to load\n${url}`);
      scheduleNextSoon(1500);
    };
    img.onload = () => {
      // fade in happens on swap
    };

    clearRoot();
    fadeSwap(img);
    startPreloadForNext();
  }

  function clearTimers() {
    if (state.itemTimer) clearTimeout(state.itemTimer);
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    if (state.retryTimer) clearTimeout(state.retryTimer);
    if (state.watchdogTimer) clearInterval(state.watchdogTimer);
    state.itemTimer = null;
    state.refreshTimer = null;
    state.retryTimer = null;
    state.watchdogTimer = null;
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

  function resetBackoff() {
    state.backoffMs = 5000;
  }

  function bumpBackoff() {
    state.backoffMs = Math.min(60_000, Math.round(state.backoffMs * 1.7));
  }

  function startWatchdog() {
    if (state.watchdogTimer) return;

    state.watchdogTimer = setInterval(() => {
      if (state.stopped) return;
      const idleMs = Date.now() - state.lastRenderAt;
      if (idleMs > 90_000) {
        console.error("Watchdog: no render for too long, restarting...");
        start().catch(() => {});
      }
    }, 10_000);
  }

  async function start() {
    if (state.stopped) return;

    clearTimers();
    startWatchdog();

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
      state.mode = "online";
      state.lastPlaylistOkAt = Date.now();

      cacheSave(data);
      resetBackoff();

      // Prime preload before first render
      startPreloadForNext();

      scheduleNextItem();

      const refreshSec = Math.max(30, Number(data?.refreshInterval || 300));
      state.refreshTimer = setTimeout(() => start().catch(() => {}), refreshSec * 1000);
    } catch (e) {
      console.error("Playlist load failed:", e);

      const cached = cacheLoad();
      if (cached && Array.isArray(cached?.playlist) && cached.playlist.length) {
        state.mode = "cached";
        state.playlist = cached.playlist;
        state.index = 0;

        startPreloadForNext();
        scheduleNextItem();
      } else {
        const msg = e?.message ? String(e.message) : "Failed to load playlist";
        setError(msg);
      }

      bumpBackoff();
      state.retryTimer = setTimeout(() => start().catch(() => {}), state.backoffMs);
    }
  }

// ---- Remote inject (from ContentBridge / Android) ----
  window.__LUMINA_INJECT_PLAYLIST__ = function (items) {
    try {
      if (!Array.isArray(items) || !items.length) return;
      clearTimers();
      state.stopped = false;
      state.playlist = items.map(function (item) {
        return {
          url: String(item.url || ""),
          type: String(item.type || "image"),
          name: String(item.name || "Content"),
          duration: Number(item.duration) > 0 ? Number(item.duration) : 30,
        };
      });
      state.index = 0;
      state.mode = "online";
      state.lastError = "";
      startWatchdog();
      scheduleNextItem();
    } catch (e) {
      console.error("__LUMINA_INJECT_PLAYLIST__ error:", e);
    }
  };

  // Boot
  state.screenId = getScreenIdFromPath();
  start();

  window.__STOP_SIGNAGE__ = function () {
    state.stopped = true;
    clearTimers();
    setText("Stopped");
  };
})();
