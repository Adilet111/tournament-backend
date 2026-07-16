/**
 * Canonical list of Kazakhstan cities selectable for a tournament.
 *
 * Covers the administrative centre of every region (oblast) plus the three
 * cities of republican significance (Astana, Almaty, Shymkent). Tournaments
 * store the `slug`; the frontend renders `en` or `ru` by the user's locale.
 *
 * `slug` is the stable identifier — never rename one; add new entries instead.
 */
export interface City {
  slug: string;
  en: string;
  ru: string;
}

export const CITIES: readonly City[] = [
  // Cities of republican significance.
  { slug: 'astana', en: 'Astana', ru: 'Астана' },
  { slug: 'almaty', en: 'Almaty', ru: 'Алматы' },
  { slug: 'shymkent', en: 'Shymkent', ru: 'Шымкент' },
  // Regional (oblast) administrative centres, alphabetical by English name.
  { slug: 'aktau', en: 'Aktau', ru: 'Актау' },
  { slug: 'aktobe', en: 'Aktobe', ru: 'Актобе' },
  { slug: 'atyrau', en: 'Atyrau', ru: 'Атырау' },
  { slug: 'karaganda', en: 'Karaganda', ru: 'Караганда' },
  { slug: 'kokshetau', en: 'Kokshetau', ru: 'Кокшетау' },
  { slug: 'konaev', en: 'Konaev', ru: 'Конаев' },
  { slug: 'kostanay', en: 'Kostanay', ru: 'Костанай' },
  { slug: 'kyzylorda', en: 'Kyzylorda', ru: 'Кызылорда' },
  { slug: 'oral', en: 'Oral', ru: 'Уральск' },
  { slug: 'oskemen', en: 'Oskemen', ru: 'Усть-Каменогорск' },
  { slug: 'pavlodar', en: 'Pavlodar', ru: 'Павлодар' },
  { slug: 'petropavl', en: 'Petropavl', ru: 'Петропавловск' },
  { slug: 'semey', en: 'Semey', ru: 'Семей' },
  { slug: 'taldykorgan', en: 'Taldykorgan', ru: 'Талдыкорган' },
  { slug: 'taraz', en: 'Taraz', ru: 'Тараз' },
  { slug: 'turkistan', en: 'Turkistan', ru: 'Туркестан' },
  { slug: 'zhezkazgan', en: 'Zhezkazgan', ru: 'Жезказган' },
];

/** Slug set for O(1) validation of an incoming city value. */
export const CITY_SLUGS = new Set(CITIES.map((c) => c.slug));

export function isValidCitySlug(slug: string): boolean {
  return CITY_SLUGS.has(slug);
}
