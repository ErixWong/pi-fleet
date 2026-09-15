import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  hasScopes,
  requirePrincipal,
  type PrincipalContext,
} from '../auth-principal.js';
import type { Scope } from '../service/identity.js';

export type ToolResult = CallToolResult;

export class ScopeDenied extends Error {
  readonly scope: string;

  constructor(scope: string) {
    super('not found');
    this.name = 'ScopeDenied';
    this.scope = scope;
  }
}

export function mcpPrincipal(): PrincipalContext {
  return requirePrincipal();
}

export function toolOk(payload: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function toolErr(message: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message }, null, 2),
      },
    ],
    isError: true,
  };
}

export function guardScope(...scopes: Scope[]): void {
  mcpPrincipal();
  if (scopes.length === 0 || !hasScopes(...scopes)) {
    throw new ScopeDenied(scopes[0] ?? 'unknown');
  }
}

export function toolFailure(error: unknown): ToolResult {
  if (error instanceof ScopeDenied) return toolErr('not found');
  if (error instanceof Error) return toolErr(error.message);
  return toolErr(String(error));
}
