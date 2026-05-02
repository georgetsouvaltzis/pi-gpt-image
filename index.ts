import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Image as TUIImage, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";

const EXTENSION_NAME = "gpt-image";
const PROVIDER = "openai-codex";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

const QUALITY_MODES = ["low", "medium", "high", "auto"] as const;
const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const SIZE_PRESETS: Record<string, string> = {
	auto: "auto",
	square: "1024x1024",
	landscape: "1536x1024",
	portrait: "1024x1536",
	"square-2k": "2048x2048",
	"landscape-2k": "2048x1152",
	"landscape-4k": "3840x2160",
	"portrait-4k": "2160x3840",
};

type QualityMode = (typeof QUALITY_MODES)[number];
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

interface Config {
	provider: "openai-codex";
	model: string;
	imageModel: string;
	outputDir: string;
	generationTimeoutMs: number;
	allowApiBilling: false;
	size?: string;
	quality?: QualityMode;
	outputFormat?: OutputFormat;
}

interface UserConfig {
	outputDir?: string;
	size?: string;
	quality?: QualityMode;
	outputFormat?: OutputFormat;
}

interface ImageArtifact {
	id: string;
	sessionId: string;
	parentId?: string;
	prompt: string;
	mimeType: string;
	size?: string;
	quality?: QualityMode;
	outputFormat?: OutputFormat;
	savedPath?: string;
	responseId?: string;
	createdAt: number;
}

interface ImageManifest {
	version: 1;
	sessionId: string;
	outputDir: string;
	artifacts: ImageArtifact[];
	updatedAt: number;
}

const DEFAULT_CONFIG: Config = {
	provider: "openai-codex",
	model: "gpt-5.4",
	imageModel: "gpt-image-2",
	outputDir: "project",
	generationTimeoutMs: 300_000,
	allowApiBilling: false,
	size: "auto",
	quality: "auto",
	outputFormat: "png",
};

const GENERATE_PARAMS = Type.Object({
	prompt: Type.String({ description: "Image prompt to send through Pi's existing ChatGPT/Codex subscription login." }),
	size: Type.Optional(
		Type.String({
			description:
				"Optional one-off override. Leave unset unless the user explicitly asks for a size. Values: auto, square, landscape, portrait, square-2k, landscape-2k, landscape-4k, portrait-4k, or exact WIDTHxHEIGHT.",
		}),
	),
	quality: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("auto")], { description: "Optional one-off override. Leave unset unless the user explicitly asks for quality." })),
	outputFormat: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], { description: "Optional one-off override. Leave unset unless the user explicitly asks for output format." })),
	parentId: Type.Optional(Type.String({ description: "Optional previous gpt-image artifact id to record a parent relationship. Previous image bytes are not sent automatically." })),
});

type GenerateParams = Static<typeof GENERATE_PARAMS>;

const LIST_PARAMS = Type.Object({});

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function absolutePath(path: string, cwd: string): string {
	const expanded = expandHome(path);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function readJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
	} catch {
		return {};
	}
}

function loadConfig(cwd: string): Config {
	const globalPath = getGlobalConfigPath();
	const projectPath = getProjectConfigPath(cwd);
	const config = { ...DEFAULT_CONFIG, ...readJson(globalPath), ...readJson(projectPath) } as Config;
	return normalizeConfig(config, cwd, true);
}

function getProjectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "gpt-image", "config.json");
}

function getGlobalConfigPath(): string {
	return join(getAgentDir(), "gpt-image", "config.json");
}

function defaultConfigFile(): UserConfig {
	return {
		outputDir: "project",
		size: "auto",
		quality: "auto",
		outputFormat: "png",
	};
}

function userConfigFile(config: Config): UserConfig {
	return {
		outputDir: config.outputDir || "project",
		size: config.size,
		quality: config.quality,
		outputFormat: config.outputFormat,
	};
}

function configValuesText(): string {
	return [
		"## Allowed values",
		"",
		`- \`size\`: \`auto\`, ${Object.keys(SIZE_PRESETS)
			.filter((v) => v !== "auto")
			.map((v) => `\`${v}\``)
			.join(", ")}, or exact \`WIDTHxHEIGHT\``,
		`- \`quality\`: ${QUALITY_MODES.map((v) => `\`${v}\``).join(", ")}`,
		`- \`outputFormat\`: ${OUTPUT_FORMATS.map((v) => `\`${v}\``).join(", ")}`,
		"- `outputDir`: `project` or a directory path. Images are saved under `<outputDir>/<session-id>/`.",
		"",
		"Size presets:",
		...Object.entries(SIZE_PRESETS).map(([name, size]) => `- \`${name}\` → \`${size}\``),
	].join("\n");
}

