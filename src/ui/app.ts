/**
 * One-screen, DAW-style UI: header (record + transport), takes sidebar,
 * always-on clip editor in the middle, compact control strip at the bottom.
 * Space = play/stop, always. The page itself never scrolls.
 */

import { analyzeInWorker } from '../analysis/client';
import { DEFAULT_INTENT, type IntentOptions } from '../analysis/intent';
import { keyName, noteName } from '../analysis/music';
import { velocityOf } from '../analysis/velocity';
import { liveGuess, newLiveState } from '../analysis/live';
import { synthInstrument, synthMelody, TEST_MELODIES, type InstrumentEvent } from '../analysis/synth';
import type { AnalysisResult, EnginePreference, KeyResult, Mode, Note } from '../analysis/types';
import { micPermissionGranted, Recorder } from '../audio/recorder';
import { encodeMidi } from '../export/midi';
import { buildSummary, buildTextSummary } from '../export/summary';
import { decodeWav, encodeWav } from '../export/wav';
import { effectiveAnalysis, effectiveSettings, intentOf, isChordsTake, newId, type Overrides, type Settings, type StoredRecording } from '../model';
import { drumHits, suggestChords, voicePlayedChords, type Chord, type DrumHit, type DrumPatternId } from '../music/arrange';
import { deleteRecording, listRecordings, loadRecording, saveRecording, type RecordingMeta } from '../storage/db';
import { PianoRoll } from './piano-roll';
import { Player, type PlayNote } from './player';

