import { describe, expect, it } from 'vitest';
import { ChatDecisionProvider, parseChoice } from '../../../src/decision/provider';

const OPTIONS = ['light', 'heavy'] as const;

describe('parseChoice', () => {
  it('reads a bare JSON object', () => {
    expect(parseChoice('{"choice":"light","confidence":0.9}', OPTIONS)).toEqual({
      choice: 'light',
      confidence: 0.9,
    });
  });

  it('unwraps a fenced code block', () => {
    expect(parseChoice('```json\n{"choice":"heavy","confidence":0.8}\n```', OPTIONS)).toEqual({
      choice: 'heavy',
      confidence: 0.8,
    });
  });

  it('ignores chatter around the object', () => {
    const reply = 'Sure! Here is my answer:\n{"choice":"light","confidence":0.75}\nHope that helps.';
    expect(parseChoice(reply, OPTIONS)?.choice).toBe('light');
  });

  it('accepts an answer that echoes the option and its hint', () => {
    // Observed against this deployment's gateway: several models copy the
    // whole `- light — small edits` line back as the answer. Throwing that
    // away would make routing abstain on almost every call.
    expect(parseChoice('{"choice":"light — small edits","confidence":0.95}', OPTIONS)?.choice).toBe(
      'light',
    );
    expect(parseChoice('{"choice":"heavy: big work","confidence":1}', OPTIONS)?.choice).toBe(
      'heavy',
    );
    expect(parseChoice('{"choice":"heavy (multi-file)","confidence":1}', OPTIONS)?.choice).toBe(
      'heavy',
    );
  });

  it('picks the most specific option when labels nest as prefixes', () => {
    const nested = ['light', 'light-plus'];
    expect(parseChoice('{"choice":"light-plus","confidence":1}', nested)?.choice).toBe('light-plus');
    expect(parseChoice('{"choice":"light-plus and more","confidence":1}', nested)?.choice).toBe(
      'light-plus',
    );
    expect(parseChoice('{"choice":"light","confidence":1}', nested)?.choice).toBe('light');
  });

  it('matches an option case- and whitespace-insensitively', () => {
    expect(parseChoice('{"choice":" HEAVY ","confidence":1}', OPTIONS)?.choice).toBe('heavy');
  });

  it('rejects an answer outside the closed set', () => {
    // The whole point of a closed set: an invented label is a failed call,
    // not a decision we try to interpret.
    expect(parseChoice('{"choice":"medium","confidence":0.99}', OPTIONS)).toBeNull();
  });

  it('defaults a missing or malformed confidence to zero', () => {
    expect(parseChoice('{"choice":"light"}', OPTIONS)?.confidence).toBe(0);
    expect(parseChoice('{"choice":"light","confidence":"high"}', OPTIONS)?.confidence).toBe(0);
    expect(parseChoice('{"choice":"light","confidence":null}', OPTIONS)?.confidence).toBe(0);
  });

  it('clamps a confidence outside [0,1]', () => {
    expect(parseChoice('{"choice":"light","confidence":1.7}', OPTIONS)?.confidence).toBe(1);
    expect(parseChoice('{"choice":"light","confidence":-3}', OPTIONS)?.confidence).toBe(0);
  });

  it('returns null for replies with no usable object', () => {
    expect(parseChoice('', OPTIONS)).toBeNull();
    expect(parseChoice('I cannot decide.', OPTIONS)).toBeNull();
    expect(parseChoice('{not json}', OPTIONS)).toBeNull();
    expect(parseChoice('"light"', OPTIONS)).toBeNull();
    expect(parseChoice('{"choice":42}', OPTIONS)).toBeNull();
  });
});

describe('ChatDecisionProvider', () => {
  function providerWith(fetchImpl: typeof fetch, timeoutMs = 50) {
    return new ChatDecisionProvider({
      baseUrl: 'https://gw.example/',
      apiKey: 'sk-test',
      model: 'fast-model',
      timeoutMs,
      fetchImpl,
    });
  }

  it('returns the parsed choice on a 200', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (url, init) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"choice":"heavy","confidence":0.7}' } }] }),
        { status: 200 },
      );
    };

    const result = await providerWith(fetchImpl).choose({
      instruction: 'Pick a tier.',
      input: 'refactor the auth module',
      options: [...OPTIONS],
      optionHints: { light: 'small edits', heavy: 'big work' },
    });

    expect(result).toEqual({ choice: 'heavy', confidence: 0.7 });
    expect(seenUrl).toBe('https://gw.example/v1/chat/completions');
    expect(seenBody['model']).toBe('fast-model');
    // Determinism: the same input must route the same way twice.
    expect(seenBody['temperature']).toBe(0);
    // 256 rather than a token-tight budget: at 64, a deliberating model can
    // spend the whole budget before it emits the JSON, which parses as "no
    // answer" — on the guard that is a missed leak, not a missed decision.
    expect(seenBody['max_tokens']).toBe(256);

    const messages = seenBody['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('Pick a tier.');
    // Every option, and nothing but the options, must reach the model.
    expect(messages[0]?.content).toContain('- light — small edits');
    expect(messages[0]?.content).toContain('- heavy — big work');
    expect(messages[1]).toEqual({ role: 'user', content: 'refactor the auth module' });
  });

  it('abstains on a non-200 response', async () => {
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 500 });
    await expect(
      providerWith(fetchImpl).choose({ instruction: 'i', input: 'x', options: [...OPTIONS] }),
    ).resolves.toBeNull();
  });

  it('abstains when the body has no message content', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 });
    await expect(
      providerWith(fetchImpl).choose({ instruction: 'i', input: 'x', options: [...OPTIONS] }),
    ).resolves.toBeNull();
  });

  it('abstains on a network error instead of throwing', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(
      providerWith(fetchImpl).choose({ instruction: 'i', input: 'x', options: [...OPTIONS] }),
    ).resolves.toBeNull();
  });

  it('abstains on timeout instead of hanging the run', async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(
      providerWith(hanging, 10).choose({ instruction: 'i', input: 'x', options: [...OPTIONS] }),
    ).resolves.toBeNull();
  });
});
