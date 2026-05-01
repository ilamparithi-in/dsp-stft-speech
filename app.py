"""
DSP Phase 1 — STFT Spectrogram Viewer
Single-window Tkinter application for comparing windowing effects on real audio signals.
"""

import tkinter as tk
from tkinter import filedialog, messagebox
import numpy as np
import matplotlib
matplotlib.use("TkAgg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import soundfile as sf
import librosa

from stft import stft

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────
TARGET_FS    = 2000
SEGMENT_SECS = 10
FRAME_SIZE   = 256
HOP_SIZE     = 128
EPSILON      = 1e-12
WINDOWS      = ["rectangular", "hann", "hamming", "blackman"]

# ──────────────────────────────────────────────────────────────────────────────
# Audio helpers
# ──────────────────────────────────────────────────────────────────────────────

def load_audio(
    path: str,
    start_sec: float,
    target_fs: int,
    segment_duration: float,
) -> np.ndarray:
    """
    Load an audio file, convert to mono, resample to *target_fs*, and extract
    a *segment_duration*-long segment beginning at *start_sec*.

    Returns a 1-D float64 array of length <= target_fs * segment_duration.
    """
    # --- primary loader: soundfile ---
    try:
        data, fs = sf.read(path, always_2d=True, dtype="float64")
    except Exception:
        # fallback: librosa (handles more container formats)
        data_lr, fs = librosa.load(path, sr=None, mono=False)
        if data_lr.ndim == 1:
            data = data_lr[:, np.newaxis]
        else:
            data = data_lr.T          # (samples, channels)
        data = data.astype(np.float64)

    # stereo → mono
    mono = data.mean(axis=1)

    # Resample the signal first so all downstream DSP uses the user-selected fs.
    if fs != target_fs:
        mono = librosa.resample(
            mono.astype(np.float32),
            orig_sr=fs,
            target_sr=target_fs,
        ).astype(np.float64)

    # Convert the user-entered time range into sample indices at the target fs.
    start_sample = int(start_sec * target_fs)
    end_sample = start_sample + int(segment_duration * target_fs)
    segment = mono[start_sample:end_sample]

    if segment.size == 0:
        raise ValueError(
            f"Start time {start_sec:.2f}s is beyond the end of the file "
            f"(duration ≈ {len(mono) / target_fs:.2f}s)."
        )

    return segment


def parse_processing_params(
    sampling_frequency_text: str,
    frame_size_text: str,
    hop_size_text: str,
    segment_duration_text: str,
) -> dict:
    """
    Parse the DSP parameter fields from the UI and enforce project constraints.
    """
    # Convert each UI field to the expected numeric type before validation.
    try:
        sampling_frequency = int(sampling_frequency_text.strip())
        frame_size = int(frame_size_text.strip())
        hop_size = int(hop_size_text.strip())
        segment_duration = float(segment_duration_text.strip())
    except ValueError as exc:
        raise ValueError(
            "Sampling frequency, frame size, and hop size must be integers, "
            "and segment duration must be a number."
        ) from exc

    # Validate the DSP parameters so invalid settings fail fast in the UI.
    if sampling_frequency <= 0:
        raise ValueError("Sampling frequency must be positive.")
    if frame_size < 16:
        raise ValueError("Frame size must be at least 16.")
    if hop_size <= 0:
        raise ValueError("Hop size must be positive.")
    if hop_size > frame_size:
        raise ValueError("Hop size must be less than or equal to frame size.")
    if segment_duration <= 0:
        raise ValueError("Segment duration must be greater than 0.")

    return {
        "sampling_frequency": sampling_frequency,
        "frame_size": frame_size,
        "hop_size": hop_size,
        "segment_duration": segment_duration,
    }


# ──────────────────────────────────────────────────────────────────────────────
# FFT helper (global spectrum of the segment)
# ──────────────────────────────────────────────────────────────────────────────

def compute_fft_db(x: np.ndarray, fs: int) -> tuple[np.ndarray, np.ndarray]:
    """Return positive-frequency axis (Hz) and magnitude spectrum in dB."""
    N   = len(x)
    X   = np.fft.fft(x)
    X_pos = X[: N // 2 + 1]
    freqs = np.fft.rfftfreq(N, d=1.0 / fs)
    mag_db = 20 * np.log10(np.abs(X_pos) / N + EPSILON)
    return freqs, mag_db


# ──────────────────────────────────────────────────────────────────────────────
# Plotting
# ──────────────────────────────────────────────────────────────────────────────

def _spectrogram_db(X: np.ndarray) -> np.ndarray:
    """Convert complex STFT matrix to dB power spectrogram (positive freqs)."""
    n_fft  = X.shape[1]
    X_pos  = X[:, : n_fft // 2 + 1]
    power  = np.abs(X_pos) ** 2
    return 10 * np.log10(power + EPSILON)


def plot_results(
    x: np.ndarray,
    stft_results: dict,
    fs: int,
    frame_size: int,
    hop_size: int,
    segment_duration: float,
    fig_frame: tk.Frame,
) -> None:
    """
    Build the comparison figure and embed it in *fig_frame*.
    Layout: 3 rows × 2 columns
      [0,0] rectangular  [0,1] hann
      [1,0] hamming      [1,1] blackman
      [2,0] global FFT   [2,1] (empty / colour scale note)
    """
    # destroy any previous canvas
    for child in fig_frame.winfo_children():
        child.destroy()

    fig, axes = plt.subplots(3, 2, figsize=(12, 9))
    fig.suptitle("STFT Spectrogram Comparison", fontsize=13, fontweight="bold")

    n_fft = list(stft_results.values())[0].shape[1]
    n_frames = list(stft_results.values())[0].shape[0]
    t_max = (n_frames - 1) * hop_size / fs
    f_max = (n_fft // 2) * fs / n_fft

    spectrogram_axes = [axes[0, 0], axes[0, 1], axes[1, 0], axes[1, 1]]

    for ax, win in zip(spectrogram_axes, WINDOWS):
        S_db   = _spectrogram_db(stft_results[win])

        # ── Diagnostics ───────────────────────────────────────────────────────
        # Due to energy-normalised window (w /= sqrt(sum(w²))) followed by
        # FFT /= frame_size, the absolute peak of S_db lands well below 0 dB
        # (typically −25 to −35 dB for a full-scale signal at N=256).  Without
        # re-anchoring, imshow(vmin=-80, vmax=0) would leave the upper portion
        # of the magma scale permanently empty, producing a "dim" spectrogram.
        s_max = np.max(S_db)
        s_min = np.min(S_db)
        print(
            f"[{win:>12}]  max={s_max:+.1f} dB  "
            f"min={s_min:+.1f} dB  "
            f"range={s_max - s_min:.1f} dB"
        )

        # ── Visualisation fix (NOT a DSP change) ─────────────────────────────
        # Subtract the per-spectrogram maximum so the strongest component
        # always maps to 0 dB.  Relative differences between frames, bins, and
        # window types are fully preserved — only the absolute reference shifts.
        # With vmin=-80, vmax=0 below, this guarantees the full magma palette
        # is exploited: bright = strong, dark = weak, 80 dB of headroom shown.
        S_db = S_db - s_max

        # Fixed dB display window: components within 80 dB of the peak are
        # rendered; anything weaker than −80 dB clips to black.  This is a
        # pure visualisation parameter and does not alter the DSP output.
        im     = ax.imshow(
            S_db.T,
            origin="lower",
            aspect="auto",
            extent=[0, t_max, 0, f_max],
            cmap="magma",
            vmin=-80,
            vmax=0,
        )
        ax.set_title(f"{win.capitalize()} window", fontsize=10)
        ax.set_xlabel("Time (s)", fontsize=8)
        ax.set_ylabel("Frequency (Hz)", fontsize=8)
        ax.tick_params(labelsize=7)
        fig.colorbar(im, ax=ax, label="dB", pad=0.02)

    # global FFT plot
    freqs, mag_db = compute_fft_db(x, fs)
    ax_fft = axes[2, 0]
    ax_fft.plot(freqs, mag_db, linewidth=0.8, color="steelblue")
    ax_fft.set_title(f"Global FFT ({len(x) / fs:.2f} s segment)", fontsize=10)
    ax_fft.set_xlabel("Frequency (Hz)", fontsize=8)
    ax_fft.set_ylabel("Magnitude (dB)", fontsize=8)
    ax_fft.set_xlim(0, fs / 2)
    ax_fft.tick_params(labelsize=7)
    ax_fft.grid(True, alpha=0.3)

    # hide the unused 6th subplot
    axes[2, 1].axis("off")
    axes[2, 1].text(
        0.5, 0.5,
        f"fs = {fs} Hz\nframe = {frame_size}\nhop = {hop_size}\nsegment <= {segment_duration}s",
        ha="center", va="center", transform=axes[2, 1].transAxes,
        fontsize=9, color="gray",
    )

    fig.tight_layout(rect=[0, 0, 1, 0.96])

    canvas = FigureCanvasTkAgg(fig, master=fig_frame)
    canvas.draw()
    canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)
    plt.close(fig)


# ──────────────────────────────────────────────────────────────────────────────
# Processing pipeline
# ──────────────────────────────────────────────────────────────────────────────

def run_pipeline(
    file_path: str,
    start_sec: float,
    sampling_frequency: int,
    frame_size: int,
    hop_size: int,
    segment_duration: float,
    fig_frame: tk.Frame,
) -> None:
    """Load audio, compute all 4 STFTs, and render plots."""
    # The user-controlled parameters affect resampling, slicing, and STFT resolution.
    x = load_audio(file_path, start_sec, sampling_frequency, segment_duration)

    stft_results = {}
    for win in WINDOWS:
        stft_results[win] = stft(x, sampling_frequency, win, frame_size, hop_size)

    plot_results(
        x,
        stft_results,
        sampling_frequency,
        frame_size,
        hop_size,
        segment_duration,
        fig_frame,
    )


# ──────────────────────────────────────────────────────────────────────────────
# GUI
# ──────────────────────────────────────────────────────────────────────────────

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("DSP Phase 1 — STFT Spectrogram Viewer")
        self.resizable(True, True)
        self._build_ui()

    # ── widget construction ────────────────────────────────────────────────

    def _build_ui(self):
        # ── control bar at the top ──
        ctrl = tk.Frame(self, pady=6, padx=8)
        ctrl.pack(side=tk.TOP, fill=tk.X)

        # file row
        file_row = tk.Frame(ctrl)
        file_row.pack(fill=tk.X, pady=(0, 4))

        tk.Label(file_row, text="Audio file:", width=10, anchor="w").pack(side=tk.LEFT)
        self._path_var = tk.StringVar()
        tk.Entry(file_row, textvariable=self._path_var, width=60).pack(side=tk.LEFT, padx=(0, 4))
        tk.Button(file_row, text="Browse", command=self._browse).pack(side=tk.LEFT)

        # options row
        opt_row = tk.Frame(ctrl)
        opt_row.pack(fill=tk.X)

        tk.Label(opt_row, text="Start time (s):", anchor="w").pack(side=tk.LEFT)
        self._start_var = tk.StringVar(value="0.0")
        tk.Entry(opt_row, textvariable=self._start_var, width=8).pack(side=tk.LEFT, padx=(4, 16))

        self._status_var = tk.StringVar(value="Ready.")
        tk.Label(opt_row, textvariable=self._status_var, fg="gray", anchor="w").pack(side=tk.LEFT, expand=True, fill=tk.X)

        tk.Button(opt_row, text="Run", command=self._run, width=8,
                  bg="#2e7d32", fg="white", relief=tk.FLAT).pack(side=tk.RIGHT)

        params_row = tk.Frame(ctrl)
        params_row.pack(fill=tk.X, pady=(4, 0))

        # Additional DSP controls let the user explore time-frequency tradeoffs.
        self._fs_var = tk.StringVar(value=str(TARGET_FS))
        self._frame_size_var = tk.StringVar(value=str(FRAME_SIZE))
        self._hop_size_var = tk.StringVar(value=str(HOP_SIZE))
        self._segment_duration_var = tk.StringVar(value=str(SEGMENT_SECS))

        self._add_labeled_entry(params_row, "Sampling Frequency (Hz)", self._fs_var, 10)
        self._add_labeled_entry(params_row, "Frame Size", self._frame_size_var, 8)
        self._add_labeled_entry(params_row, "Hop Size", self._hop_size_var, 8)
        self._add_labeled_entry(params_row, "Segment Duration (s)", self._segment_duration_var, 8)

        # ── plot area ──
        self._fig_frame = tk.Frame(self, bg="#1e1e1e")
        self._fig_frame.pack(side=tk.TOP, fill=tk.BOTH, expand=True)

        tk.Label(
            self._fig_frame,
            text="Load an audio file and click Run.",
            bg="#1e1e1e", fg="#aaaaaa",
        ).pack(expand=True)

    def _add_labeled_entry(self, parent: tk.Frame, label_text: str, variable: tk.StringVar, width: int):
        # Each DSP parameter is exposed as a labeled Tkinter entry in the same window.
        field = tk.Frame(parent)
        field.pack(side=tk.LEFT, padx=(0, 12))
        tk.Label(field, text=label_text).pack(anchor="w")
        tk.Entry(field, textvariable=variable, width=width).pack(anchor="w")

    # ── callbacks ─────────────────────────────────────────────────────────

    def _browse(self):
        path = filedialog.askopenfilename(
            title="Select audio file",
            filetypes=[
                ("WAV files", "*.wav"),
                ("All audio", "*.wav *.flac *.ogg *.mp3 *.aiff *.aif"),
                ("All files", "*"),
            ],
        )
        if path:
            self._path_var.set(path)

    def _run(self):
        path = self._path_var.get().strip()
        if not path:
            messagebox.showerror("Error", "Please select an audio file.")
            return

        raw_start = self._start_var.get().strip()
        try:
            start_sec = float(raw_start)
            if start_sec < 0:
                raise ValueError("Start time must be ≥ 0.")
        except ValueError as exc:
            messagebox.showerror("Invalid start time", str(exc))
            return

        # Parse and validate the configurable DSP parameters from the new UI fields.
        try:
            params = parse_processing_params(
                self._fs_var.get(),
                self._frame_size_var.get(),
                self._hop_size_var.get(),
                self._segment_duration_var.get(),
            )
        except ValueError as exc:
            messagebox.showerror("Invalid DSP parameters", str(exc))
            return

        self._status_var.set("Processing…")
        self.update_idletasks()

        try:
            run_pipeline(
                path,
                start_sec,
                params["sampling_frequency"],
                params["frame_size"],
                params["hop_size"],
                params["segment_duration"],
                self._fig_frame,
            )
            self._status_var.set("Done.")
        except Exception as exc:
            self._status_var.set("Error — see dialog.")
            messagebox.showerror("Processing error", str(exc))


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = App()
    app.mainloop()