export interface AppOptions {
  debug: boolean;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

function fmtTime(sec: number): string {
  const tenths = Math.max(0, Math.round(sec * 10));
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function fileSafe(name: string): string {
  return name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'voice-memo';
}

function download(filename: string, data: Uint8Array | string, mime: string): void {
  const part: BlobPart = typeof data === 'string' ? data : new Uint8Array(data);
  const url = URL.createObjectURL(new Blob([part], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function keyCandidatesText(k: KeyResult | null): string {
  if (!k) return '—';
  return k.candidates.map((c) => `${c.name} ${c.score.toFixed(2)}`).join(' · ');
}

const GRID_OPTIONS: [number, string][] = [
  [0, 'Off'],
  [1, '1/4'],
  [2, '1/8'],
  [3, '1/8T'],
  [4, '1/16'],
  [8, '1/32'],
];

const TEMPLATE = (debug: boolean): string => `
<div class="app">
  <header class="topbar">
    <button id="takes-toggle" class="icon-btn takes-toggle" title="Takes" aria-label="Show takes">☰</button>
    <button id="rec" class="rec-btn" title="Record / stop (R)" aria-label="Record"><span class="rec-icon"></span></button>
    <div class="rec-info">
      <div id="timer" class="timer">0:00.0</div>
      <div class="meter" aria-hidden="true"><div id="meter-fill" class="meter-fill"></div></div>
    </div>
    <div class="transport">
      <button id="play" class="play-btn" title="Play / stop (Space)" aria-label="Play">▶</button>
      <span id="pos" class="pos">0:00.0</span>
      <label class="chip"><input type="checkbox" id="voice" checked><span>Voice</span></label>
      <label class="chip"><input type="checkbox" id="notes-chk" checked><span>Notes</span></label>
      <label class="chip"><input type="checkbox" id="click"><span>Click</span></label>
      <label class="chip" title="Backing drums on/off (style in the Backing row)"><input type="checkbox" id="drums-on" checked><span>Drums</span></label>
      <label class="chip" title="Hear your mic live — use headphones to avoid feedback"><input type="checkbox" id="monitor"><span>🎧 Monitor</span></label>
    </div>
    <div class="nowbox" title="During playback: the chord at the playhead (and the next one). Otherwise, with the mic ready: a live guess of what you're playing or singing.">
      <span id="now-label" class="now-label">Chord</span>
      <span id="now-chord" class="now-chord">—</span>
      <span id="now-next" class="now-next"></span>
    </div>
    <div id="status" class="status">Press ● and sing an idea</div>
    ${debug ? '<a class="nav" href="./">App</a>' : '<a class="nav" href="./debug.html">Debug</a>'}
  </header>

  <div class="body">
    <aside id="side" class="side">
      ${
        debug
          ? `<section class="debug-panel">
        <h2>Debug input</h2>
        <label class="field">Audio file<input type="file" id="file" accept=".wav,audio/*"></label>
        <label class="field">Engine
          <select id="engine">
            <option value="auto">YIN + essentia key/rhythm</option>
            <option value="essentia-pyin">essentia PYIN f0 (exp.)</option>
            <option value="js">Pure JS</option>
          </select></label>
        <div class="row tight">
          <select id="synth-mel"></select>
          <label>BPM <input id="synth-bpm" type="number" value="100" min="40" max="240"></label>
          <label>¢ <input id="synth-detune" type="number" value="-30" min="-50" max="50"></label>
          <label class="check"><input type="checkbox" id="synth-sloppy" checked> sloppy</label>
          <button id="synth-go">Synth</button>
        </div>
        <div class="row tight">
          <button id="synth-piano" class="small">Piano C Am F G</button>
          <button id="synth-guitar" class="small">Guitar Dm A7 Gm</button>
        </div>
      </section>`
          : ''
      }
      <h2>Takes</h2>
      <ul id="list" class="list"></ul>
    </aside>

    <main class="main">
      <div id="empty" class="empty-state">
        <div class="big">●</div>
        <p>Press record, sing or hum your idea, press stop.<br>You'll get tempo, key, tuning and an editable melody.</p>
      </div>

      <div id="results" class="results" hidden>
        <div class="infobar">
          <input id="name" class="name" aria-label="Take name">
          <select id="source" class="small" title="What did you record? Auto decides from how many notes sound at once.">
            <option value="auto">Auto</option>
            <option value="melody">Melody</option>
            <option value="chords">Chords</option>
          </select>
          <label class="stat edit" id="st-bpm"><span class="label">Tempo BPM</span>
            <input id="in-bpm" class="stat-input" type="number" step="0.1" min="30" max="300" inputmode="decimal"></label>
          <label class="stat edit" id="st-key"><span class="label">Key</span>
            <select id="key-select" class="stat-select" aria-label="Key"></select></label>
          <label class="stat edit" id="st-tune"><span class="label">Tuning ¢</span>
            <input id="in-tune" class="stat-input" type="number" step="1" min="-50" max="50" inputmode="numeric"></label>
          <div class="stat edit" id="st-beat"><span class="label">Bar 1 at ms</span>
            <span class="stat-row"><input id="in-beat" class="stat-input" type="number" step="5" inputmode="numeric" aria-label="First beat (ms)">
            <button id="beat-here" class="mini" title="Put bar 1 at the playhead">⌖</button></span></div>
          <button id="reanalyze" class="ghost small" title="Run detection again">Re-analyze</button>
        </div>

        <div class="toolbar">
          <label class="tb">Grid <select id="grid"></select></label>
          <button id="undo" class="ghost small" title="Undo (Ctrl+Z)">↶</button>
          <button id="redo" class="ghost small" title="Redo (Ctrl+Shift+Z)">↷</button>
          <button id="qsel" class="ghost small" title="Quantize selection (Ctrl+U)">Q</button>
          <button id="revert" class="ghost small" title="Throw away edits and go back to the detected melody">Revert</button>
          <span id="sel-info" class="sel-info"></span>
          <label class="tb" id="vel-box" hidden title="Velocity of the selected notes (1–127)">Vel
            <input id="vel" type="number" min="1" max="127" step="1" class="vel-input"></label>
          <span class="spacer"></span>
          <span id="chord-list" class="chord-list"></span>
          <button id="zoom-out" class="ghost small" title="Zoom out (Ctrl+wheel)">−</button>
          <button id="zoom-in" class="ghost small" title="Zoom in (Ctrl+wheel)">+</button>
          <button id="help" class="ghost small" title="Editing help">?</button>
        </div>
        <div id="help-text" class="help" hidden>
          <b>Edit:</b> click note = select (Shift adds) · drag = move · drag edges = resize · Ctrl-drag = copy ·
          double-click empty = add · double-click note = delete · drag empty = box select · Alt = no snap ·
          ruler = set playhead · keys on the left = audition.
          <b>Keys:</b> Space play/stop · Del · ↑↓ semitone (Shift octave) · ←→ move (Shift length) ·
          Ctrl+A/C/V/D/U/Z · Esc.
        </div>

        <div id="roll-host" class="roll-host"></div>

        <div class="strip">
          <fieldset class="group">
            <legend>Interpret <span id="interp-note" class="muted"></span></legend>
            <label class="check" title="Move notes sung a bit off into the key"><input type="checkbox" id="fit-key"> Fit to key</label>
            <label class="slider" title="How strongly detected notes snap to the grid">Quantize
              <input type="range" id="q-strength" min="0" max="100" step="5"><span id="q-val"></span></label>
            <label class="check" title="Hold each note until the next one"><input type="checkbox" id="legato"> Legato</label>
            <label class="slider" title="Hide detected notes quieter than this velocity — clears faint ghost notes">Min vel
              <input type="range" id="min-vel" min="0" max="100" step="5"><span id="min-vel-val"></span></label>
          </fieldset>

          <fieldset class="group">
            <legend>Tempo &amp; key</legend>
            <button id="tap" class="small" title="Tap the beat">Tap</button>
            <button data-bpm="-1" class="small">−1</button><button data-bpm="1" class="small">+1</button>
            <button id="half" class="small">½×</button><button id="double" class="small">2×</button>
            <button data-beat="-1" class="small" title="Move bar 1 one beat earlier">◂beat</button>
            <button data-beat="1" class="small" title="Move bar 1 one beat later">beat▸</button>
            <button data-grid="-20" class="small" title="Nudge grid −20 ms">◂</button>
            <button data-grid="20" class="small" title="Nudge grid +20 ms">▸</button>
            <button id="reset" class="ghost small" title="Back to detected tempo, bar 1, key and tuning">Reset</button>
          </fieldset>

          <fieldset class="group">
            <legend>Backing</legend>
            <select id="drums" class="small" aria-label="Drums">
              <option value="off">No drums</option>
              <option value="rock" selected>Rock</option>
              <option value="halftime">Half-time</option>
              <option value="four">Four on the floor</option>
              <option value="ballad">Ballad</option>
            </select>
            <label class="check"><input type="checkbox" id="chords-chk" checked> Chords</label>
            <select id="chords-rate" class="small" aria-label="Chord rate">
              <option value="auto">Auto</option><option value="1">1 / bar</option><option value="2">2 / bar</option>
            </select>
          </fieldset>

          <fieldset class="group">
            <legend>Export</legend>
            <label class="check"><input type="checkbox" id="ex-backing" checked> +backing</label>
            <button id="ex-mid" class="small">.mid</button><button id="ex-wav" class="small">.wav</button>
            <button id="ex-json" class="small">.json</button><button id="ex-txt" class="small">.txt</button>
            <button id="copy" class="ghost small">Copy</button>
          </fieldset>
        </div>
        ${debug ? '<details class="debug-json"><summary>Analysis JSON</summary><pre id="debug-json"></pre></details>' : ''}
      </div>
    </main>
  </div>
</div>
`;

export function mountApp(root: HTMLElement, opts: AppOptions): void {
  root.innerHTML = TEMPLATE(opts.debug);
  document.body.classList.add('daw');
  const $ = <T extends HTMLElement>(id: string): T => {
    const el = root.querySelector<T>(`#${id}`);
    if (!el) throw new Error(`#${id} missing`);
    return el;
  };

  const recBtn = $<HTMLButtonElement>('rec');
  const timerEl = $<HTMLDivElement>('timer');
  const meterFill = $<HTMLDivElement>('meter-fill');
  const statusEl = $<HTMLDivElement>('status');
  const results = $<HTMLDivElement>('results');
  const emptyEl = $<HTMLDivElement>('empty');
  const side = $<HTMLElement>('side');
  const nameInput = $<HTMLInputElement>('name');
  const playBtn = $<HTMLButtonElement>('play');
  const clickChk = $<HTMLInputElement>('click');
  const drumsOn = $<HTMLInputElement>('drums-on');
  const voiceChk = $<HTMLInputElement>('voice');
  const notesChk = $<HTMLInputElement>('notes-chk');
  const posEl = $<HTMLSpanElement>('pos');
  const keySelect = $<HTMLSelectElement>('key-select');
  const listEl = $<HTMLUListElement>('list');
  const gridSel = $<HTMLSelectElement>('grid');
  const fitKeyChk = $<HTMLInputElement>('fit-key');
  const qStrength = $<HTMLInputElement>('q-strength');
  const qVal = $<HTMLSpanElement>('q-val');
  const legatoChk = $<HTMLInputElement>('legato');
  const interpNote = $<HTMLSpanElement>('interp-note');
  const drumsSel = $<HTMLSelectElement>('drums');
  const chordsChk = $<HTMLInputElement>('chords-chk');
  const chordsRate = $<HTMLSelectElement>('chords-rate');
  const chordListEl = $<HTMLSpanElement>('chord-list');
  const exBacking = $<HTMLInputElement>('ex-backing');
  const selInfo = $<HTMLSpanElement>('sel-info');
  const undoBtn = $<HTMLButtonElement>('undo');
  const redoBtn = $<HTMLButtonElement>('redo');
  const revertBtn = $<HTMLButtonElement>('revert');
  const sourceSel = $<HTMLSelectElement>('source');
  const velBox = $<HTMLLabelElement>('vel-box');
  const velInput = $<HTMLInputElement>('vel');
  const minVel = $<HTMLInputElement>('min-vel');
  const minVelVal = $<HTMLSpanElement>('min-vel-val');
  const inBpm = $<HTMLInputElement>('in-bpm');
  const inTune = $<HTMLInputElement>('in-tune');
  const inBeat = $<HTMLInputElement>('in-beat');
  const monitorChk = $<HTMLInputElement>('monitor');
  const nowLabel = $<HTMLSpanElement>('now-label');
  const nowChord = $<HTMLSpanElement>('now-chord');
  const nowNext = $<HTMLSpanElement>('now-next');
  /** Chords of the current take (played or suggested), for the "now playing" readout. */
  let currentChords: Chord[] = [];

  gridSel.innerHTML = GRID_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

  // ---------- persisted per-viewer preferences ----------
  const PREFS_KEY = 'vm.prefs';
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Record<string, string | boolean> | null;
    if (p) {
      if (typeof p.drums === 'string') drumsSel.value = p.drums;
      if (typeof p.chords === 'boolean') chordsChk.checked = p.chords;
      if (typeof p.rate === 'string') chordsRate.value = p.rate;
      if (typeof p.click === 'boolean') clickChk.checked = p.click;
      if (typeof p.drumsOn === 'boolean') drumsOn.checked = p.drumsOn;
    }
  } catch {
    /* storage unavailable */
  }
  const savePrefs = (): void => {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          drums: drumsSel.value,
          drumsOn: drumsOn.checked,
          chords: chordsChk.checked,
          rate: chordsRate.value,
          click: clickChk.checked,
        }),
      );
    } catch {
      /* ignore */
    }
  };

