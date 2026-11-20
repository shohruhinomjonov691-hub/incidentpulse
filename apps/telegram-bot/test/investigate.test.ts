import { describe, expect, test, vi } from "vitest";
import { createInvestigationBot } from "../src/index.ts";

function mockBot() {
  const enqueue = vi.fn(async () => {});
  const reply = vi.fn();
  const bot = createInvestigationBot({
    token: "123:fake-token",
    chatId: "-100",
    allowedUsers: new Set([42]),
    enqueue,
    redact: (text) => text,
    onError: (error) => {
      throw new Error(error);
    },
  });
  bot.botInfo = {
    id: 123,
    is_bot: true,
    first_name: "Incidents",
    username: "incidents_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    supports_join_request_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
  };
  bot.api.config.use(async (_previous, method) => {
    if (method !== "sendMessage") throw new Error(`Unexpected Telegram API method: ${method}`);
    reply();
    return { ok: true, result: {} } as never;
  });
  const message = (id: number, chatId: number, argument: string) =>
    bot.handleUpdate({
      update_id: 900,
      message: {
        message_id: 1,
        date: 0,
        text: `/investigate ${argument}`,
        entities: [{ offset: 0, length: 12, type: "bot_command" }],
        chat: { id: chatId, type: "supergroup", title: "Test" },
        from: { id, is_bot: false, first_name: "Tester" },
      },
    });
  return { message, enqueue, reply };
}

describe("/investigate", () => {
  test("only the allowed sender in the configured chat can enqueue a valid project", async () => {
    const f = mockBot();
    await f.message(41, -100, "kervan");
    await f.message(42, -101, "kervan");
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();

    await f.message(42, -100, "invalid");
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledTimes(1);

    await f.message(42, -100, "kervan");
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith("kervan", 900);
    expect(f.reply).toHaveBeenCalledTimes(2);
  });
});
