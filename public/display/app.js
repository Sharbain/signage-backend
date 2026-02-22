// public/display/app.js
(async function () {
  const root = document.getElementById("root");
  const screenId = decodeURIComponent(location.pathname.split("/").pop() || "");

  function setText(t) {
    if (root) root.textContent = t;
  }

  function clearRoot() {
    if (root) root.innerHTML = "";
  }

  async function fetchPlaylist() {
    // Uses your backend route:
    // GET /api/screens/:deviceId/playlist
    const res = await fetch(`/api/screens/${encodeURIComponent(screenId)}/playlist`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`playlist_http_${res.status}`);
    return res.json();
  }

  function showItem(item) {
    clearRoot();

    // Basic: image or video
    if (item.type?.toLowerCase()?.includes("video") || /\.(mp4|webm|mov)$/i.test(item.url)) {
      const v = document.createElement("video");
      v.src = item.url;
      v.autoplay = true;
      v.loop = false;
      v.muted = true;
      v.playsInline = true;
      v.style.maxWidth = "100%";
      v.style.maxHeight = "100%";
      v.onended = () => {}; // handled by timer fallback below
      root.appendChild(v);
      return;
    }

    const img = document.createElement("img");
    img.src = item.url;
    img.alt = item.name || "media";
    root.appendChild(img);
  }

  async function run() {
    if (!screenId) {
      setText("Missing screen id");
      return;
    }

    setText("Loading…");

    let data;
    try {
      data = await fetchPlaylist();
    } catch (e) {
      console.error(e);
      setText("Failed to load playlist");
      setTimeout(run, 5000);
      return;
    }

    const playlist = Array.isArray(data.playlist) ? data.playlist : [];
    if (!playlist.length) {
      setText("No content assigned");
      setTimeout(run, 10000);
      return;
    }

    let i = 0;
    const tick = () => {
      const item = playlist[i % playlist.length];
      showItem(item);

      const seconds = Math.max(3, Number(item.duration || 10));
      i++;
      setTimeout(tick, seconds * 1000);
    };

    tick();

    // Refresh playlist periodically (server suggests refreshInterval seconds)
    const refreshSec = Math.max(30, Number(data.refreshInterval || 300));
    setInterval(() => {
      run().catch(() => {});
    }, refreshSec * 1000);
  }

  run();
})();
