import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { runPromptHook } from '../codegraph-prompt.mjs';

export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event, ctx) => {
    if (!event.prompt.trim()) {
      return;
    }

    const context = await runPromptHook({ prompt: event.prompt, cwd: ctx.cwd });
    if (!context) {
      return;
    }

    return { message: { customType: 'codegraph', content: context, display: false } };
  });
}
