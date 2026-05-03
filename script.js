/**
 * script.js — Browser-based STFT Spectrogram Viewer
 *
 * Pipeline:
 *   1. User selects audio file
 *   2. loadAudio()       — decode with Web Audio API, convert mono
 *   3. computeSTFT()     — frame → window → FFT (fft.js) → magnitude²
 *   4. renderSpectrogram() — paint power matrix onto an HTML5 Canvas
 *
 * Parameters are intentionally kept in a single CONFIG object so they can
 * be wired to UI controls or made user-configurable.
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — single place to tune STFT parameters
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  maxDurationSec: 10,       // kept for reference; recording no longer auto-stops at this limit
  targetSampleRate: 48000,  // desired analysis sample rate (audio resampled if different)
  frameSize: 256,           // FFT window length (must be power of 2)
  hopSize: 128,             // samples between successive frames
  windowType: "hamming",    // default window function
  startTime: 0,             // seconds into the audio to begin analysis
  segmentDuration: 10,      // seconds of audio to analyse
  pxPerSec: 150,            // horizontal scale: canvas pixels per second
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM references
// ─────────────────────────────────────────────────────────────────────────────
const audioInput      = document.getElementById("audioInput");
const fileBtn         = document.getElementById("fileBtn");      // visible Browse button
const fileNameDisplay = document.getElementById("fileNameDisplay");
const processBtn      = document.getElementById("processBtn");
const playBtn         = document.getElementById("playBtn");       // play / stop
// Free-form number inputs — validation is deferred to the computation layer
const sampleRateInput  = document.getElementById("sampleRate");
const frameSizeInput  = document.getElementById("frameSize");
const hopSizeInput    = document.getElementById("hopSize");
const windowSelect    = document.getElementById("windowType");
const startTimeInput  = document.getElementById("startTime");
const segDurationInput = document.getElementById("segDuration");
const timeScaleInput   = document.getElementById("timeScale");
const timeScaleValue   = document.getElementById("timeScaleValue");
// Read-only metadata display (populated after Run decodes the file)
const infoDuration    = document.getElementById("infoDuration");
const infoSampleRate  = document.getElementById("infoSampleRate");
const statusBar       = document.getElementById("statusBar");
const statusText      = document.getElementById("statusText");
const canvas          = document.getElementById("spectrogramCanvas");
const cursorCanvas    = document.getElementById("cursorCanvas");   // cursor overlay
const zoomCanvas      = document.getElementById("zoomCanvas");     // zoom rectangle overlay
// Grid panels — spectroGrid is hidden until first render
const spectroGrid     = document.getElementById("spectroGrid");
const spectroArea     = document.getElementById("spectroArea");    // spectrogram cell
const spectroScrollArea = document.getElementById("spectroScrollArea"); // horizontal scroll wrapper
const xAxisDiv        = document.getElementById("xAxisDiv");
const yAxisDiv        = document.getElementById("yAxisDiv");
const colorbarCanvas  = document.getElementById("colorbarCanvas");
const canvasWrapper   = document.getElementById("canvasWrapper");
const placeholder     = document.getElementById("placeholder");
const sidebarToggle   = document.getElementById("sidebarToggle");  // collapse button
const resetZoomBtn          = document.getElementById("resetZoomBtn");           // zoom reset button
const scrollModeBtn         = document.getElementById("scrollModeBtn");          // scroll/zoom toggle
const spectroCustomScrollbar = document.getElementById("spectroCustomScrollbar"); // custom scrollbar track
const spectroCustomThumb    = document.getElementById("spectroCustomThumb");     // custom scrollbar thumb
const collapseHint          = document.getElementById("collapseHint");           // mobile post-Run hint
const appEl                 = document.getElementById("app");                    // root grid element
// Microphone recording controls
const startRecBtn  = document.getElementById("startRecBtn");
const stopRecBtn   = document.getElementById("stopRecBtn");
const saveRecBtn   = document.getElementById("saveRecBtn");
const recStatus    = document.getElementById("recStatus");
const recTimer     = document.getElementById("recTimer");
// Comparison mode controls
const comparisonModeSelect  = document.getElementById("comparisonMode");
// Side-by-side container and its sub-elements
const sbsContainer      = document.getElementById("sbsContainer");
const sbsMain           = document.getElementById("sbsMain");
const sbsScrollModeBtn  = document.getElementById("sbsScrollModeBtn");
const sbsPanelsRow      = document.getElementById("sbsPanelsRow");
const sbsYAxisDiv       = document.getElementById("sbsYAxisDiv");
const sbsYAxisWrapper   = document.getElementById("sbsYAxisWrapper");
const sbsXAxisDiv       = document.getElementById("sbsXAxisDiv");
const sbsXAxisWrapper   = document.getElementById("sbsXAxisWrapper");
const sbsColorbarCanvas = document.getElementById("sbsColorbarCanvas");
const sbsCustomScrollbar = document.getElementById("sbsCustomScrollbar");
const sbsCustomThumb    = document.getElementById("sbsCustomThumb");
// NodeList of the 4 .sbs-panel divs (in DOM order: rectangular, hann, hamming, blackman)
const sbsPanels = document.querySelectorAll(".sbs-panel");
// Per-panel scroll containers — one per spectrogram panel, synchronized via JS
const sbsPanelScrolls = document.querySelectorAll(".sbs-panel-scroll");
const ctx2d           = canvas.getContext("2d");
const cursorCtx       = cursorCanvas.getContext("2d");
const zoomCtx         = zoomCanvas.getContext("2d");

// ─────────────────────────────────────────────────────────────────────────────
// Audio decode state
// ─────────────────────────────────────────────────────────────────────────────
let monoSamples = null;
let sampleRate  = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Zoom / view state
// fullDbMatrix  — the complete dB matrix from the last Run; retained so that
//                 zoom can re-render any sub-region without re-running STFT.
// viewState     — currently displayed sub-region in frame / bin index space.
//                 null until first successful render.
// ─────────────────────────────────────────────────────────────────────────────
let fullDbMatrix  = null;
let viewState     = null;  // { frameStart, frameEnd, binStart, binEnd }
// Side-by-side mode: one dB matrix per window type.
let fullDbMatrices = null;  // { rectangular, hann, hamming, blackman } | null

// ─────────────────────────────────────────────────────────────────────────────
// Playback state
// ─────────────────────────────────────────────────────────────────────────────
// A single AudioContext is shared for both decoding and playback.
// Creating a new context per action is wasteful and can hit browser limits.
let audioCtx       = null;
// The decoded, trimmed, mono AudioBuffer — ready to hand to a source node.
let playbackBuffer = null;
// Duration of the audio that was STFT'd (may be < full file if > 10 s).
let audioDuration  = 0;
// Current AudioBufferSourceNode while playing (null when idle).
let sourceNode     = null;
// audioCtx.currentTime recorded at the moment playback started.
let playStartTime  = 0;
// Whether a source node is currently scheduled to play.
let isPlaying      = false;
// requestAnimationFrame handle for the cursor loop.
let rafId          = null;

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar collapse / expand
// ─────────────────────────────────────────────────────────────────────────────
// Returns the right glyph pair for the collapse/expand toggle.
// Desktop: « (expanded) / » (collapsed) — pointing left/right toward the sidebar.
// Mobile:  ▲ (expanded) / ▼ (collapsed) — pointing up/down along the stacked layout.
function sidebarGlyph(isCollapsed) {
  const mobile = window.matchMedia("(max-width: 640px)").matches;
  if (mobile) return isCollapsed ? "\u25BC" : "\u25B2";  // ▼ / ▲
  return isCollapsed ? "\xBB" : "\xAB";  // » / «
}

function applySidebarGlyph(isCollapsed) {
  sidebarToggle.textContent = sidebarGlyph(isCollapsed);
  sidebarToggle.title = isCollapsed ? "Expand sidebar" : "Collapse sidebar";
}

function expandSidebar() {
  appEl.classList.remove("sidebar-collapsed");
  applySidebarGlyph(false);
}

sidebarToggle.addEventListener("click", () => {
  const isCollapsed = appEl.classList.toggle("sidebar-collapsed");
  applySidebarGlyph(isCollapsed);
  if (isCollapsed) collapseHint.classList.add("hidden");
});

// Update glyph when orientation/resize crosses the 640px breakpoint
window.addEventListener("resize", () => {
  applySidebarGlyph(appEl.classList.contains("sidebar-collapsed"));
});

// ─────────────────────────────────────────────────────────────────────────────
// ResizeObserver — re-render axes whenever the spectrogram grid changes size
//
// The axis canvases read clientWidth/clientHeight at render time.  Without
// this observer, collapsing the sidebar or rotating the device changes the
// available layout space but the axes keep their stale pixel dimensions,
// making ticks stretch or compress instead of reflow.
// A 60 ms debounce avoids re-rendering during every frame of a CSS transition.
// ─────────────────────────────────────────────────────────────────────────────
let resizeRafId = null;
let resizeRenderPending = false;  // guard against ResizeObserver feedback loop
const gridResizeObserver = new ResizeObserver(() => {
  if (!fullDbMatrix && !fullDbMatrices) return;  // nothing rendered yet
  if (resizeRenderPending) return;               // rendering caused this — skip
  // Cancel any pending frame — we only need one re-render at the end
  // of a batch of resize events.
  if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
  // requestAnimationFrame fires after the next complete layout pass,
  // ensuring getBoundingClientRect() in renderAxes reads settled sizes.
  resizeRafId = requestAnimationFrame(() => {
    resizeRafId = null;
    resizeRenderPending = true;
    if (fullDbMatrices && comparisonModeSelect.value === "sidebyside") {
      renderSideBySide();
    } else if (fullDbMatrix) {
      renderCurrentView();
      renderColorbar();
    }
    // Clear flag after browser has a chance to flush any layout changes
    // caused by the render (canvas attribute changes etc.).
    requestAnimationFrame(() => { resizeRenderPending = false; });
  });
});
gridResizeObserver.observe(spectroGrid);
gridResizeObserver.observe(sbsContainer);

document.querySelectorAll(".section-icon-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    if (action === "run") {
      if (!processBtn.disabled) { processBtn.click(); }
      else { expandSidebar(); }
    } else if (action === "play") {
      if (!playBtn.disabled) { playBtn.click(); }
      else { expandSidebar(); }
    } else {
      expandSidebar();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Comparison mode framework
// ─────────────────────────────────────────────────────────────────────────────
/**
 * handleComparisonMode() — apply UI state for the currently selected mode.
 *
 * Two modes exist:
 *   "single"     — One spectrogram.  Uses the main windowType selector.
 *   "sidebyside" — 2×2 grid of all four windows.  The main window selector is
 *                  irrelevant (all four are computed automatically), so it
 *                  is disabled.
 *
 * Disabling controls that are irrelevant for the current mode prevents the
 * user from making changes that have no effect, which would be confusing.
 * The controls are re-enabled immediately when the mode changes back.
 */
function handleComparisonMode() {
  const mode = comparisonModeSelect.value;

  // Main window type selector: irrelevant in side-by-side (all four shown).
  const mainWindowRelevant = mode === "single";
  windowSelect.disabled = !mainWindowRelevant;

  // Show/hide the appropriate display container when switching modes.
  // Only switch visibility if data has already been rendered; otherwise
  // both containers stay hidden (placeholder is shown) until the next Run.
  if (fullDbMatrix || fullDbMatrices) {
    const isSbs = mode === "sidebyside";
    spectroGrid.classList.toggle("hidden", isSbs);
    sbsContainer.classList.toggle("hidden", !isSbs);
    // Re-render if the visible container has data matching the selected mode
    if (isSbs && fullDbMatrices) {
      renderSideBySide();
    } else if (!isSbs && fullDbMatrix) {
      renderCurrentView();
      renderColorbar();
    }
  }
}

// Apply on load (mode defaults to "single") and whenever the user changes it.
handleComparisonMode();
comparisonModeSelect.addEventListener("change", handleComparisonMode);

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────────────────────────────────────

// The visible "Browse…" button triggers the hidden native file input
fileBtn.addEventListener("click", () => audioInput.click());

audioInput.addEventListener("change", () => {
  const file = audioInput.files[0];
  if (!file) return;
  fileNameDisplay.textContent = file.name;
  fileNameDisplay.classList.add("selected");
  processBtn.disabled = false;
  // Stop any active playback and reset cursor before loading a new file
  stopPlayback(true);
  playBtn.disabled = true;
  monoSamples = null;
  playbackBuffer = null;
  hideStatus();
  clearCanvas();
  spectroGrid.classList.add("hidden");
  placeholder.classList.remove("hidden");
});

