/**
 * Streaming-safe filters for leaked chat-template tool-call and thinking markup.
 *
 * Hosted models sometimes leak raw template markup into visible `content` instead
 * of returning structured events. Tool-call healing delegates to the same
 * dialect scanners used by owned in-band tool calling; this file keeps the
 * provider-facing compatibility wrapper and model/provider gating.
 */

import { randomUUID } from "node:crypto";
import { parseJsonWithRepair } from "../utils/json-parse.js";

// --- inband scanner types --------------------------------------------------

export type InbandScanEvent =
	| { type: "text"; text: string }
	| { type: "thinkingStart" }
	| { type: "thinkingDelta"; delta: string }
	| { type: "thinkingEnd"; thinking: string }
	| { type: "toolStart"; id: string; name: string }
	| { type: "toolArgDelta"; id: string; name: string; key: string; delta: string }
	| { type: "toolEnd"; id: string; name: string; arguments: Record<string, unknown>; rawBlock?: string };

export interface InbandScanner {
	feed(text: string): InbandScanEvent[];
	flush(): InbandScanEvent[];
}

// --- coercion helpers ------------------------------------------------------

export function partialSuffixOverlap(text: string, tag: string): number {
	const max = Math.min(text.length, tag.length - 1);
	for (let k = max; k > 0; k--) {
		if (text.endsWith(tag.slice(0, k))) return k;
	}
	return 0;
}

export function partialSuffixOverlapAny(text: string, tags: readonly string[]): number {
	let best = 0;
	for (const tag of tags) best = Math.max(best, partialSuffixOverlap(text, tag));
	return best;
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function normalizeKimiFunctionName(rawId: string): string {
	const beforeIndex = rawId.split(":", 1)[0] ?? rawId;
	const parts = beforeIndex.split(".");
	return parts[parts.length - 1]?.trim() ?? beforeIndex.trim();
}

let idCounter = 0;
export function mintToolCallId(): string {
	idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `ptc_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

// --- fenced thinking close-matcher -----------------------------------------

/**
 * Close-matcher for a ` ```thinking ` block that respects nested Markdown code
 * fences. A naive `indexOf("```")` closes the thinking section at the FIRST
 * backtick fence inside the reasoning, so an inner ` ```rs … ``` ` code block
 * leaks its body (and everything after) into the visible channel. This scanner
 * tracks inner-fence nesting so only the real thinking closer ends the block.
 */

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BACKTICK_LEAD = /^ {0,3}(`*)([\s\S]*)$/;
const LANG_TOKEN = /^[A-Za-z0-9_+#-]+$/;

export interface FencedThinkingResult {
	readonly thinking: string;
	readonly closed: boolean;
	readonly rest: string;
}

export class FencedThinkingScanner {
	#buffer = "";
	#inner = "";
	#emitted = 0;

	feed(text: string, final: boolean): FencedThinkingResult {
		this.#buffer += text;
		let thinking = "";
		for (;;) {
			const nl = this.#buffer.indexOf("\n");
			if (nl === -1) break;
			const line = this.#buffer.slice(0, nl);
			if (!this.#inner) {
				const close = this.#closeRest(line);
				if (close !== undefined) {
					const rest = close + this.#buffer.slice(nl);
					this.#reset();
					return { thinking, closed: true, rest };
				}
			}
			thinking += this.#buffer.slice(this.#emitted, nl + 1);
			this.#updateInner(line);
			this.#buffer = this.#buffer.slice(nl + 1);
			this.#emitted = 0;
		}

		const tail = this.#buffer;
		if (this.#inner) {
			thinking += tail.slice(this.#emitted);
			this.#emitted = tail.length;
			return { thinking, closed: false, rest: "" };
		}

		if (final) {
			const close = this.#closeRestFinal(tail);
			if (close !== undefined) {
				this.#reset();
				return { thinking, closed: true, rest: close };
			}
		} else {
			const close = this.#closeRestStreamingTail(tail);
			if (close !== undefined) {
				this.#reset();
				return { thinking, closed: true, rest: close };
			}
			if (this.#mustHold(tail)) return { thinking, closed: false, rest: "" };
		}
		thinking += tail.slice(this.#emitted);
		if (final) this.#reset();
		else this.#emitted = tail.length;
		return { thinking, closed: false, rest: "" };
	}

	#closeRest(line: string): string | undefined {
		const m = BACKTICK_LEAD.exec(line);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		if (rest === "" || rest.trim() === "") return "";
		if (LANG_TOKEN.test(rest)) return undefined;
		return rest;
	}

	#closeRestFinal(tail: string): string | undefined {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		return rest.trim() === "" ? "" : rest;
	}

	#closeRestStreamingTail(tail: string): string | undefined {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		if (rest === "" || rest.trim() === "" || LANG_TOKEN.test(rest)) return undefined;
		return rest;
	}

	#mustHold(tail: string): boolean {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m) return false;
		const ticks = m[1]!.length;
		const rest = m[2]!;
		if (rest === "" || rest.trim() === "") return ticks >= 1 || /^ {0,3}$/.test(tail);
		return ticks >= 3 && LANG_TOKEN.test(rest);
	}

	#reset(): void {
		this.#buffer = "";
		this.#inner = "";
		this.#emitted = 0;
	}

	#updateInner(line: string): void {
		const fence = FENCE_LINE.exec(line);
		if (!fence) return;
		const run = fence[1]!;
		const info = fence[2]!.trim();
		if (!this.#inner) {
			this.#inner = run;
		} else if (run[0] === this.#inner[0] && run.length >= this.#inner.length && info === "") {
			this.#inner = "";
		}
	}
}

// --- generic thinking inband scanner ---------------------------------------

type Tag = { readonly open: string; readonly close: string; readonly fenced?: boolean };

const TAGS: readonly Tag[] = [
	{ open: "", close: "" },
	{ open: "<thinking>", close: "</thinking>" },
	{ open: "<scratchpad>", close: "</scratchpad>" },
	{ open: "```thinking\n", close: "```", fenced: true },
	{ open: "<|channel>thought\n", close: "<channel|>" },
	{ open: "<|start|>assistant<|channel|>analysis<|message|>", close: "<|end|>" },
	{ open: "<|channel|>analysis<|message|>", close: "<|end|>" },
];
const OPENS = TAGS.map(tag => tag.open);

export class ThinkingInbandScanner implements InbandScanner {
	#buffer = "";
	#closeTag = "";
	#thinking = "";
	#fenced: FencedThinkingScanner | undefined;
	#codeTicks = 0;
	#codeFenced = false;
	#lineIndent = 0;

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		const events = this.#consume(true);
		if (this.#buffer.length === 0) return events;
		if (this.#closeTag) {
			this.#emitThinking(this.#buffer, events);
			events.push({ type: "thinkingEnd", thinking: this.#thinking });
		} else {
			events.push({ type: "text", text: this.#buffer });
		}
		this.#buffer = "";
		this.#closeTag = "";
		return events;
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		for (;;) {
			if (this.#fenced) {
				const result = this.#fenced.feed(this.#buffer, final);
				this.#buffer = result.closed ? result.rest : "";
				this.#emitThinking(result.thinking, events);
				if (result.closed || final) {
					events.push({ type: "thinkingEnd", thinking: this.#thinking });
					this.#thinking = "";
					this.#closeTag = "";
					this.#fenced = undefined;
				}
				if (this.#fenced) break;
				continue;
			}
			if (this.#buffer.length === 0) break;
			if (this.#closeTag) {
				const close = this.#buffer.indexOf(this.#closeTag);
				if (close === -1) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [this.#closeTag]);
					this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					break;
				}
				this.#emitThinking(this.#buffer.slice(0, close), events);
				this.#buffer = this.#buffer.slice(close + this.#closeTag.length);
				events.push({ type: "thinkingEnd", thinking: this.#thinking });
				this.#thinking = "";
				this.#closeTag = "";
				continue;
			}
			if (this.#codeTicks > 0) {
				if (this.#emitCode(final, events)) continue;
				break;
			}

			const hit = scanVisible(this.#buffer, final);
			if (hit.kind === "none") {
				this.#emitText(this.#buffer, events);
				this.#buffer = "";
				break;
			}
			if (hit.index > 0) this.#emitText(this.#buffer.slice(0, hit.index), events);
			if (hit.kind === "hold") {
				this.#buffer = this.#buffer.slice(hit.index);
				break;
			}
			if (hit.kind === "code") {
				const fenced = hit.ticks >= 3 && this.#lineIndent >= 0 && this.#lineIndent <= 3;
				this.#emitText(this.#buffer.slice(hit.index, hit.index + hit.ticks), events);
				this.#buffer = this.#buffer.slice(hit.index + hit.ticks);
				this.#codeTicks = hit.ticks;
				this.#codeFenced = fenced;
				continue;
			}
			this.#buffer = this.#buffer.slice(hit.index + hit.tag.open.length);
			this.#closeTag = hit.tag.close;
			this.#thinking = "";
			if (hit.tag.fenced) this.#fenced = new FencedThinkingScanner();
			events.push({ type: "thinkingStart" });
		}
		return events;
	}

	#emitCode(final: boolean, events: InbandScanEvent[]): boolean {
		if (this.#codeFenced) {
			const end = findFenceCloseEnd(this.#buffer, this.#codeTicks, final);
			if (end !== -1) {
				this.#emitText(this.#buffer.slice(0, end), events);
				this.#buffer = this.#buffer.slice(end);
				this.#codeTicks = 0;
				this.#codeFenced = false;
				return true;
			}
			if (final) {
				this.#emitText(this.#buffer, events);
				this.#buffer = "";
				this.#codeTicks = 0;
				this.#codeFenced = false;
				return false;
			}
			const lastNl = this.#buffer.lastIndexOf("\n");
			if (lastNl !== -1) {
				this.#emitText(this.#buffer.slice(0, lastNl + 1), events);
				this.#buffer = this.#buffer.slice(lastNl + 1);
			}
			return false;
		}
		const close = findBacktickRun(this.#buffer, 0, this.#codeTicks);
		if (close !== -1 && (final || close + this.#codeTicks < this.#buffer.length)) {
			this.#emitText(this.#buffer.slice(0, close + this.#codeTicks), events);
			this.#buffer = this.#buffer.slice(close + this.#codeTicks);
			this.#codeTicks = 0;
			return true;
		}
		const hold = final ? 0 : trailingBacktickRun(this.#buffer);
		this.#emitText(this.#buffer.slice(0, this.#buffer.length - hold), events);
		this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
		if (final) this.#codeTicks = 0;
		return false;
	}

	#emitText(text: string, events: InbandScanEvent[]): void {
		if (text.length === 0) return;
		events.push({ type: "text", text });
		this.#lineIndent = trailingLineIndent(text, this.#lineIndent);
	}

	#emitThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}
}

type VisibleHit =
	| { readonly kind: "tag"; readonly index: number; readonly tag: Tag }
	| { readonly kind: "code"; readonly index: number; readonly ticks: number }
	| { readonly kind: "hold"; readonly index: number }
	| { readonly kind: "none" };

function scanVisible(buffer: string, final: boolean): VisibleHit {
	for (let i = 0; i < buffer.length; i++) {
		const tag = TAGS.find(candidate => buffer.startsWith(candidate.open, i));
		if (tag) return { kind: "tag", index: i, tag };
		if (!final) {
			const rest = buffer.slice(i);
			if (OPENS.some(open => open.length > rest.length && open.startsWith(rest))) {
				return { kind: "hold", index: i };
			}
		}
		if (buffer[i] === "`") {
			const ticks = backtickRun(buffer, i);
			if (!final && i + ticks === buffer.length) return { kind: "hold", index: i };
			return { kind: "code", index: i, ticks };
		}
	}
	return { kind: "none" };
}

