import { html, nothing, type TemplateResult } from "lit";
import { ChevronRight } from "lucide";
import { previousInboxConversations } from "./inbox-history";
import type { InboxItem } from "./inbox";
import { icon } from "./ui";
import { inboxChatHeader } from "./inbox-chat-header";

interface HistoryView {
  selectedId: string | null;
  scrollTop: number;
  listScrollTop: number;
  container: HTMLElement;
}

const views = new Map<string, HistoryView>();

export function closeInboxHistory(): void {
  views.clear();
}

function chatFor(itemId: string, view: HistoryView): HTMLElement | undefined {
  const container = view.container.isConnected ? view.container : document;
  return [...container.querySelectorAll<HTMLElement>(".inbox-chat")].find((chat) => chat.dataset.inboxItem === itemId);
}

export function openInboxHistory(item: InboxItem, opener: HTMLElement, redraw: () => void): void {
  const chat = opener.closest<HTMLElement>(".inbox-chat");
  if (!chat?.parentElement) return;
  const view: HistoryView = {
    selectedId: null,
    scrollTop: chat.querySelector<HTMLElement>(".inbox-chat-log")?.scrollTop ?? 0,
    listScrollTop: 0,
    container: chat.parentElement,
  };
  views.set(item.id, view);
  redraw();
  chatFor(item.id, view)?.querySelector<HTMLButtonElement>(".inbox-history-back")?.focus({ preventScroll: true });
}

export function inboxHistoryPanel(item: InboxItem, redraw: () => void): TemplateResult | null {
  const view = views.get(item.id);
  if (!view) return null;
  const conversations = previousInboxConversations(item);
  const selected = conversations.find((conversation) => conversation.id === view.selectedId);
  const date = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const count = (length: number) => `${length} message${length === 1 ? "" : "s"}`;
  const close = () => {
    views.delete(item.id);
    redraw();
    requestAnimationFrame(() => {
      if (views.has(item.id)) return;
      const chat = chatFor(item.id, view);
      const log = chat?.querySelector<HTMLElement>(".inbox-chat-log");
      if (log) log.scrollTop = view.scrollTop;
      chat?.querySelector<HTMLButtonElement>('[aria-label="Previous conversations"]')?.focus({ preventScroll: true });
    });
  };
  const back = () => {
    if (!selected) return close();
    view.selectedId = null;
    redraw();
    const chat = chatFor(item.id, view);
    const list = chat?.querySelector<HTMLElement>(".inbox-history-list");
    if (list) list.scrollTop = view.listScrollTop;
    [...(chat?.querySelectorAll<HTMLButtonElement>(".inbox-history-entry") ?? [])]
      .find((button) => button.dataset.conversation === selected.id)
      ?.focus({ preventScroll: true });
  };
  const selectConversation = (id: string) => {
    view.listScrollTop = chatFor(item.id, view)?.querySelector<HTMLElement>(".inbox-history-list")?.scrollTop ?? 0;
    view.selectedId = id;
    redraw();
    chatFor(item.id, view)?.querySelector<HTMLElement>(".inbox-history-transcript")?.focus({ preventScroll: true });
  };
  return html`
    <div
      class="inbox-chat inbox-history-panel"
      data-inbox-item=${item.id}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        back();
      }}
    >
      ${inboxChatHeader({
        title: selected?.title ?? "Past conversations",
        className: "inbox-history-head",
        back,
        backLabel: selected ? "Back to past conversations" : "Back to conversation",
        close: selected ? close : undefined,
      })}
      ${
        selected
          ? html`
              <div class="inbox-history-transcript" tabindex="0" aria-label="Conversation transcript">
                ${selected.messages.map(
                  (message) =>
                    html`<div class="inbox-chat-msg ${message.role}">
                      <span class="sr-only"
                        >${{ human: "You", agent: "Assistant", system: "System" }[message.role]}:</span
                      >
                      <span class="inbox-chat-text">${message.text}</span>
                    </div>`,
                )}
              </div>
            `
          : html`
              <div class="inbox-history-list" aria-label="Past conversations">
                ${
                  conversations.length
                    ? conversations.map(
                        (conversation) => html`
                          <button
                            class="inbox-history-entry"
                            type="button"
                            data-conversation=${conversation.id}
                            @click=${() => selectConversation(conversation.id)}
                          >
                            <div class="inbox-history-entry-copy">
                              <span class="inbox-history-entry-title">${conversation.title}</span>
                              ${conversation.preview ? html`<span class="inbox-history-preview">${conversation.preview}</span>` : nothing}
                              <span class="inbox-history-meta"
                                ><time datetime=${new Date(conversation.at).toISOString()}
                                  >${date(conversation.at)}</time
                                ><span>·</span><span>${count(conversation.messages.length)}</span></span
                              >
                            </div>
                            ${icon(ChevronRight, 16)}
                          </button>
                        `,
                      )
                    : html`<p class="inbox-history-empty">No past conversations yet.</p>`
                }
              </div>
            `
      }
    </div>
  `;
}
