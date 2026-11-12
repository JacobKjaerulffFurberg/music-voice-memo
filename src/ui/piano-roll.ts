/**
 * Always-on MIDI clip editor (Ableton-style) drawn on a canvas:
 * ruler (scrub), chord lane, piano-key gutter, notes over the raw f0 curve,
 * beat/sub-beat grid, marquee selection.
 *
 * Mouse / pen / touch
 *   click note            select (Shift: add/remove)       drag: move (time + pitch)
 *   drag note edges       resize start / end (all selected)
 *   Ctrl/⌘-drag note      duplicate selection
 *   double-click empty    add note (last used length)       double-click note: delete
 *   drag empty            marquee select (touch: pan)
 *   Alt while dragging    bypass grid snap
 *   loop strip (top)      drag = draw loop · drag loop = move · drag its edges = resize · double-click = on/off
 *   ruler                 click = start marker (Space plays from here), drag = scrub
 *   grid lane             drag bar 1 / empty = slide the grid · drag bar N = stretch tempo (bar 1 pinned)
 *   click empty space     start marker
 *   key gutter            audition a pitch
 *   Ctrl/⌘ + wheel        zoom around the pointer
 *
 * Keys (via handleKey)
 *   Delete/Backspace · ↑/↓ (Shift: octave) · ←/→ move by grid (Shift: change length)
 *   Ctrl+A select all · Ctrl+D duplicate · Ctrl+U quantize · Ctrl+C / Ctrl+V · Esc
 */

import { hzToMidi, noteName, scalePitchClasses } from '../analysis/music';
import type { AnalysisResult, Note } from '../analysis/types';
import { DEFAULT_VELOCITY, velocityOf } from '../analysis/velocity';
import { beatTimes, type Settings } from '../model';
import type { Chord } from '../music/arrange';

/** Loop strip (drag = draw / move / resize the loop, double-click = loop on/off). */
const LOOP_H = 11;
/** Bar ruler (click = start marker, drag = scrub). */
const RULER_Y = LOOP_H;
const RULER = 18;
/** Grid lane: drag bar 1 (or empty space) to slide the grid, drag another bar to stretch the tempo. */
const GRID_Y = RULER_Y + RULER;
const GRID_H = 15;
const HEAD = GRID_Y + GRID_H;
const CHORD_LANE = 18;
const SNAP_PX = 9;
const GUTTER = 38;
const ROW_MIN_PX = 10;
const EDGE_PX = 7;
const MIN_LEN = 0.03;
const DBL_MS = 320;

function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

interface Geometry {
  lo: number;
  hi: number;
  rowH: number;
  top: number; // y where the note area starts
  lane: number; // chord lane height
  H: number;
  pps: number;
}

type DragKind =
  | 'move'
  | 'resize-r'
  | 'resize-l'
  | 'marquee'
  | 'scrub'
  | 'pan'
  | 'loop-new'
  | 'loop-move'
  | 'loop-l'
  | 'loop-r'
  | 'grid-move'
  | 'grid-stretch';

export interface LoopRegion {
  start: number;
  end: number;
}

interface Drag {
  kind: DragKind;
  /** Pointer time at drag start. */
  t0?: number;
  loop0?: LoopRegion | null;
  /** Grid at drag start, and the beat line (index from bar 1) being dragged. */
  grid0?: { bpm: number; first: number; line: number; lineTime: number };
  x0: number;
  y0: number;
  anchor: Note | null;
  orig: Map<Note, Note>;
  changed: boolean;
  duplicate: boolean;
  dupDone: boolean;
  baseSelection: Set<Note>;
  scroll0: number;
  clientX0: number;
}

const BLACK = new Set([1, 3, 6, 8, 10]);

export class PianoRoll {
  readonly el: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private analysis: AnalysisResult | null = null;
  private settings: Settings | null = null;
  private notes: Note[] = [];
  private lastEmitted: Note[] | null = null;
  private selection = new Set<Note>();
  private clipboard: Note[] = [];
  private duration = 0;
  private playhead: number | null = null;
  private zoom = 1;
  private chords: Chord[] = [];
  private drag: Drag | null = null;
  private marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private lockedRange: [number, number] | null = null;
  private lastDown = { t: 0, x: 0, y: 0 };
  private lastLen = 0.25;
  private lastHint = '';

  /** Detected note starts in the audio (what the grid snaps to). */
  private onsets: number[] = [];
  /** Start marker: where Space starts playback (Ableton-style). */
  private cue = 0;
  private loop: LoopRegion | null = null;
  private loopOn = false;

