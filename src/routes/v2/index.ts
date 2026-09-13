import express from 'express';
import { principalAuthMiddleware, requirePrincipal } from '../../auth-principal.js';
import { attachmentsV2Router } from './attachments.js';
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
v2Router.use('/tasks', tasksV2Router);
v2Router.use('/attachments', attachmentsV2Router);