function normalizeConfig(input: Partial<Config>, cwd: string, absolutizeOutputDir: boolean): Config {
	const config = { ...DEFAULT_CONFIG, ...input } as Config;
	config.provider = "openai-codex";
	config.allowApiBilling = false;
	if (!config.model) config.model = DEFAULT_CONFIG.model;
	if (!config.imageModel) config.imageModel = DEFAULT_CONFIG.imageModel;
	if (!config.outputDir || config.outputDir === "project") config.outputDir = "project";
	else if (absolutizeOutputDir) config.outputDir = absolutePath(config.outputDir, cwd);
	if (config.size) config.size = validateSize(config.size);
	if (config.quality && !QUALITY_MODES.includes(config.quality)) config.quality = undefined;
	if (config.outputFormat && !OUTPUT_FORMATS.includes(config.outputFormat)) config.outputFormat = DEFAULT_CONFIG.outputFormat;
	if (!config.generationTimeoutMs || config.generationTimeoutMs < 30_000) config.generationTimeoutMs = 300_000;
	return config;
}

function prettyJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function safePathSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown-session";
}

function getSessionId(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId();
}

function resolveOutputDir(config: Config, cwd: string, sessionId: string): string {
	const sessionDir = safePathSegment(sessionId);
	if (!config.outputDir || config.outputDir === "project") return join(cwd, ".pi", "gpt-image", sessionDir);
	return join(config.outputDir, sessionDir);
}

function resolveBaseOutputDir(config: Config, cwd: string): string {
	if (!config.outputDir || config.outputDir === "project") return join(cwd, ".pi", "gpt-image");
	return config.outputDir;
}

async function ensureOutputDir(config: Config, ctx: { cwd: string }, sessionId: string): Promise<string> {
	if (!config.outputDir || config.outputDir === "project") return resolveOutputDir(config, ctx.cwd, sessionId);

	const baseDir = resolveBaseOutputDir(config, ctx.cwd);
	if (!existsSync(baseDir)) {
		throw new Error(
			`gpt-image outputDir does not exist: ${baseDir}. Image generation was not started. Set outputDir to "project" or an existing directory with /gpt-image config.`,
		);
	}
	if (!statSync(baseDir).isDirectory()) {
		throw new Error(`gpt-image outputDir is not a directory: ${baseDir}. Image generation was not started.`);
	}
	return join(baseDir, safePathSegment(sessionId));
}

async function validateConfigOutputDirForSave(
	userConfig: UserConfig,
	ctx: {
		cwd: string;
		ui: {
			confirm(title: string, message: string): Promise<boolean>;
			input(title: string, placeholder?: string): Promise<string | undefined>;
			notify(message: string, type?: "info" | "warning" | "error"): void;
		};
	},
): Promise<UserConfig> {
	if (!userConfig.outputDir || userConfig.outputDir === "project") return { ...userConfig, outputDir: "project" };

	let rawDir = userConfig.outputDir;
	let baseDir = absolutePath(rawDir, ctx.cwd);
	while (!existsSync(baseDir)) {
		const create = await ctx.ui.confirm("Create gpt-image output directory?", `Directory does not exist:\n${baseDir}\n\nCreate it now?`);
		if (create) {
			await mkdir(baseDir, { recursive: true });
			break;
		}
		const edited = await ctx.ui.input("Correct gpt-image outputDir", rawDir);
		if (!edited || !edited.trim()) throw new Error(`outputDir does not exist and was not created: ${baseDir}`);
		rawDir = edited.trim();
		baseDir = absolutePath(rawDir, ctx.cwd);
	}
	if (!statSync(baseDir).isDirectory()) throw new Error(`outputDir is not a directory: ${baseDir}`);
	return { ...userConfig, outputDir: rawDir };
}

function imageExtension(mimeType: string): string {
	const lower = mimeType.toLowerCase();
	if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
	if (lower.includes("webp")) return "webp";
	if (lower.includes("gif")) return "gif";
	return "png";
}

function mimeTypeForOutputFormat(format?: OutputFormat): string {
	if (format === "jpeg") return "image/jpeg";
	if (format === "webp") return "image/webp";
	return "image/png";
}

