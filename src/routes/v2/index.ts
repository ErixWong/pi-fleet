import express, { type NextFunction, type Request, type Response } from 'express';
import { principalAuthMiddleware, requirePrincipal } from '../../auth-principal.js';
import { AppError } from '../../util/errors.js';
import { attachmentsV2Router } from './attachments.js';
import { authV2Router } from './auth.js';
import { channelsV2Router } from './channels.js';
import { eventsV2Router } from './events.js';
import { hostsV2Router } from './hosts.js';
import { identitiesV2Router } from './identities.js';
import { postsV2Router } from './posts.js';
import { tasksV2Router } from './tasks.js';

export const v2Router = express.Router();

v2Router.use(express.json());

v2Router.get('/whoami', principalAuthMiddleware(), (_req, res) => {
  const context = requirePrincipal();
  res.json({
    principal: {
      id: context.principal.id,
      kind: context.principal.kind,
      name: context.principal.name,
      account_id: context.account_id,
    },
    scopes: context.scopes,
    key_id: context.key_id,
  });
});

v2Router.use('/posts', postsV2Router);
v2Router.use('/channels', channelsV2Router);
v2Router.use('/tasks', tasksV2Router);
v2Router.use('/attachments', attachmentsV2Router);
v2Router.use('/events', eventsV2Router);
v2Router.use('/hosts', hostsV2Router);
v2Router.use('/keys', identitiesV2Router);
v2Router.use(authV2Router);

v2Router.use((
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  console.error('[v2 error]', err);
  if (res.headersSent) return;
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: '内部错误' });
});
