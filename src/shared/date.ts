function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function fmtDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - jan4Day + 1 + (week - 1) * 7);
  return monday;
}

function validDateOrNull(year: number, month: number, day: number): string | null {
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }
  return null;
}

export function parseDateFromTitle(title: string): string | null {
  // YYYY-M-D / YYYY.M.D / YYYY/M/D
  const sepMatch = title.match(/(?<!\d)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/);
  if (sepMatch) {
    const result = validDateOrNull(Number(sepMatch[1]), Number(sepMatch[2]), Number(sepMatch[3]));
    if (result) {
      return result;
    }
  }

  // YYYY年M月D日
  const cnMatch = title.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (cnMatch) {
    const result = validDateOrNull(Number(cnMatch[1]), Number(cnMatch[2]), Number(cnMatch[3]));
    if (result) {
      return result;
    }
  }

  // YYYYMMDD
  const compactMatch = title.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (compactMatch) {
    const result = validDateOrNull(Number(compactMatch[1]), Number(compactMatch[2]), Number(compactMatch[3]));
    if (result) {
      return result;
    }
  }

  // YYYY-Www / YYYY-wWW
  const weekMatch = title.match(/\b(\d{4})-[wW](\d{1,2})\b/);
  if (weekMatch) {
    const year = Number(weekMatch[1]);
    const week = Number(weekMatch[2]);
    if (week >= 1 && week <= 53) {
      return fmtDate(isoWeekStart(year, week));
    }
  }

  // YYYY年第W周 / YYYY年W周
  const cnWeekMatch = title.match(/(\d{4})年\s*第?\s*(\d{1,2})\s*周/);
  if (cnWeekMatch) {
    const year = Number(cnWeekMatch[1]);
    const week = Number(cnWeekMatch[2]);
    if (week >= 1 && week <= 53) {
      return fmtDate(isoWeekStart(year, week));
    }
  }

  return null;
}
