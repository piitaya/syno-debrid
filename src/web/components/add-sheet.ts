import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { extractMagnets, type MagnetInfo } from '../../shared/magnet.js';
import { parseTorrent } from '../../shared/torrent.js';
import type { Category, ProviderId } from '../../shared/types.js';
import { api, errorInfo } from '../api.js';
import { breakable, formatBytes } from '../format.js';
import { errorMessage, t } from '../i18n.js';
import {
  categoryIcon,
  mdiAlertCircleOutline,
  mdiCheck,
  mdiClose,
  mdiContentPaste,
  mdiFileDocumentOutline,
  mdiLinkVariant,
} from '../icons.js';
import { store, StoreController } from '../store.js';
import './icon.js';
import type { DdsSheet } from './sheet.js';
import './sheet.js';
import { sharedStyles } from './styles.js';

interface TorrentItem {
  id: number;
  file: File;
  name: string;
  size: number;
  fileCount: number;
}

/** The destination last used on this device is chosen again. */
const STORAGE_CATEGORY = 'dds.category';
const MAX_TORRENT_SIZE = 10 * 1024 * 1024;

const readStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing: not remembering the choice is fine.
  }
};

// iOS greys out files whose type it does not know when `accept` is set.
const isIOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

// The async clipboard API only exists on HTTPS (or localhost).
const canReadClipboard = window.isSecureContext && 'clipboard' in navigator;

const hasFinePointer = window.matchMedia('(pointer: fine)').matches;

const shortHash = (hash: string) =>
  hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;

/** Moves within the destinations with the arrow keys. */
const ARROW_STEPS: Record<string, number> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};

/** Lines of the text in which no magnet link (or info-hash) was found. */
const unrecognizedLines = (text: string) =>
  text.split('\n').filter((line) => line.trim() && !extractMagnets(line).magnets.length).length;

@customElement('dds-add-sheet')
export class DdsAddSheet extends LitElement {
  @state() private text = '';
  @state() private torrents: TorrentItem[] = [];
  @state() private categoryId: string | null = null;
  @state() private busy = false;
  /** Files that are not .torrent files. */
  @state() private rejectedFiles: string[] = [];
  /** Why the server refused items, by magnet URI or file name. */
  @state() private failures = new Map<string, string>();
  /** Items added by the last submit that also had failures. */
  @state() private addedCount = 0;
  /** The request itself failed. */
  @state() private error = '';

  @query('dds-sheet') private sheet!: DdsSheet;
  @query('textarea') private textarea?: HTMLTextAreaElement;
  @query('input[type="file"]') private fileInput!: HTMLInputElement;

  private nextId = 1;

  constructor() {
    super();
    new StoreController(this);
  }

  get isOpen(): boolean {
    return this.sheet?.open ?? false;
  }

  /** Opens the sheet, optionally with links or .torrent files to add. */
  async open(options: { text?: string; files?: File[] } = {}): Promise<void> {
    // Opened as soon as created (magnet link in the address): the sheet is not rendered yet.
    await this.updateComplete;
    if (!this.isOpen) {
      this.text = '';
      this.torrents = [];
      this.rejectedFiles = [];
      this.failures = new Map();
      this.addedCount = 0;
      this.error = '';
    }
    if (options.text?.trim()) this.appendText(options.text);
    if (options.files?.length) await this.addFiles(options.files);
    await this.sheet.show();
    if (hasFinePointer && !options.text && !options.files?.length) this.textarea?.focus();
  }

