import { describe, expect, it } from 'vitest';

import { checkToolCall } from '../src/policy/policy.js';

describe('policy', () => {
  it('allows arbitrary tool metadata for audit only', () => {
    expect(checkToolCall({ requestId: 'test', toolName: 'run_command', command: 'printf hi', args: {} })).toEqual({
      allow: true
    });
  });
});
