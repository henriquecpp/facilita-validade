import { createTransport } from 'nodemailer';
import type { NotificationChannel, OutboundMessage } from '../../application/ports.js';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** TLS implícito (porta 465). Com false, credenciais só trafegam após STARTTLS. */
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
}

/**
 * Lê a configuração SMTP do ambiente. Sem `SMTP_HOST`, o canal de e-mail fica desligado.
 * Gmail: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=<conta>` e
 * `SMTP_PASSWORD=<senha de app>` (exige verificação em duas etapas na conta Google).
 */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(env.SMTP_PORT ?? 465);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SMTP_PORT deve ser um número de porta válido.');
  const secureText = env.SMTP_SECURE ?? (port === 465 ? 'true' : 'false');
  if (secureText !== 'true' && secureText !== 'false')
    throw new Error('SMTP_SECURE deve ser true ou false.');
  const user = env.SMTP_USER?.trim() || undefined;
  const password = env.SMTP_PASSWORD || undefined;
  if (!!user !== !!password) throw new Error('Informe SMTP_USER e SMTP_PASSWORD juntos.');
  const from = env.SMTP_FROM?.trim() || user;
  if (!from) throw new Error('Informe SMTP_FROM (ou SMTP_USER) para o remetente dos alertas.');
  return { host, port, secure: secureText === 'true', user, password, from };
}

export class SmtpEmailChannel implements NotificationChannel {
  readonly id = 'email';
  private readonly transport;

  constructor(private readonly config: SmtpConfig) {
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure && !!config.user,
      auth: config.user ? { user: config.user, pass: config.password } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      logger: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(recipients: readonly string[], message: OutboundMessage) {
    const info = await this.transport.sendMail({
      from: this.config.from,
      to: [...recipients],
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { providerMessageId: info.messageId };
  }

  close() {
    this.transport.close();
  }
}
