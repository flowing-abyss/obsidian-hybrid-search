import { randomBytes } from 'node:crypto';
import { runPromptHook } from '../codegraph-prompt.mjs';

export const CodegraphPromptContext = async ({ directory }) => ({
  'chat.message': async (_input, output) => {
    const prompt = output.parts
      .filter((part) => part.type === 'text' && !part.synthetic)
      .map((part) => part.text)
      .join('\n');

    if (!prompt.trim()) {
      return;
    }

    const context = await runPromptHook({ prompt, cwd: directory });
    if (!context) {
      return;
    }

    output.parts.push({
      id: ascendingPartId(),
      sessionID: output.message.sessionID,
      messageID: output.message.id,
      type: 'text',
      text: context,
      synthetic: true,
    });
  },
});

// OpenCode assigns part ids before `chat.message` runs, so a part added here
// brings its own, in OpenCode's ascending format: `prt_`, the low 48 bits of
// (milliseconds * 4096 + a per-millisecond counter) as 12 hex digits, then 14
// base62 characters. Later ids sort after the user's own parts.
let lastTimestamp = 0;
let counter = 0;

function ascendingPartId() {
  const now = Date.now();
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    counter = 0;
  }
  counter += 1;

  const time = (BigInt(now) * 0x1000n + BigInt(counter)).toString(16).padStart(12, '0').slice(-12);
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const random = Array.from(randomBytes(14), (byte) => alphabet[byte % 62]).join('');
  return `prt_${time}${random}`;
}
