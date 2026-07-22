import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { env } from './env';

const { combine, timestamp, json, errors } = winston.format;

const SENSITIVE_FIELDS = [
  'password', 'passwordHash', 'token', 'secret', 'key', 'seed',
  'privateKey', 'mnemonic', 'credit_card', 'ssn', 'otp'
];

const redactFormat = winston.format((info) => {
  const redacted = { ...info };

  const redactObject = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(key => {
      if (SENSITIVE_FIELDS.some(f => key.toLowerCase().includes(f))) {
        obj[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object') {
        redactObject(obj[key]);
      }
    });
  };

  redactObject(redacted);
  return redacted;
});

export const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  defaultMeta: { service: 'coinmaster-pro' },
  format: combine(
    timestamp(),
    redactFormat(),
    errors({ stack: true }),
    json()
  ),
  transports: [
    new winston.transports.Console({
      format: env.NODE_ENV === 'development' 
        ? combine(winston.format.colorize(), winston.format.simple())
        : undefined
    }),
    new DailyRotateFile({
      filename: 'logs/application-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d'
    }),
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '90d'
    })
  ]
});

export const auditLogger = winston.createLogger({
  level: 'info',
  format: combine(timestamp(), json()),
  transports: [
    new DailyRotateFile({
      filename: 'logs/audit-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '50m',
      maxFiles: '7y'
    })
  ]
});
