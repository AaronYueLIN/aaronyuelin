# aaronyuelin

[aaronyuelin.com](https://www.aaronyuelin.com): a white room, one football, and a 2×5 goal. This repository is the website’s public snapshot as of release **2026.11.23-r11** — Three.js scene, Rapier physics, camera framing, interaction, shaders, and the models and textures used on the live site.

Live site: [www.aaronyuelin.com](https://www.aaronyuelin.com)

The mobile homepage footer has a static **MIT License** link to the plaintext license at [`LICENSE.txt`](public/LICENSE.txt) (`/LICENSE.txt` when the site is served). The scope notice is [`LICENSE-SCOPE.txt`](public/LICENSE-SCOPE.txt).

## What’s included

- Scene, physics, camera, interaction, xG scoreboard, homepage gate, and related runtime modules under `public/`
- Content-addressed football and room/goal glTF models (4K and 2K tiers), split parts, and gzip transport files under `public/assets/glb/`
- Preview images, scoreboard bezel, and UI fonts
- Destination page shells (`public/target/1`–`10`), plus the public example shelf
- Vendored [Three.js](https://threejs.org/) r187 (MIT) and [Rapier](https://rapier.rs/) 0.21 (`@dimforge/rapier3d-compat`, Apache-2.0)
- [`tools/serve.mjs`](tools/serve.mjs) for local HTTP preview

The ops console and server-side CMS/auth functions are **not** included.

## License

**Source code** is under the [MIT License](LICENSE), copyright 2026 YUE LIN. That grant is also mirrored at [`public/LICENSE.txt`](public/LICENSE.txt). It does **not** license models, textures, fonts, third-party libraries, or visitor/editor content. See [LICENSE-SCOPE.txt](LICENSE-SCOPE.txt).

Third-party terms stay with their own files and are not replaced by MIT:

- [Three.js](public/vendor/THREE-LICENSE.txt) — MIT
- [Rapier](public/vendor/rapier/LICENSE) — Apache-2.0
- [Octicons](public/assets/licenses/octicons-MIT.txt) — MIT (GitHub Inc.)
- [Fraunces](public/assets/licenses/fraunces-OFL.txt) — SIL Open Font License 1.1
- [Instrument Sans](public/assets/licenses/instrument-sans-OFL.txt) — SIL Open Font License 1.1

The football and room/goal models, PBR textures, preview stills, and scoreboard artwork are included here with the owner’s permission so the public site can be run as it appears, but they are **not** licensed under MIT. Reuse requires a separate grant from the owner or the original source.

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

---

# aaronyuelin

[aaronyuelin.com](https://www.aaronyuelin.com)：一间白房间、一颗足球、一座 2×5 球门。本仓库是 **2026.11.23-r11** 的公开快照，包含 Three.js 场景、Rapier 物理、相机取景、交互、着色器，以及线上站点使用的模型与贴图。

线上网站：[www.aaronyuelin.com](https://www.aaronyuelin.com)

手机首页底部有静态的 **MIT License** 链接，指向明文许可证 [`LICENSE.txt`](public/LICENSE.txt)（站点上为 `/LICENSE.txt`）。范围说明见 [`LICENSE-SCOPE.txt`](public/LICENSE-SCOPE.txt)。

## 仓库里有什么

- `public/` 下的场景、物理、相机、交互、xG 记分牌、首页门控及相关运行时模块
- 内容寻址的足球与房间/球门 glTF 模型（4K 与 2K）、分片与 gzip 传输文件（`public/assets/glb/`）
- 预览图、记分牌外框、界面字体
- 目标页壳子（`public/target/1`–`10`）以及公开示例页
- 已内置的 [Three.js](https://threejs.org/) r187（MIT）和 [Rapier](https://rapier.rs/) 0.21（Apache-2.0）
- 本地预览用的 [`tools/serve.mjs`](tools/serve.mjs)

运维面板和用于内容管理/登录的服务端函数**不在**本仓库中。

## 许可

**源代码**采用 [MIT License](LICENSE)，版权所有 2026 YUE LIN；站点内同样提供 [`public/LICENSE.txt`](public/LICENSE.txt)。该许可**并不**覆盖模型、贴图、字体、第三方库或访客/编辑内容。详见 [LICENSE-SCOPE.txt](LICENSE-SCOPE.txt)。

第三方条款保留在各自的许可文件中，不以 MIT 重新声明：

- [Three.js](public/vendor/THREE-LICENSE.txt) — MIT
- [Rapier](public/vendor/rapier/LICENSE) — Apache-2.0
- [Octicons](public/assets/licenses/octicons-MIT.txt) — MIT（GitHub Inc.）
- [Fraunces](public/assets/licenses/fraunces-OFL.txt) — SIL Open Font License 1.1
- [Instrument Sans](public/assets/licenses/instrument-sans-OFL.txt) — SIL Open Font License 1.1

足球与房间/球门模型、PBR 贴图、预览静帧和记分牌画作经所有者同意收入本仓库，以便公开运行与线上一致的站点，但**不以 MIT 授权**。再次使用需另行获得所有者或原始来源的许可。

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

不需要 `npm install`。`package.json` 锁定了放入 `public/vendor/` 的 Three.js 与 Rapier 版本。
