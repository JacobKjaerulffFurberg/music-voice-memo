/**
 * MP3 export: rendered audio → an .mp3 file, and handing that file to the
 * phone (share sheet) or the browser (download).
 *
 * The encoder (LAME, via @breezystack/lamejs, LGPL-3.0) is loaded only when a
 * file is actually exported.
 */

export interface Pcm {
  sampleRate: number;
  /** One or two channels of samples in [-1, 1] (anything louder is brought down, not clipped). */
  channels: Float32Array[];
}

/** Float samples → 16-bit, with the whole file brought down if its peaks would clip. */
export function toInt16(channels: Float32Array[]): Int16Array[] {
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  const k = peak > 0.97 ? 0.97 / peak : 1;
  return channels.map((c) => {
    const out = new Int16Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = Math.round(c[i] * k * 32767);
    return out;
  });
}

export async function encodeMp3(pcm: Pcm, kbps = 192): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const [left, right] = toInt16(pcm.channels.slice(0, 2));
  const enc = new Mp3Encoder(right ? 2 : 1, pcm.sampleRate, kbps);
  const parts: Uint8Array[] = [];
  const BLOCK = 1152 * 20;
  for (let i = 0; i < left.length; i += BLOCK) {
    const l = left.subarray(i, i + BLOCK);
    const out = right ? enc.encodeBuffer(l, right.subarray(i, i + BLOCK)) : enc.encodeBuffer(l);
    if (out.length) parts.push(new Uint8Array(out));
    // Let the page breathe: the spinner keeps turning on a long take.
    if ((i / BLOCK) % 8 === 7) await new Promise((r) => setTimeout(r));
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}

/** A name that is safe as a file name everywhere. */
export function fileName(name: string, ext = 'mp3'): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Idea';
  return `${base}.${ext}`;
}

/**
 * Give the file to the user: the share sheet where there is one that takes files
 * (phones), else a download. Returns how it went.
 */
export async function handOver(blob: Blob, name: string): Promise<'shared' | 'saved' | 'cancelled'> {
  const file = new File([blob], name, { type: blob.type });
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      // Not allowed (the tap was too long ago) or unsupported after all: download instead.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'saved';
}
