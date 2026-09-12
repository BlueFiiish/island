# 3D asset provenance - Tarkov Weapon Builder (T2 pilot)

**Every mesh under `3d/glb/` is generated from source by the Blender scripts in
`projects/fiiiish-app/tools/tarkov-3d/blender/`. Nothing here was downloaded, ripped, extracted, converted,
photogrammetried or AI-generated.**

## The rule this directory exists to enforce

| Forbidden | Why |
|---|---|
| Battlestate Games / Escape from Tarkov game assets, in any form | Proprietary. Extracting them breaks the EULA and is not licensable. |
| Sketchfab / Open3DLab / "free Tarkov model" downloads | These are overwhelmingly ripped BSG assets re-uploaded under a CC licence the uploader had no right to grant. A CC tag on a ripped asset is not a licence. |
| AI image-to-3D (Hunyuan3D, TripoSR, Meshy, ...) on a game screenshot or a product photo | Launders the copyright of the input; the output carries the input's problems. |
| Manufacturer trademarks, roll marks, logos, serial plates, model designations | Trade dress / trademark, which is a separate right from copyright in the shape. |

## What was actually done

The M4A1 blockout and the twelve archetype parts were typed by hand as
parametric primitives (boxes, cylinders, cones) in `build_m4a1.py` /
`build_parts.py`, from **published dimensions of the real-world AR-15 / M4
pattern carbine**: 0.838 m overall with the stock extended, 14.5" barrel,
STANAG magazine envelope (~190 mm x ~60 mm x ~25 mm), M4 receiver-extension
length, and the standard MIL-STD-1913 rail pitch.

The **shape of a real firearm is not copyrightable** - it is a functional
article. What IS protected is a maker's trade dress and marks, so the blockout
carries **no markings of any kind**: no "COLT", no horse, no caliber stamp, no
serial, no model roll mark, no manufacturer profile signature. The parts are
deliberately named as generic archetypes ("30-rd box magazine",
"Quad-rail handguard"), never as products.

No reference image was traced. Quaternius' CC0 "Ultimate Guns" pack was cited
in the brief as a permissible silhouette reference; **it was not downloaded or
used** - the dimensions above were sufficient.

## Files and their origin

| File | Origin | Licence |
|---|---|---|
| `tools/tarkov-3d/blender/{lib_blockout,build_m4a1,build_parts}.py` | Written for this repo | Same as the vault |
| `tools/tarkov-3d/blender/{build_ak,build_ak_parts}.py` | Written for this repo | Same as the vault |
| `tools/tarkov-3d/glb-raw/*.glb` | Blender output of the above | Same as the vault |
| `3d/glb/*.glb` | `tools/tarkov-3d/glb-raw` passed through `@gltf-transform/cli quantize` | Same as the vault |
| `manifest.json` | Written for this repo. Contains tarkov.dev **item and category IDs** (24-hex strings) and BSG **slot nameIds** as identifiers only - the same public identifiers the rest of `/tarkov` already ships. No BSG art, text or geometry. | Same as the vault |
| `../js/vendor/three-bundle.js` | esbuild bundle of `three` r180 (`three`, `GLTFLoader`, `OrbitControls`) | **MIT** (three.js, (c) 2010-2026 three.js authors) |
| `../js/hub-builder-3d.js` | Written for this repo | Same as the vault |

## Per-mesh rows

Every `.glb` this directory ships, its generator, and where its shape came from.
**A mesh with no row here has no business being in `glb/`.**

### AR platform - `build_m4a1.py` / `build_parts.py`