  const roll = new PianoRoll();
  $<HTMLDivElement>('roll-host').appendChild(roll.el);
  const player = new Player();

  let current: StoredRecording | null = null;
  let busy = false;
  let engine: EnginePreference = 'auto';
  /** Previous / next editedNotes states (undefined = the interpreted detection). */
  const undoStack: (Note[] | undefined)[] = [];
  const redoStack: (Note[] | undefined)[] = [];

  const setStatus = (t: string): void => {
    statusEl.textContent = t;
    statusEl.title = t;
  };

  function drumPattern(): DrumPatternId {
    if (!drumsOn.checked) return 'off';
    const v = drumsSel.value;
    return v === 'rock' || v === 'halftime' || v === 'four' || v === 'ballad' ? v : 'off';
  }

  function settings(): Settings | null {
    return current ? effectiveSettings(effectiveAnalysis(current), current.overrides) : null;
  }

  function effectiveRecording(): StoredRecording | null {
    return current ? { ...current, analysis: effectiveAnalysis(current) } : null;
  }

  /** Drums + chords for the current take and effective settings. */
  function arrangement(s: Settings): { drums: DrumHit[]; chords: Chord[] } {
    if (!current) return { drums: [], chords: [] };
    const grid = { bpm: s.bpm, firstBeatSec: s.firstBeatMs / 1000, beatsPerBar: 4, durationSec: current.samples.length / current.sampleRate };
    const rate = chordsRate.value === '1' ? 1 : chordsRate.value === '2' ? 2 : 'auto';
    const eff = effectiveAnalysis(current);
    // Chords takes: back them with what was actually played. Melodies: suggest chords.
    const chords =
      isChordsTake(eff) && eff?.playedChords?.length
        ? voicePlayedChords(eff.playedChords)
        : s.key && eff
          ? suggestChords(eff.notes, s.key, grid, { chordsPerBar: rate })
          : [];
    return { drums: drumHits(drumPattern(), grid), chords };
  }

  // ---------- recording ----------
  let recStart = 0;
  let raf = 0;
  let meterPeak = 0;
  const recorder = new Recorder({
    // Live meter whenever the mic is armed, so you can see it works before recording.
    onLevel: (peak) => {
      meterPeak = Math.max(peak, meterPeak * 0.85);
      const db = 20 * Math.log10(Math.max(1e-6, meterPeak));
      meterFill.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
      meterFill.classList.toggle('clip', peak > 0.98);
    },
    onWarmChange: (warm) => {
      recBtn.classList.toggle('armed', warm);
      recBtn.title = warm ? 'Record / stop (R) — mic ready' : 'Record / stop (R)';
      if (!warm) {
        meterPeak = 0;
        meterFill.style.width = '0%';
        monitorChk.checked = false;
      }
    },
  });
  const tick = (): void => {
    timerEl.textContent = fmtTime((performance.now() - recStart) / 1000);
    raf = requestAnimationFrame(tick);
  };

