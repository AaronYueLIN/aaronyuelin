/**
 * The only visible football: a complete Blender glTF/PBR mesh.
 *
 * Architecture (why this file exists):
 *   • There is NO procedural sphere, NO billboard and NO PNG fallback. If the
 *     textured GLB cannot be loaded, the ball is not shown at all; the failure
 *     is recorded in `globalThis.__ball`, `<html data-ball="error">` and the
 *     console. A white/untextured frame is never presented as the ball.
 *   • The loader proves the asset before revealing it: a real mesh, UVs and
 *     colour + normal + roughness maps with image dimensions > 2×2.
 *   • It waits for every texture to decode, uploads it with
 *     `renderer.initTexture`, applies anisotropic filtering and a normal
 *     scale that survives the small on-screen size, then compiles the shader.
 *   • The leather gets its own PMREM studio environment, so the grain and
 *     panel seams read even when the room lighting is flat.
 *
 * The Blender source is prototype/room-goal-ball/ball.py; the exported asset
 * is prototype/site/assets/glb/football.4k.b022e4b93a8701be.glb (basecolor + normal + roughness maps,
 * UV atlas, tangents). Do not add a degraded fallback here.
 */

import * as THREE from './three.js?v=2026.11.23-r10';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { BALL_RADIUS, BAR_DEPTH } from './config.js?v=2026.11.23-r10';
import { applyTextureSampling, loadGlb, resolveAsset } from './texture-infra.js?v=2026.11.23-r10';

export const BALL_GLB_URL = new URL('assets/glb/football.4k.b022e4b93a8701be.glb', import.meta.url);

/** Maps without which the ball must not be shown. */
const REQUIRED_MAPS = [
  ['map', 'baseColor'],
  ['normalMap', 'normal'],
  ['roughnessMap', 'roughness'],
];

export class BallAssetError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'BallAssetError';
    this.report = report;
  }
}

function imageSize(texture) {
  const image = texture?.image;
  if (!image) return { width: 0, height: 0 };
  return {
    width: Number(image.width ?? image.naturalWidth ?? image.videoWidth ?? 0),
    height: Number(image.height ?? image.naturalHeight ?? image.videoHeight ?? 0),
  };
}

/** Wait for an <img> to decode; ImageBitmap is already decoded. */
async function settleTexture(texture, slot, label) {
  const image = texture?.image;
  if (!image) throw new BallAssetError(`missing ${label} image`, { slot, label });
  if (typeof image.decode === 'function') {
    try {
      await image.decode();
    } catch {
      // ImageBitmap has no failing decode; a broken <img> is caught by size.
    }
  }
  const size = imageSize(texture);
  if (!(size.width > 2 && size.height > 2)) {
    throw new BallAssetError(
      `${label} is a ${size.width}×${size.height} stub, not a usable texture`,
      { slot, label, ...size },
    );
  }
  return size;
}

/** A compact, high-contrast studio used only by the leather materials. */
function buildLeatherStudio(renderer) {
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0x202020);
  const panel = (hex, intensity, w, h, position) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(hex).multiplyScalar(intensity),
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.set(...position);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  };
  // Warm key, cool rim, white overhead strip, warm floor bounce.
  panel(0xffe2c2, 3.4, 4.5, 3.6, [-3.4, 4.2, 3.6]);
  panel(0xcfe0ff, 1.3, 3.4, 4.4, [3.6, 1.4, 2.4]);
  panel(0xffffff, 0.8, 5.0, 1.2, [0.0, 3.8, -1.2]);
  panel(0xff8a4c, 0.55, 3.0, 2.4, [1.6, -2.4, 2.4]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(studio, 0.035);
  pmrem.dispose();
  studio.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    object.material.dispose();
  });
  return target.texture;
}

function listMaterials(mesh) {
  return (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean);
}