function detectImageMimeType(base64Data: string, fallback: string): string {
	const header = Buffer.from(base64Data.slice(0, 32), "base64");
	if (header.length >= 8 && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) return "image/png";
	if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
	if (header.length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return fallback;
}

async function saveImage(base64Data: string, mimeType: string, outputDir: string): Promise<string> {
	const ext = imageExtension(mimeType);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const path = join(outputDir, `gpt-image-${timestamp}-${randomUUID().slice(0, 8)}.${ext}`);
	await withFileMutationQueue(path, async () => {
		await mkdir(outputDir, { recursive: true });
		await writeFile(path, Buffer.from(base64Data, "base64"));
	});
	return path;
}

function manifestPath(outputDir: string): string {
	return join(outputDir, "manifest.json");
}

function readManifest(outputDir: string, sessionId: string): ImageManifest {
	const path = manifestPath(outputDir);
	if (!existsSync(path)) return { version: 1, sessionId, outputDir, artifacts: [], updatedAt: Date.now() };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ImageManifest>;
		return {
			version: 1,
			sessionId,
			outputDir,
			artifacts: Array.isArray(parsed.artifacts) ? (parsed.artifacts as ImageArtifact[]).filter((a) => a?.id && a.sessionId === sessionId) : [],
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
		};
	} catch {
		return { version: 1, sessionId, outputDir, artifacts: [], updatedAt: Date.now() };
	}
}

async function writeManifest(outputDir: string, manifest: ImageManifest): Promise<void> {
	const path = manifestPath(outputDir);
	await withFileMutationQueue(path, async () => {
		await mkdir(outputDir, { recursive: true });
		await writeFile(path, prettyJson({ ...manifest, updatedAt: Date.now() }), "utf8");
	});
}

async function appendArtifactToManifest(outputDir: string, sessionId: string, artifact: ImageArtifact): Promise<ImageManifest> {
	const manifest = readManifest(outputDir, sessionId);
	manifest.artifacts = [...manifest.artifacts.filter((a) => a.id !== artifact.id), artifact];
	await writeManifest(outputDir, manifest);
	return manifest;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const payload = token.split(".")[1];
		if (!payload) return null;
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function extractAccountId(token: string): string {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
	const accountId = auth?.chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error("Failed to extract ChatGPT account id from Pi OpenAI/Codex login token. Run /login and select ChatGPT Plus/Pro (Codex).");
	}
	return accountId;
}

function summarizePrompt(prompt: string, maxLength = 120): string {
	const singleLine = prompt.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function resolveSizePreset(size: string | undefined): string | undefined {
	if (!size) return undefined;
	return SIZE_PRESETS[size] || size;
}

function validateSize(size: string | undefined): string | undefined {
	if (!size) return undefined;
	size = resolveSizePreset(size);
	if (size === "auto") return size;
	const match = /^(\d+)x(\d+)$/.exec(size);
	if (!match) throw new Error("gpt_image_generate size must be 'auto' or WIDTHxHEIGHT, e.g. 1024x1024.");
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (width % 16 !== 0 || height % 16 !== 0) throw new Error("gpt_image_generate size width and height must be multiples of 16.");
	if (Math.max(width, height) > 3840) throw new Error("gpt_image_generate size max edge must be <= 3840px.");
	if (Math.max(width, height) / Math.min(width, height) > 3) throw new Error("gpt_image_generate size long:short edge ratio must be <= 3:1.");
	const pixels = width * height;
	if (pixels < 655_360 || pixels > 8_294_400) throw new Error("gpt_image_generate size total pixels must be between 655,360 and 8,294,400.");
	return size;
}

function effectiveGenerateOptions(config: Config, params: GenerateParams) {
	return {
		size: params.size || config.size,
		quality: params.quality || config.quality,
		outputFormat: params.outputFormat || config.outputFormat || "png",
	};
}

function validateGenerateParams(config: Config, params: GenerateParams) {
	const options = effectiveGenerateOptions(config, params);
	const size = validateSize(options.size);
	return { ...options, size };
}

type EffectiveGenerateOptions = ReturnType<typeof validateGenerateParams>;

function generationOptionsText(options: EffectiveGenerateOptions): string {
	return [`size=${options.size || "auto"}`, `quality=${options.quality || "auto"}`, `outputFormat=${options.outputFormat}`].join(", ");
}

function buildImageGenerationTool(config: Config, params: GenerateParams) {
	const options = validateGenerateParams(config, params);
	const tool: Record<string, unknown> = {
		type: "image_generation",
		model: config.imageModel,
		output_format: options.outputFormat,
	};
	if (options.size) tool.size = options.size;
	if (options.quality) tool.quality = options.quality;
	return tool;
}

function buildCodexBody(config: Config, params: GenerateParams) {
	return {
		model: config.model,
		store: false,
		stream: true,
		instructions:
			"You are an image generation assistant. When the user asks for an image, use the image_generation tool and return the generated image.",
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: params.prompt }],
			},
		],
		tools: [buildImageGenerationTool(config, params)],
		tool_choice: "auto",
		parallel_tool_calls: true,
		text: { verbosity: "low" },
	};
}

