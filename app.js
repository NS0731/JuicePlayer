const API_BASE = "/api/juicewrld";
const API_ORIGIN = "https://juicewrldapi.com";
const LASTFM_API_BASE = "/auth/lastfm";
const BLOCKED_CATEGORIES = new Set(["unsurfaced", "recording_session"]);

const searchInput = document.getElementById("searchInput");
const categoryButtonsEl = document.getElementById("categoryButtons");
const categoryFilterEl = document.getElementById("categoryFilter");
const searchBtn = document.getElementById("searchBtn");
const loadMoreBtn = document.getElementById("loadMoreBtn");
const loadingEl = document.getElementById("loading");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const queueEl = document.getElementById("queue");
const nowPlayingEl = document.getElementById("nowPlaying");
const nowPlayingArtistEl = document.getElementById("nowPlayingArtist");
const nowPlayingArtEl = document.getElementById("nowPlayingArt");
const progressBar = document.getElementById("progressBar");
const currentTimeEl = document.getElementById("currentTime");
const durationEl = document.getElementById("duration");
const queuePanel = document.getElementById("queuePanel");
const queuePanelToggle = document.getElementById("queuePanelToggle");
const lastFmHint = document.getElementById("lastFmHint");
const lastFmAuthMessage = document.getElementById("lastFmAuthMessage");
const lastFmLoginBtn = document.getElementById("lastFmLoginBtn");
const lastFmLogoutBtn = document.getElementById("lastFmLogoutBtn");

const prevBtn = document.getElementById("prevBtn");
const playPauseBtn = document.getElementById("playPauseBtn");
const nextBtn = document.getElementById("nextBtn");
const radioBtn = document.getElementById("radioBtn");
const queueBtn = document.getElementById("queueBtn");
const clearQueueBtn = document.getElementById("clearQueueBtn");
const player = document.getElementById("player");

const PAGE_SIZE = 20;
const RADIO_PREFETCH_REMAINING_SECONDS = 20;
const SONG_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_SONG_CACHE_ENTRIES = 30;

let queue = [];
let currentIndex = -1;
let selectedCategory = "";
let currentPage = 1;
let hasMoreResults = false;
let isRadioMode = false;
let isFetchingRadioSong = false;
let isPrefetchingRadioSong = false;
let radioFetchPromise = null;
let prefetchedRadioSong = null;
let radioPreloadAudio = null;
let statusHideTimer = null;
let lastFmState = {
  enabled: false,
  authenticated: false,
  username: null
};
let currentTrackScrobbleState = null;
let lastFmOutcomeMessage = "";
let lastFmOutcomeType = "";
let lastFmAuthPollTimer = null;
let lastFmAuthPollAttempts = 0;
let lastFmStatusError = "";
let isLastFmAuthPending = false;
let currentLastFmFlowId = "";
let lastFmStatusLoaded = false;
let lastFmStatusRequest = null;
let lastFmStatusUpdatedAt = 0;
let activeSearchController = null;
let currentSearchRequestId = 0;
let isLoadingMore = false;
const songPageCache = new Map();
const inFlightSongRequests = new Map();
let categoriesCache = null;

function setLastFmOutcomeMessage(message, type = "") {
  lastFmOutcomeMessage = String(message || "");
  lastFmOutcomeType = type;
  if (!lastFmAuthMessage) {
    return;
  }

  lastFmAuthMessage.textContent = lastFmOutcomeMessage;
  lastFmAuthMessage.classList.toggle("success", type === "success");
  lastFmAuthMessage.classList.toggle("error", type === "error");
}

function stopLastFmAuthPolling() {
  if (lastFmAuthPollTimer) {
    clearInterval(lastFmAuthPollTimer);
    lastFmAuthPollTimer = null;
  }

  lastFmAuthPollAttempts = 0;
}

async function finalizeLastFmPopupLogin(authCode) {
  if (!authCode) {
    return false;
  }

  try {
    await postLastFm("/complete", { code: authCode });
    return true;
  } catch (error) {
    console.error("Last.fm finalize login error", error);
    return false;
  }
}

