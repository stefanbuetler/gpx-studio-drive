import { languages } from '$lib/languages';
import type { EntryGenerator } from './$types';

export const entries: EntryGenerator = () =>
    Object.keys(languages).map((language) => ({ language: language === 'en' ? '' : language }));