  override updated(): void {
    // The field grows with its content, up to a few lines.
    const field = this.textarea;
    if (field) {
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight, 200)}px`;
    }
  }

  private get configured(): boolean {
    const settings = store.settings;
    return !!settings?.nas && !!this.provider && (settings?.categories.length ?? 0) > 0;
  }

  /** The debrid service, once its API key is set. */
  private get provider(): ProviderId | null {
    return store.settings?.providers.find((provider) => provider.configured)?.id ?? null;
  }

  private get selectedCategory(): Category | null {
    const categories = store.settings?.categories ?? [];
    const id = this.categoryId ?? readStorage(STORAGE_CATEGORY);
    return categories.find((category) => category.id === id) ?? categories[0] ?? null;
  }

  private appendText(value: string): void {
    this.text = this.text.trim() ? `${this.text.trim()}\n${value.trim()}` : value.trim();
  }

  private async paste(): Promise<void> {
    try {
      const value = await navigator.clipboard.readText();
      if (value.trim()) this.appendText(value);
    } catch {
      this.textarea?.focus();
    }
  }

  private async addFiles(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        if (file.size > MAX_TORRENT_SIZE) throw new Error('too big');
        const meta = parseTorrent(new Uint8Array(await file.arrayBuffer()));
        this.torrents = [
          ...this.torrents,
          {
            id: this.nextId++,
            file,
            name: meta.name,
            size: meta.totalSize,
            fileCount: meta.files.length,
          },
        ];
      } catch {
        if (!this.rejectedFiles.includes(file.name)) {
          this.rejectedFiles = [...this.rejectedFiles, file.name];
        }
      }
    }
  }

  private onFileChange(): void {
    void this.addFiles([...(this.fileInput.files ?? [])]);
    this.fileInput.value = '';
  }

  private onTextKeyDown(event: KeyboardEvent): void {
    // Cmd/Ctrl + Enter adds, Enter alone goes to the next line.
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
    event.preventDefault();
    void this.submit();
  }

  private removeMagnet(magnet: MagnetInfo): void {
    this.text = this.text
      .split(/\s+/)
      .filter((token) => token && extractMagnets(token).magnets[0]?.hash !== magnet.hash)
      .join('\n');
  }

  private removeTorrent(torrent: TorrentItem): void {
    this.torrents = this.torrents.filter((item) => item.id !== torrent.id);
  }

  private selectCategory(id: string): void {
    this.categoryId = id;
    writeStorage(STORAGE_CATEGORY, id);
  }

  /** Arrow keys move the choice within the destinations (one tab stop for the group). */
  private async onChoiceKeyDown(event: KeyboardEvent, index: number): Promise<void> {
    const categories = store.settings?.categories ?? [];
    const step = ARROW_STEPS[event.key];
    if (!step || !categories.length) return;
    event.preventDefault();
    const next = categories[(index + step + categories.length) % categories.length]!;
    this.selectCategory(next.id);
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }

  private async submit(): Promise<void> {
    const provider = this.provider;
    const category = this.selectedCategory;
    const { magnets } = extractMagnets(this.text);
    if (this.busy || !provider || !category || (!magnets.length && !this.torrents.length)) return;

    const form = new FormData();
    form.set('provider', provider);
    form.set('categoryId', category.id);
    for (const magnet of magnets) form.append('magnets', magnet.uri);
    for (const torrent of this.torrents) form.append('torrents', torrent.file, torrent.file.name);

    this.busy = true;
    this.error = '';
    this.failures = new Map();
    this.addedCount = 0;
    try {
      const { results } = await api.addJobs(form);
      const failures = new Map<string, string>();
      let added = 0;
      for (const result of results) {
        if (result.ok) {
          store.upsertJob(result.job);
          added++;
        } else {
          failures.set(result.input, errorMessage(result.error.code));
        }
      }

      if (!failures.size) {
        store.toast(t('add.added', { count: added }), 'success');
        this.sheet.close();
        return;
      }
      // Only what failed stays, with the reason, to be removed or sent again.
      this.text = magnets
        .filter((magnet) => failures.has(magnet.uri))
        .map((magnet) => magnet.uri)
        .join('\n');
      this.torrents = this.torrents.filter((torrent) => failures.has(torrent.file.name));
      this.failures = failures;
      this.addedCount = added;
    } catch (error) {
      this.error = errorMessage(errorInfo(error).code);
    } finally {
      this.busy = false;
    }
  }

  /** The request error, or how many items were refused (their reason shows on their row). */
  private sheetError(magnets: MagnetInfo[]): string {
    if (this.error) return this.error;
    const failed =
      magnets.filter((magnet) => this.failures.has(magnet.uri)).length +
      this.torrents.filter((torrent) => this.failures.has(torrent.file.name)).length;
    if (!failed) return '';
    const failedText = t('add.failed', { count: failed });
    return this.addedCount
      ? `${failedText} ${t('add.othersAdded', { count: this.addedCount })}`
      : failedText;
  }

  override render() {
    const { magnets } = extractMagnets(this.text);
    const unrecognized = unrecognizedLines(this.text);
    const count = magnets.length + this.torrents.length;
    const provider = this.provider;
    const category = this.selectedCategory;
    const warnings = [
      ...(unrecognized ? [t('add.invalid', { count: unrecognized })] : []),
      ...this.rejectedFiles.map((name) => t('add.notTorrent', { name })),
    ];

    return html`
      <dds-sheet
        heading=${t('add.title')}
        primaryLabel=${count > 1 ? t('add.submitCount', { count }) : t('add.submit')}
        ?primaryDisabled=${!count || !provider || !category}
        ?busy=${this.busy}
        .error=${this.sheetError(magnets)}
        @dds-primary=${this.submit}
      >
        ${this.configured ? nothing : this.renderNotConfigured()}

