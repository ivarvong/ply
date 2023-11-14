// WireText is the pkt-line field validateWire parsed. A raw string is not one.
import { validateWire, type WireText } from '../../src/validate.js';

const prefix: WireText = validateWire('refs/heads/', 'ref prefix');
const option: WireText = validateWire('no-thin', 'push option');

// @ts-expect-error a raw string has not been parsed
const raw: WireText = 'refs/heads/';
void prefix;
void option;
void raw;
