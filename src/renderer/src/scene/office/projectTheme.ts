/**
 * The Projects floor as a ThemeConfig (ADR 0002): the generated map and rooms,
 * on the office tilesets, monitors, palette and cast, so the scene renders it
 * through the same path as the hand-made floors.
 */
import { OFFICE_THEME, type ThemeConfig } from './themeRegistry';
import type { ProjectFloor } from './roomLayout';

export function projectsTheme(floor: ProjectFloor): ThemeConfig {
  return {
    ...OFFICE_THEME,
    id: 'projects',
    mapRaw: JSON.stringify(floor.map),
    primarySeatNames: floor.seatNames,
    cafeSeatNames: floor.cafeSeatNames,
    cafeStands: floor.cafeStands,
    coffee: { ...floor.coffee, maxCups: OFFICE_THEME.coffee.maxCups },
    anchors: floor.anchors,
    // Errand props (plants, windows, fridge) are part of the hand-drawn office
    // art; the generated rooms have none yet, so idle agents skip errands.
    errandSpots: [],
    rooms: floor.rooms
  };
}
