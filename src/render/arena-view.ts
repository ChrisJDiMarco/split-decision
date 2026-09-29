// Placeholder cage view built from the shared arena spec. The arena module replaces the
// materials, lighting rig and crowd; the geometry must keep matching ARENA.
import * as THREE from 'three/webgpu';
import { APOTHEM, ARENA, CIRCUMRADIUS, panels, postPositions } from '../core/arena-spec';

export function buildArena(physicsRoot: THREE.Group, scene: THREE.Scene): THREE.Group {
  const g = new THREE.Group();
  const canvasMat = new THREE.MeshStandardMaterial({ color: 0xcfc8ba, roughness: 0.92 });
  const canvasShape = new THREE.Shape();
  for (let i = 0; i < ARENA.SIDES; i++) {
    const a = ((i + 0.5) / ARENA.SIDES) * Math.PI * 2;
    const r = CIRCUMRADIUS + ARENA.APRON_M;
    if (i === 0) canvasShape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else canvasShape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const canvas = new THREE.Mesh(new THREE.ShapeGeometry(canvasShape), canvasMat);
  canvas.receiveShadow = true;
  g.add(canvas);

  const postMat = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.6 });
  for (const [x, y] of postPositions()) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(ARENA.POST_PAD_RADIUS_M, ARENA.POST_PAD_RADIUS_M, ARENA.FENCE_HEIGHT_M + 0.1, 20), postMat);
    post.rotation.x = Math.PI / 2;
    post.position.set(x, y, (ARENA.FENCE_HEIGHT_M + 0.1) / 2);
    post.castShadow = true;
    g.add(post);
  }
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.5, metalness: 0.6, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
  for (const p of panels()) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(p.length, ARENA.FENCE_HEIGHT_M), fenceMat);
    panel.position.set(p.center[0], p.center[1], ARENA.FENCE_HEIGHT_M / 2);
    const a = p.normalAngle;
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(-Math.sin(a), Math.cos(a), 0), // along the side
      new THREE.Vector3(0, 0, 1), // up
      new THREE.Vector3(Math.cos(a), Math.sin(a), 0), // outward normal
    );
    panel.quaternion.setFromRotationMatrix(basis);
    g.add(panel);
  }
  physicsRoot.add(g);

  scene.add(new THREE.HemisphereLight(0x8899aa, 0x080808, 0.35));
  const key = new THREE.SpotLight(0xffffff, 900, 40, Math.PI / 5, 0.5, 1.6);
  key.position.set(0, 12, 0);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  scene.add(key, key.target);
  void APOTHEM;
  return g;
}
