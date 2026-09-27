import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { JobView } from '../../shared/types.js';
import { api, errorInfo } from '../api.js';
import { errorMessage, t } from '../i18n.js';
import { mdiCheckCircle, mdiChevronRight, mdiCircleOutline, mdiTrayArrowDown } from '../icons.js';
import { store, StoreController } from '../store.js';
import './download-row.js';
import type { DdsDownloadSheet } from './download-sheet.js';
import './download-sheet.js';
import './icon.js';
import { sharedStyles } from './styles.js';

const isFailed = (job: JobView) => job.status === 'error';
const isFinished = (job: JobView) => job.status === 'completed' || job.status === 'cancelled';
const finishedAt = (job: JobView) => job.finishedAt ?? job.updatedAt;

/** Home screen: what is left to set up, failed, running and finished downloads. */
@customElement('dds-downloads-page')
export class DdsDownloadsPage extends LitElement {
  @state() private clearing = false;

  @query('dds-download-sheet') private sheet!: DdsDownloadSheet;

  private clock: ReturnType<typeof setInterval> | undefined;

  constructor() {
    super();
    new StoreController(this);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Keeps « Il y a 5 min » current when nothing else changes.
    this.clock = setInterval(() => {
      for (const row of this.renderRoot.querySelectorAll('dds-download-row')) row.requestUpdate();
    }, 30_000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearInterval(this.clock);
  }

  private async clear(): Promise<void> {
    const ids = store.jobs.filter(isFinished).map((job) => job.id);
    this.clearing = true;
    try {
      await api.clearJobs();
      store.removeJobs(ids);
    } catch (error) {
      store.toast(errorMessage(errorInfo(error).code), 'error');
    } finally {
      this.clearing = false;
    }
  }

  private openAdd(): void {
    this.dispatchEvent(new CustomEvent('dds-open-add', { bubbles: true, composed: true }));
  }

  override render() {
    const settings = store.settings;
    const hasNas = settings ? settings.nas !== null : true;
    const hasProvider = settings?.providers.some((provider) => provider.configured) ?? true;
    const hasDestination = settings ? settings.categories.length > 0 : true;
    const configured = hasNas && hasProvider && hasDestination;

    return html`
      ${configured ? nothing : this.renderChecklist(hasNas, hasProvider, hasDestination)}
      ${store.jobsLoaded ? this.renderJobs(configured) : this.renderLoading()}
      <dds-download-sheet></dds-download-sheet>
    `;
  }

  private renderJobs(configured: boolean) {
    const jobs = store.jobs;
    if (!jobs.length) return configured ? this.renderEmpty() : nothing;

    // Failures first: they wait for a retry or to be removed.
    const failed = jobs.filter(isFailed).sort((a, b) => b.updatedAt - a.updatedAt);
    const active = jobs
      .filter((job) => !isFailed(job) && !isFinished(job))
      .sort((a, b) => b.createdAt - a.createdAt);
    const finished = jobs.filter(isFinished).sort((a, b) => finishedAt(b) - finishedAt(a));
    return html`
      ${this.renderSection(t('downloads.failed'), failed)}
      ${this.renderSection(t('downloads.active'), active)}
      ${this.renderSection(
        t('downloads.finished'),
        finished,
        html`<button class="btn btn-plain" ?disabled=${this.clearing} @click=${this.clear}>
          ${t('downloads.clear')}
        </button>`,
      )}
    `;
  }

  private renderChecklist(hasNas: boolean, hasProvider: boolean, hasDestination: boolean) {
    const step = (done: boolean, title: string) => {
      const icon = html`<span
        class="step-icon"
        role=${done ? 'img' : nothing}
        aria-label=${done ? t('status.completed') : nothing}
      >
        <dds-icon .path=${done ? mdiCheckCircle : mdiCircleOutline}></dds-icon>
      </span>`;
      // What is left to do opens the settings.
      if (done) {
        return html`<div class="row step done">
          ${icon}<span class="row-title">${title}</span>
        </div>`;
      }
      return html`<a class="row step" href="settings">
        ${icon}
        <span class="row-main"><span class="row-title">${title}</span></span>
        <dds-icon class="chevron" .path=${mdiChevronRight}></dds-icon>
      </a>`;
    };
    return html`
      <section class="section">
        <h2 class="section-header">${t('checklist.title')}</h2>
        <div class="group with-icons">
          ${step(hasNas, t('checklist.nas'))} ${step(hasProvider, t('checklist.provider'))}
          ${step(hasDestination, t('checklist.destination'))}
        </div>
        <p class="section-footer">${t('checklist.next')}</p>
      </section>
    `;
  }

  private renderSection(title: string, jobs: JobView[], action: unknown = nothing) {
    if (!jobs.length) return nothing;
    return html`
      <section class="section">
        <div class="section-header">
          <h2>${title} <span class="count num">· ${jobs.length}</span></h2>
          ${action}
        </div>
        <div class="group rows">
          ${repeat(
            jobs,
            (job) => job.id,
            (job) =>
              html`<dds-download-row
                .job=${job}
                @click=${() => void this.sheet.open(job.id)}
              ></dds-download-row>`,
          )}
        </div>
      </section>
    `;
  }

  private renderLoading() {
    return html`<div class="loading" role="status" aria-label=${t('downloads.loading')}>
      <span class="spinner"></span>
    </div>`;
  }

  private renderEmpty() {
    return html`
      <div class="empty">
        <dds-icon class="empty-icon" .path=${mdiTrayArrowDown}></dds-icon>
        <h2 class="empty-title">${t('downloads.empty')}</h2>
        <p class="empty-text">${t('downloads.emptyHint')}</p>
        <button class="btn btn-primary" @click=${this.openAdd}>${t('downloads.add')}</button>
      </div>
    `;
  }

  static override styles = [
    sharedStyles,
    css`
      /* Hairlines between rows, aligned with the text column (16 + 28 icon + 12). */
      .rows > dds-download-row {
        position: relative;
      }

      .rows > dds-download-row + dds-download-row::before {
        content: '';
        position: absolute;
        top: 0;
        right: 0;
        left: 56px;
        z-index: 1;
        height: 1px;
        background: var(--separator);
        transform: scaleY(0.5);
        transform-origin: top;
        pointer-events: none;
      }

      .step-icon {
        display: grid;
        flex: none;
        place-items: center;
        width: 28px;
        height: 28px;
        color: var(--text-tertiary);
      }

      .step-icon dds-icon {
        --icon-size: 24px;
      }

      .step.done .step-icon {
        color: var(--accent);
      }

      .step.done .row-title {
        color: var(--text-secondary);
      }

      /* Only shows when the list takes a while to arrive. */
      .loading {
        display: grid;
        place-items: center;
        min-height: calc(100dvh - 240px);
        color: var(--text-tertiary);
        animation: fade-in 0.3s ease 0.4s both;
      }

      .empty {
        display: grid;
        align-content: center;
        justify-items: center;
        gap: 8px;
        min-height: calc(100dvh - 240px);
        padding: 24px 16px;
        text-align: center;
        animation: fade-in 0.3s ease both;
      }

      .empty-icon {
        --icon-size: 44px;
        margin-bottom: 8px;
        color: var(--text-tertiary);
      }

      .empty-title {
        font-size: 17px;
        font-weight: 600;
      }

      .empty-text {
        max-width: 300px;
        color: var(--text-secondary);
      }

      .empty .btn {
        margin-top: 16px;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-downloads-page': DdsDownloadsPage;
  }
}
