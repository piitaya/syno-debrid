import { css } from 'lit';

/*
 * Shared building blocks (components live in shadow roots, so every component includes
 * `sharedStyles`). Visual rules: one accent colour, flat surfaces, no gradients, hairline
 * separators, 8px spacing grid. Hover styles only apply to devices that can hover: after a tap,
 * a touch screen would keep them.
 */
export const sharedStyles = css`
  :host {
    display: block;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  [hidden] {
    display: none !important;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  a {
    color: var(--accent);
    text-decoration: none;
  }

  button {
    font: inherit;
    color: inherit;
  }

  :focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }

  /* Text */
  .secondary {
    color: var(--text-secondary);
  }

  .small {
    font-size: 13px;
  }

  .danger-text {
    color: var(--danger);
  }

  .success-text {
    color: var(--success);
  }

  .warning-text {
    color: var(--warning);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 0.9em;
  }

  .num {
    font-variant-numeric: tabular-nums;
  }

  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wrap {
    overflow-wrap: anywhere;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: var(--control-height);
    padding: 0 14px;
    border: none;
    border-radius: var(--radius);
    font-size: 15px;
    font-weight: 600;
    line-height: 1;
    color: var(--text);
    background: var(--fill);
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    white-space: nowrap;
    transition:
      background-color 0.15s ease,
      opacity 0.15s ease;
  }

  .btn:active {
    background: var(--fill-pressed);
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: default;
    pointer-events: none;
  }

  .btn dds-icon {
    --icon-size: 18px;
  }

  .btn-primary {
    color: var(--text-on-accent);
    background: var(--accent);
  }

  .btn-primary:active {
    background: var(--accent-pressed);
  }

  .btn-primary:disabled {
    color: var(--text-tertiary);
    background: var(--fill);
    opacity: 1;
  }

  .btn-plain {
    color: var(--accent);
    background: transparent;
  }

  .btn-plain:active {
    background: var(--accent-fill);
    opacity: 0.8;
  }

  .btn-sm {
    min-height: 30px;
    padding: 0 10px;
    font-size: 13px;
    border-radius: var(--radius-sm);
  }

  @media (pointer: coarse) {
    .btn-sm {
      min-height: 36px;
      font-size: 15px;
    }
  }

  .btn-block {
    width: 100%;
  }

  .icon-btn {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: var(--control-height);
    height: var(--control-height);
    padding: 0;
    border: none;
    border-radius: var(--radius);
    color: var(--text-secondary);
    background: transparent;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .icon-btn:active {
    background: var(--fill-hover);
  }

  .icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .icon-btn.accent {
    color: var(--accent);
  }

  .icon-btn dds-icon {
    --icon-size: 20px;
  }

  /* Grouped lists (iOS settings style) */
  .section + .section {
    margin-top: 28px;
  }

  .section-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    min-height: 24px;
    padding: 0 16px 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .section-header h2 {
    font: inherit;
  }

  .section-header .count {
    font-weight: 400;
  }

  /* Keeps a finger-sized target without growing the header. */
  .section-header .btn-plain {
    min-height: 36px;
    margin: -10px -10px -10px 0;
    padding: 0 10px;
    font-size: 15px;
    font-weight: 400;
  }

  .section-footer {
    padding: 6px 16px 0;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .group {
    overflow: hidden;
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
  }

  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: var(--row-height);
    padding: 8px 16px;
    border: none;
    font: inherit;
    text-align: left;
    color: inherit;
    background: transparent;
    text-decoration: none;
  }

  /* Hairline separators, inset to the text column. */
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    left: var(--separator-inset, 16px);
    height: 1px;
    background: var(--separator);
    transform: scaleY(0.5);
    transform-origin: top;
  }

  .group.with-icons {
    --separator-inset: 56px;
  }

  /* Inside the ring: the group's rounded edges would cut it. */
  .row:focus-visible {
    box-shadow: inset var(--focus-ring);
  }

  button.row,
  a.row,
  label.row {
    cursor: pointer;
  }

  button.row:active,
  a.row:active {
    background: var(--fill-hover);
  }

  button.row:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .row-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 7px;
    color: var(--text-secondary);
    background: var(--fill);
  }

  .row-icon dds-icon {
    --icon-size: 18px;
  }

  .row-icon.accent {
    color: var(--text-on-accent);
    background: var(--accent);
  }

  .row-main {
    display: grid;
    flex: 1;
    gap: 1px;
    min-width: 0;
  }

  .row-title {
    font-size: 15px;
  }

  .row-subtitle {
    font-size: 13px;
    color: var(--text-secondary);
  }

  .row-value {
    flex: none;
    max-width: 50%;
    font-size: 15px;
    color: var(--text-secondary);
  }

  .chevron {
    --icon-size: 18px;
    flex: none;
    margin-right: -4px;
    color: var(--text-tertiary);
  }

  .check {
    --icon-size: 20px;
    flex: none;
    color: var(--accent);
  }

  .row.destructive {
    justify-content: center;
    color: var(--danger);
  }

  .row.accent {
    color: var(--accent);
  }

  .row.action {
    justify-content: center;
    color: var(--accent);
  }

  /* Switch */
  input.switch {
    position: relative;
    flex: none;
    width: 44px;
    height: 26px;
    margin: 0;
    border-radius: 13px;
    background: var(--fill-pressed);
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
    transition: background-color 0.2s ease;
  }

  input.switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform 0.2s ease;
  }

  input.switch:checked {
    background: var(--accent);
  }

  input.switch:checked::after {
    transform: translateX(18px);
  }

  /* Progress */
  .progress {
    position: relative;
    height: 4px;
    overflow: hidden;
    border-radius: 2px;
    background: var(--fill);
  }

  .progress > span {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.4s ease;
  }

  .progress.indeterminate > span {
    width: 30%;
    animation: indeterminate 1.2s ease-in-out infinite;
  }

  @keyframes indeterminate {
    from {
      left: -30%;
    }
    to {
      left: 100%;
    }
  }

  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }

  /* Inline notice (errors, warnings) */
  .notice {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: var(--radius);
    font-size: 13px;
    color: var(--danger);
    background: var(--danger-fill);
  }

  .notice dds-icon {
    --icon-size: 18px;
    flex: none;
  }

  .notice.neutral {
    color: var(--text-secondary);
    background: var(--bg-elevated);
  }

  .notice-text {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .notice-text a {
    justify-self: start;
    font-weight: 600;
  }

  /* Pressed styles (:active, above) win over these. */
  @media (hover: hover) {
    a:hover {
      text-decoration: underline;
    }

    .btn:hover:not(:active) {
      background: var(--fill-hover);
    }

    .btn-primary:hover:not(:active) {
      background: var(--accent-pressed);
    }

    .btn-plain:hover:not(:active) {
      background: var(--accent-fill);
    }

    .icon-btn:hover:not(:disabled, :active) {
      background: var(--fill);
    }

    button.row:hover:not(:disabled, :active),
    a.row:hover:not(:active),
    label.row:hover {
      background: var(--fill);
      text-decoration: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
`;

/** Borderless input filling a row (the row is the field). */
export const inlineInputStyles = css`
  /* A row holding a field. */
  .input-row {
    padding-top: 4px;
    padding-bottom: 4px;
  }

  .inline-input {
    flex: 1;
    min-width: 0;
    min-height: 32px;
    padding: 0;
    border: none;
    font: inherit;
    /* 16px keeps iOS Safari from zooming in on focus. */
    font-size: 16px;
    color: var(--text);
    background: transparent;
    outline: none;
  }

  .inline-input:focus-visible {
    box-shadow: none;
  }

  .inline-input::placeholder {
    font-family: var(--font);
    color: var(--text-tertiary);
  }

  .inline-input.mono-input {
    font-family: var(--font-mono);
  }

  @media (pointer: fine) {
    .inline-input {
      font-size: 15px;
    }

    /* Keyboard and mouse: the group shows where typing goes (touch screens show the keyboard). */
    .group:has(.inline-input:focus) {
      box-shadow: var(--focus-ring);
    }
  }
`;
