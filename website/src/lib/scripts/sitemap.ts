import fs from 'fs';
import { loadEnv } from 'vite';
const appOrigin = new URL(
    process.env.PUBLIC_APP_URL ||
        loadEnv('', process.cwd(), 'PUBLIC_').PUBLIC_APP_URL ||
        'http://localhost:5173'
).origin;
import { glob } from 'glob';
import { languages } from '$lib/languages';

function getURLForLanguage(lang: string, path: string): string {
    return `${appOrigin}${lang === 'en' ? '' : `/${lang}`}${path}`;
}

function generateSitemap() {
    const pages = glob.sync('**/*.html', { cwd: 'build' }).map((page) => `/${page}`);

    let sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n';
    sitemap +=
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';

    pages.forEach((page) => {
        const path = page.replace('/index.html', '').replace('.html', '');

        const rootDir = path.split('/')[1];
        if (
            path.includes('embed') ||
            path.includes('404') ||
            languages[path] ||
            languages[rootDir]
        ) {
            // Skip localized pages
            return;
        }

        Object.keys(languages).forEach((language) => {
            sitemap += `<url>\n`;
            sitemap += `  <loc>${getURLForLanguage(language, path)}</loc>\n`;

            Object.keys(languages).forEach((alternate) => {
                if (alternate === language) return;

                sitemap += `  <xhtml:link rel="alternate" hreflang="${alternate}" href="${getURLForLanguage(alternate, path)}" />\n`;
            });

            sitemap += `</url>\n`;
        });
    });

    sitemap += '</urlset>';

    return sitemap;
}

fs.writeFileSync('build/sitemap.xml', generateSitemap());
fs.writeFileSync(
    'build/robots.txt',
    fs
        .readFileSync('static/robots.txt', 'utf8')
        .replace(/Sitemap: .*/, `Sitemap: ${appOrigin}/sitemap.xml`)
);