function recordMaterials(meshes, env, report, bindings, allMaterials) {
  for (const mesh of meshes) {
    if (!mesh.geometry?.attributes?.uv) {
      throw new BallAssetError(`${mesh.name || 'mesh'} has no UV map`, report);
    }
    if (!mesh.geometry.attributes.position?.count) {
      throw new BallAssetError(`${mesh.name || 'mesh'} has no geometry`, report);
    }
    for (const material of listMaterials(mesh)) {
      if (!material.isMeshStandardMaterial) {
        throw new BallAssetError(`material ${material.name || material.type} is not PBR`, report);
      }
      const missing = REQUIRED_MAPS.filter(([key]) => !material[key]).map(([, label]) => label);
      if (missing.length) {
        throw new BallAssetError(
          `material ${material.name || material.type} is missing ${missing.join(', ')}`,
          report,
        );
      }
      const isThread = /stitch|thread/i.test(material.name || '');
      // PBR maps are data; keep colour in sRGB and data maps linear.
      material.map.colorSpace = THREE.SRGBColorSpace;
      material.normalMap.colorSpace = THREE.NoColorSpace;
      material.roughnessMap.colorSpace = THREE.NoColorSpace;
      if (material.metalnessMap) material.metalnessMap.colorSpace = THREE.NoColorSpace;
      material.normalMapType = THREE.TangentSpaceNormalMap;

      // The atlas is a 4096x4096 3x3 cube-face pack.  Every island is inset
      // from the tile edge, and clamping stops a coarse mip from bleeding the
      // neighbouring face into a seam.  The cord map is tileable on purpose.
      for (const [key] of REQUIRED_MAPS) {
        const texture = material[key];
        if (!texture) continue;
        texture.wrapS = isThread ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
        texture.wrapT = isThread ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      }

      material.envMap = env;
      material.envMapIntensity = isThread ? 0.62 : 0.78;
      material.metalness = 0;
      // The baked 4K albedo is the authoritative burnt-orange colour; a white
      // factor avoids the old double-tint that turned the leather salmon.
      material.color.setRGB(1.0, 1.0, 1.0);
      material.roughness = 1.0;
      if ('ior' in material) material.ior = 1.45;
      // Slightly warm specular keeps the highlight in the leather's hue
      // instead of washing the orange toward pink under the white room key.
      if ('specularIntensity' in material) material.specularIntensity = isThread ? 0.28 : 0.34;
      if ('specularColor' in material) material.specularColor.setRGB(1.0, 0.78, 0.62);
      if ('sheen' in material) {
        material.sheen = isThread ? 0.05 : 0.10;
        material.sheenRoughness = 0.55;
        material.sheenColor.setHex(0xff6b30);
      }
      // The normal map is the authored 4K relief; only a mild boost is needed.
      material.normalScale.set(isThread ? 0.85 : 1.14, isThread ? 0.85 : 1.14);
      // Padded leather has a directional satin response; the GLB carries
      // tangents and a KHR_materials_anisotropy extension.
      if ('anisotropy' in material) {
        material.anisotropy = isThread ? 0.0 : 0.28;
        material.anisotropyRotation = 0.45;
      }
      if ('clearcoat' in material) {
        material.clearcoat = isThread ? 0.0 : 0.02;
        material.clearcoatRoughness = 0.38;
      }
      // Custom WebGL layer on top of the PBR maps.  It keeps the authored
      // baseColor, normal and roughness maps.  A band-limited micro-normal
      // adds sub-texel pores only when the footprint is small enough, so it
      // sharpens the close-up without shimmering the small page ball.
      const micro = isThread ? 0.06 : 0.16;
      const rim = isThread ? 0.04 : 0.12;
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
            float leatherHash21(vec2 p) {
              p = fract(p * vec2(123.34, 456.21));
              p += dot(p, p + 45.32);
              return fract(p.x * p.y);
            }`)
          .replace(
            'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
            `vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
             vec2 leatherMicroP = vNormalMapUv * vec2(1450.0, 1450.0);
             float leatherMicroFade = 1.0 - smoothstep(0.30, 1.15, length(fwidth(leatherMicroP)));
             float leatherMicroA = leatherHash21(leatherMicroP);
             float leatherMicroB = leatherHash21(leatherMicroP + 19.7);
             mapN.xy += (vec2(leatherMicroA, leatherMicroB) - 0.5) * ${micro.toFixed(3)} * leatherMicroFade;`,
          )
          .replace('#include <opaque_fragment>', `
            float leatherFresnel = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.0);
            outgoingLight += vec3(0.86, 0.22, 0.06) * leatherFresnel * ${rim.toFixed(3)};
            gl_FragColor = vec4(outgoingLight, diffuseColor.a);`);
      };
      material.customProgramCacheKey = () => `leather-pbr-7-${isThread ? 'thread' : 'hide'}`;
      // The ball is a normal depth-tested opaque object; the floor below is
      // background-only so its slab cannot depth-occlude a resting ball.
      material.depthTest = true;
      material.depthWrite = true;
      material.side = isThread ? THREE.DoubleSide : THREE.FrontSide;
      material.needsUpdate = true;

      const textures = [];
      for (const [key, label] of REQUIRED_MAPS) {
        textures.push({ key, label, texture: material[key] });
      }
      if (material.metalnessMap) {
        textures.push({ key: 'metalnessMap', label: 'metalness', texture: material.metalnessMap });
      }
      allMaterials.push(material);
      report.materials.push({
        name: material.name,
        type: material.type,
        roughness: material.roughness,
        metalness: material.metalness,
        normalScale: [material.normalScale.x, material.normalScale.y],
        maps: Object.fromEntries(REQUIRED_MAPS.map(([key, label]) => [label, Boolean(material[key])])),
      });
      bindings.push(...textures);
    }
  }
}

/**
 * Load and reveal the Blender football.
 * @param {{ ballGroup: THREE.Group, renderer: THREE.WebGLRenderer, camera?: THREE.Camera, scene?: THREE.Scene, layer?: number }} options
 */
export async function loadFootball({ ballGroup, renderer, camera, scene = null, layer = 1 } = {}) {
  if (!ballGroup || !renderer) throw new Error('loadFootball needs a ball group and renderer');
  const started = performance.now();
  ballGroup.visible = false;
  while (ballGroup.children.length) ballGroup.remove(ballGroup.children[0]);

  const allMaterials = [];
  const asset = resolveAsset('football', BALL_GLB_URL.href, renderer);
  const report = {
    status: 'loading',
    url: asset.url,
    tier: asset.tier,
    tierReason: asset.reason,
    startedAt: Date.now(),
    meshes: [],
    materials: [],
    textures: [],
    errors: [],
  };
  globalThis.__ball = report;
  document.documentElement.dataset.ball = 'loading';

  try {
    const { gltf, bytes, ms } = await loadGlb(new GLTFLoader(), asset.url, {
      label: 'football',
      timeoutMs: 90_000,
      retries: 1,
      priority: 'low',
    });
    report.assetBytes = bytes;
    report.loadMs = ms;
    const root = gltf.scene;
    root.updateMatrixWorld(true);

    const meshes = [];
    root.traverse((object) => {
      if (object.isMesh) meshes.push(object);
    });
    if (!meshes.length) throw new BallAssetError('the GLB contains no mesh', report);

    const env = buildLeatherStudio(renderer);
    const bindings = [];
    recordMaterials(meshes, env, report, bindings, allMaterials);
    applyTextureSampling(root, renderer);

    // Normalise to the physical radius without touching the mesh data.
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const widest = Math.max(size.x, size.y, size.z);
    if (!(widest > 0) || !Number.isFinite(widest)) {
      throw new BallAssetError('the GLB has no measurable size', report);
    }
    const scale = (2 * BALL_RADIUS) / widest;
    root.scale.multiplyScalar(scale);
    root.position.copy(centre).multiplyScalar(-scale);

    // Prove every texture before the first visible frame. The roughness and
    // metalness slots intentionally share one ORM texture; report both slots
    // while uploading the GPU texture once.
    const unique = new Map();
    for (const binding of bindings) {
      const size = await settleTexture(binding.texture, binding.key, binding.label);
      const texture = binding.texture;
      if (!unique.has(texture)) {
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
        texture.needsUpdate = true;
        unique.set(texture, binding);
      }
      report.textures.push({
        slot: binding.key,
        label: binding.label,
        name: texture.name,
        width: size.width,
        height: size.height,
        colorSpace: texture.colorSpace || 'linear',
        anisotropy: texture.anisotropy,
      });
    }
    for (const texture of unique.keys()) renderer.initTexture(texture);

    root.traverse((object) => {
      if (!object.isMesh) return;
      // 06:32: no ball shadow at all, no ground/environment shadow.
      object.castShadow = false;
      object.receiveShadow = false;
      object.frustumCulled = false;
      object.layers.enable(layer);
      report.meshes.push({
        name: object.name,
        vertices: object.geometry.attributes.position.count,
        triangles: object.geometry.index ? object.geometry.index.count / 3 : object.geometry.attributes.position.count / 3,
        uv: Boolean(object.geometry.attributes.uv),
        tangent: Boolean(object.geometry.attributes.tangent),
      });
    });

    root.name = 'football-model';
    // 06:27/06:32: the floor and walls exist only as physics boundaries.
    // Hide the visible floor slab and the old shadow receiver so the page is
    // pure white, there is no ball/ground shadow, and no floor geometry can
    // depth-occlude the ball. The ball keeps normal depth testing against
    // the goal bars/walls.
    const roomFloor = scene?.getObjectByName('Room_Floor');
    if (roomFloor) roomFloor.visible = false;
    scene?.traverse((object) => {
      if (object.isMesh && object.material?.isShadowMaterial) object.visible = false;
    });
    globalThis.__ballModel = { root, materials: allMaterials, env, scene, camera, renderer, ballGroup, THREE };
    ballGroup.add(root);
    ballGroup.visible = true;
    if (camera) renderer.compile(scene ?? ballGroup, camera);

    report.status = 'ready';
    report.readyMs = Math.round(performance.now() - started);
    report.diameter = 2 * BALL_RADIUS;
    document.documentElement.dataset.ball = 'ready';
    window.dispatchEvent(new CustomEvent('ball-ready', { detail: report }));
    return { root, env, report };
  } catch (error) {
    ballGroup.visible = false;
    while (ballGroup.children.length) ballGroup.remove(ballGroup.children[0]);
    report.status = 'error';
    report.error = String(error?.message ?? error);
    report.errors.push(report.error);
    document.documentElement.dataset.ball = 'error';
    console.error('[ball] textured Blender GLB failed; no ball will be shown:', error);
    window.dispatchEvent(new CustomEvent('ball-error', { detail: report }));
    throw error instanceof BallAssetError ? error : new BallAssetError(report.error, report);
  }
}
