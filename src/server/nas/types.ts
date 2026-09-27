import { AppError } from '../errors.js';

export interface DsTask {
  id: string;
  /** Download Station status: waiting, downloading, paused, finishing, finished, error… */
  status: string;
  size: number;
  downloaded: number;
  speed: number;
  /** Error detail reported by Download Station, when status is `error`. */
  error: string | null;
  uri: string | null;
  /** File name chosen by Download Station. */
  title: string | null;
}

export interface LoginParams {
  account: string;
  password: string;
  otpCode?: string;
  /** Device token from a previous 2FA login ("remember this device"). */
  deviceId?: string;
}

export interface LoginResult {
  sid: string;
  /** Device token returned when logging in with a 2FA code. */
  deviceId: string | null;
}

/** Thrown when DSM no longer accepts a session id. */
export class NasSessionError extends AppError {
  constructor(readonly sid: string) {
    super('nas_session_expired');
    this.name = 'NasSessionError';
  }
}
