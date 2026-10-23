import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { Plugin } from 'vite';
import { handleDriveSession, type SessionEnv } from '../worker/drive-session';

// Run the same session handler on localhost without exposing server secrets to
// import.meta.env or requiring a second development server.
export function driveSessionDevPlugin(): Plugin {
    return {
        name: 'local-drive-session',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                if (!req.url?.startsWith('/api/drive/')) return next();
                try {
                    let vars: Record<string, string | undefined> = {};
                    try {
                        vars = parseEnv(
                            readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
                        );
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    }
                    const env: SessionEnv = {
                        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? vars.GOOGLE_CLIENT_ID,
                        GOOGLE_CLIENT_SECRET:
                            process.env.GOOGLE_CLIENT_SECRET ?? vars.GOOGLE_CLIENT_SECRET,
                        DRIVE_SESSION_SECRET:
                            process.env.DRIVE_SESSION_SECRET ?? vars.DRIVE_SESSION_SECRET,
                        DRIVE_ALLOWED_ORIGINS:
                            process.env.DRIVE_ALLOWED_ORIGINS ??
                            vars.DRIVE_ALLOWED_ORIGINS ??
                            'http://localhost:5173',
                    };
                    const headers = new Headers();
                    for (const [name, value] of Object.entries(req.headers)) {
                        if (value !== undefined)
                            headers.set(name, Array.isArray(value) ? value.join(', ') : value);
                    }
                    const chunks: Buffer[] = [];
                    let size = 0;
                    for await (const chunk of req) {
                        size += chunk.length;
                        if (size > 8192) {
                            res.statusCode = 413;
                            res.end();
                            return;
                        }
                        chunks.push(Buffer.from(chunk));
                    }
                    const request = new Request(`http://${req.headers.host}${req.url}`, {
                        method: req.method,
                        headers,
                        ...(!['GET', 'HEAD'].includes(req.method ?? 'GET')
                            ? { body: Buffer.concat(chunks) }
                            : {}),
                    });
                    const response = await handleDriveSession(request, env);
                    res.statusCode = response.status;
                    response.headers.forEach((value, name) => res.setHeader(name, value));
                    res.end(await response.text());
                } catch {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Cache-Control', 'no-store');
                    res.end(
                        JSON.stringify({ error: 'Local Google session service is unavailable.' })
                    );
                }
            });
        },
    };
}