processBtn.addEventListener("click", async () => {
  const file = audioInput.files[0];
  // Allow re-running with recorded audio (no file selected) if monoSamples
  // is already in memory from a previous recording.
  if (!file && !monoSamples) return;

  // Read current UI parameters into CONFIG.
  // Values are NOT clamped here — invalid inputs (NaN, non-power-of-2, etc.)
  // are caught and reported by the computation layer (prepareSegment /
  // computeSTFT), keeping all validation logic in one place.
  readConfigFromUI();

  processBtn.disabled = true;

  try {
    if (file) {
      // ── Step 1: decode (file path only) ──────────────────────────────────
      showStatus("Decoding audio…", false);
      monoSamples = await loadAudio(file);
    }
    // else: monoSamples already populated from recording — reuse as-is.

    // ── Steps 2–5: shared with mic path ─────────────────────────────────────
    await runPipelineFromSamples();
  } catch (err) {
    showStatus(`Error: ${err.message}`, true);
    console.error(err);
  } finally {
    processBtn.disabled = false;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// readConfigFromUI — read all STFT parameters from the sidebar into CONFIG
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Copies the current sidebar control values into the global CONFIG object.
 * Called by both the file Run button and the mic recording path so that both
 * input sources respect the same user-selected STFT parameters.
 */
function readConfigFromUI() {
  CONFIG.targetSampleRate = Math.max(1, parseInt(sampleRateInput.value, 10) || 48000);
  CONFIG.frameSize       = parseInt(frameSizeInput.value,   10);
  CONFIG.hopSize         = parseInt(hopSizeInput.value,     10);
  CONFIG.windowType      = windowSelect.value;
  CONFIG.startTime       = parseFloat(startTimeInput.value);
  CONFIG.segmentDuration = parseFloat(segDurationInput.value);
  CONFIG.pxPerSec        = Math.max(10, parseInt(timeScaleInput.value, 10) || 150);
}

// ─────────────────────────────────────────────────────────────────────────────
// runPipelineFromSamples — shared STFT pipeline (file upload AND mic recording)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Runs the complete STFT → render pipeline starting from already-decoded audio.
 *
 * This is the SINGLE processing path shared by both file upload and microphone
 * recording.  By funnelling both inputs here we guarantee identical STFT
 * parameters, the same normalization, and the same rendering for both sources.
 *
 * Preconditions (callers must satisfy):
 *   - global `monoSamples` is a mono Float32Array of PCM samples
 *   - global `sampleRate` (Hz) matches those samples
 *   - global `audioCtx` is an open AudioContext
 *   - CONFIG fields have been populated (via readConfigFromUI or equivalent)
 *
 * Pipeline:
 *   metadata display → prepareSegment → build playbackBuffer →
 *   computeSTFT → computeSpectrogram → render → enable playback
 *
 * Errors bubble up to the caller's try/catch.
 */
async function runPipelineFromSamples() {
  // Display audio metadata now that duration and sample rate are known.
  // The user needs these values to set sensible startTime / segmentDuration.
  infoDuration.textContent   = (monoSamples.length / sampleRate).toFixed(3);
  infoSampleRate.textContent = sampleRate;

  showStatus("Computing STFT…", false);

  // ── Step 2: slice segment ─────────────────────────────────────────────────
  // Extract the requested analysis window from the loaded samples.
  // prepareSegment() validates against the full original audio length so
  // the user can freely adjust startTime / segmentDuration after Run.
  const segment = prepareSegment(
    monoSamples,
    CONFIG.startTime,
    CONFIG.segmentDuration,
    sampleRate,
  );

  // Build the playback buffer from the analyzed segment so playback always
  // matches the currently displayed spectrogram.
  const segLen   = segment.length;
  playbackBuffer = audioCtx.createBuffer(1, segLen, sampleRate);
  playbackBuffer.getChannelData(0).set(segment);
  audioDuration  = segLen / sampleRate;

  // ── Step 3: STFT ─────────────────────────────────────────────────────────
  // Yield first so the status label paints before the CPU-bound work starts.
  await yieldToUI();

  const mode = comparisonModeSelect.value;

  if (mode === "sidebyside") {
    // ── Side-by-side: compute STFT for all four window types ──────────────
    const windowTypes = ["rectangular", "hann", "hamming", "blackman"];
    fullDbMatrices = {};
    for (const wt of windowTypes) {
      const pm = computeSTFT(segment, { ...CONFIG, windowType: wt });
      fullDbMatrices[wt] = computeSpectrogram(pm);
      await yieldToUI();
    }

    // Use any matrix to establish the shared view state (all have same dims)
    const ref = fullDbMatrices["hann"];
    const numFrames = ref.length;
    const numBins   = CONFIG.frameSize / 2 + 1;
    viewState = { frameStart: 0, frameEnd: numFrames, binStart: 0, binEnd: numBins };
    fullDbMatrix = null;  // clear single-mode state

    showStatus("Rendering spectrograms…", false);
    await yieldToUI();

    placeholder.classList.add("hidden");
    spectroGrid.classList.add("hidden");
    sbsContainer.classList.remove("hidden");

    updateSbsWidth();
    renderSideBySide();

  } else {
    // ── Single mode ───────────────────────────────────────────────────────
    const powerMatrix = computeSTFT(segment, CONFIG);

    // ── Step 4: convert power → dB, normalize, clip ───────────────────────
    const dbMatrix = computeSpectrogram(powerMatrix);

    showStatus("Rendering spectrogram…", false);
    await yieldToUI();

    // ── Step 5: render ────────────────────────────────────────────────────
    renderSpectrogram(dbMatrix, canvas, ctx2d);

    // Show the spectroGrid (reveals axes, colorbar, spectrogram) now that
    // data is painted.  Axes canvases must be visible before clientWidth is
    // read, otherwise they report 0 dimensions.
    placeholder.classList.add("hidden");
    spectroGrid.classList.remove("hidden");
    sbsContainer.classList.add("hidden");

    // Store the full result so zoom can re-render any sub-region.
    fullDbMatrix = dbMatrix;
    fullDbMatrices = null;  // clear sbs state
    const numFrames = dbMatrix.length;
    const numBins   = CONFIG.frameSize / 2 + 1;
    viewState = { frameStart: 0, frameEnd: numFrames, binStart: 0, binEnd: numBins };
    resetZoomBtn.classList.add("hidden");

    // Set the horizontal canvas width from the time scale before drawing axes.
    updateSpectroWidth();

    // Draw calibrated axes and colorbar now that the grid is laid out.
    const tEnd    = CONFIG.startTime + (numFrames * CONFIG.hopSize) / sampleRate;
    const nyquist = sampleRate / 2;
    renderAxes(CONFIG.startTime, tEnd, 0, nyquist);
    renderColorbar();
  }

  // Enable playback now that we have a rendered spectrogram and playbackBuffer
  playBtn.disabled = false;
  scrollModeBtn.classList.remove("hidden");  // show scroll/zoom toggle
  // Show the collapse hint on mobile (CSS hides it on desktop)
  if (window.matchMedia("(max-width: 640px)").matches) {
    collapseHint.classList.remove("hidden");
  }
  hideStatus();

  // Refresh window-function visualization after each Run so the plot always
  // uses the same frame size that was actually used for the STFT.
  renderWindowPanel();
}

// Tapping the collapse hint collapses the sidebar (same as pressing the toggle)
collapseHint.addEventListener("click", () => {
  appEl.classList.add("sidebar-collapsed");
  applySidebarGlyph(true);
  collapseHint.classList.add("hidden");
});

// ─────────────────────────────────────────────────────────────────────────────
// Scroll / Zoom mode toggle
// When scroll mode is active the zoom canvas is transparent to pointer/touch
// events so swipes fall through to the scroll container beneath it.
// ─────────────────────────────────────────────────────────────────────────────
let sbsScrollModeActive = false;

sbsScrollModeBtn.addEventListener("click", () => {
  sbsScrollModeActive = !sbsScrollModeActive;
  if (sbsScrollModeActive) {
    document.querySelectorAll(".sbs-zoom-canvas").forEach((c) => {
      c.style.pointerEvents = "none";
    });
    sbsScrollModeBtn.textContent = "\u{1F50D} Zoom mode: tap to scroll";
    sbsScrollModeBtn.classList.add("active");
  } else {
    document.querySelectorAll(".sbs-zoom-canvas").forEach((c) => {
      c.style.pointerEvents = "";
    });
    sbsScrollModeBtn.textContent = "\u21D4 Scroll mode: tap to drag-zoom";
    sbsScrollModeBtn.classList.remove("active");
  }
});

let scrollModeActive = false;

scrollModeBtn.addEventListener("click", () => {
  scrollModeActive = !scrollModeActive;
  if (scrollModeActive) {
    zoomCanvas.style.pointerEvents = "none";
    scrollModeBtn.textContent = "\u{1F50D} Zoom";
    scrollModeBtn.classList.add("active");
    scrollModeBtn.title = "Switch to zoom mode";
    // Clear any in-progress zoom rectangle
    if (isZooming) {
      isZooming = false;
      document.removeEventListener("mousemove", onZoomMove);
      document.removeEventListener("mouseup",   onZoomEnd);
      zoomCtx.clearRect(0, 0, zoomCanvas.width, zoomCanvas.height);
    }
  } else {
    zoomCanvas.style.pointerEvents = "";
    scrollModeBtn.textContent = "\u21D4 Scroll";
    scrollModeBtn.classList.remove("active");
    scrollModeBtn.title = "Switch to scroll mode";
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Play button toggle
// ─────────────────────────────────────────────────────────────────────────────
playBtn.addEventListener("click", () => {
  if (isPlaying) {
    stopPlayback(true);
  } else {
    startPlayback();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Utility: yield to the browser for one paint cycle
// ─────────────────────────────────────────────────────────────────────────────
function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar helpers
// ─────────────────────────────────────────────────────────────────────────────
function showStatus(msg, isError) {
  statusText.textContent = msg;
  statusBar.classList.remove("hidden", "error");
  if (isError) statusBar.classList.add("error");
}

function hideStatus() {
  statusBar.classList.add("hidden");
}

// ─────────────────────────────────────────────────────────────────────────────
// clearCanvas — blank the canvas element
// ─────────────────────────────────────────────────────────────────────────────
function clearCanvas() {
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width  = 0;
  canvas.height = 0;
}

// =============================================================================
// 1. loadAudio(file) → Float32Array (mono, trimmed)
// =============================================================================
/**
 * Decodes an audio File object using the Web Audio API and returns a mono
 * Float32Array (full duration).
 *
 * Steps:
 *   a. Read the File as an ArrayBuffer via FileReader
 *   b. Decode PCM with AudioContext.decodeAudioData()
 *   c. Average all channels into one mono channel
 *   d. Mix channels to mono
 *
 * @param {File} file - Audio file selected by the user
 * @returns {Promise<Float32Array>}
 */
async function loadAudio(file) {
  // ── a. Read file bytes ────────────────────────────────────────────────────
  const arrayBuffer = await readFileAsArrayBuffer(file);

  // ── b. Decode PCM ─────────────────────────────────────────────────────────
  // Reuse the module-level AudioContext. Creating a fresh context per file is
  // wasteful and browsers limit how many concurrent contexts exist.
  // The context is created here (during a user-gesture handler) to satisfy the
  // browser autoplay policy.
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  const nativeSampleRate = decoded.sampleRate;

  // ── b2. Resample to the user-selected target rate if necessary ────────────
  // OfflineAudioContext resamples by rendering at the desired sample rate.
  // The output length is scaled proportionally.
  let sourceBuf = decoded;
  if (nativeSampleRate !== CONFIG.targetSampleRate) {
    const resampledLength = Math.ceil(decoded.length * CONFIG.targetSampleRate / nativeSampleRate);
    const offlineCtx = new OfflineAudioContext(
      decoded.numberOfChannels,
      resampledLength,
      CONFIG.targetSampleRate,
    );
    const src = offlineCtx.createBufferSource();
    src.buffer = decoded;
    src.connect(offlineCtx.destination);
    src.start(0);
    sourceBuf = await offlineCtx.startRendering();
  }

  sampleRate = CONFIG.targetSampleRate;

  // ── c. Mix to mono ────────────────────────────────────────────────────────
  const numChannels = sourceBuf.numberOfChannels;
  const length      = sourceBuf.length;
  const mono        = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = sourceBuf.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i];
    }
  }
  if (numChannels > 1) {
    for (let i = 0; i < length; i++) mono[i] /= numChannels;
  }

  return mono;
}

/**
 * Wraps the legacy FileReader callback API in a Promise.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve(e.target.result);
    reader.onerror = ()  => reject(new Error("FileReader failed"));
    reader.readAsArrayBuffer(file);
  });
}

// =============================================================================
// 1b. prepareSegment(samples, startTime, segmentDuration, fs) → Float32Array
// =============================================================================
/**
 * Slices a raw mono PCM array to the analysis window defined by the UI.
 *
 * Validation is performed HERE (the computation layer) rather than in the UI
 * event handler. This means the UI collects raw user input and forwards it
 * unchanged; any out-of-range or non-finite value surfaces as a readable error
 * message in the status bar, preserving the user's original entry.
 *
 * @param {Float32Array} samples        - Full loaded mono PCM
 * @param {number}       startTime      - Offset in seconds (may be 0)
 * @param {number}       segmentDuration - Analysis window length in seconds
 * @param {number}       fs             - Sample rate (Hz)
 * @returns {Float32Array}
 * @throws {Error} If any parameter is non-finite, out of range, or zero-length
 */
function prepareSegment(samples, startTime, segmentDuration, fs) {
  if (!isFinite(startTime) || !isFinite(segmentDuration)) {
    throw new Error(
      `Start time and segment duration must be finite numbers ` +
      `(got startTime=${startTime}, segmentDuration=${segmentDuration}).`
    );
  }
  if (segmentDuration <= 0) {
    throw new Error(
      `Segment duration must be > 0 s (got ${segmentDuration} s).`
    );
  }
  const totalDuration = samples.length / fs;
  if (startTime < 0 || startTime >= totalDuration) {
    throw new Error(
      `Start time ${startTime.toFixed(3)} s is outside the loaded audio range ` +
      `[0, ${totalDuration.toFixed(3)} s].`
    );
  }
  const maxDuration = totalDuration - startTime;
  if (segmentDuration > maxDuration) {
    segmentDuration = maxDuration;
    // Update the UI input to reflect the clamped value
    segDurationInput.value = segmentDuration.toFixed(3);
  }
  const endTime = startTime + segmentDuration;
  const startSample = Math.round(startTime * fs);
  const endSample   = Math.round(endTime   * fs);
  return samples.slice(startSample, endSample);
}

// =============================================================================
// 2. Window functions
// =============================================================================
/**
 * Build a window coefficient array of length N.
 * Adding a new window type here is sufficient — no other code needs changing.
 *
 * @param {string} type - "hamming" | "hann" | "rectangular" | "blackman"
 * @param {number} N    - Frame size
 * @returns {Float32Array}
 */
function buildWindow(type, N) {
  // Custom window: delegate to the node-curve editor.
  // cwGetWindowArray() is defined in the custom window editor section below.
  // JavaScript's function-hoisting rules ensure it is available at call-time
  // even though its definition appears later in the file.
  if (type === "custom" || type.startsWith("csaved:")) {
    return cwGetWindowArray(type, N);
  }

  const w = new Float32Array(N);
  const TWO_PI = 2 * Math.PI;

  for (let n = 0; n < N; n++) {
    switch (type) {
      case "hamming":
        // Hamming: reduces spectral leakage while keeping a narrow main lobe
        w[n] = 0.54 - 0.46 * Math.cos(TWO_PI * n / (N - 1));
        break;

      case "hann":
        // Hann (von Hann): good general-purpose choice
        w[n] = 0.5 * (1 - Math.cos(TWO_PI * n / (N - 1)));
        break;

      case "blackman":
        // Blackman: lower sidelobes than Hamming, wider main lobe
        w[n] = 0.42
             - 0.5  * Math.cos(TWO_PI * n / (N - 1))
             + 0.08 * Math.cos(4 * Math.PI * n / (N - 1));
        break;

      case "rectangular":
      default:
        // Rectangular (boxcar): no weighting — maximum frequency resolution
        w[n] = 1.0;
        break;
    }
  }
  return w;
}

// =============================================================================
// 3. computeSTFT(samples, config) → powerMatrix[][]
// =============================================================================
/**
 * Short-Time Fourier Transform.
 *
 * Algorithm:
 *   For each frame starting at position pos (step = hopSize):
 *     1. Extract a slice of `frameSize` samples (zero-pad at the end if needed)
 *     2. Multiply element-wise by the window coefficients
 *     3. Pack into the real[] / imag[] arrays required by fft.js
 *     4. Run the FFT (in-place, via fft.js)
 *     5. Compute magnitude squared for the positive frequencies only
 *        (bins 0 … frameSize/2, i.e. numBins = frameSize/2 + 1)
 *
 * @param {Float32Array} samples - Mono PCM signal
 * @param {{frameSize:number, hopSize:number, windowType:string}} cfg
 * @returns {number[][]} powerMatrix[frameIndex][binIndex]  (linear power)
 */
function computeSTFT(samples, cfg) {
  const { frameSize, hopSize, windowType } = cfg;

  // ── Parameter validation — errors propagate to the UI status bar ─────────
  // Validation lives here (the computation layer), not in the event handler,
  // so the UI never silently adjusts what the user typed.
  if (!Number.isInteger(frameSize) || frameSize <= 0) {
    throw new Error(
      `Frame size must be a positive integer (got ${frameSize}).`
    );
  }
  if ((frameSize & (frameSize - 1)) !== 0) {
    // fft.js requires a power-of-2 size; enforce here rather than producing
    // a cryptic internal error.
    throw new Error(
      `Frame size must be a power of 2 (got ${frameSize}). ` +
      `Try 128, 256, 512, or 1024.`
    );
  }
  if (!Number.isInteger(hopSize) || hopSize <= 0) {
    throw new Error(
      `Hop size must be a positive integer (got ${hopSize}).`
    );
  }
  if (samples.length < frameSize) {
    throw new Error(
      `Segment length (${samples.length} samples) is shorter than frame size ` +
      `(${frameSize}). Increase segment duration or reduce frame size.`
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  const numBins    = frameSize / 2 + 1;  // positive-frequency bins (DC … Nyquist)
  const window     = buildWindow(windowType, frameSize);

  // fft.js instance — must be constructed with the exact FFT size
  const fftInstance = new FFT(frameSize);

  // Pre-allocate both complex buffers once outside the loop — avoids GC
  // pressure on large files (thousands of frames × 2×frameSize floats each).
  const complexInput = fftInstance.createComplexArray(); // interleaved [re,im, re,im, …]
  const out          = fftInstance.createComplexArray(); // FFT output, same layout

  const powerMatrix = [];

  for (let pos = 0; pos + frameSize <= samples.length; pos += hopSize) {
    // ── 1 & 2: extract frame and apply window ─────────────────────────────
    // complexInput layout: [re0, im0, re1, im1, …]
    // Imaginary parts are always 0 for a real-valued input signal.
    for (let n = 0; n < frameSize; n++) {
      complexInput[2 * n]     = samples[pos + n] * window[n]; // real × window
      complexInput[2 * n + 1] = 0;                            // imag = 0
    }

    // ── 3: FFT ────────────────────────────────────────────────────────────
    fftInstance.transform(out, complexInput);

    // ── 4: magnitude squared (linear power) ───────────────────────────────
    // Only positive frequencies: bins 0 … frameSize/2 (DC … Nyquist).
    const powerFrame = new Float32Array(numBins);
    for (let k = 0; k < numBins; k++) {
      const re = out[2 * k];
      const im = out[2 * k + 1];
      powerFrame[k] = re * re + im * im;
    }

    powerMatrix.push(powerFrame);
  }

  return powerMatrix;  // [numFrames][numBins]  — linear power, not yet in dB
}

// =============================================================================
// 4. computeSpectrogram(powerMatrix) → dbMatrix[][]
// =============================================================================
/**
 * Converts a linear-power STFT matrix into a display-ready dB matrix.
 *
 * Algorithm:
 *   1. S_db[t][k] = 10 * log10(power[t][k] + 1e-12)
 *      The 1e-12 floor prevents log(0) on silence.
 *
 *   2. Normalize relative to the global maximum:
 *      S_db = S_db - max(S_db)
 *      After this step the loudest bin is 0 dB; all others are negative.
 *
 *   3. Clip to the dynamic-range floor DB_FLOOR (default −80 dB).
 *      Bins quieter than the floor are all treated equally (displayed as black).
 *      This is the standard approach used by MATLAB, Audacity, and librosa.
 *
 * @param {Float32Array[]} powerMatrix - Output of computeSTFT()
 * @returns {Float32Array[]} dbMatrix  - Values in [DB_FLOOR, 0]
 */
function computeSpectrogram(powerMatrix) {
  const DB_FLOOR = -80;    // dB below peak that maps to colormap minimum
  const EPSILON  = 1e-12;  // prevents log10(0)

  // ── Pass 1: compute dB values and track the global maximum ───────────────
  let globalMaxDB = -Infinity;

  const dbMatrix = powerMatrix.map((frame) => {
    const dbFrame = new Float32Array(frame.length);
    for (let k = 0; k < frame.length; k++) {
      const db = 10 * Math.log10(frame[k] + EPSILON);
      dbFrame[k] = db;
      if (db > globalMaxDB) globalMaxDB = db;
    }
    return dbFrame;
  });

  // ── Pass 2: subtract max (→ peak = 0 dB) then clip to floor ─────────────
  for (let t = 0; t < dbMatrix.length; t++) {
    const frame = dbMatrix[t];
    for (let k = 0; k < frame.length; k++) {
      // Relative to peak: 0 dB = loudest bin, negative values = quieter
      const relative = frame[k] - globalMaxDB;
      // Clamp: anything below the floor is indistinguishable from silence
      frame[k] = relative < DB_FLOOR ? DB_FLOOR : relative;
    }
  }

  return dbMatrix;  // [numFrames][numBins], values ∈ [DB_FLOOR, 0]
}

// =============================================================================
// 5. renderSpectrogram(dbMatrix, canvas, ctx)
// =============================================================================
/**
 * Paints a pre-computed dB spectrogram matrix onto the canvas.
 *
 * Coordinate convention:
 *   X-axis → time  (left = frame 0,  right = last frame)
 *   Y-axis → freq  (bottom = DC bin, top = Nyquist bin)
 *
 * The dB values from computeSpectrogram() are in [DB_FLOOR, 0]; they are
 * linearly rescaled to [0, 1] for the colormap:
 *   norm = (db - DB_FLOOR) / (-DB_FLOOR)   →  0 = silence, 1 = peak
 *
 * Pixels are written via ImageData.putImageData() — significantly faster than
 * per-pixel fillRect(), which matters on mobile with thousands of bins × frames.
 *
 * @param {Float32Array[]} dbMatrix - Output of computeSpectrogram()
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 */
function renderSpectrogram(dbMatrix, canvas, ctx) {
  const numFrames = dbMatrix.length;
  if (numFrames === 0) return;
  const numBins = dbMatrix[0].length;

  const DB_FLOOR = -80;  // must match the value used in computeSpectrogram()

  // Size the canvas to the exact data dimensions.
  // CSS (width:100%) then scales this to fit the panel without blurring.
  canvas.width  = numFrames;
  canvas.height = numBins;

  // ImageData: row-major RGBA buffer (row 0 = top of canvas)
  const imageData = ctx.createImageData(numFrames, numBins);
  const data      = imageData.data;

  for (let t = 0; t < numFrames; t++) {
    for (let k = 0; k < numBins; k++) {
      // Map dB ∈ [DB_FLOOR, 0] → norm ∈ [0, 1]
      const norm = (dbMatrix[t][k] - DB_FLOOR) / (-DB_FLOOR);

      // Flip Y: bin 0 (DC) at bottom, Nyquist at top
      const row = numBins - 1 - k;
      const idx = (row * numFrames + t) * 4;

      const [r, g, b] = colormapInferno(norm);
      data[idx]     = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255; // fully opaque
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

// =============================================================================
// 5b. renderAxes(tStart, tEnd, fMin, fMax)
// =============================================================================
/**
 * Draws calibrated tick marks and labels on the X and Y axis canvases.
 *
 * tStart / tEnd : absolute seconds visible in the current view
 * fMin  / fMax  : Hz range visible in the current view
 *
 * Passing the range explicitly lets renderAxes serve both the initial full
 * view and any zoomed sub-region without needing to know about CONFIG.
 */
function renderAxes(tStart, tEnd, fMin, fMax) {
  // ── X-axis (time) ─────────────────────────────────────────────────────────
  // Ticks are placed at left: X% so the browser re-maps them correctly at
  // any container width — no pixel measurement, no RAF deferral needed.
  xAxisDiv.innerHTML = '';
  // Target ~1 tick every 80px of the full scrollable width so the tick
  // density grows naturally as the time scale is increased.
  const xTickTarget = Math.max(3, Math.round((xAxisDiv.offsetWidth || 600) / 80));
  const xTicks = niceTicks(tStart, tEnd, xTickTarget);
  for (const t of xTicks) {
    if (t < tStart - 1e-9 || t > tEnd + 1e-9) continue;
    const pct = ((t - tStart) / (tEnd - tStart)) * 100;
    const el = document.createElement('span');
    el.className = 'tick-x';
    el.style.left = pct + '%';
    el.textContent = formatTime(t);
    xAxisDiv.appendChild(el);
  }
  const xTitle = document.createElement('span');
  xTitle.className = 'axis-title-x';
  xTitle.textContent = 'Time (s)';
  xAxisDiv.appendChild(xTitle);

  // ── Y-axis (frequency) ────────────────────────────────────────────────────
  yAxisDiv.innerHTML = '';
  const yTicks = niceTicks(fMin, fMax, 10);
  for (const f of yTicks) {
    if (f < fMin - 1e-9 || f > fMax + 1e-9) continue;
    const pct = ((f - fMin) / (fMax - fMin)) * 100;
    const el = document.createElement('span');
    el.className = 'tick-y';
    el.style.bottom = pct + '%';
    el.textContent = formatFreq(f);
    yAxisDiv.appendChild(el);
  }
  const yTitle = document.createElement('span');
  yTitle.className = 'axis-title-y';
  yTitle.textContent = 'Frequency (Hz)';
  yAxisDiv.appendChild(yTitle);
}

// =============================================================================
// 5c. renderColorbar()
// =============================================================================
/**
 * Draws a vertical color scale legend on the colorbar canvas.
 *
 * dB normalization (matching computeSpectrogram):
 *   S_db = 10 * log10(power + 1e-12)
 *   S_db = S_db − max(S_db)    →  peak bin = 0 dB
 *   vmin = −80 dB, vmax = 0 dB
 *
 * The bar maps: top = 0 dB (colormap norm = 1), bottom = −80 dB (norm = 0).
 * The same colormapInferno() function is used for pixel-accurate consistency.
 */
function renderColorbar() {
  colorbarCanvas.width  = colorbarCanvas.clientWidth;
  colorbarCanvas.height = colorbarCanvas.clientHeight;
  const cbCtx = colorbarCanvas.getContext("2d");
  cbCtx.clearRect(0, 0, colorbarCanvas.width, colorbarCanvas.height);

  if (colorbarCanvas.width === 0 || colorbarCanvas.height === 0) return;

  const DB_MIN = -80;
  const DB_MAX =   0;

  // Geometry: narrow bar on the left, tick labels on the right
  const barX   = 4;
  const barW   = 12;
  const barTop = 18;                               // space for "dB" title
  const barBot = colorbarCanvas.height - 6;
  const barH   = barBot - barTop;

  // Title "dB" above the bar
  cbCtx.font         = "9px Consolas, Menlo, monospace";
  cbCtx.fillStyle    = "#9aa0ad";
  cbCtx.textAlign    = "center";
  cbCtx.textBaseline = "top";
  cbCtx.fillText("dB", barX + barW / 2, 3);

  // Draw the colored bar row-by-row using colormapInferno.
  // Top row = 0 dB (norm = 1), bottom row = −80 dB (norm = 0).
  const imgData = cbCtx.createImageData(barW, barH);
  for (let row = 0; row < barH; row++) {
    const norm = 1 - row / (barH - 1);
    const [r, g, b] = colormapInferno(norm);
    for (let col = 0; col < barW; col++) {
      const idx = (row * barW + col) * 4;
      imgData.data[idx]     = r;
      imgData.data[idx + 1] = g;
      imgData.data[idx + 2] = b;
      imgData.data[idx + 3] = 255;
    }
  }
  cbCtx.putImageData(imgData, barX, barTop);

  // Thin border around the bar
  cbCtx.strokeStyle = "#3a3f4a";
  cbCtx.lineWidth   = 1;
  cbCtx.strokeRect(barX, barTop, barW, barH);

  // Tick marks and numeric labels on the right side of the bar
  const dbTicks = [0, -20, -40, -60, -80];
  cbCtx.font         = "9px Consolas, Menlo, monospace";
  cbCtx.fillStyle    = "#6a6f7a";
  cbCtx.strokeStyle  = "#6a6f7a";
  cbCtx.lineWidth    = 1;
  cbCtx.textAlign    = "left";
  cbCtx.textBaseline = "middle";

  for (const db of dbTicks) {
    // dB-to-pixel: 0 dB at top, −80 dB at bottom
    const norm = (db - DB_MIN) / (DB_MAX - DB_MIN);  // 0 at -80, 1 at 0
    const y    = barTop + (1 - norm) * barH;
    // Short tick mark
    cbCtx.beginPath();
    cbCtx.moveTo(barX + barW,     y);
    cbCtx.lineTo(barX + barW + 3, y);
    cbCtx.stroke();
    // Label
    cbCtx.fillText(`${db}`, barX + barW + 5, y);
  }
}

// =============================================================================
// 5d. niceTicks / formatFreq / formatTime — axis helper utilities
// =============================================================================
/**
 * Returns a list of "nice" round tick values covering [min, max].
 * Step is rounded to 1, 2, or 5 × power-of-10 for human readability.
 *
 * @param {number} min
 * @param {number} max
 * @param {number} targetCount - Approximate desired number of ticks
 * @returns {number[]}
 */
function niceTicks(min, max, targetCount) {
  const range = max - min;
  if (range === 0) return [min];
  const roughStep  = range / targetCount;
  const magnitude  = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  let niceStep;
  if      (normalized < 1.5) niceStep =  1 * magnitude;
  else if (normalized < 3.5) niceStep =  2 * magnitude;
  else if (normalized < 7.5) niceStep =  5 * magnitude;
  else                        niceStep = 10 * magnitude;
  const start = Math.ceil(min / niceStep) * niceStep;
  const ticks  = [];
  for (let v = start; v <= max + niceStep * 1e-6; v += niceStep) {
    ticks.push(Math.round(v / niceStep) * niceStep);
  }
  return ticks;
}

/**
 * Formats a frequency value (Hz) for Y-axis labels.
 * Values ≥ 1000 Hz are rendered as kHz (e.g. "11k", "5.5k").
 */
function formatFreq(f) {
  if (f === 0) return "0";
  if (f >= 1000) {
    const k = f / 1000;
    return (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)) + "k";
  }
  return f.toFixed(0);
}

/**
 * Formats a time value (seconds) for X-axis labels.
 * Uses the minimum number of decimal places to distinguish adjacent ticks.
 */
function formatTime(t) {
  if (t === 0) return "0";
  if (t >= 10)  return t.toFixed(0);
  if (t >= 1)   return t.toFixed(1);
  return t.toFixed(2);
}

// =============================================================================
// renderSideBySide — render all 4 window panels with shared viewState
// =============================================================================
/**
 * Renders each of the 4 side-by-side spectrogram panels using the shared
 * viewState.  Called after Run in sbs mode and after any synchronized zoom.
 */
function renderSideBySide() {
  if (!fullDbMatrices || !viewState) return;

  updateSbsWidth();

  const { frameStart, frameEnd, binStart, binEnd } = viewState;
  const windowTypes = ["rectangular", "hann", "hamming", "blackman"];

  sbsPanels.forEach((panel) => {
    const wt = panel.dataset.window;
    const dbMatrix = fullDbMatrices[wt];
    if (!dbMatrix) return;

    const subMatrix = [];
    for (let t = frameStart; t < frameEnd; t++) {
      subMatrix.push(dbMatrix[t].slice(binStart, binEnd));
    }

    const cvs = panel.querySelector(".sbs-canvas");
    const cCtx = cvs.getContext("2d");
    renderSpectrogram(subMatrix, cvs, cCtx);
  });

  const fs         = sampleRate;
  const tViewStart = CONFIG.startTime + frameStart * CONFIG.hopSize / fs;
  const tViewEnd   = CONFIG.startTime + frameEnd   * CONFIG.hopSize / fs;
  const fMin       = binStart * fs / CONFIG.frameSize;
  const fMax       = (binEnd - 1) * fs / CONFIG.frameSize;

  // HTML-based axes update immediately at any container size — no deferral needed.
  renderSbsAxes(tViewStart, tViewEnd, fMin, fMax);
  renderSbsColorbar();
}

/**
 * Sets the pixel width of each .sbs-panel-inner so the spectrogram content
 * respects the time scale (pxPerSec).  The x-axis canvas is sized to match.
 * All 4 panels use the same width; scroll is synchronized via JS.
 */
function updateSbsWidth() {
  if (!viewState || !sampleRate) return;
  const viewDuration = (viewState.frameEnd - viewState.frameStart) * CONFIG.hopSize / sampleRate;
  const minW = (sbsPanelScrolls[0] && sbsPanelScrolls[0].clientWidth) || 100;
  const w = Math.max(Math.round(viewDuration * CONFIG.pxPerSec), minW);
  // Each panel inner's width drives its scrollable content size
  sbsPanels.forEach((panel) => {
    const inner = panel.querySelector(".sbs-panel-inner");
    if (inner) inner.style.width = w + "px";
  });
  sbsXAxisDiv.style.width = w + "px";  // match x-axis div width to content width
  // X-axis: width matches the top-left panel's visible viewport.
  // Y-axis: aligned to bottom-left panel (index 2) only — offset down by
  // measuring the gap from the wrapper top to that panel's scroll area.
  if (sbsPanelScrolls[0]) {
    sbsXAxisWrapper.style.width = sbsPanelScrolls[0].clientWidth + "px";
  }
  const bottomLeftScroll = sbsPanelScrolls[2] || sbsPanelScrolls[0];
  if (bottomLeftScroll) {
    const wrapperRect = sbsYAxisWrapper.getBoundingClientRect();
    const panelRect   = bottomLeftScroll.getBoundingClientRect();
    const offsetTop   = Math.max(0, panelRect.top - wrapperRect.top);
    sbsYAxisDiv.style.marginTop = offsetTop + "px";
    sbsYAxisDiv.style.height    = bottomLeftScroll.clientHeight + "px";
  }
  requestAnimationFrame(updateSbsScrollbar);
}

/**
 * Draws shared X and Y axes for the side-by-side view using HTML elements.
 * The Y-axis sits outside the scroll area so it stays fixed.
 * The X-axis sits inside so it scrolls with the panels.
 */
function renderSbsAxes(tStart, tEnd, fMin, fMax) {
  // ── X-axis (time) ─────────────────────────────────────────────────────────
  sbsXAxisDiv.innerHTML = '';
  const xTickTarget = Math.max(3, Math.round((sbsXAxisDiv.offsetWidth || 600) / 80));
  const xTicks = niceTicks(tStart, tEnd, xTickTarget);
  for (const t of xTicks) {
    if (t < tStart - 1e-9 || t > tEnd + 1e-9) continue;
    const pct = ((t - tStart) / (tEnd - tStart)) * 100;
    const el = document.createElement('span');
    el.className = 'tick-x';
    el.style.left = pct + '%';
    el.textContent = formatTime(t);
    sbsXAxisDiv.appendChild(el);
  }
  const xTitle = document.createElement('span');
  xTitle.className = 'axis-title-x';
  xTitle.textContent = 'Time (s)';
  sbsXAxisDiv.appendChild(xTitle);

  // ── Y-axis (frequency) ────────────────────────────────────────────────────
  sbsYAxisDiv.innerHTML = '';
  const yTicks = niceTicks(fMin, fMax, 10);
  for (const f of yTicks) {
    if (f < fMin - 1e-9 || f > fMax + 1e-9) continue;
    const pct = ((f - fMin) / (fMax - fMin)) * 100;
    const el = document.createElement('span');
    el.className = 'tick-y';
    el.style.bottom = pct + '%';
    el.textContent = formatFreq(f);
    sbsYAxisDiv.appendChild(el);
  }
  const yTitle = document.createElement('span');
  yTitle.className = 'axis-title-y';
  yTitle.textContent = 'Frequency (Hz)';
  sbsYAxisDiv.appendChild(yTitle);
}

/**
 * Draws the colorbar for the sbs view onto sbsColorbarCanvas.
 * Identical logic to renderColorbar() but targets the sbs canvas.
 */
function renderSbsColorbar() {
  sbsColorbarCanvas.width  = sbsColorbarCanvas.clientWidth;
  sbsColorbarCanvas.height = sbsColorbarCanvas.clientHeight;
  const cbCtx = sbsColorbarCanvas.getContext("2d");
  cbCtx.clearRect(0, 0, sbsColorbarCanvas.width, sbsColorbarCanvas.height);
  if (sbsColorbarCanvas.width === 0 || sbsColorbarCanvas.height === 0) return;

  const DB_MIN = -80;
  const DB_MAX =   0;
  const barX   = 4;
  const barW   = 12;
  const barTop = 18;
  const barBot = sbsColorbarCanvas.height - 6;
  const barH   = barBot - barTop;

  cbCtx.font         = "9px Consolas, Menlo, monospace";
  cbCtx.fillStyle    = "#9aa0ad";
  cbCtx.textAlign    = "center";
  cbCtx.textBaseline = "top";
  cbCtx.fillText("dB", barX + barW / 2, 3);

  const imgData = cbCtx.createImageData(barW, barH);
  for (let row = 0; row < barH; row++) {
    const norm = 1 - row / (barH - 1);
    const [r, g, b] = colormapInferno(norm);
    for (let col = 0; col < barW; col++) {
      const idx = (row * barW + col) * 4;
      imgData.data[idx]     = r;
      imgData.data[idx + 1] = g;
      imgData.data[idx + 2] = b;
      imgData.data[idx + 3] = 255;
    }
  }
  cbCtx.putImageData(imgData, barX, barTop);

  cbCtx.strokeStyle = "#3a3f4a";
  cbCtx.lineWidth   = 1;
  cbCtx.strokeRect(barX, barTop, barW, barH);

  const dbTicks = [0, -20, -40, -60, -80];
  cbCtx.font         = "9px Consolas, Menlo, monospace";
  cbCtx.fillStyle    = "#6a6f7a";
  cbCtx.strokeStyle  = "#6a6f7a";
  cbCtx.lineWidth    = 1;
  cbCtx.textAlign    = "left";
  cbCtx.textBaseline = "middle";

  for (const db of dbTicks) {
    const norm = (db - DB_MIN) / (DB_MAX - DB_MIN);
    const y    = barTop + (1 - norm) * barH;
    cbCtx.beginPath();
    cbCtx.moveTo(barX + barW,     y);
    cbCtx.lineTo(barX + barW + 3, y);
    cbCtx.stroke();
    cbCtx.fillText(`${db}`, barX + barW + 5, y);
  }
}

// =============================================================================
// SBS Custom Scrollbar — mirrors single-mode scrollbar logic
// =============================================================================
function updateSbsScrollbar() {
  if (!sbsPanelScrolls[0]) return;
  const scrollW = sbsPanelScrolls[0].scrollWidth;
  const clientW = sbsPanelScrolls[0].clientWidth;
  const trackW  = sbsCustomScrollbar.clientWidth;
  if (trackW === 0) return;

  if (scrollW <= clientW) {
    sbsCustomThumb.style.width = trackW + "px";
    sbsCustomThumb.style.left  = "0px";
    return;
  }

  const thumbW      = Math.max(24, Math.round((clientW / scrollW) * trackW));
  const thumbRange  = trackW - thumbW;
  const scrollFrac  = sbsPanelScrolls[0].scrollLeft / (scrollW - clientW);
  sbsCustomThumb.style.width = thumbW + "px";
  sbsCustomThumb.style.left  = Math.round(scrollFrac * thumbRange) + "px";
}

// Sync all panel scroll containers + x-axis wrapper to the same scrollLeft.
// A guard flag prevents scroll event loops (A scrolls → syncs B → B fires scroll → ...).
let sbsSyncingScroll = false;
function syncSbsScroll(sl) {
  if (sbsSyncingScroll) return;
  sbsSyncingScroll = true;
  sbsPanelScrolls.forEach((ps) => { ps.scrollLeft = sl; });
  sbsXAxisWrapper.scrollLeft = sl;
  updateSbsScrollbar();
  sbsSyncingScroll = false;
}

sbsPanelScrolls.forEach((ps) => {
  ps.addEventListener("scroll", () => syncSbsScroll(ps.scrollLeft));
});
window.addEventListener("resize", updateSbsScrollbar);

let sbsThumbDragging = false;
let sbsThumbDragStartX = 0;
let sbsThumbDragStartScrollLeft = 0;

function onSbsThumbDragStart(e) {
  sbsThumbDragging = true;
  const src = (e.touches && e.touches.length > 0) ? e.touches[0] : e;
  sbsThumbDragStartX          = src.clientX;
  sbsThumbDragStartScrollLeft = sbsPanelScrolls[0] ? sbsPanelScrolls[0].scrollLeft : 0;
  sbsCustomThumb.classList.add("active");
  document.addEventListener("mousemove", onSbsThumbDragMove);
  document.addEventListener("mouseup",   onSbsThumbDragEnd);
  document.addEventListener("touchmove", onSbsThumbDragMove, { passive: false });
  document.addEventListener("touchend",  onSbsThumbDragEnd);
  e.preventDefault();
  e.stopPropagation();
}

function onSbsThumbDragMove(e) {
  if (!sbsThumbDragging) return;
  e.preventDefault();
  const src = (e.touches && e.touches.length > 0) ? e.touches[0] : e;
  const dx         = src.clientX - sbsThumbDragStartX;
  const trackW     = sbsCustomScrollbar.clientWidth;
  const thumbW     = sbsCustomThumb.offsetWidth;
  const thumbRange = trackW - thumbW;
  if (thumbRange <= 0) return;
  const ps0 = sbsPanelScrolls[0];
  if (!ps0) return;
  const scrollRange = ps0.scrollWidth - ps0.clientWidth;
  const scrollDelta = dx * (scrollRange / thumbRange);
  syncSbsScroll(Math.max(0, Math.min(scrollRange, sbsThumbDragStartScrollLeft + scrollDelta)));
}

function onSbsThumbDragEnd() {
  sbsThumbDragging = false;
  sbsCustomThumb.classList.remove("active");
  document.removeEventListener("mousemove", onSbsThumbDragMove);
  document.removeEventListener("mouseup",   onSbsThumbDragEnd);
  document.removeEventListener("touchmove", onSbsThumbDragMove);
  document.removeEventListener("touchend",  onSbsThumbDragEnd);
}

sbsCustomThumb.addEventListener("mousedown",  onSbsThumbDragStart);
sbsCustomThumb.addEventListener("touchstart", onSbsThumbDragStart, { passive: false });

sbsCustomScrollbar.addEventListener("click", (e) => {
  if (e.target === sbsCustomThumb) return;
  const rect      = sbsCustomScrollbar.getBoundingClientRect();
  const clickX    = e.clientX - rect.left;
  const thumbLeft = parseFloat(sbsCustomThumb.style.left) || 0;
  const ps0       = sbsPanelScrolls[0];
  if (!ps0) return;
  const pageW     = ps0.clientWidth;
  syncSbsScroll(ps0.scrollLeft + (clickX < thumbLeft ? -pageW : pageW));
});

// =============================================================================
// SBS Zoom — synchronized zoom across all 4 panels
// =============================================================================
/**
 * Attach synchronized zoom listeners to each .sbs-zoom-canvas.
 * Zoom on any panel updates the shared viewState then re-renders all 4.
 */
let sbsIsZooming   = false;
let sbsZoomStartX  = 0;
let sbsZoomStartY  = 0;
let sbsZoomActiveCanvas = null;  // the zoom canvas currently being dragged

/**
 * Detects a mobile double-tap (two touchend events within 300 ms) and calls
 * handler().  Used to trigger zoom reset on devices where dblclick is unreliable.
 */
function addDoubleTap(element, handler) {
  let lastTap = 0;
  element.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      e.preventDefault();
      handler();
      lastTap = 0;
    } else {
      lastTap = now;
    }
  });
}

sbsPanels.forEach((panel) => {
  const zc = panel.querySelector(".sbs-zoom-canvas");
  zc.addEventListener("mousedown",  onSbsZoomStart);
  zc.addEventListener("touchstart", onSbsZoomStart, { passive: false });
  zc.addEventListener("touchmove",  onSbsZoomMove,  { passive: false });
  zc.addEventListener("touchend",   onSbsZoomEnd);
  zc.addEventListener("dblclick",   resetSbsZoom);
  addDoubleTap(zc, resetSbsZoom);
  // Reset button inside each panel
  panel.querySelector(".sbs-reset-btn").addEventListener("click", resetSbsZoom);
});

function syncSbsZoomCanvas(zc) {
  const inner = zc.parentElement;  // .sbs-panel-inner
  const w = inner.clientWidth;
  const h = inner.clientHeight;
  if (zc.width !== w || zc.height !== h) {
    zc.width  = w;
    zc.height = h;
  }
}

function clampedSbsPos(e, zc) {
  const pos = getEventPos(e, zc);
  return {
    x: Math.max(0, Math.min(zc.width,  pos.x)),
    y: Math.max(0, Math.min(zc.height, pos.y)),
  };
}

function onSbsZoomStart(e) {
  if (!fullDbMatrices) return;
  // In SBS scroll mode, let touch events pass through to the scroll container.
  if (sbsScrollModeActive && e.touches) return;
  e.preventDefault();
  const zc = e.currentTarget;
  syncSbsZoomCanvas(zc);
  const pos = getEventPos(e, zc);
  sbsZoomStartX = pos.x;
  sbsZoomStartY = pos.y;
  sbsIsZooming  = true;
  sbsZoomActiveCanvas = zc;
  document.addEventListener("mousemove", onSbsZoomMove);
  document.addEventListener("mouseup",   onSbsZoomEnd);
}

function onSbsZoomMove(e) {
  if (!sbsIsZooming || !sbsZoomActiveCanvas) return;
  e.preventDefault();
  const zc  = sbsZoomActiveCanvas;
  syncSbsZoomCanvas(zc);
  const w   = zc.width;
  const h   = zc.height;
  const pos = clampedSbsPos(e, zc);
  const zCtx = zc.getContext("2d");

  const rx = Math.min(sbsZoomStartX, pos.x);
  const ry = Math.min(sbsZoomStartY, pos.y);
  const rw = Math.abs(pos.x - sbsZoomStartX);
  const rh = Math.abs(pos.y - sbsZoomStartY);

  zCtx.clearRect(0, 0, w, h);
  zCtx.fillStyle = "rgba(0,0,0,0.35)";
  zCtx.fillRect(0,       0,      w,  ry);
  zCtx.fillRect(0,       ry + rh, w,  h - ry - rh);
  zCtx.fillRect(0,       ry,      rx, rh);
  zCtx.fillRect(rx + rw, ry,      w - rx - rw, rh);

  zCtx.strokeStyle = "#5a8fff";
  zCtx.lineWidth   = 1.5;
  zCtx.setLineDash([4, 2]);
  zCtx.strokeRect(rx, ry, rw, rh);
  zCtx.setLineDash([]);
}

function onSbsZoomEnd(e) {
  document.removeEventListener("mousemove", onSbsZoomMove);
  document.removeEventListener("mouseup",   onSbsZoomEnd);

  if (!sbsIsZooming || !fullDbMatrices || !viewState) return;
  sbsIsZooming = false;

  const zc  = sbsZoomActiveCanvas;
  sbsZoomActiveCanvas = null;
  const w   = zc.width;
  const h   = zc.height;
  const pos = clampedSbsPos(e, zc);

  const nx1 = Math.max(0, Math.min(sbsZoomStartX, pos.x) / w);
  const nx2 = Math.min(1, Math.max(sbsZoomStartX, pos.x) / w);
  const ny1 = Math.max(0, Math.min(sbsZoomStartY, pos.y) / h);
  const ny2 = Math.min(1, Math.max(sbsZoomStartY, pos.y) / h);

  if ((nx2 - nx1) < 0.02 || (ny2 - ny1) < 0.02) {
    zc.getContext("2d").clearRect(0, 0, w, h);
    return;
  }

  const curFrames = viewState.frameEnd - viewState.frameStart;
  const curBins   = viewState.binEnd   - viewState.binStart;

  const refMatrix = fullDbMatrices["hann"];

  const newFrameStart = viewState.frameStart + Math.floor(nx1 * curFrames);
  const newFrameEnd   = viewState.frameStart + Math.ceil(nx2  * curFrames);
  const newBinEnd     = viewState.binEnd - Math.floor(ny1 * curBins);
  const newBinStart   = viewState.binEnd - Math.ceil(ny2  * curBins);

  viewState = {
    frameStart: Math.max(0, newFrameStart),
    frameEnd:   Math.min(refMatrix.length,      Math.max(newFrameEnd,  newFrameStart + 2)),
    binStart:   Math.max(0, newBinStart),
    binEnd:     Math.min(refMatrix[0].length,   Math.max(newBinEnd,    newBinStart   + 2)),
  };

  // Clear all zoom canvas overlays and show per-panel reset buttons
  sbsPanels.forEach((p) => {
    const z = p.querySelector(".sbs-zoom-canvas");
    z.getContext("2d").clearRect(0, 0, z.width, z.height);
    p.querySelector(".sbs-reset-btn").classList.remove("hidden");
  });

  renderSideBySide();
}

function resetSbsZoom() {
  if (!fullDbMatrices) return;
  const ref = fullDbMatrices["hann"];
  viewState = {
    frameStart: 0,
    frameEnd:   ref.length,
    binStart:   0,
    binEnd:     ref[0].length,
  };
  sbsPanels.forEach((p) => {
    const z = p.querySelector(".sbs-zoom-canvas");
    z.getContext("2d").clearRect(0, 0, z.width, z.height);
    p.querySelector(".sbs-reset-btn").classList.add("hidden");
  });
  renderSideBySide();
}

// =============================================================================
// renderCurrentView — re-render the spectrogram for the current viewState
// =============================================================================
/**
 * Re-renders the spectrogram canvas and axes for whatever sub-region
 * viewState describes.  Called both after initial render (full view) and
 * after every zoom/reset.
 */
function renderCurrentView() {
  if (!fullDbMatrix || !viewState) return;

  // Resize the spectrogram area width to match the time scale before painting.
  updateSpectroWidth();

  const { frameStart, frameEnd, binStart, binEnd } = viewState;

  // Build a sub-matrix that covers only the visible frames/bins.
  const subMatrix = [];
  for (let t = frameStart; t < frameEnd; t++) {
    subMatrix.push(fullDbMatrix[t].slice(binStart, binEnd));
  }

  renderSpectrogram(subMatrix, canvas, ctx2d);

  const fs         = sampleRate;
  const tViewStart = CONFIG.startTime + frameStart * CONFIG.hopSize / fs;
  const tViewEnd   = CONFIG.startTime + frameEnd   * CONFIG.hopSize / fs;
  const fMin       = binStart * fs / CONFIG.frameSize;
  const fMax       = (binEnd - 1) * fs / CONFIG.frameSize;

  // HTML-based axes update immediately and correctly at any container size —
  // no getBoundingClientRect() or RAF deferral needed.
  renderAxes(tViewStart, tViewEnd, fMin, fMax);
  renderColorbar();
}

// =============================================================================
// updateSpectroWidth — set spectroArea CSS width from time scale + view state
// =============================================================================
/**
 * Computes the desired pixel width of the spectrogram area from the current
 * view duration and CONFIG.pxPerSec, then applies it as an inline style.
 * The minimum is the scroll container's visible width so that short segments
 * fill the available space without activating the scrollbar.
 */
function updateSpectroWidth() {
  if (!viewState || !sampleRate) return;
  const viewDuration = (viewState.frameEnd - viewState.frameStart) * CONFIG.hopSize / sampleRate;
  const minW = spectroScrollArea.clientWidth || 100;
  const w = Math.max(Math.round(viewDuration * CONFIG.pxPerSec), minW);
  spectroArea.style.width = w + "px";
  // Keep x-axis div the same width so percentage-positioned ticks align
  // correctly with the spectrogram as the user scrolls.
  xAxisDiv.style.width = w + "px";
  // Let the browser apply the new width before computing thumb metrics.
  requestAnimationFrame(updateCustomScrollbar);
}

// =============================================================================
// Custom scrollbar — always-visible thumb synced with spectroScrollArea
// =============================================================================
/**
 * Positions and sizes the thumb to reflect the current scroll state.
 * Called on scroll events, after width changes, and on resize.
 */
function updateCustomScrollbar() {
  const scrollW = spectroScrollArea.scrollWidth;
  const clientW = spectroScrollArea.clientWidth;
  const trackW  = spectroCustomScrollbar.clientWidth;
  if (trackW === 0) return;

  if (scrollW <= clientW) {
    // Content fits — fill the track so it’s clear there’s nothing to scroll.
    spectroCustomThumb.style.width = trackW + "px";
    spectroCustomThumb.style.left  = "0px";
    return;
  }

  const thumbW    = Math.max(24, Math.round((clientW / scrollW) * trackW));
  const thumbRange  = trackW - thumbW;
  const scrollFrac  = spectroScrollArea.scrollLeft / (scrollW - clientW);
  spectroCustomThumb.style.width = thumbW + "px";
  spectroCustomThumb.style.left  = Math.round(scrollFrac * thumbRange) + "px";
}

spectroScrollArea.addEventListener("scroll", updateCustomScrollbar);

// ─ Thumb drag ────────────────────────────────────────────────────────────────────
let thumbDragging = false;
let thumbDragStartX = 0;
let thumbDragStartScrollLeft = 0;

function onThumbDragStart(e) {
  thumbDragging = true;
  const src = (e.touches && e.touches.length > 0) ? e.touches[0] : e;
  thumbDragStartX          = src.clientX;
  thumbDragStartScrollLeft = spectroScrollArea.scrollLeft;
  spectroCustomThumb.classList.add("active");
  document.addEventListener("mousemove", onThumbDragMove);
  document.addEventListener("mouseup",   onThumbDragEnd);
  document.addEventListener("touchmove", onThumbDragMove, { passive: false });
  document.addEventListener("touchend",  onThumbDragEnd);
  e.preventDefault();
  e.stopPropagation();
}

function onThumbDragMove(e) {
  if (!thumbDragging) return;
  e.preventDefault();
  const src = (e.touches && e.touches.length > 0) ? e.touches[0] : e;
  const dx         = src.clientX - thumbDragStartX;
  const trackW     = spectroCustomScrollbar.clientWidth;
  const thumbW     = spectroCustomThumb.offsetWidth;
  const thumbRange = trackW - thumbW;
  if (thumbRange <= 0) return;
  const scrollRange = spectroScrollArea.scrollWidth - spectroScrollArea.clientWidth;
  const scrollDelta = dx * (scrollRange / thumbRange);
  spectroScrollArea.scrollLeft = Math.max(0, Math.min(scrollRange, thumbDragStartScrollLeft + scrollDelta));
}

function onThumbDragEnd() {
  thumbDragging = false;
  spectroCustomThumb.classList.remove("active");
  document.removeEventListener("mousemove", onThumbDragMove);
  document.removeEventListener("mouseup",   onThumbDragEnd);
  document.removeEventListener("touchmove", onThumbDragMove);
  document.removeEventListener("touchend",  onThumbDragEnd);
}

spectroCustomThumb.addEventListener("mousedown",  onThumbDragStart);
spectroCustomThumb.addEventListener("touchstart", onThumbDragStart, { passive: false });

// Click on track (outside thumb) — jump scroll by one page
spectroCustomScrollbar.addEventListener("click", (e) => {
  if (e.target === spectroCustomThumb) return;  // handled by thumb drag
  const rect     = spectroCustomScrollbar.getBoundingClientRect();
  const clickX   = e.clientX - rect.left;
  const trackW   = spectroCustomScrollbar.clientWidth;
  const thumbW   = spectroCustomThumb.offsetWidth;
  const thumbLeft = parseFloat(spectroCustomThumb.style.left) || 0;
  const pageW    = spectroScrollArea.clientWidth;
  spectroScrollArea.scrollLeft += clickX < thumbLeft ? -pageW : pageW;
});

// Keep thumb in sync when window is resized
window.addEventListener("resize", updateCustomScrollbar);

// =============================================================================
// Zoom — MATLAB-style drag-rectangle zoom on the spectrogram
// =============================================================================
/**
 * The user drags a rectangle on the zoom canvas (which overlays the
 * spectrogram).  On release the spectrogram and axes are re-rendered for
 * just the selected sub-region.  Double-click resets to the full view.
 *
 * Coordinate mapping:
 *   Horizontal: x/width → frame index within current viewState window
 *   Vertical:   y/height → bin index; y=0 = top = highest freq (fMax),
 *               y=height = bottom = lowest freq (fMin)
 */
let isZooming   = false;
let zoomStartX  = 0;
let zoomStartY  = 0;

function getEventPos(e, element) {
  const rect = element.getBoundingClientRect();
  // For touchend, e.touches is an empty TouchList (truthy object with length 0),
  // so checking `e.touches` alone is not enough — must check length > 0.
  // changedTouches always contains the lifted finger on touchend.
  const src = (e.touches && e.touches.length > 0)            ? e.touches[0]
            : (e.changedTouches && e.changedTouches.length > 0) ? e.changedTouches[0]
            : e;
  return { x: src.clientX - rect.left, y: src.clientY - rect.top };
}

function syncZoomCanvas() {
  const w = spectroArea.clientWidth;
  const h = spectroArea.clientHeight;
  if (zoomCanvas.width !== w || zoomCanvas.height !== h) {
    zoomCanvas.width  = w;
    zoomCanvas.height = h;
  }
}

zoomCanvas.addEventListener("mousedown",  onZoomStart);
zoomCanvas.addEventListener("touchstart", onZoomStart, { passive: false });

function onZoomStart(e) {
  if (!fullDbMatrix) return;
  e.preventDefault();
  syncZoomCanvas();
  const pos  = getEventPos(e, zoomCanvas);
  zoomStartX = pos.x;
  zoomStartY = pos.y;
  isZooming  = true;
  // Track mouse outside the canvas so dragging to the edge works correctly.
  document.addEventListener("mousemove", onZoomMove);
  document.addEventListener("mouseup",   onZoomEnd);
}

zoomCanvas.addEventListener("touchmove",  onZoomMove, { passive: false });

function clampedPos(e) {
  const pos = getEventPos(e, zoomCanvas);
  return {
    x: Math.max(0, Math.min(zoomCanvas.width,  pos.x)),
    y: Math.max(0, Math.min(zoomCanvas.height, pos.y)),
  };
}

function onZoomMove(e) {
  if (!isZooming) return;
  e.preventDefault();
  syncZoomCanvas();
  const w   = zoomCanvas.width;
  const h   = zoomCanvas.height;
  const pos = clampedPos(e);

  const rx = Math.min(zoomStartX, pos.x);
  const ry = Math.min(zoomStartY, pos.y);
  const rw = Math.abs(pos.x - zoomStartX);
  const rh = Math.abs(pos.y - zoomStartY);

  zoomCtx.clearRect(0, 0, w, h);

  // Dim the area outside the selection rectangle
  zoomCtx.fillStyle = "rgba(0,0,0,0.35)";
  zoomCtx.fillRect(0,       0,      w,  ry);            // top strip
  zoomCtx.fillRect(0,       ry + rh, w,  h - ry - rh);  // bottom strip
  zoomCtx.fillRect(0,       ry,      rx, rh);            // left strip
  zoomCtx.fillRect(rx + rw, ry,      w - rx - rw, rh);  // right strip

  // Selection rectangle outline
  zoomCtx.strokeStyle = "#5a8fff";
  zoomCtx.lineWidth   = 1.5;
  zoomCtx.setLineDash([4, 2]);
  zoomCtx.strokeRect(rx, ry, rw, rh);
  zoomCtx.setLineDash([]);
}

zoomCanvas.addEventListener("touchend",   onZoomEnd);

function onZoomEnd(e) {
  // Remove document-level listeners regardless of whether zoom is active.
  document.removeEventListener("mousemove", onZoomMove);
  document.removeEventListener("mouseup",   onZoomEnd);

  if (!isZooming || !fullDbMatrix || !viewState) return;
  isZooming = false;

  const w   = spectroArea.clientWidth;
  const h   = spectroArea.clientHeight;
  const pos = clampedPos(e);

  // Normalised coords within the current view [0, 1]
  const nx1 = Math.max(0, Math.min(zoomStartX, pos.x) / w);
  const nx2 = Math.min(1, Math.max(zoomStartX, pos.x) / w);
  const ny1 = Math.max(0, Math.min(zoomStartY, pos.y) / h); // top (high freq)
  const ny2 = Math.min(1, Math.max(zoomStartY, pos.y) / h); // bottom (low freq)

  // Ignore accidental single-clicks (< 2 % of either dimension)
  if ((nx2 - nx1) < 0.02 || (ny2 - ny1) < 0.02) {
    zoomCtx.clearRect(0, 0, zoomCanvas.width, zoomCanvas.height);
    return;
  }

  // Map normalised coords into the current viewState window
  const curFrames = viewState.frameEnd - viewState.frameStart;
  const curBins   = viewState.binEnd   - viewState.binStart;

  const newFrameStart = viewState.frameStart + Math.floor(nx1 * curFrames);
  const newFrameEnd   = viewState.frameStart + Math.ceil(nx2  * curFrames);
  // y=0 is the top of the canvas which corresponds to the highest-freq bin
  const newBinEnd     = viewState.binEnd - Math.floor(ny1 * curBins);
  const newBinStart   = viewState.binEnd - Math.ceil(ny2  * curBins);

  viewState = {
    frameStart: Math.max(0, newFrameStart),
    frameEnd:   Math.min(fullDbMatrix.length,    Math.max(newFrameEnd,   newFrameStart + 2)),
    binStart:   Math.max(0, newBinStart),
    binEnd:     Math.min(fullDbMatrix[0].length, Math.max(newBinEnd,     newBinStart + 2)),
  };

  zoomCtx.clearRect(0, 0, zoomCanvas.width, zoomCanvas.height);
  renderCurrentView();
  resetZoomBtn.classList.remove("hidden");
}

// Double-click on the spectrogram area resets to the full view
zoomCanvas.addEventListener("dblclick", resetZoom);
resetZoomBtn.addEventListener("click",   resetZoom);
// Mobile double-tap to reset zoom
addDoubleTap(zoomCanvas, resetZoom);

function resetZoom() {
  if (!fullDbMatrix) return;
  viewState = {
    frameStart: 0,
    frameEnd:   fullDbMatrix.length,
    binStart:   0,
    binEnd:     fullDbMatrix[0].length,
  };
  zoomCtx.clearRect(0, 0, zoomCanvas.width, zoomCanvas.height);
  renderCurrentView();
  resetZoomBtn.classList.add("hidden");
}

// =============================================================================
// Colormap — inferno approximation
// =============================================================================
/**
 * Maps a normalised value v ∈ [0, 1] to an RGB triple [r, g, b] ∈ [0, 255].
 *
 * Uses a piecewise linear interpolation through the key colours of the
 * "inferno" perceptual colormap (black → purple → red → orange → yellow/white).
 * This is a self-contained approximation — no external library needed.
 *
 * To swap colormaps, replace this function only.
 *
 * @param {number} v - Normalised power in [0, 1]
 * @returns {[number, number, number]} RGB bytes
 */
function colormapInferno(v) {
  // Key colour stops: [v, r, g, b]
  const stops = [
    [0.00,   0,   0,   4],
    [0.13,  40,  11,  84],
    [0.25, 101,  21, 110],
    [0.38, 159,  42,  99],
    [0.50, 212,  72,  66],
    [0.63, 245, 125,  21],
    [0.75, 250, 193,  39],
    [0.88, 252, 255, 164],
    [1.00, 252, 255, 255],
  ];

  // Find the two stops that bracket v
  let i = 0;
  while (i < stops.length - 2 && v > stops[i + 1][0]) i++;

  const [v0, r0, g0, b0] = stops[i];
  const [v1, r1, g1, b1] = stops[i + 1];

  // Linear interpolation between the two stops
  const t = (v1 === v0) ? 0 : (v - v0) / (v1 - v0);
  return [
    Math.round(r0 + t * (r1 - r0)),
    Math.round(g0 + t * (g1 - g0)),
    Math.round(b0 + t * (b1 - b0)),
  ];
}

// =============================================================================
// Playback — startPlayback / stopPlayback / updateCursor / updateCursorAllViews
// =============================================================================

/**
 * Start audio playback from the beginning and launch the cursor animation loop.
 *
 * AudioBufferSourceNodes are single-use — a new one must be created for every
 * play() call. We connect it to audioCtx.destination (the speakers) and record
 * the context time so the cursor can track elapsed position.
 *
 * We use audioCtx.currentTime (the Web Audio hardware clock) rather than
 * Date.now() or performance.now() because:
 *   - audioCtx.currentTime is derived from the audio device sample clock.
 *   - It advances at exactly the playback rate, so cursor position stays in
 *     lockstep with the actual audio regardless of GC pauses or JS timer drift.
 */
function startPlayback() {
  if (!playbackBuffer || !audioCtx) return;

  // Cancel any previous playback first (doesn't clear cursor — we'll overwrite it)
  stopPlayback(false);

  // Resume context if the browser suspended it (autoplay policy)
  if (audioCtx.state === "suspended") audioCtx.resume();

  sourceNode        = audioCtx.createBufferSource();
  sourceNode.buffer = playbackBuffer;
  sourceNode.connect(audioCtx.destination);

  // Snapshot the hardware clock the instant before we call start().
  // All subsequent elapsed-time calculations subtract this value.
  playStartTime = audioCtx.currentTime;
  isPlaying     = true;
  playBtn.textContent = "\u23F9 Stop";

  // onended fires when the buffer plays out naturally (not when stop() is called)
  sourceNode.onended = () => {
    isPlaying = false;
    sourceNode = null;
    playBtn.textContent = "\u25B6 Play";
    // Draw cursor at the very end position so it doesn't snap back to 0.
    // getNormalizedTime() clamps to 1.0 at this point, placing the cursor at
    // the right edge of every active spectrogram canvas.
    updateCursorAllViews();
    // Stop the rAF loop — no more updates needed
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  sourceNode.start(0);
  // Snap scroll to the beginning when play starts (both single and SBS modes).
  spectroScrollArea.scrollLeft = 0;
  syncSbsScroll(0);
  rafId = requestAnimationFrame(updateCursor);
}

/**
 * Stop playback immediately and optionally clear the cursor overlay.
 * @param {boolean} clearCursor - If true, wipe the cursor from the overlay.
 */
function stopPlayback(clearCursor) {
  isPlaying = false;

  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (sourceNode) {
    sourceNode.onended = null;   // prevent the natural-end handler from firing
    try { sourceNode.stop(); } catch (_) { /* already stopped */ }
    sourceNode = null;
  }

  if (clearCursor) clearAllCursors();
  playBtn.textContent = "\u25B6 Play";
}

/**
 * requestAnimationFrame callback — redraws the cursor on every display frame.
 *
 * Elapsed time is recomputed from the audio clock on every call, so the cursor
 * position is always accurate even if a frame is dropped or delayed.
 */
function updateCursor() {
  if (!isPlaying) return;

  // getNormalizedTime() uses the audio clock for sample-accurate positioning.
  // updateCursorAllViews() then applies it to every active spectrogram canvas.
  updateCursorAllViews();

  const elapsed = Math.min(audioCtx.currentTime - playStartTime, audioDuration);
  autoScrollToElapsed(elapsed);

  rafId = requestAnimationFrame(updateCursor);
}

/**
 * Page-by-page auto-scroll: when the playback cursor moves past the right
 * edge of the visible scroll area, advance the scroll position by exactly
 * one page width (like pressing PgDn).  The cursor will then appear near
 * the left edge of the new page and travel rightward again.
 *
 * Handles both single mode (spectroScrollArea) and side-by-side mode
 * (all sbs-panel-scroll containers, kept in sync via syncSbsScroll).
 */
function autoScrollToElapsed(elapsed) {
  const mode = comparisonModeSelect.value;

  if (mode === "sidebyside") {
    if (!viewState || !fullDbMatrices) return;
    const tViewStart = CONFIG.startTime + viewState.frameStart * CONFIG.hopSize / sampleRate;
    const tViewEnd   = CONFIG.startTime + viewState.frameEnd   * CONFIG.hopSize / sampleRate;
    if (elapsed < tViewStart || elapsed > tViewEnd) return;
    const firstInner = sbsPanelsRow.querySelector(".sbs-panel-inner");
    if (!firstInner) return;
    const innerW  = firstInner.clientWidth;
    const x       = ((elapsed - tViewStart) / (tViewEnd - tViewStart)) * innerW;
    const ps0     = sbsPanelScrolls[0];
    if (!ps0) return;
    const pageW   = ps0.clientWidth;
    if (x > ps0.scrollLeft + pageW) {
      syncSbsScroll(ps0.scrollLeft + pageW);
    }
  } else {
    if (!viewState || !fullDbMatrix) return;
    const tViewStart = CONFIG.startTime + viewState.frameStart * CONFIG.hopSize / sampleRate;
    const tViewEnd   = CONFIG.startTime + viewState.frameEnd   * CONFIG.hopSize / sampleRate;
    if (elapsed < tViewStart || elapsed > tViewEnd) return;
    const canvasW  = spectroArea.clientWidth;
    const x        = ((elapsed - tViewStart) / (tViewEnd - tViewStart)) * canvasW;
    const pageW    = spectroScrollArea.clientWidth;
    const scrollLeft = spectroScrollArea.scrollLeft;
    if (x > scrollLeft + pageW) {
      spectroScrollArea.scrollLeft = scrollLeft + pageW;
    }
  }
}

// =============================================================================
// Cursor system — mode-independent timeline marker
// =============================================================================
//
// Design:
//   The cursor is decoupled from renderSpectrogram() so spectrogram data only
//   needs to be painted once (expensive), while the cursor updates at display
//   rate (~60 fps) in a separate lightweight pass.
//
//   A single normalised time value [0, 1] is the sole source of truth.  All
//   cursor canvases — regardless of how many are visible — derive their pixel
//   x coordinate from this value via a shared mapping function.  This makes
//   adding or removing canvases trivial and guarantees pixel-perfect sync.

/**
 * Returns current playback position normalised to [0, 1] over audioDuration.
 * Uses the Web Audio hardware clock (audioCtx.currentTime) for sample-accurate
 * synchronisation, clamped so the cursor never overshoots the end.
 *
 * @returns {number} normalised time in [0, 1]
 */
function getNormalizedTime() {
  if (!audioCtx || !audioDuration) return 0;
  const elapsed = Math.min(audioCtx.currentTime - playStartTime, audioDuration);
  return elapsed / audioDuration;
}

/**
 * Maps a normalised time value to an x pixel coordinate within a scrollable
 * content element (spectroArea in single mode, .sbs-panel-inner in SBS mode).
 *
 * Normalised time is used rather than raw seconds so the mapping is independent
 * of the total duration — the same formula works whether the clip is 1 s or 10 s.
 *
 * The mapping is zoom-aware: when viewState restricts the visible time range,
 * the cursor is positioned relative to that sub-window so it always aligns with
 * the currently displayed spectrogram content.
 *
 * @param {HTMLElement} contentEl      - The scrollable content element whose
 *                                       clientWidth defines the pixel space.
 * @param {number}      normalizedTime - Current time / duration, clamped to [0, 1].
 * @returns {number|null} x pixel position, or null if outside the current view.
 */
function mapTimeToX(contentEl, normalizedTime) {
  const w = contentEl.clientWidth;
  if (!w) return null;

  // Convert back to seconds for the zoom-window comparison.
  const elapsed = normalizedTime * audioDuration;

  if (viewState && sampleRate) {
    // Zoom-aware: map elapsed into the currently visible time sub-window.
    const tViewStart = CONFIG.startTime + viewState.frameStart * CONFIG.hopSize / sampleRate;
    const tViewEnd   = CONFIG.startTime + viewState.frameEnd   * CONFIG.hopSize / sampleRate;
    if (elapsed < tViewStart - 1e-9 || elapsed > tViewEnd + 1e-9) return null;
    return ((elapsed - tViewStart) / (tViewEnd - tViewStart)) * w;
  }

  // No zoom: simple full-range mapping.
  return normalizedTime * w;
}

/**
 * Draws a vertical cursor line on a dedicated overlay canvas.
 *
 * The overlay canvas is positioned absolutely inside a scrollable content
 * element (contentEl) so the cursor travels with the content as the user
 * scrolls — just like the spectrogram pixels beneath it.  The canvas
 * dimensions are synced to contentEl on every call to handle resize.
 *
 * @param {HTMLCanvasElement} cursorCvs    - The cursor overlay canvas to draw on.
 * @param {HTMLElement}       contentEl   - The parent scrollable content element.
 * @param {number}            normalizedTime - Normalised playback position [0, 1].
 */
function drawCursorOnCanvas(cursorCvs, contentEl, normalizedTime) {
  const w = contentEl.clientWidth;
  const h = contentEl.clientHeight;
  if (!w || !h) return;

  // Sync canvas resolution to the content element dimensions.
  // This automatically handles resize without a separate ResizeObserver.
  if (cursorCvs.width !== w || cursorCvs.height !== h) {
    cursorCvs.width  = w;
    cursorCvs.height = h;
  }

  const cCtx = cursorCvs.getContext("2d");
  cCtx.clearRect(0, 0, w, h);

  const x = mapTimeToX(contentEl, normalizedTime);
  if (x === null) return;  // cursor is outside the visible time window

  cCtx.beginPath();
  cCtx.moveTo(x, 0);
  cCtx.lineTo(x, h);
  cCtx.strokeStyle = "#ff3333";
  cCtx.lineWidth   = 1.5;
  cCtx.stroke();
}

/**
 * Redraws the cursor on ALL active spectrogram canvases for the current mode.
 *
 * Multi-canvas synchronisation: rather than having each render path manage its
 * own cursor, this function is the single place that iterates all active canvases
 * and calls drawCursorOnCanvas() for each.  Adding a new display mode only
 * requires adding a branch here — no other cursor code needs to change.
 *
 * Called on every requestAnimationFrame tick during playback.
 */
function updateCursorAllViews() {
  const normalizedTime = getNormalizedTime();
  const mode = comparisonModeSelect.value;

  if (mode === "sidebyside") {
    // Side-by-side: 4 independent panels, each with its own cursor canvas.
    // The same normalizedTime drives all 4 so they stay perfectly in sync.
    sbsPanels.forEach((panel) => {
      const cursorCvs = panel.querySelector(".sbs-cursor-canvas");
      const inner     = panel.querySelector(".sbs-panel-inner");
      if (cursorCvs && inner) {
        drawCursorOnCanvas(cursorCvs, inner, normalizedTime);
      }
    });
  } else {
    // Single mode uses the main #cursorCanvas over #spectroArea.
    drawCursorOnCanvas(cursorCanvas, spectroArea, normalizedTime);
  }
}

/**
 * Erases the cursor from all canvas overlays.
 * Called on explicit stop or when a new file is loaded.
 */
function clearAllCursors() {
  // Main single-mode cursor canvas
  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  // All SBS panel cursor canvases
  sbsPanels.forEach((panel) => {
    const cursorCvs = panel.querySelector(".sbs-cursor-canvas");
    if (cursorCvs) {
      cursorCvs.getContext("2d").clearRect(0, 0, cursorCvs.width, cursorCvs.height);
    }
  });
}

// =============================================================================
// Microphone recording — MediaRecorder-based audio capture
// =============================================================================
//
// Overview of the MediaRecorder workflow:
//   1. navigator.mediaDevices.getUserMedia({ audio: true }) — request mic access.
//      The browser shows a permission prompt; on denial the returned Promise rejects.
//   2. new MediaRecorder(stream) — wraps the mic stream.  On start() the recorder
//      collects encoded audio chunks (ondataavailable fires for each chunk).
//   3. mediaRecorder.stop() — triggers the final ondataavailable event (flushing any
//      remaining data), then fires onstop when the recording is fully committed.
//   4. In onstop: concatenate all Blob chunks into one Blob, then decode it into
//      a Web Audio AudioBuffer via audioCtx.decodeAudioData().  The AudioBuffer
//      is converted to a mono Float32Array and fed into the shared STFT pipeline —
//      EXACTLY the same path used by file upload, guaranteeing identical processing.
//
// Why reuse the existing pipeline?
//   Computing the spectrogram inline here would duplicate the STFT, normalization,
//   and rendering logic.  Instead, we set the same global state (monoSamples,
//   sampleRate) that the file path sets, then call runPipelineFromSamples() which
//   is the single authoritative processing path for all audio sources.

// ── State variables ──────────────────────────────────────────────────────────
let mediaRecorder       = null;  // active MediaRecorder instance (null when idle)
let recChunks           = [];    // accumulates encoded audio Blobs during recording
let lastRecordingBlob   = null;  // set after a recording completes, used as save-ready flag
let recPCM              = null;  // Float32Array of the processed recording (for WAV export)
let recPCMSampleRate    = 0;     // sample rate matching recPCM
let recStream           = null;  // MediaStream from getUserMedia (held to stop tracks)
let recTimerIntervalId  = null;  // setInterval handle for the elapsed-time display
let recElapsedSec       = 0;     // seconds elapsed in the current recording

// ── setRecordingState — update UI to reflect recording state ─────────────────
/**
 * Sets button enabled states and status text for the three recording states.
 * @param {"idle"|"recording"|"processing"} state
 */
function setRecordingState(state) {
  switch (state) {
    case "idle":
      startRecBtn.disabled = false;
      stopRecBtn.disabled  = true;
      startRecBtn.classList.remove("recording");
      recStatus.textContent = "Idle";
      recStatus.className   = "rec-status";
      recTimer.classList.add("hidden");
      recTimer.textContent  = "0.0 s";
      break;

    case "recording":
      startRecBtn.disabled = true;
      stopRecBtn.disabled  = false;
      startRecBtn.classList.add("recording");
      recStatus.textContent = "Recording\u2026";
      recStatus.className   = "rec-status active";
      recTimer.classList.remove("hidden");
      break;

    case "processing":
      startRecBtn.disabled = true;
      stopRecBtn.disabled  = true;
      startRecBtn.classList.remove("recording");
      recStatus.textContent = "Processing\u2026";
      recStatus.className   = "rec-status processing";
      recTimer.classList.add("hidden");
      break;
  }
}

// ── startRecording ───────────────────────────────────────────────────────────
/**
 * Requests microphone access and begins recording.
 *
 * Uses navigator.mediaDevices.getUserMedia to obtain a microphone stream,
 * then creates a MediaRecorder that collects encoded audio chunks.  The
 * recording runs until the user presses Stop.
 *
 * Possible failures handled:
 *   - Permission denied (NotAllowedError)
 *   - No microphone found (NotFoundError)
 *   - General getUserMedia errors
 */
async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showStatus("Error: getUserMedia not supported in this browser.", true);
    return;
  }

  // Ensure AudioContext exists (required for later decoding).
  // Created here (inside a user-gesture handler) to satisfy autoplay policy.
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();

  try {
    // Request mono audio; sampleRate hint is advisory (browser may ignore it)
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
    });
  } catch (err) {
    // Map Web API error names to friendly messages
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      showStatus("Microphone access denied. Allow permission and try again.", true);
    } else if (err.name === "NotFoundError") {
      showStatus("No microphone found. Connect one and try again.", true);
    } else {
      showStatus(`Microphone error: ${err.message}`, true);
    }
    return;
  }

  recChunks = [];

  // MediaRecorder encodes audio into a container format (typically WebM/Opus).
  // We let the browser choose the best supported mimeType automatically.
  mediaRecorder = new MediaRecorder(recStream);

  // Each ondataavailable callback delivers one encoded audio chunk as a Blob
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recChunks.push(e.data);
  };

  // onstop fires after the final ondataavailable — all chunks are committed
  mediaRecorder.onstop = () => {
    stopRecordingTimer();
    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    recChunks = [];
    lastRecordingBlob = blob;  // stash for Save button
    // Release the microphone immediately after capture
    recStream.getTracks().forEach((t) => t.stop());
    recStream = null;
    // Hand the encoded blob to the decode + pipeline stage
    processRecordedAudio(blob);
  };

  mediaRecorder.onerror = (e) => {
    stopRecordingTimer();
    setRecordingState("idle");
    showStatus(`Recording error: ${e.error ? e.error.message : "unknown"}`, true);
    if (recStream) {
      recStream.getTracks().forEach((t) => t.stop());
      recStream = null;
    }
  };

  // Stop any previous file playback before starting recording
  stopPlayback(true);
  playBtn.disabled = true;
  hideStatus();

  setRecordingState("recording");
  startRecordingTimer();

  mediaRecorder.start();
}

// ── stopRecording ────────────────────────────────────────────────────────────
/**
 * Stops an active recording.  The MediaRecorder.onstop handler fires
 * asynchronously and triggers processRecordedAudio() once all chunks are in.
 */
function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  // stop() triggers the final ondataavailable flush, then calls onstop
  mediaRecorder.stop();
  setRecordingState("processing");
}

// ── Timer helpers ─────────────────────────────────────────────────────────────
function startRecordingTimer() {
  recElapsedSec = 0;
  recTimer.textContent = "0.0 s";
  recTimerIntervalId = setInterval(() => {
    recElapsedSec += 0.1;
    recTimer.textContent = recElapsedSec.toFixed(1) + " s";
  }, 100);
}

function stopRecordingTimer() {
  if (recTimerIntervalId !== null) {
    clearInterval(recTimerIntervalId);
    recTimerIntervalId = null;
  }
}

// ── processRecordedAudio ─────────────────────────────────────────────────────
/**
 * Decodes a recorded audio Blob and feeds it into the shared STFT pipeline.
 *
 * Why pipeline reuse matters:
 *   All STFT computation, dB normalization, colormap rendering, and playback
 *   setup live in runPipelineFromSamples().  Calling it here means recorded
 *   audio goes through EXACTLY the same processing as a file upload — no
 *   duplication, no risk of subtle differences in normalization or display.
 *
 * Conversion steps:
 *   Blob → FileReader → ArrayBuffer → audioCtx.decodeAudioData() → AudioBuffer
 *   AudioBuffer → mix to mono Float32Array
 *   → set global monoSamples / sampleRate → runPipelineFromSamples()
 *
 * @param {Blob} blob - Encoded audio blob from MediaRecorder
 */
async function processRecordedAudio(blob) {
  if (!blob || blob.size === 0) {
    setRecordingState("idle");
    showStatus("Recording produced no audio. Try again.", true);
    return;
  }

  try {
    // ── a. Blob → ArrayBuffer ─────────────────────────────────────────────
    // FileReader bridges the Blob API to the ArrayBuffer that decodeAudioData needs.
    const arrayBuffer = await new Promise((resolve, reject) => {
      const reader  = new FileReader();
      reader.onload  = (e) => resolve(e.target.result);
      reader.onerror = ()  => reject(new Error("FileReader failed reading recorded audio"));
      reader.readAsArrayBuffer(blob);
    });

    // ── b. ArrayBuffer → AudioBuffer (PCM) ────────────────────────────────
    // decodeAudioData decodes the container format (WebM/Opus etc.) into
    // interleaved PCM, exactly as it does for file uploads.
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    const nativeSampleRate = decoded.sampleRate;

    // ── c. Resample to target rate if necessary ───────────────────────────
    // Read the target rate from the UI — same as the file path does.
    const targetRate = Math.max(1, parseInt(sampleRateInput.value, 10) || 48000);
    let sourceBuf = decoded;
    if (nativeSampleRate !== targetRate) {
      const resampledLength = Math.ceil(decoded.length * targetRate / nativeSampleRate);
      const offlineCtx = new OfflineAudioContext(
        decoded.numberOfChannels,
        resampledLength,
        targetRate,
      );
      const src = offlineCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(offlineCtx.destination);
      src.start(0);
      sourceBuf = await offlineCtx.startRendering();
    }

    sampleRate = targetRate;  // set global — same side-effect as loadAudio()

    // ── d. Mix to mono ────────────────────────────────────────────────────
    const numChannels = sourceBuf.numberOfChannels;
    const length      = sourceBuf.length;
    const mono        = new Float32Array(length);

    for (let ch = 0; ch < numChannels; ch++) {
      const chData = sourceBuf.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += chData[i];
    }
    if (numChannels > 1) {
      for (let i = 0; i < length; i++) mono[i] /= numChannels;
    }

    // ── e. Use full recording without trimming ────────────────────────────
    monoSamples = mono;

    // Stash a copy of the raw PCM for WAV export — before the pipeline
    // potentially overwrites monoSamples (e.g. on a subsequent file load).
    recPCM           = monoSamples.slice();
    recPCMSampleRate = sampleRate;

    // ── f. Set CONFIG for a fresh recording: reset start to 0 but honour
    //       the user's segmentDuration input for partial processing.
    readConfigFromUI();
    CONFIG.startTime = 0;

    // Sync the start-time input; leave segDuration as the user entered it
    startTimeInput.value = "0";

    // Reset any stale file display so the metadata section shows recording info
    fileNameDisplay.textContent = "— (microphone)";
    fileNameDisplay.classList.remove("selected");

    // Stop any stale playback state before the new pipeline run
    stopPlayback(true);
    clearCanvas();
    spectroGrid.classList.add("hidden");
    placeholder.classList.remove("hidden");

    // ── g. Run the shared STFT pipeline ──────────────────────────────────
    await runPipelineFromSamples();

    // Re-enable the Run button for re-processing with different parameters
    processBtn.disabled = false;

    saveRecBtn.classList.remove("hidden");
    setRecordingState("idle");
  } catch (err) {
    setRecordingState("idle");
    showStatus(`Error processing recording: ${err.message}`, true);
    console.error(err);
  }
}

// ── encodeWAV — build a 16-bit mono WAV Blob from a Float32Array ─────────────
function encodeWAV(samples, sr) {
  const numSamples   = samples.length;
  const bitsPerSample = 16;
  const blockAlign   = bitsPerSample / 8;          // 2 bytes per sample (mono)
  const byteRate     = sr * blockAlign;
  const dataSize     = numSamples * blockAlign;
  const buffer       = new ArrayBuffer(44 + dataSize);
  const view         = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0,  "RIFF");
  view.setUint32(4,  36 + dataSize, true);   // ChunkSize
  writeStr(8,  "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16,            true);   // Subchunk1Size (PCM)
  view.setUint16(20, 1,             true);   // AudioFormat = PCM
  view.setUint16(22, 1,             true);   // NumChannels = 1
  view.setUint32(24, sr,            true);   // SampleRate
  view.setUint32(28, byteRate,      true);   // ByteRate
  view.setUint16(32, blockAlign,    true);   // BlockAlign
  view.setUint16(34, bitsPerSample, true);   // BitsPerSample
  writeStr(36, "data");
  view.setUint32(40, dataSize,      true);   // Subchunk2Size

  // Convert Float32 [-1, 1] → Int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// ── saveRecording — download the processed recording as a timestamped WAV ─────
function saveRecording() {
  if (!recPCM) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
                `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const blob = encodeWAV(recPCM, recPCMSampleRate);
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `Recording_${stamp}.wav`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Event listeners ──────────────────────────────────────────────────────────
startRecBtn.addEventListener("click", startRecording);
stopRecBtn.addEventListener("click",  stopRecording);
saveRecBtn.addEventListener("click",  saveRecording);

// ── Info modal ───────────────────────────────────────────────────────────────
const infoBtn    = document.getElementById("infoBtn");
const infoModal  = document.getElementById("infoModal");
const infoCloseBtn = document.getElementById("infoCloseBtn");

function openInfoModal() {
  infoModal.classList.remove("hidden");
  infoCloseBtn.focus();
}

function closeInfoModal() {
  infoModal.classList.add("hidden");
  infoBtn.focus();
}

infoBtn.addEventListener("click", openInfoModal);
infoCloseBtn.addEventListener("click", closeInfoModal);

// Close on backdrop click (click outside the modal box)
infoModal.addEventListener("click", function (e) {
  if (e.target === infoModal) closeInfoModal();
});

// Close on Escape key
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && !infoModal.classList.contains("hidden")) {
    closeInfoModal();
  }
});

// =============================================================================
// WINDOW FUNCTION VISUALIZATION
//
// Renders the time-domain shape of window functions directly into the sidebar.
//
// Why a shared overlay canvas instead of stacked panels?
//   Four separate canvases force the eye to align curves across disconnected
//   plots — a mentally expensive task.  A single overlay plot with shared axes
//   makes amplitude differences at every sample index immediately visible:
//   you can see in one glance that Hamming ends at ≈0.08 while Hann and
//   Blackman taper cleanly to zero, and that Blackman's peak is narrower
//   than Hamming's.  Direct comparison on common axes is how oscilloscopes,
//   MATLAB's Signal Analyzer, and most DSP textbooks present window overlays.
//
// Mode-dependent behaviour:
//   single     → one curve (selected window) + KaTeX equation below canvas
//   sidebyside → all four curves overlaid + in-canvas legend; no equation
// =============================================================================

// ── DOM refs ─────────────────────────────────────────────────────────────────
const winVizCanvas  = document.getElementById("winVizCanvas");
const winEquationEl = document.getElementById("winEquation");
const winFreqCanvas = document.getElementById("winFreqCanvas");

// ── Window colours — distinct, high-contrast on the dark background ──────────
const WIN_COLORS = {
  rectangular: "#5a8fff",  // blue
  hann:        "#4dd8a0",  // teal-green
  hamming:     "#f0c040",  // amber
  blackman:    "#e05252",  // red
};

// ── KaTeX LaTeX strings ───────────────────────────────────────────────────────
/*
 * Why KaTeX?  Window equations contain fractions, Greek letters, and
 * subscripts that are unambiguous only in properly typeset math.
 * Writing "0.54 - 0.46*cos(2πn/(N-1))" in plain text is error-prone to
 * read; KaTeX renders it as publication-quality LaTeX.
 *
 * All equations use the symmetric N−1 denominator (see generateWindow comment).
 */
const WIN_EQUATIONS = {
  rectangular: "w[n] = 1",
  hann:        "w[n] = 0.5 - 0.5\\cos\\!\\left(\\dfrac{2\\pi n}{N-1}\\right)",
  hamming:     "w[n] = 0.54 - 0.46\\cos\\!\\left(\\dfrac{2\\pi n}{N-1}\\right)",
  blackman:    "w[n] = 0.42 - 0.5\\cos\\!\\left(\\dfrac{2\\pi n}{N-1}\\right)" +
               " + 0.08\\cos\\!\\left(\\dfrac{4\\pi n}{N-1}\\right)",
};

// =============================================================================
// generateWindow(type, N) → Float32Array
// =============================================================================
/**
 * Returns N window coefficients for `type`.
 *
 * Why N−1 in the denominator?
 *   The window is defined over sample indices n = 0 … N−1.  Using N−1 as the
 *   period ensures:
 *     • n = 0   → argument of cos = 0   → w[0] is the start value
 *     • n = N−1 → argument of cos = 2π  → w[N−1] equals w[0] (symmetric ends)
 *   Using N instead would make the function periodic with period N, so the
 *   last sample would be one step short of completing the cosine cycle —
 *   this is the "periodic" form used for spectral analysis with overlap-add,
 *   but the "symmetric" (N−1) form is correct for a finite-length window.
 *
 * Window shapes and spectral leakage:
 *   The STFT frames each piece of signal with a window, then computes the FFT.
 *   The resulting spectrum is the convolution of the true spectrum with the
 *   window's frequency response (its Fourier transform).  A rectangular window
 *   has the narrowest main lobe (best frequency resolution) but very high
 *   sidelobes (−13 dB), causing energy from strong frequency components to
 *   "leak" into adjacent bins.  Tapered windows (Hann, Hamming, Blackman)
 *   reduce sidelobes at the cost of a wider main lobe.
 *
 * @param {string} type - "rectangular" | "hann" | "hamming" | "blackman"
 * @param {number} N    - Frame length in samples
 * @returns {Float32Array} coefficients w[0 … N−1] ∈ [0, 1]
 */
function generateWindow(type, N) {
  // Custom window: same delegation as buildWindow().
  // Both functions compute window coefficients; the only difference is which
  // call-site invokes them (STFT pipeline vs. sidebar visualization).
  if (type === "custom" || type.startsWith("csaved:")) {
    return cwGetWindowArray(type, N);
  }

  const w      = new Float32Array(N);
  const TWO_PI = 2 * Math.PI;
  const NM1    = N - 1;  // symmetric denominator — see doc-comment above

  for (let n = 0; n < N; n++) {
    switch (type) {
      case "hann":
        // Raised cosine tapering to exactly 0 at both ends.
        // Sidelobe level ≈ −32 dB; main-lobe width = 4 FFT bins.
        w[n] = 0.5 - 0.5 * Math.cos(TWO_PI * n / NM1);
        break;

      case "hamming":
        // Optimised raised cosine; does NOT reach 0 at ends (≈ 0.08).
        // Better sidelobe rejection than Hann (≈ −43 dB); standard in speech.
        w[n] = 0.54 - 0.46 * Math.cos(TWO_PI * n / NM1);
        break;

      case "blackman":
        // Three-term cosine.  Lowest sidelobes of the four (≈ −74 dB).
        // Widest main lobe; best for detecting weak tones near strong ones.
        w[n] = 0.42
             - 0.5  * Math.cos(TWO_PI * n / NM1)
             + 0.08 * Math.cos(4 * Math.PI * n / NM1);
        break;

      case "rectangular":
      default:
        // Uniform weighting — equivalent to no window.
        // Sharpest resolution but severe leakage (sinc sidelobes at −13 dB).
        w[n] = 1.0;
        break;
    }
  }
  return w;
}

// =============================================================================
// nextPow2(n) — smallest power of 2 ≥ n
// =============================================================================
/**
 * @param {number} n
 * @returns {number}
 */
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// =============================================================================
// computeWindowFFT(windowData) → Float32Array
// =============================================================================
/**
 * Computes the magnitude frequency response of a window function in dB.
 *
 * Why zero-padding?
 *   A window of length N has only N points in the time domain, giving an FFT
 *   with N bins spaced at fs/N Hz.  Zero-padding to N_fft = 8·N interpolates
 *   the DTFT, revealing the smooth shape of the main lobe and sidelobes at 8×
 *   finer frequency resolution — exactly like scipy.signal.freqz.  The extra
 *   bins are mathematically equivalent to evaluating the DTFT at more
 *   frequencies; they add no new information but make the curve smooth and
 *   let the eye trace the sidelobe decay without aliasing artefacts.
 *
 * Why dB scale?
 *   Window sidelobe levels span 4–5 orders of magnitude (−13 dB rectangular
 *   to −74 dB Blackman).  A linear amplitude axis would compress all the
 *   interesting sidelobe structure into an imperceptible smear at the bottom.
 *   The dB scale expands the sidelobe region, making the leakage rejection of
 *   each window directly readable — e.g. "Blackman: −74 dB sidelobes means
 *   a tone at 1 kHz contributes at most −74 dB to any other bin."
 *
 * Relation between main lobe width and frequency resolution:
 *   The width of the main lobe (in bins) is the frequency resolution cost of
 *   the window.  Rectangular: 2 bins wide → sharpest resolution but −13 dB
 *   sidelobes.  Blackman: ≈6 bins wide → three times worse resolution but
 *   −74 dB sidelobes.  The spectrogram inherits this trade-off: use Blackman
 *   on audio with a wide dynamic range, Rectangular when two nearby tones
 *   must be resolved.
 *
 * Relation between sidelobes and spectral leakage:
 *   When a tone falls between two FFT bins its energy "leaks" into neighboring
 *   bins with the pattern of the window's sidelobe structure.  High sidelobes
 *   (rectangular) mask nearby weaker tones; low sidelobes (Blackman) keep
 *   leakage below the noise floor for typical audio.
 *
 * @param {Float32Array} windowData - Window coefficients w[0 … N−1]
 * @returns {Float32Array} magnitudeDb — N_fft/2+1 values, peak = 0 dB
 */
function computeWindowFFT(windowData) {
  const N     = windowData.length;
  // 8× zero-padding gives smooth sidelobe curves while remaining fast.
  // The FFT size must be a power of 2 (fft.js requirement).
  const N_fft = nextPow2(8 * N);

  const fftInstance  = new FFT(N_fft);
  // createComplexArray() returns a Float64Array pre-filled with zeros.
  // Imaginary parts stay 0 for a real-valued input — no extra clearing needed.
  const complexInput = fftInstance.createComplexArray();
  const out          = fftInstance.createComplexArray();

  // Copy window into the real part; zero-padding is already in place.
  for (let n = 0; n < N; n++) {
    complexInput[2 * n] = windowData[n];
  }

  fftInstance.transform(out, complexInput);

  // Positive-frequency bins only: 0 (DC) … N_fft/2 (Nyquist)
  const numBins = N_fft / 2 + 1;
  const magDb   = new Float32Array(numBins);

  for (let k = 0; k < numBins; k++) {
    const re  = out[2 * k];
    const im  = out[2 * k + 1];
    const mag = Math.sqrt(re * re + im * im);
    // 20·log10 for amplitude (voltage/pressure) spectrum.
    // 1e-12 floor prevents log10(0) = −∞ on silence (numerically stable).
    magDb[k] = 20 * Math.log10(mag + 1e-12);
  }

  // Normalize so the peak bin = 0 dB.
  // This makes every window comparable on the same axes regardless of the
  // absolute gain produced by different coefficient sums.
  let maxDb = -Infinity;
  for (let k = 0; k < numBins; k++) {
    if (magDb[k] > maxDb) maxDb = magDb[k];
  }
  for (let k = 0; k < numBins; k++) {
    magDb[k] -= maxDb;
  }

  return magDb;  // values ∈ (−∞, 0], peak = 0 dB
}

// =============================================================================
// mapFrequencyAxis(numBins, N_fft) — normalized frequency per bin
// =============================================================================
/**
 * Returns the normalized frequency (cycles/sample, 0 … 0.5) for each
 * positive-frequency bin k of an N_fft-point FFT.
 *
 *   f[k] = k / N_fft    (0 = DC, 0.5 = Nyquist)
 *
 * Using normalized frequency (independent of fs) keeps the plot valid
 * even before audio is loaded — a window's leakage character is a
 * property of its shape, not the sample rate.
 *
 * @param {number} numBins - N_fft/2 + 1
 * @param {number} N_fft
 * @returns {Float32Array}
 */
function mapFrequencyAxis(numBins, N_fft) {
  const freqs = new Float32Array(numBins);
  for (let k = 0; k < numBins; k++) {
    freqs[k] = k / N_fft;
  }
  return freqs;
}

// =============================================================================
// niceFreqTicks(fMax) — nice tick values for an adaptive frequency axis
// =============================================================================
/**
 * Returns ~4 round tick values covering [0, fMax] for the frequency axis.
 * Uses the same 1-2-5 rounding strategy as niceTicks() on the main axes.
 *
 * @param {number} fMax - Maximum normalized frequency to display
 * @returns {number[]}
 */
function niceFreqTicks(fMax) {
  const roughStep = fMax / 4;  // target ~4 intervals → ~5 ticks
  const mag       = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const norm      = roughStep / mag;
  let step;
  if      (norm < 1.5) step = 1 * mag;
  else if (norm < 3.5) step = 2 * mag;
  else                 step = 5 * mag;

  const ticks = [0];
  for (let t = step; t <= fMax + step * 1e-6; t += step) {
    // Round to avoid floating-point drift (e.g. 0.02000000001)
    ticks.push(Math.round(t / step) * step);
  }
  return ticks;
}

// =============================================================================
// findSidelobePeaks(magDb, kMax, maxPeaks) — locate sidelobe local maxima
// =============================================================================
/**
 * Finds the first `maxPeaks` sidelobe peaks in magDb[0 … kMax-1].
 *
 * Algorithm:
 *   1. Skip the main lobe by descending from k=0 until the first local
 *      minimum (first null of the window's frequency response).
 *   2. Scan forward for subsequent local maxima — each is a sidelobe peak.
 *
 * Works reliably on the smooth 8× zero-padded response from computeWindowFFT()
 * where each sidelobe creates a clear, well-separated local maximum.
 *
 * @param {Float32Array} magDb    - dB values from computeWindowFFT()
 * @param {number}       kMax    - Scan only bins 0 … kMax-1
 * @param {number}       maxPeaks - Maximum number of peaks to return
 * @returns {{ k: number, db: number }[]}
 */
function findSidelobePeaks(magDb, kMax, maxPeaks) {
  // Step 1: descend from the main-lobe peak (k=0) to the first null.
  // The condition magDb[k+1] <= magDb[k] means "still descending or flat".
  let k = 0;
  while (k < kMax - 1 && magDb[k + 1] <= magDb[k]) k++;
  // k is now at the first null; move one step into the sidelobe region.
  k++;

  const peaks = [];
  while (k < kMax - 1 && peaks.length < maxPeaks) {
    // Local maximum: strictly higher than left neighbour, ≥ right neighbour.
    if (magDb[k] > magDb[k - 1] && magDb[k] >= magDb[k + 1]) {
      peaks.push({ k, db: magDb[k] });
      // Skip the descending edge of this sidelobe to land near the next null.
      while (k < kMax - 1 && magDb[k] >= magDb[k + 1]) k++;
    }
    k++;
  }
  return peaks;
}

// =============================================================================
// renderFrequencyResponse(cvs, dataList)
// =============================================================================
/**
 * Draws the magnitude frequency response (in dB) for one or more windows.
 *
 * The X-axis is adaptively zoomed to show only the main lobe plus the first
 * 2-3 sidelobes of the widest window (Blackman), keeping the plot readable
 * and removing the cluttered flat region that extends to 0.5.
 *
 *   X-axis : Normalized Frequency (0 → f_max ≈ 12/N)
 *   Y-axis : Magnitude (dB)       (0 dB top → −100 dB bottom)
 *   Ticks  : Y = 0, −20, −40, −60, −80; X = nice ticks for [0, f_max]
 *   Markers: colored dot + dB label at each annotated sidelobe peak
 *   Legend : shown when dataList.length > 1
 *
 * Expected visual characteristics (confirms correct implementation):
 *   Rectangular : narrow tall main lobe; high sidelobes (≈ −13 dB) that
 *                 decay slowly — classic sinc² envelope.
 *   Hann        : wider main lobe (≈4 bins); sidelobes at ≈ −32 dB, fast rolloff.
 *   Hamming     : similar width to Hann; sidelobes plateau at ≈ −43 dB.
 *   Blackman    : widest main lobe (≈6 bins); sidelobes below −74 dB.
 *
 * @param {HTMLCanvasElement} cvs
 * @param {{ data: Float32Array, color: string, label: string }[]} dataList
 */
function renderFrequencyResponse(cvs, dataList) {
  if (!dataList || dataList.length === 0) return;

  // ── DPR-correct canvas sizing ─────────────────────────────────────────────
  const dpr  = window.devicePixelRatio || 1;
  const cssW = cvs.offsetWidth  || 300;
  const cssH = cvs.offsetHeight || 160;
  cvs.width  = Math.round(cssW * dpr);
  cvs.height = Math.round(cssH * dpr);

  const ctx = cvs.getContext("2d");
  ctx.scale(dpr, dpr);

  // ── Layout ────────────────────────────────────────────────────────────────
  const PAD_L = 34;
  const PAD_R = 10;
  const PAD_T = 8;
  const PAD_B = 28;
  const plotW = cssW - PAD_L - PAD_R;
  const plotH = cssH - PAD_T - PAD_B;

  // ── dB axis range ─────────────────────────────────────────────────────────
  const DB_MIN = -100;
  const DB_MAX =    0;

  // ── Adaptive frequency zoom ───────────────────────────────────────────────
  // N_fft = 2*(numBins-1) from computeWindowFFT; N_orig = N_fft/8 (8× padding).
  // Showing 0 to 12/N_orig (= 96/N_fft) normalized freq displays:
  //   Blackman (main lobe 6 bins) : main lobe + ~2-3 sidelobes
  //   Hann/Hamming (4 bins)       : main lobe + ~4 sidelobes
  //   Rectangular (2 bins)        : main lobe + ~5 sidelobes
  // This makes the leakage difference visible without showing the dull flat
  // sidelobe tail that extends all the way to 0.5.
  const numBins0 = dataList[0].data.length;
  const N_fft0   = (numBins0 - 1) * 2;
  const f_max    = Math.min(0.5, 96 / N_fft0);

  // ── Coordinate helpers ────────────────────────────────────────────────────
  const xPx = (f)  => PAD_L + (f / f_max) * plotW;
  const yPx = (db) => PAD_T + ((DB_MAX - db) / (DB_MAX - DB_MIN)) * plotH;

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = "#0f1115";
  ctx.fillRect(0, 0, cssW, cssH);

  // ── Grid lines ────────────────────────────────────────────────────────────
  const dbTicks = [0, -20, -40, -60, -80];
  const fTicks  = niceFreqTicks(f_max);

  ctx.strokeStyle = "#1e2128";
  ctx.lineWidth   = 1;

  for (const db of dbTicks) {
    const y = yPx(db);
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(PAD_L + plotW, y);
    ctx.stroke();
  }
  for (const f of fTicks) {
    const x = xPx(f);
    ctx.beginPath();
    ctx.moveTo(x, PAD_T);
    ctx.lineTo(x, PAD_T + plotH);
    ctx.stroke();
  }

  // ── Axis lines ────────────────────────────────────────────────────────────
  ctx.strokeStyle = "#4a5060";
  ctx.lineWidth   = 1;

  ctx.beginPath();
  ctx.moveTo(PAD_L, PAD_T);
  ctx.lineTo(PAD_L, PAD_T + plotH);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(PAD_L,         PAD_T + plotH);
  ctx.lineTo(PAD_L + plotW, PAD_T + plotH);
  ctx.stroke();

  // ── Tick marks and labels ─────────────────────────────────────────────────
  ctx.font      = "10px Consolas, Menlo, monospace";
  ctx.fillStyle = "#6a6f7a";
  ctx.lineWidth = 1;

  // Y-axis dB ticks
  ctx.textAlign    = "right";
  ctx.textBaseline = "middle";
  for (const db of dbTicks) {
    const y = yPx(db);
    ctx.strokeStyle = "#4a5060";
    ctx.beginPath();
    ctx.moveTo(PAD_L - 4, y);
    ctx.lineTo(PAD_L,     y);
    ctx.stroke();
    ctx.fillText(String(db), PAD_L - 6, y);
  }

  // X-axis ticks — determine decimal places from the tick step size
  const fStep = fTicks.length > 1 ? (fTicks[1] - fTicks[0]) : f_max;
  const fDec  = fStep < 0.001 ? 4 : fStep < 0.01 ? 3 : 2;

  ctx.textAlign    = "center";
  ctx.textBaseline = "top";
  for (const f of fTicks) {
    const x = xPx(f);
    ctx.strokeStyle = "#4a5060";
    ctx.beginPath();
    ctx.moveTo(x, PAD_T + plotH);
    ctx.lineTo(x, PAD_T + plotH + 4);
    ctx.stroke();
    ctx.fillText(f === 0 ? "0" : f.toFixed(fDec), x, PAD_T + plotH + 6);
  }

  // Axis titles
  ctx.font         = "9px Consolas, Menlo, monospace";
  ctx.fillStyle    = "#4a5060";
  ctx.textAlign    = "center";
  ctx.textBaseline = "top";
  ctx.fillText("Normalized Frequency", PAD_L + plotW / 2, PAD_T + plotH + 17);

  ctx.textAlign    = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText("dB", PAD_L - 18, PAD_T + 2);

  // ── Frequency response curves + sidelobe peak collection ─────────────────
  // Clip to the plot area so curves stay within the axes.
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD_L, PAD_T, plotW, plotH);
  ctx.clip();

  // Single mode: annotate first 2 sidelobe peaks.
  // Multi-window overlay: no annotations — four sets of labels would overlap
  // and obscure the curves; the color legend already identifies each window.
  const isSingle  = dataList.length === 1;
  const peakLimit = isSingle ? 2 : 0;
  const allPeaks  = [];  // { px, py, db, color }

  for (const { data, color } of dataList) {
    const numBins = data.length;
    const N_fft   = (numBins - 1) * 2;
    // Extend two bins past f_max so the curve's last point isn't cut short.
    const kMax    = Math.min(numBins, Math.floor(f_max * N_fft) + 2);

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = "round";

    for (let k = 0; k < kMax; k++) {
      const f  = k / N_fft;
      const db = Math.max(DB_MIN, data[k]);
      const x  = xPx(f);
      const y  = yPx(db);
      if (k === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Collect sidelobe peaks for annotation.
    const peaks = findSidelobePeaks(data, kMax, peakLimit);
    for (const { k, db } of peaks) {
      allPeaks.push({
        px:    xPx(k / N_fft),
        py:    yPx(Math.max(DB_MIN, db)),
        db,
        color,
      });
    }
  }

  // Sidelobe peak dots — drawn within the clip region.
  for (const { px, py, color } of allPeaks) {
    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  ctx.restore();  // end clip

  // ── Sidelobe peak labels ──────────────────────────────────────────────────
  // Drawn outside the clip region so text is never cut off at the plot edges.
  // Labels flip to the left when too close to the right margin.
  ctx.font     = "8px Consolas, Menlo, monospace";
  ctx.lineWidth = 1;
  for (const { px, py, db, color } of allPeaks) {
    const label  = Math.round(db) + " dB";
    const flipL  = px + 38 > PAD_L + plotW;
    ctx.textAlign    = flipL ? "right" : "left";
    ctx.textBaseline = "bottom";
    ctx.fillStyle    = color;
    // Keep the label y within the plot area (avoid clipping at the top/bottom).
    const labelY = Math.max(PAD_T + 8, Math.min(PAD_T + plotH, py - 3));
    ctx.fillText(label, px + (flipL ? -4 : 4), labelY);
  }

  // ── Legend (multi-window) ─────────────────────────────────────────────────
  if (dataList.length > 1) {
    drawFreqLegend(ctx, dataList, PAD_L + plotW, PAD_T);
  }
}

// =============================================================================
// drawFreqLegend — compact in-canvas legend for the frequency-response plot
// =============================================================================
/**
 * Same visual style as drawLegend() but takes `label` strings verbatim
 * instead of looking them up in WIN_NAMES — works for any label.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ label: string, color: string }[]} dataList
 * @param {number} rightX
 * @param {number} topY
 */
function drawFreqLegend(ctx, dataList, rightX, topY) {
  const LINE_LEN  = 14;
  const ROW_H     = 14;
  const PAD       = 4;
  const FONT_SIZE = 10;

  ctx.font = `${FONT_SIZE}px Consolas, Menlo, monospace`;

  let maxNameW = 0;
  for (const { label } of dataList) {
    const w = ctx.measureText(label).width;
    if (w > maxNameW) maxNameW = w;
  }

  const boxW = PAD + LINE_LEN + 4 + maxNameW + PAD;
  const boxH = PAD + dataList.length * ROW_H + PAD;
  const boxX = rightX - boxW - 2;
  const boxY = topY + 2;

  ctx.fillStyle = "rgba(15, 17, 21, 0.82)";
  ctx.fillRect(boxX, boxY, boxW, boxH);

  for (let i = 0; i < dataList.length; i++) {
    const { label, color } = dataList[i];
    const rowMidY = boxY + PAD + i * ROW_H + ROW_H / 2;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.moveTo(boxX + PAD,            rowMidY);
    ctx.lineTo(boxX + PAD + LINE_LEN, rowMidY);
    ctx.stroke();

    ctx.fillStyle    = "#9aa0ad";
    ctx.textAlign    = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, boxX + PAD + LINE_LEN + 4, rowMidY);
  }
}

// =============================================================================
// renderWindowsOnCanvas(cvs, windowList, N)
// =============================================================================
/**
 * Draws one or more window functions onto `cvs` with calibrated axes, tick
 * marks, tick labels, and — when more than one window is shown — a legend.
 *
 * Axis scaling:
 *   Y-axis is ALWAYS fixed to the absolute range [0, 1].  This is critical
 *   for fair comparison: auto-scaling each window individually would make
 *   Hamming (ends ≈ 0.08) look identical to Hann (ends = 0) because both
 *   would be stretched to fill the plot height.  Fixed scaling makes the
 *   non-zero end values of Hamming visually obvious.
 *
 *   X-axis maps sample index n ∈ [0, N−1] to pixels:
 *     x = PAD_L + (n / (N−1)) × plotW
 *   The N−1 denominator is consistent with the window definition denominator:
 *   n=0 lands on the left axis line; n=N−1 lands on the right axis line.
 *
 *   Y pixel mapping (amplitude → pixels, Y-down coordinate system):
 *     y = PAD_T + (1 − amplitude) × plotH
 *   Amplitude 1 → top of plot area; amplitude 0 → bottom.
 *
 * @param {HTMLCanvasElement}          cvs        - Target canvas
 * @param {{type:string,color:string}[]} windowList - Ordered list of windows
 * @param {number}                     N          - Frame size (samples)
 */
function renderWindowsOnCanvas(cvs, windowList, N) {
  // ── DPR-correct canvas sizing ─────────────────────────────────────────────
  // Setting canvas.width = cssPixels × dpr gives one canvas pixel per physical
  // pixel, eliminating the blurriness that occurs when the browser upscales a
  // lower-resolution canvas to fill its CSS box.
  const dpr  = window.devicePixelRatio || 1;
  const cssW = cvs.offsetWidth  || 300;
  const cssH = cvs.offsetHeight || 140;
  cvs.width  = Math.round(cssW * dpr);
  cvs.height = Math.round(cssH * dpr);

  const ctx = cvs.getContext("2d");
  ctx.scale(dpr, dpr);   // scale once so all coordinates are in CSS pixels

  // ── Layout: padding around the plot area ──────────────────────────────────
  //   PAD_L: room for Y-tick labels ("1", ".5", "0") + tick marks
  //   PAD_B: room for X-tick labels and the axis title "n"
  //   PAD_T, PAD_R: visual breathing room
  const PAD_L = 30;
  const PAD_R = 10;
  const PAD_T = 8;
  const PAD_B = 24;
  const plotW = cssW - PAD_L - PAD_R;
  const plotH = cssH - PAD_T - PAD_B;

  // ── Coordinate helpers ────────────────────────────────────────────────────
  // xPx(n)   → pixel X for sample index n (n=0 at left axis, n=N-1 at right)
  // yPx(amp) → pixel Y for amplitude in [0,1] (1=top, 0=bottom)
  const xPx = (n)   => PAD_L + (n / (N - 1)) * plotW;
  const yPx = (amp) => PAD_T + (1 - amp) * plotH;

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = "#0f1115";
  ctx.fillRect(0, 0, cssW, cssH);

  // ── Grid lines ────────────────────────────────────────────────────────────
  // Drawn first so window curves paint over them cleanly.
  ctx.strokeStyle = "#1e2128";
  ctx.lineWidth   = 1;

  // Horizontal grid at amplitude 0, 0.5, 1
  for (const amp of [0, 0.5, 1]) {
    const y = yPx(amp);
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(PAD_L + plotW, y);
    ctx.stroke();
  }

  // Vertical grid at n = 0, floor(N/2), N-1
  const xTickNs = [0, Math.floor(N / 2), N - 1];
  for (const n of xTickNs) {
    const x = xPx(n);
    ctx.beginPath();
    ctx.moveTo(x, PAD_T);
    ctx.lineTo(x, PAD_T + plotH);
    ctx.stroke();
  }

  // ── Axis lines ────────────────────────────────────────────────────────────
  ctx.strokeStyle = "#4a5060";
  ctx.lineWidth   = 1;

  // Left (Y) axis
  ctx.beginPath();
  ctx.moveTo(PAD_L, PAD_T);
  ctx.lineTo(PAD_L, PAD_T + plotH);
  ctx.stroke();

  // Bottom (X) axis
  ctx.beginPath();
  ctx.moveTo(PAD_L,          PAD_T + plotH);
  ctx.lineTo(PAD_L + plotW,  PAD_T + plotH);
  ctx.stroke();

  // ── Tick marks and labels ─────────────────────────────────────────────────
  ctx.font        = "10px Consolas, Menlo, monospace";
  ctx.fillStyle   = "#6a6f7a";
  ctx.strokeStyle = "#4a5060";
  ctx.lineWidth   = 1;

  // Y-axis ticks and labels (left side)
  ctx.textAlign    = "right";
  ctx.textBaseline = "middle";
  for (const amp of [0, 0.5, 1]) {
    const y = yPx(amp);
    // 4px outward tick mark
    ctx.beginPath();
    ctx.moveTo(PAD_L - 4, y);
    ctx.lineTo(PAD_L,     y);
    ctx.stroke();
    // Compact label: "1", ".5", "0" — unambiguous and fits in 30px left pad
    const label = amp === 1 ? "1" : amp === 0.5 ? ".5" : "0";
    ctx.fillText(label, PAD_L - 6, y);
  }

  // X-axis ticks and labels (bottom)
  ctx.textAlign    = "center";
  ctx.textBaseline = "top";
  for (const n of xTickNs) {
    const x = xPx(n);
    // 4px downward tick mark
    ctx.beginPath();
    ctx.moveTo(x, PAD_T + plotH);
    ctx.lineTo(x, PAD_T + plotH + 4);
    ctx.stroke();
    // Label: actual sample index number
    const label = n === 0 ? "0"
                : n === N - 1 ? String(N - 1)
                : String(Math.floor(N / 2));
    ctx.fillText(label, x, PAD_T + plotH + 6);
  }

  // X-axis title "n" — identifies the axis as sample index
  ctx.textAlign    = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle    = "#4a5060";
  ctx.fillText("n", PAD_L + plotW + 2, PAD_T + plotH + 6);

  // ── Window curves ─────────────────────────────────────────────────────────
  // Clip to the plot area so no curve strays into the axis-label gutters.
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD_L, PAD_T, plotW, plotH);
  ctx.clip();

  for (const { type, color } of windowList) {
    const w = generateWindow(type, N);

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = "round";

    for (let n = 0; n < N; n++) {
      // Direct coordinate mapping — no separate normalisation step because
      // Y is fixed to [0, 1] and the window coefficients are already in [0, 1].
      const x = xPx(n);
      const y = yPx(w[n]);
      if (n === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.restore();  // end clip

  // ── Legend (multi-window modes only) ─────────────────────────────────────
  if (windowList.length > 1) {
    drawLegend(ctx, windowList, PAD_L + plotW, PAD_T);
  }
}

// =============================================================================
// drawLegend(ctx, windowList, rightX, topY)
// =============================================================================
/**
 * Draws a compact color-keyed legend inside the canvas, anchored to the
 * top-right corner of the plot area.
 *
 * A semi-transparent background rect makes the legend readable even when
 * window curves pass through the corner region.
 *
 * @param {CanvasRenderingContext2D}    ctx        - 2D context (CSS-px scale)
 * @param {{type:string,color:string}[]} windowList
 * @param {number} rightX - right edge of plot area (CSS px)
 * @param {number} topY   - top edge of plot area (CSS px)
 */
function drawLegend(ctx, windowList, rightX, topY) {
  const WIN_NAMES = {
    rectangular: "Rectangular",
    hann:        "Hann",
    hamming:     "Hamming",
    blackman:    "Blackman",
  };

  const LINE_LEN  = 14;  // px — length of the colored swatch line
  const ROW_H     = 14;  // px — row pitch (line height + gap)
  const PAD       = 4;   // px — inner padding of the legend box
  const FONT_SIZE = 10;

  ctx.font = `${FONT_SIZE}px Consolas, Menlo, monospace`;

  // Size the legend box to the widest name
  let maxNameW = 0;
  for (const { type } of windowList) {
    const w = ctx.measureText(WIN_NAMES[type] || type).width;
    if (w > maxNameW) maxNameW = w;
  }

  const boxW = PAD + LINE_LEN + 4 + maxNameW + PAD;
  const boxH = PAD + windowList.length * ROW_H + PAD;
  const boxX = rightX - boxW - 2;
  const boxY = topY   + 2;

  // Semi-transparent background
  ctx.fillStyle = "rgba(15, 17, 21, 0.82)";
  ctx.fillRect(boxX, boxY, boxW, boxH);

  // One row per window: colored swatch line + name
  for (let i = 0; i < windowList.length; i++) {
    const { type, color } = windowList[i];
    const rowMidY = boxY + PAD + i * ROW_H + ROW_H / 2;

    // Swatch line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.moveTo(boxX + PAD,            rowMidY);
    ctx.lineTo(boxX + PAD + LINE_LEN, rowMidY);
    ctx.stroke();

    // Name label
    ctx.fillStyle    = "#9aa0ad";
    ctx.textAlign    = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(WIN_NAMES[type] || type, boxX + PAD + LINE_LEN + 4, rowMidY);
  }
}

// =============================================================================
// renderEquation(type, container)
// =============================================================================
/**
 * Renders the KaTeX LaTeX equation for `type` into `container`.
 *
 * Falls back to plain-text ASCII if KaTeX is not yet loaded (CDN delay, no
 * network, etc.).  The canvas-plot is always drawn regardless, so the user
 * sees the shape even without typeset math.
 *
 * @param {string}      type      - Window type key
 * @param {HTMLElement} container - DOM element to render into
 */
function renderEquation(type, container) {
  const latex = WIN_EQUATIONS[type] || "";
  if (!latex) { container.textContent = ""; return; }

  try {
    katex.render(latex, container, {
      throwOnError: false,
      displayMode: false,
    });
  } catch (_) {
    container.textContent = WIN_EQUATIONS[type];
  }
}

// =============================================================================
// renderWindowPanel()
// =============================================================================
/**
 * Orchestrates the window-function visualization for the current UI state.
 *
 * Called on:
 *   - frame_size input / change
 *   - window type selector change
 *   - comparison mode selector change
 *   - post-Run (so the plot always reflects the actual frame size used)
 *   - page load (two-pass: immediate draw + delayed KaTeX re-render)
 *
 * Single mode:
 *   Draws one curve for the selected window with axes and ticks.
 *   Shows the KaTeX equation below the canvas.
 *
 * Side-by-side mode:
 *   Overlays all four window curves on the same axes with an in-canvas legend.
 *   Hides the equation div (the legend inside the canvas is sufficient).
 *   An overlay is more useful than four stacked plots because it lets the
 *   analyst see exactly how the windows compare at every sample index — for
 *   instance, that Hamming sits ≈0.08 above zero at the ends while Hann
 *   and Blackman touch zero, and that Blackman has a lower, wider peak.
 */
function renderWindowPanel() {
  const mode    = comparisonModeSelect.value;
  const N       = Math.max(4, parseInt(frameSizeInput.value, 10) || 256);
  const winType = windowSelect.value;

  if (mode === "sidebyside") {
    // ── Overlay all four windows on one canvas ────────────────────────────
    // Hide the equation — the legend inside the canvas identifies each curve.
    winEquationEl.classList.add("hidden");

    const windowList = [
      { type: "rectangular", color: WIN_COLORS.rectangular },
      { type: "hann",        color: WIN_COLORS.hann        },
      { type: "hamming",     color: WIN_COLORS.hamming     },
      { type: "blackman",    color: WIN_COLORS.blackman    },
    ];
    renderWindowsOnCanvas(winVizCanvas, windowList, N);

    // ── Frequency response: overlay all four on the same axes ────────────
    // Side-by-side mode shows all windows on one plot — consistent with the
    // time-domain overlay above.  The legend identifies each curve by name
    // and color so the leakage of each window is directly comparable.
    const freqDataList = windowList.map(({ type, color }) => ({
      data:  computeWindowFFT(generateWindow(type, N)),
      color,
      label: { rectangular: "Rectangular", hann: "Hann", hamming: "Hamming", blackman: "Blackman" }[type],
    }));
    renderFrequencyResponse(winFreqCanvas, freqDataList);

  } else {
    // ── Single mode: one curve + (optionally) KaTeX equation ─────────────
    const isCustomWinType = winType === "custom" || winType.startsWith("csaved:");

    if (isCustomWinType) {
      // Custom windows have no closed-form LaTeX equation to display.
      winEquationEl.classList.add("hidden");
    } else {
      winEquationEl.classList.remove("hidden");
      renderEquation(winType, winEquationEl);
    }

    // generateWindow() transparently handles custom types via cwGetWindowArray().
    // WIN_COLORS falls back to soft-purple for any unrecognised key.
    renderWindowsOnCanvas(
      winVizCanvas,
      [{ type: winType, color: WIN_COLORS[winType] || "#9060e0" }],
      N,
    );

    // ── Frequency response: single window ────────────────────────────────
    // For custom windows the label is derived from the type string.
    const freqLabel = isCustomWinType
      ? (winType === "custom" ? "Custom" : winType.slice("csaved:".length))
      : winType;
    const freqData = computeWindowFFT(generateWindow(winType, N));
    renderFrequencyResponse(winFreqCanvas, [{
      data:  freqData,
      color: WIN_COLORS[winType] || "#9060e0",
      label: freqLabel,
    }]);
  }
}

// ── Synchronization listeners ─────────────────────────────────────────────────
// These do NOT re-run the STFT pipeline — only the sidebar visualization is
// updated.  The user can explore different window shapes and frame sizes
// before pressing Run to see what the spectrogram would look like.
frameSizeInput.addEventListener("input",  renderWindowPanel);
frameSizeInput.addEventListener("change", renderWindowPanel);
windowSelect.addEventListener("change",   renderWindowPanel);
comparisonModeSelect.addEventListener("change", renderWindowPanel);

// ── Time-scale slider — real-time spectrogram rescale ────────────────────────
// Updates CONFIG.pxPerSec and the readout label on every slider movement.
// Re-renders the spectrogram immediately if data is available so the user
// can see the effect without pressing Run again.
timeScaleInput.addEventListener("input", () => {
  const pps = Math.max(10, parseInt(timeScaleInput.value, 10) || 150);
  CONFIG.pxPerSec = pps;
  timeScaleValue.textContent = pps;

  const mode = comparisonModeSelect.value;
  if (mode === "sidebyside" && fullDbMatrices) {
    renderSideBySide();
  } else if (fullDbMatrix) {
    renderCurrentView();
  }
});

// ── Initial render ────────────────────────────────────────────────────────────
// Two-pass strategy:
//   Pass 1 (immediate): draws the canvas plot.  KaTeX may not be available
//     yet if the CDN script hasn't finished loading — the equation falls
//     back to plain text.
//   Pass 2 (300 ms): if KaTeX has loaded in the interval, re-renders the
//     equation with properly typeset math.
function initialWindowRender() {
  renderWindowPanel();
  setTimeout(() => {
    if (typeof katex !== "undefined") renderWindowPanel();
  }, 300);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialWindowRender);
} else {
  initialWindowRender();
}

// =============================================================================
// CUSTOM WINDOW EDITOR
// =============================================================================
//
// Design rationale — why the time domain is the ONLY editable axis:
//   A window function is defined as a finite sequence of real coefficients
//   w[n], n = 0 … N−1.  Its frequency response is the Discrete-Time Fourier
//   Transform (DTFT):
//
//       W(e^{jω}) = Σ_{n=0}^{N-1}  w[n] · e^{-jωn}
//
//   The magnitude |W(e^{jω})| plotted in dB is COMPLETELY DETERMINED by w[n].
//   It is not an independent parameter that can be set separately — changing
//   any w[n] uniquely changes the frequency response, and vice versa.  This
//   means the frequency-response canvas is strictly a derived, read-only view.
//   Letting users draw on it would be physically meaningless.
//
// How the FFT derives the frequency response (computeWindowFFT):
//   The editor zero-pads w[n] to 8× its length for a smoother curve, runs an
//   FFT, computes 20·log10(|W(k)|) for each positive-frequency bin, and
//   normalises so the peak bin = 0 dB.  This is exactly the convention used by
//   scipy.signal.freqz and MATLAB's fvtool.
//
// Why symmetry matters:
//   When w[n] = w[N−1−n] the DFT W(e^{jω}) is real-valued (zero-phase).
//   Asymmetric windows introduce a frequency-dependent phase taper in each
//   STFT frame, which can cause artefacts in resynthesis (overlap-add) and
//   makes the magnitude spectrogram harder to interpret.  All standard windows
//   (Hann, Hamming, Blackman) satisfy this constraint.

// ── Register custom-window color in the global WIN_COLORS map ────────────────
// Soft purple distinguishes custom windows from the four built-in types.
WIN_COLORS["custom"] = "#9060e0";

// ── Editor state ─────────────────────────────────────────────────────────────
//
// cwNodes : [{x: 0…1, y: 0…1}] sorted by x.
//   In symmetric mode only x ∈ [0, 0.5] nodes are stored.
//   In non-symmetric mode nodes span [0, 1].
//
// cwSymmetric : boolean — true = w[n] = w[N−1−n] enforced at sample time.
//
// cwDragNode : reference to the node currently being dragged (null if idle).

let cwNodes = [
  { x: 0.0, y: 0.08 },
  { x: 0.5, y: 1.0  },
];
let cwSymmetric = true;
let cwDragNode  = null;    // node being dragged
let cwDragOffY  = 0;       // y offset within the node at drag start (unused for now)

// ── Anchor x-positions — these nodes cannot be deleted or moved horizontally ─
const CW_ANCHOR_SYM  = [0.0, 0.5];
const CW_ANCHOR_ASYM = [0.0, 1.0];
function cwIsAnchor(node) {
  const anchors = cwSymmetric ? CW_ANCHOR_SYM : CW_ANCHOR_ASYM;
  return anchors.some(ax => Math.abs(node.x - ax) < 0.006);
}

// ── Default node set (Hamming-like shape) ────────────────────────────────────
const CW_DEFAULTS_SYM  = [{ x: 0.0, y: 0.08 }, { x: 0.5, y: 1.0 }];
const CW_DEFAULTS_ASYM = [{ x: 0.0, y: 0.08 }, { x: 0.5, y: 1.0 }, { x: 1.0, y: 0.08 }];

// ── DOM references ───────────────────────────────────────────────────────────
const cwModal           = document.getElementById("customWinModal");
const cwCloseBtn        = document.getElementById("cwCloseBtn");
const cwTDCanvas        = document.getElementById("cwTimeDomainCanvas");
const cwFreqCanvas_     = document.getElementById("cwFreqCanvas");  // underscore avoids name clash
const cwSymmetryCheck   = document.getElementById("cwSymmetry");
const cwResetBtn_       = document.getElementById("cwResetBtn");
const cwNameInput       = document.getElementById("cwNameInput");
const cwSaveBtn_        = document.getElementById("cwSaveBtn");
const cwSavedListEl     = document.getElementById("cwSavedList");
const cwWarningsEl      = document.getElementById("cwWarnings");
const cwApplyBtn        = document.getElementById("cwApplyBtn");

// =============================================================================
// cwInterpolate(x, nodes) — linear interpolation along sorted node array
// =============================================================================
/**
 * Returns the interpolated y value at normalized position x ∈ [0, 1].
 * The nodes array must be sorted ascending by x.
 *
 * Edge cases:
 *   - x before first node → clamp to first node's y
 *   - x after last node   → clamp to last node's y
 *   - Two nodes at same x → return average (prevents division by zero)
 *
 * @param {number}  x     - Normalized position [0, 1]
 * @param {{x:number,y:number}[]} nodes
 * @returns {number} interpolated amplitude [0, 1]
 */
function cwInterpolate(x, nodes) {
  if (!nodes || nodes.length === 0) return 0;
  if (nodes.length === 1) return nodes[0].y;
  if (x <= nodes[0].x) return nodes[0].y;
  if (x >= nodes[nodes.length - 1].x) return nodes[nodes.length - 1].y;

  for (let i = 0; i < nodes.length - 1; i++) {
    if (x >= nodes[i].x && x <= nodes[i + 1].x) {
      const dx = nodes[i + 1].x - nodes[i].x;
      if (dx < 1e-9) return (nodes[i].y + nodes[i + 1].y) / 2;  // guard div/0
      const t = (x - nodes[i].x) / dx;
      return nodes[i].y + t * (nodes[i + 1].y - nodes[i].y);
    }
  }
  return nodes[nodes.length - 1].y;
}

// =============================================================================
// cwSampleCurve(nodes, symmetric, N) → Float32Array
// =============================================================================
/**
 * Converts the node-defined curve into a discrete window array of length N.
 *
 * Sampling formula:
 *   x[n] = n / (N − 1)           (normalized position of sample n)
 *
 * Symmetric mode (w[n] = w[N−1−n]):
 *   The nodes only cover x ∈ [0, 0.5].  For samples in the right half, the
 *   position is folded back: xForInterp = 1 − x, which maps x > 0.5 onto
 *   the left-half domain.  At x = 0.5 (the centre of an even-length window)
 *   the value is the same from both sides — no discontinuity.
 *
 * Clamping:
 *   All output values are clamped to [0, 1] regardless of node positions.
 *
 * @param {{x:number,y:number}[]} nodes
 * @param {boolean}               symmetric
 * @param {number}                N  - Frame size (must be ≥ 1)
 * @returns {Float32Array}
 */
function cwSampleCurve(nodes, symmetric, N) {
  const w = new Float32Array(Math.max(1, N));
  const denom = Math.max(1, N - 1);  // avoid div/0 for N=1
  for (let i = 0; i < N; i++) {
    let x = i / denom;
    // Fold the right half back onto the left-half domain for symmetric windows.
    const xi = (symmetric && x > 0.5) ? (1 - x) : x;
    w[i] = Math.max(0, Math.min(1, cwInterpolate(xi, nodes)));
  }
  return w;
}

// =============================================================================
// cwGetWindowArray(type, N) — resolve any custom window type to a Float32Array
// =============================================================================
/**
 * Returns the Float32Array of window coefficients for the given custom type.
 *
 * Called by both buildWindow() and generateWindow() so the same coefficients
 * are used for STFT computation AND sidebar visualization.
 *
 * Type strings:
 *   "custom"      → use current editor state (cwNodes, cwSymmetric)
 *   "csaved:Name" → look up stored nodes/symmetric from localStorage
 *
 * Falls back to a rectangular window (all ones) if the stored data is missing
 * or corrupt — this is safe and makes the failure visible in the spectrogram.
 *
 * @param {string} type - "custom" | "csaved:<name>"
 * @param {number} N    - Frame size
 * @returns {Float32Array}
 */
function cwGetWindowArray(type, N) {
  if (type === "custom") {
    return cwSampleCurve(cwNodes, cwSymmetric, N);
  }
  if (type.startsWith("csaved:")) {
    const name  = type.slice(7);   // strip "csaved:" prefix
    const saved = cwLoadAllSaved()[name];
    if (saved && Array.isArray(saved.nodes) && saved.nodes.length >= 2) {
      return cwSampleCurve(saved.nodes, !!saved.symmetric, N);
    }
  }
  // Fallback: rectangular (all 1s) — makes the issue visible without crashing
  const fallback = new Float32Array(Math.max(1, N));
  fallback.fill(1.0);
  return fallback;
}

// =============================================================================
// renderCwTimeDomain() — draw the interactive time-domain editor canvas
// =============================================================================
/**
 * Renders the current node set and interpolated curve onto cwTDCanvas.
 *
 * Visual layout:
 *   Background: dark (#0f1115)
 *   Grid:       horizontal at y=0, 0.5, 1; vertical at x=0, 0.5, 1
 *   Symmetric indicator: right half is shaded and labelled "Mirror"
 *   Curve:      solid colored line through all interpolated sample points
 *               (mirrored right half is drawn dimmer in symmetric mode)
 *   Nodes:      filled circles; anchor nodes (x=0, x=0.5 or x=1) use a
 *               different color to communicate they can't be deleted
 *   Axes:       tick labels for x and y, axis titles
 */
function renderCwTimeDomain() {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = cwTDCanvas.offsetWidth  || 400;
  const cssH = cwTDCanvas.offsetHeight || 220;
  cwTDCanvas.width  = Math.round(cssW * dpr);
  cwTDCanvas.height = Math.round(cssH * dpr);

  const ctx = cwTDCanvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // ── Layout ────────────────────────────────────────────────────────────────
  const PAD_L = 30, PAD_R = 10, PAD_T = 10, PAD_B = 26;
  const plotW = cssW - PAD_L - PAD_R;
  const plotH = cssH - PAD_T - PAD_B;

  // Helpers: normalized position → canvas pixel
  const xPx = (nx) => PAD_L + nx * plotW;
  const yPx = (ny) => PAD_T + (1 - ny) * plotH;

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = "#0f1115";
  ctx.fillRect(0, 0, cssW, cssH);

  // ── Symmetric mode: shade right half to indicate "not editable" ───────────
  if (cwSymmetric) {
    ctx.fillStyle = "rgba(30, 35, 45, 0.40)";
    ctx.fillRect(xPx(0.5), PAD_T, plotW * 0.5, plotH);
  }

  // ── Grid lines ────────────────────────────────────────────────────────────
  ctx.strokeStyle = "#1e2128";
  ctx.lineWidth   = 1;

  for (const amp of [0, 0.5, 1]) {
    const y = yPx(amp);
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
  }
  for (const nx of [0, 0.5, 1]) {
    const x = xPx(nx);
    ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + plotH); ctx.stroke();
  }

  // ── Axis lines ────────────────────────────────────────────────────────────
  ctx.strokeStyle = "#4a5060";
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(PAD_L, PAD_T); ctx.lineTo(PAD_L, PAD_T + plotH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(PAD_L, PAD_T + plotH); ctx.lineTo(PAD_L + plotW, PAD_T + plotH); ctx.stroke();

  // ── Tick marks and labels ─────────────────────────────────────────────────
  ctx.font = "10px Consolas, Menlo, monospace";

  // Y-axis
  ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillStyle = "#6a6f7a";
  ctx.strokeStyle = "#4a5060"; ctx.lineWidth = 1;
  for (const amp of [0, 0.5, 1]) {
    const y = yPx(amp);
    ctx.beginPath(); ctx.moveTo(PAD_L - 4, y); ctx.lineTo(PAD_L, y); ctx.stroke();
    ctx.fillText(amp === 1 ? "1" : amp === 0 ? "0" : ".5", PAD_L - 6, y);
  }

  // X-axis ticks
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const nx of [0, 0.5, 1]) {
    const x = xPx(nx);
    ctx.beginPath(); ctx.moveTo(x, PAD_T + plotH); ctx.lineTo(x, PAD_T + plotH + 4); ctx.stroke();
    ctx.fillText(nx === 0 ? "0" : nx === 1 ? "1" : ".5", x, PAD_T + plotH + 6);
  }

  // Axis title
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = "#4a5060";
  ctx.fillText("n/N", PAD_L + plotW + 2, PAD_T + plotH + 6);

  // Symmetric mode label on the right half
  if (cwSymmetric) {
    ctx.font = "9px Consolas, Menlo, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#3a4050";
    ctx.fillText("Mirror", xPx(0.75), PAD_T + 4);
    ctx.font = "10px Consolas, Menlo, monospace";
  }

  // ── Interpolated curve ────────────────────────────────────────────────────
  // Sample at 200 points for a smooth curve regardless of node count.
  const NUM_SAMPLES = 200;

  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD_L, PAD_T, plotW, plotH);
  ctx.clip();

  // Left half (editable region) — full-brightness curve
  ctx.beginPath();
  ctx.strokeStyle = WIN_COLORS["custom"];
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = "round";
  const xLimit = cwSymmetric ? 0.5 : 1.0;
  for (let i = 0; i <= NUM_SAMPLES; i++) {
    const nx = (i / NUM_SAMPLES) * xLimit;
    const ny = cwInterpolate(nx, cwNodes);
    const px = xPx(nx);
    const py = yPx(Math.max(0, Math.min(1, ny)));
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Right half (mirrored region) — dimmer curve
  if (cwSymmetric) {
    ctx.beginPath();
    ctx.strokeStyle = "rgba(144, 96, 224, 0.35)";
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = "round";
    for (let i = 0; i <= NUM_SAMPLES; i++) {
      const nx  = 0.5 + (i / NUM_SAMPLES) * 0.5;   // x ∈ [0.5, 1]
      const nxM = 1 - nx;                            // mirror position
      const ny  = cwInterpolate(nxM, cwNodes);
      const px  = xPx(nx);
      const py  = yPx(Math.max(0, Math.min(1, ny)));
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  ctx.restore();  // end clip

  // ── Nodes (only in editable region) ───────────────────────────────────────
  const NODE_R       = 5.5;                     // normal node radius (CSS px)
  const ANCHOR_COLOR = "#5a8fff";              // blue for anchor nodes (unmovable in x)
  const NORMAL_COLOR = WIN_COLORS["custom"];   // purple for regular nodes

  for (const node of cwNodes) {
    // In symmetric mode, nodes are only in [0, 0.5] — always visible
    const px = xPx(node.x);
    const py = yPx(node.y);
    const isAnchor = cwIsAnchor(node);

    ctx.beginPath();
    ctx.arc(px, py, NODE_R, 0, Math.PI * 2);
    ctx.fillStyle   = isAnchor ? ANCHOR_COLOR : NORMAL_COLOR;
    ctx.fill();
    ctx.strokeStyle = "#0f1115";
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }
}

// =============================================================================
// renderCwFreqResponse() — compute FFT and render read-only frequency plot
// =============================================================================
/**
 * Samples the current curve at CONFIG.frameSize points, computes the FFT,
 * and renders the magnitude spectrum using the existing renderFrequencyResponse().
 *
 * IMPORTANT: This function does NOT attach any event handlers to cwFreqCanvas_.
 * The canvas must remain completely inert — zero interactivity — so that
 * the conceptual separation between "editable time domain" and "derived
 * frequency domain" is reinforced both visually and technically.
 *
 * The FFT uses 8× zero-padding (handled internally by computeWindowFFT) to
 * produce a smooth, high-resolution sidelobe display even for small N.
 */
function renderCwFreqResponse() {
  const N = Math.max(4, parseInt(frameSizeInput.value, 10) || 256);
  const windowArray = cwSampleCurve(cwNodes, cwSymmetric, N);
  const freqData    = computeWindowFFT(windowArray);

  // renderFrequencyResponse() renders to the canvas without touching event
  // listeners — it is purely a drawing function, so calling it here is safe.
  renderFrequencyResponse(cwFreqCanvas_, [{
    data:  freqData,
    color: WIN_COLORS["custom"],
    label: "Custom",
  }]);
}

// =============================================================================
// cwValidate() — generate DSP warnings for the current node state
// =============================================================================
/**
 * Checks the current window design for common DSP pitfalls and populates
 * the #cwWarnings element with human-readable advisory messages.
 *
 * Checks performed:
 *
 *   1. End discontinuity — if either end of the window is significantly above
 *      zero, the window does not taper smoothly and will exhibit high sidelobes
 *      (similar to the rectangular window's −13 dB sinc envelope).  The
 *      threshold 0.05 is a practical limit — Hamming's ends are ~0.08, which
 *      already produces noticeable leakage compared to Hann/Blackman.
 *
 *   2. Non-symmetric design — when symmetry is disabled the user can draw
 *      an asymmetric window.  This is warned but not prevented, since
 *      asymmetric windows have legitimate uses (e.g. causal filter design).
 *
 *   3. Sharp transition — if two adjacent nodes form a near-vertical segment
 *      (|Δy| > 0.5) the resulting window approximates a step discontinuity,
 *      substantially degrading spectral leakage performance.
 */
function cwValidate() {
  const N = Math.max(4, parseInt(frameSizeInput.value, 10) || 256);
  const w = cwSampleCurve(cwNodes, cwSymmetric, N);

  const warnings = [];

  // 1. High end values → poor leakage
  const endThresh = 0.05;
  if (w[0] > endThresh || w[N - 1] > endThresh) {
    warnings.push(
      `⚠ End values are high (start=${w[0].toFixed(2)}, end=${w[N-1].toFixed(2)}).` +
      " Windows that don't taper to ≈0 have elevated sidelobes (high spectral leakage)."
    );
  }

  // 2. Non-symmetric
  if (!cwSymmetric) {
    warnings.push(
      "⚠ Symmetry is OFF. Asymmetric windows introduce phase distortion in STFT frames."
    );
  }

  // 3. Sharp transitions between adjacent nodes
  const sorted = [...cwNodes].sort((a, b) => a.x - b.x);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (Math.abs(sorted[i + 1].y - sorted[i].y) > 0.5) {
      warnings.push(
        "⚠ Sharp transition detected between nodes — this approximates a discontinuity" +
        " and will cause high sidelobes."
      );
      break;  // one warning per check is enough
    }
  }

  cwWarningsEl.textContent = warnings.join("\n");
}

// =============================================================================
// openCustomWindowEditor() / closeCustomWindowEditor()
// =============================================================================
function openCustomWindowEditor() {
  cwModal.classList.remove("hidden");
  cwCloseBtn.focus();
  // Render the editor with the current state so the canvas is immediately visible.
  renderCwTimeDomain();
  renderCwFreqResponse();
  cwValidate();
  cwRefreshSavedList();
}

function closeCustomWindowEditor() {
  cwModal.classList.add("hidden");
  windowSelect.focus();
}

// =============================================================================
// cwRefreshSavedList() — rebuild the saved-windows list in the modal
// =============================================================================
/**
 * Re-renders the list of saved custom windows inside #cwSavedList.
 * Each entry has:
 *   - Name (clickable → loads into editor)
 *   - "Use" button → applies as CONFIG.windowType without opening for editing
 *   - Delete button → removes from localStorage and select
 */
function cwRefreshSavedList() {
  cwSavedListEl.innerHTML = "";
  const all = cwLoadAllSaved();
  const names = Object.keys(all);

  if (names.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:10px;color:#3a4050;padding:3px 0";
    empty.textContent = "No saved windows yet";
    cwSavedListEl.appendChild(empty);
    return;
  }

  for (const name of names) {
    const row = document.createElement("div");
    row.className = "cw-saved-item";

    const nameBtn = document.createElement("span");
    nameBtn.className   = "cw-saved-name";
    nameBtn.textContent = name;
    nameBtn.title       = "Load into editor";
    nameBtn.addEventListener("click", () => cwLoadIntoEditor(name));

    const useBtn = document.createElement("button");
    useBtn.className   = "cw-saved-use";
    useBtn.textContent = "Use";
    useBtn.title       = "Apply this window to STFT (sets window select)";
    useBtn.addEventListener("click", () => cwApplySavedWindow(name));

    const delBtn = document.createElement("button");
    delBtn.className   = "cw-saved-del";
    delBtn.textContent = "✕";
    delBtn.title       = "Delete this saved window";
    delBtn.addEventListener("click", () => cwDeleteSavedWindow(name));

    row.appendChild(nameBtn);
    row.appendChild(useBtn);
    row.appendChild(delBtn);
    cwSavedListEl.appendChild(row);
  }
}

// =============================================================================
// localStorage helpers
// =============================================================================
/**
 * Reads the entire customWindows map from localStorage.
 * Returns an empty object on any parse error to avoid crashing.
 *
 * Storage format:
 *   localStorage["customWindows"] = JSON.stringify({
 *     "MyWindow": { name, nodes: [{x,y}…], symmetric: bool }
 *   })
 *
 * Only {name, nodes, symmetric} are stored — never the sampled Float32Array.
 * The array is always re-computed from nodes at runtime so it automatically
 * adapts to whatever frame size is in use.
 */
function cwLoadAllSaved() {
  try {
    const raw = localStorage.getItem("customWindows");
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

/** Persists the entire map to localStorage.  Silently swallows QuotaExceededError. */
function cwSaveAll(data) {
  try {
    localStorage.setItem("customWindows", JSON.stringify(data));
  } catch (_) { /* storage full or unavailable — fail silently */ }
}

/** Saves the current editor state under `name`. Overwrites if already exists. */
function cwSaveCurrentAs(name) {
  if (!name || !name.trim()) return;
  const all  = cwLoadAllSaved();
  all[name]  = { name, nodes: cwNodes.map(n => ({ x: n.x, y: n.y })), symmetric: cwSymmetric };
  cwSaveAll(all);
}

/** Loads a saved window's nodes/symmetric into the editor. */
function cwLoadIntoEditor(name) {
  const all   = cwLoadAllSaved();
  const saved = all[name];
  if (!saved || !Array.isArray(saved.nodes)) return;

  cwNodes     = saved.nodes.map(n => ({ x: n.x, y: n.y }));
  cwSymmetric = !!saved.symmetric;
  cwSymmetryCheck.checked = cwSymmetric;
  cwNameInput.value       = name;

  renderCwTimeDomain();
  renderCwFreqResponse();
  cwValidate();
}

/** Deletes a saved window from localStorage and repopulates the select. */
function cwDeleteSavedWindow(name) {
  const all = cwLoadAllSaved();
  delete all[name];
  cwSaveAll(all);
  cwRefreshSavedList();
  cwPopulateSelect();
  // If currently selected, fall back to built-in hamming
  if (windowSelect.value === `csaved:${name}`) {
    windowSelect.value  = "hamming";
    CONFIG.windowType   = "hamming";
    renderWindowPanel();
  }
}

/** Applies a saved window to the STFT (sets windowSelect + CONFIG) and closes modal. */
function cwApplySavedWindow(name) {
  const type = `csaved:${name}`;
  // Ensure the option exists in the select (should always be true after cwPopulateSelect)
  if (!Array.from(windowSelect.options).some(o => o.value === type)) {
    cwPopulateSelect();
  }
  windowSelect.value = type;
  CONFIG.windowType  = type;
  closeCustomWindowEditor();
  renderWindowPanel();
}

// =============================================================================
// cwPopulateSelect() — sync saved window names into the window type <select>
// =============================================================================
/**
 * Rebuilds the <option> list in #windowType to include all saved custom windows.
 *
 * Built-in options (rectangular, hann, hamming, blackman, custom) are left
 * untouched.  Only the dynamic "csaved:..." options are replaced.
 *
 * Called on: page load, after save, after delete, after load.
 */
function cwPopulateSelect() {
  // Remove previously added "csaved:" options
  Array.from(windowSelect.options)
    .filter(o => o.value.startsWith("csaved:"))
    .forEach(o => o.remove());

  const all = cwLoadAllSaved();
  for (const name of Object.keys(all)) {
    const opt   = document.createElement("option");
    opt.value   = `csaved:${name}`;
    opt.textContent = `⊙ ${name}`;
    windowSelect.appendChild(opt);
  }
}

// =============================================================================
// Canvas coordinate helpers (used by mouse / touch handlers)
// =============================================================================
/** Returns the plot-area geometry for cwTDCanvas. */
function cwPlotGeom() {
  const cssW = cwTDCanvas.offsetWidth  || 400;
  const cssH = cwTDCanvas.offsetHeight || 220;
  const PAD_L = 30, PAD_R = 10, PAD_T = 10, PAD_B = 26;
  return {
    PAD_L, PAD_R, PAD_T, PAD_B,
    plotW: cssW - PAD_L - PAD_R,
    plotH: cssH - PAD_T - PAD_B,
  };
}

/**
 * Converts a mouse/touch event to normalized (nx, ny) ∈ [0,1]×[0,1].
 * Returns null if the pointer is outside the canvas.
 */
function cwEventToNorm(e) {
  const rect  = cwTDCanvas.getBoundingClientRect();
  const { PAD_L, PAD_T, plotW, plotH } = cwPlotGeom();
  const src   = (e.touches && e.touches.length > 0)
              ? e.touches[0]
              : (e.changedTouches && e.changedTouches.length > 0)
              ? e.changedTouches[0]
              : e;
  const cx = src.clientX - rect.left;
  const cy = src.clientY - rect.top;
  const nx = (cx - PAD_L) / plotW;
  const ny = 1 - (cy - PAD_T) / plotH;
  return { nx, ny };
}

/** Returns the node closest to (nx, ny) within HIT_RADIUS CSS-px, or null. */
function cwHitTest(nx, ny) {
  const { plotW, plotH } = cwPlotGeom();
  const HIT_PX = 10;  // hit radius in CSS pixels
  let best = null, bestDist = Infinity;
  for (const node of cwNodes) {
    const dx = (node.x - nx) * plotW;
    const dy = (node.y - ny) * plotH;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < HIT_PX && dist < bestDist) {
      bestDist = dist;
      best     = node;
    }
  }
  return best;
}

// =============================================================================
// Canvas interaction — add / drag / delete nodes
// =============================================================================
//
// Per user-memory note on drag interactions:
//   - mousemove and mouseup are attached to `document`, not the canvas, so
//     dragging to the canvas edge (or off-screen) still works.
//   - Listeners are removed in the mouseup handler to avoid leaks.

function cwOnMouseDown(e) {
  e.preventDefault();
  const { nx, ny } = cwEventToNorm(e);

  // Right-click → delete node
  if (e.button === 2) {
    const hit = cwHitTest(nx, ny);
    if (hit && !cwIsAnchor(hit)) {
      cwNodes = cwNodes.filter(n => n !== hit);
      cwAfterEdit();
    }
    return;
  }

  // Left-click: hit test first (drag), otherwise add
  const hit = cwHitTest(nx, ny);
  if (hit) {
    // Start drag
    cwDragNode = hit;
    document.addEventListener("mousemove", cwOnDragMove);
    document.addEventListener("mouseup",   cwOnDragEnd);
  } else {
    // Add a new node if in the editable region
    const maxX = cwSymmetric ? 0.5 : 1.0;
    if (nx >= 0 && nx <= maxX && ny >= 0 && ny <= 1) {
      const newNode = {
        x: Math.max(0, Math.min(maxX, nx)),
        y: Math.max(0, Math.min(1,   ny)),
      };
      cwNodes.push(newNode);
      cwNodes.sort((a, b) => a.x - b.x);
      cwAfterEdit();
    }
  }
}

function cwOnDragMove(e) {
  if (!cwDragNode) return;
  e.preventDefault();

  const { nx, ny } = cwEventToNorm(e);
  const maxX = cwSymmetric ? 0.5 : 1.0;

  // Anchor nodes: only y can change
  if (!cwIsAnchor(cwDragNode)) {
    // Find neighbor x-values to prevent nodes crossing each other
    const idx   = cwNodes.indexOf(cwDragNode);
    const prevX = idx > 0                   ? cwNodes[idx - 1].x + 0.003 : 0;
    const nextX = idx < cwNodes.length - 1  ? cwNodes[idx + 1].x - 0.003 : maxX;
    cwDragNode.x = Math.max(prevX, Math.min(nextX, nx));
  }
  cwDragNode.y = Math.max(0, Math.min(1, ny));

  cwAfterEdit();
}

function cwOnDragEnd() {
  cwDragNode = null;
  document.removeEventListener("mousemove", cwOnDragMove);
  document.removeEventListener("mouseup",   cwOnDragEnd);
}

// Touch support — map to the same mouse handlers
function cwOnTouchStart(e) {
  e.preventDefault();
  const { nx, ny } = cwEventToNorm(e);
  const hit = cwHitTest(nx, ny);
  if (hit) {
    cwDragNode = hit;
    document.addEventListener("touchmove",  cwOnTouchMove,  { passive: false });
    document.addEventListener("touchend",   cwOnTouchEnd);
  } else {
    const maxX = cwSymmetric ? 0.5 : 1.0;
    if (nx >= 0 && nx <= maxX && ny >= 0 && ny <= 1) {
      const newNode = {
        x: Math.max(0, Math.min(maxX, nx)),
        y: Math.max(0, Math.min(1,   ny)),
      };
      cwNodes.push(newNode);
      cwNodes.sort((a, b) => a.x - b.x);
      cwAfterEdit();
    }
  }
}

function cwOnTouchMove(e) {
  if (!cwDragNode) return;
  e.preventDefault();
  cwOnDragMove(e);  // reuse same logic — cwEventToNorm handles touches
}

function cwOnTouchEnd() {
  cwDragNode = null;
  document.removeEventListener("touchmove", cwOnTouchMove);
  document.removeEventListener("touchend",  cwOnTouchEnd);
}

// Context menu → delete node (right-click)
function cwOnContextMenu(e) {
  e.preventDefault();
  const { nx, ny } = cwEventToNorm(e);
  const hit = cwHitTest(nx, ny);
  if (hit && !cwIsAnchor(hit)) {
    cwNodes = cwNodes.filter(n => n !== hit);
    cwAfterEdit();
  }
}

/**
 * Called after every node edit (add/drag/delete).
 * Re-renders both canvases and re-runs validation.
 */
function cwAfterEdit() {
  renderCwTimeDomain();
  renderCwFreqResponse();
  cwValidate();
}

// Attach event listeners to the TIME-DOMAIN canvas only.
// The frequency canvas (cwFreqCanvas_) gets NO event listeners — it is
// intentionally inert so users cannot interact with the "derived" view.
cwTDCanvas.addEventListener("mousedown",   cwOnMouseDown);
cwTDCanvas.addEventListener("contextmenu", cwOnContextMenu);
cwTDCanvas.addEventListener("touchstart",  cwOnTouchStart, { passive: false });

// =============================================================================
// cwSymmetry / cwReset control handlers
// =============================================================================
cwSymmetryCheck.addEventListener("change", () => {
  const wasSymmetric = cwSymmetric;
  cwSymmetric        = cwSymmetryCheck.checked;

  if (cwSymmetric && !wasSymmetric) {
    // Non-symmetric → symmetric: keep only left-half nodes (x ≤ 0.5).
    // Any right-half nodes are discarded because the right side is now derived
    // by mirroring, not stored independently.
    cwNodes = cwNodes.filter(n => n.x <= 0.5 + 0.005);
    // Ensure anchors at x=0 and x=0.5 always exist
    cwEnsureAnchors();
  } else if (!cwSymmetric && wasSymmetric) {
    // Symmetric → non-symmetric: expand the node list by mirroring left nodes.
    // This gives the user a starting point that is still symmetric before
    // they start adding asymmetric nodes.
    const leftNodes  = cwNodes.filter(n => Math.abs(n.x - 0.5) > 0.005);
    const rightNodes = leftNodes
      .filter(n => n.x > 0.005)           // skip x=0 anchor (already at x=1 mirror)
      .map(n => ({ x: 1 - n.x, y: n.y }))
      .reverse();
    // Remove the x=0.5 anchor (it becomes an interior node in asymmetric mode)
    // and replace x=1 anchor
    cwNodes = cwNodes.filter(n => Math.abs(n.x - 0.5) > 0.005);
    cwNodes = [...cwNodes, ...rightNodes];
    cwEnsureAnchors();
    cwNodes.sort((a, b) => a.x - b.x);
  }

  cwAfterEdit();
});

/** Ensures the mandatory anchor nodes at x=0 and x=0.5 (sym) or x=1 (asym) exist. */
function cwEnsureAnchors() {
  const anchors = cwSymmetric ? CW_ANCHOR_SYM : CW_ANCHOR_ASYM;
  const DEFAULT_Y = [0.08, 1.0, 0.08];  // default y for [0, 0.5, 1] respectively
  for (let i = 0; i < anchors.length; i++) {
    const ax = anchors[i];
    if (!cwNodes.some(n => Math.abs(n.x - ax) < 0.005)) {
      cwNodes.push({ x: ax, y: DEFAULT_Y[i] ?? 0.08 });
    }
  }
  cwNodes.sort((a, b) => a.x - b.x);
}

cwResetBtn_.addEventListener("click", () => {
  cwNodes     = cwSymmetric
    ? CW_DEFAULTS_SYM.map(n  => ({ ...n }))
    : CW_DEFAULTS_ASYM.map(n => ({ ...n }));
  cwAfterEdit();
});

// =============================================================================
// Save / Apply / Close controls
// =============================================================================
cwSaveBtn_.addEventListener("click", () => {
  const name = cwNameInput.value.trim();
  if (!name) {
    cwWarningsEl.textContent = "⚠ Enter a name before saving.";
    cwNameInput.focus();
    return;
  }
  cwSaveCurrentAs(name);
  cwPopulateSelect();
  cwRefreshSavedList();
  // Switch the select to the newly saved window
  cwApplySavedWindow(name);
});

cwApplyBtn.addEventListener("click", () => {
  // Apply the current (possibly unsaved) editor state
  windowSelect.value = "custom";
  CONFIG.windowType  = "custom";
  closeCustomWindowEditor();
  renderWindowPanel();
});

cwCloseBtn.addEventListener("click", closeCustomWindowEditor);

// Close on backdrop click
cwModal.addEventListener("click", (e) => {
  if (e.target === cwModal) closeCustomWindowEditor();
});

// Close on Escape (only when the custom window modal is open)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !cwModal.classList.contains("hidden")) {
    closeCustomWindowEditor();
  }
});

// =============================================================================
// Window select: open editor automatically when "Custom (Edit…)" is chosen
// =============================================================================
windowSelect.addEventListener("change", () => {
  if (windowSelect.value === "custom") {
    openCustomWindowEditor();
  }
});

// =============================================================================
// frameSizeInput change: refresh frequency response if editor is open,
// and re-run validation (end thresholds are computed at the current N).
// =============================================================================
frameSizeInput.addEventListener("input",  () => {
  if (!cwModal.classList.contains("hidden")) {
    renderCwFreqResponse();
    cwValidate();
  }
});

// =============================================================================
// Initialization — populate saved windows and ensure anchor nodes exist
// =============================================================================
cwEnsureAnchors();
cwPopulateSelect();