function backtickRun(buffer: string, from: number): number {
	let end = from;
	while (end < buffer.length && buffer[end] === "`") end++;
	return end - from;
}

function findBacktickRun(buffer: string, from: number, ticks: number): number {
	for (let i = buffer.indexOf("`", from); i !== -1; i = buffer.indexOf("`", i)) {
		const run = backtickRun(buffer, i);
		if (run === ticks) return i;
		i += run;
	}
	return -1;
}

function trailingBacktickRun(buffer: string): number {
	let start = buffer.length;
	while (start > 0 && buffer[start - 1] === "`") start--;
	return buffer.length - start;
}

function trailingLineIndent(text: string, prior: number): number {
	const lastNl = text.lastIndexOf("\n");
	let indent = lastNl === -1 ? prior : 0;
	for (let i = lastNl + 1; i < text.length; i++) {
		if (indent === -1) break;
		indent = text[i] === " " ? indent + 1 : -1;
	}
	return indent;
}

function findFenceCloseEnd(buffer: string, ticks: number, final: boolean): number {
	for (let start = 0; start <= buffer.length; ) {
		const nl = buffer.indexOf("\n", start);
		const terminated = nl !== -1;
		const line = buffer.slice(start, terminated ? nl : buffer.length).trim();
		if (line.length >= ticks && isAllBackticks(line) && (terminated || final)) {
			return terminated ? nl + 1 : buffer.length;
		}
		if (!terminated) break;
		start = nl + 1;
	}
	return -1;
}

