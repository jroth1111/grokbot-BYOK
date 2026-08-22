/**
 * Tool call accumulator for OpenAI streaming responses.
 *
 * OpenAI streams tool calls as deltas spread across multiple SSE chunks,
 * indexed by position. This accumulator merges those deltas back into
 * complete tool calls and can emit them as Connect InferenceStreamResponse
 * frames.
 */

import type { OpenAISSEChunk, InferenceStreamResponse } from "../types.js";
import { makeToolCallFrame } from "./response.js";

/** A single accumulated tool call, built up from streaming deltas. */
export interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Accumulates OpenAI tool-call deltas and emits Connect tool-call frames.
 *
 * Feed each SSE chunk via {@link ToolCallAccumulator.feed}, then call
 * {@link ToolCallAccumulator.flush} to emit the accumulated tool calls.
 */
export class ToolCallAccumulator {
  private calls: Map<number, AccumulatedToolCall> = new Map();

  /**
   * Feed an OpenAI SSE chunk's tool_calls deltas into the accumulator.
   *
   * Each delta in `chunk.choices[].delta.tool_calls` is merged by its
   * `index`: the `id` and function `name` are overwritten when present,
   * and the function `arguments` string is appended.
   *
   * @param chunk  The OpenAI SSE chunk to merge.
   */
  feed(chunk: OpenAISSEChunk): void {
    for (const choice of chunk.choices ?? []) {
      const toolCalls = choice.delta?.tool_calls;
      if (!toolCalls) {
        continue;
      }
      for (const tc of toolCalls) {
        // Composite key: combine the choice index with the per-choice
        // tool_call index so that tool calls from different choices (n > 1)
        // sharing the same tool_call index don't collide into one entry.
        const idx = choice.index * 1000000 + tc.index;
        const existing = this.calls.get(idx);
        // Use || (not ??) for id/name so that an explicit empty string in a
        // later delta doesn't overwrite a previously accumulated valid value.
        const id = tc.id || existing?.id || "";
        const name = tc.function?.name || existing?.name || "";
        const args = (existing?.args ?? "") + (tc.function?.arguments ?? "");
        this.calls.set(idx, { id, name, args });
      }
    }
  }

  /**
   * Flush accumulated tool calls as InferenceStreamResponse frames.
   *
   * Calls are emitted in index order. When `isStreamComplete` is false,
   * each call is emitted with `isComplete=false` so the host knows a tool
   * call was attempted but did not finish.
   *
   * @param isStreamComplete  Whether the stream completed successfully.
   * @returns  An ordered array of tool-call frames.
   */
  flush(isStreamComplete: boolean): InferenceStreamResponse[] {
    const indices = Array.from(this.calls.keys()).sort((a, b) => a - b);
    const frames: InferenceStreamResponse[] = [];
    for (const idx of indices) {
      const tc = this.calls.get(idx)!;
      frames.push(
        makeToolCallFrame(tc.id, tc.name, tc.args, isStreamComplete),
      );
    }
    return frames;
  }

  /** True if any tool calls have been accumulated. */
  get size(): number {
    return this.calls.size;
  }

  /** Snapshot of accumulated tool calls (for debugging). */
  get callList(): Array<{ id: string; name: string; args: string }> {
    return Array.from(this.calls.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id, name: v.name, args: v.args }));
  }
}
