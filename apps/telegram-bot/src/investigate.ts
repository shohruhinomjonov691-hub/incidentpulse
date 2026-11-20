import { describeError, type Redactor } from "@incidentpulse/redact";
import { type ProjectId, ProjectIdSchema } from "@incidentpulse/schemas";
import { Bot } from "grammy";

export function createInvestigationBot(options: {
  token: string;
  chatId: string;
  allowedUsers: ReadonlySet<number>;
  enqueue(project: ProjectId, updateId: number): Promise<void>;
  redact: Redactor;
  onError(error: string): void;
}) {
  const bot = new Bot(options.token);
  bot.command("investigate", async (ctx) => {
    if (
      String(ctx.chat.id) !== options.chatId ||
      !ctx.from ||
      !options.allowedUsers.has(ctx.from.id)
    )
      return;
    const project = ProjectIdSchema.safeParse(ctx.match.trim());
    if (!project.success) {
      await ctx.reply(`Foydalanish: /investigate <project>\n${ProjectIdSchema.options.join(", ")}`);
      return;
    }
    await options.enqueue(project.data, ctx.update.update_id);
    await ctx.reply("Tergov navbatga qo‘shildi.");
  });
  bot.catch((err) => options.onError(describeError(err.error, options.redact)));
  return bot;
}
