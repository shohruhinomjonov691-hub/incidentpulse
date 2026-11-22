import { describe, expect, test, vi } from "vitest";
import { createInvestigationBot } from "../src/index.ts";

function mockBot() {
  const enqueue = vi.fn(async () => {});
  const reply = vi.fn();
  const decide = vi.fn(async () => ({ answer: "OK" }));
  const setStopped = vi.fn(async (stopped: boolean) =>
    stopped ? "Runner: pauzada\nBajarilmoqda: pm2_restart\nNavbatda: nginx_reload" : "Runner: faol",
  );
  const bot = createInvestigationBot({
    token: "123:fake-token",
    chatId: "-100",
    allowedUsers: new Set([42]),
    enqueue,
    controls: { callback: decide, setStopped, status: async () => "status" },
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
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "sendMessage") reply(payload);
    else if (method !== "answerCallbackQuery")
      throw new Error(`Unexpected Telegram API method: ${method}`);
    return { ok: true, result: {} } as never;
  });
  const message = (id: number, chatId: number, argument: string, command = "/investigate") =>
    bot.handleUpdate({
      update_id: 900,
      message: {
        message_id: 1,
        date: 0,
        text: `${command} ${argument}`.trim(),
        entities: [{ offset: 0, length: command.length, type: "bot_command" }],
        chat: { id: chatId, type: "supergroup", title: "Test" },
        from: { id, is_bot: false, first_name: "Tester" },
      },
    });
  const callback = (id: number, chatId: number) =>
    bot.handleUpdate({
      update_id: 901,
      callback_query: {
        id: "test-callback",
        chat_instance: "chat",
        data: "signed-approval",
        from: { id, is_bot: false, first_name: "Tester" },
        message: {
          message_id: 1,
          date: 0,
          chat: { id: chatId, type: "supergroup", title: "Test" },
        },
      },
    });
  return { message, enqueue, reply, callback, decide, setStopped };
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

test("callback decisions and kill-switch commands require both the allowed sender and chat", async () => {
  const f = mockBot();
  await f.callback(41, -100);
  await f.callback(42, -101);
  await f.message(41, -100, "", "/stop");
  await f.message(42, -101, "", "/stop");
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.setStopped).not.toHaveBeenCalled();

  await f.callback(42, -100);
  expect(f.decide).toHaveBeenCalledExactlyOnceWith("signed-approval", 42);
  await f.message(42, -100, "", "/stop");
  expect(f.reply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      text: expect.stringContaining("Bajarilmoqda: pm2_restart\nNavbatda: nginx_reload"),
    }),
  );
  await f.message(42, -100, "", "/resume");
  expect(f.setStopped.mock.calls).toEqual([[true], [false]]);
});
