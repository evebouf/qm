import { html, render } from "lit";
import { ChevronRight } from "lucide";
import { api, fetchTranscript, TAIL_TURNS, type CoreSession } from "./core-bridge";
import { createConversation, disposeConversation, ensureDeliveryStream } from "./conversations";
import type { Conversation, ConvHost } from "./conv-types";
import { previousInboxAssistantSessions } from "./inbox-history";
import { openSessionInto } from "./sessions";
import { icon } from "./ui";
import { inboxChatHeader } from "./inbox-chat-header";

export function createInboxAssistantHistory(
  user: string,
  currentThread: () => string | null,
  options: Pick<ConvHost, "turnOptions" | "composerPlaceholder" | "thinkingIndicator"> & { onSettled(): void },
) {
  const host = document.createElement("div");
  host.className = "inbox-assistant-history";
  host.hidden = true;
  let opener: HTMLElement | null = null;
  let sessions: CoreSession[] = [];
  let selected: CoreSession | null = null;
  let transcript: Conversation | null = null;
  let transcriptHost: HTMLElement | null = null;
  const conversations = new Map<string, { conversation: Conversation; host: HTMLElement }>();
  let loading = false;
  let error = false;
  let generation = 0;
  let listScrollTop = 0;

  const clearTranscriptSelection = () => {
    transcript = null;
    transcriptHost = null;
  };
  const close = () => {
    generation++;
    host.hidden = true;
    clearTranscriptSelection();
    opener?.focus({ preventScroll: true });
  };
  const focusBack = () => host.querySelector<HTMLButtonElement>(".inbox-history-back")?.focus({ preventScroll: true });
  const back = () => {
    if (!selected) return close();
    const id = selected.id;
    generation++;
    selected = null;
    loading = error = false;
    clearTranscriptSelection();
    draw();
    const list = host.querySelector<HTMLElement>(".inbox-history-list");
    if (list) list.scrollTop = listScrollTop;
    [...host.querySelectorAll<HTMLButtonElement>(".inbox-history-entry")]
      .find((button) => button.dataset.session === id)
      ?.focus({ preventScroll: true });
  };
  const load = async () => {
    const request = ++generation;
    loading = true;
    error = false;
    draw();
    try {
      if (selected) {
        const session = selected;
        const cached = conversations.get(session.id);
        if (cached) {
          transcript = cached.conversation;
          transcriptHost = cached.host;
        } else {
          const page = await fetchTranscript(session.id, { tailTurns: TAIL_TURNS });
          if (generation !== request) return;
          const container = document.createElement("div");
          container.className = "inbox-assistant-body inbox-assistant-history-transcript";
          let working = false;
          const conversation = createConversation({
            pane: true,
            ownsUrl: false,
            container: () => container,
            claimContainer: () => container,
            visible: () => !host.hidden && container.isConnected && selected?.id === session.id,
            density: () => "compact",
            onDensityChange: () => {},
            ensureDeliveryStream,
            turnOptions: options.turnOptions,
            composerPlaceholder: options.composerPlaceholder,
            thinkingIndicator: options.thinkingIndicator,
            onState: (state) => {
              if (working && !state.working) options.onSettled();
              working = state.working;
            },
          });
          try {
            await openSessionInto(conversation, session, Promise.resolve(page));
            if (generation !== request) {
              disposeConversation(conversation);
              return;
            }
            if (!conversation.state.agent) throw new Error("Could not continue this conversation.");
          } catch (error) {
            disposeConversation(conversation);
            throw error;
          }
          conversations.set(session.id, { conversation, host: container });
          transcript = conversation;
          transcriptHost = container;
        }
      } else {
        const result = await api<{ sessions: CoreSession[] }>("/api/sessions");
        if (generation !== request) return;
        sessions = previousInboxAssistantSessions(result.sessions, user, currentThread());
      }
    } catch {
      if (generation !== request) return;
      error = true;
      clearTranscriptSelection();
    } finally {
      if (generation === request) {
        loading = false;
        draw();
        transcript?.drawActiveChat();
        transcript?.resumeIfIdle();
      }
    }
  };
  const body = () => {
    if (loading)
      return html`<p class="inbox-history-empty" role="status">
        Loading ${selected ? "conversation" : "past conversations"}…
      </p>`;
    if (error)
      return html`<div class="inbox-history-empty" role="alert">
        Could not load ${selected ? "this conversation" : "past conversations"}.
        <button class="btn compact" type="button" @click=${() => void load()}>Retry</button>
      </div>`;
    if (selected) return transcriptHost;
    return html`<div class="inbox-history-list" aria-label="Past conversations">
      ${
        sessions.length
          ? sessions.map((session) => {
              const at = session.lastActivityAt ?? session.createdAt;
              return html`<button
                class="inbox-history-entry"
                type="button"
                data-session=${session.id}
                @click=${() => {
                  listScrollTop = host.querySelector<HTMLElement>(".inbox-history-list")?.scrollTop ?? 0;
                  selected = session;
                  void load();
                  focusBack();
                }}
              >
                <span class="inbox-history-entry-copy">
                  <span class="inbox-history-entry-title">${session.title?.trim() || "Inbox conversation"}</span>
                  <span class="inbox-history-meta"
                    ><time datetime=${new Date(at).toISOString()}
                      >${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time
                    ></span
                  > </span
                >${icon(ChevronRight, 16)}
              </button>`;
            })
          : html`<p class="inbox-history-empty">No past conversations yet.</p>`
      }
    </div>`;
  };
  const draw = () =>
    render(
      html`
        <div
          class="inbox-chat inbox-history-panel"
          @keydown=${(event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            back();
          }}
        >
          ${inboxChatHeader({
            title: selected?.title?.trim() || (selected ? "Inbox conversation" : "Past conversations"),
            className: "inbox-history-head",
            back,
            backLabel: selected ? "Back to past conversations" : "Back to conversation",
            close: selected ? close : undefined,
          })}
          ${body()}
        </div>
      `,
      host,
    );
  return {
    host,
    open(button: HTMLElement) {
      opener = button;
      selected = null;
      listScrollTop = 0;
      clearTranscriptSelection();
      host.hidden = false;
      void load();
      focusBack();
    },
    redraw(resume: boolean) {
      if (host.hidden) return;
      transcript?.drawActiveChat();
      if (resume) transcript?.resumeIfIdle();
    },
    dispose() {
      close();
      for (const entry of conversations.values()) disposeConversation(entry.conversation);
      conversations.clear();
    },
  };
}
