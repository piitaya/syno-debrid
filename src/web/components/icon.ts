import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('dds-icon')
export class DdsIcon extends LitElement {
  @property() path = '';

  static override styles = css`
    :host {
      display: inline-flex;
      flex: none;
      width: var(--icon-size, 24px);
      height: var(--icon-size, 24px);
      color: inherit;
    }

    svg {
      width: 100%;
      height: 100%;
      fill: currentColor;
    }
  `;

  override render() {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${this.path}></path></svg>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dds-icon': DdsIcon;
  }
}