function looksLikeBase64Image(value: string): boolean {
	if (value.length < 1024) return false;
	if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
	return true;
}

function findImageResult(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const obj = value as Record<string, unknown>;
	if (obj.type === "image_generation_call" && typeof obj.result === "string" && looksLikeBase64Image(obj.result)) {
		return obj.result;
	}
	for (const key of ["output", "response", "item", "content"] as const) {
		const child = obj[key];
		if (Array.isArray(child)) {
			for (const item of child) {
				const found = findImageResult(item);
				if (found) return found;
			}
		} else {
			const found = findImageResult(child);
			if (found) return found;
		}
	}
	return undefined;
}

function getResponseId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const obj = value as Record<string, unknown>;
	const response = obj.response as Record<string, unknown> | undefined;
	if (typeof response?.id === "string") return response.id;
	if (typeof obj.id === "string" && obj.id.startsWith("resp_")) return obj.id;
	return undefined;
}

async function parseSseForImage(response: Response, signal?: AbortSignal): Promise<{ data: string; mimeType: string; responseId?: string }> {
	if (!response.body) throw new Error("No response body from ChatGPT/Codex backend.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let responseId: string | undefined;
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const raw = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				idx = buffer.indexOf("\n\n");
				const dataLines = raw
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim());
				if (dataLines.length === 0) continue;
				const data = dataLines.join("\n");
				if (!data || data === "[DONE]") continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(data);
				} catch {
					continue;
				}
				responseId ||= getResponseId(parsed);
				const image = findImageResult(parsed);
				if (image) {
					await reader.cancel();
					return { data: image, mimeType: "image/png", responseId };
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	throw new Error("ChatGPT/Codex completed without an image_generation result. The subscription backend may have changed or refused image generation for this account/model.");
}

async function requestImageViaPiLogin(
	ctx: { modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> } },
	config: Config,
	params: GenerateParams,
	signal?: AbortSignal,
) {
	const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
	if (!token) throw new Error("Missing Pi OpenAI/Codex login. Run /login and select ChatGPT Plus/Pro (Codex). No OPENAI_API_KEY is used.");
	const accountId = extractAccountId(token);
	const options = effectiveGenerateOptions(config, params);
	const response = await fetch(CODEX_RESPONSES_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"chatgpt-account-id": accountId,
			originator: "pi",
			"OpenAI-Beta": "responses=experimental",
			"content-type": "application/json",
			accept: "text/event-stream",
			"User-Agent": "pi gpt-image",
		},
		body: JSON.stringify(buildCodexBody(config, params)),
		signal,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`ChatGPT/Codex image request failed (${response.status}): ${text.slice(0, 800)}`);
	}
	const image = await parseSseForImage(response, signal);
	return { ...image, mimeType: detectImageMimeType(image.data, mimeTypeForOutputFormat(options.outputFormat)) };
}

interface CarouselItem {
	artifact: ImageArtifact;
	data: string;
	mimeType: string;
}

function loadCarouselItems(artifacts: ImageArtifact[]): CarouselItem[] {
	const items: CarouselItem[] = [];
	for (const artifact of artifacts) {
		if (!artifact.savedPath || !existsSync(artifact.savedPath)) continue;
		items.push({
			artifact,
			data: readFileSync(artifact.savedPath).toString("base64"),
			mimeType: artifact.mimeType,
		});
	}
	return items;
}

