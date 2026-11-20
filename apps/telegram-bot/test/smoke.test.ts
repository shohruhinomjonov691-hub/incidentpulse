import { describe, expect, test } from "vitest";
import { createTelegramNotifier, type TelegramSender } from "../src/index.ts";

const TOKEN = "123456789:AAFakeTokenForTestsOnly_0123456789abcd";

function fakeApi() {
  const calls: Array<{ chatId: number; text: string; other: unknown }> = [];
  const api: TelegramSender = {
    async sendMessage(chatId, text, other) {
      calls.push({ chatId, text, other });
      return { message_id: 77 };
    },
  };
  return { api, calls };
}

describe("createTelegramNotifier", () => {
  test("sends plain text to the configured chat and returns the message id", async () => {
    const { api, calls } = fakeApi();
    const n = createTelegramNotifier({ token: TOKEN, chatId: "42", api });
    await expect(n.send("salom")).resolves.toEqual({ messageId: 77 });
    expect(calls).toEqual([
      { chatId: 42, text: "salom", other: { link_preview_options: { is_disabled: true } } },
    ]);
  });

  test("never lets the bot token or other secrets leave in a message", async () => {
    const { api, calls } = fakeApi();
    const n = createTelegramNotifier({ token: TOKEN, chatId: "42", api });
    await n.send(`oops ${TOKEN} and sk-proj-${"x".repeat(30)}`);
    expect(calls[0]?.text).not.toContain(TOKEN);
    expect(calls[0]?.text).not.toContain("sk-proj-");
  });

  test("truncates to Telegram's 4096-char limit", async () => {
    const { api, calls } = fakeApi();
    await createTelegramNotifier({ token: TOKEN, chatId: "42", api }).send("a".repeat(10_000));
    expect(calls[0]?.text.length).toBe(4096);
  });

  test("send errors are redacted (grammY embeds the token in URLs)", async () => {
    const api: TelegramSender = {
      async sendMessage() {
        throw new Error(
          `Network request for 'sendMessage' failed: https://api.telegram.org/bot${TOKEN}/sendMessage`,
        );
      },
    };
    const n = createTelegramNotifier({ token: TOKEN, chatId: "42", api });
    const error = await n.send("x").catch((e: Error) => e);
    expect((error as Error).message).toContain("Telegram sendMessage failed");
    expect((error as Error).message).not.toContain(TOKEN);
  });

  test("rejects a non-numeric chat id", () => {
    expect(() => createTelegramNotifier({ token: TOKEN, chatId: "abc" })).toThrow(/numeric/);
  });
});
