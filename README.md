# aaronyuelin

Core architecture of [aaronyuelin.com](https://www.aaronyuelin.com): a white room, one football, and a 2×5 goal. This repository is the Three.js scene, Rapier physics, camera framing, interaction, and shaders. It is not a dump of the live site.

Live site: [www.aaronyuelin.com](https://www.aaronyuelin.com)

## What’s included

- `public/app.js` — boot, render loop, goal state
- `public/scene.js` — Three.js room, lighting, custom shaders
- `public/camera.js` — pinhole framing (centred goal on phones, desktop crop)
- `public/physics-rapier.js` — one Rapier rigid body with real football parameters
- `public/interaction.js` — drag, charge, shoot, keyboard
- `public/config.js` — room, goal, ball, and camera numbers
- `public/ball.js`, `public/ball-view.js`, `public/shot.js`, `public/texture-infra.js`
- `public/index.html`, destination shells, `tools/serve.mjs`
- Vendored [Three.js](https://threejs.org/) r187 (MIT) and [Rapier](https://rapier.rs/) 0.21 (`@dimforge/rapier3d-compat`, Apache-2.0)

## What’s not included

4K / 2K glTF models, PBR textures, Blender sources, photos, bio, contact details, and the ops console are **not** in this repository. Destination pages under `public/target/1`–`10` are obvious placeholders.

To see the textured room locally, copy your own `football` and `room-goal` `.glb` files into `public/assets/glb/` and point the texture manifest in `public/index.html` (and the `BALL_GLB_URL` / `ROOM_URL` fallbacks) at those files. Without models, physics and interaction still start, but the room and ball have nothing to draw — there is no procedural fallback.

## Run locally

The site is static ES modules. Serve it over HTTP (`file://` will not load them):

```sh
npm start            # http://localhost:4173/
# or, without npm:
node tools/serve.mjs
# or any static server:
python3 -m http.server 4173 --directory public
```

Optional: `PORT=8080 npm start`, `HOST=127.0.0.1 npm start`.

You do not need `npm install`. `package.json` pins the Three.js and Rapier versions that were vendored into `public/vendor/`.

## License

Source code is under the [MIT License](LICENSE), copyright 2026 YUE LIN. Third-party code keeps its own licenses in `public/vendor/`. Models, textures, and other artwork from the live site are not licensed here; they remain reserved.

---

# aaronyuelin

[aaronyuelin.com](https://www.aaronyuelin.com) 的核心架构：一间白房间、一颗足球、一座 2×5 球门。本仓库只公开 Three.js 场景、Rapier 物理、相机取景、交互和着色器，不是线上网站的完整拷贝。

线上网站：[www.aaronyuelin.com](https://www.aaronyuelin.com)

## 仓库里有什么

- `public/app.js` — 启动、渲染循环、进球状态
- `public/scene.js` — Three.js 房间、灯光、自定义着色器
- `public/camera.js` — 针孔取景（手机上球门居中，桌面另有裁切）
- `public/physics-rapier.js` — 单一 Rapier 刚体，使用真实足球参数
- `public/interaction.js` — 拖动、蓄力、射门、键盘
- `public/config.js` — 房间、球门、足球和相机数值
- `public/ball.js`、`public/ball-view.js`、`public/shot.js`、`public/texture-infra.js`
- `public/index.html`、目标页壳子、`tools/serve.mjs`
- 已内置的 [Three.js](https://threejs.org/) r187（MIT）和 [Rapier](https://rapier.rs/) 0.21（`@dimforge/rapier3d-compat`，Apache-2.0）

## 仓库里没有什么

4K / 2K 模型、PBR 贴图、Blender 源文件、照片、个人简介、联系方式，以及运维面板，都**不在**本仓库里。`public/target/1`–`10` 只是占位页。

如果要在本地看到带贴图的房间，请把你自己的 `football` 和 `room-goal` `.glb` 放到 `public/assets/glb/`，并改好 `public/index.html` 里的贴图清单，以及 `BALL_GLB_URL` / `ROOM_URL`。没有模型时，物理和交互仍会启动，但房间和足球没有可绘制的网格——代码里没有程序化替代物。

## 本地运行

站点是静态 ES 模块，需要用 HTTP 提供（`file://` 无法加载）：

```sh
npm start            # http://localhost:4173/
# 或不使用 npm：
node tools/serve.mjs
# 或任意静态服务器：
python3 -m http.server 4173 --directory public
```

可选：`PORT=8080 npm start`，`HOST=127.0.0.1 npm start`。

不需要执行 `npm install`。`package.json` 只是记录了内置在 `public/vendor/` 里的 Three.js 和 Rapier 版本。

## 许可证

源代码采用 [MIT 许可证](LICENSE)，版权所有 2026 YUE LIN。第三方代码的许可证在 `public/vendor/`。线上网站的模型、贴图和其他美术资源不在本仓库授权范围内，保留所有权利。
