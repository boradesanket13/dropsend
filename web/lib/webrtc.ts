const rtcConfig: RTCConfiguration = {
  iceServers: [
    {
      urls: "stun:stun.cloudflare.com:3478",
    },
  ],
};

export function createPeer(): RTCPeerConnection {
  return new RTCPeerConnection(rtcConfig);
}