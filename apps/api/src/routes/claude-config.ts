import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ClaudeConfigSource } from "@optio/shared";
import * as claudeConfigService from "../services/claude-config-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";
import { redactSkillSource } from "../utils/skill-sync-error.js";

const ClaudeConfigSourceSchema = z.unknown().describe("Claude config repo source row");

// Both reach `git` as arguments: never one it could read as an option.
const sourceUrlSchema = z
  .string()
  .min(1)
  .refine((v) => !v.trimStart().startsWith("-"), 'sourceUrl must not start with "-"');
const refSchema = z
  .string()
  .refine((v) => !v.trimStart().startsWith("-"), 'ref must not start with "-"');

const createSchema = z
  .object({
    sourceUrl: sourceUrlSchema.describe("Git URL of the repo laid out like ~/.claude"),
    ref: refSchema.optional().describe("Branch, tag, or SHA. Defaults to 'main'."),
    subpath: z
      .string()
      .optional()
      .describe("Directory within the repo that is ~/.claude. Defaults to the repo root."),
    repoUrl: z
      .string()
      .min(1)
      .optional()
      .describe("Repo this config replaces the workspace's for; omit for the workspace's"),
    enabled: z.boolean().optional(),
  })
  .describe("Body for adding a Claude config repo");

const updateSchema = z
  .object({
    sourceUrl: sourceUrlSchema.optional(),
    ref: refSchema.optional(),
    subpath: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .describe("Partial update to a Claude config repo");

const ListResponseSchema = z.object({ sources: z.array(ClaudeConfigSourceSchema) });
const ItemResponseSchema = z.object({ source: ClaudeConfigSourceSchema });

/** The URL can carry a token; it never leaves the API in the clear. */
const present = (s: ClaudeConfigSource): ClaudeConfigSource => ({
  ...s,
  sourceUrl: redactSkillSource(s.sourceUrl),
});

/** The source, when it is in the caller's workspace (else 404). */
async function requireSource(req: FastifyRequest, reply: FastifyReply, id: string) {
  const source = await claudeConfigService.getClaudeConfigSource(id);
  const wsId = req.user?.workspaceId;
  if (!source || (wsId && source.workspaceId && source.workspaceId !== wsId)) {
    reply.status(404).send({ error: "Claude config repo not found" });
    return null;
  }
  return source;
}

export async function claudeConfigRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const tags = ["Repos & Integrations"];

  app.get(
    "/api/claude-config",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "listClaudeConfigSources",
        summary: "List Claude config repos",
        description:
          "The workspace's Claude config repo and any per-repo overrides. Admin only: the source URL may carry credentials.",
        tags,
        response: { 200: ListResponseSchema },
      },
    },
    async (req, reply) => {
      const sources = await claudeConfigService.listClaudeConfigSources(
        req.user?.workspaceId ?? null,
      );
      reply.send({ sources: sources.map(present) });
    },
  );

  app.get(
    "/api/claude-config/:id",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "getClaudeConfigSource",
        summary: "Get a Claude config repo",
        tags,
        params: IdParamsSchema,
        response: { 200: ItemResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const source = await requireSource(req, reply, req.params.id);
      if (source) reply.send({ source: present(source) });
    },
  );

  app.post(
    "/api/claude-config",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "createClaudeConfigSource",
        summary: "Add a Claude config repo",
        description:
          "Registers a git repo laid out like ~/.claude, written to /home/agent/.claude in Claude Code pods. One per scope: the workspace's, and one per repo that replaces it for that repo. Synced right away, then every few minutes.",
        tags,
        body: createSchema,
        response: { 201: ItemResponseSchema, 400: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const source = await claudeConfigService.createClaudeConfigSource(
          req.body,
          req.user?.workspaceId ?? null,
        );
        const { enqueueClaudeConfigSync } = await import("../workers/claude-config-sync-worker.js");
        await enqueueClaudeConfigSync(source.id).catch(() => {});
        reply.status(201).send({ source: present(source) });
      } catch (err) {
        if (err instanceof claudeConfigService.ClaudeConfigScopeTakenError) {
          return reply.status(409).send({ error: err.message });
        }
        reply.status(400).send({ error: err instanceof Error ? err.message : "invalid input" });
      }
    },
  );

  app.patch(
    "/api/claude-config/:id",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "updateClaudeConfigSource",
        summary: "Update a Claude config repo",
        tags,
        params: IdParamsSchema,
        body: updateSchema,
        response: { 200: ItemResponseSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const existing = await requireSource(req, reply, req.params.id);
      if (!existing) return;
      try {
        const source = await claudeConfigService.updateClaudeConfigSource(req.params.id, req.body);
        const moved =
          req.body.sourceUrl !== undefined ||
          req.body.ref !== undefined ||
          req.body.subpath !== undefined;
        if (moved || req.body.enabled === true) {
          const { enqueueClaudeConfigSync } =
            await import("../workers/claude-config-sync-worker.js");
          await enqueueClaudeConfigSync(source.id).catch(() => {});
        }
        reply.send({ source: present(source) });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : "invalid input" });
      }
    },
  );

  app.delete(
    "/api/claude-config/:id",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "deleteClaudeConfigSource",
        summary: "Delete a Claude config repo",
        tags,
        params: IdParamsSchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!(await requireSource(req, reply, req.params.id))) return;
      await claudeConfigService.deleteClaudeConfigSource(req.params.id);
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/claude-config/:id/sync",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "syncClaudeConfigSource",
        summary: "Force a sync of a Claude config repo",
        description:
          "Enqueues an immediate sync and returns 202; poll GET /:id for lastSyncedAt / lastSyncError.",
        tags,
        params: IdParamsSchema,
        response: { 202: ItemResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const source = await requireSource(req, reply, req.params.id);
      if (!source) return;
      const { enqueueClaudeConfigSync } = await import("../workers/claude-config-sync-worker.js");
      await enqueueClaudeConfigSync(source.id);
      reply.status(202).send({ source: present(source) });
    },
  );
}
