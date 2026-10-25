/* Present recorded progress once per instruction; keep the underlying history intact. */
(() => {
  const parse = row => {
    const text = String(row.text || '');
    const match = text.match(/^[「“"](.+?)[」”"]\s*(\d+(?:\.\d+)?)s\s*[·•]\s*(.+)$/s) || text.match(/^(.+?)\s+(\d+(?:\.\d+)?)s\s*[·•]\s*(.+)$/s);
    return match ? { prompt: match[1], seconds: Number(match[2]), stage: match[3].trim() } : null;
  };
  window.liveuiActivityEntries = history => {
    const output = [], groups = new Map();
    for (const row of history) {
      const progress = parse(row);
      if (!progress) { output.push(row); if (row._prompt) groups.delete(row._prompt); continue; }
      const previous = groups.get(progress.prompt);
      if (previous) {
        previous.row = row; previous.seconds = Math.max(previous.seconds, progress.seconds);
        if (!previous.stages.includes(progress.stage)) previous.stages.push(progress.stage);
      } else {
        const group = { row, prompt: progress.prompt, seconds: progress.seconds, stages: [progress.stage] };
        groups.set(progress.prompt, group); output.push(group);
      }
    }
    return output.map(entry => {
      if (!entry.stages) return entry;
      const minutes = Math.floor(entry.seconds / 60), seconds = Math.round(entry.seconds % 60);
      const elapsed = minutes ? `${minutes}分${seconds}秒` : `${seconds}秒`;
      return { ...entry.row, kind: 'chat', _prompt: entry.prompt,
        text: `最近记录：${entry.stages.at(-1)} · 耗时 ${elapsed}` + (entry.stages.length > 1 ? `\n阶段：${entry.stages.join(' → ')}` : '') };
    }).reverse();
  };
})();
