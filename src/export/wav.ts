/** WAV encode (mono PCM 16/24-bit or 32-bit float) and decode (any common PCM/float layout → mono). */

export type WavBitDepth = 16 | 24 | 32;

export function encodeWav(samples: Float32Array, sampleRate: number, bitDepth: WavBitDepth = 24): Uint8Array {
  const bytesPer = bitDepth / 8;
  const dataLen = samples.length * bytesPer;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  const isFloat = bitDepth === 32;
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, isFloat ? 3 : 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * bytesPer, true);
  v.setUint16(32, bytesPer, true);
  v.setUint16(34, bitDepth, true);
  str(36, 'data');
  v.setUint32(40, dataLen, true);

  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    if (isFloat) {
      v.setFloat32(o, samples[i], true);
    } else if (bitDepth === 16) {
      v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    } else {
      const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
      v.setUint8(o, x & 0xff);
      v.setUint8(o + 1, (x >> 8) & 0xff);
      v.setUint8(o + 2, (x >> 16) & 0xff);
    }
    o += bytesPer;
  }
  return new Uint8Array(buf);
}

export interface DecodedWav {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export function decodeWav(bytes: ArrayBuffer): DecodedWav {
  const v = new DataView(bytes);
  const tag = (o: number): string => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');

  let fmt: { format: number; channels: number; sampleRate: number; bits: number; blockAlign: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  let o = 12;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const len = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      if (format === 0xfffe && len >= 26) format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = {
        format,
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        blockAlign: v.getUint16(body + 12, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(len, bytes.byteLength - body);
    }
    o = body + len + (len % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV is missing fmt or data chunk');
  const { format, channels, bits, blockAlign } = fmt;
  if (format !== 1 && format !== 3) throw new Error(`Unsupported WAV format ${format}`);
  const frames = Math.floor(dataLen / blockAlign);
  const out = new Float32Array(frames);
  const bps = bits / 8;
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOff + f * blockAlign + c * bps;
      let s: number;
      if (format === 3 && bits === 32) s = v.getFloat32(p, true);
      else if (format === 3 && bits === 64) s = v.getFloat64(p, true);
      else if (bits === 8) s = (v.getUint8(p) - 128) / 128;
      else if (bits === 16) s = v.getInt16(p, true) / 32768;
      else if (bits === 24) {
        let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
        if (x & 0x800000) x -= 0x1000000;
        s = x / 8388608;
      } else if (bits === 32) s = v.getInt32(p, true) / 2147483648;
      else throw new Error(`Unsupported bit depth ${bits}`);
      acc += s;
    }
    out[f] = acc / channels;
  }
  return { samples: out, sampleRate: fmt.sampleRate, channels, bitDepth: bits };
}
