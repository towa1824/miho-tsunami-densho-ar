// ポインタ（マウス/タッチ）で見回し＋クリックで移動＋キーボード/画面ボタンで歩く操作。
// Googleストリートビュー風: パノラマを「掴んで回す」ドラッグ＋慣性、地面クリックでその地点へ前進。
// 方位センサーが無いPCでもAR空間を歩いて検証できるようにするための操作。
//
// LocARの世界座標: 北=-Z, 東=+X。three.jsの既定カメラは -Z を向く＝初期は北を向く。
// heading(方位) = (-yaw°+360)%360。移動はカメラのyaw方向（水平面）へ並進する。
import * as THREE from "three";

export class LookControls {
  constructor(camera, domElement, { groundY = -1.5 } = {}) {
    this.camera = camera;
    this.dom = domElement;
    this.groundY = groundY;
    this.yaw = 0;     // ラジアン（0=北）
    this.pitch = 0;   // ラジアン（+で上）
    this.eyeY = camera.position.y || 0;
    this.enabled = true;
    this.sensitivity = 0.005;
    this.speed = 9;           // m/秒（キー/D-padで歩く速さ。Shiftで3倍）
    this.moveLimit = 900;     // 原点からの移動上限(m)
    this._keys = new Set();
    this._touchMove = { f: 0, s: 0 }; // 画面D-pad用 forward/strafe (-1..1)
    this._lastT = performance.now();
    this.onMove = null;       // 移動時コールバック(camera.position更新後)

    // ドラッグ/クリック判定・慣性・クリック移動
    this._dragging = false;
    this._moved = 0;          // ドラッグ移動量の累積(px)。小さければクリック扱い
    this._downT = 0;
    this._lastX = 0; this._lastY = 0;
    this._yawVel = 0; this._pitchVel = 0;  // 離した後の慣性角速度
    this._moveTarget = null;  // クリック移動の目標 {x,z}

    camera.rotation.order = "YXZ";

    this._onDown = (e) => {
      if (e.touches && e.touches.length > 1) return; // ピンチは見回しにしない
      const p = e.touches ? e.touches[0] : e;
      this._dragging = true;
      this._moved = 0;
      this._lastX = p.clientX;
      this._lastY = p.clientY;
      this._downT = performance.now();
      this._yawVel = this._pitchVel = 0; // 掴んだら慣性を止める
      this._moveTarget = null;           // 掴んだらクリック移動を止める
    };
    this._onMoveEvt = (e) => {
      if (!this._dragging || !this.enabled) return;
      if (e.touches && e.touches.length > 1) return;
      const p = e.touches ? e.touches[0] : e;
      const dx = p.clientX - this._lastX;
      const dy = p.clientY - this._lastY;
      this._lastX = p.clientX;
      this._lastY = p.clientY;
      this._moved += Math.abs(dx) + Math.abs(dy);
      // grab型: パノラマを掴んで指の向きに動かす（右へドラッグ→左を向く＝SV準拠）
      const dyaw = dx * this.sensitivity;
      const dpitch = dy * this.sensitivity;
      this.yaw += dyaw;
      this.pitch += dpitch;
      this._clampPitch();
      this._yawVel = dyaw;       // 最後の移動量を慣性の初速にする
      this._pitchVel = dpitch;
      if (e.cancelable) e.preventDefault();
    };
    this._onUp = (e) => {
      if (!this._dragging) return;
      this._dragging = false;
      // ほとんど動いていない＝クリック/タップ → その地点へ前進（ストリートビュー風）
      if (this._moved < 8 && performance.now() - this._downT < 350) {
        const p = e.changedTouches ? e.changedTouches[0] : e;
        this._clickMove(p.clientX, p.clientY);
        this._yawVel = this._pitchVel = 0;
      }
    };
    const MOVE_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
      "w", "a", "s", "d", "W", "A", "S", "D", "Shift"];
    this._onKey = (e) => {
      if (MOVE_KEYS.includes(e.key)) { this._keys.add(e.key); e.preventDefault(); }
    };
    this._onKeyUp = (e) => this._keys.delete(e.key);