async function initializeLastFmLogin() {
  const response = await fetch(`${LASTFM_API_BASE}/login-init?t=${Date.now()}`, {
    cache: "no-store",
    credentials: "same-origin"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Last.fm login-init failed with status ${response.status}`);
  }

  return response.json();
}

async function fetchLastFmFlowStatus(flowId) {
  try {
    const query = flowId ? `flow_id=${encodeURIComponent(flowId)}&` : "";
    const response = await fetch(`${LASTFM_API_BASE}/flow-status?${query}t=${Date.now()}`, {
      cache: "no-store",
      credentials: "same-origin"
    });

    if (!response.ok) {
      return { status: "pending" };
    }

    return await response.json();
  } catch (error) {
    return { status: "pending" };
  }
}

function startLastFmAuthPolling() {
  stopLastFmAuthPolling();
  isLastFmAuthPending = true;

  lastFmAuthPollTimer = setInterval(async () => {
    lastFmAuthPollAttempts += 1;

    if (currentLastFmFlowId) {
      const flowStatus = await fetchLastFmFlowStatus(currentLastFmFlowId);
      const effectiveFlowStatus = flowStatus;

      if (effectiveFlowStatus?.status === "connected") {
        await refreshLastFmState(true);
        if (lastFmState.authenticated) {
          stopLastFmAuthPolling();
          isLastFmAuthPending = false;
          currentLastFmFlowId = "";
          setStatus("Last.fm connected. Scrobbling is now active.");
          setLastFmOutcomeMessage("Connection successful. Scrobbling is active.", "success");
          return;
        }
      }

      if (effectiveFlowStatus?.status === "failed") {
        stopLastFmAuthPolling();
        isLastFmAuthPending = false;
        currentLastFmFlowId = "";
        const reason = effectiveFlowStatus?.error ? String(effectiveFlowStatus.error) : "Unknown error";
        setLastFmOutcomeMessage(`Login failed: ${reason}`, "error");
        return;
      }

      if (effectiveFlowStatus?.status === "missing_token") {
        stopLastFmAuthPolling();
        isLastFmAuthPending = false;
        currentLastFmFlowId = "";
        setLastFmOutcomeMessage("Last.fm did not return a token to the callback URL.", "error");
        return;
      }
    }

    const refreshed = currentLastFmFlowId ? true : await refreshLastFmState();

    if (!refreshed) {
      if (lastFmAuthPollAttempts >= 8) {
        stopLastFmAuthPolling();
        isLastFmAuthPending = false;
        setLastFmOutcomeMessage("Unable to reach auth status endpoint. Make sure the server is running, then try again.", "error");
      }
      return;
    }

    if (lastFmState.authenticated) {
      stopLastFmAuthPolling();
      isLastFmAuthPending = false;
      return;
    }

    if (lastFmAuthPollAttempts >= 30) {
      stopLastFmAuthPolling();
      isLastFmAuthPending = false;
      setLastFmOutcomeMessage("Authorization did not complete in time. If you approved Last.fm, click Connect again.", "error");
    }
  }, 2000);
}

async function handleLastFmAuthMessage(event) {
  if (event.origin !== window.location.origin) {
    return;
  }

  const data = event.data;
  if (!data || data.source !== "lastfm-auth") {
    return;
  }

  stopLastFmAuthPolling();
  isLastFmAuthPending = false;

  if (data.status === "connected") {
    if (data.authCode) {
      await finalizeLastFmPopupLogin(String(data.authCode));
    }

    await refreshLastFmState();
    if (lastFmState.authenticated) {
      currentLastFmFlowId = "";
      setStatus("Last.fm connected. Scrobbling is now active.");
      setLastFmOutcomeMessage("Connection successful. Scrobbling is active.", "success");
      return;
    }

    setStatus("Last.fm login did not finalize.");
    setLastFmOutcomeMessage("Authorization finished but session was not finalized. Click Connect once more.", "error");
    return;
  }

  if (data.status === "missing_token") {
    currentLastFmFlowId = "";
    setStatus("Last.fm login did not return a token.");
    setLastFmOutcomeMessage("Last.fm did not return a token to the callback URL.", "error");
    return;
  }

  currentLastFmFlowId = "";
  const reason = data.error ? String(data.error) : "Unknown error";
  setStatus("Last.fm login failed.");
  setLastFmOutcomeMessage(`Login failed: ${reason}`, "error");
}

function currentUnixTime() {
  return Math.floor(Date.now() / 1000);
}

function buildTrackScrobbleState(song, index) {
  return {
    song,
    index,
    identity: getSongIdentity(song),
    startedAt: currentUnixTime(),
    nowPlayingSent: false,
    scrobbled: false
  };
}

function updateLastFmUi() {
  const { enabled, authenticated, username } = lastFmState;

  if (!lastFmStatusLoaded) {
    lastFmHint.textContent = "Checking Last.fm configuration...";
    lastFmLoginBtn.disabled = true;
    lastFmLogoutBtn.disabled = true;
    lastFmLoginBtn.style.display = "inline-block";
    lastFmLogoutBtn.style.display = "none";
    if (!lastFmOutcomeMessage) {
      setLastFmOutcomeMessage("Checking Last.fm status...");
    }
    return;
  }

  if (lastFmStatusError) {
    lastFmHint.textContent = "Could not reach Last.fm status from this page.";
    lastFmLoginBtn.disabled = false;
    lastFmLogoutBtn.disabled = false;
    lastFmLoginBtn.style.display = "inline-block";
    lastFmLogoutBtn.style.display = "none";
    setLastFmOutcomeMessage("Status request failed. Restart the server and refresh this page.", "error");
    return;
  }

  if (!enabled) {
    lastFmHint.textContent = "Last.fm is not configured on this server. You can still use JuicePlayer normally.";
    lastFmLoginBtn.disabled = true;
    lastFmLogoutBtn.disabled = true;
    if (!lastFmOutcomeMessage) {
      setLastFmOutcomeMessage("Last.fm auth is disabled because server keys are missing.", "error");
    }
    return;
  }

  if (authenticated) {
    lastFmHint.textContent = `Scrobbling is active${username ? ` for ${username}` : ""}.`;
    lastFmLoginBtn.style.display = "none";
    lastFmLogoutBtn.style.display = "inline-block";
    lastFmLoginBtn.disabled = false;
    lastFmLogoutBtn.disabled = false;
    lastFmLogoutBtn.textContent = username ? `Disconnect: ${username}` : "Disconnect";
    setLastFmOutcomeMessage("Connected successfully.", "success");
    return;
  }

  lastFmHint.textContent = "Sign in to optionally track what you listen to. You can still use the app without login.";
  lastFmLoginBtn.style.display = "inline-block";
  lastFmLogoutBtn.style.display = "none";
  lastFmLoginBtn.disabled = false;
  lastFmLogoutBtn.disabled = false;
  lastFmLogoutBtn.textContent = "Disconnect";

  if (!lastFmOutcomeMessage || (!isLastFmAuthPending && lastFmOutcomeType !== "error")) {
    setLastFmOutcomeMessage("Not connected");
  }
}

async function refreshLastFmState(force = false) {
  const now = Date.now();
  if (lastFmStatusRequest) {
    return lastFmStatusRequest;
  }

  if (!force && lastFmStatusLoaded && now - lastFmStatusUpdatedAt < 5000) {
    return true;
  }

  lastFmStatusRequest = (async () => {
    try {
      const response = await fetch(`${LASTFM_API_BASE}/status?t=${Date.now()}`, {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!response.ok) {
        throw new Error(`Last.fm status request failed with status ${response.status}`);
      }

      const data = await response.json();
      lastFmStatusLoaded = true;
      lastFmStatusUpdatedAt = Date.now();
      lastFmStatusError = "";
      lastFmState = {
        enabled: Boolean(data?.enabled),
        authenticated: Boolean(data?.authenticated),
        username: data?.username || null
      };

      updateLastFmUi();
      return true;
    } catch (error) {
      console.error("Last.fm status error", error);
      lastFmStatusLoaded = true;
      lastFmStatusError = String(error?.message || "status_request_failed");
      lastFmState = {
        enabled: false,
        authenticated: false,
        username: null
      };
      updateLastFmUi();
      return false;
    } finally {
      lastFmStatusRequest = null;
    }
  })();

  return lastFmStatusRequest;
}

async function postLastFm(path, payload) {
  const response = await fetch(`${LASTFM_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(responseText || `Last.fm request failed with status ${response.status}`);
  }
}

async function submitLastFmNowPlaying(trackState) {
  if (!lastFmState.enabled || !lastFmState.authenticated || !trackState || trackState.nowPlayingSent) {
    return;
  }

  const song = trackState.song;
  const duration = Number.isFinite(player.duration) ? Math.floor(player.duration) : undefined;

  try {
    await postLastFm("/now-playing", {
      artist: songArtist(song),
      track: songDisplayName(song),
      album: songCategory(song),
      duration
    });
    trackState.nowPlayingSent = true;
  } catch (error) {
    console.error("Last.fm now playing error", error);
  }
}

function scrobbleThresholdSeconds() {
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  if (duration <= 0) {
    return 240;
  }

  return Math.min(duration / 2, 240);
}

async function maybeScrobbleCurrentTrack() {
  const trackState = currentTrackScrobbleState;

  if (!trackState || trackState.scrobbled || !lastFmState.enabled || !lastFmState.authenticated) {
    return;
  }

  if (trackState.index !== currentIndex || trackState.identity !== getSongIdentity(trackState.song)) {
    return;
  }

  const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  const threshold = scrobbleThresholdSeconds();

  if (currentTime < 30 || currentTime < threshold) {
    return;
  }

  const duration = Number.isFinite(player.duration) ? Math.floor(player.duration) : undefined;

  try {
    await postLastFm("/scrobble", {
      artist: songArtist(trackState.song),
      track: songDisplayName(trackState.song),
      album: songCategory(trackState.song),
      duration,
      timestamp: trackState.startedAt
    });
    trackState.scrobbled = true;
  } catch (error) {
    console.error("Last.fm scrobble error", error);
  }
}

function setLoading(isLoading) {
  loadingEl.style.display = isLoading ? "block" : "none";
}

function setEmpty(show) {
  emptyEl.style.display = show ? "block" : "none";
}

function setStatus(message) {
  const text = (message || "").trim();

  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }

  statusEl.textContent = text;
  statusEl.style.display = text ? "block" : "none";

  if (text) {
    statusHideTimer = setTimeout(() => {
      statusEl.textContent = "";
      statusEl.style.display = "none";
      statusHideTimer = null;
    }, 2400);
  }
}

function setQueueDrawerOpen(open) {
  queuePanel.classList.toggle("open", open);
  queuePanel.setAttribute("aria-hidden", open ? "false" : "true");
  queuePanelToggle.setAttribute("aria-expanded", open ? "true" : "false");
  queuePanelToggle.textContent = open ? "Close" : "Queue";
  queueBtn.setAttribute("aria-expanded", open ? "true" : "false");
  queueBtn.classList.toggle("active", open);
}

function updateRadioButton() {
  radioBtn.textContent = isRadioMode ? "Radio On" : "Radio Off";
  radioBtn.classList.toggle("active", isRadioMode);
}

function isBlockedSong(song) {
  return BLOCKED_CATEGORIES.has(song?.category);
}

function getSongFilePath(song) {
  if (!song || typeof song !== "object") {
    return "";
  }

  const candidates = [
    song.file_path,
    song.path,
    song.filePath,
    song.audio_path,
    song.download_path,
    song.file?.path,
    song.file?.file_path,
    song.audio?.path,
    song.audio?.file_path
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
}

function songStreamUrl(song) {
  const filePath = getSongFilePath(song);
  if (!filePath) {
    return "";
  }

  return `${API_BASE}/files/download/?path=${encodeURIComponent(filePath)}`;
}

function safeFileName(name) {
  return String(name || "song")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120) || "song";
}

async function downloadSong(song) {
  if (isBlockedSong(song)) {
    setStatus("This category is not available for download.");
    return;
  }

  const streamUrl = songStreamUrl(song);
  if (!streamUrl) {
    setStatus("Selected song has no valid audio file path.");
    return;
  }

  try {
    setStatus("Downloading song...");
    const response = await fetch(streamUrl);

    if (!response.ok) {
      throw new Error(`Download request failed with status ${response.status}`);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${safeFileName(songDisplayName(song))}.mp3`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    setStatus("Download started.");
  } catch (error) {
    setStatus("Unable to download song.");
    console.error("Download error", error);
  }
}

function songDisplayName(song) {
  return song?.name || "Untitled Song";
}

function songArtist(song) {
  return song?.credited_artists || "Unknown Artist";
}

function songCategory(song) {
  return song?.category || "unknown";
}

function updateMediaSession(song) {
  if (!("mediaSession" in navigator)) {
    return;
  }

  if (!song) {
    navigator.mediaSession.metadata = null;
    return;
  }

  const artworkUrl = songArtworkUrl(song);
  const metadata = {
    title: songDisplayName(song),
    artist: songArtist(song),
    album: songCategory(song)
  };

  if (artworkUrl) {
    metadata.artwork = [
      { src: artworkUrl, sizes: "512x512", type: "image/webp" },
      { src: artworkUrl, sizes: "256x256", type: "image/webp" }
    ];
  }

  navigator.mediaSession.metadata = new MediaMetadata(metadata);

  setMediaSessionAction("play", async () => {
    try {
      if (!player.src && queue.length > 0 && currentIndex === -1) {
        await playQueueIndex(0);
        return;
      }

      await player.play();
    } catch (error) {
      console.error("Media session play error", error);
    }
  });

  setMediaSessionAction("pause", () => {
    player.pause();
  });

  setMediaSessionAction("previoustrack", () => {
    playPrevious();
  });

  setMediaSessionAction("nexttrack", () => {
    playNext();
  });

  setMediaSessionAction("seekbackward", (details) => {
    player.currentTime = Math.max(0, player.currentTime - (details.seekOffset || 10));
    updateMediaSessionPositionState();
  });

  setMediaSessionAction("seekforward", (details) => {
    player.currentTime = Math.min(player.duration || player.currentTime, player.currentTime + (details.seekOffset || 10));
    updateMediaSessionPositionState();
  });

  setMediaSessionAction("seekto", (details) => {
    if (!Number.isFinite(details.seekTime)) {
      return;
    }

    if (details.fastSeek && typeof player.fastSeek === "function") {
      player.fastSeek(details.seekTime);
    } else {
      player.currentTime = details.seekTime;
    }
    updateMediaSessionPositionState();
  });
}

function setMediaSessionAction(action, handler) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch (error) {
    console.debug(`Media session action is not supported: ${action}`);
  }
}

function songArtworkUrl(song) {
  const imagePath = song?.image_url || song?.imageUrl || song?.artwork_url || song?.artworkUrl;
  if (typeof imagePath !== "string" || !imagePath.trim()) {
    return "";
  }

  const trimmedPath = imagePath.trim();
  if (/^https?:\/\//i.test(trimmedPath)) {
    return trimmedPath;
  }

  return `${API_ORIGIN}${trimmedPath.startsWith("/") ? "" : "/"}${trimmedPath}`;
}

function updateMediaSessionPositionState() {
  if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") {
    return;
  }

  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const position = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  if (duration <= 0 || position < 0 || position > duration) {
    return;
  }

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: Number.isFinite(player.playbackRate) && player.playbackRate > 0 ? player.playbackRate : 1,
      position
    });
  } catch (error) {
    console.debug("Media session position state unavailable", error);
  }
}

function getSongIdentity(song) {
  const path = getSongFilePath(song);
  if (path) {
    return `path:${path.toLowerCase()}`;
  }

  if (song?.id !== undefined && song?.id !== null) {
    return `id:${String(song.id)}`;
  }

  return `name:${songDisplayName(song).toLowerCase()}`;
}

function queueContainsSong(song) {
  const targetIdentity = getSongIdentity(song);
  return queue.some((queuedSong) => getSongIdentity(queuedSong) === targetIdentity);
}

function radioCategory() {
  if (selectedCategory && !BLOCKED_CATEGORIES.has(selectedCategory)) {
    return selectedCategory;
  }
  return "";
}

async function fetchRadioPage(params) {
  const response = await fetch(`${API_BASE}/songs/?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Radio request failed with status ${response.status}`);
  }

  return response.json();
}

function playableRadioSongs(songs) {
  return songs.filter(
    (song) => !isBlockedSong(song) && Boolean(getSongFilePath(song)) && !queueContainsSong(song)
  );
}

async function fetchRadioSongInternal() {
  const category = radioCategory();
  const strategies = category ? [{ category }, {}] : [{}];

  for (const strategy of strategies) {
    const baseParams = new URLSearchParams({ page: "1", page_size: "1" });
    if (strategy.category) {
      baseParams.set("category", strategy.category);
    }

    try {
      const overview = await fetchRadioPage(baseParams);
      const count = Number(overview?.count) || 0;
      const pageCount = Math.max(1, Math.ceil(count / PAGE_SIZE));
      const triedPages = new Set();

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const page = Math.floor(Math.random() * pageCount) + 1;
        if (triedPages.has(page)) {
          continue;
        }
        triedPages.add(page);

        const params = new URLSearchParams({
          page: String(page),
          page_size: String(PAGE_SIZE)
        });
        if (strategy.category) {
          params.set("category", strategy.category);
        }

        const data = await fetchRadioPage(params);
        const songs = Array.isArray(data?.results) ? data.results : [];
        const candidates = playableRadioSongs(songs);
        if (candidates.length > 0) {
          return candidates[Math.floor(Math.random() * candidates.length)];
        }
      }
    } catch (error) {
      console.error("Radio fetch error", error);
    }
  }

  return null;
}

async function fetchRadioSong() {
  if (radioFetchPromise) {
    return radioFetchPromise;
  }

  radioFetchPromise = fetchRadioSongInternal().finally(() => {
    radioFetchPromise = null;
  });

  return radioFetchPromise;
}

async function continueWithRadio() {
  if (!isRadioMode || isFetchingRadioSong) {
    return;
  }

  isFetchingRadioSong = true;
  setStatus("Radio mode is finding the next song...");

  try {
    let song = null;

    if (prefetchedRadioSong && !queueContainsSong(prefetchedRadioSong)) {
      song = prefetchedRadioSong;
    } else {
      song = await fetchRadioSong();
    }

    prefetchedRadioSong = null;
    radioPreloadAudio = null;

    if (!song) {
      setStatus("Radio mode could not find a playable song.");
      return;
    }

    queue.push(song);
    renderQueue();
    await playQueueIndex(queue.length - 1);
  } finally {
    isFetchingRadioSong = false;
  }
}

function shouldPrefetchRadioSong(force = false) {
  if (!isRadioMode || isFetchingRadioSong || isPrefetchingRadioSong) {
    return false;
  }

  if (currentIndex < 0 || queue.length === 0) {
    return false;
  }

  if (currentIndex !== queue.length - 1) {
    return false;
  }

  if (force) {
    return true;
  }

  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  if (duration <= 0) {
    return false;
  }

  const remaining = duration - currentTime;
  return remaining <= RADIO_PREFETCH_REMAINING_SECONDS;
}

function preloadRadioAudio(song) {
  const streamUrl = songStreamUrl(song);
  if (!streamUrl) {
    return;
  }

  const connection = navigator.connection;
  if (connection?.saveData || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") {
    return;
  }

  radioPreloadAudio = new Audio();
  radioPreloadAudio.preload = "auto";
  radioPreloadAudio.src = streamUrl;
  radioPreloadAudio.load();
}

async function prefetchNextRadioSongIfNeeded(force = false) {
  if (!shouldPrefetchRadioSong(force)) {
    return;
  }

  if (prefetchedRadioSong && !queueContainsSong(prefetchedRadioSong)) {
    return;
  }

  isPrefetchingRadioSong = true;

  try {
    const song = await fetchRadioSong();
    if (!song) {
      return;
    }

    if (queueContainsSong(song)) {
      return;
    }

    prefetchedRadioSong = song;
    preloadRadioAudio(song);
  } finally {
    isPrefetchingRadioSong = false;
  }
}

function setLoadMoreVisible(show) {
  loadMoreBtn.style.display = show ? "block" : "none";
}

function renderResults(songs, append = false) {
  if (!append) {
    resultsEl.innerHTML = "";
  }

  const fragment = document.createDocumentFragment();
  songs.forEach((song) => {
    const blocked = isBlockedSong(song);

    const item = document.createElement("div");
    item.className = `item${blocked ? " blocked" : ""}`;

    const header = document.createElement("div");
    header.className = "item-header";

    const info = document.createElement("div");
    info.className = "item-info";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = songDisplayName(song);

    info.appendChild(title);

    if (!blocked) {
      const actions = document.createElement("div");
      actions.className = "item-actions";

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.textContent = "▶ Play";
      playBtn.disabled = !getSongFilePath(song);
      playBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        addToQueueAndPlayNow(song);
        setStatus("Added to queue and playing now.");
      });

      const more = document.createElement("details");
      more.className = "item-more";

      const moreSummary = document.createElement("summary");
      moreSummary.textContent = "More";
      moreSummary.addEventListener("click", (event) => event.stopPropagation());

      const moreMenu = document.createElement("div");
      moreMenu.className = "item-more-menu";

      const addQueueBtn = document.createElement("button");
      addQueueBtn.type = "button";
      addQueueBtn.textContent = "Add to queue";
      addQueueBtn.disabled = !getSongFilePath(song);
      addQueueBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        addToQueueOnly(song);
        more.open = false;
        setStatus("Added to queue.");
      });

      const downloadBtn = document.createElement("button");
      downloadBtn.type = "button";
      downloadBtn.textContent = "Download";
      downloadBtn.disabled = !getSongFilePath(song);
      downloadBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        more.open = false;
        downloadSong(song);
      });

      moreMenu.appendChild(addQueueBtn);
      moreMenu.appendChild(downloadBtn);
      more.appendChild(moreSummary);
      more.appendChild(moreMenu);

      actions.appendChild(playBtn);
      actions.appendChild(more);
      header.appendChild(actions);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${song?.category || "unknown"} • ${songArtist(song)}${blocked ? " • Not playable" : ""}`;

    info.appendChild(meta);
    header.prepend(info);
    item.appendChild(header);

    item.addEventListener("click", () => {
      if (blocked) {
        setStatus("This category is visible but not playable.");
        return;
      }

      addToQueue(song);
      setStatus("Added to queue.");
    });

    fragment.appendChild(item);
  });

  resultsEl.appendChild(fragment);
}

function renderQueue() {
  queueEl.innerHTML = "";

  const fragment = document.createDocumentFragment();
  queue.forEach((song, index) => {
    const item = document.createElement("div");
    item.className = `item${index === currentIndex ? " active" : ""}`;

    const header = document.createElement("div");
    header.className = "item-header";

    const info = document.createElement("div");
    info.className = "item-info";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = `${index === currentIndex ? "▶ " : ""}${songDisplayName(song)}`;

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", "Remove from queue");
    removeBtn.setAttribute("title", "Remove from queue");
    removeBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await removeQueueIndex(index);
    });

    actions.appendChild(removeBtn);
    info.appendChild(title);
    header.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${song?.category || "unknown"} • ${songArtist(song)}`;

    info.appendChild(meta);
    header.prepend(info);
    item.appendChild(header);

    item.addEventListener("click", () => {
      playQueueIndex(index);
    });

    fragment.appendChild(item);
  });

  queueEl.appendChild(fragment);
}

function updateNowPlaying(song) {
  if (!song) {
    nowPlayingEl.textContent = "Nothing playing";
    nowPlayingArtistEl.textContent = "";
    nowPlayingArtEl.hidden = true;
    nowPlayingArtEl.removeAttribute("src");
    document.title = "JuicePlayer";
    updateMediaSession(null);
    return;
  }

  const title = songDisplayName(song);
  const artist = songArtist(song);
  const category = songCategory(song);
  nowPlayingEl.textContent = title;
  nowPlayingArtistEl.textContent = `${artist} · ${category}`;
  const artworkUrl = songArtworkUrl(song);
  if (artworkUrl) {
    nowPlayingArtEl.src = artworkUrl;
    nowPlayingArtEl.alt = `${title} artwork`;
    nowPlayingArtEl.hidden = false;
  } else {
    nowPlayingArtEl.hidden = true;
    nowPlayingArtEl.removeAttribute("src");
  }
  document.title = `${title} - ${artist} | JuicePlayer`;
  updateMediaSession(song);
}

function updatePlayPauseButton() {
  if (player.paused) {
    playPauseBtn.textContent = "▶";
    playPauseBtn.setAttribute("aria-label", "Play");
    playPauseBtn.setAttribute("title", "Play");
  } else {
    playPauseBtn.textContent = "⏸";
    playPauseBtn.setAttribute("aria-label", "Pause");
    playPauseBtn.setAttribute("title", "Pause");
  }
}

function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }

  const seconds = Math.floor(totalSeconds);
  const minutesPart = Math.floor(seconds / 60);
  const secondsPart = seconds % 60;
  return `${minutesPart}:${String(secondsPart).padStart(2, "0")}`;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[&+]/g, " and ")
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function songSearchText(song) {
  const fields = [
    song?.name,
    song?.original_key,
    song?.track_titles,
    song?.file_names
  ];

  return normalizeSearchText(fields.flat().join(" "));
}

function matchesNormalizedSearch(song, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return true;
  }

  const songText = songSearchText(song);
  return normalizedQuery.split(" ").every((term) => songText.includes(term));
}

async function fetchSongSearchPage(params, signal) {
  const cacheKey = params.toString();
  const cached = songPageCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SONG_CACHE_TTL_MS) {
    songPageCache.delete(cacheKey);
    songPageCache.set(cacheKey, cached);
    return cached.songs;
  }

  if (cached) {
    songPageCache.delete(cacheKey);
  }

  const activeRequest = inFlightSongRequests.get(cacheKey);
  if (activeRequest && !activeRequest.signal?.aborted) {
    return activeRequest.promise;
  }
  if (activeRequest) {
    inFlightSongRequests.delete(cacheKey);
  }

  const request = (async () => {
    const response = await fetch(`${API_BASE}/songs/?${cacheKey}`, { signal });
    if (!response.ok) {
      throw new Error(`Songs request failed with status ${response.status}`);
    }

    const data = await response.json();
    const songs = Array.isArray(data?.results) ? data.results : [];
    songPageCache.set(cacheKey, { createdAt: Date.now(), songs });

    while (songPageCache.size > MAX_SONG_CACHE_ENTRIES) {
      songPageCache.delete(songPageCache.keys().next().value);
    }

    return songs;
  })();

  const requestRecord = { promise: request, signal };
  inFlightSongRequests.set(cacheKey, requestRecord);
  try {
    return await request;
  } finally {
    if (inFlightSongRequests.get(cacheKey) === requestRecord) {
      inFlightSongRequests.delete(cacheKey);
    }
  }
}

async function fetchPunctuationFallback(query, baseParams, signal) {
  const normalizedQuery = normalizeSearchText(query);
  const terms = normalizedQuery
    .split(" ")
    .filter((term) => term.length >= 3)
    .sort((left, right) => right.length - left.length)
    .slice(0, 2);

  if (terms.length === 0) {
    return [];
  }

  const candidates = [];
  const seen = new Set();

  for (const term of terms) {
    const fallbackParams = new URLSearchParams(baseParams);
    fallbackParams.set("search", term);
    fallbackParams.set("page", "1");
    fallbackParams.set("page_size", "100");

    try {
      const songs = await fetchSongSearchPage(fallbackParams, signal);
      songs.forEach((song) => {
        const identity = getSongIdentity(song);
        if (!seen.has(identity)) {
          seen.add(identity);
          candidates.push(song);
        }
      });
    } catch (error) {
      console.debug("Search fallback request failed", error);
    }

    const matches = candidates.filter((song) => matchesNormalizedSearch(song, query));
    if (matches.length > 0) {
      return matches;
    }
  }

  return candidates.filter((song) => matchesNormalizedSearch(song, query));
}

function updateProgressDisplay() {
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;

  currentTimeEl.textContent = formatTime(currentTime);
  durationEl.textContent = formatTime(duration);

  if (duration > 0) {
    const progressPercent = (currentTime / duration) * 100;
    progressBar.value = String(progressPercent);
  } else {
    progressBar.value = "0";
  }

  updateMediaSessionPositionState();
}

function handlePlayerTimeUpdate() {
  updateProgressDisplay();
  prefetchNextRadioSongIfNeeded();
  maybeScrobbleCurrentTrack();
}

function resetProgressDisplay() {
  progressBar.value = "0";
  currentTimeEl.textContent = "0:00";
  durationEl.textContent = "0:00";
}

function addToQueue(song) {
  queue.push(song);
  renderQueue();

  if (currentIndex === -1) {
    playQueueIndex(0);
  }
}

function addToQueueOnly(song) {
  queue.push(song);
  renderQueue();
}

function addToQueueAndPlayNow(song) {
  queue.push(song);
  const newIndex = queue.length - 1;
  renderQueue();
  playQueueIndex(newIndex);
}

function clearQueue() {
  queue = [];
  currentIndex = -1;
  prefetchedRadioSong = null;
  radioPreloadAudio = null;
  currentTrackScrobbleState = null;

  player.pause();
  player.removeAttribute("src");
  player.load();

  renderQueue();
  updateNowPlaying(null);
  resetProgressDisplay();
  updatePlayPauseButton();
  setStatus("Queue cleared.");
}

async function removeQueueIndex(index) {
  if (index < 0 || index >= queue.length) {
    return;
  }

  const isRemovingCurrent = index === currentIndex;
  queue.splice(index, 1);

  if (queue.length === 0) {
    currentIndex = -1;
    currentTrackScrobbleState = null;
    prefetchedRadioSong = null;
    radioPreloadAudio = null;

    player.pause();
    player.removeAttribute("src");
    player.load();

    renderQueue();
    updateNowPlaying(null);
    resetProgressDisplay();
    updatePlayPauseButton();
    setStatus("Removed from queue.");
    return;
  }

  if (index < currentIndex) {
    currentIndex -= 1;
  }

  if (!isRemovingCurrent) {
    renderQueue();
    setStatus("Removed from queue.");
    return;
  }

  currentTrackScrobbleState = null;
  const nextIndex = Math.min(index, queue.length - 1);
  await playQueueIndex(nextIndex);
  setStatus("Removed from queue.");
}

async function playQueueIndex(index) {
  if (index < 0 || index >= queue.length) {
    return;
  }

  const song = queue[index];

  if (isBlockedSong(song)) {
    setStatus("Blocked category cannot be played.");
    return;
  }

  const streamUrl = songStreamUrl(song);
  if (!streamUrl) {
    setStatus("Selected song has no valid audio file path.");
    return;
  }

  currentIndex = index;
  currentTrackScrobbleState = buildTrackScrobbleState(song, index);
  player.src = streamUrl;
  resetProgressDisplay();
  updateNowPlaying(song);
  renderQueue();

  try {
    await player.play();
    submitLastFmNowPlaying(currentTrackScrobbleState);
    setStatus("");
  } catch (error) {
    setStatus("Unable to start playback.");
    console.error("Playback error", error);
  }

  updatePlayPauseButton();
}

async function playNext() {
  if (currentIndex + 1 < queue.length) {
    await playQueueIndex(currentIndex + 1);
    prefetchNextRadioSongIfNeeded(true);
    return;
  }

  if (isRadioMode) {
    await continueWithRadio();
  }
}

function playPrevious() {
  if (currentIndex - 1 >= 0) {
    playQueueIndex(currentIndex - 1);
  }
}

async function searchSongs() {
  if (activeSearchController) {
    activeSearchController.abort();
  }

  const controller = new AbortController();
  activeSearchController = controller;
  const requestId = currentSearchRequestId + 1;
  currentSearchRequestId = requestId;
  currentPage = 1;

  setLoading(true);
  setEmpty(false);
  setStatus("");
  setLoadMoreVisible(false);
  resultsEl.innerHTML = "";

  await fetchSongsPage(currentPage, false, controller.signal, requestId);
}

async function fetchSongsPage(page, append, signal, requestId = currentSearchRequestId) {
  const query = searchInput.value.trim();

  const params = new URLSearchParams({
    page: String(page),
    page_size: String(PAGE_SIZE)
  });

  if (query) {
    params.set("search", query);
  }

  if (selectedCategory) {
    params.set("category", selectedCategory);
  }

  try {
    let songs = await fetchSongSearchPage(params, signal);
    let usedSearchFallback = false;

    if (query && !append && songs.length === 0) {
      const fallbackSongs = await fetchPunctuationFallback(query, params, signal);
      if (fallbackSongs.length > 0) {
        songs = fallbackSongs;
        usedSearchFallback = true;
        setStatus("Showing close matches for your search.");
      }
    }

    if (requestId !== currentSearchRequestId || signal?.aborted) {
      return;
    }

    hasMoreResults = !usedSearchFallback && songs.length === PAGE_SIZE;
    setLoadMoreVisible(hasMoreResults);

    if (!append && songs.length === 0) {
      setEmpty(true);
      return;
    }

    renderResults(songs, append);
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted || requestId !== currentSearchRequestId) {
      return;
    }

    setStatus(append ? "Failed to load more songs." : "Failed to fetch songs.");
    if (!append) {
      setEmpty(true);
    }
    console.error("Search error", error);
  } finally {
    if (requestId === currentSearchRequestId && !signal?.aborted) {
      setLoading(false);
    }
  }
}

async function loadCategories() {
  categoryButtonsEl.innerHTML = "";

  const appendCategoryOption = (value, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category-option";
    button.dataset.value = value;
    button.textContent = label;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", value === selectedCategory ? "true" : "false");
    button.classList.toggle("active", value === selectedCategory);
    button.addEventListener("click", () => {
      selectedCategory = value;
      categoryButtonsEl.querySelectorAll(".category-option").forEach((option) => {
        const isActive = option.dataset.value === selectedCategory;
        option.classList.toggle("active", isActive);
        option.setAttribute("aria-checked", isActive ? "true" : "false");
      });
      categoryFilterEl.open = false;
      searchSongs();
    });
    categoryButtonsEl.appendChild(button);
  };

  appendCategoryOption("", "All Categories");

  if (categoriesCache) {
    categoriesCache.forEach((category) => {
      appendCategoryOption(category.value, category.label);
    });
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/categories/`);
    if (!response.ok) {
      throw new Error(`Categories request failed with status ${response.status}`);
    }

    const data = await response.json();
    const categories = Array.isArray(data?.categories) ? data.categories : [];
    categoriesCache = categories.filter((category) => category?.value && category?.label);

    categoriesCache.forEach((category) => {
      appendCategoryOption(category.value, category.label);
    });
  } catch (error) {
    setStatus("Failed to fetch categories.");
    console.error("Category error", error);
  }
}

