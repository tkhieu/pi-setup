/**
 * Local Models Extension
 *
 * Manage self-hosted LLM endpoints entirely from the TUI.
 * Commands:
 *   /local-models  - Open the local models manager
 *
 * Config is persisted across sessions. Models show up in /model selector
 * automatically when their endpoint is reachable.
 */

import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
  Spacer,
} from "@earendil-works/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────────────

interface LocalEndpoint {
	id: string;
	name: string;
	baseUrl: string;
	apiKey?: string;
	status: "checking" | "up" | "down";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

function generateEndpointId(baseUrl: string): string {
	return crypto.createHash("sha256").update(normalizeBaseUrl(baseUrl)).digest("hex").slice(0, 10);
}

function generateUniqueEndpointId(baseUrl: string): string {
	const baseId = generateEndpointId(baseUrl);
	let id = baseId;
	let suffix = 2;
	while (endpoints.some((ep) => ep.id === id && normalizeBaseUrl(ep.baseUrl) !== normalizeBaseUrl(baseUrl))) {
		id = `${baseId}-${suffix++}`;
	}
	return id;
}

async function checkEndpoint(url: string, apiKey?: string): Promise<boolean> {
	try {
		const headers: Record<string, string> = { "Accept": "application/json" };
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
		const res = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(5000) });
		return res.ok;
	} catch {
		return false;
	}
}

async function fetchModelsFromEndpoint(url: string, apiKey?: string): Promise<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }[]> {
	try {
		const headers: Record<string, string> = { "Accept": "application/json" };
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
		const res = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(8000) });
		if (!res.ok) return [];
		const payload = (await res.json()) as {
			data?: Array<{ id: string; name?: string; context_window?: number; max_tokens?: number }>;
		};
		return payload.data ?? [];
	} catch {
		return [];
	}
}

function getProviderName(endpoint: LocalEndpoint): string {
	return `local-${endpoint.id}`;
}

function registerLocalProvider(pi: ExtensionAPI, endpoint: LocalEndpoint, modelIds: string[]) {
	if (modelIds.length === 0) return;

	pi.registerProvider(getProviderName(endpoint), {
		name: endpoint.name,
		baseUrl: endpoint.baseUrl,
		apiKey: endpoint.apiKey || "sk-no-key",
		api: "openai-completions",
		models: modelIds.map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		})),
	});
}

function unregisterLocalProvider(pi: ExtensionAPI, endpoint: LocalEndpoint) {
	pi.unregisterProvider(getProviderName(endpoint));
}

// ─── State ───────────────────────────────────────────────────────────────────

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const CONFIG_FILE = path.join(process.env.HOME || "/tmp", ".pi/agent/local-models.json");

// In-memory state, loaded from JSON file once
let endpoints: LocalEndpoint[] = [];

function loadEndpoints(): LocalEndpoint[] {
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
		const parsed = JSON.parse(raw) as Partial<LocalEndpoint>[];
		let changed = false;
		endpoints = parsed
			.filter((ep) => ep.name && ep.baseUrl)
			.map((ep) => {
				const normalized: LocalEndpoint = {
					id: ep.id || generateEndpointId(ep.baseUrl!),
					name: ep.name!,
					baseUrl: normalizeBaseUrl(ep.baseUrl!),
					apiKey: ep.apiKey || undefined,
					status: ep.status === "up" || ep.status === "down" ? ep.status : "checking",
				};
				if (!ep.id || ep.baseUrl !== normalized.baseUrl || ep.status !== normalized.status) changed = true;
				return normalized;
			});
		if (changed) saveEndpoints();
	} catch {
		endpoints = [];
	}
	return endpoints;
}

async function registerKnownEndpoints(pi: ExtensionAPI): Promise<void> {
	for (const ep of endpoints) {
		const models = await fetchModelsFromEndpoint(ep.baseUrl, ep.apiKey);
		ep.status = models.length > 0 ? "up" : (await checkEndpoint(ep.baseUrl, ep.apiKey)) ? "up" : "down";
		if (models.length > 0) {
			registerLocalProvider(pi, ep, models.map((m) => m.id));
		}
	}
	saveEndpoints();
}

