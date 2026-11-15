import { describe, expect, it } from 'vitest';
import { encodeMp3, fileName, toInt16 } from '../src/export/mp3';

describe('mp3 export', () => {
  it('brings a too-loud file down instead of clipping it', () => {
    const [quiet] = toInt16([Float32Array.from([0, 0.5, -0.5])]);
    expect(quiet[0]).toBe(0);
    expect(Math.abs(quiet[1] - 16384)).toBeLessThanOrEqual(1);
    expect(Math.abs(quiet[2] + 16384)).toBeLessThanOrEqual(1);
    const [loud] = toInt16([Float32Array.from([0, 2, -1])]);
    expect(Math.abs(loud[1] - 0.97 * 32767)).toBeLessThanOrEqual(1);
    expect(Math.abs(loud[2] + 0.485 * 32767)).toBeLessThanOrEqual(1);
  });

  it('encodes stereo audio to an MP3 of about the right size', async () => {
    const sr = 44100;
    const left = new Float32Array(sr * 2);
    const right = new Float32Array(sr * 2);
    for (let i = 0; i < left.length; i++) {
      left[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / sr);
      right[i] = 0.4 * Math.sin((2 * Math.PI * 330 * i) / sr);
    }
    const blob = await encodeMp3({ sampleRate: sr, channels: [left, right] }, 128);
    expect(blob.type).toBe('audio/mpeg');
    // 2 s at 128 kbit/s is 32 kB.
    expect(blob.size).toBeGreaterThan(28_000);
    expect(blob.size).toBeLessThan(40_000);
    const head = new Uint8Array(await blob.arrayBuffer()).subarray(0, 2);
    expect(head[0]).toBe(0xff); // MPEG frame sync
    expect(head[1] & 0xe0).toBe(0xe0);
  });

  it('makes a safe file name from the take name', () => {
    expect(fileName('Idea Nov 15 20:31')).toBe('Idea Nov 15 20 31.mp3');
    expect(fileName('  ')).toBe('Idea.mp3');
  });
});
