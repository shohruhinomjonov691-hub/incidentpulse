import { describeError, type Redactor } from "@incidentpulse/redact";
import { type ProjectId, ProjectIdSchema } from "@incidentpulse/schemas";
import { Bot, type Context } from "grammy";

export function createInvestigationBot(options: {
  token: string;
  chatId: string;
  allowedUsers: ReadonlySet<number>;
  enqueue(project: ProjectId, updateId: number): Promise<void>;
  redact: Redactor;
  onError(error: string): void;
  controls?: {
    /** May supply the reply when runner status is available. */
    setStopped(stopped: boolean): Promise<string | undefined>;
    status(): Promise<string>;
    callback(
      data: string,
      userId: number,
    ): Promise<{ answer: string; details?: string; resolved?: boolean }>;
  };
}) {
  const bot = new Bot(options.token);
  const authorized = (ctx: Context) =>
    String(ctx.chat?.id) === options.chatId &&
    ctx.from !== undefined &&
    options.allowedUsers.has(ctx.from.id);
  bot.command("investigate", async (ctx) => {
    if (!authorized(ctx)) return;
    const project = ProjectIdSchema.safeParse(ctx.match.trim());
    if (!project.success) {
      await ctx.reply(`Foydalanish: /investigate <project>\n${ProjectIdSchema.options.join(", ")}`);
      return;
    }
    await options.enqueue(project.data, ctx.update.update_id);
    await ctx.reply("Tergov navbatga qo‘shildi.");
  });
  const controls = options.controls;
  if (controls) {
    for (const command of ["stop", "resume"] as const) {
      bot.command(command, async (ctx) => {
        if (!authorized(ctx)) return;
        const reply = await controls.setStopped(command === "stop");
        const base = command === "stop" ? "Tergovlar to‘xtatildi." : "Tergovlar davom etmoqda.";
        await ctx.reply(reply ?? base);
      });
    }
    bot.command("status", async (ctx) => {
      if (authorized(ctx)) await ctx.reply(await controls.status());
    });
    bot.on("callback_query:data", async (ctx) => {
      if (!authorized(ctx)) {
        await ctx.answerCallbackQuery("Ruxsat yo‘q.");
        return;
      }
      const result = await controls.callback(ctx.callbackQuery.data, ctx.from.id);
      await ctx.answerCallbackQuery(result.answer);
      if (result.details) await ctx.api.sendMessage(ctx.from.id, result.details.slice(0, 4096));
      if (result.resolved)
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    });
  }
  bot.catch((err) => options.onError(describeError(err.error, options.redact)));
  return bot;
}
