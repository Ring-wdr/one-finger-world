---
version: alpha
name: One Finger Act
description: Production UI design system for a melancholic one-finger dark fantasy action RPG.
colors:
  primary: "#E6C76A"
  primarySoft: "#F4E4A2"
  secondary: "#9FB4BF"
  stoneBlue: "#24343B"
  skyMist: "#B8CAD2"
  surface: "#101617"
  surfacePanel: "#172022"
  surfaceScrim: "#080D0E"
  textPrimary: "#F7F1DF"
  textMuted: "#BAC8C5"
  borderSubtle: "#526165"
  focusRing: "#F4D982"
  error: "#F2A6A6"
typography:
  title:
    fontFamily: Inter
    fontSize: 72px
    fontWeight: 900
    lineHeight: 0.9
    letterSpacing: 0px
  titleMobile:
    fontFamily: Inter
    fontSize: 44px
    fontWeight: 900
    lineHeight: 0.92
    letterSpacing: 0px
  panelTitle:
    fontFamily: Inter
    fontSize: 22px
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: 0px
  body:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
  label:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0px
  caption:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0px
rounded:
  none: 0px
  sm: 4px
  md: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  screenPadding: 24px
components:
  buttonPrimary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 48px
    padding: 16px
  buttonSecondary:
    backgroundColor: "{colors.surfaceScrim}"
    textColor: "{colors.textPrimary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 44px
    padding: 16px
  buttonSecondaryMuted:
    backgroundColor: "{colors.surfaceScrim}"
    textColor: "{colors.secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 44px
    padding: 16px
  titleText:
    textColor: "{colors.textPrimary}"
    typography: "{typography.title}"
  titleTextMobile:
    textColor: "{colors.textPrimary}"
    typography: "{typography.titleMobile}"
  panelTitle:
    textColor: "{colors.textPrimary}"
    typography: "{typography.panelTitle}"
  mutedText:
    textColor: "{colors.textMuted}"
    typography: "{typography.caption}"
  settingsPanel:
    backgroundColor: "{colors.surfacePanel}"
    textColor: "{colors.textPrimary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
  menuFallback:
    backgroundColor: "{colors.stoneBlue}"
    textColor: "{colors.textPrimary}"
  cloudLayer:
    backgroundColor: "{colors.skyMist}"
  goldGlint:
    backgroundColor: "{colors.primarySoft}"
  borderHairline:
    backgroundColor: "{colors.borderSubtle}"
  focusIndicator:
    backgroundColor: "{colors.focusRing}"
  runtimeError:
    backgroundColor: "{colors.surfaceScrim}"
    textColor: "{colors.error}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
---

# One Finger Act Design System

## Overview

One Finger Act should feel like a finished dark fantasy game, not a development sandbox. The UI is quiet, restrained, and readable over a melancholic key visual. It supports short mobile chapter sessions while preserving the story tone of a ruined sacred kingdom and one narrow line of hope.

The first screen is a full-screen title image: cold blue-gray sky, ruined stone architecture, mist, and one warm golden beam. Interface elements sit above that image with minimal chrome. Avoid instructional marketing copy, prototype labels, decorative panels, and anything that turns the menu into a tools page.

## Colors

The palette is dominated by cold blue-gray stone and deep near-black surfaces. Warm gold is reserved for the most important action and for the story's single hopeful accent.

- **Primary Gold (#E6C76A):** Use for the main action only, such as `게임 시작`, active presets, and focus highlights.
- **Primary Soft (#F4E4A2):** Use sparingly for glints, focus rings, and small hover accents.
- **Secondary Mist (#9FB4BF):** Use for quiet secondary text and low-emphasis interface details.
- **Stone Blue (#24343B):** Use for fallback backgrounds, dark overlays, and world-facing UI surfaces.
- **Sky Mist (#B8CAD2):** Use only in background art or very soft atmospheric UI accents.
- **Surface (#101617):** Base near-black for app backgrounds and scrims.
- **Surface Panel (#172022):** Settings panels and contained utility surfaces.
- **Text Primary (#F7F1DF):** Main text on dark backgrounds.
- **Text Muted (#BAC8C5):** Secondary labels, values, and helper text.
- **Error (#F2A6A6):** Runtime error text and destructive warnings only.

Do not introduce strong red, strong green, purple, hot pink, bright cyan, or modern neon accents. Gold must stay narrow and intentional.

## Typography

Use Inter for the current web implementation. The title uses a heavy weight to read clearly over a painterly background. Utility labels are compact and direct. Letter spacing stays at `0px`; hierarchy comes from size, weight, color, and spacing.

- **Title:** Heavy, large, and centered. Use only for the main game title.
- **Panel Title:** Strong but compact. Use for settings and future modal headings.
- **Body:** Plain, readable UI copy.
- **Label:** Buttons, slider labels, and preset controls.
- **Caption:** Test pad details, secondary values, and low-emphasis metadata.

## Layout

Screens are full-viewport and respect safe areas. The title screen stacks vertically: background, title, empty breathing space, `게임 시작`, `환경설정`, then bottom breathing space. Keep the first viewport focused on starting or configuring the game.

Use an 8px spacing rhythm with 4px available only for small internal adjustments. Buttons, controls, counters, and test pads need stable dimensions so text changes do not shift the layout. On mobile, settings appear as a bottom sheet; on desktop, settings appear as a centered dialog.

## Elevation & Depth

Depth comes from atmospheric art, scrims, blur, and tonal separation rather than heavy drop shadows. The title screen background may have a soft dark overlay behind UI text. Settings panels may use a subtle shadow and backdrop blur, but the panel should still feel like a functional game surface.

Do not stack cards inside cards. Do not frame the entire title experience in a card. Reserve contained panels for settings, dialogs, and repeated item groups.

## Shapes

Use restrained rectangular shapes with `8px` maximum radius for main controls and panels. Small controls may use `4px`. Avoid pill-shaped buttons unless a platform convention specifically requires them.

Buttons should feel precise and tactile. Panels should feel architectural and stable, not soft or playful.

## Components

**Primary Button:** Gold background, dark text, 48px minimum height, 8px radius. Use once per screen for the clearest action.

**Secondary Button:** Transparent or dark scrim background, light text, subtle border, 44px minimum height, 8px radius. Use for `환경설정`, reset actions, and quiet navigation.

**Settings Panel:** Dark blue-black panel with readable light text. It contains preset buttons, sliders, reset, and the input test pad. On mobile, it anchors to the bottom with internal scrolling. On desktop, it centers with a max width suitable for slider labels.

**Preset Controls:** Three equal-width buttons. Active state uses Primary Gold. Inactive state stays dark and quiet.

**Sliders:** Use Primary Gold for the active track/thumb. Labels and numeric values must be visible without relying on hover.

**Test Pad:** Use a dashed or subtle bordered dark surface. It must not look like a primary action button.

**Cloud Motion:** Clouds are decorative background layers only. Move left to right slowly and stop for `prefers-reduced-motion: reduce`.

## Do's and Don'ts

- Do keep `One Finger Act` as the main title text.
- Do let the background key visual carry the production feel.
- Do keep the main menu to title, start, and settings.
- Do move input threshold controls into the settings panel.
- Do preserve keyboard access for buttons, sliders, and dialog close.
- Do stop decorative motion when reduced motion is requested.
- Don't show `Svelte + Three.js Prototype` or other development labels.
- Don't expose settings as a permanent panel on the first screen.
- Don't add a `/settings` route for this menu pass.
- Don't put text, logos, or watermarks inside generated background art.
- Don't use strong red, green, purple, hot pink, or neon color families.
- Don't make nested cards or card-framed page sections.