function wrapPlainText(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		let line = rawLine.trimEnd();
		if (!line) {
			lines.push("");
			continue;
		}
		while (line.length > safeWidth) {
			let cut = line.lastIndexOf(" ", safeWidth);
			if (cut < Math.floor(safeWidth * 0.6)) cut = safeWidth;
			lines.push(line.slice(0, cut).trimEnd());
			line = line.slice(cut).trimStart();
		}
		lines.push(line);
	}
	return lines;
}

class GptImageCarousel {
	private index = 0;
	private image?: TUIImage;
	private imageIndex = -1;

	constructor(
		private readonly items: CarouselItem[],
		private readonly theme: { fg(color: string, text: string): string; bold(text: string): string },
		private readonly done: () => void,
		private readonly requestRender: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, Key.left) || data === "h") {
			this.index = (this.index - 1 + this.items.length) % this.items.length;
			this.invalidate();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.right) || data === "l") {
			this.index = (this.index + 1) % this.items.length;
			this.invalidate();
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const item = this.items[this.index];
		if (!item) return ["No saved gpt-image artifacts in this session."];
		if (!this.image || this.imageIndex !== this.index) {
			this.image = new TUIImage(item.data, item.mimeType, { fallbackColor: (s: string) => this.theme.fg("muted", s) }, { maxWidthCells: 72, filename: item.artifact.savedPath });
			this.imageIndex = this.index;
		}
		const imageName = item.artifact.savedPath ? basename(item.artifact.savedPath) : item.artifact.id;
		const header = this.theme.fg("accent", this.theme.bold(`gpt-image carousel ${this.index + 1}/${this.items.length}`));
		const name = `Image: ${imageName}`;
		const options = `Options: size=${item.artifact.size || "auto"}, quality=${item.artifact.quality || "auto"}, format=${item.artifact.outputFormat || imageExtension(item.mimeType)}`;
		const promptLines = wrapPlainText(item.artifact.prompt, Math.max(1, width - 2)).map((line) => `  ${line}`);
		return [
			truncateToWidth(header, width),
			truncateToWidth(name, width),
			truncateToWidth(this.theme.fg("dim", options), width),
			"",
			...this.image.render(width),
			"",
			this.theme.fg("accent", "Prompt:"),
			...promptLines.map((line) => truncateToWidth(line, width)),
			"",
			truncateToWidth(this.theme.fg("dim", "←/→ or h/l switch • q/esc close"), width),
		];
	}

	invalidate(): void {
		this.image?.invalidate();
	}
}

