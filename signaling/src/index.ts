import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOMS: DurableObjectNamespace<TransferRoom>;
}
type Role = "sender" | "receiver";
type RoomMessage =
  | { type: "join"; role: Role }
  | { type: "signal"; data: unknown };

function roomValid(id: string) {
  return /^[A-Z0-9]{10}$/.test(id);
}
function response(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET")
      return Response.json({ ok: true });
    if (
      request.method !== "GET" ||
      url.pathname.slice(0, 4) !== "/ws/" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return response("Not found", 404);
    const room = decodeURIComponent(url.pathname.slice(4));
    if (!roomValid(room)) return response("Invalid room", 400);
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

export class TransferRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: null as Role | null });
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") {
      ws.close(1003, "Text messages only");
      return;
    }
    let m: RoomMessage;
    try {
      m = JSON.parse(raw) as RoomMessage;
    } catch {
      ws.close(1003, "Invalid JSON");
      return;
    }
    const sockets = this.ctx.getWebSockets();
    if (m.type === "join") {
      if (m.role !== "sender" && m.role !== "receiver") {
        ws.close(1008, "Invalid role");
        return;
      }
      const attachment = ws.deserializeAttachment() as { role: Role | null };
      if (attachment.role) {
        ws.close(1008, "Already joined");
        return;
      }
      if (sockets.length > 2) {
        ws.close(1013, "Room full");
        return;
      }
      attachment.role = m.role;
      ws.serializeAttachment(attachment);
      if (sockets.length === 2)
        for (const socket of sockets)
          socket.send(JSON.stringify({ type: "peer-ready" }));
      return;
    }
    if (m.type === "signal") {
      const sender = ws.deserializeAttachment() as { role: Role | null };
      if (!sender.role) {
        ws.close(1008, "Join first");
        return;
      }
      const others = sockets.filter((s) => s !== ws);
      if (others.length !== 1) {
        ws.send(
          JSON.stringify({ type: "error", message: "Peer is not connected." }),
        );
        return;
      }
      const serialized = JSON.stringify({ type: "signal", data: m.data });
      if (serialized.length > 64_000) {
        ws.close(1009, "Signaling message too large");
        return;
      }
      others[0].send(serialized);
      return;
    }
    ws.close(1008, "Unsupported message");
  }
  webSocketClose(ws: WebSocket) {
    for (const peer of this.ctx.getWebSockets())
      if (peer !== ws) peer.send(JSON.stringify({ type: "peer-left" }));
  }
  webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "WebSocket error");
    } catch {}
  }
}
