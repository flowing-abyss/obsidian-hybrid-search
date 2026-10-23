import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  formatSnippetForTable,
  getSearchTableLayout,
  truncatePathMiddle,
  wrapPathForTable,
} from '../src/transports/cli-table-layout.js';

describe('truncatePathMiddle', () => {
  it('preserves the filename when shortening a long path', () => {
    const original = '40-Netolly/Sync/Biweekly/2026-04-17/deck/xxxxx-tracks-summary.md';
    const truncated = truncatePathMiddle(original, 45);

    assert.ok(truncated.startsWith('40-Netolly/'));
    assert.ok(truncated.includes('.../'));
    assert.ok(truncated.endsWith('xxxxx-tracks-summary.md'));
    assert.ok(truncated.length <= 45);
  });

  it('drops directories entirely before touching the filename itself', () => {
    const original = 'folder/some-extremely-long-file-name-that-cannot-fit-intact.md';
    const truncated = truncatePathMiddle(original, 24);

    assert.equal(truncated, 'some-extremely-long-file-name-that-cannot-fit-intact.md');
  });
});

describe('wrapPathForTable', () => {
  it('wraps long paths at directory separators instead of inserting ellipses', () => {
    const wrapped = wrapPathForTable(
      'base/notes/вектор расстояний (алгоритм маршрутизации пакетов).md',
      28,
    );

    assert.equal(wrapped, 'base/notes\nвектор расстояний (алгоритм\nмаршрутизации пакетов).md');
  });
});

describe('getSearchTableLayout', () => {
  it('expands PATH width in no-snippet mode when terminal width allows it', () => {
    const layout = getSearchTableLayout({
      extended: false,
      filterOnlyMode: false,
      hasSnippets: false,
      terminalColumns: 120,
    });

    assert.deepEqual(layout.colWidths, [7, 110]);
    assert.equal(layout.pathColumnIndex, 1);
    assert.equal(layout.pathColumnWidth, 110);
  });

  it('keeps default widths when snippets are present', () => {
    const layout = getSearchTableLayout({
      extended: false,
      filterOnlyMode: false,
      hasSnippets: true,
      terminalColumns: 140,
    });

    assert.deepEqual(layout.colWidths, [7, 56, 73]);
    assert.equal(layout.pathColumnWidth, 56);
  });

  it('shrinks PATH and SNIPPET columns to fit a narrower terminal', () => {
    const layout = getSearchTableLayout({
      extended: false,
      filterOnlyMode: false,
      hasSnippets: true,
      terminalColumns: 90,
    });

    assert.deepEqual(layout.colWidths, [7, 34, 45]);
    assert.equal(layout.pathColumnWidth, 34);
    assert.equal(layout.snippetColumnWidth, 45);
  });

  it('uses extra terminal width instead of leaving empty space on the right', () => {
    const layout = getSearchTableLayout({
      extended: false,
      filterOnlyMode: false,
      hasSnippets: true,
      terminalColumns: 200,
    });

    assert.deepEqual(layout.colWidths, [7, 82, 107]);
    assert.equal(layout.pathColumnWidth, 82);
    assert.equal(layout.snippetColumnWidth, 107);
  });
});

describe('formatSnippetForTable', () => {
  it('collapses multiline markdown-ish snippets into compact CLI text', () => {
    const formatted = formatSnippetForTable(
      '**vector()**\n\n```R\nx <- vector(length = 2)\nx[1] <- 5\nx[2] <- 8\n```\n<!--ID: 123-->',
      30,
    );

    assert.equal(
      formatted,
      '**vector()** ```R x <- vector(length = 2) x[1] <- 5 x[2] <- 8 ``` <!--ID: 123-->',
    );
  });

  it('truncates compacted snippets to a few wrapped CLI lines', () => {
    const formatted = formatSnippetForTable(
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau',
      20,
    );

    assert.ok(formatted.endsWith('...'));
    assert.ok(formatted.length <= 75);
  });
});
