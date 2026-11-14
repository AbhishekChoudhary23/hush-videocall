import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { generateCode, isCryptoAvailable, parseCode } from "./lib/crypto";
import { RoomClient } from "./lib/room";
import Home from "./components/Home";
import Prejoin from "./components/Prejoin";
import Call from "./components/Call";

const readCode = () => parseCode(window.location.hash.slice(1));

export default function App() {
  const [code, setCode] = useState(readCode);
  const [session, setSession] = useState(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    const onHash = () => {
      setCode(readCode());
      setEnded(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const goHome = useCallback(() => {
    // Drop the invite code from the address bar as well as from state.
    window.history.replaceState(null, "", window.location.pathname);
    setCode(null);
    setEnded(false);
  }, []);

  const openRoom = useCallback((next) => {
    window.location.hash = next;
    setCode(next);
    setEnded(false);
  }, []);

  const join = useCallback(
    (name, media) => {
      const client = new RoomClient({ code, name, media });
      client.connect();
      setSession({ client, media });
    },
    [code]
  );

  const leave = useCallback(() => {
    session?.client.leave();
    session?.media.stop();
    setSession(null);
    setEnded(true);
  }, [session]);

  if (!isCryptoAvailable()) {
    return (
      <div className="center-page">
        <div className="card notice">
          <ShieldAlert size={28} />
          <h2>A secure connection is required</h2>
          <p>
            Encryption, camera and microphone only work over HTTPS (or on localhost). Open this page with
            an https:// address.
          </p>
        </div>
      </div>
    );
  }

  if (session) return <Call client={session.client} media={session.media} onLeave={leave} />;
  if (code && !ended) return <Prejoin code={code} onJoin={join} onBack={goHome} />;
  return (
    <Home
      ended={ended}
      onRejoin={code ? () => setEnded(false) : null}
      onCreate={() => openRoom(generateCode())}
      onJoin={openRoom}
    />
  );
}