  /** Subdivisions per beat for snapping (0 = off). */
  grid = 4;
  /** Start marker set (ruler click / click in empty space). */
  onSeek: ((sec: number) => void) | null = null;
  /** Loop region drawn / moved / toggled. `final` is false while dragging. */
  onLoopChange: ((loop: LoopRegion | null, on: boolean, final: boolean) => void) | null = null;
  /** Grid moved or stretched by dragging in the grid lane. `final` is false while dragging. */
  onGridChange: ((bpm: number, firstBeatMs: number, final: boolean) => void) | null = null;
  /** Short help for whatever is under the pointer. */
  onHint: ((text: string) => void) | null = null;
  /** Fired after every finished edit with the full (sorted) note list. */
  onNotesChange: ((notes: Note[]) => void) | null = null;
  onSelect: ((selected: Note[]) => void) | null = null;
  /** Audition a pitch. */
  onPreview: ((midi: number) => void) | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'roll';
    this.el.tabIndex = 0;
    this.scroller = document.createElement('div');
    this.scroller.className = 'roll-scroll';
    this.canvas = document.createElement('canvas');
    this.scroller.appendChild(this.canvas);
    this.el.appendChild(this.scroller);
    this.scroller.addEventListener('scroll', () => this.draw(), { passive: true });
    this.canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.pointerUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      if (this.drag) return;
      this.canvas.style.cursor = 'default';
      if (this.lastHint) {
        this.lastHint = '';
        this.onHint?.('');
      }
    });
    this.canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.layout()).observe(this.el);
  }

  // ------------------------------------------------------------ public API

  setData(analysis: AnalysisResult | null, settings: Settings | null, durationSec: number): void {
    this.analysis = analysis;
    this.settings = settings;
    this.duration = durationSec;
    const incoming = analysis?.notes ?? [];
    if (!this.drag && incoming !== this.lastEmitted) {
      this.notes = incoming.map((n) => ({ ...n }));
      this.lastEmitted = null;
      this.setSelection(new Set());
    }
    this.layout();
  }

  /** Chord symbols drawn in a lane under the ruler (call before setData/draw). */
  setChords(chords: Chord[]): void {
    this.chords = chords;
  }

  /** Onsets the grid handles snap to (the detected, un-quantized note starts). */
  setOnsets(times: number[]): void {
    this.onsets = times;
  }

  setCue(sec: number): void {
    this.cue = Math.max(0, sec);
    this.draw();
  }

  setLoop(loop: LoopRegion | null, on: boolean): void {
    if (this.drag?.kind.startsWith('loop')) return;
    this.loop = loop;
    this.loopOn = on && !!loop;
    this.draw();
  }

  /** Bars covering the selected notes (for "loop selection"). */
  selectionSpan(): LoopRegion | null {
    const sel = this.selected;
    if (sel.length === 0) return null;
    return { start: Math.min(...sel.map((n) => n.start)), end: Math.max(...sel.map((n) => n.start + n.duration)) };
  }

  /** `follow` scrolls the view to keep the playhead visible (playback); off for redraws while editing. */
  setPlayhead(sec: number | null, follow = true): void {
    this.playhead = sec;
    if (follow && sec !== null && !this.drag) {
      const x = GUTTER + sec * this.pxPerSec();
      const view = this.scroller.clientWidth;
      if (x < this.scroller.scrollLeft + GUTTER || x > this.scroller.scrollLeft + view - 20) {
        this.scroller.scrollLeft = Math.max(0, x - GUTTER - 20);
      }
    }
    this.draw();
  }

  setZoom(factor: number, aroundClientX?: number): void {
    const rect = this.scroller.getBoundingClientRect();
    const px = aroundClientX !== undefined ? aroundClientX - rect.left : this.scroller.clientWidth / 2;
    const sec = (this.scroller.scrollLeft + px - GUTTER) / this.pxPerSec();
    this.zoom = Math.max(1, Math.min(32, this.zoom * factor));
    this.layout();
    this.scroller.scrollLeft = GUTTER + sec * this.pxPerSec() - px;
    this.draw();
  }

  get selected(): Note[] {
    return this.notes.filter((n) => this.selection.has(n));
  }

  /** Apply a change to every selected note, then commit. */
  editSelected(fn: (n: Note) => void, preview = true): void {
    const sel = this.selected;
    if (sel.length === 0) return;
    for (const n of sel) {
      fn(n);
      n.midi = Math.max(0, Math.min(127, n.midi));
      n.start = Math.max(0, n.start);
      n.duration = Math.max(MIN_LEN, n.duration);
    }
    this.commit();
    if (preview) this.onPreview?.(sel[0].midi);
  }

  deleteSelected(): void {
    if (this.selection.size === 0) return;
    this.notes = this.notes.filter((n) => !this.selection.has(n));
    this.setSelection(new Set());
    this.commit();
  }

  selectAll(): void {
    this.setSelection(new Set(this.notes));
  }

  duplicateSelected(): void {
    const sel = this.selected;
    if (sel.length === 0) return;
    const start = Math.min(...sel.map((n) => n.start));
    const end = Math.max(...sel.map((n) => n.start + n.duration));
    const span = this.gridUnit() > 0 ? Math.ceil((end - start) / this.gridUnit() - 1e-6) * this.gridUnit() : end - start;
    const copies = sel.map((n) => ({ ...n, start: n.start + span }));
    this.notes.push(...copies);
    this.setSelection(new Set(copies));
    this.commit();
  }

  quantizeSelected(): void {
    const unit = this.gridUnit();
    if (unit <= 0) return;
    this.editSelected((n) => {
      const end = this.snapTime(n.start + n.duration);
      n.start = this.snapTime(n.start);
      n.duration = Math.max(unit, end - n.start);
    }, false);
  }

  copySelected(): void {
    this.clipboard = this.selected.map((n) => ({ ...n }));
  }

  paste(): void {
    if (this.clipboard.length === 0) return;
    const first = Math.min(...this.clipboard.map((n) => n.start));
    const at = this.playhead ?? Math.max(0, ...this.notes.map((n) => n.start + n.duration));
    const target = this.gridUnit() > 0 ? this.snapTime(at) : at;
    const copies = this.clipboard.map((n) => ({ ...n, start: n.start - first + target }));
    this.notes.push(...copies);
    this.setSelection(new Set(copies));
    this.commit();
  }

  /** Keyboard handling; returns true when the key was used. */
  handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'a') return this.selectAll(), true;
    if (mod && k === 'd') return this.duplicateSelected(), true;
    if (mod && k === 'u') return this.quantizeSelected(), true;
    if (mod && k === 'c') return this.copySelected(), true;
    if (mod && k === 'v') return this.paste(), true;
    if (mod) return false;
    const step = this.gridUnit() > 0 ? this.gridUnit() : 0.01;
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        this.deleteSelected();
        return true;
      case 'ArrowUp':
        this.editSelected((n) => (n.midi += e.shiftKey ? 12 : 1));
        return true;
      case 'ArrowDown':
        this.editSelected((n) => (n.midi -= e.shiftKey ? 12 : 1));
        return true;
      case 'ArrowLeft':
        if (e.shiftKey) this.editSelected((n) => (n.duration -= step), false);
        else this.editSelected((n) => (n.start -= step), false);
        return true;
      case 'ArrowRight':
        if (e.shiftKey) this.editSelected((n) => (n.duration += step), false);
        else this.editSelected((n) => (n.start += step), false);
        return true;
      case 'Escape':
        this.setSelection(new Set());
        return true;
      default:
        return false;
    }
  }

  // ------------------------------------------------------------ grid

  private gridUnit(): number {
    const s = this.settings;
    return s && this.grid > 0 ? 60 / s.bpm / this.grid : 0;
  }

  private snapTime(t: number): number {
    const s = this.settings;
    const unit = this.gridUnit();
    if (!s || unit <= 0) return t;
    const first = s.firstBeatMs / 1000;
    return first + Math.round((t - first) / unit) * unit;
  }

  /** Snap to whole beats (or bars when zoomed far out). */
  private snapBeat(t: number, g: Geometry): number {
    const s = this.settings;
    if (!s) return t;
    const P = 60 / s.bpm;
    const step = P * g.pps < 12 ? 4 * P : P;
    const first = s.firstBeatMs / 1000;
    return first + Math.round((t - first) / step) * step;
  }

  /** Magnet: the nearest note start within a few pixels, else t itself. */
  private snapOnset(t: number, g: Geometry): number {
    let best = t;
    let bestD = SNAP_PX / g.pps;
    for (const o of this.onsets) {
      const d = Math.abs(o - t);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  /** The bar line (beat index from bar 1, multiple of 4) under x in the grid lane, if any. */
  private barHandleAt(x: number, g: Geometry): { index: number; time: number } | null {
    const s = this.settings;
    if (!s) return null;
    let best: { index: number; time: number } | null = null;
    let bestD = 8;
    for (const b of beatTimes(s.bpm, s.firstBeatMs, this.duration)) {
      if (((b.index % 4) + 4) % 4 !== 0) continue;
      const d = Math.abs(this.xOf(b.time, g) - x);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  private emitLoop(final: boolean): void {
    this.onLoopChange?.(this.loop, this.loopOn, final);
    this.draw();
  }

  // ------------------------------------------------------------ selection / commit

  private setSelection(sel: Set<Note>): void {
    this.selection = sel;
    this.onSelect?.(this.selected);
    this.draw();
  }

  private commit(): void {
    this.notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    const emitted = this.notes.map((n) => ({ ...n }));
    this.lastEmitted = emitted;
    this.onNotesChange?.(emitted);
    this.onSelect?.(this.selected);
    this.draw();
  }

  // ------------------------------------------------------------ pointer

  private localPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hit(x: number, y: number, g: Geometry): { note: Note; zone: 'l' | 'r' | 'body' } | null {
    if (y < g.top) return null;
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      const x0 = this.xOf(n.start, g);
      const x1 = this.xOf(n.start + n.duration, g);
      const yc = this.yOf(n.midi, g);
      if (x >= x0 - 2 && x <= x1 + 2 && Math.abs(y - yc) <= g.rowH / 2) {
        const edge = Math.min(EDGE_PX, (x1 - x0) / 3);
        return { note: n, zone: x >= x1 - edge ? 'r' : x <= x0 + edge ? 'l' : 'body' };
      }
    }
    return null;
  }

  private startDrag(kind: DragKind, e: PointerEvent, x: number, y: number, anchor: Note | null, duplicate = false): void {
    const orig = new Map<Note, Note>();
    for (const n of this.selection) orig.set(n, { ...n });
    this.drag = {
      kind,
      x0: x,
      y0: y,
      anchor,
      orig,
      changed: false,
      duplicate,
      dupDone: false,
      baseSelection: new Set(this.selection),
      scroll0: this.scroller.scrollLeft,
      clientX0: e.clientX,
    };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.el.focus({ preventScroll: true });
    const { x, y } = this.localPoint(e);
    const g = this.geometry();
    const now = performance.now();
    const dbl = now - this.lastDown.t < DBL_MS && Math.abs(x - this.lastDown.x) < 6 && Math.abs(y - this.lastDown.y) < 6;
    this.lastDown = { t: dbl ? 0 : now, x, y };

    const t = this.tAt(x, g);
    // Loop strip: draw a new loop, or move / resize / toggle the existing one.
    if (y < RULER_Y) {
      const L = this.loop;
      const inside = L && t >= L.start && t <= L.end;
      if (dbl && inside) {
        this.loopOn = !this.loopOn;
        this.emitLoop(true);
        return;
      }
      let kind: DragKind = 'loop-new';
      if (L) {
        const xs = this.xOf(L.start, g);
        const xe = this.xOf(L.end, g);
        if (Math.abs(x - xs) < 6) kind = 'loop-l';
        else if (Math.abs(x - xe) < 6) kind = 'loop-r';
        else if (inside) kind = 'loop-move';
      }
      this.startDrag(kind, e, x, y, null);
      if (this.drag) {
        this.drag.t0 = kind === 'loop-new' ? (e.altKey ? t : this.snapBeat(t, g)) : t;
        this.drag.loop0 = L ? { ...L } : null;
      }
      return;
    }
    // Ruler: set the start marker (snapped to the grid; Alt = free), drag to scrub.
    if (y < GRID_Y) {
      this.onSeek?.(Math.max(0, e.altKey ? t : this.snapTime(t)));
      this.startDrag('scrub', e, x, y, null);
      return;
    }
    // Grid lane: drag bar 1 / empty space to slide the grid, another bar to stretch the tempo.
    if (y < HEAD) {
      const s = this.settings;
      if (!s) return;
      const P = 60 / s.bpm;
      const first = s.firstBeatMs / 1000;
      const h = this.barHandleAt(x, g);
      const stretch = h !== null && h.index !== 0;
      const line = h ? h.index : Math.round((t - first) / P);
      this.startDrag(stretch ? 'grid-stretch' : 'grid-move', e, x, y, null);
      if (this.drag) {
        this.drag.t0 = t;
        this.drag.grid0 = { bpm: s.bpm, first, line, lineTime: first + line * P };
      }
      return;
    }
    if (y < g.top) return; // chord lane
    // Piano keys: audition.
    if (x < this.scroller.scrollLeft + GUTTER) {
      this.onPreview?.(Math.round(this.midiAt(y, g)));
      return;
    }

    this.lockedRange = [g.lo, g.hi];
    const h = this.hit(x, y, g);
    const mod = e.ctrlKey || e.metaKey;

    if (h) {
      if (dbl) {
        this.notes = this.notes.filter((n) => n !== h.note);
        this.selection.delete(h.note);
        this.lockedRange = null;
        this.commit();
        return;
      }
      if (e.shiftKey) {
        const next = new Set(this.selection);
        if (next.has(h.note)) next.delete(h.note);
        else next.add(h.note);
        this.setSelection(next);
        if (!next.has(h.note)) return;
      } else if (!this.selection.has(h.note)) {
        this.setSelection(new Set([h.note]));
      }
      this.onPreview?.(h.note.midi);
      const kind: DragKind = h.zone === 'r' ? 'resize-r' : h.zone === 'l' ? 'resize-l' : 'move';
      this.startDrag(kind, e, x, y, h.note, mod && kind === 'move');
      e.preventDefault();
      return;
    }

    if (dbl) {
      const midi = Math.round(this.midiAt(y, g));
      // Ableton-style: the new note fills the grid cell under the pointer.
      const tp = this.tAt(x, g);
      const t = Math.max(0, e.altKey ? tp : this.snapTime(tp));
      const t0 = !e.altKey && this.gridUnit() > 0 && t > tp + 1e-6 ? t - this.gridUnit() : t;
      const level = this.notes.length ? this.notes.reduce((s, n) => s + n.level, 0) / this.notes.length : 0.1;
      const note: Note = {
        midi,
        start: Math.max(0, t0),
        duration: this.lastLen,
        cents: 0,
        hz: 440 * Math.pow(2, (midi - 69) / 12),
        level,
        velocity: DEFAULT_VELOCITY,
      };
      this.notes.push(note);
      this.setSelection(new Set([note]));
      this.onPreview?.(midi);
      this.lockedRange = null;
      this.commit();
      return;
    }

    if (e.pointerType === 'touch') {
      this.startDrag('pan', e, x, y, null);
      return;
    }
    if (!e.shiftKey) this.setSelection(new Set());
    this.startDrag('marquee', e, x, y, null);
    this.marquee = { x0: x, y0: y, x1: x, y1: y };
  }

  private pointerMove(e: PointerEvent): void {
    const g = this.geometry();
    const { x, y } = this.localPoint(e);
    const d = this.drag;
    if (!d) {
      const t = this.tAt(x, g);
      let cursor = 'default';
      let hint = '';
      if (y < RULER_Y) {
        const L = this.loop;
        const nearEdge = L && (Math.abs(x - this.xOf(L.start, g)) < 6 || Math.abs(x - this.xOf(L.end, g)) < 6);
        cursor = nearEdge ? 'ew-resize' : L && t > L.start && t < L.end ? 'grab' : 'crosshair';
        hint = 'Loop: drag to draw a loop · drag it to move, its edges to resize · double-click = loop on/off (L)';
      } else if (y < GRID_Y) {
        cursor = 'pointer';
        hint = 'Click to set where playback starts (Space) · Alt = no snap';
      } else if (y < HEAD) {
        const h = this.barHandleAt(x, g);
        cursor = 'ew-resize';
        hint =
          h && h.index !== 0
            ? `Drag bar ${Math.floor(h.index / 4) + 1} onto where it really is: stretches the tempo, bar 1 stays put · Alt = no snap`
            : 'Drag to slide the whole beat grid (snaps to notes) · drag another bar number to fix the tempo · Alt = no snap';
      } else if (x < this.scroller.scrollLeft + GUTTER) cursor = 'pointer';
      else {
        const h = this.hit(x, y, g);
        cursor = h ? (h.zone === 'body' ? 'grab' : 'ew-resize') : 'default';
      }
      this.canvas.style.cursor = cursor;
      if (hint !== this.lastHint) {
        this.lastHint = hint;
        this.onHint?.(hint);
      }
      return;
    }

    if (d.kind === 'scrub') {
      const t = this.tAt(x, g);
      this.onSeek?.(Math.max(0, e.altKey ? t : this.snapTime(t)));
      return;
    }
    if (d.kind.startsWith('loop')) {
      const t = this.tAt(x, g);
      const snap = (v: number): number => Math.max(0, Math.min(this.duration, e.altKey ? v : this.snapBeat(v, g)));
      const L0 = d.loop0;
      if (d.kind === 'loop-new' && d.t0 !== undefined) {
        const a = d.t0;
        const b = snap(t);
        if (b !== a) {
          this.loop = { start: Math.min(a, b), end: Math.max(a, b) };
          this.loopOn = true;
        }
      } else if (L0 && d.t0 !== undefined) {
        if (d.kind === 'loop-move') {
          const len = L0.end - L0.start;
          const start = Math.max(0, Math.min(this.duration - len, snap(L0.start + t - d.t0)));
          this.loop = { start, end: start + len };
        } else if (d.kind === 'loop-l') {
          this.loop = { start: Math.min(snap(t), L0.end - 0.05), end: L0.end };
        } else {
          this.loop = { start: L0.start, end: Math.max(snap(t), L0.start + 0.05) };
        }
      }
      d.changed = true;
      this.canvas.style.cursor = d.kind === 'loop-move' ? 'grabbing' : 'ew-resize';
      this.emitLoop(false);
      return;
    }
    if ((d.kind === 'grid-move' || d.kind === 'grid-stretch') && d.grid0 && d.t0 !== undefined && this.settings) {
      const g0 = d.grid0;
      const P0 = 60 / g0.bpm;
      const raw = g0.lineTime + (this.tAt(x, g) - d.t0);
      const target = e.altKey ? raw : this.snapOnset(raw, g);
      let bpm = g0.bpm;
      let first = g0.first;
      if (d.kind === 'grid-move') {
        first = target - g0.line * P0;
      } else {
        const P = (target - g0.first) / g0.line;
        if (P > 60 / 300 && P < 60 / 30) bpm = 60 / P;
      }
      d.changed = true;
      this.settings = { ...this.settings, bpm, firstBeatMs: first * 1000 };
      this.onGridChange?.(bpm, first * 1000, false);
      this.draw();
      return;
    }
    if (d.kind === 'pan') {
      this.scroller.scrollLeft = d.scroll0 - (e.clientX - d.clientX0);
      return;
    }
    if (d.kind === 'marquee' && this.marquee) {
      this.marquee.x1 = x;
      this.marquee.y1 = y;
      const [ax, bx] = [Math.min(this.marquee.x0, x), Math.max(this.marquee.x0, x)];
      const [ay, by] = [Math.min(this.marquee.y0, y), Math.max(this.marquee.y0, y)];
      const sel = new Set(d.baseSelection);
      for (const n of this.notes) {
        const x0 = this.xOf(n.start, g);
        const x1 = this.xOf(n.start + n.duration, g);
        const yc = this.yOf(n.midi, g);
        if (x1 >= ax && x0 <= bx && yc + g.rowH / 2 >= ay && yc - g.rowH / 2 <= by) sel.add(n);
      }
      this.selection = sel;
      this.draw();
      return;
    }

    const anchor = d.anchor;
    const a0 = anchor ? d.orig.get(anchor) : undefined;
    if (!anchor || !a0) return;
    const raw = (x - d.x0) / g.pps;
    const snap = (t: number): number => (e.altKey ? t : this.snapTime(t));

    if (d.duplicate && !d.dupDone && Math.abs(x - d.x0) + Math.abs(y - d.y0) > 3) {
      // First movement of a Ctrl-drag: leave copies behind at the original spot.
      for (const o of d.orig.values()) this.notes.push({ ...o });
      d.dupDone = true;
    }

    if (d.kind === 'move') {
      const dt = snap(a0.start + raw) - a0.start;
      const dp = Math.round(-(y - d.y0) / g.rowH);
      let pitchChanged = false;
      for (const [n, o] of d.orig) {
        const start = Math.max(0, o.start + dt);
        const midi = Math.max(0, Math.min(127, o.midi + dp));
        if (n.midi !== midi) pitchChanged = true;
        if (n.start !== start || n.midi !== midi) d.changed = true;
        n.start = start;
        n.midi = midi;
        n.hz = 440 * Math.pow(2, (midi - 69) / 12);
      }
      if (pitchChanged) this.onPreview?.(anchor.midi);
    } else if (d.kind === 'resize-r') {
      const dEnd = snap(a0.start + a0.duration + raw) - (a0.start + a0.duration);
      for (const [n, o] of d.orig) {
        const dur = Math.max(this.gridUnit() > 0 && !e.altKey ? Math.min(this.gridUnit(), o.duration) : MIN_LEN, o.duration + dEnd);
        if (dur !== n.duration) d.changed = true;
        n.duration = dur;
      }
    } else if (d.kind === 'resize-l') {
      const dStart = snap(a0.start + raw) - a0.start;
      for (const [n, o] of d.orig) {
        const end = o.start + o.duration;
        const start = Math.max(0, Math.min(end - MIN_LEN, o.start + dStart));
        if (start !== n.start) d.changed = true;
        n.start = start;
        n.duration = end - start;
      }
    }
    this.canvas.style.cursor = d.kind === 'move' ? 'grabbing' : 'ew-resize';
    this.draw();
  }

  private pointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
    this.lockedRange = null;
    this.marquee = null;
    if (d.kind === 'marquee') {
      const { x, y } = this.localPoint(e);
      // A plain click in empty space sets the start marker (like Ableton's insert marker).
      if (Math.abs(x - d.x0) < 4 && Math.abs(y - d.y0) < 4) {
        const t = this.tAt(x, this.geometry());
        this.onSeek?.(Math.max(0, e.altKey ? t : this.snapTime(t)));
      }
      this.setSelection(this.selection);
      return;
    }
    if (d.kind.startsWith('loop')) {
      if (d.changed) this.emitLoop(true);
      return;
    }
    if (d.kind === 'grid-move' || d.kind === 'grid-stretch') {
      const s = this.settings;
      if (d.changed && s) this.onGridChange?.(s.bpm, s.firstBeatMs, true);
      this.draw();
      return;
    }
    if (d.changed) {
      if (d.kind === 'resize-r' || d.kind === 'resize-l') {
        const a = d.anchor;
        if (a) this.lastLen = a.duration;
      } else if (d.anchor) {
        this.lastLen = d.anchor.duration;
      }
      for (const n of d.orig.keys()) n.cents = 0;
      this.commit();
    } else {
      this.draw();
    }
  }

  private wheel(e: WheelEvent): void {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.setZoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX);
    } else if (e.shiftKey && e.deltaY !== 0) {
      e.preventDefault();
      this.scroller.scrollLeft += e.deltaY;
    }
  }

  // ------------------------------------------------------------ layout

  private pxPerSec(): number {
    const w = Math.max(200, this.scroller.clientWidth - GUTTER);
    return this.duration > 0 ? (w / this.duration) * this.zoom : 100;
  }

  private layout(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(this.scroller.clientWidth, Math.ceil(this.duration * this.pxPerSec()) + GUTTER);
    const cssH = this.el.clientHeight || 340;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.draw();
  }

  private pitchRange(): [number, number] {
    if (this.lockedRange) return this.lockedRange;
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of this.notes) {
      lo = Math.min(lo, n.midi);
      hi = Math.max(hi, n.midi);
    }
    if (this.analysis && this.analysis.input?.source !== 'chords') {
      const tune = this.analysis.tuning.cents / 100;
      for (const f of this.analysis.pitch.f0Hz) {
        if (f <= 0) continue;
        const m = hzToMidi(f) - tune;
        if (Number.isFinite(lo) && (m < lo - 3 || m > hi + 3)) continue; // ignore f0 outliers once notes exist
        lo = Math.min(lo, m);
        hi = Math.max(hi, m);
      }
    }
    if (!Number.isFinite(lo)) return [55, 74];
    lo = Math.floor(lo) - 3;
    hi = Math.ceil(hi) + 3;
    while (hi - lo < 18) {
      lo--;
      hi++;
    }
    return [lo, hi];
  }

  private geometry(): Geometry {
    const dpr = window.devicePixelRatio || 1;
    const H = this.canvas.height / dpr;
    const [lo, hi] = this.pitchRange();
    const lane = this.chords.length ? CHORD_LANE : 0;
    const top = HEAD + lane;
    const rowH = Math.max(ROW_MIN_PX, (H - top) / (hi - lo + 1));
    return { lo, hi, rowH, top, lane, H, pps: this.pxPerSec() };
  }

  /** Time → canvas x (time 0 sits just right of the key gutter). */
  private xOf(t: number, g: Geometry): number {
    return GUTTER + t * g.pps;
  }

  /** Canvas x → time. */
  private tAt(x: number, g: Geometry): number {
    return (x - GUTTER) / g.pps;
  }

  private yOf(m: number, g: Geometry): number {
    return g.H - (m - g.lo + 0.5) * g.rowH;
  }

  private midiAt(y: number, g: Geometry): number {
    return (g.H - y) / g.rowH - 0.5 + g.lo;
  }

  // ------------------------------------------------------------ drawing

  draw(): void {
    const c = this.canvas.getContext('2d');
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width / dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = this.geometry();
    const { lo, hi, rowH, top, lane, H } = g;
    const y = (m: number): number => this.yOf(m, g);
    const X = (t: number): number => this.xOf(t, g);
    const sl = this.scroller.scrollLeft;
    const viewR = sl + this.scroller.clientWidth;

    const col = {
      bg: cssVar(this.el, '--roll-bg', '#111'),
      row: cssVar(this.el, '--roll-row', '#1a1a1a'),
      inKey: cssVar(this.el, '--roll-inkey', '#20242c'),
      grid: cssVar(this.el, '--roll-grid', '#333'),
      sub: cssVar(this.el, '--roll-sub', '#222'),
      bar: cssVar(this.el, '--roll-bar', '#555'),
      first: cssVar(this.el, '--accent-2', '#ffb02e'),
      f0: cssVar(this.el, '--roll-f0', '#7fd1ff'),
      note: cssVar(this.el, '--accent', '#ff4d6d'),
      noteSel: cssVar(this.el, '--note-sel', '#ffd166'),
      text: cssVar(this.el, '--muted', '#888'),
      fg: cssVar(this.el, '--fg', '#fff'),
      ruler: cssVar(this.el, '--panel-2', '#1e222b'),
    };

    c.fillStyle = col.bg;
    c.fillRect(0, 0, W, H);

    // Rows (in-key rows lighter).
    const s = this.settings;
    const inKey = s?.key ? scalePitchClasses(s.key.tonic, s.key.mode) : null;
    for (let m = lo; m <= hi; m++) {
      const pc = ((m % 12) + 12) % 12;
      c.fillStyle = inKey?.has(pc) ? col.inKey : col.row;
      c.fillRect(sl, y(m) - rowH / 2 + 0.5, viewR - sl, rowH - 1);
    }

    // Grid: sub-beats, beats, bars.
    if (s) {
      const unit = this.gridUnit();
      if (unit > 0 && unit * g.pps >= 7) {
        c.strokeStyle = col.sub;
        c.lineWidth = 1;
        c.beginPath();
        const first = s.firstBeatMs / 1000;
        const k0 = Math.ceil((Math.max(0, this.tAt(sl, g)) - first) / unit);
        for (let k = k0; ; k++) {
          const x = Math.round(X(first + k * unit)) + 0.5;
          if (x > viewR || k > k0 + 100000) break;
          c.moveTo(x, top);
          c.lineTo(x, H);
        }
        c.stroke();
      }
      for (const b of beatTimes(s.bpm, s.firstBeatMs, this.duration)) {
        const x = Math.round(X(b.time)) + 0.5;
        if (x < sl - 2 || x > viewR + 2) continue;
        const bar = ((b.index % 4) + 4) % 4 === 0;
        c.strokeStyle = b.index === 0 ? col.first : bar ? col.bar : col.grid;
        c.lineWidth = b.index === 0 ? 2 : 1;
        c.beginPath();
        c.moveTo(x, top);
        c.lineTo(x, H);
        c.stroke();
      }
    }

    // Raw f0 (tuning-corrected) behind the notes — melody takes only.
    const a = this.analysis;
    if (a && a.input?.source !== 'chords') {
      // A continuous line, broken at silences and at jumps (new note / octave slip).
      const tune = a.tuning.cents / 100;
      const tr = a.pitch;
      c.strokeStyle = col.f0;
      c.lineWidth = 1.6;
      c.lineJoin = 'round';
      c.lineCap = 'round';
      let px = NaN;
      let py = NaN;
      let pm = NaN;
      for (let i = 0; i < tr.f0Hz.length; i++) {
        const f = tr.f0Hz[i];
        const x = X(tr.times[i]);
        const m = f > 0 ? hzToMidi(f) - tune : NaN;
        const visible = f > 0 && x >= sl - 4 && x <= viewR + 4 && m >= lo - 1 && m <= hi + 1;
        if (!visible) {
          px = NaN;
          continue;
        }
        const yy = y(m);
        if (!Number.isNaN(px) && Math.abs(m - pm) < 1.5 && x - px < 12) {
          c.globalAlpha = 0.25 + 0.55 * tr.confidence[i];
          c.beginPath();
          c.moveTo(px, py);
          c.lineTo(x, yy);
          c.stroke();
        }
        px = x;
        py = yy;
        pm = m;
      }
      c.globalAlpha = 1;
    }

    // Notes.
    c.font = '10px system-ui, sans-serif';
    c.textBaseline = 'middle';
    for (const n of this.notes) {
      const x0 = X(n.start);
      const w = Math.max(3, n.duration * g.pps);
      if (x0 + w < sl || x0 > viewR) continue;
      const yy = y(n.midi);
      const sel = this.selection.has(n);
      // Colour strength = velocity (like Ableton): faint notes look faint.
      c.fillStyle = sel ? col.noteSel : col.note;
      c.globalAlpha = sel ? 1 : 0.22 + 0.78 * (velocityOf(n) / 127);
      roundRect(c, x0 + 0.5, yy - rowH / 2 + 1.5, w - 1, rowH - 3, Math.min(3, rowH / 4));
      c.fill();
      c.globalAlpha = 1;
      c.strokeStyle = sel ? col.fg : 'rgba(0,0,0,0.35)';
      c.lineWidth = sel ? 1.5 : 1;
      c.stroke();
      if (w > 26 && rowH >= 11) {
        c.fillStyle = sel ? '#1a1a1a' : '#fff';
        c.fillText(noteName(n.midi), x0 + 4, yy + 0.5);
      }
    }

    if (this.marquee) {
      const m = this.marquee;
      c.fillStyle = 'rgba(127,209,255,0.12)';
      c.strokeStyle = col.f0;
      c.lineWidth = 1;
      c.fillRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      c.strokeRect(Math.min(m.x0, m.x1) + 0.5, Math.min(m.y0, m.y1) + 0.5, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    }

    // Loop region tint over the notes.
    const L = this.loop;
    if (L) {
      c.fillStyle = this.loopOn ? 'rgba(255,176,46,0.07)' : 'rgba(255,255,255,0.03)';
      c.fillRect(X(L.start), top, (L.end - L.start) * g.pps, H - top);
    }

    // Loop strip.
    c.fillStyle = col.bg;
    c.fillRect(sl, 0, viewR - sl, LOOP_H);
    if (L) {
      const x0 = X(L.start);
      const w = Math.max(2, (L.end - L.start) * g.pps);
      c.fillStyle = this.loopOn ? col.first : col.bar;
      c.globalAlpha = this.loopOn ? 0.9 : 0.6;
      c.fillRect(x0, 1, w, LOOP_H - 2);
      c.globalAlpha = 1;
      c.fillStyle = this.loopOn ? '#1a1a1a' : col.fg;
      c.fillRect(x0, 1, 2, LOOP_H - 2);
      c.fillRect(x0 + w - 2, 1, 2, LOOP_H - 2);
    }

    // Ruler (bar numbers).
    c.fillStyle = col.ruler;
    c.fillRect(sl, RULER_Y, viewR - sl, RULER);
    if (s) {
      c.fillStyle = col.text;
      c.font = '10px system-ui, sans-serif';
      c.textBaseline = 'middle';
      for (const b of beatTimes(s.bpm, s.firstBeatMs, this.duration)) {
        const x = Math.round(X(b.time)) + 0.5;
        if (x < sl - 30 || x > viewR) continue;
        const bar = ((b.index % 4) + 4) % 4 === 0;
        c.fillRect(x, RULER_Y + (bar ? 3 : 11), 1, bar ? RULER - 3 : RULER - 11);
        if (bar) c.fillText(String(Math.floor(b.index / 4) + 1), x + 3, RULER_Y + RULER / 2);
      }
    }

    // Grid lane: bar handles. Bar 1 is the orange flag you slide; the others stretch the tempo.
    c.fillStyle = col.bg;
    c.fillRect(sl, GRID_Y, viewR - sl, GRID_H);
    c.fillStyle = col.bar;
    c.fillRect(sl, HEAD - 1, viewR - sl, 1);
    if (s) {
      c.font = '600 9px system-ui, sans-serif';
      c.textBaseline = 'middle';
      const dragging = this.drag?.kind === 'grid-move' || this.drag?.kind === 'grid-stretch';
      const grabbed = dragging ? this.drag?.grid0?.line : undefined;
      for (const b of beatTimes(s.bpm, s.firstBeatMs, this.duration)) {
        if (((b.index % 4) + 4) % 4 !== 0) continue;
        const x = Math.round(X(b.time)) + 0.5;
        if (x < sl - 30 || x > viewR + 2) continue;
        const one = b.index === 0;
        const label = String(Math.floor(b.index / 4) + 1);
        const w = Math.max(14, c.measureText(label).width + 8);
        c.fillStyle = one ? col.first : b.index === grabbed ? col.fg : col.bar;
        c.beginPath();
        c.moveTo(x, GRID_Y + 1);
        c.lineTo(x + w, GRID_Y + 1);
        c.lineTo(x + w, HEAD - 5);
        c.lineTo(x + 4, HEAD - 5);
        c.lineTo(x, HEAD - 1);
        c.closePath();
        c.fill();
        c.fillStyle = one ? '#1a1a1a' : b.index === grabbed ? col.bg : '#fff';
        c.fillText(label, x + 4, GRID_Y + (GRID_H - 4) / 2 + 1);
      }
    }

    // Chord lane.
    if (lane) {
      c.fillStyle = col.bg;
      c.fillRect(sl, HEAD, viewR - sl, lane);
      c.font = '600 11px system-ui, sans-serif';
      for (const ch of this.chords) {
        const x0 = X(ch.start);
        const w = ch.duration * g.pps;
        if (x0 + w < sl || x0 > viewR) continue;
        c.fillStyle = col.row;
        c.fillRect(x0 + 1, HEAD + 2, Math.max(1, w - 2), lane - 4);
        c.fillStyle = col.first;
        c.fillText(ch.name, x0 + 4, HEAD + lane / 2, Math.max(8, w - 6));
      }
    }

    // Start marker (where Space starts): blue flag in the ruler + faint line.
    {
      const x = Math.round(X(this.cue)) + 0.5;
      c.strokeStyle = col.f0;
      c.globalAlpha = 0.35;
      c.lineWidth = 1;
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(x, HEAD);
      c.lineTo(x, H);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
      c.fillStyle = col.f0;
      c.beginPath();
      c.moveTo(x - 5, RULER_Y + RULER - 8);
      c.lineTo(x + 5, RULER_Y + RULER - 8);
      c.lineTo(x, RULER_Y + RULER);
      c.closePath();
      c.fill();
    }

    // Playhead.
    if (this.playhead !== null) {
      const x = X(this.playhead);
      c.strokeStyle = col.fg;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(x, RULER_Y);
      c.lineTo(x, H);
      c.stroke();
      c.fillStyle = col.fg;
      c.beginPath();
      c.moveTo(x - 5, RULER_Y);
      c.lineTo(x + 5, RULER_Y);
      c.lineTo(x, RULER_Y + 7);
      c.closePath();
      c.fill();
    }

    // Sticky piano-key gutter.
    c.fillStyle = col.ruler;
    c.fillRect(sl, 0, GUTTER, top);
    c.fillStyle = col.text;
    c.font = '8px system-ui, sans-serif';
    c.textBaseline = 'middle';
    c.fillText(this.loopOn ? 'LOOP ●' : 'LOOP', sl + 3, LOOP_H / 2 + 0.5);
    c.fillText('BAR', sl + 3, RULER_Y + RULER / 2);
    c.fillText('GRID ⇔', sl + 3, GRID_Y + GRID_H / 2);
    for (let m = lo; m <= hi; m++) {
      const pc = ((m % 12) + 12) % 12;
      const yy = y(m);
      c.fillStyle = BLACK.has(pc) ? '#2a2d34' : '#e9ebef';
      c.fillRect(sl, yy - rowH / 2, GUTTER - 1, rowH - 0.5);
      if (pc === 0 || rowH >= 14) {
        c.fillStyle = BLACK.has(pc) ? '#c9ccd3' : '#555b66';
        c.font = '9px system-ui, sans-serif';
        c.fillText(noteName(m), sl + 3, yy + 0.5);
      }
    }
    c.fillStyle = col.bar;
    c.fillRect(sl + GUTTER - 1, top, 1, H - top);
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
