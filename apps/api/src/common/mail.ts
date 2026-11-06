import { Logger } from '@nestjs/common';

const logger = new Logger('Mail');

/** Transactional e-mail through Resend's REST API. Without RESEND_API_KEY mail is only logged (dev). */
export async function sendMail(to: string, subject: string, html: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    logger.warn(`RESEND_API_KEY is not set; not sending "${subject}" to ${to}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'Iverto Attendance <no-reply@mailservice.iverto.ai>', to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
