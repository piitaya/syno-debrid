import { html, type TemplateResult } from 'lit';
import { locale, t } from './i18n.js';

const UNITS =
  locale === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'] : ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

const number = (value: number, digits: number) =>
  value.toLocaleString(locale, { maximumFractionDigits: digits });

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '';
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${number(value, value >= 100 || unit === 0 ? 0 : 1)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(progress: number | null | undefined): string {
  if (progress === null || progress === undefined) return '';
  const value = Math.floor(Math.min(1, Math.max(0, progress)) * 100);
  // French puts a narrow no-break space before the percent sign.
  return locale === 'fr' ? `${value}\u202f%` : `${value}%`;
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - timestamp) / 1000);
  if (seconds < 60) return t('time.now');
  if (seconds < 3600) return t('time.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('time.hours', { count: Math.floor(seconds / 3600) });
  return t('time.days', { count: Math.floor(seconds / 86400) });
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Lets long release names (`Show.S01E02.1080p.WEB`) wrap after dots, dashes and slashes. */
export function breakable(text: string): (string | TemplateResult)[] {
  const parts: (string | TemplateResult)[] = [];
  let current = '';
  for (const char of text) {
    current += char;
    if (char === '.' || char === '_' || char === '-' || char === '/') {
      parts.push(current, html`<wbr />`);
      current = '';
    }
  }
  if (current) parts.push(current);
  return parts;
}
