// WireText is the pkt-line field validateWire parsed. A raw string is not one.
import { validateWire, type WireText } from '../../src/validate.js';
import type { Transport } from '../../src/transport.js';
import { lsRefs } from '../../src/lsrefs.js';
import { checkPushCaps } from '../../src/receivecaps.js';

const prefix: WireText = validateWire('refs/heads/', 'ref prefix');
const option: WireText = validateWire('no-thin', 'push option');
declare const transport: Transport;
void lsRefs(transport, [prefix]);
void checkPushCaps(new Set(['push-options']), { pushOptions: [option] });

// @ts-expect-error a raw string has not been parsed
const raw: WireText = 'refs/heads/';
// @ts-expect-error ls-refs prefixes are WireText, not raw strings
void lsRefs(transport, ['refs/heads/']);
// @ts-expect-error push options are WireText, not raw strings
void checkPushCaps(new Set(['push-options']), { pushOptions: ['no-thin'] });
void prefix;
void option;
void raw;
