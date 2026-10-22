export interface CronField {
  wildcard: boolean;
  values: Set<number>;
}

export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export function nextCronDate(expression: string, after = new Date()): Date | null {
  const schedule = parseCronExpression(expression);
  if (!schedule) return null;

  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matchesCron(schedule, candidate)) return new Date(candidate.getTime());
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

export function parseCronExpression(expression: string): CronSchedule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const parsed = {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(dayOfWeek, 0, 7, (value) => (value === 7 ? 0 : value)),
  };
  if (!parsed.minute || !parsed.hour || !parsed.dayOfMonth || !parsed.month || !parsed.dayOfWeek)
    return null;
  return parsed as CronSchedule;
}

function parseCronField(
  expr: string,
  min: number,
  max: number,
  normalize: (value: number) => number = (value) => value,
): CronField | null {
  if (!expr) return null;
  const values = new Set<number>();
  const parts = expr.split(',');
  let wildcard = false;
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part === '*') {
      wildcard = true;
      addRange(values, min, max, normalize);
      continue;
    }
    if (part.startsWith('*/')) {
      const step = Number(part.slice(2));
      if (!Number.isInteger(step) || step <= 0) return null;
      for (let value = min; value <= max; value += step) values.add(normalize(value));
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value < min || value > max) return null;
    values.add(normalize(value));
  }
  return values.size ? { wildcard, values } : null;
}

function addRange(
  values: Set<number>,
  min: number,
  max: number,
  normalize: (value: number) => number,
): void {
  for (let value = min; value <= max; value++) values.add(normalize(value));
}

function matchesCron(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minute.values.has(date.getMinutes())) return false;
  if (!schedule.hour.values.has(date.getHours())) return false;
  if (!schedule.month.values.has(date.getMonth() + 1)) return false;

  const domMatches = schedule.dayOfMonth.values.has(date.getDate());
  const dowMatches = schedule.dayOfWeek.values.has(date.getDay());
  if (schedule.dayOfMonth.wildcard && schedule.dayOfWeek.wildcard) return true;
  if (schedule.dayOfMonth.wildcard) return dowMatches;
  if (schedule.dayOfWeek.wildcard) return domMatches;
  return domMatches || dowMatches;
}