searchBtn.addEventListener("click", searchSongs);
loadMoreBtn.addEventListener("click", async () => {
  if (!hasMoreResults || isLoadingMore || !activeSearchController) {
    return;
  }

  isLoadingMore = true;
  loadMoreBtn.disabled = true;
  currentPage += 1;
  setLoading(true);
  try {
    await fetchSongsPage(currentPage, true, activeSearchController.signal, currentSearchRequestId);
  } finally {
    isLoadingMore = false;
    loadMoreBtn.disabled = false;
  }
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    searchSongs();
  }
});

prevBtn.addEventListener("click", playPrevious);
nextBtn.addEventListener("click", playNext);
clearQueueBtn.addEventListener("click", clearQueue);
radioBtn.addEventListener("click", async () => {
  isRadioMode = !isRadioMode;
  updateRadioButton();
  setStatus(isRadioMode ? "Radio mode enabled." : "Radio mode disabled.");

  if (!isRadioMode) {
    prefetchedRadioSong = null;
    radioPreloadAudio = null;
    return;
  }

  const hasActiveTrack = currentIndex >= 0 && Boolean(player.src);
  if (hasActiveTrack) {
    return;
  }

  if (queue.length > 0) {
    await playQueueIndex(0);
    return;
  }

  await continueWithRadio();
});
queueBtn.addEventListener("click", () => {
  setQueueDrawerOpen(!queuePanel.classList.contains("open"));
});
queuePanelToggle.addEventListener("click", () => {
  setQueueDrawerOpen(false);
});