function isAllBackticks(text: string): boolean {
	for (let i = 0; i < text.length; i++) if (text[i] !== "`") return false;
	return text.length > 0;
}

// --- kimi inband scanner ---------------------------------------------------

export const KIMI_SECTION_BEGIN = "<|tool_calls_section_begin|>";
export const KIMI_SECTION_END = "<|tool_calls_section_end|>";
export const KIMI_CALL_BEGIN = "<|tool_call_begin|>";
export const KIMI_CALL_END = "<|tool_call_end|>";
export const KIMI_ARG_BEGIN = "<|tool_call_argument_begin|>";

const KIMI_TOKENS = [KIMI_SECTION_BEGIN, KIMI_SECTION_END, KIMI_CALL_BEGIN, KIMI_CALL_END, KIMI_ARG_BEGIN] as const;
const KIMI_THINK_OPEN = "";
const KIMI_THINK_CLOSE = "";
const KIMI_TOKENS_THINK = [
	KIMI_SECTION_BEGIN,
	KIMI_SECTION_END,
	KIMI_CALL_BEGIN,
	KIMI_CALL_END,
	KIMI_ARG_BEGIN,
	KIMI_THINK_OPEN,
] as const;

type KimiState = "outside" | "section" | "header" | "args" | "thinking";

export class KimiInbandScanner implements InbandScanner {
	#buffer = "";
	#state: KimiState = "outside";
	#id = "";
	#name = "";
	#rawBlock = "";
	#thinking = "";
	readonly #parseThinking: boolean;

