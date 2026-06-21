import type { PolicyDecision, PolicyRequest } from './types.js';

export function checkToolCall(request: PolicyRequest): PolicyDecision {
  if (request.toolName !== 'run_date') {
    return { allow: false, reason: `tool not allowed: ${request.toolName}` };
  }

  if (request.fixedCommand !== 'date') {
    return { allow: false, reason: `command not allowed: ${request.fixedCommand}` };
  }

  if (request.argumentsKeys.length > 0) {
    return { allow: false, reason: `run_date accepts no arguments: ${request.argumentsKeys.join(',')}` };
  }

  return { allow: true };
}
