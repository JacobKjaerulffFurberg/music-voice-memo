// Minimal ambient declarations for the essentia.js ES builds we import.
// The concrete API we rely on is typed in ./essentia.ts.

declare module 'essentia.js/dist/essentia-wasm.es.js' {
  export const EssentiaWASM: unknown;
}

declare module 'essentia.js/dist/essentia.js-core.es.js' {
  export default class Essentia {
    constructor(wasmModule: unknown, isDebug?: boolean);
  }
}