    this.dom.addEventListener("mousedown", this._onDown);
    window.addEventListener("mousemove", this._onMoveEvt);
    window.addEventListener("mouseup", this._onUp);
    this.dom.addEventListener("touchstart", this._onDown, { passive: false });
    this.dom.addEventListener("touchmove", this._onMoveEvt, { passive: false });
    this.dom.addEventListener("touchend", this._onUp);
    window.addEventListener("keydown", this._onKey);
    window.addEventListener("keyup", this._onKeyUp);
  }

  _clampPitch() {
    const lim = (85 * Math.PI) / 180;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  // 画面クリック位置の地面(y=groundY)へ向けて前進目標を設定（ストリートビューの「進む」相当）
  _clickMove(clientX, clientY) {
    const rect = this.dom.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const v = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(this.camera);
    const dir = v.sub(this.camera.position).normalize();
    if (dir.y >= -0.02) return; // 空（地平線より上）をクリック → 移動しない
    const t = (this.groundY - this.camera.position.y) / dir.y;
    const hit = this.camera.position.clone().add(dir.multiplyScalar(t));
    const dx = hit.x - this.camera.position.x;
    const dz = hit.z - this.camera.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) return;
    const step = Math.min(d, 28); // 1クリックで進む距離は最大28m
    this._moveTarget = {
      x: this.camera.position.x + (dx / d) * step,
      z: this.camera.position.z + (dz / d) * step,
    };
  }

  // 画面D-padから移動入力（forward/strafe: -1..1）。touchend で(0,0)に戻す。
  setMoveInput(forward, strafe) {
    this._touchMove.f = forward;
    this._touchMove.s = strafe;
  }

  faceBearing(bearingDeg) {
    this.yaw = (-bearingDeg * Math.PI) / 180;
    this.pitch = 0;
    this._yawVel = this._pitchVel = 0;
    this._moveTarget = null;
  }
  reset() { this.yaw = 0; this.pitch = 0; this._yawVel = this._pitchVel = 0; }
  resetPosition() {
    this.camera.position.set(0, this.eyeY, 0);
    this._moveTarget = null;
    if (this.onMove) this.onMove();
  }

  headingDeg() {
    return ((-this.yaw * 180) / Math.PI % 360 + 360) % 360;
  }

  // 原点からの距離制限内に収める
  _clampToLimit(p) {
    const r = Math.hypot(p.x, p.z);
    if (r > this.moveLimit) { p.x *= this.moveLimit / r; p.z *= this.moveLimit / r; }
  }

  update() {
    if (!this.enabled) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;

    // ドラッグを離した後の慣性回転（ストリートビュー風の余韻）
    if (!this._dragging &&
        (Math.abs(this._yawVel) > 1e-4 || Math.abs(this._pitchVel) > 1e-4)) {
      this.yaw += this._yawVel;
      this.pitch += this._pitchVel;
      this._clampPitch();
      this._yawVel *= 0.9;   // 減衰（約7フレームで半減）
      this._pitchVel *= 0.9;
    }

    // クリック移動: 目標へ滑らかに前進（残距離が縮むとゆっくり止まる）
    if (this._moveTarget) {
      const p = this.camera.position;
      const dx = this._moveTarget.x - p.x;
      const dz = this._moveTarget.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) {
        this._moveTarget = null;
      } else {
        const stepd = Math.min(d, 14 * dt); // 約14m/秒で前進
        p.x += (dx / d) * stepd;
        p.z += (dz / d) * stepd;
        this._clampToLimit(p);
        if (this.onMove) this.onMove();
      }
    }

    // 移動入力（キーボード＋画面D-pad）
    let f = this._touchMove.f, s = this._touchMove.s;
    if (this._keys.has("ArrowUp") || this._keys.has("w") || this._keys.has("W")) f += 1;
    if (this._keys.has("ArrowDown") || this._keys.has("s") || this._keys.has("S")) f -= 1;
    if (this._keys.has("ArrowRight") || this._keys.has("d") || this._keys.has("D")) s += 1;
    if (this._keys.has("ArrowLeft") || this._keys.has("a") || this._keys.has("A")) s -= 1;
    f = Math.max(-1, Math.min(1, f));
    s = Math.max(-1, Math.min(1, s));

    if (f !== 0 || s !== 0) {
      this._moveTarget = null; // 手動移動が割り込んだらクリック移動は中断
      const spd = this.speed * (this._keys.has("Shift") ? 3 : 1) * dt;
      // 前進方向 = カメラのyaw（北=-Z, yaw>0でCCW）。forward(-Z基準)を回転。
      const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
      const fx = -sinY * f + cosY * s;
      const fz = -cosY * f - sinY * s;
      const p = this.camera.position;
      p.x += fx * spd;
      p.z += fz * spd;
      this._clampToLimit(p);
      if (this.onMove) this.onMove();
    }

    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  dispose() {
    this.dom.removeEventListener("mousedown", this._onDown);
    window.removeEventListener("mousemove", this._onMoveEvt);
    window.removeEventListener("mouseup", this._onUp);
    this.dom.removeEventListener("touchstart", this._onDown);
    this.dom.removeEventListener("touchmove", this._onMoveEvt);
    this.dom.removeEventListener("touchend", this._onUp);
    window.removeEventListener("keydown", this._onKey);
    window.removeEventListener("keyup", this._onKeyUp);
  }
}
