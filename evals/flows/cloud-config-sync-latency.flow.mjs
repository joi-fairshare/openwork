/**
 * Cloud config propagation: the command palette has a "Sync cloud config"
 * action that force-pulls org providers from OpenWork Cloud, and a model
 * added to an org LLM provider on Den lands in the desktop engine within
 * ~30 seconds with NO user action (background auto-sync tick).
 *
 * Flow (real app + real Den):
 *   1. Sign in via desktop handoff.
 *   2. Create a custom LLM provider on Den via API.
 *   3. Run the palette "Sync cloud config" action — the provider is imported
 *      immediately and the engine reports its model.
 *   4. PATCH the provider on Den to add a second model. Do nothing in the
 *      app. Assert the engine reports the new model within 45s (30s tick +
 *      sweep + engine reload margin).
 *   5. Runtime injection: the imported provider lives in the runtime
 *      config, NOT in the workspace opencode.jsonc — and a pre-seeded
 *      legacy jsonc block for the same id is migrated (stripped).
 *   6. Settings -> Cloud shows the "Synced ... ago" label.
 *   7. Cleanup: delete the provider on Den; null the runtime entry.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL  Den API base
 * - OPENWORK_EVAL_DEN_TOKEN    Bearer session token for a seeded org owner
 */

const PROVIDER_NAME = "Sync Latency Eval";
const MODEL_A = "sync-model-a";
const MODEL_B = "sync-model-b";
const LATENCY_BUDGET_MS = 45_000;

const providerConfig = (modelIds) => ({
  id: "sync-latency-eval",
  name: PROVIDER_NAME,
  npm: "@ai-sdk/openai-compatible",
  env: ["SYNC_LATENCY_EVAL_API_KEY"],
  api: "https://sync-latency.example.com/v1",
  models: modelIds.map((id) => ({ id, name: id })),
});

// Reads the engine-reported provider list through the OpenWork server proxy,
// using the app's own token/port/workspace from inside the page. Returns the
// models of the imported cloud provider matched by its lpr_* id (name matching
// would hit stale orphan blocks from earlier imports), or null when absent.
const engineProviderModelsExpr = (cloudProviderId) => `(async () => {
  const port = localStorage.getItem("openwork.server.port");
  const token = localStorage.getItem("openwork.server.token");
  const workspaceId = (window.location.hash.match(/workspace\\/(ws_[a-z0-9]+)/) ?? [])[1];
  if (!port || !token || !workspaceId) return null;
  const base = "http://127.0.0.1:" + port;
  const headers = { Authorization: "Bearer " + token };
  const wsResponse = await fetch(base + "/workspaces", { headers });
  if (!wsResponse.ok) return null;
  const wsPayload = await wsResponse.json();
  const workspaceList = Array.isArray(wsPayload) ? wsPayload : wsPayload.items ?? [];
  const workspace = workspaceList.find((entry) => entry.id === workspaceId);
  const directory = workspace?.path ?? "";
  const url = base + "/workspace/" + workspaceId + "/opencode/provider" +
    (directory ? "?directory=" + encodeURIComponent(directory) : "");
  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  const payload = await response.json();
  const provider = (payload.all ?? []).find((entry) => entry.id === ${JSON.stringify(cloudProviderId)});
  if (!provider) return null;
  return Object.keys(provider.models ?? {}).sort();
})()`;