  let starting = false;
  async function toggleRecord(): Promise<void> {
    if (busy || starting) return;
    if (!recorder.isRecording) {
      // Show the recording state immediately; audio is already flowing if the mic was armed,
      // and the pre-roll covers the moment of the press.
      starting = true;
      stopPlayback();
      recStart = performance.now();
      recBtn.classList.add('recording');
      recBtn.setAttribute('aria-label', 'Stop recording');
      setStatus(recorder.isWarm ? 'Recording… press ● or R to stop' : 'Opening the microphone…');
      tick();
      try {
        const wasWarm = recorder.isWarm;
        await recorder.start();
        if (!wasWarm) {
          // First take: the mic needed opening, so start the clock now.
          recStart = performance.now();
          setStatus('Recording… press ● or R to stop');
        }
      } catch (e) {
        cancelAnimationFrame(raf);
        recBtn.classList.remove('recording');
        recBtn.setAttribute('aria-label', 'Record');
        timerEl.textContent = fmtTime(0);
        setStatus(`Microphone error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        starting = false;
      }
      return;
    }
    cancelAnimationFrame(raf);
    recBtn.classList.remove('recording');
    recBtn.setAttribute('aria-label', 'Record');
    const { samples, sampleRate } = await recorder.stop();
    if (samples.length < sampleRate * 0.5) {
      setStatus('Too short — try again');
      return;
    }
    await ingest(samples, sampleRate, `Idea ${new Date().toLocaleString()}`);
  }
  recBtn.addEventListener('click', () => void toggleRecord());

  // Arm the mic up front when permission was already granted (no prompt), so the
  // very first press is instant too. Release it when the tab is hidden.
  void micPermissionGranted().then((ok) => {
    if (ok) void recorder.warm().catch(() => undefined);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (!recorder.isRecording) recorder.release();
    } else {
      void micPermissionGranted().then((ok) => {
        if (ok) void recorder.warm().catch(() => undefined);
      });
    }
  });

  // ---------- analysis ----------
  async function ingest(samples: Float32Array, sampleRate: number, name: string): Promise<void> {
    const rec: StoredRecording = { id: newId(), name, createdAt: Date.now(), sampleRate, samples, analysis: null, overrides: {} };
    current = rec;
    undoStack.length = 0;
    redoStack.length = 0;
    keySelect.dataset.for = '';
    await saveRecording(rec).catch((e: unknown) => console.warn('save failed', e));
    await analyzeCurrent();
    void refreshList();
  }

  async function analyzeCurrent(): Promise<void> {
    const rec = current;
    if (!rec) return;
    busy = true;
    recBtn.disabled = true;
    const t0 = performance.now();
    try {
      setStatus('Analyzing…');
      const result = await analyzeInWorker(rec.samples, rec.sampleRate, engine, (stage) => setStatus(stage), rec.source ?? 'auto');
      rec.analysis = result;
      keySelect.dataset.for = '';
      await saveRecording(rec, false).catch((e: unknown) => console.warn('save failed', e));
      const ms = Math.round(performance.now() - t0);
      const eng = result.engine.essentia ? 'essentia.js' : 'pure JS';
      const what =
        result.input?.source === 'chords'
          ? `chords: ${result.notes.length} notes, ${result.playedChords?.length ?? 0} chord changes`
          : `melody: ${result.notes.length} notes`;
      const poly = result.input?.polyphony != null ? ` · polyphony ${result.input.polyphony.toFixed(1)}` : '';
      setStatus(
        `Analyzed ${fmtTime(result.durationSec)} in ${ms} ms (${eng}) — ${what}${poly}` +
          (result.engine.essentiaError ? ` · essentia: ${result.engine.essentiaError}` : ''),
      );
    } catch (e) {
      setStatus(`Analysis failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
      recBtn.disabled = false;
      render();
      void refreshList();
    }
  }

  // ---------- rendering ----------
  /** Key menu: the detected key, the next-best guesses (incl. relative / neighbour keys), then all 24. */
  function buildKeyOptions(a: AnalysisResult | null): void {
    const detected = a?.key.chosen?.name ?? 'none';
    const o = [`<option value="auto">${detected}</option>`];
    const seen = new Set<string>();
    const guesses = [...(a?.key.fromNotes?.candidates ?? []), ...(a?.key.fromAudio ? [a.key.fromAudio] : [])];
    const top = guesses.filter((c) => {
      const k = `${c.tonic}:${c.mode}`;
      if (seen.has(k) || c.name === detected) return false;
      seen.add(k);
      return true;
    });
    if (top.length) {
      o.push('<optgroup label="Other guesses">');
      for (const c of top) o.push(`<option value="${c.tonic}:${c.mode}">${keyName(c.tonic, c.mode)}</option>`);
      o.push('</optgroup>');
    }
    for (const mode of ['major', 'minor'] as Mode[]) {
      o.push(`<optgroup label="All ${mode} keys">`);
      for (let t = 0; t < 12; t++) o.push(`<option value="${t}:${mode}">${keyName(t, mode)}</option>`);
      o.push('</optgroup>');
    }
    keySelect.innerHTML = o.join('');
  }

  function render(): void {
    const rec = current;
    results.hidden = !rec;
    emptyEl.hidden = !!rec;
    if (!rec) return;
    if (document.activeElement !== nameInput) nameInput.value = rec.name;
    const a = effectiveAnalysis(rec);
    const s = effectiveSettings(a, rec.overrides);
    const dur = rec.samples.length / rec.sampleRate;
    const edited = rec.editedNotes !== undefined;
    const intent = intentOf(rec);

    // Editable settings: show values (unless being typed in), mark manual ones, explain in tooltips.
    const field = (input: HTMLInputElement, value: string, manual: boolean, title: string): void => {
      if (document.activeElement !== input) input.value = value;
      const box = input.closest('.stat') as HTMLElement;
      box.classList.toggle('manual', manual);
      box.title = title;
    };
    const cands = a?.tempo.candidates.map((c) => `${c.source === 'note-ioi' ? 'notes' : c.source === 'essentia-rhythm2013' ? 'essentia' : 'attacks'} ${c.bpm.toFixed(1)} (${pct(c.confidence)})`).join(' · ') ?? '';
    field(inBpm, s.bpm.toFixed(1), s.overridden.bpm, `${s.overridden.bpm ? 'Set by you' : `Detected, ${pct(s.bpmConfidence)} sure`} · ${cands}. Type a tempo; ½× / 2× and Tap are below.`);
    field(
      inTune,
      a ? s.tuningCents.toFixed(0) : '',
      s.overridden.tuning,
      a ? `A4 = ${s.a4Hz.toFixed(2)} Hz${s.overridden.tuning ? ' (set by you — notes re-read at this tuning)' : ` (detected from ${a.tuning.source ?? 'frames'})`}` : '',
    );
    field(inBeat, String(Math.round(s.firstBeatMs)), s.overridden.firstBeat, 'Where bar 1 beat 1 is, in ms from the start. ⌖ puts it at the playhead.');
    const audioKey = a?.key.fromAudio;
    const keyBox = keySelect.closest('.stat') as HTMLElement;
    keyBox.classList.toggle('manual', s.overridden.key);
    keyBox.title =
      `${s.overridden.key ? 'Set by you' : `Detected, ${pct(s.keyConfidence)} sure`} · notes: ${keyCandidatesText(a?.key.fromNotes ?? null)}` +
      (audioKey ? ` · audio: ${audioKey.name}` : '') +
      '. The key drives fit-to-key, chord suggestions and the MIDI key signature.';

    if (keySelect.dataset.for !== rec.id || keySelect.dataset.detected !== (a?.key.chosen?.name ?? '')) {
      buildKeyOptions(a);
      keySelect.dataset.for = rec.id;
      keySelect.dataset.detected = a?.key.chosen?.name ?? '';
    }
    keySelect.value = rec.overrides.keyTonic !== undefined ? `${rec.overrides.keyTonic}:${rec.overrides.keyMode ?? 'major'}` : 'auto';

    // Interpretation + grid.
    gridSel.value = String(intent.quantizeGrid);
    roll.grid = intent.quantizeGrid;
    fitKeyChk.checked = intent.fitToKey;
    qStrength.value = String(Math.round(intent.quantizeStrength * 100));
    qVal.textContent = `${qStrength.value}%`;
    legatoChk.checked = intent.legato;
    minVel.value = String(intent.minVelocity);
    minVelVal.textContent = intent.minVelocity > 0 ? String(intent.minVelocity) : 'off';
    const chordsTake = isChordsTake(rec.analysis);
    for (const el of [fitKeyChk, qStrength, legatoChk, minVel]) el.disabled = edited;
    if (chordsTake) legatoChk.disabled = true;
    sourceSel.value = rec.source ?? 'auto';
    const detected = rec.analysis?.input?.source;
    (sourceSel.options[0] as HTMLOptionElement).textContent = detected ? `Auto (${detected})` : 'Auto';
    interpNote.textContent = edited ? '(edited — Revert to re-apply)' : '';
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
    revertBtn.disabled = !edited;

    const arr = arrangement(s);
    currentChords = arr.chords;
    roll.setChords(chordsChk.checked ? arr.chords : []);
    chordListEl.textContent = arr.chords.length ? `${chordsTake ? 'played: ' : ''}${arr.chords.map((c) => c.name).join(' ')}` : '';
    chordListEl.title = arr.chords.map((c) => `${c.name} (${c.numeral})`).join(' · ');
    roll.setData(a, s, dur);
    roll.setPlayhead(player.playing || player.position > 0 ? player.position : null);

    if (opts.debug) {
      const dbg = root.querySelector<HTMLPreElement>('#debug-json');
      if (dbg && a) {
        const { pitch, ...rest } = a;
        dbg.textContent = JSON.stringify({ ...rest, pitch: { engine: pitch.engine, frames: pitch.f0Hz.length, hopSec: pitch.hopSec } }, null, 2);
      }
    }
  }

  // ---------- persistence ----------
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function saveSoon(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (current) void saveRecording(current, false).then(refreshList);
    }, 400);
  }

