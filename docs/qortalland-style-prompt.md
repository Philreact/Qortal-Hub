# QortalLand Style Prompt v1.0

## Purpose

This document defines the visual language for reusable QortalLand assets. It complements the QortalLand Asset Standard by describing how assets should look rather than how they are organized or loaded.

All AI-generated QortalLand assets should follow this specification so rooms built at different times still feel like they belong to the same game.

Use this document together with `docs/qortalland-asset-standard.md`.

## Compatibility With Current QortalLand

This style direction is compatible with the current QortalLand implementation:

- QortalLand currently uses a front-facing 2.5D perspective.
- Rooms are rectangular and full-screen, not isometric diamond maps.
- Current movement and scaling assume a floor plane with gentle depth, not true 3D.
- Current characters stand on the floor plane and scale by Y position.
- The development PNG loader supports transparent PNG source assets.
- Future atlases can preserve this same visual language.

Important nuance:

- Reusable props should not include room-specific floors or large external cast shadows.
- Small object-local occlusion or contact detail is acceptable when it is part of the object and helps readability.
- Room-level lighting, floor shadows, and ambient effects should usually be handled by the room layout/rendering layer, not baked into every prop.

## Camera And Perspective

All reusable assets must share one fixed QortalLand asset camera. This is now a hard style requirement, not a loose suggestion.

Use:

- Front-facing 2.5D room layout.
- Shallow overhead view, not top-down.
- Camera approximately 15 degrees downward from eye level.
- Equivalent camera framing: about 75 degrees from vertical/top-down.
- Only a modest amount of top surface should be visible.
- Front faces should remain visually dominant.
- Rectangular rooms that fill the viewport.
- Furniture viewed from the same fixed shallow overhead angle as `FUR_001 / bar_counter_long.png`.
- Furniture that feels anchored to the same floor plane as `FUR_001 / bar_counter_long.png`.
- Floors that recede gently into the distance.
- Walls that remain mostly vertical.
- Objects that reveal only a small amount of top surface where appropriate, such as tables, bars, sofas, counters, and arcade machines.
- Characters and props that feel anchored to the same floor plane.

For assets meant to sit on top of another asset:

- Use an even shallower top view than floor furniture.
- The object should visually lie on the supporting surface.
- Bar-compatible assets, such as `TEC_002 / dj_booth.png`, must appear flat enough to rest naturally on the `FUR_001 / bar_counter_long.png` countertop.
- Avoid front-facing tilt that makes the object look like it is floating or facing the camera too much.

Avoid:

- Isometric 45-degree diamond layouts.
- True 3D perspective distortion.
- Eye-level side views.
- Top-down board-game views.
- High-angle top-down views.
- Dramatic camera angles.
- Objects heavily tilted toward the viewer.
- Assets whose visible top surface is much larger than nearby approved assets.

## Visual Style

Use:

- Modern cartoon/vector aesthetic.
- Friendly, polished social MMO appearance.
- Soft futuristic styling.
- Subtle neon accents.
- Rounded forms where appropriate.
- Readable silhouettes.
- Simple, clean geometry.
- Consistent visual language across every asset.

Avoid:

- Photorealism.
- Painterly textures.
- Anime styling.
- Fantasy styling.
- Grunge or distressed realism.
- Excessive micro-detail that disappears at gameplay scale.

## Lighting

Use:

- Soft ambient lighting.
- Gentle highlights.
- Minimal gradients.
- Neon as accent lighting.
- Emissive strips, small glows, and screen light where appropriate.

Avoid:

- Bloom-heavy effects.
- Dramatic shadows.
- Hard spotlights baked into reusable props.
- Large external cast shadows.
- Lighting that assumes a specific room background unless the asset is a room-specific set piece.

## Materials

Preferred materials:

- Matte painted surfaces.
- Clean plastics.
- Brushed metal.
- Dark wood where appropriate.
- Colored upholstery.
- Soft emissive light strips.
- Simple glass or screen surfaces with restrained reflections.

Avoid:

- Chrome-heavy materials.
- Mirror finishes.
- Heavy reflections.
- Photorealistic textures.
- Dirty, scratched, or gritty surfaces unless explicitly requested for a specific room.

## Color Palette

Preferred base colors:

- Charcoal.
- Navy.
- Deep purple.
- Muted blue-black.

Preferred accent colors:

- Cyan.
- Magenta.
- Teal.
- Orange.
- Yellow.
- White.

Assets should be colorful but not visually noisy. Accent lighting should help identify objects without overwhelming the room.

## Asset Composition Requirements

For reusable prop source PNGs:

