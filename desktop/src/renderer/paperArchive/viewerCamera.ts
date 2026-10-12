// Ported from RhineLabUI (MIT, Copyright (c) 2026 LBEILC, https://github.com/LBEILC/RhineLabUI):
// src/viewer-camera.ts.
import { MathUtils, Spherical, Vector3, type PerspectiveCamera } from 'three'

const shortestAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle))

/**
 * OrbitControls records the requested pose; this camera is what is rendered. Spherical
 * interpolation avoids cutting through the model on a large reset.
 */
export class ViewerCameraMotion {
  readonly focus = new Vector3()
  private readonly pose = new Spherical()
  private readonly desired = new Spherical()
  private readonly offset = new Vector3()
  private readonly resetFrom = new Spherical()
  private readonly resetFocus = new Vector3()
  private elapsed = 0
  resetting = false

  constructor(private readonly camera: PerspectiveCamera) {}

  snap(goal: PerspectiveCamera, target: Vector3): void {
    this.resetting = false
    this.focus.copy(target)
    this.pose.setFromVector3(this.offset.copy(goal.position).sub(target))
    this.apply()
  }

  reset(): void {
    this.resetFrom.copy(this.pose)
    this.resetFocus.copy(this.focus)
    this.elapsed = 0
    this.resetting = true
  }

  interruptReset(goal: PerspectiveCamera, target: Vector3): void {
    if (!this.resetting) return
    this.resetting = false
    goal.position.copy(this.camera.position)
    target.copy(this.focus)
    goal.lookAt(target)
  }

  update(goal: PerspectiveCamera, target: Vector3, dt: number, reduced = false): void {
    if (reduced) {
      this.snap(goal, target)
      return
    }
    this.desired.setFromVector3(this.offset.copy(goal.position).sub(target))
    if (this.resetting) {
      this.elapsed += Math.max(0, dt)
      const t = Math.min(1, this.elapsed / 0.56)
      const p = 1 - (1 - t) ** 3
      this.focus.lerpVectors(this.resetFocus, target, p)
      this.interpolate(this.resetFrom, this.desired, p, p)
      if (t === 1) this.resetting = false
    } else {
      const pan = 1 - Math.exp(-13 * Math.max(0, dt))
      const orbit = 1 - Math.exp(-9 * Math.max(0, dt))
      const zoom = 1 - Math.exp(-15 * Math.max(0, dt))
      this.focus.lerp(target, pan)
      this.interpolate(this.pose, this.desired, orbit, zoom)
      if (this.focus.distanceToSquared(target) < 1e-10) this.focus.copy(target)
    }
    this.apply()
  }

  private interpolate(from: Spherical, to: Spherical, angle: number, radius: number): void {
    // Interpolate logarithmic distance so zoom in and zoom out feel symmetric.
    this.pose.radius = Math.exp(MathUtils.lerp(Math.log(from.radius), Math.log(to.radius), radius))
    this.pose.phi = MathUtils.lerp(from.phi, to.phi, angle)
    this.pose.theta = from.theta + shortestAngle(to.theta - from.theta) * angle
    this.pose.makeSafe()
  }

  private apply(): void {
    this.camera.position.copy(this.offset.setFromSpherical(this.pose)).add(this.focus)
    this.camera.lookAt(this.focus)
  }
}
