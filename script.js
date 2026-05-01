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
  maxDurationSec: 10,       // hard cap: only first N seconds are processed
  frameSize: 256,           // FFT window length (must be power of 2)
  hopSize: 128,             // samples between successive frames
  windowType: "hamming",    // default window function
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM references
// ─────────────────────────────────────────────────────────────────────────────
const audioInput      = document.getElementById("audioInput");
const fileBtn         = document.getElementById("fileBtn");      // visible Browse button
const fileNameDisplay = document.getElementById("fileNameDisplay");
const processBtn      = document.getElementById("processBtn");
const frameSizeSelect = document.getElementById("frameSize");
const hopSizeSelect   = document.getElementById("hopSize");
const windowSelect    = document.getElementById("windowType");
const statusBar       = document.getElementById("statusBar");
const statusText      = document.getElementById("statusText");
const canvas          = document.getElementById("spectrogramCanvas");
const axisLabels      = document.getElementById("axisLabels");
const placeholder     = document.getElementById("placeholder");  // pre-render hint text
const ctx2d           = canvas.getContext("2d");

// Holds the decoded mono PCM after loadAudio() succeeds
let monoSamples = null;
let sampleRate  = 0;

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
  // Clear any previous result
  monoSamples = null;
  hideStatus();
  clearCanvas();
  axisLabels.classList.add("hidden");
  placeholder.classList.remove("hidden");
});

processBtn.addEventListener("click", async () => {
  const file = audioInput.files[0];
  if (!file) return;

  // Read current UI parameters into CONFIG
  CONFIG.frameSize  = parseInt(frameSizeSelect.value, 10);
  CONFIG.hopSize    = parseInt(hopSizeSelect.value,   10);
  CONFIG.windowType = windowSelect.value;

  processBtn.disabled = true;
  showStatus("Decoding audio…", false);

  try {
    // ── Step 1: decode ──────────────────────────────────────────────────────
    monoSamples = await loadAudio(file);

    showStatus("Computing STFT…", false);

    // ── Step 2: STFT (deferred one frame so the status message paints) ──────
    // Use setTimeout(0) to yield to the browser renderer before heavy work
    await yieldToUI();
    const powerMatrix = computeSTFT(monoSamples, CONFIG);

    showStatus("Rendering spectrogram…", false);
    await yieldToUI();

    // ── Step 3: render ───────────────────────────────────────────────────────
    renderSpectrogram(powerMatrix, canvas, ctx2d);

    // Hide the placeholder text and show axis labels once data is painted
    placeholder.classList.add("hidden");
    axisLabels.classList.remove("hidden");
    hideStatus();
  } catch (err) {
    showStatus(`Error: ${err.message}`, true);
    console.error(err);
  } finally {
    processBtn.disabled = false;
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
  // AudioContext is created fresh each call so we are not blocked by the
  // browser's autoplay policy (no audio is actually played).
  const audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  sampleRate = audioBuffer.sampleRate;

  // ── c. Mix to mono ────────────────────────────────────────────────────────
  const numChannels = audioBuffer.numberOfChannels;
  const length      = audioBuffer.length;
  const mono        = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i];
    }
  }
  if (numChannels > 1) {
    for (let i = 0; i < length; i++) mono[i] /= numChannels;
  }

  // ── d. Trim to maxDurationSec ─────────────────────────────────────────────
  const maxSamples = Math.floor(CONFIG.maxDurationSec * sampleRate);
  return mono.length > maxSamples ? mono.slice(0, maxSamples) : mono;
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
  const numBins    = frameSize / 2 + 1;  // positive-frequency bins (DC … Nyquist)
  const window     = buildWindow(windowType, frameSize);

  // fft.js instance — must be constructed with the exact FFT size
  const fftInstance = new FFT(frameSize);

  // Pre-allocate the complex input buffer once and reuse it every frame
  const complexInput = fftInstance.createComplexArray(); // length = 2 * frameSize

  const powerMatrix = [];

  for (let pos = 0; pos + frameSize <= samples.length; pos += hopSize) {
    // ── 1 & 2: window the frame ───────────────────────────────────────────
    // complexInput layout: [re0, im0, re1, im1, …]
    for (let n = 0; n < frameSize; n++) {
      complexInput[2 * n]     = samples[pos + n] * window[n]; // real part
      complexInput[2 * n + 1] = 0;                            // imaginary part = 0
    }

    // ── 3: FFT ────────────────────────────────────────────────────────────
    // fft.js transforms complexInput in-place; output is written to the same array.
    const out = fftInstance.createComplexArray();
    fftInstance.transform(out, complexInput);

    // ── 4: magnitude squared (power spectrum) ─────────────────────────────
    const powerFrame = new Float32Array(numBins);
    for (let k = 0; k < numBins; k++) {
      const re = out[2 * k];
      const im = out[2 * k + 1];
      powerFrame[k] = re * re + im * im;
    }

    powerMatrix.push(powerFrame);
  }

  return powerMatrix;  // [numFrames][numBins]
}

// =============================================================================
// 4. renderSpectrogram(powerMatrix, canvas, ctx)
// =============================================================================
/**
 * Paints the spectrogram onto the canvas.
 *
 * Coordinate convention (matches common spectrogram orientation):
 *   X-axis → time (left = 0, right = last frame)
 *   Y-axis → frequency (bottom = DC, top = Nyquist)
 *
 * Color mapping:
 *   Power values are converted to dB, normalised to [0, 1], and mapped through
 *   a simple "inferno-like" colormap for readability.  The colormap function is
 *   isolated so it can be replaced without touching the rest of the rendering pipeline.
 *
 * @param {number[][]} powerMatrix
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 */
function renderSpectrogram(powerMatrix, canvas, ctx) {
  const numFrames = powerMatrix.length;
  if (numFrames === 0) return;
  const numBins = powerMatrix[0].length;

  // Size canvas to exact data dimensions — CSS scales it to 100% width
  canvas.width  = numFrames;
  canvas.height = numBins;

  // ── Convert all power values to dB ────────────────────────────────────────
  const EPSILON = 1e-10;   // prevent log(0)
  let minDB =  Infinity;
  let maxDB = -Infinity;

  // Two-pass: first find the global dB range
  const dbMatrix = powerMatrix.map((frame) =>
    Array.from(frame).map((p) => {
      const db = 10 * Math.log10(p + EPSILON);
      if (db < minDB) minDB = db;
      if (db > maxDB) maxDB = db;
      return db;
    })
  );

  const dbRange = maxDB - minDB || 1; // avoid divide-by-zero on silence

  // ── Draw one pixel column per frame ───────────────────────────────────────
  // ImageData is faster than fillRect for dense pixel-level writes
  const imageData = ctx.createImageData(numFrames, numBins);
  const data      = imageData.data; // RGBA, row-major (row 0 = top)

  for (let t = 0; t < numFrames; t++) {
    for (let k = 0; k < numBins; k++) {
      // Normalise dB value to [0, 1]
      const norm = (dbMatrix[t][k] - minDB) / dbRange;

      // Y is flipped: bin 0 (DC) should appear at the bottom of the canvas
      const row = numBins - 1 - k;
      const idx = (row * numFrames + t) * 4;  // RGBA offset

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
