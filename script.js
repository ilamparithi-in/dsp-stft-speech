/**
 * script.js — Browser-based STFT Spectrogram Viewer
 *
 * Pipeline:
 *   1. User selects audio file
 *   2. loadAudio()       — decode with Web Audio API, convert mono, trim to 10 s
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
  maxDurationSec: 10,       // hard cap: only first N seconds are loaded
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
 * Float32Array trimmed to CONFIG.maxDurationSec seconds.
 *
 * Steps:
 *   a. Read the File as an ArrayBuffer via FileReader
 *   b. Decode PCM with AudioContext.decodeAudioData()
 *   c. Average all channels into one mono channel
 *   d. Trim to at most maxDurationSec * sampleRate samples
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
 * recording auto-stops after CONFIG.maxDurationSec seconds so the captured
 * audio always fits within the existing processing limit.
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

  // Auto-stop at the processing limit so the pipeline is never overloaded
  setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopRecording();
    }
  }, CONFIG.maxDurationSec * 1000);
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
 *   AudioBuffer → mix to mono Float32Array → trim to maxDurationSec
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

    // ── e. Trim to the processing limit ──────────────────────────────────
    const maxSamples = CONFIG.maxDurationSec * sampleRate;
    monoSamples = mono.length > maxSamples ? mono.slice(0, maxSamples) : mono;

    // Stash a copy of the raw PCM for WAV export — before the pipeline
    // potentially overwrites monoSamples (e.g. on a subsequent file load).
    recPCM           = monoSamples.slice();
    recPCMSampleRate = sampleRate;

    // ── f. Set CONFIG for a fresh recording: always start at 0, full length
    //       Preserve the user's STFT parameters (frameSize, hopSize, etc.).
    readConfigFromUI();
    CONFIG.startTime       = 0;
    CONFIG.segmentDuration = monoSamples.length / sampleRate;

    // Sync the sidebar inputs so they reflect what will actually be processed
    startTimeInput.value    = "0";
    segDurationInput.value  = CONFIG.segmentDuration.toFixed(3);

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

  } else {
    // ── Single mode: one curve + KaTeX equation ───────────────────────────
    winEquationEl.classList.remove("hidden");
    renderWindowsOnCanvas(
      winVizCanvas,
      [{ type: winType, color: WIN_COLORS[winType] || "#5a8fff" }],
      N,
    );
    renderEquation(winType, winEquationEl);
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
