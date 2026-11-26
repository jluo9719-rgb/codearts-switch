import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToCanonical,
  canonicalMessagesToOpenAIWire,
  canonicalToAnthropicResponse,
  canonicalToAnthropicSSEFrames,
  canonicalToCodexResponse,
  canonicalToCodexSSEFrames,
  codexResponsesToCanonical,
  selectRoutingAccount,
  type RoutableAccount,
} from './protocolAdapter';

test('anthropicToCanonical strips thinking/redacted_thinking blocks for cross-provider /resume', () => {
  const req = anthropicToCanonical({
    model: 'GLM-5.2',
    system: [{ type: 'text', text: 'You are a coding assistant.' }],
    messages: [
      { role: 'user', content: 'Explain this file.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal chain of thought', signature: 'sig-123' },
          { type: 'redacted_thinking', data: 'opaque-blob' },
          { type: 'text', text: 'Let me inspect package.json first.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'package.json' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"name":"demo"}' },
          { type: 'text', content: 'Now summarize.' },
        ],
      },
    ],
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    ],
    tool_choice: { type: 'tool', name: 'Read' },
  });

  assert.equal(req.messages.length, 4);
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[2].role, 'assistant');
  assert.equal(req.messages[2].content, 'Let me inspect package.json first.');
  assert.equal(req.messages[2].toolCalls?.length, 1);
  assert.equal(req.messages[2].toolCalls?.[0].name, 'Read');
  assert.equal(req.messages[3].role, 'tool');
  assert.equal(req.messages[3].toolCallId, 'toolu_1');
  assert.equal(req.toolChoice, 'required');
  assert.equal(req.tools.length, 1);

  const wire = canonicalMessagesToOpenAIWire(req.messages);
  assert.equal((wire[2].tool_calls as Array<unknown>).length, 1);
});

test('codexResponsesToCanonical preserves multi-turn function_call and function_call_output history', () => {
  const req = codexResponsesToCanonical({
    model: 'GLM-5.2',
    instructions: 'Follow repo conventions.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Run tests' }] },
      { type: 'reasoning', id: 'rs_1', summary: [] },
      {
        type: 'function_call',
        call_id: 'call_abc',
        name: 'shell',
        arguments: '{"command":["npm","test"]}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_abc',
        output: 'all 7 tests passed',
      },
      { role: 'user', content: 'Great, now commit.' },
    ],
    tools: [
      {
        type: 'function',
        name: 'shell',
        description: 'Execute shell command',
        parameters: { type: 'object', properties: { command: { type: 'array' } } },
      },
    ],
    stream: true,
  });

  assert.equal(req.messages.length, 5);
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[1].role, 'user');
  assert.equal(req.messages[2].role, 'assistant');
  assert.equal(req.messages[2].toolCalls?.[0].id, 'call_abc');
  assert.equal(req.messages[2].toolCalls?.[0].name, 'shell');
  assert.equal(req.messages[3].role, 'tool');
  assert.equal(req.messages[3].toolCallId, 'call_abc');
  assert.equal(req.messages[4].role, 'user');
  assert.equal(req.tools.length, 1);
});

test('canonicalToCodexSSEFrames emits full Responses API events for text and function_call tools', () => {
  const frames = canonicalToCodexSSEFrames({
    id: 'test1',
    model: 'GLM-5.2',
    content: 'Running shell check',
    toolCalls: [
      {
        id: 'call_99',
        name: 'shell',
        arguments: '{"cmd":"git status"}',
      },
    ],
    finishReason: 'tool_calls',
    usage: { inputTokens: 120, outputTokens: 35 },
  });

  const joined = frames.join('');
  assert.match(joined, /event: response\.created/);
  assert.match(joined, /event: response\.output_text\.delta/);
  assert.match(joined, /event: response\.function_call_arguments\.delta/);
  assert.match(joined, /event: response\.function_call_arguments\.done/);
  assert.match(joined, /event: response\.output_item\.done/);
  assert.match(joined, /event: response\.completed/);
  assert.match(joined, /"call_id":"call_99"/);

  const nonStream = canonicalToCodexResponse({
    id: 'test1',
    model: 'GLM-5.2',
    content: 'ok',
    toolCalls: [{ id: 'call_99', name: 'shell', arguments: '{}' }],
    finishReason: 'tool_calls',
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  assert.equal((nonStream.output as Array<unknown>).length, 2);
});

test('canonicalToAnthropicSSEFrames never forges thinking signature blocks', () => {
  const frames = canonicalToAnthropicSSEFrames({
    id: 'm1',
    model: 'GLM-5.2',
    content: 'Done.',
    finishReason: 'stop',
    usage: { inputTokens: 20, outputTokens: 4 },
  });
  const joined = frames.join('');
  assert.match(joined, /event: message_start/);
  assert.match(joined, /event: content_block_delta/);
  assert.match(joined, /event: message_stop/);
  assert.equal(joined.includes('"signature"'), false);

  const jsonResp = canonicalToAnthropicResponse({
    id: 'm1',
    model: 'GLM-5.2',
    content: 'Done.',
    finishReason: 'stop',
    usage: { inputTokens: 20, outputTokens: 4 },
  });
  assert.equal(jsonResp.stop_reason, 'end_turn');
});

test('selectRoutingAccount respects enabled, cooldown, concurrency cap, and load balancing', () => {
  const now = 1_700_000_000_000;
  const accounts: RoutableAccount[] = [
    {
      id: 'acc-disabled',
      name: 'Disabled',
      enabled: false,
      status: 'ok',
      failures: 0,
      activeRequests: 0,
      maxConcurrent: 3,
    },
    {
      id: 'acc-cooling',
      name: 'Cooling',
      enabled: true,
      status: 'ok',
      failures: 0,
      activeRequests: 0,
      maxConcurrent: 3,
      cooldownUntil: now + 60_000,
    },
    {
      id: 'acc-full',
      name: 'Full',
      enabled: true,
      status: 'ok',
      failures: 0,
      activeRequests: 3,
      maxConcurrent: 3,
    },
    {
      id: 'acc-busy',
      name: 'Busy',
      enabled: true,
      status: 'ok',
      failures: 0,
      activeRequests: 2,
      maxConcurrent: 3,
    },
    {
      id: 'acc-idle',
      name: 'Idle',
      enabled: true,
      status: 'ok',
      failures: 0,
      activeRequests: 0,
      maxConcurrent: 3,
    },
  ];

  const picked = selectRoutingAccount(accounts, now);
  assert.equal(picked?.id, 'acc-idle');
});
