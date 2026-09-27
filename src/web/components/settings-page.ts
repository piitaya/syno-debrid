import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import {
  PROVIDERS,
  type AppSettings,
  type Category,
  type SessionInfo,
} from '../../shared/types.js';
import { api, errorInfo } from '../api.js';
import { breakable } from '../format.js';
import { errorMessage, t } from '../i18n.js';
import {
  categoryIcon,
  mdiArrowDown,
  mdiArrowUp,
  mdiChevronRight,
  mdiNas,
  mdiPlus,
} from '../icons.js';
import { store, StoreController } from '../store.js';
import type { DdsDestinationSheet } from './destination-sheet.js';
import './destination-sheet.js';
import './icon.js';
import { checkNas, type DdsNasSheet, type NasCheck } from './nas-sheet.js';
import './nas-sheet.js';
import type { DdsPasswordSheet } from './password-sheet.js';
import './password-sheet.js';
import {
  checkProvider,
  premiumLabel,
  PROVIDER,
  type DdsProviderSheet,
  type ProviderCheck,
} from './provider-sheet.js';
import { sharedStyles } from './styles.js';

/** Settings changed in place (switches, order). */
type InlinePatch = Partial<
  Pick<AppSettings, 'categories' | 'createSubfolder' | 'deleteFromDebrid'>
>;

/** "AllDebrid" → "AD". */
const initials = (name: string) => (name.match(/[A-Z]/g) ?? [name]).join('').slice(0, 2);

@customElement('dds-settings-page')
export class DdsSettingsPage extends LitElement {
  /** Check of the connection to Download Station. */
  @state() private nasCheck: NasCheck | null = null;
  /** Account check of the debrid API key. */
  @state() private providerCheck: ProviderCheck | null = null;
  /** Destinations are being reordered. */
  @state() private reordering = false;

  @query('dds-provider-sheet') private providerSheet!: DdsProviderSheet;
  @query('dds-destination-sheet') private destinationSheet!: DdsDestinationSheet;
  @query('dds-nas-sheet') private nasSheet!: DdsNasSheet;
  @query('dds-password-sheet') private passwordSheet!: DdsPasswordSheet;

  /** Outdate a check still in flight when a sheet reports a newer one. */
  private nasCheckRun = 0;
  private providerCheckRun = 0;
  /** In-place changes are sent one after the other. */
  private saves: Promise<void> = Promise.resolve();
  private pendingSaves = 0;

  constructor() {
    super();
    new StoreController(this);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.checkNas();
    this.checkProvider();
  }

  private checkNas(): void {
    if (!store.settings?.nas) return;
    const run = ++this.nasCheckRun;
    this.nasCheck = { status: 'checking' };
    void checkNas().then((check) => {
      if (this.nasCheckRun === run) this.nasCheck = check;
    });
  }

  private onNasChecked(event: CustomEvent<NasCheck>): void {
    this.nasCheckRun++;
    this.nasCheck = event.detail;
  }

  private checkProvider(): void {
    if (!store.settings?.providers.some((provider) => provider.configured)) return;
    const run = ++this.providerCheckRun;
    this.providerCheck = { status: 'checking' };
    void checkProvider().then((check) => {
      if (this.providerCheckRun === run) this.providerCheck = check;
    });
  }

  private onProviderChecked(event: CustomEvent<ProviderCheck | null>): void {
    this.providerCheckRun++;
    this.providerCheck = event.detail;
  }

  /** Shows an in-place change at once, then saves it. */
  private save(patch: InlinePatch): void {
    if (!store.settings) return;
    store.setSettings({ ...store.settings, ...patch });
    this.pendingSaves++;
    this.saves = this.saves.then(async () => {
      try {
        const settings = await api.updateSettings(patch);
        // A newer change is on its way: its answer will be applied instead.
        if (this.pendingSaves === 1) store.setSettings(settings);
      } catch (error) {
        store.toast(errorMessage(errorInfo(error).code), 'error');
        const settings = await api.settings().catch(() => null);
        if (settings) store.setSettings(settings);
      } finally {
        this.pendingSaves--;
      }
    });
  }

  private async move(index: number, offset: -1 | 1): Promise<void> {
    const categories = [...(store.settings?.categories ?? [])];
    const target = index + offset;
    const [category] = categories.splice(index, 1);
    if (!category || target < 0 || target > categories.length) return;
    categories.splice(target, 0, category);
    const hadFocus = !!this.shadowRoot?.activeElement?.closest('.move');
    this.save({ categories });

    // Keeps the keyboard focus on the moved destination.
    if (!hadFocus) return;
    await this.updateComplete;
    const row = [...this.renderRoot.querySelectorAll<HTMLElement>('[data-id]')].find(
      (element) => element.dataset.id === category.id,
    );
    const buttons = [...(row?.querySelectorAll<HTMLButtonElement>('.move button') ?? [])];
    const preferred = buttons[offset < 0 ? 0 : 1];
    (preferred && !preferred.disabled ? preferred : buttons.find((b) => !b.disabled))?.focus();
  }

