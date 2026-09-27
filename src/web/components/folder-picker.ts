import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';
import type { ErrorCode, FolderEntry } from '../../shared/types.js';
import { api, errorInfo } from '../api.js';
import { breakable } from '../format.js';
import { errorMessage, locale, t } from '../i18n.js';
import { mdiAlertCircleOutline, mdiChevronRight, mdiFolderOutline, mdiPlus } from '../icons.js';
import './icon.js';
import type { DdsSheet } from './sheet.js';
import './sheet.js';
import { inlineInputStyles, sharedStyles } from './styles.js';

/**
 * Normalizes a Download Station path like the server does (`/video//Films/` → `video/Films`);
 * empty when invalid.
 */
export function normalizePath(value: string): string {
  const parts = value
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.some((part) => part === '.' || part === '..') ? '' : parts.join('/');
}

const byName = (a: FolderEntry, b: FolderEntry) =>
  a.name.localeCompare(b.name, locale, { numeric: true, sensitivity: 'base' });

/** `video/Films` → `video`, `video` → null (the shared folders). */
const parentPath = (path: string): string | null =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;

/**
 * Browses the NAS folders. Fires `dds-pick` (`CustomEvent<string>`, a Download Station path such
 * as `video/Films`) when a folder is chosen.
 */
@customElement('dds-folder-picker')
export class DdsFolderPicker extends LitElement {
  /** Listed folder; null for the shared folders. */
  @state() private path: string | null = null;
  @state() private folders: FolderEntry[] = [];
  @state() private loading = false;
  @state() private error: ErrorCode | null = null;
  /** The "new folder" row is being edited. */
  @state() private creating = false;
  @state() private newName = '';
  @state() private busy = false;
  /** The folder could not be created. */
  @state() private createError = '';

  @query('dds-sheet') private sheet!: DdsSheet;
  @query('.new-folder input') private newInput?: HTMLInputElement;

  /** Ignores the answers of listings that are no longer wanted. */
  private loadRun = 0;

  /** Opens at `initialPath` when it exists, otherwise at the shared folders. */
  async open(initialPath?: string): Promise<void> {
    const start = normalizePath(initialPath ?? '');
    void this.load(start || null, !!start);
    await this.updateComplete;
    await this.sheet.show();
  }

  /** With `fallBack`, a folder that cannot be listed opens the closest one above it. */
  private async load(path: string | null, fallBack = false): Promise<void> {
    const run = ++this.loadRun;
    this.path = path;
    this.folders = [];
    this.error = null;
    this.loading = true;
    this.creating = false;
    this.newName = '';
    this.createError = '';
    try {
      const listing = await api.folders(path ?? undefined);
      if (run !== this.loadRun) return;
      if (!listing.exists) {
        // Opened on a folder that does not exist yet: starts from the closest one that does.
        if (fallBack && path !== null) return this.load(parentPath(path), true);
        this.error = 'destination_missing';
        this.loading = false;
        return;
      }
      this.path = listing.path;
      this.folders = [...listing.folders].sort(byName);
      this.loading = false;
    } catch (error) {
      if (run !== this.loadRun) return;
      if (fallBack && path !== null) return this.load(null);
      this.error = errorInfo(error).code;
      this.loading = false;
    }
  }

  /** Opens a folder from the list or the breadcrumb, keeping the keyboard focus in the list. */
  private async navigate(path: string | null): Promise<void> {
    const hadFocus = !!this.shadowRoot?.activeElement;
    await this.load(path);
    if (!hadFocus) return;
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>('.group button')?.focus();
  }

  private async startCreating(): Promise<void> {
    this.creating = true;
    await this.updateComplete;
    this.newInput?.focus();
  }

  private stopCreating(): void {
    this.creating = false;
    this.newName = '';
    this.createError = '';
  }

  private async cancelCreating(): Promise<void> {
    this.stopCreating();
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>('.row.accent')?.focus();
  }

  private async create(): Promise<void> {
    const name = this.newName.trim();
    if (!name || this.path === null || this.busy) return;
    this.busy = true;
    this.createError = '';
    try {
      const folder = await api.createFolder(this.path, name);
      this.busy = false;
      await this.navigate(folder.path);
    } catch (error) {
      this.createError = errorMessage(errorInfo(error).code);
    } finally {
      this.busy = false;
    }
  }

