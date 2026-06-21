import { describe, expect, it } from 'vitest';

import { checkToolCall } from '../src/policy/policy.js';

describe('policy', () => {
  it('allows only run_date with fixed date and no args', () => {
    expect(
      checkToolCall({ requestId: 'test', toolName: 'run_date', fixedCommand: 'date', argumentsKeys: [] })
    ).toEqual({ allow: true });
  });

  it('denies unknown tools', () => {
    expect(
      checkToolCall({ requestId: 'test', toolName: 'run_command', fixedCommand: 'date', argumentsKeys: [] })
    ).toEqual({ allow: false, reason: 'tool not allowed: run_command' });
  });

  it('denies extra arguments', () => {
    const decision = checkToolCall({
      requestId: 'test',
      toolName: 'run_date',
      fixedCommand: 'date',
      argumentsKeys: ['command']
    });
    expect(decision.allow).toBe(false);
  });
});
