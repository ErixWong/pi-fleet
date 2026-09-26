import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import {
  getPool,
  hasScope,
  touchDevice,
  verifyApiKey,
  type Principal,
  type Scope,
} from './service/identity.js';

export { getPool };

export interface PrincipalContext {
  principal: Principal;
  scopes: Scope[];
  key_id: string;
  account_id: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    // multer 等流式中间件的 done 回调可能丢失 AsyncLocalStorage 上下文，
    // auth 中间件把 principal 同时挂在 req 上作为兜底。
    principal?: PrincipalContext;
  }
}

export const principalContext = new AsyncLocalStorage<PrincipalContext>();

export function currentPrincipal(): PrincipalContext | null {
  return principalContext.getStore() ?? null;
}

export function requirePrincipal(req?: { principal?: PrincipalContext }): PrincipalContext {
  const context = req?.principal ?? currentPrincipal();
  if (!context) {
    const error = new Error('principal authentication required');
    Object.assign(error, { status: 401 });
    throw error;
  }
  return context;
}

export function principalAuthMiddleware(): RequestHandler {
  return (req, res, next) => {
    const authorization = req.get('authorization');
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      res.status(401).json({ error: 'missing bearer token' });
      return;
    }

    const token = match[1];
    void (async () => {
      const verified = await verifyApiKey(token);
      if (!verified) {
        res.status(401).json({ error: 'invalid or revoked key' });
        return;
      }

      const context: PrincipalContext = {
        principal: verified.principal,
        scopes: verified.scopes,
        key_id: verified.key_id,
        account_id: verified.principal.account_id,
      };
      if (context.principal.kind === 'host') {
        try {
          await touchDevice(context.principal.id);
        } catch {
          // 心跳更新不是鉴权条件；设备记录异常不能阻塞已认证请求。
        }
      }
      principalContext.run(context, () => {
        req.principal = context;
        next();
      });
    })().catch(next);
  };
}

export function requireScope(...required: Scope[]): RequestHandler {
  return (_req, res, next) => {
    const context = currentPrincipal();
    if (!context || !hasScope(context.scopes, required)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  };
}

export function hasScopes(...required: Scope[]): boolean {
  const context = currentPrincipal();
  return Boolean(context && hasScope(context.scopes, required));
}
