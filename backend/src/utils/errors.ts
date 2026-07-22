export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class SecurityError extends AppError {
  constructor(message: string) {
    super(403, 'SECURITY_VIOLATION', message, true);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, 'VALIDATION_ERROR', message, true);
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = 'Rate limit exceeded') {
    super(429, 'RATE_LIMIT', message, true);
  }
}

export class GameIntegrityError extends AppError {
  constructor(message: string) {
    super(500, 'GAME_INTEGRITY_ERROR', message, false);
  }
}

export class InsufficientBalanceError extends AppError {
  constructor(message: string = 'Insufficient balance') {
    super(400, 'INSUFFICIENT_BALANCE', message, true);
  }
}
