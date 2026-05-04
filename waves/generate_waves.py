import numpy as np
import wave
import struct

def generate_sine_wave(filename, frequency=440.0, duration=2.0, sample_rate=44100, amplitude=0.5):
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    waveform = amplitude * np.sin(2 * np.pi * frequency * t)

    waveform_integers = np.int16(waveform * 32767)

    with wave.open(filename, 'w') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)

        for sample in waveform_integers:
            wav_file.writeframes(struct.pack('<h', sample))

def generate_square_wave(filename, frequency=440.0, duration=2.0, sample_rate=44100, amplitude=0.5):
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    waveform = amplitude * np.sign(np.sin(2 * np.pi * frequency * t))

    waveform_integers = np.int16(waveform * 32767)

    with wave.open(filename, 'w') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)

        for sample in waveform_integers:
            wav_file.writeframes(struct.pack('<h', sample))

def generate_sawtooth_wave(filename, frequency=440.0, duration=2.0, sample_rate=44100, amplitude=0.5):
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    waveform = amplitude * (2 * (t * frequency - np.floor(t * frequency + 0.5)))

    waveform_integers = np.int16(waveform * 32767)

    with wave.open(filename, 'w') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)

        for sample in waveform_integers:
            wav_file.writeframes(struct.pack('<h', sample))

def generate_multi_tone(filename, frequencies, duration=2.0, sample_rate=44100, amplitude=0.5):
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    waveform = amplitude * sum(np.sin(2 * np.pi * f * t) for f in frequencies)

    waveform_integers = np.int16(waveform * 32767)

    with wave.open(filename, 'w') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)

        for sample in waveform_integers:
            wav_file.writeframes(struct.pack('<h', sample))

def generate_nonstationary_wave(filename, frequencies, wave_type="sine", duration=5.0,
                                 sample_rate=44100, amplitude=0.5, seed=None):
    """Generate a non-stationary signal whose frequency changes every second.

    Each 1-second segment is assigned a frequency drawn uniformly at random from
    `frequencies`.  The phase restarts at zero for each segment, producing a clean
    step-change that shows as a sharp horizontal transition in the spectrogram.

    Parameters
    ----------
    filename    : output WAV path
    frequencies : list of candidate frequencies (Hz)
    wave_type   : "sine" | "square" | "sawtooth"
    duration    : total length in seconds (fractional part is discarded)
    sample_rate : samples per second
    amplitude   : peak amplitude (0–1)
    seed        : optional RNG seed for reproducibility
    """
    rng = np.random.default_rng(seed)
    n_seg = int(duration)
    samples_per_seg = sample_rate

    # Guarantee every frequency appears at least once by building a pool that
    # contains one full shuffled copy of `frequencies`, then filling remaining
    # segments randomly.  This ensures full coverage regardless of n_seg.
    freqs = list(frequencies)
    pool = freqs.copy()
    rng.shuffle(pool)
    while len(pool) < n_seg:
        extra = freqs.copy()
        rng.shuffle(extra)
        pool.extend(extra)
    chosen = pool[:n_seg]

    segments = []
    for f in chosen:
        t = np.arange(samples_per_seg) / sample_rate
        if wave_type == "sine":
            seg = amplitude * np.sin(2 * np.pi * f * t)
        elif wave_type == "square":
            seg = amplitude * np.sign(np.sin(2 * np.pi * f * t))
        elif wave_type == "sawtooth":
            seg = amplitude * (2 * (t * f - np.floor(t * f + 0.5)))
        else:
            raise ValueError(f"Unknown wave_type: {wave_type!r}")
        segments.append(seg)

    waveform = np.concatenate(segments)
    waveform_integers = np.int16(np.clip(waveform, -1.0, 1.0) * 32767)

    with wave.open(filename, 'w') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        for sample in waveform_integers:
            wav_file.writeframes(struct.pack('<h', sample))

    print(f"Wrote {filename}  ({n_seg}s, freqs/s: {chosen})")


frequencies = [5000, 8000, 11000]

generate_multi_tone(f"multi_tone_{'_'.join(map(str, frequencies))}Hz.wav", frequencies=frequencies, duration=5)
for f in frequencies:
    generate_sine_wave(f"tone_{f}Hz.wav", frequency=f, duration=5)
    generate_sawtooth_wave(f"sawtooth_{f}Hz.wav", frequency=f, duration=5)
    generate_square_wave(f"square_{f}Hz.wav", frequency=f, duration=5)

for wave_type in ("sine", "square", "sawtooth"):
    generate_nonstationary_wave(
        f"nonstationary_{wave_type}_{'_'.join(map(str, frequencies))}Hz.wav",
        frequencies=frequencies,
        wave_type=wave_type,
        duration=5,
        sample_rate=48000,
    )



