/**
 * Robot Head-Mounted Camera
 *
 * Creates a virtual camera that follows the robot's head_camera_rgb_frame body,
 * rendering a first-person view from the robot's perspective.
 */

import * as THREE from 'three';
import { getPosition, getQuaternion } from '../mujocoUtils.js';

export class RobotCamera {
  /**
   * @param {THREE.WebGLRenderer} renderer - The main Three.js renderer
   * @param {THREE.Scene} scene - The main scene
   */
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    // Camera settings (approximate a typical robot camera)
    this.fov = 60;
    this.width = 640;
    this.height = 480;

    // Create the camera
    this.camera = new THREE.PerspectiveCamera(
      this.fov,
      this.width / this.height,
      0.05,
      50
    );
    this.camera.name = 'RobotHeadCamera';

    // Render target for offscreen capture
    this.renderTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType
    });

    // Buffer for pixel readback
    this.pixelBuffer = new Uint8Array(this.width * this.height * 4);

    // Body index for head_camera_link (set during init)
    this.cameraBodyIndex = -1;

    // Temporary vectors
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();

    // Frame correction: Three.js camera looks along local -Z by default.
    // After MuJoCo→Three.js coordinate swizzle, the head_camera_link's
    // forward direction (robot's look direction) is along local -X in Three.js.
    // Rotate -90° around Y to map camera -Z to body -X.
    this._frameCorrection = new THREE.Quaternion();
    this._frameCorrection.setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0));
  }

  /**
   * Initialize by finding the head camera body index in the MuJoCo model.
   * @param {object} model - MuJoCo model
   * @param {object} bodies - Three.js body groups keyed by index
   */
  init(model, bodies) {
    const textDecoder = new TextDecoder('utf-8');
    const nullChar = textDecoder.decode(new ArrayBuffer(1));

    // Use head_camera_link (not head_camera_rgb_frame which has an optical
    // frame rotation that complicates the Three.js camera alignment).
    for (let b = 0; b < model.nbody; b++) {
      const name = textDecoder.decode(
        model.names.subarray(model.name_bodyadr[b])
      ).split(nullChar)[0];

      if (name === 'head_camera_link') {
        this.cameraBodyIndex = b;
        console.log(`RobotCamera: Found head_camera_link at body index ${b}`);
        return;
      }
    }

    // Fallback: try head_camera_rgb_frame
    for (let b = 0; b < model.nbody; b++) {
      const name = textDecoder.decode(
        model.names.subarray(model.name_bodyadr[b])
      ).split(nullChar)[0];

      if (name === 'head_camera_rgb_frame') {
        this.cameraBodyIndex = b;
        console.log(`RobotCamera: Fallback to head_camera_rgb_frame at body index ${b}`);
        return;
      }
    }

    console.warn('RobotCamera: Could not find head camera body in model');
  }

  /**
   * Update the camera position/rotation from MuJoCo simulation state.
   * Call this every render frame.
   * @param {object} data - MuJoCo data
   */
  update(data) {
    if (this.cameraBodyIndex < 0) return;

    // Get body position and quaternion from MuJoCo (with Three.js swizzle)
    getPosition(data.xpos, this.cameraBodyIndex, this._pos);
    getQuaternion(data.xquat, this.cameraBodyIndex, this._quat);

    this.camera.position.copy(this._pos);
    this.camera.quaternion.copy(this._quat);

    // Apply frame correction so camera looks forward
    this.camera.quaternion.multiply(this._frameCorrection);

    // Push the camera slightly forward (along its local -Z / look direction)
    // to prevent it from being inside the robot's head mesh
    const forward = new THREE.Vector3(0, 0, -1);
    forward.applyQuaternion(this.camera.quaternion);
    this.camera.position.addScaledVector(forward, 0.05);
  }

  /**
   * Create a small PiP (Picture-in-Picture) preview element.
   * @returns {HTMLCanvasElement} The preview canvas
   */
  createPreview() {
    const pipWidth = 240;
    const pipHeight = 180;

    const wrapper = document.createElement('div');
    wrapper.id = 'robot-cam-pip';
    wrapper.style.cssText = `
      position: fixed;
      bottom: 70px;
      right: 400px;
      width: ${pipWidth}px;
      height: ${pipHeight}px;
      border: 2px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      overflow: hidden;
      z-index: 1500;
      background: #000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    `;

    const label = document.createElement('div');
    label.textContent = 'Head Camera';
    label.style.cssText = `
      position: absolute;
      top: 4px;
      left: 8px;
      color: rgba(255,255,255,0.7);
      font-size: 10px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      z-index: 1;
      pointer-events: none;
      text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    `;

    const canvas = document.createElement('canvas');
    canvas.width = pipWidth;
    canvas.height = pipHeight;
    canvas.style.cssText = 'width: 100%; height: 100%; display: block;';

    wrapper.appendChild(canvas);
    wrapper.appendChild(label);
    document.body.appendChild(wrapper);

    this._pipCanvas = canvas;
    this._pipCtx = canvas.getContext('2d');
    this._pipWidth = pipWidth;
    this._pipHeight = pipHeight;

    return wrapper;
  }

  /**
   * Update the PiP preview with the current head camera view.
   * Call this from the render loop (throttled).
   */
  updatePreview() {
    if (!this._pipCtx || this.cameraBodyIndex < 0) return;

    // Save current renderer state
    const currentRenderTarget = this.renderer.getRenderTarget();
    const currentSize = new THREE.Vector2();
    this.renderer.getSize(currentSize);

    // Render to offscreen target
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.render(this.scene, this.camera);

    // Read pixels
    this.renderer.readRenderTargetPixels(
      this.renderTarget, 0, 0,
      this.width, this.height,
      this.pixelBuffer
    );

    // Restore renderer state
    this.renderer.setRenderTarget(currentRenderTarget);
    this.renderer.setSize(currentSize.x, currentSize.y, false);

    // Draw to PiP canvas (scaled down, flipped vertically)
    const imgData = this._pipCtx.createImageData(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      const srcRow = (this.height - 1 - y) * this.width * 4;
      const dstRow = y * this.width * 4;
      for (let x = 0; x < this.width * 4; x++) {
        imgData.data[dstRow + x] = this.pixelBuffer[srcRow + x];
      }
    }

    // Use a temporary canvas at full res, then drawImage to scale
    if (!this._tmpCanvas) {
      this._tmpCanvas = document.createElement('canvas');
      this._tmpCanvas.width = this.width;
      this._tmpCanvas.height = this.height;
      this._tmpCtx = this._tmpCanvas.getContext('2d');
    }
    this._tmpCtx.putImageData(imgData, 0, 0);
    this._pipCtx.drawImage(this._tmpCanvas, 0, 0, this._pipWidth, this._pipHeight);
  }

  /**
   * Capture the current view as a base64-encoded PNG image.
   * @returns {string} Base64-encoded PNG (without data: prefix)
   */
  capture() {
    if (this.cameraBodyIndex < 0) {
      return null;
    }

    // Save current renderer state
    const currentRenderTarget = this.renderer.getRenderTarget();
    const currentSize = new THREE.Vector2();
    this.renderer.getSize(currentSize);

    // Render to our offscreen target
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.render(this.scene, this.camera);

    // Read pixels
    this.renderer.readRenderTargetPixels(
      this.renderTarget,
      0, 0,
      this.width, this.height,
      this.pixelBuffer
    );

    // Restore renderer state
    this.renderer.setRenderTarget(currentRenderTarget);
    this.renderer.setSize(currentSize.x, currentSize.y, false);

    // Convert pixel buffer to PNG using canvas
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(this.width, this.height);

    // Flip vertically (WebGL reads bottom-up)
    for (let y = 0; y < this.height; y++) {
      const srcRow = (this.height - 1 - y) * this.width * 4;
      const dstRow = y * this.width * 4;
      for (let x = 0; x < this.width * 4; x++) {
        imageData.data[dstRow + x] = this.pixelBuffer[srcRow + x];
      }
    }
    ctx.putImageData(imageData, 0, 0);

    // Convert to base64 PNG (strip the data:image/png;base64, prefix)
    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.split(',')[1];
  }
}
