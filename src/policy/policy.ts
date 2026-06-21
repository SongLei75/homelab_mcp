import type { PolicyDecision, PolicyRequest } from './types.js';

export function checkToolCall(request: PolicyRequest): PolicyDecision {
  return { allow: true };
}
