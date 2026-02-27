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
    lastBrightness: null,
  };

  // Served by backend static route: /display/fallback-logo.svg
  const FALLBACK_URL = "/display/fallback-logo.svg";

  // Normalize URLs coming from the backend.
  // Fixes cases where DB rows were created locally and still contain localhost URLs.
  function normalizeUrl(u) {
    if (!u || typeof u !== "string") return "";

    try {
      if (
        u.startsWith("http://localhost") ||
        u.startsWith("https://localhost") ||
        u.startsWith("http://127.0.0.1") ||
        u.startsWith("https://127.0.0.1")
      ) {
        const parsed = new URL(u);
        return window.location.origin + parsed.pathname;
      }

      if (u.startsWith("/")) return window.location.origin + u;

      return u;
    } catch {
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
    // ✅ Token is now REQUIRED (backend hardening)
    const qs = new URLSearchParams(location.search || "");
    const qToken = qs.get("token") || qs.get("t");
    if (qToken && qToken.trim()) return qToken.trim();

    // Keep localStorage fallback for browser testing only (optional)
    const keys = ["screenToken", "deviceToken", "device_token"];
    for (const k of keys) {
      try {
        const v = localStorage.getItem(k);
        if (v && v.trim()) return v.trim();
      } catch (_) {}
    }

    return "";
  }

  // ---- Brightness helpers ----

  function pickBrightnessFromPayload(data) {
    // Accept a few possible shapes so we don't break if your backend field name differs.
    const candidates = [
      data?.brightness,
      data?.screen?.brightness,
      data?.screenSettings?.brightness,
      data?.settings?.brightness,
    ];

    for (const v of candidates) {
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
    return null;
  }

  function applyBrightness(percent) {
    const n = Number(percent);
    if (Number.isNaN(n)) return;

    const clamped = Math.max(0, Math.min(100, n));

    // Avoid spamming native bridge every refresh if unchanged
    if (state.lastBrightness === clamped) return;
    state.lastBrightness = clamped;

    // Native (Android WebView) path:
    try {
      if (window.PlayerBridge && typeof window.PlayerBridge.setBrightness === "function") {
        window.PlayerBridge.setBrightness(clamped);
        console.log("[PLAYER] Brightness sent to Android:", clamped);
        return;
      }
    } catch (e) {
      console.warn("[PLAYER] Brightness bridge error:", e);
    }

    // Fallback for browser testing only (does NOT change device brightness):
    try {
      if (root) {
        const factor = Math.max(0.1, clamped / 100);
        root.style.filter = `brightness(${factor})`;
      }
      console.log("[PLAYER] Brightness applied via CSS fallback:", clamped);
    } catch (_) {}
  }

  function showFallbackLogo(reason) {
    clearRoot();
    state.showingFallback = true;

    if (!root) return;

    const img = document.createElement("img");
    img.src = normalizeUrl(FALLBACK_URL);
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

    // ✅ Fail fast with a clear on-screen message if token is missing
    if (!token) {
      const err = new Error("missing_display_token");
      err.status = 401;
      err.body = "No token in URL. Expected /display/<deviceId>?token=<jwt>";
      throw err;
    }

    // Send token BOTH ways: header + query param (most robust)
    const headers = { Authorization: `Bearer ${token}` };

    // Canonical: screenId here is actually your deviceId (DEV-xxxx)
    const url =
      `/api/screens/${encodeURIComponent(state.screenId)}/playlist` +
      `?token=${encodeURIComponent(token)}`;

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

    const url = normalizeUrl(String(item?.url || ""));
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
    if (status === 401 || status === 403) return 8000;
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

      // ✅ Apply brightness as soon as we have payload (before showing media)
      const b = pickBrightnessFromPayload(data);
      if (b != null) applyBrightness(b);

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

      // If missing token, show a very direct message
      if (e && typeof e === "object" && e.message === "missing_display_token") {
        setText("Missing token. Open:\n/display/<deviceId>?token=<jwt>");
        return;
      }

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
