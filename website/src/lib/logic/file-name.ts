import type { GPXFile } from 'gpx';

// Existing GPX exports can contain the default file name in any supported locale.
// These are the menu.new_file labels from src/locales, independent of UI language.
const defaultFileNames = new Set(
    [
        'Стварыць новы файл',
        'Nou fitxer',
        'Nový soubor',
        'New file',
        'Neue Datei',
        'Nuevo archivo',
        'Fitxategi berria',
        'Uusi tiedosto',
        'Nouveau fichier',
        'קובץ חדש',
        'Új fájl',
        'Berkas baru',
        'Nuovo file',
        '새 파일',
        'Naujas failas',
        'Nieuw bestand',
        'Ny fil',
        'Nowy plik',
        'Novo arquivo',
        'Fișier nou',
        'Новый файл',
        'Nova datoteka',
        'Ny fil',
        'Yeni dosya',
        'Новий файл',
        'Tạo tệp tin mới',
        '新增檔案',
        '新建文件',
    ].map((name) => name.toLocaleLowerCase())
);

function cleanName(value: unknown): string | undefined {
    return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function meaningful(name: string | undefined): name is string {
    return !!name && !defaultFileNames.has(name.replace(/\s+\d+$/u, '').toLocaleLowerCase());
}

export function getGPXName(
    file: Pick<GPXFile, 'metadata' | 'trk'>,
    filename?: string
): string | undefined {
    const metadataName = cleanName(file.metadata?.name);
    if (meaningful(metadataName)) return metadataName;

    // GPX routes are converted to tracks by the parser, preserving their names.
    const trackNames = file.trk.map((track) => cleanName(track.name));
    const trackName = trackNames.find(meaningful);
    if (trackName) return trackName;

    const sourceName = cleanName(filename?.replace(/\.gpx$/i, ''));
    if (meaningful(sourceName)) return sourceName;
    return metadataName ?? trackNames.find(Boolean) ?? sourceName;
}
