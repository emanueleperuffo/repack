---
"@callstack/repack": patch
---

Speed up `HermesBytecodePlugin` on Linux by compiling chunks in a pool of worker processes. The plugin used to spawn hermesc and the source-map composer for every chunk at once from the bundler process. On Linux each spawn copies the page tables of the whole bundler heap, so with thousands of chunks and a large heap the spawns serialized into minutes. Workers now run at most one job per CPU, configurable with the new `maxWorkers` option, and compose source maps in-process with React Native's `metro-source-map` instead of starting a Node process for `compose-source-maps.js` per chunk.
