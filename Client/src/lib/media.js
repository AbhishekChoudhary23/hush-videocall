/**
 * Owns the local camera and microphone.
 *
 * `stream` is a stable MediaStream object: tracks are swapped in and out of it
 * so video elements and peer connections can keep one reference for the whole
 * call. Turning the camera off stops the track, which also turns the camera
 * light off. Muting only disables the track so unmuting is instant.
 */
export class LocalMedia extends EventTarget {
  stream = new MediaStream();
  audioTrack = null;
  videoTrack = null;
  audioOn = false;
  videoOn = false;
  audioError = null;
  videoError = null;
  stopped = false;

  /** Asks for both devices, falling back to whichever one is available. */
  async init() {
    try {
      const both = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: VIDEO });
      if (this.stopped) return stopAll(both);
      this.#setAudioTrack(both.getAudioTracks()[0] || null);
      this.#setVideoTrack(both.getVideoTracks()[0] || null);
      this.#changed();
    } catch {
      await Promise.all([this.setAudio(true), this.setVideo(true)]);
    }
  }

  async setAudio(on) {
    if (this.stopped) return;
    if (on && !this.audioTrack) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
        if (this.stopped) return stopAll(s);
        this.audioError = null;
        this.#setAudioTrack(s.getAudioTracks()[0]);
      } catch (err) {
        this.audioError = describe(err, "microphone");
      }
    } else if (this.audioTrack) {
      this.audioTrack.enabled = on;
      this.audioOn = on;
    }
    this.#changed();
  }

  async setVideo(on) {
    if (this.stopped) return;
    if (on && !this.videoTrack) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: VIDEO });
        if (this.stopped) return stopAll(s);
        this.videoError = null;
        this.#setVideoTrack(s.getVideoTracks()[0]);
      } catch (err) {
        this.videoError = describe(err, "camera");
      }
    } else if (!on && this.videoTrack) {
      this.#setVideoTrack(null);
    }
    this.#changed();
  }

  stop() {
    this.stopped = true;
    this.#setAudioTrack(null);
    this.#setVideoTrack(null);
    this.#changed();
  }

  #setAudioTrack(track) {
    if (this.audioTrack) {
      this.stream.removeTrack(this.audioTrack);
      this.audioTrack.stop();
    }
    this.audioTrack = track;
    this.audioOn = !!track;
    if (track) {
      this.stream.addTrack(track);
      track.addEventListener("ended", () => {
        if (this.audioTrack === track) {
          this.#setAudioTrack(null);
          this.#changed();
        }
      });
    }
  }

  #setVideoTrack(track) {
    if (this.videoTrack) {
      this.stream.removeTrack(this.videoTrack);
      this.videoTrack.stop();
    }
    this.videoTrack = track;
    this.videoOn = !!track;
    if (track) {
      this.stream.addTrack(track);
      track.addEventListener("ended", () => {
        if (this.videoTrack === track) {
          this.#setVideoTrack(null);
          this.#changed();
        }
      });
    }
  }

  #changed() {
    this.dispatchEvent(new Event("change"));
  }
}

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" };

function stopAll(stream) {
  stream.getTracks().forEach((t) => t.stop());
}

function describe(err, device) {
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return `Permission to use the ${device} was denied. Allow it in your browser's site settings.`;
    case "NotFoundError":
    case "OverconstrainedError":
      return `No ${device} was found.`;
    case "NotReadableError":
      return `The ${device} is in use by another app.`;
    default:
      return `Could not start the ${device}.`;
  }
}
