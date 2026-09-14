import assert from "node:assert/strict";
import test from "node:test";
import { previousInboxConversations } from "../src/inbox-history.ts";
import type { LedgerThreadMessage } from "../src/inbox.ts";

const message = (
  id: string,
  conversationId: string | undefined,
  role: LedgerThreadMessage["role"],
  text: string,
  at: number,
): LedgerThreadMessage => ({ id, conversationId, role, text, at });

test("history groups conversations, excludes the active thread, and orders newest first", () => {
  const thread = [
    message("1", undefined, "human", "  Make this\nfriendlier  ", 1),
    message("2", "active", "human", "Do not include this", 9),
    message("3", "second", "human", "Find the email address", 3),
    message("4", undefined, "agent", "Here is a warmer reply.", 2),
    message("5", "second", "agent", "Found the address in the thread.", 4),
  ];
  const before = structuredClone(thread);
  const history = previousInboxConversations({ thread, conversationId: "active" });
  assert.deepEqual(
    history.map((conversation) => conversation.id),
    ["second", ""],
  );
  assert.equal(history[0].title, "Find the email address");
  assert.equal(history[0].preview, "Found the address in the thread.");
  assert.deepEqual(
    history[1].messages.map((message) => message.id),
    ["1", "4"],
  );
  assert.equal(history[1].title, "Make this friendlier");
  assert.deepEqual(thread, before);
});

test("legacy messages stay active until the first conversation restart", () => {
  assert.deepEqual(
    previousInboxConversations({ thread: [message("1", undefined, "human", "Current conversation", 1)] }),
    [],
  );
});

test("titles prefer user requests and previews use the last nonempty assistant reply", () => {
  const history = previousInboxConversations({
    conversationId: "current",
    thread: [
      message("1", "old", "system", "Conversation started", 1),
      message("2", "old", "human", "Shorten the draft", 2),
      message("3", "old", "agent", "First revision", 3),
      message("4", "old", "agent", "Final revision", 4),
      message("5", "old", "agent", "  ", 5),
    ],
  });
  assert.equal(history[0].title, "Shorten the draft");
  assert.equal(history[0].preview, "Final revision");
});

test("missing requests and long text still produce bounded readable entries", () => {
  const history = previousInboxConversations({
    conversationId: "current",
    thread: [message("1", "long", "agent", "a".repeat(200), 2), message("2", "blank", "system", " \n ", 1)],
  });
  assert.equal(history[0].title.length, 100);
  assert.ok(history[0].title.endsWith("…"));
  assert.equal(history[0].preview, "");
  assert.equal(history[1].title, "Previous conversation");
});
