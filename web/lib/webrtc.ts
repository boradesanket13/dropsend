const turnUrls = (process.env.NEXT_PUBLIC_TURN_URLS || "").split(",").map(x=>x.trim()).filter(Boolean);
export const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.cloudflare.com:3478" },
    ...(turnUrls.length ? [{
      urls: turnUrls,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL
    }] : [])
  ]
};
export function createPeer(): RTCPeerConnection {
  return new RTCPeerConnection(rtcConfig);
}
