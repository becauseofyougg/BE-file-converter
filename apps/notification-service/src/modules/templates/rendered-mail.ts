/** A mail ready to hand to SMTP: both bodies, because some clients show only text. */
export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}
