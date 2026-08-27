// Fastify app factory. Auth (per-VPS Bearer token) + the three ingest routes.
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Pool } from "./repository.js";
import { ingestApi, ingestEvents, ingestHttp } from "./service.js";
import { ingestApiBody, ingestEventBody, ingestHttpBody } from "./schemas.js";

declare module "fastify" {
  interface FastifyRequest {
    shopTag?: string;
  }
}

export interface AppDeps {
  pool: Pool;
  config: Config;
}

function bearer(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

export function buildServer({ pool, config }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: true,
    bodyLimit: 8 * 1024 * 1024, // internal API bodies can be large
  });

  // Unauthenticated liveness probe.
  app.get("/health", async () => ({ ok: true }));

  // Auth for every /ingest/* route: resolve token -> shop_tag (spec §9).
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/ingest/")) return;
    const token = bearer(request);
    const shopTag = token ? config.tokenToShop.get(token) : undefined;
    if (!shopTag) {
      reply.code(401).send({ error: "unauthorized" });
      return reply; // stop the chain
    }
    request.shopTag = shopTag;
  });

  // Enforce the batch cap uniformly.
  const guardBatchSize = (n: number, reply: import("fastify").FastifyReply): boolean => {
    if (n > config.maxBatch) {
      reply.code(413).send({ error: "batch too large", maxBatch: config.maxBatch });
      return false;
    }
    return true;
  };

  const badRequest = (reply: import("fastify").FastifyReply, err: z.ZodError) =>
    reply.code(400).send({ error: "invalid payload", issues: err.issues });

  app.post("/ingest/http", async (request, reply) => {
    const parsed = ingestHttpBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (!guardBatchSize(parsed.data.records.length, reply)) return reply;
    const result = await ingestHttp(pool, request.shopTag!, parsed.data.records);
    return reply.code(202).send(result);
  });

  app.post("/ingest/event", async (request, reply) => {
    const parsed = ingestEventBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (!guardBatchSize(parsed.data.events.length, reply)) return reply;
    const result = await ingestEvents(pool, request.shopTag!, parsed.data.events);
    return reply.code(202).send(result);
  });

  app.post("/ingest/api", async (request, reply) => {
    const parsed = ingestApiBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (!guardBatchSize(parsed.data.records.length, reply)) return reply;
    const result = await ingestApi(pool, request.shopTag!, parsed.data.records);
    return reply.code(202).send(result);
  });

  return app;
}
