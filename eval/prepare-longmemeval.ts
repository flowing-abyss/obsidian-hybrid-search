import fs, { createWriteStream } from 'node:fs';
import { get as httpsGet } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');
const LONGMEMEVAL_S_URL =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json';

interface LongMemEvalTurn {
  role: string;
  content: string;
  has_answer?: boolean;
}

interface LongMemEvalItem {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LongMemEvalTurn[][];
}

interface PrepareOptions {
  data: LongMemEvalItem[];
  vault: string;
  goldenSet: string;
  dataset: string;
  repoRoot?: string;
  includeAbstention?: boolean;
  maxPerType?: number;
}

interface PrepareResult {
  notesWritten: number;
  queriesWritten: number;
  abstentionsSkipped: number;
}

interface PrepareStandardOptions {
  repoRoot?: string;
  input?: string;
  vault?: string;
  goldenSet?: string;
  data?: LongMemEvalItem[];
  forceDownload?: boolean;
  includeAbstention?: boolean;
  maxPerType?: number;
}

interface PrepareStandardResult extends PrepareResult {
  input: string;
  vault: string;
  goldenSet: string;
  downloaded: boolean;
}

interface GoldenQuery {
  id: string;
  query: string;
  scope: string;
  relevant_paths: string[];
  partial_paths: string[];
  category: string;
  notes: string;
}

export function prepareLongMemEvalFixture(options: PrepareOptions): PrepareResult {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  ensureSafeFixtureVault(options.vault, repoRoot);

  fs.rmSync(options.vault, { recursive: true, force: true });
  fs.mkdirSync(options.vault, { recursive: true });
  fs.mkdirSync(path.dirname(options.goldenSet), { recursive: true });

  const goldenSet: GoldenQuery[] = [];
  const writtenByType = new Map<string, number>();
  let notesWritten = 0;
  let abstentionsSkipped = 0;

  for (const item of options.data) {
    const isAbstention = item.answer_session_ids.length === 0 || item.question_id.includes('_abs');
    if (isAbstention && !options.includeAbstention) {
      abstentionsSkipped++;
      continue;
    }
    if (options.maxPerType !== undefined) {
      const written = writtenByType.get(item.question_type) ?? 0;
      if (written >= options.maxPerType) continue;
      writtenByType.set(item.question_type, written + 1);
    }

    const questionDir = path.join(options.vault, item.question_id);
    fs.mkdirSync(questionDir, { recursive: true });

    const sessionPathById = new Map<string, string>();
    for (let i = 0; i < item.haystack_sessions.length; i++) {
      const sessionId = item.haystack_session_ids[i];
      const session = item.haystack_sessions[i];
      const date = item.haystack_dates[i];
      if (!sessionId || !session || !date) {
        throw new Error(
          `Invalid LongMemEval item ${item.question_id}: session arrays are misaligned`,
        );
      }

      const filename = `${String(i + 1).padStart(4, '0')}.md`;
      const relativePath = `${item.question_id}/${filename}`;
      sessionPathById.set(sessionId, relativePath);
      fs.writeFileSync(
        path.join(questionDir, filename),
        renderSessionMarkdown({
          dataset: options.dataset,
          questionId: item.question_id,
          questionType: item.question_type,
          sessionId,
          sessionIndex: i + 1,
          date,
          turns: session,
        }),
      );
      notesWritten++;
    }

    const relevantPaths = item.answer_session_ids.map((sessionId) => {
      const relPath = sessionPathById.get(sessionId);
      if (!relPath) {
        throw new Error(
          `Invalid LongMemEval item ${item.question_id}: answer session ${sessionId} is not in haystack_session_ids`,
        );
      }
      return relPath;
    });

    goldenSet.push({
      id: item.question_id,
      query: item.question,
      scope: `${item.question_id}/`,
      relevant_paths: relevantPaths,
      partial_paths: [],
      category: item.question_type,
      notes: buildNotes(item, options.dataset, isAbstention),
    });
  }

  fs.writeFileSync(options.goldenSet, `${JSON.stringify(goldenSet, null, 2)}\n`);
  validateGeneratedArtifacts(options.vault, goldenSet);

  return {
    notesWritten,
    queriesWritten: goldenSet.length,
    abstentionsSkipped,
  };
}

