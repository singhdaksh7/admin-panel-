/**
 * Responsive HTML transactional email generator for Kash Commerce.
 * Table-based HTML structure tested for Outlook, Gmail, Apple Mail, and mobile clients.
 */

export interface EmailRenderOptions {
  storeName: string;
  storeLogoUrl?: string | null;
  supportEmail?: string | null;
  heading: string;
  bodyText: string;
  actionButton?: {
    label: string;
    url: string;
  };
  detailsCard?: {
    title: string;
    items: { label: string; value: string }[];
  };
  codeBox?: string;
  footerNote?: string;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderHtmlEmail(opts: EmailRenderOptions): string {
  const storeName = escapeHtml(opts.storeName || "Store");
  const heading = escapeHtml(opts.heading);
  const bodyParagraphs = opts.bodyText
    .split(/\n\s*\n/)
    .filter((p) => p.trim().length > 0)
    .map((p) => `<p style="margin: 0 0 16px; font-size: 15px; line-height: 24px; color: #374151;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");

  const logoOrBrand = opts.storeLogoUrl
    ? `<img src="${escapeHtml(opts.storeLogoUrl)}" alt="${storeName}" style="max-height: 48px; max-width: 220px; border: 0; display: block; object-fit: contain;" />`
    : `<span style="font-size: 20px; font-weight: 700; color: #111827; letter-spacing: -0.02em;">${storeName}</span>`;

  const codeBoxHtml = opts.codeBox
    ? `
      <div style="margin: 24px 0; text-align: center;">
        <div style="display: inline-block; padding: 14px 28px; background: #f3f4f6; border: 1px dashed #d1d5db; border-radius: 8px;">
          <span style="font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #111827;">${escapeHtml(opts.codeBox)}</span>
        </div>
        <p style="margin: 8px 0 0; font-size: 13px; color: #6b7280;">Valid for 10 minutes. Never share this code with anyone.</p>
      </div>`
    : "";

  const actionButtonHtml = opts.actionButton
    ? `
      <div style="margin: 28px 0; text-align: center;">
        <a href="${escapeHtml(opts.actionButton.url)}" target="_blank" style="display: inline-block; padding: 12px 28px; background-color: #111827; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; border-radius: 6px; letter-spacing: -0.01em;">
          ${escapeHtml(opts.actionButton.label)}
        </a>
      </div>`
    : "";

  const detailsCardHtml = opts.detailsCard
    ? `
      <div style="margin: 24px 0; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #f9fafb; padding: 16px 20px;">
        <h4 style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #111827; text-transform: uppercase; letter-spacing: 0.05em;">${escapeHtml(opts.detailsCard.title)}</h4>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size: 14px; border-collapse: collapse;">
          ${opts.detailsCard.items
            .map(
              (item) => `
            <tr>
              <td style="padding: 6px 0; color: #6b7280; font-weight: 500; width: 40%; vertical-align: top;">${escapeHtml(item.label)}</td>
              <td style="padding: 6px 0; color: #111827; font-weight: 600; text-align: right; vertical-align: top;">${escapeHtml(item.value)}</td>
            </tr>`,
            )
            .join("")}
        </table>
      </div>`
    : "";

  const supportEmailText = opts.supportEmail ? escapeHtml(opts.supportEmail) : null;
  const footerSupport = supportEmailText
    ? `Questions? Contact our team at <a href="mailto:${supportEmailText}" style="color: #4b5563; text-decoration: underline;">${supportEmailText}</a>.<br/>`
    : "";

  const footerCustom = opts.footerNote ? `${escapeHtml(opts.footerNote)}<br/>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${heading}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #374151; -webkit-font-smoothing: antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f3f4f6; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 580px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05); border: 1px solid #e5e7eb;">
          <!-- Header -->
          <tr>
            <td style="padding: 28px 32px 20px; border-bottom: 1px solid #f3f4f6;">
              ${logoOrBrand}
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding: 32px;">
              <h1 style="margin: 0 0 20px; font-size: 22px; font-weight: 700; color: #111827; letter-spacing: -0.02em; line-height: 28px;">${heading}</h1>
              ${bodyParagraphs}
              ${codeBoxHtml}
              ${detailsCardHtml}
              ${actionButtonHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; background-color: #fafafa; border-top: 1px solid #f3f4f6; font-size: 12px; line-height: 18px; color: #9ca3af; text-align: center;">
              ${footerSupport}
              ${footerCustom}
              &copy; ${new Date().getFullYear()} ${storeName}. All rights reserved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
