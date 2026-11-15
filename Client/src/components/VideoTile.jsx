import { useEffect, useRef } from "react";
import { MicOff } from "lucide-react";
import { hueFor, initials } from "../lib/util";

/**
 * One participant. The <video> stays mounted even while the camera is off,
 * because it is also what plays that person's audio.
 */
export default function VideoTile({ stream, name, label, self = false, audioOn, videoOn, connecting = false, failed = false }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream || null;
    // Autoplay can be refused until the element is nudged; a failure here is harmless.
    if (stream) el.play?.().catch(() => {});
  }, [stream, videoOn]);

  return (
    <div className="tile">
      {stream && <video ref={ref} className={self ? "mirror" : ""} autoPlay playsInline muted={self} />}
      {!videoOn && (
        <div className="tile-cover">
          <div className="avatar" style={{ "--hue": hueFor(name) }}>
            {initials(name)}
          </div>
        </div>
      )}
      <div className="tile-label">
        {!audioOn && <MicOff size={14} aria-label="Muted" />}
        <span>{label || name}</span>
        {connecting && <span className="tile-status">connecting…</span>}
        {failed && <span className="tile-status tile-failed">can&apos;t connect</span>}
      </div>
    </div>
  );
}
