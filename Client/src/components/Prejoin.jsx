import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Link2, Mic, MicOff, ShieldCheck, Video, VideoOff } from "lucide-react";
import { inviteLink } from "../lib/crypto";
import { LocalMedia } from "../lib/media";
import { cleanName } from "../lib/room";
import { copyText, randomName, useEvent } from "../lib/util";
import VideoTile from "./VideoTile";

export default function Prejoin({ code, onJoin, onBack }) {
  const [media, setMedia] = useState(null);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState(randomName);
  const [copied, setCopied] = useState(false);
  const handedOff = useRef(false);

  useEffect(() => {
    const m = new LocalMedia();
    setMedia(m);
    setReady(false);
    m.init().finally(() => setReady(true));
    return () => {
      // Keep the camera running only if it was passed on to the call.
      if (!handedOff.current) m.stop();
    };
  }, []);

  useEvent(media, "change");

  const copy = async () => {
    if (await copyText(inviteLink(code))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  const join = (e) => {
    e.preventDefault();
    if (!media) return;
    handedOff.current = true;
    onJoin(cleanName(name), media);
  };

  const problem = media?.videoError || media?.audioError;

  return (
    <div className="center-page">
      <main className="prejoin">
        <button className="link-btn" onClick={onBack}>
          <ArrowLeft size={16} /> Back
        </button>

        <div className="prejoin-grid">
          <div className="preview">
            <VideoTile
              self
              stream={media?.stream}
              name={cleanName(name)}
              label="You"
              audioOn={!!media?.audioOn}
              videoOn={!!media?.videoOn}
            />
            <div className="preview-controls">
              <button
                className={`round ${media?.audioOn ? "" : "off"}`}
                onClick={() => media?.setAudio(!media.audioOn)}
                disabled={!ready}
                aria-label={media?.audioOn ? "Mute microphone" : "Unmute microphone"}
                aria-pressed={!media?.audioOn}
              >
                {media?.audioOn ? <Mic size={20} /> : <MicOff size={20} />}
              </button>
              <button
                className={`round ${media?.videoOn ? "" : "off"}`}
                onClick={() => media?.setVideo(!media.videoOn)}
                disabled={!ready}
                aria-label={media?.videoOn ? "Turn camera off" : "Turn camera on"}
                aria-pressed={!media?.videoOn}
              >
                {media?.videoOn ? <Video size={20} /> : <VideoOff size={20} />}
              </button>
            </div>
          </div>

          <form className="prejoin-form" onSubmit={join}>
            <h1>Ready to join?</h1>
            <p className="lede">Check how you look and sound. You can join with camera or mic off.</p>

            <label className="field">
              <span>Your name</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                autoComplete="off"
                placeholder="Anything you like"
              />
            </label>

            <button className="btn btn-primary btn-lg" type="submit" disabled={!media}>
              Join call
            </button>

            <button type="button" className="code-chip" onClick={copy} title="Copy invite link">
              <span className="mono">{code}</span>
              {copied ? <Check size={16} /> : <Link2 size={16} />}
              <span className="code-chip-hint">{copied ? "Link copied" : "Copy invite link"}</span>
            </button>

            {problem && (
              <p className="field-error" role="alert">
                {problem}
              </p>
            )}

            <p className="fine">
              <ShieldCheck size={14} /> Only people with this invite can join. Treat the link like a key.
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
