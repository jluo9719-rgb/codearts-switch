export interface RoutableAccount {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  failures: number;
  activeRequests: number;
  maxConcurrent: number;
  cooldownUntil?: number;
}

export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CanonicalToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface CanonicalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: CanonicalToolCall[];
}

export interface CanonicalChatRequest {
  model: string;
  messages: CanonicalMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream: boolean;
  tools: CanonicalToolDef[];
  toolChoice?: unknown;
  toolsCount: number;
}

export interface CanonicalChatResponse {
  id: string;
  model: string;
  content: string;
  reasoningContent?: string;
  toolCalls?: CanonicalToolCall[];
  finishReason: 'stop' | 'length' | 'tool_calls';
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const obj = part as Record<string, unknown>;
          if (typeof obj.text === 'string') return obj.text;
          if (typeof obj.content === 'string') return obj.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          if (typeof rec.text === 'string') return rec.text;
          return JSON.stringify(rec);
        }
        return '';
      })
      .filter(Boolean);
    return texts.join('\n');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}

/**
 * Translates an Anthropic Messages API request (/v1/messages) used by Claude CLI
 * into our canonical OpenAI-compatible chat request, preserving system prompts,
 * tools, tool_choice, tool_use, and tool_result turns.
 */
export function anthropicToCanonical(
  body: Record<string, unknown>,
  defaultModel = 'GLM-5.2'
): CanonicalChatRequest {
  const model =
    typeof body.model === 'string' && body.model.trim() ? body.model.trim() : defaultModel;
  const messages: CanonicalMessage[] = [];

  if (body.system !== undefined) {
    const sysText = extractTextFromContent(body.system);
    if (sysText) {
      messages.push({ role: 'system', content: sysText });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const item of body.messages) {
      if (!item || typeof item !== 'object') continue;
      const msg = item as Record<string, unknown>;
      const role = msg.role === 'assistant' ? 'assistant' : 'user';

      if (Array.isArray(msg.content)) {
        if (role === 'assistant') {
          const textParts: string[] = [];
          const toolCalls: CanonicalToolCall[] = [];
          for (const block of msg.content) {
            if (!block || typeof block !== 'object') continue;
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') {
              textParts.push(b.text);
            } else if (b.type === 'tool_use' && typeof b.name === 'string') {
              toolCalls.push({
                id: typeof b.id === 'string' ? b.id : `call_${toolCalls.length}`,
                name: b.name,
                arguments:
                  typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
              });
            }
          }
          if (textParts.length > 0 || toolCalls.length > 0) {
            messages.push({
              role: 'assistant',
              content: textParts.join('\n'),
              ...(toolCalls.length > 0 ? { toolCalls } : {}),
            });
          }
        } else {
          // User messages may contain both tool_result blocks and plain text blocks
          const userTexts: string[] = [];
          for (const block of msg.content) {
            if (typeof block === 'string') {
              userTexts.push(block);
              continue;
            }
            if (!block || typeof block !== 'object') continue;
            const b = block as Record<string, unknown>;
            if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
              messages.push({
                role: 'tool',
                toolCallId: b.tool_use_id,
                content: stringifyToolResultContent(b.content),
              });
            } else if (b.type === 'text' && typeof b.text === 'string') {
              userTexts.push(b.text);
            }
          }
          if (userTexts.length > 0) {
            messages.push({ role: 'user', content: userTexts.join('\n') });
          }
        }
      } else {
        const content = extractTextFromContent(msg.content);
        if (content) {
          messages.push({ role, content });
        }
      }
    }
  }

  let tools: CanonicalToolDef[] = [];
  if (Array.isArray(body.tools)) {
    for (const rawTool of body.tools) {
      if (!rawTool || typeof rawTool !== 'object') continue;
      const t = rawTool as Record<string, unknown>;
      if (typeof t.name === 'string' && t.name.trim()) {
        tools.push({
          type: 'function',
          function: {
            name: t.name.trim(),
            ...(typeof t.description === 'string' ? { description: t.description } : {}),
            parameters:
              t.input_schema && typeof t.input_schema === 'object'
                ? (t.input_schema as Record<string, unknown>)
                : { type: 'object', properties: {} },
          },
        });
      }
    }
  }

  // CodeArts upstream InferHub accepts string tool_choice ("auto" | "none" | "required")
  // and rejects object tool_choice; when Anthropic specifies a specific tool, filter tools + "required".
  let toolChoice: unknown = undefined;
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    const tc = body.tool_choice as Record<string, unknown>;
    if (tc.type === 'auto') {
      toolChoice = 'auto';
    } else if (tc.type === 'any') {
      toolChoice = 'required';
    } else if (tc.type === 'none') {
      toolChoice = 'none';
    } else if (tc.type === 'tool' && typeof tc.name === 'string') {
      const matched = tools.filter((t) => t.function.name === tc.name);
      if (matched.length > 0) {
        tools = matched;
        toolChoice = 'required';
      }
    }
  }

  return {
    model,
    messages,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    stream: Boolean(body.stream),
    tools,
    toolChoice,
    toolsCount: tools.length,
  };
}

