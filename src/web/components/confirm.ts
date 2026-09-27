import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { t } from '../i18n.js';
import { sharedStyles } from './styles.js';

export interface ConfirmOptions {
  /** The question, e.g. « Supprimer la clé AllDebrid ? ». */
  title: string;
  /** What happens, in a sentence. */
  message?: string;
  /** Names the action, e.g. « Supprimer la clé »: never a bare « OK ». */
  confirmLabel: string;
}

/**
 * Asks before a destructive action: an action sheet on phones, a small dialog on larger screens.
 * Resolves to true when confirmed.
 */
export async function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const element = document.createElement('dds-confirm');
  element.options = options;
  document.body.append(element);
  try {
    return await element.ask();
  } finally {
    element.remove();
  }
}

@customElement('dds-confirm')
export class DdsConfirm extends LitElement {
  @property({ attribute: false }) options: ConfirmOptions = { title: '', confirmLabel: '' };

  @query('dialog') private dialog!: HTMLDialogElement;
  @query('.cancel') private cancelButton!: HTMLButtonElement;

  async ask(): Promise<boolean> {
    await this.updateComplete;
    return new Promise((resolve) => {
      this.dialog.addEventListener('close', () => resolve(this.dialog.returnValue === 'confirm'), {
        once: true,
      });
      this.dialog.returnValue = '';
      this.dialog.showModal();
      // The safe choice is the default one: Enter keeps things as they are.
      this.cancelButton.focus();
    });
  }

  private onClick(event: MouseEvent): void {
    // A click on the backdrop reaches the <dialog> itself.
    if (event.target === this.dialog) this.dialog.close();
  }

  override render() {
    const { title, message, confirmLabel } = this.options;
    return html`
      <dialog
        role="alertdialog"
        aria-labelledby="title"
        aria-describedby=${message ? 'message' : nothing}
        @click=${this.onClick}
      >
        <form method="dialog">
          <div class="card">
            <div class="text">
              <h2 id="title">${title}</h2>
              ${message ? html`<p id="message">${message}</p>` : nothing}
            </div>
            <button class="confirm" value="confirm">${confirmLabel}</button>
          </div>
          <button class="cancel" value="cancel">${t('common.cancel')}</button>
        </form>
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
        margin: auto;
        padding: 0;
        border: none;
        color: var(--text);
        background: none;
        overflow: visible;
      }

      dialog::backdrop {
        background: var(--overlay);
        animation: fade-in 0.2s ease;
      }

      form {
        display: grid;
        gap: 8px;
      }

      .text {
        display: grid;
        gap: 4px;
      }

      h2,
      p {
        font-size: 13px;
        color: var(--text-secondary);
      }

      h2 {
        font-weight: 600;
      }

      button {
        border: none;
        cursor: pointer;
      }

      /* Phones: an action sheet, the action in its card and « Annuler » on its own below. */
      @media (max-width: 639px) {
        dialog {
          width: 100%;
          max-width: 100%;
          margin: auto 0 0;
          padding: 0 8px calc(8px + env(safe-area-inset-bottom));
        }

        dialog[open] {
          animation: slide-up 0.3s cubic-bezier(0.32, 0.72, 0, 1);
        }

        @keyframes slide-up {
          from {
            transform: translateY(100%);
          }
        }

        .card {
          overflow: hidden;
          border-radius: 14px;
          background: var(--bg-sheet-content);
        }

        .text {
          padding: 16px 20px 14px;
          text-align: center;
          border-bottom: 0.5px solid var(--separator);
        }

        button {
          display: block;
          width: 100%;
          min-height: 56px;
          padding: 0 16px;
          font-size: 17px;
          background: var(--bg-sheet-content);
        }

        .cancel {
          border-radius: 14px;
          font-weight: 600;
          color: var(--accent);
        }

        .confirm {
          color: var(--danger);
        }

        button:active {
          background: var(--fill-hover);
        }

        button:focus-visible {
          box-shadow: inset var(--focus-ring);
        }
      }

      /* Larger screens: a small dialog, the buttons at the bottom right. */
      @media (min-width: 640px) {
        dialog {
          width: min(400px, calc(100% - 48px));
          border-radius: 14px;
          background: var(--bg-sheet-content);
          box-shadow: var(--shadow-overlay);
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

        form {
          grid-template-columns: 1fr auto auto;
          padding: 20px;
        }

        .card {
          display: contents;
        }

        .text {
          grid-column: 1 / -1;
          gap: 6px;
          margin-bottom: 12px;
        }

        h2 {
          font-size: 15px;
          color: var(--text);
        }

        button {
          min-height: var(--control-height);
          padding: 0 14px;
          border-radius: var(--radius);
          font-size: 15px;
          font-weight: 600;
          transition: background-color 0.15s ease;
        }

        .cancel {
          grid-row: 2;
          grid-column: 2;
          color: var(--text);
          background: var(--fill);
        }

        .confirm {
          grid-row: 2;
          grid-column: 3;
          color: var(--text-on-accent);
          background: var(--danger);
        }

        @media (hover: hover) {
          .cancel:hover {
            background: var(--fill-hover);
          }
        }

        .cancel:active {
          background: var(--fill-pressed);
        }

        .confirm:active {
          opacity: 0.85;
        }
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-confirm': DdsConfirm;
  }
}
