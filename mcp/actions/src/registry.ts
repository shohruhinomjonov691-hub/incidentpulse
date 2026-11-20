import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CategorySchema,
  type ProjectId,
  type RunbookId,
  RunbookIdSchema,
} from "@incidentpulse/schemas";
import { parseDocument } from "yaml";
import { z } from "zod";

export const RunbookChoiceSchema = z.strictObject({
  runbookId: RunbookIdSchema,
  params: z.record(z.string(), z.string()),
});
export type RunbookChoice = z.infer<typeof RunbookChoiceSchema>;
export type RunbookRisk = "low" | "medium";
const Program = z.enum(["certbot", "nginx", "systemctl", "docker", "pm2"]);
export type ActionProgram = z.infer<typeof Program>;
const Step = z.tuple([Program], z.string().min(1));
const Target = z.enum(["domains", "containers", "pm2", "compose"]);
const Book = z.strictObject({
  id: RunbookIdSchema,
  category: CategorySchema,
  risk: z.enum(["low", "medium"]),
  params: z.partialRecord(z.enum(["domain", "service", "app", "project"]), Target),
  dry_run: z.array(Step).min(1),
  run: z.array(Step).min(1),
  prerequisite: z.literal("missing_certificate_or_vhost").optional(),
});

export interface ActionScope {
  domains: string[];
  containers?: string[];
  pm2?: string[];
  compose?: { name: string; file: string };
  nginx?: boolean;
  webroot?: string;
}
export type ActionScopes = Partial<Record<ProjectId, ActionScope>>;

export interface ActionStep {
  program: ActionProgram;
  args: string[];
}

export interface ResolvedRunbook extends RunbookChoice {
  risk: RunbookRisk;
  dryRun: ActionStep[];
  run: ActionStep[];
  prerequisite?: "missing_certificate_or_vhost";
}

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,126}$/;
const DEFAULT_REGISTRY = fileURLToPath(new URL("../../../runbooks", import.meta.url));

function matchingValues(target: z.infer<typeof Target>, scope: ActionScope) {
  switch (target) {
    case "domains":
      return scope.domains.map((domain) => new URL(`https://${domain}`).hostname);
    case "containers":
      return scope.containers ?? [];
    case "pm2":
      return scope.pm2 ?? [];
    case "compose":
      return scope.compose ? [scope.compose.name] : [];
  }
}

export function loadRunbookRegistry(scopes: ActionScopes, directory = DEFAULT_REGISTRY) {
  const books = new Map<RunbookId, z.infer<typeof Book>>();
  for (const id of RunbookIdSchema.options) {
    const document = parseDocument(readFileSync(join(directory, `${id}.yaml`), "utf8"));
    if (document.errors.length) throw new Error(`Invalid YAML for ${id}`);
    const book = Book.parse(document.toJS({ maxAliasCount: 0 }));
    if (book.id !== id) throw new Error(`Runbook id differs from filename: ${id}`);
    books.set(id, book);
  }

  function candidates(project: ProjectId) {
    const scope = scopes[project];
    if (!scope) return [];
    return [...books.values()]
      .filter(
        (book) =>
          (book.id !== "nginx_reload" || scope.nginx) &&
          (book.id !== "certbot_nginx_issue" || (scope.webroot && isAbsolute(scope.webroot))) &&
          (book.id !== "docker_compose_up" || (scope.compose && isAbsolute(scope.compose.file))),
      )
      .map(({ id, category, risk, params }) => ({
        id,
        category,
        risk,
        params: Object.fromEntries(
          Object.entries(params).map(([name, target]) => [
            name,
            matchingValues(target, scope).filter((value) => SAFE_NAME.test(value)),
          ]),
        ),
      }))
      .filter((candidate) => Object.values(candidate.params).every((values) => values.length > 0));
  }

  function resolve(project: ProjectId, input: unknown): ResolvedRunbook {
    const choice = RunbookChoiceSchema.parse(input);
    const book = books.get(choice.runbookId);
    const candidate = candidates(project).find((item) => item.id === choice.runbookId);
    if (!book || !candidate) throw new Error("Runbook is outside the project's action allowlist");
    const schema = z.strictObject(
      Object.fromEntries(
        Object.entries(candidate.params).map(([name, allowed]) => [
          name,
          z
            .string()
            .regex(SAFE_NAME)
            .refine((value) => allowed.includes(value)),
        ]),
      ),
    );
    const params = schema.parse(choice.params) as Record<string, string>;
    const trusted = {
      ...params,
      composeFile: scopes[project]?.compose?.file,
      webroot: scopes[project]?.webroot,
    };
    const steps = (list: z.infer<typeof Step>[]) =>
      list.map(([program, ...args]) => ({
        program,
        args: args.map((part) => {
          const key = /^\{([A-Za-z]+)\}$/.exec(part)?.[1];
          if (!key) return part;
          const value = (trusted as Record<string, string | undefined>)[key];
          if (!value) throw new Error(`Unbound runbook parameter: ${key}`);
          return value;
        }),
      }));
    return {
      runbookId: choice.runbookId,
      params,
      risk: book.risk,
      dryRun: steps(book.dry_run),
      run: steps(book.run),
      ...(book.prerequisite ? { prerequisite: book.prerequisite } : {}),
    };
  }
  return { resolve, candidates };
}

export type RunbookRegistry = ReturnType<typeof loadRunbookRegistry>;