export async function prepareLongMemEvalSFixture(
  options: PrepareStandardOptions = {},
): Promise<PrepareStandardResult> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const input = resolveFromRoot(repoRoot, options.input ?? 'data/longmemeval_s_cleaned.json');
  const vault = resolveFromRoot(repoRoot, options.vault ?? 'fixtures/longmemeval-s/dataset');
  const goldenSet = resolveFromRoot(
    repoRoot,
    options.goldenSet ?? 'fixtures/longmemeval-s/golden-set.json',
  );

  const downloaded =
    options.data === undefined
      ? await ensureSourceFile(input, options.forceDownload === true)
      : false;
  const data = options.data ?? (JSON.parse(fs.readFileSync(input, 'utf-8')) as LongMemEvalItem[]);
  const result = prepareLongMemEvalFixture({
    data,
    vault,
    goldenSet,
    dataset: 's',
    repoRoot,
    includeAbstention: options.includeAbstention,
    maxPerType: options.maxPerType,
  });

  return {
    ...result,
    input,
    vault,
    goldenSet,
    downloaded,
  };
}

function renderSessionMarkdown(input: {
  dataset: string;
  questionId: string;
  questionType: string;
  sessionId: string;
  sessionIndex: number;
  date: string;
  turns: LongMemEvalTurn[];
}): string {
  const lines = [
    '---',
    'title: Conversation',
    `longmemeval_dataset: ${yamlScalar(input.dataset)}`,
    `longmemeval_question_id: ${yamlScalar(input.questionId)}`,
    `longmemeval_session_id: ${yamlScalar(input.sessionId)}`,
    `longmemeval_session_index: ${String(input.sessionIndex)}`,
    `longmemeval_date: ${yamlScalar(input.date)}`,
    `longmemeval_question_type: ${yamlScalar(input.questionType)}`,
    'tags:',
    '  - benchmark/longmemeval',
    `  - benchmark/longmemeval/${input.dataset}`,
    `  - benchmark/type/${input.questionType}`,
    '---',
    '',
    '# Conversation',
    '',
    `Date: ${input.date}`,
    '',
  ];

  for (const turn of input.turns) {
    lines.push(`## ${formatRole(turn.role)}`, '', turn.content, '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9_/-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatRole(role: string): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function buildNotes(item: LongMemEvalItem, dataset: string, isAbstention: boolean): string {
  const answerPositions = item.answer_session_ids.map((sessionId) => {
    const index = item.haystack_session_ids.indexOf(sessionId);
    return index === -1 ? 'missing' : String(index + 1);
  });
  const hasAnswerRole = getHasAnswerRole(item);
  return [
    `dataset=${dataset}`,
    `question_type=${item.question_type}`,
    `answer=${item.answer}`,
    `relevant_count=${String(item.answer_session_ids.length)}`,
    `answer_session_ids=${item.answer_session_ids.join(',')}`,
    `answer_positions=${answerPositions.join(',')}`,
    `question_date=${item.question_date}`,
    `session_count=${String(item.haystack_sessions.length)}`,
    `has_answer_role=${hasAnswerRole}`,
    `is_abstention=${String(isAbstention)}`,
    'timestamp_in_body=true',
  ].join('; ');
}

function getHasAnswerRole(item: LongMemEvalItem): 'user' | 'assistant' | 'both' | 'unknown' {
  const roles = new Set<'user' | 'assistant'>();
  for (const sessionId of item.answer_session_ids) {
    const index = item.haystack_session_ids.indexOf(sessionId);
    if (index === -1) continue;
    const session = item.haystack_sessions[index] ?? [];
    for (const turn of session) {
      if (turn.has_answer !== true) continue;
      if (turn.role === 'user' || turn.role === 'assistant') roles.add(turn.role);
    }
  }
  if (roles.has('user') && roles.has('assistant')) return 'both';
  if (roles.has('user')) return 'user';
  if (roles.has('assistant')) return 'assistant';
  return 'unknown';
}

function ensureSafeFixtureVault(vault: string, repoRoot: string): void {
  const absVault = path.resolve(vault);
  const fixturesRoot = path.resolve(repoRoot, 'fixtures');
  const relative = path.relative(fixturesRoot, absVault);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new Error(`Refusing to recreate vault outside fixtures/: ${vault}`);
  }
}

function validateGeneratedArtifacts(vault: string, goldenSet: GoldenQuery[]): void {
  const forbidden = [
    /^answer_session_ids:/im,
    /^has_answer:/im,
    /^expected(?: answer)?:/im,
    /^relevant:/im,
    /\banswer_session_ids\b/i,
    /\bhas_answer\b/i,
  ];

  for (const query of goldenSet) {
    for (const relPath of query.relevant_paths) {
      if (!fs.existsSync(path.join(vault, relPath))) {
        throw new Error(`Generated relevant path does not exist: ${relPath}`);
      }
    }
  }

  for (const filePath of walkMarkdown(vault)) {
    const text = fs.readFileSync(filePath, 'utf-8');
    const match = forbidden.find((pattern) => pattern.test(text));
    if (match) {
      throw new Error(`Generated note contains forbidden ground-truth label: ${filePath}`);
    }
  }
}

function resolveFromRoot(repoRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

async function ensureSourceFile(input: string, forceDownload: boolean): Promise<boolean> {
  if (!forceDownload && fs.existsSync(input)) return false;
  fs.mkdirSync(path.dirname(input), { recursive: true });
  await downloadFile(LONGMEMEVAL_S_URL, input);
  return true;
}

async function downloadFile(url: string, destination: string, redirects = 0): Promise<void> {
  if (redirects > 5) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  await new Promise<void>((resolve, reject) => {
    const request = httpsGet(url, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        downloadFile(new URL(location, url).toString(), destination, redirects + 1)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${String(status)}`));
        return;
      }

      const tempDestination = `${destination}.tmp`;
      const file = createWriteStream(tempDestination);
      response.pipe(file);
      file.on('finish', () => {
        file.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          fs.renameSync(tempDestination, destination);
          resolve();
        });
      });
      file.on('error', (error) => {
        fs.rmSync(tempDestination, { force: true });
        reject(error);
      });
    });
    request.on('error', reject);
  });
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield fullPath;
    }
  }
}

function parseArgs(): {
  input: string | undefined;
  vault: string | undefined;
  goldenSet: string | undefined;
  dataset: string;
  forceDownload: boolean;
  includeAbstention: boolean;
  maxPerType: number | undefined;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx === -1 ? undefined : args[idx + 1];
  };

  const input = get('--input');
  const vault = get('--vault');
  const goldenSet = get('--golden-set');
  const dataset = get('--dataset') ?? 's';
  const maxPerTypeRaw = get('--max-per-type');

  return {
    input,
    vault,
    goldenSet,
    dataset,
    forceDownload: args.includes('--force-download'),
    includeAbstention: args.includes('--include-abstention'),
    maxPerType: maxPerTypeRaw === undefined ? undefined : parsePositiveInteger(maxPerTypeRaw),
  };
}

function parsePositiveInteger(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid --max-per-type: expected positive integer, got "${raw}"`);
  }
  return Number(raw);
}

async function main(): Promise<void> {
  try {
    const args = parseArgs();
    if (args.dataset !== 's') {
      throw new Error('The default fixture command currently supports only --dataset s');
    }
    const result = await prepareLongMemEvalSFixture({
      input: args.input,
      vault: args.vault,
      goldenSet: args.goldenSet,
      forceDownload: args.forceDownload,
      includeAbstention: args.includeAbstention,
      maxPerType: args.maxPerType,
    });
    console.log(`[longmem] notes written:        ${String(result.notesWritten)}`);
    console.log(`[longmem] queries written:      ${String(result.queriesWritten)}`);
    console.log(`[longmem] abstentions skipped:  ${String(result.abstentionsSkipped)}`);
    console.log(`[longmem] source downloaded:    ${String(result.downloaded)}`);
    console.log(`[longmem] input:                ${result.input}`);
    console.log(`[longmem] vault:                ${result.vault}`);
    console.log(`[longmem] golden set:           ${result.goldenSet}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
