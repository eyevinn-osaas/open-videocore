// Authentication middleware.
//
// Extracts the OSC access token from the Authorization header, resolves it to a
// workspace id, and attaches that id to the request. Any route protected by
// this hook is guaranteed a non-empty `request.workspaceId`. Requests without a
// valid token are rejected with 401 before the handler runs.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthError, resolveWorkspaceId } from './workspace.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Set by the auth preHandler. Present on every authenticated route.
    workspaceId: string;
  }
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers['authorization'];
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

// Register `request.workspaceId` (default undefined) and an `authenticate`
// preHandler that all workspace-scoped routes attach. Call once at app setup.
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('workspaceId', '');

  app.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const token = extractToken(request);
      try {
        request.workspaceId = await resolveWorkspaceId(token);
      } catch (err) {
        if (err instanceof AuthError) {
          request.log.warn({ reason: err.message }, 'authentication rejected');
          await reply
            .code(401)
            .header('WWW-Authenticate', 'Bearer')
            .send({ error: 'unauthorized', message: err.message });
          return;
        }
        throw err;
      }
    }
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
