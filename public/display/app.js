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

  // Served by backend static route: /display/fallback-logo.svg
  const FALLBACK_URL = "/display/fallback-logo.svg";

  function normalizeMediaUrl(raw) {
    const u = String(raw || "").trim();
    if (!u) return u;

    // If backend accidentally stored localhost URLs from dev, rewrite to current origin.
    try {
      const parsed = new URL(u, location.origin);
      const host = parsed.hostname;
      const isLocalhost =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0";

      if (isLocalhost) {
        // keep pathname + search + hash, but use current origin
        return location.origin + parsed.pathname + parsed.search + parsed.hash;
      }

      // For relative URLs, URL() will resolve against current origin already.
      // Return absolute for consistency.
      if (!/^https?:/i.test(u)) {
        return parsed.href;
      }

      return u;
    } catch (_) {
      return u;
    }
  }

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
    // Optional (future hardening). For now, signage works without a token.
    const qs = new URLSearchParams(location.search || "");
    const qToken = qs.get("token") || qs.get("t");
    if (qToken && qToken.trim()) return qToken.trim();

    const keys = ["screenToken", "deviceToken", "device_token"]; // avoid CMS accessToken
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
      setText("Waiting for content…");
    };

    root.appendChild(img);

    if (reason) console.warn("[PLAYER] Fallback mode:", reason);
  }

  async function fetchPlaylist() {
    const token = getToken();

    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    // Canonical: screenId here is actually your deviceId (DEV-xxxx)
    const url = `/api/screens/${encodeURIComponent(state.screenId)}/playlist`;

    const res = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
    });

    // Treat "no playlist yet" as valid
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

    const url = normalizeMediaUrl(item?.url);
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

      const vol = Number(item?.volume);
      if (!Number.isNaN(vol)) {
        const clamped = Math.max(0, Math.min(100, vol));
        v.muted = clamped === 0;
        v.volume = clamped / 100;
      } else {
        v.muted = true;
      }

      v.onerror = () => {
        showFallbackLogo("video_failed");
      };

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

    // Enterprise behavior: no playlist => show fallback logo and keep polling
    if (!playlist.length) {
      showFallbackLogo("no_playlist");
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

    if (isProbablyAssetId(state.screenId)) {
      showFallbackLogo("asset_path");
      return;
    }

    // Never get stuck on "Loading…"
    showFallbackLogo("boot");

    try {
      const data = await fetchPlaylist();
      const playlist = Array.isArray(data?.playlist) ? data.playlist : [];

      state.playlist = playlist;
      state.index = 0;

      scheduleNextItem(true);

      const refreshSec = Math.max(10, Number(data?.refreshInterval || 15));
      state.refreshTimer = setTimeout(() => {
        start().catch(() => {});
      }, refreshSec * 1000);
    } catch (e) {
      console.error("Playlist load failed:", e);

      const status = e && typeof e === "object" ? e.status : null;
      showFallbackLogo(`playlist_error_${status || "unknown"}`);

      state.retryTimer = setTimeout(
        () => start().catch(() => {}),
        computeBackoffMs(status),
      );
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