playPauseBtn.addEventListener("click", async () => {
  if (!player.src && queue.length > 0 && currentIndex === -1) {
    await playQueueIndex(0);
    return;
  }

  if (player.paused) {
    try {
      await player.play();
      submitLastFmNowPlaying(currentTrackScrobbleState);
    } catch (error) {
      setStatus("Unable to resume playback.");
      console.error("Play error", error);
    }
  } else {
    player.pause();
  }

  updatePlayPauseButton();
});

player.addEventListener("play", updatePlayPauseButton);
player.addEventListener("pause", updatePlayPauseButton);
player.addEventListener("timeupdate", handlePlayerTimeUpdate);
player.addEventListener("loadedmetadata", () => {
  updateProgressDisplay();
  submitLastFmNowPlaying(currentTrackScrobbleState);
});
player.addEventListener("durationchange", updateProgressDisplay);
player.addEventListener("ended", () => {
  playNext();
});

lastFmLoginBtn.addEventListener("click", async () => {
  try {
    const loginInit = await initializeLastFmLogin();
    currentLastFmFlowId = String(loginInit?.flowId || "");

    if (!currentLastFmFlowId || !loginInit?.authorizeUrl) {
      throw new Error("Missing flow id or authorize URL");
    }

    window.open(String(loginInit.authorizeUrl), "_blank");

    const shortFlowId = currentLastFmFlowId.slice(0, 8);
    setLastFmOutcomeMessage(`Waiting for Last.fm authorization in the new tab... (flow ${shortFlowId})`);
    startLastFmAuthPolling();
  } catch (error) {
    setLastFmOutcomeMessage("Failed to start Last.fm login. Check server and keys.", "error");
    console.error("Last.fm login-init error", error);
  }
});

