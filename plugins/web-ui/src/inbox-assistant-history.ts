import { html, render } from "lit";
import { ChevronRight } from "lucide";
import { api, entriesToMessages, fetchTranscript, TAIL_TURNS, type CoreSession } from "./core-bridge";
import { createConversation, disposeConversation, ensureDeliveryStream } from "./conversations";
import type { Conversation } from "./conv-types";
import { previousInboxAssistantSessions } from "./inbox-history";
import { transcriptModel } from "./model-options";
import { icon } from "./ui";
import { inboxChatHeader } from "./inbox-chat-header";

export function createInboxAssistantHistory(user: string, currentThread: () => string | null) {
  const host = document.createElement("div");
  host.className = "inbox-assistant-history";
  host.hidden = true;
  let opener: HTMLElement | null = null;
  let sessions: CoreSession[] = [];
  let selected: CoreSession | null = null;
  let transcript: Conversation | null = null;
  let transcriptHost: HTMLElement | null = null;
  let loading = false;
  let error = false;
  let generation = 0;
  let listScrollTop = 0;

  const disposeTranscript = () => {
    if (transcript) disposeConversation(transcript);
    transcript = null;
    transcriptHost = null;
  };
  const close = () => {
    generation++;
    host.hidden = true;
    disposeTranscript();
    opener?.focus({ preventScroll: true });
  };
  const focusBack = () => host.querySelector<HTMLButtonElement>(".inbox-history-back")?.focus({ preventScroll: true });
  const back = () => {
    if (!selected) return close();
    const id = selected.id;
    generation++;
    selected = null;
    loading = error = false;
    disposeTranscript();
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
        const page = await fetchTranscript(session.id, { tailTurns: TAIL_TURNS });
        if (generation !== request) return;
        transcriptHost = document.createElement("div");
        transcriptHost.className = "inbox-assistant-body inbox-assistant-history-transcript";
        const container = transcriptHost;
        transcript = createConversation({
          pane: true,
          ownsUrl: false,
          container: () => container,
          claimContainer: () => container,
          visible: () => !host.hidden && host.isConnected,
          density: () => "compact",
          onDensityChange: () => {},
          ensureDeliveryStream,
        });
        transcript.mountReadOnly(
          page.session ?? session,
          entriesToMessages(page.entries, transcriptModel()),
          page.earlierEntries ?? 0,
          page.entries[0]?.seq ?? null,
        );
        transcript.setPins(page.pins ?? []);
      } else {
        const result = await api<{ sessions: CoreSession[] }>("/api/sessions");
        if (generation !== request) return;
        sessions = previousInboxAssistantSessions(result.sessions, user, currentThread());
      }
    } catch {
      if (generation !== request) return;
      error = true;
      disposeTranscript();
    } finally {
      if (generation === request) {
        loading = false;
        draw();
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
      disposeTranscript();
      host.hidden = false;
      void load();
      focusBack();
    },
    dispose: close,
  };
}
