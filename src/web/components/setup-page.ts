import { LitElement, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { MIN_PASSWORD_LENGTH } from '../../shared/types.js';
import { errorInfo } from '../api.js';
import { errorMessage, t } from '../i18n.js';
import { mdiAlertCircleOutline } from '../icons.js';
import { store } from '../store.js';
import { authStyles } from './auth-styles.js';
import './icon.js';
import './logo.js';
import { sharedStyles } from './styles.js';

type Field = 'username' | 'password' | 'confirm';

/**
 * First start: creates the app's account. Download Station, the debrid service and the
 * destinations come next, from the list on the downloads screen.
 */
@customElement('dds-setup-page')
export class DdsSetupPage extends LitElement {
  @state() private busy = false;
  @state() private error = '';

  @query('form') private form!: HTMLFormElement;

  private field(name: Field): HTMLInputElement {
    return this.form.elements.namedItem(name) as HTMLInputElement;
  }

  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const username = this.field('username').value.trim();
    const password = this.field('password').value;
    const confirm = this.field('confirm');
    if (!username) return this.field('username').focus();
    if (password.length < MIN_PASSWORD_LENGTH) {
      this.error = errorMessage('weak_password');
      return this.field('password').focus();
    }
    if (password !== confirm.value) {
      this.error = t('password.mismatch');
      confirm.value = '';
      return confirm.focus();
    }

    this.busy = true;
    this.error = '';
    try {
      // Signed in: the app takes over.
      await store.setup({ username, password });
    } catch (error) {
      this.error = errorMessage(errorInfo(error).code);
    } finally {
      this.busy = false;
    }
  }

  override render() {
    return html`
      <main>
        <form @submit=${this.submit} @input=${() => (this.error = '')} novalidate>
          <header>
            <dds-logo size="56"></dds-logo>
            <h1>${t('setup.title')}</h1>
            <p class="secondary">${t('setup.hint')}</p>
          </header>
          <div class="group fields">
            ${this.input('username', t('login.username'), 'text', 'username')}
            ${this.input('password', t('login.password'), 'password', 'new-password')}
            ${this.input('confirm', t('password.confirm'), 'password', 'new-password')}
          </div>
          <p class="hint small secondary">${t('setup.passwordRule')}</p>
          ${
            this.error
              ? html`<div class="notice" role="alert">
                  <dds-icon .path=${mdiAlertCircleOutline}></dds-icon>
                  <span>${this.error}</span>
                </div>`
              : nothing
          }
          <button class="btn btn-primary btn-block submit" ?disabled=${this.busy}>
            ${this.busy ? html`<span class="spinner"></span>` : t('setup.create')}
          </button>
        </form>
      </main>
    `;
  }

  private input(name: Field, placeholder: string, type: string, autocomplete: string) {
    return html`<input
      name=${name}
      type=${type}
      placeholder=${placeholder}
      aria-label=${placeholder}
      autocomplete=${autocomplete}
      autocapitalize="none"
      autocorrect="off"
      spellcheck="false"
      ?disabled=${this.busy}
    />`;
  }

  static override styles = [sharedStyles, authStyles];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-setup-page': DdsSetupPage;
  }
}
