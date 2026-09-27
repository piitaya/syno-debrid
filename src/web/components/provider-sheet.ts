import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';
import {
  PROVIDERS,
  type ErrorInfo,
  type ProviderAccount,
  type ProviderId,
  type ProviderState,
} from '../../shared/types.js';
import { api, errorInfo } from '../api.js';
import { formatDate } from '../format.js';
import { errorMessage, t } from '../i18n.js';
import { mdiEyeOffOutline, mdiEyeOutline, mdiOpenInNew } from '../icons.js';
import { store, StoreController } from '../store.js';
import { checkRowStyles, renderCheckRow } from './check-row.js';
import { confirmAction } from './confirm.js';
import './icon.js';
import type { DdsSheet } from './sheet.js';
import './sheet.js';
import { inlineInputStyles, sharedStyles } from './styles.js';

/** The debrid service (AllDebrid only, for now). */
export const PROVIDER: ProviderId = 'alldebrid';

/** State of the account check of the API key. */
export type ProviderCheck =
  | { status: 'checking' }
  | { status: 'ok'; account: ProviderAccount }
  | { status: 'error'; error: ErrorInfo };

/** Checks the saved API key, or the given one. */
export async function checkProvider(apiKey?: string): Promise<ProviderCheck> {
  try {
    const result = await api.testProvider(PROVIDER, apiKey);
    return result.ok
      ? { status: 'ok', account: result.account }
      : { status: 'error', error: result.error };
  } catch (error) {
    return { status: 'error', error: errorInfo(error) };
  }
}

/** « Premium jusqu’au 14 février 2027 », « Premium » or « Compte gratuit ». */
export function premiumLabel(account: ProviderAccount): string {
  if (!account.premium) return t('provider.notPremium');
  return account.premiumUntil
    ? t('provider.premiumUntil', { date: formatDate(account.premiumUntil) })
    : t('provider.premium');
}

/**
 * API key and account of the debrid service.
 *
 * Fires `dds-provider-checked` (`CustomEvent<ProviderCheck | null>`, null once the key is
 * removed) whenever the saved key has been checked, so that the settings page shows the same
 * status.
 */
@customElement('dds-provider-sheet')
export class DdsProviderSheet extends LitElement {
  /** Key typed by the user. */
  @state() private key = '';
  @state() private reveal = false;
  @state() private check: ProviderCheck | null = null;
  /** Key that `check` is about; null for the saved key. */
  @state() private checkedKey: string | null = null;
  @state() private saving = false;
  @state() private working = false;
  @state() private error = '';

  @query('dds-sheet') private sheet!: DdsSheet;
  @query('#key') private keyInput?: HTMLInputElement;

  /** Ignores the answer of a check made for a previous key or a previous opening. */
  private checkRun = 0;

  constructor() {
    super();
    new StoreController(this);
  }

  private get providerState(): ProviderState | undefined {
    return store.settings?.providers.find((state) => state.id === PROVIDER);
  }

  /** Opens the sheet; `known` is the last check of the saved key, when there is one. */
  async open(known?: ProviderCheck | null): Promise<void> {
    this.key = '';
    this.reveal = false;
    this.error = '';
    this.checkRun++;
    const configured = this.providerState?.configured ?? false;
    this.check = configured && known && known.status !== 'checking' ? known : null;
    this.checkedKey = null;
    await this.updateComplete;
    await this.sheet.show();
    if (configured && !this.check) void this.test();
    if (!configured && matchMedia('(pointer: fine)').matches) this.keyInput?.focus();
  }

  private emitCheck(check: ProviderCheck | null): void {
    this.dispatchEvent(
      new CustomEvent<ProviderCheck | null>('dds-provider-checked', { detail: check }),
    );
  }

  /**
   * Tests the typed key, or the saved one. Resolves to the result, or null when it no longer
   * matters (sheet closed or reopened meanwhile).
   */
  private async test(): Promise<ProviderCheck | null> {
    const key = this.key.trim();
    const run = ++this.checkRun;
    this.check = { status: 'checking' };
    this.checkedKey = key || null;
    const check = await checkProvider(key || undefined);
    if (run !== this.checkRun) return null;
    this.check = check;
    if (!key) this.emitCheck(check);
    return check;
  }

  /** The typed key was tested and refused: saving it takes a second press. */
  private get keyRefused(): boolean {
    const key = this.key.trim();
    return !!key && this.checkedKey === key && this.check?.status === 'error';
  }

  private async save(): Promise<void> {
    const key = this.key.trim();
    if (!key || this.saving) return;
    this.saving = true;
    this.error = '';
    try {
      // A refused key would only show up at the first download: it is tested first.
      let check = this.checkedKey === key ? this.check : null;
      if (!check || check.status === 'checking') {
        check = await this.test();
        if (!check) return;
        if (check.status === 'error') {
          // The reason shows in the account section; the button now reads « Enregistrer quand même ».
          this.error = t('provider.notValidated');
          return;
        }
      }
      store.setSettings(await api.updateSettings({ apiKeys: { [PROVIDER]: key } }));
      this.emitCheck(check);
      store.toast(t('provider.saved'), 'success');
      this.sheet.close();
    } catch (error) {
      this.error = errorMessage(errorInfo(error).code);
    } finally {
      this.saving = false;
    }
  }

