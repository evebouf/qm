import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const initialization = html.slice(html.indexOf("      const adminVariant ="), html.indexOf("      const themeMedia ="));

function initialize(search: string) {
  const replaced: string[] = [];
  const removed: string[] = [];
  const ids = [...html.matchAll(/<template data-original-card="([^"]+)"/g)].map((match) => match[1]);
  const links = ["original", "1"].map((design) => ({
    dataset: { adminDesign: design },
    href: "",
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    removeAttribute(name: string) {
      this.attributes.delete(name);
    },
  }));
  const document = {
    body: { dataset: {} as Record<string, string>, classList: { contains: () => false } },
    documentElement: { dataset: {} as Record<string, string> },
    querySelectorAll(selector: string) {
      if (selector === "[data-admin-design]") return links;
      assert.equal(selector, "template[data-original-card]");
      return ids.map((id) => ({
        dataset: { originalCard: id },
        content: { cloneNode: () => id },
        remove: () => removed.push(id),
      }));
    },
    getElementById(id: string) {
      return {
        replaceWith: (replacement: string) => {
          assert.equal(replacement, id);
          replaced.push(id);
        },
      };
    },
  };
  const context = vm.createContext({
    document,
    URL,
    URLSearchParams,
    location: new URL("http://localhost/admin/models" + search),
  });
  vm.runInContext(initialization, context);
  return { context, document, links, ids, replaced, removed };
}

test("original is the default and only its controls are mounted before binding settings", () => {
  for (const search of ["", "?variant=original", "?variant=unknown"]) {
    const state = initialize(search);
    assert.equal(state.document.documentElement.dataset.adminVariant, "original");
    assert.equal(state.ids.length, 4);
    assert.deepEqual(state.replaced, state.ids);
    assert.deepEqual(state.removed, state.ids);
    assert.equal(state.links[0].attributes.get("aria-current"), "page");
    assert.equal(state.links[1].attributes.has("aria-current"), false);
  }
});

test("variant links retain scope, filters and fragment while selecting exactly one design", () => {
  const state = initialize("?variant=1&scope=org%3Aexample&filter=a%26b#details");
  assert.deepEqual(state.replaced, []);
  assert.deepEqual(state.removed, state.ids);
  for (const link of state.links) {
    const url = new URL(link.href, "http://localhost");
    assert.equal(url.pathname, "/admin/models");
    assert.equal(url.searchParams.get("scope"), "org:example");
    assert.equal(url.searchParams.get("filter"), "a&b");
    assert.equal(url.hash, "#details");
    assert.equal(url.searchParams.get("variant"), link.dataset.adminDesign);
  }
  assert.equal(state.links[1].attributes.get("aria-current"), "page");
  assert.equal(state.links[0].attributes.has("aria-current"), false);
});

test("admin navigation preserves the selected design across settings and history routes", () => {
  const routing = html.slice(
    html.indexOf("      function stateToUrl(st) {"),
    html.indexOf("      function decodePathSegment(seg) {"),
  );
  for (const variant of ["original", "1"]) {
    const state = initialize("?variant=" + variant);
    Object.assign(state.context, {
      API_BASE: "/admin",
      DEFAULT_VIEW: "history",
      SCOPED: new Set(["governance", "models", "credentials"]),
      scopeKind: (scope: string) => scope.split(":")[0],
    });
    vm.runInContext(routing, state.context);
    for (const view of ["governance", "models", "credentials", "history"]) {
      state.context.targetState = {
        view,
        scope: "org:example",
        session: view === "history" ? "test-session" : null,
        turn: 3,
      };
      const url = new URL(vm.runInContext("stateToUrl(targetState)", state.context), "http://localhost");
      assert.equal(url.searchParams.get("variant"), variant);
      if (view === "history") assert.equal(url.searchParams.get("turn"), "3");
      else assert.equal(url.searchParams.get("scope"), "org:example");
    }
  }
});
