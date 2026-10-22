// Short links store public route/view settings only, never Google credentials.
export interface ShareDatabase {
    prepare(sql: string): {
        bind(...values: unknown[]): {
            run(): Promise<unknown>;
            first<T>(): Promise<T | null>;
        };
    };
}
export interface ShareEnv {
    SHARE_LINKS?: ShareDatabase;
    GOOGLE_CLIENT_ID?: string;
}
type PublicRoute = { id: string; resourceKey?: string; view: Record<string, unknown> };
const CLIENT_ID = '1029721603429-0h1hv3datbk3guc18kq8ta2od0gevqi4.apps.googleusercontent.com';
const ID = /^[a-zA-Z0-9_-]{1,200}$/;
const CODE = /^[a-zA-Z0-9_-]{16}$/;
const VIEW_KEYS = new Set([
    'basemap',
    'overlays',
    'overpassQueries',
    'opacities',
    'customLayers',
    'terrainSource',
    'defaultWidth',
    'defaultOpacity',
    'pitch',
    'bearing',
    'distanceMarkers',
    'directionMarkers',
    'distanceUnits',
    'velocityUnits',
    'temperatureUnits',
    'theme',
    'elevation',
]);
function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}
function parseRoute(value: unknown): PublicRoute {
    const input = value as Partial<PublicRoute> | null;
    if (
        !input ||
        typeof input.id !== 'string' ||
        !ID.test(input.id) ||
        (input.resourceKey !== undefined &&
            (typeof input.resourceKey !== 'string' || !ID.test(input.resourceKey))) ||
        !input.view ||
        typeof input.view !== 'object' ||
        Array.isArray(input.view)
    )
        throw new Error('Invalid route settings.');
    const view = Object.fromEntries(
        Object.entries(input.view).filter(([key]) => VIEW_KEYS.has(key))
    );
    return { id: input.id, ...(input.resourceKey ? { resourceKey: input.resourceKey } : {}), view };
}
export function routeTarget(origin: string, route: PublicRoute, embed: boolean) {
    const target = new URL(embed ? '/embed' : '/share', origin);
    if (embed) {
        target.searchParams.set(
            'options',
            JSON.stringify({
                ...route.view,
                files: [],
                ids: [route.id],
                ...(route.resourceKey ? { resourceKeys: { [route.id]: route.resourceKey } } : {}),
            })
        );
        target.searchParams.set('fit', 'route');
    } else {
        target.searchParams.set('id', route.id);
        if (route.resourceKey) target.searchParams.set('resourcekey', route.resourceKey);
        target.searchParams.set('view', JSON.stringify(route.view));
    }
    return target.href;
}
async function boundedBody(request: Request) {
    if (Number(request.headers.get('Content-Length')) > 65536)
        throw new Error('Settings too large.');
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Missing settings.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) {
                await reader.cancel();
                throw new Error('Settings too large.');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
}
export async function handleShareLinks(
    request: Request,
    env: ShareEnv,
    fetcher: typeof fetch = fetch
): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/s/')) {
        if (!['GET', 'HEAD'].includes(request.method))
            return json({ error: 'Method not allowed.' }, 405);
        const code = url.pathname.slice(3);
        if (!CODE.test(code)) return json({ error: 'Link not found.' }, 404);
        if (!env.SHARE_LINKS) return json({ error: 'Short links are unavailable.' }, 503);
        try {
            const row = await env.SHARE_LINKS.prepare(
                'SELECT route FROM share_links WHERE code = ? AND origin = ?'
            )
                .bind(code, url.origin)
                .first<{ route: string }>();
            if (!row) return json({ error: 'Link not found.' }, 404);
            const route = parseRoute(JSON.parse(row.route));
            return new Response(null, {
                status: 302,
                headers: {
                    Location: routeTarget(url.origin, route, url.searchParams.get('embed') === '1'),
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer',
                },
            });
        } catch {
            return json({ error: 'Could not open this link. Try again.' }, 503);
        }
    }
    const origin = request.headers.get('Origin');
    const allowed = origin === url.origin || origin === 'http://localhost:5173';
    const cors = (response: Response) => {
        if (origin && allowed) response.headers.set('Access-Control-Allow-Origin', origin);
        response.headers.set('Vary', 'Origin');
        return response;
    };
    if (!allowed) return json({ error: 'Origin not allowed.' }, 403);
    if (request.method === 'OPTIONS')
        return cors(
            new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Methods': 'POST',
                    'Access-Control-Allow-Headers':
                        'Authorization, Content-Type, X-GPX-Share-Request',
                    'Access-Control-Max-Age': '600',
                },
            })
        );
    if (request.method !== 'POST') return cors(json({ error: 'Method not allowed.' }, 405));
    if (
        request.headers.get('X-GPX-Share-Request') !== '1' ||
        !request.headers.get('Content-Type')?.startsWith('application/json')
    )
        return cors(json({ error: 'Invalid request.' }, 400));
    const token = request.headers.get('Authorization')?.match(/^Bearer ([^\s]{1,4096})$/)?.[1];
    if (!token) return cors(json({ error: 'Sign in to GDrive first.' }, 401));
    if (!env.SHARE_LINKS)
        return cors(json({ error: 'Short link storage is not configured.' }, 503));
    let route: PublicRoute;
    try {
        route = parseRoute(await boundedBody(request));
    } catch {
        return cors(json({ error: 'Invalid or oversized route settings.' }, 400));
    }
    try {
        const infoResponse = await fetcher(
            `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
            { signal: AbortSignal.timeout(10000) }
        );
        if (!infoResponse.ok)
            return cors(json({ error: 'GDrive session expired. Sign in again.' }, 401));
        const info = (await infoResponse.json()) as { aud?: string; scope?: string };
        if (
            info.aud !== (env.GOOGLE_CLIENT_ID || CLIENT_ID) ||
            !info.scope?.split(' ').includes('https://www.googleapis.com/auth/drive.file')
        )
            return cors(json({ error: 'This GDrive session cannot create share links.' }, 403));
        const headers = new Headers({ Authorization: `Bearer ${token}` });
        if (route.resourceKey)
            headers.set('X-Goog-Drive-Resource-Keys', `${route.id}/${route.resourceKey}`);
        const params = new URLSearchParams({
            fields: 'id,trashed,isAppAuthorized,appProperties,permissions(type,role)',
            supportsAllDrives: 'true',
        });
        const response = await fetcher(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(route.id)}?${params}`,
            { headers, signal: AbortSignal.timeout(10000) }
        );
        if (!response.ok)
            return cors(json({ error: 'Could not verify the shared GDrive file.' }, 403));
        const file = (await response.json()) as {
            trashed?: boolean;
            isAppAuthorized?: boolean;
            appProperties?: Record<string, string>;
            permissions?: { type: string; role: string }[];
        };
        if (
            file.trashed ||
            !file.isAppAuthorized ||
            file.appProperties?.trailExplorerRoute !== '1' ||
            !file.permissions?.some(
                (p) => p.type === 'anyone' && ['reader', 'writer', 'commenter'].includes(p.role)
            )
        )
            return cors(
                json({ error: 'Make the saved route public before creating a short link.' }, 403)
            );
        const bytes = crypto.getRandomValues(new Uint8Array(12));
        const code = btoa(String.fromCharCode(...bytes))
            .replaceAll('+', '-')
            .replaceAll('/', '_');
        await env.SHARE_LINKS.prepare(
            'INSERT INTO share_links (code, origin, route, created_at) VALUES (?, ?, ?, ?)'
        )
            .bind(code, url.origin, JSON.stringify(route), Date.now())
            .run();
        return cors(json({ url: `${url.origin}/s/${code}` }, 201));
    } catch {
        return cors(
            json(
                {
                    error: 'Could not create the short link. Your route is still public; try again.',
                },
                502
            )
        );
    }
}