  private onNewKeyDown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.create();
    } else if (event.key === 'Escape') {
      // Leaves the dialog open.
      event.preventDefault();
      event.stopPropagation();
      void this.cancelCreating();
    }
  }

  private onNewBlur(): void {
    if (!this.newName.trim() && !this.busy) this.stopCreating();
  }

  private choose(): void {
    if (this.path === null) return;
    this.dispatchEvent(new CustomEvent<string>('dds-pick', { detail: this.path }));
    this.sheet.close();
  }

  override render() {
    return html`
      <dds-sheet
        heading=${t('picker.title')}
        primaryLabel=${t('picker.choose')}
        ?primaryDisabled=${this.path === null || this.loading || !!this.error}
        tall
        .error=${this.createError}
        @dds-primary=${this.choose}
      >
        ${this.renderBreadcrumb()}
        ${
          this.error
            ? html`<div class="notice" role="alert">
                <dds-icon .path=${mdiAlertCircleOutline}></dds-icon>
                <span>${t('picker.error')} ${errorMessage(this.error)}</span>
              </div>`
            : this.renderList()
        }
      </dds-sheet>
    `;
  }

  private renderBreadcrumb() {
    const parts = this.path ? this.path.split('/') : [];
    const crumbs = [
      { label: t('picker.shares'), path: null as string | null },
      ...parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join('/') })),
    ];
    return html`<nav class="crumbs" aria-label=${t('picker.location')}>
      ${crumbs.map((crumb, index) => {
        const separator = index
          ? html`<dds-icon class="separator" .path=${mdiChevronRight}></dds-icon>`
          : nothing;
        if (index === crumbs.length - 1) {
          return html`${separator}<span class="crumb current" aria-current="location"
              >${crumb.label}</span
            >`;
        }
        return html`${separator}<button
            class="btn btn-plain btn-sm crumb"
            @click=${() => this.navigate(crumb.path)}
          >
            <span>${crumb.label}</span>
          </button>`;
      })}
    </nav>`;
  }

  private renderList() {
    return html`<div class="group with-icons" aria-busy=${this.loading ? 'true' : 'false'}>
      ${
        this.loading
          ? html`<div class="row message loading"><span class="spinner"></span></div>`
          : this.folders.length
            ? this.folders.map(
                (folder) =>
                  html`<button class="row" @click=${() => this.navigate(folder.path)}>
                    <span class="row-icon"><dds-icon .path=${mdiFolderOutline}></dds-icon></span>
                    <span class="row-main"
                      ><span class="row-title">${breakable(folder.name)}</span></span
                    >
                    <dds-icon class="chevron" .path=${mdiChevronRight}></dds-icon>
                  </button>`,
              )
            : html`<div class="row message empty">${t('picker.empty')}</div>`
      }
      ${this.path !== null && !this.loading ? this.renderNewFolder() : nothing}
    </div>`;
  }

  private renderNewFolder() {
    if (!this.creating) {
      return html`<button class="row accent" @click=${this.startCreating}>
        <span class="row-icon accent"><dds-icon .path=${mdiPlus}></dds-icon></span>
        <span class="row-main"><span class="row-title">${t('picker.newFolder')}</span></span>
      </button>`;
    }
    return html`<div class="row new-folder">
      <span class="row-icon"><dds-icon .path=${mdiFolderOutline}></dds-icon></span>
      <input
        class="inline-input"
        .value=${live(this.newName)}
        placeholder=${t('picker.newFolderName')}
        aria-label=${t('picker.newFolderName')}
        maxlength="255"
        autocomplete="off"
        @input=${(event: Event) => {
          this.newName = (event.target as HTMLInputElement).value;
          this.createError = '';
        }}
        @keydown=${this.onNewKeyDown}
        @blur=${this.onNewBlur}
      />
      <button
        class="btn btn-sm btn-primary"
        ?disabled=${!this.newName.trim() || this.busy}
        @click=${this.create}
      >
        ${this.busy ? html`<span class="spinner"></span>` : t('picker.create')}
      </button>
    </div>`;
  }

  static override styles = [
    sharedStyles,
    inlineInputStyles,
    css`
      .crumbs {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        min-height: 30px;
        margin: 0 0 8px;
        padding: 0 10px;
      }

      .crumb {
        max-width: 100%;
        padding: 0 6px;
      }

      .crumb span {
        min-width: 0;
        overflow: hidden;
        line-height: 18px;
        text-overflow: ellipsis;
      }

      .crumb.current {
        overflow: hidden;
        line-height: 18px;
        font-size: 13px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Same size as the links next to it (larger buttons on touch screens). */
      @media (pointer: coarse) {
        .crumb.current {
          font-size: 15px;
        }
      }

      .separator {
        --icon-size: 14px;
        color: var(--text-tertiary);
      }

      .row-title {
        overflow-wrap: anywhere;
      }

      .message {
        color: var(--text-secondary);
      }

      /* Aligned with the folder names. */
      .message.empty {
        padding-left: 56px;
      }

      .message.loading {
        justify-content: center;
      }

      .message .spinner {
        color: var(--text-tertiary);
      }

      .new-folder .btn {
        min-width: 64px;
      }

      .new-folder .spinner {
        width: 14px;
        height: 14px;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-folder-picker': DdsFolderPicker;
  }
}