        <section class="section">
          <div class="section-header">${t('add.links')}</div>
          <div class="group input-group">
            <textarea
              rows="3"
              placeholder=${t('add.placeholder')}
              aria-label=${t('add.links')}
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              .value=${this.text}
              @input=${(event: InputEvent) => {
                this.text = (event.target as HTMLTextAreaElement).value;
              }}
              @keydown=${this.onTextKeyDown}
            ></textarea>
            <div class="toolbar">
              ${
                canReadClipboard
                  ? html`<button class="btn btn-plain btn-sm" @click=${this.paste}>
                      <dds-icon .path=${mdiContentPaste}></dds-icon>${t('add.paste')}
                    </button>`
                  : nothing
              }
              <button class="btn btn-plain btn-sm" @click=${() => this.fileInput.click()}>
                <dds-icon .path=${mdiFileDocumentOutline}></dds-icon>${t('add.chooseFile')}
              </button>
            </div>
          </div>
          ${
            warnings.length
              ? html`<div class="section-footer warnings" role="status">
                  ${warnings.map((warning) => html`<p>${breakable(warning)}</p>`)}
                </div>`
              : nothing
          }
          <input
            type="file"
            multiple
            accept=${isIOS ? '' : '.torrent,application/x-bittorrent'}
            hidden
            @change=${this.onFileChange}
          />
        </section>

