"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

import "./page.css";

import { QRCodeSVG } from "qrcode.react";

import {
  decryptChunk,
  encryptChunk,
  importSecret,
  newSecret,
} from "../lib/crypto";

import { sha256 } from "@noble/hashes/sha2.js";

import { formatBytes, newRoomId } from "../lib/format";
import { createPeer } from "../lib/webrtc";

const CHUNK = 48 * 1024;

const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 512 * 1024;

const CONNECTION_TIMEOUT = 30_000;

const MEMORY_FALLBACK_LIMIT = 256 * 1024 * 1024;

const SIGNAL_URL =
  process.env.NEXT_PUBLIC_SIGNALING_URL ||
  "wss://dropsend-signaling.dropsend.workers.dev";

type Role = "sender" | "receiver";

type Msg = {
  type: string;
  [key: string]: unknown;
};

type IncrementalHash = {
  update(data: Uint8Array): unknown;
  digest(): Uint8Array;
};

type RxFile = {
  id: string;
  name: string;
  size: number;
  mime: string;
  total: number;
  received: number;
  nextIndex: number;
  expectedHash?: string;
  hash: IncrementalHash;
  storage: "opfs" | "memory";
  opfsHandle?: FileSystemFileHandle;
  writable?: FileSystemWritableFileStream;
  chunks: ArrayBuffer[];
};