export default function gptImage(pi: ExtensionAPI) {
	let artifacts: ImageArtifact[] = [];
	let activeSessionId = "";
	let activeOutputDir = "";
	let config = loadConfig(process.cwd());

	async function restoreArtifacts(ctx: { cwd: string; sessionManager: { getSessionId(): string } }) {
		activeSessionId = getSessionId(ctx);
		const outputDir = await ensureOutputDir(config, { cwd: ctx.cwd }, activeSessionId);
		activeOutputDir = outputDir;
		artifacts = readManifest(outputDir, activeSessionId).artifacts;
	}

	function helpText(): string {
		return [
			"# gpt-image",
			"",
			"Uses Pi's existing ChatGPT Plus/Pro (Codex) login. No OPENAI_API_KEY. No OpenAI Platform billing.",
			"",
			"## Commands",
			"- `/gpt-image` — show this help",
			"- `/gpt-image list` — print current-session image artifacts",
			"- `/gpt-image list carousel` — browse current-session images with ←/→",
			"- `/gpt-image config` — show effective config and allowed values",
			"- `/gpt-image config edit` — edit project config.json",
			"- `/gpt-image config reset` — reset project config.json to defaults",
			"",
			"## Tools",
			"- `gpt_image_generate` — generate image from prompt",
			"- `gpt_image_list` — list generated image artifacts",
			"",
			"## Generation options",
			"- `size`: `auto`, exact dimensions, or preset: `square`, `landscape`, `portrait`, `square-2k`, `landscape-2k`, `landscape-4k`, `portrait-4k`",
			"- `quality`: `low`, `medium`, `high`, `auto`",
			"- `outputFormat`: `png`, `jpeg`, `webp`",
			"",
			"Defaults can be configured in `.pi/gpt-image/config.json` or `~/.pi/agent/gpt-image/config.json`.",
			"Use `/gpt-image config` to see current config and allowed values.",
			"",
			"## Output directory",
			"- `outputDir: \"project\"` — save to `.pi/gpt-image/<session-id>/`",
			"- `outputDir: \"~/Projects/gpt-images\"` — save to `~/Projects/gpt-images/<session-id>/`",
			"- image metadata is stored in `<outputDir>/<session-id>/manifest.json`",
			"- custom output directories are only created from `/gpt-image config` after confirmation; generation fails fast if missing",
			"",
			"## Examples",
			"- `create a square icon of a red circle on white using gpt-image`",
			"- `create a landscape sci-fi city at sunset using gpt-image`",
		].join("\n");
	}

	function artifactListText(): string {
		if (artifacts.length === 0) return `No gpt-image artifacts for session ${activeSessionId || "unknown"}.`;
		return [
			"# gpt-image artifacts",
			`Session: ${activeSessionId}`,
			`Manifest: ${activeOutputDir ? manifestPath(activeOutputDir) : "unknown"}`,
			"",
			...artifacts.map((a, index) =>
				[
					`${index + 1}. \`${a.id}\``,
					`   - size: ${a.size || "auto"}`,
					`   - quality: ${a.quality || "auto"}`,
					`   - format: ${a.outputFormat || imageExtension(a.mimeType)}`,
					...(a.savedPath ? [`   - path: ${a.savedPath}`] : []),
					`   - prompt: ${a.prompt}`,
				].join("\n"),
			),
		].join("\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		try {
			await restoreArtifacts(ctx);
		} catch {
			activeSessionId = getSessionId(ctx);
			activeOutputDir = "";
			artifacts = [];
		}
		ctx.ui.setWidget(EXTENSION_NAME, undefined);
		ctx.ui.setStatus(EXTENSION_NAME, ctx.ui.theme.fg("accent", "gpt-image"));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget(EXTENSION_NAME, undefined);
		ctx.ui.setStatus(EXTENSION_NAME, undefined);
	});

	pi.registerCommand("gpt-image", {
		description: "Manage GPT image generation through Pi's ChatGPT/Codex subscription login",
		handler: async (args, ctx) => {
			config = loadConfig(ctx.cwd);
			ctx.ui.setWidget(EXTENSION_NAME, undefined);
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const command = parts[0];
			const subcommand = parts[1];
			if (!command) {
				pi.sendMessage({ customType: "gpt-image-help", content: helpText(), display: true });
				return;
			}
			if (command === "list") {
				if (getSessionId(ctx) !== activeSessionId || !activeOutputDir) await restoreArtifacts(ctx);
				if (!subcommand) {
					pi.sendMessage({ customType: "gpt-image-artifacts", content: artifactListText(), display: true });
					return;
				}
				if (subcommand === "carousel") {
					const items = loadCarouselItems(artifacts);
					if (items.length === 0) {
						ctx.ui.notify("No saved gpt-image artifacts for this session.", "info");
						return;
					}
					await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new GptImageCarousel(items, theme, done, () => tui.requestRender()));
					return;
				}
				ctx.ui.notify("Usage: /gpt-image list [carousel]", "info");
				return;
			}
			if (command === "config") {
				const configPath = getProjectConfigPath(ctx.cwd);
				if (!subcommand) {
					const content = [`# gpt-image config`, "", `Path: \`${configPath}\``, "", "```json", prettyJson(userConfigFile(config)).trimEnd(), "```", "", configValuesText(), "", "Edit with: `/gpt-image config edit`"].join("\n");
					pi.sendMessage({ customType: "gpt-image-config", content, display: true });
					return;
				}
				if (subcommand === "reset") {
					await mkdir(dirname(configPath), { recursive: true });
					await writeFile(configPath, prettyJson(defaultConfigFile()), "utf8");
					config = loadConfig(ctx.cwd);
					ctx.ui.notify(`Reset gpt-image config: ${configPath}`, "info");
					return;
				}
				if (subcommand !== "edit") {
					ctx.ui.notify("Usage: /gpt-image config [edit|reset]", "info");
					return;
				}
				let currentConfigText = prettyJson(defaultConfigFile());
				if (existsSync(configPath)) {
					try {
						const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>;
						currentConfigText = prettyJson(userConfigFile(normalizeConfig(parsed, ctx.cwd, false)));
					} catch {
						currentConfigText = readFileSync(configPath, "utf8");
					}
				}
				const edited = await ctx.ui.editor("Edit gpt-image config.json", currentConfigText);
				if (edited === undefined) {
					ctx.ui.notify("Config edit cancelled", "info");
					return;
				}
				try {
					const parsed = JSON.parse(edited) as Partial<Config>;
					const normalized = normalizeConfig(parsed, ctx.cwd, false);
					const userConfig = await validateConfigOutputDirForSave(userConfigFile(normalized), ctx);
					await mkdir(dirname(configPath), { recursive: true });
					await writeFile(configPath, prettyJson(userConfig), "utf8");
					config = loadConfig(ctx.cwd);
					ctx.ui.notify(`Saved gpt-image config: ${configPath}`, "info");
				} catch (error) {
					ctx.ui.notify(`Invalid gpt-image config: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /gpt-image | list [carousel] | config", "info");
		},
	});

	pi.registerTool({
		name: "gpt_image_generate",
		label: "GPT Image Generate",
		description:
			"Generate an image using Pi's existing ChatGPT Plus/Pro (Codex) subscription login. Does not use OPENAI_API_KEY and does not incur OpenAI API billing.",
		promptSnippet: "Generate images through Pi's ChatGPT/Codex subscription login",
		promptGuidelines: [
			"Use gpt_image_generate when the user asks to create, generate, or draw an image and wants to use their ChatGPT subscription.",
			"gpt_image_generate uses Pi's openai-codex login only; it never uses OPENAI_API_KEY or OpenAI Platform billing.",
			"Do not pass optional size, quality, or outputFormat unless the user explicitly requests them. Omit them so gpt-image config defaults apply.",
		],
		parameters: GENERATE_PARAMS,
		async execute(_toolCallId, params: GenerateParams, signal, onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Request was aborted");
			config = loadConfig(ctx.cwd);
			const sessionId = getSessionId(ctx);
			activeSessionId = sessionId;
			const outputDir = await ensureOutputDir(config, ctx, sessionId);
			const options = validateGenerateParams(config, params);
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Generating image: "${summarizePrompt(params.prompt)}"\nParameters: ${generationOptionsText(options)}`,
					},
				],
				details: { parameters: options },
			});
			const image = await requestImageViaPiLogin(ctx, config, params, signal);
			const savedPath = await saveImage(image.data, image.mimeType, outputDir);
			const artifact: ImageArtifact = {
				id: `gpti_${randomUUID().slice(0, 8)}`,
				sessionId,
				parentId: params.parentId,
				prompt: params.prompt,
				mimeType: image.mimeType,
				size: resolveSizePreset(options.size),
				quality: options.quality,
				outputFormat: options.outputFormat,
				savedPath,
				responseId: image.responseId,
				createdAt: Date.now(),
			};
			artifacts.push(artifact);
			activeOutputDir = outputDir;
			await appendArtifactToManifest(outputDir, sessionId, artifact);
			const summary = [
				`Generated ${artifact.id} via Pi ChatGPT/Codex subscription login.`,
				`Parameters: ${generationOptionsText(options)}.`,
			];
			if (savedPath) summary.push(`Saved to: ${savedPath}`);
			return {
				content: [
					{ type: "text", text: summary.join(" ") },
					{ type: "image", data: image.data, mimeType: image.mimeType },
				],
				details: { artifact, parameters: options },
			};
		},
	});

	pi.registerTool({
		name: "gpt_image_list",
		label: "GPT Image List",
		description: "List images generated by gpt-image in this pi session.",
		parameters: LIST_PARAMS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const sessionId = getSessionId(ctx);
			if (sessionId !== activeSessionId || !activeOutputDir) await restoreArtifacts(ctx);
			if (artifacts.length === 0) {
				return { content: [{ type: "text", text: `No gpt-image artifacts for session ${sessionId}.` }], details: { sessionId, artifacts: [] } };
			}
			const text = [
				`Session: ${sessionId}`,
				`Manifest: ${activeOutputDir ? manifestPath(activeOutputDir) : "unknown"}`,
				"",
				...artifacts.map((a, index) =>
					[
						`${index + 1}. ${a.id}`,
						`   - size: ${a.size || "auto"}`,
						`   - quality: ${a.quality || "auto"}`,
						`   - format: ${a.outputFormat || imageExtension(a.mimeType)}`,
						...(a.savedPath ? [`   - path: ${a.savedPath}`] : []),
						`   - prompt: ${a.prompt}`,
					].join("\n"),
				),
			].join("\n");
			return { content: [{ type: "text", text }], details: { sessionId, artifacts } };
		},
	});
}