function saveEndpoints() {
	try {
		const dir = path.dirname(CONFIG_FILE);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(endpoints, null, 2));
	} catch (e) {
		console.error("Failed to save local models config:", e);
	}
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	// Register saved local providers during extension load, before Pi restores the
	// default/scoped model list. Registering in session_start is too late for
	// startup model resolution and `pi --list-models`.
	loadEndpoints();
	await registerKnownEndpoints(pi);

	// ─── /local-models command ──────────────────────────────────────────────

	pi.registerCommand("local-models", {
		description: "Manage local LLM endpoints",
		handler: async (_args, ctx) => {
			// Refresh endpoint statuses and make newly-online models visible in /model.
			for (const ep of endpoints) ep.status = "checking";
			await registerKnownEndpoints(pi);

			await showEndpointsList(pi, ctx);
		},
	});
}

// ─── TUI: Endpoints list ─────────────────────────────────────────────────────

async function showEndpointsList(pi: ExtensionAPI, ctx: any): Promise<void> {
	const items = buildEndpointItems();

	await ctx.ui.custom<void | null>((tui, theme, _kb, done) => {
		const container = new Container();

		// Top border
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		// Title
		container.addChild(new Text(theme.fg("accent", theme.bold(" Local Models ")), 1, 0));

		if (items.length === 0) {
			container.addChild(new Text(theme.fg("dim", "  No endpoints configured yet."), 1, 0));
			container.addChild(new Text(theme.fg("dim", "  Press 'a' to add one."), 1, 0));
		}

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});

		selectList.onSelect = async (item) => {
			const value = item.value;
			if (value === "__add__") {
				done(null);
				await showAddEndpoint(pi, ctx);
				return;
			}
			if (value === "__refresh__") {
				done(null);
				await refreshAllEndpoints(pi, ctx);
				return;
			}
			// Select an endpoint → pick a model
			done(null);
			await selectModelForEndpoint(pi, ctx, value);
		};

		selectList.onCancel = () => done(null);

		container.addChild(selectList);

		// Help text
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "  ↑↓ navigate • enter select • esc back • 'a' add • 'r' refresh"), 1, 0));

		// Bottom border
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (data === "a") {
					done(null);
					showAddEndpoint(pi, ctx);
					return;
				}
				if (data === "r") {
					done(null);
					refreshAllEndpoints(pi, ctx);
					return;
				}
				selectList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function buildEndpointItems(): SelectItem[] {
	const items: SelectItem[] = [];

	for (const ep of endpoints) {
		const statusIcon = ep.status === "up" ? "🟢" : ep.status === "down" ? "🔴" : "🟡";
		const label = `${statusIcon} ${ep.name}`;
		const desc = ep.status === "up" ? ep.baseUrl : `${ep.baseUrl} (${ep.status})`;
		items.push({ value: ep.id, label, description: desc });
	}

	if (items.length > 0) {
		items.push({ value: "__refresh__", label: "🔄  Refresh all", description: "Check status of all endpoints" });
	}

	items.push({ value: "__add__", label: "➕  Add endpoint", description: "Configure a new local LLM endpoint" });

	return items;
}

// ─── TUI: Add endpoint ───────────────────────────────────────────────────────

async function showAddEndpoint(pi: ExtensionAPI, ctx: any): Promise<void> {
	const name = await ctx.ui.input("Endpoint name", "e.g., My RunPod, Ollama, LM Studio");
	if (!name) { await showEndpointsList(pi, ctx); return; }

	const baseUrlInput = await ctx.ui.input("Base URL (with /v1)", "e.g., http://runpod-llm:8000/v1");
	if (!baseUrlInput) { await showEndpointsList(pi, ctx); return; }
	const baseUrl = normalizeBaseUrl(baseUrlInput);

	const existing = endpoints.find((ep) => normalizeBaseUrl(ep.baseUrl) === baseUrl);
	if (existing) {
		ctx.ui.notify(`${existing.name} is already onboarded as ${getProviderName(existing)}`, "info");
		await showEndpointsList(pi, ctx);
		return;
	}

	const useKey = await ctx.ui.confirm("API Key", "Does this endpoint require an API key?");
	let apiKey: string | undefined;
	if (useKey) {
		apiKey = await ctx.ui.input("API Key (leave empty if none)");
		if (apiKey === undefined) apiKey = "";
	}

	ctx.ui.notify(`Connecting to ${baseUrl}...`, "info");

	// Check endpoint and discover models
	const isUp = await checkEndpoint(baseUrl, apiKey);
	if (!isUp) {
		const retry = await ctx.ui.confirm("Connection failed", `Could not reach ${baseUrl}. Add anyway?`);
		if (!retry) return;
	}

	const models = isUp ? await fetchModelsFromEndpoint(baseUrl, apiKey) : [];
	const modelIds = models.map((m) => m.id);

	const endpoint: LocalEndpoint = {
		id: generateUniqueEndpointId(baseUrl),
		name,
		baseUrl,
		apiKey: apiKey || undefined,
		status: isUp ? "up" : "down",
	};

	endpoints.push(endpoint);
	saveEndpoints();

	if (isUp && modelIds.length > 0) {
		registerLocalProvider(pi, endpoint, modelIds);
		ctx.ui.notify(`Registered ${endpoint.name} with ${modelIds.length} model(s)!`, "success");

		// Refresh model list in /model
		ctx.ui.notify("Check /model to select a local model", "info");
	} else if (isUp && modelIds.length === 0) {
		ctx.ui.notify(`${endpoint.name} is up but no models found`, "warning");
	} else {
		ctx.ui.notify(`${endpoint.name} added (offline)`, "warning");
	}

	await showEndpointsList(pi, ctx);
}

