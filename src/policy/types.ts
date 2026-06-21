export interface PolicyRequest {
  requestId: string;
  toolName: string;
  fixedCommand: string;
  argumentsKeys: string[];
}

export type PolicyDecision =
  | { allow: true }
  | { allow: false; reason: string };
