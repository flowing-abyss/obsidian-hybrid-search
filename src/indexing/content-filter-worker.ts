import { projectContent, type ContentIgnorePattern } from '../content/content-ignore.js';
import { isContentFilterRequest, type ContentFilterReply } from './content-filter-protocol.js';

let patterns: readonly ContentIgnorePattern[] | undefined;

function reply(message: ContentFilterReply): void {
  process.send?.(message, (error) => {
    if (error) process.exit(1);
  });
}

process.on('disconnect', () => process.exit(0));
process.on('message', (request: unknown) => {
  if (!isContentFilterRequest(request)) {
    reply({ id: 0, ok: false });
    return;
  }
  try {
    if (request.type === 'init' && !patterns) {
      patterns = request.patterns;
      // Compile once; projectContent reuses this immutable policy between notes.
      projectContent('', patterns);
      reply({ id: request.id, ok: true });
    } else if (request.type === 'project' && patterns) {
      reply({ id: request.id, ok: true, projection: projectContent(request.body, patterns) });
    } else {
      reply({ id: request.id, ok: false });
    }
  } catch {
    // Regex errors can quote the source expression or input. The parent adds safe operation context.
    reply({ id: request.id, ok: false });
  }
});