- Transparent PNG background.
- One object per file.
- Centered composition.
- No environment around the object.
- No room background.
- No floor baked into the sprite.
- No large external cast shadow.
- No extra props unless explicitly requested.
- Designed to be reusable across rooms.
- Readable at the intended in-game size.

For large room-specific set pieces:

- Background, floor, wall, and room-context details are allowed only when the asset is explicitly a room plate or room-specific hero piece.
- Name and organize these assets as room-specific assets, not generic reusable props.

## Text And Logos

Avoid text or logos by default.

Text is allowed only when explicitly requested, such as:

- Q-Tube signage.
- Cinema marquee lettering.
- Arcade cabinet labels.
- Library category signs.
- Qortal-specific branding.

When text is required:

- Keep it large and readable.
- Avoid tiny decorative words.
- Prefer simple block lettering.
- Consider making text a separate layer or separate asset when localization or future variants are likely.

## AI Generation Prompt Template

Use this as the base prompt for AI-generated reusable prop assets:

```text
Create a production-ready transparent PNG game asset for QortalLand.
Style: modern cartoon/vector social MMO, front-facing 2.5D, fixed QortalLand camera, shallow overhead view, approximately 15 degrees downward from eye level and about 75 degrees from vertical/top-down, clean readable silhouette, soft futuristic details, subtle neon accents.
Camera: match FUR_001 bar_counter_long.png. Front faces remain visually dominant. Show only a modest amount of top surface. Do not use high-angle top-down, isometric, diamond, eye-level side, or dramatic perspective.
Object: [describe one object].
Materials: matte painted surfaces, clean plastic, brushed metal, colored upholstery or soft emissive strips where appropriate.
Composition: one object only, centered, transparent background, no room, no floor, no external cast shadow, no extra props.
Avoid: photorealism, anime style, painterly texture, fantasy style, dramatic camera angles, high-angle top-down views, isometric diamond perspective, eye-level flat side views, objects heavily tilted toward the viewer, heavy bloom, heavy reflections, text or logos unless explicitly requested.
```

For objects intended to sit on another object, add:

```text
Placement relationship: this asset sits on top of [supporting object]. Use an even shallower top view so it visually lies on that surface. It should not appear tilted toward the camera, floating, or facing the viewer more than the supporting object.
```

For room-specific set pieces, add:

```text
This is a room-specific QortalLand set piece, not a generic reusable prop.
It may include integrated wall/floor/background context only as requested.
Keep the same front-facing 2.5D perspective and cartoon/vector social MMO style.
Match the fixed QortalLand camera angle used by FUR_001 bar_counter_long.png.
```

## Negative Prompt Template

Use this negative prompt when the generation tool supports one:

```text
photorealistic, realistic render, anime, manga, painterly, fantasy, medieval, grunge, dirty texture, isometric, diamond map, top-down, high-angle top-down, eye-level side view, flat side view, dramatic perspective, steep camera angle, heavily tilted toward viewer, fisheye, 3D render look, heavy bloom, harsh shadows, mirror chrome, complex background, room environment, floor plane, external cast shadow, extra objects, tiny text, logo, watermark
```

## Quality Checklist

Before accepting an asset:

- Does it match the front-facing 2.5D camera?
- Does this asset use the same camera angle as `FUR_001 / bar_counter_long.png`?
- Does the amount of visible top surface match nearby approved assets?
- If placed on top of another object, does it visually rest on that surface?
- Does it avoid isometric or true 3D distortion?
- Does it avoid high-angle top-down framing?
- Does it avoid looking heavily tilted toward the viewer?
- Does it have a transparent background?
- Is there only one logical object in the file?
- Is the silhouette readable at gameplay scale?
- Does the object feel compatible with existing QortalLand characters?
- Does it avoid room-specific lighting or floor shadows unless intended?
- Does it avoid unwanted logos/text?
- Does it use the shared QortalLand palette and material language?
- Can it be placed in more than one room without looking out of place?

## Workflow

Recommended workflow:

1. Generate individual transparent PNG source assets using this style prompt.
2. Drop the PNGs into `src/assets/qortalland/source/`.
3. Use the development PNG loader to test scale, perspective, and readability in Phaser.
4. Adjust the source asset or placement until it matches the room and characters.
5. Once approved, move the asset into the stable source library.
6. Later, compile stable reusable assets into texture atlases for production.

## Relationship To The Asset Standard

The Asset Standard defines:

- folder structure
- source-vs-runtime asset flow
- manifests
- layouts
- hotspots
- collisions
- atlases

This Style Prompt defines:

- camera angle
- visual language
- material treatment
- color behavior
- AI generation constraints
- quality checks for visual consistency

Both documents should be treated as the source of truth for future QortalLand room development.