  private registerMagnetHandler(): void {
    try {
      // Opens the downloads page, not this one.
      navigator.registerProtocolHandler('magnet', new URL('./?magnet=%s', location.href).href);
      store.toast(t('settings.magnetHandlerDone'), 'info');
    } catch {
      store.toast(errorMessage('internal'), 'error');
    }
  }

  override render() {
    const { session, settings } = store;
    if (!session || !settings) return nothing;

    return html`
      ${this.renderNas(settings)} ${this.renderServices(settings)}
      ${this.renderDestinations(settings)} ${this.renderDownloading(settings)}
      ${this.renderAccount(session)}
      <p class="about">${t('app.name')} · ${t('settings.version', { version: session.version })}</p>
      <dds-nas-sheet @dds-nas-checked=${this.onNasChecked}></dds-nas-sheet>
      <dds-provider-sheet @dds-provider-checked=${this.onProviderChecked}></dds-provider-sheet>
      <dds-destination-sheet></dds-destination-sheet>
      <dds-password-sheet></dds-password-sheet>
    `;
  }

  private renderNas(settings: AppSettings) {
    const { nas } = settings;
    return html`<section class="section">
      <h2 class="section-header">${t('settings.nas')}</h2>
      <div class="group with-icons">
        ${this.renderConnection({
          icon: html`<span class="row-icon"><dds-icon .path=${mdiNas}></dds-icon></span>`,
          title: t('nas.title'),
          configured: !!nas,
          check: nas ? this.nasCheck : null,
          lines: nas ? [nas.account, nas.url] : [],
          open: () => this.nasSheet.open(this.nasCheck),
        })}
      </div>
    </section>`;
  }

  private renderServices(settings: AppSettings) {
    const name = PROVIDERS[PROVIDER].name;
    const configured = settings.providers.some((provider) => provider.configured);
    const check = configured ? this.providerCheck : null;
    return html`<section class="section">
      <h2 class="section-header">${t('settings.services')}</h2>
      <div class="group with-icons">
        ${this.renderConnection({
          icon: html`<span class="row-icon initials" aria-hidden="true">${initials(name)}</span>`,
          title: name,
          configured,
          check,
          lines:
            check?.status === 'ok' ? [check.account.username, premiumLabel(check.account)] : [],
          open: () => this.providerSheet.open(this.providerCheck),
        })}
      </div>
      <p class="section-footer">${t('settings.servicesFooter')}</p>
    </section>`;
  }

  /** A connection, its state on the title line and its details below, in short lines. */
  private renderConnection(connection: {
    icon: TemplateResult;
    title: string;
    configured: boolean;
    check: NasCheck | ProviderCheck | null;
    lines: string[];
    open: () => void;
  }) {
    const { check } = connection;
    const lines =
      check?.status === 'error'
        ? [...connection.lines, errorMessage(check.error.code).replace(/\.$/, '')]
        : connection.lines;
    const [value, tone] = !connection.configured
      ? [t('check.notConfigured'), 'off']
      : check?.status === 'ok'
        ? [t('check.connected'), 'ok']
        : check?.status === 'error'
          ? [t('check.error'), 'bad']
          : [t('check.checking'), ''];
    return html`<button class="row ${lines.length ? 'multiline' : ''}" @click=${connection.open}>
      ${connection.icon}
      <span class="row-main">
        <span class="title-line">
          <span class="row-title">${connection.title}</span>
          <span class="row-value ${tone}">${value}</span>
        </span>
        ${
          lines.length
            ? html`<span class="row-subtitle details wrap">
                ${lines.map((line) => html`<span>${line}</span>`)}
              </span>`
            : nothing
        }
      </span>
      <dds-icon class="chevron" .path=${mdiChevronRight}></dds-icon>
    </button>`;
  }

  private renderDestinations(settings: AppSettings) {
    const { categories } = settings;
    const reordering = this.reordering && categories.length > 1;
    return html`<section class="section">
      <div class="section-header">
        <h2>${t('settings.destinations')}</h2>
        ${
          categories.length > 1
            ? html`<button class="btn btn-plain" @click=${() => (this.reordering = !reordering)}>
                ${reordering ? t('settings.done') : t('settings.edit')}
              </button>`
            : nothing
        }
      </div>
      <div class="group with-icons">
        ${repeat(
          categories,
          (category) => category.id,
          (category, index) => this.renderCategory(category, index, categories.length, reordering),
        )}
        ${
          reordering
            ? nothing
            : html`<button class="row accent" @click=${() => this.destinationSheet.open(null)}>
                <span class="row-icon accent"><dds-icon .path=${mdiPlus}></dds-icon></span>
                <span class="row-main">
                  <span class="row-title">${t('settings.addDestination')}</span>
                </span>
              </button>`
        }
      </div>
      <p class="section-footer">${t('settings.destinationsFooter')}</p>
    </section>`;
  }

