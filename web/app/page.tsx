"use client";

import { useEffect, useRef, useState } from "react";

import { QRCodeSVG } from "qrcode.react";

import {
  decryptChunk,
  encryptChunk,
  hashBlob,
  importSecret,
  newSecret,
} from "../lib/crypto";

import { formatBytes, newRoomId } from "../lib/format";
import { createPeer } from "../lib/webrtc";

const CHUNK = 48 * 1024;

const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 512 * 1024;

const CONNECTION_TIMEOUT = 30_000;

const SIGNAL_URL =
  process.env.NEXT_PUBLIC_SIGNALING_URL ||
  "wss://dropsend-signaling.dropsend.workers.dev";

type Role = "sender" | "receiver";

type Msg = {
  type: string;
  [key: string]: unknown;
};

type RxFile = {
  id: string;
  name: string;
  size: number;
  mime: string;
  chunks: Map<number, ArrayBuffer>;
  total: number;
  received: number;
  expectedHash?: string;
  writable?: FileSystemWritableFileStream;
};

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [role, setRole] = useState<Role | null>(null);
  const [room, setRoom] = useState("");
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState("Choose files to begin.");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [transferred, setTransferred] = useState(0);
  const [currentName, setCurrentName] = useState("");
  const [complete, setComplete] = useState(false);
  const [drag, setDrag] = useState(false);

  const roleRef = useRef<Role | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);

  const keyRef = useRef<CryptoKey | null>(null);

  const filesRef = useRef<File[]>([]);
  const rxRef = useRef<RxFile | null>(null);

  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);

  const sendStarted = useRef(false);
  const connectionTimer = useRef<number | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1));

    const r = params.get("room");
    const k = params.get("key");

    if (r && k) {
      roleRef.current = "receiver";

      setRole("receiver");
      setRoom(r);
      setSecret(k);

      void joinReceiver(r, k);
    }

    return () => {
      cleanupConnection();
    };
  }, []);

  function clearConnectionTimer() {
    if (connectionTimer.current !== null) {
      window.clearTimeout(connectionTimer.current);
      connectionTimer.current = null;
    }
  }

  function startConnectionTimer() {
    clearConnectionTimer();

    connectionTimer.current = window.setTimeout(() => {
      const pc = pcRef.current;

      if (!pc || pc.connectionState === "connected") {
        return;
      }

      fail(
        "Could not establish a direct peer-to-peer connection. " +
          "DropSend does not use relay servers. " +
          "Try connecting both devices to the same Wi-Fi or switching to another network.",
      );
    }, CONNECTION_TIMEOUT);
  }

  function cleanupConnection() {
    clearConnectionTimer();

    try {
      wsRef.current?.close();
    } catch {}

    try {
      dcRef.current?.close();
    } catch {}

    try {
      pcRef.current?.close();
    } catch {}

    wsRef.current = null;
    dcRef.current = null;
    pcRef.current = null;

    pendingCandidates.current = [];
  }

  function setSelected(list: FileList | File[]) {
    const next = Array.from(list);

    filesRef.current = next;
    setFiles(next);
    setError("");
  }

  function fail(message: string) {
    clearConnectionTimer();

    setError(message);
    setStatus("Transfer stopped.");
  }

  function sendSignal(payload: unknown) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }

  async function connect(
    roomId: string,
    nextRole: Role,
    ready: () => Promise<void>,
  ) {
    const ws = new WebSocket(
      `${SIGNAL_URL.replace(/\/$/, "")}/ws/${encodeURIComponent(roomId)}`,
    );

    wsRef.current = ws;

    ws.onopen = () => {
      sendSignal({
        type: "join",
        role: nextRole,
      });
    };

    ws.onerror = () => {
      fail(
        "Could not connect to signaling. Check the signaling URL and network.",
      );
    };

    ws.onclose = () => {
      if (roleRef.current && !complete) {
        setStatus("Signaling connection closed.");
      }
    };

    ws.onmessage = async (ev) => {
      try {
        const m = JSON.parse(ev.data) as Msg;

        if (m.type === "peer-ready") {
          setStatus("Peer found. Negotiating direct connection…");

          startConnectionTimer();

          await ready();
        } else if (m.type === "signal") {
          await handleSignal(
            m.data as RTCSessionDescriptionInit | RTCIceCandidateInit,
          );
        } else if (m.type === "peer-left") {
          clearConnectionTimer();

          setStatus("The other device disconnected.");
        } else if (m.type === "error") {
          fail(String(m.message || "Signaling error"));
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : "Invalid signaling message.");
      }
    };
  }

  async function startSender() {
    if (!filesRef.current.length) {
      setError("Select at least one file.");
      return;
    }

    const r = newRoomId();
    const k = newSecret();

    setRoom(r);
    setSecret(k);
    setRole("sender");

    roleRef.current = "sender";

    setComplete(false);
    setProgress(0);
    setTransferred(0);
    setCurrentName("");
    setError("");

    sendStarted.current = false;

    try {
      keyRef.current = await importSecret(k);

      setStatus("Waiting for recipient…");

      await connect(r, "sender", createSenderPeer);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Could not start transfer.");
    }
  }

  async function joinReceiver(r: string, k: string) {
    try {
      keyRef.current = await importSecret(k);

      setStatus("Connecting to sender…");

      await connect(r, "receiver", createReceiverPeer);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Invalid transfer link.");
    }
  }

  function handlePeerConnectionState(pc: RTCPeerConnection) {
    if (pc.connectionState === "connected") {
      clearConnectionTimer();

      setStatus("Peer-to-peer connection established.");
    }

    if (pc.connectionState === "disconnected") {
      setStatus("Peer-to-peer connection temporarily disconnected…");
    }

    if (pc.connectionState === "failed") {
      clearConnectionTimer();

      fail(
        "Direct peer-to-peer connection could not be established. " +
          "DropSend does not use relay servers. " +
          "Try connecting both devices to the same Wi-Fi or switching to another network.",
      );
    }

    if (pc.connectionState === "closed") {
      clearConnectionTimer();
    }
  }

  async function logConnectionType(pc: RTCPeerConnection) {
    try {
      const stats = await pc.getStats();

      for (const report of stats.values()) {
        if (report.type !== "candidate-pair") {
          continue;
        }

        if (report.state !== "succeeded") {
          continue;
        }

        const localCandidate = stats.get(report.localCandidateId);

        const remoteCandidate = stats.get(report.remoteCandidateId);

        if (localCandidate?.type && remoteCandidate?.type) {
          const localType = String(localCandidate.type);
          const remoteType = String(remoteCandidate.type);

          if (localType === "host" && remoteType === "host") {
            setStatus("Direct local peer-to-peer connection established.");
          } else if (localType === "srflx" || remoteType === "srflx") {
            setStatus("Direct Internet peer-to-peer connection established.");
          }

          return;
        }
      }
    } catch {
      // Connection diagnostics are informational only.
    }
  }

  async function createSenderPeer() {
    const pc = createPeer();

    pcRef.current = pc;
    console.log("[WebRTC] SENDER peer created");

    pc.oniceconnectionstatechange = () => {
      console.log("[WebRTC] SENDER ICE:", pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log("[WebRTC] SENDER CONNECTION:", pc.connectionState);
    };

    pc.onsignalingstatechange = () => {
      console.log("[WebRTC] SENDER SIGNALING:", pc.signalingState);
    };
    const dc = pc.createDataChannel("dropsend-v1", {
      ordered: true,
    });

    setupChannel(dc);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({
          type: "signal",
          data: e.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      void logConnectionType(pc);

      handlePeerConnectionState(pc);
    };

    const offer = await pc.createOffer();

    await pc.setLocalDescription(offer);

    sendSignal({
      type: "signal",
      data: offer,
    });
  }

  async function createReceiverPeer() {
    const pc = createPeer();

    pcRef.current = pc;
    console.log("[WebRTC] RECEIVER peer created");

    pc.oniceconnectionstatechange = () => {
      console.log("[WebRTC] RECEIVER ICE:", pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log("[WebRTC] RECEIVER CONNECTION:", pc.connectionState);
    };

    pc.onsignalingstatechange = () => {
      console.log("[WebRTC] RECEIVER SIGNALING:", pc.signalingState);
    };
    pc.ondatachannel = (e) => {
      setupChannel(e.channel);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({
          type: "signal",
          data: e.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      void logConnectionType(pc);

      handlePeerConnectionState(pc);
    };
  }

  async function handleSignal(
    data: RTCSessionDescriptionInit | RTCIceCandidateInit,
  ) {
    console.log("[WebRTC] RECEIVED SIGNAL:", data);
    const pc = pcRef.current;

    if (!pc) {
      return;
    }

    if ("sdp" in data && data.sdp) {
      await pc.setRemoteDescription(data as RTCSessionDescriptionInit);

      for (const candidate of pendingCandidates.current) {
        await pc.addIceCandidate(candidate);
      }

      pendingCandidates.current = [];

      if (data.type === "offer") {
        const answer = await pc.createAnswer();

        await pc.setLocalDescription(answer);

        sendSignal({
          type: "signal",
          data: answer,
        });
      }

      return;
    }

    if ("candidate" in data && data.candidate) {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(data as RTCIceCandidateInit);
      } else {
        pendingCandidates.current.push(data as RTCIceCandidateInit);
      }
    }
  }

  function setupChannel(dc: RTCDataChannel) {
    dcRef.current = dc;

    dc.binaryType = "arraybuffer";

    dc.bufferedAmountLowThreshold = LOW_WATER;

    dc.onopen = () => {
      clearConnectionTimer();

      setStatus("Encrypted peer-to-peer channel ready.");

      if (roleRef.current === "sender" && !sendStarted.current) {
        sendStarted.current = true;

        void sendAll(dc);
      }
    };

    dc.onerror = () => {
      fail("Data channel error.");
    };

    dc.onclose = () => {
      if (!complete) {
        setStatus("Peer-to-peer channel closed.");
      }
    };

    dc.onmessage = (e) => {
      void receiveMessage(e.data).catch((err) =>
        fail(
          err instanceof Error
            ? err.message
            : "Could not process received data.",
        ),
      );
    };
  }

  async function sendPacket(dc: RTCDataChannel, packet: ArrayBuffer) {
    if (dc.readyState !== "open") {
      throw new Error("Connection closed during transfer.");
    }

    if (dc.bufferedAmount > HIGH_WATER) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();

          reject(new Error("Timed out waiting for network backpressure."));
        }, 30_000);

        const cleanup = () => {
          window.clearTimeout(timeout);

          dc.removeEventListener("bufferedamountlow", onLow);
        };

        const onLow = () => {
          cleanup();

          resolve();
        };

        dc.addEventListener("bufferedamountlow", onLow, { once: true });
      });
    }

    dc.send(packet);
  }

  async function sendAll(dc: RTCDataChannel) {
    try {
      setStatus("Sending files…");

      let totalTransferred = 0;
      let totalBytes = filesRef.current.reduce(
        (sum, file) => sum + file.size,
        0,
      );

      for (
        let fileIndex = 0;
        fileIndex < filesRef.current.length;
        fileIndex++
      ) {
        const file = filesRef.current[fileIndex];

        const id = `f${fileIndex}-${crypto.randomUUID()}`;

        const total = Math.ceil(file.size / CHUNK);

        dc.send(
          JSON.stringify({
            type: "file-start",
            id,
            name: file.name,
            size: file.size,
            mime: file.type || "application/octet-stream",
            total,
            chunkSize: CHUNK,
          }),
        );

        for (let i = 0; i < total; i++) {
          const plain = await file
            .slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK))
            .arrayBuffer();

          const encrypted = await encryptChunk(keyRef.current!, plain, i);

          await sendPacket(dc, encrypted);

          totalTransferred += plain.byteLength;

          setTransferred(totalTransferred);

          setProgress(file.size ? (totalTransferred / totalBytes) * 100 : 100);

          setCurrentName(file.name);
        }

        dc.send(
          JSON.stringify({
            type: "file-end",
            id,
            sha256: await hashBlob(file),
          }),
        );
      }

      dc.send(
        JSON.stringify({
          type: "all-done",
        }),
      );

      setComplete(true);
      setStatus("All files sent.");
    } catch (e) {
      fail(e instanceof Error ? e.message : "Sending failed.");
    }
  }

  async function receiveMessage(data: unknown) {
    if (typeof data === "string") {
      const m = JSON.parse(data) as Msg;

      if (m.type === "file-start") {
        const file: RxFile = {
          id: String(m.id),
          name: String(m.name),
          size: Number(m.size),
          mime: String(m.mime),
          total: Number(m.total),
          chunks: new Map(),
          received: 0,
        };

        setCurrentName(file.name);
        setProgress(0);
        setTransferred(0);

        const picker = (
          window as Window & {
            showSaveFilePicker?: (
              options?: unknown,
            ) => Promise<FileSystemFileHandle>;
          }
        ).showSaveFilePicker;

        if (picker) {
          const handle = await picker({
            suggestedName: file.name,
          });

          file.writable = await handle.createWritable();
        }

        rxRef.current = file;

        setStatus(`Receiving ${file.name}…`);
      } else if (m.type === "file-end") {
        const file = rxRef.current;

        if (!file || file.id !== String(m.id)) {
          throw new Error("Unexpected file completion.");
        }

        file.expectedHash = String(m.sha256);

        if (file.writable) {
          await file.writable.close();

          setStatus(
            `Saved ${file.name}. Each chunk passed AES-GCM authentication.`,
          );
        } else {
          const parts: ArrayBuffer[] = [];

          for (let i = 0; i < file.total; i++) {
            const part = file.chunks.get(i);

            if (!part) {
              throw new Error(`Missing chunk ${i}.`);
            }

            parts.push(part);
          }

          const blob = new Blob(parts, {
            type: file.mime,
          });

          if ((await hashBlob(blob)) !== file.expectedHash) {
            throw new Error("SHA-256 verification failed.");
          }

          const url = URL.createObjectURL(blob);

          const a = document.createElement("a");

          a.href = url;
          a.download = file.name;

          a.click();

          setTimeout(() => URL.revokeObjectURL(url), 30_000);

          setStatus(`Verified and saved ${file.name}.`);
        }

        rxRef.current = null;
      } else if (m.type === "all-done") {
        setComplete(true);

        setStatus("All files received.");
      }

      return;
    }

    const file = rxRef.current;

    if (!file) {
      throw new Error("Received data before file metadata.");
    }

    const { index, data: plain } = await decryptChunk(
      keyRef.current!,
      data as ArrayBuffer,
    );

    if (index >= file.total || file.chunks.has(index)) {
      throw new Error("Invalid or duplicate chunk index.");
    }

    if (file.writable) {
      await file.writable.write(new Uint8Array(plain));
    } else {
      file.chunks.set(index, plain);
    }

    file.received += plain.byteLength;

    setTransferred(file.received);

    setProgress(file.size ? (file.received / file.size) * 100 : 100);
  }

  function reset() {
    cleanupConnection();

    keyRef.current = null;
    rxRef.current = null;

    filesRef.current = [];

    roleRef.current = null;

    sendStarted.current = false;

    setFiles([]);
    setRole(null);
    setRoom("");
    setSecret("");

    setStatus("Choose files to begin.");

    setError("");
    setProgress(0);
    setTransferred(0);
    setCurrentName("");
    setComplete(false);

    history.replaceState(null, "", location.pathname);
  }

  const shareUrl =
    room && secret
      ? `${typeof window !== "undefined" ? window.location.origin : ""}${
          typeof window !== "undefined" ? window.location.pathname : ""
        }#room=${encodeURIComponent(room)}&key=${encodeURIComponent(secret)}`
      : "";

  return (
    <main className="page">
      <section className="shell">
        <div className="brand">DROPSEND: Secure File Transfer Made Easy!</div>

        <h1>Send files privately.</h1>

        <p className="subtitle">
          Encrypted browser-to-browser file transfer. No accounts, no cloud
          storage.
        </p>

        {!role && (
          <>
            <label
              className={`drop ${drag ? "drag" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();

                setDrag(false);

                setSelected(e.dataTransfer.files);
              }}
            >
              <input
                hidden
                type="file"
                multiple
                onChange={(e) => e.target.files && setSelected(e.target.files)}
              />

              <strong>Drop files here</strong>

              <div className="meta">or click to browse</div>
            </label>

            {files.length > 0 && (
              <>
                <div className="panel">
                  {files.map((f, i) => (
                    <div
                      className="file"
                      key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
                    >
                      <span>{f.name}</span>

                      <span className="meta">{formatBytes(f.size)}</span>
                    </div>
                  ))}
                </div>

                <div className="actions">
                  <button
                    className="primary"
                    onClick={() => void startSender()}
                  >
                    Create transfer
                  </button>

                  <button
                    className="secondary"
                    onClick={() => {
                      filesRef.current = [];

                      setFiles([]);
                    }}
                  >
                    Clear
                  </button>
                </div>
              </>
            )}

            <p className="small">
              🎯 Fun Fact: The signaling service exchanges connection metadata
              only. File data travels over WebRTC🚀
            </p>
          </>
        )}

        {role && (
          <div className="panel">
            {role === "sender" && !complete && (
              <div
                style={{
                  padding: 24,
                }}
              >
                <h2>Waiting for recipient</h2>

                <p className="status">
                  Scan this QR code on the receiving device.
                </p>

                <div className="qr">
                  <QRCodeSVG value={shareUrl} size={240} />

                  <div className="code">{room}</div>
                </div>
              </div>
            )}

            {role === "receiver" && !complete && (
              <div
                style={{
                  padding: 24,
                }}
              >
                <h2>Joining transfer</h2>

                <p className="status">{status}</p>
              </div>
            )}

            {(complete ||
              status.startsWith("Receiving") ||
              status.startsWith("Sending") ||
              status.startsWith("Saved") ||
              status.startsWith("Verified")) && (
              <div
                style={{
                  padding: 24,
                }}
              >
                <h2>
                  {complete ? "Transfer complete" : "Transfer in progress"}
                </h2>

                <p className="status">{status}</p>

                <p>{currentName}</p>

                <div className="progress">
                  <div
                    style={{
                      width: `${Math.min(100, progress)}%`,
                    }}
                  />
                </div>

                <p className="status">
                  {formatBytes(transferred)} · {progress.toFixed(1)}%
                </p>
              </div>
            )}

            {error && (
              <div
                className="error"
                style={{
                  margin: 16,
                }}
              >
                {error}
              </div>
            )}

            <div
              className="actions"
              style={{
                padding: "0 24px 24px",
              }}
            >
              <button className="secondary" onClick={reset}>
                Start over
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
