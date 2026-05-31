import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareLongMemEvalFixture,
  prepareLongMemEvalSFixture,
} from '../../eval/prepare-longmemeval.js';

const sample = [
  {
    question_id: 'q1',
    question_type: 'single-session-user',
    question: 'What degree did I graduate with?',
    answer: 'Business Administration',
    question_date: '2023/05/30 (Tue) 23:40',
    answer_session_ids: ['answer_1'],
    haystack_dates: ['2023/05/30 (Tue) 17:27', '2023/05/30 (Tue) 18:27'],
    haystack_session_ids: ['distractor_1', 'answer_1'],
    haystack_sessions: [
      [{ role: 'user', content: 'Tell me a puzzle.' }],
      [
        {
          role: 'user',
          content: 'I graduated with a degree in Business Administration.',
          has_answer: true,
        },
        { role: 'assistant', content: 'Congratulations.' },
      ],
    ],
  },
];

const abstentionSample = [
  {
    ...sample[0]!,
    question_id: 'q_abs',
    question: 'What did I say about a nonexistent thing?',
    answer: 'No answer',
    answer_session_ids: [],
  },
];

const multiTypeSample = [
  { ...sample[0]!, question_id: 'u1', question_type: 'single-session-user' },
  { ...sample[0]!, question_id: 'u2', question_type: 'single-session-user' },
  { ...sample[0]!, question_id: 'u3', question_type: 'single-session-user' },
  { ...sample[0]!, question_id: 'm1', question_type: 'multi-session' },
  { ...sample[0]!, question_id: 'm2', question_type: 'multi-session' },
  { ...sample[0]!, question_id: 'm3', question_type: 'multi-session' },
];

