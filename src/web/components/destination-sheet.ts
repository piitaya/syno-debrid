import { LitElement, css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';
import { CATEGORY_ICONS, type Category, type CategoryIcon } from '../../shared/types.js';
import { api, errorInfo } from '../api.js';
import { errorMessage, iconLabel, t } from '../i18n.js';
import { categoryIcon, mdiFolderOpenOutline } from '../icons.js';
import { store, StoreController } from '../store.js';
import { confirmAction } from './confirm.js';
import { normalizePath, type DdsFolderPicker } from './folder-picker.js';
import './icon.js';
import type { DdsSheet } from './sheet.js';
import './sheet.js';
import { inlineInputStyles, sharedStyles } from './styles.js';

/** Creates or edits a destination (a named NAS folder offered when adding downloads). */
@customElement('dds-destination-sheet')
export class DdsDestinationSheet extends LitElement {
  /** Destination being edited; null for a new one. */
  @state() private editing: Category | null = null;
  @state() private name = '';
  @state() private folder = '';
  @state() private icon: CategoryIcon = 'folder';
  @state() private saving = false;
  @state() private deleting = false;
  @state() private error = '';
  /** Folder found missing on the NAS: the next save creates it. */
  @state() private missingFolder: string | null = null;

  @query('dds-sheet') private sheet!: DdsSheet;
  @query('dds-folder-picker') private picker!: DdsFolderPicker;
  @query('#name') private nameInput?: HTMLInputElement;

  constructor() {
    super();
    new StoreController(this);
  }

  async open(category: Category | null): Promise<void> {
    this.editing = category;
    this.name = category?.name ?? '';
    this.folder = category?.destination ?? '';
    this.icon = category?.icon ?? 'folder';
    this.error = '';
    this.missingFolder = null;
    await this.updateComplete;
    await this.sheet.show();
    if (!category && matchMedia('(pointer: fine)').matches) this.nameInput?.focus();
  }

  /** Something differs from the destination being edited (always true for a new one). */
  private get changed(): boolean {
    const editing = this.editing;
    if (!editing) return true;
    return (
      this.name.trim() !== editing.name ||
      normalizePath(this.folder) !== editing.destination ||
      this.icon !== editing.icon
    );
  }

  /** The folder to save is known to be missing: saving creates it. */
  private get creatingFolder(): boolean {
    const folder = normalizePath(this.folder);
    return !!folder && this.missingFolder === folder;
  }

  /**
   * Checks that the folder exists, since a mistyped one would only show up at the first download.
   * False when it does not: the error says so and, below a shared folder, the next press creates
   * it.
   */
  private async checkFolder(path: string): Promise<boolean> {
    if (this.missingFolder === path) {
      const slash = path.lastIndexOf('/');
      await api.createFolder(path.slice(0, slash), path.slice(slash + 1));
      return true;
    }
    // Not checked when the NAS cannot tell (no access to File Station…): saved as typed.
    const listing = await api.folders(path).catch(() => null);
    if (!listing || listing.exists) return true;

    // Shared folders cannot be created from here: a mistyped one is pointed out.
    const share = path.split('/')[0]!;
    const shares = await api.folders().catch(() => null);
    const shareExists =
      !shares || shares.folders.some((item) => item.name.toLowerCase() === share.toLowerCase());
    if (!path.includes('/') || !shareExists) {
      this.error = t('destination.shareMissing', { name: share });
      return false;
    }
    this.missingFolder = path;
    return false;
  }

  private async save(): Promise<void> {
    const settings = store.settings;
    const name = this.name.trim();
    const destination = normalizePath(this.folder);
    if (!settings || !name || !destination || this.saving) return;

    const editing = this.editing;
    const item: Category = { id: editing?.id ?? '', name, icon: this.icon, destination };
    const categories = editing
      ? settings.categories.map((category) => (category.id === editing.id ? item : category))
      : [...settings.categories, item];

    this.saving = true;
    this.error = '';
    try {
      if (destination !== editing?.destination && !(await this.checkFolder(destination))) return;
      store.setSettings(await api.updateSettings({ categories }));
      store.toast(t('destination.saved'), 'success');
      this.sheet.close();
    } catch (error) {
      this.error = errorMessage(errorInfo(error).code);
    } finally {
      this.saving = false;
    }
  }

  private async deleteDestination(): Promise<void> {
    const editing = this.editing;
    if (!store.settings || !editing) return;
    const confirmed = await confirmAction({
      title: t('destination.deleteTitle', { name: editing.name }),
      message: t('destination.deleteMessage'),
      confirmLabel: t('destination.delete'),
    });
    const settings = store.settings;
    if (!confirmed || !settings) return;
    this.deleting = true;
    this.error = '';
    try {
      const categories = settings.categories.filter((category) => category.id !== editing.id);
      store.setSettings(await api.updateSettings({ categories }));
      store.toast(t('destination.deleted'), 'success');
      this.sheet.close();
    } catch (error) {
      this.error = errorMessage(errorInfo(error).code);
    } finally {
      this.deleting = false;
    }
  }

  override render() {
    const valid = !!this.name.trim() && !!normalizePath(this.folder);
    const creatingFolder = this.creatingFolder;
    const error = this.error || (creatingFolder ? t('destination.folderMissing') : '');

    return html`
      <dds-sheet
        heading=${this.editing ? t('destination.edit') : t('destination.new')}
        primaryLabel=${creatingFolder ? t('destination.createAndSave') : t('common.save')}
        ?primaryDisabled=${!valid || !this.changed || this.deleting}
        ?busy=${this.saving}
        .error=${error}
        @dds-primary=${this.save}
      >
        <section class="section">
          <div class="group">
            <div class="row input-row">
              <label class="field-label" for="name">${t('destination.name')}</label>
              <input
                id="name"
                class="inline-input"
                .value=${live(this.name)}
                maxlength="40"
                placeholder=${t('destination.namePlaceholder')}
                autocomplete="off"
                @input=${(event: Event) => (this.name = (event.target as HTMLInputElement).value)}
              />
            </div>
            <div class="row input-row">
              <label class="field-label" for="folder">${t('destination.folderShort')}</label>
              <input
                id="folder"
                class="inline-input"
                aria-label=${t('destination.folder')}
                .value=${live(this.folder)}
                placeholder=${t('destination.folderPlaceholder')}
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                spellcheck="false"
                @input=${(event: Event) => {
                  this.folder = (event.target as HTMLInputElement).value;
                  this.error = '';
                }}
              />
              <button
                class="icon-btn accent browse"
                aria-label=${t('destination.browse')}
                title=${t('destination.browse')}
                @click=${() => this.picker.open(this.folder)}
              >
                <dds-icon .path=${mdiFolderOpenOutline}></dds-icon>
              </button>
            </div>
          </div>
        </section>

        <section class="section">
          <h3 class="section-header">${t('destination.icon')}</h3>
          <div class="group icons" role="group" aria-label=${t('destination.icon')}>
            ${CATEGORY_ICONS.map(
              (icon) =>
                html`<button
                  class="icon-choice"
                  aria-label=${iconLabel(icon)}
                  aria-pressed=${this.icon === icon ? 'true' : 'false'}
                  title=${iconLabel(icon)}
                  @click=${() => (this.icon = icon)}
                >
                  <dds-icon .path=${categoryIcon(icon)}></dds-icon>
                </button>`,
            )}
          </div>
        </section>

        ${
          this.editing
            ? html`<section class="section">
                <div class="group">
                  <button
                    class="row destructive"
                    ?disabled=${this.saving || this.deleting}
                    @click=${this.deleteDestination}
                  >
                    ${t('destination.delete')}
                  </button>
                </div>
              </section>`
            : nothing
        }
      </dds-sheet>
      <dds-folder-picker
        @dds-pick=${(event: CustomEvent<string>) => {
          this.folder = event.detail;
          this.error = '';
        }}
      ></dds-folder-picker>
    `;
  }

  static override styles = [
    sharedStyles,
    inlineInputStyles,
    css`
      .field-label {
        flex: none;
        width: 76px;
        color: var(--text-secondary);
        cursor: default;
      }

      .input-row .browse {
        margin: -4px -12px -4px -4px;
      }

      /* Two rows of 7: squares of 44px at most, a bit less on narrow phones. */
      .icons {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        justify-items: center;
        gap: 8px;
        padding: 12px;
      }

      .icon-choice {
        display: grid;
        place-items: center;
        width: 100%;
        max-width: 44px;
        aspect-ratio: 1;
        padding: 0;
        border: none;
        border-radius: 10px;
        color: var(--text-secondary);
        background: var(--fill);
        cursor: pointer;
        transition:
          background-color 0.15s ease,
          color 0.15s ease;
      }

      @media (hover: hover) {
        .icon-choice:hover {
          background: var(--fill-hover);
        }
      }

      .icon-choice[aria-pressed='true'] {
        color: var(--text-on-accent);
        background: var(--accent);
      }

      .icon-choice dds-icon {
        --icon-size: 24px;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-destination-sheet': DdsDestinationSheet;
  }
}
