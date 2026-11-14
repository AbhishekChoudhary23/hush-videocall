import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, Trash2, Undo2 } from "lucide-react";

const COLORS = ["#ff5d5d", "#ffd166", "#c9f26c", "#5db8ff", "#ffffff"];
const BRUSH = 4; // thousandths of the picture width

/**
 * The shared screen with a drawing layer on top. Everyone in the call can
 * draw. Points are stored as fractions of the picture, and the canvas is laid
 * exactly over the visible picture, so marks line up on every screen.
 */
export default function ShareStage({ client, sharer }) {
  const boxRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const active = useRef(null);
  const frame = useRef(0);
  const [drawing, setDrawing] = useState(false);
  const [color, setColor] = useState(COLORS[0]);

  useEffect(() => {
    const el = videoRef.current;
    if (el.srcObject !== sharer.stream) el.srcObject = sharer.stream;
    el.play?.().catch(() => {});
  }, [sharer.stream]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of client.strokes.values()) {
      const { pts } = stroke;
      const w = Math.max(1, (stroke.size / 1000) * width);
      ctx.strokeStyle = ctx.fillStyle = stroke.color;
      ctx.lineWidth = w;
      if (pts.length === 2) {
        ctx.beginPath();
        ctx.arc(pts[0] * width, pts[1] * height, w / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0] * width, pts[1] * height);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * width, pts[i + 1] * height);
      ctx.stroke();
    }
  }, [client]);

  const schedule = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(paint);
  }, [paint]);

  // Keep the canvas glued to the letterboxed picture inside the box.
  const layout = useCallback(() => {
    const box = boxRef.current;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!box || !video || !canvas) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      canvas.style.display = "none";
      return;
    }
    const scale = Math.min(box.clientWidth / vw, box.clientHeight / vh);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.display = "block";
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${Math.round((box.clientWidth - w) / 2)}px`;
    canvas.style.top = `${Math.round((box.clientHeight - h) / 2)}px`;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    paint();
  }, [paint]);

  useEffect(() => {
    const video = videoRef.current;
    const observer = new ResizeObserver(layout);
    observer.observe(boxRef.current);
    video.addEventListener("loadedmetadata", layout);
    video.addEventListener("resize", layout);
    client.addEventListener("anno", schedule);
    layout();
    return () => {
      observer.disconnect();
      video.removeEventListener("loadedmetadata", layout);
      video.removeEventListener("resize", layout);
      client.removeEventListener("anno", schedule);
      cancelAnimationFrame(frame.current);
    };
  }, [client, layout, schedule]);

  const point = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const clamp = (n) => Math.min(1, Math.max(0, n));
    // Four decimals is sub-pixel on any screen and keeps messages small.
    const round = (n) => Math.round(clamp(n) * 10000) / 10000;
    return [round((e.clientX - rect.left) / rect.width), round((e.clientY - rect.top) / rect.height)];
  };

  const onPointerDown = (e) => {
    if (!drawing || e.button > 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = point(e);
    active.current = client.annoStart(color, BRUSH, x, y);
  };

  const onPointerMove = (e) => {
    if (!active.current) return;
    client.annoPoints(active.current, point(e));
  };

  const onPointerUp = () => {
    active.current = null;
  };

  return (
    <div className="share">
      <div className="share-box" ref={boxRef}>
        <video ref={videoRef} autoPlay playsInline muted />
        <canvas
          ref={canvasRef}
          className={drawing ? "drawing" : ""}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <div className="share-label">
          {sharer.id === "self" ? "You are sharing your screen" : `${sharer.name} is sharing`}
        </div>
      </div>

      <div className="anno-bar" role="toolbar" aria-label="Annotation tools">
        <button
          className={`pill-btn ${drawing ? "on" : ""}`}
          onClick={() => setDrawing((d) => !d)}
          aria-pressed={drawing}
          title="Draw on the shared screen"
        >
          <Pencil size={16} /> {drawing ? "Drawing" : "Annotate"}
        </button>
        {drawing && (
          <>
            <div className="swatches" role="radiogroup" aria-label="Pen colour">
              {COLORS.map((c) => (
                <button
                  key={c}
                  role="radio"
                  aria-checked={c === color}
                  aria-label={`Colour ${c}`}
                  className={`swatch ${c === color ? "on" : ""}`}
                  style={{ "--c": c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <button className="icon-btn" onClick={() => client.annoUndo()} aria-label="Undo my last stroke" title="Undo my last stroke">
              <Undo2 size={16} />
            </button>
            <button className="icon-btn" onClick={() => client.annoClear()} aria-label="Clear all drawings" title="Clear all drawings">
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
