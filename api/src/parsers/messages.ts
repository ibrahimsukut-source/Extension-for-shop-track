// Messages parser -> message_threads + messages. Direction (in/out) drives the
// response-time derivation (§5.1). Message text is NOT stored — only has_text —
// to minimize retained PII (§9).
import type { MessageRow, MessageThreadRow, Parser } from "./types.js";
import { getArray, hashPII, isObject, pick, toBool, toDateISO, toStr } from "./util.js";

/** Decide whether a message is outgoing (from the seller) or incoming (buyer). */
function direction(m: Record<string, unknown>): "in" | "out" | null {
  const explicit = toStr(pick(m, ["direction"]));
  if (explicit === "in" || explicit === "out") return explicit;
  const fromSeller = toBool(pick(m, ["is_from_seller", "from_seller", "is_seller"]));
  if (fromSeller !== null) return fromSeller ? "out" : "in";
  const senderType = toStr(pick(m, ["sender_type", "senderType", "role"]));
  if (senderType) return /seller|shop|you/i.test(senderType) ? "out" : "in";
  return null;
}

function hasText(m: Record<string, unknown>): boolean {
  const t = toStr(pick(m, ["message", "text", "body", "content"]));
  if (t !== null) return t.trim().length > 0;
  return toBool(pick(m, ["has_text", "hasText"])) ?? false;
}

export const parseMessages: Parser = (body) => {
  const threads = getArray(body, ["conversations", "threads", "results"]);
  const messageThreads: MessageThreadRow[] = [];

  for (const t of threads) {
    const threadId = toStr(pick(t, ["conversation_id", "thread_id", "id"]));
    if (!threadId) continue;

    const rawMessages = pick(t, ["messages", "message_list"]);
    const messages: MessageRow[] = [];
    let lastAt: string | null = toDateISO(pick(t, ["last_message_at", "last_updated_tsz", "updated_at"]));

    if (Array.isArray(rawMessages)) {
      for (let i = 0; i < rawMessages.length; i++) {
        const m = rawMessages[i];
        if (!isObject(m)) continue;
        const sentAt = toDateISO(pick(m, ["created_timestamp", "sent_at", "timestamp", "created_at"]));
        const messageId = toStr(pick(m, ["message_id", "id"])) ?? `${threadId}:${i}`;
        messages.push({ messageId, direction: direction(m), sentAt, hasText: hasText(m) });
        if (sentAt && (!lastAt || sentAt > lastAt)) lastAt = sentAt;
      }
    }

    messageThreads.push({
      threadId,
      buyerHash: hashPII(toStr(pick(t, ["buyer_user_id", "other_user_id", "with_user_id"]))),
      lastMessageAt: lastAt,
      messages,
    });
  }

  return { messageThreads };
};
