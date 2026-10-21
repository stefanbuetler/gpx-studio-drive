// Fail preview builds early if the public Google OAuth client ID is missing.
// Do not print the credential or token. This runs only during website builds.
const value = process.env.PUBLIC_GOOGLE_CLIENT_ID?.trim();
if (!value) {
    console.error('GPX Studio Drive: PUBLIC_GOOGLE_CLIENT_ID is MISSING from the BUILD environment.');
    console.error('Set it under Workers & Pages → gpx-studio-drive → Settings → Builds → Previews Base → Variables and secrets.');
    throw new Error('Missing preview build variable PUBLIC_GOOGLE_CLIENT_ID');
}
if (!/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(value)) {
    console.error('GPX Studio Drive: PUBLIC_GOOGLE_CLIENT_ID has an invalid format. Verify the complete OAuth Web Client ID.');
    throw new Error('Invalid PUBLIC_GOOGLE_CLIENT_ID format');
}
console.log('GPX Studio Drive: Google OAuth client ID is present in the build environment (value hidden).');
