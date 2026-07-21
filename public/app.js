const state = {
  fileId: null,
  duration: 0,
  frameCount: 3,
  cuts: []
};

const uploadForm = document.querySelector("#uploadForm");
const videoInput = document.querySelector("#videoInput");
const frameCountInput = document.querySelector("#frameCount");
const dropZone = document.querySelector("#dropZone");
const fileName = document.querySelector("#fileName");
const statusPill = document.querySelector("#statusPill");
const editor = document.querySelector("#editor");
const downloads = document.querySelector("#downloads");
const timeline = document.querySelector("#timeline");
const markerList = document.querySelector("#markerList");
const durationLabel = document.querySelector("#durationLabel");
const detectionSummary = document.querySelector("#detectionSummary");
const uploadButton = document.querySelector("#uploadButton");
const splitButton = document.querySelector("#splitButton");
const downloadList = document.querySelector("#downloadList");
const zipLink = document.querySelector("#zipLink");

function setStatus(text, isError = false) {
  statusPill.textContent = text;
  statusPill.classList.toggle("error", isError);
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const remaining = safe - minutes * 60;
  return `${minutes}:${remaining.toFixed(3).padStart(6, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function expectedCuts() {
  return Math.max(1, state.frameCount - 1);
}

function normalizeCuts(cuts) {
  const count = expectedCuts();
  return [...cuts]
    .slice(0, count)
    .map((time) => clamp(Number(time) || 0, 0.05, state.duration - 0.05))
    .sort((a, b) => a - b);
}

function renderMarkers() {
  timeline.innerHTML = "";
  markerList.innerHTML = "";
  state.cuts = normalizeCuts(state.cuts);
  durationLabel.textContent = formatTime(state.duration);
  splitButton.disabled = state.cuts.length !== expectedCuts();

  state.cuts.forEach((cut, index) => {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "marker";
    marker.style.left = `${(cut / state.duration) * 100}%`;
    marker.setAttribute("aria-label", `Cut ${index + 1} at ${formatTime(cut)}`);
    marker.addEventListener("pointerdown", (event) => beginDrag(event, index));
    timeline.append(marker);

    const row = document.createElement("div");
    row.className = "marker-row";
    row.innerHTML = `<strong>Cut ${index + 1}</strong>`;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = String(state.duration);
    input.step = "0.001";
    input.value = cut.toFixed(3);
    input.addEventListener("input", () => {
      state.cuts[index] = clamp(Number(input.value), 0.05, state.duration - 0.05);
      renderMarkers();
    });
    const label = document.createElement("span");
    label.textContent = formatTime(cut);
    row.append(label, input);
    markerList.append(row);
  });

  for (let index = state.cuts.length; index < expectedCuts(); index += 1) {
    const row = document.createElement("div");
    row.className = "marker-row";
    row.innerHTML = `<strong>Cut ${index + 1}</strong><span>Click the timeline or enter seconds</span>`;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = String(state.duration);
    input.step = "0.001";
    input.placeholder = "seconds";
    input.addEventListener("change", () => {
      if (input.value === "") return;
      state.cuts.push(clamp(Number(input.value), 0.05, state.duration - 0.05));
      renderMarkers();
    });
    row.append(input);
    markerList.append(row);
  }
}

function beginDrag(event, index) {
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  const rect = timeline.getBoundingClientRect();

  function move(moveEvent) {
    const ratio = clamp((moveEvent.clientX - rect.left) / rect.width, 0, 1);
    state.cuts[index] = Number((ratio * state.duration).toFixed(3));
    renderMarkers();
  }

  function end() {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
  }

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end, { once: true });
}

function setFrameCount(value) {
  state.frameCount = clamp(Number.parseInt(value, 10) || 3, 2, 12);
  frameCountInput.value = state.frameCount;
  document.querySelectorAll(".preset").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.count) === state.frameCount);
  });
  if (state.duration) renderMarkers();
}

async function parseJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!videoInput.files[0]) return;

  setStatus("Detecting");
  uploadButton.disabled = true;
  downloads.hidden = true;

  try {
    const formData = new FormData(uploadForm);
    formData.set("frameCount", String(state.frameCount));
    const data = await fetch("/api/upload", {
      method: "POST",
      body: formData
    }).then(parseJsonResponse);

    state.fileId = data.fileId;
    state.duration = data.duration;
    state.frameCount = data.frameCount;
    state.cuts = normalizeCuts(data.cutTimestamps);
    detectionSummary.classList.remove("error");

    const missing = data.foundCuts < data.expectedCuts;
    const extra = data.candidateCount > data.expectedCuts;
    detectionSummary.textContent = missing
      ? `Found ${data.foundCuts} of ${data.expectedCuts} expected cuts. Place or nudge the remaining marker before splitting.`
      : extra
        ? `Found ${data.candidateCount} possible cuts and selected the strongest ${data.expectedCuts}. Review the markers before splitting.`
        : `Found ${data.foundCuts} expected cut${data.foundCuts === 1 ? "" : "s"}.`;

    editor.hidden = false;
    renderMarkers();
    setStatus("Review");
  } catch (err) {
    setStatus("Error", true);
    detectionSummary.textContent = err.message;
    detectionSummary.classList.add("error");
  } finally {
    uploadButton.disabled = false;
  }
});

timeline.addEventListener("click", (event) => {
  if (event.target.closest(".marker") || state.cuts.length >= expectedCuts()) return;
  const rect = timeline.getBoundingClientRect();
  const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  state.cuts.push(Number((ratio * state.duration).toFixed(3)));
  renderMarkers();
});

splitButton.addEventListener("click", async () => {
  setStatus("Splitting");
  splitButton.disabled = true;

  try {
    const data = await fetch("/api/split", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: state.fileId,
        cutTimestamps: state.cuts
      })
    }).then(parseJsonResponse);

    downloadList.innerHTML = "";
    data.files.forEach((file) => {
      const row = document.createElement("div");
      row.className = "download-row";
      row.innerHTML = `<strong>${file.name}</strong>`;
      const link = document.createElement("a");
      link.className = "secondary";
      link.href = file.url;
      link.textContent = "Download";
      row.append(link);
      downloadList.append(row);
    });
    zipLink.href = data.zipUrl;
    downloads.hidden = false;
    setStatus("Done");
  } catch (err) {
    setStatus("Error", true);
    alert(err.message);
  } finally {
    splitButton.disabled = false;
  }
});

videoInput.addEventListener("change", () => {
  fileName.textContent = videoInput.files[0]?.name || "or choose a file";
});

document.querySelectorAll(".preset").forEach((button) => {
  button.addEventListener("click", () => setFrameCount(button.dataset.count));
});

frameCountInput.addEventListener("input", () => setFrameCount(frameCountInput.value));

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
});

dropZone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  videoInput.files = transfer.files;
  fileName.textContent = file.name;
});
