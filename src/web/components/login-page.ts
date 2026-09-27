import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import type { ErrorCode } from '../../shared/types.js';
import { errorInfo } from '../api.js';
import { errorMessage, t } from '../i18n.js';
import { mdiAlertCircleOutline } from '../icons.js';
import { store } from '../store.js';
import { authStyles } from './auth-styles.js';
import './icon.js';
import './logo.js';
import { sharedStyles } from './styles.js';

@customElement('dds-login-page')
export class DdsLoginPage extends LitElement {
  @state() private busy = false;
  @state() private error: string | null =
    store.signedOutReason === 'unauthorized' ? errorMessage('unauthorized') : null;
  @state() private forgot = false;

  @query('input[name="password"]') private passwordInput?: HTMLInputElement;

  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const username = String(data.get('username') ?? '').trim();
    const password = String(data.get('password') ?? '');
    if (!username || !password) return;

    this.busy = true;
    this.error = null;
    let code: ErrorCode;
    try {
      await store.login(username, password);
      return;
    } catch (error) {
      code = errorInfo(error).code;
    } finally {
      this.busy = false;
    }

    this.error = errorMessage(code);
    if (code !== 'invalid_credentials') return;
    // The fields are disabled while signing in: the password takes the focus once rendered again.
    await this.updateComplete;
    this.passwordInput!.value = '';
    this.passwordInput!.focus();
  }

  override render() {
    return html`
      <main>
        <form @submit=${this.submit}>
          <header>
            <dds-logo size="56"></dds-logo>
            <h1>${t('app.name')}</h1>
            <p class="secondary">${t('login.subtitle')}</p>
          </header>

          <div class="group fields">
            <input
              name="username"
              placeholder=${t('login.username')}
              aria-label=${t('login.username')}
              autocomplete="username"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              required
              ?disabled=${this.busy}
            />
            <input
              name="password"
              type="password"
              placeholder=${t('login.password')}
              aria-label=${t('login.password')}
              autocomplete="current-password"
              required
              ?disabled=${this.busy}
            />
          </div>
          ${
            this.error
              ? html`<div class="notice" role="alert">
                  <dds-icon .path=${mdiAlertCircleOutline}></dds-icon>
                  <span>${this.error}</span>
                </div>`
              : nothing
          }

          <button class="btn btn-primary btn-block submit" ?disabled=${this.busy}>
            ${this.busy ? html`<span class="spinner"></span>` : t('login.submit')}
          </button>
          <button
            type="button"
            class="btn btn-plain link"
            aria-expanded=${this.forgot}
            @click=${() => (this.forgot = !this.forgot)}
          >
            ${t('login.forgot')}
          </button>
          ${this.forgot ? html`<p class="help small secondary">${this.renderForgotHelp()}</p>` : nothing}
        </form>
      </main>
    `;
  }

  /** The file name is shown in monospace. */
  private renderForgotHelp() {
    const [before, after = ''] = t('login.forgotHelp', { file: '\u0000' }).split('\u0000');
    return html`${before}<code>account.json</code>${after}`;
  }

  static override styles = [
    sharedStyles,
    authStyles,
    css`
      .help {
        margin-top: -8px;
        padding: 0 16px;
        text-align: center;
        text-wrap: pretty;
      }

      code {
        font-family: var(--font-mono);
        font-size: 0.95em;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-login-page': DdsLoginPage;
  }
}
