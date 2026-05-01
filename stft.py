import numpy as np
import matplotlib.pyplot as plt


def rectangular_window(frame_size):
	return np.ones(frame_size)


def hann_window(frame_size):
	n = np.arange(frame_size)
	return 0.5 - 0.5 * np.cos(2 * np.pi * n / (frame_size - 1))


def hamming_window(frame_size):
	n = np.arange(frame_size)
	return 0.54 - 0.46 * np.cos(2 * np.pi * n / (frame_size - 1))


def blackman_window(frame_size):
	n = np.arange(frame_size)
	return 0.42 - 0.5 * np.cos(2 * np.pi * n / (frame_size - 1)) + 0.08 * np.cos(4 * np.pi * n / (frame_size - 1))


def get_window(window_type, frame_size):
	if window_type == "rectangular":
		return rectangular_window(frame_size)
	if window_type == "hann":
		return hann_window(frame_size)
	if window_type == "hamming":
		return hamming_window(frame_size)
	if window_type == "blackman":
		return blackman_window(frame_size)
	raise ValueError("window_type must be one of: rectangular, hann, hamming, blackman")


def stft(x, fs, window_type, frame_size, hop_size, n_fft=None):
	x = np.asarray(x, dtype=float).reshape(-1)
	if frame_size <= 0 or hop_size <= 0:
		raise ValueError("frame_size and hop_size must be positive")
	if x.ndim != 1:
		raise ValueError("x must be a 1D array")
	if n_fft is None:
		n_fft = frame_size
	if n_fft <= 0:
		raise ValueError("n_fft must be positive")

	w = get_window(window_type, frame_size)
	w = w / np.sqrt(np.sum(w ** 2))

	# Choose enough frames so the full signal is covered with the given hop.
	if len(x) < frame_size:
		num_frames = 1
	else:
		num_frames = int(np.ceil((len(x) - frame_size) / hop_size)) + 1

	# Zero-pad so the last frame has exactly frame_size samples.
	pad_length = (num_frames - 1) * hop_size + frame_size
	x_padded = np.pad(x, (0, max(0, pad_length - len(x))), mode="constant")

	X = np.zeros((num_frames, n_fft), dtype=complex)
	for m in range(num_frames):
		start = m * hop_size
		# Frame extraction + windowing, then FFT for this frame.
		frame = x_padded[start:start + frame_size]
		X[m, :] = np.fft.fft(frame * w, n=n_fft) / frame_size

	return X


def plot_spectrogram(X, fs, hop_size):
	X = np.asarray(X)
	n_frames, n_fft = X.shape
	# For real-valued inputs, keep only non-negative frequency bins.
	X_pos = X[:, : n_fft // 2 + 1]
	power = np.abs(X_pos) ** 2
	# Clamp power floor to avoid log(0) in dB conversion.
	S_db = 10 * np.log10(power + 1e-12)

	# Map frame/bins to physical time (s) and frequency (Hz) axes.
	f = np.arange(n_fft // 2 + 1) * fs / n_fft
	f_min, f_max = f[0], f[-1]
	t_max = (n_frames - 1) * hop_size / fs

	plt.figure(figsize=(10, 4))
	plt.imshow(
		S_db.T,
		origin="lower",
		aspect="auto",
		extent=[0, t_max, f_min, f_max],
		cmap="magma",
	)
	plt.xlabel("Time (seconds)")
	plt.ylabel("Frequency (Hz)")
	plt.title("Spectrogram (dB)")
	plt.colorbar(label="Power (dB)")
	plt.tight_layout()
	plt.show()


if __name__ == "__main__":
    fs = 2000
    duration = 1.0
    t = np.arange(int(fs * duration)) / fs
    x = np.sin(2 * np.pi * 100 * t) + np.sin(2 * np.pi * 300 * t)

    window_type = "hamming"
    frame_size = 256
    hop_size = 128

    X = stft(x, fs, window_type, frame_size, hop_size)
    print(X.shape)
    plot_spectrogram(X, fs, hop_size)
