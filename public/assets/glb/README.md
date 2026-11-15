# Models and textures are not in this repository

The live site loads two self-contained glTF binaries (PBR textures baked in):

- `football.4k.<hash>.glb` and `football.2k.<hash>.glb`
- `room-goal.4k.<hash>.glb` and `room-goal.2k.<hash>.glb`

Filenames are content-addressed. `public/index.html` embeds a texture manifest,
and `scene.js` / `ball-view.js` also fall back to the 4K paths next to this
folder. To run the room locally, copy your own models here and either keep
those names or update the manifest and the `ROOM_URL` / `BALL_GLB_URL`
constants.

Without the models the page still boots (Rapier, camera, interaction), but the
room and ball stay empty — the renderer has no procedural fallback.
