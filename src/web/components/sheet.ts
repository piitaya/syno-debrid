import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { t } from '../i18n.js';
import { mdiAlertCircleOutline, mdiClose } from '../icons.js';
import './icon.js';
import { sharedStyles } from './styles.js';

/** Fields in which Enter presses the primary button. */
const TEXT_INPUTS = new Set(['text', 'password', 'url', 'email', 'search', 'tel', 'number']);

/** Open sheets, counted to keep the page behind them still (sheets can be stacked). */
let openSheets = 0;

function lockPageScroll(): void {
  if (openSheets++) return;
  const root = document.documentElement;
  // The scrollbar goes away: its width is kept so that the page does not shift sideways.
  const scrollbar = window.innerWidth - root.clientWidth;
  root.style.overflow = 'hidden';
  if (scrollbar > 0) root.style.paddingRight = `${scrollbar}px`;
}

function unlockPageScroll(): void {
  if (--openSheets > 0) return;
  const root = document.documentElement;
  root.style.overflow = '';
  root.style.paddingRight = '';
}

/**
 * Modal panel used for every secondary screen: a bottom sheet on phones, a centered dialog on
 * larger screens. Content goes in the default slot.
 *
 * Errors of the sheet's actions go in `error`: they show above the footer, whatever the scroll
 * position (toasts would be hidden behind the sheet).
 *
 * Enter in a text field presses the primary button, unless the field handles it itself.
 *
 * Events: `dds-primary` when the primary button is pressed, `dds-closed` once closed.
 */
@customElement('dds-sheet')
export class DdsSheet extends LitElement {
  @property() heading = '';
  /** Label of the primary action; no footer when empty. */
  @property() primaryLabel = '';
  @property({ type: Boolean }) primaryDisabled = false;
  /** Shows a spinner in the primary button. */
  @property({ type: Boolean }) busy = false;
  /** Fixed height, for content that changes while the sheet is open (folder picker). */
  @property({ type: Boolean }) tall = false;
  /** Error message shown above the footer. */
  @property() error = '';

  /** The content is scrolled: a hairline separates it from the header. */
  @state() private scrolled = false;

  @query('dialog') private dialog!: HTMLDialogElement;

  /** This sheet keeps the page from scrolling. */
  private locking = false;

  get open(): boolean {
    return this.dialog?.open ?? false;
  }

  async show(): Promise<void> {
    await this.updateComplete;
    if (this.dialog.open) return;
    this.scrolled = false;
    this.dialog.showModal();
    this.lock(true);
  }

  close(): void {
    if (this.dialog?.open) this.dialog.close();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Removed while open (signed out, another download shown…): the page must scroll again.
    this.lock(false);
    this.dialog?.close();
  }

  private lock(locked: boolean): void {
    if (locked === this.locking) return;
    this.locking = locked;
    if (locked) lockPageScroll();
    else unlockPageScroll();
  }

  private onClose(): void {
    this.lock(false);
    this.dispatchEvent(new CustomEvent('dds-closed'));
  }