  private renderCategory(category: Category, index: number, count: number, reordering: boolean) {
    const content = html`
      <span class="row-icon"><dds-icon .path=${categoryIcon(category.icon)}></dds-icon></span>
      <span class="row-main">
        <span class="row-title wrap">${breakable(category.name)}</span>
        <span class="row-subtitle">${breakable(category.destination)}</span>
      </span>
    `;
    if (!reordering) {
      return html`<button
        class="row multiline"
        data-id=${category.id}
        @click=${() => this.destinationSheet.open(category)}
      >
        ${content}<dds-icon class="chevron" .path=${mdiChevronRight}></dds-icon>
      </button>`;
    }
    return html`<div class="row multiline" data-id=${category.id}>
      ${content}
      <span class="move">
        <button
          class="icon-btn"
          aria-label=${t('settings.moveUp')}
          ?disabled=${index === 0}
          @click=${() => this.move(index, -1)}
        >
          <dds-icon .path=${mdiArrowUp}></dds-icon>
        </button>
        <button
          class="icon-btn"
          aria-label=${t('settings.moveDown')}
          ?disabled=${index === count - 1}
          @click=${() => this.move(index, 1)}
        >
          <dds-icon .path=${mdiArrowDown}></dds-icon>
        </button>
      </span>
    </div>`;
  }

  private renderDownloading(settings: AppSettings) {
    return html`<section class="section">
      <h2 class="section-header">${t('settings.downloading')}</h2>
      <div class="group">
        <label class="row">
          <span class="row-main">
            <span class="row-title">${t('settings.subfolder')}</span>
            <span class="row-subtitle">${t('settings.subfolderHint')}</span>
          </span>
          <input
            type="checkbox"
            class="switch"
            role="switch"
            .checked=${live(settings.createSubfolder)}
            @change=${(event: Event) =>
              this.save({ createSubfolder: (event.target as HTMLInputElement).checked })}
          />
        </label>
        <label class="row">
          <span class="row-main">
            <span class="row-title">${t('settings.cleanup')}</span>
            <span class="row-subtitle">${t('settings.cleanupHint')}</span>
          </span>
          <input
            type="checkbox"
            class="switch"
            role="switch"
            .checked=${live(settings.deleteFromDebrid)}
            @change=${(event: Event) =>
              this.save({ deleteFromDebrid: (event.target as HTMLInputElement).checked })}
          />
        </label>
      </div>
    </section>`;
  }

  private renderAccount(session: SessionInfo) {
    const canHandleMagnets =
      window.isSecureContext && typeof navigator.registerProtocolHandler === 'function';
    const magnetHandler = canHandleMagnets
      ? html`<button class="row accent" @click=${this.registerMagnetHandler}>
          ${t('settings.magnetHandler')}
        </button>`
      : nothing;
    // No sign-in (AUTH=none): a reverse proxy takes care of who may come in.
    if (session.username === null) {
      return canHandleMagnets
        ? html`<section class="section"><div class="group">${magnetHandler}</div></section>`
        : nothing;
    }
    return html`<section class="section">
        <h2 class="section-header">${t('settings.account')}</h2>
        <div class="group">
          <div class="row">
            <span class="row-main">
              <span class="row-title wrap">
                ${t('settings.signedInAs', { user: session.username })}
              </span>
            </span>
          </div>
          <button class="row accent" @click=${() => this.passwordSheet.open()}>
            ${t('settings.changePassword')}
          </button>
          ${magnetHandler}
        </div>
      </section>
      <section class="section">
        <div class="group">
          <button class="row destructive" @click=${() => store.logout()}>
            ${t('settings.signOut')}
          </button>
        </div>
      </section>`;
  }

  static override styles = [
    sharedStyles,
    css`
      .initials {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: -0.2px;
      }

      /*
       * The value sits on the title line, so that subtitles get the full width. In rows with
       * details, the chevron stays on that line too (like a message list); the icon is centered.
       */
      .row.multiline {
        align-items: flex-start;
      }

      .row.multiline > .row-icon,
      .row.multiline > .move {
        align-self: center;
      }

      /* Centered on the 21px title line. */
      .row.multiline > .chevron {
        margin-top: 1.5px;
      }

      .title-line {
        display: flex;
        align-items: baseline;
        gap: 12px;
      }

      .title-line .row-title {
        flex: 1;
        min-width: 0;
      }

      /* One line per detail on phones, a single line on larger screens. */
      .details > span {
        display: block;
      }

      @media (min-width: 640px) {
        .details > span {
          display: inline;
        }

        .details > span + span::before {
          content: ' · ';
        }
      }

      .row-value.ok {
        color: var(--success);
      }

      .row-value.bad {
        color: var(--danger);
      }

      .row-value.off {
        color: var(--text-secondary);
      }

      .move {
        display: flex;
        flex: none;
        margin-right: -8px;
      }

      .about {
        margin-top: 28px;
        font-size: 13px;
        text-align: center;
        color: var(--text-secondary);
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-settings-page': DdsSettingsPage;
  }
}
