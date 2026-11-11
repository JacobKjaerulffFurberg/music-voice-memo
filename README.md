# Voice Memo → DAW

Press record, sing or hum an idea, press stop. The app gives you the settings to continue in a DAW:
BPM and first-beat offset, key (top 3 + audio key), tuning offset (cents / A4 Hz), and the melody as notes.
You can export .mid, .wav, .json and .txt.

```bash
npm install
npm run dev        # http://localhost:5173  (debug page: /debug.html)
npm test           # Vitest, synthesized signals
npm run build      # typecheck + production build
```

## Layout

| Path | What |
| --- | --- |
| `src/audio/recorder.ts`, `recorder-worklet.ts` | getUserMedia (AEC/NS/AGC off) → AudioWorklet → mono Float32Array at the native rate |
| `src/analysis/pitch.ts` | YIN f0 tracker (decimates to ~16 kHz, 5 ms hop, parabolic interpolation) |
| `src/analysis/tuning.ts` | Circular-median cents offset of stable voiced frames → cents + A4 Hz |
| `src/analysis/notes.ts` | Median filter, split on >70 c jumps / voicing gaps / energy dips, drop <80 ms, quantise after tuning removal |
| `src/analysis/key.ts` | Krumhansl–Schmuckler on the duration-weighted pitch-class histogram |
| `src/analysis/tempo.ts` | Continuous-time IOI autocorrelation + comb, least-squares grid fit, fold into 70–160 |
| `src/analysis/essentia.ts` | essentia.js adapter: KeyExtractor, RhythmExtractor2013 (and experimental PYIN) |
| `src/analysis/pipeline.ts` | Pure `analyze(samples, sampleRate, externalInputs?)` |
| `src/analysis/worker.ts`, `client.ts` | Web Worker host + main-thread client |
| `src/export/midi.ts`, `wav.ts`, `summary.ts` | SMF writer (first downbeat = bar 1, pickups shifted into a leading bar), WAV enc/dec, summaries |
| `src/storage/db.ts` | IndexedDB (metadata and audio in separate stores) |
| `src/ui/*` | App shell, canvas piano roll, player with click track |

## Notes on engines

- **Pitch / f0:** comes from the pure-TS YIN by default. essentia.js 0.1.3's `PitchYinProbabilistic` measured badly in the browser:
  220 Hz → 213 Hz, 440 Hz → 224 Hz (octave error), 452 Hz → 445 Hz. That's far outside the ±5 c the tuning estimate needs.
  You can still pick it on the debug page ("essentia PYIN f0 (experimental)").
- **Key:** the card shows both the note-based Krumhansl–Schmuckler result (top 3) and essentia's `KeyExtractor`.
  KeyExtractor gets the detected A4 as its `tuningFrequency`. With 6 or more notes the app uses the note-based key; with fewer it uses the audio key.
- **Tempo:** the note-IOI estimate and essentia's `RhythmExtractor2013` both run (audio resampled to 44.1 kHz).
  The app picks whichever has higher confidence (essentia's multifeature confidence is divided by 5.32) and folds the result into 70–160 BPM.
- If essentia fails to load, everything falls back to pure TS. The status line says which engine ran.

## Mobile / Capacitor caveats

- Downloads use `<a download>`. In a Capacitor shell, swap this for the Filesystem/Share plugins.
- iOS needs the AudioContext started from a user gesture; the Record button does this.
- The essentia WASM chunk is ~2.5 MB and loads lazily inside the worker.
