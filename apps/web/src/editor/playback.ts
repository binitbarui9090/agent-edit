import { TICKS_PER_SECOND, ticksPerFrame } from '@agent-edit/shared';
import { clipAt, clipEnd, timelineDuration } from '@agent-edit/timeline-engine';
import type {
  CaptionClip,
  MediaClip,
  TimelineClip,
  TimelineState,
  TimelineTrack,
  TrackType,
} from '@agent-edit/validation';

const VISUAL: ReadonlySet<TrackType> = new Set(['VIDEO', 'BROLL', 'OVERLAYS']);
/** How far out the next clip starts loading, so a cut does not show a gap. */
const PREROLL_SECONDS = 1.5;
/** Tolerated drift during playback. Seeking to fix less than this stutters more than it helps. */
const MAX_DRIFT_SECONDS = 0.15;

interface Slot {
  active: HTMLVideoElement;
  next: HTMLVideoElement;
  activeClipId: string | null;
  nextClipId: string | null;
}

function createVideo(stage: HTMLElement, visual: boolean, zIndex: number): HTMLVideoElement {
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:contain;visibility:hidden;z-index:${zIndex};`;
  if (!visual) video.style.display = 'none';
  stage.appendChild(video);
  return video;
}

type Listener = (time: number) => void;

/**
 * Plays a timeline by driving real video elements from a master clock. It lives outside React: the
 * clock runs every animation frame, and rendering through React at that rate would be wasteful.
 *
 * This is a practical preview, not a frame-accurate one. `<video>` seeks land within about a frame,
 * rapid multi-track cuts can show a brief hold, and gains above 100% only apply in the final render.
 * Timeline data and the render stay exact either way.
 */
export class PlaybackEngine {
  private state: TimelineState | null = null;
  private urls = new Map<string, string>();
  private slots = new Map<string, Slot>();
  private caption: HTMLDivElement;
  private shownCaption: string | null = null;
  private frameRequest = 0;
  private listeners = new Set<Listener>();
  private playingListeners = new Set<(playing: boolean) => void>();
  private clockTicks = 0;
  private anchorNow = 0;
  private anchorTime = 0;
  private playing = false;
  private buffering = false;

  constructor(private readonly stage: HTMLElement) {
    this.caption = document.createElement('div');
    this.caption.dataset.testid = 'caption-layer';
    this.caption.style.cssText =
      'position:absolute;left:5%;right:5%;z-index:100;text-align:center;pointer-events:none;white-space:pre-wrap;';
    stage.appendChild(this.caption);
    this.loop = this.loop.bind(this);
    this.frameRequest = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.frameRequest);
    for (const slot of this.slots.values()) {
      for (const video of [slot.active, slot.next]) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
      }
    }
    this.slots.clear();
    this.caption.remove();
    this.listeners.clear();
    this.playingListeners.clear();
  }

  setTimeline(state: TimelineState): void {
    this.state = state;
    const clamped = this.clockTicks > this.duration;
    if (clamped) {
      this.clockTicks = this.duration;
      this.anchor();
    }
    this.syncSlots();
    this.render();
    // Without this, removing the last clips leaves the playhead drawn where the clock no longer is.
    if (clamped) this.notify();
  }

  setMediaUrl(mediaId: string, url: string): void {
    if (this.urls.get(mediaId) === url) return;
    this.urls.set(mediaId, url);
    this.render();
  }

  get time(): number {
    return this.clockTicks;
  }

  get duration(): number {
    return this.state ? timelineDuration(this.state) : 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.clockTicks);
    return () => this.listeners.delete(listener);
  }

  subscribePlaying(listener: (playing: boolean) => void): () => void {
    this.playingListeners.add(listener);
    return () => this.playingListeners.delete(listener);
  }

  play(): void {
    if (this.playing || this.duration === 0) return;
    if (this.clockTicks >= this.duration) this.clockTicks = 0;
    this.setPlaying(true);
    this.anchor();
    this.render();
  }

  pause(): void {
    if (!this.playing) return;
    this.setPlaying(false);
    for (const slot of this.slots.values()) slot.active.pause();
    this.render();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(ticks: number): void {
    const frame = this.state ? ticksPerFrame(this.state.frameRate) : 1;
    const snapped = Math.round(ticks / frame) * frame;
    this.clockTicks = Math.max(0, Math.min(snapped, this.duration));
    this.anchor();
    this.render();
    this.notify();
  }

  stepFrames(frames: number): void {
    if (!this.state) return;
    this.pause();
    this.seek(this.clockTicks + frames * ticksPerFrame(this.state.frameRate));
  }

  private setPlaying(playing: boolean) {
    this.playing = playing;
    for (const listener of this.playingListeners) listener(playing);
  }

  private anchor() {
    this.anchorNow = performance.now();
    this.anchorTime = this.clockTicks;
  }

  private notify() {
    for (const listener of this.listeners) listener(this.clockTicks);
  }

  private loop(now: number) {
    this.frameRequest = requestAnimationFrame(this.loop);
    if (!this.playing) return;
    if (this.buffering) {
      // Hold the clock while footage loads, rather than letting picture and timeline drift apart.
      this.anchor();
    } else {
      this.clockTicks = this.anchorTime + ((now - this.anchorNow) / 1000) * TICKS_PER_SECOND;
    }
    if (this.clockTicks >= this.duration) {
      this.clockTicks = this.duration;
      this.pause();
    }
    this.render();
    this.notify();
  }

  private syncSlots() {
    if (!this.state) return;
    const wanted = this.state.tracks.filter((track) => track.type !== 'CAPTIONS');
    const count = wanted.length;
    wanted.forEach((track, index) => {
      if (this.slots.has(track.id)) return;
      const visual = VISUAL.has(track.type);
      // Track order is top first, so earlier tracks get higher z-indexes.
      const zIndex = count - index;
      this.slots.set(track.id, {
        active: createVideo(this.stage, visual, zIndex),
        next: createVideo(this.stage, visual, zIndex),
        activeClipId: null,
        nextClipId: null,
      });
    });
  }

  private render() {
    if (!this.state) return;
    let buffering = false;
    let caption: { clip: CaptionClip } | null = null;
    for (const track of this.state.tracks) {
      if (track.type === 'CAPTIONS') {
        const clip = clipAt(track, this.clockTicks);
        if (clip?.kind === 'caption' && clip.enabled) caption = { clip };
        continue;
      }
      if (this.renderTrack(track)) buffering = true;
    }
    this.buffering = this.playing && buffering;
    this.renderCaption(caption?.clip ?? null);
  }

  /** Returns true when this track is holding up playback by loading. */
  private renderTrack(track: TimelineTrack): boolean {
    const slot = this.slots.get(track.id);
    if (!slot) return false;
    const found = clipAt(track, this.clockTicks);
    const clip = found?.kind === 'media' && found.enabled ? found : null;

    if (!clip) {
      this.hide(slot.active);
      slot.activeClipId = null;
      this.preroll(track, slot);
      return false;
    }

    if (slot.activeClipId !== clip.id) {
      if (slot.nextClipId === clip.id) {
        // The next clip is already loaded and cued, so the cut needs no seek.
        [slot.active, slot.next] = [slot.next, slot.active];
        slot.nextClipId = null;
        this.hide(slot.next);
      }
      slot.activeClipId = clip.id;
    }

    const url = this.urls.get(clip.sourceMediaId);
    if (!url) return this.playing;
    const video = slot.active;
    if (video.dataset.url !== url) {
      video.dataset.url = url;
      video.src = url;
    }

    const desired = this.sourceSeconds(clip);
    const drift = Math.abs(video.currentTime - desired);
    if (this.playing ? drift > MAX_DRIFT_SECONDS : drift > 0.5 / this.fps()) {
      if (video.readyState >= 1) video.currentTime = desired;
    }

    this.applyLook(video, track, clip);
    video.playbackRate = clip.speed;
    if (this.playing && video.paused) void video.play().catch(() => undefined);
    if (!this.playing && !video.paused) video.pause();

    this.preroll(track, slot);
    return VISUAL.has(track.type) && (video.readyState < 2 || video.seeking);
  }

  /** Loads and cues the upcoming clip while it is still off screen. */
  private preroll(track: TimelineTrack, slot: Slot) {
    const horizon = this.clockTicks + PREROLL_SECONDS * TICKS_PER_SECOND;
    const upcoming = track.clips.find(
      (clip): clip is MediaClip =>
        clip.kind === 'media' &&
        clip.enabled &&
        clip.id !== slot.activeClipId &&
        clip.start > this.clockTicks &&
        clip.start <= horizon,
    );
    if (!upcoming) {
      slot.nextClipId = null;
      return;
    }
    const url = this.urls.get(upcoming.sourceMediaId);
    if (!url) return;
    if (slot.next.dataset.url !== url) {
      slot.next.dataset.url = url;
      slot.next.src = url;
    }
    const cue = upcoming.sourceIn / TICKS_PER_SECOND;
    if (slot.nextClipId !== upcoming.id || Math.abs(slot.next.currentTime - cue) > 0.1) {
      if (slot.next.readyState >= 1) slot.next.currentTime = cue;
    }
    slot.nextClipId = upcoming.id;
  }

  private fps(): number {
    return this.state ? this.state.frameRate.num / this.state.frameRate.den : 30;
  }

  private sourceSeconds(clip: MediaClip): number {
    return (clip.sourceIn + (this.clockTicks - clip.start) * clip.speed) / TICKS_PER_SECOND;
  }

  private hide(video: HTMLVideoElement) {
    if (!video.paused) video.pause();
    video.style.visibility = 'hidden';
    video.muted = true;
  }

  /** A clip's volume and opacity right now, including fades and transitions at its edges. */
  private edgeLevel(clip: TimelineClip): { gain: number; opacity: number } {
    const into = this.clockTicks - clip.start;
    const left = clipEnd(clip) - this.clockTicks;
    let gain = 1;
    if (clip.audio.fadeIn > 0) gain = Math.min(gain, into / clip.audio.fadeIn);
    if (clip.audio.fadeOut > 0) gain = Math.min(gain, left / clip.audio.fadeOut);
    let opacity = 1;
    if (clip.transitionIn) opacity = Math.min(opacity, into / clip.transitionIn.duration);
    if (clip.transitionOut) opacity = Math.min(opacity, left / clip.transitionOut.duration);
    return { gain: Math.max(0, gain), opacity: Math.max(0, opacity) };
  }

  private applyLook(video: HTMLVideoElement, track: TimelineTrack, clip: MediaClip) {
    const { gain, opacity } = this.edgeLevel(clip);
    const { x, y, scale, rotation, opacity: base } = clip.transform;
    video.muted = track.muted;
    // <video> caps at 100%. The render uses the true gain.
    video.volume = Math.min(1, clip.volume * track.volume * gain);
    if (VISUAL.has(track.type)) {
      video.style.visibility = 'visible';
      video.style.opacity = String(base * opacity);
      video.style.transform = `translate(${x * 100}%, ${y * 100}%) scale(${scale}) rotate(${rotation}deg)`;
    }
  }

  private renderCaption(clip: CaptionClip | null) {
    const key = clip ? `${clip.id}|${clip.text}|${JSON.stringify(clip.style)}` : null;
    if (key === this.shownCaption) return;
    this.shownCaption = key;
    const { caption } = this;
    if (!clip) {
      caption.replaceChildren();
      return;
    }
    const { style } = clip;
    const stageHeight = this.state?.height ?? 1080;
    const line = document.createElement('span');
    // textContent, so a transcript can never inject markup into the page.
    line.textContent = clip.text;
    line.style.cssText = `display:inline;padding:0.1em 0.35em;box-decoration-break:clone;-webkit-box-decoration-break:clone;line-height:1.35;`;
    line.style.fontFamily = `"${style.font}", sans-serif`;
    line.style.fontSize = `calc(${(style.size / stageHeight) * 100} * 1cqh)`;
    line.style.color = style.color;
    line.style.background = style.background ?? 'transparent';
    caption.style.top = style.position === 'top' ? '6%' : style.position === 'middle' ? '50%' : '';
    caption.style.bottom = style.position === 'bottom' ? '6%' : '';
    caption.style.transform = style.position === 'middle' ? 'translateY(-50%)' : '';
    caption.replaceChildren(line);
  }
}