        ${count ? this.renderItems(magnets) : nothing}
        ${this.configured ? this.renderChoices(category) : nothing}
      </dds-sheet>
    `;
  }

  private renderNotConfigured() {
    return html`<div class="section">
      <div class="notice neutral">
        <dds-icon .path=${mdiAlertCircleOutline}></dds-icon>
        <div class="notice-text">
          <p>${t('add.notConfigured')}</p>
          <a href="settings" @click=${() => this.sheet.close()}>${t('common.openSettings')}</a>
        </div>
      </div>
    </div>`;
  }

  private renderItem(
    icon: string,
    name: string,
    detail: unknown,
    failure: string | undefined,
    remove: () => void,
  ) {
    return html`<div class="row item">
      <span class="row-icon"><dds-icon .path=${icon}></dds-icon></span>
      <span class="row-main">
        <span class="row-title item-name">${breakable(name)}</span>
        ${
          failure
            ? html`<span class="row-subtitle failure">${failure}</span>`
            : detail
              ? html`<span class="row-subtitle">${detail}</span>`
              : nothing
        }
      </span>
      <button class="icon-btn remove" aria-label=${t('add.remove')} @click=${remove}>
        <dds-icon .path=${mdiClose}></dds-icon>
      </button>
    </div>`;
  }

  private renderItems(magnets: MagnetInfo[]) {
    return html`<section class="section">
      <div class="group with-icons">
        ${magnets.map((magnet) =>
          this.renderItem(
            mdiLinkVariant,
            magnet.name ?? t('add.unnamed'),
            html`<span class="mono">${shortHash(magnet.hash)}</span>`,
            this.failures.get(magnet.uri),
            () => this.removeMagnet(magnet),
          ),
        )}
        ${this.torrents.map((torrent) =>
          this.renderItem(
            mdiFileDocumentOutline,
            torrent.name,
            html`<span class="num"
              >${formatBytes(torrent.size)} ·
              ${t('downloads.fileCount', { count: torrent.fileCount })}</span
            >`,
            this.failures.get(torrent.file.name),
            () => this.removeTorrent(torrent),
          ),
        )}
      </div>
    </section>`;
  }

  private renderChoices(category: Category | null) {
    const categories = store.settings?.categories ?? [];
    return html`
      <section class="section">
        <div class="section-header">${t('add.destination')}</div>
        <div class="group with-icons" role="radiogroup" aria-label=${t('add.destination')}>
          ${categories.map((item, index) => {
            const checked = item.id === category?.id;
            return html`<button
              class="row"
              role="radio"
              aria-checked=${checked ? 'true' : 'false'}
              tabindex=${checked ? 0 : -1}
              @click=${() => this.selectCategory(item.id)}
              @keydown=${(event: KeyboardEvent) => this.onChoiceKeyDown(event, index)}
            >
              <span class="row-icon"><dds-icon .path=${categoryIcon(item.icon)}></dds-icon></span>
              <span class="row-main">
                <span class="row-title">${item.name}</span>
                <span class="row-subtitle ellipsis">${item.destination}</span>
              </span>
              ${checked ? html`<dds-icon class="check" .path=${mdiCheck}></dds-icon>` : nothing}
            </button>`;
          })}
        </div>
      </section>
    `;
  }

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: contents;
      }

      .section:first-child {
        margin-top: 4px;
      }

      .input-group {
        transition: box-shadow 0.15s ease;
      }

      /* Keyboard and mouse: the group shows where typing goes (touch screens show the keyboard). */
      @media (pointer: fine) {
        .input-group:focus-within {
          box-shadow: var(--focus-ring);
        }
      }

      textarea {
        display: block;
        width: 100%;
        min-height: 92px;
        max-height: 200px;
        padding: 12px 16px;
        border: none;
        font: inherit;
        font-size: 16px;
        line-height: 1.4;
        color: var(--text);
        background: transparent;
        outline: none;
        resize: none;
        word-break: break-all;
      }

      textarea::placeholder {
        color: var(--text-tertiary);
      }

      /* The whole group shows the focus ring. */
      textarea:focus-visible {
        box-shadow: none;
      }

      @media (pointer: fine) {
        textarea {
          font-size: 15px;
        }
      }

      .toolbar {
        position: relative;
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 6px 8px;
      }

      .toolbar::before {
        content: '';
        position: absolute;
        top: 0;
        right: 0;
        left: 16px;
        height: 1px;
        background: var(--separator);
        transform: scaleY(0.5);
      }

      .warnings {
        display: grid;
        gap: 2px;
        color: var(--warning);
      }

      .item {
        padding-right: 4px;
      }

      /* Long release names wrap at dots, on two lines at most. */
      .item-name {
        display: -webkit-box;
        overflow: hidden;
        overflow-wrap: anywhere;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }

      .item .failure {
        color: var(--danger);
      }

      .remove dds-icon {
        --icon-size: 18px;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-add-sheet': DdsAddSheet;
  }
}
