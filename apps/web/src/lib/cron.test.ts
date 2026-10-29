import { describe, expect, it } from 'vitest';
import { describeCron, fromCron, timezoneOptions, toCron } from './cron';

describe('schedule cron', () => {
  it('round-trips every shape the form writes', () => {
    for (const cron of ['0 8 * * *', '30 9 * * 1-5', '15 7 * * 1,5', '0 6 1 * *']) expect(toCron(fromCron(cron)!)).toBe(cron);
  });

  it('describes in words and leaves anything else as custom', () => {
    expect(describeCron('0 8 * * 1')).toBe('Every Mon at 08:00');
    expect(describeCron('30 9 * * 1-5')).toBe('Weekdays (Mon–Fri) at 09:30');
    expect(describeCron('0 6 2 * *')).toBe('Monthly on the 2nd at 06:00');
    expect(fromCron('*/15 * * * *')).toBeNull();
    expect(fromCron('0 8 * 1 *')).toBeNull();
    expect(describeCron('0 8 * 1 *')).toBe('Custom (0 8 * 1 *)');
  });

  it('lists zones and keeps an unknown saved one', () => {
    expect(timezoneOptions().some((z) => z.value === 'Asia/Kolkata')).toBe(true);
    expect(timezoneOptions('Etc/Unknown')[0].value).toBe('Etc/Unknown');
  });
});
