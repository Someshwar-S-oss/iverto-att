import { Matches, registerDecorator, ValidationOptions } from 'class-validator';

function isValidTimeZone(v: unknown): boolean {
  if (typeof v !== 'string' || !v) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

export function IsTimeZone(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isTimeZone',
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} must be an IANA timezone, e.g. Asia/Kolkata`, ...options },
      validator: { validate: (v: unknown) => isValidTimeZone(v) },
    });
}

/** 'YYYY-MM-DD' that is also a real calendar date. */
export function IsYmd(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isYmd',
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} must be a date YYYY-MM-DD`, ...options },
      validator: {
        validate: (v: unknown) =>
          typeof v === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(v) &&
          new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
      },
    });
}

/** Wall-clock 'HH:mm'. */
export const IsHm = (options?: ValidationOptions) =>
  Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'must be a time HH:mm', ...options });

export const IsMonth = (options?: ValidationOptions) =>
  Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'must be a month YYYY-MM', ...options });
