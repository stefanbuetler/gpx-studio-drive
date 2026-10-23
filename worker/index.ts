import { handleRoutingService } from './routing-service';
import { handlePOIs } from './pois';
import { handleShareLinks, type ShareEnv } from './share-links';
import { handleDriveSession, type SessionEnv } from './drive-session';

interface Env extends SessionEnv, ShareEnv {
    ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
    fetch(request: Request, env: Env) {
        const path = new URL(request.url).pathname;
        if (path.startsWith('/__gpx_services/')) return handleRoutingService(request);
        if (path === '/api/pois') return handlePOIs(request);
        if (path === '/api/share' || path.startsWith('/s/')) return handleShareLinks(request, env);
        if (path.startsWith('/api/drive/')) return handleDriveSession(request, env);
        return env.ASSETS.fetch(request);
    },
};
