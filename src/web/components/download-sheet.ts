import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import type { JobFileView, JobView } from '../../shared/types.js';
import { api, errorInfo } from '../api.js';
import { breakable, formatBytes, formatPercent } from '../format.js';
import { errorMessage, locale, t } from '../i18n.js';
import { mdiAlertCircleOutline, mdiCheckCircle } from '../icons.js';
import { store, StoreController } from '../store.js';
import { confirmAction } from './confirm.js';
import {
  isActiveJob,
  progressPercent,
  renderProgress,
  renderStatus,
  statusStyles,
} from './download-row.js';
import './icon.js';
import type { DdsSheet } from './sheet.js';
import './sheet.js';
import { sharedStyles } from './styles.js';

const MAX_FILES = 200;

const formatDateTime = (timestamp: number) =>
  new Date(timestamp).toLocaleString(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Details of a download, kept up to date while open. */
@customElement('dds-download-sheet')
export class DdsDownloadSheet extends LitElement {
  @state() private jobId: string | null = null;
  @state() private busy = false;
  /** Error of the last action (retry, stop, remove). */
  @state() private error = '';

  @query('dds-sheet') private sheet!: DdsSheet;

  constructor() {
    super();
    new StoreController(this);
  }

  async open(jobId: string): Promise<void> {
    if (!store.jobs.some((job) => job.id === jobId)) return;
    this.jobId = jobId;
    this.error = '';
    await this.updateComplete;
    await this.sheet.show();
  }

  private get job(): JobView | undefined {
    return store.jobs.find((job) => job.id === this.jobId);
  }

  override willUpdate(): void {
    // Removed meanwhile (cleared, cancelled from another device…): nothing left to show.
    if (this.jobId !== null && !this.job) {
      this.jobId = null;
      this.sheet?.close();
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    try {
      await action();
    } catch (error) {
      this.error = errorMessage(errorInfo(error).code);
    } finally {
      this.busy = false;
    }
  }

  private retry(job: JobView): Promise<void> {
    return this.run(async () => store.upsertJob(await api.retryJob(job.id)));
  }

  private async deleteJob(job: JobView, cancel: boolean): Promise<void> {
    if (
      cancel &&
      !(await confirmAction({
        title: t('downloads.cancelTitle'),
        message: t('downloads.cancelMessage'),
        confirmLabel: t('downloads.cancel'),
      }))
    ) {
      return;
    }
    await this.run(async () => {
      await api.deleteJob(job.id, cancel);
      store.removeJobs([job.id]);
      this.sheet.close();
    });
  }

  override render() {
    const job = this.job;
    // A new panel for each download: it opens scrolled to the top.
    return keyed(
      this.jobId,
      html`<dds-sheet
        heading=${t('downloads.details')}
        .error=${this.error}
        @dds-closed=${() => (this.jobId = null)}
      >
        ${job ? this.renderJob(job) : nothing}
      </dds-sheet>`,
    );
  }

  private renderJob(job: JobView) {
    const percent = progressPercent(job);
    return html`
      <div class="section">
        <div class="group summary">
          <h3 class="name">${breakable(job.name)}</h3>
          <div class="status-row">
            ${renderStatus(job, { reason: !job.error, wrap: true })}
            ${percent ? html`<span class="percent num">${percent}</span>` : nothing}
          </div>
          ${renderProgress(job)}
        </div>
        ${
          job.status === 'waiting_nas'
            ? html`<div class="notice neutral">
                <dds-icon class="warning-text" .path=${mdiAlertCircleOutline}></dds-icon>
                <div class="notice-text">
                  <p>${t('downloads.waitingNas')}</p>
                  <a href="settings" @click=${() => this.sheet.close()}>
                    ${t('common.openSettings')}
                  </a>
                </div>
              </div>`
            : nothing
        }
        ${
          job.error
            ? html`<div class="notice">
                <dds-icon .path=${mdiAlertCircleOutline}></dds-icon>
                <div class="notice-text">
                  <p>${errorMessage(job.error.code)}</p>
                  ${
                    job.error.message
                      ? html`<p class="raw">
                          ${t('common.detail', { message: job.error.message })}
                        </p>`
                      : nothing
                  }
                </div>
              </div>`
            : nothing
        }
      </div>

      <section class="section">
        <div class="group info">
          ${job.categoryName ? this.renderInfo(t('downloads.destination'), job.categoryName) : nothing}
          ${job.size ? this.renderInfo(t('downloads.size'), formatBytes(job.size)) : nothing}
          ${this.renderInfo(t('downloads.added'), formatDateTime(job.createdAt))}
          <div class="row">
            <div class="row-main">
              <span class="row-title">${t('downloads.folder')}</span>
              <span class="row-subtitle mono path">${breakable(job.destination)}</span>
            </div>
          </div>
        </div>
      </section>

      ${job.files.length > 1 ? this.renderFiles(job.files) : nothing}

      <section class="section">
        <div class="group">
          ${
            job.status === 'error'
              ? html`<button
                  class="row action"
                  ?disabled=${this.busy}
                  @click=${() => this.retry(job)}
                >
                  ${t('downloads.retry')}
                </button>`
              : nothing
          }
          ${
            isActiveJob(job)
              ? html`<button
                  class="row destructive"
                  ?disabled=${this.busy}
                  @click=${() => this.deleteJob(job, true)}
                >
                  ${t('downloads.cancel')}
                </button>`
              : html`<button
                  class="row destructive"
                  ?disabled=${this.busy}
                  @click=${() => this.deleteJob(job, false)}
                >
                  ${t('downloads.remove')}
                </button>`
          }
        </div>
      </section>
    `;
  }

  private renderInfo(label: string, value: string) {
    return html`<div class="row">
      <span class="row-title">${label}</span>
      <span class="row-value">${value}</span>
    </div>`;
  }

  private renderFiles(files: JobFileView[]) {
    const shown = files.slice(0, MAX_FILES);
    const more = files.length - shown.length;
    return html`
      <section class="section">
        <h3 class="section-header">
          <span>${t('downloads.files')} <span class="count num">· ${files.length}</span></span>
        </h3>
        <div class="group">
          ${shown.map(
            (file) =>
              html`<div class="row file">
                <div class="row-main">
                  <span class="row-title">${breakable(file.path)}</span>
                  <span class="row-subtitle num">${formatBytes(file.size)}</span>
                </div>
                ${this.renderFileStatus(file)}
              </div>`,
          )}
          ${
            more > 0
              ? html`<div class="row more">${t('downloads.moreFiles', { count: more })}</div>`
              : nothing
          }
        </div>
      </section>
    `;
  }

  private renderFileStatus(file: JobFileView) {
    if (file.status === 'completed') {
      return html`<span class="file-status done" role="img" aria-label=${t('file.completed')}>
        <dds-icon .path=${mdiCheckCircle}></dds-icon>
      </span>`;
    }
    if (file.status === 'error') {
      return html`<span class="file-status danger-text">${t('file.error')}</span>`;
    }
    if (file.status === 'downloading' && file.progress !== null) {
      return html`<span class="file-status percent num">${formatPercent(file.progress)}</span>`;
    }
    return html`<span class="file-status">${t(`file.${file.status}`)}</span>`;
  }

  static override styles = [
    sharedStyles,
    statusStyles,
    css`
      :host {
        display: contents;
      }

      .section > .notice {
        margin-top: 12px;
      }

      .summary {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 4px;
        padding: 14px 16px 16px;
      }

      .summary .name {
        font-size: 17px;
        font-weight: 600;
        line-height: 22px;
        overflow-wrap: anywhere;
        text-wrap: pretty;
      }

      .status-row {
        display: flex;
        align-items: baseline;
        gap: 12px;
      }

      .status-row .status {
        flex: 1;
      }

      .summary .progress {
        margin-top: 8px;
      }

      .notice .raw {
        font-size: 12px;
        color: var(--text-secondary);
        overflow-wrap: anywhere;
      }

      /* Rows that only show information: no touch target to enlarge. */
      .info .row,
      .file,
      .more {
        min-height: 44px;
      }

      .info .row-title {
        flex: 1;
      }

      .info .row-value {
        max-width: 70%;
        text-align: right;
        overflow-wrap: anywhere;
      }

      .path {
        overflow-wrap: anywhere;
      }

      .file .row-title {
        overflow-wrap: anywhere;
        text-wrap: pretty;
      }

      .file-status {
        flex: none;
        font-size: 13px;
        color: var(--text-secondary);
      }

      .file-status.done {
        display: grid;
        color: var(--success);
      }

      .file-status.done dds-icon {
        --icon-size: 20px;
      }

      .file-status.danger-text {
        color: var(--danger);
      }

      .more {
        font-size: 13px;
        color: var(--text-secondary);
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-download-sheet': DdsDownloadSheet;
  }
}
