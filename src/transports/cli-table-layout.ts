const TABLE_BORDER_WIDTH = 1;
const TABLE_COLUMN_SEPARATOR_WIDTH = 1;
const MIN_PATH_WIDTH = 20;
const MIN_SNIPPET_WIDTH = 28;
const MIN_META_WIDTH = 16;

interface SearchTableLayoutOptions {
  extended: boolean;
  filterOnlyMode: boolean;
  hasSnippets: boolean;
  terminalColumns?: number;
}

interface FlexibleColumn {
  preferred: number;
  min: number;
  weight: number;
}

export interface SearchTableLayout {
  colWidths: number[];
  pathColumnIndex: number;
  pathColumnWidth: number;
  snippetColumnIndex?: number;
  snippetColumnWidth?: number;
}

function roundWidthsToTarget(widths: number[], target: number, minWidths: number[]): number[] {
  const base = widths.map((width, index) => Math.max(minWidths[index]!, Math.floor(width)));
  let remainder = target - base.reduce((sum, width) => sum + width, 0);

  if (remainder <= 0) return base;

  const fractions = widths
    .map((width, index) => ({ index, fraction: width - Math.floor(width) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (const { index } of fractions) {
    if (remainder <= 0) break;
    base[index] = base[index]! + 1;
    remainder -= 1;
  }

  return base;
}

function getAvailableFlexibleWidth(
  terminalColumns: number | undefined,
  totalColumns: number,
  fixedWidth: number,
  preferredFlexibleWidth: number,
): number {
  if (!terminalColumns || terminalColumns <= 0) return preferredFlexibleWidth;

  const separatorWidth = TABLE_BORDER_WIDTH + totalColumns * TABLE_COLUMN_SEPARATOR_WIDTH;
  return terminalColumns - fixedWidth - separatorWidth;
}

function distributeFlexibleWidths(available: number, columns: FlexibleColumn[]): number[] {
  const preferred = columns.map((column) => column.preferred);
  const minWidths = columns.map((column) => column.min);
  const preferredTotal = preferred.reduce((sum, width) => sum + width, 0);
  const minTotal = minWidths.reduce((sum, width) => sum + width, 0);

  if (available <= minTotal) return minWidths;
  if (available >= preferredTotal) {
    const extra = available - preferredTotal;
    const totalWeight = columns.reduce((sum, column) => sum + column.weight, 0);
    const widths = preferred.map(
      (width, index) => width + extra * (columns[index]!.weight / totalWeight),
    );
    return roundWidthsToTarget(widths, available, minWidths);
  }

  const widths = [...preferred];
  let remainingShrink = preferredTotal - available;
  let shrinkable = columns.map((column, index) => ({
    index,
    capacity: preferred[index]! - column.min,
    weight: column.weight,
  }));

  while (remainingShrink > 0.0001 && shrinkable.length > 0) {
    const totalWeight = shrinkable.reduce((sum, item) => sum + item.weight, 0);
    let consumed = 0;

    for (const item of shrinkable) {
      const share = remainingShrink * (item.weight / totalWeight);
      const shrink = Math.min(item.capacity, share);
      widths[item.index] = widths[item.index]! - shrink;
      item.capacity -= shrink;
      consumed += shrink;
    }

    remainingShrink -= consumed;
    shrinkable = shrinkable.filter((item) => item.capacity > 0.0001);

    if (consumed <= 0.0001) break;
  }

  return roundWidthsToTarget(widths, available, minWidths);
}

function middleEllipsis(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 3) return '.'.repeat(Math.max(0, maxLen));

  const visible = maxLen - 3;
  const start = Math.ceil(visible / 2);
  const end = Math.floor(visible / 2);
  return `${text.slice(0, start)}...${text.slice(text.length - end)}`;
}

function truncateDirectoryPart(directory: string, maxLen: number): string {
  if (directory.length <= maxLen) return directory;
  if (maxLen <= 3) return '.'.repeat(Math.max(0, maxLen));

  const segments = directory.split('/').filter(Boolean);
  if (segments.length === 0) return middleEllipsis(directory, maxLen);

  const first = segments[0]!;
  if (`${first}/...`.length > maxLen) return middleEllipsis(directory, maxLen);

  let suffix = '';
  for (let i = segments.length - 1; i >= 1; i--) {
    const candidate = `${first}/.../${segments.slice(i).join('/')}`;
    if (candidate.length <= maxLen) {
      suffix = segments.slice(i).join('/');
      break;
    }
  }

  return suffix ? `${first}/.../${suffix}` : `${first}/...`;
}

/** Preserve the full note filename when possible; collapse directory segments first. */
export function truncatePathMiddle(notePath: string, maxLen: number): string {
  if (notePath.length <= maxLen) return notePath;
  if (maxLen <= 3) return '.'.repeat(Math.max(0, maxLen));

  const slashIndex = notePath.lastIndexOf('/');
  if (slashIndex === -1) return middleEllipsis(notePath, maxLen);

  const fileName = notePath.slice(slashIndex + 1);
  const directory = notePath.slice(0, slashIndex);

  if (fileName.length <= maxLen) {
    if (`.../${fileName}`.length > maxLen) return fileName;
    const directoryMaxLen = maxLen - fileName.length - 1;
    if (directoryMaxLen <= 0) return fileName;

    const shortenedDirectory = truncateDirectoryPart(directory, directoryMaxLen);
    return `${shortenedDirectory}/${fileName}`;
  }

  return fileName;
}

function splitLongSegment(segment: string, maxLen: number): string[] {
  if (maxLen <= 1 || segment.length <= maxLen) return [segment];

  const parts: string[] = [];
  let remaining = segment;

  while (remaining.length > maxLen) {
    const candidate = remaining.slice(0, maxLen);
    const breakAt = candidate.lastIndexOf(' ');
    const cut = breakAt > Math.floor(maxLen * 0.6) ? breakAt : maxLen;
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

/**
 * Wrap a path across multiple table lines, preferring breaks at `/` so directory
 * context stays intact instead of being replaced with ellipses.
 */
export function wrapPathForTable(notePath: string, maxLen: number): string {
  if (maxLen <= 1 || notePath.length <= maxLen) return notePath;

  const segments = notePath.split('/');
  const lines: string[] = [];
  let current = '';

  for (const segment of segments) {
    const segmentParts = splitLongSegment(segment, maxLen);
    for (let i = 0; i < segmentParts.length; i++) {
      const part = segmentParts[i]!;
      const token = current.length === 0 ? part : `${current}/${part}`;
      const isSegmentContinuation = i < segmentParts.length - 1;

      if (token.length <= maxLen) {
        current = token;
        if (isSegmentContinuation) {
          lines.push(current);
          current = '';
        }
        continue;
      }

      if (current.length > 0) lines.push(current);
      current = part;

      if (isSegmentContinuation) {
        lines.push(current);
        current = '';
      }
    }
  }

  if (current.length > 0) lines.push(current);
  return lines.join('\n');
}

export function formatSnippetForTable(snippet: string, columnWidth: number): string {
  const normalized = snippet
    .replace(/\t/g, ' ')
    .replace(/\r?\n+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();

  if (!normalized) return '';

  const maxLen = Math.max(columnWidth * 3, 72);
  if (normalized.length <= maxLen) return normalized;

  const cut = normalized.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > columnWidth ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

export function getSearchTableLayout({
  extended,
  filterOnlyMode,
  hasSnippets,
  terminalColumns,
}: SearchTableLayoutOptions): SearchTableLayout {
  if (filterOnlyMode) {
    const colWidths = [Math.max(70, getAvailableFlexibleWidth(terminalColumns, 1, 0, 70))];
    return {
      colWidths,
      pathColumnIndex: 0,
      pathColumnWidth: colWidths[0]!,
    };
  }

  if (extended && hasSnippets) {
    const fixed = 7;
    const flexible = distributeFlexibleWidths(
      getAvailableFlexibleWidth(terminalColumns, 4, fixed, 38 + 20 + 47),
      [
        { min: MIN_PATH_WIDTH, preferred: 38, weight: 1.5 },
        { min: MIN_META_WIDTH, preferred: 20, weight: 0.8 },
        { min: MIN_SNIPPET_WIDTH, preferred: 47, weight: 1.7 },
      ],
    );
    const colWidths = [7, ...flexible];
    return {
      colWidths,
      pathColumnIndex: 1,
      pathColumnWidth: colWidths[1]!,
      snippetColumnIndex: 3,
      snippetColumnWidth: colWidths[3]!,
    };
  }

  if (extended) {
    const fixed = 7;
    const flexible = distributeFlexibleWidths(
      getAvailableFlexibleWidth(terminalColumns, 3, fixed, 50 + 25),
      [
        { min: MIN_PATH_WIDTH, preferred: 50, weight: 1.6 },
        { min: MIN_META_WIDTH, preferred: 25, weight: 1.0 },
      ],
    );
    const colWidths = [7, ...flexible];
    return {
      colWidths,
      pathColumnIndex: 1,
      pathColumnWidth: colWidths[1]!,
    };
  }

  if (hasSnippets) {
    const fixed = 7;
    const flexible = distributeFlexibleWidths(
      getAvailableFlexibleWidth(terminalColumns, 3, fixed, 45 + 60),
      [
        { min: MIN_PATH_WIDTH, preferred: 45, weight: 1.4 },
        { min: MIN_SNIPPET_WIDTH, preferred: 60, weight: 1.8 },
      ],
    );
    const colWidths = [7, ...flexible];
    return {
      colWidths,
      pathColumnIndex: 1,
      pathColumnWidth: colWidths[1]!,
      snippetColumnIndex: 2,
      snippetColumnWidth: colWidths[2]!,
    };
  }

  const fixed = 7;
  const flexible = distributeFlexibleWidths(
    getAvailableFlexibleWidth(terminalColumns, 2, fixed, 60),
    [{ min: MIN_PATH_WIDTH, preferred: 60, weight: 1 }],
  );
  const colWidths = [7, ...flexible];
  return {
    colWidths,
    pathColumnIndex: 1,
    pathColumnWidth: colWidths[1]!,
  };
}