// ─── TUI: Select model for endpoint ──────────────────────────────────────────

async function selectModelForEndpoint(pi: ExtensionAPI, ctx: any, endpointId: string): Promise<void> {
	const ep = endpoints.find((e) => e.id === endpointId);
	if (!ep) return;

	if (ep.status !== "up") {
		ctx.ui.notify(`${ep.name} is offline`, "error");
		return;
	}

	const models = await fetchModelsFromEndpoint(ep.baseUrl, ep.apiKey);
	if (models.length === 0) {
		ctx.ui.notify("No models found on this endpoint", "error");
		return;
	}

	const modelIds = models.map((m) => m.id);

	const chosen = await ctx.ui.select(`Select a model on ${ep.name}:`, modelIds);
	if (!chosen) return;

	// Ensure provider is registered, then switch the active Pi model.
	registerLocalProvider(pi, ep, models.map((m) => m.id));
	const model = ctx.modelRegistry.find(getProviderName(ep), chosen);
	if (!model) {
		ctx.ui.notify(`Model not found after registration: ${getProviderName(ep)}/${chosen}`, "error");
		return;
	}
	const success = await pi.setModel(model);
	if (!success) {
		ctx.ui.notify(`No API key available for ${getProviderName(ep)}/${chosen}`, "error");
		return;
	}
	ctx.ui.notify(`Selected ${getProviderName(ep)}/${chosen}`, "success");
}

// ─── TUI: Refresh all endpoints ──────────────────────────────────────────────

async function refreshAllEndpoints(pi: ExtensionAPI, ctx: any): Promise<void> {
	ctx.ui.notify("Checking all endpoints...", "info");

	for (const ep of endpoints) {
		ep.status = "checking";
	}

	for (const ep of endpoints) {
		const isUp = await checkEndpoint(ep.baseUrl, ep.apiKey);
		ep.status = isUp ? "up" : "down";

		if (isUp) {
			const models = await fetchModelsFromEndpoint(ep.baseUrl, ep.apiKey);
			const modelIds = models.map((m) => m.id);
			registerLocalProvider(pi, ep, modelIds);
		} else {
			unregisterLocalProvider(pi, ep);
		}
	}

	ctx.ui.notify("Endpoints refreshed!", "success");
	await showEndpointsList(pi, ctx);
}

// ─── TUI: Remove endpoint ────────────────────────────────────────────────────

async function confirmRemoveEndpoint(pi: ExtensionAPI, ctx: any, endpointId: string): Promise<void> {
	const ep = endpoints.find((e) => e.id === endpointId);
	if (!ep) return;

	const ok = await ctx.ui.confirm("Remove endpoint", `Delete "${ep.name}" (${ep.baseUrl})?`);
	if (!ok) {
		await showEndpointsList(pi, ctx);
		return;
	}

	unregisterLocalProvider(pi, ep);
	endpoints = endpoints.filter((e) => e.id !== endpointId);
	saveEndpoints();
	ctx.ui.notify(`Removed ${ep.name}`, "info");
	await showEndpointsList(pi, ctx);
}
