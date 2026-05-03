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

frequencies = [100, 250, 440, 1000, 5000]

generate_multi_tone(f"multi_tone_{'_'.join(map(str, frequencies))}Hz.wav", frequencies=frequencies, duration=5)
for f in frequencies:
    generate_sine_wave(f"tone_{f}Hz.wav", frequency=f, duration=5)
    generate_sawtooth_wave(f"sawtooth_{f}Hz.wav", frequency=f, duration=5)
    generate_square_wave(f"square_{f}Hz.wav", frequency=f, duration=5)



