import { locationMap } from './specs/location.mjs';
import { aiMaskPaste } from "./specs/ai-mask-paste.mjs";
import { colorRange } from './specs/color-range.mjs';
import { colorProfiles } from "./specs/color-profiles.mjs";
import { maskFold } from './specs/mask-fold.mjs';
import { overlayOvershoot } from './specs/overlay-overshoot.mjs';
import { maskHiddenEdit } from './specs/mask-hidden-edit.mjs';
import { maskMenu } from './specs/mask-menu.mjs';
import { maskInvertRange } from './specs/mask-invert-range.mjs';
import { negativeProfileMemory } from './specs/negative-profile-memory.mjs';
import { agxPresets } from './specs/agx-presets.mjs';
// SPDX-License-Identifier: GPL-3.0-or-later
import { startup, exposure, splash } from './specs/smoke.mjs';
import { sliderInput, sliderClick, history, rail, sliders, panelScroll, leftScroll } from './specs/controls.mjs';
import { moduleOptions, preferencesHelp } from './specs/preferences.mjs';
import { batchPaste } from './specs/batch-paste.mjs';
import { guiBenchmark } from './specs/benchmark.mjs';
import { cases } from './suites.mjs';
import { cropGuides,cropLocked,cropPortrait,cropOptions,cropAutoStraighten,cropUndo,beforeAfterIdle } from './specs/crop.mjs';
import { rangeContract,choiceContract } from './specs/ranges.mjs';
import * as workflows from './specs/workflows.mjs';
import * as dialogs from './specs/dialogs.mjs';
import * as regressions from './specs/regressions.mjs';
import { moduleOutput,moduleSwitch,panorama,immichWorkflow } from './specs/modules.mjs';
import { siteShots } from './specs/site.mjs';
import { zoomReady, fitDetail, zoomBelowFit } from './specs/zoom.mjs';
import { demo } from './specs/demo.mjs';
import { overlayOpacity } from './specs/overlay.mjs';
import { shiftRange } from './specs/shift-range.mjs';
import { lensProfile, lensPick, demosaicMethod } from './specs/lens.mjs';
import { themes, workspaceLayout } from './specs/themes.mjs';
import { engineRestart } from './specs/engine-restart.mjs';
import { saveFailure } from './specs/save-failure.mjs';
import { supportBundle } from './specs/support-bundle.mjs';
import { menus, menusGuards, menusViewMode } from './specs/menus.mjs';
import * as release0450 from './specs/release-0450.mjs';
import { hostileText } from './specs/hostile-text.mjs';
import { settingsStore } from './specs/settings-store.mjs';
import { editingMode } from './specs/editing-mode.mjs';
import { advancedExposure } from './specs/advanced-exposure.mjs';
import { advancedInstances } from './specs/advanced-instances.mjs';
import { advancedMaskCards } from './specs/advanced-mask-cards.mjs';
import { advancedPresets } from './specs/advanced-presets.mjs';
import { advancedTonemapper } from './specs/advanced-tonemapper.mjs';
import { tonemapperLdr, tonemapperRawGuard } from './specs/tonemapper-guard.mjs';
import { advancedGroups } from './specs/advanced-groups.mjs';
import { advancedModuleOrder } from './specs/advanced-module-order.mjs';
import { advancedSearch } from './specs/advanced-search.mjs';
import { advancedHidden } from './specs/advanced-hidden.mjs';
import { advancedSync } from './specs/advanced-sync.mjs';
import { advancedEditors } from './specs/advanced-editors.mjs';
import { advancedColorCards } from './specs/advanced-color-cards.mjs';
import { advancedChecker } from './specs/advanced-checker.mjs';
import { advancedCurveCards } from './specs/advanced-curve-cards.mjs';
import { advancedRawCards } from './specs/advanced-raw-cards.mjs';
import { advancedFileCards } from './specs/advanced-file-cards.mjs';
import { colorzonesCurves } from './specs/colorzones-curves.mjs';
import { healFill } from './specs/heal-fill.mjs';
import { healRangeHover, maskRangeHover } from './specs/range-hover.mjs';
import { panelPeek } from './specs/panel-peek.mjs';
import { eyeOrder } from './specs/eye-order.mjs';
import { gridZoom } from './specs/grid-zoom.mjs';
import { largeFolder } from './specs/large-folder.mjs';
import { movePhotos, moveCopy } from './specs/move-photos.mjs';
import { moveFolders } from './specs/move-folders.mjs';
import { moveCompanions, moveSubfolders, moveMenuItems } from './specs/move-options.mjs';
import { exportSubfolders } from './specs/export-subfolders.mjs';
import { exportNumberFields } from './specs/export-number-fields.mjs';
import { renamePhotos } from './specs/rename-photos.mjs';
import { unmountedShare } from './specs/unmounted-share.mjs';
import { folderMenu } from './specs/folder-menu.mjs';
import { libraryMenuRate } from './specs/library-menu-rate.mjs';
import { immichPrefs } from './specs/immich-prefs.mjs';
import { morfphotoPrefs } from './specs/morfphoto-prefs.mjs';
import { morfphotoMirror } from './specs/morfphoto-mirror.mjs';
import { detailGroup } from './specs/detail-group.mjs';
import { recentKeywords } from './specs/recent-keywords.mjs';
import { gridCulling, gridCullingControls, gridCullingPriority, virtualCopyKeywords } from './specs/grid-culling.mjs';
import { editedCullingPreview } from './specs/edited-culling-preview.mjs';
import { openFailureRecovery } from './specs/open-failure.mjs';
import { photoFilter } from './specs/photo-filter.mjs';
import { startupRestore } from './specs/startup-restore.mjs';
import { dngThumbnail } from './specs/dng-thumbnail.mjs';
import { libraryWorkers } from './specs/library-workers.mjs';
import { localSearch } from './specs/local-search.mjs';
import { newPhotoDefaults } from './specs/new-photo-defaults.mjs';
import { findLive, findNoClip, findPanelMemory, findSizes, findSaved, savedFiltersSidebar } from './specs/find.mjs';
import { wheelUndo } from './specs/wheel-undo.mjs';
import { historyPaint } from './specs/history-paint.mjs';