describe('prepareLongMemEvalFixture()', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  function makePaths(): { vault: string; goldenSet: string } {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'ohs-longmem-'));
    const fixtures = path.join(tempRoot, 'fixtures');
    const fixtureRoot = path.join(fixtures, 'longmemeval-s');
    return {
      vault: path.join(fixtureRoot, 'dataset'),
      goldenSet: path.join(fixtureRoot, 'golden-set.json'),
    };
  }

  it('writes scoped markdown notes and a native OHS golden set', () => {
    const { vault, goldenSet } = makePaths();

    const result = prepareLongMemEvalFixture({
      data: sample,
      vault,
      goldenSet,
      dataset: 's',
      repoRoot: tempRoot!,
    });

    expect(result).toEqual({
      notesWritten: 2,
      queriesWritten: 1,
      abstentionsSkipped: 0,
    });

    const distractor = readFileSync(path.join(vault, 'q1/0001.md'), 'utf-8');
    const relevant = readFileSync(path.join(vault, 'q1/0002.md'), 'utf-8');
    const golden = JSON.parse(readFileSync(goldenSet, 'utf-8')) as Array<{
      id: string;
      scope: string;
      relevant_paths: string[];
      notes: string;
    }>;

    expect(distractor).toContain('title: Conversation');
    expect(relevant).toContain('longmemeval_session_id: answer_1');
    expect(relevant).toContain('# Conversation');
    expect(relevant).toContain('Date: 2023/05/30 (Tue) 18:27');
    expect(relevant).toContain('## User');
    expect(relevant).toContain('I graduated with a degree in Business Administration.');
    expect(relevant).toContain('## Assistant');
    expect(relevant).toContain('Congratulations.');

    expect(relevant).not.toContain('answer_session_ids');
    expect(relevant).not.toContain('has_answer');
    expect(relevant).not.toContain('Expected answer');
    expect(relevant).not.toContain('What degree did I graduate with?');

    expect(golden).toHaveLength(1);
    expect(golden[0]).toMatchObject({
      id: 'q1',
      scope: 'q1/',
      relevant_paths: ['q1/0002.md'],
    });
    expect(golden[0]!.notes).toContain('answer_positions=2');
    expect(golden[0]!.notes).toContain('session_count=2');
    expect(golden[0]!.notes).toContain('has_answer_role=user');
  });

  it('skips abstention questions by default', () => {
    const { vault, goldenSet } = makePaths();

    const result = prepareLongMemEvalFixture({
      data: abstentionSample,
      vault,
      goldenSet,
      dataset: 's',
      repoRoot: tempRoot!,
    });

    const golden = JSON.parse(readFileSync(goldenSet, 'utf-8')) as unknown[];

    expect(result).toEqual({
      notesWritten: 0,
      queriesWritten: 0,
      abstentionsSkipped: 1,
    });
    expect(golden).toEqual([]);
  });

  it('can include abstention questions when requested', () => {
    const { vault, goldenSet } = makePaths();

    const result = prepareLongMemEvalFixture({
      data: abstentionSample,
      vault,
      goldenSet,
      dataset: 's',
      repoRoot: tempRoot!,
      includeAbstention: true,
    });

    const golden = JSON.parse(readFileSync(goldenSet, 'utf-8')) as Array<{
      id: string;
      relevant_paths: string[];
      notes: string;
    }>;

    expect(result).toEqual({
      notesWritten: 2,
      queriesWritten: 1,
      abstentionsSkipped: 0,
    });
    expect(golden[0]).toMatchObject({
      id: 'q_abs',
      relevant_paths: [],
    });
    expect(golden[0]!.notes).toContain('is_abstention=true');
  });

  it('rejects answer session ids that are missing from the haystack', () => {
    const { vault, goldenSet } = makePaths();

    expect(() =>
      prepareLongMemEvalFixture({
        data: [{ ...sample[0]!, answer_session_ids: ['missing_answer'] }],
        vault,
        goldenSet,
        dataset: 's',
        repoRoot: tempRoot!,
      }),
    ).toThrow(/answer session missing_answer is not in haystack_session_ids/);
  });

  it('refuses to recreate a vault outside fixtures', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'ohs-longmem-'));

    expect(() =>
      prepareLongMemEvalFixture({
        data: sample,
        vault: path.join(tempRoot!, 'not-fixtures/longmemeval-s'),
        goldenSet: path.join(tempRoot!, 'eval/golden-sets/longmemeval-s.json'),
        dataset: 's',
        repoRoot: tempRoot!,
      }),
    ).toThrow(/outside fixtures/);
  });

  it('limits generated queries per question type when maxPerType is set', () => {
    const { vault, goldenSet } = makePaths();

    const result = prepareLongMemEvalFixture({
      data: multiTypeSample,
      vault,
      goldenSet,
      dataset: 's',
      repoRoot: tempRoot!,
      maxPerType: 2,
    });

    const golden = JSON.parse(readFileSync(goldenSet, 'utf-8')) as Array<{ id: string }>;

    expect(result.queriesWritten).toBe(4);
    expect(result.notesWritten).toBe(8);
    expect(golden.map((q) => q.id)).toEqual(['u1', 'u2', 'm1', 'm2']);
  });

  it('prepares the standard LongMemEval-S fixture with repository defaults', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'ohs-longmem-defaults-'));
    const input = path.join(tempRoot, 'data/longmemeval_s_cleaned.json');
    const vault = path.join(tempRoot, 'fixtures/longmemeval-s/dataset');
    const goldenSet = path.join(tempRoot, 'fixtures/longmemeval-s/golden-set.json');
    rmSync(path.dirname(input), { recursive: true, force: true });

    const result = await prepareLongMemEvalSFixture({
      data: sample,
      repoRoot: tempRoot,
    });

    const golden = JSON.parse(readFileSync(goldenSet, 'utf-8')) as Array<{
      id: string;
      scope: string;
    }>;

    expect(result).toEqual({
      notesWritten: 2,
      queriesWritten: 1,
      abstentionsSkipped: 0,
      input,
      vault,
      goldenSet,
      downloaded: false,
    });
    expect(readFileSync(path.join(vault, 'q1/0002.md'), 'utf-8')).toContain(
      'Business Administration',
    );
    expect(golden).toEqual([
      expect.objectContaining({
        id: 'q1',
        scope: 'q1/',
      }),
    ]);
  });
});