/**
 * Converts canonical messages into OpenAI / CodeArts ChatV2 wire format.
 */
export function canonicalMessagesToOpenAIWire(
  messages: CanonicalMessage[]
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const out: Record<string, unknown> = {
      role: m.role,
      content: m.content,
    };
    if (m.toolCallId) {
      out.tool_call_id = m.toolCallId;
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
    }
    return out;
  });
}

/**
 * Translates a canonical response back to Anthropic Messages API JSON format (/v1/messages).
 */
export function canonicalToAnthropicResponse(resp: CanonicalChatResponse): Record<string, unknown> {
  const contentBlocks: Array<Record<string, unknown>> = [];

  if (resp.content) {
    contentBlocks.push({
      type: 'text',
      text: resp.content,
    });
  }

  if (resp.toolCalls && resp.toolCalls.length > 0) {
    for (const tc of resp.toolCalls) {
      let parsedInput: unknown = {};
      try {
        parsedInput = tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {
        parsedInput = { raw: tc.arguments };
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: parsedInput,
      });
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: 'text', text: '' });
  }

  const stopReason =
    resp.toolCalls && resp.toolCalls.length > 0
      ? 'tool_use'
      : resp.finishReason === 'length'
        ? 'max_tokens'
        : 'end_turn';

  return {
    id: `msg_${resp.id}`,
    type: 'message',
    role: 'assistant',
    model: resp.model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage.inputTokens,
      output_tokens: resp.usage.outputTokens,
    },
  };
}

/**
 * Formats an Anthropic SSE frame ("event: <name>\ndata: <json>\n\n").
 */
export function formatAnthropicSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Converts a complete CanonicalChatResponse into a compliant sequence of Anthropic SSE events
 * (used for sandbox responses or non-streaming fallbacks when Claude CLI asks for stream: true).
 */
export function canonicalToAnthropicSSEFrames(resp: CanonicalChatResponse): string[] {
  const frames: string[] = [];
  const msgId = `msg_${resp.id}`;

  frames.push(
    formatAnthropicSSE('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: resp.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: resp.usage.inputTokens,
          output_tokens: 0,
        },
      },
    })
  );

  let blockIdx = 0;

  if (resp.content || !resp.toolCalls?.length) {
    frames.push(
      formatAnthropicSSE('content_block_start', {
        type: 'content_block_start',
        index: blockIdx,
        content_block: { type: 'text', text: '' },
      })
    );
    if (resp.content) {
      frames.push(
        formatAnthropicSSE('content_block_delta', {
          type: 'content_block_delta',
          index: blockIdx,
          delta: { type: 'text_delta', text: resp.content },
        })
      );
    }
    frames.push(
      formatAnthropicSSE('content_block_stop', {
        type: 'content_block_stop',
        index: blockIdx,
      })
    );
    blockIdx += 1;
  }

  if (resp.toolCalls && resp.toolCalls.length > 0) {
    for (const tc of resp.toolCalls) {
      frames.push(
        formatAnthropicSSE('content_block_start', {
          type: 'content_block_start',
          index: blockIdx,
          content_block: {
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: {},
          },
        })
      );
      if (tc.arguments) {
        frames.push(
          formatAnthropicSSE('content_block_delta', {
            type: 'content_block_delta',
            index: blockIdx,
            delta: { type: 'input_json_delta', partial_json: tc.arguments },
          })
        );
      }
      frames.push(
        formatAnthropicSSE('content_block_stop', {
          type: 'content_block_stop',
          index: blockIdx,
        })
      );
      blockIdx += 1;
    }
  }

  const stopReason =
    resp.toolCalls && resp.toolCalls.length > 0
      ? 'tool_use'
      : resp.finishReason === 'length'
        ? 'max_tokens'
        : 'end_turn';

  frames.push(
    formatAnthropicSSE('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: resp.usage.outputTokens },
    })
  );
  frames.push(formatAnthropicSSE('message_stop', { type: 'message_stop' }));

  return frames;
}

