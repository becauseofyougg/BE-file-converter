import type { RenderedMail } from './rendered-mail';

export const PRODUCT_NAME = 'File Converter';

/**
 * What a mail says, independent of how it is laid out. Every string here is
 * plain text: {@link compose} escapes all of it for the HTML body, so a
 * template cannot forget to — which matters, because some of these values
 * come from whoever sent the request. The User-Agent on a login mail is
 * whatever the caller chose to put in the header.
 */
export interface MailContent {
  subject: string;
  heading: string;
  paragraphs: string[];
  /** A one-time code, set apart so it can be read and typed. */
  code?: string;
  /** The one thing to click. Must be an absolute http(s) URL. */
  action?: { label: string; url: string };
  /** Label/value pairs, e.g. the device a sign-in came from. */
  details?: Array<[label: string, value: string]>;
  /** Small print — mainly "if this was not you". */
  footer?: string[];
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * Refuses anything but http(s). The URLs come from our own configuration, so
 * this is a backstop — but a `javascript:` href in a mail is not a mistake
 * worth being able to make.
 */
function safeHref(url: string): string {
  const { protocol } = new URL(url);

  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`Refusing to render a ${protocol} link`);
  }

  return escapeHtml(url);
}

export function compose(content: MailContent): RenderedMail {
  return {
    subject: content.subject,
    text: composeText(content),
    html: composeHtml(content),
  };
}

function composeText({
  heading,
  paragraphs,
  code,
  action,
  details,
  footer,
}: MailContent): string {
  const blocks: string[] = [heading, ...paragraphs];

  if (code) {
    blocks.push(`    ${code}`);
  }

  if (action) {
    blocks.push(`${action.label}:\n${action.url}`);
  }

  if (details?.length) {
    blocks.push(
      details.map(([label, value]) => `${label}: ${value}`).join('\n'),
    );
  }

  blocks.push(...(footer ?? []), `— ${PRODUCT_NAME}`);

  return `${blocks.join('\n\n')}\n`;
}

/**
 * Tables and inline styles, because that is what mail clients render
 * consistently; a stylesheet or a flexbox layout is stripped by half of them.
 */
function composeHtml({
  subject,
  heading,
  paragraphs,
  code,
  action,
  details,
  footer,
}: MailContent): string {
  const rows: string[] = [
    `<h1 style="margin:0 0 16px;font-size:20px;">${escapeHtml(heading)}</h1>`,
    ...paragraphs.map(
      (paragraph) => `<p style="margin:0 0 16px;">${escapeHtml(paragraph)}</p>`,
    ),
  ];

  if (code) {
    rows.push(
      `<p style="margin:0 0 16px;font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace;">${escapeHtml(code)}</p>`,
    );
  }

  if (action) {
    const href = safeHref(action.url);

    rows.push(
      `<p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;padding:10px 20px;background:#1a56db;color:#ffffff;text-decoration:none;border-radius:4px;">${escapeHtml(action.label)}</a></p>`,
      // The bare URL too: some clients block buttons, and a user should be able
      // to see where a link goes before trusting it.
      `<p style="margin:0 0 16px;font-size:12px;color:#555555;word-break:break-all;">${href}</p>`,
    );
  }

  if (details?.length) {
    rows.push(
      `<table role="presentation" style="margin:0 0 16px;font-size:14px;">${details
        .map(
          ([label, value]) =>
            `<tr><td style="padding:2px 12px 2px 0;color:#555555;">${escapeHtml(label)}</td><td style="padding:2px 0;">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}</table>`,
    );
  }

  for (const line of footer ?? []) {
    rows.push(
      `<p style="margin:0 0 12px;font-size:12px;color:#555555;">${escapeHtml(line)}</p>`,
    );
  }

  return [
    '<!doctype html>',
    `<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#111111;">',
    '<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:6px;">',
    `<tr><td style="padding:32px;">${rows.join('')}</td></tr>`,
    '</table>',
    `<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#888888;text-align:center;">${escapeHtml(PRODUCT_NAME)}</p>`,
    '</body></html>',
  ].join('');
}
