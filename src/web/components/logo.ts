import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** The app mark (same drawing as public/icons/icon.svg), in the accent colour. */
@customElement('dds-logo')
export class DdsLogo extends LitElement {
  @property({ type: Number }) size = 32;

  static override styles = css`
    :host {
      display: inline-flex;
      flex: none;
      color: var(--accent);
    }

    svg {
      display: block;
    }
  `;

  override render() {
    return html`<svg
      width=${this.size}
      height=${this.size}
      viewBox="0 0 512 512"
      aria-hidden="true"
    >
      <rect width="512" height="512" rx="112" fill="currentColor" />
      <path
        d="M256 128v200m-88-88 88 88 88-88M152 384h208"
        fill="none"
        stroke="#fff"
        stroke-width="40"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-logo': DdsLogo;
  }
}
