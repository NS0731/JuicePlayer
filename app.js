const API_BASE = "/api/juicewrld";
const BLOCKED_CATEGORIES = new Set(["unsurfaced", "recording_session"]);

const searchInput = document.getElementById("searchInput");
const categoryButtonsEl = document.getElementById("categoryButtons");
const searchBtn = document.getElementById("searchBtn");
const loadMoreBtn = document.getElementById("loadMoreBtn");
const loadingEl = document.getElementById("loading");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const queueEl = document.getElementById("queue");
const nowPlayingEl = document.getElementById("nowPlaying");
const progressBar = document.getElementById("progressBar");
const currentTimeEl = document.getElementById("currentTime");
const durationEl = document.getElementById("duration");

const prevBtn = document.getElementById("prevBtn");
const playPauseBtn = document.getElementById("playPauseBtn");
const nextBtn = document.getElementById("nextBtn");
const radioBtn = document.getElementById("radioBtn");
const player = document.getElementById("player");

const PAGE_SIZE = 20;

let queue = [];
let currentIndex = -1;
let selectedCategory = "";
let currentPage = 1;
let hasMoreResults = false;
let isRadioMode = false;
let isFetchingRadioSong = false;

function setLoading(isLoading) {
  loadingEl.style.display = isLoading ? "block" : "none";
}

function setEmpty(show) {
  emptyEl.style.display = show ? "block" : "none";
}

function setStatus(message) {
  statusEl.textContent = message || "";
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

function radioSearchTerm() {
  const currentSong = queue[currentIndex];
  const source = songDisplayName(currentSong || null);
  const words = source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);

  if (words.length > 0) {
    return words.join(" ");
  }

  return searchInput.value.trim();
}

function radioCategory() {
  if (selectedCategory && !BLOCKED_CATEGORIES.has(selectedCategory)) {
    return selectedCategory;
  }

  const currentSongCategory = queue[currentIndex]?.category;
  if (currentSongCategory && !BLOCKED_CATEGORIES.has(currentSongCategory)) {
    return currentSongCategory;
  }

  return "";
}

async function fetchRadioSong() {
  const searchTerm = radioSearchTerm();
  const category = radioCategory();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const params = new URLSearchParams({
      page: String(Math.floor(Math.random() * 120) + 1),
      page_size: String(PAGE_SIZE)
    });

    if (category) {
      params.set("category", category);
    }

    if (searchTerm && attempt < 3) {
      params.set("search", searchTerm);
    }

    try {
      const response = await fetch(`${API_BASE}/songs/?${params.toString()}`);
      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      const songs = Array.isArray(data?.results) ? data.results : [];
      const candidate = songs.find(
        (song) => !isBlockedSong(song) && Boolean(getSongFilePath(song)) && !queueContainsSong(song)
      );

      if (candidate) {
        return candidate;
      }
    } catch (error) {
      console.error("Radio fetch error", error);
    }
  }

  return null;
}