  private async removeKey(): Promise<void> {
    const name = PROVIDERS[PROVIDER].name;
    const confirmed = await confirmAction({
      title: t('provider.removeTitle', { name }),
      message: t('provider.removeMessage', { name }),
      confirmLabel: t('provider.remove'),
    });
    if (!confirmed) return;
    this.working = true;
    this.error = '';
    try {
      store.setSettings(await api.updateSettings({ apiKeys: { [PROVIDER]: null } }));
      this.emitCheck(null);
      store.toast(t('provider.removed'), 'success');
      this.sheet.close();
    } catch (error) {
      this.error = errorMessage(errorInfo(error).code);
    } finally {
      this.working = false;
    }
  }

  private onClosed(): void {
    // Does not keep a typed key around.
    this.key = '';
    this.reveal = false;
    this.error = '';
    this.checkedKey = null;
    this.checkRun++;
  }

  override render() {
    const provider = PROVIDERS[PROVIDER];
    const configured = this.providerState?.configured ?? false;
    const fromEnv = this.providerState?.fromEnv ?? false;

    return html`
      <dds-sheet
        heading=${provider.name}
        primaryLabel=${fromEnv ? '' : this.keyRefused ? t('provider.saveAnyway') : t('provider.save')}
        ?primaryDisabled=${!this.key.trim() || this.working}
        ?busy=${this.saving}
        .error=${this.error}
        @dds-primary=${this.save}
        @dds-closed=${this.onClosed}
      >
        ${
          this.check || fromEnv
            ? html`<section class="section">
                <h3 class="section-header">${t('provider.account')}</h3>
                ${this.check ? html`<div class="group">${this.renderCheck(this.check)}</div>` : nothing}
                ${fromEnv ? html`<p class="section-footer">${this.renderFromEnv()}</p>` : nothing}
              </section>`
            : nothing
        }
        ${fromEnv ? nothing : this.renderKey(configured)}
        ${
          configured && !fromEnv
            ? html`<section class="section">
                <div class="group">
                  <button
                    class="row destructive"
                    ?disabled=${this.working || this.saving}
                    @click=${this.removeKey}
                  >
                    ${t('provider.remove')}
                  </button>
                </div>
              </section>`
            : nothing
        }
      </dds-sheet>
    `;
  }

  private renderCheck(check: ProviderCheck) {
    if (check.status === 'checking') return renderCheckRow(check);
    if (check.status === 'ok') {
      return renderCheckRow({
        status: 'ok',
        title: check.account.username,
        subtitle: premiumLabel(check.account),
      });
    }
    const raw = check.error.message;
    return renderCheckRow({
      status: 'error',
      title: errorMessage(check.error.code),
      detail: raw && raw !== check.error.code ? t('common.detail', { message: raw }) : undefined,
    });
  }

  /** The variable name is shown in monospace. */
  private renderFromEnv() {
    const name = `${PROVIDER.toUpperCase()}_API_KEY`;
    const [before, after = ''] = t('provider.fromEnv', { name: '\u0000' }).split('\u0000');
    return html`${before}<code>${name}</code>${after}`;
  }

  private renderKey(configured: boolean) {
    const provider = PROVIDERS[PROVIDER];
    const testing = this.check?.status === 'checking';
    return html`<section class="section">
      <h3 class="section-header"><label for="key">${t('provider.apiKey')}</label></h3>
      <div class="group">
        <div class="row input-row key">
          <input
            id="key"
            class="inline-input mono-input"
            type=${this.reveal ? 'text' : 'password'}
            .value=${live(this.key)}
            placeholder=${t('provider.apiKeyPlaceholder')}
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @input=${(event: Event) => {
              this.key = (event.target as HTMLInputElement).value;
              this.error = '';
            }}
          />
          <button
            class="icon-btn"
            aria-label=${this.reveal ? t('provider.hide') : t('provider.show')}
            @click=${() => (this.reveal = !this.reveal)}
          >
            <dds-icon .path=${this.reveal ? mdiEyeOffOutline : mdiEyeOutline}></dds-icon>
          </button>
        </div>
      </div>
      ${configured ? html`<p class="section-footer">${t('provider.replaceHint')}</p>` : nothing}
      <div class="actions">
        <button
          class="btn"
          ?disabled=${testing || (!configured && !this.key.trim())}
          @click=${this.test}
        >
          ${t('provider.test')}
        </button>
        <a class="btn btn-plain" href=${provider.apiKeyUrl} target="_blank" rel="noreferrer">
          ${t('provider.getKey')}<dds-icon .path=${mdiOpenInNew}></dds-icon>
        </a>
      </div>
    </section>`;
  }

  static override styles = [
    sharedStyles,
    inlineInputStyles,
    checkRowStyles,
    css`
      /* Room for the button showing the key. */
      .key {
        padding-right: 6px;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
      }

      a.btn:hover {
        text-decoration: none;
      }

      .actions a dds-icon {
        --icon-size: 16px;
      }

      code {
        font-family: var(--font-mono);
        font-size: 0.95em;
        overflow-wrap: anywhere;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-provider-sheet': DdsProviderSheet;
  }
}
