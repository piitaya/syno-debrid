import { css, html, nothing } from 'lit';
import { t } from '../i18n.js';
import { mdiAlertCircleOutline, mdiCheckCircleOutline } from '../icons.js';
import './icon.js';

/** What a connection check found (Download Station, a debrid API key). */
export type CheckRow =
  | { status: 'checking' }
  | { status: 'ok'; title: string; subtitle?: string }
  | { status: 'error'; title: string; detail?: string };

/** A row of a sheet showing a check: in progress, working, or what went wrong. */
export function renderCheckRow(row: CheckRow) {
  if (row.status === 'checking') {
    return html`<div class="row check-row single" role="status">
      <span class="check-icon"><span class="spinner"></span></span>
      <span class="row-main"><span class="row-title secondary">${t('check.checking')}</span></span>
    </div>`;
  }
  const ok = row.status === 'ok';
  const subtitle = ok ? row.subtitle : row.detail;
  return html`<div
    class="row check-row ${subtitle ? '' : 'single'}"
    role=${ok ? 'status' : 'alert'}
  >
    <dds-icon
      class="check-icon ${ok ? 'success-text' : 'danger-text'}"
      .path=${ok ? mdiCheckCircleOutline : mdiAlertCircleOutline}
    ></dds-icon>
    <span class="row-main">
      <span class="row-title wrap ${ok ? '' : 'danger-text'}">${row.title}</span>
      ${subtitle ? html`<span class="row-subtitle wrap">${subtitle}</span>` : nothing}
    </span>
  </div>`;
}

export const checkRowStyles = css`
  .check-row {
    align-items: flex-start;
  }

  .check-icon {
    --icon-size: 22px;
    display: grid;
    flex: none;
    place-items: center;
    width: 22px;
    height: 22px;
    margin-top: -1px;
  }

  .check-icon .spinner {
    color: var(--text-secondary);
  }

  .check-row .row-main {
    align-self: center;
  }

  /* A single line: the icon is centered on it. */
  .check-row.single {
    align-items: center;
  }

  .check-row.single .check-icon {
    margin-top: 0;
  }
`;
