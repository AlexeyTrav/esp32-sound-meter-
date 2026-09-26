// Exit codes are part of the tool's contract with cron/systemd — keep stable.
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  SESSION_EXPIRED: 2,
  EXPORT_NOT_FOUND: 3,
  LOCKED: 4,
};

/** Navigation landed on a login/SSO page. Never retried, never auto-logged-in. */
export class SessionExpiredError extends Error {
  constructor(message = 'OPERA Cloud session has expired (login page detected)') {
    super(message);
    this.name = 'SessionExpiredError';
    this.exitCode = EXIT.SESSION_EXPIRED;
    this.retryable = false;
  }
}

/** No generated export exists for the requested business date. */
export class ExportNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportNotFoundError';
    this.exitCode = EXIT.EXPORT_NOT_FOUND;
    this.retryable = false;
  }
}

export class LockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockedError';
    this.exitCode = EXIT.LOCKED;
    this.retryable = false;
  }
}
