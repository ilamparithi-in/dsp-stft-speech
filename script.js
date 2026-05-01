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
  frameSize: 256,           // FFT window length (must be power of 2)
  hopSize: 128,             // samples between successive frames
  windowType: "hamming",    // default window function
  startTime: 0,             // seconds into the audio to begin analysis
  segmentDuration: 10,      // seconds of audio to analyse
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
const frameSizeInput  = document.getElementById("frameSize");
const hopSizeInput    = document.getElementById("hopSize");
const windowSelect    = document.getElementById("windowType");
const startTimeInput  = document.getElementById("startTime");
const segDurationInput = document.getElementById("segDuration");
// Read-only metadata display (populated after Run decodes the file)
const infoDuration    = document.getElementById("infoDuration");
const infoSampleRate  = document.getElementById("infoSampleRate");
const statusBar       = document.getElementById("statusBar");
const statusText      = document.getElementById("statusText");
const canvas          = document.getElementById("spectrogramCanvas");
const cursorCanvas    = document.getElementById("cursorCanvas");   // cursor overlay
const canvasWrapper   = document.getElementById("canvasWrapper");
const axisLabels      = document.getElementById("axisLabels");
const placeholder     = document.getElementById("placeholder");
const ctx2d           = canvas.getContext("2d");
const cursorCtx       = cursorCanvas.getContext("2d");

// ─────────────────────────────────────────────────────────────────────────────
// Audio decode state
// ─────────────────────────────────────────────────────────────────────────────
let monoSamples = null;
let sampleRate  = 0;

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
  axisLabels.classList.add("hidden");
  placeholder.classList.remove("hidden");
});

processBtn.addEventListener("click", async () => {
  const file = audioInput.files[0];
  if (!file) return;

  // Read current UI parameters into CONFIG.
  // Values are NOT clamped here — invalid inputs (NaN, non-power-of-2, etc.)
  // are caught and reported by the computation layer (prepareSegment /
  // computeSTFT), keeping all validation logic in one place.
  CONFIG.frameSize       = parseInt(frameSizeInput.value,   10);
  CONFIG.hopSize         = parseInt(hopSizeInput.value,     10);
  CONFIG.windowType      = windowSelect.value;
  CONFIG.startTime       = parseFloat(startTimeInput.value);
  CONFIG.segmentDuration = parseFloat(segDurationInput.value);

  processBtn.disabled = true;
  showStatus("Decoding audio…", false);

  try {
    // ── Step 1: decode ──────────────────────────────────────────────────────
    monoSamples = await loadAudio(file);

    // Display audio metadata now that duration and sample rate are known.
    // The user needs these values to set sensible startTime / segmentDuration.
    infoDuration.textContent   = (monoSamples.length / sampleRate).toFixed(3);
    infoSampleRate.textContent = sampleRate;

    showStatus("Computing STFT…", false);

    // ── Step 2: slice segment ─────────────────────────────────────────────
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
    const powerMatrix = computeSTFT(segment, CONFIG);

    // ── Step 4: convert power → dB, normalize, clip ───────────────────────
    const dbMatrix = computeSpectrogram(powerMatrix);

    showStatus("Rendering spectrogram…", false);
    await yieldToUI();

    // ── Step 5: render ────────────────────────────────────────────────────
    renderSpectrogram(dbMatrix, canvas, ctx2d);

    // Hide the placeholder text and show axis labels once data is painted
    placeholder.classList.add("hidden");
    axisLabels.classList.remove("hidden");
    // Enable playback now that we have a rendered spectrogram and playbackBuffer
    playBtn.disabled = false;
    hideStatus();
  } catch (err) {
    showStatus(`Error: ${err.message}`, true);
    console.error(err);
  } finally {
    processBtn.disabled = false;
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
  sampleRate = decoded.sampleRate;

  // ── c. Mix to mono ────────────────────────────────────────────────────────
  const numChannels = decoded.numberOfChannels;
  const length      = decoded.length;
  const mono        = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = decoded.getChannelData(ch);
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
// Playback — startPlayback / stopPlayback / updateCursor / drawCursor
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
    // Draw cursor at the very end position so it doesn't snap back to 0
    drawCursor(audioDuration);
    // Stop the rAF loop — no more updates needed
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  sourceNode.start(0);
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

  if (clearCursor) clearCursorCanvas();
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

  const elapsed = Math.min(audioCtx.currentTime - playStartTime, audioDuration);
  drawCursor(elapsed);

  rafId = requestAnimationFrame(updateCursor);
}

/**
 * Draw a 1-pixel vertical cursor line on the overlay canvas at the position
 * corresponding to `elapsed` seconds into the audio.
 *
 * Time-to-pixel mapping:
 *   The spectrogram canvas has canvas.width = numFrames data columns, but is
 *   CSS-stretched to fill the full panel width (clientWidth px).
 *   The cursor overlay has the same CSS dimensions and is sized to clientWidth
 *   × clientHeight in device-independent pixels so the line is 1px wide.
 *
 *   x_css = (elapsed / audioDuration) × clientWidth
 *
 * The overlay dimensions are updated on every call to automatically handle
 * window resize without a separate ResizeObserver.
 *
 * @param {number} elapsed - Seconds elapsed since playback started
 */
function drawCursor(elapsed) {
  // Sync overlay canvas resolution to its CSS-rendered size.
  // Must be done before drawing; if dimensions change clearRect is implicit.
  const w = canvasWrapper.clientWidth;
  const h = canvasWrapper.clientHeight;
  if (cursorCanvas.width !== w || cursorCanvas.height !== h) {
    cursorCanvas.width  = w;
    cursorCanvas.height = h;
  }

  cursorCtx.clearRect(0, 0, w, h);

  // x = fraction of total duration × display width (CSS pixels)
  const x = (elapsed / audioDuration) * w;

  cursorCtx.beginPath();
  cursorCtx.moveTo(x, 0);
  cursorCtx.lineTo(x, h);
  cursorCtx.strokeStyle = "#ff3333";
  cursorCtx.lineWidth   = 1.5;
  cursorCtx.stroke();
}

/**
 * Erase the cursor overlay entirely (called on stop or new file load).
 */
function clearCursorCanvas() {
  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
}
