import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const website = fileURLToPath(new URL('../../../', import.meta.url));
const lock = JSON.parse(readFileSync(resolve(website, 'package-lock.json'), 'utf8'));
const notices = [
    'Third-party software notices for trail-explorer',
    'Includes installed build tools as well as application dependencies. Each package retains its own license.',
    'Original gpx.studio license: /LICENSE.txt',
];
for (const [path, metadata] of Object.entries(lock.packages) as [
    string,
    { license?: string; version?: string },
][]) {
    if (!path.startsWith('node_modules/')) continue;
    const directory = resolve(website, path);
    if (!existsSync(directory)) continue; // Optional binaries for other platforms are not distributed.
    const files = readdirSync(directory, { withFileTypes: true })
        .filter((file) => file.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/i.test(file.name))
        .map((file) => file.name);
    notices.push(
        `\n${'='.repeat(72)}\n${path.replace(/^node_modules\//, '')} ${metadata.version || ''}\nDeclared license: ${metadata.license || 'See package source'}\n`
    );
    for (const file of files)
        notices.push(`${file}\n${readFileSync(resolve(directory, file), 'utf8')}`);
    if (!files.length)
        notices.push('See the distributed package and its upstream source for license terms.');
}
writeFileSync(resolve(website, 'static/THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'));
// Serve the original license unchanged with the static website too.
writeFileSync(resolve(website, 'static/LICENSE.txt'), readFileSync(resolve(website, '../LICENSE')));
