export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] || '').length)),
  );
  const format = (cells: string[]): string =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index])))
      .join('  ');
  return [format(headers), ...rows.map(format)].join('\n');
}
