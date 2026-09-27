import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { t } from '../i18n.js';
import {
  mdiAlertCircle,
  mdiCheckCircle,
  mdiChevronLeft,
  mdiCogOutline,
  mdiInformation,
  mdiPlus,
  mdiTrayArrowDown,
} from '../icons.js';
import { store, StoreController } from '../store.js';
import type { DdsAddSheet } from './add-sheet.js';
import './add-sheet.js';
import './downloads-page.js';
import './icon.js';
import './login-page.js';
import './logo.js';
import './settings-page.js';
import './setup-page.js';
import { sharedStyles } from './styles.js';

type Route = 'downloads' | 'settings';

const routeFromHash = (): Route =>
  location.hash.startsWith('#/settings') ? 'settings' : 'downloads';

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** Magnet link passed in the URL (`?magnet=`) by the browser's magnet handler. */
function takeUrlMagnet(): string | null {
  const magnet = new URLSearchParams(location.search).get('magnet');
  if (magnet) history.replaceState(null, '', location.pathname);
  return magnet;
}

@customElement('dds-app')
export class DdsApp extends LitElement {
  @state() private route: Route = routeFromHash();
  @state() private dragging = false;

  @query('dds-add-sheet') private addSheet?: DdsAddSheet;

  private pendingMagnet = takeUrlMagnet();
  private dragDepth = 0;

