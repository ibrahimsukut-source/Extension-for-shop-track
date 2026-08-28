// Messages parser -> message_threads + messages. Handles Etsy's real
// conversations/message-list-data shape (a flat messages[] array with
// conversation_id + sender_id), and falls back to a nested conversations[] shape.
// Message text is NOT stored (only has_text) to minimize retained PII (§9).
//
// Direction (in/out) needs the seller's own Etsy user id, which this endpoint
// doesn't label. We store sender_id so direction (and the §5.1 response-time
// metric) can be backfilled once the seller user id is known.
import type { MessageRow, MessageThreadRow, Parser } from "./types.js";
import { getArray, hashPII, isObject, pick, toBool, toDateISO, toInt, toStr } from "./util.js";

function hasText(m: Record<string, unknown>): boolean {
  const t = toStr(pick(m, ["message", "text", "body", "content"]));
  if (t !== null) return t.trim().length > 0;
  return toBool(pick(m, ["has_text", "hasText"])) ?? false;
}

/** Explicit-flag direction, when the payload provides one. */
function direction(m: Record<string, unknown>): "in" | "out" | null {
  const explicit = toStr(pick(m, ["direction"]));
  if (explicit === "in" || explicit === "out") return explicit;
  const fromSeller = toBool(pick(m, ["is_from_seller", "from_seller", "is_seller"]));
  if (fromSeller !== null) return fromSeller ? "out" : "in";
  const senderType = toStr(pick(m, ["sender_type", "senderType", "role"]));
  if (senderType) return /seller|shop|you/i.test(senderType) ? "out" : "in";
  return null; // unknown here; backfill from sender_id later
}

/** Real shape: a flat messages[] where each item carries its conversation_id. */
function parseFlatMessages(list: Record<string, unknown>[]): MessageThreadRow[] {
  const threads = new Map<string, MessageThreadRow>();
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const threadId = toStr(pick(m, ["conversation_id", "thread_id", "conversationId"]));
    if (!threadId) continue;
    const sentAt = toDateISO(pick(m, ["create_date", "created_timestamp", "sent_at", "timestamp"]));
    const messageId = toStr(pick(m, ["conversation_message_id", "message_id", "id"])) ?? `${threadId}:${i}`;

    let thread = threads.get(threadId);
    if (!thread) {
      thread = { threadId, buyerHash: null, lastMessageAt: null, messages: [] };
      threads.set(threadId, thread);
    }
    thread.messages.push({
      messageId,
      direction: direction(m),
      senderId: toInt(pick(m, ["sender_id", "senderId"])),
      sentAt,
      hasText: hasText(m),
    });
    if (sentAt && (!thread.lastMessageAt || sentAt > thread.lastMessageAt)) thread.lastMessageAt = sentAt;
  }
  return [...threads.values()];
}

/** Fallback shape: conversations[] each with its own nested messages[]. */
function parseNestedConversations(threadsRaw: Record<string, unknown>[]): MessageThreadRow[] {
  const out: MessageThreadRow[] = [];
  for (const t of threadsRaw) {
    const threadId = toStr(pick(t, ["conversation_id", "thread_id", "id"]));
    if (!threadId) continue;
    const rawMessages = pick(t, ["messages", "message_list"]);
    const messages: MessageRow[] = [];
    let lastAt: string | null = toDateISO(pick(t, ["last_message_at", "last_updated_tsz", "updated_at"]));
    if (Array.isArray(rawMessages)) {
      for (let i = 0; i < rawMessages.length; i++) {
        const m = rawMessages[i];
        if (!isObject(m)) continue;
        const sentAt = toDateISO(pick(m, ["created_timestamp", "create_date", "sent_at", "timestamp"]));
        const messageId = toStr(pick(m, ["conversation_message_id", "message_id", "id"])) ?? `${threadId}:${i}`;
        messages.push({
          messageId,
          direction: direction(m),
          senderId: toInt(pick(m, ["sender_id", "senderId"])),
          sentAt,
          hasText: hasText(m),
        });
        if (sentAt && (!lastAt || sentAt > lastAt)) lastAt = sentAt;
      }
    }
    out.push({ threadId, buyerHash: hashPII(toStr(pick(t, ["buyer_user_id", "other_user_id", "with_user_id"]))), lastMessageAt: lastAt, messages });
  }
  return out;
}

export const parseMessages: Parser = (body) => {
  // Real shape first: a top-level messages[] whose items carry conversation_id.
  if (isObject(body) && Array.isArray(body.messages) && body.messages.some((m) => isObject(m) && "conversation_id" in m)) {
    return { messageThreads: parseFlatMessages(body.messages.filter(isObject)) };
  }
  const nested = getArray(body, ["conversations", "threads", "results"]);
  return { messageThreads: parseNestedConversations(nested) };
};
