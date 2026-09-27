import {
  mdiAnimationPlayOutline,
  mdiApps,
  mdiBookOpenVariantOutline,
  mdiDownloadOutline,
  mdiEarth,
  mdiFolderOutline,
  mdiGamepadVariantOutline,
  mdiMovieOpenOutline,
  mdiMusicNoteOutline,
  mdiSoccer,
  mdiStarOutline,
  mdiTeddyBear,
  mdiTelevisionClassic,
} from '@mdi/js';
import type { CategoryIcon } from '../shared/types.js';

export * from '@mdi/js';

export const categoryIcons: Record<CategoryIcon, string> = {
  movie: mdiMovieOpenOutline,
  tv: mdiTelevisionClassic,
  anime: mdiAnimationPlayOutline,
  kids: mdiTeddyBear,
  documentary: mdiEarth,
  music: mdiMusicNoteOutline,
  book: mdiBookOpenVariantOutline,
  game: mdiGamepadVariantOutline,
  app: mdiApps,
  sport: mdiSoccer,
  star: mdiStarOutline,
  download: mdiDownloadOutline,
  folder: mdiFolderOutline,
};

export const categoryIcon = (icon: CategoryIcon | null | undefined): string =>
  (icon && categoryIcons[icon]) || mdiFolderOutline;
