# STFT Spectrogram Viewer

A browser-based tool for spectral analysis of non-stationary signals using the Short-Time Fourier Transform (STFT). Load an audio file, choose a windowing technique, and inspect the resulting spectrogram interactively.

## Features

- **STFT pipeline** with configurable FFT size, hop size, and window function
- **Five window functions**: Hamming, Hann, Blackman, Rectangular, Bartlett
- **Inferno colormap** with dB-scaled output (peak-normalised, -80 dB floor)
- **Audio playback** with a synchronized cursor overlaid on the spectrogram
- **MATLAB-style zoom**: click and drag to zoom into any region; double-click or use the reset button to return to full view
- **Collapsible sidebar** for maximum spectrogram canvas area
- **KaTeX equations** showing the window function formula for the selected window
- Pure JavaScript, no build step, no frameworks

## Getting Started

Open `index.html` directly in a browser, or serve the project directory with any static file server:

```bash
python -m http.server 8000
```

Then navigate to `http://localhost:8000`.

## Usage

1. Click **Choose File** and select a WAV or other browser-supported audio file.
2. Adjust STFT parameters in the sidebar (FFT size, hop size, window type).
3. Click **Run** to compute and render the spectrogram.
4. Click **Play** to play back the audio with a cursor tracking position on the spectrogram.
5. Click and drag on the spectrogram to zoom into a time-frequency region. Double-click to reset.

## Project Structure

```
index.html          Single-page app shell
style.css           Engineering dark theme layout
script.js           STFT pipeline, Web Audio playback, zoom, cursor
app.py              Python/Tkinter prototype (not used by the web app)
fft.py              FFT utilities for the Python prototype
stft.py             STFT implementation for the Python prototype
waves/              Sample waveform generation scripts
```

## Dependencies

- [fft.js 4.0.4](https://github.com/indutny/fft.js) via jsDelivr CDN
- [KaTeX](https://katex.org/) via jsDelivr CDN (math equation rendering)

Both are loaded from CDN at runtime; no `npm install` is required. This also means that you need an internet connection to make the site fully work.

## About the Python Scripts

The python scripts were written by hand first for learning purposes, then the website was made with the python implementation as reference, and with the aide of Claude Sonnet 4.6.

## License

See [LICENSE](LICENSE).
