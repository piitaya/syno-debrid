const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

/** Hides secrets that could end up in logged URLs or messages. */
export function redact(text: string): string {
  return text.replace(
    /([?&](?:_sid|sid|passwd|password|apikey|api_key|token|otp_code|device_id)=)[^&\s"]+/gi,
    '$1***',
  );
}

function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: Level, message: string, extra: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const line = [
    new Date().toISOString(),
    level.toUpperCase().padEnd(5),
    message,
    ...extra.map(format),
  ].join(' ');
  const output = redact(line);
  if (level === 'error' || level === 'warn') console.error(output);
  else console.log(output);
}

export const log = {
  debug: (message: string, ...extra: unknown[]) => write('debug', message, extra),
  info: (message: string, ...extra: unknown[]) => write('info', message, extra),
  warn: (message: string, ...extra: unknown[]) => write('warn', message, extra),
  error: (message: string, ...extra: unknown[]) => write('error', message, extra),
};
