export interface PolicyRequest {
  requestId: string;
  toolName: string;
  command?: string;
  args?: unknown;
}

export type PolicyDecision = { allow: true };
