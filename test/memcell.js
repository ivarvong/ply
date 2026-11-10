// How a memory cell measures live bytes (#249): one set of node flags for every child that samples
// process.memoryUsage().arrayBuffers after a forced gc (test/stream/cell.mjs, test/stream/resolve-cell.mjs,
// test/push-stream-child.mjs, test/push-pack-child.mjs, test/pack-subset-child.mjs).
//
//   --expose-gc                              the cell calls gc() before every sample.
//   --no-concurrent-array-buffer-sweeping    V8 frees the backing stores of dead ArrayBuffers on a background thread
//                                            after a gc, and arrayBuffers counts them until it has. On node 22, beside
//                                            other test files, that thread lagged: pushPack's 256 MiB cell read
//                                            11,534,476 B with it and 2,097,292 B without it (two 1 MiB chunks, what it
//                                            holds); node 24 read 2,097,288 B either way. Sweeping with the gc makes the
//                                            sample the live bytes whatever the machine's load.
//
// The other half of #249 is the cells' input: test/stream/pieces.mjs.
export const MEMORY_CELL_FLAGS = Object.freeze(['--expose-gc', '--no-concurrent-array-buffer-sweeping']);
