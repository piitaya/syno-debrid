import { css } from 'lit';

/** Full-page forms shown before signing in: sign-in, first start. */
export const authStyles = css`
  main {
    display: grid;
    place-items: center;
    min-height: 100vh;
    min-height: 100dvh;
    padding: calc(24px + env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom));
  }

  form {
    display: grid;
    gap: 16px;
    width: min(360px, 100%);
  }

  header {
    display: grid;
    justify-items: center;
    gap: 6px;
    margin-bottom: 12px;
    text-align: center;
    text-wrap: pretty;
  }

  header dds-logo {
    margin-bottom: 10px;
  }

  h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .fields input {
    display: block;
    width: 100%;
    min-height: var(--row-height);
    padding: 0 16px;
    border: none;
    font: inherit;
    font-size: 16px;
    color: var(--text);
    background: transparent;
    outline: none;
  }

  .fields input + input {
    border-top: 0.5px solid var(--separator);
  }

  .fields input::placeholder {
    color: var(--text-tertiary);
  }

  /* The group shows the focus (below): a ring around a field would be cut by the group. */
  .fields input:focus-visible {
    box-shadow: none;
  }

  /* Keyboard and mouse: the group shows where typing goes (touch screens show the keyboard). */
  @media (pointer: fine) {
    .fields:focus-within {
      box-shadow: var(--focus-ring);
    }
  }

  .hint {
    margin-top: -8px;
    padding: 0 16px;
  }

  .submit {
    min-height: 50px;
    margin-top: 4px;
    font-size: 17px;
    border-radius: var(--radius-lg);
  }

  /* Secondary action under the main button. */
  .link {
    justify-self: center;
    margin-top: -4px;
    font-weight: 400;
  }
`;
