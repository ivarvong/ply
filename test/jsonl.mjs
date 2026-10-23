// Node-only JSONL file exporter for the OTLP tracer (kept out of src/: node:fs has no place in a Workers bundle).
import fs from 'node:fs';
export function jsonlExporter(path) {
  const fd = fs.openSync(path, 'a');
  return Object.assign(line => fs.writeSync(fd, JSON.stringify(line) + '\n'), { close: () => fs.closeSync(fd) });
}