  constructor() {
    super();
    new StoreController(this);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.onHashChange);
    window.addEventListener('dragenter', this.onDragEnter);
    window.addEventListener('dragover', this.onDragOver);
    window.addEventListener('dragleave', this.onDragLeave);
    window.addEventListener('drop', this.onDrop);
    window.addEventListener('paste', this.onPaste);
    this.addEventListener('dds-open-add', this.onOpenAdd);
    void store.init();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.onHashChange);
    window.removeEventListener('dragenter', this.onDragEnter);
    window.removeEventListener('dragover', this.onDragOver);
    window.removeEventListener('dragleave', this.onDragLeave);
    window.removeEventListener('drop', this.onDrop);
    window.removeEventListener('paste', this.onPaste);
    this.removeEventListener('dds-open-add', this.onOpenAdd);
  }

  override updated(): void {
    // A magnet link from the URL opens the add sheet once signed in.
    if (this.pendingMagnet && store.session && store.settings && this.addSheet) {
      const magnet = this.pendingMagnet;
      this.pendingMagnet = null;
      void this.addSheet.open({ text: magnet });
    }
  }

  private readonly onHashChange = () => {
    this.route = routeFromHash();
    window.scrollTo({ top: 0 });
  };

  private readonly onOpenAdd = () => {
    void this.addSheet?.open();
  };

  private get canAdd(): boolean {
    return !!store.session && this.route === 'downloads' && !!this.addSheet;
  }

  // Dropping .torrent files anywhere opens the add sheet with them.
  private readonly onDragEnter = (event: DragEvent) => {
    if (!this.canAdd || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragDepth++;
    this.dragging = true;
  };

  private readonly onDragOver = (event: DragEvent) => {
    if (!this.canAdd || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  private readonly onDragLeave = () => {
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragging = false;
  };

  private readonly onDrop = (event: DragEvent) => {
    this.dragDepth = 0;
    this.dragging = false;
    if (!this.canAdd || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    void this.addSheet!.open({ files: [...event.dataTransfer.files] });
  };

  /** Pasting outside of a field (desktop) opens the add sheet with the clipboard content. */
  private readonly onPaste = (event: ClipboardEvent) => {
    if (!this.canAdd || this.addSheet!.isOpen) return;
    if (isEditable(event.composedPath()[0] ?? null)) return;
    const files = [...(event.clipboardData?.files ?? [])];
    const text = event.clipboardData?.getData('text') ?? '';
    if (!files.length && !text.trim()) return;
    event.preventDefault();
    void this.addSheet!.open({ text, files });
  };

  private navigate(route: Route): void {
    location.hash = route === 'settings' ? '#/settings' : '#/';
  }

  override render() {
    if (!store.ready) {
      return html`<div class="splash">
        <dds-logo size="56"></dds-logo>
        ${store.online ? nothing : html`<p class="splash-status">${t('common.offline')}</p>`}
      </div>`;
    }
    if (!store.session) {
      return html`${
        store.signedOutReason === 'setup_required'
          ? html`<dds-setup-page></dds-setup-page>`
          : html`<dds-login-page></dds-login-page>`
      }${this.renderToasts()}`;
    }

    const settings = this.route === 'settings';
    return html`
      <header class="bar">
        <div class="bar-inner">
          <div class="leading">
            ${
              settings
                ? html`<button
                    class="icon-btn accent back"
                    aria-label=${t('nav.back')}
                    @click=${() => this.navigate('downloads')}
                  >
                    <dds-icon .path=${mdiChevronLeft}></dds-icon>
                  </button>`
                : html`<dds-logo size="26"></dds-logo>`
            }
          </div>
          <h1>${settings ? t('nav.settings') : t('nav.downloads')}</h1>
          ${
            settings
              ? nothing
              : html`
                  <button
                    class="icon-btn"
                    aria-label=${t('nav.settings')}
                    title=${t('nav.settings')}
                    @click=${() => this.navigate('settings')}
                  >
                    <dds-icon .path=${mdiCogOutline}></dds-icon>
                  </button>
                  <button
                    class="add"
                    aria-label=${t('downloads.add')}
                    title=${t('downloads.add')}
                    @click=${this.onOpenAdd}
                  >
                    <span class="add-shape">
                      <dds-icon .path=${mdiPlus}></dds-icon
                      ><span class="add-label">${t('nav.add')}</span>
                    </span>
                  </button>
                `
          }
        </div>
        ${
          store.online
            ? nothing
            : html`<div class="offline" role="status">
                <span class="spinner"></span>${t('common.offline')}
              </div>`
        }
      </header>

      <main>
        ${
          settings
            ? html`<dds-settings-page></dds-settings-page>`
            : html`<dds-downloads-page></dds-downloads-page>`
        }
      </main>

      <dds-add-sheet></dds-add-sheet>

      ${
        this.dragging
          ? html`<div class="drop">
              <div class="drop-box">
                <dds-icon .path=${mdiTrayArrowDown}></dds-icon>
                <span>${t('add.drop')}</span>
              </div>
            </div>`
          : nothing
      }
      ${this.renderToasts()}
    `;
  }

  private renderToasts() {
    const icons = { info: mdiInformation, success: mdiCheckCircle, error: mdiAlertCircle };
    return html`<div class="toasts" aria-live="polite">
      ${store.toasts.map(
        (toast) =>
          html`<button class="toast ${toast.kind}" @click=${() => store.dismissToast(toast.id)}>
            <dds-icon .path=${icons[toast.kind]}></dds-icon>
            <span>${toast.message}</span>
          </button>`,
      )}
    </div>`;
  }

  static override styles = [
    sharedStyles,
    css`
      .splash {
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 20px;
        min-height: 100vh;
        min-height: 100dvh;
        padding: 24px;
        text-align: center;
      }

      /* Only shows when loading takes a while: most of the time the app is there at once. */
      .splash dds-logo {
        animation: fade-in 0.3s ease 0.5s both;
      }

      .splash-status {
        font-size: 13px;
        color: var(--text-secondary);
        animation: fade-in 0.3s ease both;
      }

      .bar {
        position: sticky;
        top: 0;
        z-index: 10;
        padding-top: env(safe-area-inset-top);
        background: var(--bg-bar);
        -webkit-backdrop-filter: saturate(180%) blur(20px);
        backdrop-filter: saturate(180%) blur(20px);
        box-shadow: 0 0.5px 0 var(--separator);
      }

      .bar-inner {
        display: flex;
        align-items: center;
        gap: 4px;
        max-width: 760px;
        min-height: 52px;
        margin: 0 auto;
        padding: 0 max(16px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left));
      }

      /* Logo or back button: the title starts at the same place on every page. */
      .leading {
        display: flex;
        flex: none;
        align-items: center;
        width: 34px;
      }

      /* The chevron lines up with the content, the button reaches over the margin. */
      .back {
        width: 44px;
        margin-left: -10px;
        place-items: center start;
      }

      .back dds-icon {
        --icon-size: 28px;
      }

      h1 {
        flex: 1;
        min-width: 0;
        font-size: 17px;
        font-weight: 600;
      }

      /* The button is the hit area, .add-shape what shows. */
      .add {
        display: grid;
        flex: none;
        place-items: center;
        margin-left: 4px;
        padding: 0;
        border: none;
        font: inherit;
        background: none;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
      }

      .add-shape {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: var(--control-height);
        padding: 0 14px 0 10px;
        border-radius: var(--radius);
        font-size: 15px;
        font-weight: 600;
        color: var(--text-on-accent);
        background: var(--accent);
        transition: background-color 0.15s ease;
      }

      .add-shape dds-icon {
        --icon-size: 18px;
      }

      .add:active .add-shape {
        background: var(--accent-pressed);
      }

      @media (hover: hover) {
        .add:hover .add-shape {
          background: var(--accent-pressed);
        }
      }

      .add:focus-visible {
        box-shadow: none;
      }

      .add:focus-visible .add-shape {
        box-shadow: var(--focus-ring);
      }

      /* Phones: a round "+" in a 44px hit area, its edge on the content edge. */
      @media (max-width: 639px) {
        .add {
          width: 44px;
          height: 44px;
          margin-right: -5px;
        }

        .add-shape {
          justify-content: center;
          width: 34px;
          height: 34px;
          padding: 0;
          border-radius: 50%;
        }

        .add-label {
          display: none;
        }

        .add-shape dds-icon {
          --icon-size: 22px;
        }
      }

      .offline {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 6px 16px 8px;
        font-size: 13px;
        color: var(--text-secondary);
      }

      .offline .spinner {
        width: 12px;
        height: 12px;
        border-width: 1.5px;
      }

      main {
        max-width: 760px;
        margin: 0 auto;
        padding: 20px max(16px, env(safe-area-inset-right)) calc(40px + env(safe-area-inset-bottom))
          max(16px, env(safe-area-inset-left));
      }

      @media (min-width: 640px) {
        main {
          padding-top: 28px;
        }
      }

      .drop {
        position: fixed;
        inset: 0;
        z-index: 50;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--overlay);
        pointer-events: none;
      }

      .drop-box {
        display: grid;
        justify-items: center;
        gap: 10px;
        width: min(420px, 100%);
        padding: 40px 24px;
        border: 2px dashed var(--accent);
        border-radius: 14px;
        font-weight: 600;
        color: var(--accent);
        background: var(--bg-elevated);
      }

      .drop-box dds-icon {
        --icon-size: 36px;
      }

      .toasts {
        position: fixed;
        left: 50%;
        bottom: calc(20px + env(safe-area-inset-bottom));
        z-index: 100;
        display: grid;
        justify-items: center;
        gap: 8px;
        width: min(440px, calc(100% - 32px));
        transform: translateX(-50%);
        pointer-events: none;
      }

      .toast {
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: 100%;
        padding: 10px 16px 10px 12px;
        border: none;
        border-radius: 12px;
        font-size: 14px;
        font-weight: 500;
        text-align: left;
        color: var(--toast-text);
        background: var(--toast-bg);
        box-shadow: var(--shadow-overlay);
        pointer-events: auto;
        cursor: pointer;
        animation: toast-in 0.2s ease-out;
      }

      .toast dds-icon {
        --icon-size: 20px;
        flex: none;
        color: var(--toast-icon);
      }

      .toast.success dds-icon {
        color: var(--toast-success);
      }

      .toast.error dds-icon {
        color: var(--toast-danger);
      }

      @keyframes toast-in {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-app': DdsApp;
  }
}