	constructor(options: { parseThinking?: boolean } = {}) {
		this.#parseThinking = options.parseThinking !== false;
	}

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		return this.#consume(true);
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		while (this.#buffer.length > 0) {
			if (this.#state === "outside") {
				if (!this.#consumeOutside(final, events)) break;
				continue;
			}

			if (this.#state === "thinking") {
				if (!this.#consumeThinking(final, events)) break;
				continue;
			}

			if (this.#state === "section") {
				if (!this.#consumeSection(final)) break;
				continue;
			}

			if (this.#state === "header") {
				if (!this.#consumeHeader(final, events)) break;
				continue;
			}

			if (!this.#consumeArgs(final, events)) break;
		}
		if (final && this.#state === "thinking") this.#endThinking(events);
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): boolean {
		const tokenStart = this.#nextTokenIndex();
		const thinkStart = this.#parseThinking ? this.#buffer.indexOf(KIMI_THINK_OPEN) : -1;
		let start = tokenStart;
		if (thinkStart !== -1 && (start === -1 || thinkStart < start)) start = thinkStart;
		if (start === -1) {
			const tags = this.#parseThinking ? KIMI_TOKENS_THINK : KIMI_TOKENS;
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, tags);
			const emitEnd = this.#buffer.length - hold;
			if (emitEnd > 0) events.push({ type: "text", text: this.#buffer.slice(0, emitEnd) });
			this.#buffer = this.#buffer.slice(emitEnd);
			return false;
		}

		if (start > 0) events.push({ type: "text", text: this.#buffer.slice(0, start) });
		this.#buffer = this.#buffer.slice(start);
		if (this.#parseThinking && this.#buffer.startsWith(KIMI_THINK_OPEN)) {
			this.#buffer = this.#buffer.slice(KIMI_THINK_OPEN.length);
			this.#thinking = "";
			events.push({ type: "thinkingStart" });
			this.#state = "thinking";
			return true;
		}
		const token = this.#tokenAtStart();
		if (!token) return false;
		this.#buffer = this.#buffer.slice(token.length);
		if (token === KIMI_SECTION_BEGIN) this.#state = "section";
		else events.push({ type: "text", text: token });
		return true;
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): boolean {
		const close = this.#buffer.indexOf(KIMI_THINK_CLOSE);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [KIMI_THINK_CLOSE]);
			this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) {
				this.#endThinking(events);
				this.#state = "outside";
			}
			return false;
		}
		this.#emitThinking(this.#buffer.slice(0, close), events);
		this.#buffer = this.#buffer.slice(close + KIMI_THINK_CLOSE.length);
		this.#endThinking(events);
		this.#state = "outside";
		return true;
	}

	#emitThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}

	#endThinking(events: InbandScanEvent[]): void {
		events.push({ type: "thinkingEnd", thinking: this.#thinking });
		this.#thinking = "";
		this.#state = "outside";
	}

	#consumeSection(final: boolean): boolean {
		this.#skipWhitespace();
		if (this.#buffer.length === 0) return false;

		const token = this.#tokenAtStart();
		if (token === KIMI_SECTION_END) {
			this.#buffer = this.#buffer.slice(KIMI_SECTION_END.length);
			this.#state = "outside";
			return true;
		}
		if (token === KIMI_CALL_BEGIN) {
			this.#buffer = this.#buffer.slice(KIMI_CALL_BEGIN.length);
			this.#state = "header";
			return true;
		}
		if (token) {
			this.#buffer = this.#buffer.slice(token.length);
			return true;
		}

		if (!final && partialSuffixOverlapAny(this.#buffer, KIMI_TOKENS) === this.#buffer.length) return false;
		this.#buffer = this.#buffer.slice(1);
		return true;
	}

	#consumeHeader(final: boolean, events: InbandScanEvent[]): boolean {
		const sep = this.#buffer.indexOf(KIMI_ARG_BEGIN);
		if (sep === -1) {
			if (final) this.#dropBufferedCall();
			return false;
		}

		const rawHeader = this.#buffer.slice(0, sep);
		this.#id = rawHeader.trim();
		this.#name = normalizeKimiFunctionName(this.#id);
		this.#rawBlock = `${KIMI_CALL_BEGIN}${rawHeader}${KIMI_ARG_BEGIN}`;
		events.push({ type: "toolStart", id: this.#id, name: this.#name });
		this.#buffer = this.#buffer.slice(sep + KIMI_ARG_BEGIN.length);
		this.#state = "args";
		return true;
	}

	#consumeArgs(final: boolean, events: InbandScanEvent[]): boolean {
		const end = this.#buffer.indexOf(KIMI_CALL_END);
		if (end === -1) {
			if (final) this.#dropBufferedCall();
			return false;
		}

		const rawArgsBlock = this.#buffer.slice(0, end);
		const rawArgs = rawArgsBlock.trim();
		events.push({
			type: "toolEnd",
			id: this.#id,
			name: this.#name,
			arguments: this.#parseArgs(rawArgs),
			rawBlock: `${this.#rawBlock}${rawArgsBlock}${KIMI_CALL_END}`,
		});
		this.#buffer = this.#buffer.slice(end + KIMI_CALL_END.length);
		this.#resetCall();
		this.#state = "section";
		return true;
	}

	#parseArgs(rawArgs: string): Record<string, unknown> {
		if (rawArgs.length === 0) return {};
		try {
			return asRecord(parseJsonWithRepair<unknown>(rawArgs));
		} catch {
			return {};
		}
	}

	#nextTokenIndex(): number {
		let best = -1;
		for (const token of KIMI_TOKENS) {
			const index = this.#buffer.indexOf(token);
			if (index !== -1 && (best === -1 || index < best)) best = index;
		}
		return best;
	}

	#tokenAtStart(): string | undefined {
		for (const token of KIMI_TOKENS) {
			if (this.#buffer.startsWith(token)) return token;
		}
		return undefined;
	}

	#skipWhitespace(): void {
		let i = 0;
		while (i < this.#buffer.length && isKimiWhitespace(this.#buffer.charCodeAt(i))) i++;
		if (i > 0) this.#buffer = this.#buffer.slice(i);
	}

	#dropBufferedCall(): void {
		this.#buffer = "";
		this.#resetCall();
		this.#state = "outside";
	}

	#resetCall(): void {
		this.#id = "";
		this.#name = "";
		this.#rawBlock = "";
	}
}

function isKimiWhitespace(cp: number): boolean {
	return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0b || cp === 0x0c;
}

// --- deepseek (DSML) inband scanner ----------------------------------------

export const DEEPSEEK_TOOL_CALLS_BEGIN = "<｜tool▁calls▁begin｜>";
export const DEEPSEEK_TOOL_CALLS_END = "<｜tool▁calls▁end｜>";
export const DEEPSEEK_TOOL_CALL_BEGIN = "<｜tool▁call▁begin｜>";
export const DEEPSEEK_TOOL_CALL_END = "<｜tool▁call▁end｜>";
export const DEEPSEEK_TOOL_SEPARATOR = "<｜tool▁sep｜>";
const DEEPSEEK_TOOL_OUTPUT_BEGIN = "<｜tool▁output▁begin｜>";
const DEEPSEEK_TOOL_OUTPUT_END = "<｜tool▁output▁end｜>";
const DEEPSEEK_BOS = "<｜begin▁of▁sentence｜>";
const DEEPSEEK_USER = "<｜User｜>";
const DEEPSEEK_ASSISTANT = "<｜Assistant｜>";
const DEEPSEEK_EOS = "<｜end▁of▁sentence｜>";

const DS_THINK_OPEN = "";
const DS_THINK_CLOSE = "";
const DS_LEGACY_TOOL_TYPE = "function";
const DS_LEGACY_JSON_FENCE = "```json";
const DS_CODE_FENCE = "```";

const DSML_TOOL_CALLS_OPEN_FULLWIDTH = "<｜DSML｜tool_calls>";
const DSML_TOOL_CALLS_CLOSE_FULLWIDTH = "</｜DSML｜tool_calls>";
const DSML_TOOL_CALLS_OPEN_ASCII = "<|DSML|tool_calls>";
const DSML_TOOL_CALLS_CLOSE_ASCII = "</|DSML|tool_calls>";

const DS_CONTROL_TOKENS = [
	DEEPSEEK_BOS,
	DEEPSEEK_EOS,
	"<｜▁pad▁｜>",
	DEEPSEEK_USER,
	DEEPSEEK_ASSISTANT,
	"<|EOT|>",
	"<｜search▁begin｜>",
	"<｜search▁end｜>",
	"<｜fim▁hole｜>",
	"<｜fim▁begin｜>",
	"<｜fim▁end｜>",
	"<｜tool▁outputs▁begin｜>",
	"<｜tool▁outputs▁end｜>",
	DEEPSEEK_TOOL_OUTPUT_BEGIN,
	DEEPSEEK_TOOL_OUTPUT_END,
] as const;

const DS_OUTSIDE_TOKENS = [
	DEEPSEEK_TOOL_CALLS_BEGIN,
	DEEPSEEK_TOOL_CALLS_END,
	DEEPSEEK_TOOL_CALL_BEGIN,
	DS_THINK_OPEN,
	DS_THINK_CLOSE,
	DSML_TOOL_CALLS_OPEN_FULLWIDTH,
	DSML_TOOL_CALLS_OPEN_ASCII,
	DSML_TOOL_CALLS_CLOSE_FULLWIDTH,
	DSML_TOOL_CALLS_CLOSE_ASCII,
	...DS_CONTROL_TOKENS,
] as const;

const DS_SECTION_TOKENS = [DEEPSEEK_TOOL_CALL_BEGIN, DEEPSEEK_TOOL_CALLS_END] as const;
const DS_DSML_SECTION_TOKENS = [
	DSML_TOOL_CALLS_CLOSE_FULLWIDTH,
	DSML_TOOL_CALLS_CLOSE_ASCII,
	"<｜DSML｜invoke",
	"<|DSML|invoke",
] as const;
const DS_DSML_INVOKE_TOKENS = ["</｜DSML｜invoke>", "</|DSML|invoke>", "<｜DSML｜parameter", "<|DSML|parameter"] as const;
const DS_DSML_PARAMETER_CLOSE_TOKENS = ["</｜DSML｜parameter>", "</|DSML|parameter>"] as const;

type DsState =
	| "outside"
	| "thinking"
	| "section"
	| "header"
	| "args"
	| "legacyName"
	| "legacyArgs"
	| "dsmlSection"
	| "dsmlInvoke"
	| "dsmlParam";

export class DeepSeekInbandScanner implements InbandScanner {
	#buffer = "";
	#state: DsState = "outside";
	#parseThinking: boolean;
	#inToolSection = false;
	#id = "";
	#name = "";
	#thinking = "";
	#dsmlArgs: Record<string, unknown> = {};
	#dsmlParamName = "";
	#dsmlParamIsString = true;
	#dsmlParamRaw = "";
	#rawBlock = "";
	#stripLeadingWhitespace = false;

	constructor(options: { parseThinking?: boolean } = {}) {
		this.#parseThinking = options.parseThinking ?? true;
	}

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		return this.#consume(true);
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		while (this.#buffer.length > 0) {
			if (this.#state === "outside") {
				this.#consumeOutside(final, events);
				if (this.#state !== "outside" && this.#buffer.length > 0) continue;
				break;
			}
			if (this.#state === "thinking") {
				this.#consumeThinking(final, events);
				if (!final && this.#state === "thinking") break;
				continue;
			}
			if (this.#state === "section") {
				if (!this.#consumeSection(final)) break;
				continue;
			}
			if (this.#state === "header") {
				if (!this.#consumeHeader(final, events)) break;
				continue;
			}
			if (this.#state === "legacyName") {
				if (!this.#consumeLegacyName(final, events)) break;
				continue;
			}
			if (this.#state === "args" || this.#state === "legacyArgs") {
				if (!this.#consumeArgs(final, events)) break;
				continue;
			}
			if (this.#state === "dsmlSection") {
				if (!this.#consumeDsmlSection(final, events)) break;
				continue;
			}
			if (this.#state === "dsmlInvoke") {
				if (!this.#consumeDsmlInvoke(final, events)) break;
				continue;
			}
			if (!this.#consumeDsmlParam(final, events)) break;
		}
		if (final && this.#state === "thinking") this.#endThinking(events);
		if (final && this.#buffer.length === 0 && this.#rawBlock.length > 0) this.#rawBlock = "";
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): void {
		while (this.#buffer.length > 0) {
			if (this.#stripLeadingWhitespace) {
				const trimmed = this.#buffer.replace(/^\s+/u, "");
				if (trimmed.length === 0) {
					this.#buffer = "";
					return;
				}
				this.#buffer = trimmed;
				this.#stripLeadingWhitespace = false;
			}
			const match = findEarliestToken(this.#buffer, DS_OUTSIDE_TOKENS);
			if (!match) {
				const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, DS_OUTSIDE_TOKENS);
				const emit = this.#buffer.slice(0, this.#buffer.length - hold);
				if (emit.length > 0) events.push({ type: "text", text: emit });
				this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
				return;
			}
			if (match.index > 0) events.push({ type: "text", text: this.#buffer.slice(0, match.index) });
			this.#buffer = this.#buffer.slice(match.index);
			if (this.#buffer.startsWith(DEEPSEEK_TOOL_CALLS_BEGIN)) {
				this.#buffer = this.#buffer.slice(DEEPSEEK_TOOL_CALLS_BEGIN.length);
				this.#inToolSection = true;
				this.#state = "section";
				return;
			}
			if (this.#buffer.startsWith(DEEPSEEK_TOOL_CALL_BEGIN)) {
				this.#buffer = this.#buffer.slice(DEEPSEEK_TOOL_CALL_BEGIN.length);
				this.#rawBlock = DEEPSEEK_TOOL_CALL_BEGIN;
				this.#inToolSection = false;
				this.#state = "header";
				return;
			}
			if (this.#buffer.startsWith(DS_THINK_OPEN)) {
				this.#buffer = this.#buffer.slice(DS_THINK_OPEN.length);
				this.#state = "thinking";
				this.#thinking = "";
				if (this.#parseThinking) events.push({ type: "thinkingStart" });
				return;
			}
			if (
				this.#buffer.startsWith(DSML_TOOL_CALLS_OPEN_FULLWIDTH) ||
				this.#buffer.startsWith(DSML_TOOL_CALLS_OPEN_ASCII)
			) {
				const openToken = this.#buffer.startsWith(DSML_TOOL_CALLS_OPEN_FULLWIDTH)
					? DSML_TOOL_CALLS_OPEN_FULLWIDTH
					: DSML_TOOL_CALLS_OPEN_ASCII;
				this.#buffer = this.#buffer.slice(openToken.length);
				this.#state = "dsmlSection";
				return;
			}
			const control = this.#matchingControlToken();
			if (control) {
				this.#buffer = this.#buffer.slice(control.length);
				this.#stripLeadingWhitespace = true;
				continue;
			}
			this.#buffer = this.#buffer.slice(match.token.length);
		}
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): void {
		const close = this.#buffer.indexOf(DS_THINK_CLOSE);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [DS_THINK_CLOSE]);
			this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) this.#endThinking(events);
			return;
		}
		this.#emitThinking(this.#buffer.slice(0, close), events);
		this.#buffer = this.#buffer.slice(close + DS_THINK_CLOSE.length);
		this.#endThinking(events);
	}

	#consumeSection(final: boolean): boolean {
		while (this.#buffer.length > 0) {
			this.#skipWhitespace();
			if (this.#buffer.startsWith(DEEPSEEK_TOOL_CALLS_END)) {
				this.#buffer = this.#buffer.slice(DEEPSEEK_TOOL_CALLS_END.length);
				this.#inToolSection = false;
				this.#state = "outside";
				return true;
			}
			if (this.#buffer.startsWith(DEEPSEEK_TOOL_CALL_BEGIN)) {
				this.#buffer = this.#buffer.slice(DEEPSEEK_TOOL_CALL_BEGIN.length);
				this.#rawBlock = DEEPSEEK_TOOL_CALL_BEGIN;
				this.#state = "header";
				return true;
			}
			if (!final && partialSuffixOverlapAny(this.#buffer, DS_SECTION_TOKENS) === this.#buffer.length) return false;
			if (this.#buffer.length === 0) return false;
			this.#buffer = this.#buffer.slice(1);
		}
		return final;
	}

	#consumeHeader(final: boolean, events: InbandScanEvent[]): boolean {
		const sep = this.#buffer.indexOf(DEEPSEEK_TOOL_SEPARATOR);
		if (sep === -1) {
			if (final) this.#resetTool();
			return false;
		}
		const rawHead = this.#buffer.slice(0, sep + DEEPSEEK_TOOL_SEPARATOR.length);
		const head = this.#buffer.slice(0, sep).trim();
		this.#rawBlock += rawHead;
		this.#buffer = this.#buffer.slice(rawHead.length);
		if (head === DS_LEGACY_TOOL_TYPE) {
			this.#state = "legacyName";
			return true;
		}
		this.#startTool(head, events);
		this.#state = "args";
		return true;
	}

	#consumeLegacyName(final: boolean, events: InbandScanEvent[]): boolean {
		const fence = this.#buffer.indexOf(DS_LEGACY_JSON_FENCE);
		if (fence === -1) {
			if (final) this.#resetTool();
			return false;
		}
		const rawName = this.#buffer.slice(0, fence + DS_LEGACY_JSON_FENCE.length);
		const name = this.#buffer.slice(0, fence).trim();
		this.#rawBlock += rawName;
		this.#buffer = this.#buffer.slice(rawName.length);
		this.#rawBlock += this.#dropOneLineBreak();
		this.#startTool(name, events);
		this.#state = "legacyArgs";
		return true;
	}

	#consumeArgs(final: boolean, events: InbandScanEvent[]): boolean {
		const end = this.#buffer.indexOf(DEEPSEEK_TOOL_CALL_END);
		if (end === -1) {
			if (final) this.#resetTool();
			return false;
		}
		let rawArgs = this.#buffer.slice(0, end);
		if (this.#state === "legacyArgs") {
			const fence = rawArgs.lastIndexOf(DS_CODE_FENCE);
			if (fence !== -1) rawArgs = rawArgs.slice(0, fence);
		}
		const rawTail = this.#buffer.slice(0, end + DEEPSEEK_TOOL_CALL_END.length);
		this.#rawBlock += rawTail;
		events.push({
			type: "toolEnd",
			id: this.#id,
			name: this.#name,
			arguments: this.#parseArgs(rawArgs),
			rawBlock: this.#rawBlock,
		});
		this.#buffer = this.#buffer.slice(rawTail.length);
		this.#resetTool(this.#inToolSection ? "section" : "outside");
		return true;
	}

	#consumeDsmlSection(final: boolean, events: InbandScanEvent[]): boolean {
		while (this.#buffer.length > 0) {
			this.#skipWhitespace();
			const close = this.#matchingDsmlClose(DSML_TOOL_CALLS_CLOSE_FULLWIDTH, DSML_TOOL_CALLS_CLOSE_ASCII);
			if (close) {
				this.#buffer = this.#buffer.slice(close.length);
				this.#state = "outside";
				return true;
			}
			const invoke = this.#matchDsmlOpen("invoke");
			if (invoke) {
				this.#rawBlock = invoke.raw;
				this.#name = invoke.name;
				this.#id = mintToolCallId();
				this.#dsmlArgs = {};
				events.push({ type: "toolStart", id: this.#id, name: this.#name });
				this.#state = "dsmlInvoke";
				return true;
			}
			if (!final) {
				if (
					(this.#buffer.startsWith("<｜DSML｜invoke") || this.#buffer.startsWith("<|DSML|invoke")) &&
					!this.#buffer.includes(">")
				)
					return false;
				if (partialSuffixOverlapAny(this.#buffer, DS_DSML_SECTION_TOKENS) === this.#buffer.length) return false;
			}
			if (this.#buffer.length === 0) return false;
			this.#buffer = this.#buffer.slice(1);
		}
		return final;
	}

	#consumeDsmlInvoke(final: boolean, events: InbandScanEvent[]): boolean {
		while (this.#buffer.length > 0) {
			const skipped = this.#skipWhitespace();
			if (skipped.length > 0) this.#rawBlock += skipped;
			const close = this.#matchingDsmlClose("</｜DSML｜invoke>", "</|DSML|invoke>");
			if (close) {
				this.#rawBlock += close;
				this.#buffer = this.#buffer.slice(close.length);
				events.push({
					type: "toolEnd",
					id: this.#id,
					name: this.#name,
					arguments: this.#dsmlArgs,
					rawBlock: this.#rawBlock,
				});
				this.#resetDsmlTool();
				this.#state = "dsmlSection";
				return true;
			}
			const param = this.#matchDsmlOpen("parameter");
			if (param) {
				this.#rawBlock += param.raw;
				this.#dsmlParamName = param.name;
				this.#dsmlParamIsString = param.stringAttr !== "false";
				this.#state = "dsmlParam";
				return true;
			}
			if (!final) {
				if (
					(this.#buffer.startsWith("<｜DSML｜parameter") || this.#buffer.startsWith("<|DSML|parameter")) &&
					!this.#buffer.includes(">")
				)
					return false;
				if (partialSuffixOverlapAny(this.#buffer, DS_DSML_INVOKE_TOKENS) === this.#buffer.length) return false;
			}
			const consumed = this.#buffer[0]!;
			this.#rawBlock += consumed;
			this.#buffer = this.#buffer.slice(1);
		}
		return final;
	}

	#consumeDsmlParam(final: boolean, events: InbandScanEvent[]): boolean {
		const close = findEarliestToken(this.#buffer, DS_DSML_PARAMETER_CLOSE_TOKENS);
		if (!close) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, DS_DSML_PARAMETER_CLOSE_TOKENS);
			const chunk = this.#buffer.slice(0, this.#buffer.length - hold);
			this.#streamDsmlParam(chunk, events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) this.#resetDsmlTool();
			return false;
		}
		this.#streamDsmlParam(this.#buffer.slice(0, close.index), events);
		this.#dsmlArgs[this.#dsmlParamName] = coerceDsmlValue(this.#dsmlParamRaw, this.#dsmlParamIsString);
		this.#rawBlock += close.token;
		this.#buffer = this.#buffer.slice(close.index + close.token.length);
		this.#dsmlParamName = "";
		this.#dsmlParamIsString = true;
		this.#dsmlParamRaw = "";
		this.#state = "dsmlInvoke";
		return true;
	}

	#startTool(name: string, events: InbandScanEvent[]): void {
		this.#name = name;
		this.#id = mintToolCallId();
		events.push({ type: "toolStart", id: this.#id, name: this.#name });
	}

	#streamDsmlParam(chunk: string, events: InbandScanEvent[]): void {
		if (chunk.length === 0) return;
		this.#dsmlParamRaw += chunk;
		this.#rawBlock += chunk;
		events.push({ type: "toolArgDelta", id: this.#id, name: this.#name, key: this.#dsmlParamName, delta: chunk });
	}

	#emitThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		if (this.#parseThinking) {
			this.#thinking += delta;
			events.push({ type: "thinkingDelta", delta });
		} else {
			events.push({ type: "text", text: delta });
		}
	}

	#endThinking(events: InbandScanEvent[]): void {
		if (this.#parseThinking) events.push({ type: "thinkingEnd", thinking: this.#thinking });
		this.#thinking = "";
		this.#state = "outside";
	}

	#parseArgs(rawArgs: string): Record<string, unknown> {
		const trimmed = rawArgs.trim();
		if (trimmed.length === 0) return {};
		try {
			return asRecord(parseJsonWithRepair<unknown>(trimmed));
		} catch {
			return {};
		}
	}

	#skipWhitespace(): string {
		let i = 0;
		while (i < this.#buffer.length && /\s/.test(this.#buffer[i]!)) i++;
		if (i === 0) return "";
		const skipped = this.#buffer.slice(0, i);
		this.#buffer = this.#buffer.slice(i);
		return skipped;
	}

	#dropOneLineBreak(): string {
		if (this.#buffer.startsWith("\r\n")) {
			this.#buffer = this.#buffer.slice(2);
			return "\r\n";
		}
		if (this.#buffer.startsWith("\n")) {
			this.#buffer = this.#buffer.slice(1);
			return "\n";
		}
		return "";
	}

	#matchingControlToken(): string | undefined {
		if (this.#buffer.startsWith(DEEPSEEK_TOOL_CALLS_END)) return DEEPSEEK_TOOL_CALLS_END;
		if (this.#buffer.startsWith(DS_THINK_CLOSE)) return DS_THINK_CLOSE;
		if (this.#buffer.startsWith(DSML_TOOL_CALLS_CLOSE_FULLWIDTH)) return DSML_TOOL_CALLS_CLOSE_FULLWIDTH;
		if (this.#buffer.startsWith(DSML_TOOL_CALLS_CLOSE_ASCII)) return DSML_TOOL_CALLS_CLOSE_ASCII;
		for (const token of DS_CONTROL_TOKENS) {
			if (this.#buffer.startsWith(token)) return token;
		}
		return undefined;
	}

	#matchingDsmlClose(fullwidth: string, ascii: string): string | undefined {
		if (this.#buffer.startsWith(fullwidth)) return fullwidth;
		if (this.#buffer.startsWith(ascii)) return ascii;
		return undefined;
	}

	#matchDsmlOpen(
		kind: "invoke" | "parameter",
	): { name: string; stringAttr: string | undefined; raw: string } | undefined {
		if (!this.#buffer.startsWith(`<｜DSML｜${kind}`) && !this.#buffer.startsWith(`<|DSML|${kind}`)) return undefined;
		const end = this.#buffer.indexOf(">");
		if (end === -1) return undefined;
		const tag = this.#buffer.slice(0, end + 1);
		const name = /\sname="([^"]*)"/.exec(tag)?.[1];
		if (name === undefined) return undefined;
		const stringAttr = /\sstring="(true|false)"/.exec(tag)?.[1];
		this.#buffer = this.#buffer.slice(end + 1);
		return { name, stringAttr, raw: tag };
	}

	#resetTool(next: DsState = "outside"): void {
		this.#state = next;
		this.#id = "";
		this.#name = "";
		this.#rawBlock = "";
	}

	#resetDsmlTool(): void {
		this.#id = "";
		this.#name = "";
		this.#dsmlArgs = {};
		this.#dsmlParamName = "";
		this.#dsmlParamIsString = true;
		this.#dsmlParamRaw = "";
		this.#rawBlock = "";
	}
}

function findEarliestToken(text: string, tokens: readonly string[]): { index: number; token: string } | undefined {
	let bestIndex = -1;
	let bestToken = "";
	for (const token of tokens) {
		const index = text.indexOf(token);
		if (index === -1) continue;
		if (bestIndex === -1 || index < bestIndex || (index === bestIndex && token.length > bestToken.length)) {
			bestIndex = index;
			bestToken = token;
		}
	}
	return bestIndex === -1 ? undefined : { index: bestIndex, token: bestToken };
}

function coerceDsmlValue(raw: string, isString: boolean): unknown {
	if (isString) return raw;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return raw;
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return raw;
	}
}

// --- qwen xml inband scanner -----------------------------------------------

const QWEN_SECTION_OPEN = "<tool_calls>";
const QWEN_SECTION_CLOSE = "</tool_calls>";
const QWEN_TOOL_ELEMENT = /^<([A-Za-z_][\w.-]*)(\s[^<>]*?)?\s*\/>$/s;
const QWEN_ATTRIBUTE = /([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

export class QwenXmlInbandScanner implements InbandScanner {
	#buffer = "";
	#insideSection = false;

	feed(chunk: string): InbandScanEvent[] {
		this.#buffer += chunk;
		return this.#drain(false);
	}

	flush(): InbandScanEvent[] {
		return this.#drain(true);
	}

	#drain(flush: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		while (this.#buffer.length > 0) {
			if (!this.#insideSection) {
				const open = this.#buffer.indexOf(QWEN_SECTION_OPEN);
				if (open >= 0) {
					if (open > 0) events.push({ type: "text", text: this.#buffer.slice(0, open) });
					this.#buffer = this.#buffer.slice(open + QWEN_SECTION_OPEN.length);
					this.#insideSection = true;
					continue;
				}
				if (flush) {
					events.push({ type: "text", text: this.#buffer });
					this.#buffer = "";
					break;
				}
				const held = longestSuffixPrefix(this.#buffer, QWEN_SECTION_OPEN);
				const visibleLength = this.#buffer.length - held;
				if (visibleLength > 0) {
					events.push({ type: "text", text: this.#buffer.slice(0, visibleLength) });
					this.#buffer = this.#buffer.slice(visibleLength);
				}
				break;
			}

			const close = this.#buffer.indexOf(QWEN_SECTION_CLOSE);
			if (close < 0) {
				if (flush) this.#buffer = "";
				break;
			}
			const section = this.#buffer.slice(0, close);
			for (const element of section.match(/<[^<>]+\/>/gs) ?? []) {
				const call = parseQwenToolElement(element);
				if (!call) continue;
				const id = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
				events.push({ type: "toolStart", id, name: call.name });
				events.push({ type: "toolEnd", id, name: call.name, arguments: call.arguments, rawBlock: element });
			}
			this.#buffer = this.#buffer.slice(close + QWEN_SECTION_CLOSE.length);
			this.#insideSection = false;
		}
		return events;
	}
}

function parseQwenToolElement(element: string): { name: string; arguments: Record<string, unknown> } | undefined {
	const match = QWEN_TOOL_ELEMENT.exec(element);
	if (!match) return undefined;
	const args: Record<string, unknown> = {};
	for (const attribute of match[2]?.matchAll(QWEN_ATTRIBUTE) ?? []) {
		args[attribute[1]!] = attribute[3] ?? attribute[4] ?? "";
	}
	return { name: match[1]!, arguments: args };
}

function longestSuffixPrefix(text: string, target: string): number {
	const max = Math.min(text.length, target.length - 1);
	for (let length = max; length > 0; length--) {
		if (text.endsWith(target.slice(0, length))) return length;
	}
	return 0;
}

// --- stream markup healing wrapper -----------------------------------------

const KIMI_SECTION_END_TOKEN = "<|tool_calls_section_end|>";
const DSML_TOOL_CALLS_CLOSE_FULLWIDTH_TOKEN = "</｜DSML｜tool_calls>";
const DSML_TOOL_CALLS_CLOSE_ASCII_TOKEN = "</|DSML|tool_calls>";

export interface HealedToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

export type StreamMarkupHealingPattern = "kimi" | "dsml" | "qwen" | "thinking";

export interface StreamMarkupHealingOptions {
	readonly pattern: StreamMarkupHealingPattern;
}

export type StreamMarkupHealingEvent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "thinking"; readonly thinking: string }
	| { readonly type: "toolCall"; readonly call: HealedToolCall };

/**
 * State machine that consumes streamed visible text and emits cleaned text,
 * thinking deltas, and reconstructed tool calls.
 *
 * A {@link ThinkingInbandScanner} always heals leaked reasoning idioms
 * (``, `<thinking>`, ` ```thinking `, Gemma/Harmony channels, …) out of
 * the visible channel. For Kimi / DeepSeek-DSML the provider tool-call grammar
 * runs first and its cleaned text is piped through that thinking healer, so a
 * model can leak tool-call markup and reasoning in the same stream.
 *
 * Feed only one stream channel (usually `delta.content` / `message.content`).
 * Mixing reasoning and visible text into the same instance can corrupt held-back
 * partial tag buffers.
 */
export class StreamMarkupHealing {
	readonly #pattern: StreamMarkupHealingPattern;
	readonly #toolScanner: InbandScanner | undefined;
	readonly #thinkingScanner = new ThinkingInbandScanner();
	#sectionTerminated = false;
	readonly #completed: HealedToolCall[] = [];

	constructor(options: StreamMarkupHealingOptions) {
		this.#pattern = options.pattern;
		this.#toolScanner =
			options.pattern === "kimi"
				? new KimiInbandScanner()
				: options.pattern === "dsml"
					? new DeepSeekInbandScanner()
					: options.pattern === "qwen"
						? new QwenXmlInbandScanner()
						: undefined;
	}

	get pattern(): StreamMarkupHealingPattern {
		return this.#pattern;
	}

	/**
	 * Feed a chunk and return visible text only. Reconstructed tool calls are
	 * stored for {@link drainCompleted}; thinking blocks are intentionally not
	 * returned by this compatibility helper. Use {@link feedEvents} when the caller
	 * needs ordered text/thinking/tool-call events.
	 */
	feed(text: string): string {
		let clean = "";
		for (const event of this.feedEvents(text)) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	/** Feed a chunk and return cleaned text/thinking/tool-call events in stream order. */
	feedEvents(text: string): StreamMarkupHealingEvent[] {
		if (text.length === 0) return [];
		this.#markSectionClosed(text);
		if (!this.#toolScanner) return this.#convertScannerEvents(this.#thinkingScanner.feed(text));
		return this.#convertScannerEvents(this.#healThinking(this.#toolScanner.feed(text)));
	}

	/**
	 * Feed a chunk and return cleaned events, excluding synthesized tool calls.
	 * Used when the upstream chunk also carries structured `tool_calls`, keeping
	 * that structured payload as the single source of truth while preserving
	 * adjacent text and thinking events.
	 */
	feedEventsWithoutCalls(text: string): StreamMarkupHealingEvent[] {
		const events = this.feedEvents(text);
		let out: StreamMarkupHealingEvent[] | undefined;
		for (let i = 0; i < events.length; i++) {
			const event = events[i]!;
			if (event.type === "toolCall") {
				out ??= events.slice(0, i);
			} else if (out) {
				out.push(event);
			}
		}
		return out ?? events;
	}

	/** Drain accumulated tool calls from calls to {@link feed}. */
	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	/**
	 * Flush held-back stream-end fragments as ordered events. Partial tool-call
	 * sections/envelopes are dropped by the delegated scanners; unterminated
	 * thinking blocks are emitted as thinking, matching the previous MiniMax parser
	 * behavior.
	 */
	flushEvents(): StreamMarkupHealingEvent[] {
		const tail = this.#toolScanner ? this.#healThinking(this.#toolScanner.flush()) : [];
		tail.push(...this.#thinkingScanner.flush());
		return this.#convertScannerEvents(tail);
	}

	/** Flush held-back text only. Reconstructed calls are retained for {@link drainCompleted}. */
	flushPending(): string {
		let clean = "";
		for (const event of this.flushEvents()) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	/** True once any configured tool-call section/envelope has fully closed. */
	get sectionClosed(): boolean {
		return this.#sectionTerminated;
	}

	#markSectionClosed(text: string): void {
		if (this.#sectionTerminated || !this.#toolScanner) return;
		if (this.#pattern === "kimi") {
			this.#sectionTerminated = text.includes(KIMI_SECTION_END_TOKEN);
			return;
		}
		if (this.#pattern === "qwen") {
			this.#sectionTerminated = text.includes("</tool_calls>");
			return;
		}
		this.#sectionTerminated =
			text.includes(DSML_TOOL_CALLS_CLOSE_FULLWIDTH_TOKEN) || text.includes(DSML_TOOL_CALLS_CLOSE_ASCII_TOKEN);
	}

	/**
	 * Re-scan the tool scanner's visible text through the always-on thinking
	 * healer: `text` events are healed for leaked reasoning idioms, while the tool
	 * scanner's own thinking / tool-call events pass through in stream order.
	 */
	#healThinking(toolEvents: readonly InbandScanEvent[]): InbandScanEvent[] {
		const out: InbandScanEvent[] = [];
		for (const event of toolEvents) {
			if (event.type === "text") out.push(...this.#thinkingScanner.feed(event.text));
			else out.push(event);
		}
		return out;
	}

	#convertScannerEvents(events: readonly InbandScanEvent[]): StreamMarkupHealingEvent[] {
		const out: StreamMarkupHealingEvent[] = [];
		for (const event of events) {
			switch (event.type) {
				case "text":
					out.push({ type: "text", text: event.text });
					break;
				case "thinkingDelta":
					if (event.delta.length > 0) out.push({ type: "thinking", thinking: event.delta });
					break;
				case "toolEnd":
					out.push({
						type: "toolCall",
						call: {
							id: generateHealedToolCallId(),
							name: event.name,
							arguments: JSON.stringify(event.arguments),
						},
					});
					break;
				case "thinkingStart":
				case "thinkingEnd":
				case "toolStart":
				case "toolArgDelta":
					break;
			}
		}
		return out;
	}
}

function generateHealedToolCallId(): string {
	return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Detect the healing pattern from streamed text content at runtime.
 *
 * Used for automatic tool-call healing: when a dialect marker appears in
 * `delta.content` mid-stream, this function inspects the text and returns the
 * matching pattern so a {@link StreamMarkupHealing} instance can be created
 * on-the-fly — no provider pre-configuration needed.
 *
 * Returns `undefined` when the text contains no recognized tool-call dialect
 * marker (e.g. Llama `<function=>` tags, which are handled by the post-hoc
 * `rescueInlineToolCalls` path instead).
 */
export function detectHealingPatternFromText(text: string): StreamMarkupHealingPattern | undefined {
	if (text.includes("<|tool_calls_section_begin|>") || text.includes("<|tool_call_begin|>")) {
		return "kimi";
	}
	if (text.includes("<tool_calls>")) {
		return "qwen";
	}
	if (text.includes("｜tool▁calls▁begin｜") || text.includes("｜tool▁call▁begin｜")) {
		return "dsml";
	}
	return undefined;
}
