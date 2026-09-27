import { LitElement, css, html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';
import { MIN_PASSWORD_LENGTH } from '../../shared/types.js';
import { api, errorInfo } from '../api.js';
import { errorMessage, t } from '../i18n.js';
import { store } from '../store.js';
import type { DdsSheet } from './sheet.js';
import './sheet.js';
import { inlineInputStyles, sharedStyles } from './styles.js';

type Field = 'current' | 'password' | 'confirm';

/** New password for the app's account. The other devices are signed out. */
@customElement('dds-password-sheet')
export class DdsPasswordSheet extends LitElement {
  @state() private values: Record<Field, string> = { current: '', password: '', confirm: '' };
  @state() private saving = false;
  @state() private error = '';

  @query('dds-sheet') private sheet!: DdsSheet;

  async open(): Promise<void> {
    this.values = { current: '', password: '', confirm: '' };
    this.error = '';
    await this.sheet.show();
    if (matchMedia('(pointer: fine)').matches) this.focusField('current');
  }

  private set(field: Field, value: string): void {
    this.values = { ...this.values, [field]: value };
    this.error = '';
  }

  private async focusField(field: Field, clear = false): Promise<void> {
    if (clear) this.values = { ...this.values, [field]: '' };
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLInputElement>(`#${field}`)?.focus();
  }

  private get complete(): boolean {
    const { current, password, confirm } = this.values;
    return !!current && !!password && !!confirm;
  }

  private async save(): Promise<void> {
    if (!this.complete || this.saving) return;
    const { current, password, confirm } = this.values;
    if (password.length < MIN_PASSWORD_LENGTH) {
      this.error = errorMessage('weak_password');
      return void this.focusField('password');
    }
    if (password !== confirm) {
      this.error = t('password.mismatch');
      return void this.focusField('confirm', true);
    }
    this.saving = true;
    try {
      const result = await api.changePassword({ current, password });
      if (result.ok) {
        store.toast(t('password.saved'), 'success');
        this.sheet.close();
        return;
      }
      this.error = errorMessage(result.error.code);
      if (result.error.code === 'wrong_password') void this.focusField('current', true);
    } catch (error) {
      this.error = errorMessage(errorInfo(error).code);
    } finally {
      this.saving = false;
    }
  }

  override render() {
    return html`
      <dds-sheet
        heading=${t('settings.changePassword')}
        primaryLabel=${t('common.save')}
        ?primaryDisabled=${!this.complete}
        ?busy=${this.saving}
        .error=${this.error}
        @dds-primary=${this.save}
        @dds-closed=${() => (this.values = { current: '', password: '', confirm: '' })}
      >
        <section class="section">
          <!-- For password managers: whose password this is. -->
          <input
            class="username"
            autocomplete="username"
            .value=${store.session?.username ?? ''}
            readonly
            tabindex="-1"
            aria-hidden="true"
          />
          <div class="group">
            ${this.renderField('current', t('password.current'), 'current-password')}
            ${this.renderField('password', t('password.new'), 'new-password')}
            ${this.renderField('confirm', t('password.confirm'), 'new-password')}
          </div>
          <p class="section-footer">${t('password.footer')}</p>
        </section>
      </dds-sheet>
    `;
  }

  private renderField(field: Field, placeholder: string, autocomplete: string) {
    return html`<div class="row input-row">
      <input
        id=${field}
        class="inline-input"
        type="password"
        placeholder=${placeholder}
        aria-label=${placeholder}
        autocomplete=${autocomplete}
        .value=${live(this.values[field])}
        @input=${(event: Event) => this.set(field, (event.target as HTMLInputElement).value)}
      />
    </div>`;
  }

  static override styles = [
    sharedStyles,
    inlineInputStyles,
    css`
      .username {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-password-sheet': DdsPasswordSheet;
  }
}
