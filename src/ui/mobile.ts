/**
 * Minimal phone page: press the big button, sing, stop. You get key, tempo,
 * your pitch line over the notes it was heard as, and floaty keys playing
 * chords that follow the melody. Chords can be spiced up, or changed one by
 * one (tap = pick, swipe up/down = try the next best); the key can be fixed.
 *
 * Shares takes (IndexedDB), analysis and playback with the DAW page.
 */

import { analyzeInWorker } from '../analysis/client';
import { liveGuess, newLiveState } from '../analysis/live';
import { hzToMidi, keyName, noteName, scalePitchClasses } from '../analysis/music';
import { fitGridAtBpm, onsetsFromNotes } from '../analysis/tempo';
import type { Note } from '../analysis/types';
import { micPermissionGranted, Recorder } from '../audio/recorder';
import { effectiveAnalysis, effectiveSettings, newId, type Settings, type StoredRecording } from '../model';
import { chordChoices, CHROMA_LEVELS, flavours, prefersSharps, SPICE_LEVELS, type Chord, type ChordChoice } from '../music/arrange';
import { takeChords } from '../music/progression';
import type { Mode } from '../analysis/types';
import { velocityOf } from '../analysis/velocity';
import { deleteRecording, listRecordings, loadRecording, saveRecording } from '../storage/db';
import { Player } from './player';

/** Height of the chord-name band along the top of the melody (a touch target). */
const HEAD = 44;

type View = 'idle' | 'recording' | 'analyzing' | 'result';

const ICON = {
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 8h9M19 8h1M4 16h1M11 16h9"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/></svg>',
  loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>',
};

const TEMPLATE = `
<div class="m" id="m">
  <header class="m-top">
    <button class="m-icon" id="m-takes" aria-label="Takes">${ICON.list}</button>
    <span class="m-title" id="m-title"></span>
    <button class="m-icon" id="m-adv" aria-label="More controls" aria-pressed="false">${ICON.more}</button>
  </header>

  <section class="m-stage" id="m-stage">
    <div class="m-stage-top"><canvas class="m-roll" id="m-roll"></canvas></div>
    <button class="m-rec" id="m-rec" aria-label="Record"><span></span></button>
    <div class="m-stage-bot">
      <div class="m-live" id="m-live"></div>
      <div class="m-timer" id="m-timer"></div>
      <p class="m-hint" id="m-hint">Sing</p>
    </div>
  </section>

  <section class="m-result" id="m-result" hidden>
    <div class="m-facts m-more">
      <button class="m-fact" id="m-key-fact" aria-label="Change the key"><b id="m-key">—</b><span id="m-mode">key</span></button>
      <button class="m-fact" id="m-bpm-fact" aria-label="Halve or double the tempo"><b id="m-bpm">—</b><span>bpm</span></button>
      <button class="m-fact m-enh" id="m-enhance" aria-label="Enhance: slower, more careful analysis">✦</button>
      <a class="m-fact m-daw" href="./" aria-label="Open the full editor"><span>DAW</span></a>
    </div>
    <div class="m-melody-wrap">
      <canvas class="m-melody" id="m-melody"></canvas>
    </div>
    <div class="m-chords m-more" id="m-chords"></div>
    <div class="m-dials">
      <button class="m-dial" id="m-chroma" aria-label="Break out of the key"><b>♯</b><span class="m-pips" id="m-pips"></span></button>
      <button class="m-dial" id="m-spice" aria-label="Spice up the chords"><span class="m-peppers" id="m-peppers"></span></button>
    </div>
    <div class="m-toggles m-more">
      <button class="m-toggle" id="t-voice" aria-pressed="true">Voice</button>
      <button class="m-toggle" id="t-melody" aria-pressed="false">Melody</button>
      <button class="m-toggle" id="t-keys" aria-pressed="true">Keys</button>
    </div>
    <div class="m-controls">
      <button class="m-side rec" id="m-new" aria-label="Record a new idea"><span></span></button>
      <button class="m-play" id="m-play" aria-label="Play">${ICON.play}</button>
      <button class="m-side m-loop" id="t-loop" aria-label="Loop" aria-pressed="false">${ICON.loop}</button>
    </div>
  </section>

  <div class="m-sheet" id="m-sheet" hidden>
    <div class="m-sheet-panel"><div class="m-sheet-grip"></div><div id="m-list"></div></div>
  </div>
  <div class="m-sheet" id="m-picker" hidden>
    <div class="m-sheet-panel"><div class="m-sheet-grip"></div><div id="m-picker-body"></div></div>
  </div>
  <div class="m-sheet" id="m-keys" hidden>
    <div class="m-sheet-panel"><div class="m-sheet-grip"></div><div id="m-keys-body"></div></div>
  </div>
</div>`;

const fmt = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Notes that were heard outside the key and moved into it ("fit to key"):
 * where each was actually sung, and which shown note it became. Drawn dotted;
 * tapping one puts the note back there.
 */
function heardOutside(raw: Note[], shown: Note[], scale: Set<number> | null): { i: number; midi: number }[] {
  if (!scale) return [];
  const out: { i: number; midi: number }[] = [];
  for (const r of raw) {
    if (scale.has(((r.midi % 12) + 12) % 12)) continue;
    let best = -1;
    let most = 0;
    shown.forEach((e, i) => {
      const o = Math.min(r.start + r.duration, e.start + e.duration) - Math.max(r.start, e.start);
      if (o > most) {
        most = o;
        best = i;
      }
    });
    if (best >= 0 && shown[best].midi !== r.midi && Math.abs(shown[best].midi - r.midi) <= 2) out.push({ i: best, midi: r.midi });
  }
  return out;
}