/**
 * Translates an OpenAI Responses API request (/v1/responses) used by Codex CLI
 * into our canonical chat completion request, preserving multi-turn function_call
 * and function_call_output history while safely ignoring reasoning blocks.
 */
export function codexResponsesToCanonical(
  body: Record<string, unknown>,
  defaultModel = 'GLM-5.2'
): CanonicalChatRequest {
  const model =
    typeof body.model === 'string' && body.model.trim() ? body.model.trim() : defaultModel;
  const messages: CanonicalMessage[] = [];

  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions.trim() });
  }

  let pendingAssistantToolCalls: CanonicalToolCall[] = [];
  const flushPendingToolCalls = () => {
    if (pendingAssistantToolCalls.length === 0) return;
    const prev = messages[messages.length - 1];
    if (prev && prev.role === 'assistant') {
      prev.toolCalls = [...(prev.toolCalls || []), ...pendingAssistantToolCalls];
    } else {
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: pendingAssistantToolCalls,
      });
    }
    pendingAssistantToolCalls = [];
  };

  if (typeof body.input === 'string' && body.input.trim()) {
    messages.push({ role: 'user', content: body.input.trim() });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (typeof item === 'string') {
        flushPendingToolCalls();
        messages.push({ role: 'user', content: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;

      // Safely skip reasoning items on cross-provider resume
      if (entry.type === 'reasoning') {
        continue;
      }

      if (entry.type === 'function_call' && typeof entry.name === 'string') {
        pendingAssistantToolCalls.push({
          id:
            typeof entry.call_id === 'string'
              ? entry.call_id
              : typeof entry.id === 'string'
                ? entry.id
                : `call_${pendingAssistantToolCalls.length}`,
          name: entry.name,
          arguments:
            typeof entry.arguments === 'string'
              ? entry.arguments
              : JSON.stringify(entry.arguments ?? {}),
        });
        continue;
      }

      flushPendingToolCalls();

      if (entry.type === 'function_call_output' && typeof entry.call_id === 'string') {
        messages.push({
          role: 'tool',
          toolCallId: entry.call_id,
          content: stringifyToolResultContent(entry.output),
        });
        continue;
      }

      const rawRole = typeof entry.role === 'string' ? entry.role : 'user';
      const role: CanonicalMessage['role'] =
        rawRole === 'system' || rawRole === 'developer'
          ? 'system'
          : rawRole === 'assistant'
            ? 'assistant'
            : 'user';
      const content = extractTextFromContent(entry.content ?? entry.text);
      if (content) {
        messages.push({ role, content });
      }
    }
    flushPendingToolCalls();
  }

  const tools: CanonicalToolDef[] = [];
  if (Array.isArray(body.tools)) {
    for (const rawTool of body.tools) {
      if (!rawTool || typeof rawTool !== 'object') continue;
      const t = rawTool as Record<string, unknown>;
      if (t.type === 'function' && typeof t.name === 'string') {
        tools.push({
          type: 'function',
          function: {
            name: t.name,
            ...(typeof t.description === 'string' ? { description: t.description } : {}),
            parameters:
              t.parameters && typeof t.parameters === 'object'
                ? (t.parameters as Record<string, unknown>)
                : { type: 'object', properties: {} },
          },
        });
      }
    }
  }

  return {
    model,
    messages,
    maxTokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    stream: Boolean(body.stream),
    tools,
    toolsCount: tools.length,
  };
}

/**
 * Translates a canonical response back to OpenAI Responses API format (/v1/responses).
 */
export function canonicalToCodexResponse(resp: CanonicalChatResponse): Record<string, unknown> {
  const output: Array<Record<string, unknown>> = [];

  if (resp.content || !resp.toolCalls?.length) {
    output.push({
      id: `msg_${resp.id}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: resp.content,
          annotations: [],
        },
      ],
    });
  }

  if (resp.toolCalls && resp.toolCalls.length > 0) {
    for (const tc of resp.toolCalls) {
      output.push({
        id: `fc_${tc.id}`,
        type: 'function_call',
        status: 'completed',
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      });
    }
  }

  return {
    id: `resp_${resp.id}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: resp.model,
    output,
    output_text: resp.content,
    usage: {
      input_tokens: resp.usage.inputTokens,
      output_tokens: resp.usage.outputTokens,
      total_tokens: resp.usage.inputTokens + resp.usage.outputTokens,
    },
  };
}

/**
 * Emits a compliant sequence of OpenAI Responses API SSE frames for Codex CLI,
 * supporting both text output and function_call tool invocations.
 */
export function canonicalToCodexSSEFrames(resp: CanonicalChatResponse): string[] {
  const frames: string[] = [];
  const respId = `resp_${resp.id}`;
  const createdAt = Math.floor(Date.now() / 1000);

  const push = (event: string, data: Record<string, unknown>) => {
    frames.push(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  };

  push('response.created', {
    response: {
      id: respId,
      object: 'response',
      created_at: createdAt,
      status: 'in_progress',
      model: resp.model,
      output: [],
    },
  });

  let outputIndex = 0;

  if (resp.content || !resp.toolCalls?.length) {
    const itemId = `msg_${resp.id}`;
    push('response.output_item.added', {
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    push('response.content_part.added', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    if (resp.content) {
      push('response.output_text.delta', {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        delta: resp.content,
      });
    }
    push('response.output_text.done', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text: resp.content,
    });
    push('response.content_part.done', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: resp.content, annotations: [] },
    });
    push('response.output_item.done', {
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: resp.content, annotations: [] }],
      },
    });
    outputIndex += 1;
  }

  if (resp.toolCalls && resp.toolCalls.length > 0) {
    for (const tc of resp.toolCalls) {
      const fcId = `fc_${tc.id}`;
      push('response.output_item.added', {
        output_index: outputIndex,
        item: {
          id: fcId,
          type: 'function_call',
          status: 'in_progress',
          call_id: tc.id,
          name: tc.name,
          arguments: '',
        },
      });
      if (tc.arguments) {
        push('response.function_call_arguments.delta', {
          item_id: fcId,
          output_index: outputIndex,
          delta: tc.arguments,
        });
      }
      push('response.function_call_arguments.done', {
        item_id: fcId,
        output_index: outputIndex,
        arguments: tc.arguments,
      });
      push('response.output_item.done', {
        output_index: outputIndex,
        item: {
          id: fcId,
          type: 'function_call',
          status: 'completed',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        },
      });
      outputIndex += 1;
    }
  }

  push('response.completed', {
    response: canonicalToCodexResponse(resp),
  });

  return frames;
}

/**
 * Translates an OpenAI Chat Completions request (/v1/chat/completions) used by DSH & OpenAI clients.
 */
export function openAIChatToCanonical(
  body: Record<string, unknown>,
  defaultModel = 'GLM-5.2'
): CanonicalChatRequest {
  const model =
    typeof body.model === 'string' && body.model.trim() ? body.model.trim() : defaultModel;
  const messages: CanonicalMessage[] = [];

  if (Array.isArray(body.messages)) {
    for (const item of body.messages) {
      if (!item || typeof item !== 'object') continue;
      const msg = item as Record<string, unknown>;
      const rawRole = typeof msg.role === 'string' ? msg.role : 'user';
      const role: CanonicalMessage['role'] =
        rawRole === 'system' || rawRole === 'assistant' || rawRole === 'tool' ? rawRole : 'user';
      const content = extractTextFromContent(msg.content);
      const toolCalls: CanonicalToolCall[] = [];
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          const rec = tc as Record<string, unknown>;
          const fn = rec.function as Record<string, unknown> | undefined;
          if (fn && typeof fn.name === 'string') {
            toolCalls.push({
              id: typeof rec.id === 'string' ? rec.id : `call_${toolCalls.length}`,
              name: fn.name,
              arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
            });
          }
        }
      }
      if (content || toolCalls.length > 0 || role === 'tool') {
        messages.push({
          role,
          content,
          ...(typeof msg.tool_call_id === 'string' ? { toolCallId: msg.tool_call_id } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
      }
    }
  }

  let tools: CanonicalToolDef[] = [];
  if (Array.isArray(body.tools)) {
    for (const rawTool of body.tools) {
      if (!rawTool || typeof rawTool !== 'object') continue;
      const t = rawTool as Record<string, unknown>;
      const fn = t.function as Record<string, unknown> | undefined;
      if (fn && typeof fn.name === 'string') {
        tools.push({
          type: 'function',
          function: {
            name: fn.name,
            ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
            parameters:
              fn.parameters && typeof fn.parameters === 'object'
                ? (fn.parameters as Record<string, unknown>)
                : { type: 'object', properties: {} },
          },
        });
      }
    }
  }

  let toolChoice: unknown = undefined;
  if (typeof body.tool_choice === 'string') {
    toolChoice = body.tool_choice;
  } else if (body.tool_choice && typeof body.tool_choice === 'object') {
    const tc = body.tool_choice as Record<string, unknown>;
    const fn = tc.function as Record<string, unknown> | undefined;
    if (fn && typeof fn.name === 'string') {
      const matched = tools.filter((t) => t.function.name === fn.name);
      if (matched.length > 0) {
        tools = matched;
        toolChoice = 'required';
      }
    }
  }

  return {
    model,
    messages,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    stream: Boolean(body.stream),
    tools,
    toolChoice,
    toolsCount: tools.length,
  };
}

export function canonicalToOpenAIChatResponse(resp: CanonicalChatResponse): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: resp.content || (resp.toolCalls?.length ? null : ''),
  };
  if (resp.toolCalls && resp.toolCalls.length > 0) {
    message.tool_calls = resp.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));
  }

  return {
    id: `chatcmpl-${resp.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: resp.toolCalls?.length ? 'tool_calls' : resp.finishReason,
      },
    ],
    usage: {
      prompt_tokens: resp.usage.inputTokens,
      completion_tokens: resp.usage.outputTokens,
      total_tokens: resp.usage.inputTokens + resp.usage.outputTokens,
    },
  };
}

/**
 * Selects the best eligible healthy account for routing a model request.
 * Respects enabled flag, cooldown window, concurrency cap (max 3), and balances by fewest active requests & failures.
 */
export function selectRoutingAccount(
  accounts: RoutableAccount[],
  nowMs = Date.now()
): RoutableAccount | null {
  const eligible = accounts.filter(
    (acc) =>
      acc.enabled &&
      acc.status === 'ok' &&
      acc.activeRequests < acc.maxConcurrent &&
      (!acc.cooldownUntil || acc.cooldownUntil <= nowMs)
  );

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    if (a.activeRequests !== b.activeRequests) return a.activeRequests - b.activeRequests;
    if (a.failures !== b.failures) return a.failures - b.failures;
    return a.id.localeCompare(b.id);
  });

  return eligible[0];
}