const implementations = { "ai-mask-paste": aiMaskPaste, 'color-range': colorRange, 'batch-paste': batchPaste, startup, splash, exposure, 'slider-input': sliderInput, 'slider-click': sliderClick, history, rail, sliders, 'module-options': moduleOptions, 'module-switch': moduleSwitch,
  'panel-scroll': panelScroll,
  'left-scroll': leftScroll,
  'history-paint': historyPaint,
  'panel-peek': panelPeek,
  'eye-order': eyeOrder,
  'grid-zoom': gridZoom,
  'large-folder': largeFolder,
  'recent-keywords': recentKeywords,
  'grid-culling': gridCulling,
  'grid-culling-controls': gridCullingControls,
  'grid-culling-priority': gridCullingPriority,
  'virtual-copy-keywords': virtualCopyKeywords,
  'edited-culling-preview': editedCullingPreview,
  'open-failure-recovery': openFailureRecovery,
  'photo-filter': photoFilter,
  'startup-restore': startupRestore,
  'dng-thumbnail': dngThumbnail,
  'library-workers': libraryWorkers,
  'local-search': localSearch,
  'new-photo-defaults': newPhotoDefaults,
  'find-live': findLive,
  'find-no-clip': findNoClip,
  'find-sizes': findSizes,
  'find-panel-memory': findPanelMemory,
  'find-saved': findSaved,
  'saved-filters-sidebar': savedFiltersSidebar,
  'wheel-undo': wheelUndo,
  'move-photos': movePhotos,
  'move-folders': moveFolders,
  'rename-photos': renamePhotos,
  'unmounted-share': unmountedShare,
  'move-copy': moveCopy,
  'move-companions': moveCompanions,
  'move-subfolders': moveSubfolders,
  'move-menu-items': moveMenuItems,
  'export-subfolders': exportSubfolders,
  'export-number-fields': exportNumberFields,
  'folder-menu': folderMenu,
  'library-menu-rate': libraryMenuRate,
  'immich-prefs': immichPrefs,
  'morfphoto-prefs': morfphotoPrefs,
  'morfphoto-mirror': morfphotoMirror,
  'detail-group': detailGroup,
  'agx-presets': agxPresets,
  'color-profiles': colorProfiles,
  'mask-fold': maskFold,
  'mask-hidden-edit': maskHiddenEdit,
  'mask-menu': maskMenu,
  'overlay-overshoot': overlayOvershoot,
  'mask-invert-range': maskInvertRange,
  'negative-profile-memory': negativeProfileMemory,
  'gui-benchmark': guiBenchmark,
  'gui-benchmark-screen': t => guiBenchmark(t, true),
  'gui-benchmark-whole': t => guiBenchmark(t, false),
  'crop-guides':cropGuides,'crop-locked':cropLocked,'crop-portrait':cropPortrait,'crop-options':cropOptions,'crop-auto-straighten':cropAutoStraighten,'crop-undo':cropUndo,'before-after-idle':beforeAfterIdle,'zoom-ready':zoomReady,'fit-detail':fitDetail,'zoom-below-fit':zoomBelowFit,
  'native-reset':workflows.nativeReset,curves:workflows.curves,wheels:workflows.wheels,equalizer:workflows.equalizer,
  'saturation-curve':workflows.saturationCurve,
  masks:workflows.masks,heal:workflows.heal,negative:workflows.negative,film:workflows.film,zones:workflows.zones,print:workflows.print,
  'preferences-matrix':dialogs.preferencesMatrix,'slider-wheel':dialogs.sliderWheel,'export-options':dialogs.exportOptions,
  filters:dialogs.filters,presets:dialogs.presets,shortcuts:dialogs.shortcuts,
  'histogram-endpoints':regressions.histogramEndpoints,'preview-alignment':regressions.previewAlignment,
  'loupe-grid':regressions.loupeGrid,'mask-loupe':regressions.maskLoupe,'grain-hover':regressions.grainHover,'presets-hover-release':regressions.presetsHoverRelease,'detail-without-loupe':regressions.detailWithoutLoupe,'detail-fit-drag':regressions.detailFitDrag,'camera-body':regressions.cameraBody,
  'rejected-deletion':regressions.rejectedDeletion,'folder-race':regressions.folderRace,panorama,'immich-workflow':immichWorkflow,
  'overlay-opacity':overlayOpacity,'shift-range':shiftRange,'lens-profile':lensProfile,'lens-pick':lensPick,'demosaic':demosaicMethod,
  'site-shots':siteShots,
  demo,
  themes,
  'workspace-layout': workspaceLayout,
  'preferences-help': preferencesHelp,
  'location-map': locationMap,
  menus,
  'engine-restart': engineRestart,
  'save-failure': saveFailure,
  'support-bundle': supportBundle,
  'menus-guards': menusGuards,
  'menus-view-mode': menusViewMode,
  'hostile-text': hostileText,
  'settings-store': settingsStore,
  'space-pan': release0450.spacePanTools,
  'heal-show-spots': release0450.healShowSpots,
  'jpeg-preset': release0450.jpegPreset,
  'brush-dot': release0450.brushDot,
  'editing-mode': editingMode,
  'advanced-exposure': advancedExposure,
  'advanced-instances': advancedInstances,
  'advanced-module-order': advancedModuleOrder,
  'advanced-mask-cards': advancedMaskCards,
  'advanced-presets': advancedPresets,
  'advanced-tonemapper': advancedTonemapper,
  'tonemapper-ldr': tonemapperLdr,
  'tonemapper-raw-guard': tonemapperRawGuard,
  'advanced-groups': advancedGroups,
  'advanced-search': advancedSearch,
  'advanced-hidden': advancedHidden,
  'advanced-sync': advancedSync,
  'advanced-editors': advancedEditors,
  'advanced-color-cards': advancedColorCards,
  'advanced-checker': advancedChecker,
  'advanced-curve-cards': advancedCurveCards,
  'advanced-raw-cards': advancedRawCards,
  'advanced-file-cards': advancedFileCards,
  'colorzones-curves': colorzonesCurves,
  'heal-fill': healFill,
  'mask-range-hover': maskRangeHover,
  'heal-range-hover': healRangeHover,
};
for(const [name,definition] of Object.entries(cases)) if(definition.kind)
  implementations[name] = t => ({range:rangeContract,choice:choiceContract,module:moduleOutput}[definition.kind])(t,definition);

export function implementationFor(name) {
  if (!Object.hasOwn(implementations,name)) throw Error(`Missing GUI implementation: ${name}`);
  return implementations[name];
}