  function changed(): void {
    render();
    saveSoon();
    if (player.playing) void startPlayback(player.position);
  }

  // ---------- overrides (tempo / grid / key) ----------
  function override(mut: (o: Overrides, s: Settings) => void): void {
    const s = settings();
    if (!current || !s) return;
    mut(current.overrides, s);
    if (current.overrides.bpm !== undefined) current.overrides.bpm = Math.max(30, Math.min(300, current.overrides.bpm));
    changed();
  }
  root.querySelectorAll<HTMLButtonElement>('[data-bpm]').forEach((b) =>
    b.addEventListener('click', () => override((o, s) => (o.bpm = Math.round((s.bpm + Number(b.dataset.bpm)) * 100) / 100))),
  );
  $<HTMLButtonElement>('half').addEventListener('click', () => override((o, s) => (o.bpm = s.bpm / 2)));
  $<HTMLButtonElement>('double').addEventListener('click', () => override((o, s) => (o.bpm = s.bpm * 2)));
  root.querySelectorAll<HTMLButtonElement>('[data-grid]').forEach((b) =>
    b.addEventListener('click', () => override((o, s) => (o.firstBeatMs = s.firstBeatMs + Number(b.dataset.grid)))),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-beat]').forEach((b) =>
    b.addEventListener('click', () => override((o, s) => (o.firstBeatMs = s.firstBeatMs + (Number(b.dataset.beat) * 60000) / s.bpm))),
  );
  keySelect.addEventListener('change', () =>
    override((o) => {
      if (keySelect.value === 'auto') {
        delete o.keyTonic;
        delete o.keyMode;
      } else {
        const [t, m] = keySelect.value.split(':');
        o.keyTonic = Number(t);
        o.keyMode = m === 'minor' ? 'minor' : 'major';
      }
    }),
  );
  $<HTMLButtonElement>('reset').addEventListener('click', () =>
    override((o) => {
      delete o.bpm;
      delete o.firstBeatMs;
      delete o.keyTonic;
      delete o.keyMode;
      delete o.tuningCents;
    }),
  );

  // Typed values (applied on Enter / leaving the field).
  const numberField = (input: HTMLInputElement, apply: (v: number, o: Overrides) => void): void => {
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (input.value.trim() === '' || !Number.isFinite(v)) {
        render();
        return;
      }
      override((o) => apply(v, o));
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        render();
        input.blur();
      }
    });
  };
  numberField(inBpm, (v, o) => (o.bpm = v));
  numberField(inBeat, (v, o) => (o.firstBeatMs = v));
  numberField(inTune, (v, o) => (o.tuningCents = Math.max(-50, Math.min(50, v))));
  $<HTMLButtonElement>('beat-here').addEventListener('click', () =>
    override((o) => (o.firstBeatMs = Math.round(player.position * 1000))),
  );
  const taps: number[] = [];
  $<HTMLButtonElement>('tap').addEventListener('pointerdown', () => {
    const t = performance.now();
    if (taps.length && t - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(t);
    if (taps.length > 8) taps.shift();
    if (taps.length >= 2) {
      const span = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      override((o) => (o.bpm = Math.round((60000 / span) * 10) / 10));
    }
  });

  nameInput.addEventListener('input', () => {
    if (!current) return;
    current.name = nameInput.value;
    saveSoon();
  });
  $<HTMLButtonElement>('reanalyze').addEventListener('click', () => {
    if (current?.editedNotes && !confirm('Re-analyzing replaces your edited notes with freshly detected ones. Continue?')) return;
    if (current) delete current.editedNotes;
    undoStack.length = 0;
    redoStack.length = 0;
    void analyzeCurrent();
  });

  sourceSel.addEventListener('change', () => {
    if (!current) return;
    if (current.editedNotes && !confirm('Changing the input type re-analyzes the take and replaces your edited notes. Continue?')) {
      sourceSel.value = current.source ?? 'auto';
      return;
    }
    const v = sourceSel.value;
    current.source = v === 'melody' || v === 'chords' ? v : 'auto';
    delete current.editedNotes;
    undoStack.length = 0;
    redoStack.length = 0;
    void analyzeCurrent();
  });

  // ---------- interpretation ----------
  function setIntent(patch: Partial<IntentOptions>): void {
    if (!current) return;
    current.intent = { ...DEFAULT_INTENT, ...current.intent, ...patch };
    changed();
  }
  gridSel.addEventListener('change', () => setIntent({ quantizeGrid: Number(gridSel.value) }));
  fitKeyChk.addEventListener('change', () => setIntent({ fitToKey: fitKeyChk.checked }));
  legatoChk.addEventListener('change', () => setIntent({ legato: legatoChk.checked }));
  minVel.addEventListener('input', () => {
    const v = Number(minVel.value);
    minVelVal.textContent = v > 0 ? String(v) : 'off';
    setIntent({ minVelocity: v });
  });
  qStrength.addEventListener('input', () => {
    qVal.textContent = `${qStrength.value}%`;
    setIntent({ quantizeStrength: Number(qStrength.value) / 100 });
  });

  // ---------- note editing ----------
  function setEditedNotes(next: Note[] | undefined, history: 'push' | 'undo' | 'redo' = 'push'): void {
    if (!current) return;
    if (history === 'push') {
      undoStack.push(current.editedNotes);
      if (undoStack.length > 300) undoStack.shift();
      redoStack.length = 0;
    }
    if (next) current.editedNotes = next;
    else delete current.editedNotes;
    changed();
  }
  const undo = (): void => {
    if (!current || undoStack.length === 0) return;
    redoStack.push(current.editedNotes);
    setEditedNotes(undoStack.pop(), 'undo');
  };
  const redo = (): void => {
    if (!current || redoStack.length === 0) return;
    undoStack.push(current.editedNotes);
    setEditedNotes(redoStack.pop(), 'redo');
  };
  roll.onNotesChange = (notes) => setEditedNotes(notes);
  roll.onSelect = (sel) => {
    velBox.hidden = sel.length === 0;
    if (sel.length === 0) selInfo.textContent = '';
    else if (sel.length === 1) {
      const n = sel[0];
      selInfo.textContent = `${noteName(n.midi)} · ${n.start.toFixed(2)}s · ${Math.round(n.duration * 1000)}ms`;
    } else selInfo.textContent = `${sel.length} notes`;
    if (sel.length && document.activeElement !== velInput) {
      velInput.value = String(Math.round(sel.reduce((s, n) => s + velocityOf(n), 0) / sel.length));
    }
  };
  velInput.addEventListener('change', () => {
    const v = Math.max(1, Math.min(127, Math.round(Number(velInput.value))));
    if (Number.isFinite(v)) roll.editSelected((n) => (n.velocity = v), false);
  });
  velInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') velInput.blur();
  });
  roll.onPreview = (midi) => {
    const s = settings();
    void player.preview(midi, voiceChk.checked && s ? s.tuningCents : 0);
  };
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  revertBtn.addEventListener('click', () => {
    if (current?.editedNotes) setEditedNotes(undefined);
  });
  $<HTMLButtonElement>('qsel').addEventListener('click', () => roll.quantizeSelected());
  $<HTMLButtonElement>('zoom-in').addEventListener('click', () => roll.setZoom(1.5));
  $<HTMLButtonElement>('zoom-out').addEventListener('click', () => roll.setZoom(1 / 1.5));
  $<HTMLButtonElement>('help').addEventListener('click', () => {
    const h = $<HTMLDivElement>('help-text');
    h.hidden = !h.hidden;
  });

  // ---------- monitoring (hear your mic) ----------
  monitorChk.addEventListener('change', () => {
    void recorder.setMonitor(monitorChk.checked ? 1 : 0).then(
      () => setStatus(monitorChk.checked ? 'Monitoring on — use headphones, or you will get feedback' : 'Monitoring off'),
      (e: unknown) => {
        monitorChk.checked = false;
        setStatus(`Microphone error: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  });

  // ---------- chord readout: now/next during playback, live guess otherwise ----------
  function chordAt(t: number): { now: Chord | null; next: Chord | null } {
    const i = currentChords.findIndex((c) => t >= c.start && t < c.start + c.duration);
    if (i >= 0) return { now: currentChords[i], next: currentChords[i + 1] ?? null };
    const nextIdx = currentChords.findIndex((c) => c.start > t);
    return { now: null, next: nextIdx >= 0 ? currentChords[nextIdx] : null };
  }
  function showNow(label: string, main: string, sub: string, isNote = false): void {
    if (nowLabel.textContent !== label) nowLabel.textContent = label;
    if (nowChord.textContent !== main) nowChord.textContent = main;
    if (nowNext.textContent !== sub) nowNext.textContent = sub;
    nowChord.classList.toggle('note', isNote);
  }
  const liveState = newLiveState();
  setInterval(() => {
    if (player.playing) return; // follow() drives the readout during playback
    const spec = recorder.readSpectrum();
    if (spec) {
      const s = settings();
      const g = liveGuess(spec.mags, spec.sampleRate, spec.fftSize, spec.rms, liveState, s?.tuningCents ?? 0, s?.key ?? null);
      const cents = g.kind === 'note' && g.cents !== null ? `${g.cents >= 0 ? '+' : '−'}${Math.abs(Math.round(g.cents))}¢` : '';
      showNow(recorder.isRecording ? 'Rec' : 'Live', g.label, cents, g.kind === 'note');
      return;
    }
    const { now, next } = chordAt(player.position);
    showNow('Chord', now?.name ?? '—', next ? `→ ${next.name}` : '');
  }, 100);

  // ---------- playback ----------
  let playRaf = 0;
  const follow = (): void => {
    posEl.textContent = fmtTime(player.position);
    roll.setPlayhead(player.position);
    const { now, next } = chordAt(player.position);
    showNow('Now', now?.name ?? '—', next ? `→ ${next.name}` : '');
    if (player.playing) playRaf = requestAnimationFrame(follow);
  };

  async function startPlayback(from: number): Promise<void> {
    const s = settings();
    if (!current || !s) return;
    const arr = arrangement(s);
    const notes: PlayNote[] = notesChk.checked
      ? (effectiveAnalysis(current)?.notes ?? []).map((n) => ({ midi: n.midi, start: n.start, duration: n.duration, velocity: velocityOf(n) }))
      : [];
    await player.play(current.samples, current.sampleRate, {
      from,
      click: clickChk.checked,
      voice: voiceChk.checked,
      bpm: s.bpm,
      firstBeatMs: s.firstBeatMs,
      beatsPerBar: 4,
      clickGain: 0.35,
      notes,
      notesTuningCents: voiceChk.checked ? s.tuningCents : 0,
      notesGain: voiceChk.checked ? 0.18 : 0.3,
      drums: arr.drums,
      chords: chordsChk.checked ? arr.chords : [],
      backingTuningCents: voiceChk.checked ? s.tuningCents : 0,
    });
    playBtn.textContent = '■';
    playBtn.classList.add('playing');
    cancelAnimationFrame(playRaf);
    follow();
  }

  function stopPlayback(): void {
    player.stop();
    playBtn.textContent = '▶';
    playBtn.classList.remove('playing');
  }

  function togglePlay(): void {
    if (recorder.isRecording) {
      void toggleRecord();
      return;
    }
    if (player.playing) stopPlayback();
    else if (current) void startPlayback(player.position);
  }

  player.onEnded = () => {
    playBtn.textContent = '▶';
    playBtn.classList.remove('playing');
    roll.setPlayhead(null);
    posEl.textContent = fmtTime(0);
  };
  playBtn.addEventListener('click', togglePlay);
  for (const el of [clickChk, voiceChk, notesChk]) {
    el.addEventListener('change', () => {
      savePrefs();
      if (player.playing) void startPlayback(player.position);
    });
  }
  for (const el of [drumsSel, drumsOn, chordsChk, chordsRate]) {
    el.addEventListener('change', () => {
      savePrefs();
      changed();
    });
  }
  roll.onSeek = (sec) => {
    if (player.playing) void startPlayback(sec);
    else {
      player.seek(sec);
      roll.setPlayhead(sec);
      posEl.textContent = fmtTime(sec);
    }
  };

  // ---------- keyboard: Space always plays/stops, never scrolls ----------
  const isTextField = (t: EventTarget | null): boolean =>
    t instanceof HTMLInputElement
      ? !['checkbox', 'radio', 'range', 'button', 'file'].includes(t.type)
      : t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

  window.addEventListener(
    'keydown',
    (e) => {
      if (isTextField(e.target)) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) togglePlay();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod && !e.altKey && e.key.toLowerCase() === 'r' && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        if (!e.repeat) void toggleRecord();
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (e.target instanceof HTMLSelectElement && !mod) return; // let selects use arrows
      if (current && roll.handleKey(e)) e.preventDefault();
    },
    { capture: true },
  );
  // Buttons/checkboxes activate on Space keyup — swallow that too.
  window.addEventListener(
    'keyup',
    (e) => {
      if ((e.code === 'Space' || e.key === ' ') && !isTextField(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
  // Don't leave focus on clicked controls (keeps keyboard focus on the editor).
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t instanceof HTMLButtonElement) t.blur();
  });

  // ---------- export ----------
  $<HTMLButtonElement>('ex-mid').addEventListener('click', () => {
    const s = settings();
    const eff = current ? effectiveAnalysis(current) : null;
    if (!current || !eff || !s) return;
    const arr = arrangement(s);
    const bytes = encodeMidi(
      eff.notes,
      { bpm: s.bpm, firstBeatSec: s.firstBeatMs / 1000, quantize: 0, key: s.key, trackName: current.name },
      exBacking.checked ? { chords: chordsChk.checked ? arr.chords : [], drums: arr.drums } : undefined,
    );
    download(`${fileSafe(current.name)}.mid`, bytes, 'audio/midi');
  });
  $<HTMLButtonElement>('ex-wav').addEventListener('click', () => {
    if (current) download(`${fileSafe(current.name)}.wav`, encodeWav(current.samples, current.sampleRate, 24), 'audio/wav');
  });
  $<HTMLButtonElement>('ex-json').addEventListener('click', () => {
    const s = settings();
    const rec = effectiveRecording();
    if (rec && s) download(`${fileSafe(rec.name)}.json`, JSON.stringify(buildSummary(rec, s), null, 2), 'application/json');
  });
  $<HTMLButtonElement>('ex-txt').addEventListener('click', () => {
    const s = settings();
    const rec = effectiveRecording();
    if (rec && s) download(`${fileSafe(rec.name)}.txt`, buildTextSummary(rec, s), 'text/plain');
  });
  $<HTMLButtonElement>('copy').addEventListener('click', () => {
    const s = settings();
    const rec = effectiveRecording();
    if (!rec || !s) return;
    void navigator.clipboard.writeText(buildTextSummary(rec, s)).then(
      () => setStatus('Settings copied to clipboard'),
      () => setStatus('Clipboard not available'),
    );
  });

  // ---------- takes list ----------
  $<HTMLButtonElement>('takes-toggle').addEventListener('click', () => side.classList.toggle('open'));

  async function refreshList(): Promise<void> {
    let items: RecordingMeta[];
    try {
      items = await listRecordings();
    } catch (e) {
      listEl.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = `Storage unavailable: ${e instanceof Error ? e.message : String(e)}`;
      listEl.appendChild(li);
      return;
    }
    listEl.innerHTML = '';
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No takes yet.';
      listEl.appendChild(li);
      return;
    }
    for (const m of items) {
      const s = effectiveSettings(effectiveAnalysis(m), m.overrides);
      const li = document.createElement('li');
      li.classList.toggle('active', current?.id === m.id);
      const main = document.createElement('button');
      main.className = 'item-main';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = m.name;
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      meta.textContent = [
        fmtTime(m.durationSec),
        m.analysis ? `${s.bpm.toFixed(0)} BPM` : 'not analyzed',
        s.key?.name ?? '',
        m.editedNotes ? '✎' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      main.append(title, meta);
      main.title = new Date(m.createdAt).toLocaleString();
      main.addEventListener('click', () => {
        side.classList.remove('open');
        void open(m.id);
      });
      const del = document.createElement('button');
      del.className = 'ghost del';
      del.textContent = '✕';
      del.title = 'Delete take';
      del.addEventListener('click', () => {
        if (!confirm(`Delete "${m.name}"? This cannot be undone.`)) return;
        void deleteRecording(m.id).then(() => {
          if (current?.id === m.id) {
            stopPlayback();
            current = null;
            render();
          }
          return refreshList();
        });
      });
      li.append(main, del);
      listEl.appendChild(li);
    }
  }

  async function open(id: string): Promise<void> {
    if (recorder.isRecording || busy) return;
    stopPlayback();
    player.seek(0);
    const rec = await loadRecording(id);
    if (!rec) {
      setStatus('Take not found');
      return;
    }
    current = rec;
    undoStack.length = 0;
    redoStack.length = 0;
    keySelect.dataset.for = '';
    render();
    void refreshList();
    if (!rec.analysis) await analyzeCurrent();
  }

  // ---------- debug inputs ----------
  if (opts.debug) {
    const engineSel = $<HTMLSelectElement>('engine');
    engineSel.addEventListener('change', () => {
      const v = engineSel.value;
      engine = v === 'js' || v === 'essentia-pyin' ? v : 'auto';
    });
    $<HTMLInputElement>('file').addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      void (async () => {
        const buf = await file.arrayBuffer();
        let samples: Float32Array;
        let sampleRate: number;
        try {
          const w = decodeWav(buf);
          samples = w.samples;
          sampleRate = w.sampleRate;
        } catch {
          const ctx = new AudioContext();
          const ab = await ctx.decodeAudioData(buf.slice(0));
          sampleRate = ab.sampleRate;
          samples = new Float32Array(ab.length);
          for (let c = 0; c < ab.numberOfChannels; c++) {
            const ch = ab.getChannelData(c);
            for (let i = 0; i < ch.length; i++) samples[i] += ch[i] / ab.numberOfChannels;
          }
          await ctx.close();
        }
        await ingest(samples, sampleRate, file.name.replace(/\.[^.]+$/, ''));
        input.value = '';
      })().catch((err: unknown) => setStatus(`Could not load file: ${err instanceof Error ? err.message : String(err)}`));
    });
    const melSel = $<HTMLSelectElement>('synth-mel');
    melSel.innerHTML = Object.keys(TEST_MELODIES)
      .map((k) => `<option>${k}</option>`)
      .join('');
    $<HTMLButtonElement>('synth-go').addEventListener('click', () => {
      const mel = TEST_MELODIES[melSel.value];
      if (!mel) return;
      const bpm = Number($<HTMLInputElement>('synth-bpm').value) || 100;
      const detune = Number($<HTMLInputElement>('synth-detune').value) || 0;
      const sloppy = $<HTMLInputElement>('synth-sloppy').checked;
      const sr = 48000;
      const samples = synthMelody(mel.notes, {
        bpm,
        detuneCents: detune,
        sampleRate: sr,
        harmonics: [1, 0.6, 0.35, 0.2],
        vibratoCents: sloppy ? 35 : 15,
        ...(sloppy ? { scoopCents: -150, scoopSec: 0.09, timingJitterSec: 0.035, pitchErrorCents: 20, gapSec: 0.02, noise: 0.006 } : {}),
        seed: Math.floor(Math.random() * 1000) + 1,
      });
      void ingest(samples, sr, `Synth ${melSel.value} ${bpm}bpm ${detune}c${sloppy ? ' sloppy' : ''}`);
    });
    const barsOf = (chords: number[][], strikes: number[], len: number): InstrumentEvent[] =>
      chords.flatMap((midis, bar) => strikes.map((s) => ({ midis, at: bar * 4 + s, beats: len })));
    $<HTMLButtonElement>('synth-piano').addEventListener('click', () => {
      const bpm = Number($<HTMLInputElement>('synth-bpm').value) || 100;
      const detune = Number($<HTMLInputElement>('synth-detune').value) || 0;
      const prog = [[48, 60, 64, 67], [45, 60, 64, 69], [41, 60, 65, 69], [43, 59, 62, 67], [48, 60, 64, 67]];
      const samples = synthInstrument(barsOf(prog, [0, 2], 2), { bpm, detuneCents: detune, sampleRate: 48000 });
      void ingest(samples, 48000, `Synth piano C-Am-F-G ${bpm}bpm`);
    });
    $<HTMLButtonElement>('synth-guitar').addEventListener('click', () => {
      const bpm = Number($<HTMLInputElement>('synth-bpm').value) || 92;
      const detune = Number($<HTMLInputElement>('synth-detune').value) || 0;
      const prog = [[50, 57, 62, 65], [45, 52, 55, 61, 64], [43, 50, 55, 58, 62], [45, 52, 55, 61, 64], [50, 57, 62, 65]];
      const samples = synthInstrument(barsOf(prog, [0, 1, 2, 3], 1), {
        bpm,
        detuneCents: detune,
        sampleRate: 48000,
        strumSec: 0.012,
        decaySec: 0.9,
        inharmonicity: 0.00005,
      });
      void ingest(samples, 48000, `Synth guitar Dm-A7-Gm ${bpm}bpm`);
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && player.playing) stopPlayback();
  });

  render();
  void refreshList();
}
