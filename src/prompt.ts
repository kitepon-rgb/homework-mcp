export interface PromptHeaderInput {
  createdAt: Date;
  now: Date;
  body: string;
}

export function buildFiringPrompt({ createdAt, now, body }: PromptHeaderInput): string {
  const elapsed = formatElapsed(now.getTime() - createdAt.getTime());
  const createdAtStr = formatDateTime(createdAt);
  const nowStr = formatDateTime(now);
  return [
    "[homework-mcp からの宿題]",
    "",
    `このタスクは ${createdAtStr} に仕込まれたものです。`,
    `現在は ${nowStr} で、${elapsed}経過しています。`,
    "コードベース・状況が変わっている可能性が高いため、",
    "着手前に必ず現状を確認してください。",
    "",
    "---",
    body,
  ].join("\n");
}

function formatDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatElapsed(ms: number): string {
  if (ms < 0) return "0 分";
  const totalMinutes = Math.floor(ms / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 日と ${hours} 時間`;
  if (hours > 0) return `${hours} 時間と ${minutes} 分`;
  return `${minutes} 分`;
}
