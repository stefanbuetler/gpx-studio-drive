import { handleDriveSession, type SessionEnv } from './drive-session';

interface Env extends SessionEnv {
    ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
    fetch(request: Request, env: Env) {
        if (new URL(request.url).pathname.startsWith('/api/drive/'))
            return handleDriveSession(request, env);
        return env.ASSETS.fetch(request);
    },
};
