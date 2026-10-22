import { base } from '$app/paths';
import { languages } from '$lib/languages';
import { getURLForLanguage } from '$lib/utils';

const appOrigin = new URL(import.meta.env.PUBLIC_APP_URL || 'http://localhost:5173').origin;
/** @param {unknown} value */
const escape = (value) =>
    String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');

export async function handle({ event, resolve }) {
    const language = event.params.language ?? 'en';
    const strings = await import(`./locales/${language}.json`);
    const path = event.url.pathname;
    const page = event.route.id?.replace('/[[language]]', '').split('/')[1] || 'home';
    let title =
        page === 'share'
            ? 'Shared route'
            : strings.metadata[`${page}_title`] || strings.metadata.home_title;
    const description = strings.metadata.description;
    if (page === 'help' && event.params.guide) {
        const [guide, subguide] = event.params.guide.split('/');
        const guideModule = subguide
            ? await import(`./lib/docs/${language}/${guide}/${subguide}.mdx`)
            : await import(`./lib/docs/${language}/${guide}.mdx`);
        title = `${title} | ${guideModule.metadata.title}`;
    }
    const fullTitle = `trail-explorer — ${title}`;
    const pageURL = `${appOrigin}${path}`;
    const imageURL = `${appOrigin}${base}/og_logo.png`;
    const schema = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'trail-explorer',
        url: appOrigin,
    }).replaceAll('<', '\\u003c');
    let headTag = `<head>
    <title>${escape(fullTitle)}</title>
    <script type="application/ld+json">${schema}</script>
    <meta name="application-name" content="trail-explorer" />
    <meta name="apple-mobile-web-app-title" content="trail-explorer" />
    <meta name="description" content="${escape(description)}" />
    <meta property="og:title" content="${escape(fullTitle)}" />
    <meta property="og:description" content="${escape(description)}" />
    <meta property="og:image" content="${escape(imageURL)}" />
    <meta property="og:url" content="${escape(pageURL)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="trail-explorer" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escape(fullTitle)}" />
    <meta name="twitter:description" content="${escape(description)}" />
    <meta name="twitter:image" content="${escape(imageURL)}" />
    <meta name="twitter:url" content="${escape(pageURL)}" />
    <link rel="alternate" hreflang="x-default" href="${escape(appOrigin + getURLForLanguage('en', path))}" />
    <link rel="manifest" href="/${language}.manifest.webmanifest" />`;
    if (page !== '404') {
        for (const lang of Object.keys(languages)) {
            headTag += `<link rel="alternate" hreflang="${lang}" href="${escape(appOrigin + getURLForLanguage(lang, path))}" />`;
        }
    }
    return resolve(event, {
        transformPageChunk: ({ html }) =>
            html
                .replace('<html>', `<html lang="${language}" translate="no">`)
                .replace('<head>', headTag),
    });
}