async function denRequest(ctx, path, init = {}) {
  const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  ctx.assert(response.ok || init.allowStatuses?.includes(response.status), `${init.method ?? "GET"} ${path} failed: ${response.status} ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : null;
}

// Navigate to the active workspace session route (where the palette and the
// session-scoped auto-sync live) regardless of which route we start on.
async function ensureWorkspaceRoute(ctx) {
  const PALETTE_ACTION_READY =
    "Boolean(window.__openworkControl && window.__openworkControl.listActions().some((a) => a.id === 'command_palette.open'))";
  // The palette action only registers on the session route (a workspace
  // settings route also matches '/workspace/', so check the action itself).
  const ready = await ctx.eval(PALETTE_ACTION_READY);
  if (ready) return;
  const workspaceId = await ctx.eval(
    "localStorage.getItem('openwork.react.activeWorkspace') ?? ''",
  );
  ctx.assert(Boolean(workspaceId), "No active workspace recorded; cannot open the session route.");
  await ctx.navigateHash(`/workspace/${workspaceId}/session`);
  await ctx.waitFor(PALETTE_ACTION_READY, {
    timeoutMs: 30_000,
    label: "command palette control action registered",
  });
}

// ctx.waitFor cannot await promises, so async engine reads poll from flow code.
async function pollEngineModels(ctx, predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const models = await ctx
      .eval(engineProviderModelsExpr(ctx.providerId), { awaitPromise: true })
      .catch(() => undefined);
    if (models !== undefined && predicate(models)) return models;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// Read/write the workspace project opencode.jsonc via the OpenWork server
// config-file API, from inside the page (uses the app's own token/port).
const configFileExpr = (method, contentJson) => `(async () => {
  const port = localStorage.getItem("openwork.server.port");
  const token = localStorage.getItem("openwork.server.token");
  const workspaceId = (window.location.hash.match(/workspace\\/(ws_[a-z0-9]+)/) ?? [])[1];
  if (!port || !token || !workspaceId) return null;
  const base = "http://127.0.0.1:" + port;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  if (${JSON.stringify(method)} === "GET") {
    const file = await (await fetch(base + "/workspace/" + workspaceId + "/opencode-config?scope=project", { headers })).json();
    return file.content ?? "";
  }
  const response = await fetch(base + "/workspace/" + workspaceId + "/opencode-config", {
    method: "POST", headers,
    body: JSON.stringify({ scope: "project", content: ${contentJson} }),
  });
  return response.status;
})()`;

async function readProjectConfig(ctx) {
  return await ctx.eval(configFileExpr("GET", "null"), { awaitPromise: true });
}

async function runPaletteSync(ctx) {
  await ctx.control("command_palette.open");
  // Placeholders are not innerText; wait for the input element itself.
  await ctx.waitFor(
    `Boolean(document.querySelector('input[placeholder="Search actions"]'))`,
    { timeoutMs: 15_000, label: "command palette input" },
  );
  await ctx.fill('input[placeholder="Search actions"]', "sync cloud");
  await ctx.clickText("Sync cloud config", { selector: "button, [role=option], [role=button], li, div[data-item]", timeoutMs: 15_000 });
  await ctx.waitForText("Cloud config synced.", { timeoutMs: 60_000 });
}

export default {
  id: "cloud-config-sync-latency",
  title: "Palette force-sync + Den model change lands within 45s hands-free",
  spec: "evals/cloud-provider-sync-flows.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000 });
      },
    },
    {
      name: "Sign in to OpenWork Cloud via desktop handoff",
      run: async (ctx) => {
        const signedIn = await ctx.eval(
          "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
        );
        if (signedIn) {
          ctx.log("Already signed in; reusing session.");
          return;
        }
        const payload = await denRequest(ctx, "/v1/auth/desktop-handoff", {
          method: "POST",
          body: JSON.stringify({ desktopScheme: "openwork" }),
        });
        ctx.assert(typeof payload.openworkUrl === "string" && payload.openworkUrl.length > 0, "No openworkUrl in handoff response.");
        await ctx.navigateHash("/settings/cloud-account");
        await ctx.clickText("Paste sign-in code", { timeoutMs: 30_000 });
        await ctx.fill("#den-signin-link", payload.openworkUrl);
        await ctx.clickText("Finish sign-in");
        await ctx.waitFor(
          "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
          { timeoutMs: 45_000, label: "persisted den auth token" },
        );
      },
    },
    {
      name: "Create the org LLM provider on Den (cleanup leftovers first)",
      run: async (ctx) => {
        // Pin the flow to the active workspace before touching its config —
        // all page-side reads/writes derive the workspace from the hash.
        await ensureWorkspaceRoute(ctx);
        const existing = await denRequest(ctx, "/v1/llm-providers");
        for (const provider of existing.llmProviders ?? []) {
          if (provider.name === PROVIDER_NAME) {
            await denRequest(ctx, `/v1/llm-providers/${encodeURIComponent(provider.id)}`, { method: "DELETE", allowStatuses: [204, 404] });
          }
        }
        const created = await denRequest(ctx, "/v1/llm-providers", {
          method: "POST",
          body: JSON.stringify({
            name: PROVIDER_NAME,
            source: "custom",
            customConfig: providerConfig([MODEL_A]),
            apiKey: "sk-sync-latency-eval",
            memberIds: [],
            teamIds: [],
          }),
        });
        ctx.providerId = created.llmProvider?.id;
        ctx.assert(typeof ctx.providerId === "string" && ctx.providerId.length > 0, "Provider create returned no id.");
        ctx.log(`Created Den provider ${ctx.providerId}`);

        // Seed a legacy-style jsonc block for this provider id so the flow
        // proves the migration path: runtime injection must strip it.
        const raw = await readProjectConfig(ctx);
        ctx.assert(raw !== null, "Could not reach the project opencode.jsonc API.");
        if (!raw.includes(ctx.providerId)) {
          const legacyBlock = JSON.stringify({
            npm: "@ai-sdk/openai-compatible",
            name: "Legacy Stale Block",
            models: { "stale-model": { name: "stale-model" } },
          });
          let nextContent;
          if (/"provider"\s*:\s*\{/.test(raw)) {
            nextContent = raw.replace(/"provider"\s*:\s*\{/, (match) => `${match}\n    "${ctx.providerId}": ${legacyBlock},`);
          } else if (raw.trim()) {
            nextContent = raw.replace(/\}\s*$/, `,\n  "provider": { "${ctx.providerId}": ${legacyBlock} }\n}\n`);
          } else {
            nextContent = `{\n  "$schema": "https://opencode.ai/config.json",\n  "provider": { "${ctx.providerId}": ${legacyBlock} }\n}\n`;
          }
          const status = await ctx.eval(configFileExpr("POST", JSON.stringify(nextContent)), { awaitPromise: true });
          ctx.assert(status === 200, `Seeding legacy block failed: ${status}`);
          ctx.log("Seeded legacy jsonc block for migration proof");
        }
      },
    },
    {
      name: "Palette 'Sync cloud config' imports the provider immediately",
      run: async (ctx) => {
        // Land on a workspace session first (palette lives there).
        await ensureWorkspaceRoute(ctx);
        await ctx.prove("The command palette can force-pull cloud config", {
          action: async () => {
            await runPaletteSync(ctx);
          },
          assert: async () => {
            await pollEngineModels(
              ctx,
              (models) => Array.isArray(models) && models.includes(MODEL_A),
              90_000,
              "engine reports the imported provider with its model",
            );
            // Runtime injection proof: the provider is served by the engine
            // while the workspace opencode.jsonc contains no block for it —
            // including the legacy block we seeded, which must be migrated.
            const raw = await readProjectConfig(ctx);
            ctx.assert(
              typeof raw === "string" && !raw.includes(ctx.providerId),
              "opencode.jsonc still contains a block for the imported provider (runtime injection failed or migration did not strip the legacy block)",
            );
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "Imported provider is engine-visible with zero opencode.jsonc footprint (runtime config injection; legacy block migrated)",
            });
          },
          screenshot: {
            name: "palette-sync-imported",
            claim: "Palette sync imported the Den provider; the engine now serves it.",
            requireText: ["Cloud config synced."],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "A model added on Den lands hands-free within the latency budget",
      run: async (ctx) => {
        await ctx.prove(`A Den model add propagates to the engine within ${LATENCY_BUDGET_MS / 1000}s with no user action`, {
          action: async () => {
            await denRequest(ctx, `/v1/llm-providers/${encodeURIComponent(ctx.providerId)}`, {
              method: "PATCH",
              body: JSON.stringify({
                name: PROVIDER_NAME,
                source: "custom",
                customConfig: providerConfig([MODEL_A, MODEL_B]),
                memberIds: [],
                teamIds: [],
              }),
            });
            ctx.patchAt = Date.now();
            ctx.log(`Patched provider at ${new Date(ctx.patchAt).toISOString()}`);
          },
          assert: async () => {
            await pollEngineModels(
              ctx,
              (models) => Array.isArray(models) && models.includes(MODEL_B),
              LATENCY_BUDGET_MS,
              `engine reports ${MODEL_B} within ${LATENCY_BUDGET_MS / 1000}s`,
            );
            const elapsed = Date.now() - ctx.patchAt;
            ctx.log(`Model landed after ${Math.round(elapsed / 1000)}s`);
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: `Den model add propagated hands-free in ${Math.round(elapsed / 1000)}s (budget ${LATENCY_BUDGET_MS / 1000}s)`,
            });
          },
          screenshot: {
            name: "hands-free-propagation",
            claim: "The engine serves the model added on Den without any user action.",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Settings -> Cloud shows the synced-ago label",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/cloud-providers");
        await ctx.waitFor("window.location.hash.includes('/settings/cloud-providers')", { timeoutMs: 20_000 });
        await ctx.prove("The Cloud providers view shows when the last sync ran", {
          assert: async () => {
            await ctx.waitFor(
              `document.body.innerText.match(/Synced (just now|\\d+[smh] ago)/) !== null`,
              { timeoutMs: 30_000, label: "'Synced ... ago' label visible" },
            );
          },
          screenshot: {
            name: "synced-ago-label",
            claim: "Settings -> Cloud providers shows the last-synced label.",
            requireText: ["Synced"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/cloud-providers",
          },
        });
      },
    },
    {
      name: "Cleanup: delete the provider on Den and null the runtime entry",
      run: async (ctx) => {
        await ensureWorkspaceRoute(ctx);
        await denRequest(ctx, `/v1/llm-providers/${encodeURIComponent(ctx.providerId)}`, { method: "DELETE", allowStatuses: [204, 404] });
        // Removal propagation still depends on the persisted import record
        // (cloudImports race, tracked separately). Clean deterministically via
        // the same per-key runtime merge the store now uses: null deletes.
        const status = await ctx.eval(`(async () => {
          const port = localStorage.getItem("openwork.server.port");
          const token = localStorage.getItem("openwork.server.token");
          const workspaceId = (window.location.hash.match(/workspace\\/(ws_[a-z0-9]+)/) ?? [])[1];
          if (!port || !token || !workspaceId) return null;
          const base = "http://127.0.0.1:" + port;
          const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
          const response = await fetch(base + "/workspace/" + workspaceId + "/config", {
            method: "PATCH", headers,
            body: JSON.stringify({ opencode: { provider: { [${JSON.stringify(ctx.providerId)}]: null } } }),
          });
          return response.status;
        })()`, { awaitPromise: true });
        ctx.assert(status === 200, `Runtime null-delete failed: ${status}`);
        // The store's removal path reloads the engine itself; this direct
        // cleanup needs an explicit reload for the engine to drop the entry.
        await ctx.eval(`(async () => {
          const port = localStorage.getItem("openwork.server.port");
          const token = localStorage.getItem("openwork.server.token");
          const workspaceId = (window.location.hash.match(/workspace\\/(ws_[a-z0-9]+)/) ?? [])[1];
          const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + workspaceId + "/engine/reload", {
            method: "POST", headers: { Authorization: "Bearer " + token },
          });
          return response.status;
        })()`, { awaitPromise: true }).catch(() => null);
        await pollEngineModels(
          ctx,
          (models) => models === null,
          90_000,
          "provider removed from the engine after runtime null-delete",
        );
      },
    },
  ],
};