async function continueWithRadio() {
  if (!isRadioMode || isFetchingRadioSong) {
    return;
  }

  isFetchingRadioSong = true;
  setStatus("Radio mode is finding the next song...");

  try {
    const song = await fetchRadioSong();
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

function setLoadMoreVisible(show) {
  loadMoreBtn.style.display = show ? "block" : "none";
}

function renderResults(songs, append = false) {
  if (!append) {
    resultsEl.innerHTML = "";
  }

  songs.forEach((song) => {
    const blocked = isBlockedSong(song);

    const item = document.createElement("div");
    item.className = `item${blocked ? " blocked" : ""}`;

    const header = document.createElement("div");
    header.className = "item-header";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = songDisplayName(song);

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.textContent = "Download";
    downloadBtn.disabled = blocked || !getSongFilePath(song);
    downloadBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      downloadSong(song);
    });

    actions.appendChild(downloadBtn);
    header.appendChild(title);
    header.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${song?.category || "unknown"} • ${songArtist(song)}${blocked ? " • Not playable" : ""}`;

    item.appendChild(header);
    item.appendChild(meta);

    item.addEventListener("click", () => {
      if (blocked) {
        setStatus("This category is visible but not playable.");
        return;
      }

      addToQueue(song);
      setStatus("Added to queue.");
    });

    resultsEl.appendChild(item);
  });
}

function renderQueue() {
  queueEl.innerHTML = "";

  queue.forEach((song, index) => {
    const item = document.createElement("div");
    item.className = `item${index === currentIndex ? " active" : ""}`;

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = `${index === currentIndex ? "▶ " : ""}${songDisplayName(song)}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${song?.category || "unknown"} • ${songArtist(song)}`;

    item.appendChild(title);
    item.appendChild(meta);

    item.addEventListener("click", () => {
      playQueueIndex(index);
    });

    queueEl.appendChild(item);
  });
}

function updateNowPlaying(song) {
  nowPlayingEl.textContent = song ? `Now Playing: ${songDisplayName(song)}` : "Now Playing: Nothing";
}

function updatePlayPauseButton() {
  playPauseBtn.textContent = player.paused ? "Play" : "Pause";
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
  player.src = streamUrl;
  resetProgressDisplay();
  updateNowPlaying(song);
  renderQueue();

  try {
    await player.play();
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
  currentPage = 1;

  setLoading(true);
  setEmpty(false);
  setStatus("");
  setLoadMoreVisible(false);
  resultsEl.innerHTML = "";

  await fetchSongsPage(currentPage, false);
}

async function fetchSongsPage(page, append) {
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
    const response = await fetch(`${API_BASE}/songs/?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Songs request failed with status ${response.status}`);
    }

    const data = await response.json();
    const songs = Array.isArray(data?.results) ? data.results : [];

    hasMoreResults = songs.length === PAGE_SIZE;
    setLoadMoreVisible(hasMoreResults);

    if (!append && songs.length === 0) {
      setEmpty(true);
      return;
    }

    renderResults(songs, append);
  } catch (error) {
    setStatus(append ? "Failed to load more songs." : "Failed to fetch songs.");
    if (!append) {
      setEmpty(true);
    }
    console.error("Search error", error);
  } finally {
    setLoading(false);
  }
}

async function loadCategories() {
  categoryButtonsEl.innerHTML = "";

  const createCategoryButton = (value, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category-btn";
    button.dataset.value = value;
    button.textContent = label;

    if (value === selectedCategory) {
      button.classList.add("active");
    }

    button.addEventListener("click", () => {
      selectedCategory = value;
      const buttons = categoryButtonsEl.querySelectorAll(".category-btn");
      buttons.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.value === selectedCategory);
      });
      searchSongs();
    });

    return button;
  };

  categoryButtonsEl.appendChild(createCategoryButton("", "All Categories"));

  try {
    const response = await fetch(`${API_BASE}/categories/`);
    if (!response.ok) {
      throw new Error(`Categories request failed with status ${response.status}`);
    }

    const data = await response.json();
    const categories = Array.isArray(data?.categories) ? data.categories : [];

    categories.forEach((category) => {
      if (!category?.value || !category?.label) {
        return;
      }

      categoryButtonsEl.appendChild(createCategoryButton(category.value, category.label));
    });
  } catch (error) {
    setStatus("Failed to fetch categories.");
    console.error("Category error", error);
  }
}

searchBtn.addEventListener("click", searchSongs);
loadMoreBtn.addEventListener("click", async () => {
  if (!hasMoreResults) {
    return;
  }

  currentPage += 1;
  setLoading(true);
  await fetchSongsPage(currentPage, true);
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    searchSongs();
  }
});

prevBtn.addEventListener("click", playPrevious);
nextBtn.addEventListener("click", playNext);
radioBtn.addEventListener("click", () => {
  isRadioMode = !isRadioMode;
  updateRadioButton();
  setStatus(isRadioMode ? "Radio mode enabled." : "Radio mode disabled.");
});

playPauseBtn.addEventListener("click", async () => {
  if (!player.src && queue.length > 0 && currentIndex === -1) {
    await playQueueIndex(0);
    return;
  }

  if (player.paused) {
    try {
      await player.play();
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
player.addEventListener("timeupdate", updateProgressDisplay);
player.addEventListener("loadedmetadata", updateProgressDisplay);
player.addEventListener("durationchange", updateProgressDisplay);
player.addEventListener("ended", () => {
  playNext();
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
loadCategories();