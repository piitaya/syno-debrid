import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { ACTIVE_JOB_STATUSES, PROVIDERS, type JobView } from '../../shared/types.js';
import { breakable, formatBytes, formatPercent, formatRelative, formatSpeed } from '../format.js';
import { errorMessage, t } from '../i18n.js';
import { categoryIcon, mdiCheckCircle, mdiChevronRight } from '../icons.js';
import './icon.js';
import { sharedStyles } from './styles.js';

/*
 * Status helpers shared by the downloads list and the details sheet. Components that render
 * `renderStatus()` or `renderProgress()` include `statusStyles`.
 */

type StatusTone = 'neutral' | 'success' | 'warning' | 'danger';

/** Still running (a failed job is not). */
export const isActiveJob = (job: JobView): boolean => ACTIVE_JOB_STATUSES.includes(job.status);

function statusTone(job: JobView): StatusTone {
  switch (job.status) {
    case 'completed':
      return 'success';
    case 'waiting_nas':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
}

interface StatusOptions {
  /** Appends the error message to « Échec » (off when a notice already shows it). */
  reason?: boolean;
}

/**
 * What the job is doing, as segments shown « a · b · c »: the first one says the state, the
 * others add numbers (sizes, speed, sources) that can be left out when space runs short.
 */
function statusParts(job: JobView, { reason = true }: StatusOptions = {}): string[] {
  const provider = PROVIDERS[job.provider].name;
  let parts: string[];
  switch (job.status) {
    case 'debrid': {
      const queued = job.detail === 'queued';
      parts = [
        queued ? t('status.queued', { provider }) : t('status.debrid', { provider }),
        formatSpeed(job.speed),
        // Services report 0 sources while a torrent is queued: only meaningful afterwards.
        job.seeders !== null && !queued ? t('status.seeders', { count: job.seeders }) : '',
      ];
      break;
    }
    case 'sending':
      parts = [t('status.sending')];
      break;
    case 'waiting_nas':
      parts = [t('status.waitingNas')];
      break;
    case 'downloading': {
      const total = job.files.length;
      const done = job.files.filter((file) => file.status === 'completed').length;
      parts = [
        total > 1 ? t('status.files', { done, total }) : '',
        // Nothing received yet: « 0 o sur 7,8 Go » says less than the phase name below.
        job.size && job.progress
          ? t('downloads.of', {
              done: formatBytes(job.size * job.progress),
              total: formatBytes(job.size),
            })
          : '',
        formatSpeed(job.speed),
      ];
      if (!parts.some(Boolean)) parts = [t('status.downloading')];
      break;
    }
    case 'completed':
      parts = [
        t('status.completed'),
        formatBytes(job.size),
        job.finishedAt ? formatRelative(job.finishedAt) : '',
      ];
      break;
    case 'cancelled':
      parts = [t('status.cancelled')];
      break;
    case 'error':
      // One segment: a long reason is cut with an ellipsis rather than left out. No final period.
      parts = [
        reason
          ? `${t('status.failed')} · ${errorMessage(job.error?.code).replace(/\.$/, '')}`
          : t('status.failed'),
      ];
      break;
  }
  return parts.filter(Boolean);
}

/**
 * Progress bar of a running job: a fraction, 'indeterminate', or null when it has none.
 * A job waiting for Download Station gets a still bar: nothing is moving.
 */
function jobProgress(job: JobView): number | 'indeterminate' | null {
  if (!isActiveJob(job)) return null;
  if (job.status === 'waiting_nas') return job.progress ?? 0;
  if (job.status === 'sending' || job.progress === null) return 'indeterminate';
  return job.progress;
}

/** « 42 % » for a running job with a known progress, '' otherwise. */
export function progressPercent(job: JobView): string {
  const progress = jobProgress(job);
  return typeof progress === 'number' && job.progress !== null ? formatPercent(progress) : '';
}

/**
 * Status line. On one line (lists), the trailing segments that do not fit are left out whole and
 * the first one is cut with an ellipsis. With `wrap`, lines break inside the first segment or
 * between segments (never inside « 184 sources »), the dots ending the lines.
 */
export function renderStatus(
  job: JobView,
  options: StatusOptions & { wrap?: boolean } = {},
): TemplateResult {
  const tone = statusTone(job);
  const parts = statusParts(job, options);
  const last = parts.length - 1;
  const segments = options.wrap
    ? parts.map(
        (part, index) =>
          html`${index ? ' ' : ''}<span>${part}${index < last ? '\u00a0·' : ''}</span>`,
      )
    : parts.map((part, index) => html`<span>${index ? `· ${part}` : part}</span>`);
  return html`<span class="status ${tone}">
    ${
      tone === 'success'
        ? html`<dds-icon class="status-icon" .path=${mdiCheckCircle}></dds-icon>`
        : nothing
    }
    <span class="status-text ${options.wrap ? 'wrap' : ''}">${segments}</span>
  </span>`;
}

/**
 * Progress bar. While the debrid service fetches the torrent the bar is grey: the blue one that
 * follows, for the download to the NAS, starts again from zero.
 */
export function renderProgress(job: JobView): TemplateResult | typeof nothing {
  const progress = jobProgress(job);
  if (progress === null) return nothing;
  const remote = job.status === 'debrid' ? 'remote' : '';
  if (progress === 'indeterminate') {
    return html`<span class="progress indeterminate ${remote}"><span></span></span>`;
  }
  return html`<span class="progress ${remote}">
    <span style=${styleMap({ width: `${Math.min(1, Math.max(0, progress)) * 100}%` })}></span>
  </span>`;
}

export const statusStyles = css`
  .status {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    font-size: 13px;
    line-height: 18px;
    color: var(--text-secondary);
  }

  /* Segments that do not fit wrap onto a second line, which is clipped. */
  .status-text {
    display: flex;
    flex-wrap: wrap;
    column-gap: 0.3em;
    height: 18px;
    min-width: 0;
    overflow: hidden;
  }

  .status-text > span {
    flex: none;
    white-space: nowrap;
  }

  .status-text > span:first-child {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-text.wrap {
    display: block;
    height: auto;
    overflow-wrap: anywhere;
  }

  .status-text.wrap > span:first-child {
    white-space: normal;
  }

  .status.warning {
    color: var(--warning);
  }

  .status.danger {
    color: var(--danger);
  }

  .status-icon {
    --icon-size: 15px;
    color: var(--success);
  }

  .progress {
    display: block;
  }

  .progress.remote > span {
    background: var(--text-secondary);
  }

  .percent {
    flex: none;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
  }
`;

/** A download in the list: category icon, name, status line, progress, chevron. */
@customElement('dds-download-row')
export class DdsDownloadRow extends LitElement {
  @property({ attribute: false }) job!: JobView;

  override render() {
    const job = this.job;
    return html`
      <button class="row" aria-haspopup="dialog">
        <span class="row-icon"><dds-icon .path=${categoryIcon(job.categoryIcon)}></dds-icon></span>
        <span class="main">
          <span class="name">${breakable(job.name)}</span>
          ${renderStatus(job)} ${renderProgress(job)}
        </span>
        ${
          jobProgress(job) === null
            ? nothing
            : html`<span class="percent num">${progressPercent(job)}</span>`
        }
        <dds-icon class="chevron" .path=${mdiChevronRight}></dds-icon>
      </button>
    `;
  }

  static override styles = [
    sharedStyles,
    statusStyles,
    css`
      .row {
        padding: 10px 16px;
      }

      .main {
        display: grid;
        flex: 1;
        grid-template-columns: minmax(0, 1fr);
        gap: 2px;
        min-width: 0;
      }

      .name {
        display: -webkit-box;
        overflow: hidden;
        font-size: 15px;
        font-weight: 500;
        line-height: 20px;
        overflow-wrap: anywhere;
        /* Keeps a short last part (« mkv ») from ending up alone on a line. */
        text-wrap: pretty;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }

      .main .progress {
        margin: 6px 0 2px;
      }

      /*
       * Same width on every row with a bar (even without a figure), so the bars line up. Sized
       * for two digits: « 100 % » only shows for a moment.
       */
      .percent {
        min-width: 2.3em;
        margin-left: -4px;
        text-align: right;
      }

      .percent + .chevron {
        margin-left: -4px;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-download-row': DdsDownloadRow;
  }
}