lastFmLogoutBtn.addEventListener("click", async () => {
  try {
    await postLastFm("/logout", {});
    lastFmState.authenticated = false;
    lastFmState.username = null;
    currentLastFmFlowId = "";
    stopLastFmAuthPolling();
    isLastFmAuthPending = false;
    setLastFmOutcomeMessage("Disconnected from Last.fm.");
    updateLastFmUi();
    setStatus("Last.fm disconnected.");
  } catch (error) {
    setStatus("Failed to disconnect Last.fm.");
    console.error("Last.fm logout error", error);
  }
});

progressBar.addEventListener("input", () => {
  if (!Number.isFinite(player.duration) || player.duration <= 0) {
    return;
  }

  const nextTime = (Number(progressBar.value) / 100) * player.duration;
  if (Number.isFinite(nextTime)) {
    player.currentTime = nextTime;
    updateProgressDisplay();
  }
});

updateNowPlaying(null);
updatePlayPauseButton();
updateRadioButton();
resetProgressDisplay();
const authOutcome = new URLSearchParams(window.location.search).get("lastfm");
const authError = new URLSearchParams(window.location.search).get("lastfm_error");
if (authOutcome === "connected") {
  setStatus("Last.fm connected. Scrobbling is now active.");
  setLastFmOutcomeMessage("Connection successful. Scrobbling is active.", "success");
}
if (authOutcome === "failed") {
  setStatus("Last.fm login failed.");
  setLastFmOutcomeMessage(authError ? `Login failed: ${authError}` : "Login failed. Please try again.", "error");
}
if (authOutcome === "missing_token") {
  setStatus("Last.fm login did not return a token.");
  setLastFmOutcomeMessage("Last.fm did not return a token to the callback URL.", "error");
}

if (authOutcome) {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("lastfm");
  cleanUrl.searchParams.delete("lastfm_error");
  window.history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
}

window.addEventListener("focus", () => {
  refreshLastFmState();
});

window.addEventListener("message", handleLastFmAuthMessage);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshLastFmState();
  }
});

updateLastFmUi();
refreshLastFmState();
loadCategories().finally(() => {
  searchSongs();
});