export function mountMobile(root: HTMLElement): void {
  root.innerHTML = TEMPLATE;
  const $ = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`) as T;
  const stage = $<HTMLElement>('m-stage');
  const result = $<HTMLElement>('m-result');
  const recBtn = $<HTMLButtonElement>('m-rec');
  const live = $<HTMLDivElement>('m-live');
  const timer = $<HTMLDivElement>('m-timer');
  const hint = $<HTMLParagraphElement>('m-hint');
  const title = $<HTMLSpanElement>('m-title');
  const canvas = $<HTMLCanvasElement>('m-melody');
  const chordsEl = $<HTMLDivElement>('m-chords');
  const playBtn = $<HTMLButtonElement>('m-play');
  const sheet = $<HTMLDivElement>('m-sheet');
  const listEl = $<HTMLDivElement>('m-list');
  const toggles = {
    voice: $<HTMLButtonElement>('t-voice'),
    melody: $<HTMLButtonElement>('t-melody'),
    keys: $<HTMLButtonElement>('t-keys'),
    loop: $<HTMLButtonElement>('t-loop'),
  };

  const player = new Player();
  let view: View = 'idle';
  let current: StoredRecording | null = null;
  let chords: Chord[] = [];
  /** The melody as the chords and playback use it (interpreted, or hand-edited). */
  let shown: Note[] = [];
  let ghosts: { i: number; midi: number }[] = [];
  let drag: { i: number; y: number; from: number; midi: number; moved: boolean; ghost: number | null } | null = null;
  let cue = 0;
  let recStart = 0;
  let starting = false;
  /** The note whose name is shown for a moment (tapped or being dragged). */
  let tapInfo: { i: number; midi: number; until: number } | null = null;

  const on = (b: HTMLButtonElement): boolean => b.getAttribute('aria-pressed') === 'true';

  // "More": key, tempo, the chord chips and the part toggles stay hidden until asked for.
  const page = $<HTMLElement>('m');
  const advBtn = $<HTMLButtonElement>('m-adv');
  function setMore(show: boolean): void {
    page.classList.toggle('adv', show);
    advBtn.setAttribute('aria-pressed', String(show));
    try {
      localStorage.setItem('hum-more', show ? '1' : '');
    } catch {
      // Private mode: just not remembered.
    }
    requestAnimationFrame(() => draw());
  }
  advBtn.addEventListener('click', () => setMore(!page.classList.contains('adv')));
  try {
    if (localStorage.getItem('hum-more')) setMore(true);
  } catch {
    // No storage: start simple.
  }

  // ---------- live pitch while recording ----------
  const roll = $<HTMLCanvasElement>('m-roll');
  const rollPts: { t: number; m: number }[] = [];
  let rollLo = 50;
  let rollHi = 70;
  function drawRoll(): void {
    const c = roll.getContext('2d');
    if (!c) return;
    const r = roll.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (roll.width !== Math.round(r.width * dpr) || roll.height !== Math.round(r.height * dpr)) {
      roll.width = Math.round(r.width * dpr);
      roll.height = Math.round(r.height * dpr);
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    if (view !== 'recording') return;
    const cs = getComputedStyle(root);
    const now = (performance.now() - recStart) / 1000;
    const win = 8; // seconds on screen, newest at the right
    while (rollPts.length && rollPts[0].t < now - win - 1) rollPts.shift();
    // The pitch range follows what is being sung, easing so the rows don't jump.
    if (rollPts.length) {
      let lo = Math.min(...rollPts.map((p) => p.m)) - 3;
      let hi = Math.max(...rollPts.map((p) => p.m)) + 3;
      while (hi - lo < 16) {
        lo -= 0.5;
        hi += 0.5;
      }
      rollLo += (lo - rollLo) * 0.08;
      rollHi += (hi - rollHi) * 0.08;
    }
    const W = r.width;
    const H = r.height;
    const head = W - 28;
    const x = (t: number): number => head - ((now - t) / win) * head;
    const y = (m: number): number => 10 + ((rollHi - m) / (rollHi - rollLo)) * (H - 20);
    c.font = '10px system-ui, sans-serif';
    c.textBaseline = 'middle';
    for (let m = Math.ceil(rollLo); m <= rollHi; m++) {
      const isC = ((m % 12) + 12) % 12 === 0;
      c.fillStyle = cs.getPropertyValue('--faint').trim();
      c.fillRect(0, Math.round(y(m)), W, isC ? 2 : 1);
      if (isC) {
        c.fillStyle = cs.getPropertyValue('--muted').trim();
        c.fillText(noteName(m), W - 22, y(m) - 8);
      }
    }
    c.strokeStyle = cs.getPropertyValue('--fg').trim();
    c.lineWidth = 3;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.beginPath();
    let prev: { t: number; m: number } | null = null;
    for (const p of rollPts) {
      if (prev && p.t - prev.t < 0.25 && Math.abs(p.m - prev.m) < 2.5) c.lineTo(x(p.t), y(p.m));
      else {
        c.moveTo(x(p.t), y(p.m));
        c.lineTo(x(p.t) + 0.1, y(p.m));
      }
      prev = p;
    }
    c.stroke();
    if (prev && now - prev.t < 0.25) {
      c.fillStyle = cs.getPropertyValue('--accent').trim();
      c.beginPath();
      c.arc(x(prev.t), y(prev.m), 5, 0, Math.PI * 2);
      c.fill();
    }
    requestAnimationFrame(drawRoll);
  }

  function setView(v: View): void {
    view = v;
    stage.hidden = v === 'result';
    result.hidden = v !== 'result';
    recBtn.classList.toggle('on', v === 'recording');
    recBtn.hidden = v === 'analyzing';
    recBtn.setAttribute('aria-label', v === 'recording' ? 'Stop' : 'Record');
    if (v === 'analyzing') {
      live.innerHTML = '<div class="m-bar"><i id="m-bar-fill"></i></div>';
      timer.textContent = '';
    }
    if (v === 'idle') {
      live.textContent = '';
      timer.textContent = '';
      hint.textContent = 'Sing';
      title.textContent = '';
    }
    if (v === 'recording') hint.textContent = '';
  }

  // ---------- recording ----------
  const recorder = new Recorder({
    onLevel: (peak) => recBtn.style.setProperty('--lvl', String(1 + Math.min(0.45, peak * 1.6))),
  });
  void micPermissionGranted().then((ok) => {
    if (ok) void recorder.warm().catch(() => undefined);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !recorder.isRecording) recorder.release();
  });

  const liveState = newLiveState();
  setInterval(() => {
    if (view === 'recording') {
      timer.textContent = fmt((performance.now() - recStart) / 1000);
      const spec = recorder.readSpectrum();
      if (!spec) return;
      const g = liveGuess(spec.mags, spec.sampleRate, spec.fftSize, spec.rms, liveState);
      if (g.kind === 'none') live.textContent = '';
      else live.innerHTML = g.label;
      if (g.kind === 'note' && g.notes.length) rollPts.push({ t: (performance.now() - recStart) / 1000, m: g.notes[0] + (g.cents ?? 0) / 100 });
    }
  }, 100);

  async function toggleRecord(): Promise<void> {
    if (starting || view === 'analyzing') return;
    if (!recorder.isRecording) {
      starting = true;
      stopPlayback();
      setView('recording');
      recStart = performance.now();
      rollPts.length = 0;
      requestAnimationFrame(drawRoll);
      try {
        const warm = recorder.isWarm;
        await recorder.start();
        if (!warm) recStart = performance.now();
      } catch (e) {
        setView('idle');
        hint.textContent = `Microphone: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        starting = false;
      }
      return;
    }
    const { samples, sampleRate } = await recorder.stop();
    if (samples.length < sampleRate * 0.6) {
      setView('idle');
      hint.textContent = 'Too short';
      return;
    }
    const d = new Date();
    current = {
      id: newId(),
      name: `Idea ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
      createdAt: Date.now(),
      sampleRate,
      samples,
      analysis: null,
      overrides: {},
    };
    await saveRecording(current).catch(() => undefined);
    await analyze('normal');
  }
  recBtn.addEventListener('click', () => void toggleRecord());
  $<HTMLButtonElement>('m-new').addEventListener('click', () => {
    setView('idle');
    void toggleRecord();
  });

  async function analyze(quality: 'normal' | 'high'): Promise<void> {
    const rec = current;
    if (!rec) return;
    setView('analyzing');
    // Progress follows the real analysis stages; within a stage the bar eases toward that stage's end.
    const STAGES: [match: string, word: string, upTo: number][] = [
      ['Loading', '', 0.12],
      ['pitch', 'pitch', 0.55],
      ['Key', 'key', 0.68],
      ['Rhythm', 'tempo', 0.82],
      ['Notes', 'notes', 0.96],
      ['High quality', 'notes', 0.96],
    ];
    const fill = live.querySelector<HTMLElement>('#m-bar-fill');
    let upTo = 0.12;
    let at = 0;
    hint.textContent = '';
    const tick = setInterval(() => {
      at += (upTo - at) * 0.06;
      if (fill) fill.style.width = `${(at * 100).toFixed(1)}%`;
    }, 50);
    const onStage = (stage: string): void => {
      const s = STAGES.find(([m]) => stage.includes(m));
      if (!s) return;
      at = Math.max(at, upTo * 0.9); // the stage before is done
      upTo = Math.max(upTo, s[2]);
      hint.textContent = s[1];
    };
    try {
      rec.analysis = await analyzeInWorker(rec.samples, rec.sampleRate, 'auto', onStage, rec.source ?? 'auto', quality);
      delete rec.editedNotes;
      await saveRecording(rec, false).catch(() => undefined);
      cue = 0;
      player.seek(0);
      setView('result');
      render();
    } catch (e) {
      setView('idle');
      hint.textContent = `Couldn't analyse: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      clearInterval(tick);
    }
  }
  $<HTMLButtonElement>('m-enhance').addEventListener('click', () => void analyze('high'));

  // ---------- result ----------
  function settings(): Settings | null {
    return current ? effectiveSettings(effectiveAnalysis(current), current.overrides) : null;
  }

  function computeChords(s: Settings): Chord[] {
    return current ? takeChords(current, s, { chordsPerBar: 'auto', floaty: true }) : [];
  }

  /**
   * The section that loops: whole bars on the take's grid, from the bar line
   * under the first sung note to the bar line after the last one. A phrase that
   * stops mid-bar gets the rest of that bar as silence (it may run past the end
   * of the recording), so the loop always comes round in time.
   */
  function loopSpan(): [number, number] | null {
    const s = settings();
    if (!s || shown.length === 0) return null;
    const beat = 60 / s.bpm;
    const bar = 4 * beat;
    const first = Math.min(...shown.map((n) => n.start));
    const last = Math.max(...shown.map((n) => n.start + n.duration));
    const fb = s.firstBeatMs / 1000;
    // A note a hair before or after a bar line still belongs to that bar.
    let start = fb + Math.floor((first + 0.25 * beat - fb) / bar) * bar;
    if (start < 0) start += bar * Math.ceil(-start / bar - 1e-9);
    const bars = Math.max(1, Math.ceil((last - 0.25 * beat - start) / bar));
    return [start, start + bars * bar];
  }

  /** Visible time span: the sung part with a little air, and the whole loop section. */
  function span(): [number, number] {
    const dur = current ? current.samples.length / current.sampleRate : 1;
    if (!current?.analysis || shown.length === 0) return [0, dur];
    const first = Math.min(...shown.map((n) => n.start));
    const last = Math.max(...shown.map((n) => n.start + n.duration));
    const lp = loopSpan();
    return [Math.max(0, Math.min(first - 0.35, lp ? lp[0] - 0.1 : Infinity)), Math.max(Math.min(dur, last + 0.5), lp ? lp[1] + 0.1 : 0)];
  }

  function render(): void {
    const rec = current;
    const s = settings();
    if (!rec || !s || !rec.analysis) return;
    title.textContent = rec.name + (rec.analysis.quality === 'high' ? ' ✦' : '');
    const [tonic, mode] = s.key ? [s.key.name.split(' ')[0], s.key.name.split(' ')[1] ?? ''] : ['—', 'key'];
    $<HTMLElement>('m-key').textContent = tonic;
    $<HTMLElement>('m-mode').textContent = mode;
    $<HTMLElement>('m-bpm').textContent = String(Math.round(s.bpm));
    const level = current?.spice ?? 0;
    $<HTMLElement>('m-spice').setAttribute('aria-label', `Chord spice: ${SPICE_LEVELS[level]}`);
    $<HTMLElement>('m-peppers').innerHTML = [1, 2, 3].map((k) => `<i class="${k <= level ? 'hot' : ''}"></i>`).join('');
    const chroma = current?.chroma ?? 0;
    $<HTMLElement>('m-chroma').setAttribute('aria-label', `Break out of the key: ${CHROMA_LEVELS[chroma]}`);
    $<HTMLElement>('m-pips').innerHTML = [1, 2, 3].map((k) => `<i class="${k <= chroma ? 'hot' : ''}"></i>`).join('');
    chords = computeChords(s);
    shown =effectiveAnalysis(rec)?.notes ?? [];
    ghosts = heardOutside(rec.analysis.notes, shown, s.key ? scalePitchClasses(s.key.tonic, s.key.mode) : null);
    const edits = rec.chordEdits ?? {};
    chordsEl.innerHTML = chords
      .map((c, i) => `<button class="m-chord${c.slot && edits[c.slot] ? ' edited' : ''}" data-i="${i}" style="--h:${hue(c.root)}">${c.name}</button>`)
      .join('');
    draw();
  }

  /**
   * A chord's colour: hue steps round the circle of fifths from the key's tonic,
   * so chords close to home look alike and far-out ones stand out.
   */
  function hue(root: number): number {
    const tonic = settings()?.key?.tonic ?? 0;
    return (265 + ((((root - tonic) * 7) % 12) + 12) % 12 * 30) % 360;
  }

  // ---------- chords: chromatic, spice, pick, swipe ----------
  $<HTMLButtonElement>('m-chroma').addEventListener('click', () => {
    if (!current) return;
    current.chroma = ((current.chroma ?? 0) + 1) % CHROMA_LEVELS.length;
    refresh();
  });

  function save(): void {
    if (current) void saveRecording(current, false).catch(() => undefined);
  }
  function refresh(): void {
    save();
    render();
    if (player.playing) void startPlayback(player.position);
  }

  $<HTMLButtonElement>('m-spice').addEventListener('click', () => {
    if (!current) return;
    current.spice = ((current.spice ?? 0) + 1) % SPICE_LEVELS.length;
    refresh();
    const first = chords[0];
    const s = settings();
    if (first && s && !player.playing) void player.previewChord(first.voicing, first.bass, on(toggles.voice) ? s.tuningCents : 0);
  });

  /** Best chords for a slot (fit to the melody there), with the current one marked. */
  function choicesFor(c: Chord): ChordChoice[] {
    const s = settings();
    const eff = current ? effectiveAnalysis(current) : null;
    if (!s?.key || !eff) return [];
    return chordChoices(eff.notes, s.key, c.start, c.start + c.duration);
  }

  function setChord(i: number, root: number, quality: Chord['quality'] | null): void {
    const c = chords[i];
    if (!current || !c?.slot) return;
    const edits = (current.chordEdits ??= {});
    if (quality === null) delete edits[c.slot];
    else edits[c.slot] = { root, quality };
    refresh();
    const now = chords[i];
    const s = settings();
    if (now && s && !player.playing) void player.previewChord(now.voicing, now.bass, on(toggles.voice) ? s.tuningCents : 0);
  }

  const picker = $<HTMLDivElement>('m-picker');
  const pickerBody = $<HTMLDivElement>('m-picker-body');
  function openPicker(i: number): void {
    const c = chords[i];
    const s = settings();
    if (!c || !s) return;
    const bar = Math.floor((c.start - s.firstBeatMs / 1000) / ((4 * 60) / s.bpm)) + 1;
    const choices = choicesFor(c);
    const edited = !!(c.slot && current?.chordEdits?.[c.slot]);
    const chip = (x: ChordChoice, cls = ''): string =>
      `<button class="m-pick${x.root === c.root && x.quality === c.quality ? ' cur' : ''} ${cls}" data-root="${x.root}" data-q="${x.quality}"><b>${x.name}</b>${x.numeral ? `<span>${x.numeral}</span>` : ''}</button>`;
    pickerBody.innerHTML = `
      <div class="m-sheet-title"><b>${c.name}</b><span>bar ${Math.max(1, bar)}</span>${edited ? '<button class="m-link" data-auto>Auto</button>' : ''}</div>
      <div class="m-sub">Fits</div>
      <div class="m-picks">${choices.slice(0, 8).map((x) => chip(x)).join('')}</div>
      <div class="m-sub">Flavour</div>
      <div class="m-picks">${flavours(c.root, c.quality, prefersSharps(s.key)).map((x) => chip(x, 'flav')).join('')}</div>`;
    pickerBody.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-auto]')) {
        setChord(i, c.root, null);
        openPicker(i);
        return;
      }
      const b = t.closest<HTMLButtonElement>('.m-pick');
      if (!b) return;
      setChord(i, Number(b.dataset.root), b.dataset.q as Chord['quality']);
      openPicker(i);
    };
    picker.hidden = false;
  }
  picker.addEventListener('click', (e) => {
    if (e.target === picker) picker.hidden = true;
  });

  // Tap a chord = pick it; swipe it up / down = the next / previous best fit.
  let swipe: { i: number; x: number; y: number; moved: boolean } | null = null;
  chordsEl.addEventListener('pointerdown', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.m-chord');
    if (!b) return;
    swipe = { i: Number(b.dataset.i), x: e.clientX, y: e.clientY, moved: false };
  });
  chordsEl.addEventListener('pointermove', (e) => {
    if (!swipe || swipe.moved) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
      swipe = null; // horizontal: the row scrolls
      return;
    }
    if (Math.abs(dy) < 22) return;
    swipe.moved = true;
    const c = chords[swipe.i];
    const list = c ? choicesFor(c) : [];
    if (!c || !list.length) return;
    const exact = list.findIndex((x) => x.root === c.root && x.quality === c.quality);
    const at = exact >= 0 ? exact : list.findIndex((x) => x.root === c.root);
    const next = list[(Math.max(0, at) + (dy < 0 ? 1 : list.length - 1)) % list.length];
    setChord(swipe.i, next.root, next.quality);
    const el = chordsEl.querySelector<HTMLElement>(`.m-chord[data-i="${swipe.i}"]`);
    el?.classList.add(dy < 0 ? 'bump-up' : 'bump-down');
  });
  chordsEl.addEventListener('pointerup', () => {
    if (swipe && !swipe.moved) openPicker(swipe.i);
    swipe = null;
  });
  chordsEl.addEventListener('pointercancel', () => (swipe = null));

  // ---------- key ----------
  const keysSheet = $<HTMLDivElement>('m-keys');
  const keysBody = $<HTMLDivElement>('m-keys-body');
  function openKeys(): void {
    const a = current?.analysis;
    const s = settings();
    if (!a || !s) return;
    const detected = a.key.chosen;
    const cur = s.key ? `${s.key.tonic}:${s.key.mode}` : '';
    const seen = new Set<string>();
    const guesses = [...(a.key.fromNotes?.candidates ?? []), ...(a.key.fromAudio ? [a.key.fromAudio] : [])].filter((k) => {
      const id = `${k.tonic}:${k.mode}`;
      if (seen.has(id) || (detected && id === `${detected.tonic}:${detected.mode}`)) return false;
      seen.add(id);
      return true;
    });
    const btn = (t: number, m: Mode, label = keyName(t, m)): string =>
      `<button class="m-pick${cur === `${t}:${m}` ? ' cur' : ''}" data-t="${t}" data-m="${m}"><b>${label}</b></button>`;
    const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    keysBody.innerHTML = `
      <div class="m-sheet-title"><b>Key</b>${current?.overrides.keyTonic !== undefined ? '<button class="m-link" data-auto>Auto</button>' : ''}</div>
      <div class="m-sub">Heard</div>
      <div class="m-picks">${detected ? btn(detected.tonic, detected.mode) : ''}${guesses.slice(0, 4).map((k) => btn(k.tonic, k.mode)).join('')}</div>
      <div class="m-sub">Major</div>
      <div class="m-picks grid">${names.map((n, t) => btn(t, 'major', n)).join('')}</div>
      <div class="m-sub">Minor</div>
      <div class="m-picks grid">${names.map((n, t) => btn(t, 'minor', n + 'm')).join('')}</div>`;
    keysSheet.hidden = false;
  }
  keysBody.addEventListener('click', (e) => {
    if (!current) return;
    const t = e.target as HTMLElement;
    const o = current.overrides;
    if (t.closest('[data-auto]')) {
      delete o.keyTonic;
      delete o.keyMode;
    } else {
      const b = t.closest<HTMLButtonElement>('.m-pick');
      if (!b) return;
      o.keyTonic = Number(b.dataset.t);
      o.keyMode = b.dataset.m === 'minor' ? 'minor' : 'major';
    }
    delete current.chordEdits;
    refresh();
    openKeys();
  });
  keysSheet.addEventListener('click', (e) => {
    if (e.target === keysSheet) keysSheet.hidden = true;
  });
  $<HTMLButtonElement>('m-key-fact').addEventListener('click', openKeys);

  function setBpm(factor: number): void {
    const s = settings();
    if (!current || !s) return;
    const bpm = Math.max(30, Math.min(300, s.bpm * factor));
    const o = current.overrides;
    o.bpm = bpm;
    if (o.firstBeatMs === undefined || o.firstBeatAuto) {
      const fb = fitGridAtBpm(onsetsFromNotes(current.analysis?.notes ?? []), bpm);
      if (fb !== null) {
        o.firstBeatMs = Math.round(fb * 1000);
        o.firstBeatAuto = true;
      }
    }
    void saveRecording(current, false).catch(() => undefined);
    render();
    if (player.playing) void startPlayback(player.position);
  }
  $<HTMLButtonElement>('m-bpm-fact').addEventListener('click', () => {
    const s = settings();
    if (s) setBpm(s.bpm >= 120 ? 0.5 : 2);
  });

  for (const b of Object.values(toggles)) {
    b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', String(!on(b)));
      if (player.playing) void startPlayback(player.position);
      else draw();
    });
  }

  // ---------- melody canvas ----------
  function colors(): Record<string, string> {
    const cs = getComputedStyle(root);
    const v = (n: string): string => cs.getPropertyValue(n).trim();
    return { fg: v('--fg'), muted: v('--muted'), faint: v('--faint'), accent: v('--accent'), note: v('--note'), line: v('--line') };
  }

  function geometry(): { W: number; H: number; x: (t: number) => number; t: (x: number) => number; y: (m: number) => number; lo: number; hi: number; top: number } {
    const r = canvas.getBoundingClientRect();
    const W = r.width;
    const H = r.height;
    const [t0, t1] = span();
    const notes = [...(current?.analysis?.notes ?? []), ...shown];
    let lo = Math.min(...notes.map((n) => n.midi), 60) - 2;
    let hi = Math.max(...notes.map((n) => n.midi), 60) + 2;
    if (notes.length) {
      lo = Math.min(...notes.map((n) => n.midi)) - 2;
      hi = Math.max(...notes.map((n) => n.midi)) + 2;
    }
    while (hi - lo < 20) {
      lo--;
      hi++;
    }
    const top = HEAD + 8;
    const bottom = 30;
    const padX = 14;
    const x = (t: number): number => padX + ((t - t0) / (t1 - t0)) * (W - 2 * padX);
    const tAt = (px: number): number => t0 + ((px - padX) / (W - 2 * padX)) * (t1 - t0);
    const y = (m: number): number => top + ((hi - m) / (hi - lo)) * (H - top - bottom);
    return { W, H, x, t: tAt, y, lo, hi, top };
  }

  function draw(): void {
    const rec = current;
    const a = rec?.analysis;
    const s = settings();
    const c = canvas.getContext('2d');
    if (!rec || !a || !s || !c) return;
    const dpr = window.devicePixelRatio || 1;
    const g = geometry();
    if (canvas.width !== Math.round(g.W * dpr) || canvas.height !== Math.round(g.H * dpr)) {
      canvas.width = Math.round(g.W * dpr);
      canvas.height = Math.round(g.H * dpr);
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, g.W, g.H);
    const col = colors();
    const scale = s.key ? scalePitchClasses(s.key.tonic, s.key.mode) : null;

    // Key rows: faint lines on scale notes, labelled tonics.
    c.font = '10px system-ui, sans-serif';
    c.textBaseline = 'middle';
    for (let m = Math.ceil(g.lo); m <= g.hi; m++) {
      const pc = ((m % 12) + 12) % 12;
      if (scale && !scale.has(pc)) continue;
      const yy = Math.round(g.y(m)) + 0.5;
      const tonic = s.key && pc === s.key.tonic;
      c.strokeStyle = col.faint;
      c.lineWidth = tonic ? 2 : 1;
      c.beginPath();
      c.moveTo(0, yy);
      c.lineTo(g.W, yy);
      c.stroke();
      if (tonic) {
        c.fillStyle = col.muted;
        c.fillText(noteName(m), g.W - 26, yy - 7);
      }
    }

    // Chords: a faint line at each change (names live on the chips below); the one sounding now is lit.
    // Each chord's stretch is washed in its colour; the one sounding now is brighter.
    const pos = player.playing ? player.position : -1;
    for (const ch of chords) {
      const xx = g.x(ch.start);
      const w = g.x(ch.start + ch.duration) - xx;
      if (xx > g.W || xx + w < 0) continue;
      const now = pos >= ch.start && pos < ch.start + ch.duration;
      c.fillStyle = `hsl(${hue(ch.root)} 55% 60% / ${now ? 0.2 : 0.07})`;
      c.fillRect(xx, 0, w, g.H);
      c.fillStyle = col.faint;
      c.fillRect(Math.round(xx), 0, 1, g.H);
      c.font = '600 14px system-ui, sans-serif';
      c.fillStyle = `hsl(${hue(ch.root)} 80% 84%)`;
      c.fillText(ch.name, Math.max(6, xx + 7), HEAD / 2, Math.max(12, w - 10));
    }

    // Notes as soft pills: the melody the chords follow. Dotted = where a note was
    // heard before it was pulled into the key (tap it to put the note there).
    const rowH = Math.max(8, Math.min(18, (g.y(g.lo) - g.y(g.lo + 1)) * 0.95));
    c.lineWidth = 1.5;
    shown.forEach((n, i) => {
      const x0 = g.x(n.start);
      const w = Math.max(rowH, g.x(n.start + n.duration) - x0);
      const held = drag?.moved && drag.i === i;
      const yy = g.y(held && drag ? drag.midi : n.midi);
      // A note takes the colour of the chord it sits in.
      const mid = n.start + n.duration / 2;
      const under = chords.find((ch) => mid >= ch.start && mid < ch.start + ch.duration);
      const tone = under ? `hsl(${hue(under.root)} 70% 72%)` : col.note;
      c.strokeStyle = tone;
      c.fillStyle = tone;
      c.globalAlpha = held ? 0.95 : 0.7;
      pill(c, x0 + 1, yy - rowH / 2 + 1, w - 2, rowH - 2);
      c.fill();
      const gh = held ? undefined : ghosts.find((x) => x.i === i);
      if (gh) {
        c.globalAlpha = 0.6;
        c.setLineDash([3, 3]);
        pill(c, x0 + 1, g.y(gh.midi) - rowH / 2 + 1, w - 2, rowH - 2);
        c.stroke();
        c.setLineDash([]);
      }
      c.globalAlpha = 1;
    });

    // Your voice: the scribble on top of the notes.
    const tune = a.tuning.cents / 100;
    const tr = a.pitch;
    c.strokeStyle = col.line;
    c.lineWidth = 2;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.globalAlpha = 0.9;
    c.beginPath();
    let pen = false;
    let prevM = NaN;
    let prevX = NaN;
    // Smoothed over ~180 ms (about one vibrato cycle) so vibrato reads as where the pitch sits, not a scribble.
    const raw = Array.from(tr.f0Hz, (f, i) => (f > 0 && tr.confidence[i] >= 0.3 ? hzToMidi(f) - tune : NaN));
    const half = Math.max(1, Math.round(0.09 / tr.hopSec));
    for (let i = 0; i < raw.length; i++) {
      if (Number.isNaN(raw[i])) {
        pen = false;
        continue;
      }
      let sum = 0;
      let k = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(raw.length - 1, i + half); j++) {
        if (Number.isNaN(raw[j]) || Math.abs(raw[j] - raw[i]) > 1) continue;
        sum += raw[j];
        k++;
      }
      const m = sum / k;
      const xx = g.x(tr.times[i]);
      if (m < g.lo - 1 || m > g.hi + 1) {
        pen = false;
        continue;
      }
      if (pen && Math.abs(m - prevM) < 1.5 && xx - prevX < 8) c.lineTo(xx, g.y(m));
      else c.moveTo(xx, g.y(m));
      pen = true;
      prevM = m;
      prevX = xx;
    }
    c.stroke();
    c.globalAlpha = 1;

    // Loop on: what lies outside the looped bars is dimmed.
    const lp = on(toggles.loop) ? loopSpan() : null;
    if (lp) {
      c.fillStyle = getComputedStyle(root).getPropertyValue('--bg').trim();
      c.globalAlpha = 0.6;
      c.fillRect(0, 0, Math.max(0, g.x(lp[0])), g.H);
      c.fillRect(g.x(lp[1]), 0, Math.max(0, g.W - g.x(lp[1])), g.H);
      c.globalAlpha = 1;
    }

    // Start marker + playhead.
    const xc = g.x(cue);
    c.fillStyle = col.muted;
    c.beginPath();
    c.moveTo(xc - 5, g.H - 26);
    c.lineTo(xc + 5, g.H - 26);
    c.lineTo(xc, g.H - 32);
    c.closePath();
    c.fill();
    if (player.playing) {
      const xp = g.x(player.position);
      c.strokeStyle = col.accent;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(xp, HEAD);
      c.lineTo(xp, g.H - 26);
      c.stroke();
    }

    // What you tapped: the note's name.
    const named = tapInfo && performance.now() < tapInfo.until ? shown[tapInfo.i] : undefined;
    if (tapInfo && named) {
      c.font = '600 12px system-ui, sans-serif';
      c.fillStyle = col.fg;
      c.textAlign = 'center';
      const nx = (g.x(named.start) + Math.max(g.x(named.start) + rowH, g.x(named.start + named.duration))) / 2;
      c.fillText(noteName(tapInfo.midi), Math.max(16, Math.min(g.W - 16, nx)), g.y(tapInfo.midi) - rowH / 2 - 9);
      c.textAlign = 'start';
    }
  }

  /** Change one note's pitch by hand. The key is held where it was, and the chords re-fit. */
  function setNote(i: number, midi: number): void {
    const s = settings();
    if (!current || !s) return;
    if (!current.editedNotes) {
      const o = current.overrides;
      if (o.keyTonic === undefined && s.key) {
        o.keyTonic = s.key.tonic;
        o.keyMode = s.key.mode;
      }
      current.editedNotes = shown.map((n) => ({ ...n }));
    }
    const n = current.editedNotes[i];
    if (!n) return;
    current.editedNotes[i] = { ...n, midi, cents: 0 };
    refresh();
  }
  /**
   * Swap a chord for the next one that makes sense under that stretch of melody:
   * the best fits first (relative minor / major, subdominant, dominant, then
   * borrowed colours), round and round back to where it started.
   */
  function nextChord(ci: number): void {
    const c = chords[ci];
    const list = c ? choicesFor(c).slice(0, 6) : [];
    if (!c || list.length < 2) return;
    const exact = list.findIndex((x) => x.root === c.root && x.quality === c.quality);
    const at = exact >= 0 ? exact : list.findIndex((x) => x.root === c.root);
    const next = list[(at + 1) % list.length];
    setChord(ci, next.root, next.quality);
  }
  function hear(i: number, midi: number): void {
    const s = settings();
    tapInfo = { i, midi, until: performance.now() + 2500 };
    setTimeout(draw, 2600);
    if (s && !player.playing) void player.preview(midi, on(toggles.voice) ? s.tuningCents : 0);
  }

  // Tap a note = start there. Drag it up / down = change its pitch. Tap a dotted one = move the note there.
  canvas.addEventListener('pointerdown', (e) => {
    if (!current?.analysis) return;
    const r = canvas.getBoundingClientRect();
    const g = geometry();
    const t = g.t(e.clientX - r.left);
    const y = e.clientY - r.top;
    if (y < HEAD) {
      const ci = chords.findIndex((ch) => t >= ch.start && t < ch.start + ch.duration);
      if (ci >= 0) nextChord(ci);
      return;
    }
    const i = shown.findIndex((nn) => t >= nn.start - 0.05 && t <= nn.start + nn.duration + 0.05);
    if (i < 0) {
      setCue(Math.max(0, t));
      return;
    }
    const gh = ghosts.find((x) => x.i === i);
    const onGhost = !!gh && Math.abs(y - g.y(gh.midi)) < Math.abs(y - g.y(shown[i].midi));
    drag = { i, y: e.clientY, from: shown[i].midi, midi: shown[i].midi, moved: false, ghost: gh && onGhost ? gh.midi : null };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // No capture (synthetic pointer): the drag still works while it stays on the canvas.
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (!drag.moved && Math.abs(dy) < 10) return;
    drag.moved = true;
    const g = geometry();
    const row = g.y(0) - g.y(1);
    const m = Math.max(Math.ceil(g.lo), Math.min(Math.floor(g.hi), drag.from + Math.round(dy / row)));
    if (m !== drag.midi) {
      drag.midi = m;
      hear(drag.i, m);
    }
    draw();
  });
  canvas.addEventListener('pointerup', () => {
    const d = drag;
    drag = null;
    const n = d ? shown[d.i] : undefined;
    if (!d || !n) return;
    if (d.moved) {
      if (d.midi !== d.from) setNote(d.i, d.midi);
      else draw();
    } else if (d.ghost !== null) {
      hear(d.i, d.ghost);
      setNote(d.i, d.ghost);
    } else {
      tapInfo = { i: d.i, midi: n.midi, until: performance.now() + 2500 };
      setTimeout(draw, 2600);
      setCue(Math.max(0, n.start));
    }
  });
  canvas.addEventListener('pointercancel', () => {
    drag = null;
    draw();
  });
  new ResizeObserver(() => draw()).observe(canvas);

  // ---------- playback ----------
  function setCue(t: number): void {
    cue = t;
    if (player.playing) void startPlayback(cue);
    else {
      player.seek(cue);
      draw();
    }
  }

  async function startPlayback(from: number): Promise<void> {
    const s = settings();
    if (!current || !s) return;
    const lp = on(toggles.loop) ? loopSpan() : null;
    const last = chords[chords.length - 1];
    const backing = lp && last && last.start + last.duration < lp[1] ? [...chords.slice(0, -1), { ...last, duration: lp[1] - last.start }] : chords;
    await player.play(current.samples, current.sampleRate, {
      from,
      click: false,
      voice: on(toggles.voice),
      bpm: s.bpm,
      firstBeatMs: s.firstBeatMs,
      beatsPerBar: 4,
      clickGain: 0,
      notes: on(toggles.melody)
        ? (effectiveAnalysis(current)?.notes ?? []).map((n) => ({ midi: n.midi, start: n.start, duration: n.duration, velocity: velocityOf(n) }))
        : [],
      notesTuningCents: on(toggles.voice) ? s.tuningCents : 0,
      notesGain: on(toggles.voice) ? 0.16 : 0.28,
      drums: [],
      chords: on(toggles.keys) ? backing : [],
      backingTuningCents: on(toggles.voice) ? s.tuningCents : 0,
      chordStyle: 'floaty',
      loop: lp ? { start: lp[0], end: lp[1] } : null,
    });
    playBtn.innerHTML = ICON.stop;
    playBtn.setAttribute('aria-label', 'Stop');
    follow();
  }
  function stopPlayback(): void {
    player.stop();
    player.seek(cue);
    playBtn.innerHTML = ICON.play;
    playBtn.setAttribute('aria-label', 'Play');
    draw();
  }
  player.onEnded = () => {
    player.seek(cue);
    playBtn.innerHTML = ICON.play;
    playBtn.setAttribute('aria-label', 'Play');
    draw();
  };
  function follow(): void {
    if (!player.playing) return;
    const p = player.position;
    let idx = -1;
    chords.forEach((c, i) => {
      if (p >= c.start && p < c.start + c.duration) idx = i;
    });
    chordsEl.querySelectorAll<HTMLElement>('.m-chord').forEach((el, i) => {
      const now = i === idx;
      if (now && !el.classList.contains('now')) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      el.classList.toggle('now', now);
    });
    draw();
    requestAnimationFrame(follow);
  }
  playBtn.addEventListener('click', () => {
    if (player.playing) stopPlayback();
    else {
      const [t0] = span();
      void startPlayback(Math.max(cue, t0 - 0.2));
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    if (view === 'result') playBtn.click();
    else recBtn.click();
  });

  // ---------- takes ----------
  async function openSheet(): Promise<void> {
    const takes = await listRecordings();
    listEl.innerHTML = takes.length ? '' : '<div class="m-empty">No ideas yet</div>';
    for (const m of takes) {
      const s = effectiveSettings(m.analysis, m.overrides);
      const row = document.createElement('div');
      row.className = 'm-take' + (m.id === current?.id ? ' cur' : '');
      const main = document.createElement('button');
      main.className = 'm-take-main';
      const b = document.createElement('b');
      b.textContent = m.name;
      const meta = document.createElement('span');
      meta.textContent = m.analysis ? `${s.key?.name ?? '—'} · ${Math.round(s.bpm)} · ${fmt(m.durationSec)}` : fmt(m.durationSec);
      main.append(b, meta);
      main.addEventListener('click', () => void open(m.id));
      const del = document.createElement('button');
      del.className = 'm-take-del';
      del.textContent = '✕';
      del.setAttribute('aria-label', `Delete ${m.name}`);
      del.addEventListener('click', () => {
        if (!confirm(`Delete "${m.name}"? This can't be undone.`)) return;
        void deleteRecording(m.id).then(() => {
          if (current?.id === m.id) {
            stopPlayback();
            current = null;
            setView('idle');
          }
          return openSheet();
        });
      });
      row.append(main, del);
      listEl.appendChild(row);
    }
    sheet.hidden = false;
  }
  async function open(id: string): Promise<void> {
    sheet.hidden = true;
    stopPlayback();
    const rec = await loadRecording(id);
    if (!rec) return;
    current = rec;
    cue = 0;
    if (!rec.analysis) await analyze('normal');
    else {
      setView('result');
      render();
    }
  }
  $<HTMLButtonElement>('m-takes').addEventListener('click', () => void openSheet());
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.hidden = true;
  });

  setView('idle');
}

function pill(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = Math.min(h / 2, w / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