  private onClick(event: MouseEvent): void {
    // A click on the backdrop reaches the <dialog> itself, outside of its box.
    if (event.target !== this.dialog) return;
    const box = this.dialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) this.close();
  }

  private onScroll(event: Event): void {
    const scrolled = (event.target as HTMLElement).scrollTop > 0;
    if (scrolled !== this.scrolled) this.scrolled = scrolled;
  }

  private primary(): void {
    if (this.primaryDisabled || this.busy) return;
    this.dispatchEvent(new CustomEvent('dds-primary'));
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return;
    const field = event.composedPath()[0];
    if (!(field instanceof HTMLInputElement) || !TEXT_INPUTS.has(field.type)) return;
    event.preventDefault();
    if (this.primaryLabel) this.primary();
  }

  override render() {
    const footer = !!this.primaryLabel;
    const classes = [
      this.tall ? 'tall' : '',
      footer ? 'has-footer' : '',
      this.error ? 'has-error' : '',
    ];
    return html`
      <dialog
        class=${classes.filter(Boolean).join(' ')}
        aria-label=${this.heading}
        @click=${this.onClick}
        @close=${this.onClose}
        @keydown=${this.onKeyDown}
      >
        <header class=${this.scrolled ? 'scrolled' : ''}>
          <h2>${this.heading}</h2>
          <button class="close" aria-label=${t('common.close')} @click=${() => this.close()}>
            <dds-icon .path=${mdiClose}></dds-icon>
          </button>
        </header>
        <div class="body" @scroll=${this.onScroll}><slot></slot></div>
        ${
          this.error
            ? html`<div class="error" role="alert">
                <dds-icon .path=${mdiAlertCircleOutline}></dds-icon>
                <span>${this.error}</span>
              </div>`
            : nothing
        }
        ${
          footer
            ? html`<footer>
                <button class="btn cancel" @click=${() => this.close()}>
                  ${t('common.cancel')}
                </button>
                <button
                  class="btn btn-primary"
                  ?disabled=${this.primaryDisabled || this.busy}
                  @click=${this.primary}
                >
                  ${this.busy ? html`<span class="spinner"></span>` : this.primaryLabel}
                </button>
              </footer>`
            : nothing
        }
      </dialog>
    `;
  }

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: contents;
      }

      dialog {
        display: none;
        flex-direction: column;
        width: 100%;
        max-width: 100%;
        max-height: calc(100dvh - env(safe-area-inset-top) - 16px);
        margin: auto 0 0;
        padding: 0;
        border: none;
        border-radius: 14px 14px 0 0;
        color: var(--text);
        background: var(--bg-sheet);
        box-shadow: var(--shadow-overlay);
        overflow: hidden;
        /* Groups inside a sheet sit one level higher (visible in dark mode). */
        --bg-elevated: var(--bg-sheet-content);
      }

      dialog.tall {
        height: min(680px, calc(100dvh - env(safe-area-inset-top) - 16px));
      }

      dialog[open] {
        display: flex;
        animation: slide-up 0.32s cubic-bezier(0.32, 0.72, 0, 1);
      }

      dialog::backdrop {
        background: var(--overlay);
        animation: fade-in 0.2s ease;
      }

      @keyframes slide-up {
        from {
          transform: translateY(100%);
        }
      }

      /* The × circle ends where the groups end (16px from the edge), its hit area is 44px. */
      header {
        position: relative;
        z-index: 1;
        display: flex;
        flex: none;
        align-items: center;
        gap: 8px;
        min-height: 56px;
        padding: 6px 9px 6px 16px;
        transition: box-shadow 0.15s ease;
      }

      header.scrolled {
        box-shadow: 0 0.5px 0 var(--separator);
      }

      h2 {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        font-size: 17px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .close {
        position: relative;
        display: grid;
        flex: none;
        place-items: center;
        width: 44px;
        height: 44px;
        padding: 0;
        border: none;
        border-radius: 50%;
        color: var(--text-secondary);
        background: none;
        cursor: pointer;
      }

      .close::before {
        content: '';
        position: absolute;
        inset: 7px;
        border-radius: 50%;
        background: var(--fill);
        transition: background-color 0.15s ease;
      }

      @media (hover: hover) {
        .close:hover::before {
          background: var(--fill-hover);
        }
      }

      .close:active::before {
        background: var(--fill-pressed);
      }

      .close:focus-visible {
        box-shadow: none;
      }

      .close:focus-visible::before {
        box-shadow: var(--focus-ring);
      }

      .close dds-icon {
        --icon-size: 18px;
        position: relative;
      }

      .body {
        flex: 1;
        min-height: 0;
        padding: 4px 16px 20px;
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      /* Nothing below the content on phones but the home indicator. */
      dialog:not(.has-footer) .body {
        padding-bottom: calc(20px + env(safe-area-inset-bottom));
      }

      dialog.has-error .body {
        padding-bottom: 12px;
      }

      .error {
        display: flex;
        flex: none;
        align-items: flex-start;
        gap: 8px;
        margin: 0 16px 12px;
        padding: 10px 12px;
        border-radius: var(--radius);
        font-size: 13px;
        color: var(--danger);
        background: var(--danger-fill);
        animation: fade-in 0.15s ease;
      }

      dialog:not(.has-footer) .error {
        margin-bottom: calc(16px + env(safe-area-inset-bottom));
      }

      .error dds-icon {
        --icon-size: 18px;
        flex: none;
      }

      footer {
        display: flex;
        flex: none;
        gap: 8px;
        padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
        border-top: 0.5px solid var(--separator);
        background: var(--bg-sheet);
      }

      /* Phones: one full-width action at the bottom, closing is done with the × button. */
      footer .cancel {
        display: none;
      }

      footer .btn-primary {
        flex: 1;
        min-height: 50px;
        font-size: 17px;
        border-radius: var(--radius-lg);
      }

      @media (min-width: 640px) {
        dialog {
          width: min(520px, calc(100% - 48px));
          max-height: min(760px, calc(100dvh - 64px));
          margin: auto;
          border-radius: 14px;
        }

        dialog.tall {
          height: min(600px, calc(100dvh - 64px));
        }

        dialog[open] {
          animation: pop-in 0.18s ease-out;
        }

        @keyframes pop-in {
          from {
            opacity: 0;
            transform: scale(0.97);
          }
        }

        dialog:not(.has-footer) .body {
          padding-bottom: 20px;
        }

        dialog.has-error .body {
          padding-bottom: 12px;
        }

        dialog:not(.has-footer) .error {
          margin-bottom: 16px;
        }

        footer {
          justify-content: flex-end;
          padding-bottom: 12px;
        }

        footer .cancel {
          display: inline-flex;
        }

        footer .btn-primary {
          flex: none;
          min-height: var(--control-height);
          font-size: 15px;
          border-radius: var(--radius);
        }
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-sheet': DdsSheet;
  }
}
