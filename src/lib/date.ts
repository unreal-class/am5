export function todayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function currentMonthKey() {
  return todayKey().slice(0, 7);
}

export function currentYearKey() {
  return todayKey().slice(0, 4);
}

export function formatDate(date: string | null | undefined) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(new Date(`${date}T00:00:00`));
}

export function formatTime(dateTime: string | null | undefined) {
  if (!dateTime) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(dateTime));
}

export function elapsedMinutes(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const minutes = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000));
  return minutes;
}

export function formatRate(rate: number) {
  return `${rate.toFixed(1)}%`;
}