| Mesh | Generator | Shape from |
|---|---|---|
| `m4a1.glb` | `build_m4a1.py` | AR-15/M4 carbine published dimensions: 0.838 m overall stock-extended, 14.5" barrel, MIL-STD-1913 rail pitch. Self-modelled primitives. No markings. |
| `mag_stanag_30.glb`, `mag_drum_60.glb` | `build_parts.py` | STANAG box envelope (~190 x 60 x 25 mm) / generic high-capacity drum. Self-modelled. |
| `muzzle_brake.glb`, `muzzle_suppressor.glb` | `build_parts.py` | Generic 5.56 brake and can. Self-modelled. |
| `optic_reddot.glb`, `optic_scope_4x.glb` | `build_parts.py` | Generic reflex sight / generic magnified optic. Self-modelled. Shared with the AK platform. |
| `grip_pistol.glb`, `stock_collapsible.glb`, `stock_fixed.glb` | `build_parts.py` | Generic AR grip, carbine sliding stock on a receiver extension, fixed stock. Self-modelled. |
| `foregrip_vertical.glb`, `tactical_light.glb` | `build_parts.py` | Generic vertical grip / generic weapon light-laser box. Self-modelled. Shared with the AK platform. |
| `handguard_ris.glb` | `build_parts.py` | Generic quad-rail handguard on MIL-STD-1913 pitch. Self-modelled. |

### AK platform - `build_ak.py` / `build_ak_parts.py`

| Mesh | Generator | Shape from |
|---|---|---|
| `ak74n.glb` | `build_ak.py` | AK-pattern rifle published dimensions: 0.943 m overall with the fixed stock, 415 mm barrel, stamped receiver, gas tube over the bore. Self-modelled primitives. **No Kalashnikov / Izhmash / Molot trademark, roll mark, proof stamp or model designation is modelled.** |
| `ak_mag_30.glb` | `build_ak_parts.py` | 5.45x39 30-round box envelope, ~22 deg arc. Self-modelled. |
| `ak_mag_762_30.glb` | `build_ak_parts.py` | 7.62x39 30-round box envelope, ~30 deg arc. Self-modelled. |
| `ak_mag_45.glb`, `ak_mag_60.glb` | `build_ak_parts.py` | Generic extended and quad-stack box magazines. Self-modelled. |
| `ak_muzzle_brake.glb` | `build_ak_parts.py` | Generic ported two-chamber rifle brake. Self-modelled. |
| `ak_suppressor.glb` | `build_ak_parts.py` | Generic over-barrel can. Self-modelled. |
| `ak_dustcover.glb`, `ak_dustcover_rail.glb` | `build_ak_parts.py` | Generic stamped dust cover, plain and with a MIL-STD-1913 strip. Self-modelled. |
| `ak_side_mount.glb` | `build_ak_parts.py` | Generic left-side dovetail optic bracket. Self-modelled. |
| `ak_handguard_wood.glb`, `ak_handguard_rail.glb` | `build_ak_parts.py` | Generic two-piece handguard set (lower + gas-tube cover), plain and railed. Self-modelled. |
| `ak_stock_fixed.glb` | `build_ak_parts.py` | Generic fixed rifle buttstock, 0.27 m, 0.11 m butt, ~0.04 m drop. Self-modelled. |
| `ak_stock_folding.glb` | `build_ak_parts.py` | Generic triangular side-folding skeleton stock. Self-modelled. |
| `ak_grip.glb` | `build_ak_parts.py` | Generic raked pistol grip. Self-modelled. |

Colours are chosen from generic firearm-furniture palettes (dark metal, black
polymer, tan polymer, plum polymer) and are not anyone's trade dress.

## Third-party licence notice

`js/vendor/three-bundle.js` contains three.js, MIT licensed:

> Copyright (c) 2010-2026 three.js authors
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction... THE SOFTWARE IS PROVIDED "AS IS".

No meshopt or draco decoder is bundled - see `tools/tarkov-3d/README.md` for
why (the shell CSP forbids WebAssembly).

## If a future lane adds a gun

Add it the same way: a new `build_<gun>.py` of hand-typed primitives, a new row
in the table above, and no downloaded mesh. If someone proposes an asset from
the internet, the default answer is no unless its licence is verifiable **and**
its uploader is plausibly its author.
