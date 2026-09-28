import { compose, escapeHtml, PRODUCT_NAME } from './compose';

describe('compose', () => {
  const base = {
    subject: 'Subject',
    heading: 'Heading',
    paragraphs: ['First paragraph.'],
  };

  it('escapes every character HTML treats specially', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  /**
   * The login mail shows the requester's User-Agent, which is whatever they
   * put in the header. Rendered raw, it would be markup in the victim's inbox.
   */
  it('escapes caller-controlled values in the HTML body', () => {
    const { html, text } = compose({
      ...base,
      details: [['Device', '<img src=x onerror=alert(1)>']],
    });

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Plain text has nothing to escape, and escaping it would garble it.
    expect(text).toContain('Device: <img src=x onerror=alert(1)>');
  });

  it('sets a code apart in both bodies', () => {
    const { html, text } = compose({ ...base, code: '123456' });

    expect(text).toContain('    123456');
    expect(html).toContain('>123456</p>');
  });

  it('renders an action as a button and as the bare URL', () => {
    const url = 'https://app.example.com/verify-email?token=abc&x=1';
    const { html, text } = compose({
      ...base,
      action: { label: 'Confirm', url },
    });

    expect(text).toContain(`Confirm:\n${url}`);
    expect(html).toContain(
      'href="https://app.example.com/verify-email?token=abc&amp;x=1"',
    );
    expect(html.match(/verify-email\?token=abc&amp;x=1/g)).toHaveLength(2);
  });

  it('refuses a link that is not http(s)', () => {
    expect(() =>
      compose({
        ...base,
        action: { label: 'Confirm', url: 'javascript:alert(1)' },
      }),
    ).toThrow('javascript:');
  });

  it('signs the text body and puts the footer before the signature', () => {
    const { text } = compose({ ...base, footer: ['Small print.'] });

    expect(text.trimEnd().endsWith(`Small print.\n\n— ${PRODUCT_NAME}`)).toBe(
      true,
    );
  });

  it('keeps the subject as given, and titles the HTML with it', () => {
    const mail = compose({ ...base, subject: 'A & B' });

    expect(mail.subject).toBe('A & B');
    expect(mail.html).toContain('<title>A &amp; B</title>');
  });

  it('leaves out the sections a mail does not use', () => {
    const { html } = compose(base);

    expect(html).not.toContain('<a ');
    expect(html).not.toContain(
      '<table role="presentation" style="margin:0 0 16px',
    );
  });
});