type ReceivedFile = {
  id: string;
  name: string;
  size: number;
  mime: string;
  storage: "opfs" | "memory";
  handle?: FileSystemFileHandle;
  blob?: Blob;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function safeStorageName(name: string): string {
  const cleaned = name
    .replace(/[\/\0]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[\u0000-\u001f]/g, "_")
    .trim();

  return (cleaned || "file").slice(0, 180);
}

function hasOpfs(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

function hasWebRtcSupport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.RTCPeerConnection === "function" &&
    typeof window.RTCDataChannel !== "undefined"
  );
}

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
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);

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
  const receiveQueue = useRef(Promise.resolve());
  const receivedFilesRef = useRef<ReceivedFile[]>([]);

  useEffect(() => {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );

    if (!elements.length) {
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      elements.forEach((element) => element.classList.add("is-in-view"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in-view");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );

    elements.forEach((element) => observer.observe(element));

    return () => observer.disconnect();
  }, [role, files.length, receivedFiles.length, complete]);

  useEffect(() => {
    if (!hasWebRtcSupport()) {
      setError(
        "WebRTC DataChannel is not available in this browser. " +
          "Use a current Chrome, Edge, Firefox, Safari, or compatible mobile browser.",
      );
      setStatus("Browser not supported.");
    } else if (!hasOpfs()) {
      setStatus(
        "Ready. This browser will use a compatibility receive path for saved files.",
      );
    }

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

    if (!hasWebRtcSupport()) {
      setError(
        "This browser does not support WebRTC DataChannel. " +
          "Use a current version of Chrome, Edge, Firefox, Safari, or a compatible mobile browser.",
      );
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
      if (!hasWebRtcSupport()) {
        throw new Error(
          "This browser does not support WebRTC DataChannel. " +
            "Use a current version of Chrome, Edge, Firefox, Safari, or a compatible mobile browser.",
        );
      }

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
    } catch {}
  }

  async function createSenderPeer() {
    const pc = createPeer();

    pcRef.current = pc;

    pc.oniceconnectionstatechange = () => {};

    pc.onconnectionstatechange = () => {};

    pc.onsignalingstatechange = () => {};
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

    pc.oniceconnectionstatechange = () => {};

    pc.onconnectionstatechange = () => {};

    pc.onsignalingstatechange = () => {};
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
      receiveQueue.current = receiveQueue.current
        .then(() => receiveMessage(e.data))
        .catch((err) => {
          fail(
            err instanceof Error
              ? err.message
              : "Could not process received data.",
          );
        });
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
        const fileHash = sha256.create() as IncrementalHash;

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

          const plainBytes = new Uint8Array(plain);
          fileHash.update(plainBytes);

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
            sha256: bytesToHex(fileHash.digest()),
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

  async function saveReceivedFile(received: ReceivedFile) {
    let source: File | Blob;

    if (received.storage === "opfs") {
      if (!received.handle) {
        throw new Error("Received file storage is unavailable.");
      }

      source = await received.handle.getFile();
    } else {
      if (!received.blob) {
        throw new Error("Received file data is unavailable.");
      }

      source = received.blob;
    }

    const picker = (
      window as Window & {
        showSaveFilePicker?: (
          options?: unknown,
        ) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;

    if (typeof picker === "function") {
      const target = await picker({
        suggestedName: safeStorageName(received.name),
      });

      const writable = await target.createWritable();

      try {
        await writable.write(source);
        await writable.close();
        setStatus(`Saved ${received.name}.`);
      } catch (error) {
        try {
          await writable.abort();
        } catch {}
        throw error;
      }
    } else {
      const url = URL.createObjectURL(source);
      const anchor = document.createElement("a");

      anchor.href = url;
      anchor.download = safeStorageName(received.name);
      anchor.rel = "noopener";
      anchor.style.display = "none";

      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

      setStatus(`Downloaded ${received.name}.`);
    }
  }

  async function receiveMessage(data: unknown) {
    if (typeof data === "string") {
      const m = JSON.parse(data) as Msg;

      if (m.type === "file-start") {
        if (rxRef.current) {
          throw new Error(
            "Received a new file before the previous file finished.",
          );
        }

        const fileId = String(m.id);
        const name = String(m.name);
        const size = Number(m.size);
        const total = Number(m.total);
        const mime = String(m.mime);

        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          !Number.isSafeInteger(total) ||
          total < 0 ||
          total !== Math.ceil(size / CHUNK)
        ) {
          throw new Error("Invalid file metadata.");
        }

        if (!hasOpfs() && size > MEMORY_FALLBACK_LIMIT) {
          throw new Error(
            `This browser does not provide disk-backed receiving. ` +
              `Files larger than ${formatBytes(MEMORY_FALLBACK_LIMIT)} ` +
              "cannot be safely received here. Use a current browser with OPFS support.",
          );
        }

        let storage: "opfs" | "memory" = "memory";
        let opfsHandle: FileSystemFileHandle | undefined;
        let writable: FileSystemWritableFileStream | undefined;

        if (hasOpfs()) {
          try {
            const root = await navigator.storage.getDirectory();
            const directory = await root.getDirectoryHandle(
              "dropsend-transfers",
              {
                create: true,
              },
            );

            const storageName =
              `${fileId.replace(/[^a-zA-Z0-9_-]/g, "_")}-` +
              safeStorageName(name);

            opfsHandle = await directory.getFileHandle(storageName, {
              create: true,
            });

            writable = await opfsHandle.createWritable();
            storage = "opfs";
          } catch {
            if (size > MEMORY_FALLBACK_LIMIT) {
              throw new Error(
                "Browser storage could not be opened for this large file. " +
                  "Try a normal browsing window or a browser with OPFS support.",
              );
            }

            storage = "memory";
          }
        }

        const file: RxFile = {
          id: fileId,
          name,
          size,
          mime,
          total,
          received: 0,
          nextIndex: 0,
          hash: sha256.create() as IncrementalHash,
          storage,
          opfsHandle,
          writable,
          chunks: [],
        };

        rxRef.current = file;

        setCurrentName(file.name);
        setProgress(0);
        setTransferred(0);
        setStatus(
          storage === "opfs"
            ? `Receiving ${file.name}…`
            : `Receiving ${file.name} in browser memory…`,
        );
      } else if (m.type === "file-end") {
        const file = rxRef.current;

        if (!file || file.id !== String(m.id)) {
          throw new Error("Unexpected file completion.");
        }

        file.expectedHash = String(m.sha256);

        if (file.received !== file.size) {
          throw new Error(
            `Incomplete file: received ${file.received} of ${file.size} bytes.`,
          );
        }

        if (file.nextIndex !== file.total) {
          throw new Error(
            `Missing chunks: received ${file.nextIndex} of ${file.total}.`,
          );
        }

        const actualHash = bytesToHex(file.hash.digest());

        if (actualHash !== file.expectedHash) {
          throw new Error("SHA-256 verification failed.");
        }

        if (file.storage === "opfs") {
          await file.writable?.close();
        }

        const completed: ReceivedFile =
          file.storage === "opfs"
            ? {
                id: file.id,
                name: file.name,
                size: file.size,
                mime: file.mime,
                storage: "opfs",
                handle: file.opfsHandle,
              }
            : {
                id: file.id,
                name: file.name,
                size: file.size,
                mime: file.mime,
                storage: "memory",
                blob: new Blob(file.chunks, {
                  type: file.mime || "application/octet-stream",
                }),
              };

        receivedFilesRef.current = [...receivedFilesRef.current, completed];
        setReceivedFiles([...receivedFilesRef.current]);

        rxRef.current = null;

        setStatus(`Verified ${file.name}. Ready to save.`);
      } else if (m.type === "all-done") {
        setComplete(true);
        setStatus("All files received and verified.");
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

    if (index !== file.nextIndex) {
      throw new Error(
        `Unexpected chunk order: expected ${file.nextIndex}, received ${index}.`,
      );
    }

    if (index >= file.total) {
      throw new Error("Invalid chunk index.");
    }

    const bytes = new Uint8Array(plain);

    if (file.storage === "opfs") {
      await file.writable?.write(bytes);
    } else {
      const chunkBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(chunkBuffer).set(bytes);
      file.chunks.push(chunkBuffer);
    }

    file.hash.update(bytes);

    file.received += bytes.byteLength;
    file.nextIndex += 1;

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
    receiveQueue.current = Promise.resolve();

    receivedFilesRef.current = [];
    setReceivedFiles([]);

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

  async function copyShareUrl() {
    if (!shareUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(shareUrl);
      setStatus("Transfer link copied.");
    } catch {
      setError(
        "Could not copy the transfer link. Copy it from the address bar instead.",
      );
    }
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const isTransferring =
    status.startsWith("Receiving") ||
    status.startsWith("Sending") ||
    status.startsWith("Saved") ||
    status.startsWith("Verified");
  const connectionReady =
    status.includes("established") || status.includes("channel ready");

  return (
    <main className="ds-page">
      <div className="ds-noise" aria-hidden="true" />
      <div className="ds-orb ds-orb-a" aria-hidden="true" />
      <div className="ds-orb ds-orb-b" aria-hidden="true" />

      <header className="ds-nav">
        <button
          className="ds-brand"
          onClick={reset}
          aria-label="Go to DropSend home"
        >
          <span className="ds-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 40 40" fill="none">
              <path
                d="M11 8.5h13.5c4.4 0 8 3.6 8 8v4.5"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
              />
              <path
                d="M29 31.5H15.5c-4.4 0-8-3.6-8-8V19"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
              />
              <path
                d="M20 14.5 26.5 20 20 25.5"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M13.5 20h13"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="ds-brand-wordmark">
            <b>Drop</b>
            <em>Send</em>
          </span>
        </button>

        {!role ? (
          <nav className="ds-nav-links" aria-label="Primary navigation">
            <a href="#how-it-works">How it works</a>
            <a href="#security">Security</a>
            <a
              href="https://github.com/boradesanket13/dropsend"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            <button
              className="ds-nav-cta"
              onClick={() =>
                document
                  .getElementById("share")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              Start sharing
            </button>
          </nav>
        ) : (
          <button className="ds-nav-exit" onClick={reset}>
            Exit transfer
          </button>
        )}
      </header>

      {!role ? (
        <>
          <section className="ds-hero" id="share" data-reveal="hero">
            <div className="ds-hero-copy" data-reveal="hero-copy">
              <div className="ds-eyebrow">
                <span /> Developed around Data Privacy
              </div>
              <h1>
                Send files
                <br />
                <em>privately.</em>
              </h1>
              <p>
                Your files are encrypted in your browser using AES GCM. Transferred directly between your devices via WebRTC. 
                Your files stay out of the internet, cloud and out of our hands.
              </p>
              <div className="ds-hero-actions" data-reveal="up">
                <label className="ds-button ds-button-primary">
                  <input
                    hidden
                    type="file"
                    multiple
                    onChange={(event) =>
                      event.target.files && setSelected(event.target.files)
                    }
                  />
                  Select files
                  <span aria-hidden="true">＋</span>
                </label>
                <a className="ds-button ds-button-quiet" href="#how-it-works">
                  Explore the flow
                </a>
              </div>
              <div
                className="ds-proof-row"
                aria-label="Product properties"
                data-reveal="line"
              >
                <span>
                  <i /> Local encryption
                </span>
                <span>
                  <i /> Direct channel
                </span>
                <span>
                  <i /> Zero signup
                </span>
              </div>
            </div>

            <div
              className="ds-network-card"
              data-reveal="scale"
              aria-label="Direct browser-to-browser transfer visualization"
            >
              <div className="ds-network-grid" />
              <div
                className="ds-network-label ds-network-label-top"
                data-reveal="line"
              >
                DIRECT CONNECTION
              </div>
              <div className="ds-network-center">
                <div className="ds-center-ring ds-ring-one" />
                <div className="ds-center-ring ds-ring-two" />
                <div className="ds-center-core">
                  <span className="ds-bolt">DS</span>
                  <small>DIRECT</small>
                </div>
              </div>
              <div className="ds-device ds-device-one">
                <div className="ds-laptop">
                  <span />
                </div>
                <b>This browser</b>
                <small>Encrypted locally</small>
              </div>
              <div className="ds-device ds-device-two">
                <div className="ds-phone">
                  <span />
                </div>
                <b>Peer browser</b>
                <small>Direct channel</small>
              </div>
              <div className="ds-device ds-device-three">
                <div className="ds-tablet">
                  <span />
                </div>
                <b>Compatible browser</b>
              </div>
              <svg
                className="ds-network-lines"
                viewBox="0 0 620 520"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path d="M145 156 C230 150 250 210 310 260" />
                <path d="M310 260 C385 270 420 215 492 174" />
                <path d="M310 260 C355 330 425 365 485 378" />
              </svg>
              <div className="ds-network-bottom" data-reveal="line">
                No file bucket in the middle.
              </div>
            </div>
          </section>

          {files.length > 0 && (
            <section
              className="ds-selection"
              aria-labelledby="selected-files-title"
              data-reveal="up"
            >
              <div className="ds-section-heading compact">
                <div>
                  <div className="ds-eyebrow">READY TO TRANSFER</div>
                  <h2 id="selected-files-title">
                    {files.length} {files.length === 1 ? "file" : "files"}
                  </h2>
                </div>
                <span>{formatBytes(totalSize)}</span>
              </div>
              <div className="ds-file-list">
                {files.map((file, index) => (
                  <div
                    className="ds-file"
                    key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                    data-reveal="row"
                    style={
                      {
                        "--reveal-delay": `${Math.min(index, 8) * 55}ms`,
                      } as CSSProperties
                    }
                  >
                    <div className="ds-file-symbol" aria-hidden="true">
                      {file.type.startsWith("image/")
                        ? "▧"
                        : file.type.startsWith("video/")
                          ? "▶"
                          : "□"}
                    </div>
                    <div className="ds-file-copy">
                      <strong title={file.name}>{file.name}</strong>
                      <span>{formatBytes(file.size)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="ds-selection-actions" data-reveal="up">
                <button
                  className="ds-button ds-button-primary"
                  onClick={() => void startSender()}
                >
                  Create private transfer <span>→</span>
                </button>
                <button
                  className="ds-button ds-button-quiet"
                  onClick={() => {
                    filesRef.current = [];
                    setFiles([]);
                  }}
                >
                  Clear selection
                </button>
              </div>
            </section>
          )}

          <section className="ds-marquee" aria-hidden="true" data-reveal="line">
            <span>LOCAL FIRST</span>
            <i />
            <span>DIRECT CHANNEL</span>
            <i />
            <span>NO FILE STORAGE</span>
            <i />
            <span>ZERO SIGN UP</span>
          </section>

          <section className="ds-features" id="how-it-works" data-reveal="up">
            <div className="ds-section-heading" data-reveal="up">
              <div>
                <div className="ds-eyebrow">HOW IT WORKS</div>
                <h2>
                  A shorter path
                  <br />
                  to a private transfer.
                </h2>
              </div>
              <p>
                DropSend keeps the experience focused: select locally, pair
                privately, move the encrypted bytes, then verify what arrived.
              </p>
            </div>

            <div className="ds-feature-grid">
              <article
                className="ds-feature-card ds-feature-large"
                data-reveal="up"
                style={{ "--reveal-delay": "0ms" } as CSSProperties}
              >
                <div className="ds-feature-number">01</div>
                <div className="ds-mini-drop">
                  <span>＋</span>
                  <b>Pick locally</b>
                  <small>One or many files</small>
                </div>
                <h3>Select without uploading.</h3>
                <p>
                  Your selection stays in the browser while the private session
                  is prepared. There is no upload queue waiting on a server.
                </p>
              </article>
              <article
                className="ds-feature-card"
                data-reveal="up"
                style={{ "--reveal-delay": "90ms" } as CSSProperties}
              >
                <div className="ds-feature-number">02</div>
                <div className="ds-mini-qr">
                  <div />
                  <div />
                  <div />
                  <div />
                  <span>PAIR</span>
                </div>
                <h3>Pair the second screen.</h3>
                <p>
                  Use the short room link or QR code. The second browser can
                  join without an account or installation.
                </p>
              </article>
              <article
                className="ds-feature-card"
                data-reveal="up"
                style={{ "--reveal-delay": "180ms" } as CSSProperties}
              >
                <div className="ds-feature-number">03</div>
                <div className="ds-mini-transfer">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <h3>Let the browsers move it.</h3>
                <p>
                  WebRTC carries the encrypted chunks between peers while the
                  signaling service stays outside the file path.
                </p>
              </article>
            </div>
          </section>

          <section className="ds-security" id="security" data-reveal="up">
            <div className="ds-security-visual" data-reveal="scale">
              <div className="ds-security-orbit orbit-one" />
              <div className="ds-security-orbit orbit-two" />
              <div className="ds-security-core">
                <span>AES</span>
                <small>GCM</small>
              </div>
              <div className="ds-security-node node-a">Browser A</div>
              <div className="ds-security-node node-b">Browser B</div>
              <div className="ds-security-line line-a" />
              <div className="ds-security-line line-b" />
            </div>
            <div className="ds-security-copy" data-reveal="up">
              <div className="ds-eyebrow">PRIVATE ARCHITECTURE</div>
              <h2>The middle helps connect you. It does not hold your file.</h2>
              <p>
                DropSend uses the signaling service to coordinate the
                connection. File content is encrypted in the browser before it
                enters the WebRTC data channel, keeping the transfer path
                between peers.
              </p>
              <div className="ds-security-list" data-reveal="line">
                <div>
                  <span>01</span>
                  <b>Encrypted before transport</b>
                  <small>
                    AES-GCM protects each chunk before it enters the data
                    channel.
                  </small>
                </div>
                <div>
                  <span>02</span>
                  <b>Direct browser channel</b>
                  <small>
                    WebRTC carries the file payload between the connected
                    browsers.
                  </small>
                </div>
                <div>
                  <span>03</span>
                  <b>No account or file bucket</b>
                  <small>
                    The signaling layer coordinates the session without becoming
                    a file-storage layer.
                  </small>
                </div>
              </div>
            </div>
          </section>

          <section className="ds-process" data-reveal="up">
            <div className="ds-process-heading">
              <div className="ds-eyebrow">THE FLOW</div>
              <h2>Four deliberate steps.</h2>
            </div>
            <div className="ds-process-track" data-reveal="up">
              <div>
                <span>01</span>
                <b>Select</b>
                <small>Choose files locally.</small>
              </div>
              <div className="ds-process-arrow">→</div>
              <div>
                <span>02</span>
                <b>Pair</b>
                <small>Open the private session.</small>
              </div>
              <div className="ds-process-arrow">→</div>
              <div>
                <span>03</span>
                <b>Transfer</b>
                <small>Send encrypted chunks.</small>
              </div>
              <div className="ds-process-arrow">→</div>
              <div>
                <span>04</span>
                <b>Verify</b>
                <small>Validate the completed file.</small>
              </div>
            </div>
          </section>

          <section className="ds-final-cta" data-reveal="scale">
            <div className="ds-final-glow" />
            <div className="ds-eyebrow">READY WHEN YOU ARE</div>
            <h2>
              Ready to move
              <br />
              <em>one file?</em>
            </h2>
            <p>
              No account. No cloud folder. Just two browsers and a private
              connection.
            </p>
            <label className="ds-button ds-button-primary ds-final-button">
              <input
                hidden
                type="file"
                multiple
                onChange={(event) =>
                  event.target.files && setSelected(event.target.files)
                }
              />
              Choose a file
              <span>＋</span>
            </label>
          </section>

          <footer className="ds-footer" data-reveal="line">
            <button
              className="ds-footer-brand"
              onClick={reset}
              aria-label="Go to DropSend home"
            >
              <span className="ds-brand-mark" aria-hidden="true">
                <svg viewBox="0 0 40 40" fill="none">
                  <path
                    d="M11 8.5h13.5c4.4 0 8 3.6 8 8v4.5"
                    stroke="currentColor"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                  />
                  <path
                    d="M29 31.5H15.5c-4.4 0-8-3.6-8-8V19"
                    stroke="currentColor"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                  />
                  <path
                    d="M20 14.5 26.5 20 20 25.5"
                    stroke="currentColor"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M13.5 20h13"
                    stroke="currentColor"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <span className="ds-brand-wordmark">
                <b>Drop</b>
                <em>Send</em>
              </span>
            </button>
            <div className="ds-footer-links">
              <a href="#how-it-works">How it works</a>
              <a href="#security">Security</a>
              <a
                href="https://github.com/boradesanket13/dropsend"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            </div>
            <p>Direct file transfer, designed around data privacy.</p>
          </footer>
        </>
      ) : (
        <section className="ds-transfer" aria-live="polite" data-reveal="up">
          <div className="ds-transfer-top" data-reveal="up">
            <div>
              <div className="ds-eyebrow">
                {complete
                  ? "TRANSFER VERIFIED"
                  : role === "sender"
                    ? "SENDING SESSION"
                    : "RECEIVING SESSION"}
              </div>
              <h1>
                {complete
                  ? "Transfer complete."
                  : role === "sender"
                    ? "Ready to send."
                    : "Connecting securely."}
              </h1>
              <p>{status}</p>
            </div>
            <div
              className={`ds-live-pill ${connectionReady ? "is-ready" : ""}`}
            >
              <i /> {connectionReady ? "Connected" : "Connecting"}
            </div>
          </div>

          {role === "sender" && !complete && (
            <div className="ds-transfer-grid">
              <div className="ds-connect-panel" data-reveal="scale">
                <div className="ds-connect-visual">
                  <div className="ds-connect-device">
                    <div className="ds-laptop">
                      <span />
                    </div>
                    <small>This device</small>
                  </div>
                  <div className="ds-connect-path">
                    <i />
                    <span>DIRECT</span>
                    <i />
                  </div>
                  <div className="ds-connect-device muted">
                    <div className="ds-phone">
                      <span />
                    </div>
                    <small>Waiting for peer</small>
                  </div>
                </div>
                <div className="ds-qr-box" data-reveal="scale">
                  <div className="ds-eyebrow">SCAN TO CONNECT</div>
                  <div className="ds-qr">
                    <QRCodeSVG value={shareUrl} size={230} includeMargin />
                  </div>
                  <div className="ds-room-code">{room}</div>
                  <button
                    className="ds-copy-button"
                    onClick={() => void copyShareUrl()}
                  >
                    Copy private transfer link <span>↗</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {role === "receiver" && !complete && !isTransferring && (
            <div className="ds-wait-panel" data-reveal="scale">
              <div className="ds-radar">
                <span />
                <i />
                <b />
              </div>
              <div>
                <div className="ds-eyebrow">PRIVATE SESSION</div>
                <h2>Finding the other device</h2>
                <p>{status}</p>
              </div>
            </div>
          )}

          {(complete || isTransferring) && (
            <div
              className={`ds-transfer-progress ${complete ? "is-complete" : ""}`}
              data-reveal="up"
            >
              <div className="ds-transfer-progress-head">
                <div>
                  <div className="ds-eyebrow">
                    {complete
                      ? "SECURELY TRANSFERRED"
                      : role === "sender"
                        ? "SENDING NOW"
                        : "RECEIVING NOW"}
                  </div>
                  <h2>{currentName || "Preparing files…"}</h2>
                </div>
                <strong>
                  {complete ? "✓" : `${Math.min(100, progress).toFixed(0)}%`}
                </strong>
              </div>
              <progress
                max="100"
                value={Math.min(100, progress)}
                aria-label="Transfer progress"
              />
              <div className="ds-transfer-meta">
                <span>{formatBytes(transferred)} transferred</span>
                <span>{complete ? "SHA-256 verified" : status}</span>
              </div>
            </div>
          )}

          {receivedFiles.length > 0 && (
            <div className="ds-received-panel" data-reveal="up">
              <div className="ds-section-heading compact">
                <div>
                  <div className="ds-eyebrow">ON THIS DEVICE</div>
                  <h2>Received files</h2>
                </div>
                <span>{receivedFiles.length}</span>
              </div>
              <div className="ds-file-list">
                {receivedFiles.map((received) => (
                  <div className="ds-file" key={received.id} data-reveal="row">
                    <div className="ds-file-symbol" aria-hidden="true">
                      □
                    </div>
                    <div className="ds-file-copy">
                      <strong title={received.name}>{received.name}</strong>
                      <span>{formatBytes(received.size)}</span>
                    </div>
                    <button
                      className="ds-save-button"
                      onClick={() =>
                        void saveReceivedFile(received).catch((cause) =>
                          fail(
                            cause instanceof Error
                              ? cause.message
                              : "Could not save the received file.",
                          ),
                        )
                      }
                    >
                      Save <span>↓</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {complete && (
            <div className="ds-complete-panel" data-reveal="scale">
              <div className="ds-complete-icon">✓</div>
              <div>
                <b>Transfer verified</b>
                <span>
                  Encrypted in your browser and transferred directly between
                  peers.
                </span>
              </div>
            </div>
          )}

          {error && (
            <div className="ds-error" role="alert" data-reveal="up">
              {error}
            </div>
          )}

          <button className="ds-back-button" onClick={reset}>
            Start a new transfer
          </button>
        </section>
      )}
    </main>
  );
}
