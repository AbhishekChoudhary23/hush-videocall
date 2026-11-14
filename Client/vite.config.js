import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the client talks to its own origin and Vite forwards the
// signaling traffic to the Node server, so no URL has to be hard-coded.
const SERVER = process.env.SIGNALING_URL || "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/socket.io": { target: SERVER, ws: true },
    },
  },
});
