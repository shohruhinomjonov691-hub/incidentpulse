import { createRedactor, describeError, type Redactor } from "@incidentpulse/redact";
import { Api } from "grammy";

/**
 * Phase 1: outbound, read-only notifications. No buttons, no commands, no callbacks yet
 * (inline Approve/Reject, /status and /stop arrive in Phase 4).
 */

export interface Notifier {
  send(text: string): Promise<{ messageId: number }>;
}

/** The slice of grammY's Api we use; lets tests inject a mock. */
export interface TelegramSender {
  sendMessage(
    chatId: number,
    text: string,
    other?: { link_preview_options?: { is_disabled: boolean } },
  ): Promise<{ message_id: number }>;
}

const TELEGRAM_LIMIT = 4096;

export function createTelegramNotifier(options: {
  token: string;
  chatId: string;
  redact?: Redactor;
  api?: TelegramSender;
}): Notifier {
  const chatId = Number(options.chatId);
  if (!Number.isSafeInteger(chatId)) throw new Error("TELEGRAM_CHAT_ID must be a numeric chat id");
  // Always mask our own token, whatever redactor the caller passes in.
  const own = createRedactor({ secrets: [options.token] });
  const redact: Redactor = (t) => own(options.redact ? options.redact(t) : t);
  const api: TelegramSender = options.api ?? new Api(options.token);

  return {
    async send(text) {
      const safe = redact(text);
      const body = safe.length > TELEGRAM_LIMIT ? `${safe.slice(0, TELEGRAM_LIMIT - 1)}…` : safe;
      try {
        // Plain text on purpose (no parse_mode): nothing in the message can be interpreted as markup.
        const sent = await api.sendMessage(chatId, body, {
          link_preview_options: { is_disabled: true },
        });
        return { messageId: sent.message_id };
      } catch (error) {
        // grammY errors can embed the request URL, which contains the bot token.
        throw new Error(`Telegram sendMessage failed: ${describeError(error, redact)}`);
      }
    },
  };
}
